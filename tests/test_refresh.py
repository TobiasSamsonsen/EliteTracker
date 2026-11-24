"""Tests for the one-command data refresh.

Nothing touches the network: the fetch function is injected, so the whole
fetch -> normalize -> validate -> write pipeline runs on inline payloads.
"""

import json
from datetime import date, datetime, timedelta, timezone

import pytest

from elitetracker import refresh
from elitetracker.refresh import refresh_matches
from elitetracker.sources.fotmob import FetchError

TODAY = date(2026, 8, 9)

TEAMS = [f"Team {chr(ord('A') + i)}" for i in range(16)]
TEAM_IDS = {team: str(index + 1) for index, team in enumerate(TEAMS)}


def raw_match_for(mid, home, away, day, finished):
    status = {
        "utcTime": f"2026-03-{day:02d}T19:00:00Z",
        "finished": finished,
        "started": finished,
        "cancelled": False,
    }
    if finished:
        status["scoreStr"] = "1 - 0"
    return {
        "round": "1",
        "roundName": 1,
        "id": mid,
        "home": {"name": home, "id": TEAM_IDS[home]},
        "away": {"name": away, "id": TEAM_IDS[away]},
        "status": status,
    }


def raw_payload(played_ids=()):
    """A full 16-team double round-robin, with the given ids marked finished."""
    played = set(played_ids)
    matches, counter = [], 0
    for home in TEAMS:
        for away in TEAMS:
            if home == away:
                continue
            counter += 1
            mid = f"{counter:04d}"
            matches.append(raw_match_for(mid, home, away, 1 + counter // 10, mid in played))
    return matches


class TestRefreshMatches:
    def test_writes_a_valid_normalized_file(self, tmp_path):
        played = {"0001", "0033", "0155", "0240"}
        refresh_matches(
            tmp_path,
            season=2026,
            leagues=["eliteserien"],
            fetch=lambda slug, season: raw_payload(played),
            today=TODAY,
        )
        path = tmp_path / "eliteserien_2026_matches.json"
        records = json.loads(path.read_text(encoding="utf-8"))
        assert len(records) == 240
        played_in_file = {m["match_id"] for m in records if m["played"]}
        assert played_in_file == played

    def test_refreshed_payload_updates_played_matches(self, tmp_path):
        """A second refresh sees results the first feed did not have."""
        first = raw_payload(played_ids={"0001"})
        second = raw_payload(played_ids={"0001", "0002"})

        refresh_matches(
            tmp_path, season=2026, leagues=["eliteserien"],
            fetch=lambda *a, **k: first, today=TODAY,
        )
        refresh_matches(                     # (the guard has its own tests below: these March kick-offs are long stale)
            tmp_path, season=2026, leagues=["eliteserien"],
            fetch=lambda *a, **k: second, today=TODAY, refresh_guard=False,
        )
        records = json.loads((tmp_path / "eliteserien_2026_matches.json").read_text(encoding="utf-8"))
        assert {m["match_id"] for m in records if m["played"]} == {"0001", "0002"}

    def test_refresh_defaults_to_both_leagues(self, tmp_path):
        refresh_matches(
            tmp_path, season=2026,
            fetch=lambda slug, season: raw_payload(),
            today=TODAY,
        )
        assert (tmp_path / "eliteserien_2026_matches.json").exists()
        assert (tmp_path / "obosligaen_2026_matches.json").exists()

    def test_season_defaults_to_the_latest_with_data(self, tmp_path):
        (tmp_path / "eliteserien_2021_matches.json").write_text("[]", encoding="utf-8")
        (tmp_path / "obosligaen_2021_matches.json").write_text("[]", encoding="utf-8")

        refresh_matches(
            tmp_path,
            fetch=lambda slug, season: raw_payload(),
            today=TODAY,
            refresh_guard=False,
        )
        assert (tmp_path / "eliteserien_2021_matches.json").exists()
        assert (tmp_path / "obosligaen_2021_matches.json").exists()

    def test_no_partial_tmp_files_left_behind(self, tmp_path):
        refresh_matches(
            tmp_path, season=2026, leagues=["eliteserien"],
            fetch=lambda *a, **k: raw_payload(), today=TODAY,
        )
        assert list(tmp_path.glob("*.tmp")) == []


class TestRefreshFailsafe:
    def test_bad_payload_raises_and_keeps_the_previous_file(self, tmp_path):
        path = tmp_path / "eliteserien_2026_matches.json"
        path.write_text("sentinel", encoding="utf-8")

        one_off = [raw_match_for("0001", "Team A", "Team B", 5, True)]
        with pytest.raises(SystemExit, match="refusing to write"):
            refresh_matches(
                tmp_path, season=2026, leagues=["eliteserien"],
                fetch=lambda *a, **k: one_off, today=TODAY,
            )
        assert path.read_text(encoding="utf-8") == "sentinel"

    def test_failed_fetch_keeps_the_previous_file(self, tmp_path):
        path = tmp_path / "eliteserien_2026_matches.json"
        path.write_text("sentinel", encoding="utf-8")

        def boom(slug, season):
            raise FetchError("unreachable")

        with pytest.raises(FetchError, match="unreachable"):
            refresh_matches(tmp_path, season=2026, leagues=["eliteserien"], fetch=boom, today=TODAY)
        assert path.read_text(encoding="utf-8") == "sentinel"

    def test_no_file_is_created_when_validation_fails(self, tmp_path):
        with pytest.raises(SystemExit):
            refresh_matches(
                tmp_path, season=2026, leagues=["eliteserien"],
                fetch=lambda *a, **k: [], today=TODAY,
            )
        assert not (tmp_path / "eliteserien_2026_matches.json").exists()


class TestCiSkipsObosXg:
    """Sofascore refuses runner IPs, so CI must not keep asking for it."""

    def _stub(self, monkeypatch, called, tmp_path, pending=True):
        # main() reads both league files, so they have to exist. The OBOS one
        # needs a played match, or there is nothing to fetch and the pull is
        # correctly skipped.
        (tmp_path / "eliteserien_2026_matches.json").write_text("[]", encoding="utf-8")
        rows = [{
            "match_id": "77", "date": "2026-10-03", "time": "18:00",
            "home": "Odds Ballklubb", "away": "Start",
            "home_goals": 2, "away_goals": 1, "played": True,
            "kickoff_utc": "2026-10-03T16:00:00Z",
            "home_id": "h77", "away_id": "a77",
        }]
        (tmp_path / "obosligaen_2026_matches.json").write_text(
            json.dumps(rows), encoding="utf-8")
        monkeypatch.setattr(
            refresh, "pending_obos_xg",
            lambda m: list(m) if pending else [])
        monkeypatch.setattr(refresh, "update_obos_xg", lambda *a, **k: called.append(a) or 0)
        monkeypatch.setattr(refresh, "update_xg", lambda *a, **k: 0)
        monkeypatch.setattr(refresh, "refresh_matches", lambda *a, **k: None)

    def test_ci_does_not_call_sofascore(self, monkeypatch, tmp_path, capsys):
        called = []
        monkeypatch.setenv("GITHUB_ACTIONS", "true")
        self._stub(monkeypatch, called, tmp_path)
        refresh.main(["--root", str(tmp_path), "--season", "2026"])
        assert called == []
        assert "skipped in CI" in capsys.readouterr().out

    def test_local_still_fetches(self, monkeypatch, tmp_path):
        called = []
        monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
        self._stub(monkeypatch, called, tmp_path)
        refresh.main(["--root", str(tmp_path), "--season", "2026"])
        assert len(called) == 1

    def test_the_flag_forces_it_even_in_ci(self, monkeypatch, tmp_path):
        called = []
        monkeypatch.setenv("GITHUB_ACTIONS", "true")
        self._stub(monkeypatch, called, tmp_path)
        refresh.main(["--root", str(tmp_path), "--season", "2026", "--obos-xg"])
        assert len(called) == 1

    def test_nothing_pending_costs_no_request(self, monkeypatch, tmp_path, capsys):
        called = []
        monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
        self._stub(monkeypatch, called, tmp_path, pending=False)
        refresh.main(["--root", str(tmp_path), "--season", "2026"])
        assert called == []
        assert "nothing outstanding" in capsys.readouterr().out

    def test_the_target_set_is_passed_through(self, monkeypatch, tmp_path):
        seen = {}

        def fake(matches, season, *, only=None, **k):
            seen["only"] = [m.match_id for m in only]
            return 0

        monkeypatch.delenv("GITHUB_ACTIONS", raising=False)
        self._stub(monkeypatch, [], tmp_path)
        monkeypatch.setattr(refresh, "update_obos_xg", fake)
        refresh.main(["--root", str(tmp_path), "--season", "2026"])
        assert seen["only"] == ["77"]

def test_play_offs_are_asked_for_only_while_they_are_on(tmp_path):
    from datetime import datetime, timezone

    from elitetracker.normalize.matches import Match, dump
    from elitetracker.refresh import refresh_playoffs

    def obos(played):
        dump([Match(match_id="m", date="2026-11-15", time="15:00", home="A", away="B", home_goals=1 if played else None,
                    away_goals=0 if played else None, played=played, home_id="A", away_id="B",
                    kickoff_utc="2026-11-15T14:00:00Z")],
             tmp_path / "obosligaen_2026_matches.json")

    calls = []
    fixture = {"id": "1", "home": {"name": "Odd", "id": "7988"}, "away": {"name": "Bryne", "id": "8531"},
               "status": {"utcTime": "2026-11-29T13:30:00Z", "finished": False, "cancelled": False}}

    def fetch(season):
        calls.append(season)
        return [fixture]

    at = lambda day, hour: datetime(2026, 11, day, hour, 5, tzinfo=timezone.utc)
    obos(False)
    refresh_playoffs(tmp_path, 2026, fetch=fetch, now=at(22, 10))
    assert calls == []                                   # OBOS-ligaen still playing
    obos(True)
    refresh_playoffs(tmp_path, 2026, fetch=fetch, now=at(22, 10))
    assert calls == [2026]                               # first sight
    stored = json.loads((tmp_path / "playoff_fixtures.json").read_text(encoding="utf-8"))["2026"]
    assert stored[0]["home_id"] == "7988" and stored[0]["played"] is False
    refresh_playoffs(tmp_path, 2026, fetch=fetch, now=at(23, 10))
    assert calls == [2026]                               # nothing due, off-hours
    refresh_playoffs(tmp_path, 2026, fetch=fetch, now=at(23, 18))
    assert calls == [2026] * 2                           # a check hour
    refresh_playoffs(tmp_path, 2026, fetch=fetch, now=at(29, 15))
    assert calls == [2026] * 3                           # kicked off, no result yet

    def failing(season):
        raise FetchError("HTTP 429")
    refresh_playoffs(tmp_path, 2026, fetch=failing, now=at(29, 16))   # non-fatal, stored matches stand
    assert json.loads((tmp_path / "playoff_fixtures.json").read_text(encoding="utf-8"))["2026"] == stored
    (tmp_path / "playoff_outcomes.json").write_text('{"2026": {}}', encoding="utf-8")
    refresh_playoffs(tmp_path, 2026, fetch=fetch, now=at(29, 18))
    assert calls == [2026] * 3                           # on file by hand: done


def _league_file(tmp_path, kickoff, played=False):
    record = {"match_id": "1", "date": kickoff.date().isoformat(), "time": "12:00", "home": "A", "away": "B",
              "home_goals": 1 if played else None, "away_goals": 0 if played else None, "played": played,
              "kickoff_utc": kickoff.isoformat().replace("+00:00", "Z"), "round": 1, "home_id": "a", "away_id": "b"}
    (tmp_path / "eliteserien_2026_matches.json").write_text(json.dumps([record]), encoding="utf-8")


def test_fotmob_is_asked_only_once_a_result_can_be_there(tmp_path):
    kickoff = datetime(2026, 11, 28, 15, 0, tzinfo=timezone.utc)
    _league_file(tmp_path, kickoff)
    asked = lambda minutes: refresh._needs_refresh("eliteserien", 2026, tmp_path, kickoff + timedelta(minutes=minutes))  # noqa: E731
    assert not asked(-30) and not asked(45) and not asked(99)     # before kick-off, and while the match is on
    assert asked(100) and asked(115) and asked(11 * 60)             # from about the end, every time the refresh runs
    # long past: probably put off, asked about at 06 and 18 UTC (first quarter of the hour) only
    late = kickoff.replace(hour=6, minute=5) + timedelta(days=1)
    assert refresh._needs_refresh("eliteserien", 2026, tmp_path, late)
    assert not refresh._needs_refresh("eliteserien", 2026, tmp_path, late.replace(minute=30))
    assert not refresh._needs_refresh("eliteserien", 2026, tmp_path, late.replace(hour=9))


def test_a_played_match_or_a_missing_file_is_decided_as_before(tmp_path):
    kickoff = datetime(2026, 11, 28, 15, 0, tzinfo=timezone.utc)
    assert refresh._needs_refresh("eliteserien", 2026, tmp_path, kickoff)           # no file yet
    _league_file(tmp_path, kickoff, played=True)
    assert not refresh._needs_refresh("eliteserien", 2026, tmp_path, kickoff + timedelta(hours=3))
