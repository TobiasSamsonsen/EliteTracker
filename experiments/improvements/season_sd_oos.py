"""The strength shock chosen walk-forward from season_check.py's files: each
season from 2019 is scored with the shock whose season odds (RPS over the
places, all cuts, both divisions) did best on the seasons before it, against
the shipped shock on the same season-leagues; t over the season-league
clusters, as season_check.py's --compare.

    .venv/Scripts/python experiments/improvements/season_sd_oos.py BASE_SD SD=FILE ...
"""
import json
import math
import sys
from pathlib import Path

import numpy as np


def clusters(path):
    out = {}
    for r in json.loads(Path(path).read_text()):
        out.setdefault((r["season"], r["league"]), []).append((r["rps"], r["ll"]))
    return {k: np.array(v).mean(axis=0) for k, v in out.items()}


def t(d):
    d = np.asarray(d)
    return d.mean() / (d.std(ddof=1) / math.sqrt(len(d)))


def main(base, files):
    runs = {sd: clusters(path) for sd, path in files.items()}
    keys = sorted(runs[base])
    picks, rows = {}, []
    for season in range(2019, 2026):
        prior = [k for k in keys if 2016 <= k[0] < season]
        best = min(runs, key=lambda sd: (np.mean([runs[sd][k][0] for k in prior]), sd != base))
        picks[season] = best
        rows += [(k, runs[best][k] - runs[base][k]) for k in keys if k[0] == season]
    print("picks: " + " ".join(f"{s}:{p}" for s, p in picks.items()))
    d = np.array([v for _, v in rows])
    early = np.array([v for k, v in rows if k[0] <= 2021])
    late = np.array([v for k, v in rows if k[0] >= 2022])
    for i, name in enumerate(("RPS over places", "log loss of the place")):
        print(f"{name}: {d[:, i].mean():+.5f} (t {t(d[:, i]):+.2f}), 2019-2021 {early[:, i].mean():+.5f}, "
              f"2022-2025 {late[:, i].mean():+.5f} ({len(d)} season-leagues)")


if __name__ == "__main__":
    base = float(sys.argv[1])
    main(base, {float(a.split("=", 1)[0]): a.split("=", 1)[1] for a in sys.argv[2:]})
