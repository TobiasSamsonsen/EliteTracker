"""1.7/1.8 follow-up: wider value-pull grid, with the pull strength, the
early-season step and each other."""
import math, sys
from dataclasses import replace
sys.path.insert(0, "experiments/improvements")
from context_terms import BASE_AD, BASE_ELO, BASE_MIX, COUNT, ad_target, elo_target  # noqa: E402
from harness import WINDOWS, ADConfig, EloRun, ad_run, blend, elo_run, line, oos_report  # noqa: E402
A16 = WINDOWS["all16"]

fam = {0: BASE_MIX}
for beta in (0.2, 0.3, 0.4, 0.5, 0.75, 1.0):
    for reg in (0.80, 0.88, 0.94):
        out = ad_run(config=replace(ADConfig(), season_regression=reg), season_hook=ad_target(beta, "prev"))
        fam[(beta, reg)] = blend(BASE_ELO, out.probs)
        print(line(f"value AD b={beta} reg={reg}", fam[(beta, reg)], BASE_MIX, A16))
oos_report("value AD wide", fam, 0, windows=("all16", "es16", "ob16", "xg"))

def khook(g, tau=3.0):
    return lambda ad, team, match: 1.0 + g * math.exp(-COUNT[(team, match.date)] / tau)
fam2 = {0: BASE_MIX}
for beta in (0.0, 0.3, 0.5):
    for g in (0.0, 0.5, 1.0, 1.5, 2.0):
        if beta == 0 and g == 0:
            continue
        kw = {}
        if beta:
            kw["season_hook"] = ad_target(beta, "prev")
        if g:
            kw["k_hook"] = khook(g)
        out = ad_run(**kw)
        fam2[(beta, g)] = blend(BASE_ELO, out.probs)
        print(line(f"value b={beta} + early g={g}", fam2[(beta, g)], BASE_MIX, A16))
oos_report("value + early", fam2, 0, windows=("all16", "es16", "ob16", "xg"))
early_only = {k: v for k, v in fam2.items() if k == 0 or k[0] == 0.0}
oos_report("early only wide", early_only, 0, windows=("all16", "es16", "ob16"))

# Elo pull to value with larger betas, judged on the blend
fam3 = {0: BASE_MIX}
for beta in (100, 150, 200, 300):
    fam3[beta] = blend(elo_run(EloRun(target=elo_target(beta, "prev"))), BASE_AD.probs)
    print(line(f"value Elo b={beta} blend", fam3[beta], BASE_MIX, A16))
oos_report("value Elo wide", fam3, 0)
