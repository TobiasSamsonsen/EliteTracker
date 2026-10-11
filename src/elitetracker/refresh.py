"""Refetch the latest results and rebuild the normalized match files.

This is the one command to run when a round has finished. It pulls the current
fixture feed from fotmob (which also carries results for played matches),
normalizes it, runs the same consistency checks a hand-written file would get,
and replaces ``data/normalized/<league>_<season>_matches.json``.

It also stores Norway's UEFA association rank for the season
(``uefa_ranks.json``), which decides the league places that lead into Europe.

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
import os
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from elitetracker.normalize.fotmob import normalize_matches
from elitetracker.normalize.matches import dump
from elitetracker.pipeline import (
    NORMALIZED_DIR, UEFA_RANKS_FILE, _europe_by_rank, current_season, load_matches,
)
from elitetracker.sources.fotmob import LEAGUES, FetchError, fetch_matches, update_xg
from elitetracker.sources.sofascore import (
    SofascoreBlocked, pending_obos_xg, update_obos_xg,
)
from elitetracker.sources.uefa import fetch_rank
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


def refresh_uefa_rank(
    root: Path = NORMALIZED_DIR,
    season: int | None = None,
    *,
    fetch: Callable[[int], int] = fetch_rank,
    today: date | None = None,
) -> None:
    """Store Norway's UEFA rank for `season` in uefa_ranks.json.

    The rank that decides a season's European places is provisional until
    the European season ends in June, so it is refetched until a stored
    rank has reached August. Non-fatal by design: on a failed fetch or a
    rank the access-list rule does not cover, the stored ranks stand and
    the season takes the newest one known.
    """
    root = Path(root)
    season = season or current_season(root)
    path = root / UEFA_RANKS_FILE
    stored = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    if str(season) in stored and (today or date.today()) >= date(season, 8, 1):
        return  # final; no request needed
    try:
        rank = fetch(season)
        _europe_by_rank(rank)
    except (FetchError, ValueError) as exc:
        print(f"UEFA rank skipped: {exc}")
        return
    if stored.get(str(season)) != rank:
        stored[str(season)] = rank
        path.write_text(json.dumps(dict(sorted(stored.items())), indent=2) + "\n", encoding="utf-8")
        print(f"UEFA rank {season}: Norway {rank}")


def _in_ci() -> bool:
    return bool(os.environ.get("GITHUB_ACTIONS"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--season", type=int, help="default: the latest season with data")
    parser.add_argument("--root", type=Path, default=NORMALIZED_DIR)
    parser.add_argument("--force", action="store_true", help="fetch even if no matches appear to have finished")
    parser.add_argument("--obos-xg", action="store_true",
                        help="fetch OBOS xG even in CI (only useful where Sofascore serves this network)")
    args = parser.parse_args(argv)
    refresh_matches(args.root, season=args.season, refresh_guard=not args.force)
    refresh_uefa_rank(args.root, args.season)
    # The attack/defence ratings and the Elo update both run on xG where there
    # is any: fotmob for Eliteserien, Sofascore for OBOS (fotmob has no shotmap
    # for the second division). Top up both for anything newly played.
    # Non-fatal by design -- the model falls back to goals.
    season = args.season or current_season(args.root)
    added = update_xg(load_matches(args.root / f"eliteserien_{season}_matches.json"))
    if _in_ci() and not args.obos_xg:
        # Sofascore refuses GitHub's runner ranges outright, so a scheduled run
        # would ask, be told no, and ask again in half an hour -- 48 pointless
        # requests a day against a site we want to stay welcome to. Skip it and
        # let the local pull own OBOS xG; `--obos-xg` overrides when a runner
        # range does get served.
        print("OBOS xG: skipped in CI (Sofascore refuses runner IPs). "
              "Run `python -m elitetracker.refresh --obos-xg` locally.")
    else:
        try:
            obos = load_matches(args.root / f"obosligaen_{season}_matches.json")
            # Ask only about matches that were never fetched, or were fetched
            # inside the settle window and may have been revised since. A fully
            # settled season costs no request at all.
            todo = pending_obos_xg(obos)
            if todo:
                obos_added = update_obos_xg(obos, season, only=todo)
                added += obos_added
                print(f"OBOS xG: {obos_added} recorded")
            else:
                print("OBOS xG: nothing outstanding")
        except SofascoreBlocked as exc:
            # Sofascore refuses this network outright; no request shape changes
            # that. The model falls back to goals for OBOS, so not fatal.
            print(f"OBOS xG unavailable: {exc}")
        except FetchError as exc:
            print(f"OBOS xG skipped: {exc}")
    if added:
        print(f"xG: {added} new match(es) recorded")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except FetchError as exc:
        raise SystemExit(f"refresh failed: {exc}")
