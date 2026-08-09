"""Tests for the caching layer and the fotmob payload extraction.

Nothing here touches the network: the HTML/JSON fixtures are inlined and the
fetch functions are injected.
"""

import json
import os
import time
from datetime import timedelta

import pytest

from elitetracker.sources.cache import Cache
from elitetracker.sources.fotmob import (
    FetchError,
    LEAGUES,
    _assert_season,
    _page_props,
    _validate_matches,
    _validate_standings,
    cache_key,
    league,
)


def page(props):
    return (
        '<html><body><script id="__NEXT_DATA__" type="application/json">'
        + json.dumps({"props": {"pageProps": props}})
        + "</script></body></html>"
    )


class TestCache:
    def test_fetches_on_a_cold_cache(self, tmp_path):
        cache = Cache(tmp_path)
        payload, from_cache = cache.get_or_fetch("k", lambda: [1, 2, 3])
        assert payload == [1, 2, 3]
        assert from_cache is False
        assert cache.path_for("k").exists()

    def test_second_call_avoids_the_network(self, tmp_path):
        cache = Cache(tmp_path)
        calls = []

        def fetch():
            calls.append(1)
            return ["v"]

        cache.get_or_fetch("k", fetch)
        payload, from_cache = cache.get_or_fetch("k", fetch)
        assert payload == ["v"]
        assert from_cache is True
        assert len(calls) == 1

    def test_force_refetches_despite_a_fresh_entry(self, tmp_path):
        cache = Cache(tmp_path)
        cache.get_or_fetch("k", lambda: ["old"])
        payload, from_cache = cache.get_or_fetch("k", lambda: ["new"], force=True)
        assert payload == ["new"]
        assert from_cache is False
        assert cache.read("k") == ["new"]

    def test_stale_entry_is_refetched(self, tmp_path):
        cache = Cache(tmp_path, max_age=timedelta(seconds=60))
        cache.write("k", ["old"])
        stale = time.time() - 3600
        os.utime(cache.path_for("k"), (stale, stale))
        assert cache.is_fresh("k") is False
        payload, from_cache = cache.get_or_fetch("k", lambda: ["new"])
        assert (payload, from_cache) == (["new"], False)

    def test_a_bad_response_never_overwrites_a_good_entry(self, tmp_path):
        """validate runs before the write, so the cache keeps the last good data."""
        cache = Cache(tmp_path, max_age=timedelta(seconds=0))
        cache.write("k", ["good"])

        def reject(payload):
            raise FetchError("truncated")

        with pytest.raises(FetchError):
            cache.get_or_fetch("k", lambda: ["bad"], validate=reject)
        assert cache.read("k") == ["good"]

    def test_cache_hits_are_validated_too(self, tmp_path):
        """Regression: a fotmob key once collided with an archived parse.bot
        file, so 258 rows in a foreign schema were served as a cache hit."""
        cache = Cache(tmp_path)
        cache.write("k", [{"foreign": "schema"}] * 258)

        def only_240(payload):
            if len(payload) != 240:
                raise FetchError(f"expected 240, got {len(payload)}")

        payload, from_cache = cache.get_or_fetch("k", lambda: [{"ok": True}] * 240, validate=only_240)
        assert from_cache is False
        assert len(payload) == 240
        assert len(cache.read("k")) == 240

    def test_a_valid_cache_hit_still_skips_the_network(self, tmp_path):
        cache = Cache(tmp_path)
        cache.write("k", [1, 2])

        def boom():
            raise AssertionError("should not fetch")

        payload, from_cache = cache.get_or_fetch("k", boom, validate=lambda p: None)
        assert (payload, from_cache) == ([1, 2], True)

    def test_unicode_survives_the_round_trip(self, tmp_path):
        cache = Cache(tmp_path)
        cache.write("k", [{"team": "Bodø/Glimt"}])
        assert cache.read("k") == [{"team": "Bodø/Glimt"}]

    def test_age_is_none_when_absent(self, tmp_path):
        assert Cache(tmp_path).age_seconds("nope") is None


class TestLeagueRegistry:
    def test_known_leagues(self):
        assert set(LEAGUES) == {"eliteserien", "obosligaen"}

    def test_obosligaen_uses_fotmobs_own_slug(self):
        assert league("obosligaen").fotmob_path == "1-divisjon"

    def test_unknown_league_is_rejected(self):
        with pytest.raises(FetchError, match="unknown league"):
            league("premier-league")


class TestCacheKey:
    def test_keys_are_namespaced_by_source(self):
        """Otherwise a fotmob fetch reads an archived parse.bot file as its cache."""
        key = cache_key(league("eliteserien"), 2026, "matches")
        assert key == "fotmob_eliteserien_2026_matches"
        assert key != "eliteserien_2026_matches"

    def test_kind_league_and_season_all_vary_the_key(self):
        keys = {
            cache_key(league("eliteserien"), 2026, "matches"),
            cache_key(league("eliteserien"), 2025, "matches"),
            cache_key(league("obosligaen"), 2026, "matches"),
            cache_key(league("eliteserien"), 2026, "standings"),
        }
        assert len(keys) == 4


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

    def test_full_table_passes(self):
        _validate_standings([{}] * 16, league("obosligaen"))

    def test_truncated_table_is_rejected(self):
        with pytest.raises(FetchError, match="expected 16 rows"):
            _validate_standings([{}] * 10, league("obosligaen"))

    def test_non_list_is_rejected(self):
        with pytest.raises(FetchError, match="not a list"):
            _validate_matches({"allMatches": []}, league("eliteserien"))
