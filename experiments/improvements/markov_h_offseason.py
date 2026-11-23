"""Step 7: the one lead, as a model change. After the offseason pull, a club that beat or
missed the model's expectation last season (mean points residual per match against the
shipped blend, last season's club-season, known at the season's start) is moved:
rebound = a bad year lifts its rating, a good year (linear form) lowers it. Elo (points
per unit of residual) and the goals model (log-goals, added to attack and defence) tested
alone and together; subsets all clubs / relegated clubs / promoted clubs; thresholds on the
residual; identity at gamma 0 is the shipped model. Walk-forward picks 2019+.

    markov_h_offseason.py CACHE [NPERM]
"""
import sys, time, math
import numpy as np
import markov_common as M
import harness as H

CACHE = sys.argv[1]
NPERM = int(sys.argv[2]) if len(sys.argv) > 2 else 0
d = M.build(cache=CACHE)
rows = {}
for r in range(len(d["mi"])): rows.setdefault((d["team"][r], d["season"][r]), []).append(r)
RES, XGD, LG = {}, {}, {}
for (t, s), rr in rows.items():
    rr = np.array(rr); LG[(t, s)] = d["league"][rr[0]]
    if len(rr) >= 20:
        RES[(t, s)] = d["pts_res"][rr].mean()
        x = d["xgd_res"][rr]; x = x[~np.isnan(x)]
        if len(x) >= 12: XGD[(t, s)] = x.mean()
ELO_SD = np.nanstd(list(RES.values()))

elo0 = H.elo_run(); ad0 = H.ad_run(); mix0 = H.blend(elo0, ad0.probs)
W = {"all16": H.WINDOWS["all16"], "xg": H.WINDOWS["xg"]}

def boost(t, season, spec, resmap):
    """>= 0 for a club whose last season beat/missed expectations (negative res -> positive boost)."""
    r = resmap.get((t, season - 1))
    if r is None: return 0.0
    kind, c, subset = spec
    lgp, lgc = LG.get((t, season - 1)), LG.get((t, season))
    if subset == "rel" and not (lgp == "eliteserien" and lgc == "obosligaen"): return 0.0
    if subset == "prom" and not (lgp == "obosligaen" and lgc == "eliteserien"): return 0.0
    if subset == "es" and lgc != "eliteserien": return 0.0
    if subset == "obos" and lgc != "obosligaen": return 0.0
    if kind == "lin": return -r
    if kind == "bad": return max(-r - c, 0.0)
    if kind == "both": return max(-r - c, 0.0) - max(r - c, 0.0)
    raise KeyError(kind)

def elo_variant(spec, gamma, resmap):
    def off(season, ratings):
        for t in ratings:
            ratings[t] += gamma * boost(t, season, spec, resmap)
    return H.elo_run(H.EloRun(offseason=off))

def ad_variant(spec, gamma, resmap):
    def hook(ad, season):
        for t in list(ad.attack):
            b = gamma * boost(t, season, spec, resmap)
            if b:
                ad.attack[t] += b; ad.defence[t] += b
    return H.ad_run(season_hook=hook).probs

SPECS = [("bad", 0.0, "all"), ("bad", 0.1, "all"), ("bad", 0.2, "all"), ("bad", 0.3, "all"), ("lin", 0.0, "all"), ("both", 0.1, "all"),
         ("lin", 0.0, "rel"), ("bad", 0.0, "rel"), ("bad", 0.0, "prom"), ("lin", 0.0, "es"), ("lin", 0.0, "obos")]
EG = (10, 20, 35, 50, 75, 100, 150)       # Elo points per 1.0 of residual
AG = (0.03, 0.06, 0.1, 0.15, 0.2, 0.3, 0.45)   # log-goals added to attack and defence per 1.0 of residual
# identity
assert abs(elo_variant(SPECS[0], 0.0, RES) - elo0).max() < 1e-12 and abs(ad_variant(SPECS[0], 0.0, RES) - ad0.probs).max() < 1e-12
print("identity ok")

def sweep(resmap, specs, label=""):
    ev, av = {}, {}
    for sp in specs:
        for g in EG: ev[(sp, g)] = elo_variant(sp, g, resmap)
        for g in AG: av[(sp, g)] = ad_variant(sp, g, resmap)
    return ev, av

