"""Adapter for the parse.bot scraper payload.

The scraper this reads was deleted upstream and now 404s, so nothing new can be
fetched through it. The adapter is kept because the archived first fetch
(``data/raw/eliteserien_2026_matches.json``) is still normalizable, which makes
it a useful cross-check against the fotmob data that replaced it.

Raw records look like::

    {"date": "søndag 09.08.26", "time": "14:30", "home": "Lillestrøm",
     "away": "Rosenborg", "result": "-", "venue": "Åråsen stadion",
     "match_id": "8986259"}
"""

from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path
from typing import Any

from elitetracker.normalize.matches import (
    Match,
    NormalizationError,
    clean_text,
    dump,
    finalize,
    load_json,
    parse_score,
    parse_time,
)

# The scraper prefixes dates with a Norwegian weekday, e.g. "søndag 09.08.26".
_RAW_DATE_FORMAT = "%d.%m.%y"


def parse_date(raw: Any) -> str:
    """Parse ``"søndag 09.08.26"`` (or ``"09.08.26"``) into ``"2026-08-09"``."""
    text = clean_text(raw)
    if text is None:
        raise NormalizationError("missing date")
    # Drop the weekday prefix if present; the date is always the last token.
    token = text.split()[-1]
    try:
        return datetime.strptime(token, _RAW_DATE_FORMAT).date().isoformat()
    except ValueError as exc:
        raise NormalizationError(f"unparseable date {text!r}") from exc


def normalize_match(raw: dict[str, Any]) -> Match:
    """Convert one raw record into a Match, raising on anything unusable."""
    match_id = clean_text(raw.get("match_id"))
    if match_id is None:
        raise NormalizationError("missing match_id")

    home = clean_text(raw.get("home"))
    away = clean_text(raw.get("away"))
    if home is None or away is None:
        raise NormalizationError(f"match {match_id}: missing team name")
    if home == away:
        raise NormalizationError(f"match {match_id}: {home} plays itself")

    home_goals, away_goals = parse_score(raw.get("result"))

    return Match(
        match_id=match_id,
        date=parse_date(raw.get("date")),
        time=parse_time(raw.get("time")),
        home=home,
        away=away,
        venue=clean_text(raw.get("venue")),
        home_goals=home_goals,
        away_goals=away_goals,
        played=home_goals is not None,
    )


def normalize(raw_matches: list[dict[str, Any]]) -> list[Match]:
    return finalize(normalize_match(raw) for raw in raw_matches)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("input", type=Path, help="raw parse.bot match JSON")
    parser.add_argument("output", type=Path, help="destination for normalized JSON")
    args = parser.parse_args(argv)

    raw = load_json(args.input)
    matches = normalize(raw)
    dump(matches, args.output)

    played = sum(1 for match in matches if match.played)
    print(
        f"{args.input} -> {args.output}: {len(matches)} matches "
        f"({len(raw) - len(matches)} duplicates dropped, {played} played, "
        f"{len(matches) - played} upcoming)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
