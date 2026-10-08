"""The high-stakes feature: which remaining fixtures swing a
contender's band chance most.

The unit tests drive `_compute_high_stakes` on hand-built
conditional tallies, so the arithmetic is exact and every branch
of the filters is reachable. The integration tests run the real
Monte Carlo and check the tally invariant and the report contract.
"""

import json
from dataclasses import asdict

import pytest

from elitetracker.model.table import table_from_matches
from elitetracker.normalize.matches import Match
from elitetracker.pipeline import (
    Band, _compute_high_stakes, build_all_careers, build_report,
)
from elitetracker.simulation.history import HistoryConfig
from elitetracker.simulation.season import SimulationConfig, simulate_season

# A two-club world: the title and the drop are the only bands that
# can be contended for, which is exactly what the orientation tests
# need pinned down.
BANDS = (
    Band("Champions", 1, 1, "champion"),
    Band("Relegation", 2, 2, "relegation"),
)
# The filter tests want one band: in a two-club world every club
# contends for both, which would double its entries.
TITLE = (BANDS[0],)


def match(match_id, home, away, day=1, score=None):
    home_goals, away_goals = score if score else (None, None)
    date = day if isinstance(day, str) else f"2026-03-{day:02d}"
    return Match(
        match_id=str(match_id),
        date=date,
        time="18:00",
        home=home,
        away=away,
        home_goals=home_goals,
        away_goals=away_goals,
        played=score is not None,
        home_id=home,
        away_id=away,
    )


def tallies(outcomes, clubs=2, positions=2):
    """One fixture's conditional tally: `outcomes` maps an outcome
    code to {club index: position counts}; missing cells are zero."""
    fixture = [[[0] * positions for _ in range(clubs)] for _ in range(3)]
    for outcome, per_club in outcomes.items():
        for club, counts in per_club.items():
            fixture[outcome][club] = counts
    return fixture


def league_matches():
    games = [
        match(1, "A", "B", day=1, score=(2, 0)),
        match(2, "C", "D", day=1, score=(1, 1)),
    ]
    games += [
        match(10 + i, home, away, day=10 + i)
        for i, (home, away) in enumerate(
            [("A", "B"), ("C", "D"), ("A", "C"), ("B", "D"), ("A", "D"), ("B", "C")]
        )
    ]
    return games


RATINGS = {"A": 1600, "B": 1500, "C": 1450, "D": 1400}


class TestStakeOrientation:
    def test_getting_in_bands_read_the_win_and_relegation_the_loss(self):
        """The chance of the band given the favourable outcome: for a
        getting-in band that is the win, for relegation the loss --
        losing is what brings the drop closer."""
        # A win puts A top for certain, a loss leaves it top a
        # quarter of the time; the draw splits the difference.
        # B's finishing counts are flat, so only A has a swing.
        conditionals = [tallies({
            0: {0: [1000, 0], 1: [500, 500]},
            1: {0: [500, 500], 1: [500, 500]},
            2: {0: [250, 750], 1: [500, 500]},
        })]
        clubs = ["A", "B"]
        fixtures = [match("f0", "A", "B")]
        unconditional = {"A": [0.5833, 0.4167], "B": [0.4167, 0.5833]}
        entries = _compute_high_stakes(
            conditionals, clubs, fixtures, unconditional, BANDS,
            SimulationConfig(simulations=3000),
        )
        champions = next(
            e for e in entries if e["team_id"] == "A" and e["band_tone"] == "champion"
        )
        assert champions["p_favourable"] == 1.0
        assert champions["p_unfavourable"] == 0.25
        relegation = next(
            e for e in entries if e["team_id"] == "A" and e["band_tone"] == "relegation"
        )
        assert relegation["p_favourable"] == 0.75
        assert relegation["p_unfavourable"] == 0.0


class TestPairingCollapse:
    def test_a_pairing_collapses_to_its_higher_swing_leg(self):
        """Two legs against one opponent produce one entry per club
        and band, naming the higher-swing leg, with both legs
        attached so the view can show the whole pairing."""
        # Leg f0 (A at home): A is certain top on a win and certain
        # second on a loss -- a full swing. Leg f1 (A away): the
        # same shape at half the swing.
        leg0 = tallies({
            0: {0: [1000, 0], 1: [0, 1000]},
            1: {0: [500, 500], 1: [500, 500]},
            2: {0: [0, 1000], 1: [1000, 0]},
        })
        leg1 = tallies({
            0: {0: [375, 1125], 1: [1125, 375]},
            1: {0: [750, 750], 1: [750, 750]},
            2: {0: [1125, 375], 1: [375, 1125]},
        })
        conditionals = [leg0, leg1]
        clubs = ["A", "B"]
        fixtures = [match("f0", "A", "B", day=1), match("f1", "B", "A", day=2)]
        unconditional = {"A": [0.5, 0.5], "B": [0.5, 0.5]}
        entries = _compute_high_stakes(
            conditionals, clubs, fixtures, unconditional, BANDS,
            SimulationConfig(simulations=3000),
        )
        champions = [
            e for e in entries if e["team_id"] == "A" and e["band_tone"] == "champion"
        ]
        assert len(champions) == 1
        entry = champions[0]
        assert entry["match_id"] == "f0"
        assert sorted(entry["leg_match_ids"]) == ["f0", "f1"]
        assert entry["swing"] == 1.0


