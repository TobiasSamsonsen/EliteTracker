"""Bookmaker closing odds as a benchmark for the model.

football-data.co.uk publishes Eliteserien results with closing odds (Pinnacle
where available), free and without a key. The closing line is the best public
forecast there is, so the gap to it says how much room a model has left.
Nothing shipped depends on odds; this is measurement only.

A bookmaker's prices carry a margin, so their inverses sum to more than one.
Three ways to take it out (`devig`): proportional (the margin spread pro rata,
the original benchmark), the power method (inverses raised to the k that makes
them sum to one) and Shin's method (the margin read as protection against
insiders, which takes more off long shots). The last two correct the
favourite-longshot bias that proportional normalisation leaves in. `kelly`
then stakes on the model's edges at the closing prices.

The CSV holds closing prices only, so closing-line value (beating the close
with an earlier price) cannot be measured from it.
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
from elitetracker.model.probabilities import AWAY_WIN, DRAW, HOME_WIN, MatchProbabilities, outcome_of
from elitetracker.normalize.matches import Match

CSV_URL = "https://www.football-data.co.uk/new/NOR.csv"
CSV_PATH = Path("data/raw/football-data_NOR.csv")
ODDS_PATH = Path("data/odds_closing.json")
# The same matches' raw closing prices (decimal, home/draw/away), for the
# power and Shin de-vig and the staking simulation.
PRICES_PATH = Path("data/odds_closing_prices.json")
DEVIG_METHODS = ("proportional", "power", "shin")

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


def _closing_prices(row: dict[str, str]) -> tuple[float, float, float] | None:
    """Closing decimal prices of the best book the row has: Pinnacle, else the
    market average, else Bet365."""
    for prefix in ("PSC", "AvgC", "B365C"):
        try:
            prices = tuple(float(row[prefix + side]) for side in "HDA")
        except (KeyError, ValueError):
            continue
        if all(price > 1.0 for price in prices):
            return prices  # type: ignore[return-value]
    return None


def _prices(row: dict[str, str]) -> tuple[float, float, float] | None:
    """Closing prices, best book first, normalised so the three sum to one."""
    prices = _closing_prices(row)
    return devig(prices) if prices else None


def _bisect(f, lo: float, hi: float, steps: int = 100) -> float:
    """The root of a function that falls from f(lo) > 0 to f(hi) < 0."""
    for _ in range(steps):
        mid = (lo + hi) / 2.0
        if f(mid) > 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def devig(prices: tuple[float, float, float], method: str = "proportional") -> tuple[float, float, float]:
    """Probabilities from decimal prices with the bookmaker's margin removed."""
    inverse = [1.0 / price for price in prices]
    total = sum(inverse)
    if method == "proportional" or total <= 1.0:
        return tuple(value / total for value in inverse)  # type: ignore[return-value]
    if method == "power":
        k = _bisect(lambda k: sum(value ** k for value in inverse) - 1.0, 1.0, 10.0)
        raw = [value ** k for value in inverse]
    elif method == "shin":
        def shin(z: float) -> list[float]:
            return [(math.sqrt(z * z + 4.0 * (1.0 - z) * value * value / total) - z) / (2.0 * (1.0 - z))
                    for value in inverse]
        raw = shin(_bisect(lambda z: sum(shin(z)) - 1.0, 0.0, 0.5))
    else:
        raise ValueError(f"unknown de-vig method {method!r}")
    norm = sum(raw)  # 1 to the bisection's tolerance; make it exact
    return tuple(value / norm for value in raw)  # type: ignore[return-value]


def build_odds(matches: list[Match], csv_path: Path = CSV_PATH, out: Path = ODDS_PATH,
               prices_out: Path | None = None) -> tuple[int, list[str]]:
    """Join our played matches to the CSV rows; returns (joined, unmatched match ids).

    Writes the proportionally de-vigged probabilities to `out` and the raw
    closing prices beside it (`<out>_prices.json` unless `prices_out` says
    otherwise; for the default `out` that is PRICES_PATH)."""
    with csv_path.open(encoding="utf-8-sig") as handle:
        rows = list(csv.DictReader(handle))
    by_pair: dict[tuple[str, str], list[tuple[date, tuple[float, float, float]]]] = {}
    names: set[str] = set()
    for row in rows:
        prices = _closing_prices(row)
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
    raw: dict[str, list[float]] = {}
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
            odds[match.match_id] = [round(value, 5) for value in devig(hit)]
            raw[match.match_id] = list(hit)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(odds, indent=0) + "\n", encoding="utf-8")
    prices_out = prices_out or out.with_name(f"{out.stem}_prices{out.suffix}")
    prices_out.write_text(json.dumps(raw, indent=0) + "\n", encoding="utf-8")
    return len(odds), unmatched


def load_odds(path: Path = ODDS_PATH) -> dict[str, tuple[float, float, float]]:
    with path.open(encoding="utf-8") as handle:
        return {key: tuple(value) for key, value in json.load(handle).items()}


def load_prices(path: Path = PRICES_PATH) -> dict[str, tuple[float, float, float]]:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        return {key: tuple(value) for key, value in json.load(handle).items()}


def market_cards(prices: dict[str, tuple[float, float, float]], matches: list[Match]) -> dict[str, Scorecard]:
    """The closing line scored once per de-vig method, on every match it prices."""
    return {
        method: benchmark_card({mid: devig(p, method) for mid, p in prices.items()}, matches,
                               name=f"close ({method})")
        for method in DEVIG_METHODS
    }


def kelly(
    card: Scorecard,
    prices: dict[str, tuple[float, float, float]],
    order: list[str],
    *,
    fraction: float = 0.25,
    cap: float = 0.025,
    min_edge: float = 0.03,
) -> dict[str, float]:
    """Stake on the model's best edge per match at the closing prices.

    A quarter of the Kelly stake (the damping that keeps an over-confident
    model from ruin), at most `cap` of the bankroll on one match, and only
    where the edge p * price - 1 is at least `min_edge`. `order` is the
    chronological match order; the bankroll compounds along it. ROI is
    profit over stakes, each stake counted as its fraction of the bankroll.
    """
    bankroll = peak = 1.0
    drawdown = staked = profit = 0.0
    bets = wins = 0
    for match_id in order:
        if match_id not in card.predictions or match_id not in prices:
            continue
        probabilities, outcome = card.predictions[match_id]
        options = [(probabilities.of(key) * price - 1.0, key, price)
                   for key, price in zip((HOME_WIN, DRAW, AWAY_WIN), prices[match_id])]
        edge, key, price = max(options)
        if edge < min_edge:
            continue
        stake = min(cap, fraction * edge / (price - 1.0))
        won = key == outcome
        bets += 1
        wins += won
        staked += stake
        gain = stake * (price - 1.0) if won else -stake
        profit += gain
        bankroll *= 1.0 + gain
        peak = max(peak, bankroll)
        drawdown = max(drawdown, 1.0 - bankroll / peak)
    return {
        "bets": bets,
        "hit_rate": wins / bets if bets else float("nan"),
        "roi": profit / staked if staked else float("nan"),
        "bankroll": bankroll,
        "max_drawdown": drawdown,
    }


def benchmark_card(
    odds: dict[str, tuple[float, float, float]], matches: list[Match], name: str = "pinnacle-close"
) -> Scorecard:
    """Score the closing line on every played match it covers."""
    card = Scorecard(name=name)
    for match in matches:
        if match.played and match.match_id in odds:
            card.observe(MatchProbabilities(*odds[match.match_id]), outcome_of(match), match.match_id)
    return card
