"""Step 9: replace, not add. The rebound term (last season's residual against the blend lifts a
club's Elo and goals-model ratings after the offseason pull) is tried in place of the shipped
mechanisms that overlap with it: the relegation special-casing (elo-v15.0), the squad-value
pull, and the strength of the general offseason regression. Each removal is scored alone (what
it costs), then with the rebound term (does the term earn it back), against the shipped blend,
walk-forward over the term's size."""
import sys
from dataclasses import replace
import numpy as np
import markov_common as M
import harness as H
from elitetracker.model.attack_defence import ADConfig
from elitetracker.model.elo import EloConfig, era_config

d = M.build(cache=sys.argv[1])
elo0 = H.elo_run(); ad0 = H.ad_run(); mix0 = H.blend(elo0, ad0.probs)
keys = {}
for r in range(len(d["mi"])): keys.setdefault((d["team"][r], d["season"][r]), []).append(r)
RES = {k: d["pts_res"][np.array(rr)].mean() for k, rr in keys.items() if len(rr) >= 20}
LG = {k: d["league"][rr[0]] for k, rr in keys.items()}

def boost(t, season, kind, c):
    r = RES.get((t, season - 1))
    if r is None: return 0.0
    return -r if kind == "lin" else max(-r - c, 0.0)
def run(ec, ac, term=None):
    off = hook = None
    if term:
        kind, c, ge, ga = term
        def off(season, ratings):
            for t in ratings: ratings[t] += ge * boost(t, season, kind, c)
        def hook(ad, season):
            for t in list(ad.attack):
                b = ga * boost(t, season, kind, c)
                if b: ad.attack[t] += b; ad.defence[t] += b
    e = H.elo_run(H.EloRun(config_for=lambda lg, s: era_config(s, ec), offseason=off))
    kw = {"season_hook": hook} if hook else {}
    a = H.ad_run(config=ac, **kw).probs
    return H.blend(e, a)

E0, A0 = EloConfig(), ADConfig()
REMOVALS = {
  "shipped (control)": (E0, A0),
  "no relegation special-casing": (replace(E0, relegated_regression=E0.season_regression, relegated_value_pull=0.0), replace(A0, relegated_regression=A0.obos_season_regression)),
  "no squad-value pull (goals model)": (E0, replace(A0, value_pull=0.0, obos_value_pull=0.0)),
  "weaker offseason regression 0.94/0.85": (replace(E0, season_regression=0.94), replace(A0, season_regression=0.94, obos_season_regression=0.85)),
  "no offseason regression at all": (replace(E0, season_regression=1.0), replace(A0, season_regression=1.0, obos_season_regression=1.0)),
  "all three removed (0.94/0.85)": (replace(E0, season_regression=0.94, relegated_regression=0.94, relegated_value_pull=0.0),
                                    replace(A0, season_regression=0.94, obos_season_regression=0.85, relegated_regression=0.85, value_pull=0.0, obos_value_pull=0.0)),
}
TERMS = [(k, c, ge, ga) for k, c in (("bad", 0.0), ("bad", 0.1), ("bad", 0.2), ("lin", 0.0)) for ge, ga in ((35, 0.1), (75, 0.2), (100, 0.3), (150, 0.45), (250, 0.7))]
W = H.WINDOWS
assert abs(run(E0, A0) - mix0).max() < 1e-12
print("identity ok")
for name, (ec, ac) in REMOVALS.items():
    alone = run(ec, ac)
    print(f"\n## {name}")
    print("  removal alone vs shipped:  " + H.line("", alone, mix0, W["all16"])[34:])
    variants = {"base": alone}
    scored = []
    for t in TERMS:
        mx = run(ec, ac, t); variants[t] = mx
        c = H.compare(mx, mix0, W["all16"]); scored.append((c["ll"][0], t, c))
    scored.sort(key=lambda x: x[0])
    for ll, t, c in scored[:3]:
        print(f"  + term {t}: vs SHIPPED LL {ll:+.5f} (t {c['ll'][1]:+5.2f}) Br {c['brier'][0]:+.5f} RPS {c['rps'][0]:+.5f} halves t {c['ll_halves'][0]:+.2f}/{c['ll_halves'][1]:+.2f}")
    chosen, picks = H.oos(variants, "base")
    print("  walk-forward over the term (base = this removal without it), picks: " + " ".join(f"{s}:{'none' if p == 'base' else str(p)}" for s, p in picks.items() if s >= 2023))
    for w in ("all16", "xg"):
        keep = W[w] & (H.SEASON >= 2019)
        print("  walk-forward vs SHIPPED [" + w + " 2019+]: " + H.line("", chosen, mix0, keep)[34:])
