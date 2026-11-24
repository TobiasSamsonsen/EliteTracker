"""Step 5: (1) the Markov-chain test again with the right null (shuffle states among
the club-season's matches of the SAME side, so home/away alternation, which made
z_pts' lag-2 'dependence' in step 4, is kept); (2) the goals-model shock grid walk-forward;
(3) does the spread of a club-season's residual depend on its cohort (a bigger strength
shock for clubs that just changed division?)."""
import sys, math
import numpy as np
import markov_common as M
import harness as H
from elitetracker.model.career import team_ids

CACHE = sys.argv[1]
d = M.build(cache=CACHE)
rng = np.random.default_rng(11)
grp = M.cluster_ids(d)
side = d["side"]
mi = d["mi"]
idx_c = np.lexsort((mi, side, grp))          # chronological inside each (club-season, side) block
chrono = np.lexsort((mi, grp))
def states(x, k):
    q = np.nanpercentile(x, np.linspace(0, 100, k + 1)[1:-1])
    s = np.digitize(x, q); s[np.isnan(x)] = -1
    return s
def pairs(s, lag):
    o = chrono; g = grp[o]; ss = s[o]
    a, b = ss[:-lag], ss[lag:]
    ok = (g[:-lag] == g[lag:]) & (a >= 0) & (b >= 0)
    return a[ok], b[ok]
def chi2(a, b, k):
    T = np.zeros((k, k)); np.add.at(T, (a, b), 1)
    E = T.sum(1, keepdims=True) * T.sum(0, keepdims=True) / T.sum()
    return ((T - E) ** 2 / np.maximum(E, 1e-9)).sum()
def shuffled(s):
    idx_p = np.lexsort((rng.random(len(s)), side, grp))
    sp = np.empty_like(s); sp[idx_c] = s[idx_p]
    return sp
print("=== (1) Markov-chain test, null = shuffle within club-season AND side (1000 shuffles)")
ps = []
for sig in ["z_pts", "gd_res", "gf_res", "ga_res", "xgd_res", "xgpts_res", "xg_res", "xga_res", "luck_res", "fin_res", "keep_res"]:
    out = []
    for k in (3, 5):
        s = states(d[sig], k)
        for lag in (1, 2, 3):
            obs = chi2(*pairs(s, lag), k)
            null = np.array([chi2(*pairs(shuffled(s), lag), k) for _ in range(1000)])
            p = (1 + (null >= obs).sum()) / 1001
            ps.append(p); out.append(f"{k}st/lag{lag} p={p:.3f}")
    print(f"  {sig:<10} " + "  ".join(out))
ps = np.array(ps)
print(f"  {len(ps)} tests: p<0.05 in {int((ps<0.05).sum())} (chance alone gives {0.05*len(ps):.1f}), p<0.01 in {int((ps<0.01).sum())}; min p {ps.min():.3f}")

# ---- (3) spread of club-season residual by cohort
keys = {}
for r in range(len(d["mi"])): keys.setdefault((d["team"][r], d["season"][r]), []).append(r)
info = {}
for (t, s), rows in keys.items():
    rows = np.array(rows)
    info[(t, s)] = (d["league"][rows[0]], len(rows), d["pts_res"][rows].mean(), d["pts_res"][rows].var(ddof=1) / len(rows))
groups = {"ES stable": [], "OBOS stable": [], "promoted": [], "relegated": [], "OBOS new/other": []}
for (t, s), (lg, n, res, sv) in info.items():
    if n < 24 or s == 2026: continue
    p = info.get((t, s - 1))
    if p is None: continue
    if p[0] == "eliteserien" and lg == "eliteserien": groups["ES stable"].append((res, sv))
    elif p[0] == "obosligaen" and lg == "obosligaen": groups["OBOS stable"].append((res, sv))
    elif p[0] == "obosligaen" and lg == "eliteserien": groups["promoted"].append((res, sv))
    elif p[0] == "eliteserien" and lg == "obosligaen": groups["relegated"].append((res, sv))
print("\n=== (3) club-season mean points residual: spread by cohort (the persistent part = what a strength shock stands for)")
for name, v in groups.items():
    a = np.array(v)
    if len(a) < 5: continue
    pers = math.sqrt(max(a[:, 0].var(ddof=1) - a[:, 1].mean(), 0))
    print(f"  {name:<16} n={len(a):<3} mean {a[:,0].mean():+.3f}  sd {a[:,0].std(ddof=1):.3f}  sampling sd {math.sqrt(a[:,1].mean()):.3f}  persistent sd {pers:.3f} pts/match")

# ---- (2) goals-model shock grid, walk-forward
print("\n=== (2) goals-model shock grid, walk-forward (72 cells, pick from earlier seasons)")
elo0 = H.elo_run(); ad0 = H.ad_run(); mix0 = H.blend(elo0, ad0.probs)
def make_ad(mode, a, c):
    class ADS(H.ADX):
        def observe(self, match):
            home, away = team_ids(match)
            lam, mu = self._learning_rates(home, away, match.date)
            obs_home, obs_away, k = self.observed(match)
            cfg = self.config
            def g(s):
                s = max(-cfg.cap, min(cfg.cap, s))
                hit = abs(s) > c and (mode == "sym" or (mode == "up" and s > 0) or (mode == "dn" and s < 0))
                return s * (1.0 + a) if hit else s
            hs, as_ = g(obs_home - lam), g(obs_away - mu)
            kh, ka = k * self._early(home), k * self._early(away)
            self.attack[home] += kh * hs; self.defence[away] -= ka * hs
            self.attack[away] += ka * as_; self.defence[home] -= kh * as_
            self._played[home] = self._played.get(home, 0) + 1; self._played[away] = self._played.get(away, 0) + 1
            if cfg.finishing_regression < 1.0:
                shots = self.shots.get(match.match_id)
                if shots and match.home_goals is not None and match.away_goals is not None:
                    self._season_goals[home] = self._season_goals.get(home, 0.0) + match.home_goals
                    self._season_xg[home] = self._season_xg.get(home, 0.0) + shots[0]
                    self._season_goals[away] = self._season_goals.get(away, 0.0) + match.away_goals
                    self._season_xg[away] = self._season_xg.get(away, 0.0) + shots[1]
            self._record_keeping(match)
    return ADS
variants = {"base": mix0}
for mode in ("sym", "up", "dn"):
    for c in (0.5, 0.8, 1.2, 1.8):
        for a in (-0.6, -0.3, 0.3, 0.6, 1.0, 2.0):
            variants[(mode, a, c)] = H.blend(elo0, H.ad_run(cls=make_ad(mode, a, c)).probs)
H.oos_report("goals-model shock grid", variants, "base")
