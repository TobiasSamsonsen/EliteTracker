"""Keeping and finishing over a club's last N matches (October 2026).

keeping.py used last season's numbers; a squad changes between seasons (a
new keeper, a new striker), so here each term is a rolling window over the
club's last N matches with the data, across season boundaries:

    fin   = log(goals / xG)                   xG: both divisions where they have it
    shoot = log(xGoT / xG)                    FotMob xGoT: Eliteserien from 2020
    beat  = log(goals / xGoT)
    keep  = log(xGoT faced / goals conceded)  (positive = good keeper)

each against its division over the division's last LEAGUE_WINDOW matches with
the data (so a league-wide run of goals over xG does not count), shrunk to
`w` of itself, and only once the club has `min_n` matches in the window. A
side's log rate gets `fin (or shoot + beat) - keep[opponent]`, in the
predicted rates and the learning rates alike. The baseline is the shipped
model; variants that replace finishing switch the shipped season-level term
off. elo-v9 tested a rolling finishing window unshrunk (rolling 20: +0.015);
the shrinkage here is the difference.

    .venv/Scripts/python experiments/improvements/keeping_rolling.py
"""
from __future__ import annotations

import math
import sys
from collections import deque

import numpy as np

sys.path.insert(0, "experiments/improvements")
from harness import LEAGUE, SEASON, SHOTS, WINDOWS, ADConfig, ad_run, blend, elo_run, line, oos_report  # noqa: E402
from elitetracker.model.career import team_ids  # noqa: E402

BASE_ELO = elo_run()
BASE = blend(BASE_ELO, ad_run().probs)
WINDOWS["es21"] = (LEAGUE == "eliteserien") & (SEASON >= 2021)
WINDOWS["ob24"] = (LEAGUE == "obosligaen") & (SEASON >= 2024)
LEAGUE_WINDOW = 240


