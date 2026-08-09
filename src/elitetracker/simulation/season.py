"""Monte Carlo simulation of the remaining season.

Every unplayed match is sampled from its win/draw/loss probabilities, points are
accumulated on top of the live table, and the resulting order is recorded. Doing
that many times gives each team a distribution over finishing positions.

Runs use a seeded random number generator, so the same inputs and seed always
produce the same matrix. No network access is involved.

Two deliberate simplifications in elo-v1, both documented rather than hidden:

* Ratings are held fixed for the rest of the season. A team does not get
  stronger inside a simulation by winning simulated matches.
* Simulated matches yield points but not scorelines, so goal difference cannot
  move. Ties are broken on goal difference *as it stands today*, which is a
  reasonable proxy but will slightly favour teams already ahead on it.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from elitetracker.model.elo import EloConfig
from elitetracker.model.probabilities import match_probabilities
from elitetracker.model.table import TableRow, ranking_key, table_from_matches
from elitetracker.normalize.matches import Match
from elitetracker.normalize.standings import POINTS_FOR_DRAW, POINTS_FOR_WIN

DEFAULT_SIMULATIONS = 10_000
DEFAULT_SEED = 20260809


@dataclass(frozen=True)
class SimulationConfig:
    simulations: int = DEFAULT_SIMULATIONS
    seed: int = DEFAULT_SEED

    def __post_init__(self) -> None:
        if self.simulations < 1:
            raise ValueError(f"simulations must be at least 1, got {self.simulations}")


@dataclass
class TeamProjection:
    team_id: str
    team: str
    rating: float
    current_position: int
    current_points: int
    current_goal_difference: int
    played: int
    # position_probabilities[0] is the chance of finishing 1st.
    position_probabilities: list[float]
    expected_points: float

    def probability_of_position(self, position: int) -> float:
        return self.position_probabilities[position - 1]

    def probability_within(self, best: int, worst: int) -> float:
        """Chance of finishing between `best` and `worst` inclusive (1-indexed)."""
        return sum(self.position_probabilities[best - 1 : worst])


@dataclass
class SeasonProjection:
    teams: list[TeamProjection]
    simulations: int
    seed: int
    matches_remaining: int
    matches_played: int


def _fixture_odds(
    matches: list[Match], ratings: dict[str, float], config: EloConfig
) -> list[tuple[str, str, float, float]]:
    """Precompute (home, away, P(home), P(home)+P(draw)) for each unplayed match.

    Probabilities do not change between simulations, so they are computed once
    and reused; only the sampling happens in the hot loop.
    """
    odds = []
    for match in matches:
        if match.played:
            continue
        home_id = match.home_id or match.home
        away_id = match.away_id or match.away
        probabilities = match_probabilities(ratings[home_id], ratings[away_id], config)
        odds.append(
            (home_id, away_id, probabilities.home_win, probabilities.home_win + probabilities.draw)
        )
    return odds


def simulate_season(
    matches: list[Match],
    ratings: dict[str, float],
    *,
    config: SimulationConfig | None = None,
    elo_config: EloConfig | None = None,
) -> SeasonProjection:
    config = config or SimulationConfig()
    elo_config = elo_config or EloConfig()

    current: list[TableRow] = table_from_matches(matches)
    positions = {row.team_id: index + 1 for index, row in enumerate(current)}
    by_id = {row.team_id: row for row in current}
    team_ids = list(by_id)

    missing = [team_id for team_id in team_ids if team_id not in ratings]
    if missing:
        raise KeyError(f"no rating for {missing}")

    odds = _fixture_odds(matches, ratings, elo_config)
    base_points = {team_id: row.points for team_id, row in by_id.items()}
    # Frozen tiebreaks: simulated matches do not produce goals.
    tiebreak = {
        team_id: (-row.goal_difference, -row.goals_for, row.team) for team_id, row in by_id.items()
    }

    counts = {team_id: [0] * len(team_ids) for team_id in team_ids}
    points_total = {team_id: 0 for team_id in team_ids}

    rng = random.Random(config.seed)
    random_value = rng.random  # bound once; this is the hot path

    for _ in range(config.simulations):
        points = dict(base_points)
        for home_id, away_id, home_chance, home_or_draw_chance in odds:
            roll = random_value()
            if roll < home_chance:
                points[home_id] += POINTS_FOR_WIN
            elif roll < home_or_draw_chance:
                points[home_id] += POINTS_FOR_DRAW
                points[away_id] += POINTS_FOR_DRAW
            else:
                points[away_id] += POINTS_FOR_WIN

        order = sorted(team_ids, key=lambda team_id: (-points[team_id], *tiebreak[team_id]))
        for index, team_id in enumerate(order):
            counts[team_id][index] += 1
            points_total[team_id] += points[team_id]

    simulations = config.simulations
    projections = [
        TeamProjection(
            team_id=team_id,
            team=by_id[team_id].team,
            rating=ratings[team_id],
            current_position=positions[team_id],
            current_points=by_id[team_id].points,
            current_goal_difference=by_id[team_id].goal_difference,
            played=by_id[team_id].played,
            position_probabilities=[count / simulations for count in counts[team_id]],
            expected_points=points_total[team_id] / simulations,
        )
        for team_id in team_ids
    ]
    projections.sort(key=lambda projection: (-projection.expected_points, projection.team))

    return SeasonProjection(
        teams=projections,
        simulations=simulations,
        seed=config.seed,
        matches_remaining=len(odds),
        matches_played=sum(1 for match in matches if match.played),
    )
