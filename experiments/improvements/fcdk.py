"""A finishing / chance creation / chance prevention / keeping goals model
(October 2026, the owner's idea).

The shipped attack and defence ratings learn from 0.75 xG + 0.25 goals, so
they already carry some of a club's finishing and keeping; keeping_rolling.py
found rolling finishing and keeping on top of that worse the shorter the
window, as if the same goals were counted twice. Here the parts are kept
apart:

    chances  attack / defence learn from xG alone where a match has it
             (alpha), against rates without finishing and keeping;
    finish   log(goals / xG) over the club's last N matches with xG,
    keep     log(xGoT faced / goals let in) over its last M with xGoT
             (FotMob, Eliteserien from 2020),
    each against its division's last ~240 club matches, shrunk to w, from
    N/2 (M/2) matches on;
    goals    exp(base + home + spread * (attack - defence[opp] + finish - keep[opp])).

Matches without xG learn from goals, as shipped, against rates that include
the terms. The shipped season-level finishing is switched off when the
rolling finishing is on. Scored as the shipped grid/Elo blend, paired against
the shipped model.

    .venv/Scripts/python experiments/improvements/fcdk.py
"""
from __future__ import annotations

import itertools
import math
import sys
from collections import deque

import numpy as np

sys.path.insert(0, "experiments/improvements")
import harness  # noqa: E402
from harness import LEAGUE, SEASON, SHOTS, WINDOWS, ADConfig, ad_run, blend, elo_run, line, oos_report  # noqa: E402
from elitetracker.model.career import team_ids  # noqa: E402

BASE_ELO = elo_run()
BASE = blend(BASE_ELO, ad_run().probs)
WINDOWS["es21"] = (LEAGUE == "eliteserien") & (SEASON >= 2021)
WINDOWS["ob24"] = (LEAGUE == "obosligaen") & (SEASON >= 2024)
LEAGUE_ROWS = 240

# The learning rates need to know whether the match being learnt has xG;
# `observe` computes them before it reads the match, so it is noted first.
_observe = harness.ADX.observe


def _noting_observe(self, match):
    self._current = match
    return _observe(self, match)


harness.ADX.observe = _noting_observe


def fcdk(alpha=0.75, n_fin=20, w_fin=0.0, n_keep=10, w_keep=0.0, k_shots=None, pure_learning=True):
    """Config and hooks for one variant. alpha 0.75, both weights 0: the
    shipped model."""
    club_xg: dict[str, deque] = {}
    club_got: dict[str, deque] = {}
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
        for team, gf, ga, xf, of, oa in (
            (home, m.home_goals, m.away_goals, shots[0], *(shots[2:4] if got else (0, 0))),
            (away, m.away_goals, m.home_goals, shots[1], *((shots[3], shots[2]) if got else (0, 0))),
        ):
            league_of[team] = league
            club_xg.setdefault(team, deque(maxlen=n_fin)).append((gf, xf))
            league_xg.setdefault(league, deque(maxlen=LEAGUE_ROWS)).append((gf, xf))
            if got:
                club_got.setdefault(team, deque(maxlen=n_keep)).append((ga, oa))
                league_got.setdefault(league, deque(maxlen=LEAGUE_ROWS)).append((ga, oa))

    def log_ratio(rows, top, bottom):
        a, b = sum(r[top] for r in rows), sum(r[bottom] for r in rows)
        return math.log(a / b) if a > 0 and b > 0 else None

    def term(rows, ref, n, top, bottom):
        if not rows or len(rows) < n // 2 or not ref:
            return 0.0
        mine, theirs = log_ratio(rows, top, bottom), log_ratio(ref, top, bottom)
        return 0.0 if mine is None or theirs is None else mine - theirs

    def finish(team):
        return w_fin * term(club_xg.get(team), league_xg.get(league_of.get(team)), n_fin, 0, 1) if w_fin else 0.0

    def keep(team):
        # xGoT faced / goals let in, so positive is a good keeper
        return w_keep * term(club_got.get(team), league_got.get(league_of.get(team)), n_keep, 1, 0) if w_keep else 0.0

    def extra(home, away):
        return finish(home) - keep(away), finish(away) - keep(home)

    def rates_hook(ad, home, away, on, lam, mu):
        h, a = extra(home, away)
        s = ad.config.spread
        return lam * math.exp(s * h), mu * math.exp(s * a)

    def learn_hook(ad, home, away, on):
        cfg = ad.config
        match = getattr(ad, "_current", None)
        learns_xg = match is not None and match.match_id in SHOTS and cfg.alpha > 0
        # Learning from xG alone: the rates are chances, without finishing and
        # keeping. Learning from goals (no xG, or a blend): with them.
        h, a = (0.0, 0.0) if (learns_xg and pure_learning and cfg.alpha >= 1.0) else extra(home, away)
        lam = math.exp(cfg.base + cfg.home + ad.attack[home] - ad.defence[away] + ad.finishing.get(home, 0.0) + h)
        mu = math.exp(cfg.base + ad.attack[away] - ad.defence[home] + ad.finishing.get(away, 0.0) + a)
        return lam, mu

    replace_fin = bool(w_fin)
    config = ADConfig(alpha=alpha, finishing_regression=1.0 if replace_fin else ADConfig().finishing_regression,
                      k_shots=k_shots if k_shots is not None else ADConfig().k_shots)
    hooks = {"after_observe": after}
    if w_fin or w_keep:
        hooks.update(rates_hook=rates_hook, learn_hook=learn_hook)
    return config, hooks


