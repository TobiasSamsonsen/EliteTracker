"""Walk-forward harness for the IMPROVEMENTS.md model sweep (October 2026).

One replay that mirrors `career.replay` + `backtest.walk_forward` (Elo) and the
attack/defence loop in `research.cmd_run`, with hooks where each candidate
changes something. `identity()` checks that the hooks at their defaults
reproduce the shipped model to the bit before any number counts.

Everything reads local files only (data/normalized, data/xg.json, data/raw);
nothing here touches the network.

Scoring: per-match log loss, Brier and RPS over home/draw/away, paired against
the shipped model on exactly the same matches; `oos()` picks a candidate's value
walk-forward (each season scored with the value that did best on the seasons
before it) -- the ship rule of elo-v12.0.

The model comes from `src`, so the numbers in out/ were measured against
elo-v12.2, which `src` was when they ran. elo-v13.0 changed the defaults
underneath (xG margin, implied score, value pull, early step), so to reproduce
out/ exactly put a worktree of commit ed7b2b0's `src` first on PYTHONPATH.
`verify_src.py` checks elo-v13.0 against the bundle built from these hooks.
Likewise keeping.py, keeping_rolling.py, fcdk*.py and sweep2021*.py measured
against elo-v13.0 (commit 9b6d720's `src`); elo-v14.0 is their final
candidate, so on its `src` their "shipped" baseline is elo-v14.0 itself.
recalibration.py, own_level.py, division_value_gap.py and value_crossers.py
measured against elo-v14.0 (commit b813a07's `src`); value_crossers.py's
relegated-clubs variant is elo-v15.0, which the replay below now carries.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Callable

import numpy as np

from elitetracker.model.attack_defence import ADConfig, AttackDefence, OUTCOME_BLEND, score_grid
from elitetracker.model.career import relegated_values, team_ids
from elitetracker.model.elo import (
    EloConfig, actual_score, effective_home_advantage, era_config, expected_score, xg_implied_score,
)
from elitetracker.model.initial_ratings import rating_for_unseeded_team
from elitetracker.model.probabilities import match_probabilities
from elitetracker.normalize.matches import Match
from elitetracker.normalize.surfaces import surface_edge
from elitetracker.pipeline import load_slices, market_values, seed_ratings, shot_table

SLICES = load_slices()
SEEDS = {team_id: seed.rating for team_id, seed in seed_ratings().items()}
SHOTS = shot_table()
VALUES = market_values()
PLAYED: list[tuple[Match, str, int]] = sorted(
    ((m, s.league, s.season) for s in SLICES for m in s.matches if m.played),
    key=lambda row: Match.sort_key(row[0]),
)
IDS = [m.match_id for m, _, _ in PLAYED]
INDEX = {mid: i for i, mid in enumerate(IDS)}
LEAGUE = np.array([lg for _, lg, _ in PLAYED])
SEASON = np.array([s for _, _, s in PLAYED])
DATE = np.array([m.date for m, _, _ in PLAYED])
HG = np.array([m.home_goals for m, _, _ in PLAYED])
AG = np.array([m.away_goals for m, _, _ in PLAYED])
Y = np.where(HG > AG, 0, np.where(HG == AG, 1, 2))
HAS_XG = np.array([m.match_id in SHOTS for m, _, _ in PLAYED])


# ---------------------------------------------------------------- Elo ----

def shipped_score(hg, ag, hxg, axg, cfg: EloConfig) -> float:
    """`elo.updated_pair`'s observation, verbatim (elo-v13.0; elo-v12.2's form
    is `score_with(margin="shipped")` in elo_update.py)."""
    scored = actual_score(hg, ag)
    if hxg is not None and axg is not None and cfg.xg_alpha > 0.0:
        scored = (1.0 - cfg.xg_alpha) * scored + cfg.xg_alpha * xg_implied_score(hxg, axg)
        if cfg.xg_margin:
            c = cfg.xg_margin_smoothing
            ratio = math.log((hxg + c) / (axg + c))
            bonus = math.copysign(cfg.xg_margin * math.log(1.0 + abs(ratio)), ratio)
            scored = min(1.0, max(0.0, scored + bonus))
    return scored


@dataclass
class EloRun:
    """Hooks, all optional. Defaults reproduce the shipped Elo replay."""
    score: Callable = shipped_score
    config_for: Callable[[str, int], EloConfig] = lambda league, season: era_config(season)
    shots: dict = field(default_factory=lambda: SHOTS)
    # (match, league, season, ctx) -> multiplier on K for this match
    k_mult: Callable | None = None
    # (match, league, season, ctx) -> Elo points added to the home side (predict and update)
    home_shift: Callable | None = None
    # False: the shift moves the prediction only, the rating update ignores it
    shift_in_update: bool = True
    # The shipped surface edge on Eliteserien predictions (elo-v13.0)
    surface: bool = True
    # (season, league, ids, ratings) -> {team: target} for the offseason pull
    target: Callable | None = None
    # team -> starting rating for a club with none (default: the ladder floor)
    newcomer: Callable | None = None
    # (season, ratings) called after the offseason pull, before newcomers are placed
    offseason: Callable | None = None


def elo_run(run: EloRun | None = None, gaps: np.ndarray | None = None) -> np.ndarray:
    """Pre-match Elo odds (n x 3) for every played match, kickoff order.
    `gaps`, when given, is filled with MatchProbabilities.rating_gap."""
    run = run or EloRun()
    ratings = dict(SEEDS)
    out = np.zeros((len(PLAYED), 3))
    seasons = sorted({s for _, _, s in PLAYED} | {sl.season for sl in SLICES})
    ctx = Context()
    previous: dict[str, str] = {}
    for season in seasons:
        in_season = [sl for sl in SLICES if sl.season == season]
        active: dict[str, str] = {}
        for sl in in_season:
            for m in sl.matches:
                for t in team_ids(m):
                    active[t] = sl.league
        if season != seasons[0]:
            by_league: dict[str, list[str]] = {}
            for t, lg in active.items():
                if t in ratings:
                    by_league.setdefault(lg, []).append(t)
            for lg, ids in by_league.items():
                cfg = run.config_for(lg, season)
                regression = cfg.season_regression
                if regression >= 1.0:
                    continue
                mean = sum(ratings[t] for t in ids) / len(ids)
                targets = run.target(season, lg, ids, ratings) if run.target else None
                # elo-v15.0: clubs relegated into OBOS-ligaen, placed by squad value.
                down = relegated_values(lg, ids, previous, VALUES.get(season - 1, {}))
                for t in ids:
                    if t in down:
                        goal = mean + cfg.relegated_value_pull * down[t]
                        ratings[t] = goal + cfg.relegated_regression * (ratings[t] - goal)
                        continue
                    goal = targets.get(t, mean) if targets else mean
                    ratings[t] = goal + regression * (ratings[t] - goal)
            if run.offseason:
                run.offseason(season, ratings)
        previous = active
        for sl in in_season:
            for m in sl.matches:
                for t in team_ids(m):
                    if t not in ratings:
                        ratings[t] = run.newcomer(t, season, sl.league) if run.newcomer else rating_for_unseeded_team()
        ctx.new_season(season)
        for i in np.nonzero(SEASON == season)[0]:
            m, lg, _ = PLAYED[i]
            home, away = team_ids(m)
            cfg = run.config_for(lg, season)
            shift = run.home_shift(m, lg, season, ctx) if run.home_shift else 0.0
            h, a = ratings[home] + shift, ratings[away]
            edge = surface_edge(home, away, m.date) if run.surface and lg == "eliteserien" else 0.0
            p = match_probabilities(h + edge, a, cfg)
            out[i] = (p.home_win, p.draw, p.away_win)
            if gaps is not None:
                gaps[i] = p.rating_gap
            xg = run.shots.get(m.match_id)
            hxg = xg[0] if xg and len(xg) >= 2 else None
            axg = xg[1] if xg and len(xg) >= 2 else None
            hu = h if run.shift_in_update else ratings[home]
            expected = expected_score(hu + effective_home_advantage(cfg, hu, a), a)
            scored = run.score(m.home_goals, m.away_goals, hxg, axg, cfg)
            k = cfg.k_factor * (run.k_mult(m, lg, season, ctx) if run.k_mult else 1.0)
            change = k * (scored - expected)
            ratings[home] += change
            ratings[away] -= change
            ctx.played(m)
    return out


class Context:
    """Per-season state a hook may read: matches played and last match date."""

    def __init__(self):
        self.count: dict[str, int] = {}
        self.last: dict[str, str] = {}
        self.season = None

    def new_season(self, season):
        self.season = season
        self.count = {}

    def played(self, m: Match):
        for t in team_ids(m):
            self.count[t] = self.count.get(t, 0) + 1
            self.last[t] = m.date


# ------------------------------------------------------ attack/defence ----

class ADX(AttackDefence):
    """AttackDefence with hooks; with none set it is the shipped model."""

    # (self, match) -> (home_obs, away_obs, k) replacing `observed`
    observed_hook: Callable | None = None
    # (self, home, away, on) -> (lam, mu) replacing `_learning_rates`
    learn_hook: Callable | None = None
    # (self, season) called after the shipped `_start_season`
    season_hook: Callable | None = None
    # (self, home, away, on, lam, mu) -> (lam, mu) applied after `rates`
    rates_hook: Callable | None = None
    # (self, team, match) -> multiplier on the step for that team's ratings
    k_hook: Callable | None = None

    def observed(self, match):
        if self.observed_hook:
            return self.observed_hook(self, match)
        return super().observed(match)

    def _learning_rates(self, home_id, away_id, on):
        if self.learn_hook:
            self._ensure(on, home_id, away_id)
            return self.learn_hook(self, home_id, away_id, on)
        return super()._learning_rates(home_id, away_id, on)

    def _start_season(self, season):
        super()._start_season(season)
        if self.season_hook:
            self.season_hook(self, season)

    def rates(self, home_id, away_id, on, elo_gap=0.0):
        lam, mu = super().rates(home_id, away_id, on, elo_gap=elo_gap)
        if self.rates_hook:
            lam, mu = self.rates_hook(self, home_id, away_id, on, lam, mu)
        return lam, mu

    def observe(self, match):
        if not self.k_hook:
            return super().observe(match)
        home, away = team_ids(match)
        lam, mu = self._learning_rates(home, away, match.date)
        obs_home, obs_away, k = self.observed(match)
        cfg = self.config
        hs = max(-cfg.cap, min(cfg.cap, obs_home - lam))
        as_ = max(-cfg.cap, min(cfg.cap, obs_away - mu))
        kh, ka = k * self.k_hook(self, home, match), k * self.k_hook(self, away, match)
        self.attack[home] += kh * hs
        self.defence[away] -= ka * hs
        self.attack[away] += ka * as_
        self.defence[home] -= kh * as_
        if cfg.finishing_regression < 1.0:
            shots = self.shots.get(match.match_id)
            if shots:
                self._season_goals[home] = self._season_goals.get(home, 0.0) + match.home_goals
                self._season_xg[home] = self._season_xg.get(home, 0.0) + shots[0]
                self._season_goals[away] = self._season_goals.get(away, 0.0) + match.away_goals
                self._season_xg[away] = self._season_xg.get(away, 0.0) + shots[1]
        self._record_keeping(match)


@dataclass
class ADOut:
    probs: np.ndarray       # n x 3 grid outcome odds
    lam: np.ndarray
    mu: np.ndarray
    exact: np.ndarray       # p(observed scoreline) under the grid
    over: np.ndarray        # p(total goals >= 3) under the grid


def ad_run(config: ADConfig | None = None, shots: dict | None = None, elo_gap: np.ndarray | None = None,
           after_observe: Callable | None = None, values: dict | None = None, cls: type = None, **hooks) -> ADOut:
    """`cls`, a subclass of ADX, replaces the goals model's class."""
    ad = (cls or ADX).from_slices(SLICES, config or ADConfig(), shots=SHOTS if shots is None else shots,
                         values=market_values() if values is None else values)
    for name, hook in hooks.items():
        setattr(ad, name, hook)
    n = len(PLAYED)
    probs, lam_a, mu_a, exact, over = np.zeros((n, 3)), np.zeros(n), np.zeros(n), np.zeros(n), np.zeros(n)
    for i, (m, _, _) in enumerate(PLAYED):
        home, away = team_ids(m)
        gap = float(elo_gap[i]) if elo_gap is not None else 0.0
        lam, mu = ad.rates(home, away, m.date, elo_gap=gap)
        grid = np.array(score_grid(lam, mu, ad.config.rho))
        probs[i] = (np.tril(grid, -1).sum(), np.trace(grid), np.triu(grid, 1).sum())
        lam_a[i], mu_a[i] = lam, mu
        cap = grid.shape[0] - 1
        exact[i] = grid[min(m.home_goals, cap), min(m.away_goals, cap)]
        idx = np.add.outer(np.arange(cap + 1), np.arange(cap + 1))
        over[i] = grid[idx >= 3].sum()
        ad.observe(m)
        if after_observe:
            after_observe(ad, m)
    return ADOut(probs, lam_a, mu_a, exact, over)


