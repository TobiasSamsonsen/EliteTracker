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


def small():
    from elitetracker.simulation.history import HistoryConfig

    return dict(simulation=SimulationConfig(simulations=2_000), history=HistoryConfig(simulations=100, max_snapshots=2))


def test_the_recorded_play_offs_agree_with_who_played_where_the_next_season():
    """Every flag in data/normalized/playoff_outcomes.json is the next season's
    membership: the bracket winner went up if (and only if) Eliteserien's 14th
    went down, each 14th stayed if it is in its division the next season."""
    from elitetracker.model.table import table_from_matches
    from elitetracker.pipeline import NORMALIZED_DIR, _matches_path, load_matches, playoff_outcomes

    def table(slug, season):
        return table_from_matches(load_matches(_matches_path(slug, season, NORMALIZED_DIR)))

    outcomes = playoff_outcomes()
    assert sorted(outcomes) == list(range(2015, 2026))
    for season, outcome in outcomes.items():
        elite, obos = table("eliteserien", season), table("obosligaen", season)
        next_elite = {row.team_id for row in table("eliteserien", season + 1)}
        next_obos = {row.team_id for row in table("obosligaen", season + 1)}
        assert outcome["bracket_winner"] in {row.team_id for row in obos[2:6]}
        assert outcome["eliteserien_14th"] == elite[13].team_id and outcome["obosligaen_14th"] == obos[13].team_id
        assert outcome["promoted"] == (outcome["bracket_winner"] in next_elite)
        assert outcome["promoted"] == outcome["eliteserien_14th_relegated"] == (outcome["eliteserien_14th"] not in next_elite)
        assert outcome["obosligaen_14th_relegated"] == (outcome["obosligaen_14th"] not in next_obos)
        # Nobody else from the bracket went up.
        assert {row.team_id for row in obos[2:6]} & next_elite <= {outcome["bracket_winner"]}


def test_a_finished_seasons_play_offs_are_as_they_went_not_simulated():
    from elitetracker.pipeline import build_report, playoff_outcomes

    outcome = playoff_outcomes()[2017]   # Ranheim (4th) beat Sogndal (Eliteserien 14th)
    obos = build_report("obosligaen", 2017, **small())["table"]
    by_id = {row["team_id"]: row for row in obos}
    assert by_id[outcome["bracket_winner"]]["promotion_probability"] == 1.0
    assert by_id[outcome["bracket_winner"]]["playoff_win_probability"] == 1.0
    assert sum(row["promotion_probability"] for row in obos) == pytest.approx(3.0)
    assert by_id[outcome["obosligaen_14th"]]["relegation_probability"] == 1.0
    assert sum(row["relegation_probability"] for row in obos) == pytest.approx(3.0)
    elite = build_report("eliteserien", 2017, **small())["table"]
    assert {row["team_id"] for row in elite if row["relegation_probability"] == 1.0} >= {outcome["eliteserien_14th"]}
    assert sum(row["relegation_probability"] for row in elite) == pytest.approx(3.0)
    # A rewound view of the same season is mid-season again: simulated, not settled.
    rewound = build_report("obosligaen", 2017, asof="2017-08-01", **small())["table"]
    assert all(0.0 < row["playoff_win_probability"] < 1.0 for row in rewound if row["position_probabilities"][3] > 0.2)


def test_the_two_divisions_play_one_tie_and_agree_on_it():
    """OBOS-ligaen's promotions through the final and Eliteserien's relegations
    through the same tie are the same runs: their chances add up to the same
    number, whether the two reports share their simulations or not."""
    from elitetracker.pipeline import build_report

    config = small()
    shared: dict = {}
    both = {slug: build_report(slug, 2026, share=shared, **config)["table"] for slug in ("eliteserien", "obosligaen")}
    alone = {slug: build_report(slug, 2026, **config)["table"] for slug in ("eliteserien", "obosligaen")}
    assert both == alone
    down = sum(row["relegation_probability"] - sum(row["position_probabilities"][14:]) for row in both["eliteserien"])
    up = sum(row["promotion_probability"] - sum(row["position_probabilities"][:2]) for row in both["obosligaen"])
    assert down > 0.05 and down == pytest.approx(up, abs=2e-5)


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


