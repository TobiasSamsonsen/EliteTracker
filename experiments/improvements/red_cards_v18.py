"""Red cards re-tested on elo-v18.0 (November 2026): "oversampling" (a bigger
step after an early red), a side-aware man-advantage correction, and the
suspension in the next match, beside the down-weights elo-v12.0 and elo-v13.0
rejected.

Red cards from local files (red_cards_data.py).

    .venv/Scripts/python experiments/improvements/red_cards_v18.py [--extras-only]
"""
import math, sys
import numpy as np
sys.path.insert(0, "experiments/improvements")
import elitetracker.pipeline as _pipeline  # noqa: E402
# Measured against the model without elo-v19.0's red-card correction, which
# the harness reads from data/red_cards.json: this script adds its own.
_pipeline.red_table = lambda *args, **kwargs: {}
from harness import (PLAYED, SEASON, WINDOWS, EloRun, ad_run, blend, elo_run, expected_score, line,  # noqa: E402
                     oos_report)
from red_cards_data import ADV as adv, EARLY as early, EXTRAS_ONLY, RED, REDS, X, cover  # noqa: E402
from elitetracker.model.career import team_ids  # noqa: E402

cover = cover()
print(f"card data {int(cover.sum())} matches; with a red {len(adv)}; first red before 60' {len(early)}")

# ---- How big is a man advantage? xG a minute before and after a lone red (extras' shots).
pre, post = np.zeros(2), np.zeros(2)  # [man-up side, man-down side]
tpre = tpost = 0.0
for mid, v in X.items():
    cards = [c for c in v["cards"] if c[2] in REDS]
    if len(cards) != 1 or cards[0][0] >= 80:
        continue
    t, down = min(90, cards[0][0]), cards[0][1]
    for minute, side, xg, *_ in v["shots"]:
        (pre if minute <= t else post)[1 if side == down else 0] += xg
    tpre += t; tpost += 90 - t
up_ratio, down_ratio = (post / tpost) / (pre / tpre)
print(f"xG a minute after a lone red (before 80') vs before it: man up x{up_ratio:.2f}, man down x{down_ratio:.2f}")

base_elo, base_ad = elo_run(), ad_run().probs
base = blend(base_elo, base_ad)
keep = cover & WINDOWS["all16"]
first = 2021 if EXTRAS_ONLY else 2017
print(line("shipped (identity)", base, base, keep))


def show(name, p):
    print(line(name, p, base, keep))
    if not EXTRAS_ONLY:
        print(line("    Eliteserien 2020+ extras", p, base, keep & np.array([m.match_id in X for m, _, _ in PLAYED])))
        print(line("    OBOS-ligaen", p, base, keep & WINDOWS["ob16"]))


# ---- 1. Step size on matches with an early red: <1 down-weights, >1 "oversamples".
fam_k = {1.0: base}
for mult in (0.5, 1.5, 2.0, 3.0):
    def km(mid, m_=mult):
        return m_ if mid in early else 1.0
    e = elo_run(EloRun(k_mult=lambda m, lg, s, ctx: km(m.match_id)))
    a = ad_run(k_hook=lambda ad, team, m: km(m.match_id))
    fam_k[mult] = blend(e, a.probs)
    show(f"early-red step x{mult}", fam_k[mult])

# ---- 2. Side-aware: judge each side against an expectation that knows about
# the man advantage (Elo), and take the advantage out of the observed goals/xG
# (goals model). Post-match information, used in the update only.
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


assert abs(expected_score(123.0, 0.0) - 1 / (1 + 10 ** (-123 / 400))) < 1e-12
fam_s = {(0, 0.0): base}
e_c, a_c = {0: base_elo}, {0.0: base_ad}
for pts in (100, 200, 300, 400, 600):
    e_c[pts] = elo_run(EloRun(k_mult=remember, change=elo_shift(pts)))
for a in (0.2, 0.35, 0.5):
    a_c[a] = ad_run(observed_hook=ad_obs(a)).probs
for pts in e_c:
    for a in a_c:
        if (pts, a) != (0, 0.0):
            fam_s[(pts, a)] = blend(e_c[pts], a_c[a])
            show(f"man advantage Elo {pts} / goals {a}", fam_s[(pts, a)])

# ---- 3. Pre-match: the suspension. A side sent off in its previous match
# misses that player in this one (known before kickoff).
susp, last_red = {}, {}
for m, _, _ in PLAYED:
    home, away = team_ids(m)
    susp[m.match_id] = (last_red.get(home, False), last_red.get(away, False))
    r = RED.get(m.match_id, [])
    last_red[home], last_red[away] = any(h for _, h in r), any(not h for _, h in r)
hit = np.array([any(susp[m.match_id]) for m, _, _ in PLAYED])
print(f"\nmatches with a side suspended from its last match: {int((hit & keep).sum())}")
_by = {(*team_ids(m), m.date): m.match_id for m, _, _ in PLAYED}


def susp_elo(points):
    def shift(m, lg, s, ctx):
        h, a = susp[m.match_id]
        return -points * h + points * a
    return shift


def susp_ad(f):
    def hook(ad, home, away, on, lam, mu):
        h, a = susp[_by[(home, away, on)]]
        return lam * (1 - f * h) * (1 + f * a), mu * (1 - f * a) * (1 + f * h)
    return hook


fam_p = {(0, 0.0): base}
e_p, a_p = {0: base_elo}, {0.0: base_ad}
for pts in (10, 20, 40):
    e_p[pts] = elo_run(EloRun(home_shift=susp_elo(pts)))
for f in (0.03, 0.06):
    a_p[f] = ad_run(rates_hook=susp_ad(f)).probs
for pts in e_p:
    for f in a_p:
        if (pts, f) != (0, 0.0):
            fam_p[(pts, f)] = blend(e_p[pts], a_p[f])
            show(f"suspension Elo {pts} / goals {f}", fam_p[(pts, f)])
            print(line("    only those matches", fam_p[(pts, f)], base, keep & hit))

print()
for name, fam, b in (("early-red step", fam_k, 1.0), ("man advantage", fam_s, (0, 0.0)), ("suspension", fam_p, (0, 0.0))):
    chosen, _ = oos_report(name, fam, b, first=first, restrict=keep, windows=())
    print(line(f"{name} OOS [cards {first}+]", chosen, base, keep & (SEASON >= first)))
