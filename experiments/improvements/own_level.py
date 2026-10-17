"""The offseason pull toward each club's own long-run level, re-tested on
elo-v14.0 (October 2026).

In the elo-v12 era (PROJECT_STATUS.md, "elo-v12.0"): pulling toward an EWMA
of each club's end-of-season deviation from its division mean, instead of
the mean, was -0.0002 (t -1.8). The recalibration re-test (recalibration.py)
found the heavy favourites' recent excess is mostly dominant clubs
(Bodø/Glimt +7.3 wins of +14.6 since 2021), which is what a pull toward the
mean would cause, so the idea is back.

At each offseason a club's target is mean + w * L, where L is the EWMA
(memory lam, starting from 0) of its pre-pull deviation from its division's
mean at the offseasons before, this one included; a club that changed
division starts again from 0. In Elo through `EloRun.target`; in the goals
model the attack and defence ratings each get their own L, and the target
moves on top of the squad-value shift: (1 - regression) * w * L.

    .venv/Scripts/python experiments/improvements/own_level.py
"""
from __future__ import annotations

import itertools

import numpy as np

import harness as h
from elitetracker.model.elo import MODEL_VERSION

LAMS = (0.5, 0.7, 0.85)
WEIGHTS = (0.5, 1.0)


def elo_target(lam, w):
    level: dict[str, float] = {}
    league_of: dict[str, tuple[int, str]] = {}

    def target(season, league, ids, ratings):
        mean = sum(ratings[t] for t in ids) / len(ids)
        out = {}
        for t in ids:
            prev = league_of.get(t)
            if not prev or prev[1] != league or prev[0] != season - 1:
                level[t] = 0.0
            level[t] = lam * level.get(t, 0.0) + (1 - lam) * (ratings[t] - mean)
            league_of[t] = (season, league)
            out[t] = mean + w * level[t]
        return out
    return target


def ad_hooks(lam, w):
    """season_hook and after_observe for ad_run: the snapshot after each
    match is the pre-pull state when the next season starts."""
    snap = {"attack": {}, "defence": {}}
    levels = {"attack": {}, "defence": {}}
    league_of: dict[str, tuple[int, str]] = {}

    def after_observe(ad, m):
        snap["attack"], snap["defence"] = ad.attack.copy(), ad.defence.copy()

    def season_hook(ad, season):
        active: dict[str, list[str]] = {}
        for (year, team), league in ad.divisions.items():
            if year == season:
                active.setdefault(league, []).append(team)
        for league, teams in active.items():
            regression, _ = ad.config.offseason(league)
            for name in ("attack", "defence"):
                pre = snap[name]
                known = [t for t in teams if t in pre]
                if not known or regression >= 1.0:
                    continue
                mean = sum(pre[t] for t in known) / len(known)
                for t in known:
                    prev = league_of.get(t)
                    if not prev or prev[1] != league or prev[0] != season - 1:
                        levels[name][t] = 0.0
                    levels[name][t] = lam * levels[name].get(t, 0.0) + (1 - lam) * (pre[t] - mean)
                    getattr(ad, name)[t] += (1.0 - regression) * w * levels[name][t]
            for t in teams:
                league_of[t] = (season, league)
    return season_hook, after_observe


def main():
    h.identity()
    gaps = np.zeros(len(h.Y))
    elo0 = h.elo_run(gaps=gaps)
    ad0 = h.ad_run(elo_gap=gaps)
    base = h.blend(elo0, ad0.probs)
    print(f"{MODEL_VERSION}: shipped, {h.mask().sum()} matches 2016+")
    variants = {"shipped": base}
    for lam, w in itertools.product(LAMS, WEIGHTS):
        g = np.zeros(len(h.Y))
        elo = h.elo_run(h.EloRun(target=elo_target(lam, w)), gaps=g)
        hook, after = ad_hooks(lam, w)
        ad_both = h.ad_run(elo_gap=g, season_hook=hook, after_observe=after)
        hook, after = ad_hooks(lam, w)
        ad_only = h.ad_run(elo_gap=gaps, season_hook=hook, after_observe=after)
        for where, p in (("elo", h.blend(elo, ad0.probs)), ("ad", h.blend(elo0, ad_only.probs)),
                         ("both", h.blend(elo, ad_both.probs))):
            key = f"{where} lam {lam} w {w}"
            variants[key] = p
            print(h.line(key, p, base, h.WINDOWS["all16"]))
    print()
    for where in ("elo", "ad", "both"):
        family = {k: v for k, v in variants.items() if k == "shipped" or k.startswith(where + " ")}
        h.oos_report(where, family, "shipped", first=2019, windows=("all16", "es16", "ob16"))
    print()
    for key in variants:
        if key != "shipped":
            print(h.line(f"{key} [2021+]", variants[key], base, h.mask((2021, 2100))))
    # The favourites the idea is meant for, at the best in-sample variant.
    keep = h.mask()
    best = min((k for k in variants if k != "shipped"), key=lambda k: h.losses(variants[k])["ll"][keep].mean())
    for name in ("shipped", best):
        p = variants[name]
        top = p.max(1)
        sel = keep & (h.SEASON >= 2021) & (top >= 0.7)
        print(f"{name}: favourites >= 70 % 2021+: {sel.sum()}, priced {top[sel].mean():.1%}, "
              f"won {(p[sel].argmax(1) == h.Y[sel]).mean():.1%}")


if __name__ == "__main__":
    main()
