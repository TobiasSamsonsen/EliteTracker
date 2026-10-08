"""Expected goals for OBOS-ligaen, from Sofascore.

fotmob carries no shotmap for the second division, so `fetch_match_xg` returns
None for every OBOS match and both xG-driven parts of the model (the
attack/defence observation and the xG-informed Elo update) fall back to raw
goals there. Sofascore has xG for OBOS from 2023 onward -- earlier seasons
report `hasXg: false` for every fixture.

Two endpoints are used:

    /unique-tournament/22/season/<id>/events/last/<page>   30 fixtures a page
    /event/<id>/statistics                                 xG for one fixture

Sofascore knows nothing about fotmob's match ids, so an event is joined to our
normalized fixture by the pair of club names (each ordered pair meets exactly
once a season) and the result is checked against the stored score.

Written into the same `data/xg.json` as the fotmob pull, as a two-value entry:
Sofascore publishes no xG on target, and a fake zero there would be read as a
real one by anything that later prefers that signal.
"""

from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from typing import Any, Iterable

from curl_cffi import requests
from elitetracker.sources.fotmob import FetchError, load_xg, save_xg

TOURNAMENT_ID = 22  # Sofascore's unique tournament id for OBOS-ligaen

# Sofascore's per-season ids. xG exists from 2023; 2020-2022 are listed so a
# re-check is one line rather than a hunt through the site.
SEASON_IDS: dict[int, int] = {
    2020: 26800, 2021: 35404, 2022: 40407, 2023: 47820,
    2024: 57356, 2025: 70186, 2026: 87867,
}
FIRST_XG_SEASON = 2023

# Club names differ between the two feeds ("Odds BK" / "Odds Ballklubb",
# "IK Start" / "Start"); dropping the club-type words leaves the same stem.
_NOISE = {"fk", "if", "il", "ik", "bk", "sk", "fotball", "ballklubb", "oslo", "fotballklubb"}

# These headers plus a safari17_0 fingerprint used to be the passing pair. They
# no longer are, and cannot be: from a GitHub Actions runner (Azure, 2026-10-08)
# every variant returns 403 -- safari17_0, chrome, chrome131/136, firefox133/135,
# no impersonation at all, plain urllib -- on every path including the site
# homepage and robots.txt. The reason in the body is "Forbidden" (Varnish), not
# the "challenge" a fingerprint mismatch gets, so the refusal happens at the
# edge before headers are read. Verified blocked from two runner IPs.
#
# The profile is kept because it still works from an unblocked network. It is
# not the fix for CI; see SofascoreBlocked.
_SOFASCORE_HEADERS = {
    "Referer": "https://www.sofascore.com/",
    "Origin": "https://www.sofascore",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
}

_TIMEOUT_SECONDS = 30

# One second between requests. Sofascore flags an IP that asks for too much:
# a 12-request burst at 0.2s intervals was enough to get a working residential
# IP refused. An OBOS season is ~4 event pages plus one statistics call per
# uncached match, so a full backfill costs a couple of minutes -- cheap enough.
DEFAULT_DELAY = 1.0

# How long after kickoff a fetch has to happen before its xG counts as settled.
# Sofascore keeps revising xG in the hours after a fixture, so a number pulled
# straight after kickoff is a snapshot of an incomplete feed. Six hours is past
# the point where their numbers stop moving; a fetch after that is kept forever.
SETTLE_HOURS = 6.0

# 429 and 5xx are worth another try; a 403 never is, so it is not in here.
_RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
_MAX_ATTEMPTS = 4


class SofascoreBlocked(FetchError):
    """Sofascore refused this IP outright, so retrying cannot help.

    Distinct from a plain FetchError so callers can tell "this will never work
    from here" apart from "the network hiccupped" and stop hammering.
    """


