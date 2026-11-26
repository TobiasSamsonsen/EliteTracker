"""Penalty xG weight, a finer sweep on elo-v18.0 (November 2026), sides
corrected (shots_local.py). As rank5_openplay_xg.py: the weighted xG feeds the
Elo update and the goals model's observation, not rescaled; finishing and
keeping read the stored xG. Measured against elo-v18.0; its result is
elo-v19.0, whose `model_xg` weights the penalties underneath, so to reproduce
the numbers set `elitetracker.model.elo.PENALTY_XG_WEIGHT = 1.0` first.

    .venv/Scripts/python experiments/improvements/penalty_weight_fine.py
"""
import sys
sys.path.insert(0, "experiments/improvements")
import harness as h  # noqa: E402
import rules as r  # noqa: E402
import shots_local as s  # noqa: E402
from rank5_openplay_xg import weights  # noqa: E402

WEIGHTS = (1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.0, 2.25, 2.5, 3.0)

if __name__ == "__main__":
    s.check()
    assert abs(s.run(s.reweigh(weights(1.0, 1.0), normalise=False)) - r.BASE).max() == 0.0
    keep = r.W["xg"] & s.EXTRAS
    fam = {1.0: r.BASE}
    for w in WEIGHTS:
        fam[w] = s.run(s.reweigh(weights(1.0, w), normalise=False))
        print(h.line(f"penalty xG x{w} [shots]", fam[w], r.BASE, keep))
        print(h.line(f"penalty xG x{w} [es16]", fam[w], r.BASE, r.W["es16"]))
        print(h.line(f"penalty xG x{w} [all16]", fam[w], r.BASE, r.W["all16"]), flush=True)
    for first in (2021, 2022):
        chosen, picks = h.oos(fam, 1.0, first=first, restrict=s.EXTRAS)
        print(f"walk-forward from {first}, picks: " + " ".join(f"{k}:{v}" for k, v in picks.items()))
        print(h.line(f"  OOS [es {first}+]", chosen, r.BASE, r.W["es16"] & (h.SEASON >= first)))
        print(h.line(f"  OOS [all {first}+]", chosen, r.BASE, r.W["all16"] & (h.SEASON >= first)))
