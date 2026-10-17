"""IMPROVEMENTS2.md Rank 6, on elo-v15.0: late-season table stakes.

For a match where both sides have played 24 or more of their 30, the live
table from the matches before its date: each side's distance d in points to
the nearest line it is on either side of (the edges of the season's bands in
`pipeline.bands_for`: the title, the European or promotion places, the
promotion play-off, the relegation play-off and relegation), measured to the
first club across the line, and its pressure
    P = exp(-max(0, d - 1) / (tau * r)),  r its matches left.
On the prediction only (the ratings never see it, as the surface edge):
Elo + gamma (P_home - P_away), gamma 10-45 x tau 0.5-1.2; and the goals
model's rates x exp(+-kappa (P_home - P_away)).

    PYTHONPATH=experiments/improvements .venv/Scripts/python experiments/improvements/rank6_tablestakes.py
"""

from __future__ import annotations

import itertools
import math

import numpy as np

import harness as h
import rules as r
from elitetracker.model.career import team_ids
from elitetracker.model.table import table_from_matches
from elitetracker.pipeline import LEAGUE_SPECS, bands_for

ROUNDS = 30
MIN_PLAYED = 24


def lines(league: str, season: int) -> list[int]:
    """Positions b with a line between b and b + 1."""
    out = set()
    for band in bands_for(LEAGUE_SPECS[league], season):
        out |= {band.first - 1, band.last}
    return sorted(b for b in out if 1 <= b <= 15)


def distances() -> dict[str, tuple[int, int, int, int]]:
    """match_id -> (d_home, left_home, d_away, left_away) for the run-in."""
    out = {}
    for sl in h.SLICES:
        played = [m for m in sl.matches if m.played]
        cuts = lines(sl.league, sl.season)
        for day in sorted({m.date for m in played}):
            today = [m for m in played if m.date == day]
            table = table_from_matches([m for m in played if m.date < day])
            rows = {row.team_id: (pos, row) for pos, row in enumerate(table, start=1)}
            pts = [row.points for row in table]
            for m in today:
                home, away = team_ids(m)
                if home not in rows or away not in rows:
                    continue
                if min(rows[home][1].played, rows[away][1].played) < MIN_PLAYED:
                    continue
                vals = []
                for t in (home, away):
                    pos, row = rows[t]
                    d = min(pts[pos - 1] - pts[b] if pos <= b else pts[b - 1] - pts[pos - 1] for b in cuts)
                    vals += [d, ROUNDS - row.played]
                out[m.match_id] = tuple(vals)
    return out


D = distances()
LATE = h.mask() & np.array([m.match_id in D for m, _, _ in h.PLAYED])


def pressure(d: int, left: int, tau: float) -> float:
    return math.exp(-max(0, d - 1) / (tau * max(left, 1)))


def diff(mid: str, tau: float) -> float:
    dh, lh, da, la = D[mid]
    return pressure(dh, lh, tau) - pressure(da, la, tau)


def elo_shift(gamma: float, tau: float):
    return lambda m, lg, season, ctx: gamma * diff(m.match_id, tau) if m.match_id in D else 0.0


def ad_run_shift(kappa: float, tau: float) -> np.ndarray:
    """The goals model with its rates moved by the pressure difference;
    rates() is called once per match, before observe, in kickoff order."""
    order = iter(h.PLAYED)

    def hook(ad, home, away, on, lam, mu):
        m = next(order)[0]
        assert team_ids(m) == (home, away)
        if m.match_id not in D:
            return lam, mu
        x = kappa * diff(m.match_id, tau)
        return lam * math.exp(x), mu * math.exp(-x)
    return h.ad_run(rates_hook=hook).probs


def residuals() -> None:
    """The shipped odds' miss on the run-in, by the pressure difference."""
    keep = np.nonzero(LATE)[0]
    x = np.array([diff(h.IDS[i], 0.8) for i in keep])
    pts = np.where(h.Y[keep] == 0, 1.0, np.where(h.Y[keep] == 1, 0.5, 0.0))
    exp = r.BASE[keep, 0] + 0.5 * r.BASE[keep, 1]
    for lo, hi, name in ((-1.01, -0.3, "away under more pressure"), (-0.3, 0.3, "about even"),
                         (0.3, 1.01, "home under more pressure")):
        sel = (x > lo) & (x <= hi)
        res = pts[sel] - exp[sel]
        print(f"  {name}: {int(sel.sum())} matches, home points share actual - expected "
              f"{res.mean():+.4f} (t {h.tstat(res):+.2f})")


if __name__ == "__main__":
    print(f"run-in: {int(LATE.sum())} matches 2016+ with both sides past {MIN_PLAYED} played; lines e.g. "
          f"Eliteserien 2019 {lines('eliteserien', 2019)}, 2025 {lines('eliteserien', 2025)}, "
          f"OBOS-ligaen {lines('obosligaen', 2025)}")
    residuals()
    extra = {"late": LATE}
    wins = ("all16", "es16", "ob16", "late")

    elo_fam = {(0, 0.8): r.BASE}
    for gamma, tau in itertools.product((10, 20, 30, 45), (0.5, 0.8, 1.2)):
        e = h.elo_run(h.EloRun(home_shift=elo_shift(gamma, tau), shift_in_update=False))
        elo_fam[(gamma, tau)] = h.blend(e, r.BASE_AD.probs)
        c = h.compare(elo_fam[(gamma, tau)], r.BASE, LATE)
        print(f"  Elo gamma {gamma} tau {tau}: run-in LL {c['ll'][0]:+.5f} (t {c['ll'][1]:+.2f}), "
              f"Brier {c['brier'][0]:+.5f}, RPS {c['rps'][0]:+.5f}")
    r.table("Elo gamma 30, tau 0.8", elo_fam[(30, 0.8)], extra=extra, windows=wins)
    r.one_knob("Elo stakes, walk-forward", elo_fam, (0, 0.8), restrict=LATE)
    best = min((k for k in elo_fam if k[0]), key=lambda k: h.losses(elo_fam[k][LATE], h.Y[LATE])["ll"].mean())
    r.structural(f"Elo stakes {best}", elo_fam[best], target="late", extra=extra)

    ad_fam = {(0, 0.8): r.BASE}
    for kappa, tau in itertools.product((0.03, 0.06, 0.10), (0.5, 0.8, 1.2)):
        ad_fam[(kappa, tau)] = h.blend(r.BASE_ELO, ad_run_shift(kappa, tau))
        c = h.compare(ad_fam[(kappa, tau)], r.BASE, LATE)
        print(f"  goals model kappa {kappa} tau {tau}: run-in LL {c['ll'][0]:+.5f} (t {c['ll'][1]:+.2f}), "
              f"Brier {c['brier'][0]:+.5f}, RPS {c['rps'][0]:+.5f}")
    r.table("goals model kappa 0.06, tau 0.8", ad_fam[(0.06, 0.8)], extra=extra, windows=wins)
    r.one_knob("goals-model stakes, walk-forward", ad_fam, (0, 0.8), restrict=LATE)
