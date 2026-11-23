"""An in-memory stand-in for sources.firestore.Firestore, for the sync tests.

It takes the same Write objects the real client sends and applies them the way
Firestore would (set replaces, merge writes the masked leaf fields, delete
removes; a server-time transform becomes the store's clock), so the job's logic
is tested without a network or the emulator.
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import Any, Iterable, Iterator

from elitetracker.sources.firestore import Write, decode, decode_document


def _split(path: str) -> list[str]:
    """A field path with backtick quoting, as a list of keys."""
    parts, current, quoted = [], "", False
    for char in path:
        if char == "`":
            quoted = not quoted
        elif char == "." and not quoted:
            parts.append(current)
            current = ""
        else:
            current += char
    parts.append(current)
    return parts


def _put(data: dict, keys: list[str], value: Any) -> None:
    for key in keys[:-1]:
        data = data.setdefault(key, {})
    data[keys[-1]] = value


class FakeStore:
    def __init__(self, clock: datetime | None = None):
        self.docs: dict[str, dict] = {}
        self.clock = clock or datetime(2027, 4, 1, tzinfo=timezone.utc)
        self.commits: list[list[Write]] = []

    # reads
    def get(self, path: str) -> dict | None:
        return copy.deepcopy(self.docs.get(path))

    def list(self, collection: str, page_size: int = 300) -> Iterator[tuple[str, dict]]:
        prefix = collection.strip("/") + "/"
        for path in sorted(self.docs):
            if path.startswith(prefix) and "/" not in path[len(prefix):]:
                yield path[len(prefix):], copy.deepcopy(self.docs[path])

    def query_group(self, collection_id: str, field: str, equals: Any) -> Iterator[tuple[str, dict]]:
        for path in sorted(self.docs):
            parts = path.split("/")
            if len(parts) >= 2 and parts[-2] == collection_id and self.docs[path].get(field) == equals:
                yield path, copy.deepcopy(self.docs[path])

    # writes
    def commit(self, writes: Iterable[Write], batch: int = 400) -> int:
        writes = list(writes)
        self.commits.append(writes)
        for write in writes:
            body = write.body
            if "delete" in body:
                self.docs.pop(write.path, None)
                continue
            fields = decode_document({"fields": body["update"]["fields"]})
            if "updateMask" in body:
                doc = self.docs.setdefault(write.path, {})
                for path in body["updateMask"]["fieldPaths"]:
                    keys = _split(path)
                    cursor = fields
                    for key in keys:
                        cursor = cursor[key]
                    _put(doc, keys, cursor)
            else:
                doc = fields
                self.docs[write.path] = doc
            for transform in body.get("updateTransforms", []):
                _put(doc, _split(transform["fieldPath"]), self.clock)
        return len(writes)

    def set(self, path: str, data: dict) -> None:
        self.commit([Write.set(path, data)])

    def merge(self, path: str, data: dict) -> None:
        self.commit([Write.merge(path, data)])

    def delete(self, path: str) -> None:
        self.commit([Write.delete(path)])

    def writes_to(self, prefix: str) -> list[Write]:
        return [w for batch in self.commits for w in batch if w.path.startswith(prefix)]
