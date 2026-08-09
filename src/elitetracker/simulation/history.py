"""Re-run the projection as it stood at each point in the season.

Snapshots are taken **by date, not by round**. Rounds are not played in
chronological order: Eliteserien 2026 has round 12 scheduled after rounds 13-16
have already been played, and matches inside a single round can be spread over
weeks for cup and European commitments. Indexing on rounds would put those
snapshots in the wrong order and claim knowledge that did not exist yet.

For a given date we rewind: any match played after it is treated as unplayed,
ratings are replayed over what was actually known on the day, and the rest of
the season is simulated from there.

Rewinding marks later matches unplayed rather than dropping them, so every
snapshot still simulates a full fixture list and the distributions stay
comparable across dates.

The first snapshot is pre-season: nothing played, ratings straight from the
2025 tables. It shows what the seeding alone predicted.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date, timedelta

from elitetracker.model.elo import EloConfig
from elitetracker.model.initial_ratings import TeamRating
from elitetracker.model.ratings import build_rating_table
from elitetracker.normalize.matches import Match
from elitetracker.simulation.season import DEFAULT_SEED, SimulationConfig, simulate_season


@dataclass(frozen=True)
class HistoryConfig:
    # Fewer runs than the headline projection: this is a trend line, and it is
    # computed once per snapshot rather than once per season.
    simulations: int = 4_000
    seed: int = DEFAULT_SEED
    # Cap the number of snapshots so a long season cannot blow up start-up time.
    max_snapshots: int = 20

    def __post_init__(self) -> None:
        if self.simulations < 1:
            raise ValueError(f"simulations must be at least 1, got {self.simulations}")
        if self.max_snapshots < 2:
            raise ValueError(f"max_snapshots must be at least 2, got {self.max_snapshots}")


@dataclass
class HistorySnapshot:
    date: str  # ISO YYYY-MM-DD; the state at the end of this day
    matches_played: int
    # The furthest round with any match played by this date. Informational
    # only -- rounds are not chronological, so nothing is ordered by it.
    latest_round: int | None
    # team id -> probability of finishing in each position, index 0 = 1st.
    positions: dict[str, list[float]]
    ratings: dict[str, float]


def as_of_date(matches: list[Match], on: str) -> list[Match]:
    """The fixture list as it looked at the end of `on` (ISO YYYY-MM-DD).

    ISO dates compare correctly as strings, which is the reason the normalizer
    stores them that way.
    """
    rewound = []
    for match in matches:
        if match.played and match.date > on:
            rewound.append(replace(match, home_goals=None, away_goals=None, played=False))
        else:
            rewound.append(match)
    return rewound


def snapshot_dates(matches: list[Match], max_snapshots: int) -> list[str]:
    """Dates worth sampling: pre-season, then match days, thinned to the cap."""
    played_dates = sorted({match.date for match in matches if match.played})
    if not played_dates:
        return []

    # Pre-season is the day before the first match was played, so the first
    # snapshot genuinely knows nothing about this season.
    preseason = (date.fromisoformat(played_dates[0]) - timedelta(days=1)).isoformat()

    candidates = [preseason, *played_dates]
    if len(candidates) <= max_snapshots:
        return candidates

    # Thin evenly, but never drop the first or last.
    step = (len(candidates) - 1) / (max_snapshots - 1)
    picked = sorted({candidates[round(index * step)] for index in range(max_snapshots)})
    if picked[-1] != candidates[-1]:
        picked.append(candidates[-1])
    return picked


def _latest_round(matches: list[Match], on: str) -> int | None:
    rounds = [
        match.round
        for match in matches
        if match.played and match.round is not None and match.date <= on
    ]
    return max(rounds) if rounds else None


def build_history(
    league_matches: list[Match],
    all_matches: list[Match],
    seeds: dict[str, TeamRating],
    *,
    elo_config: EloConfig | None = None,
    config: HistoryConfig | None = None,
) -> list[HistorySnapshot]:
    """One snapshot per sampled date, oldest first.

    `all_matches` spans both divisions so ratings stay on one scale; only
    `league_matches` is simulated.
    """
    elo_config = elo_config or EloConfig()
    config = config or HistoryConfig()

    snapshots = []
    for on in snapshot_dates(league_matches, config.max_snapshots):
        rewound_all = as_of_date(all_matches, on)
        rewound_league = as_of_date(league_matches, on)

        ratings = build_rating_table(seeds, rewound_all, config=elo_config)
        projection = simulate_season(
            rewound_league,
            ratings.ratings,
            config=SimulationConfig(simulations=config.simulations, seed=config.seed),
            elo_config=elo_config,
        )
        snapshots.append(
            HistorySnapshot(
                date=on,
                matches_played=projection.matches_played,
                latest_round=_latest_round(league_matches, on),
                positions={team.team_id: team.position_probabilities for team in projection.teams},
                ratings={team.team_id: ratings.ratings[team.team_id] for team in projection.teams},
            )
        )
    return snapshots