class TestFilters:
    def test_a_club_out_of_contention_gets_no_entry(self):
        """A club below the band-probability bar is not a contender,
        however decisive its fixtures are."""
        conditionals = [tallies({
            0: {0: [1000, 0], 1: [0, 1000]},
            1: {0: [500, 500], 1: [500, 500]},
            2: {0: [0, 1000], 1: [1000, 0]},
        })]
        clubs = ["A", "B"]
        fixtures = [match("f0", "A", "B")]
        # B is certain to finish top whatever happens, but the model
        # gives it a 5% chance: below the contention bar.
        unconditional = {"A": [0.95, 0.05], "B": [0.05, 0.95]}
        entries = _compute_high_stakes(
            conditionals, clubs, fixtures, unconditional, TITLE,
            SimulationConfig(simulations=3000),
        )
        assert [e["team_id"] for e in entries] == ["A"]

    def test_a_branch_thinner_than_the_floor_is_left_off(self):
        """A branch holding too few runs is Monte Carlo noise, not a
        probability: the fixture is left off rather than divided
        into a tiny denominator."""
        # A's branches swing the title; B's finishing counts
        # are flat, so B has no stake of its own to report.
        thin = tallies({
            0: {0: [2900, 0], 1: [50, 50]},
            1: {0: [0, 0], 1: [50, 50]},
            2: {0: [50, 50], 1: [50, 50]},
        })
        thick = tallies({
            0: {0: [2400, 0], 1: [300, 300]},
            1: {0: [0, 0], 1: [300, 300]},
            2: {0: [300, 300], 1: [300, 300]},
        })
        clubs = ["A", "B"]
        fixtures = [match("f0", "A", "B")]
        unconditional = {"A": [0.8, 0.2], "B": [0.05, 0.95]}
        config = SimulationConfig(simulations=3000)
        # The loss branch holds 100 runs: under the floor. A's swing
        # would be 0.5, so only the guard can be keeping it off.
        assert _compute_high_stakes([thin], clubs, fixtures, unconditional, TITLE, config) == []
        # Thicken the branch to 600 runs and the stake appears.
        entries = _compute_high_stakes([thick], clubs, fixtures, unconditional, TITLE, config)
        assert [e["team_id"] for e in entries] == ["A"]

    def test_empty_inputs_produce_no_entries(self):
        assert _compute_high_stakes(None, ["A"], [], {}, BANDS) == []
        assert _compute_high_stakes([], ["A"], [], {}, BANDS) == []
        # A club with no recorded chances has a zero baseline.
        assert _compute_high_stakes(
            [[[ [0] ]]], ["A"], [match("f0", "A", "B")], {}, BANDS
        ) == []


class TestSimulation:
    def test_the_three_outcome_branches_sum_to_the_run_count(self):
        """The tally invariant: for any fixture and either club in
        it, the three outcome branches sum to exactly the run count,
        because every run lands the club in exactly one branch."""
        projection = simulate_season(
            league_matches(), RATINGS,
            config=SimulationConfig(simulations=400, seed=3),
        )
        unplayed = [game for game in league_matches() if not game.played]
        order = [row.team_id for row in table_from_matches(league_matches())]
        index_of = {team_id: index for index, team_id in enumerate(order)}
        for fixture_index, game in enumerate(unplayed):
            for club_id in (game.home_id, game.away_id):
                club = index_of[club_id]
                total = sum(
                    sum(branch[club]) for branch in projection.conditionals[fixture_index]
                )
                assert total == projection.simulations

    def test_conditionals_reproduce_the_finishing_odds(self):
        """Summing a club's branches over the fixtures it plays must
        rebuild its finishing-position probabilities exactly."""
        games = league_matches()
        projection = simulate_season(
            games, RATINGS, config=SimulationConfig(simulations=400, seed=3)
        )
        unplayed = [game for game in games if not game.played]
        order = [row.team_id for row in table_from_matches(games)]
        index_of = {team_id: index for index, team_id in enumerate(order)}
        played_count = {
            team_id: sum(
                1 for game in unplayed if team_id in (game.home_id, game.away_id)
            )
            for team_id in order
        }
        for team in projection.teams:
            club = index_of[team.team_id]
            for position in range(len(projection.teams)):
                tally = sum(
                    projection.conditionals[fixture_index][outcome][club][position]
                    for fixture_index in range(len(unplayed))
                    for outcome in range(3)
                )
                expected = (
                    played_count[team.team_id]
                    * projection.simulations
                    * team.position_probabilities[position]
                )
                assert tally == pytest.approx(expected)

    def test_the_same_seed_reproduces_the_same_stakes(self):
        games = league_matches()
        clubs = [row.team_id for row in table_from_matches(games)]
        unplayed = [game for game in games if not game.played]
        bands = (BANDS[0], BANDS[1])
        config = SimulationConfig(simulations=3000, seed=9)
        stakes = []
        for _ in range(2):
            projection = simulate_season(games, RATINGS, config=config)
            unconditional = {
                team.team_id: team.position_probabilities for team in projection.teams
            }
            stakes.append(_compute_high_stakes(
                projection.conditionals, clubs, unplayed, unconditional, bands, config,
            ))
        assert stakes[0] == stakes[1]
        assert stakes[0]  # this league has stakes to reproduce


