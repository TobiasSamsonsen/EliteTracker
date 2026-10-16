"""Squad market values from Transfermarkt, for the goals model's offseason
pull (`ADConfig.value_pull`), kept in `data/market_values.json`.

Two pages a season (Eliteserien, OBOS-ligaen), fetched by hand once a year
with `python -m elitetracker.research market-values --season YYYY`, never by
`refresh` or CI. Politely: one request at a time, 4-8 s of jittered wait
between them, a browser fingerprint, and a stop at the first 403 or 429 --
the scraping rules of IMPROVEMENTS.md. robots.txt allows the competition
pages.

Season S is stored from the page Transfermarkt files under saison_id S - 1,
the convention the file was built with (checked 2026-10-16: the stored 2026
values are saison_id 2025's). The pull reads the season before the one it
starts, so whichever season a page describes, the value predates it.
"""

from __future__ import annotations

import json
import random
import re
import time
from html import unescape
from pathlib import Path

from elitetracker.normalize.matches import Match
from elitetracker.sources.fotmob import FetchError
from elitetracker.sources.sofascore import _NOISE

MARKET_VALUES_PATH = Path("data/market_values.json")
URL = "https://www.transfermarkt.com/{slug}/startseite/wettbewerb/{code}/saison_id/{year}"
COMPETITIONS = {"eliteserien": ("eliteserien", "NO1"), "obosligaen": ("obos-ligaen", "NO2")}
_TIMEOUT_SECONDS = 30

# Club-type words Transfermarkt adds beyond Sofascore's, and the names that
# differ outright (folded keys, theirs -> ours).
_EXTRA_NOISE = {"ff", "uil", "fc"}
_ALIASES = {"hamkam": "hamarkameratene", "kfumkameratene": "kfum", "lyn1896": "lyn", "ullensakerkisa": "ullkisa"}

_ROW = re.compile(r'<tr class="(?:odd|even)">(.*?)</tr>', re.S)
_CLUB = re.compile(r'<td class="hauptlink no-border-links"><a title="([^"]+)" href="[^"]*/verein/(\d+)/')
_MONEY = re.compile(r"€\s*([\d.,]+)\s*(bn|m|k|Th\.)?")
_UNITS = {"bn": 1e9, "m": 1e6, "k": 1e3, "Th.": 1e3, None: 1.0}


def club_key(name: str) -> str:
    """Club name folded for joining: lowercase, club-type words dropped, a
    trailing "s" dropped ("Aalesunds" and "Aalesund" are one club)."""
    words = [w for w in re.findall(r"\w+", unescape(name).lower()) if w not in _NOISE | _EXTRA_NOISE]
    key = "".join(words).rstrip("s")
    return _ALIASES.get(key, key)


def _money(text: str) -> float:
    amount, unit = text
    return float(amount.replace(",", "")) * _UNITS[unit]


def parse_values(html: str) -> list[tuple[str, float]]:
    """(club name, total squad value in EUR) per row of a competition page's
    clubs table; the total is the row's last money figure."""
    rows = []
    for row in _ROW.findall(html):
        club = _CLUB.search(row)
        money = _MONEY.findall(row)
        if club and money:
            rows.append((unescape(club.group(1)), _money(money[-1])))
    return rows


def join(rows: list[tuple[str, float]], matches: list[Match]) -> tuple[dict[str, dict], list[str]]:
    """Map Transfermarkt's clubs onto ours (by folded name, else by a unique
    containment): ({team_id: {"name", "total"}}, their names left over)."""
    ours = {}
    for match in matches:
        for team_id, name in ((match.home_id, match.home), (match.away_id, match.away)):
            ours[team_id or name] = name
    by_key = {club_key(name): team_id for team_id, name in ours.items()}
    joined, unmatched = {}, []
    for name, total in rows:
        key = club_key(name)
        team_id = by_key.get(key)
        if team_id is None:
            hits = [tid for k, tid in by_key.items() if k and (k in key or key in k)]
            team_id = hits[0] if len(hits) == 1 else None
        if team_id is None or team_id in joined:
            unmatched.append(name)
            continue
        joined[team_id] = {"name": ours[team_id], "total": total}
    return joined, unmatched


def fetch_page(league: str, season: int) -> str:
    """One competition page. A 403 or 429 stops everything: asking again
    would only make a refusal stick."""
    from curl_cffi import requests

    slug, code = COMPETITIONS[league]
    url = URL.format(slug=slug, code=code, year=season - 1)
    try:
        response = requests.get(url, headers={"Accept-Language": "en-US,en;q=0.9"},
                                impersonate="chrome", timeout=_TIMEOUT_SECONDS)
    except requests.RequestsError as exc:
        raise FetchError(f"{url} unreachable: {exc}") from exc
    if response.status_code in (403, 429):
        raise FetchError(f"{url} returned HTTP {response.status_code}: stopping, try another day")
    response.raise_for_status()
    return response.text


def load_values(path: Path = MARKET_VALUES_PATH) -> dict[str, dict]:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def save_values(data: dict[str, dict], path: Path = MARKET_VALUES_PATH) -> None:
    temp = path.with_suffix(".json.tmp")
    ordered = {season: data[season] for season in sorted(data)}
    temp.write_text(json.dumps(ordered, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    temp.replace(path)


def update_values(
    season: int,
    matches_by_league: dict[str, list[Match]],
    *,
    path: Path = MARKET_VALUES_PATH,
    fetch=fetch_page,
    write: bool = True,
    pause=lambda: time.sleep(random.uniform(4.0, 8.0)),
) -> tuple[dict[str, dict], list[str]]:
    """Fetch, join and (with `write`) store one season, saving after each
    league so an interrupted run keeps what it has. Returns the season's
    entries and the Transfermarkt names that joined to nothing."""
    data = load_values(path)
    entries: dict[str, dict] = {}
    unmatched: list[str] = []
    for index, (league, matches) in enumerate(matches_by_league.items()):
        if index:
            pause()
        joined, missed = join(parse_values(fetch(league, season)), matches)
        entries.update({team_id: {**entry, "league": league} for team_id, entry in joined.items()})
        unmatched += missed
        if write:
            data[str(season)] = {**data.get(str(season), {}), **entries}
            save_values(data, path)
    return entries, unmatched
