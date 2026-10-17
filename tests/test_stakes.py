"""Late-season table stakes (elo-v16.0): the pressure, the backtest's and the
fixtures' gaps, and the season simulation pricing the run-in from each run's
own table."""

from collections import namedtuple
from datetime import date, timedelta

import numpy as np
import pytest

from elitetracker.model.backtest import walk_forward
from elitetracker.model.career import SeasonSlice
from elitetracker.model.elo import EloConfig
from elitetracker.model.attack_defence import AttackDefence
from elitetracker.model.probabilities import match_probabilities
from elitetracker.model.stakes import (
    STAKES_ELO, STAKES_FROM, distance, fixture_gaps, lines, pressure, run_pressures, season_gaps,
)
from elitetracker.model.table import table_from_matches
from elitetracker.normalize.matches import Match
from elitetracker.simulation.season import STAKES_GAPS, SimulationConfig, _fixtures, simulate_season

TEAMS = [f"T{i:02d}" for i in range(16)]
Band = namedtuple("Band", "first last")
OBOS_LIKE = (Band(1, 1), Band(1, 2), Band(3, 6), Band(14, 14), Band(15, 16))


def round_robin() -> list[list[tuple[str, str]]]:
    """Thirty rounds of eight: the circle method, then the return legs."""
    teams, rounds = TEAMS[:], []
    for r in range(15):
        pairs = [(teams[i], teams[15 - i]) for i in range(8)]
        rounds.append(pairs if r % 2 == 0 else [(b, a) for a, b in pairs])
        teams = [teams[0], teams[-1]] + teams[1:-1]
    return rounds + [[(b, a) for a, b in pairs] for pairs in rounds]


def season(played_rounds: int, last_round: int = 30) -> list[Match]:
    """The stronger club (lower number) wins every played match 1-0."""
    out = []
    for r, pairs in enumerate(round_robin()[:last_round]):
        day = (date(2026, 3, 1) + timedelta(days=7 * r)).isoformat()
        for k, (home, away) in enumerate(pairs):
            played = r < played_rounds
            win = TEAMS.index(home) < TEAMS.index(away)
            out.append(Match(match_id=f"{r}-{k}", date=day, time="18:00", home=home, away=away,
                             home_goals=(1 if win else 0) if played else None,
                             away_goals=(0 if win else 1) if played else None, played=played,
                             home_id=home, away_id=away))
    return out


def round_of(match_id: str) -> int:
    return int(match_id.split("-")[0])


def test_lines_are_the_band_edges():
    assert lines(OBOS_LIKE, 16) == (1, 2, 6, 13, 14)


def test_distance_does_not_depend_on_the_tiebreak():
    # Line between 3rd and 4th, both on 40 points.
    assert distance(40, above=40, below=40) == 0
    assert distance(48, above=40, below=40) == 8
    assert distance(30, above=40, below=40) == 10


def test_pressure_is_one_near_a_line_and_falls_with_the_gap():
    assert pressure(0, 6) == pressure(1, 6) == 1.0
    assert 1.0 > pressure(3, 6) > pressure(9, 6) > pressure(9, 2) > 0.0


def test_run_pressures_are_the_scalar_pressures():
    rng = np.random.default_rng(1)
    points = rng.integers(10, 60, size=(50, 16))
    left = rng.integers(1, 7, size=16)
    cuts = lines(OBOS_LIKE, 16)
    got = run_pressures(points, left, cuts)
    for run in range(50):
        ranked = sorted(points[run], reverse=True)
        for club in range(16):
            d = min(distance(points[run, club], ranked[b - 1], ranked[b]) for b in cuts)
            assert got[run, club] == pytest.approx(pressure(d, left[club]))


def test_season_gaps_cover_the_run_in_only():
    matches = season(30)
    gaps = season_gaps(matches, lines(OBOS_LIKE, 16))
    assert set(gaps) == {m.match_id for m in matches if round_of(m.match_id) >= STAKES_FROM}
    assert all(-1.0 <= g <= 1.0 for g in gaps.values()) and any(abs(g) > 0.5 for g in gaps.values())


