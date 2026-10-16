"""Keeping and finishing as weighted averages, recent matches counting most
(October 2026, the owner's idea).

fcdk.py's windows weigh each of a club's last N matches the same. Here every
match's weight halves every `half-life` matches: decayed sums of goals and
xG (finishing) and of goals let in and xGoT faced (keeping), against the
division's last ~240 club matches, shrunk to w, from `min_n` matches on.
Scored on the final elo-v14.0 candidate (sweep2021_final.py: per-division
offseason pull, surface edge 20), paired against it; its keeping is the flat
45-match window x 0.75.

    .venv/Scripts/python experiments/improvements/fcdk_decay.py
"""
from __future__ import annotations

import math
import sys
from collections import deque

sys.path.insert(0, "experiments/improvements")
import fcdk  # noqa: E402
import harness  # noqa: E402
import sweep2021 as S  # noqa: E402
import sweep2021_division as D  # noqa: E402
from harness import LEAGUE, SEASON, SHOTS, WINDOWS, ADConfig, elo_run, line, oos  # noqa: E402
from elitetracker.model.career import team_ids  # noqa: E402

PULLS = {"eliteserien": (0.88, 0.2), "obosligaen": (0.75, 0.3)}
LEAGUE_ROWS = 240


def decayed(alpha=0.9, keep=("flat", 45, 0.75), fin=None, min_n=10):
    """(config, hooks): keeping and finishing as ("flat", N, w) or
    ("decay", half-life, w); fin None keeps last season's finishing."""
    clubs: dict[str, dict] = {}
    league_xg: dict[str, deque] = {}
    league_got: dict[str, deque] = {}
    league_of: dict[str, str] = {}

    def state(team):
        return clubs.setdefault(team, {"fin": [0.0, 0.0, 0], "keep": [0.0, 0.0, 0],
                                       "fin_rows": deque(maxlen=200), "keep_rows": deque(maxlen=200)})

    def add(slot, rows, spec, top, bottom):
        if spec is None:
            return
        kind, size, _ = spec
        if kind == "decay":
            d = 0.5 ** (1.0 / size)
            slot[0] = slot[0] * d + top
            slot[1] = slot[1] * d + bottom
        rows.append((top, bottom))
        slot[2] += 1

    def after(ad, m):
        shots = SHOTS.get(m.match_id)
        if not shots:
            return
        home, away = team_ids(m)
        league = ad.divisions.get((int(m.date[:4]), home), "")
        got = len(shots) >= 4
        for team, gf, ga, xf, oa in (
            (home, m.home_goals, m.away_goals, shots[0], shots[3] if got else None),
            (away, m.away_goals, m.home_goals, shots[1], shots[2] if got else None),
        ):
            league_of[team] = league
            s = state(team)
            add(s["fin"], s["fin_rows"], fin, gf, xf)
            league_xg.setdefault(league, deque(maxlen=LEAGUE_ROWS)).append((gf, xf))
            if got:
                add(s["keep"], s["keep_rows"], keep, oa, ga)   # xGoT faced / let in
                league_got.setdefault(league, deque(maxlen=LEAGUE_ROWS)).append((oa, ga))

    def term(team, which, spec, ref):
        if spec is None:
            return 0.0
        kind, size, w = spec
        s = clubs.get(team)
        if not s or not ref:
            return 0.0
        slot = s[which]
        if kind in ("flat", "taper"):
            rows = list(s[f"{which}_rows"])[-size:]
            if len(rows) < size // 2:
                return 0.0
            # taper: the newest match weighs 1, the window's oldest 1 / size
            weights = [(size - age) / size for age in range(len(rows) - 1, -1, -1)] if kind == "taper" else [1.0] * len(rows)
            top = sum(wt * r[0] for wt, r in zip(weights, rows))
            bottom = sum(wt * r[1] for wt, r in zip(weights, rows))
        else:
            if slot[2] < min_n:
                return 0.0
            top, bottom = slot[0], slot[1]
        rt, rb = sum(r[0] for r in ref), sum(r[1] for r in ref)
        if top <= 0 or bottom <= 0 or rt <= 0 or rb <= 0:
            return 0.0
        return w * (math.log(top / bottom) - math.log(rt / rb))

    def extra(home, away):
        f = lambda t: term(t, "fin", fin, league_xg.get(league_of.get(t)))  # noqa: E731
        k = lambda t: term(t, "keep", keep, league_got.get(league_of.get(t)))  # noqa: E731
        return f(home) - k(away), f(away) - k(home)

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

    config = ADConfig(alpha=alpha, finishing_regression=1.0 if fin else ADConfig().finishing_regression)
    return config, {"after_observe": after, "rates_hook": rates_hook, "learn_hook": learn_hook}


def final_with(**kw):
    """The final candidate's per-division pull, with these keeping/finishing hooks."""
    real = D.fcdk.fcdk
    D.fcdk.fcdk = lambda **_: decayed(**kw)
    try:
        return D.per_division(PULLS)
    finally:
        D.fcdk.fcdk = real


if __name__ == "__main__":
    original = harness.surface_edge
    harness.surface_edge = lambda h, a, on: original(h, a, on, edge=20.0)
    S.ELO = elo_run()
    harness.surface_edge = original
    final = D.per_division(PULLS)
    same = final_with()
    print(f"identity (flat 45 x 0.75 through these hooks): max diff {abs(same - final).max():.2e}")
    windows = {"all 2021+": SEASON >= 2021, "Eliteserien 2021+": (SEASON >= 2021) & (LEAGUE == "eliteserien"),
               "all 2016+": WINDOWS["all16"]}

    def short(name, p):
        out = []
        for label, keep in windows.items():
            c = harness.compare(p, final, keep)
            out.append(f"{label} {c['ll'][0]:+.5f} (t {c['ll'][1]:+5.2f})")
        c = harness.compare(p, final, windows["Eliteserien 2021+"])
        return f"{name:<34} " + "  ".join(out) + f"  es Br t {c['brier'][1]:+5.2f} RPS t {c['rps'][1]:+5.2f}"

    print("\n-- keeping, weighted: half-life (matches) x weight, vs the flat 45 x 0.75")
    family = {"flat 45 x 0.75": final}
    for hl in (10, 15, 20, 30, 45, 60):
        for w in (0.5, 0.75, 1.0):
            key = f"keep half-life {hl} x {w}"
            family[key] = p = final_with(keep=("decay", hl, w))
            print(short(key, p))
    chosen, picks = oos(family, "flat 45 x 0.75", first=2021, select_from=2016)
    print("walk-forward picks: " + " | ".join(f"{s}: {p}" for s, p in sorted(picks.items())))
    print(short("walk-forward", chosen))
    best = min((k for k in family if k != "flat 45 x 0.75"),
               key=lambda k: harness.compare(family[k], final, windows["all 2021+"])["ll"][0])
    print(f"best keeping: {best}")

    print("\n-- finishing, weighted, in place of last season's (keeping as the final model's)")
    for hl in (10, 20, 30, 45, 60, 90):
        for w in (0.25, 0.5):
            print(short(f"finishing half-life {hl} x {w}", final_with(fin=("decay", hl, w))))
