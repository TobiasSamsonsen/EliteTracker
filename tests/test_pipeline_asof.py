"""The season-rewind view: the report as it would have read on a given day."""

import json
import math

import pytest

from elitetracker.normalize.matches import Match, dump
from elitetracker import pipeline
from elitetracker.pipeline import (
    LEAGUE_SPECS, UEFA_RANKS_FILE, _europe_by_rank, _matchdays, bands_for, build_all_careers,
    build_report, uefa_ranks,
)
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
        home_goals=home_goals,
        away_goals=away_goals,
        played=played,
        round=round_number,
        home_id=home,
        away_id=away,
    )


class TestPreseasonDate:
    """The pre-season view's date: the day before either division kicks off."""

    def write(self, root, eliteserien, obosligaen):
        dump(eliteserien, root / "eliteserien_2026_matches.json")
        dump(obosligaen, root / "obosligaen_2026_matches.json")

    def test_day_before_the_earlier_division_starts(self, tmp_path):
        self.write(
            tmp_path,
            [match(1, "A", "B", "2026-03-14"), match(2, "A", "B", "2026-03-21")],
            [match(3, "C", "D", "2026-03-08")],
        )
        assert pipeline.preseason_date(2026, tmp_path) == "2026-03-07"

    def test_crosses_month_boundaries(self, tmp_path):
        self.write(tmp_path, [match(1, "A", "B", "2026-04-01")], [match(2, "C", "D", "2026-04-02")])
        assert pipeline.preseason_date(2026, tmp_path) == "2026-03-31"

    def test_none_before_anything_is_played(self, tmp_path):
        self.write(
            tmp_path,
            [match(1, "A", "B", "2026-03-14", played=False)],
            [match(2, "C", "D", "2026-03-08", played=False)],
        )
        assert pipeline.preseason_date(2026, tmp_path) is None


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
            (tmp_path / f"{slug}_{season}_standings.json").write_text(json.dumps([
                dict(position=i + 1, team=name, team_id=name, played=2, wins=1,
                     draws=0, losses=1, goals_for=2, goals_against=2, points=3)
                for i, name in enumerate(pair)
            ]), encoding="utf-8")

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

    def test_results_carry_team_ids(self, tiny_league):
        """The played-results view looks ratings up by id, so ids must be present."""
        report = build(tiny_league)
        assert report["results"]
        for result in report["results"]:
            assert result["home_id"] == result["home"]
            assert result["away_id"] == result["away"]

    def test_results_carry_xg_where_known(self):
        """Played Results prints xG under the score; matches without it get no key."""
        with_xg, without = pipeline._results_payload(
            [match(1, "A", "B", "2026-03-01"), match(2, "C", "D", "2026-03-01")],
            shots={"1": (1.234, 0.5, 0.9, 0.2)},
        )
        assert with_xg["xg"] == [1.23, 0.5]
        assert with_xg["xgot"] == [0.9, 0.2]
        assert "xg" not in without and "xgot" not in without

    def test_results_leave_out_xgot_the_source_lacks(self):
        """Sofascore (OBOS-ligaen) has xG but no xG on target: no xgot key."""
        (result,) = pipeline._results_payload([match(1, "A", "B", "2026-03-01")], shots={"1": (1.4, 0.7)})
        assert result["xg"] == [1.4, 0.7]
        assert "xgot" not in result

    def test_xg_form_is_the_rating_change_the_chances_alone_would_give(self):
        """The trend arrow's signal: K * (xG-implied score - expected score), and
        the away side's is the negative. Even ratings, even xG: the home side
        only matched what home advantage expected of it, so it comes out below."""
        from elitetracker.model.elo import EloConfig
        config = EloConfig(k_factor=30, home_advantage=60)
        even = pipeline.xg_form(1500, 1500, 1.4, 1.4, config)
        assert even < 0
        assert pipeline.xg_form(1500, 1500, 3.0, 0.5, config) > 5
        (result,) = pipeline._results_payload(
            [match(1, "A", "B", "2026-03-01")], {"1": (1500.0, 1500.0)}, config, shots={"1": (3.0, 0.5)}
        )
        home, away = result["xg_form"]
        assert home == pytest.approx(-away) and home > 5

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

    def test_position_points_are_exposed(self, tiny_league):
        """The table turns the band thresholds into per-position expected points,
        so the report must carry median points for every finishing position."""
        report = build(tiny_league)
        points = report["model"]["position_points"]
        assert len(points) == len(report["table"])
        for higher, lower in zip(points, points[1:]):
            assert higher >= lower

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
        from elitetracker.model.attack_defence import AttackDefence, outcome_probabilities

        fixture = build(tiny_league, asof="2016-03-01")["fixtures"][0]
        # B hosts A having just lost to them, so A is the stronger side by rating.
        assert fixture["away_rating"] > fixture["home_rating"]
        # The shipped odds blend Elo with the goals model; after a single match the
        # goals model is still nearly neutral (home advantage only), so the test is
        # that Elo's view pulls A's chance above what the neutral grid alone gives.
        neutral = outcome_probabilities(AttackDefence().grid(fixture["home_id"], fixture["away_id"], "2016-03-01"))
        assert fixture["away_win"] > neutral.away_win
        assert fixture["home_win"] < neutral.home_win


