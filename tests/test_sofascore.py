"""Tests for the Sofascore OBOS-ligaen xG pull.

Nothing touches the network: the two endpoints are monkeypatched.
"""

import json
from datetime import datetime, timedelta, timezone

import pytest

from elitetracker.normalize.matches import Match
from elitetracker.sources import sofascore
from elitetracker.sources.sofascore import _key, event_xg, update_obos_xg


def match(match_id, home, away, home_goals, away_goals, date="2026-04-05",
          kickoff_utc=None):
    return Match(match_id=match_id, date=date, time="18:00", home=home, away=away,
                 home_goals=home_goals, away_goals=away_goals, played=True,
                 kickoff_utc=kickoff_utc,
                 home_id=f"h{match_id}", away_id=f"a{match_id}")


def at(kickoff: datetime) -> str:
    return kickoff.strftime("%Y-%m-%dT%H:%M:%SZ")


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
        monkeypatch.setattr(sofascore, "_download_sofascore", lambda url: json.dumps(payload))
        assert event_xg(1) == (2.77, 0.8)

    def test_a_fixture_without_the_row_is_none(self, monkeypatch):
        monkeypatch.setattr(sofascore, "_download_sofascore", lambda url: json.dumps({"statistics": []}))
        assert event_xg(1) is None


class TestBlockHandling:
    """A 403 is a dead network, not a bad request: fail fast, do not retry."""

    class _Resp:
        def __init__(self, status, text="", headers=None):
            self.status_code = status
            self.text = text
            self.headers = headers or {}

        def raise_for_status(self):
            if self.status_code >= 400:
                raise AssertionError(f"unexpected raise_for_status on {self.status_code}")

    def test_403_raises_blocked_without_retrying(self, monkeypatch):
        calls = []

        def fake_get(url, **kwargs):
            calls.append(url)
            return self._Resp(403, '{"error": {"code": 403, "reason": "Forbidden" }}')

        monkeypatch.setattr(sofascore.requests, "get", fake_get)
        monkeypatch.setattr(sofascore.time, "sleep", lambda s: None)
        with pytest.raises(sofascore.SofascoreBlocked):
            sofascore._download_sofascore("https://www.sofascore.com/api/v1/x")
        assert len(calls) == 1, "a 403 must not be retried"

    def test_blocked_is_a_fetch_error_so_existing_handlers_still_work(self):
        assert issubclass(sofascore.SofascoreBlocked, sofascore.FetchError)

    def test_429_is_retried_and_then_succeeds(self, monkeypatch):
        seen = []

        def fake_get(url, **kwargs):
            seen.append(url)
            if len(seen) == 1:
                return self._Resp(429, headers={"retry-after": "1"})
            return self._Resp(200, '{"ok": true}')

        monkeypatch.setattr(sofascore.requests, "get", fake_get)
        monkeypatch.setattr(sofascore.time, "sleep", lambda s: None)
        assert sofascore._download_sofascore("https://x") == '{"ok": true}'
        assert len(seen) == 2

    def test_the_default_delay_is_at_least_a_second(self):
        assert sofascore.DEFAULT_DELAY >= 1.0

    def test_a_mid_season_block_stops_the_loop_rather_than_printing_per_match(
        self, monkeypatch, tmp_path
    ):
        events = [{"id": i, "home": "Odds BK", "away": "IK Start",
                   "home_goals": 2, "away_goals": 1, "has_xg": True} for i in range(50)]
        monkeypatch.setattr(sofascore, "season_events", lambda season, delay=0.0: events)
        calls = []

        def blocked(event_id):
            calls.append(event_id)
            raise sofascore.SofascoreBlocked("refused")

        monkeypatch.setattr(sofascore, "event_xg", blocked)
        monkeypatch.setattr(sofascore, "load_xg", lambda: {"matches": {}, "none": []})
        monkeypatch.setattr(sofascore, "save_xg", lambda data: None)
        with pytest.raises(sofascore.SofascoreBlocked):
            update_obos_xg([match("77", "Odds Ballklubb", "Start", 2, 1)], 2026, delay=0.0)
        assert len(calls) == 1, "must abort, not keep requesting after a block"


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