def blend(elo: np.ndarray, grid: np.ndarray, w: float | np.ndarray = OUTCOME_BLEND) -> np.ndarray:
    w = np.asarray(w, dtype=float)
    if w.ndim == 1:
        w = w[:, None]
    raw = elo ** w * grid ** (1.0 - w)
    return raw / raw.sum(axis=1, keepdims=True)


# ------------------------------------------------------------ scoring ----

def losses(p: np.ndarray, y: np.ndarray = Y) -> dict[str, np.ndarray]:
    p = np.clip(p, 1e-12, 1.0)
    n = len(y)
    onehot = np.zeros_like(p)
    onehot[np.arange(n), y] = 1.0
    ll = -np.log(p[np.arange(n), y])
    brier = ((p - onehot) ** 2).sum(axis=1)
    c = np.cumsum(p, axis=1)[:, :2]
    co = np.cumsum(onehot, axis=1)[:, :2]
    rps = ((c - co) ** 2).sum(axis=1) / 2.0
    return {"ll": ll, "brier": brier, "rps": rps}


def ece(p: np.ndarray, y: np.ndarray = Y) -> float:
    """`Scorecard.calibration_error`: 10 buckets over all three outcomes."""
    onehot = np.zeros_like(p)
    onehot[np.arange(len(y)), y] = 1.0
    b = np.minimum(9, (p * 10).astype(int)).ravel()
    pv, ov = p.ravel(), onehot.ravel()
    gap = sum(abs(pv[b == k].sum() - ov[b == k].sum()) for k in range(10))
    return gap / len(pv)