class TestFixtureScorelines:
    def test_every_unplayed_fixture_carries_scorelines(self, tiny_league):
        report = build(tiny_league, asof="2016-03-01")
        assert report["fixtures"]
        for fixture in report["fixtures"]:
            assert "scorelines" in fixture
            assert 0 < len(fixture["scorelines"]) <= 5

    def test_scorelines_are_probabilities_under_their_outcome(self, tiny_league):
        fixture = build(tiny_league, asof="2016-03-01")["fixtures"][0]
        # The best single scoreline cannot outrank the largest outcome's probability.
        best = fixture["scorelines"][0]
        top_outcome = max(fixture["home_win"], fixture["draw"], fixture["away_win"])
        assert best["probability"] <= top_outcome + 1e-6
        assert all(0.0 <= line["probability"] <= 1.0 for line in fixture["scorelines"])

    def test_scorelines_sum_to_at_most_one(self, tiny_league):
        fixture = build(tiny_league, asof="2016-03-01")["fixtures"][0]
        assert sum(line["probability"] for line in fixture["scorelines"]) <= 1.0 + 1e-9

    def test_scorelines_are_descending(self, tiny_league):
        fixture = build(tiny_league, asof="2016-03-01")["fixtures"][0]
        probs = [line["probability"] for line in fixture["scorelines"]]
        assert probs == sorted(probs, reverse=True)

    def test_scorelines_are_reproducible(self, tiny_league):
        first = build(tiny_league, asof="2016-03-01")["fixtures"][0]["scorelines"]
        second = build(tiny_league, asof="2016-03-01")["fixtures"][0]["scorelines"]
        assert first == second


class TestBands:
    def test_eliteserien_bands_per_season(self):
        """Pins the per-season European places, checked against each final
        table: league places only, never a cup spot passed down."""
        cl, el, conf = ("Champions League qualification", "Europa League qualification",
                        "Conference League qualification")
        europe = {
            2015: [(cl, 1, 1), (el, 2, 3)], 2016: [(cl, 1, 1), (el, 2, 3)],
            2017: [(cl, 1, 1), (el, 2, 3)], 2018: [(cl, 1, 1), (el, 2, 3)],
            2019: [(cl, 1, 1), (el, 2, 3)], 2020: [(cl, 1, 1), (conf, 2, 4)],
            2021: [(cl, 1, 1), (conf, 2, 3)], 2022: [(cl, 1, 1), (conf, 2, 3)],
            2023: [(cl, 1, 1), (conf, 2, 3)], 2024: [(cl, 1, 2), (conf, 3, 4)],
            2025: [(cl, 1, 2), (el, 3, 3), (conf, 4, 4)], 2026: [(cl, 1, 2), (conf, 3, 4)],
        }
        spec = LEAGUE_SPECS["eliteserien"]
        for season, rows in europe.items():
            expected = [("Champions", 1, 1, "champion")]
            expected += [(label, first, last, "top" if label == cl else "europe") for label, first, last in rows]
            expected += [("Relegation play-off", 14, 14, "playoff"), ("Relegation", 15, 16, "relegation")]
            got = [(b.label, b.first, b.last, b.tone) for b in bands_for(spec, season)]
            assert got == expected, season
        assert bands_for(spec, 2030) == bands_for(spec, 2026)
        assert [b.label for b in bands_for(LEAGUE_SPECS["obosligaen"], 2020)] == [
            "Champions", "Promotion", "Promotion play-off", "Relegation play-off", "Relegation"]

    def test_the_access_list_rule_by_rank(self):
        """Rank boundaries of the access list in force since 2024-25."""
        cl, el, conf = ("Champions League qualification", "Europa League qualification",
                        "Conference League qualification")
        assert _europe_by_rank(12) == ((cl, 1, 2), (el, 3, 3), (conf, 4, 4))
        assert _europe_by_rank(13) == _europe_by_rank(15) == ((cl, 1, 2), (conf, 3, 4))
        assert _europe_by_rank(16) == _europe_by_rank(50) == ((cl, 1, 1), (conf, 2, 3))
        for rank in (6, 51):
            with pytest.raises(ValueError):
                _europe_by_rank(rank)

    def test_a_ranks_file_extends_and_overrides_the_built_in_ranks(self, tmp_path):
        """The refresh writes new seasons' ranks to a file; a season with no
        rank yet takes the newest one known."""
        spec = LEAGUE_SPECS["eliteserien"]
        (tmp_path / UEFA_RANKS_FILE).write_text('{"2026": 20, "2027": 9}', encoding="utf-8")
        assert uefa_ranks(tmp_path)[2025] == 11  # built in
        europe = lambda season: [(b.label, b.first, b.last) for b in bands_for(spec, season, tmp_path)
                                 if b.tone in ("top", "europe")]
        assert europe(2026) == [("Champions League qualification", 1, 1),
                                ("Conference League qualification", 2, 3)]
        assert europe(2027) == [("Champions League qualification", 1, 2),
                                ("Europa League qualification", 3, 3),
                                ("Conference League qualification", 4, 4)]
        assert europe(2028) == europe(2027)