class TestPending:
    """refresh reads this to decide whether a season is worth a request."""

    def _data(self, matches, none=(), pending=None):
        return {"matches": {m: [1.0, 1.0] for m in matches}, "none": list(none),
                "pending": dict(pending or {})}

    def _stub(self, monkeypatch, data):
        monkeypatch.setattr(sofascore, "load_xg", lambda: data)

    def test_a_never_fetched_played_match_is_pending(self, monkeypatch):
        self._stub(monkeypatch, self._data([]))
        assert [m.match_id for m in sofascore.pending_obos_xg(
            [match("77", "Odds Ballklubb", "Start", 2, 1)])] == ["77"]

    def test_an_already_stored_match_is_not_pending(self, monkeypatch):
        self._stub(monkeypatch, self._data(["77"]))
        assert sofascore.pending_obos_xg(
            [match("77", "Odds Ballklubb", "Start", 2, 1)]) == []

    def test_an_old_match_sofascore_reported_no_xg_for_is_not_pending(self, monkeypatch):
        # Under `none` past the recheck window means we asked, it had nothing,
        # and we have stopped asking -- 19 matches in 2023 still have no xG.
        self._stub(monkeypatch, self._data([], none=["77"]))
        assert sofascore.pending_obos_xg(
            [match("77", "Odds Ballklubb", "Start", 2, 1)]) == []

    def test_an_unplayed_match_is_not_pending(self, monkeypatch):
        self._stub(monkeypatch, self._data([]))
        upcoming = Match(match_id="78", date="2026-10-10", time="18:00",
                         home="Odds Ballklubb", away="Start",
                         home_goals=None, away_goals=None, played=False,
                         home_id="h78", away_id="a78")
        assert sofascore.pending_obos_xg([upcoming]) == []


class TestNoneRecheck:
    """`none` is not a final verdict -- Sofascore backfills.

    Seven OBOS fixtures from 2026-09-20 were asked within hours of kickoff,
    filed under `none`, and did have xG on Sofascore 18 days later.
    """

    NOW = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)

    def _run(self, monkeypatch, matchday):
        data = {"matches": {}, "none": ["77"], "pending": {}}
        monkeypatch.setattr(sofascore, "load_xg", lambda: data)
        m = match("77", "Odds Ballklubb", "Start", 2, 1, date=matchday)
        return [x.match_id for x in sofascore.pending_obos_xg([m], now=self.NOW)]

    def test_a_recent_none_entry_is_asked_about_again(self, monkeypatch):
        assert self._run(monkeypatch, "2026-09-20") == ["77"]

    def test_a_none_entry_just_inside_the_window_is_still_asked_about(self, monkeypatch):
        assert self._run(monkeypatch, "2026-09-10") == ["77"]

    def test_a_none_entry_past_the_window_is_left_alone(self, monkeypatch):
        assert self._run(monkeypatch, "2026-09-01") == []

    def test_the_window_is_configurable(self, monkeypatch):
        data = {"matches": {}, "none": ["77"], "pending": {}}
        monkeypatch.setattr(sofascore, "load_xg", lambda: data)
        m = match("77", "Odds Ballklubb", "Start", 2, 1, date="2026-01-01")
        assert [x.match_id for x in sofascore.pending_obos_xg(
            [m], now=self.NOW, none_recheck_days=400)] == ["77"]

    def test_an_unparseable_matchday_is_not_a_reason_to_refetch(self, monkeypatch):
        assert self._run(monkeypatch, "not-a-date") == []

    def test_a_stored_match_is_not_rechecked_just_for_being_recent(self, monkeypatch):
        # Only the `none` list gets a second look; a real value is never in doubt.
        data = {"matches": {"77": [1.0, 1.0]}, "none": [], "pending": {}}
        monkeypatch.setattr(sofascore, "load_xg", lambda: data)
        m = match("77", "Odds Ballklubb", "Start", 2, 1, date="2026-09-20")
        assert sofascore.pending_obos_xg([m], now=self.NOW) == []


