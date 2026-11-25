"""Leaderboards, built from per-player round totals (docs/predict-plan.md, section 2).

A row: rank, name, matches, points (``pts``: 10 x (1 - Brier) a match, summed;
scoring.total_points), accuracy (``acc``: the average Brier as a percent) and the
plus the record the page does not rank by (summed accuracy against the
median ``ab`` and its RPS twin ``ar``, average Brier ``b`` and RPS ``r``, ``vm``
against the model). The model and the crowd stand on the board as players ("can
you beat the model?"). Rank is by points, then accuracy: a skipped match counts 0
and a cautious tip never less, so tipping more is rewarded. A board holds the top
ROW_LIMIT visible rows and a percentile table of every player's points (hidden
ones included), so a player outside the list can still be told "you are in the
top 23 %". A player row's ``place`` counts hidden players too, so the place, the
player count and the share beaten all describe the same field (a hidden player
above you shows as a skipped number); the model and the crowd take no place.

Players are identified on a public board only by ``uid_hash``, a short hash the
browser can compute for itself, never by the account id.
"""

from __future__ import annotations

import hashlib
from typing import Iterable, Mapping, Sequence

from elitetracker.predict.scoring import accuracy, total_points

ROW_LIMIT = 200
LAST_ROUNDS = 10
MODEL_NAME, CROWD_NAME = "Modellen", "Folket"


def uid_hash(uid: str) -> str:
    return hashlib.sha256(uid.encode("utf-8")).hexdigest()[:10]


def _blank() -> dict:
    return {"n": 0, "b": 0.0, "r": 0.0, "ab": 0.0, "ar": 0.0, "vm": 0.0}


def combine(rounds: Iterable[Mapping]) -> dict:
    """Sum round totals (n, b, r, ab, ar, vm)."""
    total = _blank()
    for totals in rounds:
        for field in total:
            total[field] += totals.get(field, 0)
    return total


def percentile_table(values: Sequence[float]) -> list[float]:
    """101 cut-offs: entry p is the score that p percent of players are at or
    below (nearest rank). Empty when there are no players."""
    if not values:
        return []
    ordered = sorted(values)
    last = len(ordered) - 1
    return [round(ordered[round(p / 100 * last)], 4) for p in range(101)]


def _row(kind: str, uid: str | None, nick: str, totals: Mapping) -> dict:
    n = totals["n"]
    acc = accuracy(n, totals["b"])
    return {"u": uid_hash(uid) if uid else kind, "nick": nick, "kind": kind, "n": n,
            "pts": round(total_points(n, totals["b"]), 3), "acc": round(acc, 4) if acc is not None else None,
            "ab": round(totals["ab"], 4), "ar": round(totals["ar"], 4),
            "b": round(totals["b"] / n, 4) if n else None, "r": round(totals["r"] / n, 4) if n else None,
            "vm": round(totals["vm"], 4)}


def make_board(scope: str, players: Iterable[dict], *, model: Mapping | None, crowd: Mapping | None,
               updated: str, extra: Mapping | None = None) -> dict:
    """One board document. ``players``: dicts with ``uid``, ``nick``, ``hidden``,
    and ``totals``; ``model`` / ``crowd``: their totals."""
    # A player with nothing scored yet stands on the board when they have tipped a round that has kicked off
    # (``pending``: 0 matches, 0 points, after everyone with points), so the board is not empty until a match settles.
    humans = [p for p in players if p["totals"]["n"] > 0 or p.get("pending")]
    order = lambda r: (-r["pts"], -(r["acc"] or 0), r["u"])  # noqa: E731 - one sort key for places and ranks
    everyone = sorted(((_row("player", p["uid"], p["nick"], p["totals"]), p["hidden"]) for p in humans), key=lambda e: order(e[0]))
    for place, (row, _hidden) in enumerate(everyone, 1):
        row["place"] = place
    rows = [row for row, hidden in everyone if not hidden]
    if model and model["n"]:
        rows.append(_row("model", None, MODEL_NAME, model))
    if crowd and crowd["n"]:
        rows.append(_row("crowd", None, CROWD_NAME, crowd))
    rows.sort(key=order)
    for rank, row in enumerate(rows, 1):
        row["rank"] = rank
    board = {"scope": scope, "updated": updated, "players": len(humans),
             "rows": rows[:ROW_LIMIT],
             "pct": percentile_table([total_points(p["totals"]["n"], p["totals"]["b"]) for p in humans])}
    board.update(extra or {})
    return board


def build_season_boards(season: int, slug: str, players: Mapping[str, dict], *, rounds: Sequence[Mapping],
                        model_rounds: Mapping[str, Mapping], crowd_rounds: Mapping[str, Mapping],
                        updated: str, changed_rounds: Sequence[str] = ()) -> dict[str, dict]:
    """The boards of one league and season.

    ``players``: uid -> {nick, hidden, rounds: {key: totals}, pending?}. ``rounds``: the
    league's rounds with any settled match, oldest first, each {key, round,
    matches, settled}; a round is *finished* when settled == matches. ``changed_rounds`` (round keys)
    also get a board of their own, `round_{season}_{slug}_{n}`, kept as a past round's board."""
    boards: dict[str, dict] = {}

    def over(keys: Sequence[str], scope: str, extra: Mapping, pending: bool = False) -> dict:
        wanted = set(keys)
        rows = []
        for uid, p in players.items():
            mine = {k: v for k, v in p["rounds"].items() if k in wanted}
            rows.append({"uid": uid, "nick": p["nick"], "hidden": p["hidden"], "totals": combine(mine.values()),
                         "pending": pending and bool(p.get("pending"))})
        return make_board(scope, rows, model=combine(v for k, v in model_rounds.items() if k in wanted),
                          crowd=combine(v for k, v in crowd_rounds.items() if k in wanted),
                          updated=updated, extra=extra)

    keys = [r["key"] for r in rounds]
    boards[f"season_{season}_{slug}"] = over(keys, "season", {"season": season, "league": slug}, pending=True)
    for info in rounds:
        if info["key"] in set(changed_rounds):
            boards[f"round_{season}_{slug}_{info['round']}"] = over([info["key"]], "round",
                                                                    {"season": season, "league": slug, "round": info["round"]})
    if rounds:
        latest = rounds[-1]
        boards[f"round_{season}_{slug}"] = over([latest["key"]], "round",
                                                {"season": season, "league": slug, "round": latest["round"]})
        boards[f"last10_{season}_{slug}"] = over(keys[-LAST_ROUNDS:], "last10", {"season": season, "league": slug},
                                               pending=True)
    return boards


def build_overall_board(season: int, divisions: Mapping[str, tuple[Mapping[str, dict], Sequence[Mapping]]], *,
                        model_rounds: Mapping[str, Mapping], crowd_rounds: Mapping[str, Mapping], updated: str) -> dict:
    """Both divisions together, this season: ``season_{season}_all``. ``divisions``: slug -> (players,
    rounds) as build_season_boards takes them; ``model_rounds`` and ``crowd_rounds`` hold both
    divisions' rounds."""
    merged: dict[str, dict] = {}
    for players, _rounds in divisions.values():
        for uid, p in players.items():
            row = merged.setdefault(uid, {"uid": uid, "nick": p["nick"], "hidden": p["hidden"], "totals": _blank(),
                                          "pending": False})
            row["pending"] = row["pending"] or bool(p.get("pending"))
            row["totals"] = combine([row["totals"], combine(p["rounds"].values())])
    return make_board("season", merged.values(), model=combine(model_rounds.values()), crowd=combine(crowd_rounds.values()),
                      updated=updated, extra={"season": season, "league": "all"})
