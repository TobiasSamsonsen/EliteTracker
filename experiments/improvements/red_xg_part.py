"""Is the huge Elo setting on the xG seasons (man_advantage_fine.py --xg:
16,000 points) really undoing xG a man advantage inflated? (November 2026.)

The variant corrects the xG the Elo update reads instead of its expectation:
in a match with a red, the home side's xG x e^(-b*f), the away side's
x e^(b*f) (f the home side's net man advantage, red_cards_data.ADV; xG, xGOT
and npxG alike, so `model_xg` sees it), the result part left alone. Matches
without xG have no xG part: there the shipped Elo 300 can stay on the result.
Against no correction, the shipped one (300 / 0.25 everywhere) and the split
(xG matches 16,000 / 0.1, others 300 / 0.25). Local files only.

    .venv/Scripts/python experiments/improvements/red_xg_part.py
"""
import math, sys
import numpy as np
sys.path.insert(0, "experiments/improvements")
import elitetracker.pipeline as _pipeline  # noqa: E402
# Measured against the model without elo-v19.0's red-card correction (the
# harness reads it from data/red_cards.json); every variant here adds its own.
_pipeline.red_table = lambda *args, **kwargs: {}
import harness as h  # noqa: E402
import red_cards_data as rc  # noqa: E402

B = (0.25, 0.5, 0.6, 0.75, 1.0, 1.5, 2.0)
A = (0.0, 0.1, 0.25)
adv, cover = rc.ADV, rc.cover()
XG = h.SHOTS
keep = cover & h.WINDOWS["all16"]
xgw = keep & h.WINDOWS["xg"]
_cur = {}


def remember(m, lg, s, ctx):
    _cur["mid"] = m.match_id
    return 1.0


def elo(points_xg, points_other, b=0.0):
    """Elo odds: the expectation shifted by points * f (separately on xG
    matches and the rest), and/or the xG part read from xG corrected by b."""
    shots = XG
    if b:
        shots = dict(XG)
        for mid, f in adv.items():
            if mid in XG:
                v = list(XG[mid])
                down, up = math.exp(-b * f), math.exp(b * f)
                for i in range(min(6, len(v))):
                    v[i] *= down if i % 2 == 0 else up
                shots[mid] = tuple(v)

    def change(k, scored, expected, hxg, axg, cfg):
        mid = _cur["mid"]
        f, pts = adv.get(mid, 0.0), points_xg if mid in XG else points_other
        if not f or not pts:
            return k * (scored - expected)
        gap = 400 * math.log10(expected / (1 - expected))
        return k * (scored - h.expected_score(gap + pts * f, 0.0))
    return h.elo_run(h.EloRun(k_mult=remember, change=change, shots=shots))


def ad(a_xg, a_other):
    def hook(model, m):
        home, away, k = type(model).__mro__[1].observed(model, m)
        f, a = adv.get(m.match_id, 0.0), a_xg if m.match_id in XG else a_other
        return home * math.exp(-a * f), away * math.exp(a * f), k
    return h.ad_run(observed_hook=hook).probs


e_none = h.elo_run()
a_c = {a: ad(a, a) for a in A}
a_split = ad(0.1, 0.25)
a_ship = ad(0.25, 0.25)
none = h.blend(e_none, a_c[0.0])
e_ship, e_split = elo(300, 300), elo(16000, 300)
ship, split = h.blend(e_ship, a_ship), h.blend(e_split, a_split)

print("Elo odds alone, xG matches with cards, against no correction")
print(h.line("  Elo 300 on the result", e_ship, e_none, xgw))
print(h.line("  Elo 16,000 on the result", e_split, e_none, xgw))
e_b = {b: elo(0, 300, b) for b in B}
for b in B:
    print(h.line(f"  xG part only, b {b}", e_b[b], e_none, xgw))

print("\nShipped odds (blend), against no correction")
print(h.line("shipped 300 / 0.25 [xg]", ship, none, xgw))
print(h.line("shipped 300 / 0.25 [all16]", ship, none, keep))
print(h.line("split 16,000 / 0.1 [xg]", split, none, xgw))
print(h.line("split 16,000 / 0.1 [all16]", split, none, keep))
fam = {}
for b in B:
    for a in A:
        # xG matches: b on the xG part and a in the goals model; the rest as shipped.
        fam[(b, a)] = h.blend(e_b[b], ad(a, 0.25) if a else ad(0.0, 0.25))
        print(h.line(f"xG part b {b} / goals {a} [xg]", fam[(b, a)], none, xgw))
best = min(fam, key=lambda k: h.compare(fam[k], none, xgw)["ll"][0])
print(f"\nbest on the xG matches: b {best[0]} / goals {best[1]}")
for w in ("all16", "es16", "ob16", "xg"):
    print(h.line(f"  vs none [{w}]", fam[best], none, keep & h.WINDOWS[w]))
    print(h.line(f"  vs split [{w}]", fam[best], split, keep & h.WINDOWS[w]))
for first in (2021, 2022):
    chosen, picks = h.oos({(0, 0.0): none, **fam}, (0, 0.0), first=first, restrict=xgw)
    print(f"walk-forward from {first}, picks: " + " ".join(f"{s}:{p}" for s, p in picks.items()))
    print(h.line(f"  OOS [xg {first}+]", chosen, none, xgw & (h.SEASON >= first)))
