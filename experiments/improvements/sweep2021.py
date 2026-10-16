"""Every model setting, one at a time, scored on 2021-2026 (October 2026).

The baseline is the elo-v14.0 candidate from fcdk.py: the shipped model with
the goals model's chances learnt 90 % from xG (alpha 0.9) and the other
side's keeping over its last 45 matches at 0.75. Each setting is moved alone,
everything else held, and scored as the shipped blend of the grid and the Elo
odds on every match 2021-2026 (both divisions), Eliteserien and OBOS-ligaen
apart, paired against the candidate. A walk-forward pick per setting (each
season scored with the value that did best on the seasons from 2016 before
it) guards against reading noise as a gain.

The Elo settings are the modern era's (MODERN_CONFIG, 2022 on; 2021 keeps the
legacy config). The goals model's settings are ADConfig's. The blend is the
Elo weight in the geometric blend of the two models' odds.

    .venv/Scripts/python experiments/improvements/sweep2021.py
"""
from __future__ import annotations

import math
import sys
from dataclasses import replace

import numpy as np

sys.path.insert(0, "experiments/improvements")
import harness  # noqa: E402
import fcdk  # noqa: E402
from harness import LEAGUE, SEASON, Y, EloRun, ad_run, blend, elo_run, losses, oos, tstat  # noqa: E402
from elitetracker.model.elo import MODERN_CONFIG, era_config  # noqa: E402
from elitetracker.normalize import surfaces  # noqa: E402

W = {
    "all21": SEASON >= 2021,
    "es21": (SEASON >= 2021) & (LEAGUE == "eliteserien"),
    "ob21": (SEASON >= 2021) & (LEAGUE == "obosligaen"),
}
CANDIDATE = dict(alpha=0.9, n_keep=45, w_keep=0.75)
SHIPPED = fcdk.BASE
ELO = fcdk.BASE_ELO


def ad_probs(ad_changes=None, keep=None):
    """The candidate's goals model with ADConfig fields and keeping moved."""
    kw = dict(CANDIDATE, **(keep or {}))
    config, hooks = fcdk.fcdk(**kw)
    if ad_changes:
        config = replace(config, **ad_changes)
    return ad_run(config, **hooks).probs


AD = ad_probs()
CAND = blend(ELO, AD)


def elo_probs(changes):
    modern = replace(MODERN_CONFIG, **changes)
    return elo_run(EloRun(config_for=lambda league, season: era_config(season, modern=modern)))


def lw(p, w, metric="ll"):
    return losses(p[W[w]], Y[W[w]])[metric]


def cells(p, base):
    out = []
    for w in ("all21", "es21", "ob21"):
        d = lw(p, w) - lw(base, w)
        out.append(f"{d.mean():+.5f} ({tstat(d):+5.2f})")
    d_b = lw(p, "all21", "brier") - lw(base, "all21", "brier")
    d_r = lw(p, "all21", "rps") - lw(base, "all21", "rps")
    return "  ".join(out) + f"   Br t {tstat(d_b):+5.2f}  RPS t {tstat(d_r):+5.2f}"


def walk_forward(family, current):
    chosen, picks = oos(family, current, first=2021, select_from=2016)
    d = lw(chosen, "all21") - lw(CAND, "all21")
    names = " ".join(str(picks[s]) for s in sorted(picks))
    return f"walk-forward {d.mean():+.5f} (t {tstat(d):+5.2f})  picks {names}"


def sweep(name, current, values, probs_for):
    print(f"\n{name} (now {current})          all 2021+ LL (t)    Eliteserien         OBOS-ligaen")
    family = {}
    for v in values:
        family[v] = CAND if v == current else probs_for(v)
        mark = "*" if v == current else " "
        print(f"  {mark}{str(v):<8} {cells(family[v], CAND)}")
    print(f"   {walk_forward(family, current)}")
    return family


