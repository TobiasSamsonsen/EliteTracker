"""The candidate bundle (1.1 B + 1.3, 1.7A AD value pull, 1.8 AD early step):
leave-one-out marginals, then the 1.11 re-sweep of the dormant hooks and the
main constants on top of it.

    .venv/Scripts/python experiments/improvements/bundle.py
"""
import math
import sys
from dataclasses import replace

import numpy as np

sys.path.insert(0, "experiments/improvements")
from context_terms import COUNT, ad_target  # noqa: E402
from elo_update import implied_exact, score_with  # noqa: E402
from harness import (  # noqa: E402
    HAS_XG, LEAGUE, SEASON, WINDOWS, ADConfig, EloRun, ad_run, blend, elo_run, line, oos_report, summary,
)
from elitetracker.model.attack_defence import gap_blend_weight  # noqa: E402
from elitetracker.model.elo import MODERN_CONFIG, EloConfig  # noqa: E402

A16, XG = WINDOWS["all16"], WINDOWS["xg"]
BASE_ELO = elo_run()
BASE_AD = ad_run()
BASE_MIX = blend(BASE_ELO, BASE_AD.probs)

MARGIN = dict(gamma=0.10, c=0.25)
VALUE_BETA = 0.2
EARLY = dict(g=0.5, tau=3.0)


def elo_cands(margin=True, gamma=None, c=None, config_for=None, gaps=None):
    kw = {}
    if margin:
        kw["score"] = score_with(implied=implied_exact, margin="B",
                                 gamma=MARGIN["gamma"] if gamma is None else gamma, c=c or MARGIN["c"])
    if config_for:
        kw["config_for"] = config_for
    return elo_run(EloRun(**kw), gaps=gaps)


def ad_cands(value=True, early=True, config=None, beta=None, g=None, **extra):
    kw = dict(extra)
    if value:
        kw["season_hook"] = ad_target(VALUE_BETA if beta is None else beta, "prev")
    if early:
        gg = EARLY["g"] if g is None else g
        kw["k_hook"] = lambda ad, team, m: 1.0 + gg * math.exp(-COUNT[(team, m.date)] / EARLY["tau"])
    return ad_run(config=config, **kw)


def main():
    e_all = elo_cands()
    a_all = ad_cands()
    full = blend(e_all, a_all.probs)
    print("== the bundle against elo-v12.2 ==")
    for w in ("all16", "es16", "ob16", "xg"):
        print(line(f"bundle blend [{w}]", full, BASE_MIX, WINDOWS[w]))
        print(line(f"bundle elo [{w}]", e_all, BASE_ELO, WINDOWS[w]))
    print("\n== leave one out (each against the bundle without it) ==")
    without = {
        "margin": blend(elo_run(), a_all.probs),
        "value": blend(e_all, ad_cands(value=False).probs),
        "early": blend(e_all, ad_cands(early=False).probs),
    }
    for name, other in without.items():
        for w in ("all16", "xg"):
            print(line(f"+{name} on the rest [{w}]", full, other, WINDOWS[w]))

    print("\n== 1.11 re-sweep on the bundle ==")
    gaps = np.zeros(len(full))
    elo_cands(gaps=gaps)
    # OUTCOME_BLEND
    fam = {0.25: full}
    for w in (0.0, 0.10, 0.15, 0.20, 0.30, 0.35, 0.40):
        fam[w] = blend(e_all, a_all.probs, w)
        print(line(f"OUTCOME_BLEND w={w}", fam[w], full, A16))
    oos_report("OUTCOME_BLEND", fam, 0.25)
    # blend_gamma (gap-dependent blend weight)
    fam = {0.0: full}
    for gamma in (0.1, 0.3, 0.6):
        weights = np.array([gap_blend_weight(gp, gamma) for gp in gaps])
        fam[gamma] = blend(e_all, a_all.probs, weights)
        print(line(f"blend_gamma {gamma}", fam[gamma], full, A16))
    oos_report("blend_gamma", fam, 0.0)
    # rho
    fam = {-0.05: full}
    for rho in (-0.11, -0.08, -0.04, -0.02, 0.0):
        fam[rho] = blend(e_all, ad_cands(config=replace(ADConfig(), rho=rho)).probs)
        print(line(f"rho {rho}", fam[rho], full, A16))
    oos_report("rho", fam, -0.05)
    # AD home_beta (needs the Elo gap)
    fam = {0.0: full}
    for hb in (-0.3, 0.3, 0.6):
        fam[hb] = blend(e_all, ad_cands(config=replace(ADConfig(), home_beta=hb), elo_gap=gaps).probs)
        print(line(f"AD home_beta {hb}", fam[hb], full, A16))
    oos_report("AD home_beta", fam, 0.0)
    # Elo home_advantage_beta (both eras)
    fam = {0.0: full}
    for hb in (-0.3, 0.3, 0.6):
        cf = lambda lg, s, hb=hb: replace(MODERN_CONFIG if s >= 2022 else EloConfig(), home_advantage_beta=hb)
        fam[hb] = blend(elo_cands(config_for=cf), a_all.probs)
        print(line(f"Elo home_advantage_beta {hb}", fam[hb], full, A16))
    oos_report("Elo home_advantage_beta", fam, 0.0)
    # spread
    fam = {1.10: full}
    for sp in (1.0, 1.05, 1.15, 1.20):
        fam[sp] = blend(e_all, ad_cands(config=replace(ADConfig(), spread=sp)).probs)
        print(line(f"spread {sp}", fam[sp], full, A16))
    oos_report("spread", fam, 1.10)
    # modern K x xg_alpha with the fixed margin
    fam_b, fam_e = {(30, 0.30): full}, {(30, 0.30): e_all}
    for k in (25, 30, 35, 45):
        for a in (0.2, 0.3, 0.45, 0.6):
            if (k, a) == (30, 0.30):
                continue
            cf = lambda lg, s, k=k, a=a: replace(MODERN_CONFIG, k_factor=k, xg_alpha=a) if s >= 2022 else EloConfig()
            e = elo_cands(config_for=cf)
            fam_e[(k, a)] = e
            fam_b[(k, a)] = blend(e, a_all.probs)
            print(line(f"modern K={k} alpha={a} elo", e, e_all, A16))
    oos_report("modern K x alpha elo", fam_e, (30, 0.30))
    oos_report("modern K x alpha blend", fam_b, (30, 0.30))
    # home advantage (Elo) and AD home
    fam = {60: full}
    for ha in (45, 50, 55, 65, 70, 80):
        cf = lambda lg, s, ha=ha: replace(MODERN_CONFIG if s >= 2022 else EloConfig(), home_advantage=ha)
        fam[ha] = blend(elo_cands(config_for=cf), a_all.probs)
        print(line(f"Elo home_advantage {ha}", fam[ha], full, A16))
    oos_report("Elo home_advantage", fam, 60)
    fam = {0.22: full}
    for h in (0.16, 0.19, 0.25, 0.28):
        fam[h] = blend(e_all, ad_cands(config=replace(ADConfig(), home=h)).probs)
        print(line(f"AD home {h}", fam[h], full, A16))
    oos_report("AD home", fam, 0.22)

    print("\n== summaries ==")
    for w in ("all16", "es16", "ob16", "xg"):
        print(summary(f"elo-v12.2 [{w}]", BASE_MIX, WINDOWS[w]))
        print(summary(f"bundle [{w}]", full, WINDOWS[w]))


if __name__ == "__main__":
    main()
