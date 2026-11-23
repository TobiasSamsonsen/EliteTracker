"""The hourly Predict job, end to end against an in-memory store."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from elitetracker.normalize.matches import Match
from elitetracker.predict import boards, sync
from elitetracker.predict.ics import calendar
from elitetracker.predict.scoring import score_match
from elitetracker.sources.firestore import Write
from tests.predict_fakes import FakeStore

SEASON = 2027
T0 = datetime(2027, 4, 4, 12, 0, tzinfo=timezone.utc)        # round 1's first kick-off
KEY = f"{SEASON}_eliteserien_1"


def match(mid, home, away, kickoff, played=False, goals=None, rnd=1, slug_ids=("h", "a")):
    return Match(match_id=str(mid), date=kickoff.date().isoformat(), time="12:00", home=home, away=away,
                 home_goals=goals[0] if goals else None, away_goals=goals[1] if goals else None, played=played,
                 kickoff_utc=kickoff.isoformat().replace("+00:00", "Z"), round=rnd,
                 home_id=f"{home}-id", away_id=f"{away}-id")


def season(played=()):
    """Round 1 of both divisions: three matches in Eliteserien, one in OBOS."""
    goals = dict(played)
    es = [match(101, "A", "B", T0, 101 in goals, goals.get(101)),
          match(102, "C", "D", T0 + timedelta(hours=3), 102 in goals, goals.get(102)),
          match(103, "E", "F", T0 + timedelta(days=1), 103 in goals, goals.get(103))]
    obos = [match(201, "G", "H", T0 + timedelta(hours=1), 201 in goals, goals.get(201))]
    return {"eliteserien": es, "obosligaen": obos}


REPORT = {"eliteserien": {"model": {"version": "elo-v99.0"},
                          "fixtures": [{"match_id": "101", "home_win": 0.5, "draw": 0.25, "away_win": 0.25},
                                       {"match_id": "102", "home_win": 0.3, "draw": 0.3, "away_win": 0.4}]},
          "obosligaen": {"model": {"version": "elo-v99.0"}, "fixtures": []}}


def put_entry(store, uid, key, slots, when):
    store.docs[f"entries/{uid}/rounds/{key}"] = {
        "curve": 1, "r": key,
        "p": {s: {"g": g, "k": 10, "h": h, "d": d, "a": a, "t": when} for s, (g, h, d, a) in slots.items()}}


def go(store, now, matches, tmp_path, **kwargs):
    return sync.run(store, now=now, matches_by_slug=matches, season=SEASON, report=kwargs.pop("report", REPORT),
                    data_dir=tmp_path / "predict", ics_path=tmp_path / "rounds.ics", **kwargs)


def test_fixtures_get_stable_slots_and_a_seven_day_window(tmp_path):
    store = FakeStore()
    go(store, T0 - timedelta(days=10), season(), tmp_path)
    doc = store.docs[f"fixtures/{KEY}"]
    assert [doc["slots"][s]["id"] for s in ("s1", "s2", "s3")] == ["101", "102", "103"]
    assert doc["closes"] == T0 and doc["opens"] == T0 - timedelta(days=7)
    assert store.docs[f"fixtures/{SEASON}_obosligaen_1"]["slots"]["s1"]["id"] == "201"
    # a second run changes nothing in fixtures
    before = len(store.writes_to("fixtures/"))
    go(store, T0 - timedelta(days=9), season(), tmp_path)
    assert len(store.writes_to("fixtures/")) == before


def test_a_postponed_match_keeps_its_slot(tmp_path):
    store = FakeStore()
    go(store, T0 - timedelta(days=3), season(), tmp_path)
    later = season()
    later["eliteserien"][0] = match(101, "A", "B", T0 + timedelta(days=30))   # moved to the end of the month
    go(store, T0 - timedelta(days=2), later, tmp_path)
    doc = store.docs[f"fixtures/{KEY}"]
    assert doc["slots"]["s1"]["id"] == "101" and doc["slots"]["s1"]["kickoff"] == T0 + timedelta(days=30)
    assert doc["closes"] == T0 + timedelta(hours=3)


def test_the_model_odds_are_snapshotted_in_the_last_hours_before_kickoff(tmp_path):
    store = FakeStore()
    go(store, T0 - timedelta(hours=5), season(), tmp_path)
    assert not (tmp_path / "predict" / "locked_odds.json").read_text() or "101" not in json.loads(
        (tmp_path / "predict" / "locked_odds.json").read_text())
    summary = go(store, T0 - timedelta(hours=2), season(), tmp_path)
    snaps = json.loads((tmp_path / "predict" / "locked_odds.json").read_text())
    assert summary["snapshots"] == 1 and snaps["101"]["h"] == 0.5 and snaps["101"]["v"] == "elo-v99.0"
    assert "102" not in snaps            # kicks off in 5 h: outside the window
    # later published odds (a new run) do not overwrite once the match has started
    changed = {**REPORT, "eliteserien": {**REPORT["eliteserien"], "fixtures": [
        {"match_id": "101", "home_win": 0.9, "draw": 0.05, "away_win": 0.05}]}}
    go(store, T0 + timedelta(minutes=1), season(), tmp_path, report=changed)
    assert json.loads((tmp_path / "predict" / "locked_odds.json").read_text())["101"]["h"] == 0.5


def test_a_settled_round_is_scored_boards_are_built_and_a_rerun_is_idempotent(tmp_path):
    store = FakeStore()
    go(store, T0 - timedelta(hours=2), season(), tmp_path)          # opens the round, snapshots 101
    for i in range(6):                                              # six players tip match 101 (slot s1)
        put_entry(store, f"u{i}", KEY, {"s1": (0, 70 - i * 5, 20, 10 + i * 5)}, T0 - timedelta(days=2))
    for i in range(6):
        store.docs[f"users/u{i}"] = {"nick": f"Tipper_{i}", "hidden": i == 5, "created": T0 - timedelta(days=30)}
    summary = go(store, T0 + timedelta(hours=5), season(played={101: (2, 0)}), tmp_path)
    assert KEY in summary["rounds"] and summary["scored_players"] == 6   # (the other division's kicked-off match is aggregated too)
    # the crowd aggregate for the match that kicked off (six players: published)
    crowd = json.loads((tmp_path / "predict" / "crowd.json").read_text())
    assert crowd["101"]["n"] == 6 and crowd["101"]["h"] == pytest.approx(57.5)
    # a player's stats are the same numbers score_match gives for the match
    expected = score_match({f"u{i}": (70 - i * 5, 20, 10 + i * 5) for i in range(6)}, (0.5, 0.25, 0.25), "home_win")
    mine = store.docs["stats/u0"]["rounds"][KEY]
    assert mine["n"] == 1 and mine["m"] == 3
    assert mine["ab"] == pytest.approx(expected["players"]["u0"]["acc_brier"], abs=1e-5)
    # the board lists visible players, the model and the crowd; the hidden player is counted but not shown
    board = store.docs[f"boards/season_{SEASON}_eliteserien"]
    kinds = [r["kind"] for r in board["rows"]]
    assert kinds.count("player") == 5 and "model" in kinds and "crowd" in kinds
    assert board["players"] == 6 and len(board["pct"]) == 101
    assert board["rows"][0]["rank"] == 1 and all("uid" not in r for r in board["rows"])
    assert store.docs["meta/sync"]["scored"][KEY] == 1
    # the cheap documents the page reads: the round index and the reveal for the round
    index = store.docs["meta/rounds"]
    assert index["season"] == SEASON and {r["key"] for r in index["rounds"]} == {KEY, f"{SEASON}_obosligaen_1"}
    assert next(r for r in index["rounds"] if r["key"] == KEY)["last"] == T0 + timedelta(days=1)   # the page's "round is over"
    reveal = store.docs[f"reveal/{KEY}"]["matches"]
    assert set(reveal) == {"s1", "s2"}                               # the matches that have kicked off (s3 is tomorrow)
    assert reveal["s1"]["model"] == {"h": 0.5, "d": 0.25, "a": 0.25, "v": "elo-v99.0"}
    assert reveal["s1"]["crowd"]["n"] == 6 and reveal["s1"]["result"] == {"hg": 2, "ag": 0}
    assert json.loads((tmp_path / "predict" / "crowd.json").read_text())["101"]["med"]["b"] > 0   # the field's median, once settled
    # a second run with the same data does no scoring and rewrites no stats
    stats_writes = len(store.writes_to("stats/"))
    again = go(store, T0 + timedelta(hours=6), season(played={101: (2, 0)}), tmp_path)
    assert again["rounds"] == [] and len(store.writes_to("stats/")) == stats_writes


def test_a_match_with_fewer_than_five_players_publishes_no_aggregate(tmp_path):
    store = FakeStore()
    go(store, T0 - timedelta(hours=2), season(), tmp_path)
    for i in range(4):
        put_entry(store, f"u{i}", KEY, {"s1": (0, 40, 30, 30)}, T0 - timedelta(days=1))
    go(store, T0 + timedelta(minutes=30), season(), tmp_path)
    assert json.loads((tmp_path / "predict" / "crowd.json").read_text())["101"] == {"hidden": True}


def test_a_played_match_without_a_snapshot_is_reported_not_scored(tmp_path):
    store = FakeStore()
    put_entry(store, "u1", KEY, {"s1": (0, 40, 30, 30)}, T0 - timedelta(days=1))
    summary = go(store, T0 + timedelta(hours=5), season(played={101: (1, 1)}), tmp_path)   # no earlier run: no snapshot
    assert "101" in summary["unscorable"] and "stats/u1" not in store.docs


def test_a_deletion_request_erases_the_player_and_strips_the_boards(tmp_path):
    store = FakeStore()
    go(store, T0 - timedelta(hours=2), season(), tmp_path)
    for i in range(6):
        put_entry(store, f"u{i}", KEY, {"s1": (0, 50, 25, 25)}, T0 - timedelta(days=1))
        store.docs[f"users/u{i}"] = {"nick": f"Tipper_{i}", "hidden": False, "created": T0 - timedelta(days=30)}
        store.docs[f"nicknames/tipper_{i}"] = {"uid": f"u{i}"}
    go(store, T0 + timedelta(hours=5), season(played={101: (1, 0)}), tmp_path)
    mark = boards.uid_hash("u2")
    assert any(r["u"] == mark for r in store.docs[f"boards/season_{SEASON}_eliteserien"]["rows"])
    store.docs["deleteRequests/u2"] = {"at": T0}
    store.docs["tables/u2/picks/x"] = {"order": []}
    go(store, T0 + timedelta(hours=7), season(played={101: (1, 0)}), tmp_path)
    assert not [p for p in store.docs if "u2" in p.split("/") or p == "nicknames/tipper_2"]
    for board_doc in (d for p, d in store.docs.items() if p.startswith("boards/")):
        assert all(r["u"] != mark for r in board_doc["rows"])


def test_an_account_unused_for_24_months_goes_but_its_past_board_row_stays(tmp_path):
    store = FakeStore()
    old = T0 - timedelta(days=800)
    store.docs["users/old"] = {"nick": "Gamle_Ola", "hidden": False, "created": old}
    store.docs["nicknames/gamle_ola"] = {"uid": "old"}
    store.docs["stats/old"] = {"rounds": {"2025_eliteserien_1": {"n": 1}}, "last": old}
    store.docs["entries/old/rounds/2025_eliteserien_1"] = {"p": {}, "r": "2025_eliteserien_1"}
    store.docs["boards/season_2025_eliteserien"] = {"rows": [{"u": boards.uid_hash("old"), "nick": "Gamle_Ola", "rank": 1}]}
    store.docs["users/new"] = {"nick": "Ny_Pia", "hidden": False, "created": T0 - timedelta(days=5)}
    summary = go(store, T0 - timedelta(days=3), season(), tmp_path)
    assert summary["purged"] == ["old"]
    assert "users/old" not in store.docs and "stats/old" not in store.docs and "users/new" in store.docs
    assert "entries/old/rounds/2025_eliteserien_1" not in store.docs and "nicknames/gamle_ola" not in store.docs
    assert store.docs["boards/season_2025_eliteserien"]["rows"][0]["nick"] == "Gamle_Ola"
    # the sweep runs once a day
    store.docs["users/old2"] = {"nick": "Gamle_Per", "hidden": False, "created": old}
    assert go(store, T0 - timedelta(days=3, hours=-1), season(), tmp_path)["purged"] == []


def test_reported_or_blocked_names_are_hidden_from_the_boards(tmp_path):
    store = FakeStore()
    go(store, T0 - timedelta(hours=2), season(), tmp_path)
    names = {"u0": "Greit_Navn", "u1": "Rapportert", "u2": "Sh1t_Show"}
    for i, (uid, nick) in enumerate(names.items()):
        put_entry(store, uid, KEY, {"s1": (0, 50, 25, 25)}, T0 - timedelta(days=1))
        store.docs[f"users/{uid}"] = {"nick": nick, "hidden": False, "created": T0 - timedelta(days=9)}
    for who in ("a", "b", "c"):
        store.docs[f"reports/{who}"] = {"nickLower": "rapportert", "by": who}
    go(store, T0 + timedelta(hours=5), season(played={101: (1, 0)}), tmp_path)
    shown = [r["nick"] for r in store.docs[f"boards/season_{SEASON}_eliteserien"]["rows"] if r["kind"] == "player"]
    assert shown == ["Greit_Navn"]


def test_mini_league_boards_cover_only_their_members(tmp_path):
    store = FakeStore()
    go(store, T0 - timedelta(hours=2), season(), tmp_path)
    for uid in ("u0", "u1", "u2"):
        put_entry(store, uid, KEY, {"s1": (0, 50, 25, 25)}, T0 - timedelta(days=1))
        store.docs[f"users/{uid}"] = {"nick": f"Navn_{uid}", "hidden": False, "created": T0 - timedelta(days=9)}
    store.docs["leagues/ABCD2345"] = {"name": "Kontoret", "owner": "u0", "created": T0}
    store.docs["leagues/ABCD2345/members/u0"] = {"joined": T0}
    store.docs["leagues/ABCD2345/members/u1"] = {"joined": T0}
    go(store, T0 + timedelta(hours=5), season(played={101: (1, 0)}), tmp_path)
    board = store.docs["boards/league_ABCD2345"]
    assert board["name"] == "Kontoret" and sorted(r["nick"] for r in board["rows"]) == ["Navn_u0", "Navn_u1"]


def test_the_table_game_opens_with_the_fixtures_and_closes_at_the_first_kickoff(tmp_path):
    store = FakeStore()
    go(store, T0 - timedelta(days=20), season(), tmp_path)
    doc = store.docs[f"tablegames/{SEASON}_eliteserien"]
    assert doc["closes"] == T0 and doc["opens"] == T0 - timedelta(days=20)
    assert doc["clubs"] == sorted(["A-id", "B-id", "C-id", "D-id", "E-id", "F-id"]) and doc["names"]["A-id"] == "A"
    go(store, T0 - timedelta(days=5), season(), tmp_path)
    assert store.docs[f"tablegames/{SEASON}_eliteserien"]["opens"] == T0 - timedelta(days=20)   # the opening day is kept
    go(store, T0 + timedelta(hours=1), season(), tmp_path)    # a ball has been kicked: no new table game doc


def test_the_calendar_feed_lists_coming_rounds_only():
    docs = [{"season": 2027, "league": "eliteserien", "round": 1, "closes": T0},
            {"season": 2027, "league": "obosligaen", "round": 1, "closes": T0 - timedelta(days=1)}]
    text = calendar(docs, T0 - timedelta(hours=1))
    assert text.count("BEGIN:VEVENT") == 1 and "DTSTART:20270404T120000Z" in text and "TRIGGER:-PT1H" in text
    assert text.startswith("BEGIN:VCALENDAR\r\n") and text.endswith("END:VCALENDAR\r\n")
    assert all(len(line.encode()) <= 75 for line in text.split("\r\n"))


def test_dry_run_commits_and_writes_nothing(tmp_path):
    store = FakeStore()
    summary = go(store, T0 - timedelta(hours=2), season(), tmp_path, dry_run=True)
    assert summary["writes"] > 0 and store.docs == {} and not (tmp_path / "predict").exists()


def test_the_table_game_is_scored_when_the_season_is_complete(tmp_path):
    # a four-club division: A wins everything, then B, C, D by results
    def game(mid, home, away, hg, ag, day):
        return match(mid, home, away, T0 + timedelta(days=day), True, (hg, ag), rnd=day + 1)
    played = [game(1, "A", "B", 1, 0, 0), game(2, "C", "D", 1, 0, 1), game(3, "A", "C", 1, 0, 2),
              game(4, "B", "D", 1, 0, 3), game(5, "A", "D", 1, 0, 4), game(6, "B", "C", 1, 0, 5)]
    store = FakeStore()
    data = tmp_path / "predict"
    data.mkdir()
    key = f"{SEASON}_eliteserien"
    (data / "locked_tables.json").write_text(json.dumps({key: ["A-id", "C-id", "B-id", "D-id"]}))
    ids = lambda order: [f"{c}-id" for c in order]
    store.docs[f"tables/u1/picks/{key}"] = {"r": key, "order": ids("ABCD")}   # exactly right
    store.docs[f"tables/u2/picks/{key}"] = {"r": key, "order": ids("DCBA")}   # reversed
    store.docs["users/u1"] = {"nick": "Spot_On", "hidden": False, "created": T0}
    store.docs["users/u2"] = {"nick": "Upside_Down", "hidden": False, "created": T0}
    report = {"eliteserien": {"league": {"bands": [{"first": 1, "last": 1, "tone": "champion"}]}}}
    go_end = lambda days: sync.run(store, now=T0 + timedelta(days=days), matches_by_slug={"eliteserien": played, "obosligaen": []},
                                   season=SEASON, report=report, data_dir=data, purge=False)
    summary = go_end(30)
    assert summary["tables"] == [key]
    assert store.docs["stats/u1"]["tables"][key]["error"] == -6            # footrule 0, champion bonus 6
    board = store.docs[f"boards/tables_{key}"]
    assert board["rows"][0]["nick"] == "Spot_On" and [r["kind"] for r in board["rows"]].count("model") == 1
    assert "tables" not in go_end(31)                                      # scored once only
