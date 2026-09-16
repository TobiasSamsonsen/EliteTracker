"""Tests for the Sofascore OBOS-ligaen xG pull.

Nothing touches the network: the two endpoints are monkeypatched.
"""

import json

import pytest

from elitetracker.normalize.matches import Match
from elitetracker.sources import sofascore
from elitetracker.sources.sofascore import _key, event_xg, update_obos_xg


def match(match_id, home, away, home_goals, away_goals, date="2026-04-05"):
    return Match(match_id=match_id, date=date, time="18:00", home=home, away=away,
                 home_goals=home_goals, away_goals=away_goals, played=True,
                 home_id=f"h{match_id}", away_id=f"a{match_id}")


class TestNameKey:
    @pytest.mark.parametrize("sofascore_name, fotmob_name", [
        ("Odds BK", "Odds Ballklubb"),
        ("IK Start", "Start"),
        ("Aalesunds FK", "Aalesund"),
        ("KFUM Oslo", "KFUM"),
        ("Stabæk Fotball", "Stabæk"),
        ("Hødd IL", "Hødd"),
    ])
    def test_the_two_feeds_spellings_agree(self, sofascore_name, fotmob_name):
        assert _key(sofascore_name) == _key(fotmob_name)

    def test_different_clubs_stay_apart(self):
        assert _key("Strømmen IF") != _key("Strømsgodset")


class TestEventXg:
    def test_reads_the_expected_goals_row(self, monkeypatch):
        payload = {"statistics": [
            {"period": "1ST", "groups": [{"statisticsItems": [
                {"key": "expectedGoals", "homeValue": 0.5, "awayValue": 0.1}]}]},
            {"period": "ALL", "groups": [
                {"statisticsItems": [{"key": "ballPossession", "homeValue": 60, "awayValue": 40}]},
                {"statisticsItems": [{"key": "expectedGoals", "homeValue": 2.77, "awayValue": 0.8}]}]},
        ]}
        monkeypatch.setattr(sofascore, "_download", lambda url: json.dumps(payload))
        assert event_xg(1) == (2.77, 0.8)

    def test_a_fixture_without_the_row_is_none(self, monkeypatch):
        monkeypatch.setattr(sofascore, "_download", lambda url: json.dumps({"statistics": []}))
        assert event_xg(1) is None


class TestUpdate:
    def _patch(self, monkeypatch, tmp_path, events, xg=(1.5, 0.9)):
        monkeypatch.setattr(sofascore, "season_events", lambda season, delay=0.0: events)
        monkeypatch.setattr(sofascore, "event_xg", lambda event_id: xg)
        path = tmp_path / "xg.json"
        monkeypatch.setattr(sofascore, "load_xg", lambda: {"matches": {}, "none": []})
        written = {}
        monkeypatch.setattr(sofascore, "save_xg", lambda data: written.update(data))
        return written

    def test_joins_on_club_names_and_stores_two_values(self, monkeypatch, tmp_path):
        events = [{"id": 9, "home": "Odds BK", "away": "IK Start",
                   "home_goals": 2, "away_goals": 1, "has_xg": True}]
        written = self._patch(monkeypatch, tmp_path, events)
        added = update_obos_xg([match("77", "Odds Ballklubb", "Start", 2, 1)], 2026, delay=0.0)
        assert added == 1
        # Sofascore has no xG on target: the entry stays two values long.
        assert written["matches"] == {"77": [1.5, 0.9]}

    def test_a_score_that_disagrees_is_skipped(self, monkeypatch, tmp_path):
        events = [{"id": 9, "home": "Odds BK", "away": "IK Start",
                   "home_goals": 3, "away_goals": 1, "has_xg": True}]
        self._patch(monkeypatch, tmp_path, events)
        assert update_obos_xg([match("77", "Odds Ballklubb", "Start", 2, 1)], 2026, delay=0.0) == 0

    def test_a_playoff_fixture_we_do_not_hold_is_skipped(self, monkeypatch, tmp_path):
        events = [{"id": 9, "home": "Tromsdalen UIL", "away": "Lyn FK",
                   "home_goals": 0, "away_goals": 1, "has_xg": True}]
        self._patch(monkeypatch, tmp_path, events)
        assert update_obos_xg([match("77", "Odds Ballklubb", "Start", 2, 1)], 2026, delay=0.0) == 0

    def test_seasons_before_sofascore_has_xg_are_not_fetched(self):
        assert update_obos_xg([match("77", "Odds Ballklubb", "Start", 2, 1)], 2022) == 0
