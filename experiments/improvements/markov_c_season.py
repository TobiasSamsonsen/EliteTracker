"""Step 3: season-level bounce-back. (a) descriptive tables of club-season residuals
against the shipped blend, relegated / promoted cohorts, the Brann / Viking /
Lillestrom type; (b) does last season's residual or table move predict the next
season's residual; (c) the same as a fitted walk-forward tilt on match odds; (d) the
within-season split-half (is first-half residual persistent into the second half).
"""
import sys, math
import numpy as np
import markov_common as M
import harness as H

CACHE = sys.argv[1]
d = M.build(cache=CACHE)
n = len(H.PLAYED)
elo, ad, mix = H.shipped()
LOGP = np.log(np.clip(mix, 1e-12, 1))
SEAS = H.SEASON
Y = H.Y

# ---- club-season table
keys = {}
for r in range(len(d["mi"])):
    keys.setdefault((d["team"][r], d["season"][r]), []).append(r)
cs = {}
for (t, s), rows in keys.items():
    rows = np.array(rows)
    lg = d["league"][rows[0]]
    pts = d["pts"][rows].sum()
    gd = (d["gf"][rows] - d["ga"][rows]).sum()
    xr = d["xgd_res"][rows]; has = ~np.isnan(xr)
    cs[(t, s)] = dict(team=t, season=s, league=lg, n=len(rows), pts=pts, gd=gd, xpts=d["xpts"][rows].sum(),
                      res=d["pts_res"][rows].mean(), res_sum=d["pts_res"][rows].sum(),
                      xgd=xr[has].mean() if has.sum() >= 10 else np.nan,
                      gdres=d["gd_res"][rows].mean(), rows=rows)
# final rank percentile within season-league (points, then gd)
by = {}
for k, v in cs.items(): by.setdefault((v["season"], v["league"]), []).append(k)
for (s, lg), ks in by.items():
    order = sorted(ks, key=lambda k: (-cs[k]["pts"], -cs[k]["gd"]))
    for i, k in enumerate(order):
        cs[k]["rank"] = i + 1; cs[k]["size"] = len(order); cs[k]["pct"] = 1 - i / (len(order) - 1)
# playoff-free: champion flag
for k, v in cs.items(): v["champ"] = v["rank"] == 1; v["top2"] = v["rank"] <= 2

def prev(k, back=1):
    return cs.get((k[0], k[1] - back))

print("seasons", sorted({k[1] for k in cs}), "club-seasons", len(cs))

# ---- (a) cohorts
def line(name, vals):
    vals = np.array([v for v in vals if not np.isnan(v)])
    if len(vals) < 2: print(f"  {name:<52} n={len(vals)}"); return
    print(f"  {name:<52} n={len(vals):<3} mean res/match {vals.mean():+.3f}  se {vals.std(ddof=1)/math.sqrt(len(vals)):.3f}  t {vals.mean()/(vals.std(ddof=1)/math.sqrt(len(vals))):+.2f}")

full = lambda v: v["n"] >= 20
print("\n=== (a) mean points residual per match vs the shipped blend, by cohort (positive = beat the model)")
rel_first, prom_first, rel_back, rel_stay = [], [], [], []
rows_list = []
for k, v in sorted(cs.items(), key=lambda kv: (kv[1]["season"], kv[0][0])):
    p = prev(k)
    if not (p and full(v) and full(p)) or v["season"] >= 2026: continue
    if p["league"] == "eliteserien" and v["league"] == "obosligaen":
        rel_first.append(v["res"]); rows_list.append(("REL->OBOS", v, p))
    if p["league"] == "obosligaen" and v["league"] == "eliteserien":
        prom_first.append(v["res"]); rows_list.append(("PROM->ES", v, p))
line("relegated ES -> OBOS: first OBOS season", rel_first)
line("promoted OBOS -> ES: first ES season", prom_first)
# second step of the cycle: relegated at s-1 (ES s-2), promoted at s (OBOS s-1 -> ES s)
bounce, bounce_obos, nonbounce_obos, bounce_champ = [], [], [], []
for k, v in cs.items():
    p, pp = prev(k), prev(k, 2)
    if not (p and pp and full(v) and full(p) and full(pp)) or v["season"] >= 2026: continue
    if pp["league"] == "eliteserien" and p["league"] == "obosligaen" and v["league"] == "eliteserien":
        bounce.append(v["res"]); bounce_obos.append(p["res"])
        if p["champ"] or p["top2"]: bounce_champ.append(v["res"])
    if pp["league"] == "eliteserien" and p["league"] == "obosligaen" and v["league"] == "obosligaen":
        nonbounce_obos.append(p["res"])
