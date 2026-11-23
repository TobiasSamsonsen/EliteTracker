"""Step 1: descriptive Markov pass. Mean next-match residual by current state."""
import sys, math, time
from pathlib import Path
import numpy as np
import markov_common as M

CACHE = sys.argv[1]
d = M.build(cache=CACHE)
g = M.cluster_ids(d)
prev1 = M.group_prev(d, 1)
prev2 = M.group_prev(d, 2)
prev3 = M.group_prev(d, 3)

SIGNALS = ["pts_res", "z_pts", "gd_res", "gf_res", "ga_res", "xg_res", "xga_res", "xgd_res", "xgpts_res", "luck_res", "fin_res", "keep_res"]
TARGETS = ["pts_res", "gd_res", "xgd_res", "xgpts_res"]
QS = [0, 5, 30, 70, 95, 100]

def fmt(m, se):
    return f"{m:+.3f}({m/se:+.1f})" if se > 0 else "  n/a"

def run(lag_prev, label):
    print(f"\n=== next-match target after the state {label} (cluster t by club-season) ===")
    for tgt in TARGETS:
        print(f"-- target {tgt}")
        for s in SIGNALS:
            x = d[s]; y = d[tgt]
            ok = np.nonzero(lag_prev >= 0)[0]
            sx = x[lag_prev[ok]]; yy = y[ok]
            keep = ~np.isnan(sx) & ~np.isnan(yy)
            sx, yy, gg = sx[keep], yy[keep], g[ok][keep]
            if len(yy) < 500: continue
            sd = sx.std()
            cuts = np.percentile(sx, QS)
            cells = []
            for lo, hi in zip(cuts[:-1], cuts[1:]):
                sel = (sx >= lo) & (sx <= hi) if hi == cuts[-1] else (sx >= lo) & (sx < hi)
                cells.append(fmt(*M.cluster_mean(yy[sel], gg[sel])) if sel.sum() > 30 else "n/a")
            # piecewise slope: core clipped at +-1.5sd, tails
            c = 1.5 * sd
            core = np.clip(sx, -c, c); up = np.maximum(sx - c, 0); dn = np.minimum(sx + c, 0)
            X = np.column_stack([np.ones(len(sx)), core / sd, up / sd, dn / sd])
            b, se = M.cluster_ols(X, yy, gg)
            print(f"  {s:<10} n={len(yy):<5} bins[<5,5-30,30-70,70-95,>95]: " + "  ".join(cells) +
                  f" | core {b[1]:+.3f}({b[1]/se[1]:+.1f}) up {b[2]:+.3f}({b[2]/se[2]:+.1f}) dn {b[3]:+.3f}({b[3]/se[3]:+.1f})")

run(prev1, "of the previous match (lag 1)")
run(prev2, "two matches ago (lag 2)")
run(prev3, "three matches ago (lag 3)")
