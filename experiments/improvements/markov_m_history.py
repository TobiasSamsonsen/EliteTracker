"""Step 12: the anchor from standings back to 1963 (data/history_standings.json, Wikipedia), one
ladder across both tiers and every era: a club's season score = 1 - rank / (N1 + N2 + 16), rank = its
place in the top tier, N1 + its place in the second tier (two groups of 12 interleaved, 1991-96),
or a floor rank (N1 + N2 + 8; before 1991, when the second tier was not a single table and is not
fetched, N1 + 16) for a club in neither. Seasons 2016+ from the matches (3 W + D, then goal
difference). anchor = EWMA (memory 0.8 / 0.9 / 0.95) of the seasons before the last one, gap =
last season's score - anchor, level = anchor - the division's mean anchor, exactly as in
markov_k_anchor.py; same 7 feature sets x ridge 1, 30; walk-forward tilt 2019+; 40-shuffle null;
the best config rerun without each of the highest-level clubs.

    markov_m_history.py CACHE [NPERM]
"""
import sys, json, unicodedata
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
         "valerengen": "valerenga", "pors grenland": "pors", "vard haugesund": "vard", "sarpsborg fk": "sarpsborg 08", "sarpsborg": "sarpsborg 08",
         "gjovik-lyn": "lyn"}
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
    n1 = len(t1); rank = {}
    for r in t1: rank[key2(r["team"])] = r["pos"]
    if t2:
        G = len({r.get("group", 0) for r in t2}); n2 = len(t2)
        for r in t2: rank[key2(r["team"])] = n1 + (r["pos"] - 1) * G + r.get("group", 0) + 1 if G > 1 else n1 + r["pos"]
        floor = n1 + n2 + 8; denom = n1 + n2 + 16
    else:
        floor = n1 + 16; denom = n1 + 14 + 16
    for k in set(ID2KEY.values()) | set(rank):
        SCORE[(k, year)] = 1 - rank.get(k, floor) / denom
fin = {}
for i, (m, lg, s) in enumerate(H.PLAYED):
    if s < 2016: continue
    for side, t in enumerate(team_ids(m)):
        g = fin.setdefault((s, lg), {}).setdefault(t, [0, 0, 0])
        gf, ga = (m.home_goals, m.away_goals) if side == 0 else (m.away_goals, m.home_goals)
        g[0] += 3 if gf > ga else (1 if gf == ga else 0); g[1] += gf - ga; g[2] += 1
for s in range(2016, 2027):
    t1 = sorted(fin.get((s, "eliteserien"), {}).items(), key=lambda kv: (-kv[1][0], -kv[1][1]))
    t2 = sorted(fin.get((s, "obosligaen"), {}).items(), key=lambda kv: (-kv[1][0], -kv[1][1]))
    n1, n2 = len(t1) or 16, len(t2) or 16; denom = n1 + n2 + 16; rank = {}
    for i, (t, _) in enumerate(t1): rank[ID2KEY[t]] = i + 1
    for i, (t, _) in enumerate(t2): rank[ID2KEY[t]] = n1 + i + 1
    for k in set(ID2KEY.values()): SCORE[(k, s)] = 1 - rank.get(k, n1 + n2 + 8) / denom
KEYS = sorted(set(ID2KEY.values()))
missing = [k for k in KEYS if all(SCORE[(k, y)] == SCORE[(k, 1963)] for y in range(1963, 2015))]
print("repo clubs whose score never moves 1963-2014 (name did not join, or never in the top two tiers):", missing)

DIV = {}
for r in range(len(d["mi"])): DIV[(d["team"][r], d["season"][r])] = d["league"][r]
def anchor_feats(delta):
    out = {}
    for s in range(2016, 2027):
        ids = [t for (t, ss) in DIV if ss == s]
        A, G = {}, {}
        for t in ids:
            k = ID2KEY[t]; num = wsum = 0.0
            for y in range(1963, s - 1):
                w = delta ** (s - 2 - y); num += w * SCORE[(k, y)]; wsum += w
            A[t] = num / wsum; G[t] = SCORE[(k, s - 1)] - A[t]
        for lg in ("eliteserien", "obosligaen"):
            idl = [t for t in A if DIV.get((t, s)) == lg]
            if not idl: continue
            mean = np.mean([A[t] for t in idl])
            for t in idl: out[(t, s)] = (G[t], A[t] - mean, A[t])
    return out
def feat_rows(af):
    F = np.zeros((len(d["mi"]), 3))
    for r in range(len(d["mi"])):
        v = af.get((d["team"][r], d["season"][r]))
        if v: F[r] = v
    return F
OK_ALL = np.ones(len(Y), bool)
def wf(X, ridge, ok=OK_ALL, first=2019):
    out = mix0.copy()
    for s in range(first, int(SEAS.max()) + 1):
        tr = (SEAS >= 2016) & (SEAS < s) & ok; te = SEAS == s
        b = M.fit(X[tr], LOGP[tr], Y[tr], ridge); out[te] = M.tilt(X[te], LOGP[te], b)
    L, L0 = H.losses(out), H.losses(mix0); res = {}
    for w in ("all", "xg"):
        keep = (SEAS >= first) & ok & (H.HAS_XG if w == "xg" else True)
        dd = {k: (L[k] - L0[k])[keep] for k in L}; v = dd["ll"]; h = len(v) // 2
        res[w] = (v.mean(), H.tstat(v), dd["brier"].mean(), dd["rps"].mean(), v[:h].mean(), v[h:].mean())
    return res
