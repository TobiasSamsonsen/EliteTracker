"""Step 6: a strength shock that differs by division (the persistent club-season
spread was 0.05 for Eliteserien and 0.10 for OBOS-ligaen in markov_e). Reads the
season_check.py files for several shock sizes; per division, in-sample table and a
walk-forward pick (each season from 2019 with the sd that did best on the earlier
seasons of that division), against the shipped 0.20 on the same season-leagues.

    python markov_f_sd.py SD=FILE ...
"""
import json, math, sys
import numpy as np

files = {float(a.split("=", 1)[0]): a.split("=", 1)[1] for a in sys.argv[1:]}
def clusters(path):
    out = {}
    for r in json.loads(open(path).read()):
        out.setdefault((r["season"], r["league"]), []).append((r["rps"], r["ll"]))
    return {k: np.array(v).mean(axis=0) for k, v in out.items()}
runs = {sd: clusters(p) for sd, p in files.items()}
base = 0.20
keys = sorted(runs[base])
def t(d):
    d = np.asarray(d)
    return d.mean() / (d.std(ddof=1) / math.sqrt(len(d))) if len(d) > 1 and d.std() > 0 else 0.0
print("in-sample, per division (mean over 10 seasons; d vs sd 0.20; t over the 10 season-leagues)")
for lg in ("eliteserien", "obosligaen"):
    ks = [k for k in keys if k[1] == lg]
    for sd in sorted(runs):
        rps = np.array([runs[sd][k][0] for k in ks]); ll = np.array([runs[sd][k][1] for k in ks])
        drps = rps - np.array([runs[base][k][0] for k in ks]); dll = ll - np.array([runs[base][k][1] for k in ks])
        print(f"  {lg:<12} sd {sd:.2f}  RPS {rps.mean():.5f} (d {drps.mean():+.5f}, t {t(drps):+5.2f})   LL {ll.mean():.4f} (d {dll.mean():+.4f}, t {t(dll):+5.2f})")
print("\nwalk-forward, per division: pick by RPS over the earlier seasons of that division")
tot = {"rps": [], "ll": []}
for lg in ("eliteserien", "obosligaen"):
    picks = {}
    for season in range(2019, 2026):
        prior = [k for k in keys if k[1] == lg and k[0] < season]
        best = min(runs, key=lambda sd: (np.mean([runs[sd][k][0] for k in prior]), sd != base))
        picks[season] = best
        k = (season, lg)
        tot["rps"].append(runs[best][k][0] - runs[base][k][0]); tot["ll"].append(runs[best][k][1] - runs[base][k][1])
    print(f"  {lg} picks: " + " ".join(f"{s}:{p}" for s, p in picks.items()))
for m in ("rps", "ll"):
    a = np.array(tot[m]); print(f"  per-division walk-forward vs 0.20, {m}: {a.mean():+.5f} (t {t(a):+.2f}, {len(a)} season-leagues)")
# one shared pick, same rule (what season_sd_oos.py does)
sh = {"rps": [], "ll": []}
for season in range(2019, 2026):
    prior = [k for k in keys if k[0] < season]
    best = min(runs, key=lambda sd: (np.mean([runs[sd][k][0] for k in prior]), sd != base))
    for lg in ("eliteserien", "obosligaen"):
        k = (season, lg); sh["rps"].append(runs[best][k][0] - runs[base][k][0]); sh["ll"].append(runs[best][k][1] - runs[base][k][1])
picks_sh = {}
for season in range(2019, 2026):
    prior = [k for k in keys if k[0] < season]
    picks_sh[season] = min(runs, key=lambda sd: (np.mean([runs[sd][k][0] for k in prior]), sd != base))
print("  shared picks: " + " ".join(f"{s}:{p}" for s, p in picks_sh.items()))
for m in ("rps", "ll"):
    a = np.array(sh[m]); print(f"  one shared walk-forward pick vs 0.20, {m}: {a.mean():+.5f} (t {t(a):+.2f})")