t0 = time.time()
ev, av = sweep(RES, SPECS)
print(f"{len(ev)} Elo + {len(av)} goals-model runs, {time.time()-t0:.0f}s")
def stat(mx, w="all16"):
    c = H.compare(mx, mix0, W[w]); return c["ll"][0], c["ll"][1], c["brier"][0], c["rps"][0], c["ll_halves"]
res = []
for (sp, g), e in ev.items(): res.append(("Elo only", sp, g, stat(H.blend(e, ad0.probs))))
for (sp, g), a in av.items(): res.append(("AD only", sp, g, stat(H.blend(elo0, a))))
for sp in SPECS:
    for ie, ge in enumerate(EG):
        ga = AG[ie]
        res.append(("both", sp, (ge, ga), stat(H.blend(ev[(sp, ge)], av[(sp, ga)]))))
print(f"{len(res)} cells; share dLL<0: {np.mean([r[3][0]<0 for r in res]):.2f}")
for who in ("Elo only", "AD only", "both"):
    sub = sorted([r for r in res if r[0] == who], key=lambda r: r[3][0])[:6]
    print(f"-- best {who}")
    for _, sp, g, s in sub:
        print(f"   {str(sp):<26} g={str(g):<14} all16 LL {s[0]:+.5f} (t {s[1]:+5.2f}) Br {s[2]:+.5f} RPS {s[3]:+.5f} halves t {s[4][0]:+.2f}/{s[4][1]:+.2f}")
# walk-forward pick over the whole family
variants = {"base": mix0}
for (sp, g), e in ev.items(): variants[("elo", sp, g)] = H.blend(e, ad0.probs)
for (sp, g), a in av.items(): variants[("ad", sp, g)] = H.blend(elo0, a)
for sp in SPECS:
    for ie, ge in enumerate(EG): variants[("both", sp, ge)] = H.blend(ev[(sp, ge)], av[(sp, AG[ie])])
H.oos_report("offseason rebound, all families", variants, "base")
bothonly = {k: v for k, v in variants.items() if k == "base" or k[0] == "both"}
H.oos_report("offseason rebound, both models", bothonly, "base")
allonly = {k: v for k, v in variants.items() if k == "base" or (k[0] == "both" and k[1][2] == "all")}
H.oos_report("offseason rebound, both models, all clubs", allonly, "base")
best = min(res, key=lambda r: r[3][0])
print("real best dLL", best[3][0], "t", min(r[3][1] for r in res))

# null: shuffle the residual table among the clubs of the same season
if NPERM:
    rng = np.random.default_rng(5)
    keys_by_season = {}
    for k in RES: keys_by_season.setdefault(k[1], []).append(k)
    null_best = []; null_t = []; null_share = []
    for it in range(NPERM):
        sh = {}
        for s, ks in keys_by_season.items():
            vals = [RES[k] for k in ks]; rng.shuffle(vals)
            for k, v in zip(ks, vals): sh[k] = v
        e2, a2 = sweep(sh, SPECS[:6] + SPECS[6:8])      # the compact family
        cells = [stat(H.blend(e, ad0.probs)) for e in e2.values()] + [stat(H.blend(elo0, a)) for a in a2.values()] + \
                [stat(H.blend(e2[(sp, ge)], a2[(sp, AG[i])])) for sp in SPECS[:8] for i, ge in enumerate(EG)]
        null_best.append(min(c[0] for c in cells)); null_t.append(min(c[1] for c in cells)); null_share.append(np.mean([c[0] < 0 for c in cells]))
        print(f"  shuffle {it}: best dLL {null_best[-1]:+.5f}, best t {null_t[-1]:+.2f}, share of cells below zero {null_share[-1]:.2f}", flush=True)
    real_share = np.mean([r[3][0] < 0 for r in res if r[1] in SPECS[:8]])
    print(f"NULL share of cells below zero: mean {np.mean(null_share):.2f} (min {np.min(null_share):.2f}, max {np.max(null_share):.2f}); real compact family {real_share:.2f}")
    real_compact = min([r for r in res if r[1] in SPECS[:8]], key=lambda r: r[3][0])
    rt = min(r[3][1] for r in res if r[1] in SPECS[:8])
    print(f"NULL: best dLL mean {np.mean(null_best):+.5f} min {np.min(null_best):+.5f}; real compact best {real_compact[3][0]:+.5f}; share of shuffles at least as good: dLL {np.mean(np.array(null_best) <= real_compact[3][0]):.2f}, t {np.mean(np.array(null_t) <= rt):.2f} (real t {rt:+.2f})")
