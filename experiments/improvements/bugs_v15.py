"""IMPROVEMENTS2.md 1.0, on elo-v15.0: three suspected bugs in the goals model.

A. At each offseason finishing regresses toward the division's mean
   finishing (`mean_f + r * (f - mean_f)`), though the comment says toward 0,
   so a division's league-wide goals over xG carries into the next season.
   Variants: zero-centred `r * (f - mean_f)`, toward zero `r * f`.
B. A club with no xG matches last season (relegated into OBOS-ligaen before
   it had xG, or back from the third tier) keeps its old finishing, regressed
   once more each offseason. Variants: reset to 0, halved.
C. `rates_against_average` does not call `start_season`; checked directly
   (it changes no odds).

`Fin._start_season` is `AttackDefence._start_season` verbatim with the
switches; at its defaults it is the shipped model (checked to the bit).

    PYTHONPATH=experiments/improvements .venv/Scripts/python experiments/improvements/bugs_v15.py
"""

from __future__ import annotations

import math

import numpy as np

import harness as h
import rules as r
from elitetracker.model.attack_defence import ADConfig, AttackDefence
from elitetracker.model.career import team_ids
from elitetracker.pipeline import market_values


class Fin(h.ADX):
    fin_target = "mean"   # "mean" (shipped), "centred" (r (f - mean)), "zero" (r f)
    fin_reg: float | None = None
    stale = "keep"        # "keep" (shipped), "reset", or a float multiplier
    stale_count = 0

    def _start_season(self, season):
        cfg = self.config
        reg_f = cfg.finishing_regression if self.fin_reg is None else self.fin_reg
        active: dict[str, list[str]] = {}
        for (year, team), league in self.divisions.items():
            if year == season:
                active.setdefault(league, []).append(team)
        prev_season = self.season
        first = prev_season is None
        self.season = season
        self._played = {}
        if prev_season is not None and self._season_xg and cfg.finishing_regression < 1.0:
            if self.stale != "keep":
                for t in [t for t in self.finishing if t not in self._season_xg and self.finishing[t] != 0.0]:
                    self.stale_count += 1
                    self.finishing[t] = 0.0 if self.stale == "reset" else self.stale * self.finishing[t]
            for team in list(self._season_goals):
                total_goals = self._season_goals[team]
                total_xg = self._season_xg[team]
                if total_xg > 0 and total_goals > 0:
                    self.finishing[team] = math.log(total_goals / total_xg)
            self._season_goals.clear()
            self._season_xg.clear()
        for league, teams in active.items():
            known = [t for t in teams if t in self.attack]
            regression, pull = cfg.offseason(league)
            down = {t for t in known if self.divisions.get((prev_season, t)) == "eliteserien"} \
                if league == "obosligaen" and not first else set()
            if known and not first and regression < 1.0:
                for ratings in (self.attack, self.defence):
                    mean = sum(ratings[t] for t in known) / len(known)
                    for t in known:
                        keep = cfg.relegated_regression if t in down else regression
                        ratings[t] = mean + keep * (ratings[t] - mean)
                fin_known = [t for t in teams if t in self.finishing]
                if fin_known:
                    mean_f = sum(self.finishing[t] for t in fin_known) / len(fin_known)
                    for t in fin_known:
                        f = self.finishing[t]
                        if self.fin_target == "mean":
                            self.finishing[t] = mean_f + reg_f * (f - mean_f)
                        elif self.fin_target == "centred":
                            self.finishing[t] = reg_f * (f - mean_f)
                        else:
                            self.finishing[t] = reg_f * f
            level = -cfg.division_gap if league == "obosligaen" else 0.0
            for t in teams:
                if t not in self.attack:
                    if known:
                        self.attack[t] = sum(self.attack[x] for x in known) / len(known) - cfg.newcomer
                        self.defence[t] = sum(self.defence[x] for x in known) / len(known) - cfg.newcomer
                    else:
                        self.attack[t] = level
                        self.defence[t] = level
                    self.finishing.setdefault(t, 0.0)
            if known and not first and pull:
                self._pull_toward_value(season, teams, regression, pull, down)
        if self.season_hook:
            self.season_hook(self, season)


def fin_class(**kw):
    return type("FinVariant", (Fin,), kw)


def goals_lines(name, out: h.ADOut, base: h.ADOut, keep):
    """Exact scoreline and over/under 2.5 log loss, paired against the shipped grid."""
    total = h.HG + h.AG
    ex = -np.log(np.clip(out.exact, 1e-12, 1)) + np.log(np.clip(base.exact, 1e-12, 1))
    ov = lambda o: -np.log(np.clip(np.where(total >= 3, o.over, 1 - o.over), 1e-12, 1))
    ou = ov(out) - ov(base)
    print(f"  {name}: exact scoreline {ex[keep].mean():+.5f} (t {h.tstat(ex[keep]):+.2f}), "
          f"over/under 2.5 {ou[keep].mean():+.5f} (t {h.tstat(ou[keep]):+.2f})")


