"""Online attack, defence and finishing ratings on the log-goals scale.

Each club carries three ratings:

    attack   -- ability to create chances (updated via the blended signal)
    defence  -- ability to prevent chances (updated via the blended signal)
    finishing -- conversion quality: season-level log(total goals / total xG),
                 carried forward with regression, not updated match-by-match

A fixture's expected goals are

    home: exp(base + home_advantage + attack[home] - defence[away] + finishing[home])
    away: exp(base                  + attack[away] - defence[home] + finishing[away])

After the match, attack and defence move by a step proportional to the
observed signal above or below expectation: the scorer's attack and the
conceder's defence move together, the way a Poisson regression's gradient
does.  That is Elo's idea applied to goals instead of results, with two
numbers per club instead of one, so a club that scores freely and concedes
freely is described as exactly that.

Where fotmob has expected goals (Eliteserien from 2020) the observed goals
are blended with xG, so a lucky win moves the ratings less than a deserved
one -- and because xG is the less noisy signal, those matches earn a bigger
step.  Finishing quality is computed at the season level: each team's
cumulative log(goals / xG) over the full season is stored and carried into
the next season with regression, avoiding the noise of match-level updates.

Two season-start corrections (elo-v13.0): the offseason pull aims at the
division mean shifted by the club's squad market value from the season
before, and a club's first matches of a season take a bigger step.

Scorelines come from the three rates through a Poisson grid with Dixon and
Coles' low-score correction.  The grid's own win/draw/loss odds are blended
75/25 with the Elo odds for the shipped outcome probabilities.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from elitetracker.model.career import SeasonSlice, team_ids
from elitetracker.model.probabilities import AWAY_WIN, DRAW, HOME_WIN, MatchProbabilities
from elitetracker.normalize.matches import Match

GOAL_CAP = 8  # P(9+) is under 1e-4 at Norwegian scoring rates; the grid is renormalised
OUTCOME_BLEND = 0.25  # weight on the Elo odds when the two models' outcome odds are blended


@dataclass(frozen=True)
class ADConfig:
    # Fitted walk-forward on 2016-2026 (PROJECT_STATUS.md, "attack/defence"):
    # the step is the one knob that matters; everything else is flat around
    # these values.
    k: float = 0.015             # rating step per goal of surprise
    home: float = 0.22           # home advantage in log goals (exp(0.22) = 1.25x)
    # When > 0, the AD home term scales with the Elo rating gap, matching
    # the Elo home advantage's gap-scaling.  effective_home = home * (1 + home_beta * gap).
    home_beta: float = 0.0       # 0.0 reproduces the constant
    base: float = 0.37           # log of the average goals per side (exp(0.37) = 1.45)
    cap: float = 4.0             # the largest surprise one match may carry, in goals
    season_regression: float = 0.88
    division_gap: float = 0.25   # OBOS clubs start this far below in both ratings
    newcomer: float = 0.15       # a club with no history starts this far below its division
    rho: float = -0.05           # Dixon-Coles low-score correction
    alpha: float = 0.75          # weight on the shot-based signal where fotmob has it
    signal: str = "xg"           # "xg" or "xgot" (xG on target measured worse)
    k_shots: float | None = 0.05 # step for xG-backed matches: a cleaner signal earns a bigger move
    # Season-level finishing quality.  Regressed toward 0 at each offseason.
    # Fitted walk-forward: reg=0.70 gives -0.00039 log loss vs no finishing (t=-1.04).
    finishing_regression: float = 0.70
    # Gap-dependent blend sharpening.  When > 0, the Elo weight in the
    # outcome blend shrinks as the rating gap grows (more grid weight for
    # heavy favourites).  weight = clamp(OUTCOME_BLEND - gamma * |gap|, 0.05, 0.50).
    blend_gamma: float = 0.0      # 0.0 reproduces the constant
    # The fixed-step online update lags, so the ratings sit too close together
    # and the grid under-prices favourites (priced 0.60-0.70 at home, they win
    # 0.72). At prediction time each side's attack - defence + finishing is
    # stretched by `spread`. Chosen walk-forward (every season 2019-2026 picked
    # 1.10 from prior seasons, grid capped there): -0.0011 log loss out of sample
    # (t -3.0), Brier t -2.6, RPS t -2.3, negative in both halves. 1.0 is elo-v11.
    spread: float = 1.10
    # The offseason pull aims at the division mean shifted by value_pull * v,
    # v = log(squad value / the division's geometric mean) from Transfermarkt's
    # page for the season before (set before the season starts, so no
    # hindsight); clubs without one (up from the third tier) keep the plain
    # mean. Walk-forward over 0.05-0.3: -0.00127 log loss out of sample
    # (t -2.84), Brier t -2.74, RPS t -2.62, both halves negative; nearly all of
    # it in OBOS-ligaen seasons without xG (Eliteserien +0.0004). The pick sits
    # at 0.3-0.4; 0.2 is the shrunk value. 0.0 is elo-v12. The same pull on the
    # Elo ratings added nothing on top (-0.0003, t -1.7, null on xG matches).
    value_pull: float = 0.2
    # A club's n-th match of a season steps by k * (1 + early_boost *
    # exp(-n / early_tau)), so its ratings catch up with a winter of transfers
    # sooner. Walk-forward over 0.2-1.0 x 3-5 matches: -0.0008 (t -1.5), Brier
    # and RPS negative, both halves; on top of value_pull -0.0004 (t -1.8).
    # Shipped at half the pick (1.0). 0.0 is elo-v12.
    early_boost: float = 0.5
    early_tau: float = 3.0


def tau(home_goals: int, away_goals: int, lam: float, mu: float, rho: float) -> float:
    if home_goals == 0 and away_goals == 0:
        return 1.0 - lam * mu * rho
    if home_goals == 0 and away_goals == 1:
        return 1.0 + lam * rho
    if home_goals == 1 and away_goals == 0:
        return 1.0 + mu * rho
    if home_goals == 1 and away_goals == 1:
        return 1.0 - rho
    return 1.0


def score_grid(lam: float, mu: float, rho: float, cap: int = GOAL_CAP) -> list[list[float]]:
    """P(home scores i, away scores j) for i, j in 0..cap, renormalised."""
    p_home = [math.exp(-lam) * lam ** i / math.factorial(i) for i in range(cap + 1)]
    p_away = [math.exp(-mu) * mu ** j / math.factorial(j) for j in range(cap + 1)]
    grid = [[p_home[i] * p_away[j] * max(tau(i, j, lam, mu, rho), 0.0) for j in range(cap + 1)] for i in range(cap + 1)]
    total = sum(map(sum, grid))
    return [[value / total for value in row] for row in grid]


def outcome_probabilities(grid: list[list[float]]) -> MatchProbabilities:
    home = sum(grid[i][j] for i in range(len(grid)) for j in range(i))
    draw = sum(grid[i][i] for i in range(len(grid)))
    return MatchProbabilities(home_win=home, draw=draw, away_win=1.0 - home - draw)


def gap_blend_weight(gap: float, gamma: float, base: float = OUTCOME_BLEND) -> float:
    """Blend weight (on Elo odds) that shrinks toward the grid as the gap grows.

    When gamma is 0.0 this returns the constant base weight.  When positive,
    heavy-favourite matches get more grid weight, which is where the model's
    under-confidence concentrates.
    """
    if gamma == 0.0:
        return base
    return max(0.05, min(0.50, base - gamma * abs(gap)))


def blend_outcomes(elo: MatchProbabilities, grid: list[list[float]], weight: float | None = None) -> MatchProbabilities:
    """The shipped outcome odds: a geometric blend of the Elo odds and the grid's own."""
    own = outcome_probabilities(grid)
    w = weight if weight is not None else OUTCOME_BLEND
    raw = [e ** w * g ** (1.0 - w) for e, g in zip((elo.home_win, elo.draw, elo.away_win), (own.home_win, own.draw, own.away_win))]
    total = sum(raw)
    return MatchProbabilities(*(value / total for value in raw))


