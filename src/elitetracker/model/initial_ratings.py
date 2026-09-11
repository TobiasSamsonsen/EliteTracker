"""Deterministic starting ratings from the seed season's final tables.

Both divisions are placed on one ladder. An OBOS-ligaen finish is treated as
`division_offset` places worse than the same finish in Eliteserien, which is
what lets a promoted champion outrank a relegated Eliteserien side. The ladder
is then mapped linearly onto the target range, so the top of Eliteserien sits at
1670 and the bottom of OBOS-ligaen at 1330.

With the default offset of 14 and 16-team divisions:

    Eliteserien  1st  -> rank  1 -> 1670
    Eliteserien 16th  -> rank 16 -> 1494
    OBOS-ligaen  1st  -> rank 15 -> 1506
    OBOS-ligaen 16th  -> rank 30 -> 1330
"""

from __future__ import annotations

from dataclasses import dataclass

from elitetracker.normalize.standings import Standing


@dataclass(frozen=True)
class SeedingConfig:
    best_rating: float = 1670.0
    worst_rating: float = 1330.0
    # How many places worse an OBOS finish is treated as, relative to the same
    # finish in Eliteserien. Promoted champions have historically slotted into
    # the lower half of Eliteserien rather than the bottom.
    division_offset: int = 14


@dataclass(frozen=True)
class TeamRating:
    team_id: str
    team: str
    rating: float


def initial_ratings(
    top_tier: list[Standing],
    second_tier: list[Standing],
    *,
    config: SeedingConfig | None = None,
) -> dict[str, TeamRating]:
    """Seed every team that appears in either final table, keyed by team id."""
    config = config or SeedingConfig()
    ranked = [(s, s.position) for s in top_tier] + [
        (s, s.position + config.division_offset) for s in second_tier
    ]
    if not ranked:
        return {}
    worst_rank = max(rank for _, rank in ranked)
    step = (config.best_rating - config.worst_rating) / (worst_rank - 1) if worst_rank > 1 else 0.0
    return {
        s.team_id: TeamRating(s.team_id, s.team, config.best_rating - (rank - 1) * step)
        for s, rank in ranked
    }


def rating_for_unseeded_team(config: SeedingConfig | None = None) -> float:
    """A side promoted from the third tier has no record here: it starts at the floor."""
    return (config or SeedingConfig()).worst_rating
