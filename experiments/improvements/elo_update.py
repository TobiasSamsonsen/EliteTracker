"""IMPROVEMENTS.md 1.1-1.3: the Elo observation (xG margin sign, logistic
margin, the exact xg_implied_score). Run from the repo root:

    .venv/Scripts/python experiments/improvements/elo_update.py
"""

from __future__ import annotations

import math
import sys

import numpy as np

sys.path.insert(0, "experiments/improvements")
from harness import (  # noqa: E402
    EloRun, HAS_XG, SEASON, WINDOWS, ad_run, blend, elo_run, line, oos_report, report, shipped_score,
)
from elitetracker.model.elo import actual_score, xg_implied_score  # noqa: E402


def implied_exact(hxg: float, axg: float, cap: int = 12) -> float:
    """O(cap) recurrence, normalised by the truncated mass (IMPROVEMENTS 1.3)."""
    ph, pa = math.exp(-hxg), math.exp(-axg)
    below = home = draw = total_h = 0.0
    for k in range(cap + 1):
        if k:
            ph *= hxg / k
            pa *= axg / k
        home += ph * below
        draw += ph * pa
        below += pa
        total_h += ph
    return (home + 0.5 * draw) / (total_h * below)


def score_with(implied=xg_implied_score, margin: str = "shipped", gamma: float | None = None, c: float = 0.25):
    """The shipped observation with the implied score and the margin term swapped."""
    def score(hg, ag, hxg, axg, cfg):
        s = actual_score(hg, ag)
        if hxg is None or axg is None or cfg.xg_alpha <= 0.0:
            return s
        s = (1.0 - cfg.xg_alpha) * s + cfg.xg_alpha * implied(hxg, axg)
        g = cfg.xg_margin if gamma is None else gamma
        if not g or margin == "none":
            return s
        if margin == "shipped":  # elo-v12.2's form, signed by the scoreline
            if hg != ag and hxg > 0 and axg > 0:
                winner = 1.0 if hg > ag else -1.0
                s += winner * g * math.log(1.0 + abs(math.log(hxg / axg)))
        elif margin == "A1":  # signed by the xG winner, decided matches only
            if hg != ag and hxg > 0 and axg > 0:
                r = math.log(hxg / axg)
                s += math.copysign(g * math.log(1.0 + abs(r)), r)
        elif margin == "A2":  # zero when goals and xG disagree on the winner
            if hg != ag and hxg > 0 and axg > 0 and (hg - ag) * (hxg - axg) > 0:
                winner = 1.0 if hg > ag else -1.0
                s += winner * g * math.log(1.0 + abs(math.log(hxg / axg)))
        elif margin == "B":  # signed, smoothed, every xG match incl. draws and 0.0 xG
            r = math.log((hxg + c) / (axg + c))
            s += math.copysign(g * math.log(1.0 + abs(r)), r)
        return min(1.0, max(0.0, s))
    return score


def logistic(w: float, c: float, hybrid: float | None = None, goals_only_too: bool = False):
    """1.2: the observed score as a logistic of a blended goal/xG margin."""
    def score(hg, ag, hxg, axg, cfg):
        if hxg is None or axg is None:
            if goals_only_too:
                return 1.0 / (1.0 + 10.0 ** (-(hg - ag) / c))
            return actual_score(hg, ag)
        dy = w * (hxg - axg) + (1.0 - w) * (hg - ag)
        s_obs = 1.0 / (1.0 + 10.0 ** (-dy / c))
        if hybrid is None:
            return s_obs
        return (1.0 - hybrid) * shipped_score(hg, ag, hxg, axg, cfg) + hybrid * s_obs
    return score


def main() -> None:
    base_elo = elo_run()
    grid = ad_run().probs
    base_mix = blend(base_elo, grid)
    xgm = WINDOWS["xg"]

    print("== 1.3 exact xg_implied_score (cap 12, normalised) ==")
    worst = max(abs(implied_exact(h, a) - xg_implied_score(h, a))
                for h in np.linspace(0, 6, 61) for a in np.linspace(0, 6, 61))
    print(f"max |new - old| over xG 0..6: {worst:.5f}; at (5.0, 0.3): "
          f"{xg_implied_score(5.0, 0.3):.5f} -> {implied_exact(5.0, 0.3):.5f}")
    e13 = elo_run(EloRun(score=score_with(implied=implied_exact)))
    report("1.3 elo", e13, base_elo, ("all16", "xg"))
    report("1.3 blend", blend(e13, grid), base_mix, ("all16", "xg"))

    print("\n== 1.1 xg_margin sign ==")
    families = {}
    for margin in ("A1", "A2"):
        for g in (0.03, 0.05, 0.08, 0.10, 0.12):
            families[(margin, g, None)] = elo_run(EloRun(score=score_with(margin=margin, gamma=g)))
    for g in (0.03, 0.05, 0.08, 0.10, 0.12):
        for c in (0.15, 0.25, 0.35):
            families[("B", g, c)] = elo_run(EloRun(score=score_with(margin="B", gamma=g, c=c)))
    for g in (0.0, 0.03, 0.08, 0.10, 0.12):
        families[("shipped", g, None)] = elo_run(EloRun(score=score_with(margin="shipped", gamma=g)))
    families[("shipped", 0.05, None)] = base_elo
    for key, e in families.items():
        if key == ("shipped", 0.05, None):
            continue
        name = f"1.1 {key[0]} g={key[1]}" + (f" c={key[2]}" if key[2] else "")
        print(line(name + " elo [xg]", e, base_elo, xgm))
        print(line(name + " blend [xg]", blend(e, grid), base_mix, xgm))
    for fam in ("A1", "A2", "B", "shipped"):
        variants = {k: v for k, v in families.items() if k[0] == fam or k == ("shipped", 0.05, None)}
        oos_report(f"1.1 {fam} elo", variants, ("shipped", 0.05, None), restrict=HAS_XG)
        oos_report(f"1.1 {fam} blend", {k: blend(v, grid) for k, v in variants.items()},
                   ("shipped", 0.05, None), restrict=HAS_XG)

    print("\n== 1.2 logistic margin ==")
    lfam = {"base": base_elo}
    for w in (0.5, 0.75, 1.0):
        for c in (1.5, 2.0, 3.0, 4.0):
            lfam[("L", w, c)] = elo_run(EloRun(score=logistic(w, c)))
            for h in (0.25, 0.5):
                lfam[("H", w, c, h)] = elo_run(EloRun(score=logistic(w, c, hybrid=h)))
    for c in (1.5, 2.0, 3.0):
        lfam[("G", 0.75, c)] = elo_run(EloRun(score=logistic(0.75, c, goals_only_too=True)))
    for key, e in lfam.items():
        if key == "base":
            continue
        print(line(f"1.2 {key} elo [xg]", e, base_elo, xgm))
        if key[0] == "G":
            print(line(f"1.2 {key} elo [all16]", e, base_elo, WINDOWS["all16"]))
    for fam in ("L", "H", "G"):
        variants = {k: v for k, v in lfam.items() if k == "base" or k[0] == fam}
        oos_report(f"1.2 {fam} elo", variants, "base", restrict=None if fam == "G" else HAS_XG)
        oos_report(f"1.2 {fam} blend", {k: blend(v, grid) for k, v in variants.items()}, "base",
                   restrict=None if fam == "G" else HAS_XG)


if __name__ == "__main__":
    main()