class TestSettleWindow:
    """A fetch inside the window is a snapshot of an incomplete feed, so it is
    re-fetched once the window has passed -- and only then."""

    NOW = datetime(2026, 10, 3, 20, 0, tzinfo=timezone.utc)

    def _case(self, fetched_after, elapsed):
        """A match kicked off `elapsed` hours ago whose xG was fetched
        `fetched_after` hours after that kickoff."""
        kickoff = self.NOW - timedelta(hours=elapsed)
        data = {"matches": {"77": [1.0, 1.0]}, "none": [],
                "pending": {"77": at(kickoff + timedelta(hours=fetched_after))}}
        m = match("77", "Odds Ballklubb", "Start", 2, 1, kickoff_utc=at(kickoff))
        return m, data

    def _run(self, monkeypatch, data, m):
        monkeypatch.setattr(sofascore, "load_xg", lambda: data)
        return sofascore.pending_obos_xg([m], now=self.NOW)

    def test_a_fetch_inside_the_window_is_refetched_once_the_window_passes(self, monkeypatch):
        # Fetched 2h after kickoff, inside the 6h window; 20h have now passed, so
        # Sofascore may well have revised it and a fetch now would be settled.
        m, data = self._case(fetched_after=2, elapsed=20)
        assert [x.match_id for x in self._run(monkeypatch, data, m)] == ["77"]

    def test_a_fetch_inside_the_window_is_left_alone_until_the_window_passes(self, monkeypatch):
        # Fetched 2h after kickoff but only 3h have passed: re-fetching now
        # would land just as early, so there is nothing to gain.
        m, data = self._case(fetched_after=2, elapsed=3)
        assert self._run(monkeypatch, data, m) == []

    def test_a_stored_match_with_no_pending_record_is_settled(self, monkeypatch):
        # Pre-existing archive entries carry no timestamp: treat them as final
        # rather than re-fetching every season on the first run.
        data = {"matches": {"77": [1.0, 1.0]}, "none": [], "pending": {}}
        m = match("77", "Odds Ballklubb", "Start", 2, 1,
                  kickoff_utc="2026-10-03T16:00:00Z")
        monkeypatch.setattr(sofascore, "load_xg", lambda: data)
        assert sofascore.pending_obos_xg([m], now=self.NOW) == []

    def test_a_pending_match_with_no_kickoff_is_not_refetched_forever(self, monkeypatch):
        # Without a kickoff we cannot tell the window has passed, so leave it.
        data = {"matches": {"77": [1.0, 1.0]}, "none": [], "pending": {"77": "2026-10-03T17:00:00Z"}}
        m = match("77", "Odds Ballklubb", "Start", 2, 1, kickoff_utc=None)
        assert self._run(monkeypatch, data, m) == []


class TestPendingIsRecorded:
    def _stub(self, monkeypatch, events):
        monkeypatch.setattr(sofascore, "season_events", lambda season, delay=0.0: events)
        monkeypatch.setattr(sofascore, "save_xg", lambda data: None)

    EVENT = [{"id": 9, "home": "Odds BK", "away": "IK Start",
              "home_goals": 2, "away_goals": 1, "has_xg": True}]

    def test_a_fetch_inside_the_window_is_recorded_for_later(self, monkeypatch):
        self._stub(monkeypatch, self.EVENT)
        monkeypatch.setattr(sofascore, "event_xg", lambda event_id: (1.5, 0.9))
        written = {}
        monkeypatch.setattr(sofascore, "load_xg", lambda: {"matches": {}, "none": []})
        monkeypatch.setattr(sofascore, "save_xg", lambda data: written.update(data))
        recent = datetime.now(timezone.utc) - timedelta(minutes=30)
        m = match("77", "Odds Ballklubb", "Start", 2, 1, kickoff_utc=at(recent))
        update_obos_xg([m], 2026, delay=0.0)
        assert "77" in written["pending"]

    def test_a_fetch_after_the_window_is_not_recorded(self, monkeypatch):
        self._stub(monkeypatch, self.EVENT)
        monkeypatch.setattr(sofascore, "event_xg", lambda event_id: (1.5, 0.9))
        written = {}
        monkeypatch.setattr(sofascore, "load_xg", lambda: {"matches": {}, "none": []})
        monkeypatch.setattr(sofascore, "save_xg", lambda data: written.update(data))
        old = datetime.now(timezone.utc) - timedelta(days=2)
        m = match("77", "Odds Ballklubb", "Start", 2, 1, kickoff_utc=at(old))
        update_obos_xg([m], 2026, delay=0.0)
        assert written["pending"] == {}

    def test_only_the_requested_matches_are_fetched(self, monkeypatch):
        events = self.EVENT + [{"id": 10, "home": "Lyn FK", "away": "Moss FK",
                                 "home_goals": 1, "away_goals": 0, "has_xg": True}]
        self._stub(monkeypatch, events)
        asked = []
        monkeypatch.setattr(sofascore, "event_xg",
                            lambda eid: asked.append(eid) or (1.0, 1.0))
        monkeypatch.setattr(sofascore, "load_xg", lambda: {"matches": {}, "none": []})
        old = datetime.now(timezone.utc) - timedelta(days=2)
        wanted = match("77", "Odds Ballklubb", "Start", 2, 1, kickoff_utc=at(old))
        other = match("78", "Lyn", "Moss", 1, 0, kickoff_utc=at(old))
        update_obos_xg([wanted, other], 2026, delay=0.0, only=[wanted])
        assert asked == [9]
