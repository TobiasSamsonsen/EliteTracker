"""Luck view: which signals take the skill out of the luck (October 2026, the
owner's question, after luck_signals.py).

A club's luck is its points against its usual points: the Poisson xG points
of its matches plus whatever skill terms a method adds. luck_signals.py
showed that a term read off this season's goals soaks up this season's luck
(the no-skill world), so every term here is fixed before the season (last
season's finishing, the pre-season rating, the squad value) or read off this
season's xG, never its goals. Each method is scored three ways:

1. per match, out of sample: each season's coefficients fitted on the other
   seasons, then the points squared error and the W/D/L log loss of every
   match against the plain xG points, paired by match;
2. the skill left in a club season's luck: the between-club-season variance
   of the per-match luck beyond what its noise explains (one-way random
   effects), in points squared a club season, with a bootstrap se; and the
   luck's correlation with the pre-season rating, the squad value and the
   season's xG points a match; halves; year to year;
3. the no-skill world: goals drawn Poisson from the xG, so all of it is luck
   and no skill is there to find.

Then the shots (fotmob's, Eliteserien): each match's expected points from its
shots one by one instead of a Poisson on its total, and each shot's luck
weighted by what the match hung on it (`wpa_luck`), against the shot world
(the real shots, each going in with its xG, so all of it is luck). Last,
OBOS-ligaen (Sofascore xG from 2023, no shots), a champion's luck in the shot
world, and this season's chance quality (xG a shot, shot share) as trend terms.

Eliteserien 2020-2026 (fotmob xG and xG on target; 2020 only as last season
for 2021), OBOS-ligaen 2023-2026 (Sofascore xG). About 90 seconds; the output
is in out/luck_skill.txt.

    .venv/Scripts/python -W ignore experiments/improvements/luck_skill.py > experiments/improvements/out/luck_skill.txt
"""

from __future__ import annotations

import json
import math
from collections import defaultdict

import numpy as np

from elitetracker.pipeline import build_all_careers

ES, OBOS = "eliteserien", "obosligaen"
LEAGUES = {ES: range(2020, 2027), OBOS: range(2023, 2027)}
SCORED = range(2021, 2027)          # per match (2026 so far)
FINISHED = range(2021, 2026)        # club seasons
XG = json.load(open("data/xg.json", encoding="utf-8"))["matches"]
EXTRAS = json.load(open("data/raw/fotmob_match_extras.json", encoding="utf-8"))
ODDS = json.load(open("data/odds_closing.json", encoding="utf-8"))
VALUES = {int(s): {t: e["total"] for t, e in clubs.items() if e.get("total")}
          for s, clubs in json.load(open("data/market_values.json", encoding="utf-8")).items()}


# --- matches ----------------------------------------------------------------

def oriented_shots(mid: str, xg: tuple[float, float]):
    """The shots as (minute, is_home, xg, situation, own_goal, event): fotmob's
    `side` is the home side's when its summed xG matches the stored home xG."""
    e = EXTRAS.get(mid)
    if not e:
        return None
    s = [sum(x[2] for x in e["shots"] if x[1] == k) for k in (0, 1)]
    home = 1 if abs(s[1] - xg[0]) + abs(s[0] - xg[1]) <= abs(s[0] - xg[0]) + abs(s[1] - xg[1]) else 0
    return [(x[0], x[1] == home, x[2], x[3], bool(x[4]), x[5]) for x in e["shots"]]


def load() -> list[dict]:
    out = []
    for league, seasons in LEAGUES.items():
        for season in seasons:
            for m in json.load(open(f"data/normalized/{league}_{season}_matches.json", encoding="utf-8")):
                x = XG.get(m["match_id"])
                if not m.get("played") or m.get("home_goals") is None or not x:
                    continue
                r = {"id": m["match_id"], "league": league, "season": season, "date": m["date"],
                     "home": m["home_id"], "away": m["away_id"], "hg": m["home_goals"], "ag": m["away_goals"],
                     "xg": (x[0], x[1]), "xgot": (x[2], x[3]) if len(x) >= 4 else None}
                r["shots"] = oriented_shots(r["id"], r["xg"]) if league == ES else None
                out.append(r)
    out.sort(key=lambda r: (r["date"], r["home"]))
    return out


MATCHES = load()
GOALS = np.array([[r["hg"], r["ag"]] for r in MATCHES])
SC_IDX = np.array([i for i, r in enumerate(MATCHES) if r["league"] == ES and r["season"] in SCORED])
SC = [MATCHES[i] for i in SC_IDX]
N = len(SC)
SEASON = np.array([r["season"] for r in SC])


# --- outcome probabilities, vectorised ---------------------------------------

KMAX = 12
_K = np.arange(KMAX + 1)
_FACT = np.array([math.factorial(k) for k in _K], dtype=float)


def pmf(lam) -> np.ndarray:
    lam = np.asarray(lam, dtype=float)[:, None]
    return np.exp(-lam) * lam ** _K / _FACT


def wdl(lh, la) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(home win, draw, away win) from two Poisson means, each grid's mass
    renormalised as the browser's `xgPoints` does."""
    ph, pa = pmf(lh), pmf(la)
    mass = ph.sum(1) * pa.sum(1)
    below = np.concatenate([np.zeros((len(pa), 1)), np.cumsum(pa, axis=1)[:, :-1]], axis=1)
    home = (ph * below).sum(1) / mass
    draw = (ph * pa).sum(1) / mass
    return home, draw, 1.0 - home - draw


def xpoints(lh, la) -> np.ndarray:
    """(n, 2): home and away expected points."""
    h, d, a = wdl(lh, la)
    return np.column_stack([3 * h + d, 3 * a + d])


PLAIN_ALL = xpoints([r["xg"][0] for r in MATCHES], [r["xg"][1] for r in MATCHES])
XGH = np.array([r["xg"][0] for r in SC])
XGA = np.array([r["xg"][1] for r in SC])
PLAIN = PLAIN_ALL[SC_IDX]


# --- what is known before a season, and what this season's xG says -----------

CAREERS = build_all_careers()
ELO_START = {(tid, rec.season): rec.rating_start for tid, c in CAREERS.items() for rec in c.seasons}


def _division(season: int) -> list[str]:
    return sorted({t for r in MATCHES if r["league"] == ES and r["season"] == season for t in (r["home"], r["away"])})


def centred(season: int, get) -> dict[str, float]:
    """team -> value - the division's mean, over the clubs that have one."""
    vals = {t: get(t) for t in _division(season)}
    vals = {t: v for t, v in vals.items() if v is not None}
    mean = sum(vals.values()) / len(vals) if vals else 0.0
    return {t: v - mean for t, v in vals.items()}


_xp = defaultdict(list)
_mk = defaultdict(list)
for _i, _r in enumerate(MATCHES):
    if _r["league"] != ES:
        continue
    _xp[(_r["home"], _r["season"])].append(PLAIN_ALL[_i, 0])
    _xp[(_r["away"], _r["season"])].append(PLAIN_ALL[_i, 1])
    if _r["id"] in ODDS:
        _ph, _pd, _pa = ODDS[_r["id"]]
        _mk[(_r["home"], _r["season"])].append(3 * _ph + _pd)
        _mk[(_r["away"], _r["season"])].append(3 * _pa + _pd)

