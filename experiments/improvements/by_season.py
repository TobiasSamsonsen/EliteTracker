"""Per season x division deltas for the 1.7/1.8 candidates (fixed values)."""
import math, sys
sys.path.insert(0, "experiments/improvements")
from context_terms import BASE_ELO, BASE_MIX, COUNT, ad_target  # noqa: E402
from harness import LEAGUE, SEASON, Y, ad_run, blend, losses, tstat  # noqa: E402
import numpy as np
cands = {
    "value b=0.3": ad_run(season_hook=ad_target(0.3, "prev")),
    "early g=0.5": ad_run(k_hook=lambda ad, t, m: 1.0 + 0.5 * math.exp(-COUNT[(t, m.date)] / 3.0)),
}
base = losses(BASE_MIX)["ll"]
for name, out in cands.items():
    d = losses(blend(BASE_ELO, out.probs))["ll"] - base
    print(name)
    for lg in ("eliteserien", "obosligaen"):
        row = []
        for s in range(2016, 2027):
            k = (SEASON == s) & (LEAGUE == lg)
            row.append(f"{s}:{d[k].mean():+.4f}")
        k = (LEAGUE == lg) & (SEASON >= 2023)
        print(f"  {lg[:4]} " + " ".join(row) + f" | 2023+ {d[k].mean():+.5f} t {tstat(d[k]):+.2f}")
    # rounds 1-10 vs later
    early = np.array([1 if r else 0 for r in (SEASON >= 2016)])
