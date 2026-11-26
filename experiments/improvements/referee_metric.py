"""Which per-match "actual minus expected" number the referee view should show.

Compares points minus pre-match expected points (shipped) with Elo rating
change measured against Elo's own expectation, the result-only score against
the published odds, and actual rating change minus the rating change the
site's model expects (result part from the published odds, xG parts from the
attack/defence goal rates, plain and with the xG part linearly calibrated).
Tests: bias by pre-match strength, split-half reliability over 400 random
splits, and walk-forward prediction of the next match from a pairing's past
mean (net of the club's own past mean). Reads data/referees.json; no network.
Run: .venv/Scripts/python experiments/improvements/referee_metric.py
"""
from __future__ import annotations

import math
import random
import statistics
from collections import defaultdict

import numpy as np

from elitetracker.model.attack_defence import ADConfig, AttackDefence
from elitetracker.model.backtest import walk_forward as wf_elo
from elitetracker.model.career import replay, team_ids
from elitetracker.model.elo import EloConfig, actual_score, effective_home_advantage, era_config, expected_score, xg_implied_score
from elitetracker.model.pricing import goal_rates, match_odds
from elitetracker.normalize.matches import Match
from elitetracker.pipeline import (
    SEED_SEASON, load_slices, market_values, playoff_played, referees_payload, seed_ratings, shot_table, stakes_table,
)

payload = referees_payload()
refs = payload["referees"]
rows = payload["matches"]
slices = load_slices()
seeds = {k: v.rating for k, v in seed_ratings().items()}
shots, values, playoffs, stakes = shot_table(), market_values(), playoff_played(), stakes_table()

info = {}
for season, in_season, ratings, matches in replay(slices, seeds, shots=shots, values=values, playoffs=playoffs):
    cfg = era_config(season, EloConfig())
    for m, (hb, ab) in matches:
        h, _ = team_ids(m)
        e = expected_score(hb + effective_home_advantage(cfg, hb, ab), ab)
        info[m.match_id] = (ratings[h] - hb, cfg, e, actual_score(m.home_goals, m.away_goals))

elo = wf_elo(slices, seeds, EloConfig(), score_from_season=SEED_SEASON + 1, name="elo",
             shots=shots, values=values, stakes=stakes, playoffs=playoffs)
ad = AttackDefence.from_slices(slices, ADConfig(), shots=shots, values=values)
site = {}
for match in sorted((m for s_ in slices for m in s_.matches if m.played), key=Match.sort_key):
    if match.match_id in elo.predictions:
        probs = elo.predictions[match.match_id][0]
        st = stakes.get(match.match_id, 0.0)
        (rates,) = goal_rates([probs], ad, match, [st])
        odds = match_odds(probs, ad, match, stakes=st).odds
        site[match.match_id] = (odds.home_win, odds.draw, rates[0], rates[1])
    ad.observe(match)


def expected_change(cfg, e, pw, pd, lh, la, has_xg):
    """E[delta/K] under the site's model."""
    res = pw + 0.5 * pd
    if not has_xg or cfg.xg_alpha <= 0:
        return res - e
    obs = (1 - cfg.xg_alpha) * res + cfg.xg_alpha * xg_implied_score(lh, la)
    if cfg.xg_margin:
        c = cfg.xg_margin_smoothing
        r = math.log((lh + c) / (la + c))
        obs += math.copysign(cfg.xg_margin * math.log(1 + abs(r)), r)
    return obs - e


M = ["pts - xPts", "rating change vs Elo E", "result vs site odds (S - Pw - Pd/2)", "rating change vs site-expected change", "same, xG part calibrated", "rating change vs site-MEDIAN change"]
# calibration: realised xG part vs plug-in xG part, home side
cal_x, cal_y = [], []
for r in rows:
    mid = r[0]
    if mid not in info or mid not in site or mid not in shots:
        continue
    d, cfg, e, s_ = info[mid]
    pw, pd, lh, la = site[mid]
    res_part = (1 - cfg.xg_alpha) * s_
    cal_y.append(d / cfg.k_factor + e - res_part)
    cal_x.append(expected_change(cfg, e, pw, pd, lh, la, True) + e - (1 - cfg.xg_alpha) * (pw + 0.5 * pd))