line("bounce-back (ES, OBOS, ES): their OBOS-year residual", bounce_obos)
line("bounce-back (ES, OBOS, ES): residual back in ES", bounce)
line("  of which promoted as OBOS top-2: residual back in ES", bounce_champ)
line("relegated and NOT promoted next year: their 2nd OBOS season", nonbounce_obos)
nonbounce2 = [v["res"] for k, v in cs.items() if prev(k) and prev(k, 2) and full(v) and v["season"] < 2026
              and prev(k, 2)["league"] == "eliteserien" and prev(k)["league"] == "obosligaen" and v["league"] == "obosligaen"]
line("  second OBOS season of those who stayed down", nonbounce2)
print("\n  every relegated-then-back-up club (the user's Brann / Viking / Lillestrom type):")
for k, v in sorted(cs.items(), key=lambda kv: kv[1]["season"]):
    p, pp = prev(k), prev(k, 2)
    if p and pp and pp["league"] == "eliteserien" and p["league"] == "obosligaen" and v["league"] == "eliteserien" and full(v):
        print(f"    {k[0]:<22} ES {pp['season']} (rank {pp['rank']}/{pp['size']}, res {pp['res']:+.2f}) -> OBOS {p['season']} (rank {p['rank']}/{p['size']}, res {p['res']:+.2f}) -> ES {v['season']} (rank {v['rank']}/{v['size']}, res {v['res']:+.2f}{' partial' if v['n']<28 else ''})")

# ---- (b) next season residual on this season's, clustered by club
print("\n=== (b) next-season mean residual on this-season state (club-season pairs, cluster = club)")
pairs = []
for k, v in cs.items():
    nx = cs.get((k[0], k[1] + 1))
    if nx and full(v) and nx["n"] >= 20 and v["season"] >= 2015 and nx["season"] <= 2025:
        pairs.append((v, nx))
cl = {t: i for i, t in enumerate(sorted({v["team"] for v, _ in pairs}))}
g = np.array([cl[v["team"]] for v, _ in pairs])
y = np.array([nx["res"] for v, nx in pairs])
print(f"  pairs {len(pairs)}  (next-season mean residual sd {y.std():.3f}; sampling sd about {1.15/math.sqrt(30):.3f})")
def reg(name, x, mask=None):
    x = np.asarray(x, float); ok = ~np.isnan(x) & (np.ones(len(x), bool) if mask is None else mask)
    if ok.sum() < 20: print(f"  {name:<46} n={ok.sum()} skipped"); return
    sd = x[ok].std()
    X = np.column_stack([np.ones(ok.sum()), (x[ok] - x[ok].mean()) / sd])
    b, se = M.cluster_ols(X, y[ok], g[ok])
    print(f"  {name:<46} n={ok.sum():<4} per 1sd {b[1]:+.4f} (t {b[1]/se[1]:+.2f})")
same = np.array([v["league"] == nx["league"] for v, nx in pairs])
reg("res(s) -> res(s+1), all", [v["res"] for v, _ in pairs])
reg("res(s) -> res(s+1), same division", [v["res"] for v, _ in pairs], same)
reg("res(s) -> res(s+1), changed division", [v["res"] for v, _ in pairs], ~same)
reg("xgd res(s) -> res(s+1)", [v["xgd"] for v, _ in pairs])
reg("gd res(s) -> res(s+1)", [v["gdres"] for v, _ in pairs])
reg("rank pct(s) - rank pct(s-1), same div", [ (v["pct"] - prev((v["team"], v["season"]))["pct"]) if prev((v["team"], v["season"])) and prev((v["team"], v["season"]))["league"] == v["league"] else np.nan for v, _ in pairs])
reg("rank pct(s)", [v["pct"] for v, _ in pairs])
reg("rank pct(s) (OBOS only)", [v["pct"] for v, _ in pairs], np.array([v["league"] == "obosligaen" for v, _ in pairs]))
reg("bad year: res(s) below -0.15", [min(v["res"] + 0.15, 0) for v, _ in pairs])
reg("big year: res(s) above +0.15", [max(v["res"] - 0.15, 0) for v, _ in pairs])
reg("relegated into OBOS at s (flag)", [float(nx["league"] == "obosligaen" and v["league"] == "eliteserien") for v, nx in pairs])
reg("champion/top-2 of OBOS at s (flag)", [float(v["league"] == "obosligaen" and v["top2"]) for v, _ in pairs])
reg("ES share of the last 4 seasons", [np.mean([1.0 if (cs.get((v['team'], v['season'] - j)) and cs[(v['team'], v['season'] - j)]['league'] == 'eliteserien') else 0.0 for j in range(4)]) for v, _ in pairs])

