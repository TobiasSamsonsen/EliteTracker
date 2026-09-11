"""Attack/defence ratings: the grid, the conditioning on Elo odds, the update, the season pull."""

import math

from elitetracker.model.attack_defence import (
    ADConfig, AttackDefence, blend_outcomes, conditional_scorelines, outcome_probabilities, score_grid, top_scorelines,
)
from elitetracker.model.career import SeasonSlice
from elitetracker.model.probabilities import MatchProbabilities
from elitetracker.normalize.matches import Match


def match(mid, date, home, away, hg, ag, played=True):
    return Match(match_id=mid, date=date, time="18:00", home=home, away=away,
                 home_goals=hg if played else None, away_goals=ag if played else None, played=played,
                 home_id=home, away_id=away)


def slices(*seasons):
    return [SeasonSlice(league=league, league_name=league, season=season, matches=matches)
            for season, league, matches in seasons]


def test_grid_sums_to_one_and_rho_lifts_low_draws():
    grid = score_grid(1.6, 1.1, rho=0.0)
    assert abs(sum(map(sum, grid)) - 1.0) < 1e-12
    assert abs(grid[2][1] - math.exp(-1.6) * 1.6 ** 2 / 2 * math.exp(-1.1) * 1.1 / sum(map(sum, [[math.exp(-1.6) * 1.6 ** i / math.factorial(i) * math.exp(-1.1) * 1.1 ** j / math.factorial(j) for j in range(9)] for i in range(9)]))) < 1e-12
    lifted = score_grid(1.6, 1.1, rho=-0.1)
    assert lifted[0][0] > grid[0][0] and lifted[1][1] > grid[1][1] and lifted[1][0] < grid[1][0]
    p = outcome_probabilities(grid)
    assert abs(p.home_win + p.draw + p.away_win - 1.0) < 1e-12 and p.home_win > p.away_win


def test_conditioning_keeps_the_elo_odds_and_only_reshapes_within_outcomes():
    grid = score_grid(1.6, 1.1, rho=-0.05)
    odds = MatchProbabilities(0.5, 0.3, 0.2)
    cells = conditional_scorelines(grid, odds)
    assert abs(sum(v for (i, j), v in cells.items() if i > j) - 0.5) < 1e-12
    assert abs(sum(v for (i, j), v in cells.items() if i == j) - 0.3) < 1e-12
    assert abs(sum(cells.values()) - 1.0) < 1e-12
    # Within an outcome the relative shape is the grid's own.
    assert abs(cells[(2, 1)] / cells[(1, 0)] - grid[2][1] / grid[1][0]) < 1e-12
    top = top_scorelines(grid, odds, 3)
    assert len(top) == 3 and top[0][1] >= top[1][1] >= top[2][1]


def test_update_moves_attack_and_defence_together_and_caps_a_rout():
    model = AttackDefence(config=ADConfig(k=0.1, cap=2.0), divisions={(2020, "A"): "l", (2020, "B"): "l"})
    lam, mu = model.rates("A", "B", "2020-03-01")
    model.observe(match("1", "2020-03-01", "A", "B", 9, 0))
    assert abs(model.attack["A"] - 0.1 * 2.0) < 1e-12      # capped at 2 goals of surprise
    assert abs(model.defence["B"] + 0.1 * 2.0) < 1e-12     # the conceder's defence drops as much
    assert model.attack["B"] < 0 and model.defence["A"] > 0 # B scored under expectation
    assert model.rates("A", "B", "2020-03-01")[0] > lam


def test_xg_blend_reduces_a_lucky_win():
    shots = {"1": (0.4, 2.1, 0.5, 2.6)}  # home won 1-0 but was outshot
    goals_only = AttackDefence(config=ADConfig(k=0.1), divisions={(2020, "A"): "l", (2020, "B"): "l"})
    # Same step for both, so only the observation differs (k_shots is 0.05 by default).
    blended = AttackDefence(config=ADConfig(k=0.1, k_shots=0.1, alpha=0.5), divisions={(2020, "A"): "l", (2020, "B"): "l"}, shots=shots)
    for model in (goals_only, blended):
        model.observe(match("1", "2020-03-01", "A", "B", 1, 0))
    assert blended.attack["A"] < goals_only.attack["A"]
    assert blended.defence["A"] < goals_only.defence["A"]
    xgot = AttackDefence(config=ADConfig(k=0.1, k_shots=0.1, alpha=1.0, signal="xgot"), divisions={(2020, "A"): "l", (2020, "B"): "l"}, shots=shots)
    xgot.observe(match("1", "2020-03-01", "A", "B", 1, 0))
    assert xgot.observed(match("1", "2020-03-01", "A", "B", 1, 0)) == (0.5, 2.6, 0.1)