def _download_sofascore(url: str) -> str:
    """One GET, retried only for statuses that can plausibly succeed later.

    A 403 raises SofascoreBlocked on the first try rather than being retried:
    the edge has already refused this IP, so every further attempt adds traffic
    for nothing.
    """
    for attempt in range(_MAX_ATTEMPTS):
        try:
            response = requests.get(
                url,
                headers=_SOFASCORE_HEADERS,
                timeout=_TIMEOUT_SECONDS,
                impersonate="safari17_0",
            )
        except requests.RequestsError as exc:
            raise FetchError(f"{url} unreachable: {exc}") from exc
        if response.status_code == 403:
            raise SofascoreBlocked(
                f"{url} returned HTTP 403: Sofascore has refused this network. "
                "Not a request-shape problem -- the whole domain (homepage "
                "included) answers 403 from here. Run this off-CI."
            )
        if response.status_code in _RETRY_STATUSES and attempt < _MAX_ATTEMPTS - 1:
            # Honour Retry-After when it is there; that is what keeps a rate
            # limit from escalating into a block.
            wait = float(response.headers.get("retry-after") or 0) or 2 ** (attempt + 1)
            print(f"  HTTP {response.status_code}, waiting {wait:.0f}s", flush=True)
            time.sleep(min(wait, 60))
            continue
        response.raise_for_status()
        return response.text
    raise FetchError(f"{url} still failing after {_MAX_ATTEMPTS} attempts")


def _key(name: str) -> str:
    words = [w for w in re.findall(r"\w+", name.lower()) if w not in _NOISE]
    return "".join(words).rstrip("s")  # "Aalesunds" and "Aalesund" are one club


def _get(url: str) -> dict[str, Any]:
    try:
        return json.loads(_download_sofascore(url))
    except json.JSONDecodeError as exc:
        raise FetchError(f"{url}: not JSON ({exc})") from exc


def season_events(season: int, *, delay: float = DEFAULT_DELAY) -> list[dict[str, Any]]:
    """Every fixture of an OBOS season as {id, home, away, goals, has_xg}."""
    try:
        season_id = SEASON_IDS[season]
    except KeyError:
        raise FetchError(f"no Sofascore season id for OBOS {season}") from None
    events: list[dict[str, Any]] = []
    page = 0
    while True:
        payload = _get(
            f"https://www.sofascore.com/api/v1/unique-tournament/{TOURNAMENT_ID}"
            f"/season/{season_id}/events/last/{page}"
        )
        for event in payload.get("events", []):
            if event.get("status", {}).get("type") != "finished":
                continue
            events.append({
                "id": event["id"],
                "home": event["homeTeam"]["name"],
                "away": event["awayTeam"]["name"],
                "home_goals": event["homeScore"]["current"],
                "away_goals": event["awayScore"]["current"],
                "has_xg": bool(event.get("hasXg")),
            })
        if not payload.get("hasNextPage"):
            return events
        page += 1
        time.sleep(delay)


def event_xg(event_id: int) -> tuple[float, float] | None:
    """(home_xg, away_xg) for one fixture, or None where Sofascore has none."""
    try:
        payload = _get(f"https://www.sofascore.com/api/v1/event/{event_id}/statistics")
    except FetchError as exc:
        if "HTTP 404" in str(exc):
            return None
        raise
    for period in payload.get("statistics", []):
        if period.get("period") != "ALL":
            continue
        for group in period.get("groups", []):
            for item in group.get("statisticsItems", []):
                if item.get("key") == "expectedGoals":
                    return float(item["homeValue"]), float(item["awayValue"])
    return None


def _kickoff(match) -> datetime | None:
    if not match.kickoff_utc:
        return None
    try:
        return datetime.fromisoformat(match.kickoff_utc.replace("Z", "+00:00"))
    except ValueError:
        return None


