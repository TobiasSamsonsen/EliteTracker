"""IMPROVEMENTS.md 1.7-1.9: squad market values, an early-season step, rest
days and UEFA congestion. Local files only (data/market_values.json,
data/raw/fotmob_other_matches.json).

    .venv/Scripts/python experiments/improvements/context_terms.py
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import replace
from datetime import date

import numpy as np

sys.path.insert(0, "experiments/improvements")
from harness import (  # noqa: E402
    INDEX, LEAGUE, PLAYED, SEASON, WINDOWS, EloRun, ad_run, blend, elo_run, line, oos_report,
)
from elitetracker.model.attack_defence import ADConfig  # noqa: E402
from elitetracker.model.career import team_ids  # noqa: E402

BASE_ELO = elo_run()
BASE_AD = ad_run()
BASE_MIX = blend(BASE_ELO, BASE_AD.probs)
A16 = WINDOWS["all16"]

# ------------------------------------------------------------ 1.7 ----
MV = json.load(open("data/market_values.json", encoding="utf-8"))


def v_rel(season: int, source: str) -> dict[str, float]:
    """log(value / division geometric mean) per club for `season`.
    source 'prev': the previous season's page (leak-free: before the season);
    'same': the season's own page (may carry in-season hindsight)."""
    year = season - 1 if source == "prev" else season
    page = MV.get(str(year), {})
    league_of = {t: lg for (y, t), lg in DIVISIONS.items() if y == season}
    out: dict[str, float] = {}
    by_league: dict[str, list[tuple[str, float]]] = {}
    for t, entry in page.items():
        if t in league_of and entry.get("total"):
            by_league.setdefault(league_of[t], []).append((t, math.log(entry["total"])))
    for lg, rows in by_league.items():
        mean = sum(v for _, v in rows) / len(rows)
        out.update({t: v - mean for t, v in rows})
    return out


from harness import SLICES  # noqa: E402
DIVISIONS = {(s.season, t): s.league for s in SLICES for m in s.matches for t in team_ids(m)}
VREL = {(src, s): v_rel(s, src) for src in ("prev", "same") for s in range(2015, 2027)}


def elo_target(beta: float, source: str):
    def target(season, league, ids, ratings):
        mean = sum(ratings[t] for t in ids) / len(ids)
        rel = VREL[(source, season)]
        return {t: mean + beta * rel[t] for t in ids if t in rel}
    return target


def ad_target(beta: float, source: str):
    """Re-pull attack and defence toward a value-shifted division mean after the
    shipped pull: equivalent to pulling toward mean + beta * v (in log goals)."""
    def hook(ad, season):
        rel = VREL[(source, season)]
        reg = ad.config.season_regression
        for t, v in rel.items():
            if t in ad.attack:
                ad.attack[t] += (1 - reg) * beta * v
                ad.defence[t] += (1 - reg) * beta * v
    return hook


def ad_covariate(gamma: float, source: str, tau: float | None):
    def hook(ad, home, away, on, lam, mu):
        rel = VREL[(source, int(on[:4]))]
        if home not in rel or away not in rel:
            return lam, mu
        decay = 1.0
        if tau:
            m = (COUNT.get((home, on), 0) + COUNT.get((away, on), 0)) / 2
            decay = math.exp(-m / tau)
        d = gamma * decay * (rel[home] - rel[away]) / 2
        return lam * math.exp(d), mu * math.exp(-d)
    return hook


# matches played this season before each match date, per club
COUNT: dict[tuple[str, str], int] = {}
_seen: dict[tuple[str, int], int] = {}
for m, lg, s in PLAYED:
    for t in team_ids(m):
        COUNT[(t, m.date)] = _seen.get((t, s), 0)
    for t in team_ids(m):
        _seen[(t, s)] = _seen.get((t, s), 0) + 1


# ------------------------------------------------------------ 1.9 ----
OTHER = json.load(open("data/raw/fotmob_other_matches.json", encoding="utf-8"))["matches"]
UEFA = {"clq", "cl", "elq", "el", "eclq", "ecl"}


