"""Follow-ups to the IMPROVEMENTS2.md items whose walk-forward pick sat at the
edge of the planned grid (on elo-v15.0):

- Rank 6 table stakes: Elo gamma beyond 45, the goals model's kappa beyond
  0.10, and the two together (one pressure term in both models).
- Rank 3 game state: the late damper past 0.5, from other minutes and
  margins; and the planned weights the other way round (the trailing side's
  shots up), since the planned direction was worse everywhere.

    PYTHONPATH=experiments/improvements .venv/Scripts/python experiments/improvements/followups_v15.py
"""

from __future__ import annotations

import itertools
import math

import numpy as np

import harness as h
import rules as r
import shots_local as s
from rank6_tablestakes import LATE, ad_run_shift, elo_shift
from rank3_gamestate_xg import game_state


def late_damper(d_late: float, minute: int, margin: int):
    def weight(shot):
        m, is_home, _, _, hg, ag = shot
        lead = (hg - ag) if is_home else (ag - hg)
        return 1.0 - d_late if abs(lead) >= margin and m >= minute else 1.0
    return weight


if __name__ == "__main__":
    extra = {"late": LATE}
    tau = 0.8
    # ---- Rank 6, wider ----
    elo = {g: h.elo_run(h.EloRun(home_shift=elo_shift(g, tau), shift_in_update=False)) for g in (30, 45, 60, 80, 100, 130)}
    ad = {k: ad_run_shift(k, tau) for k in (0.05, 0.10, 0.15, 0.20, 0.30)}
    fam_e = {0: r.BASE, **{g: h.blend(e, r.BASE_AD.probs) for g, e in elo.items()}}
    fam_a = {0: r.BASE, **{k: h.blend(r.BASE_ELO, a) for k, a in ad.items()}}
    for name, fam in (("Elo gamma", fam_e), ("goals model kappa", fam_a)):
        for k, p in fam.items():
            if k:
                c, cl = h.compare(p, r.BASE, r.W["all16"]), h.compare(p, r.BASE, LATE)
                print(f"  {name} {k}: all16 {c['ll'][0]:+.5f} (t {c['ll'][1]:+.2f}); run-in {cl['ll'][0]:+.5f} "
                      f"(t {cl['ll'][1]:+.2f}), halves t {cl['ll_halves'][0]:+.2f} / {cl['ll_halves'][1]:+.2f}")
    r.one_knob("stakes, Elo, gamma 0-130, walk-forward", fam_e, 0, restrict=LATE)
    r.one_knob("stakes, goals model, kappa 0-0.30, walk-forward", fam_a, 0, restrict=LATE)
    both = {(0, 0): r.BASE}
    for g, k in itertools.product((0, 30, 45, 60, 80), (0, 0.05, 0.10, 0.15)):
        if g or k:
            both[(g, k)] = h.blend(elo[g] if g else r.BASE_ELO, ad[k] if k else r.BASE_AD.probs)
    print("\nstakes in both models (gamma, kappa), in-sample:")
    for key, p in both.items():
        if key != (0, 0):
            c, cl = h.compare(p, r.BASE, r.W["all16"]), h.compare(p, r.BASE, LATE)
            print(f"  {key}: all16 {c['ll'][0]:+.5f} (t {c['ll'][1]:+.2f}); run-in {cl['ll'][0]:+.5f} (t {cl['ll'][1]:+.2f})")
    r.one_knob("stakes, both models, walk-forward", both, (0, 0), restrict=LATE)
    for key in ((30, 0.05), (45, 0.05), (45, 0.10)):
        r.table(f"stakes, both models, gamma {key[0]}, kappa {key[1]}", both[key], extra=extra,
                windows=("all16", "es16", "ob16", "es21", "ob21", "fav70", "late"))
        r.structural(f"stakes {key}", both[key], target="late", extra=extra)

    # ---- Rank 3, the late damper wider, and the reverse direction ----
    keep = r.W["xg"] & s.EXTRAS
    fam = {(0.0, 75, 2): r.BASE}
    for d, minute, margin in itertools.product((0.25, 0.5, 0.75, 1.0), (60, 70, 75, 80), (2, 3)):
        fam[(d, minute, margin)] = s.run(s.reweigh(late_damper(d, minute, margin)))
    print("\nlate damper (strength, from minute, margin), the matches with shots:")
    for key, p in fam.items():
        if key[0]:
            c = h.compare(p, r.BASE, keep)
            print(f"  {key}: {c['ll'][0]:+.5f} (t {c['ll'][1]:+.2f}), Brier t {c['brier'][1]:+.2f}, RPS t {c['rps'][1]:+.2f}")
    r.one_knob("late damper, walk-forward", fam, (0.0, 75, 2), target="es16", restrict=s.EXTRAS)
    sub = {k: v for k, v in fam.items() if k == (0.0, 75, 2) or (k[1] == 75 and k[2] == 2)}
    r.one_knob("late damper, 75' and two goals, strength only, walk-forward", sub, (0.0, 75, 2), target="es16",
               restrict=s.EXTRAS, ship=(0.5, 75, 2))
    rev = {(0.0, 0.0): r.BASE}
    for d_lead, d_trail in ((-0.05, 0.0), (-0.10, 0.0), (0.0, -0.10), (0.0, -0.20), (-0.05, -0.10)):
        rev[(d_lead, d_trail)] = s.run(s.reweigh(game_state(d_lead, d_trail)))
        c = h.compare(rev[(d_lead, d_trail)], r.BASE, keep)
        print(f"  reversed game state d_lead {d_lead}, d_trail {d_trail}: {c['ll'][0]:+.5f} (t {c['ll'][1]:+.2f})")
    r.one_knob("reversed game state, walk-forward", rev, (0.0, 0.0), target="es16", restrict=s.EXTRAS)
