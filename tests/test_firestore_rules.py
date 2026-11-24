"""The Firestore security rules (firestore.rules), run in the Firestore emulator.

Skipped unless the emulator is up. Run them with

    firebase emulators:exec --only firestore --project demo-elitetracker \
        ".venv/Scripts/python -m pytest tests/test_firestore_rules.py -q"

No Firebase SDK: the emulator takes a REST commit with ``Bearer owner`` (an
admin, rules bypassed) and unsigned JWTs for a signed-in player, so the tests
use the same ``sources/firestore.py`` client as the job.
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import pytest

from elitetracker.sources.firestore import SERVER_TIME, Firestore, FirestoreError, Write

pytestmark = pytest.mark.skipif(not os.environ.get("FIRESTORE_EMULATOR_HOST"),
                                reason="needs the Firestore emulator (see the module docstring)")

PROJECT = "demo-elitetracker"
ROUND = "2027_eliteserien_5"
NOW = datetime.now(timezone.utc)


def _b64(obj) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


def token(uid: str) -> str:
    """An unsigned ID token, which the emulator accepts as that player."""
    claims = {"user_id": uid, "sub": uid, "iat": int(time.time()), "exp": int(time.time()) + 3600,
              "firebase": {"sign_in_provider": "anonymous", "identities": {}}}
    return f"{_b64({'alg': 'none', 'typ': 'JWT'})}.{_b64(claims)}."


def player(uid: str) -> Firestore:
    return Firestore(PROJECT, token=token(uid))


@pytest.fixture()
def admin() -> Firestore:
    store = Firestore(PROJECT)  # the emulator host makes this the owner
    clear = urllib.request.Request(  # the emulator's own endpoint: wipe every document
        f"http://{os.environ['FIRESTORE_EMULATOR_HOST']}/emulator/v1/projects/{PROJECT}/databases/(default)/documents",
        method="DELETE")
    urllib.request.urlopen(clear).read()
    return store


def fixture_doc(opens=-7 * 24, kickoffs=(3, 5, 48)):
    """A round whose slots kick off ``kickoffs`` hours from now; it opened ``-opens`` hours ago."""
    return {"season": 2027, "league": "eliteserien", "round": 5,
            "opens": NOW + timedelta(hours=opens),
            "slots": {f"s{i + 1}": {"id": str(100 + i), "home": "A", "away": "B",
                                    "kickoff": NOW + timedelta(hours=h)} for i, h in enumerate(kickoffs)}}


def pick(g=20, k=10, h=45, d=27, a=28):
    return {"g": g, "k": k, "h": h, "d": d, "a": a, "t": SERVER_TIME}


def save(store: Firestore, uid: str, slots: dict, round_key: str = ROUND, extra: dict | None = None):
    """What the browser does: write only the changed slots, with a server time each."""
    data = {"curve": 1, "r": round_key, "p": slots}
    data.update(extra or {})
    store.commit([Write.merge(f"entries/{uid}/rounds/{round_key}", data)])


def denied(call) -> bool:
    try:
        call()
    except FirestoreError as error:
        return error.status == 403
    return False


def test_an_open_slot_can_be_picked_and_the_server_stamps_it(admin):
    admin.set(f"fixtures/{ROUND}", fixture_doc())
    me = player("u1")
    save(me, "u1", {"s1": pick(), "s2": pick(g=-100, h=14, d=21, a=65)})
    got = me.get(f"entries/u1/rounds/{ROUND}")
    assert got["p"]["s1"]["h"] == 45 and got["p"]["s2"]["a"] == 65
    assert isinstance(got["p"]["s1"]["t"], datetime) and abs((got["p"]["s1"]["t"] - NOW).total_seconds()) < 120
    assert got["r"] == ROUND and got["curve"] == 1


def test_a_pick_can_be_changed_while_open_and_other_slots_stay(admin):
    admin.set(f"fixtures/{ROUND}", fixture_doc())
    me = player("u1")
    save(me, "u1", {"s1": pick(), "s2": pick(g=5, h=34, d=29, a=37)})
    save(me, "u1", {"s1": pick(g=100, h=62, d=24, a=14)})
    got = me.get(f"entries/u1/rounds/{ROUND}")
    assert got["p"]["s1"]["g"] == 100 and got["p"]["s2"]["g"] == 5


def test_a_slot_whose_match_has_started_is_locked(admin):
    doc = fixture_doc(kickoffs=(-1, 5))
    admin.set(f"fixtures/{ROUND}", doc)
    me = player("u1")
    assert denied(lambda: save(me, "u1", {"s1": pick()}))
    save(me, "u1", {"s2": pick()})  # the open slot is fine


def test_a_locked_pick_cannot_be_changed_or_withdrawn_after_kickoff(admin):
    admin.set(f"fixtures/{ROUND}", fixture_doc(kickoffs=(3, 5)))
    me = player("u1")
    save(me, "u1", {"s1": pick()})
    # kick-off passes: the job (or time) moves the fixture into the past
    admin.set(f"fixtures/{ROUND}", fixture_doc(kickoffs=(-1, 5)))
    assert denied(lambda: save(me, "u1", {"s1": pick(g=300, h=80, d=12, a=8)}))
    assert denied(lambda: me.commit([Write.merge(f"entries/u1/rounds/{ROUND}", {"p": {"s1": None}})]))
    save(me, "u1", {"s2": pick()})  # the other slot is still open
    assert me.get(f"entries/u1/rounds/{ROUND}")["p"]["s1"]["g"] == 20


def test_a_round_that_has_not_opened_takes_no_picks(admin):
    admin.set(f"fixtures/{ROUND}", fixture_doc(opens=+24))
    assert denied(lambda: save(player("u1"), "u1", {"s1": pick()}))


def test_values_are_checked(admin):
    admin.set(f"fixtures/{ROUND}", fixture_doc())
    me = player("u1")
    for bad in (pick(h=50, d=30, a=30),            # sums to 110
                pick(g=701),                        # gap out of range
                pick(h=0, d=50, a=50),              # below the floor (1 %)
                pick(h=99, d=1, a=0),               # above the ceiling (98 %)
                pick(k=19), pick(k=4),              # draw tendency out of range
                {**pick(), "extra": 1},             # unknown field
                {**pick(), "t": NOW}):              # a client-chosen time
        assert denied(lambda b=bad: save(me, "u1", {"s1": b})), bad
    save(me, "u1", {"s1": pick(h=98, d=1, a=1)})                                # a fine-tuned pick may go down to 1 %
    assert denied(lambda: save(me, "u1", {"s9": pick()}))                      # no such slot
    assert denied(lambda: save(me, "u1", {"s1": pick()}, extra={"curve": 2}))  # unknown curve
    assert denied(lambda: save(me, "u1", {"s1": pick()}, round_key="2027_eliteserien_6"))  # r must match the path


def test_nobody_reads_or_writes_another_players_entry(admin):
    admin.set(f"fixtures/{ROUND}", fixture_doc())
    save(player("u1"), "u1", {"s1": pick()})
    assert denied(lambda: player("u2").get(f"entries/u1/rounds/{ROUND}"))
    assert denied(lambda: save(player("u2"), "u1", {"s1": pick()}))
    anonymous = urllib.request.Request(  # no Authorization header at all
        f"http://{os.environ['FIRESTORE_EMULATOR_HOST']}/v1/projects/{PROJECT}/databases/(default)/documents/entries/u1/rounds/{ROUND}")
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(anonymous)
    assert error.value.code == 403


def test_entries_cannot_be_deleted_from_the_browser(admin):
    admin.set(f"fixtures/{ROUND}", fixture_doc())
    me = player("u1")
    save(me, "u1", {"s1": pick()})
    assert denied(lambda: me.delete(f"entries/u1/rounds/{ROUND}"))


def test_fixtures_are_readable_by_anyone_but_writable_by_nobody(admin):
    admin.set(f"fixtures/{ROUND}", fixture_doc())
    assert Firestore(PROJECT, token=token("u1")).get(f"fixtures/{ROUND}")["round"] == 5
    assert denied(lambda: player("u1").set(f"fixtures/{ROUND}", fixture_doc()))
    assert denied(lambda: player("u1").set("boards/season_2027_eliteserien", {"rows": []}))


def test_the_browsers_cheap_documents_are_public_but_not_listable(admin):
    for path in ("meta/rounds", f"reveal/{ROUND}", f"fixtures/{ROUND}", "tablegames/2027_eliteserien"):
        admin.set(path, {"x": 1})
        assert player("u1").get(path) == {"x": 1}
        assert denied(lambda p=path: player("u1").set(p, {"x": 2}))
    admin.set("meta/sync", {"secret": 1})
    assert denied(lambda: player("u1").get("meta/sync"))
    for collection in ("fixtures", "reveal", "tablegames"):
        assert denied(lambda c=collection: list(player("u1").list(c)))


def test_the_standings_document_is_public_like_the_round_index(admin):
    admin.set("meta/standings", {"season": 2027, "leagues": {}})
    assert player("u1").get("meta/standings")["season"] == 2027
    assert denied(lambda: player("u1").set("meta/standings", {"season": 1}))


def test_a_pick_can_be_withdrawn_before_kickoff_with_an_update_mask(admin):
    admin.set(f"fixtures/{ROUND}", fixture_doc())
    me = player("u1")
    save(me, "u1", {"s1": pick(), "s2": pick()})
    # what the page sends to clear s1: the mask names the slot, the document leaves it out
    name = "entries/u1/rounds/" + ROUND
    withdraw = Write(name, {"update": {"name": name, "fields": {"r": {"stringValue": ROUND}, "curve": {"integerValue": "1"}}},
                            "updateMask": {"fieldPaths": ["curve", "r", "p.s1"]}})
    me.commit([withdraw])
    assert list(me.get(name)["p"]) == ["s2"]


def test_boards_can_be_read_one_by_one_but_not_listed(admin):
    admin.set("boards/league_ABCD2345", {"rows": []})
    me = player("u1")
    assert me.get("boards/league_ABCD2345") == {"rows": []}
    assert denied(lambda: list(me.list("boards")))


def test_the_table_game_takes_a_permutation_before_it_closes(admin):
    admin.set("tablegames/2027_eliteserien", {"opens": NOW - timedelta(days=1), "closes": NOW + timedelta(days=30),
                                              "clubs": ["1", "2", "3", "4"]})
    me = player("u1")
    me.commit([Write.merge("tables/u1/picks/2027_eliteserien",
                           {"order": ["3", "1", "4", "2"], "r": "2027_eliteserien", "t": SERVER_TIME})])
    assert me.get("tables/u1/picks/2027_eliteserien")["order"] == ["3", "1", "4", "2"]
    for order in (["3", "1", "4"], ["3", "1", "4", "4"], ["3", "1", "4", "9"]):
        assert denied(lambda o=order: me.commit([Write.merge("tables/u1/picks/2027_eliteserien",
                                                             {"order": o, "r": "2027_eliteserien", "t": SERVER_TIME})]))


def test_the_table_game_locks_at_the_first_kickoff(admin):
    admin.set("tablegames/2027_eliteserien", {"opens": NOW - timedelta(days=9), "closes": NOW - timedelta(hours=1),
                                              "clubs": ["1", "2"]})
    assert denied(lambda: player("u1").commit([Write.merge("tables/u1/picks/2027_eliteserien",
                                                           {"order": ["1", "2"], "r": "2027_eliteserien", "t": SERVER_TIME})]))


# ---- profile and nickname ---------------------------------------------------

def key(nick: str) -> str:
    """The ASCII key of a nickname claim (the same encoding as the rules and the page)."""
    return nick.lower().replace("æ", "~e").replace("ø", "~o").replace("å", "~a")


def profile(nick="Tipper_1", custom=False, **extra):
    base = {"nick": nick, "nickLower": nick.lower(), "nickCustom": custom, "nickAt": SERVER_TIME,
            "locale": "nb", "hidden": False, "created": SERVER_TIME}
    base.update(extra)
    return base


def create_profile(store, uid, nick="Tipper_1", custom=False, **extra):
    store.commit([Write.set(f"nicknames/{key(nick)}", {"uid": uid}),
                  Write.set(f"users/{uid}", profile(nick, custom, **extra))])


def test_a_player_creates_a_profile_with_a_claimed_nickname(admin):
    me = player("u1")
    create_profile(me, "u1", "Øyvind_9")
    assert me.get("users/u1")["nick"] == "Øyvind_9"
    assert me.get("nicknames/~oyvind_9")["uid"] == "u1"


@pytest.mark.parametrize("nick", ["ab", "x" * 21, "bad!name", " lead", "Modellen", "FOLKET", "tab\tname"])
def test_bad_or_reserved_nicknames_are_refused(admin, nick):
    assert denied(lambda: create_profile(player("u1"), "u1", nick))


def test_a_nickname_is_unique_ignoring_case(admin):
    create_profile(player("u1"), "u1", "Tipper_1")
    assert denied(lambda: create_profile(player("u2"), "u2", "TIPPER_1"))


def test_a_profile_cannot_claim_a_name_held_by_another_player(admin):
    admin.set("nicknames/stolen", {"uid": "u9"})
    assert denied(lambda: player("u1").commit([Write.set("users/u1", profile("Stolen"))]))


def test_nickname_changes_wait_30_days_once_a_chosen_name_is_held(admin):
    me = player("u1")
    create_profile(me, "u1", "Generated_1")           # a generated name: free to change
    me.commit([Write.set("nicknames/chosen_2", {"uid": "u1"}),
               Write.merge("users/u1", {"nick": "Chosen_2", "nickLower": "chosen_2", "nickCustom": True,
                                        "nickAt": SERVER_TIME, "locale": "nb", "hidden": False})])
    assert me.get("users/u1")["nick"] == "Chosen_2"
    assert denied(lambda: me.commit([Write.set("nicknames/third_3", {"uid": "u1"}),
                                     Write.merge("users/u1", {"nick": "Third_3", "nickLower": "third_3",
                                                              "nickCustom": True, "nickAt": SERVER_TIME,
                                                              "locale": "nb", "hidden": False})]))
    # 31 days later (the admin backdates the record)
    admin.merge("users/u1", {"nickAt": NOW - timedelta(days=31)})
    me.commit([Write.set("nicknames/third_3", {"uid": "u1"}),
               Write.merge("users/u1", {"nick": "Third_3", "nickLower": "third_3", "nickCustom": True,
                                        "nickAt": SERVER_TIME, "locale": "nb", "hidden": False})])
    assert me.get("users/u1")["nick"] == "Third_3"


def test_other_profile_fields_change_freely(admin):
    me = player("u1")
    create_profile(me, "u1", "Chosen_2", custom=True)
    me.commit([Write.merge("users/u1", {"hidden": True, "club": "Brann", "notify": True})])
    assert me.get("users/u1")["hidden"] is True


def test_a_case_only_nickname_change_keeps_the_claim_and_the_clock(admin):
    me = player("u1")
    create_profile(me, "u1", "Chosen_2", custom=True)
    me.commit([Write.merge("users/u1", {"nick": "CHOSEN_2"})])                 # just the spelling: no new claim, no new nickAt
    assert me.get("users/u1")["nick"] == "CHOSEN_2"
    assert denied(lambda: me.commit([Write.merge("users/u1", {"nick": "Other_9"})]))     # a different name needs a claim


def test_a_profile_may_list_its_mini_leagues(admin):
    me = player("u1")
    create_profile(me, "u1", "Chosen_2", custom=True)
    me.commit([Write.merge("users/u1", {"leagues": ["ABCD2345", "EFGH6789"]})])
    assert me.get("users/u1")["leagues"] == ["ABCD2345", "EFGH6789"]
    assert denied(lambda: me.commit([Write.merge("users/u1", {"leagues": ["ABCD2345"] * 21})]))
    assert denied(lambda: me.commit([Write.merge("users/u1", {"leagues": "ABCD2345"})]))


def test_profiles_are_private(admin):
    create_profile(player("u1"), "u1")
    assert denied(lambda: player("u2").get("users/u1"))


def test_the_server_only_collections_are_closed_to_players(admin):
    admin.set("stats/u1", {"x": 1})
    assert player("u1").get("stats/u1") == {"x": 1}          # the owner may read own stats
    assert denied(lambda: player("u2").get("stats/u1"))
    assert denied(lambda: player("u1").set("stats/u1", {"x": 2}))
    assert denied(lambda: player("u1").get("anything/else"))


def test_reports_leagues_and_deletion_requests(admin):
    me = player("u1")
    me.commit([Write.set("reports/badname_u1", {"nickLower": "badname", "by": "u1", "at": SERVER_TIME})])
    assert denied(lambda: me.commit([Write.set("reports/badname_u1", {"nickLower": "badname", "by": "u1", "at": SERVER_TIME})]))   # twice
    assert denied(lambda: me.commit([Write.set("reports/r1", {"nickLower": "badname", "by": "u1", "at": SERVER_TIME})]))           # not that id
    assert denied(lambda: me.commit([Write.set("reports/x_u2", {"nickLower": "x", "by": "u2", "at": SERVER_TIME})]))               # not as u2
    me.commit([Write.set("reports/~oyvind_u1", {"nickLower": "øyvind", "by": "u1", "at": SERVER_TIME})])                           # the ASCII claim key
    me.commit([Write.set("leagues/ABCD2345", {"name": "Kontoret", "owner": "u1", "created": SERVER_TIME})])
    assert denied(lambda: me.commit([Write.set("leagues/abcd2345", {"name": "Kontoret", "owner": "u1", "created": SERVER_TIME})]))
    other = player("u2")
    assert other.get("leagues/ABCD2345")["name"] == "Kontoret"
    assert denied(lambda: list(other.list("leagues")))
    other.commit([Write.set("leagues/ABCD2345/members/u2", {"joined": SERVER_TIME})])
    assert denied(lambda: me.commit([Write.set("leagues/ABCD2345/members/u3", {"joined": SERVER_TIME})]))
    me.commit([Write.set("deleteRequests/u1", {"at": SERVER_TIME})])
    assert denied(lambda: me.commit([Write.set("deleteRequests/u2", {"at": SERVER_TIME})]))


def test_a_nickname_cannot_be_claimed_without_using_it(admin):
    me = player("u1")
    assert denied(lambda: me.set("nicknames/squatted", {"uid": "u1"}))            # no profile at all
    assert denied(lambda: me.commit([Write.set("nicknames/squatted", {"uid": "u1"}),
                                     Write.set("users/u1", profile("Other_1"))]))  # profile uses another name
    create_profile(me, "u1", "Mine_1")
    assert denied(lambda: player("u2").delete("nicknames/mine_1"))                # only the holder releases it
    me.delete("nicknames/mine_1")