# ---- (c) walk-forward tilt with season-level features
def season_feats(r):
    t, s = d["team"][r], d["season"][r]
    p, pp = cs.get((t, s - 1)), cs.get((t, s - 2))
    cur = cs[(t, s)]
    f = {}
    f["prev_res"] = p["res"] if p and p["n"] >= 20 else 0.0
    f["prev_xgd"] = p["xgd"] if p and not np.isnan(p["xgd"]) else 0.0
    f["prev_bad"] = min(p["res"] + 0.15, 0) if p and p["n"] >= 20 else 0.0
    f["prev_big"] = max(p["res"] - 0.15, 0) if p and p["n"] >= 20 else 0.0
    f["prev_rankch"] = (p["pct"] - pp["pct"]) if p and pp and p["league"] == pp["league"] else 0.0
    f["rel"] = float(bool(p and p["league"] == "eliteserien" and cur["league"] == "obosligaen"))
    f["prom"] = float(bool(p and p["league"] == "obosligaen" and cur["league"] == "eliteserien"))
    f["prom_top2"] = float(bool(p and p["league"] == "obosligaen" and p["top2"] and cur["league"] == "eliteserien"))
    f["bounce"] = float(bool(p and pp and pp["league"] == "eliteserien" and p["league"] == "obosligaen" and cur["league"] == "eliteserien"))
    f["es_share4"] = np.mean([1.0 if cs.get((t, s - j)) and cs[(t, s - j)]["league"] == "eliteserien" else 0.0 for j in range(1, 5)])
    f["prev_pct"] = (p["pct"] - 0.5) if p else 0.0
    f["rel_x_prevres"] = f["rel"] * f["prev_res"]
    f["rel_bad"] = f["rel"] * 1.0 if (p and p["res"] < 0) else 0.0
    return f
FE = [season_feats(r) for r in range(len(d["mi"]))]
names = list(FE[0].keys())
FM = {k: np.array([f[k] for f in FE]) for k in names}
DX = lambda cols: np.column_stack([FM[c] for c in cols])
Dd = lambda cols: (lambda F: F[0::2] - F[1::2])(DX(cols))

def wf(X, ridge, first=2019):
    out = mix.copy()
    for s in range(first, int(SEAS.max()) + 1):
        tr = (SEAS >= 2016) & (SEAS < s); te = SEAS == s
        b = M.fit(X[tr], LOGP[tr], Y[tr], ridge)
        out[te] = M.tilt(X[te], LOGP[te], b)
    keep = SEAS >= first
    L, L0 = H.losses(out), H.losses(mix)
    dd = {k: (L[k] - L0[k])[keep] for k in L}
    v = dd["ll"]; h = len(v) // 2
    return v.mean(), H.tstat(v), dd["brier"].mean(), dd["rps"].mean(), v[:h].mean(), v[h:].mean()

print("\n=== (c) walk-forward tilt with season-level features (2019+, fitted on earlier seasons; negative = better than shipped)")
import itertools
sets = [[c] for c in names] + [["prev_res", "prev_xgd"], ["prev_bad", "prev_big"], ["rel", "prom", "bounce"], ["rel", "prom", "bounce", "prev_res"],
        ["prev_res", "prev_rankch", "rel", "prom", "bounce", "es_share4"], ["prev_res", "prev_xgd", "prev_bad", "prev_big", "prev_rankch", "rel", "prom", "prom_top2", "bounce", "es_share4"]]
res = []
for cols in sets:
    for r in (1.0, 30.0, 300.0):
        st = wf(Dd(cols), r)
        res.append((cols, r, st))
for cols, r, st in sorted(res, key=lambda x: x[2][0])[:20]:
    print(f"  {','.join(cols):<70} ridge {r:<5} dLL {st[0]:+.5f} t{st[1]:+5.2f} Br{st[2]:+.5f} RPS{st[3]:+.5f}  halves {st[4]:+.5f}/{st[5]:+.5f}")
print(f"  ({len(res)} configs; share dLL<0: {np.mean([x[2][0]<0 for x in res]):.2f})")

