"""The gap between the divisions set by squad value (October 2026, elo-v14.0).

The owner's idea: base the difference between Eliteserien and OBOS-ligaen on
the difference in their clubs' average or median squad value. Today the gap
is seeded once (the 2014 ladder: an OBOS finish 14 places down in Elo; the
goals model's `division_gap` 0.25) and then carried: each offseason pulls a
club toward its own division's mean and no match crosses the divisions, so
only the clubs going up and down move it. Shifting a whole division changes
nothing inside it; what changes is where a promoted or relegated club lands
among its new peers.

At each offseason, after the shipped pull, the gap G between last season's
Eliteserien clubs and last season's OBOS-ligaen clubs (Elo; attack and
defence each) is moved a fraction k toward a value-implied target, by
shifting last season's OBOS-ligaen clubs (and, in the goals model, the
newcomers placed among them):

- relative: G* = the run's own mean gap over the seasons before x this
  season's value gap / their mean value gap (log of the division's median, or
  mean, squad value the season before). Walk-forward, on the model's own scale.
- absolute (goals model): G* = the shipped value pull (0.2 per log value) x
  the value gap, the same rule the pull applies inside a division.

    PYTHONPATH=experiments/improvements .venv/Scripts/python experiments/improvements/division_value_gap.py
"""
from __future__ import annotations

import math
import statistics

import numpy as np

import harness as h
from elitetracker.model.career import team_ids
from elitetracker.model.elo import MODEL_VERSION
from elitetracker.pipeline import market_values

VALUES = market_values()
LEAGUE_OF: dict[tuple[int, str], str] = {}
for sl in h.SLICES:
    for m in sl.matches:
        for t in team_ids(m):
            LEAGUE_OF[(sl.season, t)] = sl.league


def value_gap(season: int, centre=statistics.median) -> float | None:
    """log centre value of last season's Eliteserien clubs over OBOS-ligaen's."""
    page = VALUES.get(season - 1, {})
    by = {"eliteserien": [], "obosligaen": []}
    for (year, t), league in LEAGUE_OF.items():
        if year == season - 1 and page.get(t):
            by[league].append(page[t])
    if len(by["eliteserien"]) < 8 or len(by["obosligaen"]) < 8:
        return None
    return math.log(centre(by["eliteserien"])) - math.log(centre(by["obosligaen"]))


def groups(season, ratings):
    es = [t for t in ratings if LEAGUE_OF.get((season - 1, t)) == "eliteserien"]
    ob = [t for t in ratings if LEAGUE_OF.get((season - 1, t)) == "obosligaen"]
    return es, ob


class Gap:
    """Measures the gap each offseason and returns the shift for last season's
    OBOS-ligaen clubs; `log` keeps (season, gap, value gap) for the report."""

    def __init__(self, k, mode="relative", centre=statistics.median, scale=0.2):
        self.k, self.mode, self.centre, self.scale = k, mode, centre, scale
        self.history: list[tuple[float, float]] = []
        self.log: list[tuple[int, float, float | None]] = []

    def shift(self, season, ratings):
        es, ob = groups(season, ratings)
        if not es or not ob:
            return 0.0
        gap = sum(ratings[t] for t in es) / len(es) - sum(ratings[t] for t in ob) / len(ob)
        dv = value_gap(season, self.centre)
        self.log.append((season, gap, dv))
        if dv is None:
            return 0.0
        if self.mode == "absolute":
            target = self.scale * dv
        else:
            if not self.history:
                self.history.append((gap, dv))
                return 0.0
            mean_gap = sum(g for g, _ in self.history) / len(self.history)
            mean_dv = sum(v for _, v in self.history) / len(self.history)
            target = mean_gap * dv / mean_dv
        self.history.append((gap, dv))
        return -self.k * (target - gap)