_S = LEAGUES[ES]
Q_TABLES = {
    # 100 Elo points of pre-season rating
    "elo": {s: centred(s, lambda t, s=s: ELO_START[(t, s)] / 100 if (t, s) in ELO_START else None) for s in _S},
    # log squad value, the season before's page (what the model's pull reads)
    "value": {s: centred(s, lambda t, s=s: math.log(VALUES[s - 1][t]) if t in VALUES.get(s - 1, {}) else None)
              for s in _S},
    # this season's xG points a match (no goals in it): the shipped trend's
    "xpts": {s: centred(s, lambda t, s=s: float(np.mean(_xp[(t, s)])) if _xp.get((t, s)) else None) for s in _S},
    # the closing market's expected points a match (it moves with results)
    "market": {s: centred(s, lambda t, s=s: float(np.mean(_mk[(t, s)])) if _mk.get((t, s)) else None) for s in _S},
}


def per_side(table: dict[int, dict[str, float]]) -> np.ndarray:
    """(n, 2) of a season -> team table for each scored match's two sides."""
    return np.array([[table.get(r["season"], {}).get(r["home"], 0.0), table.get(r["season"], {}).get(r["away"], 0.0)]
                     for r in SC])


Q = {name: per_side(table) for name, table in Q_TABLES.items()}


