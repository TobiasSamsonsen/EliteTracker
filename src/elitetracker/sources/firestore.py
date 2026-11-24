"""A small Firestore REST client for the Predict job (docs/predict-plan.md).

The only network code that talks to Firestore, beside the other fetchers in
this package, so "nothing below pipeline.py touches the network" still holds.
Standard library only (urllib): the Firebase SDKs would be a new dependency
for a handful of calls.

Auth, in order: ``FIRESTORE_EMULATOR_HOST`` (the emulator, bearer ``owner``,
which bypasses security rules like an admin), ``FIRESTORE_ACCESS_TOKEN`` (CI:
the output of google-github-actions/auth, a Workload Identity token for the
``predict-sync`` service account), or ``gcloud auth print-access-token`` on a
developer machine. The browser API key is never used here.

Values are decoded to plain Python: int, float, str, bool, None, aware
datetime (timestamps), list, dict. ``encode`` goes the other way; a ``datetime``
becomes a timestamp and a ``ServerTime`` a server-time transform.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Iterator

PROJECT = "elitetrackerno"
API = "https://firestore.googleapis.com/v1"
_SIMPLE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class FirestoreError(RuntimeError):
    """A Firestore call failed; ``status`` is the HTTP status, 0 for no response."""

    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class ServerTime:
    """Marker: write the server's request time into this field (a transform)."""


SERVER_TIME = ServerTime()


# ---- value encoding ---------------------------------------------------------

