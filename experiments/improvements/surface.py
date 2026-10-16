"""IMPROVEMENTS.md 1.10: grass vs artificial turf mismatch on home advantage.

Surfaces from Wikipedia's "List of Eliteserien venues" (fetched 2026-10-16:
venue surface plus the year a venue went artificial). Everything else is
artificial turf. Entries marked (?) come from that list's historical rows for
second-tier grounds and are the least certain.
"""
import math, sys
sys.path.insert(0, "experiments/improvements")
from harness import INDEX, PLAYED, WINDOWS, EloRun, ad_run, blend, elo_run, line, oos_report  # noqa: E402
from elitetracker.model.career import team_ids  # noqa: E402
import numpy as np

GRASS_UNTIL = {  # team id -> first date on artificial turf ("9999" = grass throughout)
    "8422": "9999", "8468": "9999", "8476": "9999", "8512": "9999", "8531": "9999",  # RBK, Brann, LSK, FKH, Bryne
    "8478": "2018-01-01",   # Viking: artificial since 2018
    "8609": "2024-01-01",   # Sandefjord (Jotun Arena): artificial since 2024
    "9918": "2023-08-01",   # Stabæk (Nadderud): artificial since August 2023
    "8007": "2017-01-01",   # Vålerenga: Ullevaal grass, Intility Arena from 2017
    "7937": "9999", "8405": "9999", "9812": "9999", "8133": "9999", "10224": "9999",  # (?) Hødd, Moss, Raufoss, Sandnes Ulf, Lyn
}

def grass(team, on):
    return on < GRASS_UNTIL.get(team, "0000")

feat = np.zeros((len(PLAYED), 2))  # [turf home vs grass visitor, grass home vs turf visitor]
for i, (m, _, _) in enumerate(PLAYED):
    h, a = team_ids(m)
    gh, ga = grass(h, m.date), grass(a, m.date)
    feat[i] = (float(not gh and ga), float(gh and not ga))
print(f"turf home v grass visitor: {feat[:, 0].sum():.0f} matches; grass home v turf visitor: {feat[:, 1].sum():.0f}")

base = elo_run(); grid = ad_run().probs; mix = blend(base, grid)
A16 = WINDOWS["all16"]
for col, label in ((0, "turf-home/grass-away"), (1, "grass-home/turf-away")):
    fam = {0: base}
    for g in (-30, -15, 15, 30, 50):
        e = elo_run(EloRun(home_shift=lambda m, lg, s, ctx, g=g, col=col: g * feat[INDEX[m.match_id], col]))
        fam[g] = e
        touched = A16 & (feat[:, col] > 0)
        print(line(f"1.10 {label} g={g} elo [touched]", e, base, touched))
        print(line(f"1.10 {label} g={g} blend [all16]", blend(e, grid), mix, A16))
    oos_report(f"1.10 {label} blend", {k: blend(v, grid) for k, v in fam.items()}, 0)
    # AD: the same shift on log-goals
    famad = {0: mix}
    for g in (-0.1, 0.1, 0.2):
        def hook(ad, h, a, on, lam, mu, g=g, col=col):
            gh, ga = grass(h, on), grass(a, on)
            on_ = (not gh and ga) if col == 0 else (gh and not ga)
            return (lam * math.exp(g / 2), mu * math.exp(-g / 2)) if on_ else (lam, mu)
        famad[g] = blend(base, ad_run(rates_hook=hook).probs)
        print(line(f"1.10 AD {label} g={g} blend [all16]", famad[g], mix, A16))
    oos_report(f"1.10 AD {label}", famad, 0)

print("\n== one term for any mismatch ==")
anym = feat.sum(axis=1)
fam = {0: base}
for g in (10, 15, 20, 25, 30, 40, 50):
    fam[g] = elo_run(EloRun(home_shift=lambda m, lg, s, ctx, g=g: g * anym[INDEX[m.match_id]]))
    print(line(f"1.10 any mismatch g={g} blend [all16]", blend(fam[g], grid), mix, A16))
    print(line(f"1.10 any mismatch g={g} elo [all16]", fam[g], base, A16))
oos_report("1.10 any mismatch blend", {k: blend(v, grid) for k, v in fam.items()}, 0, windows=("all16", "es16", "ob16", "xg"))
oos_report("1.10 any mismatch elo", fam, 0, windows=("all16", "es16", "ob16", "xg"))