cb, ca = np.polyfit(cal_x, cal_y, 1)
print(f"xG-part calibration: realised = {ca:+.3f} + {cb:.3f} * plug-in")

# Median expected change: simulate each match's result from the published
# odds; the xG part is the calibrated plug-in plus a residual drawn from the
# residuals real matches with that result produced (home-oriented).
pools = {1.0: [], 0.5: [], 0.0: []}
for r in rows:
    mid = r[0]
    if mid not in info or mid not in site or mid not in shots:
        continue
    d, cfg, e, s_ = info[mid]
    pw, pd, lh, la = site[mid]
    plug = expected_change(cfg, e, pw, pd, lh, la, True) + e - (1 - cfg.xg_alpha) * (pw + 0.5 * pd)
    realised = d / cfg.k_factor + e - (1 - cfg.xg_alpha) * s_
    pools[s_].append(realised - (ca + cb * plug))
rng_med = np.random.default_rng(7)
SIMS = 400


def median_change(cfg, e, pw, pd, x_cal):
    outcome = rng_med.choice([1.0, 0.5, 0.0], size=SIMS, p=[pw, pd, max(0.0, 1 - pw - pd)])
    resid = np.array([pools[o][i] for o, i in zip(outcome, rng_med.integers(0, 10**9, SIMS) % np.array([len(pools[o]) for o in outcome]))])
    return float(np.median((1 - cfg.xg_alpha) * outcome + x_cal + resid - e))
obs = []
for r in rows:
    mid, date, season, _lg, ri, hid, aid, hg, ag, hx, ax = r[:11]
    if mid not in info or mid not in site:
        continue
    d, cfg, e, s = info[mid]
    k = cfg.k_factor
    pw, pd, lh, la = site[mid]
    has_xg = mid in shots
    ex = expected_change(cfg, e, pw, pd, lh, la, has_xg)
    plug = ex + e - (1 - cfg.xg_alpha) * (pw + 0.5 * pd)
    ex_cal = ex - plug + (ca + cb * plug) if has_xg else ex
    ex_med = median_change(cfg, e, pw, pd, ca + cb * plug) if has_xg else ex
    hp = 3 if hg > ag else 1 if hg == ag else 0
    ap = 3 if ag > hg else 1 if hg == ag else 0
    sres = s - (pw + 0.5 * pd)
    for team, home, pts, xp, sign, exp in ((hid, True, hp, hx, 1, e), (aid, False, ap, ax, -1, 1 - e)):
        obs.append({"ref": refs[ri], "team": team, "season": season, "date": date, "home": home,
                    "xp": xp, "E": exp, "win": pts == 3,
                    "m": (pts - xp, sign * d / k, sign * sres, sign * (d / k - ex), sign * (d / k - ex_cal), sign * (d / k - ex_med))})
obs.sort(key=lambda o: o["date"])
NM = len(M)
print(f"team-matches {len(obs)}")
for j, name in enumerate(M):
    v = [o["m"][j] for o in obs]
    print(f"  {name:40s} mean {statistics.mean(v):+.4f}  sd {statistics.pstdev(v):.3f}")
mat = np.array([o["m"] for o in obs])
print("  correlations:", np.round(np.corrcoef(mat.T), 3))

