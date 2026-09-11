"""Tests for the fotmob payload extraction and archive write.

Nothing here touches the network: the HTML/JSON fixtures are inlined and the
download is monkeypatched.
"""

import json

import pytest

from elitetracker.sources import fotmob
from elitetracker.sources.fotmob import (
    FetchError,
    LEAGUES,
    _assert_season,
    _page_props,
    _validate_matches,
    fetch_matches,
    league,
)


def page(props):
    return (
        '<html><body><script id="__NEXT_DATA__" type="application/json">'
        + json.dumps({"props": {"pageProps": props}})
        + "</script></body></html>"
    )


class TestLeagueRegistry:
    def test_known_leagues(self):
        assert set(LEAGUES) == {"eliteserien", "obosligaen"}

    def test_obosligaen_uses_fotmobs_own_slug(self):
        assert league("obosligaen").fotmob_path == "1-divisjon"

    def test_unknown_league_is_rejected(self):
        with pytest.raises(FetchError, match="unknown league"):
            league("premier-league")


class TestPageProps:
    def test_extracts_embedded_json(self):
        assert _page_props(page({"details": {"name": "Eliteserien"}}), "u")["details"]["name"] == "Eliteserien"

    def test_missing_script_tag_is_reported(self):
        with pytest.raises(FetchError, match="no __NEXT_DATA__"):
            _page_props("<html>nothing here</html>", "u")

    def test_malformed_json_is_reported(self):
        html = '<script id="__NEXT_DATA__" type="application/json">{oops</script>'
        with pytest.raises(FetchError, match="unexpected __NEXT_DATA__"):
            _page_props(html, "u")

    def test_unexpected_shape_is_reported(self):
        html = '<script id="__NEXT_DATA__" type="application/json">{"props": {}}</script>'
        with pytest.raises(FetchError, match="unexpected __NEXT_DATA__"):
            _page_props(html, "u")


class TestSeasonGuard:
    def test_matching_season_passes(self):
        _assert_season({"details": {"selectedSeason": "2025"}}, 2025, "u")

    def test_silent_season_fallback_is_caught(self):
        """fotmob serves the current season rather than erroring on a bad param."""
        with pytest.raises(FetchError, match="served"):
            _assert_season({"details": {"selectedSeason": "2026"}}, 2025, "u")

    def test_absent_season_field_is_tolerated(self):
        _assert_season({"details": {}}, 2025, "u")


class TestPayloadValidation:
    def test_full_fixture_list_passes(self):
        _validate_matches([{}] * 240, league("eliteserien"))

    def test_truncated_fixture_list_is_rejected(self):
        with pytest.raises(FetchError, match="expected 240 matches"):
            _validate_matches([{}] * 239, league("eliteserien"))

    def test_non_list_is_rejected(self):
        with pytest.raises(FetchError, match="not a list"):
            _validate_matches({"allMatches": []}, league("eliteserien"))


class TestFetchMatches:
    def test_archives_a_valid_payload(self, monkeypatch, tmp_path):
        props = {"details": {"selectedSeason": "2026"}, "fixtures": {"allMatches": [{"team": "Bodø/Glimt"}] * 240}}
        monkeypatch.setattr(fotmob, "_download", lambda url: page(props))
        payload = fetch_matches("eliteserien", 2026, cache_dir=tmp_path)
        assert len(payload) == 240
        archived = json.loads((tmp_path / "fotmob_eliteserien_2026_matches.json").read_text(encoding="utf-8"))
        assert archived == payload

    def test_a_bad_response_is_not_archived(self, monkeypatch, tmp_path):
        props = {"details": {"selectedSeason": "2026"}, "fixtures": {"allMatches": [{}] * 10}}
        monkeypatch.setattr(fotmob, "_download", lambda url: page(props))
        with pytest.raises(FetchError, match="expected 240"):
            fetch_matches("eliteserien", 2026, cache_dir=tmp_path)
        assert list(tmp_path.iterdir()) == []
