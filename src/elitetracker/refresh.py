"""Refetch the latest results and rebuild the normalized match files.

This is the one command to run when a round has finished. It pulls the current
fixture feed from fotmob (which also carries results for played matches),
normalizes it, runs the same consistency checks a hand-written file would get,
and replaces ``data/normalized/<league>_<season>_matches.json``.

Nothing here touches the model; the rating replay, table and simulations read
the normalized files on every run, so once the files are current the
predictions are current too. A network failure or a file that fails validation
leaves the previous normalized files untouched.

Usage::

    python -m elitetracker.refresh                      # both divisions, latest season
    python -m elitetracker.refresh --season 2026        # pick a season
    python -m elitetracker.refresh --no-force           # let the 6h raw cache answer
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any, Callable, Iterable

from elitetracker.normalize.fotmob import normalize_matches
from elitetracker.normalize.matches import dump
from elitetracker.pipeline import NORMALIZED_DIR, current_season
from elitetracker.sources.fotmob import LEAGUES, FetchError, fetch_matches
from elitetracker.validation.matches import validate

RAW_DIR = Path("data/raw")


class RefreshError(RuntimeError):
    """A matched file failed to validate, so nothing was overwritten."""


@dataclass(frozen=True)
class LeagueRefresh:
    """What one league's refreshed file contains."""

    slug: str
    name: str
    season: int
    matches: int
    played: int
    last_result: str | None

    @property
    def upcoming(self) -> int:
        return self.matches - self.played


def _fetch(
    slug: str, season: int, *, force: bool, cache_dir: Path = RAW_DIR
) -> list[dict[str, Any]]:
    """Default fetcher: fotmob, cache backed by data/raw/."""
    payload, _from_cache = fetch_matches(slug, season, force=force, cache_dir=cache_dir)
    return payload


def refresh_matches(
    root: Path = NORMALIZED_DIR,
    *,
    season: int | None = None,
    force: bool = True,
    fetch: Callable[..., list[dict[str, Any]]] = _fetch,
    leagues: Iterable[str] | None = None,
    today: date | None = None,
) -> list[LeagueRefresh]:
    """Refetch and rewrite the match files for every requested league.

    Each league is fetched, normalized and validated in turn; a payload that
    fails validation raises :class:`RefreshError` and leaves that league's
    previous file untouched. `today` is passed through to the validator so a
    refreshed snapshot can be checked against the calendar.
    """
    season = season or current_season(root)
    root = Path(root)
    refreshed = []

    for slug in leagues or sorted(LEAGUES):
        lg = LEAGUES[slug]
        raw = fetch(slug, season, force=force)
        matches = normalize_matches(raw)
        report = validate(matches, expected_teams=lg.team_count, today=today)
        if not report.ok:
            raise RefreshError(
                f"{lg.name} {season}: refusing to write, normalized data failed checks:\n"
                + "\n".join(f"  ERROR {error}" for error in report.errors)
            )

        dump(matches, root / f"{slug}_{season}_matches.json")
        played = [m for m in matches if m.played]
        refreshed.append(
            LeagueRefresh(
                slug=slug,
                name=lg.name,
                season=season,
                matches=len(matches),
                played=len(played),
                last_result=max((m.date for m in played), default=None),
            )
        )

    return refreshed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--season", type=int, help="default: the latest season with data")
    parser.add_argument("--root", type=Path, default=NORMALIZED_DIR)
    parser.add_argument("--no-force", action="store_true", help="use a fresh raw cache entry instead of refetching")
    args = parser.parse_args(argv)

    refreshed = refresh_matches(args.root, season=args.season, force=not args.no_force)

    for result in refreshed:
        source = "fotmob" if not args.no_force else "cache"
        last = f", last result {result.last_result}" if result.last_result else ""
        print(
            f"{result.name} {result.season}: {result.matches} matches "
            f"({result.played} played, {result.upcoming} upcoming){last}, from {source}"
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FetchError, RefreshError) as exc:
        print(f"refresh failed: {exc}")
        raise SystemExit(1)