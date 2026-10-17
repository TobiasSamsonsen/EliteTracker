"""Finishing and keeping learnt online, the way attack and defence are
(October 2026, elo-v15.0, the owner's idea).

Attack and defence take a step after every match: k times the surprise, the
gradient of the Poisson likelihood. Finishing is last season's
log(goals / xG), pulled 0.7 toward the division at each offseason; keeping is
log(xGoT faced / goals let in) over the club's last 45 matches with xG on
target, against the division, x 0.75. fcdk_decay.py tried both as
exponentially decayed averages (worse); a learning-rate step is close to
that but not the same: it is a Poisson gradient, so a match with more xG
says more, and a 0-goal match needs no special case.

Here each is a rating of its own that moves after every match with the data:

    finishing  F += kF * (goals - xG * R_F * exp(F))        every match with xG
    keeping    K += kK * (xGoT faced * R_K * exp(-K) - let in)   with xG on target

R_F, R_K: the division's goals per xG and goals let in per xGoT over its last
240 club matches, before the match (so 0 is the division's average). The
surprise is capped like the attack/defence one; the predicted and learning
rates take wF * F and wK * K. F replaces the season-level finishing (with or
without the 0.7 offseason pull toward the division mean), K the flat window.

    PYTHONPATH=experiments/improvements .venv/Scripts/python experiments/improvements/fcdk_online.py
"""
from __future__ import annotations

import itertools
import math
from collections import deque
from dataclasses import replace

import numpy as np

import harness as h
from elitetracker.model.attack_defence import ADConfig
from elitetracker.model.career import team_ids
from elitetracker.model.elo import MODEL_VERSION

REFERENCE_ROWS = 240
SPEEDS = (0.005, 0.01, 0.02, 0.04, 0.08)
WEIGHTS = (0.25, 0.5, 0.75, 1.0)


def online(kF=0.0, wF=0.0, kK=0.0, wK=0.0, pullF=1.0, f=False, k=False):
    """An ADX subclass with online finishing (f) and/or keeping (k)."""

    class Online(h.ADX):
        def _st(self):
            if not hasattr(self, "_online"):
                self._online = {"F": {}, "K": {}, "refF": {}, "refK": {}}
            return self._online

        def keeping(self, team_id):
            if not k:
                return super().keeping(team_id)
            return wK * self._st()["K"].get(team_id, 0.0)

        def _start_season(self, season):
            super()._start_season(season)
            if not f or pullF >= 1.0:
                return
            st = self._st()
            by: dict[str, list[str]] = {}
            for (year, t), lg in self.divisions.items():
                if year == season and t in st["F"]:
                    by.setdefault(lg, []).append(t)
            for teams in by.values():
                mean = sum(st["F"][t] for t in teams) / len(teams)
                for t in teams:
                    st["F"][t] = mean + pullF * (st["F"][t] - mean)
                    self.finishing[t] = wF * st["F"][t]

        def observe(self, match):
            st = self._st()
            shots = self.shots.get(match.match_id)
            home, away = team_ids(match)
            league = self.divisions.get((int(match.date[:4]), home), "")

            def ratio(rows):
                a, b = sum(r[0] for r in rows), sum(r[1] for r in rows)
                return a / b if a > 0 and b > 0 else 1.0

            refF = st["refF"].setdefault(league, deque(maxlen=REFERENCE_ROWS))
            refK = st["refK"].setdefault(league, deque(maxlen=REFERENCE_ROWS))
            r_f, r_k = ratio(refF), ratio(refK)
            super().observe(match)  # attack/defence step on the rates before this match's F and K
            if not shots:
                return
            cap = self.config.cap
            if f:
                for team, goals, xg in ((home, match.home_goals, shots[0]), (away, match.away_goals, shots[1])):
                    rating = st["F"].get(team, 0.0)
                    surprise = max(-cap, min(cap, goals - xg * r_f * math.exp(rating)))
                    st["F"][team] = rating + kF * surprise
                    self.finishing[team] = wF * st["F"][team]
                refF.extend(((match.home_goals, shots[0]), (match.away_goals, shots[1])))
            if k and len(shots) >= 4:
                # The home keeper faces the away side's xG on target, and the other way round.
                for team, let_in, faced in ((home, match.away_goals, shots[3]), (away, match.home_goals, shots[2])):
                    rating = st["K"].get(team, 0.0)
                    surprise = max(-cap, min(cap, faced * r_k * math.exp(-rating) - let_in))
                    st["K"][team] = rating + kK * surprise
                refK.extend(((match.away_goals, shots[3]), (match.home_goals, shots[2])))

    return Online


