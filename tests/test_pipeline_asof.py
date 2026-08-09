"""The season-rewind view: the report as it would have read on a given day."""

import json

import pytest

from elitetracker.normalize.matches import Match, dump
from elitetracker.normalize.standings import Standing, dump_standings
from elitetracker.pipeline import _matchdays, build_all_careers, build_report
from elitetracker.simulation.history import HistoryConfig
from elitetracker.simulation.season import SimulationConfig

FAST = SimulationConfig(simulations=120)
FAST_HISTORY = HistoryConfig(simulations=60, max_snapshots=4)


def match(match_id, home, away, date, played=True, score=(1, 0), round_number=1):
    home_goals, away_goals = score if played else (None, None)
    return Match(
        match_id=str(match_id),
        date=date,
        time="18:00",
        home=home,
        away=away,
        venue=None,
        home_goals=home_goals,
        away_goals=away_goals,
        played=played,
        round=round_number,
        home_id=home,
        away_id=away,
    )


class TestMatchdays:
    def test_one_entry_per_played_date(self):
        days = _matchdays([
            match(1, "A", "B", "2026-03-01"),
            match(2, "C", "D", "2026-03-01"),
            match(3, "A", "C", "2026-03-08"),
        ])
        assert [d["date"] for d in days] == ["2026-03-01", "2026-03-08"]

    def test_running_total_counts_every_match(self):
        days = _matchdays([
            match(1, "A", "B", "2026-03-01"),
            match(2, "C", "D", "2026-03-01"),
            match(3, "A", "C", "2026-03-08"),
        ])
        assert [d["matches_played"] for d in days] == [2, 3]

    def test_unplayed_matches_are_not_matchdays(self):
        days = _matchdays([
            match(1, "A", "B", "2026-03-01"),
            match(2, "A", "C", "2026-09-01", played=False),
        ])
        assert [d["date"] for d in days] == ["2026-03-01"]

    def test_dates_are_chronological(self):
        days = _matchdays([
            match(1, "A", "B", "2026-05-01"),
            match(2, "C", "D", "2026-03-01"),
        ])
        assert [d["date"] for d in days] == ["2026-03-01", "2026-05-01"]

    def test_no_matches_played(self):
        assert _matchdays([match(1, "A", "B", "2026-03-01", played=False)]) == []


@pytest.fixture
def tiny_league(tmp_path):
    """A two-club, four-team-total world with a short, complete history."""
    teams = ["A", "B"]
    others = ["C", "D"]

    for season in (2014,):
        for slug, pair in (("eliteserien", teams), ("obosligaen", others)):
            dump_standings(
                [
                    Standing(position=i + 1, team=name, team_id=name, played=2, wins=1,
                             draws=0, losses=1, goals_for=2, goals_against=2, points=3)
                    for i, name in enumerate(pair)
                ],
                tmp_path / f"{slug}_{season}_standings.json",
            )

    for season in (2015, 2016):
        dump(
            [
                match(f"e{season}1", "A", "B", f"{season}-03-01", score=(2, 0)),
                match(f"e{season}2", "B", "A", f"{season}-06-01", score=(0, 1)),
            ],
            tmp_path / f"eliteserien_{season}_matches.json",
        )
        dump(
            [
                match(f"o{season}1", "C", "D", f"{season}-03-01", score=(1, 0)),
                match(f"o{season}2", "D", "C", f"{season}-06-01", score=(1, 1)),
            ],
            tmp_path / f"obosligaen_{season}_matches.json",
        )
    return tmp_path


def build(root, **kwargs):
    careers = build_all_careers(root)
    return build_report(
        "eliteserien", 2016, root=root, careers=careers,
        simulation=FAST, history=FAST_HISTORY, **kwargs,
    )


class TestRewind:
    def test_live_report_sees_every_result(self, tiny_league):
        report = build(tiny_league)
        assert report["league"]["asof"] is None
        assert report["model"]["matches_played"] == 2
        assert report["model"]["matches_remaining"] == 0

    def test_rewinding_hides_later_results(self, tiny_league):
        report = build(tiny_league, asof="2016-03-01")
        assert report["league"]["asof"] == "2016-03-01"
        assert report["model"]["matches_played"] == 1
        assert report["model"]["matches_remaining"] == 1

    def test_rewinding_before_the_season_shows_nothing_played(self, tiny_league):
        report = build(tiny_league, asof="2016-01-01")
        assert report["model"]["matches_played"] == 0
        assert report["model"]["matches_remaining"] == 2

    def test_the_hidden_match_becomes_an_upcoming_fixture(self, tiny_league):
        report = build(tiny_league, asof="2016-03-01")
        assert [f["date"] for f in report["fixtures"]] == ["2016-06-01"]

    def test_ratings_are_those_of_the_day(self, tiny_league):
        """A win on 1 June cannot be in the rating on 1 March."""
        early = {row["team"]: row["rating"] for row in build(tiny_league, asof="2016-03-01")["table"]}
        late = {row["team"]: row["rating"] for row in build(tiny_league)["table"]}
        assert early != late
        # A beat B in March and again in June, so A is stronger by the end.
        assert late["A"] > early["A"]

    def test_the_table_reflects_only_what_had_been_played(self, tiny_league):
        report = build(tiny_league, asof="2016-03-01")
        rows = {row["team"]: row for row in report["table"]}
        assert rows["A"]["played"] == 1
        assert rows["A"]["points"] == 3
        assert rows["B"]["points"] == 0

    def test_matchdays_span_the_whole_season_even_when_rewound(self, tiny_league):
        """The slider must not shrink as you drag it backwards."""
        live = build(tiny_league)["league"]["matchdays"]
        past = build(tiny_league, asof="2016-03-01")["league"]["matchdays"]
        assert [d["date"] for d in past] == [d["date"] for d in live]
        assert len(live) == 2

    def test_rewinding_is_reproducible(self, tiny_league):
        first = build(tiny_league, asof="2016-03-01")
        second = build(tiny_league, asof="2016-03-01")
        assert first["table"] == second["table"]

    def test_the_other_division_is_rewound_too(self, tiny_league):
        """Ratings are shared across divisions, so both must rewind together."""
        careers = build_all_careers(tiny_league)
        obos = build_report(
            "obosligaen", 2016, root=tiny_league, careers=careers,
            simulation=FAST, history=FAST_HISTORY, asof="2016-03-01",
        )
        assert obos["model"]["matches_played"] == 1


class TestFixtureRatings:
    def test_fixtures_carry_both_ratings(self, tiny_league):
        fixture = build(tiny_league, asof="2016-03-01")["fixtures"][0]
        assert isinstance(fixture["home_rating"], float)
        assert isinstance(fixture["away_rating"], float)

    def test_fixture_ratings_match_the_table(self, tiny_league):
        report = build(tiny_league, asof="2016-03-01")
        ratings = {row["team"]: row["rating"] for row in report["table"]}
        fixture = report["fixtures"][0]
        assert fixture["home_rating"] == pytest.approx(ratings[fixture["home"]])
        assert fixture["away_rating"] == pytest.approx(ratings[fixture["away"]])

    def test_the_stronger_side_is_favoured(self, tiny_league):
        fixture = build(tiny_league, asof="2016-03-01")["fixtures"][0]
        # B hosts A having just lost to them, so A is away favourite.
        assert fixture["away_rating"] > fixture["home_rating"]
        assert fixture["away_win"] > fixture["home_win"]