if __name__ == "__main__":
    print("candidate vs shipped:  " + cells(CAND, SHIPPED))
    results = {}
    # -- the goals model -------------------------------------------------
    ad_grid = {
        "k": (0.015, [0.010, 0.0125, 0.015, 0.0175, 0.020]),
        "k_shots": (0.05, [0.035, 0.045, 0.05, 0.055, 0.065]),
        "alpha": (0.9, [0.8, 0.85, 0.9, 0.95, 1.0]),
        "home": (0.22, [0.18, 0.20, 0.22, 0.24, 0.26]),
        "base": (0.37, [0.33, 0.35, 0.37, 0.39, 0.41]),
        "cap": (4.0, [2.0, 3.0, 4.0, 6.0]),
        "season_regression": (0.88, [0.80, 0.84, 0.88, 0.92, 0.96]),
        "division_gap": (0.25, [0.15, 0.20, 0.25, 0.30, 0.35]),
        "newcomer": (0.15, [0.05, 0.10, 0.15, 0.20, 0.25]),
        "rho": (-0.05, [-0.10, -0.075, -0.05, -0.025, 0.0]),
        "finishing_regression": (0.70, [0.5, 0.6, 0.7, 0.8, 0.9, 1.0]),
        "spread": (1.10, [1.0, 1.05, 1.10, 1.15, 1.20]),
        "value_pull": (0.2, [0.0, 0.1, 0.2, 0.3, 0.4]),
        "early_boost": (0.5, [0.0, 0.25, 0.5, 0.75, 1.0]),
        "early_tau": (3.0, [2.0, 3.0, 4.0, 5.0]),
    }
    print("\n=== goals model (ADConfig) ===")
    for field, (current, values) in ad_grid.items():
        if field == "alpha":
            results[field] = sweep(field, current, values, lambda v: blend(ELO, ad_probs(keep={"alpha": v})))
        else:
            results[field] = sweep(field, current, values, lambda v, f=field: blend(ELO, ad_probs({f: v})))
    results["keeping matches"] = sweep("keeping matches", 45, [30, 45, 60, 90], lambda v: blend(ELO, ad_probs(keep={"n_keep": v})))
    results["keeping weight"] = sweep("keeping weight", 0.75, [0.5, 0.75, 1.0], lambda v: blend(ELO, ad_probs(keep={"w_keep": v})))

    # -- Elo (modern config, 2022 on) ------------------------------------
    elo_grid = {
        "k_factor": (30.0, [20.0, 25.0, 30.0, 35.0, 40.0]),
        "home_advantage": (60.0, [40.0, 50.0, 60.0, 70.0, 80.0]),
        "xg_alpha": (0.30, [0.20, 0.25, 0.30, 0.35, 0.40, 0.50]),
        "xg_margin": (0.10, [0.0, 0.05, 0.10, 0.15, 0.20]),
        "draw_base": (0.26, [0.22, 0.24, 0.26, 0.28, 0.30]),
        "draw_scale": (375.0, [300.0, 340.0, 375.0, 410.0, 450.0]),
        "season_regression": (0.88, [0.80, 0.84, 0.88, 0.92, 0.96]),
    }
    print("\n=== Elo (modern config) ===")
    for field, (current, values) in elo_grid.items():
        results[f"elo {field}"] = sweep(f"elo {field}", current, values, lambda v, f=field: blend(elo_probs({f: v}), AD))
    edge = surfaces.SURFACE_EDGE
    original = harness.surface_edge

    def with_edge(v):
        harness.surface_edge = lambda h, a, on: original(h, a, on, edge=v)
        try:
            return blend(elo_run(), AD)
        finally:
            harness.surface_edge = original
    results["surface edge"] = sweep("surface edge (Elo points)", edge, [0.0, 5.0, 10.0, 15.0, 20.0], with_edge)

    # -- the blend -------------------------------------------------------
    print("\n=== the blend of the two models' odds ===")
    results["blend"] = sweep("Elo weight in the blend", 0.25, [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40], lambda v: blend(ELO, AD, v))
