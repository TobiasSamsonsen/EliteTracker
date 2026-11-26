"""The man-advantage correction from red_cards_v18.py, a finer sweep on
elo-v19.0 (November 2026). Elo: each side judged against an expectation that
knows about the man advantage, expected_score(gap + points * f); goals model:
the observed home goals/xG x e^(-a*f), the away side's x e^(a*f). f is the
home side's net man advantage as a share of 90 minutes (red_cards_v18.adv).
Post-match information, used in the update only. Local files only; red cards
as red_cards_v18.py reads them.

    .venv/Scripts/python experiments/improvements/man_advantage_fine.py [--xg]

--xg scores the xG seasons only (Eliteserien 2020+, OBOS-ligaen 2023+), with
the walk-forward from 2021 and 2022.
"""
import math, sys
import numpy as np
sys.path.insert(0, "experiments/improvements")
import elitetracker.pipeline as _pipeline  # noqa: E402
# Measured against the model without elo-v19.0's red-card correction, which
# the harness reads from data/red_cards.json: this script adds its own.
_pipeline.red_table = lambda *args, **kwargs: {}
from harness import (PLAYED, SEASON, WINDOWS, EloRun, ad_run, blend, compare, elo_run, expected_score, line,  # noqa: E402
                     oos)
import red_cards_data as rc  # noqa: E402

POINTS = (0, 100, 200, 300, 400, 600, 800, 1000, 1200, 1600, 2000, 2400, 3200, 4800)
if "--xg" in sys.argv:  # the xG seasons want more: the grid goes on until it turns
    POINTS = (0, 300, 1000, 2000, 3200, 4800, 6400, 9600, 16000, 32000)
GOALS = (0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4)

adv, cover = rc.ADV, rc.cover()
XG_ONLY = "--xg" in sys.argv
keep = cover & WINDOWS["xg" if XG_ONLY else "all16"]
es_x = keep & np.array([m.match_id in rc.X for m, _, _ in PLAYED])
print(f"card data {int(cover.sum())} matches; with a red {len(adv)}; scored {int(keep.sum())}")

_cur = {}


def remember(m, lg, s, ctx):
    _cur["mid"] = m.match_id
    return 1.0


def elo_shift(points):
    def change(k, scored, expected, hxg, axg, cfg):
        f = adv.get(_cur["mid"], 0.0)
        if not f:
            return k * (scored - expected)
        gap = 400 * math.log10(expected / (1 - expected))
        return k * (scored - expected_score(gap + points * f, 0.0))
    return change


def ad_obs(a):
    def hook(ad, m):
        h, w, k = type(ad).__mro__[1].observed(ad, m)
        f = adv.get(m.match_id, 0.0)
        return h * math.exp(-a * f), w * math.exp(a * f), k
    return hook


base_elo, base_ad = elo_run(), ad_run().probs
base = blend(base_elo, base_ad)
e_c = {0: base_elo, **{p: elo_run(EloRun(k_mult=remember, change=elo_shift(p))) for p in POINTS if p}}
a_c = {0.0: base_ad, **{a: ad_run(observed_hook=ad_obs(a)).probs for a in GOALS if a}}
fam = {(p, a): blend(e_c[p], a_c[a]) for p in POINTS for a in GOALS}
assert np.abs(fam[(0, 0.0)] - base).max() == 0.0


def grid(title, metric, w):
    print(f"\n{title}  (rows Elo points, columns goals a; x1e5, t in brackets)")
    print("      " + "".join(f"{a:>15}" for a in GOALS))
    for p in POINTS:
        cells = []
        for a in GOALS:
            c = compare(fam[(p, a)], base, w)
            cells.append(f"{c[metric][0] * 1e5:+7.1f} ({c[metric][1]:+5.2f})" if (p, a) != (0, 0.0) else f"{'-':>15}")
        print(f"{p:>5} " + "".join(f"{x:>15}" for x in cells))


grid(f"log loss, {'xG matches' if XG_ONLY else 'all16'} with cards", "ll", keep)
grid(f"RPS, {'xG matches' if XG_ONLY else 'all16'} with cards", "rps", keep)
grid("log loss, Eliteserien 2020+ (extras)", "ll", es_x)
grid("log loss, OBOS-ligaen", "ll", keep & WINDOWS["ob16"])

ranked = sorted((k for k in fam if k != (0, 0.0)), key=lambda k: compare(fam[k], base, keep)["ll"][0])
print("\nbest eight by log loss")
for k in ranked[:8]:
    print(line(f"Elo {k[0]} / goals {k[1]}", fam[k], base, keep))
    print(line("    Eliteserien 2020+ extras", fam[k], base, es_x))
    print(line("    OBOS-ligaen", fam[k], base, keep & WINDOWS["ob16"]))

print()
for name, sub in (("full grid", fam),
                  ("Elo only", {k: v for k, v in fam.items() if k[1] == 0.0}),
                  ("goals only", {k: v for k, v in fam.items() if k[0] == 0})):
    for first in ((2021, 2022) if XG_ONLY else (2017, 2020)):
        chosen, picks = oos(sub, (0, 0.0), first=first, restrict=keep)
        print(f"{name} walk-forward from {first}, picks: " + " ".join(f"{s}:{p}" for s, p in picks.items()))
        print(line(f"  OOS {name} [{first}+]", chosen, base, keep & (SEASON >= first)))
