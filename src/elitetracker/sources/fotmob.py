"""Fetch match schedules from fotmob.

fotmob is a Next.js app: the page HTML embeds the fully-rendered page data in a
``<script id="__NEXT_DATA__">`` tag, so no browser or API key is needed. We
extract only the slice we care about and keep a copy in ``data/raw/``, which
keeps the stored artifacts small and readable.

This replaces the parse.bot scraper used for the first Eliteserien fetch; that
scraper was deleted upstream and now 404s for every tournament.

Driven by `refresh`, which fetches both divisions in one command.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

RAW_DIR = Path("data/raw")
XG_PATH = Path("data/xg.json")

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


def fetch_matches(slug: str, season: int, *, cache_dir: Path = RAW_DIR) -> list[dict[str, Any]]:
    """Download, validate and archive one league season's fixture list."""
    lg = league(slug)
    payload = fetch_matches_payload(lg, season)
    _validate_matches(payload, lg)
    path = cache_dir / f"fotmob_{lg.slug}_{season}_matches.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return payload


def parse_match_details(data: dict[str, Any]) -> tuple[float, ...] | None:
    """(home_xg, away_xg, home_xgot, away_xgot, home_npxg, away_npxg,
    red_minute) from one match-details payload, or None without shot data.

    The last three ride on the same response (IMPROVEMENTS 2.1): xG without
    penalties (a penalty is ~0.79 xG) and the minute of the first red card in
    the match, 90 when there was none. The model reads neither -- both were
    re-measured and rejected (PROJECT_STATUS.md, elo-v13.0, "Scrapers") -- they
    are kept so a later season can test them again without a backfill.
    """
    content = data.get("content") or {}
    shots = (content.get("shotmap") or {}).get("shots") or []
    if not shots:
        return None
    home_team = str((data.get("general") or {}).get("homeTeam", {}).get("id"))

    def is_home(shot: dict[str, Any]) -> bool:
        return bool(shot["isHome"]) if shot.get("isHome") is not None else str(shot.get("teamId")) == home_team

    def total(key: str, home: bool, penalties: bool = True) -> float:
        return round(sum(shot.get(key) or 0.0 for shot in shots
                         if is_home(shot) == home and (penalties or shot.get("situation") != "Penalty")), 3)

    events = ((content.get("matchFacts") or {}).get("events") or {}).get("events") or []
    reds = [event["time"] for event in events
            if event.get("type") == "Card" and event.get("card") in ("Red", "YellowRed")
            and isinstance(event.get("time"), (int, float))]
    return (
        total("expectedGoals", True), total("expectedGoals", False),
        total("expectedGoalsOnTarget", True), total("expectedGoalsOnTarget", False),
        total("expectedGoals", True, penalties=False), total("expectedGoals", False, penalties=False),
        min(reds) if reds else 90,
    )


def fetch_match_xg(match_id: str) -> tuple[float, ...] | None:
    """The match-details endpoint, parsed by `parse_match_details`: one
    request per match, as `refresh` has always made.

    fotmob carries per-shot xG and xG-on-target for Eliteserien from 2020;
    OBOS-ligaen and earlier seasons have no shotmap and return None.
    """
    url = f"https://www.fotmob.com/api/data/matchDetails?matchId={match_id}"
    try:
        data = json.loads(_download(url))
    except json.JSONDecodeError as exc:
        raise FetchError(f"{url}: not JSON ({exc})") from exc
    return parse_match_details(data)


def load_xg(path: Path = XG_PATH) -> dict[str, Any]:
    """{"matches": {match_id: values}, "none": [ids without shot data],
    "pending": {match_id: when fetched}} -- `pending` holds the fetches made
    inside the settle window, still to be asked for once more (`update_xg`,
    and Sofascore's `update_obos_xg`).

    `values` is [home_xg, away_xg] from Sofascore (OBOS-ligaen); from fotmob
    [home_xg, away_xg, home_xgot, away_xgot], and from October 2026 on also
    [..., home_npxg, away_npxg, red_minute] (`parse_match_details`). Readers
    take the first two, xGOT the next two where there are four or more."""
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"matches": {}, "none": []}


def save_xg(data: dict[str, Any], path: Path = XG_PATH) -> None:
    temp = path.with_suffix(".json.tmp")
    temp.write_text(json.dumps(data, indent=0, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temp, path)


# How long after kickoff FotMob's xG counts as settled. FotMob refines a
# match's xG after the first post-match pull; the old rule re-fetched every
# match of the last two days on every run (the hourly job: up to ~48 requests
# a match). Now a fetch inside this window is marked pending and asked for
# once more after it, then never again -- the rule Sofascore's OBOS pull
# follows (`sources.sofascore.pending_obos_xg`).
SETTLE_HOURS = 48.0


def _kickoff(match) -> datetime | None:
    """Kickoff in UTC: the feed's `kickoff_utc`, else the date and local time
    read as UTC (two hours out at most, which a 48-hour window absorbs)."""
    stamp = match.kickoff_utc or (f"{match.date}T{match.time or '00:00'}:00Z" if match.date else None)
    if not stamp:
        return None
    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None


def update_xg(
    matches: list,
    *,
    path: Path = XG_PATH,
    fetch=fetch_match_xg,
    delay: float = 1.0,
    settle_hours: float = SETTLE_HOURS,
    now: datetime | None = None,
) -> int:
    """Add or refresh shot data for played matches; returns how many were fetched.

    A match is asked for when it was never fetched, or when its last fetch
    landed inside `settle_hours` of kickoff (recorded under xg.json's
    `pending`) and the window has since passed: one request when it is first
    seen, one more once FotMob has settled its numbers. A recorded match with
    no `pending` entry is final, except one still inside its window, which is
    marked pending without a request (fetched before this rule existed).

    Never raises: the model falls back to goals for a match without xG, so a
    failed fetch is printed and skipped rather than allowed to block a refresh.
    """
    now = now or datetime.now(timezone.utc)
    data = load_xg(path)
    pending = data.setdefault("pending", {})
    added = 0
    marked = False
    for match in matches:
        if not match.played:
            continue
        is_known = match.match_id in data["matches"] or match.match_id in data["none"]
        kickoff = _kickoff(match)
        settled = kickoff is None or (now - kickoff).total_seconds() >= settle_hours * 3600
        if is_known and match.match_id not in pending:
            if not settled:
                pending[match.match_id] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
                marked = True
            continue
        if is_known and not settled:
            continue
        try:
            shots = fetch(match.match_id)
        except FetchError as exc:
            print(f"  xG for {match.match_id} skipped: {exc}")
            continue
        if shots is None:
            if not is_known:
                data["none"].append(match.match_id)
        else:
            data["matches"][match.match_id] = list(shots)
            # Remove from "none" if it was previously recorded there
            if match.match_id in data["none"]:
                data["none"].remove(match.match_id)
        if settled:
            pending.pop(match.match_id, None)
        else:
            pending[match.match_id] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        added += 1
        time.sleep(delay)
    if added or marked:
        save_xg(data, path)
    return added
