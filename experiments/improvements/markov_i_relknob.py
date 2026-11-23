"""Step 8: is the season-level rebound just the elo-v15.0 relegation knob, under-tuned on
the current model? Re-sweep relegated_regression (Elo and goals model) and Elo's
relegated_value_pull walk-forward against the shipped blend, then put the step-9 rebound
term on top of the best setting (what it adds at the margin)."""
import sys
from dataclasses import replace
import numpy as np
import markov_common as M
import harness as H
from elitetracker.model.attack_defence import ADConfig
from elitetracker.model.elo import EloConfig, era_config

CACHE = sys.argv[1]
d = M.build(cache=CACHE)
elo0 = H.elo_run(); ad0 = H.ad_run(); mix0 = H.blend(elo0, ad0.probs)

def elo_knob(r, v):
    base = replace(EloConfig(), relegated_regression=r, relegated_value_pull=v)
    return H.elo_run(H.EloRun(config_for=lambda lg, s: era_config(s, base)))
def ad_knob(r):
    return H.ad_run(config=replace(ADConfig(), relegated_regression=r)).probs
assert abs(elo_knob(0.5, 75.0) - elo0).max() < 1e-12 and abs(ad_knob(0.5) - ad0.probs).max() < 1e-12
print("identity ok (shipped 0.5 / 75 / 0.5)")
RS = (0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0); VS = (0, 50, 75, 100, 150)
if len(sys.argv) > 2 and sys.argv[2] == "wide":      # the optimum sat on the grid's edge: go past it
    RS = (0.0, 0.1, 0.2, 0.3, 0.4, 0.5); VS = (75, 100, 150, 200, 300)
ev = {(r, v): elo_knob(r, float(v)) for r in RS for v in VS}
av = {r: ad_knob(r) for r in RS}
W = H.WINDOWS["all16"]
rows = []
for (re_, ve), e in ev.items():
    for ra, a in av.items():
        mx = H.blend(e, a); c = H.compare(mx, mix0, W)
        rows.append((c["ll"][0], c["ll"][1], c["brier"][0], c["rps"][0], c["ll_halves"], (re_, ve, ra), mx))
rows.sort(key=lambda x: x[0])
print(f"{len(rows)} cells (Elo relegated_regression x relegated_value_pull x goals-model relegated_regression); share below zero {np.mean([r[0]<0 for r in rows]):.2f}")
for s in rows[:8]:
    print(f"   Elo r={s[5][0]} v={s[5][1]}, AD r={s[5][2]}:  LL {s[0]:+.5f} (t {s[1]:+5.2f}) Br {s[2]:+.5f} RPS {s[3]:+.5f} halves t {s[4][0]:+.2f}/{s[4][1]:+.2f}")
print("   the shipped cell (0.5, 75, 0.5) is zero by construction; Elo-only and AD-only rows of the grid:")
for r in RS:
    c = H.compare(H.blend(ev[(r, 75)], ad0.probs), mix0, W); c2 = H.compare(H.blend(elo0, av[r]), mix0, W)
    print(f"      r={r}: Elo-only (v 75) LL {c['ll'][0]:+.5f} (t {c['ll'][1]:+5.2f})   goals-model-only LL {c2['ll'][0]:+.5f} (t {c2['ll'][1]:+5.2f})")
variants = {"base": mix0}
for (re_, ve), e in ev.items():
    for ra, a in av.items():
        variants[(re_, ve, ra)] = H.blend(e, a)
H.oos_report("relegation knobs, whole grid", variants, "base", windows=("all16", "xg", "es16", "ob16"))
if len(sys.argv) > 2 and sys.argv[2] == "wide":
    sys.exit(0)
v2 = {"base": mix0}
for (re_, ve), e in ev.items(): v2[("elo", re_, ve)] = H.blend(e, ad0.probs)
for ra, a in av.items(): v2[("ad", ra)] = H.blend(elo0, a)
H.oos_report("relegation knobs, one model at a time", v2, "base")

# the rebound term on top of the best in-sample setting
best = rows[0][5]
print("\nbest in-sample setting:", best)
RES = {}
keys = {}
for r in range(len(d["mi"])): keys.setdefault((d["team"][r], d["season"][r]), []).append(r)
for k, rr in keys.items():
    if len(rr) >= 20: RES[k] = d["pts_res"][np.array(rr)].mean()
def off_factory(gamma, c):
    def off(season, ratings):
        for t in ratings:
            r = RES.get((t, season - 1))
            if r is not None: ratings[t] += gamma * max(-r - c, 0.0)
    return off
def hook_factory(gamma, c):
    def hook(ad, season):
        for t in list(ad.attack):
            r = RES.get((t, season - 1))
            if r is not None:
                b = gamma * max(-r - c, 0.0); ad.attack[t] += b; ad.defence[t] += b
    return hook
cfg_e = replace(EloConfig(), relegated_regression=best[0], relegated_value_pull=float(best[1]))
cfg_a = replace(ADConfig(), relegated_regression=best[2])
mixb = H.blend(ev[(best[0], best[1])], av[best[2]])
top = {"base": mixb}
for c in (0.0, 0.1, 0.2):
    for ge, ga in ((35, 0.1), (50, 0.15), (75, 0.2), (100, 0.3), (150, 0.45)):
        e = H.elo_run(H.EloRun(config_for=lambda lg, s: era_config(s, cfg_e), offseason=off_factory(ge, c)))
        a = H.ad_run(config=cfg_a, season_hook=hook_factory(ga, c)).probs
        top[(c, ge)] = H.blend(e, a)
print("rebound term on top of the best relegation setting (vs that setting; negative = the term adds):")
for k, v in top.items():
    if k == "base": continue
    print("  " + H.line(f"bad past {k[0]}, Elo {k[1]}", v, mixb, W))
H.oos_report("rebound on top of the re-tuned knob", top, "base")
