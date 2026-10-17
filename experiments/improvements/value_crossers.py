"""Clubs changing division placed by their squad value (October 2026, elo-v14.0).

Follow-up to division_value_gap.py (rejected): instead of moving the whole
gap between the divisions, place each promoted or relegated club more by its
own squad value against its new division. Today such a club is pulled like
any other: toward its new division's mean, keeping `season_regression` of
its distance (0.88 Eliteserien / 0.75 OBOS-ligaen in the goals model, 0.88 in
Elo), with the goals model's target moved by `value_pull` (0.2 / 0.3) x its
log value against the division's; Elo has no value term.

For clubs whose division changed (newcomers from the third tier excepted,
they have no rating), at each offseason after the shipped pull:
- goals model: keep r_c of the distance instead (shipped, 0.5, 0.25), the
  value shift x m (1, 2);
- Elo: keep r_c (shipped, 0.5, 0.25), target mean + c x log value against
  the division's (c 0, 75, 150 Elo points); c 0 is the control, a stronger
  pull with no value.

    PYTHONPATH=experiments/improvements .venv/Scripts/python experiments/improvements/value_crossers.py
"""
from __future__ import annotations

import itertools
import math

import numpy as np

import harness as h
from elitetracker.model.career import team_ids
from elitetracker.model.elo import MODEL_VERSION, era_config
from elitetracker.pipeline import market_values

VALUES = market_values()
LEAGUE_OF: dict[tuple[int, str], str] = {}
for sl in h.SLICES:
    for m in sl.matches:
        for t in team_ids(m):
            LEAGUE_OF[(sl.season, t)] = sl.league


def crossers(season, league, known, direction="both"):
    """Clubs of `known` whose division changed: "up" only into Eliteserien,
    "down" only into OBOS-ligaen."""
    if (direction == "up" and league != "eliteserien") or (direction == "down" and league != "obosligaen"):
        return []
    return [t for t in known if LEAGUE_OF.get((season - 1, t)) not in (None, league)]


def log_values(season, teams):
    """Each club's log squad value from the season before, less the mean over
    the clubs of `teams` that have one (as `_pull_toward_value` does)."""
    page = VALUES.get(season - 1, {})
    logs = {t: math.log(page[t]) for t in teams if page.get(t)}
    if not logs:
        return {}
    mean = sum(logs.values()) / len(logs)
    return {t: v - mean for t, v in logs.items()}


def elo_variant(keep, c, direction="both"):
    def offseason(season, ratings):
        reg = era_config(season).season_regression
        by: dict[str, list[str]] = {}
        for (year, t), lg in LEAGUE_OF.items():
            if year == season and t in ratings:
                by.setdefault(lg, []).append(t)
        for lg, ids in by.items():
            moved = crossers(season, lg, ids, direction)
            if not moved or reg >= 1.0:
                continue
            mean = sum(ratings[t] for t in ids) / len(ids)  # the pull keeps the mean
            rel = log_values(season, ids)
            r_c = reg if keep is None else keep
            for t in moved:
                pre = mean + (ratings[t] - mean) / reg
                goal = mean + c * rel.get(t, 0.0)
                ratings[t] = goal + r_c * (pre - goal)
    g = np.zeros(len(h.Y))
    return h.elo_run(h.EloRun(offseason=offseason), gaps=g), g


def ad_variant(keep, mult, elo_gap, direction="both"):
    snap = {"attack": {}, "defence": {}}

    def after_observe(ad, m):
        snap["attack"], snap["defence"] = ad.attack.copy(), ad.defence.copy()

    def season_hook(ad, season):
        by: dict[str, list[str]] = {}
        for (year, t), lg in ad.divisions.items():
            if year == season:
                by.setdefault(lg, []).append(t)
        for lg, teams in by.items():
            reg, pull = ad.config.offseason(lg)
            known = [t for t in teams if t in snap["attack"]]
            moved = crossers(season, lg, known, direction)
            if not moved or reg >= 1.0:
                continue
            rel = log_values(season, [t for t in teams if t in snap["attack"]])
            r_c = reg if keep is None else keep
            for name in ("attack", "defence"):
                pre = snap[name]
                mean = sum(pre[t] for t in known) / len(known)
                for t in moved:
                    goal = mean + mult * pull * rel.get(t, 0.0)
                    getattr(ad, name)[t] = goal + r_c * (pre[t] - goal)
    return h.ad_run(elo_gap=elo_gap, season_hook=season_hook, after_observe=after_observe)


def main():
    h.identity()
    g0 = np.zeros(len(h.Y))
    elo0 = h.elo_run(gaps=g0)
    ad0 = h.ad_run(elo_gap=g0)
    base = h.blend(elo0, ad0.probs)

    # The hooks at the shipped settings must give the shipped odds back.
    elo_same, _ = elo_variant(None, 0.0)
    ad_same = ad_variant(None, 1.0, g0)
    print(f"{MODEL_VERSION}: hooks at shipped settings, max diff elo {abs(elo_same - elo0).max():.1e}, "
          f"grid {abs(ad_same.probs - ad0.probs).max():.1e}")

    first = np.array([any(LEAGUE_OF.get((s - 1, t)) not in (None, lg) for t in team_ids(m)) for m, lg, s in h.PLAYED])
    moved = h.mask() & first
    print(f"{moved.sum()} matches 2016+ with a club that changed division\n")

    variants = {"shipped": base}
    elo_runs = {}
    for keep, c in itertools.product((None, 0.5, 0.25, 0.0), (0.0, 75.0, 150.0, 225.0, 300.0)):
        if keep is None and c == 0.0:
            continue
        elo, g = elo_variant(keep, c)
        elo_runs[(keep, c)] = (elo, g)
        variants[f"elo keep {keep} c {c:g}"] = h.blend(elo, ad0.probs)
    for keep, mult in itertools.product((None, 0.5, 0.25, 0.0), (0.5, 1.0, 1.5, 2.0)):
        if keep is None and mult == 1.0:
            continue
        variants[f"ad keep {keep} x{mult:g}"] = h.blend(elo0, ad_variant(keep, mult, g0).probs)
    for keep, mult, c in ((0.5, 1.0, 75.0), (0.25, 1.0, 75.0), (0.25, 1.0, 150.0), (0.0, 1.0, 150.0)):
        elo, g = elo_runs[(keep, c)]
        variants[f"both keep {keep} x{mult:g} c {c:g}"] = h.blend(elo, ad_variant(keep, mult, g).probs)
    # Promoted and relegated clubs apart, at the both-models settings.
    for direction in ("up", "down"):
        for keep, c in ((0.5, 75.0), (0.25, 150.0)):
            elo, g = elo_variant(keep, c, direction)
            variants[f"{direction} keep {keep} x1 c {c:g}"] = h.blend(elo, ad_variant(keep, 1.0, g, direction).probs)
    for key, p in variants.items():
        if key == "shipped":
            continue
        print(h.line(key, p, base, h.WINDOWS["all16"]))
        print(h.line("   changed division", p, base, moved))
    print()
    for where in ("elo", "ad", "both", "up", "down"):
        family = {k: v for k, v in variants.items() if k == "shipped" or k.startswith(where + " ")}
        h.oos_report(where, family, "shipped", first=2019, windows=("all16", "es16", "ob16"))
        chosen, _ = h.oos(family, "shipped", first=2019)
        print(h.line(f"{where} OOS [changed division 2019+]", chosen, base, moved & (h.SEASON >= 2019)))


if __name__ == "__main__":
    main()
