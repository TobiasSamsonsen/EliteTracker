"""Online attack and defence ratings on the log-goals scale.

Each club carries an attack strength and a defence strength. A fixture's
expected goals are

    home: exp(base + home_advantage + attack[home] - defence[away])
    away: exp(base                  + attack[away] - defence[home])

and after the match each rating moves by a step proportional to the goals
the side scored above or below expectation: the scorer's attack and the
conceder's defence move together, the way a Poisson regression's gradient
does. That is Elo's idea applied to goals instead of results, with two
numbers per club instead of one, so a club that scores freely and concedes
freely is described as exactly that.

Where fotmob has expected goals (Eliteserien from 2020) the observed goals
are blended with xG, so a lucky win moves the ratings less than a deserved
one -- and because xG is the less noisy signal, those matches earn a bigger
step. A season boundary pulls every rating toward its own division's mean, as
the Elo replay does.

Scorelines come from the two rates through a Poisson grid with Dixon and
Coles' low-score correction. The grid's own win/draw/loss odds are blended
50/50 with the Elo odds for the shipped outcome probabilities: measured
walk-forward on Eliteserien 2021-2026 the blend beats Elo alone by 0.75-0.87
pp of log loss (t -3.6 to -3.8); OBOS-ligaen, without xG, is unchanged
(PROJECT_STATUS.md).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from elitetracker.model.career import SeasonSlice, team_ids
from elitetracker.model.probabilities import AWAY_WIN, DRAW, HOME_WIN, MatchProbabilities
from elitetracker.normalize.matches import Match

GOAL_CAP = 8  # P(9+) is under 1e-4 at Norwegian scoring rates; the grid is renormalised
OUTCOME_BLEND = 0.5  # weight on the Elo odds when the two models' outcome odds are blended


@dataclass(frozen=True)
class ADConfig:
    # Fitted walk-forward on 2016-2026 (PROJECT_STATUS.md, "attack/defence"):
    # the step is the one knob that matters; everything else is flat around
    # these values.
    k: float = 0.015             # rating step per goal of surprise
    home: float = 0.22           # home advantage in log goals (exp(0.22) = 1.25x)
    base: float = 0.37           # log of the average goals per side (exp(0.37) = 1.45)
    cap: float = 4.0             # the largest surprise one match may carry, in goals
    season_regression: float = 0.88
    division_gap: float = 0.25   # OBOS clubs start this far below in both ratings
    newcomer: float = 0.15       # a club with no history starts this far below its division
    rho: float = -0.05           # Dixon-Coles low-score correction
    alpha: float = 0.75          # weight on the shot-based signal where fotmob has it
    signal: str = "xg"           # "xg" or "xgot" (xG on target measured worse)
    k_shots: float | None = 0.05 # step for xG-backed matches: a cleaner signal earns a bigger move


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


def blend_outcomes(elo: MatchProbabilities, grid: list[list[float]], weight: float = OUTCOME_BLEND) -> MatchProbabilities:
    """The shipped outcome odds: a geometric blend of the Elo odds and the grid's own."""
    own = outcome_probabilities(grid)
    raw = [e ** weight * g ** (1.0 - weight) for e, g in zip((elo.home_win, elo.draw, elo.away_win), (own.home_win, own.draw, own.away_win))]
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
    attack: dict[str, float] = field(default_factory=dict)
    defence: dict[str, float] = field(default_factory=dict)
    season: int | None = None

    @classmethod
    def from_slices(cls, slices: list[SeasonSlice], config: ADConfig | None = None, shots=None) -> "AttackDefence":
        divisions = {(s.season, t): s.league for s in slices for m in s.matches for t in team_ids(m)}
        return cls(config=config or ADConfig(), divisions=divisions, shots=dict(shots or {}))

    def replay(self, matches: list[Match]) -> "AttackDefence":
        """Apply every played match in kickoff order; returns self."""
        for match in sorted((m for m in matches if m.played), key=Match.sort_key):
            self.observe(match)
        return self

    def copy(self) -> "AttackDefence":
        """An independent state to replay a different continuation from."""
        return AttackDefence(self.config, self.divisions, self.shots, dict(self.attack), dict(self.defence), self.season)

    def rates_against_average(self, team_id: str, league: str, season: int) -> tuple[float, float]:
        """Goals for and against per match a club would expect against an average
        side of `league`, at a neutral ground -- the readable form of its ratings."""
        cfg = self.config
        peers = [t for (year, t), lg in self.divisions.items() if year == season and lg == league and t in self.attack]
        mean_attack = sum(self.attack[t] for t in peers) / len(peers) if peers else 0.0
        mean_defence = sum(self.defence[t] for t in peers) / len(peers) if peers else 0.0
        scored = math.exp(cfg.base + self.attack.get(team_id, mean_attack) - mean_defence)
        conceded = math.exp(cfg.base + mean_attack - self.defence.get(team_id, mean_defence))
        return scored, conceded

    # -- seasons ---------------------------------------------------------
    def _start_season(self, season: int) -> None:
        cfg = self.config
        active: dict[str, list[str]] = {}
        for (year, team), league in self.divisions.items():
            if year == season:
                active.setdefault(league, []).append(team)
        first = self.season is None
        self.season = season
        for league, teams in active.items():
            known = [t for t in teams if t in self.attack]
            if known and not first and cfg.season_regression < 1.0:
                for ratings in (self.attack, self.defence):
                    mean = sum(ratings[t] for t in known) / len(known)
                    for t in known:
                        ratings[t] = mean + cfg.season_regression * (ratings[t] - mean)
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

    def start_season(self, season: int) -> None:
        """Apply the offseason pull and place newcomers, once, for `season`."""
        if season != self.season:
            self._start_season(season)

    def _ensure(self, on: str, *teams: str) -> None:
        self.start_season(int(on[:4]))
        for t in teams:
            self.attack.setdefault(t, 0.0)
            self.defence.setdefault(t, 0.0)

    # -- prediction ------------------------------------------------------
    def rates(self, home_id: str, away_id: str, on: str) -> tuple[float, float]:
        self._ensure(on, home_id, away_id)
        cfg = self.config
        lam = math.exp(cfg.base + cfg.home + self.attack[home_id] - self.defence[away_id])
        mu = math.exp(cfg.base + self.attack[away_id] - self.defence[home_id])
        return lam, mu

    def grid(self, home_id: str, away_id: str, on: str) -> list[list[float]]:
        lam, mu = self.rates(home_id, away_id, on)
        return score_grid(lam, mu, self.config.rho)

    def predict(self, home_id: str, away_id: str, on: str) -> MatchProbabilities:
        return outcome_probabilities(self.grid(home_id, away_id, on))

    # -- learning --------------------------------------------------------
    def observed(self, match: Match) -> tuple[float, float, float]:
        """(home, away, step): goals blended with the shot-based signal where
        there is one, and the step that observation earns."""
        goals = (float(match.home_goals), float(match.away_goals))
        shots = self.shots.get(match.match_id)
        cfg = self.config
        if not shots or cfg.alpha == 0.0:
            return goals[0], goals[1], cfg.k
        signal = shots[2:4] if cfg.signal == "xgot" and len(shots) == 4 else shots[0:2]
        a = cfg.alpha
        return (1 - a) * goals[0] + a * signal[0], (1 - a) * goals[1] + a * signal[1], cfg.k_shots or cfg.k

    def observe(self, match: Match) -> None:
        home, away = team_ids(match)
        lam, mu = self.rates(home, away, match.date)
        obs_home, obs_away, k = self.observed(match)
        cfg = self.config
        home_surprise = max(-cfg.cap, min(cfg.cap, obs_home - lam))
        away_surprise = max(-cfg.cap, min(cfg.cap, obs_away - mu))
        self.attack[home] += k * home_surprise
        self.defence[away] -= k * home_surprise
        self.attack[away] += k * away_surprise
        self.defence[home] -= k * away_surprise
