"""Keeping and finishing from xG on target, in the goals model (October 2026).

The owner's idea: better shooting turns xG into more xGoT, better keeping
turns xGoT into fewer goals; rate both and match them up. In log goals the
parts add, so a side's expected goals become

    exp(base + home + spread * (attack - defence[opp] + shoot + beat - keep[opp]))

with three season-level terms from last season (as elo-v9's finishing):
    shoot = log(xGoT / xG)                   its shots: on target, and where
    beat  = log(goals / xGoT)                its goals from what reached goal
    keep  = log(xGoT faced / goals conceded) its keeper (positive = good)
each measured against its division that season (so a league-wide year such
as 2022's, goals 20 % over xG, is not carried into the next) and shrunk to
`w` of itself. xGoT is FotMob's, Eliteserien from 2020 only; a club without
it last season gets 0 for that term (and, where the variant keeps it, the
shipped log(goals / xG) finishing).

The shipped finishing (log(goals / xG), shrunk 0.70 toward the division mean,
which keeps the league offset) is the baseline. Scored as the shipped blend
of the grid and the Elo odds, paired against the shipped model on the same
matches; `oos_report` picks each season's variant from the seasons before.

    .venv/Scripts/python experiments/improvements/keeping.py
"""
from __future__ import annotations

import math
import sys
from dataclasses import replace

import numpy as np

sys.path.insert(0, "experiments/improvements")
from harness import (  # noqa: E402
    HAS_XG, LEAGUE, SEASON, SHOTS, WINDOWS, ADConfig, ad_run, blend, elo_run, line, oos_report,
)
from elitetracker.model.career import team_ids  # noqa: E402

BASE_ELO = elo_run()
BASE = blend(BASE_ELO, ad_run().probs)
XGOT = np.array([len(SHOTS.get(m, ())) >= 4 for m in __import__("harness").IDS])
# Eliteserien matches from 2021, where last season's xGoT can exist.
ES21 = (LEAGUE == "eliteserien") & (SEASON >= 2021)
WINDOWS["es21"] = ES21
WINDOWS["xgot21"] = ES21 & XGOT


def terms(w_shoot=0.0, w_beat=0.0, w_keep=0.0, w_fin=None, fin_centered=True, learn=True):
    """Hooks for one variant. w_fin: the plain log(goals / xG) finishing
    (None keeps the shipped one; a number replaces it with this module's,
    centred on the division if `fin_centered`), used for every club when
    w_shoot and w_beat are 0, else only for clubs without xGoT."""
    own_fin = w_fin is not None
    stats: dict[tuple[int, str], list[float]] = {}  # (season, team) -> goals, xg, xgot, against, xgot_against, n_xgot
    league_of: dict[tuple[int, str], str] = {}
    current = {"shoot": {}, "beat": {}, "keep": {}, "fin": {}}
    ad_ref = [None]  # the model, for the shipped finishing the split replaces

    def after(ad, m):
        shots = SHOTS.get(m.match_id)
        if not shots:
            return
        season = int(m.date[:4])
        home, away = team_ids(m)
        for team, gf, ga, xf, of, oa in ((home, m.home_goals, m.away_goals, shots[0], *(shots[2:4] if len(shots) >= 4 else (None, None))),
                                         (away, m.away_goals, m.home_goals, shots[1], *((shots[3], shots[2]) if len(shots) >= 4 else (None, None)))):
            s = stats.setdefault((season, team), [0.0, 0.0, 0.0, 0.0, 0.0, 0])
            s[0] += gf
            s[1] += xf
            if of is not None:
                s[2] += of
                s[3] += ga
                s[4] += oa
                s[5] += 1
            league_of[(season, team)] = ad.divisions.get((season, team), "")

    def season_hook(ad, season):
        ad_ref[0] = ad
        prev = season - 1
        rows = {t: s for (y, t), s in stats.items() if y == prev}
        for name in current:
            current[name].clear()
        by_league: dict[str, list[str]] = {}
        for t in rows:
            by_league.setdefault(league_of[(prev, t)], []).append(t)
        for league, teams in by_league.items():
            def centred(values):
                if not values:
                    return {}
                mean = sum(values.values()) / len(values)
                return {t: v - mean for t, v in values.items()}
            fin = {t: math.log(rows[t][0] / rows[t][1]) for t in teams if rows[t][0] > 0 and rows[t][1] > 0}
            with_got = [t for t in teams if rows[t][5] >= 10 and rows[t][2] > 0 and rows[t][4] > 0 and rows[t][0] > 0 and rows[t][3] > 0]
            shoot = {t: math.log(rows[t][2] / rows[t][1]) for t in with_got}
            beat = {t: math.log(rows[t][0] / rows[t][2]) for t in with_got}
            keep = {t: math.log(rows[t][4] / rows[t][3]) for t in with_got}
            if fin_centered:
                fin = centred(fin)
            for name, values, w in (("shoot", centred(shoot), w_shoot), ("beat", centred(beat), w_beat), ("keep", centred(keep), w_keep)):
                current[name].update({t: w * v for t, v in values.items()})
            if own_fin:
                mean = 0.0 if fin_centered else (sum(fin.values()) / len(fin) if fin else 0.0)
                current["fin"].update({t: mean + w_fin * (v - mean) for t, v in fin.items()})

    def extra(home, away):
        """Log-goal terms added for the home side's goals and the away side's."""
        def side(att, dfn):
            # The split replaces the shipped finishing only for a club with
            # xGoT last season (so the delta takes the shipped term out);
            # every other club keeps the shipped one, untouched.
            total = 0.0
            if (w_shoot or w_beat) and att in current["shoot"]:
                total += current["shoot"][att] + current["beat"][att] - ad_ref[0].finishing.get(att, 0.0)
            if own_fin:
                total += current["fin"].get(att, 0.0)
            return total - current["keep"].get(dfn, 0.0)
        return side(home, away), side(away, home)

    def rates_hook(ad, home, away, on, lam, mu):
        h, a = extra(home, away)
        s = ad.config.spread
        return lam * math.exp(s * h), mu * math.exp(s * a)

    def learn_hook(ad, home, away, on):
        cfg = ad.config
        h, a = extra(home, away)
        lam = math.exp(cfg.base + cfg.home + ad.attack[home] - ad.defence[away] + ad.finishing.get(home, 0.0) + h)
        mu = math.exp(cfg.base + ad.attack[away] - ad.defence[home] + ad.finishing.get(away, 0.0) + a)
        return lam, mu

    config = ADConfig(finishing_regression=1.0) if own_fin else ADConfig()
    hooks = {"season_hook": season_hook, "rates_hook": rates_hook, "after_observe": after}
    if learn:
        hooks["learn_hook"] = learn_hook
    return config, hooks


