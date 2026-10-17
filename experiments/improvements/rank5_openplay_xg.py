"""IMPROVEMENTS2.md Rank 5, on elo-v15.0: open-play against set-piece xG.

Open play: RegularPlay, FastBreak, IndividualPlay; set pieces: FromCorner,
SetPiece, FreeKick, ThrowInSetPiece; and penalties. First how persistent
each is (a club's xG a match for and against, season to season and between
the halves of a season); then the signal weighted
    open + w_set * set + w_pen * pen, rescaled so the corpus's total xG holds
(shots_local.reweigh), w_set 0.5-1.0, as the xG of the Elo update and the
goals model's observation; finishing and keeping keep the stored xG. Also
the penalty weight re-run with the sides the right way round (extras.py
moved the wrong side's penalties; see shots_local.py).

    PYTHONPATH=experiments/improvements .venv/Scripts/python experiments/improvements/rank5_openplay_xg.py
"""

from __future__ import annotations

import numpy as np

import harness as h
import rules as r
import shots_local as s

OPEN = {"RegularPlay", "FastBreak", "IndividualPlay"}
SET = {"FromCorner", "SetPiece", "FreeKick", "ThrowInSetPiece"}


def kind(situation: str) -> str:
    return "pen" if situation == "Penalty" else "set" if situation in SET else "open"


def persistence() -> None:
    """Correlation across clubs of xG a match (for, against) by kind:
    season to season (the same club in Eliteserien both years) and odd
    against even matches within a season."""
    from elitetracker.model.career import team_ids
    per: dict[tuple[int, str], list[dict]] = {}
    for mid in s.HOME:
        m = s.MATCH[mid]
        home, away = team_ids(m)
        sums = {(True, k): 0.0 for k in ("open", "set", "pen")} | {(False, k): 0.0 for k in ("open", "set", "pen")}
        for shot in s.timeline(mid)[0]:
            sums[(shot[1], kind(shot[3]))] += shot[2]
        season = int(m.date[:4])
        for team, me in ((home, True), (away, False)):
            row = {f"{k} for": sums[(me, k)] for k in ("open", "set", "pen")}
            row |= {f"{k} against": sums[(not me, k)] for k in ("open", "set", "pen")}
            per.setdefault((season, team), []).append((m.date, row))
    keys = [f"{k} {d}" for k in ("open", "set", "pen") for d in ("for", "against")]

    def mean(rows, key):
        return np.mean([row[key] for _, row in rows])

    print("persistence across clubs (r):")
    for key in keys:
        pairs = [(mean(v, key), mean(per[(y + 1, t)], key)) for (y, t), v in per.items() if (y + 1, t) in per]
        halves = []
        for rows in per.values():
            rows = sorted(rows, key=lambda x: x[0])
            if len(rows) >= 20:
                halves.append((mean(rows[0::2], key), mean(rows[1::2], key)))
        yy = np.corrcoef(np.array(pairs).T)[0, 1]
        sh = np.corrcoef(np.array(halves).T)[0, 1]
        level = np.mean([mean(v, key) for v in per.values()])
        print(f"  {key:<12} {level:.3f} a match; season to season r {yy:+.2f} ({len(pairs)} pairs); "
              f"odd/even matches r {sh:+.2f} ({len(halves)} club-seasons)")


def weights(w_set: float, w_pen: float = 1.0):
    def weight(shot):
        k = kind(shot[3])
        return w_set if k == "set" else w_pen if k == "pen" else 1.0
    return weight


if __name__ == "__main__":
    s.check()
    persistence()
    assert abs(s.run(s.reweigh(weights(1.0))) - r.BASE).max() == 0.0
    print("identity: every weight 1 = the shipped model to the bit")
    keep = r.W["xg"] & s.EXTRAS

    fam = {1.0: r.BASE}
    for w in (0.5, 0.65, 0.8, 1.2):
        fam[w] = s.run(s.reweigh(weights(w)))
        r.table(f"set-piece xG x{w}", fam[w], extra={"shots": keep}, windows=("all16", "es16", "es21", "shots"))
    r.one_knob("set-piece weight, walk-forward", fam, 1.0, target="es16", restrict=s.EXTRAS)
    best = min((k for k in fam if k != 1.0), key=lambda k: h.losses(fam[k][keep], h.Y[keep])["ll"].mean())
    r.structural(f"set-piece xG x{best}", fam[best], target="es16")

    pen = {1.0: r.BASE}
    for w in (0.0, 0.5, 1.5):
        pen[w] = s.run(s.reweigh(weights(1.0, w), normalise=False))
        r.table(f"penalty xG x{w} (sides corrected)", pen[w], extra={"shots": keep}, windows=("es16", "shots"))
    r.one_knob("penalty weight, walk-forward", pen, 1.0, target="es16", restrict=s.EXTRAS)
