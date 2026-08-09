"""Fetch match schedules and final league tables from fotmob.

fotmob is a Next.js app: the page HTML embeds the fully-rendered page data in a
``<script id="__NEXT_DATA__">`` tag, so no browser or API key is needed. We
extract only the slice we care about and cache that in ``data/raw/``, which
keeps the stored artifacts small and readable.

This replaces the parse.bot scraper used for the first Eliteserien fetch; that
scraper was deleted upstream and now 404s for every tournament.

Usage::

    python -m elitetracker.sources.fotmob matches eliteserien 2026
    python -m elitetracker.sources.fotmob standings obosligaen 2025 --force
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

from elitetracker.sources.cache import DEFAULT_MAX_AGE, Cache

RAW_DIR = Path("data/raw")

# fotmob serves the SPA shell to unknown clients; a browser UA gets the real page.
_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

_NEXT_DATA = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.DOTALL
)

_TIMEOUT_SECONDS = 30


class FetchError(RuntimeError):
    """A remote fetch failed or returned something we cannot use."""


@dataclass(frozen=True)
class League:
    slug: str  # our identifier, used in filenames
    name: str  # human-readable
    fotmob_id: int
    fotmob_path: str  # the slug fotmob uses in its own URLs
    team_count: int


LEAGUES: dict[str, League] = {
    "eliteserien": League("eliteserien", "Eliteserien", 59, "eliteserien", 16),
    "obosligaen": League("obosligaen", "OBOS-ligaen", 203, "1-divisjon", 16),
}


def league(slug: str) -> League:
    try:
        return LEAGUES[slug]
    except KeyError:
        raise FetchError(f"unknown league {slug!r}; known: {sorted(LEAGUES)}") from None


def cache_key(lg: League, season: int, kind: str) -> str:
    """Cache keys are namespaced by source.

    Different sources describe the same fixtures with incompatible schemas, so
    a fotmob payload must never land in the slot holding an archived parse.bot
    payload for the same league and season.
    """
    return f"fotmob_{lg.slug}_{season}_{kind}"


def _url(lg: League, tab: str, season: int) -> str:
    return f"https://www.fotmob.com/leagues/{lg.fotmob_id}/{tab}/{lg.fotmob_path}?season={season}"


def _download(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT_SECONDS) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raise FetchError(f"{url} returned HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise FetchError(f"{url} unreachable: {exc.reason}") from exc


def _page_props(html: str, url: str) -> dict[str, Any]:
    match = _NEXT_DATA.search(html)
    if match is None:
        raise FetchError(f"{url}: no __NEXT_DATA__ block -- fotmob's page layout may have changed")
    try:
        return json.loads(match.group(1))["props"]["pageProps"]
    except (json.JSONDecodeError, KeyError) as exc:
        raise FetchError(f"{url}: unexpected __NEXT_DATA__ shape ({exc})") from exc


def _assert_season(props: dict[str, Any], season: int, url: str) -> None:
    """fotmob silently falls back to the current season for bad season params."""
    served = props.get("details", {}).get("selectedSeason")
    if served is not None and str(served) != str(season):
        raise FetchError(f"{url}: asked for season {season} but fotmob served {served!r}")


def fetch_matches_payload(lg: League, season: int) -> list[dict[str, Any]]:
    url = _url(lg, "matches", season)
    props = _page_props(_download(url), url)
    _assert_season(props, season, url)
    matches = props.get("fixtures", {}).get("allMatches")
    if not matches:
        raise FetchError(f"{url}: no matches in payload")
    return matches


def fetch_standings_payload(lg: League, season: int) -> list[dict[str, Any]]:
    url = _url(lg, "table", season)
    props = _page_props(_download(url), url)
    _assert_season(props, season, url)
    tables = props.get("table") or []
    if not tables:
        raise FetchError(f"{url}: no table in payload")
    # A league can expose several tables (overall / home / away / by stage);
    # "all" is the overall standings we want.
    rows = tables[0].get("data", {}).get("table", {}).get("all")
    if not rows:
        raise FetchError(f"{url}: table payload has no overall standings")
    return rows


def _validate_matches(payload: Any, lg: League) -> None:
    expected = lg.team_count * (lg.team_count - 1)
    if not isinstance(payload, list):
        raise FetchError("match payload is not a list")
    # Abandoned fixtures are listed alongside their replay, so count only the
    # ones that are actually part of the schedule.
    live = [m for m in payload if not (m.get("status") or {}).get("cancelled")]
    if len(live) != expected:
        raise FetchError(
            f"expected {expected} matches for {lg.name}, got {len(live)}"
            + (f" ({len(payload) - len(live)} cancelled)" if len(payload) != len(live) else "")
        )


def _validate_standings(payload: Any, lg: League) -> None:
    if not isinstance(payload, list):
        raise FetchError("standings payload is not a list")
    if len(payload) != lg.team_count:
        raise FetchError(f"expected {lg.team_count} rows for {lg.name}, got {len(payload)}")


def fetch_matches(
    slug: str, season: int, *, force: bool = False, cache_dir: Path = RAW_DIR,
    max_age: timedelta = DEFAULT_MAX_AGE,
) -> tuple[list[dict[str, Any]], bool]:
    lg = league(slug)
    cache = Cache(cache_dir, max_age)
    return cache.get_or_fetch(
        cache_key(lg, season, "matches"),
        lambda: fetch_matches_payload(lg, season),
        force=force,
        validate=lambda payload: _validate_matches(payload, lg),
    )


def fetch_standings(
    slug: str, season: int, *, force: bool = False, cache_dir: Path = RAW_DIR,
    max_age: timedelta = DEFAULT_MAX_AGE,
) -> tuple[list[dict[str, Any]], bool]:
    lg = league(slug)
    cache = Cache(cache_dir, max_age)
    return cache.get_or_fetch(
        cache_key(lg, season, "standings"),
        lambda: fetch_standings_payload(lg, season),
        force=force,
        validate=lambda payload: _validate_standings(payload, lg),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("kind", choices=["matches", "standings"])
    parser.add_argument("league", choices=sorted(LEAGUES))
    parser.add_argument("season", type=int)
    parser.add_argument("--force", action="store_true", help="ignore a fresh cache entry")
    parser.add_argument("--cache-dir", type=Path, default=RAW_DIR)
    args = parser.parse_args(argv)

    fetch = fetch_matches if args.kind == "matches" else fetch_standings
    payload, from_cache = fetch(args.league, args.season, force=args.force, cache_dir=args.cache_dir)

    source = "cache" if from_cache else "fotmob"
    path = Cache(args.cache_dir).path_for(cache_key(league(args.league), args.season, args.kind))
    print(f"{args.league} {args.season} {args.kind}: {len(payload)} rows from {source} -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