# 1. Bias by strength: is a strong favourite's mean metric still ~0?
print("\n1. Mean metric by pre-match expectation (Elo E), SE in brackets")
edges = [0, 0.3, 0.45, 0.55, 0.7, 1.01]
for lo, hi in zip(edges, edges[1:]):
    g = [o for o in obs if lo <= o["E"] < hi]
    cells = []
    for j in range(NM):
        v = [o["m"][j] / statistics.pstdev(mat[:, j]) for o in g]  # in SDs, comparable
        cells.append(f"{statistics.mean(v):+.3f} ({statistics.pstdev(v) / math.sqrt(len(v)):.3f})")
    print(f"  E {lo:.2f}-{hi:.2f} n={len(g):4d}  " + "  ".join(cells))
print("  (values in per-match SDs of each metric; 0 = unbiased)")
wins = [o for o in obs if o["win"] and o["E"] >= 0.7]
print(f"  strong favourite (E>=0.70) WINS only, n={len(wins)}: " + "  ".join(
    f"{statistics.mean(o['m'][j] for o in wins) / statistics.pstdev(mat[:, j]):+.3f} SD" for j in range(NM)))


# 2. Split-half reliability over random splits
def split_half(key, min_n, label, reps=400, seed=1):
    groups = defaultdict(list)
    for o in obs:
        k = key(o)
        if k is not None:
            groups[k].append(o)
    groups = [g for g in groups.values() if len(g) >= min_n]
    rng = random.Random(seed)
    print(f"\n2. {label}: {len(groups)} groups with >= {min_n}")
    for j, name in enumerate(M):
        rs = []
        for _ in range(reps):
            a, b = [], []
            for g in groups:
                idx = list(range(len(g)))
                rng.shuffle(idx)
                h = len(idx) // 2
                a.append(statistics.mean(g[i]["m"][j] for i in idx[:h]))
                b.append(statistics.mean(g[i]["m"][j] for i in idx[h:]))
            rs.append(np.corrcoef(a, b)[0, 1])
        rs.sort()
        mean_r = statistics.mean(rs)
        sb = 2 * mean_r / (1 + mean_r) if mean_r > -1 else float("nan")
        print(f"   {name:40s} r {mean_r:+.3f}  [{rs[int(0.025 * reps)]:+.3f}, {rs[int(0.975 * reps)]:+.3f}]  full-sample reliability {sb:+.2f}")


split_half(lambda o: (o["ref"], o["team"]), 10, "referee x club")
split_half(lambda o: (o["ref"], o["team"]), 6, "referee x club")
split_half(lambda o: o["ref"] if o["home"] else None, 30, "referee home tilt (home side)")
split_half(lambda o: o["team"], 60, "club overall (control: clubs vs the model)")


# 3. Walk-forward: does a pair's past mean predict its next match?
def walk_forward(min_prior=4, shrink=10.0, from_season=2022):
    print(f"\n3. Walk-forward, predictor = past (ref, club) mean minus the club's past mean, "
          f"shrunk n/(n+{shrink:g}), >= {min_prior} prior pair matches, scored {from_season}+")
    for j, name in enumerate(M):
        pair = defaultdict(lambda: [0.0, 0])
        club = defaultdict(lambda: [0.0, 0])
        xs, ys_by = [], [[] for _ in range(NM)]
        for o in obs:
            p, c = pair[(o["ref"], o["team"])], club[o["team"]]
            if o["season"] >= from_season and p[1] >= min_prior and c[1] > p[1]:
                pm = p[0] / p[1]
                cm = c[0] / c[1]
                xs.append((pm - cm) * p[1] / (p[1] + shrink))
                for t in range(NM):
                    ys_by[t].append(o["m"][t])
            p[0] += o["m"][j]; p[1] += 1
            c[0] += o["m"][j]; c[1] += 1
        cells = []
        for t in range(NM):
            r = np.corrcoef(xs, ys_by[t])[0, 1]
            tstat = r * math.sqrt(len(xs) - 2) / math.sqrt(1 - r * r)
            cells.append(f"{r:+.3f} (t {tstat:+.2f})")
        print(f"   from {name:40s} n={len(xs)} -> next: " + " | ".join(cells))


walk_forward()
walk_forward(min_prior=2, shrink=5.0)
