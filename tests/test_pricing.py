"""Match odds (`model.pricing`): one recipe for the published fixtures, the
season simulation and the backtest, and the golden numbers the browser's
ports are pinned to (`tests/fixtures/match_odds.json`, read by
tests/frontend.test.js too).

After a deliberate model change, rewrite the golden file from the repo root
with `python -m tests.test_pricing`, then bring the JS ports up to it."""

import json
from dataclasses import replace
from pathlib import Path

import pytest

from elitetracker.model.attack_defence import (
    ADConfig, AttackDefence, blend_outcomes, conditional_scorelines, outcome_probabilities, score_grid, top_scorelines,
)
from elitetracker.model.elo import EloConfig
from elitetracker.model.pricing import SURFACE_LEAGUE, elo_odds, match_odds
from elitetracker.model.probabilities import MatchProbabilities, _draw_model_probabilities
from elitetracker.model.stakes import STAKES_ELO, pressure
from elitetracker.normalize.matches import Match
from elitetracker.normalize.surfaces import SURFACE_EDGE
from elitetracker.pipeline import _fixtures_payload
from elitetracker.simulation.season import _fixtures

GOLDEN = Path(__file__).with_name("fixtures") / "match_odds.json"

# The browser's compare tool reads these from report.model; the test model
# app.js is checked against.
APP_MODEL = {
    "home_advantage": 60, "home_advantage_beta": 0, "draw_base": 0.26, "draw_scale": 375,
    "attack_defence": {"outcome_blend": 0.25, "blend_gamma": 0, "home": 0.22, "home_beta": 0, "base": 0.37,
                       "rho": -0.05, "spread": 1, "k": 0.015,
                       "teams": {"A": [0.3, 0.15], "B": [-0.2, -0.1]}},
}
# The model page's Elo settings (public/model.js).
PAGE_CONFIG = {"k_factor": 30, "home_advantage": 60, "xg_alpha": 0.3, "draw_base": 0.26, "draw_scale": 375}


def fixture(home="A", away="B", on="2026-05-01", match_id="1"):
    return Match(match_id=match_id, date=on, time=None, home=home, away=away, home_goals=None, away_goals=None,
                 played=False, home_id=home, away_id=away)


def app_state():
    """APP_MODEL as the Python model: its Elo config and attack/defence state."""
    m, ad_m = APP_MODEL, APP_MODEL["attack_defence"]
    config = EloConfig(home_advantage=m["home_advantage"], home_advantage_beta=m["home_advantage_beta"],
                       draw_base=m["draw_base"], draw_scale=m["draw_scale"])
    ad = AttackDefence(ADConfig(home=ad_m["home"], home_beta=ad_m["home_beta"], base=ad_m["base"], rho=ad_m["rho"],
                                spread=ad_m["spread"], blend_gamma=ad_m["blend_gamma"]))
    ad.start_season(2026)
    for team, (attack, defence) in ad_m["teams"].items():
        ad.attack[team], ad.defence[team] = attack, defence
    return config, ad


def golden() -> dict:
    """The numbers both languages are held to, worked out by the Python model."""
    config, ad = app_state()
    match = fixture()
    elo = elo_odds(match, 1700, 1300, config)
    grid = ad.grid("A", "B", match.date)
    given = MatchProbabilities(0.6, 0.25, 0.15)
    page = EloConfig(home_advantage=PAGE_CONFIG["home_advantage"], draw_base=PAGE_CONFIG["draw_base"],
                     draw_scale=PAGE_CONFIG["draw_scale"])
    page_grid = score_grid(1.6, 1.1, -0.05)
    page_elo = _draw_model_probabilities(110, page)
    page_blend = blend_outcomes(page_elo, page_grid, 0.25)
    cells = conditional_scorelines(page_grid, page_blend)
    odds = lambda p: [p.home_win, p.draw, p.away_win]
    return {
        "app": {
            "model": APP_MODEL,
            "ratings": [1700, 1300],
            "elo": odds(elo),
            "grid": {"0-0": grid[0][0], "1-1": grid[1][1]},
            "given": odds(given),
            "scorelines": [[i, j, p] for (i, j), p in top_scorelines(grid, given, 5)],
            "odds": odds(match_odds(elo, ad, match).odds),
        },
        "page": {
            "config": PAGE_CONFIG,
            "elo": [[gap, odds(_draw_model_probabilities(gap, page))] for gap in (110, -340)],
            "grid": {"rates": [1.6, 1.1, -0.05], "odds": odds(outcome_probabilities(page_grid)),
                     "0-0": page_grid[0][0], "1-1": page_grid[1][1]},
            "blend": {"gap": 110, "weight": 0.25, "odds": odds(page_blend),
                      "1-1": cells[(1, 1)], "1-0": cells[(1, 0)], "2-1": cells[(2, 1)]},
            "pressure": [[d, left, 0.8, pressure(d, left, 0.8)] for d, left in ((0, 3), (4, 3), (6, 10))],
        },
    }


