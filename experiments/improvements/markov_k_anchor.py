"""Step 10: a club's own 'home level' (anchor). Per club-season, from the baseline replay's
pre-pull ratings (end of the season before, one cross-division ladder, no reset on a change
of division, seeded from the 2014 ladder): anchor = EWMA of the club's earlier end-of-season
ratings (the last one excluded), gap = last end-of-season rating - anchor (negative = below
where it belongs), level = anchor - the division's mean anchor (how big a club it is).
Tilt on the blend's odds, walk-forward 2019+, with a permutation null (whole club-season
vectors shuffled among the clubs of a season).

    markov_k_anchor.py CACHE [NPERM]
"""
import sys, math
import numpy as np
import markov_common as M
import harness as H
from elitetracker.model.career import team_ids

CACHE = sys.argv[1]; NPERM = int(sys.argv[2]) if len(sys.argv) > 2 else 0
d = M.build(cache=CACHE)
elo0 = H.elo_run(); ad0 = H.ad_run(); mix0 = H.blend(elo0, ad0.probs)
LOGP = np.log(np.clip(mix0, 1e-12, 1)); SEAS = H.SEASON; Y = H.Y

END = {}      # (team, season_ended) -> rating, the target hook sees ratings before the pull
for t, s in H.SEEDS.items(): END[(t, 2014)] = s
DIV = {}
def rec(season, league, ids, ratings):
    for t in ids:
        END[(t, season - 1)] = ratings[t]; DIV[(t, season)] = league
    return None
H.elo_run(H.EloRun(target=rec))
names = {}
for m, lg, s in H.PLAYED:
    for side, t in enumerate(team_ids(m)): names[t] = (m.home if side == 0 else m.away); DIV.setdefault((t, s), lg)

def anchor_feats(delta):
    out = {}
    for s in sorted({s for (_, s) in DIV}):
        if s < 2016: continue
        cl = [t for (t, ss) in DIV if ss == s]
        A = {}; G = {}
        for t in cl:
            last = END.get((t, s - 1))
            if last is None: continue
            wsum = num = 0.0
            for k in range(2014, s - 1):
                v = END.get((t, k))
                if v is None: continue
                w = delta ** (s - 2 - k); num += w * v; wsum += w
            anchor = num / wsum if wsum else last
            A[t] = anchor; G[t] = last - anchor
        for lg in ("eliteserien", "obosligaen"):
            ids = [t for t in A if DIV.get((t, s)) == lg]
            if not ids: continue
            mean = np.mean([A[t] for t in ids])
            for t in ids: out[(t, s)] = (G[t], A[t] - mean, A[t])
    return out

def feat_rows(af):
    F = np.zeros((len(d["mi"]), 3))
    for r in range(len(d["mi"])):
        v = af.get((d["team"][r], d["season"][r]))
        if v: F[r] = v
    return F

def wf(X, ridge, first=2019):
    out = mix0.copy()
    for s in range(first, int(SEAS.max()) + 1):
        tr = (SEAS >= 2016) & (SEAS < s); te = SEAS == s
        b = M.fit(X[tr], LOGP[tr], Y[tr], ridge); out[te] = M.tilt(X[te], LOGP[te], b)
    L, L0 = H.losses(out), H.losses(mix0)
    res = {}
    for w in ("all", "xg"):
        keep = (SEAS >= first) & (H.HAS_XG if w == "xg" else True)
        dd = {k: (L[k] - L0[k])[keep] for k in L}; v = dd["ll"]; h = len(v) // 2
        res[w] = (v.mean(), H.tstat(v), dd["brier"].mean(), dd["rps"].mean(), v[:h].mean(), v[h:].mean())
    return res

SETS = {"gap": lambda g, l: [g], "gap- gap+": lambda g, l: [np.minimum(g, 0), np.maximum(g, 0)], "level": lambda g, l: [l],
        "gap level": lambda g, l: [g, l], "gap- gap+ level": lambda g, l: [np.minimum(g, 0), np.maximum(g, 0), l],
        "gap-,gap-*level, gap+,gap+*level": lambda g, l: [np.minimum(g, 0), np.minimum(g, 0) * l, np.maximum(g, 0), np.maximum(g, 0) * l],
        "gap-*level": lambda g, l: [np.minimum(g, 0) * l]}