def calendar():
    """Per played league match: (rest_home, rest_away, league-only rest h/a,
    uefa_before_h, uefa_before_a) with rest capped at 10 days."""
    events: dict[str, list[tuple[str, str]]] = {}
    for m, _, _ in PLAYED:
        for t in team_ids(m):
            events.setdefault(t, []).append((m.date, "league"))
    for _, o in OTHER.items():
        if not o.get("finished") or o.get("cancelled"):
            continue
        day = o["utc"][:10]
        for t in (o["home"], o["away"]):
            events.setdefault(t, []).append((day, o["comp"]))
    for t in events:
        events[t].sort()
    feats = np.zeros((len(PLAYED), 6))
    for i, (m, _, _) in enumerate(PLAYED):
        today = date.fromisoformat(m.date)
        row = []
        for t in team_ids(m):
            before = [(d, c) for d, c in events[t] if d < m.date]
            last_any = before[-1][0] if before else None
            last_league = next((d for d, c in reversed(before) if c == "league"), None)
            rest_any = min(10, (today - date.fromisoformat(last_any)).days) if last_any else 10
            rest_league = min(10, (today - date.fromisoformat(last_league)).days) if last_league else 10
            uefa = any(c in UEFA and 0 < (today - date.fromisoformat(d)).days <= 4 for d, c in before[-3:])
            row.append((rest_any, rest_league, float(uefa)))
        (ra_h, rl_h, u_h), (ra_a, rl_a, u_a) = row
        feats[i] = (ra_h, ra_a, rl_h, rl_a, u_h, u_a)
    return feats


