"""The survivors of the IMPROVEMENTS2.md pass stacked (section 0.4), on
elo-v15.0, and each taken out again to see that it still adds:

    unclamp  the xG margin's [0, 1] clamp taken out of the Elo update (1A),
             margin 0.10 as shipped
    gamma12  the margin 0.10 -> 0.12 on top (1A's re-sweep, the walk-forward's
             0.15 shrunk)
    stakes   late-season table pressure on the prediction, Elo + 30 x
             (P_home - P_away), the goals model's rates x exp(+-0.05 x that),
             tau 0.8 (Rank 6)
    late     shots in the last 15 minutes at a two-goal margin at half
             weight in the xG signal (Rank 3; failed once its grid was
             widened, here to see its margin in the stack)

    PYTHONPATH=experiments/improvements .venv/Scripts/python experiments/improvements/bundle_v16.py
"""

from __future__ import annotations

import itertools
import math

import numpy as np

import harness as h
import rules as r
import shots_local as s
from elitetracker.model.career import team_ids
from followups_v15 import late_damper
from rank1_ceiling import INF, capped
from rank6_tablestakes import D, LATE, diff, elo_shift

PARTS = ("unclamp", "gamma12", "stakes", "late")
LATE_TABLE = s.reweigh(late_damper(0.5, 75, 2))


def build(parts) -> tuple[np.ndarray, np.ndarray]:
    """(Elo odds, blended odds) with `parts` switched on."""
    parts = set(parts)
    run = h.EloRun(score=capped(INF if "unclamp" in parts else 0.0, 0.12 if "gamma12" in parts else 0.10))
    hooks = {}
    if "late" in parts:
        run.shots = LATE_TABLE
        hooks["observed_hook"] = s.signal_hook(LATE_TABLE)
    if "stakes" in parts:
        run.home_shift, run.shift_in_update = elo_shift(30, 0.8), False
        order = iter(h.PLAYED)

        def rates(ad, home, away, on, lam, mu):
            m = next(order)[0]
            if m.match_id not in D:
                return lam, mu
            x = 0.05 * diff(m.match_id, 0.8)
            return lam * math.exp(x), mu * math.exp(-x)
        hooks["rates_hook"] = rates
    e = h.elo_run(run)
    a = h.ad_run(**hooks).probs if hooks else r.BASE_AD.probs
    return e, h.blend(e, a)


if __name__ == "__main__":
    e0, p0 = build(())
    assert abs(p0 - r.BASE).max() == 0.0 and abs(e0 - r.BASE_ELO).max() == 0.0
    print("identity: no parts = the shipped model to the bit")
    extra = {"late": LATE}
    wins = ("all16", "es16", "ob16", "es21", "ob21", "xg", "fav70", "late")
    cache = {}

    def get(parts):
        key = frozenset(parts)
        if key not in cache:
            cache[key] = build(key)
        return cache[key]

    for p in PARTS:
        if p == "gamma12":
            continue
        e, b = get({p})
        c = h.compare(b, r.BASE, r.W["all16"])
        print(f"  {p} alone: all16 {c['ll'][0]:+.5f} (t {c['ll'][1]:+.2f})")
    bundles = {
        "core (unclamp + stakes)": {"unclamp", "stakes"},
        "core + gamma12": {"unclamp", "gamma12", "stakes"},
        "core + late": {"unclamp", "stakes", "late"},
        "all four": set(PARTS),
    }
    for name, parts in bundles.items():
        e, b = get(parts)
        r.table(f"{name}, blend", b, extra=extra, windows=wins)
        r.table(f"{name}, Elo's own odds", e, r.BASE_ELO, extra=extra, windows=("all16", "xg", "fav70", "late"))
        print("  " + r.favourites(b))
        r.one_knob(f"{name}: walk-forward between shipped and it", {"shipped": r.BASE, "bundle": b}, "shipped",
                   ship="bundle")
        r.structural(name, b)
    print("\nleave one out (the bundle against the bundle without the part):")
    for name, parts in bundles.items():
        _, full = get(parts)
        for p in sorted(parts):
            if p == "unclamp" and "gamma12" in parts:
                continue
            rest = parts - {p} - ({"gamma12"} if p == "unclamp" else set())
            _, without = get(rest)
            c = h.compare(full, without, r.W["all16"])
            hm = c["ll_hmeans"]
            print(f"  {name}, {p}: all16 {c['ll'][0]:+.5f} (t {c['ll'][1]:+.2f}), Brier t {c['brier'][1]:+.2f}, "
                  f"RPS t {c['rps'][1]:+.2f}, halves {hm[0]:+.5f} / {hm[1]:+.5f}")