SETS = {"gap": lambda g, l: [g], "gap- gap+": lambda g, l: [np.minimum(g, 0), np.maximum(g, 0)], "level": lambda g, l: [l],
        "gap level": lambda g, l: [g, l], "gap- gap+ level": lambda g, l: [np.minimum(g, 0), np.maximum(g, 0), l],
        "gap-,gap-*level, gap+,gap+*level": lambda g, l: [np.minimum(g, 0), np.minimum(g, 0) * l, np.maximum(g, 0), np.maximum(g, 0) * l],
        "gap-*level": lambda g, l: [np.minimum(g, 0) * l]}
DELTAS = (0.8, 0.9, 0.95)
AF = {dl: feat_rows(anchor_feats(dl)) for dl in DELTAS}
def design(F, name):
    g, l = F[:, 0] * 10, F[:, 1] * 10
    X = np.column_stack(SETS[name](g, l)); return X[0::2] - X[1::2]
def sweep(shuffle=None, ok=OK_ALL, only=None):
    out = []
    for delta in DELTAS:
        F = AF[delta] if shuffle is None else AF[delta][shuffle]
        for name in SETS:
            for r in (1.0, 30.0):
                if only and (delta, name, r) != only: continue
                out.append(((delta, name, r), wf(design(F, name), r, ok)))
    return out
res = sweep(); res.sort(key=lambda x: x[1]["all"][0])
print(f"{len(res)} configs, walk-forward 2019+ vs the shipped blend (negative = better); comparator: anchor from the 2014 Elo ladder, best -0.00040 (t -1.14), null p 0.03")
for cfg, st in res[:10]:
    a, x = st["all"], st["xg"]
    print(f"  {str(cfg):<52} all LL {a[0]:+.5f} (t {a[1]:+5.2f}) Br {a[2]:+.5f} RPS {a[3]:+.5f} halves {a[4]:+.5f}/{a[5]:+.5f} | xG LL {x[0]:+.5f} (t {x[1]:+5.2f})")
print(f"  worst {res[-1][0]} {res[-1][1]['all'][0]:+.5f}; share below zero {np.mean([r[1]['all'][0] < 0 for r in res]):.2f}")
bestcfg, bestst = res[0]; bestll, bestt = res[0][1]["all"][0], min(r[1]["all"][1] for r in res)
F = AF[0.9]; g, l = F[:, 0] * 10, F[:, 1] * 10
for nm in ("gap-*level", "level"):
    X = {"gap-*level": np.minimum(g, 0) * l, "level": l}[nm][:, None]; X = X[0::2] - X[1::2]
    print(f"  fitted beta on [{nm}] memory 0.9: {M.fit(X[SEAS >= 2016], LOGP[SEAS >= 2016], Y[SEAS >= 2016], 1.0).round(3)}")
lvl = {}
for (t, s), v in anchor_feats(bestcfg[0]).items():
    if s >= 2019: lvl.setdefault(t, []).append(v[1])
top = sorted(lvl, key=lambda t: -np.mean(lvl[t]))[:6]
ros = [t for t, n in names.items() if "rosenborg" in n.lower()]
print("\nbest config without a club (its matches dropped from fit and score):", bestcfg, " highest-level clubs:", [names[t] for t in top])
tid_of_match = [team_ids(m) for m, _, _ in H.PLAYED]
others = [t for t in top if t not in ros]
for grp in [ros] + [[t] for t in others[:5]] + [ros + others[:1]]:
    ok = np.array([not (a in grp or b in grp) for a, b in tid_of_match])
    st = sweep(ok=ok, only=bestcfg)[0][1]["all"]
    print(f"  without {', '.join(names[t] for t in grp):<28} n={int((ok & (SEAS >= 2019)).sum())} LL {st[0]:+.5f} (t {st[1]:+5.2f}) Br {st[2]:+.5f} RPS {st[3]:+.5f} halves {st[4]:+.5f}/{st[5]:+.5f}")
if NPERM:
    keys = {}
    for r in range(len(d["mi"])): keys.setdefault((d["season"][r], d["league"][r]), {}).setdefault(d["team"][r], []).append(r)
    rng = np.random.default_rng(3); nb, nt = [], []
    for it in range(NPERM):
        src = np.arange(len(d["mi"]))
        for k, tm in keys.items():
            ts = list(tm); perm = rng.permutation(len(ts))
            for a, bi in zip(ts, perm):
                for r in tm[a]: src[r] = tm[ts[bi]][0]
        rs = sweep(shuffle=src)
        nb.append(min(r[1]["all"][0] for r in rs)); nt.append(min(r[1]["all"][1] for r in rs))
    print(f"\nNULL ({NPERM} shuffles): best LL mean {np.mean(nb):+.5f} min {np.min(nb):+.5f}; best t mean {np.mean(nt):+.2f} min {np.min(nt):+.2f}; real best LL {bestll:+.5f} t {bestt:+.2f}; share at least as good: LL {np.mean(np.array(nb) <= bestll):.2f}, t {np.mean(np.array(nt) <= bestt):.2f}")
print("\nRosenborg: ladder score per season 2010-2025, then memory-0.9 gap / level (x10)")
af = anchor_feats(0.9)
for t in ros:
    print("  score", " ".join(f"{y}:{SCORE[(ID2KEY[t], y)]:.2f}" for y in range(2010, 2026)))
    print("  " + " ".join(f"{s}:g{af[(t, s)][0]*10:+.1f}/l{af[(t, s)][1]*10:+.1f}" for s in range(2016, 2027) if (t, s) in af))
