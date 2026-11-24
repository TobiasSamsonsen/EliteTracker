"""Leaderboards, built from per-player round totals (docs/predict-plan.md, section 2).

Columns follow FFI's tournament: rank, name, matches, Accuracy (Brier), Accuracy
(RPS), average Brier, average RPS, streak. The model and the crowd stand on the
board as players ("can you beat the model?"). Rank is by summed Accuracy
(Brier); skipping a match counts 0, so answering more only helps if you beat
half the field. A board holds the top ROW_LIMIT visible rows and a percentile
table of every player (hidden ones included), so a player outside the list can
still be told "you are in the top 23 %".

Players are identified on a public board only by ``uid_hash``, a short hash the
browser can compute for itself, never by the account id.
"""

from __future__ import annotations

import hashlib
from typing import Iterable, Mapping, Sequence

from elitetracker.predict.streaks import streak as streak_of

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


def player_streak(rounds: Sequence[Mapping], entered: Mapping[str, Mapping]) -> dict:
    """The streak of completed rounds in one league, counted from the player's
    first entered round. ``rounds``: the league's finished rounds, oldest first,
    each {key, matches}; ``entered``: the player's round totals by key."""
    flags: list[bool] = []
    started = False
    for info in rounds:
        mine = entered.get(info["key"])
        if mine:
            started = True
        if started:
            flags.append(bool(mine) and mine["n"] >= info["matches"])
    return streak_of(flags)


def _row(kind: str, uid: str | None, nick: str, totals: Mapping, streak: int | None) -> dict:
    n = totals["n"]
    return {"u": uid_hash(uid) if uid else kind, "nick": nick, "kind": kind, "n": n,
            "ab": round(totals["ab"], 4), "ar": round(totals["ar"], 4),
            "b": round(totals["b"] / n, 4) if n else None, "r": round(totals["r"] / n, 4) if n else None,
            "vm": round(totals["vm"], 4), "streak": streak}


def make_board(scope: str, players: Iterable[dict], *, model: Mapping | None, crowd: Mapping | None,
               updated: str, extra: Mapping | None = None) -> dict:
    """One board document. ``players``: dicts with ``uid``, ``nick``, ``hidden``,
    ``totals`` and optionally ``streak``; ``model`` / ``crowd``: their totals."""
    humans = [p for p in players if p["totals"]["n"] > 0]
    rows = [_row("player", p["uid"], p["nick"], p["totals"], p.get("streak")) for p in humans if not p["hidden"]]
    if model and model["n"]:
        rows.append(_row("model", None, MODEL_NAME, model, None))
    if crowd and crowd["n"]:
        rows.append(_row("crowd", None, CROWD_NAME, crowd, None))
    rows.sort(key=lambda r: (-r["ab"], -r["n"], r["u"]))
    for rank, row in enumerate(rows, 1):
        row["rank"] = rank
    board = {"scope": scope, "updated": updated, "players": len(humans),
             "rows": rows[:ROW_LIMIT], "pct": percentile_table([p["totals"]["ab"] for p in humans])}
    board.update(extra or {})
    return board


def build_season_boards(season: int, slug: str, players: Mapping[str, dict], *, rounds: Sequence[Mapping],
                        model_rounds: Mapping[str, Mapping], crowd_rounds: Mapping[str, Mapping],
                        updated: str, changed_rounds: Sequence[str] = ()) -> dict[str, dict]:
    """The boards of one league and season.

    ``players``: uid -> {nick, hidden, rounds: {key: totals}}. ``rounds``: the
    league's rounds with any settled match, oldest first, each {key, round,
    matches, settled}; a round is *finished* when settled == matches. ``changed_rounds`` (round keys)
    also get a board of their own, `round_{season}_{slug}_{n}`, kept as a past round's board."""
    finished = [r for r in rounds if r["settled"] >= r["matches"]]
    boards: dict[str, dict] = {}

    def over(keys: Sequence[str], scope: str, extra: Mapping) -> dict:
        wanted = set(keys)
        rows = []
        for uid, p in players.items():
            mine = {k: v for k, v in p["rounds"].items() if k in wanted}
            rows.append({"uid": uid, "nick": p["nick"], "hidden": p["hidden"], "totals": combine(mine.values()),
                         "streak": player_streak(finished, p["rounds"])["current"]})
        return make_board(scope, rows, model=combine(v for k, v in model_rounds.items() if k in wanted),
                          crowd=combine(v for k, v in crowd_rounds.items() if k in wanted),
                          updated=updated, extra=extra)

    keys = [r["key"] for r in rounds]
    boards[f"season_{season}_{slug}"] = over(keys, "season", {"season": season, "league": slug})
    for info in rounds:
        if info["key"] in set(changed_rounds):
            boards[f"round_{season}_{slug}_{info['round']}"] = over([info["key"]], "round",
                                                                    {"season": season, "league": slug, "round": info["round"]})
    if rounds:
        latest = rounds[-1]
        boards[f"round_{season}_{slug}"] = over([latest["key"]], "round",
                                                {"season": season, "league": slug, "round": latest["round"]})
        boards[f"last10_{season}_{slug}"] = over(keys[-LAST_ROUNDS:], "last10", {"season": season, "league": slug})
    return boards
