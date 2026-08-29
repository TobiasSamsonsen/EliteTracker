"""The canonical match schema and the source-independent normalization steps.

Per-source adapters live alongside this module (``fotmob``) and
all produce :class:`Match` objects, so deduplication, ordering, serialization
and validation are written once.

Dates are stored as ISO ``YYYY-MM-DD`` strings so they sort lexically and
survive JSON round-trips unchanged -- an earlier pandas-based pipeline wrote
them as epoch milliseconds, which broke every downstream consumer.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable

# "2 - 1", "2-1" and "2 – 1" (en dash) all appear across sources.
_SCORE_PATTERN = re.compile(r"^\s*(\d+)\s*[-–]\s*(\d+)\s*$")

_TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")

# Placeholders sources use for "no value yet".
_MISSING = {"", "-", "–", "null", "none"}


class NormalizationError(ValueError):
    """A raw record could not be turned into a normalized record."""


@dataclass(frozen=True)
class Match:
    match_id: str
    date: str  # ISO YYYY-MM-DD, local (Europe/Oslo) matchday
    time: str | None  # HH:MM local, or None when no kickoff time is published
    home: str
    away: str
    venue: str | None
    home_goals: int | None
    away_goals: int | None
    played: bool
    # Fields below are only available from richer sources; adapters that cannot
    # supply them leave them None so the schema stays uniform.
    kickoff_utc: str | None = None  # ISO 8601, e.g. 2026-03-14T15:00:00Z
    round: int | None = None
    home_id: str | None = None
    away_id: str | None = None

    def sort_key(self) -> tuple[str, str, str]:
        """Chronological ordering: date, then kickoff time, then match id.

        Matches with no published kickoff time sort last within their day --
        an unknown time is not the same as midnight.
        """
        return (self.date, self.time or "99:99", self.match_id)


def clean_text(value: Any) -> str | None:
    """Collapse a source's various empty-value spellings to None."""
    if value is None:
        return None
    text = str(value).strip()
    if text.lower() in _MISSING:
        return None
    return text


def parse_time(raw: Any) -> str | None:
    """Return a ``HH:MM`` string, or None when no kickoff time is published."""
    text = clean_text(raw)
    if text is None:
        return None
    if not _TIME_PATTERN.match(text):
        raise NormalizationError(f"unparseable time {text!r}")
    return text


def parse_score(raw: Any) -> tuple[int | None, int | None]:
    """Split ``"2 - 1"`` into ``(2, 1)``; an unplayed match yields ``(None, None)``."""
    text = clean_text(raw)
    if text is None:
        return (None, None)
    match = _SCORE_PATTERN.match(text)
    if match is None:
        raise NormalizationError(f"unparseable result {text!r}")
    return (int(match.group(1)), int(match.group(2)))


def deduplicate(matches: Iterable[Match]) -> list[Match]:
    """Drop repeated match ids.

    Some sources emit the current round twice, so identical records are
    expected and dropped silently. Two records sharing an id but disagreeing on
    content is a genuine data problem and raises instead.
    """
    seen: dict[str, Match] = {}
    for match in matches:
        existing = seen.get(match.match_id)
        if existing is None:
            seen[match.match_id] = match
        elif existing != match:
            raise NormalizationError(
                f"match {match.match_id} appears twice with conflicting data: "
                f"{existing} != {match}"
            )
    return list(seen.values())


def finalize(matches: Iterable[Match]) -> list[Match]:
    """Deduplicate and chronologically sort adapter output."""
    return sorted(deduplicate(matches), key=Match.sort_key)


def load_json(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if data is None:
        raise NormalizationError(f"{path} contains null -- the fetch never succeeded")
    if not isinstance(data, list):
        raise NormalizationError(
            f"{path} should contain a list of matches, got {type(data).__name__}"
        )
    return data


def dump(matches: list[Match], path: Path) -> None:
    """Write the records, replacing any existing file atomically.

    The JSON is written to a temporary sibling and renamed into place, so a
    crash mid-write never leaves a truncated fixture list masquerading as a
    complete one.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    records = [asdict(match) for match in matches]
    temp = path.with_suffix(path.suffix + ".tmp")
    try:
        with temp.open("w", encoding="utf-8") as handle:
            json.dump(records, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)
