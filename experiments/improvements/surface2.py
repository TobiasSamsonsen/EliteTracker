"""IMPROVEMENTS.md 1.10, pursued (October 2026): the pitch-surface mismatch
re-tested on elo-v13.0 with a checked surface table.

Sources: Wikipedia's "List of Eliteserien venues" (surface and the year a
venue went artificial), then per ground: Nye Høddvoll (artificial, Hødd's home
since April 2015), Melløs (Moss, natural grass, NFF's facility register),
Øster Hus Arena (Sandnes Ulf from 2020, artificial; Sandnes Stadion before,
natural), Nammo stadion (Raufoss, artificial), Bislett (Lyn, grass). Every
club not listed plays on artificial turf.

    .venv/Scripts/python experiments/improvements/surface2.py
"""
import math
import sys

import numpy as np

sys.path.insert(0, "experiments/improvements")
from harness import INDEX, LEAGUE, PLAYED, SEASON, WINDOWS, EloRun, ad_run, blend, elo_run, line, oos_report  # noqa: E402
from elitetracker.model.career import team_ids  # noqa: E402

# team id -> the first date on artificial turf; "9999" = grass throughout.
GRASS_UNTIL = {
    "8422": "9999",        # Rosenborg, Lerkendal
    "8468": "9999",        # Brann, Brann Stadion
    "8476": "9999",        # Lillestrøm, Åråsen
    "8512": "9999",        # Haugesund
    "8531": "9999",        # Bryne
    "8405": "9999",        # Moss, Melløs
    "10224": "9999",       # Lyn, Bislett
    "8478": "2018-01-01",  # Viking: artificial since 2018
    "8007": "2017-01-01",  # Vålerenga: Ullevaal, then Intility Arena from 2017
    "9918": "2023-08-01",  # Stabæk, Nadderud: artificial since August 2023
    "8609": "2024-01-01",  # Sandefjord, Jotun Arena: artificial since 2024
    "8133": "2020-01-01",  # Sandnes Ulf: Sandnes Stadion, then Øster Hus Arena from 2020
}


def grass(team, on):
    return on < GRASS_UNTIL.get(team, "0000")


MISMATCH = np.array([float(grass(team_ids(m)[0], m.date) != grass(team_ids(m)[1], m.date)) for m, _, _ in PLAYED])
GRASS_HOME = np.array([float(grass(team_ids(m)[0], m.date) and not grass(team_ids(m)[1], m.date)) for m, _, _ in PLAYED])
TURF_HOME = MISMATCH - GRASS_HOME


def elo_shift(feature, g):
    return lambda m, lg, s, ctx: g * feature[INDEX[m.match_id]]


def ad_shift(feature, g):
    lookup = {(*team_ids(m), m.date): feature[i] for i, (m, _, _) in enumerate(PLAYED)}

    def hook(ad, h, a, on, lam, mu):
        d = g * lookup.get((h, a, on), 0.0) / 2
        return lam * math.exp(d), mu * math.exp(-d)
    return hook


def main():
    base_elo = elo_run()
    base_ad = ad_run()
    base = blend(base_elo, base_ad.probs)
    A16 = WINDOWS["all16"]
    print(f"mismatched matches 2016+: {int(MISMATCH[A16].sum())} of {int(A16.sum())} "
          f"(grass home v turf visitor {int(GRASS_HOME[A16].sum())}, turf home v grass visitor {int(TURF_HOME[A16].sum())})")
    print("Eliteserien share mismatched:", f"{MISMATCH[A16 & (LEAGUE == 'eliteserien')].mean():.1%}",
          "OBOS:", f"{MISMATCH[A16 & (LEAGUE == 'obosligaen')].mean():.1%}")
    families = {}
    for label, feature in (("any", MISMATCH), ("grass-home", GRASS_HOME), ("turf-home", TURF_HOME)):
        elo_fam, ad_fam, both_fam = {0: base}, {0: base}, {0: base}
        for g in (5, 10, 15, 20, 30):
            e = elo_run(EloRun(home_shift=elo_shift(feature, g)))
            elo_fam[g] = blend(e, base_ad.probs)
            gl = g * 0.22 / 60  # the same edge in log goals, as the two models' home terms relate
            a = ad_run(rates_hook=ad_shift(feature, gl))
            ad_fam[g] = blend(base_elo, a.probs)
            both_fam[g] = blend(e, a.probs)
            for name, fam in (("Elo", elo_fam), ("AD", ad_fam), ("both", both_fam)):
                print(line(f"{label} {name} g={g}", fam[g], base, A16))
        for name, fam in (("Elo", elo_fam), ("AD", ad_fam), ("both", both_fam)):
            families[(label, name)] = fam
            oos_report(f"{label} {name}", fam, 0, windows=("all16", "es16", "ob16", "xg"))
    # Per division: each division's own value, chosen walk-forward on that division.
    for league in ("eliteserien", "obosligaen"):
        fam = families[("any", "both")]
        keep = LEAGUE == league
        oos_report(f"any both, {league} only", fam, 0, restrict=keep, windows=("es16" if league == "eliteserien" else "ob16",))


if __name__ == "__main__" and not sys.argv[1:]:
    main()


def eliteserien_only():
    """The mismatch edge for Eliteserien matches only, a wider grid, chosen and
    scored on Eliteserien."""
    base_elo = elo_run()
    base_ad = ad_run()
    base = blend(base_elo, base_ad.probs)
    es = (LEAGUE == "eliteserien").astype(float)
    elo_fam, both_fam = {0: base}, {0: base}
    for g in (10, 20, 30, 40, 50, 60, 80):
        e = elo_run(EloRun(home_shift=elo_shift(MISMATCH * es, g)))
        elo_fam[g] = blend(e, base_ad.probs)
        a = ad_run(rates_hook=ad_shift(MISMATCH * es, g * 0.22 / 60))
        both_fam[g] = blend(e, a.probs)
        print(line(f"ES-only Elo g={g}", elo_fam[g], base, WINDOWS["es16"]))
        print(line(f"ES-only both g={g}", both_fam[g], base, WINDOWS["es16"]))
        print(line(f"ES-only Elo g={g} (Elo odds)", e, base_elo, WINDOWS["es16"]))
    keep = LEAGUE == "eliteserien"
    oos_report("ES-only Elo", elo_fam, 0, restrict=keep, windows=("es16", "all16"))
    oos_report("ES-only both", both_fam, 0, restrict=keep, windows=("es16", "all16"))


if __name__ == "__main__" and sys.argv[1:] == ["es"]:
    eliteserien_only()
