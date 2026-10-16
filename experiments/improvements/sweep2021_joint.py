"""sweep2021.py's second pass: the settings that moved alone, together.

The goals model's season regression and the squad-value pull are coupled
(a club is pulled toward mean + value_pull * v by 1 - regression), so they
are swept jointly; the surface edge and the spread past the first grid's
edge. Paired against the elo-v14.0 candidate on 2021-2026, with a
walk-forward pick over the joint family.

    .venv/Scripts/python experiments/improvements/sweep2021_joint.py
"""
from __future__ import annotations

import itertools
import sys

sys.path.insert(0, "experiments/improvements")
import harness  # noqa: E402
import sweep2021 as S  # noqa: E402
from harness import blend, elo_run  # noqa: E402

if __name__ == "__main__":
    print("\n-- goals model: season regression x value pull")
    family = {}
    for reg, pull in itertools.product((0.70, 0.75, 0.80, 0.84, 0.88), (0.2, 0.3, 0.4, 0.5, 0.6)):
        key = f"reg {reg} pull {pull}"
        family[key] = S.CAND if (reg, pull) == (0.88, 0.2) else blend(S.ELO, S.ad_probs({"season_regression": reg, "value_pull": pull}))
        print(f"  {key:<20} {S.cells(family[key], S.CAND)}")
    print("   " + S.walk_forward(family, "reg 0.88 pull 0.2"))

    print("\n-- surface edge past the grid")
    original = harness.surface_edge
    edges = {}
    for v in (10.0, 20.0, 25.0, 30.0, 40.0):
        harness.surface_edge = lambda h, a, on, v=v: original(h, a, on, edge=v)
        edges[v] = blend(elo_run(), S.AD)
        print(f"  edge {v:<6} {S.cells(edges[v], S.CAND)}")
    harness.surface_edge = original
    print("   " + S.walk_forward(edges, 10.0))

    print("\n-- spread past the grid")
    spreads = {1.1: S.CAND}
    for v in (1.15, 1.2, 1.25, 1.3):
        spreads[v] = blend(S.ELO, S.ad_probs({"spread": v}))
        print(f"  spread {v:<5} {S.cells(spreads[v], S.CAND)}")
    print("   " + S.walk_forward(spreads, 1.1))
