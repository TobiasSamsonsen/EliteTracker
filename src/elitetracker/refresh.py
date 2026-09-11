"""Refetch the latest results and rebuild the normalized match files.

This is the one command to run when a round has finished. It pulls the current
fixture feed from fotmob (which also carries results for played matches),
normalizes it, runs the same consistency checks a hand-written file would get,
and replaces ``data/normalized/<league>_<season>_matches.json``.

Nothing here touches the model; the rating replay, table and simulations read
the normalized files on every run, so once the files are current the
predictions are current too. A network failure or a file that fails validation
leaves the previous normalized files untouched.

By default a guard skips leagues whose normalized file already exists and has
no unplayed matches with a past kickoff -- fotmob cannot have new results for
them. ``--force`` disables this check.

Usage::

    python -m elitetracker.refresh                      # both divisions, latest season
    python -m elitetracker.refresh --season 2026        # pick a season
    python -m elitetracker.refresh --force              # skip the refresh guard
"""

from __future__ import annotations

import argparse
import json
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from elitetracker.normalize.fotmob import normalize_matches
from elitetracker.normalize.matches import dump
from elitetracker.pipeline import NORMALIZED_DIR, current_season, load_matches
from elitetracker.sources.fotmob import LEAGUES, FetchError, fetch_matches, update_xg
from elitetracker.validation.matches import validate


def _needs_refresh(slug: str, season: int, root: Path) -> bool:
    """True if the league file is missing or has unplayed matches whose
    kickoff time has passed -- meaning results should be available on fotmob."""
    path = root / f"{slug}_{season}_matches.json"
    if not path.exists():
        return True
    try:
        matches = load_matches(path)
    except (json.JSONDecodeError, ValueError, TypeError):
        return True  # corrupted or unreadable -- refetch
    now = datetime.now(timezone.utc)
    for m in matches:
        if m.played or m.kickoff_utc is None:
            continue
        if datetime.fromisoformat(m.kickoff_utc.replace("Z", "+00:00")) < now:
            return True
    return False


def refresh_matches(
    root: Path = NORMALIZED_DIR,
    *,
    season: int | None = None,
    refresh_guard: bool = True,
    fetch: Callable[[str, int], list[dict[str, Any]]] = fetch_matches,
    leagues: Iterable[str] | None = None,
    today: date | None = None,
) -> None:
    """Refetch and rewrite the match files for every requested league.

    Each league is fetched, normalized and validated in turn; a payload that
    fails validation raises :class:`SystemExit` and leaves that league's
    previous file untouched. `today` is passed through to the validator so a
    refreshed snapshot can be checked against the calendar.
    """
    season = season or current_season(root)
    root = Path(root)

    for slug in leagues or sorted(LEAGUES):
        lg = LEAGUES[slug]
        if refresh_guard and not _needs_refresh(slug, season, root):
            print(f"{lg.name} {season}: no finished matches to pick up, skipping")
            continue
        matches = normalize_matches(fetch(slug, season))
        report = validate(matches, expected_teams=lg.team_count, today=today)
        if not report.ok:
            raise SystemExit(
                f"refresh failed: {lg.name} {season}: refusing to write, normalized data failed checks:\n"
                + "\n".join(f"  ERROR {error}" for error in report.errors)
            )

        dump(matches, root / f"{slug}_{season}_matches.json")
        played = [m for m in matches if m.played]
        last = f", last result {max(m.date for m in played)}" if played else ""
        print(
            f"{lg.name} {season}: {len(matches)} matches "
            f"({len(played)} played, {len(matches) - len(played)} upcoming){last}"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--season", type=int, help="default: the latest season with data")
    parser.add_argument("--root", type=Path, default=NORMALIZED_DIR)
    parser.add_argument("--force", action="store_true", help="fetch even if no matches appear to have finished")
    args = parser.parse_args(argv)
    refresh_matches(args.root, season=args.season, refresh_guard=not args.force)
    # The attack/defence ratings update on xG where fotmob has it (Eliteserien);
    # top up the shot file for anything newly played. Non-fatal by design.
    season = args.season or current_season(args.root)
    added = update_xg(load_matches(args.root / f"eliteserien_{season}_matches.json"))
    if added:
        print(f"xG: {added} new match(es) recorded")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except FetchError as exc:
        raise SystemExit(f"refresh failed: {exc}")
