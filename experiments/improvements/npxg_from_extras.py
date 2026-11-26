"""Fill npxG and the first red card's minute into data/xg.json's Eliteserien
entries that hold only [xg, xg, xgot, xgot], from the local shots in
data/raw/fotmob_match_extras.json (elo-v19.0, November 2026). No network.

npxG = the stored xG less the side's penalty xG from the shots (sides oriented
by shots_local.py: the extras' `side` is 1 for home); the red minute is the
first red or second yellow, 90 when there was none -- the 7-value shape
`sources.fotmob.parse_match_details` has written since October 2026.

    .venv/Scripts/python experiments/improvements/npxg_from_extras.py [--write]
"""
import sys
sys.path.insert(0, "experiments/improvements")
import shots_local as s  # noqa: E402
from elitetracker.sources.fotmob import load_xg, save_xg  # noqa: E402

data = load_xg()
filled, worst, pens = 0, 0.0, 0
for mid, values in data["matches"].items():
    if len(values) != 4 or mid not in s.HOME:
        continue
    hs = s.HOME[mid]
    pen = [0.0, 0.0]
    raw = [0.0, 0.0]
    for minute, side, xg, situation, *_ in s.X[mid]["shots"]:
        i = 0 if side == hs else 1
        raw[i] += xg
        if situation == "Penalty":
            pen[i] += xg
            pens += 1
    worst = max(worst, abs(raw[0] - values[0]), abs(raw[1] - values[1]))
    reds = [c[0] for c in s.X[mid]["cards"] if c[2] in ("Red", "YellowRed")]
    values += [round(max(0.0, values[0] - pen[0]), 3), round(max(0.0, values[1] - pen[1]), 3),
               min(reds) if reds else 90]
    filled += 1
left = sum(1 for v in data["matches"].values() if len(v) == 4)
print(f"filled {filled} matches ({pens} penalties); largest gap shots vs stored xG {worst:.3f}; "
      f"still without npxG: {left}")
if "--write" in sys.argv:
    save_xg(data)
    print("written")
