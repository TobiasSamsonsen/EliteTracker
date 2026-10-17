"""IMPROVEMENTS2.md Rank 8, on elo-v15.0: travel distance and derbies.

The distance between the two clubs' home grounds (great circle; the grounds
below to about a kilometre, written from known locations, not scraped)
shapes the home advantage:
    log distance:  home + beta * ln(max(d, 15) / 280)  Elo points
    derby damper:  home - delta when d < 35 km
on the prediction only, or in the rating update too (as the home
advantage itself is); then the goals model's home term likewise
(lam x exp(beta_ad ln(max(d, 15) / 280))).

    PYTHONPATH=experiments/improvements .venv/Scripts/python experiments/improvements/rank8_distance.py
"""

from __future__ import annotations

import itertools
import math

import numpy as np

import harness as h
import rules as r
from elitetracker.model.career import team_ids

# team id -> (lat, lon) of the home ground.
GROUND = {
    "8404": (62.465, 6.193),    # Aalesund, Color Line Stadion
    "257932": (58.461, 8.768),  # Arendal
    "8402": (67.276, 14.392),   # Bodø/Glimt, Aspmyra
    "8468": (60.367, 5.358),    # Brann, Brann Stadion
    "8531": (58.735, 5.648),    # Bryne
    "8137": (59.890, 10.525),   # Bærum, Sandvika
    "4722": (58.452, 6.002),    # Egersund
    "2292": (60.881, 11.563),   # Elverum
    "8512": (59.413, 5.268),    # Haugesund
    "4319": (61.600, 5.032),    # Florø
    "7963": (59.720, 10.835),   # Follo, Ski
    "8417": (59.212, 10.940),   # Fredrikstad
    "4201": (59.961, 10.882),   # Grorud, Oslo
    "8448": (60.795, 11.072),   # HamKam, Briskeby
    "7937": (62.341, 5.852),    # Hødd, Ulsteinvik
    "8067": (60.168, 10.255),   # Hønefoss
    "2303": (58.342, 8.594),    # Jerv, Grimstad
    "2305": (59.897, 10.776),   # KFUM, Ekeberg
    "8179": (60.191, 11.998),   # Kongsvinger, Gjemselund
    "8605": (63.111, 7.732),    # Kristiansund
    "6561": (63.746, 11.300),   # Levanger
    "8476": (59.963, 11.048),   # Lillestrøm, Åråsen
    "10224": (59.925, 10.733),  # Lyn, Bislett
    "6541": (59.750, 10.020),   # Mjøndalen
    "9917": (62.734, 7.150),    # Molde, Aker Stadion
    "8405": (59.440, 10.670),   # Moss, Melløs
    "9929": (59.560, 9.260),    # Notodden
    "7988": (59.205, 9.610),    # Odd, Skien
    "6563": (63.425, 10.535),   # Ranheim
    "9812": (60.722, 10.610),   # Raufoss
    "8422": (63.412, 10.405),   # Rosenborg, Lerkendal
    "8609": (59.130, 10.220),   # Sandefjord
    "8133": (58.850, 5.740),    # Sandnes Ulf
    "8509": (59.283, 11.110),   # Sarpsborg 08
    "8421": (59.945, 10.770),   # Skeid, Nordre Åsen
    "8616": (61.230, 7.100),    # Sogndal
    "9918": (59.924, 10.590),   # Stabæk, Nadderud
    "9919": (58.143, 7.990),    # Start, Kristiansand
    "4393": (63.470, 10.920),   # Stjørdals-Blink
    "4249": (59.948, 11.010),   # Strømmen
    "8180": (59.744, 10.190),   # Strømsgodset, Marienlyst
    "8617": (69.650, 19.010),   # Tromsdalen
    "8608": (69.650, 18.960),   # Tromsø, Alfheim
    "10232": (60.142, 11.172),  # Ull/Kisa, Jessheim
    "8478": (58.922, 5.733),    # Viking, Jåttåvågen
    "8007": (59.915, 10.806),   # Vålerenga, Valle Hovin
    "10021": (60.465, 5.330),   # Åsane, Myrdal
    "1706": (60.405, 5.030),    # Øygarden, Ågotnes
}


