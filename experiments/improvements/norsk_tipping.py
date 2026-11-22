"""Norsk Tipping's 1X2 prices against Pinnacle's close and the model (November 2026, elo-v16.0).

`data/odds_norsktipping.json` holds Norsk Tipping's prices (decimal,
home/draw/away) for 119 Eliteserien matches, read by hand in the browser
from FotMob's match pages on 22 November 2026 (FotMob shows Norsk Tipping's
odds under the score, still there after full time): a random 100 of 2024
(seed 2024; Odd - HamKam showed none) and 20 of 2026 (round 1's HamKam -
Viking and the 19 latest finished). One page at a time, 4-8 s apart, each
page's heading date checked against the match. Not refreshed by anything.

Prints: NT against the Pinnacle close on 2024 (margins, fair-line gaps, the
price ratio by probability, a per-outcome fit NT implied = a + b x Pinnacle
fair), the model's bets at NT's real prices, and the 2021+ backtest with the
close re-priced to NT's fitted shape, all edges and the 3-15 % band.
Results in PROJECT_STATUS.md, "Bookmaker benchmark (1.13)".

    python experiments/improvements/norsk_tipping.py
"""
import json, os, math, random
from elitetracker.research import shipped_cards, load_slices, seed_ratings, shot_table, market_values, stakes_table
from elitetracker.model import benchmark
from elitetracker.model.probabilities import HOME_WIN, DRAW, AWAY_WIN
NT = json.load(open("data/odds_norsktipping.json", encoding="utf-8"))
K = (HOME_WIN, DRAW, AWAY_WIN)
slices = load_slices(); seeds = {t: s.rating for t, s in seed_ratings().items()}
dates = {m.match_id: m.date for s in slices for m in s.matches}
nt24 = {m: p for m, p in NT.items() if dates[m].startswith("2024")}
nt26 = {m: p for m, p in NT.items() if dates[m].startswith("2026")}
elo, model = shipped_cards(slices, seeds, score_from_season=2021, shots=shot_table(),
                           values=market_values(), league="eliteserien", stakes=stakes_table())
close = benchmark.load_prices(); books = benchmark.load_books()
ip = lambda p: [1/x for x in p]

# 1. NT vs Pinnacle on the 99
both = [m for m in nt24 if m in close and books.get(m) == "PSC"]
print(f"== Norsk Tipping vs Pinnacle close, 2024, n={len(both)} ==")
print(f"margin: NT {sum(sum(ip(nt24[m]))-1 for m in both)/len(both):.2%}   Pinnacle {sum(sum(ip(close[m]))-1 for m in both)/len(both):.2%}")
for meth in ("proportional", "power"):
    diffs = [[benchmark.devig(tuple(nt24[m]), meth)[i] - benchmark.devig(close[m], meth)[i] for i in range(3)] for m in both]
    for i, lab in enumerate("HDA"):
        xs = [d[i] for d in diffs]; mu = sum(xs)/len(xs); sd = math.sqrt(sum((x-mu)**2 for x in xs)/(len(xs)-1))
        print(f"  {meth:12} fair {lab}: NT - Pin mean {mu*100:+.2f} pp (se {sd/math.sqrt(len(xs))*100:.2f}), sd {sd*100:.2f} pp, max |d| {max(abs(x) for x in xs)*100:.1f} pp")
# price ratio by Pinnacle fair probability bucket: how much NT shaves each outcome
print("  NT price / Pinnacle price, by Pinnacle fair prob:")
rows = [(benchmark.devig(close[m], "power")[i], nt24[m][i] / close[m][i]) for m in both for i in range(3)]
for lo, hi in ((0, .15), (.15, .25), (.25, .35), (.35, .5), (.5, .7), (.7, 1)):
    r = [x for p, x in rows if lo <= p < hi]
    if r: print(f"    p {lo:.2f}-{hi:.2f}: n={len(r):3d}  ratio {sum(r)/len(r):.3f}")
mo = [benchmark.devig(tuple(nt24[m]), "power") for m in both]
ll = lambda probs: -sum(math.log(p[K.index(model.predictions[m][1])]) for p, m in zip(probs, both)) / len(both)
print(f"  log loss: NT {ll(mo):.4f}  Pinnacle {ll([benchmark.devig(close[m], 'power') for m in both]):.4f}  model {ll([[model.predictions[m][0].of(k) for k in K] for m in both]):.4f}")

