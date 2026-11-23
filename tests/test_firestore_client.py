"""sources/firestore.py: value encoding, write bodies, paging and errors, with an injected transport."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from elitetracker.sources.firestore import (
    SERVER_TIME, Firestore, FirestoreError, Write, decode, decode_document, encode, field_path, parse_time,
)


def test_values_round_trip():
    stamp = datetime(2027, 4, 4, 12, 30, 15, tzinfo=timezone.utc)
    value = {"n": 3, "x": 1.5, "s": "øl", "b": True, "none": None, "t": stamp, "list": [1, "a", [2]],
             "map": {"deep": {"k": 7}}, "neg": -400}
    assert decode(encode(value)) == value


def test_integers_are_not_floats_and_bools_are_not_integers():
    assert encode(5) == {"integerValue": "5"} and encode(True) == {"booleanValue": True}
    assert encode(0.5) == {"doubleValue": 0.5}


def test_a_naive_datetime_is_taken_as_utc_and_a_zoned_one_is_converted():
    assert encode(datetime(2027, 1, 1, 0, 0)) == {"timestampValue": "2027-01-01T00:00:00Z"}
    oslo = datetime.fromisoformat("2027-04-04T14:00:00+02:00")
    assert encode(oslo) == {"timestampValue": "2027-04-04T12:00:00Z"}


def test_timestamps_with_nanosecond_fractions_parse():
    assert parse_time("2027-04-04T12:00:00.123456789Z") == datetime(2027, 4, 4, 12, 0, 0, 123456, tzinfo=timezone.utc)
    assert parse_time("2027-04-04T12:00:00Z") == datetime(2027, 4, 4, 12, 0, tzinfo=timezone.utc)


def test_field_paths_quote_parts_that_are_not_identifiers():
    assert field_path("p", "s1", "g") == "p.s1.g"
    assert field_path("rounds", "2027_eliteserien_1", "n") == "rounds.`2027_eliteserien_1`.n"


def test_a_merge_masks_only_the_leaf_fields_and_turns_server_time_into_a_transform():
    write = Write.merge("entries/u1/rounds/k", {"r": "k", "p": {"s1": {"g": 20, "t": SERVER_TIME}}})
    body = write.body
    assert sorted(body["updateMask"]["fieldPaths"]) == ["p.s1.g", "r"]
    assert body["updateTransforms"] == [{"fieldPath": "p.s1.t", "setToServerValue": "REQUEST_TIME"}]
    assert body["update"]["fields"]["p"]["mapValue"]["fields"]["s1"]["mapValue"]["fields"]["g"] == {"integerValue": "20"}


def test_a_set_replaces_and_a_delete_names_the_document():
    assert Write.set("a/b", {"x": 1}).body["update"]["fields"] == {"x": {"integerValue": "1"}}
    assert Write.delete("a/b").body == {"delete": "a/b"}


class Recorder:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def __call__(self, method, url, body, headers):
        self.calls.append((method, url, body, headers))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply


def client(replies, **kwargs):
    transport = Recorder(replies)
    return Firestore("proj", token="tok", base="https://fs.test/v1", transport=transport, **kwargs), transport


def test_get_decodes_a_document_and_returns_none_for_a_missing_one():
    store, transport = client([{"fields": {"a": {"integerValue": "4"}}}, FirestoreError("nope", 404)])
    assert store.get("things/one") == {"a": 4}
    assert store.get("things/two") is None
    method, url, _, headers = transport.calls[0]
    assert (method, url) == ("GET", "https://fs.test/v1/projects/proj/databases/(default)/documents/things/one")
    assert headers["Authorization"] == "Bearer tok" and "X-Goog-User-Project" not in headers


def test_other_errors_are_raised():
    store, _ = client([FirestoreError("denied", 403)])
    with pytest.raises(FirestoreError):
        store.get("things/one")


def test_list_follows_page_tokens():
    page = lambda ids, token="": {"documents": [{"name": f"projects/proj/databases/(default)/documents/c/{i}",
                                                  "fields": {"v": {"integerValue": i}}} for i in ids],
                                  **({"nextPageToken": token} if token else {})}
    store, transport = client([page(["1", "2"], "next"), page(["3"])])
    assert list(store.list("c")) == [("1", {"v": 1}), ("2", {"v": 2}), ("3", {"v": 3})]
    assert "pageToken=next" in transport.calls[1][1]


def test_a_collection_group_query_filters_on_a_field_and_returns_full_paths():
    doc = {"name": "projects/proj/databases/(default)/documents/entries/u1/rounds/k", "fields": {"r": {"stringValue": "k"}}}
    store, transport = client([[{"readTime": "x"}, {"document": doc}]])
    assert list(store.query_group("rounds", "r", "k")) == [("entries/u1/rounds/k", {"r": "k"})]
    query = transport.calls[0][2]["structuredQuery"]
    assert query["from"] == [{"collectionId": "rounds", "allDescendants": True}]
    assert query["where"]["fieldFilter"]["value"] == {"stringValue": "k"}


def test_commit_batches_writes_and_rewrites_names_to_full_paths():
    store, transport = client([{}, {}, {}])
    count = store.commit([Write.set(f"c/{i}", {"x": i}) for i in range(5)] + [Write.delete("c/gone")], batch=4)
    assert count == 6 and len(transport.calls) == 2
    first = transport.calls[0][2]["writes"]
    assert len(first) == 4 and first[0]["update"]["name"] == "projects/proj/databases/(default)/documents/c/0"
    assert transport.calls[1][2]["writes"][-1] == {"delete": "projects/proj/databases/(default)/documents/c/gone"}


def test_a_user_token_bills_the_call_to_the_project(monkeypatch):
    monkeypatch.delenv("FIRESTORE_EMULATOR_HOST", raising=False)
    monkeypatch.delenv("FIRESTORE_ACCESS_TOKEN", raising=False)
    monkeypatch.setattr("elitetracker.sources.firestore.gcloud_token", lambda: "user-token")
    transport = Recorder([{"fields": {}}])
    store = Firestore("proj", transport=transport)
    store.get("a/b")
    assert transport.calls[0][3]["X-Goog-User-Project"] == "proj" and transport.calls[0][3]["Authorization"] == "Bearer user-token"


def test_a_ci_token_is_used_as_is_without_a_billing_header(monkeypatch):
    monkeypatch.delenv("FIRESTORE_EMULATOR_HOST", raising=False)
    monkeypatch.setenv("FIRESTORE_ACCESS_TOKEN", "ci-token")
    transport = Recorder([{"fields": {}}])
    Firestore("proj", transport=transport).get("a/b")
    assert transport.calls[0][3]["Authorization"] == "Bearer ci-token" and "X-Goog-User-Project" not in transport.calls[0][3]


def test_the_emulator_host_wins(monkeypatch):
    monkeypatch.setenv("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8085")
    transport = Recorder([{"fields": {}}])
    Firestore("proj", transport=transport).get("a/b")
    assert transport.calls[0][1].startswith("http://127.0.0.1:8085/v1/projects/proj/") and transport.calls[0][3]["Authorization"] == "Bearer owner"


def test_decode_document_of_an_empty_document():
    assert decode_document({"name": "x"}) == {}
