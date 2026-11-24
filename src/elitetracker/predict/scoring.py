"""Scoring (docs/predict-plan.md, section 5).

Per match: the Brier score (0 to 2, lower is better). The leaderboard ranks by
*points*: 10 x (1 - Brier) a match, summed over the matches you tipped. A
skipped match scores 0, a cautious pick (no outcome above about 60 %) can never
go below 0, and only a confident pick that misses loses points, so tipping a
match is always worth it and a bold miss still costs. *Accuracy* is the
average Brier shown as a percent, 100 x (1 - Brier / 2), apart from the score.
Points are a straight-line function of Brier, so the honest forecast is still
the best one.

The job also keeps each match's median Brier (the model's locked odds are one
more voter in it) and the RPS: the score against the median and the RPS stay in
the stats and on the boards for the badges and the record, not for the ranking.

Picks are stored as whole percents (h, d, a); scores use those, never the
slider position, so a later refit of the curve cannot rescore anything.
"""

from __future__ import annotations

from statistics import median
from typing import Iterable, Mapping

from elitetracker.model.scores import brier, rps

# A match's three outcomes as the game stores them.
HOME, DRAW, AWAY = "home_win", "draw", "away_win"
MIN_CROWD = 5  # a published aggregate needs at least this many players


def match_points(brier_score: float) -> float:
    """One match's points: 10 x (1 - Brier), a mark out of 10. 10 for a certain call that comes
    off, 0 at Brier 1, at worst -8.8 for a 96 % call that misses (picks are clipped to 2..96)."""
    return 10.0 * (1.0 - brier_score)


def total_points(n: int, brier_sum: float) -> float:
    """Points over ``n`` tipped matches whose Brier scores add up to ``brier_sum``."""
    return 10.0 * (n - brier_sum)


def accuracy(n: int, brier_sum: float) -> float | None:
    """The average Brier as a percent: 100 x (1 - mean Brier / 2); None with no matches."""
    return 100.0 * (1.0 - brier_sum / n / 2.0) if n else None


def outcome(home_goals: int, away_goals: int) -> str:
    return HOME if home_goals > away_goals else AWAY if home_goals < away_goals else DRAW


def _score(h: float, d: float, a: float, result: str) -> tuple[float, float]:
    return brier(h, d, a, result), rps(h, d, a, result)


def crowd_odds(picks: Iterable[tuple[int, int, int]]) -> tuple[float, float, float] | None:
    """The mean forecast of the field as fractions, or None below MIN_CROWD."""
    rows = list(picks)
    if len(rows) < MIN_CROWD:
        return None
    n = len(rows)
    return tuple(sum(r[i] for r in rows) / (100.0 * n) for i in range(3))  # type: ignore[return-value]


def score_match(picks: Mapping[str, tuple[int, int, int]], model: tuple[float, float, float],
                result: str) -> dict:
    """Score one settled match.

    ``picks``: uid -> (h, d, a) whole percents. ``model``: the model's locked
    (home, draw, away) as fractions. Returns ``{"players": {uid: {...}},
    "model": {...}, "crowd": {...} | None, "median_brier", "median_rps"}``;
    every entry has ``brier``, ``rps``, ``acc_brier``, ``acc_rps`` and
    ``vs_model`` (the model's Brier minus yours; positive beats the model)."""
    own = {uid: _score(h / 100.0, d / 100.0, a / 100.0, result) for uid, (h, d, a) in picks.items()}
    model_score = _score(*model, result)
    med_b = median([s[0] for s in own.values()] + [model_score[0]])
    med_r = median([s[1] for s in own.values()] + [model_score[1]])

    def row(s: tuple[float, float]) -> dict:
        return {"brier": s[0], "rps": s[1], "acc_brier": med_b - s[0], "acc_rps": med_r - s[1],
                "vs_model": model_score[0] - s[0]}

    crowd = crowd_odds(picks.values())
    return {"players": {uid: row(s) for uid, s in own.items()},
            "model": row(model_score),
            "crowd": row(_score(*crowd, result)) if crowd else None,
            "median_brier": med_b, "median_rps": med_r}


def _blank() -> dict:
    return {"n": 0, "b": 0.0, "r": 0.0, "ab": 0.0, "ar": 0.0, "vm": 0.0}


def _add(total: dict, row: dict) -> None:
    total["n"] += 1
    total["b"] += row["brier"]
    total["r"] += row["rps"]
    total["ab"] += row["acc_brier"]
    total["ar"] += row["acc_rps"]
    total["vm"] += row["vs_model"]


def score_round(entries: Mapping[str, Mapping[str, tuple[int, int, int]]],
                matches: Iterable[dict]) -> dict:
    """Score every settled match of a round and add each player up.

    ``entries``: uid -> {slot -> (h, d, a)}. ``matches``: dicts with ``slot``,
    ``result`` (home_win / draw / away_win) and ``model`` (locked fractions).
    Returns ``{"players": {uid: totals}, "model": totals, "crowd": totals,
    "matches": number settled, "per_match": {slot: n, median_brier, median_rps}}``
    where totals are ``n`` (matches scored), the
    summed Brier ``b`` and RPS ``r``, the summed accuracies ``ab`` / ``ar`` and
    ``vm`` (versus the model). Skipped matches add nothing."""
    players: dict[str, dict] = {}
    model, crowd = _blank(), _blank()
    settled = 0
    per_match: dict[str, dict] = {}
    for match in matches:
        settled += 1
        picks = {uid: slots[match["slot"]] for uid, slots in entries.items() if match["slot"] in slots}
        scored = score_match(picks, match["model"], match["result"])
        per_match[match["slot"]] = {"n": len(picks), "median_brier": scored["median_brier"],
                                    "median_rps": scored["median_rps"]}
        for uid, row in scored["players"].items():
            _add(players.setdefault(uid, _blank()), row)
        _add(model, scored["model"])
        if scored["crowd"]:
            _add(crowd, scored["crowd"])
    return {"players": players, "model": model, "crowd": crowd, "matches": settled, "per_match": per_match}