def elo_variant(k, centre=statistics.median):
    gap = Gap(k, centre=centre)

    def offseason(season, ratings):
        move = gap.shift(season, ratings)
        if move:
            for t in groups(season, ratings)[1]:
                ratings[t] += move
    g = np.zeros(len(h.Y))
    return h.elo_run(h.EloRun(offseason=offseason), gaps=g), g, gap


def ad_variant(k, elo_gap, mode="relative", centre=statistics.median):
    gaps = {"attack": Gap(k, mode, centre), "defence": Gap(k, mode, centre)}

    def season_hook(ad, season):
        if season - 1 not in {y for y, _ in ad.divisions}:
            return
        newcomers = [t for (y, t), lg in ad.divisions.items()
                     if y == season and lg == "obosligaen" and (season - 1, t) not in LEAGUE_OF]
        for name, gap in gaps.items():
            ratings = getattr(ad, name)
            move = gap.shift(season, ratings)
            if move:
                for t in groups(season, ratings)[1] + [t for t in newcomers if t in ratings]:
                    ratings[t] += move
    return h.ad_run(elo_gap=elo_gap, season_hook=season_hook), gaps


def main():
    h.identity()
    g0 = np.zeros(len(h.Y))
    elo0 = h.elo_run(gaps=g0)
    ad0 = h.ad_run(elo_gap=g0)
    base = h.blend(elo0, ad0.probs)
    print(f"{MODEL_VERSION}: shipped, {h.mask().sum()} matches 2016+")

    # How the carried gap and the value gap have moved, on the shipped model.
    _, _, probe = elo_variant(0.0)
    _, probes = ad_variant(0.0, g0)
    print("season  Elo gap  attack gap  defence gap  value gap (median)  (mean)")
    for (s, ge, dv), (_, ga, _), (_, gd, _) in zip(probe.log, probes["attack"].log, probes["defence"].log):
        mean_dv = value_gap(s, statistics.mean)
        print(f"  {s}  {ge:7.1f}  {ga:10.3f}  {gd:11.3f}  {dv if dv is None else round(dv, 2)!s:>18}  "
              f"{mean_dv if mean_dv is None else round(mean_dv, 2)}")

    variants = {"shipped": base}
    for k in (0.25, 0.5, 1.0):
        elo, g, _ = elo_variant(k)
        ad_only, _ = ad_variant(k, g0)
        ad_both, _ = ad_variant(k, g)
        variants[f"elo k {k}"] = h.blend(elo, ad0.probs)
        variants[f"ad k {k}"] = h.blend(elo0, ad_only.probs)
        variants[f"both k {k}"] = h.blend(elo, ad_both.probs)
    elo, g, _ = elo_variant(0.5, statistics.mean)
    ad_both, _ = ad_variant(0.5, g, centre=statistics.mean)
    variants["both k 0.5, mean value"] = h.blend(elo, ad_both.probs)
    for k in (0.5, 1.0):
        ad_abs, _ = ad_variant(k, g0, mode="absolute")
        variants[f"ad absolute 0.2 k {k}"] = h.blend(elo0, ad_abs.probs)

    # Where it can matter: matches with a club in its first season in the division.
    first = np.array([any(LEAGUE_OF.get((s - 1, t)) not in (None, lg) or (s - 1, t) not in LEAGUE_OF
                          for t in team_ids(m)) for m, lg, s in h.PLAYED])
    moved = h.mask() & first
    print(f"\nall matches 2016+ / the {moved.sum()} with a club new to its division")
    for key, p in variants.items():
        if key == "shipped":
            continue
        print(h.line(key, p, base, h.WINDOWS["all16"]))
        print(h.line("   new to the division", p, base, moved))
    print()
    for where in ("elo", "ad", "both"):
        family = {k: v for k, v in variants.items() if k == "shipped" or k.startswith(where + " k")}
        h.oos_report(where, family, "shipped", first=2019, windows=("all16", "es16", "ob16"))


if __name__ == "__main__":
    main()
