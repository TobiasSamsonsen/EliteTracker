"""Step 2: the big sweep. A prediction-time tilt on the shipped blend's odds,
driven by each club's recent residual 'state' (every feature built from earlier
matches of the same club-season only), fitted walk-forward: each season from 2019
is scored with coefficients fitted on 2016..season-1 only.

    p'(H) ~ p(H) exp(+psi/2), p'(A) ~ p(A) exp(-psi/2), p'(D) = p(D);
    psi = beta . (F_home - F_away)

beta = 0 is the shipped blend. Also runs a permutation null (the same sweep with the
state features shuffled among club-rows of the same season) to price the best-of-N
selection effect.
"""
import sys, math, time, itertools, json
import numpy as np
import markov_common as M
import harness as H

CACHE = sys.argv[1]
NPERM = int(sys.argv[2]) if len(sys.argv) > 2 else 20
d = M.build(cache=CACHE)
n = len(H.PLAYED)
Y = H.Y
SEAS = H.SEASON
mix = None

def get_mix():
    global mix
    elo, ad, mix = H.shipped()
    return mix

mix = get_mix()
LOGP = np.log(np.clip(mix, 1e-12, 1))
U = np.array([0.5, 0.0, -0.5])
PREV = {k: M.group_prev(d, k) for k in range(1, 6)}

SIGS = ["z_pts", "gd_res", "gf_res", "ga_res", "xg_res", "xga_res", "xgd_res", "xgpts_res", "luck_res", "fin_res", "keep_res"]
Z = {s: d[s] / np.nanstd(d[s]) for s in SIGS}

def lagmat(s, k=5):
    x = Z[s]
    out = np.full((len(x), k), np.nan)
    for j in range(1, k + 1):
        p = PREV[j]
        ok = p >= 0
        out[ok, j - 1] = x[p[ok]]
    return out

LAGS = {s: lagmat(s) for s in SIGS}
nz = lambda a: np.nan_to_num(a, nan=0.0)

def feats(s, kind, p=None):
    L = LAGS[s]
    s1 = L[:, 0]
    if kind == "lin1":
        return [nz(s1)]
    if kind == "lin2":
        return [nz(L[:, 0]), nz(L[:, 1])]
    if kind == "pw":
        c = p
        return [nz(np.clip(s1, -c, c)), nz(np.maximum(s1 - c, 0)), nz(np.minimum(s1 + c, 0))]
    if kind == "tails":
        c = p
        return [nz(np.maximum(s1 - c, 0)), nz(np.minimum(s1 + c, 0))]
    if kind == "state":
        c = p
        return [nz(s1 > c).astype(float), nz(s1 < -c).astype(float)]
    if kind == "avg":
        k = p
        with np.errstate(all="ignore"):
            a = np.nanmean(L[:, :k], axis=1)
        return [nz(a)]
    if kind == "ewma":
        a = p
        w = np.array([a * (1 - a) ** j for j in range(5)])
        num = np.nansum(L * w, axis=1)
        return [num]
    if kind == "avgtails":
        k, c = p
        with np.errstate(all="ignore"):
            a = np.nanmean(L[:, :k], axis=1)
        return [nz(np.maximum(a - c, 0)), nz(np.minimum(a + c, 0))]
    if kind == "seq2":
        c = p
        return [nz((L[:, 0] < -c) & (L[:, 1] < -c)).astype(float), nz((L[:, 0] > c) & (L[:, 1] > c)).astype(float)]
    if kind == "rebound":      # shock then what followed: tail at lag 2 times the lag-1 value
        c = p
        t2 = (L[:, 1] < -c)
        t2u = (L[:, 1] > c)
        return [nz(t2 * L[:, 0]), nz(t2u * L[:, 0])]
    raise KeyError(kind)

def fit(X, lp, y, ridge, iters=25):
    beta = np.zeros(X.shape[1])
    for _ in range(iters):
        psi = X @ beta
        lg = lp + psi[:, None] * U
        lg -= lg.max(1, keepdims=True)
        pr = np.exp(lg); pr /= pr.sum(1, keepdims=True)
        Eu = pr @ U
        g = X.T @ (U[y] - Eu) - ridge * beta
        var = pr @ (U ** 2) - Eu ** 2
        Hs = X.T @ (X * var[:, None]) + ridge * np.eye(X.shape[1])
        step = np.linalg.solve(Hs, g)
        beta += step
        if np.abs(step).max() < 1e-7: break
    return beta

def tilt(X, lp, beta):
    psi = X @ beta
    lg = lp + psi[:, None] * U
    lg -= lg.max(1, keepdims=True)
    pr = np.exp(lg); return pr / pr.sum(1, keepdims=True)

LL0 = H.losses(mix)
FIRST = 2019