def encode(value: Any) -> dict[str, Any]:
    if value is None:
        return {"nullValue": None}
    if isinstance(value, bool):
        return {"booleanValue": value}
    if isinstance(value, int):
        return {"integerValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, datetime):
        stamp = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return {"timestampValue": stamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")}
    if isinstance(value, (list, tuple)):
        return {"arrayValue": {"values": [encode(v) for v in value]}}
    if isinstance(value, dict):
        return {"mapValue": {"fields": {str(k): encode(v) for k, v in value.items()}}}
    raise TypeError(f"cannot encode {type(value).__name__}")


def parse_time(text: str) -> datetime:
    """An RFC 3339 timestamp with any fraction of a second, as an aware datetime."""
    text = text.replace("Z", "+00:00")
    head, _, rest = text.partition(".")
    if rest:
        digits = re.match(r"\d+", rest).group(0)
        tail = rest[len(digits):]
        text = f"{head}.{digits[:6].ljust(6, '0')}{tail}"
    return datetime.fromisoformat(text)


def decode(value: dict[str, Any]) -> Any:
    (kind, payload), = value.items()
    if kind == "nullValue":
        return None
    if kind in ("booleanValue", "stringValue", "doubleValue"):
        return payload
    if kind == "integerValue":
        return int(payload)
    if kind == "timestampValue":
        return parse_time(payload)
    if kind == "arrayValue":
        return [decode(v) for v in payload.get("values", [])]
    if kind == "mapValue":
        return {k: decode(v) for k, v in payload.get("fields", {}).items()}
    return payload  # referenceValue, geoPointValue, bytesValue: passed through


def decode_document(document: dict[str, Any]) -> dict[str, Any]:
    return {k: decode(v) for k, v in document.get("fields", {}).items()}


def field_path(*parts: str) -> str:
    """A field path, quoting a part that is not a plain identifier (a key that
    starts with a digit, say) with backticks."""
    return ".".join(p if _SIMPLE.match(p) else "`" + p.replace("\\", "\\\\").replace("`", "\\`") + "`"
                    for p in parts)


# ---- writes -----------------------------------------------------------------

def _flatten(prefix: tuple[str, ...], data: dict[str, Any], fields: dict, paths: list, stamps: list) -> None:
    """Split a nested dict into leaf fields (for the update mask) and server-time
    transforms. Leaves are written one by one so a merge never clobbers a sibling."""
    for key, value in data.items():
        here = prefix + (str(key),)
        if isinstance(value, ServerTime):
            stamps.append(field_path(*here))
        elif isinstance(value, dict) and value:
            _flatten(here, value, fields, paths, stamps)
        else:
            paths.append(field_path(*here))
            cursor = fields
            for part in here[:-1]:
                cursor = cursor.setdefault(part, {"mapValue": {"fields": {}}})["mapValue"]["fields"]
            cursor[here[-1]] = encode(value)


class Write:
    """One write of a batched commit. Build with ``Write.set``, ``Write.merge``
    or ``Write.delete``."""

    def __init__(self, path: str, body: dict[str, Any]):
        self.path = path
        self.body = body

    @classmethod
    def set(cls, path: str, data: dict[str, Any]) -> "Write":
        """Replace the document. Top-level ServerTime values become transforms."""
        stamps = [k for k, v in data.items() if isinstance(v, ServerTime)]
        plain = {k: encode(v) for k, v in data.items() if not isinstance(v, ServerTime)}
        body: dict[str, Any] = {"update": {"name": path, "fields": plain}}
        if stamps:
            body["updateTransforms"] = [{"fieldPath": field_path(k), "setToServerValue": "REQUEST_TIME"} for k in stamps]
        return cls(path, body)

    @classmethod
    def merge(cls, path: str, data: dict[str, Any]) -> "Write":
        """Set the given leaf fields (nested dicts are merged, not replaced);
        the document is created if absent."""
        fields: dict[str, Any] = {}
        paths: list[str] = []
        stamps: list[str] = []
        _flatten((), data, fields, paths, stamps)
        body: dict[str, Any] = {"update": {"name": path, "fields": fields}, "updateMask": {"fieldPaths": paths}}
        if stamps:
            body["updateTransforms"] = [{"fieldPath": s, "setToServerValue": "REQUEST_TIME"} for s in stamps]
        return cls(path, body)

    @classmethod
    def delete(cls, path: str) -> "Write":
        return cls(path, {"delete": path})


# ---- the client -------------------------------------------------------------

def gcloud_token() -> str:
    for exe in ("gcloud", "gcloud.cmd"):
        try:
            out = subprocess.run([exe, "auth", "print-access-token"], capture_output=True, text=True, timeout=60)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            continue
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    raise FirestoreError("no credentials: set FIRESTORE_ACCESS_TOKEN or log in with gcloud")


class Firestore:
    """Reads and writes one project's (default) database over REST.

    ``transport(method, url, body, headers)`` returns the parsed JSON reply and
    is replaceable for tests; the default uses urllib."""

    def __init__(self, project: str = PROJECT, token: str | None = None, base: str | None = None,
                 transport: Callable[..., Any] | None = None):
        self.project = project
        emulator = os.environ.get("FIRESTORE_EMULATOR_HOST")
        self.base = base or (f"http://{emulator}/v1" if emulator else API)
        self.quota_project = False
        if token is None:
            if emulator:
                token = "owner"
            elif os.environ.get("FIRESTORE_ACCESS_TOKEN"):
                token = os.environ["FIRESTORE_ACCESS_TOKEN"]
            else:
                token = gcloud_token()
                self.quota_project = True  # a user token needs a project to bill the call to
        self.token = token
        self.transport = transport or self._http
        self.root = f"projects/{project}/databases/(default)/documents"

    # -- plumbing
    def _http(self, method: str, url: str, body: Any, headers: dict[str, str]) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=60) as reply:
                text = reply.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            raise FirestoreError(f"{method} {url} -> {error.code}: {error.read().decode('utf-8', 'replace')[:400]}",
                                 error.code) from None
        except urllib.error.URLError as error:
            raise FirestoreError(f"{method} {url}: {error.reason}") from None
        return json.loads(text) if text else {}

    def _call(self, method: str, path: str, body: Any = None) -> Any:
        headers = {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"}
        if self.quota_project:
            headers["X-Goog-User-Project"] = self.project
        return self.transport(method, f"{self.base}/{path}", body, headers)

    def name(self, path: str) -> str:
        return f"{self.root}/{path.strip('/')}"

    # -- reads
    def get(self, path: str) -> dict[str, Any] | None:
        try:
            return decode_document(self._call("GET", self.name(path)))
        except FirestoreError as error:
            if error.status == 404:
                return None
            raise

    def list(self, collection: str, page_size: int = 300) -> Iterator[tuple[str, dict[str, Any]]]:
        """(id, fields) of every document directly in ``collection`` (a path)."""
        token = ""
        while True:
            query = f"?pageSize={page_size}" + (f"&pageToken={urllib.parse.quote(token)}" if token else "")
            reply = self._call("GET", self.name(collection) + query)
            for document in reply.get("documents", []):
                yield document["name"].rsplit("/", 1)[-1], decode_document(document)
            token = reply.get("nextPageToken", "")
            if not token:
                return

    def query_group(self, collection_id: str, field: str, equals: Any) -> Iterator[tuple[str, dict[str, Any]]]:
        """(full path under the documents root, fields) of every document in any
        collection called ``collection_id`` whose ``field`` equals ``equals``.
        Needs the collection-group index in firestore.indexes.json."""
        body = {"structuredQuery": {
            "from": [{"collectionId": collection_id, "allDescendants": True}],
            "where": {"fieldFilter": {"field": {"fieldPath": field}, "op": "EQUAL", "value": encode(equals)}},
        }}
        reply = self._call("POST", f"projects/{self.project}/databases/(default)/documents:runQuery", body)
        prefix = self.root + "/"
        for row in reply if isinstance(reply, list) else []:
            document = row.get("document")
            if document:
                yield document["name"][len(prefix):], decode_document(document)

    def query_group_after(self, collection_id: str, field: str, after: datetime | None = None) -> Iterator[tuple[str, dict[str, Any]]]:
        """Like ``query_group``, for every document whose timestamp ``field`` is later than ``after``
        (every document that has the field when ``after`` is None), oldest first. The collection-group
        index on that field is in firestore.indexes.json."""
        query: dict[str, Any] = {"from": [{"collectionId": collection_id, "allDescendants": True}],
                                 "orderBy": [{"field": {"fieldPath": field}, "direction": "ASCENDING"}]}
        if after is not None:
            query["where"] = {"fieldFilter": {"field": {"fieldPath": field}, "op": "GREATER_THAN", "value": encode(after)}}
        reply = self._call("POST", f"projects/{self.project}/databases/(default)/documents:runQuery", {"structuredQuery": query})
        prefix = self.root + "/"
        for row in reply if isinstance(reply, list) else []:
            document = row.get("document")
            if document:
                yield document["name"][len(prefix):], decode_document(document)

    # -- writes
    def commit(self, writes: Iterable[Write], batch: int = 400) -> int:
        """Apply the writes, in batches (each batch is atomic). Returns the count."""
        pending = list(writes)
        for start in range(0, len(pending), batch):
            chunk = pending[start:start + batch]
            body = {"writes": [self._named(w) for w in chunk]}
            self._call("POST", f"projects/{self.project}/databases/(default)/documents:commit", body)
        return len(pending)

    def _named(self, write: Write) -> dict[str, Any]:
        body = json.loads(json.dumps(write.body))  # a copy: the path is rewritten to a full name
        full = self.name(write.path)
        if "update" in body:
            body["update"]["name"] = full
        else:
            body["delete"] = full
        return body

    def set(self, path: str, data: dict[str, Any]) -> None:
        self.commit([Write.set(path, data)])

    def merge(self, path: str, data: dict[str, Any]) -> None:
        self.commit([Write.merge(path, data)])

    def delete(self, path: str) -> None:
        self.commit([Write.delete(path)])