def run(order, px, lo, hi, card=model):
    flat = []; bank = 1.0; st = pr = 0.0; peak = 1.0; dd = 0.0
    for mid in order:
        if mid not in px or mid not in card.predictions: continue
        p, out = card.predictions[mid]
        opts = [(p.of(k)*pr_-1, k, pr_) for k, pr_ in zip(K, px[mid])]
        opts = [o for o in opts if lo <= o[0] < hi]
        if not opts: continue
        e, key, price = max(opts)
        s = min(0.025, 0.25*e/(price-1)); g = s*(price-1) if key == out else -s
        flat.append(price-1 if key == out else -1); st += s; pr += g; bank *= 1+g; peak = max(peak, bank); dd = max(dd, 1-bank/peak)
    n = len(flat)
    if n < 2: return f"{n} bets"
    m = sum(flat)/n; sd = math.sqrt(sum((x-m)**2 for x in flat)/(n-1))
    return f"{n:4d} bets  hit {sum(x>0 for x in flat)/n:5.1%}  flat ROI {m:+6.1%} (t {m/(sd/math.sqrt(n)):+.2f})  Kelly ROI {pr/st:+6.1%}  bankroll x{bank:.2f}  max dd {dd:.0%}"

# 2. model at actual NT prices (99 from 2024 + 20 from 2026)
ntall = {**nt24, **nt26}
o_nt = sorted(ntall, key=lambda m: (dates[m], m))
print(f"\n== model bets at Norsk Tipping's real prices, {len(o_nt)} matches ==")
for lo, hi, lab in ((0.03, 9, "edge >= 3%"), (0.03, 0.15, "edge 3-15%")):
    print(f"  {lab:10} {run(o_nt, ntall, lo, hi)}")
print(f"  same 99 at Pinnacle close, edge 3-15%: {run(sorted(both, key=lambda m: dates[m]), close, 0.03, 0.15)}")

# 3. full 2021+ backtest: Pinnacle close, and NT-shaped re-pricing fitted on the 99
order = sorted((m for m in model.predictions if m in close), key=lambda m: (dates[m], m))
# fit NT implied = a + b * Pinnacle fair (power), per outcome
fit = []
for i in range(3):
    xs = [benchmark.devig(close[m], "power")[i] for m in both]; ys = [1/nt24[m][i] for m in both]
    mx, my = sum(xs)/len(xs), sum(ys)/len(ys)
    b = sum((x-mx)*(y-my) for x, y in zip(xs, ys))/sum((x-mx)**2 for x in xs); a = my - b*mx
    res = math.sqrt(sum((y-a-b*x)**2 for x, y in zip(xs, ys))/(len(xs)-2)); fit.append((a, b)); print(f"  fit {'HDA'[i]}: NT implied = {a:+.4f} + {b:.4f} x Pinnacle fair  (residual sd {res*100:.2f} pp)")
ntlike = {m: tuple(1/(fit[i][0] + fit[i][1]*benchmark.devig(close[m], "power")[i]) for i in range(3)) for m in order}
fair = {m: benchmark.devig(close[m], "power") for m in order}
flat68 = {m: tuple(1/(q*1.0684) for q in fair[m]) for m in order}
print(f"\n== Eliteserien 2021-2026 backtest, {len(order)} priced matches ==")
for name, px in (("Pinnacle/avg close", close), ("close at 6.84% margin, even", flat68), ("close re-priced to NT's fitted shape", ntlike)):
    for lo, hi, lab in ((0.03, 9, "edge >= 3%"), (0.03, 0.15, "edge 3-15%"), (0.15, 9, "edge >= 15%")):
        print(f"  {name:38} {lab:11} {run(order, px, lo, hi)}")
# per season for NT-shaped 3-15
print("\n  NT-shaped, edge 3-15%, by season:")
for y in range(2021, 2027):
    print(f"    {y} {run([m for m in order if dates[m].startswith(str(y))], ntlike, 0.03, 0.15)}")