def tstat(d: np.ndarray) -> float:
    if len(d) < 2 or d.std(ddof=1) == 0:
        return 0.0
    return d.mean() / (d.std(ddof=1) / math.sqrt(len(d)))


def mask(seasons=(2016, 2100), league: str | None = None, xg: bool | None = None) -> np.ndarray:
    keep = (SEASON >= seasons[0]) & (SEASON <= seasons[1])
    if league:
        keep &= LEAGUE == league
    if xg is not None:
        keep &= HAS_XG == xg
    return keep


WINDOWS = {
    "all16": mask(),
    "es16": mask(league="eliteserien"),
    "ob16": mask(league="obosligaen"),
    "xg": mask(xg=True),
}


def compare(var: np.ndarray, base: np.ndarray, keep: np.ndarray) -> dict:
    lv, lb = losses(var[keep], Y[keep]), losses(base[keep], Y[keep])
    order = np.argsort(DATE[keep], kind="stable")
    half = len(order) // 2
    out = {"n": int(keep.sum())}
    for metric in ("ll", "brier", "rps"):
        d = lv[metric] - lb[metric]
        out[metric] = (d.mean(), tstat(d))
        out[metric + "_halves"] = (tstat(d[order[:half]]), tstat(d[order[half:]]))
        out[metric + "_hmeans"] = (d[order[:half]].mean(), d[order[half:]].mean())
    out["ece"] = (ece(var[keep], Y[keep]), ece(base[keep], Y[keep]))
    return out


