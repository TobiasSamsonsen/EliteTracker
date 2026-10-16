"""sweep2021.py's last pass: the elo-v14.0 candidate with what the sweep kept.

    shipped    elo-v13.0
    candidate  chances 90 % from xG, keeping over the last 45 matches x 0.75
    final      the candidate, OBOS-ligaen's offseason pull (0.75, 0.3) with
               Eliteserien's left at (0.88, 0.2), the surface edge 20

Each against the shipped model and the candidate, on 2021-2026 and on
2016-2026, with the halves and a walk-forward pick between them.

    .venv/Scripts/python experiments/improvements/sweep2021_final.py
"""
from __future__ import annotations

import sys

import numpy as np

sys.path.insert(0, "experiments/improvements")
import harness  # noqa: E402
import sweep2021 as S  # noqa: E402
import sweep2021_division as D  # noqa: E402
from harness import SEASON, WINDOWS, blend, elo_run, line, oos  # noqa: E402

PULLS = {"eliteserien": (0.88, 0.2), "obosligaen": (0.75, 0.3)}
EDGE = 20.0

if __name__ == "__main__":
    original = harness.surface_edge
    harness.surface_edge = lambda h, a, on: original(h, a, on, edge=EDGE)
    elo_edge = elo_run()
    harness.surface_edge = original
    S.ELO = elo_edge
    final = D.per_division(PULLS)          # blends with S.ELO, now the edge-20 Elo
    windows = {
        "all 2021+": SEASON >= 2021,
        "Eliteserien 2021+": (SEASON >= 2021) & (harness.LEAGUE == "eliteserien"),
        "OBOS-ligaen 2021+": (SEASON >= 2021) & (harness.LEAGUE == "obosligaen"),
        "all 2016+": WINDOWS["all16"],
    }
    for label, base in (("vs shipped", S.SHIPPED), ("vs candidate", S.CAND)):
        print(f"\nfinal {label}")
        for name, keep in windows.items():
            print(line(f"  {name}", final, base, keep))
    print("\ncandidate vs shipped")
    for name, keep in windows.items():
        print(line(f"  {name}", S.CAND, S.SHIPPED, keep))
    chosen, picks = oos({"shipped": S.SHIPPED, "candidate": S.CAND, "final": final}, "shipped", first=2021, select_from=2016)
    print("\nwalk-forward among shipped / candidate / final: " + " ".join(f"{s}:{p}" for s, p in sorted(picks.items())))
    print(line("  all 2021+", chosen, S.SHIPPED, windows["all 2021+"]))
