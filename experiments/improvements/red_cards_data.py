"""Red cards per match from local files, for red_cards_v18.py and
man_advantage_fine.py.

data/raw/fotmob_match_extras.json (Eliteserien 2020-2026; its `side` is 1 for
the home team in most matches, so each match is oriented by its shots against
the stored xG, as shots_local.py does) and data/raw/fotmob_match_cards.json
(fetch_red_cards.py: Eliteserien 2015-2019 and 2026's later rounds, OBOS-ligaen
2015-2026; side 0 is home).
"""
import json, sys, time
from pathlib import Path
import numpy as np
sys.path.insert(0, "experiments/improvements")
from harness import PLAYED, SHOTS  # noqa: E402

EXTRAS_ONLY = "--extras-only" in sys.argv
X = json.load(open("data/raw/fotmob_match_extras.json", encoding="utf-8"))
NEW = Path("data/raw/fotmob_match_cards.json")
REDS = ("Red", "YellowRed")


def home_side(mid: str) -> int:
    """The extras' `side` value of the home team (shots_local.home_side)."""
    shots, stored = X[mid]["shots"], SHOTS.get(mid)
    if not shots or not stored:
        return 1
    s = [sum(x[2] for x in shots if x[1] == k) for k in (0, 1)]
    return 0 if abs(s[0] - stored[0]) + abs(s[1] - stored[1]) <= abs(s[1] - stored[0]) + abs(s[0] - stored[1]) else 1


# RED[mid]: [(minute, home was sent off)], for every match with card data.
RED: dict[str, list[tuple[int, bool]]] = {}
for mid, v in X.items():
    hs = home_side(mid)
    RED[mid] = [(min(90, c[0]), c[1] == hs) for c in v["cards"] if c[2] in REDS]
if not EXTRAS_ONLY and NEW.exists():
    for _ in range(10):  # the fetch may be rewriting the file as it runs
        try:
            cards = json.loads(NEW.read_text(encoding="utf-8"))["matches"]
            break
        except json.JSONDecodeError:
            time.sleep(0.3)
    for mid, v in cards.items():
        RED.setdefault(mid, [(min(90, c[0]), c[1] == 0) for c in v["cards"] if c[2] in REDS])

# ADV[mid]: the home side's net man advantage as the share of 90 minutes played with it.
ADV = {mid: sum((-1 if home else 1) * (90 - t) / 90 for t, home in r) for mid, r in RED.items() if r}
EARLY = {mid for mid, r in RED.items() if r and min(t for t, _ in r) < 60}


def cover() -> np.ndarray:
    return np.array([m.match_id in RED for m, _, _ in PLAYED])