def line(name: str, var: np.ndarray, base: np.ndarray, keep: np.ndarray) -> str:
    c = compare(var, base, keep)
    h = c["ll_halves"]
    return (f"{name:<34} n={c['n']:<5} LL {c['ll'][0]:+.5f} (t {c['ll'][1]:+5.2f})  "
            f"Br {c['brier'][0]:+.5f} (t {c['brier'][1]:+5.2f})  RPS {c['rps'][0]:+.5f} (t {c['rps'][1]:+5.2f})  "
            f"halves t {h[0]:+5.2f}/{h[1]:+5.2f}  ece {c['ece'][0]:.4f}/{c['ece'][1]:.4f}")


def report(name: str, var: np.ndarray, base: np.ndarray, windows=("all16", "es16", "ob16", "xg")) -> None:
    for w in windows:
        print(line(f"{name} [{w}]", var, base, WINDOWS[w]))


def oos(variants: dict, base_key, first: int = 2019, select_from: int = 2016,
        restrict: np.ndarray | None = None) -> tuple[np.ndarray, dict[int, object]]:
    """Each season from `first` scored with the variant that had the lowest log
    loss on seasons [select_from, season) -- chosen from prior seasons only.
    Seasons before `first` keep the base. `restrict` limits the selection
    window (e.g. to xG matches), never the scoring."""
    base = variants[base_key]
    out = base.copy()
    picks = {}
    sel = np.ones(len(Y), bool) if restrict is None else restrict
    lls = {k: losses(v)["ll"] for k, v in variants.items()}
    for season in sorted(set(SEASON.tolist())):
        if season < first:
            continue
        window = (SEASON >= select_from) & (SEASON < season) & sel
        if not window.any():  # nothing to choose on yet: keep the base
            picks[season] = base_key
            continue
        best = min(variants, key=lambda k: (lls[k][window].mean(), k != base_key))
        picks[season] = best
        rows = SEASON == season
        out[rows] = variants[best][rows]
    return out, picks


