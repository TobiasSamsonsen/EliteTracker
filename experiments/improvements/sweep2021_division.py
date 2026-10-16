"""The goals model's offseason pull, per division (sweep2021.py's third pass).

sweep2021_joint.py found a lower season regression and a stronger squad-value
pull better on OBOS-ligaen (t -3) and slightly worse on Eliteserien, so one
value cannot serve both. Here each division has its own (regression, pull):
the shipped pull is switched off (season_regression 1.0, value_pull 0.0) and
redone in a season hook, league by league, in the shipped order (the pull
toward the mean, finishing's pull, then the value shift for every club with
last season's value). With today's values in both divisions it is the
candidate to the bit.

    .venv/Scripts/python experiments/improvements/sweep2021_division.py
"""
from __future__ import annotations

import itertools
import math
import sys
from dataclasses import replace

import numpy as np

sys.path.insert(0, "experiments/improvements")
import fcdk  # noqa: E402
import harness  # noqa: E402
import sweep2021 as S  # noqa: E402
from harness import ad_run, blend, elo_run  # noqa: E402
from elitetracker.model.career import team_ids  # noqa: E402


def per_division(pulls: dict[str, tuple[float, float]], ad_changes=None):
    """The candidate's goals model with (season regression, value pull) per
    division; `pulls` maps league slug -> (regression, pull)."""
    config, hooks = fcdk.fcdk(**S.CANDIDATE)
    config = replace(config, season_regression=1.0, value_pull=0.0, **(ad_changes or {}))
    played: set[str] = set()
    inner_after = hooks["after_observe"]

    def after(ad, m):
        inner_after(ad, m)
        played.update(team_ids(m))

    def season_hook(ad, season):
        if not played:
            return
        active: dict[str, list[str]] = {}
        for (year, team), league in ad.divisions.items():
            if year == season:
                active.setdefault(league, []).append(team)
        for league, teams in active.items():
            reg, pull = pulls[league]
            known = [t for t in teams if t in played]
            if not known:
                continue
            for ratings in (ad.attack, ad.defence):
                mean = sum(ratings[t] for t in known) / len(known)
                for t in known:
                    ratings[t] = mean + reg * (ratings[t] - mean)
            fin = [t for t in known if t in ad.finishing]
            if fin and ad.config.finishing_regression < 1.0:
                mean_f = sum(ad.finishing[t] for t in fin) / len(fin)
                for t in fin:
                    ad.finishing[t] = mean_f + ad.config.finishing_regression * (ad.finishing[t] - mean_f)
            page = ad.values.get(season - 1, {})
            logs = {t: math.log(page[t]) for t in teams if page.get(t) and t in ad.attack}
            if logs and pull:
                mean_v = sum(logs.values()) / len(logs)
                for t, v in logs.items():
                    shift = (1.0 - reg) * pull * (v - mean_v)
                    ad.attack[t] += shift
                    ad.defence[t] += shift

    hooks = dict(hooks, after_observe=after, season_hook=season_hook)
    return blend(S.ELO, ad_run(config, **hooks).probs)


if __name__ == "__main__":
    same = per_division({"eliteserien": (0.88, 0.2), "obosligaen": (0.88, 0.2)})
    print(f"identity: max diff vs the candidate {np.abs(same - S.CAND).max():.2e}")
    assert np.abs(same - S.CAND).max() < 1e-9

    print("\n-- OBOS-ligaen's (regression, pull), Eliteserien kept at (0.88, 0.2)")
    family = {"ob 0.88/0.2": S.CAND}
    for reg, pull in itertools.product((0.70, 0.75, 0.80, 0.84, 0.88), (0.2, 0.3, 0.4, 0.5)):
        key = f"ob {reg}/{pull}"
        if key not in family:
            family[key] = per_division({"eliteserien": (0.88, 0.2), "obosligaen": (reg, pull)})
        print(f"  {key:<14} {S.cells(family[key], S.CAND)}")
    print("   " + S.walk_forward(family, "ob 0.88/0.2"))

    print("\n-- Eliteserien's, OBOS-ligaen at (0.75, 0.3)")
    family_es = {}
    for reg, pull in itertools.product((0.84, 0.88, 0.92), (0.1, 0.2, 0.3)):
        key = f"es {reg}/{pull}"
        family_es[key] = per_division({"eliteserien": (reg, pull), "obosligaen": (0.75, 0.3)})
        print(f"  {key:<14} {S.cells(family_es[key], S.CAND)}")
    print("   " + S.walk_forward(family_es, "es 0.88/0.2"))
