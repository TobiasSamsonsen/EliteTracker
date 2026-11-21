import json

from elitetracker.bundles import seasons_on_disk, summary_payload, timeline_name, timeline_payload, write_timelines


def _report(rows_by_league):
    return {
        league: {"table": [
            {"team_id": team_id, "position": position, "rating": rating, "position_probabilities": probs, "team": "x"}
            for team_id, position, rating, probs in rows
        ]}
        for league, rows in rows_by_league.items()
    }


def _write(tmp_path, name, rows_by_league):
    (tmp_path / name).write_text(json.dumps(_report(rows_by_league)), encoding="utf-8")


def test_timeline_copies_each_dated_report_and_ignores_the_rest(tmp_path):
    _write(tmp_path, "report-2025-2025-03-01.json", {"eliteserien": [(1, 2, 1500.5, [0.25, 0.75])]})
    _write(tmp_path, "report-2025-2025-03-08.json", {
        "eliteserien": [(1, 1, 1510.25, [0.5, 0.5])],
        "obosligaen": [(9, 1, 1400.0, [1.0])],
    })
    _write(tmp_path, "report-2025.json", {"eliteserien": [(1, 1, 1, [1.0])]})  # the live view is not a date
    _write(tmp_path, "report-2024-2024-04-01.json", {"eliteserien": [(5, 1, 1, [1.0])]})  # another season

    payload = timeline_payload(tmp_path, 2025)

    assert payload == {"season": 2025, "dates": {
        "2025-03-01": {"eliteserien": [[1, 2, 1500.5, [0.25, 0.75]]]},
        "2025-03-08": {"eliteserien": [[1, 1, 1510.25, [0.5, 0.5]]], "obosligaen": [[9, 1, 1400.0, [1.0]]]},
    }}
    assert timeline_payload(tmp_path, 2030) is None
    assert seasons_on_disk(tmp_path) == [2024, 2025]


def test_write_timelines_fills_gaps_and_rewrites_only_rebuilt_seasons(tmp_path):
    _write(tmp_path, "report-2024-2024-04-01.json", {"eliteserien": [(5, 1, 1.0, [1.0])]})
    _write(tmp_path, "report-2025-2025-03-01.json", {"eliteserien": [(1, 1, 1.0, [1.0])]})
    kept = tmp_path / timeline_name(2024)
    kept.write_text("kept", encoding="utf-8")

    # 2024 has a timeline and was not rebuilt; 2025 has none.
    assert write_timelines(tmp_path, rebuilt=set()) == [timeline_name(2025)]
    assert kept.read_text(encoding="utf-8") == "kept"
    assert json.loads((tmp_path / timeline_name(2025)).read_text(encoding="utf-8"))["season"] == 2025

    # A rebuilt season is rewritten even though its timeline exists.
    assert write_timelines(tmp_path, rebuilt={2024}) == [timeline_name(2024)]
    assert json.loads(kept.read_text(encoding="utf-8"))["season"] == 2024


def _live(season, preseason, final, results, pre_probs=None, history=None):
    return {"eliteserien": {
        "league": {"season": season, "preseason": preseason},
        "model": {"matches_remaining": 0, "simulations": 5},
        "table": [{"team_id": "1", "team": "Viking", "position": final, "rating": 1500, "position_probabilities": [1.0]}],
        "results": results,
        "history": history or {},
    }}


def test_summary_keeps_only_what_luck_and_the_scorecard_read(tmp_path):
    result = {"match_id": "m1", "home_id": "1", "away_id": "2", "home": "Viking", "away": "Brann",
              "home_goals": 2, "away_goals": 1, "xg": [1.5, 0.5], "date": "2025-04-01", "odds": [0.5, 0.3, 0.2]}
    (tmp_path / "report-2025.json").write_text(json.dumps(_live(2025, "2025-03-01", 3, [result])), encoding="utf-8")
    _write(tmp_path, "report-2025-2025-03-01.json", {"eliteserien": [("1", 1, 1500.0, [0.4, 0.6])]})
    # A season with no pre-season report falls back to the season shape's first snapshot.
    history = {"latest_rounds": [None, 1], "teams": [{"team_id": "1", "positions": [[0.7, 0.3], [0.5, 0.5]]}]}
    (tmp_path / "report-2024.json").write_text(json.dumps(_live(2024, None, 1, [], history=history)), encoding="utf-8")
    _write(tmp_path, "report-2024-2024-04-01.json", {"eliteserien": [("1", 1, 1.0, [1.0])]})

    seasons = summary_payload(tmp_path)["seasons"]

    body = seasons["2025"]["eliteserien"]
    assert body["league"] == {"season": 2025, "slug": "eliteserien", "preseason": "2025-03-01"}
    assert body["model"] == {"matches_remaining": 0}
    assert body["table"] == [{"team_id": "1", "team": "Viking", "position": 3}]
    assert body["results"] == [{k: result[k] for k in ("match_id", "home_id", "away_id", "home", "away", "home_goals", "away_goals", "xg")}]
    assert body["pre"] == [{"team_id": "1", "position_probabilities": [0.4, 0.6]}]
    assert seasons["2024"]["eliteserien"]["pre"] == [{"team_id": "1", "position_probabilities": [0.7, 0.3]}]