# ---- (d) split-half within season
print("\n=== (d) within-season persistence: first-half residual vs second-half (per club-season, cluster = club)")
fh, sh, fx, sx, gg = [], [], [], [], []
cmap = {}
for k, v in cs.items():
    if v["n"] < 24: continue
    rows = np.sort(v["rows"]); h = len(rows) // 2
    a, b = rows[:h], rows[h:]
    fh.append(d["pts_res"][a].mean()); sh.append(d["pts_res"][b].mean())
    xa_, xb_ = d["xgd_res"][a], d["xgd_res"][b]
    fx.append(np.nanmean(xa_) if (~np.isnan(xa_)).sum() >= 6 else np.nan); sx.append(np.nanmean(xb_) if (~np.isnan(xb_)).sum() >= 6 else np.nan)
    gg.append(cmap.setdefault(k[0], len(cmap)))
fh, sh, fx, sx, gg = map(np.array, (fh, sh, fx, sx, gg))
def sp(name, a, b):
    ok = ~np.isnan(a) & ~np.isnan(b)
    X = np.column_stack([np.ones(ok.sum()), a[ok]]); beta, se = M.cluster_ols(X, b[ok], gg[ok])
    print(f"  {name:<40} n={ok.sum():<4} slope {beta[1]:+.3f} (t {beta[1]/se[1]:+.2f})  corr {np.corrcoef(a[ok], b[ok])[0,1]:+.3f}")
sp("pts residual: H1 -> H2", fh, sh)
sp("xGD residual: H1 -> H2", fx, sx)
sp("xGD residual H1 -> pts residual H2", fx, sh)
# excess variance of the club-season mean residual over the sampling variance (what a constant strength shock stands for)
allres = np.array([v["res"] for v in cs.values() if v["n"] >= 24])
samp = np.mean([ (d["pts_res"][v["rows"]].var(ddof=1) / v["n"]) for v in cs.values() if v["n"] >= 24])
print(f"  season mean pts residual: sd {allres.std():.3f} vs pure sampling sd {math.sqrt(samp):.3f} -> persistent club-season component sd {math.sqrt(max(allres.var()-samp,0)):.3f} points/match")


# ---- (e) permutation null for (c): shuffle whole club-season feature vectors among the clubs of the same season
if len(sys.argv) > 2:
    NPERM = int(sys.argv[2])
    best_cfg = min(res, key=lambda x: x[2][0])
    best_ll = best_cfg[2][0]
    best_t = min(x[2][1] for x in res)
    print(f"\n=== (e) null for the {len(res)} season-level configs: real best dLL {best_ll:+.5f}, best t {best_t:+.2f}")
    for cols in (["rel_x_prevres"], ["prev_bad"]):
        beta = M.fit(Dd(cols)[(SEAS >= 2016)], LOGP[(SEAS >= 2016)], Y[(SEAS >= 2016)], 1.0)
        print(f"  fitted on all seasons, {cols}: beta {beta.round(4)}  (psi > 0 favours the home side: positive beta on a 'bad year' feature (<= 0) means a bad year is followed by doing WORSE than the blend; negative = BETTER, a rebound)")
    FM0 = FM
    first_row = {}
    for r in range(len(d["mi"])): first_row.setdefault((d["team"][r], d["season"][r]), r)
    by_season = {}
    for (t, s), r in first_row.items(): by_season.setdefault(s, []).append((t, r))
    rng = np.random.default_rng(99)
    null_ll, null_t = [], []
    for it in range(NPERM):
        src = np.arange(len(d["mi"]))
        for s, lst in by_season.items():
            order = rng.permutation(len(lst))
            for (t, r), j in zip(lst, order):
                rows = np.nonzero((d["team"] == t) & (d["season"] == s))[0]
                src[rows] = lst[j][1]
        FM = {k: v[src] for k, v in FM0.items()}
        out = [wf(Dd(cols), r) for cols in sets for r in (1.0, 30.0, 300.0)]
        null_ll.append(min(o[0] for o in out)); null_t.append(min(o[1] for o in out))
    null_ll, null_t = np.array(null_ll), np.array(null_t)
    print(f"  {NPERM} shuffles: best dLL mean {null_ll.mean():+.5f} (min {null_ll.min():+.5f}), best t mean {null_t.mean():+.2f} (min {null_t.min():+.2f})")
    print(f"  share of shuffles at least as good as the real best: dLL {np.mean(null_ll <= best_ll):.2f}, t {np.mean(null_t <= best_t):.2f}")