def test_season_start_pulls_toward_the_division_and_places_newcomers():
    data = slices(
        (2020, "eliteserien", [match("1", "2020-05-01", "A", "B", 3, 0), match("2", "2020-05-08", "B", "A", 0, 3)]),
        (2021, "eliteserien", [match("3", "2021-04-01", "A", "C", 1, 1), match("5", "2021-04-08", "B", "C", 1, 1)]),
        (2021, "obosligaen", [match("4", "2021-04-01", "D", "E", 1, 1)]),
    )
    model = AttackDefence.from_slices(data, ADConfig(k=0.1, season_regression=0.5, newcomer=0.2, division_gap=0.3))
    model.replay(data[0].matches)
    before = dict(model.attack)
    model.start_season(2021)
    mean = (before["A"] + before["B"]) / 2
    assert abs(model.attack["A"] - (mean + 0.5 * (before["A"] - mean))) < 1e-12
    assert abs(model.attack["C"] - (model.attack["A"] + model.attack["B"]) / 2 + 0.2) < 1e-12  # newcomer sits below its peers
    assert model.attack["D"] == model.defence["D"] == -0.3                                     # a first-season division is placed, not learned
    model.start_season(2021)  # idempotent
    assert abs(model.attack["C"] - (model.attack["A"] + model.attack["B"]) / 2 + 0.2) < 1e-12


def test_copy_is_independent_and_rates_against_average_are_readable():
    data = slices((2020, "eliteserien", [match("1", "2020-05-01", "A", "B", 2, 0)]))
    model = AttackDefence.from_slices(data, ADConfig(k=0.1)).replay(data[0].matches)
    twin = model.copy()
    twin.observe(match("2", "2020-05-08", "A", "B", 4, 0))
    assert twin.attack["A"] > model.attack["A"]
    scored, conceded = model.rates_against_average("A", "eliteserien", 2020)
    assert scored > conceded > 0


def test_blend_outcomes_interpolates_between_elo_and_the_grid():
    grid = score_grid(2.0, 0.8, rho=-0.05)
    elo = MatchProbabilities(0.4, 0.3, 0.3)
    own = outcome_probabilities(grid)
    for weight, expected in ((1.0, elo), (0.0, own)):
        got = blend_outcomes(elo, grid, weight)
        assert abs(got.home_win - expected.home_win) < 1e-12 and abs(got.draw - expected.draw) < 1e-12
    mid = blend_outcomes(elo, grid, 0.5)
    assert abs(mid.home_win + mid.draw + mid.away_win - 1.0) < 1e-12
    assert min(elo.home_win, own.home_win) < mid.home_win < max(elo.home_win, own.home_win)


def test_update_xg_records_new_matches_and_survives_a_failed_fetch(tmp_path):
    from elitetracker.sources.fotmob import FetchError, load_xg, update_xg
    path = tmp_path / "xg.json"
    calls = []

    def fetch(match_id):
        calls.append(match_id)
        if match_id == "bad":
            raise FetchError("boom")
        return None if match_id == "obos" else (1.5, 0.5, 1.2, 0.4)

    games = [match("a", "2026-05-01", "A", "B", 2, 0), match("bad", "2026-05-02", "A", "B", 2, 0),
             match("obos", "2026-05-03", "A", "B", 2, 0), match("later", "2026-05-09", "A", "B", 0, 0, played=False)]
    assert update_xg(games, path=path, fetch=fetch, delay=0) == 2
    data = load_xg(path)
    assert data["matches"]["a"] == [1.5, 0.5, 1.2, 0.4] and data["none"] == ["obos"] and "later" not in calls
    assert update_xg(games, path=path, fetch=fetch, delay=0) == 0   # only the failed one is retried
    assert calls.count("bad") == 2 and calls.count("a") == 1