def rolling(n, w_fin=0.0, w_shoot=0.0, w_beat=0.0, w_keep=0.0, min_n=None, replace_fin=False, learn=True):
    """Hooks for one variant; every weight 0 is the shipped model."""
    min_n = min_n if min_n is not None else max(5, n // 2)
    club_xg: dict[str, deque] = {}    # team -> (goals, xg)
    club_got: dict[str, deque] = {}   # team -> (goals, xg, xgot, conceded, xgot faced)
    league_xg: dict[str, deque] = {}
    league_got: dict[str, deque] = {}
    league_of: dict[str, str] = {}

    def after(ad, m):
        shots = SHOTS.get(m.match_id)
        if not shots:
            return
        home, away = team_ids(m)
        league = ad.divisions.get((int(m.date[:4]), home), "")
        got = len(shots) >= 4
        for team, gf, ga, xf, xa, of, oa in (
            (home, m.home_goals, m.away_goals, shots[0], shots[1], *(shots[2:4] if got else (0, 0))),
            (away, m.away_goals, m.home_goals, shots[1], shots[0], *((shots[3], shots[2]) if got else (0, 0))),
        ):
            league_of[team] = league
            club_xg.setdefault(team, deque(maxlen=n)).append((gf, xf))
            league_xg.setdefault(league, deque(maxlen=2 * LEAGUE_WINDOW)).append((gf, xf))
            if got:
                club_got.setdefault(team, deque(maxlen=n)).append((gf, xf, of, ga, oa))
                league_got.setdefault(league, deque(maxlen=2 * LEAGUE_WINDOW)).append((gf, xf, of, ga, oa))

    def ratio(rows, a, b):
        top, bottom = sum(r[a] for r in rows), sum(r[b] for r in rows)
        return math.log(top / bottom) if top > 0 and bottom > 0 else None

    def term(team, kind):
        if kind == "fin":
            rows, ref = club_xg.get(team), league_xg.get(league_of.get(team))
            a, b = 0, 1
        else:
            rows, ref = club_got.get(team), league_got.get(league_of.get(team))
            a, b = {"shoot": (2, 1), "beat": (0, 2), "keep": (4, 3)}[kind]
        if not rows or len(rows) < min_n or not ref:
            return None
        mine, theirs = ratio(rows, a, b), ratio(ref, a, b)
        return None if mine is None or theirs is None else mine - theirs

    def extra(ad, home, away):
        def side(att, dfn):
            total = 0.0
            split = (w_shoot or w_beat) and term(att, "shoot") is not None
            if split:
                total += w_shoot * term(att, "shoot") + w_beat * (term(att, "beat") or 0.0)
            elif w_fin and term(att, "fin") is not None:
                total += w_fin * term(att, "fin")
            if (split or w_fin) and not replace_fin:
                total -= ad.finishing.get(att, 0.0)  # the rolling term stands in for the shipped one
            if w_keep:
                total -= w_keep * (term(dfn, "keep") or 0.0)
            return total
        return side(home, away), side(away, home)

    def rates_hook(ad, home, away, on, lam, mu):
        h, a = extra(ad, home, away)
        s = ad.config.spread
        return lam * math.exp(s * h), mu * math.exp(s * a)

    def learn_hook(ad, home, away, on):
        cfg = ad.config
        h, a = extra(ad, home, away)
        lam = math.exp(cfg.base + cfg.home + ad.attack[home] - ad.defence[away] + ad.finishing.get(home, 0.0) + h)
        mu = math.exp(cfg.base + ad.attack[away] - ad.defence[home] + ad.finishing.get(away, 0.0) + a)
        return lam, mu

    config = ADConfig(finishing_regression=1.0) if replace_fin else ADConfig()
    hooks = {"rates_hook": rates_hook, "after_observe": after}
    if learn:
        hooks["learn_hook"] = learn_hook
    return config, hooks


def run(n, **kw):
    config, hooks = rolling(n, **kw)
    return blend(BASE_ELO, ad_run(config, **hooks).probs)


def show(name, p, windows=("all16", "es21", "ob24")):
    for w in windows:
        print(line(f"{name} [{w}]", p, BASE, WINDOWS[w]))


if __name__ == "__main__":
    same = run(30)
    print(f"identity: max diff vs shipped {np.abs(same - BASE).max():.2e}")
    assert np.abs(same - BASE).max() < 1e-12

    print("\n-- A. rolling keeping, on top of the shipped finishing")
    fam = {"shipped": BASE}
    for n in (15, 20, 30, 45):
        for w in (0.25, 0.5, 1.0):
            fam[f"n{n}/w{w}"] = p = run(n, w_keep=w)
            show(f"keep n{n} w{w}", p, ("all16", "es21"))
    oos_report("rolling keep", fam, "shipped", first=2021, windows=("all16", "es21"))

    print("\n-- B. rolling finishing in place of the season-level one (clubs with a full window; the rest shipped)")
    fam = {"shipped": BASE}
    for n in (15, 20, 30, 45):
        for w in (0.25, 0.5, 1.0):
            fam[f"n{n}/w{w}"] = p = run(n, w_fin=w)
            show(f"fin n{n} w{w}", p)
    oos_report("rolling fin", fam, "shipped", first=2021, windows=("all16", "es21"))

    print("\n-- C. rolling split: shooting and beating the keeper (Eliteserien clubs with xGoT; the rest shipped)")
    fam = {"shipped": BASE}
    for n in (20, 30, 45):
        for ws, wb in ((0.5, 0.5), (0.25, 0.5), (0.5, 0.25), (1.0, 1.0)):
            fam[f"n{n}/s{ws}/b{wb}"] = p = run(n, w_shoot=ws, w_beat=wb)
            show(f"split n{n} s{ws} b{wb}", p, ("all16", "es21"))
    oos_report("rolling split", fam, "shipped", first=2021, windows=("all16", "es21"))

    print("\n-- D. the owner's full model, rolling: shooting + beating the keeper - the opponent's keeping")
    fam = {"shipped": BASE}
    for n in (20, 30, 45):
        for ws, wb, wk in ((0.5, 0.5, 0.25), (0.5, 0.5, 0.5), (1.0, 1.0, 0.5), (0.5, 0.5, 1.0)):
            fam[f"n{n}/s{ws}/b{wb}/k{wk}"] = p = run(n, w_shoot=ws, w_beat=wb, w_keep=wk)
            show(f"full n{n} s{ws} b{wb} k{wk}", p, ("all16", "es21"))
    oos_report("rolling full", fam, "shipped", first=2021, windows=("all16", "es21"))