def run(**kw):
    config, hooks = fcdk(**kw)
    return blend(BASE_ELO, ad_run(config, **hooks).probs)


def show(name, p, windows=("all16", "es21", "ob24")):
    for w in windows:
        print(line(f"{name} [{w}]", p, BASE, WINDOWS[w]))


def short(name, p):
    c = harness.compare(p, BASE, WINDOWS["all16"])
    e = harness.compare(p, BASE, WINDOWS["es21"])
    return (f"{name:<44} all LL {c['ll'][0]:+.5f} (t {c['ll'][1]:+5.2f})  "
            f"es21 LL {e['ll'][0]:+.5f} (t {e['ll'][1]:+5.2f})  Br t {e['brier'][1]:+5.2f}  RPS t {e['rps'][1]:+5.2f}")


if __name__ == "__main__":
    same = run()
    print(f"identity: max diff vs shipped {np.abs(same - BASE).max():.2e}")
    assert np.abs(same - BASE).max() < 1e-12

    print("\n-- 1. chances from xG alone, nothing else (alpha), shipped finishing kept")
    for alpha in (0.9, 1.0):
        print(short(f"alpha {alpha}", run(alpha=alpha)))

    print("\n-- 2. the f/c/d/k grid: alpha x finishing (N, w) x keeping (M, w)")
    fam, rows = {"shipped": BASE}, []
    for alpha, (n_fin, w_fin), (n_keep, w_keep) in itertools.product(
            (0.75, 0.9, 1.0),
            ((10, 0.5), (10, 1.0), (20, 0.5), (20, 1.0), (30, 0.5), (30, 1.0), (45, 0.5)),
            ((10, 0.0), (10, 0.5), (10, 1.0), (20, 0.5), (20, 1.0), (45, 0.5))):
        key = f"a{alpha}/f{n_fin}x{w_fin}/k{n_keep}x{w_keep}"
        fam[key] = p = run(alpha=alpha, n_fin=n_fin, w_fin=w_fin, n_keep=n_keep, w_keep=w_keep)
        c = harness.compare(p, BASE, WINDOWS["all16"])
        rows.append((c["ll"][0], key))
    rows.sort()
    print("best 12 on all matches 2016+:")
    for _, key in rows[:12]:
        print(short(key, fam[key]))
    print("by alpha, best of each:")
    for alpha in (0.75, 0.9, 1.0):
        key = min((k for _, k in rows if k.startswith(f"a{alpha}/")), key=lambda k: harness.compare(fam[k], BASE, WINDOWS["all16"])["ll"][0])
        print(short(key, fam[key]))
    oos_report("fcdk", fam, "shipped", first=2021, windows=("all16", "es21"))

    print("\n-- 3. the step for xG-backed matches, at the best three settings")
    for _, key in rows[:3]:
        a, f, k = key.split("/")
        alpha = float(a[1:])
        n_fin, w_fin = (float(v) for v in f[1:].split("x"))
        n_keep, w_keep = (float(v) for v in k[1:].split("x"))
        for ks in (0.035, 0.05, 0.065):
            p = run(alpha=alpha, n_fin=int(n_fin), w_fin=w_fin, n_keep=int(n_keep), w_keep=w_keep, k_shots=ks)
            print(short(f"{key} k_shots {ks}", p))
    best = rows[0][1]
    print(f"\nbest: {best}")
    show(best, fam[best])