def close(saved, worked_out, where="golden"):
    if isinstance(worked_out, dict):
        assert sorted(saved) == sorted(worked_out), where
        for key in worked_out:
            close(saved[key], worked_out[key], f"{where}.{key}")
    elif isinstance(worked_out, (list, tuple)):
        assert len(saved) == len(worked_out), where
        for index, (a, b) in enumerate(zip(saved, worked_out)):
            close(a, b, f"{where}[{index}]")
    else:
        assert saved == pytest.approx(worked_out, abs=1e-12), where


def test_the_golden_numbers_are_the_models():
    """If this fails after a deliberate change, rewrite the file (module
    docstring): the JS ports are then checked against the new numbers."""
    close(json.loads(GOLDEN.read_text(encoding="utf-8")), golden())


def test_the_surface_edge_is_eliteserien_only():
    grass_v_turf = fixture("8468", "8402", "2026-05-01")
    config = EloConfig()
    plain = elo_odds(grass_v_turf, 1500, 1500, config, "obosligaen")
    edged = elo_odds(grass_v_turf, 1500, 1500, config, SURFACE_LEAGUE)
    assert plain == elo_odds(grass_v_turf, 1500, 1500, config)
    assert edged == elo_odds(grass_v_turf, 1500 + SURFACE_EDGE, 1500, config, "obosligaen")


def test_stakes_move_the_gap_every_gap_term_reads():
    """The stakes term prices the Elo side, and the goals model and the blend
    weight read the gap it was priced at."""
    config, ad = app_state()
    ad.config = replace(ad.config, home_beta=0.4, blend_gamma=0.2)
    match = fixture()
    calm, tense = elo_odds(match, 1600, 1500, config), elo_odds(match, 1600, 1500, config, stakes=0.5)
    assert tense == elo_odds(match, 1600 + STAKES_ELO * 0.5, 1500, config)
    assert tense.rating_gap - calm.rating_gap == pytest.approx(STAKES_ELO * 0.5 / 400)
    assert match_odds(tense, ad, match, stakes=0.5).odds.home_win > match_odds(calm, ad, match, stakes=0.5).odds.home_win


@pytest.mark.parametrize("home_beta, blend_gamma", [(0.0, 0.0), (0.4, 0.2)])
def test_the_published_fixtures_and_the_season_simulation_agree(home_beta, blend_gamma):
    """The odds a fixture is published with are the odds the season is
    simulated at, whatever the gap-dependent terms are set to."""
    config, ad = app_state()
    ad.config = replace(ad.config, home_beta=home_beta, blend_gamma=blend_gamma)
    matches = [fixture("A", "B", match_id="1"), fixture("B", "A", match_id="2")]
    ratings = {"A": 1720.0, "B": 1480.0}
    published = _fixtures_payload(matches, ratings, config, ad, league="obosligaen")
    simulated = _fixtures(matches, ratings, {"A": 0, "B": 1}, config, ad, league="obosligaen")
    for row, home_win, home_or_draw in zip(published, simulated.home_win, simulated.home_or_draw):
        assert row["home_win"] == round(float(home_win), 4)
        assert row["home_win"] + row["draw"] == pytest.approx(float(home_or_draw), abs=1e-4)
    for match, home_win in zip(matches, simulated.home_win):
        elo = elo_odds(match, ratings[match.home_id], ratings[match.away_id], config, "obosligaen")
        assert float(home_win) == pytest.approx(match_odds(elo, ad, match).odds.home_win, abs=1e-12)


if __name__ == "__main__":
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(json.dumps(golden(), indent=1) + "\n", encoding="utf-8")
    print(f"wrote {GOLDEN}")