def own_opp(q: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    return q, q[:, ::-1]


# --- a world: the goals, and what is read off them ----------------------------

class World:
    """The matches with one set of goals (the real ones, or drawn): points,
    results and every goals-based prior."""

    def __init__(self, goals: np.ndarray):
        self.goals = goals
        g = goals[SC_IDX]
        self.pts = np.column_stack([np.where(g[:, 0] > g[:, 1], 3, np.where(g[:, 0] == g[:, 1], 1, 0)),
                                    np.where(g[:, 1] > g[:, 0], 3, np.where(g[:, 0] == g[:, 1], 1, 0))]).astype(float)
        self.y = np.where(g[:, 0] > g[:, 1], 0, np.where(g[:, 0] == g[:, 1], 1, 2))
        self.tot = self._totals()
        self._ref: dict = {}

    def _totals(self) -> dict[tuple, dict]:
        tot: dict[tuple, dict] = defaultdict(lambda: defaultdict(float))
        for k, r in enumerate(MATCHES):
            hg, ag = self.goals[k]
            for i, (team, gf, ga) in enumerate(((r["home"], hg, ag), (r["away"], ag, hg))):
                t = tot[(team, r["league"], r["season"])]
                t["n"] += 1
                t["gf"] += gf
                t["ga"] += ga
                t["xg"] += r["xg"][i]
                t["xga"] += r["xg"][1 - i]
                t["pts"] += 3 if gf > ga else 1 if gf == ga else 0
                t["xpts"] += PLAIN_ALL[k, i]
                if r["xgot"]:
                    t["xgot"] += r["xgot"][i]
                    t["xgota"] += r["xgot"][1 - i]
                    t["ga_ot"] += ga
                if r["shots"]:
                    mine = [s for s in r["shots"] if s[1] == (i == 0) and not s[4]]
                    pens = [s for s in mine if s[3] == "Penalty"]
                    t["npxg"] += r["xg"][i] - sum(s[2] for s in pens)
                    t["npgf"] += gf - sum(1 for s in pens if s[5] == "Goal")
                    t["n_sh"] += 1
        return tot

    def league_ratio(self, league: str, season: int, top: str, bottom: str) -> float | None:
        key = (league, season, top, bottom)
        if key not in self._ref:
            a = sum(t[top] for (tm, lg, s), t in self.tot.items() if lg == league and s == season)
            b = sum(t[bottom] for (tm, lg, s), t in self.tot.items() if lg == league and s == season)
            self._ref[key] = math.log(a / b) if a > 0 and b > 0 else None
        return self._ref[key]

    def rel_log(self, team: str, league: str, season: int, top: str, bottom: str) -> tuple[float, float] | None:
        """(log(top / bottom) against the division's, the bottom's size)."""
        t = self.tot.get((team, league, season))
        ref = self.league_ratio(league, season, top, bottom)
        if not t or ref is None or t[bottom] <= 0 or t[top] <= 0:
            return None
        return math.log(t[top] / t[bottom]) - ref, t[bottom]

    def prior(self, team: str, season: int, top: str = "gf", bottom: str = "xg", k: float = 0.0,
              back: int = 1, decay: float = 0.5, promoted: bool = False) -> float:
        """A club's ratio over its last `back` Eliteserien seasons (each older
        one weighted `decay` less, by size), shrunk by k units of `bottom`
        toward the division; 0 without one. `promoted`: a club up from
        OBOS-ligaen takes its ratio there (Sofascore's xG, that division's)."""
        num = den = 0.0
        for j in range(1, back + 1):
            v = self.rel_log(team, ES, season - j, top, bottom)
            if v is None:
                continue
            w = decay ** (j - 1) * v[1]
            num += w * v[0]
            den += w
        if not den and promoted:
            v = self.rel_log(team, OBOS, season - 1, top, bottom)
            if v is not None:
                num, den = v[0] * v[1], v[1]
        if not den:
            return 0.0
        return num / den * (den / (den + k) if k else 1.0)

    def prior_sides(self, **kw) -> np.ndarray:
        return np.array([[self.prior(r["home"], r["season"], **kw), self.prior(r["away"], r["season"], **kw)] for r in SC])

    def last_gap(self) -> np.ndarray:
        """Last season's points - xG points, a match (0 without one)."""
        def gap(team, season):
            t = self.tot.get((team, ES, season - 1))
            return (t["pts"] - t["xpts"]) / t["n"] if t and t["n"] else 0.0
        return np.array([[gap(r["home"], r["season"]), gap(r["away"], r["season"])] for r in SC])

    def rolling(self, n_fin: int = 20, n_keep: int = 10, league_n: int = 240) -> np.ndarray:
        """The shipped `luckChances` form before each scored match: log scale
        on (home, away) xG, finishing over the club's last n_fin matches,
        the opponent's keeping over its last n_keep, against the division's
        last league_n club matches, from n/2 matches on."""
        clubs: dict[str, list] = {}
        league: list = []

        def ratio(rows, top, bottom):
            a, b = sum(row[top] for row in rows), sum(row[bottom] for row in rows)
            return math.log(a / b) if a > 0 and b > 0 else None

        def form(team, n, top, bottom, ref):
            rows = [row for row in clubs.get(team, []) if row[3] is not None or top != 3][-n:]
            if len(rows) < n // 2 or ref is None:
                return 0.0
            mine = ratio(rows, top, bottom)
            return 0.0 if mine is None else mine - ref

        out = {}
        for k, r in enumerate(MATCHES):
            if r["league"] != ES:
                continue
            fin = ratio(league, 0, 1)
            keep = ratio([row for row in league if row[3] is not None], 3, 2)
            h, a = r["home"], r["away"]
            out[r["id"]] = (form(h, n_fin, 0, 1, fin) - form(a, n_keep, 3, 2, keep),
                            form(a, n_fin, 0, 1, fin) - form(h, n_keep, 3, 2, keep))
            hg, ag = self.goals[k]
            xo = r["xgot"]
            for team, row in ((h, [hg, r["xg"][0], ag, xo[1] if xo else None]),
                              (a, [ag, r["xg"][1], hg, xo[0] if xo else None])):
                clubs[team] = (clubs.get(team, []) + [row])[-200:]
                league.append(row)
            league = league[-league_n:]
        return np.array([out[r["id"]] for r in SC])


REAL = World(GOALS)


def null_world(rng) -> World:
    xg = np.array([r["xg"] for r in MATCHES])
    return World(np.column_stack([rng.poisson(xg[:, 0]), rng.poisson(xg[:, 1])]))


# --- scoring --------------------------------------------------------------------

def chances(log_scale: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """(points (n, 2), W/D/L probabilities (n, 3)) of the scaled chances."""
    lh, la = XGH, XGA
    if log_scale is not None:
        lh, la = XGH * np.exp(log_scale[:, 0]), XGA * np.exp(log_scale[:, 1])
    h, d, a = wdl(lh, la)
    return np.column_stack([3 * h + d, 3 * a + d]), np.column_stack([h, d, a])


def scores(w: World, pts: np.ndarray, probs: np.ndarray | None) -> tuple[np.ndarray, np.ndarray | None]:
    se = ((w.pts - pts) ** 2).sum(1)
    ll = None if probs is None else -np.log(np.clip(probs[np.arange(N), w.y], 1e-9, None))
    return se, ll


def tstat(d: np.ndarray) -> float:
    sd = d.std(ddof=1)
    return float(d.mean() / (sd / math.sqrt(len(d)))) if sd > 0 else float("nan")


def loso_grid(w: World, build, grid: list, crit: str = "ll") -> tuple[np.ndarray, np.ndarray | None, dict]:
    """Each scored season takes the grid value that does best on the other
    scored seasons. `build(value) -> (pts, probs)`."""
    cache = {}
    for g in grid:
        pts, probs = build(g)
        cache[g] = (pts, probs) + scores(w, pts, probs)
    pts = np.zeros((N, 2))
    probs = np.zeros((N, 3))
    picks = {}
    for s in SCORED:
        test = SEASON == s
        key = 3 if crit == "ll" else 2
        best = min(grid, key=lambda g: cache[g][key][~test].mean())
        picks[s] = best
        pts[test] = cache[best][0][test]
        probs[test] = cache[best][1][test]
    return pts, probs, picks


def loso_add(w: World, base_pts: np.ndarray, features: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
    """base + an additive term per side, a + sum b_k f_k, least squares on the
    per-side gap of the other scored seasons. Returns (pts, coefficients on
    all seasons)."""
    gap = (w.pts - base_pts).reshape(-1)
    X = np.column_stack([np.ones(2 * N)] + [f.reshape(-1) for f in features])
    seasons = np.repeat(SEASON, 2)
    add = np.zeros(2 * N)
    for s in SCORED:
        test = seasons == s
        beta = np.linalg.lstsq(X[~test], gap[~test], rcond=None)[0]
        add[test] = X[test] @ beta
    return base_pts + add.reshape(N, 2), np.linalg.lstsq(X, gap, rcond=None)[0]


# --- club seasons -----------------------------------------------------------------

def club_rows(w: World, pts: np.ndarray) -> dict[tuple, np.ndarray]:
    """(team, season) -> its per-match luck (points - usual), finished seasons."""
    rows: dict[tuple, list] = defaultdict(list)
    for i, r in enumerate(SC):
        if r["season"] in FINISHED:
            rows[(r["home"], r["season"])].append(w.pts[i, 0] - pts[i, 0])
            rows[(r["away"], r["season"])].append(w.pts[i, 1] - pts[i, 1])
    return {k: np.array(v) for k, v in rows.items()}


def skill_left(rows: dict[tuple, np.ndarray], boot: int = 0, seed: int = 1) -> tuple[float, float]:
    """One-way random effects on the per-match luck: the variance of the club
    seasons' mean luck beyond its noise (within variance / n), times n^2 --
    the skill in a club season's luck, points squared; bootstrap se over
    club seasons. A season's clubs share their matches, so their luck sums to
    about nothing and the spread of 16 means runs 16/15 high on noise alone;
    the variance is taken within each season and the noise scaled to match."""
    keys = sorted(rows)
    seasons = np.array([s for _, s in keys])
    means = np.array([rows[k].mean() for k in keys])
    noise = np.array([rows[k].var(ddof=1) / len(rows[k]) for k in keys])
    n2 = np.mean([len(rows[k]) for k in keys]) ** 2

    def est(idx):
        parts = []
        for s in np.unique(seasons[idx]):
            sel = idx[seasons[idx] == s]
            if len(sel) < 3:
                continue
            m = len(sel)
            parts.append((means[sel].var(ddof=1) - noise[sel].mean() * m / (m - 1), m))
        return sum(v * m for v, m in parts) / sum(m for _, m in parts) * n2

    se = 0.0
    if boot:
        rng = np.random.default_rng(seed)
        # resample clubs within each season, so each season keeps its shape
        groups = [np.flatnonzero(seasons == s) for s in np.unique(seasons)]
        se = float(np.std([est(np.concatenate([rng.choice(g, len(g)) for g in groups])) for _ in range(boot)]))
    return float(est(np.arange(len(keys)))), se


def corr(a, b) -> float:
    return float(np.corrcoef(a, b)[0, 1])


def diagnostics(rows: dict[tuple, np.ndarray], splits: int = 100, seed: int = 3) -> dict:
    keys = sorted(rows)
    luck = np.array([rows[k].sum() for k in keys])
    n = np.array([len(rows[k]) for k in keys])
    out = {"msq": float(np.mean(luck ** 2))}
    for name in ("elo", "value", "xpts"):
        q = np.array([Q_TABLES[name][s].get(t, np.nan) for t, s in keys])
        ok = ~np.isnan(q)
        out["r_" + name] = corr((luck / n)[ok], q[ok])
    rng = np.random.default_rng(seed)
    hs = []
    for _ in range(splits):
        a, b = [], []
        for k in keys:
            perm = rng.permutation(len(rows[k]))
            half = len(perm) // 2
            a.append(rows[k][perm[:half]].sum())
            b.append(rows[k][perm[half: 2 * half]].sum())
        hs.append(corr(a, b))
    out["halves"] = float(np.mean(hs))
    by = {k: luck[i] / n[i] for i, k in enumerate(keys)}
    pairs = [(v, by[(t, s + 1)]) for (t, s), v in by.items() if (t, s + 1) in by]
    out["y2y"] = corr(*zip(*pairs))
    return out


# --- methods: World -> (usual points (n, 2), W/D/L (n, 3) or None) -----------

W_GRID = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0]
B_GRID = [0.0, 0.02, 0.05, 0.08, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.7]
HOME_SIDE = np.column_stack([np.ones(N), np.zeros(N)])


def m_plain(w):
    return chances()


def m_add(*names, opp: bool = False):
    """Plain + an additive trend on the named qualities (own, and the
    opponent's too with `opp`)."""
    def run(w):
        feats = [Q[n] for n in names] + ([Q[n][:, ::-1] for n in names] if opp else [])
        return loso_add(w, chances()[0], feats)[0], None
    return run


def m_home(w):
    return loso_add(w, chances()[0], [HOME_SIDE])[0], None


def m_qscale(name: str):
    """Each side's xG times exp(b * (own - opponent's quality))."""
    q = Q[name]

    def run(w):
        pts, probs, _ = loso_grid(w, lambda b: chances(b * (q - q[:, ::-1])), B_GRID)
        return pts, probs
    return run


def m_prior(own: dict | None = None, opp: dict | None = None, sign_opp: float = -1.0, grid=W_GRID):
    """Each side's xG times exp(w * its own prior + sign * w * the opponent's),
    one weight, picked out of sample. `own`/`opp`: World.prior kwargs."""
    def run(w):
        f = w.prior_sides(**own) if own else np.zeros((N, 2))
        g = w.prior_sides(**opp)[:, ::-1] if opp else np.zeros((N, 2))
        pts, probs, _ = loso_grid(w, lambda x: chances(x * (f + sign_opp * g)), grid)
        return pts, probs
    return run


def m_prior2(own: dict, opp: dict, sign_opp: float = -1.0, grid=W_GRID):
    """Own and opponent's priors with a weight each (2-d grid)."""
    def run(w):
        f, g = w.prior_sides(**own), w.prior_sides(**opp)[:, ::-1]
        pairs = [(a, b) for a in grid for b in grid]
        pts, probs, _ = loso_grid(w, lambda ab: chances(ab[0] * f + sign_opp * ab[1] * g), pairs)
        return pts, probs
    return run


def m_last_gap(w):
    gap = w.last_gap()
    return loso_add(w, chances()[0], [gap, gap[:, ::-1]])[0], None


def m_then_trend(method, *names):
    """A method's chances, then the additive trend on the named qualities."""
    def run(w):
        pts, _ = method(w)
        return loso_add(w, pts, [Q[n] for n in names])[0], None
    return run


def m_rolling(w):
    return chances(w.rolling())


FIN = {"top": "gf", "bottom": "xg"}
METHODS = {
    "plain xG points": m_plain,
    # the trend, by what quality it reads (additive, own side)
    "trend: this season's xG pts a match (shipped's)": m_add("xpts"),
    "trend: xG pts a match, own and opponent's": m_add("xpts", opp=True),
    "trend: pre-season rating": m_add("elo"),
    "trend: pre-season rating, own and opponent's": m_add("elo", opp=True),
    "trend: squad value": m_add("value"),
    "trend: closing market's points a match": m_add("market"),
    "trend: xG pts + rating": m_add("xpts", "elo"),
    "trend: xG pts + value": m_add("xpts", "value"),
    "trend: rating + value": m_add("elo", "value"),
    "home side term": m_home,
    # the trend as a scale on the chances
    "scale: xG pts a match, own - opp": m_qscale("xpts"),
    "scale: rating, own - opp": m_qscale("elo"),
    "scale: value, own - opp": m_qscale("value"),
    # club priors from last season
    "last season's finishing (goals / xG)": m_prior(FIN),
    "  non-penalty": m_prior({"top": "npgf", "bottom": "npxg"}),
    "  shrunk, k 20 xG": m_prior({**FIN, "k": 20.0}, grid=W_GRID + [1.2, 1.5, 2.0]),
    "  shrunk, k 40 xG": m_prior({**FIN, "k": 40.0}, grid=W_GRID + [1.2, 1.5, 2.0, 2.5]),
    "  two seasons, decay 0.5": m_prior({**FIN, "back": 2}),
    "  three seasons, decay 0.7": m_prior({**FIN, "back": 3, "decay": 0.7}),
    "  promoted clubs: their OBOS-ligaen finishing": m_prior({**FIN, "promoted": True}),
    "last season's shooting (xG on target / xG)": m_prior({"top": "xgot", "bottom": "xg"}),
    "last season's keeping, opponent's (xGoT faced / conceded)": m_prior(None, {"top": "xgota", "bottom": "ga_ot"}),
    "last season's conceding, opponent's (conceded / xG against)": m_prior(None, {"top": "ga", "bottom": "xga"}, sign_opp=1.0),
    "finishing + opponent's conceding, a weight each": m_prior2(FIN, {"top": "ga", "bottom": "xga"}, sign_opp=1.0),
    "last season's gap (points - xG points), own and opp": m_last_gap,
    # the shipped rolling form, for reference
    "rolling finishing 20 + keeping 10 (shipped chances)": m_rolling,
}
def m_fixed(scale_fn):
    """Chances scaled by a fixed exp(scale_fn(world)), nothing fitted."""
    def run(w):
        return chances(scale_fn(w))
    return run


METHODS.update({
    "finishing x 0.5 (fixed weight)": m_fixed(lambda w: 0.5 * w.prior_sides(**FIN)),
    "finishing, then trend xG pts": m_then_trend(m_prior(FIN), "xpts"),
    "finishing x 0.5, then trend xG pts (proposed)": m_then_trend(m_fixed(lambda w: 0.5 * w.prior_sides(**FIN)), "xpts"),
    "finishing, then trend rating": m_then_trend(m_prior(FIN), "elo"),
    "finishing, then trend xG pts + rating": m_then_trend(m_prior(FIN), "xpts", "elo"),
    "finishing, then trend market": m_then_trend(m_prior(FIN), "market"),
    "finishing, then trend xG pts + market": m_then_trend(m_prior(FIN), "xpts", "market"),
    "rolling 20 + 10, then trend xG pts (shipped)": m_then_trend(m_rolling, "xpts"),
})


def table_per_match(results: dict) -> None:
    base_se, base_ll = scores(REAL, *results["plain xG points"])
    print(f"\nper match, Eliteserien {SCORED.start}-{SCORED.stop - 1} ({N} matches; 2026 so far), each season fitted on the"
          f" others; against the plain xG points (squared error {base_se.mean() / 2:.4f} a side, log loss"
          f" {base_ll.mean():.4f}); negative is better")
    print("| usual points | points sq error a match (t) | log loss (t) |")
    print("|---|---|---|")
    for name, (pts, probs) in results.items():
        se, ll = scores(REAL, pts, probs)
        lls = f"{(ll - base_ll).mean():+.5f} (t {tstat(ll - base_ll):+.2f})" if ll is not None else "-"
        print(f"| {name} | {(se - base_se).mean():+.5f} (t {tstat(se - base_se):+.2f}) | {lls} |")


def table_club(results: dict) -> None:
    base = skill_left(club_rows(REAL, results["plain xG points"][0]), boot=400)
    print(f"\nclub seasons {FINISHED.start}-{FINISHED.stop - 1} (80): skill left in a club season's luck (points squared,"
          f" random effects, bootstrap se); plain xG points {base[0]:.1f} (se {base[1]:.1f})")
    print("| usual points | skill left (se) | share of plain's removed | mean sq luck | r pre-season rating | r value |"
          " r xG pts | r halves | r year to year |")
    print("|---|---|---|---|---|---|---|---|---|")
    for name, (pts, _) in results.items():
        rows = club_rows(REAL, pts)
        s, se = skill_left(rows, boot=400)
        d = diagnostics(rows)
        print(f"| {name} | {s:.1f} ({se:.1f}) | {1 - s / base[0]:.0%} | {d['msq']:.1f} | {d['r_elo']:+.2f} | "
              f"{d['r_value']:+.2f} | {d['r_xpts']:+.2f} | {d['halves']:+.2f} | {d['y2y']:+.2f} |")


def table_null(names: list[str], runs: int = 20, seed: int = 2026) -> None:
    rng = np.random.default_rng(seed)
    acc = defaultdict(list)
    for _ in range(runs):
        w = null_world(rng)
        plain_pts, plain_probs = m_plain(w)
        base_se, base_ll = scores(w, plain_pts, plain_probs)
        truth = club_rows(w, plain_pts)
        keys = sorted(truth)
        true_luck = np.array([truth[k].sum() for k in keys])
        for name in names:
            pts, probs = METHODS[name](w)
            se, ll = scores(w, pts, probs)
            rows = club_rows(w, pts)
            luck = np.array([rows[k].sum() for k in keys])
            acc[name].append(((se - base_se).mean(), (ll - base_ll).mean() if ll is not None else np.nan,
                              skill_left(rows)[0], corr(luck, true_luck), np.mean(luck ** 2) - np.mean(true_luck ** 2)))
    print(f"\nno-skill world ({runs} runs; goals Poisson from the xG, so all of it is luck): what each method finds there")
    print("| usual points | points sq error vs plain | log loss vs plain | skill left | r with the true luck |"
          " mean sq luck vs true |")
    print("|---|---|---|---|---|---|")
    for name in names:
        a = np.array(acc[name])
        ll = f"{np.nanmean(a[:, 1]):+.5f}" if not np.isnan(a[:, 1]).all() else "-"
        print(f"| {name} | {a[:, 0].mean():+.5f} | {ll} | {a[:, 2].mean():+.1f} (sd {a[:, 2].std():.1f}) | "
              f"{a[:, 3].mean():+.3f} | {a[:, 4].mean():+.1f} |")


# --- shot by shot, each shot's luck weighted by what the match hung on it --------
#
# Each shot's luck is (goal - xG), worth the expected points it moves for each
# side: what the match is worth if it goes in against if it does not, at its
# minute and score. Expected points come from a Poisson clock at the match's
# own xG rates. The sum is a martingale: with xG right, it averages zero for
# any club whatever the score did, so it cannot hand a scorer's luck back to
# it, and a shot at 3-0 counts for little.

T_END = 98          # minutes on the clock: 45 + 3 of first-half stoppage + 45 + 5
D_MAX = 10
SHOT_RUNS = 30


def clock(shots: list) -> list[float]:
    """Each shot's minute on a 0..T_END clock: fotmob lumps stoppage time
    into minute 45 and 90, so those shots are spread over 3 and 6 minutes in
    their listed order."""
    n45 = sum(1 for s in shots if s[0] == 45)
    n90 = sum(1 for s in shots if s[0] >= 90)
    j45 = j90 = 0
    out = []
    for s in shots:
        m = s[0]
        if m < 45:
            out.append(float(m))
        elif m == 45:
            out.append(45 + 3 * (j45 + 0.5) / n45)
            j45 += 1
        elif m < 90:
            out.append(m + 2.0)
        else:
            out.append(92 + 6 * (j90 + 0.5) / n90)
            j90 += 1
    return out


_EP_CACHE: dict = {}


def ep_tables(lh: float, la: float, rates=None) -> tuple[np.ndarray, np.ndarray]:
    """Home and away expected points with the clock at minute t (row) and the
    home side d goals up (column d + D_MAX), goals Poisson at the match's xG
    over T_END minutes. `rates(d) -> (home, away multiplier)` for a clock
    that answers the score (kept per `rates` object)."""
    key = (round(lh, 6), round(la, 6), id(rates))
    if key not in _EP_CACHE:
        _EP_CACHE[key] = _ep_tables(lh, la, rates)
    return _EP_CACHE[key]


def _ep_tables(lh: float, la: float, rates=None) -> tuple[np.ndarray, np.ndarray]:
    d = np.arange(-D_MAX, D_MAX + 1)
    vh = np.zeros((T_END + 1, len(d)))
    va = np.zeros((T_END + 1, len(d)))
    vh[T_END] = np.where(d > 0, 3.0, np.where(d == 0, 1.0, 0.0))
    va[T_END] = np.where(d < 0, 3.0, np.where(d == 0, 1.0, 0.0))
    mh, ma = (np.ones(len(d)), np.ones(len(d))) if rates is None else rates(d)
    ph = 1 - np.exp(-lh * mh / T_END)
    pa = 1 - np.exp(-la * ma / T_END)
    up, down = ph * (1 - pa), pa * (1 - ph)
    stay = 1 - up - down
    for t in range(T_END - 1, -1, -1):
        for v in (vh, va):
            nxt = v[t + 1]
            v[t] = up * np.append(nxt[1:], nxt[-1]) + down * np.insert(nxt[:-1], 0, nxt[0]) + stay * nxt
    return vh, va


def wpa_luck(r: dict, outcomes: list[bool] | None = None, scale: tuple[float, float] = (1.0, 1.0),
             rates=None) -> tuple[float, float]:
    """(home, away) luck in points over a match's shots. `outcomes`: whether
    each shot went in (default: what happened; own goals kept as they were).
    `scale`: each side's xG multiplier (a finishing prior), on the shots and
    on the clock."""
    shots = r["shots"]
    lh, la = r["xg"][0] * scale[0], r["xg"][1] * scale[1]
    vh, va = ep_tables(lh, la, rates)
    times = clock(shots)
    d = 0
    luck = [0.0, 0.0]
    for k, (s, t) in enumerate(zip(shots, times)):
        minute, is_home, xg, situation, own, event = s
        goal = (event == "Goal") if outcomes is None else outcomes[k]
        if own:
            if not goal:
                continue
            beneficiary_home, x = not is_home, 0.0
        else:
            beneficiary_home, x = is_home, min(xg * scale[0 if is_home else 1], 0.97)
        step = 1 if beneficiary_home else -1
        ti = min(int(t), T_END - 1)
        col = min(max(d, -D_MAX + 1), D_MAX - 1) + D_MAX
        dh = vh[ti, col + step] - vh[ti, col]
        da = va[ti, col + step] - va[ti, col]
        luck[0] += (goal - x) * dh
        luck[1] += (goal - x) * da
        if goal:
            d += step
    return luck[0], luck[1]


HAS_SHOTS = np.array([bool(r["shots"]) for r in SC])


def wpa_usual(w_pts: np.ndarray, outcomes: dict | None = None, scales: np.ndarray | None = None,
              rates=None, fallback: np.ndarray | None = None) -> np.ndarray:
    """Usual points = points - the shot-by-shot luck; the plain xG points for
    a match without shots (or `fallback`)."""
    base = PLAIN if fallback is None else fallback
    out = np.array(base, dtype=float)
    for i, r in enumerate(SC):
        if not HAS_SHOTS[i]:
            continue
        sc = (1.0, 1.0) if scales is None else (math.exp(scales[i, 0]), math.exp(scales[i, 1]))
        lk = wpa_luck(r, None if outcomes is None else outcomes[r["id"]], sc, rates)
        out[i] = w_pts[i] - np.array(lk)
    return out


def state_multipliers() -> dict[int, float]:
    """xG a minute by the shooting side's lead (-2..2, capped), against its
    season's average xG a minute, pooled over Eliteserien's shots: how the
    clock should answer the score."""
    xg_in = defaultdict(float)
    expected = defaultdict(float)
    for r in MATCHES:
        if not r["shots"]:
            continue
        t = TOT_RATE[(r["home"], r["season"])], TOT_RATE[(r["away"], r["season"])]
        times = clock(r["shots"])
        d, last = 0, 0.0
        marks = []
        for s, tm in zip(r["shots"], times):
            if s[5] == "Goal":
                marks.append((tm, 1 if s[1] != s[4] else -1))
        segments = []
        for tm, step in marks + [(float(T_END), 0)]:
            segments.append((last, tm, d))
            d += step
            last = tm
        for a, b, dd in segments:
            for side, sign in ((0, 1), (1, -1)):
                key = max(-2, min(2, sign * dd))
                expected[key] += t[side] * (b - a)
        d = 0
        for s, tm in zip(r["shots"], times):
            if not s[4]:
                side_sign = 1 if s[1] else -1
                xg_in[max(-2, min(2, side_sign * d))] += s[2]
            if s[5] == "Goal":
                d += 1 if s[1] != s[4] else -1
    return {k: xg_in[k] / expected[k] for k in sorted(expected)}


TOT_RATE = {(t, s): v["xg"] / v["n"] / T_END for (t, lg, s), v in REAL.tot.items() if lg == ES}


def score_clock(mult: dict[int, float]):
    """rates(d): each side's multiplier at the home side's lead d."""
    def rates(d):
        return (np.array([mult[max(-2, min(2, int(x)))] for x in d]),
                np.array([mult[max(-2, min(2, int(-x)))] for x in d]))
    return rates


def shot_world(rng) -> tuple[World, dict]:
    """The same shots, each going in with its xG (own goals dropped), so
    the goals are all luck; a match without shots draws Poisson goals."""
    goals = np.zeros((len(MATCHES), 2), dtype=int)
    outcomes = {}
    for k, r in enumerate(MATCHES):
        if r["shots"]:
            o = [bool(rng.random() < min(s[2], 0.97)) and not s[4] for s in r["shots"]]
            outcomes[r["id"]] = o
            goals[k] = [sum(1 for s, g in zip(r["shots"], o) if g and s[1]),
                        sum(1 for s, g in zip(r["shots"], o) if g and not s[1])]
        else:
            goals[k] = [rng.poisson(r["xg"][0]), rng.poisson(r["xg"][1])]
    return World(goals), outcomes


def shots_expected(r: dict) -> tuple[float, float]:
    """Expected points from the shots one by one (Poisson-binomial), own
    goals left out: the exact usual points of the shot world."""
    dists = []
    for home in (True, False):
        dist = np.array([1.0])
        for s in r["shots"]:
            if s[1] == home and not s[4]:
                p = min(s[2], 0.97)
                dist = np.append(dist * (1 - p), 0.0) + np.insert(dist * p, 0, 0.0)
        dists.append(dist)
    h, a = dists
    below = np.concatenate([[0.0], np.cumsum(a)[:-1]])
    below = np.append(below, np.ones(max(0, len(h) - len(below))))[: len(h)]
    win = float((h * below).sum())
    m = min(len(h), len(a))
    draw = float((h[:m] * a[:m]).sum())
    return 3 * win + draw, 3 * (1 - win - draw) + draw


def shots_usual(scales: np.ndarray | None = None) -> np.ndarray:
    """Expected points from each match's shots one by one, xG scaled by
    exp(scales); plain xG points without shots."""
    out = np.array(PLAIN, dtype=float)
    for i, r in enumerate(SC):
        if HAS_SHOTS[i]:
            if scales is None:
                out[i] = shots_expected(r)
            else:
                f = (math.exp(scales[i, 0]), math.exp(scales[i, 1]))
                out[i] = shots_expected({**r, "shots": [s[:2] + (s[2] * f[0 if s[1] else 1],) + s[3:] for s in r["shots"]]})
    return out


def table_shots() -> None:
    """Shot-by-shot luck against the plain, on the real matches and in the
    shot world."""
    real_wpa = wpa_usual(REAL.pts)
    fin = REAL.prior_sides(**FIN)
    pb = shots_usual()
    variants = {
        "plain xG points": PLAIN,
        "shots one by one (Poisson-binomial)": pb,
        "shots one by one, finishing x 0.5": shots_usual(0.5 * fin),
        "shot by shot": real_wpa,
        "shot by shot, finishing x 0.5": wpa_usual(REAL.pts, scales=0.5 * fin),
    }
    variants["shots one by one, then trend xG pts"] = loso_add(REAL, pb, [Q["xpts"]])[0]
    variants["shots one by one, finishing x 0.5, then trend xG pts"] = loso_add(REAL, variants["shots one by one, finishing x 0.5"], [Q["xpts"]])[0]
    variants["shot by shot, then trend xG pts"] = loso_add(REAL, real_wpa, [Q["xpts"]])[0]
    variants["shot by shot, finishing x 0.5, then trend xG pts"] = loso_add(REAL, variants["shot by shot, finishing x 0.5"], [Q["xpts"]])[0]
    variants["plain, then trend xG pts"] = loso_add(REAL, PLAIN, [Q["xpts"]])[0]
    variants["plain, finishing x 0.5, then trend xG pts"] = loso_add(REAL, chances(0.5 * fin)[0], [Q["xpts"]])[0]
    print("\nper match, the usual points that read no result (against the plain xG points):")
    for name in ("shots one by one (Poisson-binomial)", "shots one by one, finishing x 0.5",
                 "shots one by one, then trend xG pts", "plain, then trend xG pts"):
        se, _ = scores(REAL, variants[name], None)
        base, _ = scores(REAL, PLAIN, None)
        print(f"  {name}: points sq error a match {(se - base).mean():+.5f} (t {tstat(se - base):+.2f})")
    base = skill_left(club_rows(REAL, PLAIN), boot=400)
    print(f"\nshot by shot ({int(HAS_SHOTS.sum())} of {N} scored matches have shots), club seasons"
          f" {FINISHED.start}-{FINISHED.stop - 1}")
    print("| usual points | skill left (se) | share of plain's removed | mean sq luck | r pre-season rating | r value |"
          " r xG pts | r halves | r year to year | r with plain luck |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    plain_rows = club_rows(REAL, PLAIN)
    keys = sorted(plain_rows)
    plain_luck = np.array([plain_rows[k].sum() for k in keys])
    for name, pts in variants.items():
        rows = club_rows(REAL, pts)
        s, se = skill_left(rows, boot=400)
        d = diagnostics(rows)
        luck = np.array([rows[k].sum() for k in keys])
        print(f"| {name} | {s:.1f} ({se:.1f}) | {1 - s / base[0]:.0%} | {d['msq']:.1f} | {d['r_elo']:+.2f} | "
              f"{d['r_value']:+.2f} | {d['r_xpts']:+.2f} | {d['halves']:+.2f} | {d['y2y']:+.2f} | {corr(luck, plain_luck):+.2f} |")

    rng = np.random.default_rng(99)
    acc = defaultdict(list)
    exact = pb  # the shots one by one are the exact usual points of the shot world
    for _ in range(SHOT_RUNS):
        w, outcomes = shot_world(rng)
        truth = club_rows(w, exact)
        keys = sorted(truth)
        true_luck = np.array([truth[k].sum() for k in keys])
        wfin = w.prior_sides(**FIN)
        wwpa = wpa_usual(w.pts, outcomes)
        wwfin = wpa_usual(w.pts, outcomes, scales=0.5 * wfin)
        for name, pts in (("plain xG points", PLAIN), ("shots one by one (the truth here)", exact),
                          ("shot by shot", wwpa),
                          ("shot by shot, then trend xG pts", loso_add(w, wwpa, [Q["xpts"]])[0]),
                          ("shot by shot, finishing x 0.5, then trend xG pts", loso_add(w, wwfin, [Q["xpts"]])[0]),
                          ("plain, then trend xG pts", loso_add(w, PLAIN, [Q["xpts"]])[0]),
                          ("plain, finishing x 0.5", chances(0.5 * wfin)[0])):
            rows = club_rows(w, pts)
            luck = np.array([rows[k].sum() for k in keys])
            d = diagnostics(rows, splits=20)
            acc[name].append((skill_left(rows)[0], corr(luck, true_luck), d["r_xpts"], d["r_elo"], np.mean(luck ** 2),
                              d["halves"]))
    print(f"\nshot world ({SHOT_RUNS} runs: the real shots, each in with its xG, so all of it is luck)")
    print("| usual points | skill left | r with the true luck | r xG pts | r pre-season rating | mean sq luck | r halves |")
    print("|---|---|---|---|---|---|---|")
    for name, v in acc.items():
        a = np.array(v)
        print(f"| {name} | {a[:, 0].mean():+.1f} (sd {a[:, 0].std():.1f}) | {a[:, 1].mean():+.3f} | {a[:, 2].mean():+.2f} | "
              f"{a[:, 3].mean():+.2f} | {a[:, 4].mean():.1f} | {a[:, 5].mean():+.2f} |")


def obos_check() -> None:
    """OBOS-ligaen (Sofascore xG from 2023, no shots or xG on target): the
    trend and last season's finishing, per match, 2024-2026, each season
    fitted on the other two."""
    ms = [r for r in MATCHES if r["league"] == OBOS and r["season"] >= 2024]
    n = len(ms)
    seasons = np.array([r["season"] for r in ms])
    xh, xa = np.array([r["xg"][0] for r in ms]), np.array([r["xg"][1] for r in ms])
    pts = np.array([[3 if r["hg"] > r["ag"] else 1 if r["hg"] == r["ag"] else 0,
                     3 if r["ag"] > r["hg"] else 1 if r["hg"] == r["ag"] else 0] for r in ms], dtype=float)
    y = np.array([0 if r["hg"] > r["ag"] else 1 if r["hg"] == r["ag"] else 2 for r in ms])

    def fin(team, season, leagues=(OBOS,)):
        for league in leagues:  # last season in OBOS-ligaen (or, with ES, relegated from Eliteserien)
            v = REAL.rel_log(team, league, season - 1, "gf", "xg")
            if v is not None:
                return v[0]
        return 0.0

    f = np.array([[fin(r["home"], r["season"]), fin(r["away"], r["season"])] for r in ms])
    f_down = np.array([[fin(r["home"], r["season"], (OBOS, ES)), fin(r["away"], r["season"], (OBOS, ES))] for r in ms])
    xp = defaultdict(list)
    plain = xpoints(xh, xa)
    for i, r in enumerate(ms):
        xp[(r["home"], r["season"])].append(plain[i, 0])
        xp[(r["away"], r["season"])].append(plain[i, 1])
    div = {s: np.mean([np.mean(v) for (t, ss), v in xp.items() if ss == s]) for s in set(seasons)}
    q = np.array([[np.mean(xp[(r["home"], r["season"])]) - div[r["season"]],
                   np.mean(xp[(r["away"], r["season"])]) - div[r["season"]]] for r in ms])

    def run(scale):
        h, d, a = wdl(xh * np.exp(scale[:, 0]), xa * np.exp(scale[:, 1]))
        return np.column_stack([3 * h + d, 3 * a + d]), np.column_stack([h, d, a])

    def sc(p, probs):
        se = ((pts - p) ** 2).sum(1)
        ll = None if probs is None else -np.log(np.clip(probs[np.arange(n), y], 1e-9, None))
        return se, ll

    def trend(base):
        gap = (pts - base).reshape(-1)
        X = np.column_stack([np.ones(2 * n), q.reshape(-1)])
        ss = np.repeat(seasons, 2)
        add = np.zeros(2 * n)
        for s in sorted(set(seasons)):
            test = ss == s
            add[test] = X[test] @ np.linalg.lstsq(X[~test], gap[~test], rcond=None)[0]
        return base + add.reshape(n, 2)

    base_se, base_ll = sc(*run(np.zeros((n, 2))))
    print(f"\nOBOS-ligaen 2024-2026 ({n} matches; 2026 so far), against the plain xG points (negative is better):")
    for name, (p, probs) in (("trend xG pts", (trend(plain), None)),
                             ("last season's finishing in OBOS-ligaen x 0.5", run(0.5 * f)),
                             ("last season's finishing in OBOS-ligaen x 1.0", run(1.0 * f)),
                             ("  relegated clubs bring their Eliteserien finishing, x 0.5", run(0.5 * f_down)),
                             ("  the same, x 1.0", run(1.0 * f_down)),
                             ("finishing x 0.5, then trend xG pts", (trend(run(0.5 * f)[0]), None))):
        se, ll = sc(p, probs)
        lls = f", log loss {(ll - base_ll).mean():+.5f} (t {tstat(ll - base_ll):+.2f})" if ll is not None else ""
        print(f"  {name}: points sq error a match {(se - base_se).mean():+.5f} (t {tstat(se - base_se):+.2f}){lls}")
    for league, seasons in ((ES, range(2021, 2027)), (OBOS, range(2024, 2027))):
        pairs = [(REAL.rel_log(t, league, s - 1, "gf", "xg")[0], REAL.rel_log(t, league, s, "gf", "xg")[0])
                 for (t, lg, s), v in REAL.tot.items()
                 if lg == league and s in seasons and v["n"] >= 15
                 and REAL.rel_log(t, league, s - 1, "gf", "xg") and REAL.rel_log(t, league, s, "gf", "xg")]
        print(f"  {league}: finishing year to year, same club and division, r {corr(*zip(*pairs)):+.2f} (n {len(pairs)})")


def chance_quality() -> None:
    """This season's chance quality from the shots, no goals in it: xG a shot
    (for, against) and shot share, each beside the trend on xG points."""
    st = defaultdict(lambda: [0.0, 0, 0.0, 0])  # xG for, shots for, xG against, shots against
    for r in MATCHES:
        if r["league"] != ES or not r["shots"]:
            continue
        for s in r["shots"]:
            if s[4]:
                continue
            for team, mine in ((r["home"], s[1]), (r["away"], not s[1])):
                a = st[(team, r["season"])]
                a[0 if mine else 2] += s[2]
                a[1 if mine else 3] += 1

    def table(fn):
        return per_side({s: centred(s, lambda t, s=s: fn(st[(t, s)]) if st[(t, s)][1] else None) for s in LEAGUES[ES]})

    base, _ = scores(REAL, PLAIN, None)
    trend_se, _ = scores(REAL, loso_add(REAL, PLAIN, [Q["xpts"]])[0], None)
    print("\nthis season's chance quality beside the trend on xG points (per match, against the trend alone):")
    for name, f in (("xG a shot", table(lambda a: a[0] / a[1])), ("xG a shot against", table(lambda a: a[2] / a[3])),
                    ("shot share", table(lambda a: a[1] / (a[1] + a[3])))):
        se, _ = scores(REAL, loso_add(REAL, PLAIN, [Q["xpts"], f])[0], None)
        print(f"  {name}: points sq error a match {(se - trend_se).mean():+.5f} (t {tstat(se - trend_se):+.2f})")


def finishing_weights() -> None:
    """Last season's finishing at fixed weights (every season scored), and
    the trend with each club's xG points a match from its other matches only
    (nothing of the match itself in it)."""
    fin = REAL.prior_sides(**FIN)
    base_se, base_ll = scores(REAL, *chances())
    print("\nlast season's finishing at a fixed weight, per match against the plain xG points:")
    for x in (0.1, 0.25, 0.5, 0.7, 1.0):
        se, ll = scores(REAL, *chances(x * fin))
        print(f"  w {x}: points sq error {(se - base_se).mean():+.5f} (t {tstat(se - base_se):+.2f}),"
              f" log loss {(ll - base_ll).mean():+.5f} (t {tstat(ll - base_ll):+.2f})")
    sums = defaultdict(lambda: [0.0, 0])
    for i, r in enumerate(SC):
        for j, team in ((0, r["home"]), (1, r["away"])):
            sums[(team, r["season"])][0] += PLAIN[i, j]
            sums[(team, r["season"])][1] += 1
    div = {s: np.mean([a / n for (t, ss), (a, n) in sums.items() if ss == s]) for s in SCORED}
    other = np.array([[(sums[(t, r["season"])][0] - PLAIN[i, j]) / (sums[(t, r["season"])][1] - 1) - div[r["season"]]
                       for j, t in ((0, r["home"]), (1, r["away"]))] for i, r in enumerate(SC)])
    se, _ = scores(REAL, loso_add(REAL, PLAIN, [other])[0], None)
    print(f"  the trend on xG points a match from the club's other matches only: points sq error"
          f" {(se - base_se).mean():+.5f} (t {tstat(se - base_se):+.2f})")


def notable() -> None:
    """The luckiest and unluckiest club seasons by points - xG points, under
    each luck."""
    names = {}
    for s in LEAGUES[ES]:
        for m in json.load(open(f"data/normalized/{ES}_{s}_matches.json", encoding="utf-8")):
            names[m["home_id"]], names[m["away_id"]] = m["home"], m["away"]
    fin = REAL.prior_sides(**FIN)
    methods = {
        "the trend alone": loso_add(REAL, PLAIN, [Q["xpts"]])[0],
        "shipped": METHODS["rolling 20 + 10, then trend xG pts (shipped)"](REAL)[0],
        "proposed": loso_add(REAL, chances(0.5 * fin)[0], [Q["xpts"]])[0],
        "shot by shot + finishing + trend": loso_add(REAL, wpa_usual(REAL.pts, scales=0.5 * fin), [Q["xpts"]])[0],
    }
    rows = {k: club_rows(REAL, v) for k, v in methods.items()}
    plain = club_rows(REAL, PLAIN)
    keys = sorted(plain, key=lambda k: -plain[k].sum())
    print("\n| club season | points - xG points | " + " | ".join(methods) + " |")
    print("|---|---|" + "---|" * len(methods))
    for k in keys[:6] + keys[-4:]:
        print(f"| {names[k[0]]} {k[1]} | {plain[k].sum():+.1f} | " + " | ".join(f"{rows[m][k].sum():+.1f}" for m in methods) + " |")


def champion_luck(runs: int = 40, seed: int = 5) -> None:
    """How lucky the club that finishes first is when there is no skill at
    all (the shot world), against the real champions under each luck."""
    def champion(w: World, s: int) -> tuple[str, int]:
        table = defaultdict(float)
        for i in np.flatnonzero(SEASON == s):
            table[SC[i]["home"]] += w.pts[i, 0]
            table[SC[i]["away"]] += w.pts[i, 1]
        return max(table, key=table.get), s

    rng = np.random.default_rng(seed)
    pb = shots_usual()
    lucks = []
    for _ in range(runs):
        w, _ = shot_world(rng)
        rows = club_rows(w, pb)
        lucks.extend(rows[champion(w, s)].sum() for s in FINISHED)
    fin = REAL.prior_sides(**FIN)
    methods = {
        "points - xG points": PLAIN,
        "plain, then trend xG pts": loso_add(REAL, PLAIN, [Q["xpts"]])[0],
        "rolling 20 + 10, then trend (shipped)": METHODS["rolling 20 + 10, then trend xG pts (shipped)"](REAL)[0],
        "finishing x 0.5, then trend (proposed)": loso_add(REAL, chances(0.5 * fin)[0], [Q["xpts"]])[0],
        "shot by shot, finishing x 0.5, then trend": loso_add(REAL, wpa_usual(REAL.pts, scales=0.5 * fin), [Q["xpts"]])[0],
    }
    champions = [champion(REAL, s) for s in FINISHED]
    print(f"\na champion's luck: in the shot world (no skill, {runs} runs x {len(FINISHED)} seasons) the club that finishes"
          f" first is {np.mean(lucks):+.1f} (sd {np.std(lucks):.1f}) above its usual points; the real champions"
          f" {FINISHED.start}-{FINISHED.stop - 1}, on average:")
    for name, pts in methods.items():
        rows = club_rows(REAL, pts)
        print(f"  {name}: {np.mean([rows[k].sum() for k in champions]):+.1f}")


def main() -> None:
    print(f"Eliteserien matches with xG: {sum(1 for r in MATCHES if r['league'] == ES)}; scored {N}; "
          f"OBOS-ligaen with xG: {sum(1 for r in MATCHES if r['league'] == OBOS)}")
    results = {name: fn(REAL) for name, fn in METHODS.items()}
    table_per_match(results)
    table_club(results)
    table_null(list(METHODS))
    table_shots()
    m = state_multipliers()
    print("\nxG a minute by the shooting side's lead (-2..2), against its season's average: "
          + ", ".join(f"{k:+d}: {v:.3f}" for k, v in m.items()))
    rates = score_clock(m)
    fin = REAL.prior_sides(**FIN)
    for name, pts in (("shot by shot, a clock that answers the score", wpa_usual(REAL.pts, rates=rates)),
                      ("  with finishing x 0.5, then trend xG pts",
                       loso_add(REAL, wpa_usual(REAL.pts, scales=0.5 * fin, rates=rates), [Q["xpts"]])[0])):
        rows = club_rows(REAL, pts)
        s, se = skill_left(rows, boot=400)
        d = diagnostics(rows)
        print(f"  {name}: skill left {s:.1f} ({se:.1f}), mean sq luck {d['msq']:.1f}, r xG pts {d['r_xpts']:+.2f},"
              f" r halves {d['halves']:+.2f}, r year to year {d['y2y']:+.2f}")
    obos_check()
    chance_quality()
    finishing_weights()
    notable()
    champion_luck()


if __name__ == "__main__":
    main()