def mean_finishing(cls) -> None:
    """Each division's mean finishing at the start of each xG season."""
    ad = cls.from_slices(h.SLICES, ADConfig(), shots=h.SHOTS, values=market_values())
    rows = []
    for season in range(2021, 2027):
        ad.replay([m for sl in h.SLICES if sl.season == season - 1 for m in sl.matches])
        ad.start_season(season)
        for lg in ("eliteserien", "obosligaen"):
            ts = [t for (y, t), l in ad.divisions.items() if y == season and l == lg]
            rows.append(f"{season} {lg[:3]} {np.mean([ad.finishing.get(t, 0.0) for t in ts]):+.3f}")
    print("  mean finishing at the season start: " + ", ".join(rows))


if __name__ == "__main__":
    base_out = r.BASE_AD
    ident = h.ad_run(cls=Fin)
    print(f"identity: Fin at its defaults vs the shipped grid, max diff {abs(ident.probs - base_out.probs).max():.1e}")
    assert abs(ident.probs - base_out.probs).max() == 0.0
    print("shipped:"); mean_finishing(Fin)

    # ---- A: the finishing target ----
    fam_a = {"shipped": r.BASE}
    outs = {}
    for target in ("centred", "zero"):
        for reg in (0.5, 0.7, 0.85):
            key = f"{target} r{reg}"
            out = h.ad_run(cls=fin_class(fin_target=target, fin_reg=reg))
            outs[key] = out
            fam_a[key] = h.blend(r.BASE_ELO, out.probs)
    for key in ("centred r0.7", "zero r0.7"):
        r.table(f"A, finishing {key} (shipped regression 0.70)", fam_a[key])
        goals_lines(key, outs[key], base_out, r.W["all16"])
        goals_lines(key + " [xg]", outs[key], base_out, r.W["xg"])
    print("centred r0.7:"); mean_finishing(fin_class(fin_target="centred"))
    for key in fam_a:
        if key != "shipped":
            c = h.compare(fam_a[key], r.BASE, r.W["all16"])
            print(f"  in-sample all16 {key}: {c['ll'][0]:+.5f} (t {c['ll'][1]:+.2f}); es21 "
                  f"{h.compare(fam_a[key], r.BASE, r.W['es21'])['ll'][0]:+.5f}")
    r.one_knob("A walk-forward (target x regression)", fam_a, "shipped")
    r.one_knob("A walk-forward, r 0.70 only", {k: v for k, v in fam_a.items() if k in ("shipped", "centred r0.7", "zero r0.7")}, "shipped")

    # ---- B: stale finishing ----
    fam_b = {"shipped": r.BASE}
    for stale in ("reset", 0.5):
        cls = fin_class(stale=stale)
        out = h.ad_run(cls=cls)
        fam_b[stale] = h.blend(r.BASE_ELO, out.probs)
        probe = cls.from_slices(h.SLICES, ADConfig(), shots=h.SHOTS, values=market_values())
        probe.replay([m for m, _, _ in h.PLAYED])
        affected = np.abs(fam_b[stale] - r.BASE).max(axis=1) > 0
        print(f"\nB {stale}: {probe.stale_count} club-seasons with stale finishing; "
              f"{int(affected.sum())} matches' odds move")
        r.table(f"B, stale finishing {stale}", fam_b[stale])
        if affected.any():
            print("  on the matches that move: " + r.cells(fam_b[stale], r.BASE, affected))
    r.one_knob("B walk-forward", fam_b, "shipped")

    # ---- C: rates_against_average before start_season ----
    ad = AttackDefence.from_slices(h.SLICES, ADConfig(), shots=h.SHOTS, values=market_values())
    worst = []
    for season in range(2017, 2027):
        ad.replay([m for sl in h.SLICES if sl.season == season - 1 for m in sl.matches])
        clubs = sorted({(lg, t) for (y, t), lg in ad.divisions.items() if y == season})
        before = {c: ad.rates_against_average(c[1], c[0], season) for c in clubs}
        probe = ad.copy()
        probe.start_season(season)
        after = {c: probe.rates_against_average(c[1], c[0], season) for c in clubs}
        d = max(max(abs(a - b) for a, b in zip(before[c], after[c])) for c in clubs)
        worst.append(f"{season} {d:.3f}")
    print("\nC: largest change in goals for/against an average side, pre-season, before vs after "
          "start_season: " + ", ".join(worst))
    print("   pipeline.build_report calls ad.start_season(season) before rates_against_average "
          "(pipeline.py:347, :822), so published reports are unaffected")
