"""Bookmaker closing odds as a benchmark for the model.

football-data.co.uk publishes Eliteserien results with closing odds (Pinnacle
where available), free and without a key. The closing line is the best public
forecast there is, so the gap to it says how much room a model has left.
Nothing shipped depends on odds; this is measurement only.
"""

from __future__ import annotations

import csv
import json
import math
import re
import unicodedata
import urllib.request
from datetime import date, timedelta
from pathlib import Path

from elitetracker.model.backtest import Scorecard
from elitetracker.model.probabilities import MatchProbabilities, outcome_of
from elitetracker.normalize.matches import Match

CSV_URL = "https://www.football-data.co.uk/new/NOR.csv"
CSV_PATH = Path("data/raw/football-data_NOR.csv")
ODDS_PATH = Path("data/odds_closing.json")

# Our registered names that neither equal nor contain the bookmaker's spelling.
_ALIASES = {"hamarkameratene": "hamkam"}


def fold(name: str) -> str:
    """ASCII, lowercase, letters and digits only: 'Bodø/Glimt' -> 'bodoglimt'."""
    text = name.replace("ø", "o").replace("Ø", "O").replace("æ", "ae").replace("Æ", "AE").replace("å", "a").replace("Å", "A")
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    folded = re.sub(r"[^a-z0-9]", "", text.lower())
    return _ALIASES.get(folded, folded)


def same_club(ours: str, theirs: str) -> bool:
    a, b = fold(ours), fold(theirs)
    return a == b or a in b or b in a


def download_csv(path: Path = CSV_PATH) -> Path:
    request = urllib.request.Request(CSV_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        body = response.read()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return path


def _prices(row: dict[str, str]) -> tuple[float, float, float] | None:
    """Closing prices, best book first, normalised so the three sum to one."""
    for prefix in ("PSC", "AvgC", "B365C"):
        try:
            inverse = [1.0 / float(row[prefix + side]) for side in "HDA"]
        except (KeyError, ValueError, ZeroDivisionError):
            continue
        total = sum(inverse)
        return tuple(value / total for value in inverse)  # type: ignore[return-value]
    return None


def build_odds(matches: list[Match], csv_path: Path = CSV_PATH, out: Path = ODDS_PATH) -> tuple[int, list[str]]:
    """Join our played matches to the CSV rows; returns (joined, unmatched match ids)."""
    with csv_path.open(encoding="utf-8-sig") as handle:
        rows = list(csv.DictReader(handle))
    by_pair: dict[tuple[str, str], list[tuple[date, tuple[float, float, float]]]] = {}
    names: set[str] = set()
    for row in rows:
        prices = _prices(row)
        if prices is None:
            continue
        day, month, year = row["Date"].split("/")
        when = date(int(year), int(month), int(day))
        by_pair.setdefault((fold(row["Home"]), fold(row["Away"])), []).append((when, prices))
        names.update((row["Home"], row["Away"]))

    resolved: dict[str, str] = {}

    def theirs(ours: str) -> str | None:
        if ours not in resolved:
            hits = {fold(name) for name in names if same_club(ours, name)}
            resolved[ours] = hits.pop() if len(hits) == 1 else None
        return resolved[ours]

    odds: dict[str, list[float]] = {}
    unmatched: list[str] = []
    for match in matches:
        if not match.played:
            continue
        home, away = theirs(match.home), theirs(match.away)
        when = date.fromisoformat(match.date)
        candidates = by_pair.get((home, away), []) if home and away else []
        hit = next((p for d, p in candidates if abs((d - when).days) <= 1), None)
        if hit is None:
            unmatched.append(match.match_id)
        else:
            odds[match.match_id] = [round(value, 5) for value in hit]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(odds, indent=0) + "\n", encoding="utf-8")
    return len(odds), unmatched


def load_odds(path: Path = ODDS_PATH) -> dict[str, tuple[float, float, float]]:
    with path.open(encoding="utf-8") as handle:
        return {key: tuple(value) for key, value in json.load(handle).items()}


def benchmark_card(
    odds: dict[str, tuple[float, float, float]], matches: list[Match], name: str = "pinnacle-close"
) -> Scorecard:
    """Score the closing line on every played match it covers."""
    card = Scorecard(name=name)
    for match in matches:
        if match.played and match.match_id in odds:
            card.observe(MatchProbabilities(*odds[match.match_id]), outcome_of(match), match.match_id)
    return card