def main():
    h.identity()
    g0 = np.zeros(len(h.Y))
    elo = h.elo_run(gaps=g0)
    ad0 = h.ad_run(elo_gap=g0)
    base = h.blend(elo, ad0.probs)
    # The subclass with nothing switched on must be the shipped model.
    same = h.ad_run(elo_gap=g0, cls=online())
    print(f"{MODEL_VERSION}: subclass off, max diff {abs(same.probs - ad0.probs).max():.1e}")
    no_season_fin = replace(ADConfig(), finishing_regression=1.0)

    variants = {"shipped": base}
    for kK, wK in itertools.product(SPEEDS, WEIGHTS):
        ad = h.ad_run(elo_gap=g0, cls=online(kK=kK, wK=wK, k=True))
        variants[f"K k {kK} w {wK}"] = h.blend(elo, ad.probs)
    for pullF, kF, wF in itertools.product((1.0, 0.7), SPEEDS, WEIGHTS):
        ad = h.ad_run(no_season_fin, elo_gap=g0, cls=online(kF=kF, wF=wF, pullF=pullF, f=True))
        variants[f"F pull {pullF} k {kF} w {wF}"] = h.blend(elo, ad.probs)
    for speed, weight in itertools.product((0.01, 0.02, 0.04), (0.5, 0.75)):
        ad = h.ad_run(no_season_fin, elo_gap=g0,
                      cls=online(kF=speed, wF=weight, kK=speed, wK=weight, pullF=0.7, f=True, k=True))
        variants[f"FK k {speed} w {weight}"] = h.blend(elo, ad.probs)

    es21 = h.mask((2021, 2100), league="eliteserien")
    all21 = h.mask((2021, 2100))
    rows = []
    for key, p in variants.items():
        if key == "shipped":
            continue
        c_all, c_es, c_21 = h.compare(p, base, h.WINDOWS["all16"]), h.compare(p, base, es21), h.compare(p, base, all21)
        rows.append((c_all["ll"][0], key, c_all, c_es, c_21))
    print(f"\n{'variant':28s} {'all 2016+ LL (t)':>20s} {'Brier t':>8s} {'RPS t':>7s} {'halves t':>13s}"
          f"  {'all 2021+ LL (t)':>20s}  {'Eliteserien 2021+ LL (t)':>24s}")
    for family in ("K ", "F pull 1.0", "F pull 0.7", "FK"):
        fam = sorted((r for r in rows if r[1].startswith(family)), key=lambda r: r[0])
        for _, key, a, e, t21 in fam[:4] + fam[-1:]:
            print(f"{key:28s} {a['ll'][0]:+.5f} ({a['ll'][1]:+5.2f}) {a['brier'][1]:+8.2f} {a['rps'][1]:+7.2f} "
                  f"{a['ll_halves'][0]:+6.2f}/{a['ll_halves'][1]:+5.2f}  {t21['ll'][0]:+.5f} ({t21['ll'][1]:+5.2f})"
                  f"  {e['ll'][0]:+.5f} ({e['ll'][1]:+5.2f})")
        print(f"  ... {len(fam)} settings; worst shown last")
    print()
    for family in ("K ", "F pull 1.0", "F pull 0.7", "FK"):
        fam = {k: v for k, v in variants.items() if k == "shipped" or k.startswith(family)}
        h.oos_report(family.strip(), fam, "shipped", first=2019, windows=("all16", "es16", "ob16"))


if __name__ == "__main__":
    main()