def test_inputs_come_from_the_data_directory_and_reload_on_request(tmp_path):
    """xG is read beside the normalized directory it is asked for, never from
    the working copy's data/; a read is kept until `reload_inputs`."""
    root = tmp_path / "normalized"
    root.mkdir()
    xg = tmp_path / "xg.json"
    xg.write_text(json.dumps({"matches": {"1": [1.0, 2.0]}, "none": []}), encoding="utf-8")
    assert pipeline.shot_table(root) == {"1": (1.0, 2.0)}
    assert pipeline.market_values(root) == {}
    xg.write_text(json.dumps({"matches": {"1": [3.0, 0.5]}, "none": []}), encoding="utf-8")
    assert pipeline.shot_table(root) == {"1": (1.0, 2.0)}
    pipeline.reload_inputs()
    assert pipeline.shot_table(root) == {"1": (3.0, 0.5)}


class TestAttackTrend:
    """The attack map's trend slope, pooled over the division's earlier seasons."""

    def rates(self, monkeypatch, rates, first_xg=None):
        monkeypatch.setattr(pipeline, "season_end_rates", lambda root: rates)
        monkeypatch.setattr(pipeline, "first_xg_seasons", lambda root: first_xg or {})

    def test_pools_earlier_seasons_each_centred_on_its_own_mean(self, monkeypatch):
        # Two seasons on the same slope at different scoring levels: pooled
        # raw, the level shift would tilt the line; centred, it does not.
        low = [(1.0, 1.5), (1.4, 1.3), (1.8, 1.1)]
        high = [(2.0, 2.5), (2.4, 2.3), (2.8, 2.1)]
        self.rates(monkeypatch, {
            ("eliteserien", 2020): low, ("eliteserien", 2021): high,
            ("eliteserien", 2022): [(1.0, 1.0), (2.0, 2.0)],  # the season shown: never pooled
            ("obosligaen", 2021): [(1.0, 1.0), (2.0, 2.0)],
        })
        trend = pipeline.attack_trend("eliteserien", 2022)
        assert trend == {"sxx": pytest.approx(0.64), "syy": pytest.approx(0.16), "sxy": pytest.approx(-0.32), "first": 2020}
        # Orthogonal regression on those sums: the shared slope.
        sxx, syy, sxy = trend["sxx"], trend["syy"], trend["sxy"]
        assert (syy - sxx + math.hypot(syy - sxx, 2 * sxy)) / (2 * sxy) == pytest.approx(-0.5)

    def test_none_before_an_earlier_season(self, monkeypatch):
        self.rates(monkeypatch, {("eliteserien", 2020): [(1.0, 1.5), (1.8, 1.1)]})
        assert pipeline.attack_trend("eliteserien", 2020) is None

    def test_xg_seasons_and_goals_only_seasons_pool_apart(self, monkeypatch):
        clubs = [(1.0, 1.5), (1.4, 1.3), (1.8, 1.1)]
        self.rates(monkeypatch, {("eliteserien", year): clubs for year in range(2017, 2023)},
                   first_xg={"eliteserien": 2020})
        assert pipeline.attack_trend("eliteserien", 2022)["first"] == 2020
        assert pipeline.attack_trend("eliteserien", 2020) is None  # the first xG season fits its own
        assert pipeline.attack_trend("eliteserien", 2019)["first"] == 2017
        assert pipeline.attack_trend("eliteserien", 2023)["sxx"] == pytest.approx(3 * 0.32)  # 2020-2022