def _outcome(home_goals: int, away_goals: int) -> str:
    return HOME_WIN if home_goals > away_goals else DRAW if home_goals == away_goals else AWAY_WIN


def conditional_scorelines(grid: list[list[float]], odds: MatchProbabilities) -> dict[tuple[int, int], float]:
    """P(scoreline) with who-wins taken from `odds` and how-many from the grid.

    Each outcome's cells are rescaled so they sum to that outcome's odds, so
    the scoreline distribution agrees with the rating-implied result odds
    exactly and the goals model only decides the margin and the total.
    """
    own = outcome_probabilities(grid)
    scale = {o: (odds.of(o) / own.of(o) if own.of(o) > 0 else 0.0) for o in (HOME_WIN, DRAW, AWAY_WIN)}
    return {
        (i, j): grid[i][j] * scale[_outcome(i, j)]
        for i in range(len(grid)) for j in range(len(grid))
    }


def top_scorelines(grid: list[list[float]], odds: MatchProbabilities, n: int = 5) -> list[tuple[tuple[int, int], float]]:
    return sorted(conditional_scorelines(grid, odds).items(), key=lambda cell: cell[1], reverse=True)[:n]


@dataclass
class AttackDefence:
    """The live model: feed it matches in kickoff order, ask it about fixtures."""

    config: ADConfig = field(default_factory=ADConfig)
    # (season, team_id) -> league slug, for the offseason pull toward the division mean.
    divisions: dict[tuple[int, str], str] = field(default_factory=dict)
    # match_id -> (home_xg, away_xg, home_xgot, away_xgot) where fotmob has shot data.
    shots: dict[str, tuple[float, ...]] = field(default_factory=dict)
    # season -> team_id -> Transfermarkt squad value (EUR), for `value_pull`.
    values: dict[int, dict[str, float]] = field(default_factory=dict)
    attack: dict[str, float] = field(default_factory=dict)
    defence: dict[str, float] = field(default_factory=dict)
    # Season-level finishing: log(total goals / total xG) per team, carried across seasons.
    finishing: dict[str, float] = field(default_factory=dict)
    # Per-season accumulators for computing finishing at the season boundary.
    _season_goals: dict[str, float] = field(default_factory=dict)
    _season_xg: dict[str, float] = field(default_factory=dict)
    season: int | None = None
    # Matches each club has played this season, for `early_boost`.
    _played: dict[str, int] = field(default_factory=dict)

    @classmethod
    def from_slices(cls, slices: list[SeasonSlice], config: ADConfig | None = None, shots=None,
                    values=None) -> "AttackDefence":
        divisions = {(s.season, t): s.league for s in slices for m in s.matches for t in team_ids(m)}
        return cls(config=config or ADConfig(), divisions=divisions, shots=dict(shots or {}),
                   values=dict(values or {}))

    def replay(self, matches: list[Match]) -> "AttackDefence":
        """Apply every played match in kickoff order; returns self."""
        for match in sorted((m for m in matches if m.played), key=Match.sort_key):
            self.observe(match)
        return self

    def copy(self) -> "AttackDefence":
        """An independent state to replay a different continuation from."""
        return AttackDefence(
            config=self.config, divisions=self.divisions, shots=self.shots, values=self.values,
            attack=dict(self.attack), defence=dict(self.defence), finishing=dict(self.finishing),
            _season_goals=dict(self._season_goals), _season_xg=dict(self._season_xg),
            season=self.season, _played=dict(self._played),
        )

    def rates_against_average(self, team_id: str, league: str, season: int) -> tuple[float, float]:
        """Goals for and against per match a club would expect against an average
        side of `league`, at a neutral ground -- the readable form of its ratings."""
        cfg = self.config
        peers = [t for (year, t), lg in self.divisions.items() if year == season and lg == league and t in self.attack]
        mean_attack = sum(self.attack[t] for t in peers) / len(peers) if peers else 0.0
        mean_defence = sum(self.defence[t] for t in peers) / len(peers) if peers else 0.0
        scored = math.exp(cfg.base + cfg.spread * (self.attack.get(team_id, mean_attack) - mean_defence
                                                   + self.finishing.get(team_id, 0.0)))
        conceded = math.exp(cfg.base + cfg.spread * (mean_attack - self.defence.get(team_id, mean_defence)))
        return scored, conceded

    # -- seasons ---------------------------------------------------------
    def _start_season(self, season: int) -> None:
        cfg = self.config
        active: dict[str, list[str]] = {}
        for (year, team), league in self.divisions.items():
            if year == season:
                active.setdefault(league, []).append(team)
        prev_season = self.season
        first = prev_season is None
        self.season = season
        self._played = {}

        # Compute season-level finishing from the previous season's accumulators.
        # Skip when finishing_regression >= 1.0 (disabled — the elo-v8 baseline).
        if prev_season is not None and self._season_xg and cfg.finishing_regression < 1.0:
            for team in list(self._season_goals):
                total_goals = self._season_goals[team]
                total_xg = self._season_xg[team]
                if total_xg > 0 and total_goals > 0:
                    self.finishing[team] = math.log(total_goals / total_xg)
            self._season_goals.clear()
            self._season_xg.clear()

        for league, teams in active.items():
            known = [t for t in teams if t in self.attack]
            if known and not first and cfg.season_regression < 1.0:
                for ratings in (self.attack, self.defence):
                    mean = sum(ratings[t] for t in known) / len(known)
                    for t in known:
                        ratings[t] = mean + cfg.season_regression * (ratings[t] - mean)
                # Finishing regresses toward 0 (log-space average = 1.0x multiplier).
                fin_known = [t for t in teams if t in self.finishing]
                if fin_known:
                    mean_f = sum(self.finishing[t] for t in fin_known) / len(fin_known)
                    for t in fin_known:
                        self.finishing[t] = mean_f + cfg.finishing_regression * (self.finishing[t] - mean_f)
            # Newcomers: below their division; in the first season the division
            # itself is placed, since nothing has been learned yet.
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
            if known and not first and cfg.value_pull:
                self._pull_toward_value(season, teams)

    def _pull_toward_value(self, season: int, teams: list[str]) -> None:
        """Move the pull's target by `value_pull` * relative squad value. Each
        club with last season's value is shifted by (1 - regression) *
        value_pull * v after the pull toward the mean, which is the same as
        pulling it toward mean + value_pull * v in the first place."""
        cfg = self.config
        page = self.values.get(season - 1, {})
        logs = {t: math.log(page[t]) for t in teams if page.get(t) and t in self.attack}
        if not logs:
            return
        mean = sum(logs.values()) / len(logs)
        for t, value in logs.items():
            shift = (1.0 - cfg.season_regression) * cfg.value_pull * (value - mean)
            self.attack[t] += shift
            self.defence[t] += shift

    def start_season(self, season: int) -> None:
        """Apply the offseason pull and place newcomers, once, for `season`."""
        if season != self.season:
            self._start_season(season)

    def _ensure(self, on: str, *teams: str) -> None:
        self.start_season(int(on[:4]))
        for t in teams:
            self.attack.setdefault(t, 0.0)
            self.defence.setdefault(t, 0.0)
            self.finishing.setdefault(t, 0.0)

    # -- prediction ------------------------------------------------------
    def rates(self, home_id: str, away_id: str, on: str, elo_gap: float = 0.0) -> tuple[float, float]:
        self._ensure(on, home_id, away_id)
        cfg = self.config
        effective_home = cfg.home * (1.0 + cfg.home_beta * elo_gap)
        lam = math.exp(cfg.base + effective_home + cfg.spread * (
            self.attack[home_id] - self.defence[away_id] + self.finishing.get(home_id, 0.0)))
        mu = math.exp(cfg.base + cfg.spread * (
            self.attack[away_id] - self.defence[home_id] + self.finishing.get(away_id, 0.0)))
        return lam, mu

    def _learning_rates(self, home_id: str, away_id: str, on: str) -> tuple[float, float]:
        """The rates the online update measures surprise against: unstretched,
        so `spread` changes predictions and never what the ratings learn."""
        self._ensure(on, home_id, away_id)
        cfg = self.config
        lam = math.exp(cfg.base + cfg.home + self.attack[home_id] - self.defence[away_id]
                        + self.finishing.get(home_id, 0.0))
        mu = math.exp(cfg.base + self.attack[away_id] - self.defence[home_id]
                       + self.finishing.get(away_id, 0.0))
        return lam, mu

    def grid(self, home_id: str, away_id: str, on: str, elo_gap: float = 0.0) -> list[list[float]]:
        lam, mu = self.rates(home_id, away_id, on, elo_gap=elo_gap)
        return score_grid(lam, mu, self.config.rho)

    def predict(self, home_id: str, away_id: str, on: str, elo_gap: float = 0.0) -> MatchProbabilities:
        return outcome_probabilities(self.grid(home_id, away_id, on, elo_gap=elo_gap))

    # -- learning --------------------------------------------------------
    def observed(self, match: Match) -> tuple[float, float, float]:
        """(home, away, step): goals blended with the shot-based signal where
        there is one, and the step that observation earns."""
        goals = (float(match.home_goals), float(match.away_goals))
        shots = self.shots.get(match.match_id)
        cfg = self.config
        if not shots or cfg.alpha == 0.0:
            return goals[0], goals[1], cfg.k
        signal = shots[2:4] if cfg.signal == "xgot" and len(shots) >= 4 else shots[0:2]
        a = cfg.alpha
        return (1 - a) * goals[0] + a * signal[0], (1 - a) * goals[1] + a * signal[1], cfg.k_shots or cfg.k

    def _early(self, team_id: str) -> float:
        cfg = self.config
        if not cfg.early_boost:
            return 1.0
        return 1.0 + cfg.early_boost * math.exp(-self._played.get(team_id, 0) / cfg.early_tau)

    def observe(self, match: Match) -> None:
        home, away = team_ids(match)
        lam, mu = self._learning_rates(home, away, match.date)
        obs_home, obs_away, k = self.observed(match)
        cfg = self.config
        home_surprise = max(-cfg.cap, min(cfg.cap, obs_home - lam))
        away_surprise = max(-cfg.cap, min(cfg.cap, obs_away - mu))
        # Each club's own two ratings take its own step (see `early_boost`).
        k_home, k_away = k * self._early(home), k * self._early(away)
        self.attack[home] += k_home * home_surprise
        self.defence[away] -= k_away * home_surprise
        self.attack[away] += k_away * away_surprise
        self.defence[home] -= k_home * away_surprise
        self._played[home] = self._played.get(home, 0) + 1
        self._played[away] = self._played.get(away, 0) + 1
        # Accumulate season-level goals and xG for finishing calculation.
        if cfg.finishing_regression < 1.0:
            shots = self.shots.get(match.match_id)
            if shots and match.home_goals is not None and match.away_goals is not None:
                home_xg, away_xg = shots[0], shots[1]
                self._season_goals[home] = self._season_goals.get(home, 0.0) + match.home_goals
                self._season_xg[home] = self._season_xg.get(home, 0.0) + home_xg
                self._season_goals[away] = self._season_goals.get(away, 0.0) + match.away_goals
                self._season_xg[away] = self._season_xg.get(away, 0.0) + away_xg
