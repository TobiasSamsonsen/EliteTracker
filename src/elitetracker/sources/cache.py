"""Read-through disk cache for remote fetches.

The pipeline is request -> validate -> store -> use cached data. Callers ask
for a key; if a fresh file exists it is returned without touching the network,
otherwise the supplied fetch function runs and its result is stored.

Freshness is judged by file modification time so the cache needs no sidecar
metadata and stays inspectable as plain JSON in data/raw/.
"""

from __future__ import annotations

import json
import time
from datetime import timedelta
from pathlib import Path
from typing import Any, Callable

DEFAULT_MAX_AGE = timedelta(hours=6)


class Cache:
    def __init__(self, root: Path, max_age: timedelta = DEFAULT_MAX_AGE) -> None:
        self.root = Path(root)
        self.max_age = max_age

    def path_for(self, key: str) -> Path:
        return self.root / f"{key}.json"

    def age_seconds(self, key: str) -> float | None:
        """Seconds since the cached entry was written, or None if absent."""
        path = self.path_for(key)
        if not path.exists():
            return None
        return time.time() - path.stat().st_mtime

    def is_fresh(self, key: str) -> bool:
        age = self.age_seconds(key)
        return age is not None and age < self.max_age.total_seconds()

    def read(self, key: str) -> Any:
        with self.path_for(key).open(encoding="utf-8") as handle:
            return json.load(handle)

    def write(self, key: str, payload: Any) -> Path:
        path = self.path_for(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        return path

    def get_or_fetch(
        self,
        key: str,
        fetch: Callable[[], Any],
        *,
        force: bool = False,
        validate: Callable[[Any], None] | None = None,
    ) -> tuple[Any, bool]:
        """Return ``(payload, from_cache)``.

        `validate` runs on freshly fetched data *before* it is stored, so a bad
        response never overwrites a good cache entry. It also runs on cache
        *hits*: an entry written by a different source or an older schema would
        otherwise be handed to callers that cannot read it.
        """
        if not force and self.is_fresh(key):
            payload = self.read(key)
            if validate is None:
                return payload, True
            try:
                validate(payload)
            except (ValueError, RuntimeError):
                pass  # unusable entry -- fall through and refetch
            else:
                return payload, True

        payload = fetch()
        if validate is not None:
            validate(payload)
        self.write(key, payload)
        return payload, False
