"""The whole loop against the Firestore emulator: players write picks through the
security rules, the job (sources/firestore.py + predict/sync.py) reads them back with a
collection-group query, scores them and publishes boards. Skipped without the emulator
(see tests/test_firestore_rules.py for how to run it)."""

from __future__ import annotations

import json
import os
import urllib.request
from datetime import datetime, timedelta, timezone

import pytest

from elitetracker.normalize.matches import Match
from elitetracker.predict import boards, sync
from elitetracker.sources.firestore import SERVER_TIME, Firestore, Write
from tests.test_firestore_rules import PROJECT, denied, player, token

pytestmark = pytest.mark.skipif(not os.environ.get("FIRESTORE_EMULATOR_HOST"),
                                reason="needs the Firestore emulator (see tests/test_firestore_rules.py)")

SEASON = 2027
KEY = f"{SEASON}_eliteserien_1"


@pytest.fixture()
def store() -> Firestore:
    request = urllib.request.Request(
        f"http://{os.environ['FIRESTORE_EMULATOR_HOST']}/emulator/v1/projects/{PROJECT}/databases/(default)/documents",
        method="DELETE")
    urllib.request.urlopen(request).read()
    return Firestore(PROJECT)


def matches(first_kickoff: datetime, played: bool):
    def one(mid, home, away, kick, goals=None):
        return Match(match_id=str(mid), date=kick.date().isoformat(), time="12:00", home=home, away=away,
                     home_goals=goals[0] if played and goals else None, away_goals=goals[1] if played and goals else None,
                     played=played and goals is not None, kickoff_utc=kick.isoformat().replace("+00:00", "Z"), round=1,
                     home_id=f"{home}-id", away_id=f"{away}-id")
    return {"eliteserien": [one(101, "A", "B", first_kickoff, (2, 0)), one(102, "C", "D", first_kickoff + timedelta(hours=3))],
            "obosligaen": [one(201, "G", "H", first_kickoff + timedelta(hours=1))]}


def run(store, now, first_kickoff, played, tmp_path, report):
    return sync.run(store, now=now, matches_by_slug=matches(first_kickoff, played), season=SEASON, report=report,
                    data_dir=tmp_path / "predict")


def save_pick(who: Firestore, uid: str, h: int, d: int, a: int):
    who.commit([Write.merge(f"entries/{uid}/rounds/{KEY}",
                            {"curve": 1, "r": KEY, "p": {"s1": {"g": 20, "k": 10, "h": h, "d": d, "a": a, "t": SERVER_TIME}}})])


def test_picks_written_through_the_rules_are_scored_and_published_and_a_deletion_request_erases_them(store, tmp_path):
    real_now = datetime.now(timezone.utc)
    kickoff = real_now + timedelta(days=2)
    report = {"eliteserien": {"model": {"version": "elo-v99.0"},
                              "fixtures": [{"match_id": "101", "home_win": 0.5, "draw": 0.25, "away_win": 0.25}]},
              "obosligaen": {"model": {"version": "elo-v99.0"}, "fixtures": []}}

    # the job opens the round (fixtures, index, table game), nothing more
    first = run(store, real_now, kickoff, False, tmp_path, report)
    assert first["fixtures"] == 2 and store.get("meta/rounds")["season"] == SEASON
    assert store.get(f"fixtures/{KEY}")["slots"]["s1"]["id"] == "101"

    # six players pick match 101 under the rules; the server stamps each pick
    for i in range(6):
        uid = f"u{i}"
        who = player(uid)
        save_pick(who, uid, 70 - 5 * i, 20, 10 + 5 * i)
        who.commit([Write.set(f"nicknames/tipper_{i}", {"uid": uid}),
                    Write.set(f"users/{uid}", {"nick": f"Tipper_{i}", "nickLower": f"tipper_{i}", "nickCustom": False,
                                               "nickAt": SERVER_TIME, "locale": "nb", "hidden": False, "created": SERVER_TIME})])

    # the model's odds are kept from 48 hours out, and the crowd of the last run before kick-off is the shadow's
    assert first["snapshots"] == 1
    snap = run(store, kickoff - timedelta(hours=2), kickoff, False, tmp_path, report)
    assert snap["snapshots"] == 0 and snap["rounds"] == []                       # the odds have not changed
    last = run(store, kickoff - timedelta(minutes=30), kickoff, False, tmp_path, report)
    assert last["shadow"] == 1 and json.loads((tmp_path / "predict" / "shadow.json").read_text())["101"]["n"] == 6

    # after full time: the round is read with a collection-group query, scored and ranked
    done = run(store, kickoff + timedelta(hours=5), kickoff, True, tmp_path, report)
    assert KEY in done["rounds"] and done["scored_players"] == 6
    stats = store.get("stats/u0")
    assert stats["rounds"][KEY]["n"] == 1 and stats["rounds"][KEY]["m"] == 2
    board = store.get(f"boards/season_{SEASON}_eliteserien")
    assert board["players"] == 6 and [r["kind"] for r in board["rows"]].count("player") == 6
    assert store.get(f"reveal/{KEY}")["matches"]["s1"]["result"] == {"hg": 2, "ag": 0}
    # the owner reads own stats, a stranger cannot
    assert player("u0").get("stats/u0")["rounds"][KEY]["n"] == 1 and denied(lambda: player("u1").get("stats/u0"))
    # nothing new: a rerun does no scoring
    assert run(store, kickoff + timedelta(hours=6), kickoff, True, tmp_path, report)["rounds"] == []

    # a deletion request: the player's documents and board rows go on the next run
    player("u3").commit([Write.set("deleteRequests/u3", {"at": SERVER_TIME})])
    gone = run(store, kickoff + timedelta(hours=7), kickoff, True, tmp_path, report)
    assert gone["purged"] == ["u3"]
    assert store.get("users/u3") is None and store.get("stats/u3") is None and store.get("nicknames/tipper_3") is None
    assert not list(store.query_group("rounds", "r", KEY)) or all("u3" not in path for path, _ in store.query_group("rounds", "r", KEY))
    board = store.get(f"boards/season_{SEASON}_eliteserien")
    assert all(r["u"] != boards.uid_hash("u3") for r in board["rows"])


def test_new_league_members_are_found_with_a_group_query_on_joined(store, tmp_path):
    me, other = player("u1"), player("u2")
    me.commit([Write.set("leagues/ABCD2345", {"name": "Kontoret", "owner": "u1", "created": SERVER_TIME})])
    me.commit([Write.set("leagues/ABCD2345/members/u1", {"joined": SERVER_TIME})])
    found = list(store.query_group_after("members", "joined"))
    assert [path for path, _ in found] == ["leagues/ABCD2345/members/u1"]
    newest = found[0][1]["joined"]
    other.commit([Write.set("leagues/ABCD2345/members/u2", {"joined": SERVER_TIME})])
    assert [path for path, _ in store.query_group_after("members", "joined", newest)] == ["leagues/ABCD2345/members/u2"]
    assert list(store.query_group_after("members", "joined", datetime.now(timezone.utc) + timedelta(days=1))) == []
    # and the job's own helper: only the league that gained a member, and the newest join
    summary: dict = {"warnings": []}
    codes, seen = sync._new_league_members(store, newest, summary)
    assert codes == {"ABCD2345"} and seen > newest and not summary["warnings"]
