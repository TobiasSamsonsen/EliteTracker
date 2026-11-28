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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

RAW_DIR = Path("data/raw")
XG_PATH = Path("data/xg.json")
REFEREES_PATH = Path("data/referees.json")
RED_CARDS_PATH = Path("data/red_cards.json")

# fotmob serves the SPA shell to unknown clients; a browser UA gets the real page.
_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

_NEXT_DATA = re.compile(
    r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.DOTALL
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


# The play-offs after the season (fotmob's "Eliteserien Qualification"):
# OBOS-ligaen's ladder and its winner's tie with Eliteserien's 14th. Not in
# LEAGUES: it has no round robin, and `refresh` asks for it only while it is on.
QUALIFICATION = League("qualification", "Eliteserien qualification", 60, "eliteserien-qualification", 0)


def fetch_qualification(season: int) -> list[dict[str, Any]]:
    """The season's play-off matches as fotmob lists them (none yet: empty)."""
    url = _url(QUALIFICATION, "matches", season)
    props = _page_props(_download(url), url)
    _assert_season(props, season, url)
    matches = props.get("fixtures", {}).get("allMatches") or []
    if not isinstance(matches, list):
        raise FetchError(f"{url}: play-off matches are not a list")
    return matches


# OBOS-ligaen's 14th plays a two-legged tie against the tier below (fotmob's
# "OBOS-ligaen Qualification"): a semi-final and a final between third-tier clubs,
# and the final against the 14th. It lists the fixtures only on the fixtures tab,
# by date, and asks for it only while the tie is on (`refresh_survival`).
SURVIVAL = League("survival", "OBOS-ligaen qualification", 9754, "obos-ligaen-qualification", 0)


def fetch_survival(season: int) -> list[dict[str, Any]]:
    """The season's survival-tie matches as fotmob lists them (none yet: empty)."""
    url = f"{_url(SURVIVAL, 'fixtures', season)}&group=by-date"
    props = _page_props(_download(url), url)
    _assert_season(props, season, url)
    matches = props.get("fixtures", {}).get("allMatches") or []
    if not isinstance(matches, list):
        raise FetchError(f"{url}: survival-tie matches are not a list")
    return matches


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
    the match, 90 when there was none. The model reads npxG to weight penalty
    xG (`elo.model_xg`, elo-v19.0); the red cards it reads are
    `parse_match_reds`'s, with their side.
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


def parse_match_reds(data: dict[str, Any]) -> list[list[int]] | None:
    """Every red card (a second yellow too) in one match-details payload as
    `[minute, side]`, side 0 the home side's, in match order: [] without one,
    None when the payload has no match events to tell (the model's man
    advantage in the goals model, `attack_defence.man_advantage`, elo-v19.0)."""
    content = data.get("content") or {}
    events = ((content.get("matchFacts") or {}).get("events") or {}).get("events")
    if not events:
        return None
    home_team = str((data.get("general") or {}).get("homeTeam", {}).get("id"))
    reds = []
    for event in events:
        if not isinstance(event, dict) or event.get("type") != "Card" or event.get("card") not in ("Red", "YellowRed"):
            continue
        if not isinstance(event.get("time"), (int, float)):
            continue
        home = bool(event["isHome"]) if event.get("isHome") is not None else str(event.get("teamId")) == home_team
        reds.append([int(event["time"]), 0 if home else 1])
    return reds


def load_red_cards(path: Path = RED_CARDS_PATH) -> dict[str, list[list[int]]]:
    """match_id -> its red cards `[minute, side]` (side 0 home), for the
    matches with one; a match not listed had none or is not known."""
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def save_red_cards(data: dict[str, list[list[int]]], path: Path = RED_CARDS_PATH) -> None:
    temp = path.with_suffix(".json.tmp")
    temp.write_text(json.dumps(data, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temp, path)


def fetch_match_payload(match_id: str) -> dict[str, Any]:
    """Fetch the raw JSON payload for one match from FotMob's matchDetails endpoint."""
    url = f"https://www.fotmob.com/api/data/matchDetails?matchId={match_id}"
    try:
        return json.loads(_download(url))
    except json.JSONDecodeError as exc:
        raise FetchError(f"{url}: not JSON ({exc})") from exc


def fetch_match_xg(match_id: str) -> tuple[float, ...] | None:
    """The match-details endpoint, parsed by `parse_match_details`: one
    request per match, as `refresh` has always made.

    fotmob carries per-shot xG and xG-on-target for Eliteserien from 2020;
    OBOS-ligaen and earlier seasons have no shotmap and return None.
    """
    return parse_match_details(fetch_match_payload(match_id))


def _stat_pair(value: Any) -> list[int] | None:
    """Parse a [home, away] stat pair into ints, or None when unusable."""
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        return None
    out = []
    for item in value[:2]:
        if isinstance(item, bool):
            return None
        try:
            out.append(int(item))
        except (TypeError, ValueError):
            return None
    return out


def parse_match_referee(data: dict[str, Any]) -> dict[str, Any] | None:
    """Extract referee, card counts and fouls from one matchDetails payload.

    Returns ``{"referee": name, "yellow": [h, a], "red": [h, a], "fouls": [h, a] | None}``
    or ``None`` when no referee is named. Cards prefer the match stats table
    where present and fall back to card events (for OBOS-ligaen and older
    Eliteserien seasons where ``stats`` is empty).
    """
    content = data.get("content") or {}
    facts = content.get("matchFacts") or {}
    info = facts.get("infoBox") or {}
    raw_ref = info.get("Referee")
    name = raw_ref.get("text") if isinstance(raw_ref, dict) else raw_ref
    name = str(name).strip() if name is not None else ""
    if not name:
        return None

    stats_groups = (((content.get("stats") or {}).get("Periods") or {}).get("All") or {}).get("stats") or []
    found_stats: dict[str, list[int]] = {}
    for group in stats_groups:
        if not isinstance(group, dict):
            continue
        for item in group.get("stats") or []:
            if not isinstance(item, dict):
                continue
            key = item.get("key")
            if key in ("fouls", "yellow_cards", "red_cards") and key not in found_stats:
                pair = _stat_pair(item.get("stats"))
                if pair is not None:
                    found_stats[key] = pair

    home_team = str((data.get("general") or {}).get("homeTeam", {}).get("id"))
    events = ((facts.get("events") or {}).get("events")) or []
    ev_yellow = [0, 0]
    ev_red = [0, 0]
    for event in events:
        if not isinstance(event, dict) or event.get("type") != "Card":
            continue
        is_home = bool(event["isHome"]) if event.get("isHome") is not None else str(event.get("teamId")) == home_team
        side = 0 if is_home else 1
        card = event.get("card")
        if card == "Yellow":
            ev_yellow[side] += 1
        elif card in ("Red", "YellowRed"):
            ev_red[side] += 1

    return {
        "referee": name,
        "yellow": found_stats.get("yellow_cards", ev_yellow),
        "red": found_stats.get("red_cards", ev_red),
        "fouls": found_stats.get("fouls"),
    }


def fetch_match_referee(match_id: str) -> dict[str, Any] | None:
    """Fetch and parse referee, card counts and fouls for one match."""
    return parse_match_referee(fetch_match_payload(match_id))


def load_referees(path: Path = REFEREES_PATH) -> dict[str, Any]:
    """Load ``{"matches": {match_id: {...}}, "none": [...]}`` from disk."""
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"matches": {}, "none": []}


def save_referees(data: dict[str, Any], path: Path = REFEREES_PATH) -> None:
    """Atomically write ``data/referees.json``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".json.tmp")
    temp.write_text(json.dumps(data, indent=0, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temp, path)


def load_xg(path: Path = XG_PATH) -> dict[str, Any]:
    """{"matches": {match_id: values}, "none": [ids without shot data],
    "pending": {match_id: when fetched}} -- `pending` holds the matches
    still to be asked for again (`update_xg`'s re-fetches, and Sofascore's
    settle window in `update_obos_xg`).

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


# When FotMob's xG is asked for again. FotMob refines a match's xG after the
# first post-match pull (Bodø/Glimt-Vålerenga 2026-10-24: 2.22-1.36 at the
# whistle, 2.8-1.35 a day later). The first rule re-fetched every match of the
# last two days on every run (the hourly job: up to ~48 requests a match), the
# next only once, 48 hours on, so a revision showed two days late. Now a match
# is fetched when first seen, again 3 hours after the final whistle and a last
# time 24 hours after it, then never again.
MATCH_HOURS = 2.0  # kickoff to final whistle: 90 minutes, the break and stoppage time
REFETCH_HOURS = (3.0, 24.0)  # after the final whistle


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


def _stamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def update_xg(
    matches: list,
    *,
    path: Path = XG_PATH,
    fetch=None,
    delay: float = 1.0,
    refetch_hours: tuple[float, ...] = REFETCH_HOURS,
    now: datetime | None = None,
    referee_path: Path | None = None,
) -> int:
    """Add or refresh shot data for played matches; returns how many were fetched.

    A match is asked for when it was never fetched, and again at each of
    `refetch_hours` after its final whistle that its last fetch (recorded
    under xg.json's `pending`) came before: one request when it is first
    seen, then one per re-fetch time; a run that missed several asks once.
    With none left the entry leaves `pending` and is final. A recorded match
    with no `pending` entry is final too, except one whose last re-fetch time
    is still ahead, which is marked pending without a request (fetched before
    this rule existed).

    When `fetch` is None (the live refresh path), the single `matchDetails`
    response also populates `referees.json` and `red_cards.json` at zero
    extra HTTP requests.

    Never raises: the model falls back to goals for a match without xG, so a
    failed fetch is printed and skipped rather than allowed to block a refresh.
    """
    now = now or datetime.now(timezone.utc)
    data = load_xg(path)
    pending = data.setdefault("pending", {})
    ref_target = referee_path or (path.parent / REFEREES_PATH.name)
    ref_data = load_referees(ref_target) if fetch is None else None
    ref_changed = False
    red_target = path.parent / RED_CARDS_PATH.name
    red_data = load_red_cards(red_target) if fetch is None else None
    red_changed = False
    added = 0
    marked = False
    for match in matches:
        if not match.played:
            continue
        is_known = match.match_id in data["matches"] or match.match_id in data["none"]
        kickoff = _kickoff(match)
        refetches = [kickoff + timedelta(hours=MATCH_HOURS + hours) for hours in refetch_hours] if kickoff else []
        if is_known:
            if match.match_id not in pending:
                if refetches and now < refetches[-1]:
                    pending[match.match_id] = _stamp(now)
                    marked = True
                continue
            last = datetime.fromisoformat(pending[match.match_id].replace("Z", "+00:00"))
            due = next((moment for moment in refetches if moment > last), None)
            if due is None:
                del pending[match.match_id]
                marked = True
                continue
            if now < due:
                continue
        try:
            if fetch is None:
                raw = fetch_match_payload(match.match_id)
                shots = parse_match_details(raw)
                ref_entry = parse_match_referee(raw)
                reds = parse_match_reds(raw)
            else:
                shots = fetch(match.match_id)
                ref_entry = reds = None
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
        if ref_data is not None:
            if ref_entry is not None:
                ref_data["matches"][match.match_id] = ref_entry
                if match.match_id in ref_data["none"]:
                    ref_data["none"].remove(match.match_id)
                ref_changed = True
            elif match.match_id not in ref_data["matches"] and match.match_id not in ref_data["none"]:
                ref_data["none"].append(match.match_id)
                ref_changed = True
        if red_data is not None and reds is not None and red_data.get(match.match_id, []) != reds:
            if reds:
                red_data[match.match_id] = reds
            else:
                del red_data[match.match_id]
            red_changed = True
        if any(moment > now for moment in refetches):
            pending[match.match_id] = _stamp(now)
        else:
            pending.pop(match.match_id, None)
        added += 1
        time.sleep(delay)
    if added or marked:
        save_xg(data, path)
    if ref_data is not None and ref_changed:
        save_referees(ref_data, ref_target)
    if red_data is not None and red_changed:
        save_red_cards(red_data, red_target)
    return added
