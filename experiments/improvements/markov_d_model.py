"""Step 4: (1) an explicit Markov-chain test of the residual sequences (state
transition counts vs independence, permuted within club-season); (2) the shock
as a model change, not a post-hoc tilt: Elo step bigger/smaller for big surprises
(`change` hook), and the goals model's step bigger/smaller for big goal
surprises (up-only, down-only, symmetric)."""
import sys, math, time
import numpy as np
import markov_common as M
import harness as H
from elitetracker.model.attack_defence import ADConfig
from elitetracker.model.career import team_ids

CACHE = sys.argv[1]
d = M.build(cache=CACHE)
rng = np.random.default_rng(7)

# ------------------------------------------------ (1) Markov chain test
print("=== (1) Markov-chain test: does the residual state at t move the state at t+1?")
print("    chi-square of the transition table vs independence; p from 600 within-club-season shuffles (the home/away alternation makes this null wrong for points z, see markov_e_followups.py)")
grp = M.cluster_ids(d)
order0 = np.argsort(d["mi"], kind="stable")
def chi2(a, b, k):
    T = np.zeros((k, k)); np.add.at(T, (a, b), 1)
    E = T.sum(1, keepdims=True) * T.sum(0, keepdims=True) / T.sum()
    return ((T - E) ** 2 / np.maximum(E, 1e-9)).sum(), T
def states(x, k):
    q = np.nanpercentile(x, np.linspace(0, 100, k + 1)[1:-1])
    s = np.digitize(x, q); s[np.isnan(x)] = -1
    return s
def seqpairs(s, perm_keys, lag):
    # rows sorted by (group, key); a pair is two rows 'lag' apart in the same group
    o = np.lexsort((perm_keys, grp))
    g = grp[o]; ss = s[o]
    a, b = ss[:-lag], ss[lag:]
    ok = (g[:-lag] == g[lag:]) & (a >= 0) & (b >= 0)
    return a[ok], b[ok]
base_key = d["mi"].astype(float)
for sig in ["z_pts", "gd_res", "xgd_res", "xgpts_res", "xg_res", "xga_res", "luck_res", "fin_res"]:
    for k in (3, 5):
        s = states(d[sig], k)
        for lag in (1, 2):
            a, b = seqpairs(s, base_key, lag)
            obs, T = chi2(a, b, k)
            null = []
            for _ in range(600):
                a2, b2 = seqpairs(s, rng.random(len(s)), lag)
                null.append(chi2(a2, b2, k)[0])
            null = np.array(null)
            p = (1 + (null >= obs).sum()) / (1 + len(null))
            ex = T / T.sum(1, keepdims=True)
            print(f"  {sig:<10} {k} states lag {lag}: chi2 {obs:6.1f} (null mean {null.mean():5.1f}) p={p:.3f}  P(top|top) {ex[-1,-1]:.3f} vs base {T.sum(0)[-1]/T.sum():.3f}; P(bottom|bottom) {ex[0,0]:.3f} vs {T.sum(0)[0]/T.sum():.3f}")

# ------------------------------------------------ (2) model-level shocks
elo0 = H.elo_run()
ad0 = H.ad_run()
mix0 = H.blend(elo0, ad0.probs)
keeps = {"all16": H.WINDOWS["all16"], "xg": H.WINDOWS["xg"]}
def show(name, mix):
    c = H.compare(mix, mix0, keeps["all16"]); cx = H.compare(mix, mix0, keeps["xg"])
    h = c["ll_halves"]
    return (f"{name:<34} all16 LL {c['ll'][0]:+.5f} (t{c['ll'][1]:+5.2f}) RPS {c['rps'][0]:+.5f} halves {h[0]:+5.2f}/{h[1]:+5.2f} | xg LL {cx['ll'][0]:+.5f} (t{cx['ll'][1]:+5.2f})")

print("\n=== (2a) Elo: step on a big surprise multiplied by (1 + a) when |scored - expected| > c")
elo_var = {}
t0 = time.time()
for c in (0.25, 0.35, 0.45, 0.55, 0.7, 0.9):
    for a in (-0.75, -0.5, -0.25, 0.25, 0.5, 1.0, 2.0):
        def change(k, scored, expected, hxg, axg, cfg, a=a, c=c):
            s = scored - expected
            return k * s * (1.0 + (a if abs(s) > c else 0.0))
        e = H.elo_run(H.EloRun(change=change))
        elo_var[("elo", a, c)] = e
print(f"  ({len(elo_var)} Elo runs, {time.time()-t0:.0f}s)")
rows = []
for key, e in elo_var.items():
    mx = H.blend(e, ad0.probs)
    cmp = H.compare(mx, mix0, keeps["all16"])
    rows.append((cmp["ll"][0], key, show(f"Elo a={key[1]:+.2f} c={key[2]:.2f}", mx)))
for _, key, txt in sorted(rows)[:10]: print("  " + txt)
print("   ... worst: " + sorted(rows)[-1][2])
print(f"  share of Elo cells with dLL<0: {np.mean([r[0]<0 for r in rows]):.2f}")

print("\n=== (2b) goals model: surprise g(s) = s*(1 + a) when s beyond c goals (mode: sym / up only / down only)")
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
            self.attack[home] += kh * hs
            self.defence[away] -= ka * hs
            self.attack[away] += ka * as_
            self.defence[home] -= kh * as_
            self._played[home] = self._played.get(home, 0) + 1
            self._played[away] = self._played.get(away, 0) + 1
            if cfg.finishing_regression < 1.0:
                shots = self.shots.get(match.match_id)
                if shots and match.home_goals is not None and match.away_goals is not None:
                    self._season_goals[home] = self._season_goals.get(home, 0.0) + match.home_goals
                    self._season_xg[home] = self._season_xg.get(home, 0.0) + shots[0]
                    self._season_goals[away] = self._season_goals.get(away, 0.0) + match.away_goals
                    self._season_xg[away] = self._season_xg.get(away, 0.0) + shots[1]
            self._record_keeping(match)
    return ADS
ident = H.ad_run(cls=make_ad("sym", 0.0, 1.0))
print(f"  identity (a=0): max diff {abs(ident.probs - ad0.probs).max():.2e}")
t0 = time.time(); rows2 = []
for mode in ("sym", "up", "dn"):
    for c in (0.5, 0.8, 1.2, 1.8):
        for a in (-0.6, -0.3, 0.3, 0.6, 1.0, 2.0):
            ad = H.ad_run(cls=make_ad(mode, a, c))
            mx = H.blend(elo0, ad.probs)
            cmp = H.compare(mx, mix0, keeps["all16"])
            rows2.append((cmp["ll"][0], (mode, a, c), show(f"AD {mode} a={a:+.1f} c={c:.1f}", mx)))
print(f"  ({len(rows2)} goals-model runs, {time.time()-t0:.0f}s)")
for _, key, txt in sorted(rows2)[:12]: print("  " + txt)
print("   ... worst: " + sorted(rows2)[-1][2])
print(f"  share of goals-model cells with dLL<0: {np.mean([r[0]<0 for r in rows2]):.2f}")
# walk-forward pick across the whole shock family (both models), the ship rule
variants = {"base": mix0}
for key, e in elo_var.items(): variants[key] = H.blend(e, ad0.probs)
H.oos_report("Elo shock grid", variants, "base")
