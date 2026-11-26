"""Tests for referee payload building and polite backfill CLI."""

from __future__ import annotations

import json
from dataclasses import asdict

from elitetracker.normalize.matches import Match
from elitetracker.pipeline import SEED_SEASON, normalize_referee_name, referees_payload, reload_inputs
from elitetracker.research import backfill_referees
from elitetracker.sources.fotmob import FetchError, load_referees, save_referees


def test_referees_payload_empty_when_file_missing(tmp_path):
    norm = tmp_path / "normalized"
    norm.mkdir()
    reload_inputs()
    payload = referees_payload(norm)
    assert payload == {
        "leagues": ["eliteserien", "obosligaen"],
        "referees": [],
        "teams": {},
        "seasons": [],
        "matches": [],
    }


def test_referees_payload_shapes_matches_and_expected_points(tmp_path):
    norm = tmp_path / "normalized"
    norm.mkdir()
    standings = [
        {"position": 1, "team_id": "1", "team": "Alpha", "played": 30, "wins": 20, "draws": 5, "losses": 5, "goals_for": 60, "goals_against": 25, "goal_difference": 35, "points": 65},
        {"position": 2, "team_id": "2", "team": "Beta", "played": 30, "wins": 15, "draws": 5, "losses": 10, "goals_for": 45, "goals_against": 35, "goal_difference": 10, "points": 50},
    ]
    for lg in ("eliteserien", "obosligaen"):
        (norm / f"{lg}_{SEED_SEASON}_standings.json").write_text(json.dumps(standings), encoding="utf-8")

    es_match = Match("m1", "2015-04-10", "18:00", "Alpha", "Beta", 2, 1, True, home_id="1", away_id="2")
    ob_match = Match("m2", "2015-04-11", "18:00", "Beta", "Alpha", 0, 0, True, home_id="2", away_id="1")
    (norm / "eliteserien_2015_matches.json").write_text(json.dumps([asdict(es_match)]), encoding="utf-8")
    (norm / "obosligaen_2015_matches.json").write_text(json.dumps([asdict(ob_match)]), encoding="utf-8")

    save_referees(
        {
            "matches": {
                "m1": {"referee": "Tore Hansen", "yellow": [2, 3], "red": [0, 1], "fouls": [10, 14]},
            },
            "none": [],
        },
        tmp_path / "referees.json",
    )
    reload_inputs()
    payload = referees_payload(norm)
    assert payload["referees"] == ["Tore Hansen"]
    assert payload["teams"] == {"1": "Alpha", "2": "Beta"}
    assert payload["seasons"] == [2015]
    assert len(payload["matches"]) == 1
    row = payload["matches"][0]
    assert row[0] == "m1"
    assert row[4] == 0  # ref_idx
    assert row[7:9] == [2, 1]
    assert 0.0 <= row[9] <= 3.0 and 0.0 <= row[10] <= 3.0
    assert row[11:17] == [2, 3, 0, 1, 10, 14]
    # The home side's rating change and the change the model expected; no xG here.
    assert len(row) == 21
    assert isinstance(row[17], float) and isinstance(row[18], float)
    assert row[19:21] == [None, None]


def test_expected_rating_change_mirrors_the_update():
    from elitetracker.model.elo import EloConfig, xg_score_part
    from elitetracker.pipeline import _expected_rating_change, _fit_line

    config = EloConfig(k_factor=30.0, xg_alpha=0.3)
    # Without xG: K x (P(win) + P(draw)/2 - Elo's expectation).
    assert abs(_expected_rating_change(config, 0.55, 0.5, 0.3, None, (0.0, 1.0)) - 30.0 * (0.65 - 0.55)) < 1e-12
    # With xG: the result at 1 - alpha, the xG part at the expected goals, through the calibration.
    part = xg_score_part(1.6, 0.9, config)
    got = _expected_rating_change(config, 0.55, 0.5, 0.3, (1.6, 0.9), (0.01, 0.9))
    assert abs(got - 30.0 * (0.7 * 0.65 + 0.01 + 0.9 * part - 0.55)) < 1e-12
    # Mirrored match, mirrored expectation: the expected change is zero-sum like the update.
    away = _expected_rating_change(config, 0.45, 0.2, 0.3, (0.9, 1.6), (0.0, 1.0))
    home = _expected_rating_change(config, 0.55, 0.5, 0.3, (1.6, 0.9), (0.0, 1.0))
    assert abs(home + away) < 1e-12
    assert _fit_line([1.0] * 5, [2.0] * 5) == (0.0, 1.0)
    xs = [i / 10 for i in range(30)]
    a, b = _fit_line(xs, [0.2 + 0.5 * x for x in xs])
    assert abs(a - 0.2) < 1e-9 and abs(b - 0.5) < 1e-9


def test_backfill_referees_resumes_saves_per_match_and_stops_on_429(tmp_path):
    norm = tmp_path / "normalized"
    norm.mkdir()
    matches = [
        Match("m1", "2020-06-16", "18:00", "A", "B", 1, 0, True, home_id="1", away_id="2"),
        Match("m2", "2020-06-17", "18:00", "B", "A", 0, 2, True, home_id="2", away_id="1"),
        Match("m3", "2020-06-18", "18:00", "A", "B", 1, 1, True, home_id="1", away_id="2"),
    ]
    (norm / "eliteserien_2020_matches.json").write_text(json.dumps([asdict(m) for m in matches]), encoding="utf-8")
    (norm / "obosligaen_2020_matches.json").write_text(json.dumps([asdict(m) for m in matches]), encoding="utf-8")
    (norm / "eliteserien_2014_standings.json").write_text("[]", encoding="utf-8")
    (norm / "obosligaen_2014_standings.json").write_text("[]", encoding="utf-8")

    ref_path = tmp_path / "referees.json"
    save_referees({"matches": {"m1": {"referee": "Cached", "yellow": [0, 0], "red": [0, 0], "fouls": None}}, "none": []}, ref_path)
    reload_inputs()

    asked = []

    def fake_fetch(mid):
        asked.append(mid)
        if mid == "m3":
            raise FetchError("HTTP 429 Too Many Requests")
        return {"referee": "Marius Lien", "yellow": [1, 2], "red": [0, 0], "fouls": [8, 9]}

    code = backfill_referees("2020", root=norm, path=ref_path, fetch=fake_fetch, sleep=lambda _s: None)
    assert code == 1
    assert asked == ["m2", "m3"]  # m1 skipped because already cached
    stored = load_referees(ref_path)
    assert "m2" in stored["matches"]  # saved before hitting 429 on m3
    assert "m3" not in stored["matches"]


def test_normalize_referee_name_merges_fotmob_spelling_variants():
    assert normalize_referee_name("Espen Eskaas") == "Espen Eskås"
    assert normalize_referee_name("Marius Hansen Groetta") == "Marius Hansen Grøtta"
    assert normalize_referee_name("Sivert Oeksnes Amland") == "Sivert Øksnes Amland"
    assert normalize_referee_name("Sivert Amland") == "Sivert Øksnes Amland"
    assert normalize_referee_name("Mohammad Aslam") == "Mohammad Usman Aslam"
    assert normalize_referee_name("Tore Hansen") == "Tore Hansen"