def test_the_shared_tie_is_published_pairing_by_pairing_and_agrees_in_both_reports():
    """Eliteserien's 14th v OBOS-ligaen's bracket winner is one tie: both reports
    carry the same pairs (the Explore page's matrix), they cover almost every run,
    and the upper club's survival is what the table's play-off relegation adds."""
    from elitetracker.pipeline import build_report

    elite = build_report("eliteserien", 2017, asof="2017-08-01", **small())
    obos = build_report("obosligaen", 2017, asof="2017-08-01", **small())
    tie, other = elite["relegation_playoff"], obos["relegation_playoff"]
    assert tie["settled"] is False and tie["pairs"] == other["pairs"]
    assert 0.99 < sum(pair["p"] for pair in tie["pairs"]) <= 1.0 + 1e-6
    assert all(0.0 <= pair["stay"] <= 1.0 for pair in tie["pairs"])
    assert {pair["top"] for pair in tie["pairs"]} <= {row["team_id"] for row in elite["table"]}
    assert {pair["bottom"] for pair in tie["pairs"]} <= {row["team_id"] for row in obos["table"]}
    assert all(team in tie["teams"] for pair in tie["pairs"] for team in (pair["top"], pair["bottom"]))
    # Eliteserien's play-off relegations are the pairs' losses (to rounding of the thin pairs).
    down = {row["team_id"]: row["relegation_probability"] for row in elite["table"]}
    lost = {}
    for pair in tie["pairs"]:
        lost[pair["top"]] = lost.get(pair["top"], 0.0) + pair["p"] * (1.0 - pair["stay"])
    for team, share in lost.items():
        assert down[team] >= share - 1e-3
    # OBOS-ligaen's survival tie is only in its own report.
    assert "survival" not in tie and 0.99 < sum(row["p"] for row in other["survival"]) <= 1.0 + 1e-6


def test_a_finished_seasons_tie_is_the_one_that_was_played():
    from elitetracker.pipeline import build_report, playoff_outcomes

    outcome = playoff_outcomes()[2017]
    for slug in ("eliteserien", "obosligaen"):
        tie = build_report(slug, 2017, **small())["relegation_playoff"]
        assert tie["settled"] is True
        assert tie["pairs"] == [{"top": outcome["eliteserien_14th"], "bottom": outcome["bracket_winner"], "p": 1.0,
                                 "stay": 0.0 if outcome["eliteserien_14th_relegated"] else 1.0}]
    assert tie["survival"][0]["team_id"] == outcome["obosligaen_14th"]


def test_the_bracket_is_published_match_by_match_and_agrees_in_both_reports():
    """OBOS-ligaen's play-off, match by match: every match covers almost every run,
    the last match's winners are the tie's lower side, and both reports agree."""
    from elitetracker.pipeline import build_report

    elite = build_report("eliteserien", 2023, asof="2023-09-01", **small())["relegation_playoff"]
    obos = build_report("obosligaen", 2023, asof="2023-09-01", **small())["relegation_playoff"]
    assert elite["bracket"] == obos["bracket"] and len(obos["bracket"]) == 3
    for match in obos["bracket"]:
        assert 0.99 < sum(pair["p"] for pair in match) <= 1.0 + 1e-6
        assert all(0.0 <= pair["home_win"] <= 1.0 for pair in match)
        assert all(pair["home"] in obos["teams"] and pair["away"] in obos["teams"] for pair in match)
    # The final's winners are the bracket winners the tie is played against.
    final = {}
    for pair in obos["bracket"][2]:
        final[pair["home"]] = final.get(pair["home"], 0.0) + pair["p"] * pair["home_win"]
        final[pair["away"]] = final.get(pair["away"], 0.0) + pair["p"] * (1 - pair["home_win"])
    tie = {}
    for pair in obos["pairs"]:
        tie[pair["bottom"]] = tie.get(pair["bottom"], 0.0) + pair["p"]
    for team, share in tie.items():
        assert abs(final.get(team, 0.0) - share) < 2e-3
