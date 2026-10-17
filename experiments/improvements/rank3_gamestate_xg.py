"""IMPROVEMENTS2.md Rank 3, on elo-v15.0: game-state-adjusted xG.

A side that leads sits back and a side that trails shoots more, from worse
positions, so raw xG flatters the trailing side. Each shot's xG is weighted
by the score when it was taken, from the shooter's side:
    ahead            1 + d_lead
    level            1
    behind by one    1 - d_trail / 2
    behind by two+   1 - d_trail
and, separately, a late damper: x (1 - d_late) when the margin is two or
more from the 75th minute. The weights rescale each side's stored xG and
one constant keeps the corpus's total xG (shots_local.reweigh). Eliteserien
2020-2026 only (fotmob's shots); OBOS-ligaen's Sofascore xG is unchanged.
The adjusted xG is the signal of the Elo update and of the goals model's
observation; finishing and keeping keep the stored xG.

    PYTHONPATH=experiments/improvements .venv/Scripts/python experiments/improvements/rank3_gamestate_xg.py
"""

from __future__ import annotations

import itertools

import numpy as np

import harness as h
import rules as r
import shots_local as s


def game_state(d_lead: float, d_trail: float, d_late: float = 0.0):
    def weight(shot):
        minute, is_home, _, _, hg, ag = shot
        lead = (hg - ag) if is_home else (ag - hg)
        w = 1.0 + d_lead if lead >= 1 else 1.0 if lead == 0 else 1.0 - d_trail / 2 if lead == -1 else 1.0 - d_trail
        if d_late and abs(lead) >= 2 and minute >= 75:
            w *= 1.0 - d_late
        return w
    return weight


def shares() -> None:
    """How much xG is taken in each state, and at what xG a shot."""
    rows = {}
    for mid in s.HOME:
        for minute, is_home, xg, _, hg, ag in s.timeline(mid)[0]:
            lead = (hg - ag) if is_home else (ag - hg)
            key = "ahead" if lead >= 1 else "level" if lead == 0 else "behind 1" if lead == -1 else "behind 2+"
            rows.setdefault(key, []).append(xg)
    total = sum(sum(v) for v in rows.values())
    print("xG by game state: " + "; ".join(f"{k} {sum(v) / total:.1%} of xG, {len(v)} shots, {np.mean(v):.3f} a shot"
                                          for k, v in rows.items()))


if __name__ == "__main__":
    s.check()
    shares()
    ident = s.reweigh(game_state(0.0, 0.0))
    assert all(ident[k] == h.SHOTS[k] for k in h.SHOTS)
    assert abs(s.run(ident) - r.BASE).max() == 0.0
    print("identity: no weights = the shipped model to the bit")

    fam = {(0.0, 0.0, 0.0): r.BASE}
    tables = {}
    for d_lead, d_trail in itertools.product((0.0, 0.05, 0.10, 0.15), (0.0, 0.10, 0.20, 0.30)):
        if d_lead or d_trail:
            tables[(d_lead, d_trail, 0.0)] = s.reweigh(game_state(d_lead, d_trail))
    for d_late in (0.25, 0.5):
        tables[(0.0, 0.0, d_late)] = s.reweigh(game_state(0.0, 0.0, d_late))
    for key, table in tables.items():
        fam[key] = s.run(table)
    keep = r.W["xg"] & s.EXTRAS
    print(f"\nin-sample, the {int(keep.sum())} scored matches with shots (d_lead, d_trail, d_late):")
    for key, p in fam.items():
        if key == (0.0, 0.0, 0.0):
            continue
        c = h.compare(p, r.BASE, keep)
        print(f"  {key}: LL {c['ll'][0]:+.5f} (t {c['ll'][1]:+.2f}), Brier {c['brier'][0]:+.5f} "
              f"(t {c['brier'][1]:+.2f}), RPS {c['rps'][0]:+.5f} (t {c['rps'][1]:+.2f})")
    best = min((k for k in fam if k != (0.0, 0.0, 0.0)),
               key=lambda k: h.losses(fam[k][keep], h.Y[keep])["ll"].mean())
    r.table(f"best in-sample {best}", fam[best], extra={"shots": keep}, windows=("all16", "es16", "es21", "xg", "shots"))
    for key in ((0.10, 0.20, 0.0), (0.0, 0.20, 0.0), (0.10, 0.0, 0.0)):
        r.table(f"{key}", fam[key], extra={"shots": keep}, windows=("es16", "es21", "shots"))
    for where, kw in (("Elo only", {"ad": False}), ("goals model only", {"elo": False})):
        p = s.run(tables[best], **kw)
        c = h.compare(p, r.BASE, keep)
        print(f"  {best} {where}: LL {c['ll'][0]:+.5f} (t {c['ll'][1]:+.2f})")
    r.one_knob("game state, walk-forward", fam, (0.0, 0.0, 0.0), target="es16", restrict=s.EXTRAS)
    r.structural(f"game state {best}", fam[best], target="es16")