def run(**kw):
    config, hooks = terms(**kw)
    return blend(BASE_ELO, ad_run(config, **hooks).probs)


def show(name, p, windows=("all16", "es21", "xgot21")):
    for w in windows:
        print(line(f"{name} [{w}]", p, BASE, WINDOWS[w]))


if __name__ == "__main__":
    # 0. With every weight 0 the hooks must leave the shipped model alone.
    same = run()
    print(f"identity: max diff vs shipped {np.abs(same - BASE).max():.2e}")
    assert np.abs(same - BASE).max() < 1e-12

    print("\n-- 1. the shipped finishing, centred on its division each season")
    fam_c = {"shipped": BASE}
    for w in (0.5, 0.7, 0.9):
        fam_c[w] = run(w_fin=w)
        show(f"fin centred w {w}", fam_c[w])
    oos_report("fin centred", fam_c, "shipped", first=2021, windows=("all16", "es21"))

    print("\n-- 2. keeping on top of the shipped finishing")
    fam_k = {0.0: BASE}
    for w in (0.25, 0.5, 0.75, 1.0):
        fam_k[w] = run(w_keep=w)
        show(f"keep w {w}", fam_k[w])
    oos_report("keep", fam_k, 0.0, first=2021, windows=("all16", "es21"))

    print("\n-- 3. finishing split: shooting and beating the keeper (centred), shipped finishing for clubs without xGoT")
    fam_s = {"shipped": BASE}
    for ws in (0.0, 0.35, 0.7):
        for wb in (0.35, 0.7):
            key = f"s{ws}/b{wb}"
            fam_s[key] = run(w_shoot=ws, w_beat=wb)
            show(key, fam_s[key])
    oos_report("split", fam_s, "shipped", first=2021, windows=("all16", "es21"))

    print("\n-- 4. the owner's full model: shooting x beating the keeper x the opponent's keeping")
    fam_f = {"shipped": BASE}
    for ws, wb, wk in ((0.35, 0.7, 0.25), (0.35, 0.7, 0.5), (0.7, 0.7, 0.5), (0.7, 0.7, 0.7), (0.35, 0.35, 0.35)):
        key = f"s{ws}/b{wb}/k{wk}"
        fam_f[key] = run(w_shoot=ws, w_beat=wb, w_keep=wk)
        show(key, fam_f[key])
    oos_report("full", fam_f, "shipped", first=2021, windows=("all16", "es21"))

    print("\n-- 5. the terms in the predictions only, not in what the ratings learn")
    show("keep w 0.5, predict only", run(w_keep=0.5, learn=False))
    show("s0.35/b0.7/k0.5, predict only", run(w_shoot=0.35, w_beat=0.7, w_keep=0.5, learn=False))
