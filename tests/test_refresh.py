"""Tests for the one-command data refresh.

Nothing touches the network: the fetch function is injected, so the whole
fetch -> normalize -> validate -> write pipeline runs on inline payloads.
"""

import json
from datetime import date

import pytest

from elitetracker.refresh import RefreshError, refresh_matches
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
        results = refresh_matches(
            tmp_path,
            season=2026,
            leagues=["eliteserien"],
            fetch=lambda slug, season, *, force: raw_payload(played),
            today=TODAY,
        )
        result = results[0]
        assert result.played == len(played)
        assert result.matches == 240
        assert result.last_result == "2026-03-25"

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
        results = refresh_matches(
            tmp_path, season=2026, leagues=["eliteserien"],
            fetch=lambda *a, **k: second, today=TODAY,
        )
        assert results[0].played == 2
        records = json.loads((tmp_path / "eliteserien_2026_matches.json").read_text(encoding="utf-8"))
        assert {m["match_id"] for m in records if m["played"]} == {"0001", "0002"}

    def test_force_flag_is_forwarded(self, tmp_path):
        calls = []

        def fake(slug, season, *, force):
            calls.append(force)
            return raw_payload()

        refresh_matches(tmp_path, season=2026, leagues=["eliteserien"], fetch=fake, today=TODAY)
        refresh_matches(tmp_path, season=2026, leagues=["eliteserien"], fetch=fake, force=False, today=TODAY)
        assert calls == [True, False]

    def test_refresh_defaults_to_both_leagues(self, tmp_path):
        refresh_matches(
            tmp_path, season=2026,
            fetch=lambda slug, season, *, force: raw_payload(),
            today=TODAY,
        )
        assert (tmp_path / "eliteserien_2026_matches.json").exists()
        assert (tmp_path / "obosligaen_2026_matches.json").exists()

    def test_season_defaults_to_the_latest_with_data(self, tmp_path):
        (tmp_path / "eliteserien_2021_matches.json").write_text("[]", encoding="utf-8")
        (tmp_path / "obosligaen_2021_matches.json").write_text("[]", encoding="utf-8")

        results = refresh_matches(
            tmp_path,
            fetch=lambda slug, season, *, force: raw_payload(),
            today=TODAY,
        )
        assert {result.season for result in results} == {2021}
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
        with pytest.raises(RefreshError, match="refusing to write"):
            refresh_matches(
                tmp_path, season=2026, leagues=["eliteserien"],
                fetch=lambda *a, **k: one_off, today=TODAY,
            )
        assert path.read_text(encoding="utf-8") == "sentinel"

    def test_failed_fetch_keeps_the_previous_file(self, tmp_path):
        path = tmp_path / "eliteserien_2026_matches.json"
        path.write_text("sentinel", encoding="utf-8")

        def boom(slug, season, *, force):
            raise FetchError("unreachable")

        with pytest.raises(FetchError, match="unreachable"):
            refresh_matches(tmp_path, season=2026, leagues=["eliteserien"], fetch=boom, today=TODAY)
        assert path.read_text(encoding="utf-8") == "sentinel"

    def test_no_file_is_created_when_validation_fails(self, tmp_path):
        with pytest.raises(RefreshError):
            refresh_matches(
                tmp_path, season=2026, leagues=["eliteserien"],
                fetch=lambda *a, **k: [], today=TODAY,
            )
        assert not (tmp_path / "eliteserien_2026_matches.json").exists()