"""FROZEN CHECKS, defined 23 November 2026, before the seasons they test. Nothing here may be
retuned; rerun as a season is added and append the numbers to PROJECT_STATUS.md ("Shocks,
rebounds and a Markov chain over results"). The seasons the definitions were chosen on are
2016-2025 and 2026 up to that date; a season from 2027 is clean, 2026 is partly seen.

  A. relegated clubs' first season in OBOS-ligaen: long-run level (memory 0.9, markov_history_common)
     against the club-season points residual a match vs the shipped blend. Hypothesis: slope > 0
     (+0.091 per sd on 2016-2025, permutation p 0.062). Reported for the seasons from FIRST and pooled.
  B. the step-9 rebound term, one setting: after the offseason pull a club whose last season missed the
     blend by more than 0.1 points a match is lifted by 100 x (-residual - 0.1) Elo points and
     0.3 x (-residual - 0.1) in the goals model's attack and defence; scored against the shipped
     blend on the matches of the seasons from FIRST. Hypothesis: log loss, Brier and RPS below zero.
  C. (by hand, once Eliteserien 2026 is final) season_check.py --sd 0.20 and --sd 0.25, then
     season_sd_oos.py: the strength shock stays 0.20 unless 0.25 is better on both measures.

    .venv/Scripts/python -X utf8 experiments/improvements/frozen_checks.py CACHE [FIRST=2026]
"""
import sys
import numpy as np
import markov_common as M
import markov_history_common as HC
import harness as H

CACHE = sys.argv[1]; FIRST = int(sys.argv[2]) if len(sys.argv) > 2 else 2026
d = M.build(cache=CACHE)
names, id2key, score, div = HC.build(d)
rows = {}
for r in range(len(d["mi"])): rows.setdefault((d["team"][r], d["season"][r]), []).append(r)
RES = {k: d["pts_res"][np.array(rr)].mean() for k, rr in rows.items() if len(rr) >= 20}

print(f"A. relegated clubs' first OBOS-ligaen season, level (memory 0.9) vs residual; seasons from {FIRST} and pooled 2016+")
LT = HC.level_table(score, id2key, div, 0.9)
def slope(sub):
    lv = np.array([x[2] for x in sub]); y = np.array([x[3] for x in sub])
    return (np.polyfit(lv, y, 1)[0] * lv.std(), np.corrcoef(lv, y)[0, 1]) if len(sub) >= 5 and lv.std() > 0 else (float("nan"), float("nan"))
rel = [(t, s, LT[(t, s)][0], RES[(t, s)]) for (t, s) in sorted(LT, key=lambda x: x[1]) if LT[(t, s)][1] == "rel" and (t, s) in RES]
for t, s, l, r_ in rel:
    if s >= FIRST: print(f"   {s} {names[t]:<18} level {l:+5.2f}  residual {r_:+.2f}  ({len(rows[(t, s)])} matches)")
new_ = [x for x in rel if x[1] >= FIRST]; old_ = [x for x in rel if x[1] < FIRST]
print(f"   from {FIRST}: n={len(new_)}  slope per sd {slope(new_)[0]:+.3f} corr {slope(new_)[1]:+.2f}   |   before: n={len(old_)} slope {slope(old_)[0]:+.3f}   |   pooled n={len(rel)} slope {slope(rel)[0]:+.3f}")
if new_: print(f"   mean residual from {FIRST}: {np.mean([x[3] for x in new_]):+.3f}; predicted sign for the level-weighted mean: positive")

print(f"\nB. the step-9 rebound term, frozen (100 Elo points / 0.3 log goals per 1.0 of residual past 0.1), seasons from {FIRST}")
from elitetracker.model.elo import EloConfig, era_config
elo0 = H.elo_run(); ad0 = H.ad_run(); mix0 = H.blend(elo0, ad0.probs)
def off(season, ratings):
    for t in ratings:
        r = RES.get((t, season - 1))
        if r is not None: ratings[t] += 100.0 * max(-r - 0.1, 0.0)
def hook(ad, season):
    for t in list(ad.attack):
        r = RES.get((t, season - 1))
        if r is not None:
            b = 0.3 * max(-r - 0.1, 0.0); ad.attack[t] += b; ad.defence[t] += b
mix = H.blend(H.elo_run(H.EloRun(offseason=off)), H.ad_run(season_hook=hook).probs)
for label, keep in ((f"seasons {FIRST}+", H.SEASON >= FIRST), ("2016+ (in sample, for reference)", H.SEASON >= 2016), ("xG matches from " + str(FIRST), (H.SEASON >= FIRST) & H.HAS_XG)):
    if keep.sum() < 50: print(f"   {label}: n={int(keep.sum())}, too few"); continue
    print("   " + H.line(label, mix, mix0, keep)[:200])