def main() -> None:
    print("== 1.7 market values ==")
    for src in ("prev", "same"):
        cover = sum(1 for (s, t) in DIVISIONS if t in VREL[(src, s)] and s >= 2016) / sum(1 for (s, _) in DIVISIONS if s >= 2016)
        print(f"  {src}: club-seasons with a value 2016+: {cover:.1%}")
    for src in ("prev", "same"):
        fam = {0: BASE_ELO}
        for beta in (25, 50, 100, 150):
            e = elo_run(EloRun(target=elo_target(beta, src)))
            fam[beta] = e
            print(line(f"1.7A Elo pull to value b={beta} {src} elo", e, BASE_ELO, A16))
        oos_report(f"1.7A Elo {src} elo", fam, 0)
        oos_report(f"1.7A Elo {src} blend", {k: blend(v, BASE_AD.probs) for k, v in fam.items()}, 0)
        famad = {0: BASE_MIX}
        for beta in (0.05, 0.1, 0.2, 0.3):
            out = ad_run(season_hook=ad_target(beta, src))
            famad[beta] = blend(BASE_ELO, out.probs)
            print(line(f"1.7A AD pull to value b={beta} {src} blend", famad[beta], BASE_MIX, A16))
        oos_report(f"1.7A AD {src}", famad, 0)
        # newcomers: a club without a rating seeded from its value (same-season only: no prior page)
    fam = {0: BASE_ELO}
    for beta in (50, 100):
        def newcomer(t, season, league, beta=beta):
            rel = VREL[("same", season)]
            floor = 1330.0
            return floor + beta * rel[t] if t in rel else floor
        fam[beta] = elo_run(EloRun(newcomer=newcomer))
        print(line(f"1.7A newcomer seeded by value b={beta} elo", fam[beta], BASE_ELO, A16))
    for src in ("prev", "same"):
        fam = {0: BASE_MIX}
        for gamma in (0.05, 0.1, 0.2):
            for tau in (None, 10.0):
                out = ad_run(rates_hook=ad_covariate(gamma, src, tau))
                fam[(gamma, tau)] = blend(BASE_ELO, out.probs)
                print(line(f"1.7B AD covariate g={gamma} tau={tau} {src}", fam[(gamma, tau)], BASE_MIX, A16))
        oos_report(f"1.7B AD covariate {src}", fam, 0)
        early = A16 & np.array([COUNT[(team_ids(m)[0], m.date)] < 10 for m, _, _ in PLAYED])
        best = min((k for k in fam if k), key=lambda k: -0)  # report rounds 1-10 for each
        for k, v in fam.items():
            if k:
                print(line(f"1.7B rounds 1-10 {k} {src}", v, BASE_MIX, early))

    print("\n== 1.8 early-season step ==")
    fam_e, fam_a, fam_b = {0: BASE_ELO}, {0: BASE_MIX}, {0: BASE_MIX}
    for g in (0.20, 0.35, 0.50, 1.0):
        for tau in (3.0, 5.0):
            def kmult(m, lg, season, ctx, g=g, tau=tau):
                h, a = team_ids(m)
                mm = (ctx.count.get(h, 0) + ctx.count.get(a, 0)) / 2
                return 1.0 + g * math.exp(-mm / tau)
            e = elo_run(EloRun(k_mult=kmult))
            fam_e[(g, tau)] = e
            def khook(ad, team, match, g=g, tau=tau):
                return 1.0 + g * math.exp(-COUNT[(team, match.date)] / tau)
            out = ad_run(k_hook=khook)
            fam_a[(g, tau)] = blend(BASE_ELO, out.probs)
            fam_b[(g, tau)] = blend(e, out.probs)
            print(line(f"1.8 g={g} tau={tau} elo", e, BASE_ELO, A16))
            print(line(f"1.8 g={g} tau={tau} AD blend", fam_a[(g, tau)], BASE_MIX, A16))
            print(line(f"1.8 g={g} tau={tau} both blend", fam_b[(g, tau)], BASE_MIX, A16))
    oos_report("1.8 Elo", fam_e, 0)
    oos_report("1.8 AD", fam_a, 0)
    oos_report("1.8 both", fam_b, 0)
    # with the spread re-swept alongside
    fam_s = {0: BASE_MIX}
    for spread in (1.0, 1.05, 1.15):
        out = ad_run(config=replace(ADConfig(), spread=spread))
        fam_s[("s", spread)] = blend(BASE_ELO, out.probs)
        for g in (0.35, 0.5):
            def khook(ad, team, match, g=g):
                return 1.0 + g * math.exp(-COUNT[(team, match.date)] / 5.0)
            out = ad_run(config=replace(ADConfig(), spread=spread), k_hook=khook)
            fam_s[(spread, g)] = blend(BASE_ELO, out.probs)
            print(line(f"1.8 spread={spread} g={g} AD blend", fam_s[(spread, g)], BASE_MIX, A16))
    oos_report("1.8 with spread", fam_s, 0)

    print("\n== 1.9 rest days and UEFA congestion ==")
    feats = calendar()
    for label, col in (("any comp", (0, 1)), ("league only", (2, 3))):
        rd = feats[:, col[0]] - feats[:, col[1]]
        print(f"  {label}: rest diff distribution "
              + " ".join(f"{v:+.0f}:{(rd == v).mean():.1%}" for v in (-7, -4, -3, -2, -1, 0, 1, 2, 3, 4, 7)))
        fam_e, fam_a = {0: BASE_ELO}, {0: BASE_MIX}
        for g in (-20, -10, -5, 5, 10, 20):
            shift = lambda m, lg, s, ctx, g=g, rd=rd: g * math.tanh(rd[INDEX[m.match_id]] / 3.0)
            e = elo_run(EloRun(home_shift=shift))
            fam_e[g] = e
            print(line(f"1.9 rest {label} g={g} elo", e, BASE_ELO, A16))
        for g in (-0.10, -0.05, 0.05, 0.10):
            hook = lambda ad, h, a, on, lam, mu, g=g, rd=rd: (lam, mu)  # replaced below
            def rhook(ad, h, a, on, lam, mu, g=g, rd=rd):
                d = g * math.tanh(REST_LOOKUP[(h, a, on)] / 3.0) / 2
                return lam * math.exp(d), mu * math.exp(-d)
            REST_LOOKUP.clear()
            for i, (m, _, _) in enumerate(PLAYED):
                REST_LOOKUP[(*team_ids(m), m.date)] = rd[i]
            out = ad_run(rates_hook=rhook)
            fam_a[g] = blend(BASE_ELO, out.probs)
            print(line(f"1.9 rest {label} g={g} AD blend", fam_a[g], BASE_MIX, A16))
        oos_report(f"1.9 rest {label} Elo", fam_e, 0)
        oos_report(f"1.9 rest {label} AD", fam_a, 0)
    u = feats[:, 5] - feats[:, 4]  # away congested minus home congested
    print(f"  UEFA within 4 days before: home {feats[:, 4].sum():.0f}, away {feats[:, 5].sum():.0f} matches")
    fam = {0: BASE_ELO}
    for g in (-30, -15, 15, 30):
        e = elo_run(EloRun(home_shift=lambda m, lg, s, ctx, g=g: g * u[INDEX[m.match_id]]))
        fam[g] = e
        print(line(f"1.9 UEFA congestion g={g} elo", e, BASE_ELO, A16))
        print(line(f"1.9 UEFA congestion g={g} elo [touched]", e, BASE_ELO, A16 & (u != 0)))
    oos_report("1.9 UEFA Elo", fam, 0)
    oos_report("1.9 UEFA blend", {k: blend(v, BASE_AD.probs) for k, v in fam.items()}, 0)


REST_LOOKUP: dict = {}

if __name__ == "__main__":
    main()
