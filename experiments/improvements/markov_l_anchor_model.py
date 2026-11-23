"""Step 11: the anchor as a model change. After the offseason pull a club below where it
belongs (gap < 0: last season's end rating under the EWMA of its earlier end ratings, one
cross-division ladder, seeded from the 2014 ladder, built from THIS variant's own replay) is
lifted in proportion to the gap and to how big a club it is (level: its anchor above the
division's mean anchor): Elo + g_e * (-gap/100) * (level/100) points; the goals model's attack
and defence each + g_a * the same product (anchors taken from the baseline Elo replay).
Variants: on top of shipped; in place of the relegation special-casing; against / together with
the step-9 rebound term. Walk-forward over the size, 2019+."""
import sys
from dataclasses import replace
import numpy as np
import markov_common as M
import harness as H
from elitetracker.model.attack_defence import ADConfig
from elitetracker.model.elo import EloConfig, era_config

d = M.build(cache=sys.argv[1])
W = H.WINDOWS
class Anchor:
    """records pre-pull ratings (target hook), builds anchors, lifts after the pull (offseason hook)"""
    def __init__(self, delta, g_e):
        self.delta, self.g_e = delta, g_e
        self.end = {(t, 2014): r for t, r in H.SEEDS.items()}
        self.div = {}; self.gl = {}
    def target(self, season, league, ids, ratings):
        for t in ids:
            self.end[(t, season - 1)] = ratings[t]; self.div[(t, season)] = league
        A = {}; G = {}
        for t in ids:
            wsum = num = 0.0
            for k in range(2014, season - 1):
                v = self.end.get((t, k))
                if v is not None:
                    w = self.delta ** (season - 2 - k); num += w * v; wsum += w
            last = self.end[(t, season - 1)]
            A[t] = num / wsum if wsum else last; G[t] = last - A[t]
        mean = np.mean(list(A.values()))
        for t in ids: self.gl[(t, season)] = (G[t], A[t] - mean)
        return None
    def offseason(self, season, ratings):
        if not self.g_e: return
        for (t, s), (g, l) in self.gl.items():
            if s == season and t in ratings: ratings[t] += self.g_e * max(-g, 0.0) / 100 * l / 100

def elo_variant(delta, g_e, ec=None, extra=None):
    a = Anchor(delta, g_e)
    def off(season, ratings):
        a.offseason(season, ratings)
        if extra: extra(season, ratings)
    e = H.elo_run(H.EloRun(config_for=lambda lg, s: era_config(s, ec or EloConfig()), target=a.target, offseason=off))
    return e, a

def ad_variant(gl, g_a, ac=None, extra=None):
    def hook(ad, season):
        for t in list(ad.attack):
            v = gl.get((t, season))
            if v and g_a:
                b = g_a * max(-v[0], 0.0) / 100 * v[1] / 100; ad.attack[t] += b; ad.defence[t] += b
        if extra: extra(ad, season)
    return H.ad_run(config=ac or ADConfig(), season_hook=hook).probs

elo0 = H.elo_run(); ad0 = H.ad_run(); mix0 = H.blend(elo0, ad0.probs)
e0, a0 = elo_variant(0.7, 0.0)
assert abs(e0 - elo0).max() < 1e-12
assert abs(ad_variant(a0.gl, 0.0) - ad0.probs).max() < 1e-12
print("identity ok")
keys = {}
for r in range(len(d["mi"])): keys.setdefault((d["team"][r], d["season"][r]), []).append(r)
RES = {k: d["pts_res"][np.array(rr)].mean() for k, rr in keys.items() if len(rr) >= 20}
def step9_e(season, ratings):
    for t in ratings:
        r = RES.get((t, season - 1))
        if r is not None: ratings[t] += 100 * max(-r - 0.1, 0.0)
def step9_a(ad, season):
    for t in list(ad.attack):
        r = RES.get((t, season - 1))
        if r is not None: b = 0.3 * max(-r - 0.1, 0.0); ad.attack[t] += b; ad.defence[t] += b

GE = (10, 20, 30, 45, 70); GA = (0.02, 0.04, 0.07, 0.1, 0.15)
def family(name, ec=None, ac=None, extra_e=None, extra_a=None, base_mix=None):
    base = H.blend(*(( elo_variant(0.7, 0.0, ec, extra_e)[0]), ad_variant(a0.gl, 0.0, ac, extra_a))) if base_mix is None else base_mix
    var = {"base": base}
    for delta in (0.5, 0.7):
        for ge, ga in zip(GE, GA):
            e, a = elo_variant(delta, ge, ec, extra_e)
            var[(delta, ge)] = H.blend(e, ad_variant(a.gl, ga, ac, extra_a))
    return var
def report(name, var):
    cells = sorted(((H.compare(v, mix0, W["all16"]), k) for k, v in var.items() if k != "base"), key=lambda x: x[0]["ll"][0])
    print(f"\n## {name}")
    base = H.compare(var["base"], mix0, W["all16"])
    print(f"  without the anchor term vs SHIPPED: LL {base['ll'][0]:+.5f} (t {base['ll'][1]:+.2f})")
    for c, k in cells[:3]:
        print(f"  + anchor {k}: vs SHIPPED LL {c['ll'][0]:+.5f} (t {c['ll'][1]:+5.2f}) Br {c['brier'][0]:+.5f} RPS {c['rps'][0]:+.5f} halves t {c['ll_halves'][0]:+.2f}/{c['ll_halves'][1]:+.2f}")
    print(f"  share of cells below the shipped: {np.mean([c['ll'][0] < 0 for c, _ in cells]):.2f}")
    chosen, picks = H.oos(var, "base")
    print("  picks: " + " ".join(f"{s}:{'none' if p == 'base' else p}" for s, p in picks.items() if s >= 2022))
    for w in ("all16", "xg", "es16", "ob16"):
        keep = W[w] & (H.SEASON >= 2019)
        print(f"  walk-forward vs SHIPPED [{w} 2019+]: " + H.line("", chosen, mix0, keep)[34:])
    return chosen

report("A. the anchor term on top of everything shipped", family("A"))
E0, A0 = EloConfig(), ADConfig()
ec_rel = replace(E0, relegated_regression=E0.season_regression, relegated_value_pull=0.0)
ac_rel = replace(A0, relegated_regression=A0.obos_season_regression)
report("B. the anchor term IN PLACE OF the relegation special-casing", family("B", ec_rel, ac_rel))
report("C. step-9 rebound term alone (for comparison, same walk-forward form)", {"base": mix0, **{("s9", g): H.blend(elo_variant(0.7, 0.0, None, lambda s, r: [r.__setitem__(t, r[t] + g * max(-RES.get((t, s - 1), 1) - 0.1, 0.0)) for t in list(r) if (t, s - 1) in RES])[0], ad_variant(a0.gl, 0.0, None, step9_a)) for g in (50, 100)}})
report("D. anchor term TOGETHER with the step-9 term", family("D", None, None, step9_e, step9_a))
report("E. anchor term in place of the relegation special-casing AND against step 9 (both removed vs shipped)", family("E", ec_rel, ac_rel, None, None))