def km(a: str, b: str) -> float:
    (la1, lo1), (la2, lo2) = GROUND[a], GROUND[b]
    p1, p2 = math.radians(la1), math.radians(la2)
    dp, dl = p2 - p1, math.radians(lo2 - lo1)
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(x))


DIST = np.array([km(*team_ids(m)) for m, _, _ in h.PLAYED])
DERBY = h.mask() & (DIST < 35)


def log_term(m) -> float:
    return math.log(max(km(*team_ids(m)), 15.0) / 280.0)


def elo_log(beta: float):
    return lambda m, lg, season, ctx: beta * log_term(m)


def elo_derby(delta: float):
    return lambda m, lg, season, ctx: -delta if km(*team_ids(m)) < 35 else 0.0


def ad_log(beta: float) -> np.ndarray:
    order = iter(h.PLAYED)

    def hook(ad, home, away, on, lam, mu):
        m = next(order)[0]
        return lam * math.exp(beta * log_term(m)), mu
    return h.ad_run(rates_hook=hook).probs


def residuals() -> None:
    pts = np.where(h.Y == 0, 1.0, np.where(h.Y == 1, 0.5, 0.0))
    exp = r.BASE[:, 0] + 0.5 * r.BASE[:, 1]
    keep = h.mask()
    for lo, hi in ((0, 35), (35, 150), (150, 400), (400, 800), (800, 2000)):
        sel = keep & (DIST >= lo) & (DIST < hi)
        res = pts[sel] - exp[sel]
        print(f"  {lo}-{hi} km: {int(sel.sum())} matches, home points share actual - expected "
              f"{res.mean():+.4f} (t {h.tstat(res):+.2f})")


if __name__ == "__main__":
    print(f"distances 2016+: median {np.median(DIST[h.mask()]):.0f} km; derbies under 35 km: {int(DERBY.sum())}")
    residuals()
    extra = {"derby": DERBY}
    wins = ("all16", "es16", "ob16", "derby")
    for in_update in (False, True):
        tag = "rating update too" if in_update else "prediction only"
        fam = {0: r.BASE}
        for beta in (-10, -5, 5, 10, 15, 20):
            e = h.elo_run(h.EloRun(home_shift=elo_log(beta), shift_in_update=in_update))
            fam[beta] = h.blend(e, r.BASE_AD.probs)
            c = h.compare(fam[beta], r.BASE, r.W["all16"])
            print(f"  log distance, beta {beta}, {tag}: LL {c['ll'][0]:+.5f} (t {c['ll'][1]:+.2f})")
        r.one_knob(f"log distance, Elo, {tag}, walk-forward", fam, 0)
        fam = {0: r.BASE}
        for delta in (15, 25, 35):
            e = h.elo_run(h.EloRun(home_shift=elo_derby(delta), shift_in_update=in_update))
            fam[delta] = h.blend(e, r.BASE_AD.probs)
            c = h.compare(fam[delta], r.BASE, DERBY)
            print(f"  derby damper {delta}, {tag}: derbies LL {c['ll'][0]:+.5f} (t {c['ll'][1]:+.2f})")
        r.table(f"derby damper 25, {tag}", fam[25], extra=extra, windows=wins)
        r.one_knob(f"derby damper, Elo, {tag}, walk-forward", fam, 0)
    fam = {0: r.BASE}
    for beta in (-0.04, -0.02, 0.02, 0.04, 0.06):
        fam[beta] = h.blend(r.BASE_ELO, ad_log(beta))
        c = h.compare(fam[beta], r.BASE, r.W["all16"])
        print(f"  log distance, goals model, beta {beta}: LL {c['ll'][0]:+.5f} (t {c['ll'][1]:+.2f})")
    r.one_knob("log distance, goals model, walk-forward", fam, 0)
