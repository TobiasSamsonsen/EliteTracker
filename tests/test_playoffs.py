"""The post-season play-offs played inside the season simulation."""

import numpy as np
import pytest

from elitetracker.normalize.matches import Match
from elitetracker.simulation.playoffs import Opponent, Playoffs
from elitetracker.simulation.season import SimulationConfig, simulate_season

TEAMS = ["A", "B", "C", "D", "E", "F", "G", "H"]


def finished_league(points_order):
    """A played round robin whose table is `points_order`, best first: each club
    beats every club below it, so the table is fixed and only the play-offs
    are random."""
    matches = []
    for i, home in enumerate(points_order):
        for away in points_order[i + 1:]:
            matches.append(Match(match_id=f"{home}{away}", date="2026-05-01", time="18:00", home=home, away=away,
                                 home_goals=1, away_goals=0, played=True, home_id=home, away_id=away))
    return matches


def run(playoffs, ratings=None, runs=20_000, **kw):
    ratings = ratings or {team: 1500.0 for team in TEAMS + ["X"]}
    return simulate_season(finished_league(TEAMS), ratings, config=SimulationConfig(simulations=runs, seed=7),
                           tally_conditionals=False, playoffs=playoffs, **kw)


def by_team(projection, field):
    return {team.team_id: getattr(team, field) for team in projection.teams}


def test_the_ladder_favours_the_higher_seeds():
    """2019 on: 5th v 6th, the winner at 4th, then at 3rd. Equal clubs, so the
    fewer matches a seed needs (and the home games), the likelier it goes through."""
    wins = by_team(run(Playoffs(bracket=(3, 4, 5, 6), ladder=True)), "playoff_win")
    assert sum(wins.values()) == pytest.approx(1.0)
    assert wins["C"] > wins["D"] > max(wins["E"], wins["F"])
    assert wins["C"] > 0.4 and wins["E"] + wins["F"] < 0.35
    assert wins["A"] == wins["B"] == wins["G"] == 0.0


def test_the_old_semi_finals_are_flatter():
    """2015-2018: 3rd v 6th and 4th v 5th, the winners at the higher seed:
    every club needs two wins, so the seeds sit closer together."""
    wins = by_team(run(Playoffs(bracket=(3, 4, 5, 6), ladder=False)), "playoff_win")
    assert sum(wins.values()) == pytest.approx(1.0)
    assert 0.15 < min(wins[t] for t in "CDEF") and max(wins[t] for t in "CDEF") < 0.4
    assert wins["C"] > wins["F"]


def test_the_final_and_the_survival_tie_follow_the_strength_of_the_other_side():
    runs = 20_000
    zeros = np.zeros(runs, dtype=np.intp)
    weak = Opponent(("X",), zeros, np.zeros(runs))
    for rating, expect_promoted in ((1100.0, lambda p: p > 0.9), (1900.0, lambda p: p < 0.1)):
        ratings = {**{team: 1500.0 for team in TEAMS}, "X": rating}
        projection = run(Playoffs(bracket=(3, 4, 5, 6), final=weak, survival_position=7, survival=weak),
                         ratings=ratings, runs=runs)
        promoted = sum(by_team(projection, "promoted_via_playoff").values())
        relegated = by_team(projection, "relegated_via_playoff")
        assert expect_promoted(promoted)
        # Only the club in the survival place can go down through the tie.
        assert set(team for team, p in relegated.items() if p) <= {"G"}
        assert relegated["G"] == pytest.approx(1.0 - promoted, abs=0.05)  # same opponent, mirrored odds


def test_play_offs_leave_the_finishing_chances_alone_and_hand_over_their_runs():
    """They run on a random stream of their own, so the table runs are the same
    draws with or without them; the bracket winners and a kept place come back
    run by run for the other division's tie."""
    fixtures = finished_league(TEAMS)[:-6]  # leave the last few matches to play
    for match in finished_league(TEAMS)[-6:]:
        fixtures.append(Match(match_id=match.match_id, date="2026-06-01", time="18:00", home=match.home,
                              away=match.away, home_goals=None, away_goals=None, played=False,
                              home_id=match.home_id, away_id=match.away_id))
    ratings = {team: 1500.0 for team in TEAMS}
    config = SimulationConfig(simulations=3_000, seed=11)
    plain = simulate_season(fixtures, ratings, config=config, tally_conditionals=False, keep_position=7)
    with_playoffs = simulate_season(fixtures, ratings, config=config, tally_conditionals=False,
                                    playoffs=Playoffs(bracket=(3, 4, 5, 6)))
    assert by_team(plain, "position_probabilities") == by_team(with_playoffs, "position_probabilities")
    assert len(with_playoffs.bracket_winners.club) == 3_000 == len(plain.kept.club)
    seventh = np.bincount(plain.kept.club, minlength=len(TEAMS)) / 3_000
    for index, team in enumerate(plain.kept.team_ids):
        assert seventh[index] == pytest.approx(by_team(plain, "position_probabilities")[team][6])


def test_reports_count_the_play_offs_between_the_direct_places_and_the_play_off_places():
    """On the real 2026 data: promotion lies between the top two and the top
    six, relegation between 15th-16th and 14th-16th, and only OBOS-ligaen has
    promotion chances."""
    from elitetracker.pipeline import build_report
    from elitetracker.simulation.history import HistoryConfig

    small = dict(simulation=SimulationConfig(simulations=2_000), history=HistoryConfig(simulations=100, max_snapshots=2))
    for slug in ("eliteserien", "obosligaen"):
        table = build_report(slug, 2026, **small)["table"]
        for row in table:
            p = row["position_probabilities"]
            assert sum(p[14:]) - 1e-6 <= row["relegation_probability"] <= sum(p[13:]) + 1e-6
            if slug == "obosligaen":
                assert sum(p[:2]) - 1e-6 <= row["promotion_probability"] <= sum(p[:6]) + 1e-6
                assert row["playoff_win_probability"] <= sum(p[2:6]) + 1e-6
            else:
                assert "promotion_probability" not in row
        if slug == "obosligaen":
            assert sum(row["playoff_win_probability"] for row in table) == pytest.approx(1.0)
