"""IMPROVEMENTS.md 1.12: the online attack/defence learner against a refitted,
time-decayed, opponent-adjusted multiplicative model (iterative proportional
fitting with empirical-Bayes shrinkage of tau0 matches toward the division
mean), refit every matchday on everything before it. Same observation as the
shipped model (0.75 xG + 0.25 goals where there is xG), same grid (Dixon-Coles
rho, spread off: IPF has no online lag to correct).
Also: the Elo value pull on top of the bundle.
"""
import math, sys
import numpy as np
sys.path.insert(0, "experiments/improvements")
from harness import (AG, DATE, HG, LEAGUE, PLAYED, SEASON, SHOTS, WINDOWS, ADConfig, blend, line,  # noqa: E402
                     oos_report, score_grid, summary, elo_run, EloRun)
from bundle import ad_cands, elo_cands, BASE_MIX  # noqa: E402
from context_terms import elo_target  # noqa: E402
from elitetracker.model.career import team_ids  # noqa: E402
from datetime import date

A16 = WINDOWS["all16"]
e_all = elo_cands(); a_all = ad_cands(); full = blend(e_all, a_all.probs)

print("== Elo value pull on top of the bundle ==")
from elo_update import implied_exact, score_with  # noqa: E402
fam = {0: full}
for beta in (50, 100, 150):
    e = elo_run(EloRun(score=score_with(implied=implied_exact, margin="B", gamma=0.10, c=0.25), target=elo_target(beta, "prev")))
    fam[beta] = blend(e, a_all.probs)
    print(line(f"+Elo value b={beta} blend", fam[beta], full, A16))
    print(line(f"+Elo value b={beta} elo", e, e_all, A16))
oos_report("+Elo value", fam, 0)

print("\n== 1.12 IPF benchmark ==")
teams = sorted({t for m, _, _ in PLAYED for t in team_ids(m)})
tix = {t: i for i, t in enumerate(teams)}
H = np.array([tix[team_ids(m)[0]] for m, _, _ in PLAYED]); A = np.array([tix[team_ids(m)[1]] for m, _, _ in PLAYED])
cfg = ADConfig()
obs_h = HG.astype(float).copy(); obs_a = AG.astype(float).copy()
for i, (m, _, _) in enumerate(PLAYED):
    s = SHOTS.get(m.match_id)
    if s:
        obs_h[i] = 0.25 * HG[i] + 0.75 * s[0]; obs_a[i] = 0.25 * AG[i] + 0.75 * s[1]
DAY = np.array([date.fromisoformat(d).toordinal() for d in DATE])

def ipf_run(half_life, tau0, iters=30):
    out = np.zeros((len(PLAYED), 3))
    att = np.ones(len(teams)); dfn = np.ones(len(teams)); home = math.exp(cfg.home); mean = 1.4
    days = sorted(set(DAY.tolist()))
    for day in days:
        today = np.nonzero(DAY == day)[0]
        past = DAY < day
        if past.sum() > 200:
            w = 0.5 ** ((day - DAY[past]) / half_life)
            h, a, oh, oa = H[past], A[past], obs_h[past], obs_a[past]
            mean = (w * (oh + oa)).sum() / (2 * w.sum())
            home = math.sqrt(((w * oh).sum() / (w * oa).sum()))
            for _ in range(iters):
                # attack: goals scored / expected given opponents' defence, shrunk by tau0 pseudo-matches at 1.0
                exp_h = mean * home * dfn[a]; exp_a = mean / home * dfn[h]
                num = np.bincount(h, w * oh, len(teams)) + np.bincount(a, w * oa, len(teams))
                den = np.bincount(h, w * exp_h, len(teams)) + np.bincount(a, w * exp_a, len(teams))
                cnt_mean = (np.bincount(h, w, len(teams)) + np.bincount(a, w, len(teams)))
                att = (num + tau0 * mean) / (den + tau0 * mean)
                exp_h = mean * home * att[h]; exp_a = mean / home * att[a]
                num = np.bincount(a, w * oh, len(teams)) + np.bincount(h, w * oa, len(teams))
                den = np.bincount(a, w * exp_h, len(teams)) + np.bincount(h, w * exp_a, len(teams))
                dfn = (num + tau0 * mean) / (den + tau0 * mean)
        for i in today:
            lam = mean * home * att[H[i]] * dfn[A[i]]; mu = mean / home * att[A[i]] * dfn[H[i]]
            g = np.array(score_grid(lam, mu, cfg.rho))
            out[i] = (np.tril(g, -1).sum(), np.trace(g), np.triu(g, 1).sum())
    return out

base_grid = a_all.probs
res = {}
for hl in (120, 240, 365, 730):
    for tau0 in (3, 6, 12):
        p = ipf_run(hl, tau0)
        res[(hl, tau0)] = p
        print(line(f"IPF hl={hl}d tau0={tau0} grid vs online grid", p, base_grid, A16))
        print(line(f"IPF hl={hl}d tau0={tau0} blended vs bundle", blend(e_all, p), full, A16))
best = min(res, key=lambda k: -np.log(res[k][np.arange(len(res[k])), np.where(HG > AG, 0, np.where(HG == AG, 1, 2))])[A16].mean())
print("best IPF in-sample:", best)
oos_report("IPF (blended) vs bundle", {"online": full, **{k: blend(e_all, v) for k, v in res.items()}}, "online")
