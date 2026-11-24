"""The user's three examples (Brann, Viking, Lillestrom) season by season: division,
final place, points residual per match against the shipped blend."""
import sys
import numpy as np
import markov_common as M
import harness as H
from elitetracker.model.career import team_ids
d = M.build(cache=sys.argv[1])
names = {}
for m, lg, s in H.PLAYED:
    for side, t in enumerate(team_ids(m)):
        names[t] = (m.home if side == 0 else m.away)
want = {t: n for t, n in names.items() if any(k in str(n).lower() for k in ("brann", "viking", "lillestr"))}
print(want)
for t, n in want.items():
    print(n)
    for s in sorted(set(d["season"])):
        rows = np.nonzero((d["team"] == t) & (d["season"] == s))[0]
        if not len(rows): continue
        pts = d["pts"][rows].sum(); xp = d["xpts"][rows].sum()
        xr = d["xgd_res"][rows]; xr = xr[~np.isnan(xr)]
        print(f"   {s} {d['league'][rows[0]]:<12} n={len(rows):<2} pts {pts:4.0f} vs expected {xp:5.1f}  res/match {(pts-xp)/len(rows):+.2f}" + (f"  xGD res {xr.mean():+.2f}" if len(xr) > 10 else ""))
