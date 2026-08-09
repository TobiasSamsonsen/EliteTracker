"""Normalize raw match payloads into the canonical match schema.

Raw records come from the parse.bot scraper and look like::

    {"date": "søndag 09.08.26", "time": "14:30", "home": "Lillestrøm",
     "away": "Rosenborg", "result": "-", "venue": "Åråsen stadion",
     "match_id": "8986259"}

A normalized record looks like::

    {"match_id": "8986259", "date": "2026-08-09", "time": "14:30",
     "home": "Lillestrøm", "away": "Rosenborg", "venue": "Åråsen stadion",
     "home_goals": None, "away_goals": None, "played": False}

Dates are stored as ISO ``YYYY-MM-DD`` strings so they sort lexically and
survive JSON round-trips unchanged -- an earlier pandas-based version wrote
them as epoch milliseconds, which broke every downstream consumer.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

# The scraper prefixes dates with a Norwegian weekday, e.g. "søndag 09.08.26".
# Only the trailing DD.MM.YY part is meaningful.
_RAW_DATE_FORMAT = "%d.%m.%y"

# "2 - 1", "2-1" and "2 – 1" (en dash) all appear in scraped data.
_RESULT_PATTERN = re.compile(r"^\s*(\d+)\s*[-–]\s*(\d+)\s*$")

_TIME_PATTERN = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")

# Placeholders the scraper uses for "no value yet".
_MISSING = {"", "-", "–", "null", "none"}


class NormalizationError(ValueError):
    """A raw record could not be turned into a normalized record."""


@dataclass(frozen=True)
class Match:
    match_id: str
    date: str  # ISO YYYY-MM-DD
    time: str | None  # HH:MM, or None when the kickoff time is not published
    home: str
    away: str
    venue: str | None
    home_goals: int | None
    away_goals: int | None
    played: bool

    def sort_key(self) -> tuple[str, str, str]:
        """Chronological ordering: date, then kickoff time, then match id.

        Matches with no published kickoff time sort last within their day --
        an unknown time is not the same as midnight.
        """
        return (self.date, self.time or "99:99", self.match_id)


def _clean(value: Any) -> str | None:
    """Collapse the scraper's various empty-value spellings to None."""
    if value is None:
        return None
    text = str(value).strip()
    if text.lower() in _MISSING:
        return None
    return text


def parse_date(raw: Any) -> str:
    """Parse ``"søndag 09.08.26"`` (or ``"09.08.26"``) into ``"2026-08-09"``."""
    text = _clean(raw)
    if text is None:
        raise NormalizationError("missing date")
    # Drop the weekday prefix if present; the date is always the last token.
    token = text.split()[-1]
    try:
        return datetime.strptime(token, _RAW_DATE_FORMAT).date().isoformat()
    except ValueError as exc:
        raise NormalizationError(f"unparseable date {text!r}") from exc


def parse_time(raw: Any) -> str | None:
    """Return a ``HH:MM`` string, or None when no kickoff time is published."""
    text = _clean(raw)
    if text is None:
        return None
    if not _TIME_PATTERN.match(text):
        raise NormalizationError(f"unparseable time {text!r}")
    return text


def parse_result(raw: Any) -> tuple[int | None, int | None]:
    """Split ``"2 - 1"`` into ``(2, 1)``; an unplayed match yields ``(None, None)``."""
    text = _clean(raw)
    if text is None:
        return (None, None)
    match = _RESULT_PATTERN.match(text)
    if match is None:
        raise NormalizationError(f"unparseable result {text!r}")
    return (int(match.group(1)), int(match.group(2)))


def normalize_match(raw: dict[str, Any]) -> Match:
    """Convert one raw record into a Match, raising on anything unusable."""
    match_id = _clean(raw.get("match_id"))
    if match_id is None:
        raise NormalizationError("missing match_id")

    home = _clean(raw.get("home"))
    away = _clean(raw.get("away"))
    if home is None or away is None:
        raise NormalizationError(f"match {match_id}: missing team name")
    if home == away:
        raise NormalizationError(f"match {match_id}: {home} plays itself")

    home_goals, away_goals = parse_result(raw.get("result"))

    return Match(
        match_id=match_id,
        date=parse_date(raw.get("date")),
        time=parse_time(raw.get("time")),
        home=home,
        away=away,
        venue=_clean(raw.get("venue")),
        home_goals=home_goals,
        away_goals=away_goals,
        played=home_goals is not None,
    )


def deduplicate(matches: Iterable[Match]) -> list[Match]:
    """Drop repeated match ids.

    The scraper emits the current round twice, so identical records are
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


def normalize(raw_matches: Iterable[dict[str, Any]]) -> list[Match]:
    """Normalize, deduplicate and chronologically sort a raw match list."""
    normalized = [normalize_match(raw) for raw in raw_matches]
    return sorted(deduplicate(normalized), key=Match.sort_key)


def load_raw(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    if data is None:
        raise NormalizationError(f"{path} contains null -- the fetch never succeeded")
    if not isinstance(data, list):
        raise NormalizationError(f"{path} should contain a list of matches, got {type(data).__name__}")
    return data


def dump(matches: list[Match], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    records = [asdict(match) for match in matches]
    with path.open("w", encoding="utf-8") as handle:
        json.dump(records, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("input", type=Path, help="raw match JSON from data/raw/")
    parser.add_argument("output", type=Path, help="destination for normalized JSON")
    args = parser.parse_args(argv)

    raw = load_raw(args.input)
    matches = normalize(raw)
    dump(matches, args.output)

    dropped = len(raw) - len(matches)
    played = sum(1 for match in matches if match.played)
    print(
        f"{args.input} -> {args.output}: {len(matches)} matches "
        f"({dropped} duplicates dropped, {played} played, {len(matches) - played} upcoming)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
