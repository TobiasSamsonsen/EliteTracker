"""IMPROVEMENTS.md 2.1: penalties and red cards, re-tested on elo-v13.0 with the
local match extras (Eliteserien 2020-2026: data/raw/fotmob_match_extras.json)."""
import json, math, sys
import numpy as np
sys.path.insert(0, "experiments/improvements")
from harness import INDEX, PLAYED, SHOTS, WINDOWS, EloRun, ad_run, blend, elo_run, line, oos_report  # noqa: E402
from elitetracker.model.career import team_ids  # noqa: E402

X = json.load(open("data/raw/fotmob_match_extras.json", encoding="utf-8"))
base_elo = elo_run(); base_ad = ad_run(); base = blend(base_elo, base_ad.probs)
keep = WINDOWS["xg"] & np.array([m.match_id in X for m, _, _ in PLAYED])
pens = sum(1 for v in X.values() for s in v["shots"] if s[3] == "Penalty")
print(f"extras: {len(X)} matches, {pens} penalties; scored with extras: {keep.sum()}")

def pen_shots(weight):
    out = dict(SHOTS)
    for mid, v in X.items():
        if mid not in SHOTS:
            continue
        adj = [0.0, 0.0]
        for minute, side, xg, situation, *_ in v["shots"]:
            if situation == "Penalty":
                adj[side] += (weight - 1.0) * xg
        s = SHOTS[mid]
        out[mid] = (max(0.0, s[0] + adj[0]), max(0.0, s[1] + adj[1])) + tuple(s[2:])
    return out

fam = {1.0: base}
for w in (0.0, 0.5, 1.5):
    sh = pen_shots(w)
    fam[w] = blend(elo_run(EloRun(shots=sh)), ad_run(shots=sh).probs)
    print(line(f"penalty xG x{w}", fam[w], base, keep))
oos_report("penalty weight", fam, 1.0, first=2021, restrict=keep, windows=("xg",))

red = {}
for mid, v in X.items():
    mins = [c[0] for c in v["cards"] if c[2] in ("Red", "YellowRed")]
    if mins:
        red[mid] = min(mins)
print(f"matches with a red card: {len(red)}; before 60': {sum(1 for m in red.values() if m < 60)}")
fam = {0.0: base}
for strength in (0.35, 0.65):
    def rk(mid, s=strength):
        r = red.get(mid)
        return 1.0 if r is None else 1.0 - s * max(0.0, (90 - r) / 90)
    e = elo_run(EloRun(k_mult=lambda m, lg, season, ctx: rk(m.match_id)))
    a = ad_run(k_hook=lambda ad, team, m: rk(m.match_id))
    fam[strength] = blend(e, a.probs)
    print(line(f"red-card down-weight {strength}", fam[strength], base, keep))
oos_report("red-card down-weight", fam, 0.0, first=2021, restrict=keep, windows=("xg",))