def oos_report(name: str, variants: dict, base_key, first: int = 2019, restrict=None,
               windows=("all16", "xg")) -> tuple[np.ndarray, dict]:
    chosen, picks = oos(variants, base_key, first=first, restrict=restrict)
    print(f"{name} OOS picks: " + " ".join(f"{s}:{p}" for s, p in picks.items()))
    for w in windows:
        keep = WINDOWS[w] & (SEASON >= first)
        print(line(f"{name} OOS [{w} {first}+]", chosen, variants[base_key], keep))
    return chosen, picks


# ----------------------------------------------------------- identity ----

def shipped() -> tuple[np.ndarray, ADOut, np.ndarray]:
    elo = elo_run()
    ad = ad_run()
    return elo, ad, blend(elo, ad.probs)


def identity() -> None:
    """The harness at its defaults must be the shipped model, to the bit."""
    from elitetracker.model.attack_defence import blend_outcomes
    from elitetracker.model.backtest import walk_forward

    elo, ad, mix = shipped()
    card = walk_forward(SLICES, SEEDS, EloConfig(), score_from_season=2015, shots=SHOTS, values=VALUES)
    worst = max(abs(np.array([p.home_win, p.draw, p.away_win]) - elo[INDEX[mid]]).max()
                for mid, (p, _) in card.predictions.items())
    assert len(card.predictions) == len(IDS), (len(card.predictions), len(IDS))
    real = AttackDefence.from_slices(SLICES, ADConfig(), shots=SHOTS, values=market_values())
    worst_mix = 0.0
    from elitetracker.model.probabilities import MatchProbabilities
    for i, (m, _, _) in enumerate(PLAYED):
        home, away = team_ids(m)
        p = blend_outcomes(MatchProbabilities(*elo[i]), real.grid(home, away, m.date))
        worst_mix = max(worst_mix, abs(np.array([p.home_win, p.draw, p.away_win]) - mix[i]).max())
        real.observe(m)
    print(f"identity: elo max diff {worst:.2e}, blend max diff {worst_mix:.2e} over {len(IDS)} matches")
    assert worst < 1e-12 and worst_mix < 1e-12


def summary(name: str, p: np.ndarray, keep: np.ndarray) -> str:
    l = losses(p[keep], Y[keep])
    return (f"{name:<28} n={int(keep.sum()):<5} LL {l['ll'].mean():.5f}  Brier {l['brier'].mean():.5f}  "
            f"RPS {l['rps'].mean():.5f}  ECE {ece(p[keep], Y[keep]):.4f}")


if __name__ == "__main__":
    import time
    t0 = time.time()
    identity()
    print(f"{time.time() - t0:.1f}s")
    elo, ad, mix = shipped()
    for w, keep in WINDOWS.items():
        print(summary(f"elo [{w}]", elo, keep))
        print(summary(f"grid [{w}]", ad.probs, keep))
        print(summary(f"shipped blend [{w}]", mix, keep))
