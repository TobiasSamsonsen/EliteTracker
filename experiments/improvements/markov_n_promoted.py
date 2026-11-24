"""Step 13: a prior for clubs that change division, from their long-run level (the standings
history back to 1963, markov_m_history.py's ladder score). For a club that came up (OBOS ->
Eliteserien), came down, or has no row in the season before (up from the third tier): level =
EWMA (memory 0.9 / 0.95) of its ladder scores through LAST season, minus the division's mean of the
same. (a) club-season residual against the blend on level, n about 24 a group; (b) walk-forward
tilt on the match odds with level x (mover flag), 16 configs, null = level shuffled among the
movers of the same kind over all seasons.

    markov_n_promoted.py CACHE [NPERM]
"""
import sys, json, unicodedata, math
from pathlib import Path
import numpy as np
import markov_common as M
import harness as H
from elitetracker.model.career import team_ids

CACHE = sys.argv[1]; NPERM = int(sys.argv[2]) if len(sys.argv) > 2 else 0
d = M.build(cache=CACHE)
elo0 = H.elo_run(); ad0 = H.ad_run(); mix0 = H.blend(elo0, ad0.probs)
LOGP = np.log(np.clip(mix0, 1e-12, 1)); SEAS = H.SEASON; Y = H.Y
HIST = json.loads((Path(__file__).resolve().parents[2] / "data" / "history_standings.json").read_text(encoding="utf-8"))
ALIAS = {"odd grenland": "odd", "odds ballklubb": "odd", "ham-kam": "hamkam", "hamarkameratene": "hamkam", "honefoss bk": "honefoss",
         "l/f honefoss": "honefoss", "kristiansund bk": "kristiansund", "sandefjord bk": "sandefjord", "vif fotball": "valerenga",
         "valerengen": "valerenga", "pors grenland": "pors", "vard haugesund": "vard", "sarpsborg fk": "sarpsborg 08", "sarpsborg": "sarpsborg 08", "gjovik-lyn": "lyn"}
def key2(name):
    low = name.lower().replace("\xf8", "o").replace("\xe5", "a").replace("\xe6", "ae")
    low = unicodedata.normalize("NFKD", low).encode("ascii", "ignore").decode().strip()
    return ALIAS.get(low, low)
names = {}
for m, lg, s in H.PLAYED:
    for side, t in enumerate(team_ids(m)): names[t] = m.home if side == 0 else m.away
ID2KEY = {t: key2(n) for t, n in names.items()}
SCORE = {}
for year in range(1963, 2016):
    t1 = HIST["tier1"].get(str(year)); t2 = HIST["tier2"].get(str(year))
    if not t1: continue
    n1 = len(t1); rank = {r_["team"] and key2(r_["team"]): r_["pos"] for r_ in t1}
    if t2:
        G = len({r_.get("group", 0) for r_ in t2}); n2 = len(t2)
        for r_ in t2: rank[key2(r_["team"])] = n1 + (r_["pos"] - 1) * G + r_.get("group", 0) + 1 if G > 1 else n1 + r_["pos"]
        floor, denom = n1 + n2 + 8, n1 + n2 + 16
    else:
        floor, denom = n1 + 16, n1 + 14 + 16
    for k in set(ID2KEY.values()) | set(rank): SCORE[(k, year)] = 1 - rank.get(k, floor) / denom
fin = {}
for m, lg, s in H.PLAYED:
    if s < 2016: continue
    for side, t in enumerate(team_ids(m)):
        g = fin.setdefault((s, lg), {}).setdefault(t, [0, 0])
        gf, ga = (m.home_goals, m.away_goals) if side == 0 else (m.away_goals, m.home_goals)
        g[0] += 3 if gf > ga else (1 if gf == ga else 0); g[1] += gf - ga
for s in range(2016, 2027):
    t1 = sorted(fin.get((s, "eliteserien"), {}).items(), key=lambda kv: (-kv[1][0], -kv[1][1]))
    t2 = sorted(fin.get((s, "obosligaen"), {}).items(), key=lambda kv: (-kv[1][0], -kv[1][1]))
    n1, n2 = len(t1) or 16, len(t2) or 16; rank = {}
    for i, (t, _) in enumerate(t1): rank[ID2KEY[t]] = i + 1
    for i, (t, _) in enumerate(t2): rank[ID2KEY[t]] = n1 + i + 1
    for k in set(ID2KEY.values()): SCORE[(k, s)] = 1 - rank.get(k, n1 + n2 + 8) / (n1 + n2 + 16)
DIV = {}
for r in range(len(d["mi"])): DIV[(d["team"][r], d["season"][r])] = d["league"][r]
keys = {}
for r in range(len(d["mi"])): keys.setdefault((d["team"][r], d["season"][r]), []).append(r)
RES = {k: d["pts_res"][np.array(rr)].mean() for k, rr in keys.items() if len(rr) >= 20}

def level_table(delta):
    out = {}
    for s in range(2016, 2027):
        ids = [t for (t, ss) in DIV if ss == s]
        A = {}
        for t in ids:
            k = ID2KEY[t]; num = wsum = 0.0
            for y in range(1963, s):
                w = delta ** (s - 1 - y); num += w * SCORE[(k, y)]; wsum += w
            A[t] = num / wsum
        for lg in ("eliteserien", "obosligaen"):
            idl = [t for t in A if DIV.get((t, s)) == lg]
            if not idl: continue
            mean = np.mean([A[t] for t in idl])
            for t in idl:
                prev = DIV.get((t, s - 1)); cur = lg
                kind = "prom" if (prev == "obosligaen" and cur == "eliteserien") else "rel" if (prev == "eliteserien" and cur == "obosligaen") else "new" if prev is None and s > 2016 else None
                out[(t, s)] = ((A[t] - mean) * 10, kind)
    return out

