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


def test_match_details_carry_npxg_and_the_first_red_card_on_the_same_request():
    """IMPROVEMENTS 2.1: parsed from the response refresh already fetches."""
    from elitetracker.sources.fotmob import parse_match_details

    shot = lambda team, xg, xgot, situation="RegularPlay": {
        "teamId": team, "expectedGoals": xg, "expectedGoalsOnTarget": xgot, "situation": situation}
    payload = {
        "general": {"homeTeam": {"id": 1}},
        "content": {
            "shotmap": {"shots": [shot(1, 0.3, 0.5), shot(1, 0.79, 0.9, "Penalty"), shot(2, 0.2, 0.0)]},
            "matchFacts": {"events": {"events": [
                {"type": "Card", "card": "Yellow", "time": 10},
                {"type": "Card", "card": "YellowRed", "time": 70},
                {"type": "Card", "card": "Red", "time": 55},
            ]}},
        },
    }
    assert parse_match_details(payload) == (1.09, 0.2, 1.4, 0.0, 0.3, 0.2, 55)
    payload["content"]["matchFacts"]["events"]["events"] = []
    assert parse_match_details(payload)[-1] == 90  # no red card
    assert parse_match_details({"content": {"shotmap": {"shots": []}}}) is None


def test_parse_match_referee_prefers_stats_and_falls_back_to_events():
    from elitetracker.sources.fotmob import parse_match_referee

    es_payload = {
        "general": {"homeTeam": {"id": 1}},
        "content": {
            "matchFacts": {
                "infoBox": {"Referee": {"text": "Ola Hobber Nilsen", "id": 123}},
                "events": {"events": [{"type": "Card", "card": "Yellow", "isHome": True}]},
            },
            "stats": {
                "Periods": {
                    "All": {
                        "stats": [
                            {"stats": [
                                {"key": "yellow_cards", "stats": [2, 3]},
                                {"key": "red_cards", "stats": [0, 1]},
                                {"key": "fouls", "stats": [11, 14]},
                            ]}
                        ]
                    }
                }
            },
        },
    }
    assert parse_match_referee(es_payload) == {
        "referee": "Ola Hobber Nilsen",
        "yellow": [2, 3],
        "red": [0, 1],
        "fouls": [11, 14],
    }

    obos_payload = {
        "general": {"homeTeam": {"id": 10}},
        "content": {
            "matchFacts": {
                "infoBox": {"Referee": {"text": "Tore Hansen", "id": None}},
                "events": {
                    "events": [
                        {"type": "Card", "card": "Yellow", "isHome": True},
                        {"type": "Card", "card": "Yellow", "isHome": False},
                        {"type": "Card", "card": "YellowRed", "teamId": 10},
                        {"type": "Card", "card": "Red", "teamId": 20},
                    ]
                },
            },
            "stats": None,
        },
    }
    assert parse_match_referee(obos_payload) == {
        "referee": "Tore Hansen",
        "yellow": [1, 1],
        "red": [1, 1],
        "fouls": None,
    }
    assert parse_match_referee({"content": {"matchFacts": {"infoBox": {}}}}) is None


def test_update_xg_piggybacks_referees_on_single_request(monkeypatch, tmp_path):
    from datetime import datetime, timezone
    from elitetracker.normalize.matches import Match
    from elitetracker.sources.fotmob import load_referees, load_xg, update_xg

    calls = []

    def fake_payload(mid):
        calls.append(mid)
        return {
            "general": {"homeTeam": {"id": 1}},
            "content": {
                "shotmap": {"shots": [{"teamId": 1, "expectedGoals": 1.2, "expectedGoalsOnTarget": 0.8}]},
                "matchFacts": {"infoBox": {"Referee": {"text": "Marius Lien"}}, "events": {"events": []}},
                "stats": {"Periods": {"All": {"stats": [{"stats": [{"key": "fouls", "stats": [9, 12]}]}]}}},
            },
        }

    monkeypatch.setattr(fotmob, "fetch_match_payload", fake_payload)
    xg_path = tmp_path / "xg.json"
    ref_path = tmp_path / "referees.json"
    match = Match("m1", "2026-05-01", "18:00", "A", "B", 1, 0, True, kickoff_utc="2026-05-01T16:00:00Z", home_id="1", away_id="2")
    added = update_xg([match], path=xg_path, delay=0, now=datetime(2026, 5, 5, tzinfo=timezone.utc), referee_path=ref_path)
    assert added == 1
    assert calls == ["m1"]
    assert "m1" in load_xg(xg_path)["matches"]
    assert load_referees(ref_path)["matches"]["m1"] == {
        "referee": "Marius Lien",
        "yellow": [0, 0],
        "red": [0, 0],
        "fouls": [9, 12],
    }


def test_parse_match_reds_reads_each_red_with_its_minute_and_side():
    from elitetracker.sources.fotmob import parse_match_reds

    payload = {
        "general": {"homeTeam": {"id": 10}},
        "content": {"matchFacts": {"events": {"events": [
            {"type": "Card", "card": "Yellow", "time": 12, "isHome": True},
            {"type": "Card", "card": "YellowRed", "time": 55, "teamId": 10},
            {"type": "Goal", "time": 60, "isHome": False},
            {"type": "Card", "card": "Red", "time": 90, "isHome": False},
        ]}}},
    }
    assert parse_match_reds(payload) == [[55, 0], [90, 1]]
    assert parse_match_reds({"content": {"matchFacts": {"events": {"events": [
        {"type": "Goal", "time": 3, "isHome": True}]}}}}) == []
    assert parse_match_reds({"content": {}}) is None


def test_update_xg_stores_red_cards_from_the_same_request(monkeypatch, tmp_path):
    from datetime import datetime, timezone
    from elitetracker.normalize.matches import Match
    from elitetracker.sources.fotmob import load_red_cards, update_xg

    events = [{"type": "Card", "card": "Red", "time": 34, "isHome": False}]

    def fake_payload(mid):
        return {
            "general": {"homeTeam": {"id": 1}},
            "content": {
                "shotmap": {"shots": [{"teamId": 1, "expectedGoals": 1.2, "expectedGoalsOnTarget": 0.8}]},
                "matchFacts": {"infoBox": {}, "events": {"events": list(events)}},
            },
        }

    monkeypatch.setattr(fotmob, "fetch_match_payload", fake_payload)
    xg_path = tmp_path / "xg.json"
    match = Match("m1", "2026-05-01", "18:00", "A", "B", 1, 0, True, kickoff_utc="2026-05-01T16:00:00Z", home_id="1", away_id="2")
    update_xg([match], path=xg_path, delay=0, now=datetime(2026, 5, 1, 19, tzinfo=timezone.utc))
    assert load_red_cards(tmp_path / "red_cards.json") == {"m1": [[34, 1]]}
    # The re-fetch finds the card rescinded: the match leaves the file.
    events[:] = [{"type": "Goal", "time": 50, "isHome": True}]
    update_xg([match], path=xg_path, delay=0, now=datetime(2026, 5, 3, tzinfo=timezone.utc))
    assert load_red_cards(tmp_path / "red_cards.json") == {}