def sweep(shuffle=None):
    out = []
    for delta in (0.5, 0.7, 0.85):
        F = AF[delta]
        if shuffle is not None: F = F[shuffle]
        g, l = F[:, 0] / 100, F[:, 1] / 100
        for name, fn in SETS.items():
            X = np.column_stack(fn(g, l)); X = X[0::2] - X[1::2]
            for r in (1.0, 30.0):
                out.append(((delta, name, r), wf(X, r)))
    return out
AF = {dl: feat_rows(anchor_feats(dl)) for dl in (0.5, 0.7, 0.85)}
print("club-season rows with an anchor, delta 0.7:", int((AF[0.7][:, 1] != 0).sum()), "of", len(d["mi"]))
res = sweep()
res.sort(key=lambda x: x[1]["all"][0])
print(f"{len(res)} configs, walk-forward 2019+ vs the shipped blend (negative = better)")
for cfg, st in res[:10]:
    a, x = st["all"], st["xg"]
    print(f"  {str(cfg):<52} all LL {a[0]:+.5f} (t {a[1]:+5.2f}) Br {a[2]:+.5f} RPS {a[3]:+.5f} halves {a[4]:+.5f}/{a[5]:+.5f} | xG LL {x[0]:+.5f} (t {x[1]:+5.2f})")
print("  worst: ", res[-1][0], f"{res[-1][1]['all'][0]:+.5f} (t {res[-1][1]['all'][1]:+.2f})")
print(f"  share below zero {np.mean([r[1]['all'][0] < 0 for r in res]):.2f}")
bestt = min(r[1]["all"][1] for r in res); bestll = min(r[1]["all"][0] for r in res)
g, l = AF[0.7][:, 0] / 100, AF[0.7][:, 1] / 100
for name in ("gap-", "gap-*level", "level"):
    X = {"gap-": np.minimum(g, 0), "gap-*level": np.minimum(g, 0) * l, "level": l}[name][:, None]; X = X[0::2] - X[1::2]
    b = M.fit(X[SEAS >= 2016], LOGP[SEAS >= 2016], Y[SEAS >= 2016], 1.0)
    print(f"  fitted beta on [{name}] delta 0.7: {b.round(3)} (gap- <= 0: a NEGATIVE beta = below-anchor clubs do BETTER than the blend, a rebound)")
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
        print(f"  shuffle {it}: best LL {nb[-1]:+.5f} t {nt[-1]:+.2f}", flush=True)
    print(f"NULL ({NPERM} shuffles): best LL mean {np.mean(nb):+.5f} min {np.min(nb):+.5f}; best t mean {np.mean(nt):+.2f} min {np.min(nt):+.2f}; real best LL {bestll:+.5f} t {bestt:+.2f}; share of shuffles at least as good: LL {np.mean(np.array(nb) <= bestll):.2f}, t {np.mean(np.array(nt) <= bestt):.2f}")

keys = {}
for r in range(len(d["mi"])): keys.setdefault((d["team"][r], d["season"][r]), []).append(r)
print("\nnamed clubs (delta 0.7): season E/O, gap (rating points), level, residual per match that season")
af = anchor_feats(0.7)
want = [t for t, n in names.items() if any(k in str(n).lower() for k in ("rosenborg", "molde", "brann", "viking", "lillestr", "lerenga", "msgodset", "odd", "start", "sarpsborg"))]
for t in want:
    rows = []
    for s in range(2016, 2027):
        v = af.get((t, s)); rr = keys.get((t, s))
        if v and rr and len(rr) >= 20:
            rows.append(f"{s}{'E' if DIV[(t, s)] == 'eliteserien' else 'O'} g{v[0]:+4.0f} l{v[1]:+4.0f} r{d['pts_res'][np.array(rr)].mean():+.2f}")
    print(f"  {names[t]:<16} " + " | ".join(rows))