print("(a) first season after a move: club-season points residual a match against the blend vs the club's long-run level (x10, memory 0.9)")
LT = level_table(0.9)
cl = {t: i for i, t in enumerate(sorted({t for (t, s) in LT}))}
for kind in ("prom", "rel", "new"):
    rows = [(t, s, LT[(t, s)][0], RES[(t, s)]) for (t, s) in sorted(LT, key=lambda x: x[1]) if LT[(t, s)][1] == kind and (t, s) in RES and s <= 2025]
    if len(rows) < 6: print(f"  {kind}: n={len(rows)}"); continue
    lv = np.array([r[2] for r in rows]); y = np.array([r[3] for r in rows]); g = np.array([cl[r[0]] for r in rows])
    X = np.column_stack([np.ones(len(rows)), (lv - lv.mean()) / lv.std()]); b, se = M.cluster_ols(X, y, g)
    print(f"  {kind}: n={len(rows)}  mean residual {y.mean():+.3f}  per 1 sd of level {b[1]:+.3f} (t {b[1]/se[1]:+.2f}); corr {np.corrcoef(lv, y)[0,1]:+.2f}")
    if kind == "prom":
        for t, s, l, r_ in rows: print(f"      {s} {names[t]:<16} level {l:+5.2f} residual {r_:+.2f}")

def feat_rows(delta, kinds_sets):
    LTd = level_table(delta); F = np.zeros((len(d["mi"]), len(kinds_sets)))
    for r in range(len(d["mi"])):
        v = LTd.get((d["team"][r], d["season"][r]))
        if v and v[1]:
            for j, ks in enumerate(kinds_sets):
                if v[1] in ks: F[r, j] = v[0]
    return F
SETS = {"prom x level": [("prom",)], "rel x level": [("rel",)], "prom, rel x level": [("prom",), ("rel",)], "all movers x level": [("prom", "rel", "new")]}
def wf(X, ridge, first=2019):
    out = mix0.copy()
    for s in range(first, int(SEAS.max()) + 1):
        tr = (SEAS >= 2016) & (SEAS < s); te = SEAS == s
        b = M.fit(X[tr], LOGP[tr], Y[tr], ridge); out[te] = M.tilt(X[te], LOGP[te], b)
    L, L0 = H.losses(out), H.losses(mix0); keep = SEAS >= first
    dd = {k: (L[k] - L0[k])[keep] for k in L}; v = dd["ll"]; h = len(v) // 2
    return v.mean(), H.tstat(v), dd["brier"].mean(), dd["rps"].mean(), v[:h].mean(), v[h:].mean()
AFs = {dl: {name: feat_rows(dl, ks) for name, ks in SETS.items()} for dl in (0.9, 0.95)}
def sweep(shuffle=None):
    out = []
    for dl in (0.9, 0.95):
        for name in SETS:
            F = AFs[dl][name]
            if shuffle is not None: F = F[shuffle[dl][name]]
            X = F[0::2] - F[1::2]
            for r in (1.0, 30.0): out.append(((dl, name, r), wf(X, r)))
    return out
res = sweep(); res.sort(key=lambda x: x[1][0])
print(f"\n(b) {len(res)} configs, walk-forward 2019+ vs the blend (negative = better); matches touched by a mover: {int(((AFs[0.9]['all movers x level'][0::2] != 0) | (AFs[0.9]['all movers x level'][1::2] != 0)).sum())}")
for cfg, st in res[:8]:
    print(f"  {str(cfg):<44} LL {st[0]:+.5f} (t {st[1]:+5.2f}) Br {st[2]:+.5f} RPS {st[3]:+.5f} halves {st[4]:+.5f}/{st[5]:+.5f}")
print(f"  worst {res[-1][0]} {res[-1][1][0]:+.5f}; share below zero {np.mean([r[1][0] < 0 for r in res]):.2f}")
bestll, bestt = res[0][1][0], min(r[1][1] for r in res)
for nm in ("prom x level", "rel x level"):
    F = AFs[0.9][nm]; X = F[0::2] - F[1::2]
    print(f"  fitted beta on [{nm}] memory 0.9: {M.fit(X[SEAS >= 2016], LOGP[SEAS >= 2016], Y[SEAS >= 2016], 1.0).round(3)} (positive = a higher-level mover does better than the blend)")
if NPERM:
    rng = np.random.default_rng(8); nb, nt = [], []
    # shuffle level among club-season rows of the same mover kind over all seasons
    for it in range(NPERM):
        sh = {}
        for dl in (0.9, 0.95):
            LTd = level_table(dl); sh[dl] = {}
            for name, ks in SETS.items():
                idx = np.arange(len(d["mi"]))
                for kk in ("prom", "rel", "new"):
                    cs_ = [(t, s) for (t, s), v in LTd.items() if v[1] == kk]
                    perm = rng.permutation(len(cs_))
                    for (t, s), j in zip(cs_, perm):
                        for r in keys.get((t, s), []): idx[r] = keys[cs_[j]][0]
                sh[dl][name] = idx
        rs = sweep(shuffle=sh)
        nb.append(min(r[1][0] for r in rs)); nt.append(min(r[1][1] for r in rs))
    print(f"NULL ({NPERM} shuffles): best LL mean {np.mean(nb):+.5f} min {np.min(nb):+.5f}; best t mean {np.mean(nt):+.2f} min {np.min(nt):+.2f}; real best {bestll:+.5f} t {bestt:+.2f}; share at least as good: LL {np.mean(np.array(nb) <= bestll):.2f}, t {np.mean(np.array(nt) <= bestt):.2f}")
