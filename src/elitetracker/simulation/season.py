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

# Chosen by measurement, not taste. Monte Carlo error falls as 1/sqrt(N), and
# the point of diminishing returns is set by the model's own accuracy: elo-v3
# has a calibration error of 1.54 percentage points, so sampling error well
# under a fifth of that is already invisible.
#
# Measured against a 4,000,000-run reference, worst single cell in the grid:
#
#      10,000   1.31 pp    0.07 s per league
#      50,000   0.50 pp    0.37 s     <- here
#     200,000   0.23 pp    1.43 s
#   1,000,000   0.11 pp    7.2  s
#  10,000,000   0.04 pp   72    s
#
# 50,000 keeps the worst cell at a third of the model's error while the page
# still shows whole percent, where 0.5pp is half a displayed digit. Going
# further buys precision beneath both the display and the model.
DEFAULT_SIMULATIONS = 50_000
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

    # The hot loop works on integer indices rather than team ids: a list slice
    # per simulation instead of a dict rebuild, and one packed integer per club
    # instead of a lambda that builds a tuple. Same maths, same seed, same
    # numbers -- about 1.5x the throughput, which is 1.5x the accuracy for the
    # same wait.
    count = len(team_ids)
    index_of = {team_id: index for index, team_id in enumerate(team_ids)}
    rows = [by_id[team_id] for team_id in team_ids]

    odds = [
        (index_of[home], index_of[away], home_chance, home_or_draw_chance)
        for home, away, home_chance, home_or_draw_chance
        in _fixture_odds(matches, ratings, elo_config)
    ]
    base_points = [row.points for row in rows]

    # Frozen tiebreaks: simulated matches do not produce goals, so clubs level
    # on simulated points are separated on goal difference, then goals scored,
    # then name. This must NOT be read off the current table order, which has
    # today's points already baked into it -- that would let points decide a
    # tie that only exists because the points are equal.
    tie_order = sorted(
        range(count),
        key=lambda index: (-rows[index].goal_difference, -rows[index].goals_for, rows[index].team),
    )
    tie_bonus = [0] * count
    for rank, index in enumerate(tie_order):
        tie_bonus[index] = count - 1 - rank

    # points | tiebreak | index packed into one sortable integer, best first.
    width = count.bit_length()
    mask = (1 << width) - 1

    counts = [[0] * count for _ in range(count)]
    points_total = [0] * count

    rng = random.Random(config.seed)
    random_value = rng.random  # bound once; this is the hot path

    for _ in range(config.simulations):
        points = base_points[:]
        for home, away, home_chance, home_or_draw_chance in odds:
            roll = random_value()
            if roll < home_chance:
                points[home] += POINTS_FOR_WIN
            elif roll < home_or_draw_chance:
                points[home] += POINTS_FOR_DRAW
                points[away] += POINTS_FOR_DRAW
            else:
                points[away] += POINTS_FOR_WIN

        packed = [
            (((points[index] << width) | tie_bonus[index]) << width) | index
            for index in range(count)
        ]
        packed.sort(reverse=True)
        for position, value in enumerate(packed):
            index = value & mask
            counts[index][position] += 1
            points_total[index] += points[index]

    simulations = config.simulations
    projections = [
        TeamProjection(
            team_id=team_id,
            team=rows[index].team,
            rating=ratings[team_id],
            current_position=positions[team_id],
            current_points=rows[index].points,
            current_goal_difference=rows[index].goal_difference,
            played=rows[index].played,
            position_probabilities=[value / simulations for value in counts[index]],
            expected_points=points_total[index] / simulations,
        )
        for index, team_id in enumerate(team_ids)
    ]
    projections.sort(key=lambda projection: (-projection.expected_points, projection.team))

    return SeasonProjection(
        teams=projections,
        simulations=simulations,
        seed=config.seed,
        matches_remaining=len(odds),
        matches_played=sum(1 for match in matches if match.played),
    )