@pytest.fixture
def tiny_league(tmp_path):
    """A two-club Eliteserien, level on points, with one match left."""
    for slug, pair in (("eliteserien", ["A", "B"]), ("obosligaen", ["C", "D"])):
        (tmp_path / f"{slug}_2014_standings.json").write_text(json.dumps([
            dict(position=i + 1, team=name, team_id=name, played=2, wins=1,
                 draws=0, losses=1, goals_for=2, goals_against=2, points=3)
            for i, name in enumerate(pair)
        ]), encoding="utf-8")
        for season in (2015, 2016):
            games = [
                match(f"{slug[0]}{season}1", pair[0], pair[1], f"{season}-03-01", score=(2, 0)),
                match(f"{slug[0]}{season}2", pair[1], pair[0], f"{season}-06-01", score=(1, 0)),
            ]
            if slug == "eliteserien" and season == 2016:
                # The decider: both clubs are level on points and
                # goal difference, so this match settles the title.
                games.append(match("e20163", "A", "B", "2016-09-01"))
            (tmp_path / f"{slug}_{season}_matches.json").write_text(
                json.dumps([asdict(game) for game in games]), encoding="utf-8"
            )
    return tmp_path


class TestReport:
    def test_the_report_carries_the_stakes_and_the_table_points_at_them(self, tiny_league):
        careers = build_all_careers(tiny_league)
        report = build_report(
            "eliteserien", 2016, root=tiny_league, careers=careers,
            simulation=SimulationConfig(simulations=2000, seed=4),
            history=HistoryConfig(simulations=60, max_snapshots=4),
        )
        entries = report["high_stakes"]
        assert entries
        for entry in entries:
            for key in (
                "team_id", "team", "opponent_id", "opponent", "band_label",
                "band_first", "band_last", "band_tone", "match_id",
                "leg_match_ids", "date", "home_id", "away_id",
                "p_baseline", "p_favourable", "p_unfavourable", "swing",
            ):
                assert key in entry
            assert entry["leg_match_ids"]
            assert entry["match_id"] in entry["leg_match_ids"]
            assert 0.0 <= entry["p_favourable"] <= 1.0
            assert 0.0 <= entry["p_unfavourable"] <= 1.0
        # Sorted by swing, biggest first.
        swings = [entry["swing"] for entry in entries]
        assert swings == sorted(swings, reverse=True)
        # The title decider must be in there for both clubs: the
        # winner is certain to finish top, the loser certain second.
        deciders = [e for e in entries if e["match_id"] == "e20163"]
        assert {e["team_id"] for e in deciders} == {"A", "B"}
        for entry in deciders:
            assert entry["p_favourable"] == pytest.approx(1.0)
            assert entry["p_unfavourable"] == pytest.approx(0.0)
        # The table rows point at their own entries.
        table = {row["team_id"]: row for row in report["table"]}
        for entry in entries:
            assert entry["match_id"] in table[entry["team_id"]]["high_stakes_match_ids"]
        for row in report["table"]:
            own = [e for e in entries if e["team_id"] == row["team_id"]]
            assert row["high_stakes_match_ids"] == [e["match_id"] for e in own]

    def test_a_finished_season_has_no_stakes(self, tiny_league):
        careers = build_all_careers(tiny_league)
        report = build_report(
            "eliteserien", 2015, root=tiny_league, careers=careers,
            simulation=SimulationConfig(simulations=2000, seed=4),
            history=HistoryConfig(simulations=60, max_snapshots=4),
        )
        assert report["model"]["matches_remaining"] == 0
        assert report["high_stakes"] == []
        for row in report["table"]:
            assert row["high_stakes_match_ids"] == []

    def test_the_same_seed_builds_the_same_stakes(self, tiny_league):
        careers = build_all_careers(tiny_league)
        kwargs = dict(
            root=tiny_league, careers=careers,
            simulation=SimulationConfig(simulations=2000, seed=4),
            history=HistoryConfig(simulations=60, max_snapshots=4),
        )
        first = build_report("eliteserien", 2016, **kwargs)
        second = build_report("eliteserien", 2016, **kwargs)
        assert first["high_stakes"] == second["high_stakes"]