def test_fixture_gaps_count_the_matches_played_by_then():
    matches = season(20)
    gaps = fixture_gaps(matches, lines(OBOS_LIKE, 16))
    assert set(gaps) == {m.match_id for m in matches if not m.played and round_of(m.match_id) >= STAKES_FROM}


def test_the_backtest_moves_only_the_run_in():
    matches = season(30)
    slices = [SeasonSlice(league="obosligaen", league_name="OBOS", season=2026, matches=matches)]
    seeds = {t: 1500.0 for t in TEAMS}
    plain = walk_forward(slices, seeds, EloConfig(), score_from_season=2026)
    late = next(m.match_id for m in matches if round_of(m.match_id) == 27)
    priced = walk_forward(slices, seeds, EloConfig(), score_from_season=2026, stakes={late: 0.5})
    moved = {mid for mid in plain.predictions
             if plain.predictions[mid][0].home_win != priced.predictions[mid][0].home_win}
    assert moved == {late} and priced.predictions[late][0].home_win > plain.predictions[late][0].home_win


def test_the_simulation_without_a_run_in_is_unchanged():
    matches = season(5, last_round=20)  # nobody reaches 24 played
    ratings = {t: 1500.0 + 10 * (16 - i) for i, t in enumerate(TEAMS)}
    config = SimulationConfig(simulations=2_000, seed=7)
    plain = simulate_season(matches, ratings, config=config)
    staked = simulate_season(matches, ratings, config=config, stakes_lines=lines(OBOS_LIKE, 16))
    assert [t.position_probabilities for t in plain.teams] == [t.position_probabilities for t in staked.teams]


def test_the_run_in_odds_at_no_pressure_difference_are_the_plain_odds():
    matches = season(20)
    ratings = {t: 1500.0 + 10 * (16 - i) for i, t in enumerate(TEAMS)}
    index_of = {t: i for i, t in enumerate(TEAMS)}
    played = np.full(16, 20)
    fixtures = _fixtures(matches, ratings, index_of, EloConfig(), AttackDefence(), True, "", played, True)
    assert len(fixtures.stakes) == 6 * 8
    zero = list(STAKES_GAPS).index(0.0)
    assert np.allclose(fixtures.stakes_home_win[:, zero], fixtures.home_win[fixtures.stakes], atol=1e-12)
    assert (np.diff(fixtures.stakes_home_win, axis=1) > 0).all()


def test_each_run_prices_the_run_in_from_its_own_table():
    """The 25th round is the run-in's first and all on one date, after the
    played rounds: every run has the same table before it, so each of its
    fixtures' simulated home-win share must match the odds at its gap."""
    matches = season(24)
    ratings = {t: 1500.0 for t in TEAMS}
    cuts = lines(OBOS_LIKE, 16)
    gaps = fixture_gaps(matches, cuts)
    first = [m for m in matches if round_of(m.match_id) == 24]
    config = SimulationConfig(simulations=100_000, seed=3, strength_sd=0.0)
    projection = simulate_season(matches, ratings, config=config, stakes_lines=cuts)
    unplayed = [m for m in matches if not m.played]
    # The conditionals' club axis is the live table's order.
    index = {row.team_id: i for i, row in enumerate(table_from_matches(matches))}
    strongest = max(first, key=lambda m: abs(gaps[m.match_id]))
    assert abs(gaps[strongest.match_id]) > 0.4
    for m in first:
        f = unplayed.index(m)
        home_wins = sum(projection.conditionals[f][0][index[m.home_id]])
        expected = match_probabilities(1500.0 + STAKES_ELO * gaps[m.match_id], 1500.0, EloConfig()).home_win
        sd = (expected * (1 - expected) / config.simulations) ** 0.5
        assert abs(home_wins / config.simulations - expected) < 5 * sd
    plain = match_probabilities(1500.0, 1500.0, EloConfig()).home_win
    f = unplayed.index(strongest)
    share = sum(projection.conditionals[f][0][index[strongest.home_id]]) / config.simulations
    assert abs(share - plain) > 6 * (plain * (1 - plain) / config.simulations) ** 0.5