def pending_obos_xg(matches: Iterable, *, settle_hours: float = SETTLE_HOURS,
                    now: datetime | None = None) -> list:
    """Played matches worth asking Sofascore about.

    Two cases, and only two:

    * never fetched -- the id is in neither `matches` nor `none` of xg.json. An
      id under `none` is a fixture Sofascore publishes no xG for, so asking
      again changes nothing;
    * fetched too early -- recorded under `pending`, meaning that fetch landed
      less than `settle_hours` after kickoff, so Sofascore may well have
      revised it since. Re-fetch once the window has passed, then stop.

    Anything else is settled and never touched again. An entry with no
    `pending` record counts as settled, so the first run after this shipped
    does not re-fetch the whole archive.

    Reads local files only: a caller can see whether there is work to do
    without spending a request.
    """
    now = now or datetime.now(timezone.utc)
    data = load_xg()
    known = set(data["matches"]) | set(data["none"])
    pending = data.get("pending") or {}
    out = []
    for m in matches:
        if not m.played:
            continue
        if m.match_id not in known:
            out.append(m)
        elif m.match_id in pending:
            kickoff = _kickoff(m)
            # No known kickoff means we cannot say the window has passed, so
            # leave it alone rather than refetching forever.
            if kickoff and (now - kickoff).total_seconds() >= settle_hours * 3600:
                out.append(m)
    return out


def update_obos_xg(
    matches: Iterable,
    season: int,
    *,
    delay: float = DEFAULT_DELAY,
    settle_hours: float = SETTLE_HOURS,
    only: Iterable | None = None,
    verbose: bool = False,
) -> int:
    """Store Sofascore xG for one OBOS season's played matches; returns how many
    were fetched.

    `only` restricts the pull to a set of matches (see `pending_obos_xg`); by
    default a season with nothing outstanding still walks the event list, which
    is what the recurring refresh wants.

    Each fetch is recorded under xg.json's `pending` map when it happened less
    than `settle_hours` after kickoff, which is the only case where Sofascore's
    later revision can still reach us. Past that the entry is dropped and the
    match is never asked about again.

    Never raises on a single fixture: the model falls back to goals for a match
    without xG, so a failure is reported and skipped.
    """
    if season < FIRST_XG_SEASON:
        return 0
    played = [m for m in matches if m.played]
    by_pair = {(_key(m.home), _key(m.away)): m for m in played}
    if len(by_pair) != len(played):
        raise FetchError(f"OBOS {season}: club names collide after normalisation")

    data = load_xg()
    known = set(data["matches"]) | set(data["none"])
    pending = data.setdefault("pending", {})
    wanted = None if only is None else {m.match_id for m in only}
    now = datetime.now(timezone.utc)
    added = 0
    for event in season_events(season, delay=delay):
        match = by_pair.get((_key(event["home"]), _key(event["away"])))
        if match is None:
            print(f"  OBOS {season}: no fixture for {event['home']} v {event['away']}")
            continue
        if (match.home_goals, match.away_goals) != (event["home_goals"], event["away_goals"]):
            print(f"  OBOS {season}: score mismatch for {event['home']} v {event['away']}"
                  f" ({event['home_goals']}-{event['away_goals']} vs stored"
                  f" {match.home_goals}-{match.away_goals}), skipped")
            continue
        if wanted is not None and match.match_id not in wanted:
            continue
        if not event["has_xg"]:
            if match.match_id not in known:
                data["none"].append(match.match_id)
            continue
        try:
            xg = event_xg(event["id"])
        except SofascoreBlocked:
            # Keep what we got, but stop: the block does not lift on a retry, so
            # looping would fire a request per remaining fixture (~200 of them)
            # and finish the season printing nothing but refusals.
            if added:
                save_xg(data)
            raise
        except FetchError as exc:
            print(f"  xG for {match.match_id} skipped: {exc}")
            continue
        if xg is None:
            if match.match_id not in known:
                data["none"].append(match.match_id)
        else:
            data["matches"][match.match_id] = list(xg)
            if match.match_id in data["none"]:
                data["none"].remove(match.match_id)
            # Only a fetch inside the settle window can still be revised, so
            # only that one is worth remembering. Everything else is final.
            kickoff = _kickoff(match)
            if kickoff and (now - kickoff).total_seconds() < settle_hours * 3600:
                pending[match.match_id] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
            else:
                pending.pop(match.match_id, None)
        added += 1
        if verbose and added % 25 == 0:
            save_xg(data)
            print(f"  {added} fetched ({match.date})", flush=True)
        time.sleep(delay)
    if added:
        save_xg(data)
    return added
