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
from datetime import date, timedelta
from typing import Any, Iterable

from elitetracker.sources.fotmob import FetchError, _download, load_xg, save_xg

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


def _key(name: str) -> str:
    words = [w for w in re.findall(r"\w+", name.lower()) if w not in _NOISE]
    return "".join(words).rstrip("s")  # "Aalesunds" and "Aalesund" are one club


def _get(url: str) -> dict[str, Any]:
    try:
        return json.loads(_download(url))
    except json.JSONDecodeError as exc:
        raise FetchError(f"{url}: not JSON ({exc})") from exc


def season_events(season: int, *, delay: float = 0.3) -> list[dict[str, Any]]:
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


def update_obos_xg(
    matches: Iterable,
    season: int,
    *,
    delay: float = 0.3,
    stale_days: int = 2,
    verbose: bool = False,
) -> int:
    """Store Sofascore xG for one OBOS season's played matches; returns how many
    were fetched.

    Matches already recorded are skipped, so the pull is resumable and cheap to
    re-run; anything played within `stale_days` is re-fetched anyway, because
    Sofascore revises xG in the days after a fixture -- the same rule the fotmob
    pull uses.

    Never raises on a single fixture: the model falls back to goals for a match
    without xG, so a failure is reported and skipped.
    """
    if season < FIRST_XG_SEASON:
        return 0
    played = [m for m in matches if m.played]
    by_pair = {(_key(m.home), _key(m.away)): m for m in played}
    if len(by_pair) != len(played):
        raise FetchError(f"OBOS {season}: club names collide after normalisation")
    stale_cutoff = (date.today() - timedelta(days=stale_days)).isoformat()

    data = load_xg()
    known = set(data["matches"]) | set(data["none"])
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
        if match.match_id in known and match.date <= stale_cutoff:
            continue
        if not event["has_xg"]:
            if match.match_id not in known:
                data["none"].append(match.match_id)
            continue
        try:
            xg = event_xg(event["id"])
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
        added += 1
        if verbose and added % 25 == 0:
            save_xg(data)
            print(f"  {added} fetched ({match.date})", flush=True)
        time.sleep(delay)
    if added:
        save_xg(data)
    return added