def oos_eval(X, ridge, perm_seed=None):
    """walk-forward; returns per-match diffs (LL, Brier, RPS) over seasons >= FIRST."""
    out = mix.copy()
    for s in range(FIRST, int(SEAS.max()) + 1):
        tr = (SEAS >= 2016) & (SEAS < s)
        te = SEAS == s
        b = fit(X[tr], LOGP[tr], Y[tr], ridge)
        out[te] = tilt(X[te], LOGP[te], b)
    keep = SEAS >= FIRST
    L = H.losses(out)
    return {k: (L[k] - LL0[k])[keep] for k in L}, out

def summarize(dd):
    v = dd["ll"]
    half = len(v) // 2
    return v.mean(), H.tstat(v), dd["brier"].mean(), dd["rps"].mean(), v[:half].mean(), v[half:].mean()

def diffX(cols):
    F = np.column_stack(cols)
    return F[0::2] - F[1::2]

# --- the sweep ---
specs = []
for s in SIGS:
    specs += [(s, "lin1", None), (s, "lin2", None)]
    for c in (1.0, 1.5, 2.0, 2.5):
        specs += [(s, "pw", c), (s, "tails", c), (s, "state", c), (s, "seq2", c), (s, "rebound", c)]
    for k in (2, 3, 5):
        specs += [(s, "avg", k)]
    for a in (0.2, 0.35, 0.5, 0.7):
        specs += [(s, "ewma", a)]
    for k in (3, 5):
        for c in (0.5, 1.0):
            specs += [(s, "avgtails", (k, c))]
RIDGES = (1.0, 100.0)
print(f"{len(specs)} feature sets x {len(RIDGES)} ridges = {len(specs)*len(RIDGES)} configs; match-level matches scored: {(SEAS>=FIRST).sum()}")

def sweep(shuffle=None):
    res = []
    for (s, kind, p) in specs:
        cols = feats(s, kind, p)
        if shuffle is not None:
            cols = [c[shuffle] for c in cols]
        X = diffX(cols)
        for r in RIDGES:
            dd, _ = oos_eval(X, r)
            res.append(((s, kind, p, r), summarize(dd)))
    return res

t0 = time.time()
real = sweep()
print(f"sweep {time.time()-t0:.1f}s")
real_sorted = sorted(real, key=lambda r: r[1][0])
print("\nTOP 25 configs by out-of-sample mean LL difference vs the shipped blend (negative = better):")
print("   (signal, kind, param, ridge)   dLL  t  dBrier  dRPS  halfA halfB")
for (cfg, st) in real_sorted[:25]:
    print(f"   {str(cfg):<44} {st[0]:+.5f} t{st[1]:+5.2f} Br{st[2]:+.5f} RPS{st[3]:+.5f}  {st[4]:+.5f}/{st[5]:+.5f}")
print("\nWORST 5:")
for (cfg, st) in real_sorted[-5:]:
    print(f"   {str(cfg):<44} {st[0]:+.5f} t{st[1]:+5.2f}")
allt = np.array([st[1] for _, st in real]); allm = np.array([st[0] for _, st in real])
print(f"\nall {len(real)} configs: mean dLL {allm.mean():+.5f}, share with dLL<0: {(allm<0).mean():.2f}, min t {allt.min():+.2f}, max t {allt.max():+.2f}")
best_real = min(allt)

# permutation null: shuffle the state features among club-rows of the same season
rng = np.random.default_rng(20261123)
rows_by_season = {s: np.nonzero(d["season"] == s)[0] for s in np.unique(d["season"])}
null_best_t, null_best_m = [], []
for it in range(NPERM):
    perm = np.arange(len(d["mi"]))
    for s, idx in rows_by_season.items():
        perm[idx] = rng.permutation(idx)
    # shuffle whole club-rows; home/away pairing broken but marginal and season structure kept
    t0 = time.time()
    res = sweep(shuffle=perm)
    ts = np.array([st[1] for _, st in res]); ms = np.array([st[0] for _, st in res])
    null_best_t.append(ts.min()); null_best_m.append(ms.min())
    print(f"perm {it}: best t {ts.min():+.2f}, best dLL {ms.min():+.5f} ({time.time()-t0:.0f}s)", flush=True)
print(f"\nNULL best-of-{len(specs)*len(RIDGES)}: t mean {np.mean(null_best_t):+.2f}, min {np.min(null_best_t):+.2f}; dLL mean {np.mean(null_best_m):+.5f}, min {np.min(null_best_m):+.5f}")
print(f"REAL best-of-N: t {best_real:+.2f}, dLL {min(allm):+.5f}; share of permutations at least as good (t): {(np.array(null_best_t) <= best_real).mean():.2f}")
