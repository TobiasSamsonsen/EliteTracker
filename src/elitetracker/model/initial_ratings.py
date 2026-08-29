"""Deterministic starting ratings from the previous season's final tables.

The only input is where a team finished in 2025, so the same standings always
produce the same ratings -- no randomness, no hand-tuning per club.

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

# Tier 1 is Eliteserien, tier 2 is OBOS-ligaen.
TOP_TIER = 1
SECOND_TIER = 2


@dataclass(frozen=True)
class SeedingConfig:
    best_rating: float = 1670.0
    worst_rating: float = 1330.0
    # How many places worse an OBOS finish is treated as, relative to the same
    # finish in Eliteserien. Promoted champions have historically slotted into
    # the lower half of Eliteserien rather than the bottom.
    division_offset: int = 14

    def __post_init__(self) -> None:
        if self.best_rating <= self.worst_rating:
            raise ValueError("best_rating must exceed worst_rating")
        if self.division_offset < 0:
            raise ValueError("division_offset must not be negative")


@dataclass(frozen=True)
class TeamRating:
    team_id: str
    team: str
    rating: float
    # Where the team came from, for display and for explaining a rating.
    source: str


def equivalent_rank(position: int, tier: int, config: SeedingConfig) -> int:
    """Map a finishing position in a division onto the combined ladder."""
    if position < 1:
        raise ValueError(f"position must be 1 or greater, got {position}")
    if tier == TOP_TIER:
        return position
    if tier == SECOND_TIER:
        return position + config.division_offset
    raise ValueError(f"unknown tier {tier}")


def rating_for_rank(rank: int, worst_rank: int, config: SeedingConfig) -> float:
    """Linearly place a ladder rank in the target rating range."""
    if worst_rank <= 1:
        return config.best_rating
    span = config.best_rating - config.worst_rating
    step = span / (worst_rank - 1)
    return config.best_rating - (rank - 1) * step


def initial_ratings(
    top_tier: list[Standing],
    second_tier: list[Standing],
    *,
    config: SeedingConfig | None = None,
) -> dict[str, TeamRating]:
    """Seed every team that appears in either final table.

    Returns a mapping from team id to rating; ids are stable across seasons so
    a promoted team keeps its identity.
    """
    config = config or SeedingConfig()

    ranked: list[tuple[Standing, int, str]] = []
    for standing in top_tier:
        ranked.append((standing, equivalent_rank(standing.position, TOP_TIER, config), "Eliteserien"))
    for standing in second_tier:
        ranked.append((standing, equivalent_rank(standing.position, SECOND_TIER, config), "OBOS-ligaen"))

    if not ranked:
        return {}

    worst_rank = max(rank for _, rank, _ in ranked)
    return {
        standing.team_id: TeamRating(
            team_id=standing.team_id,
            team=standing.team,
            rating=rating_for_rank(rank, worst_rank, config),
            source=f"{division} 2025 #{standing.position}",
        )
        for standing, rank, division in ranked
    }


def rating_for_unseeded_team(config: SeedingConfig | None = None) -> float:
    """Rating for a team with no previous-season record in either division.

    OBOS-ligaen 2026 contains sides promoted from the third tier, which is
    outside this project's data scope. They start at the bottom of the ladder;
    the rating updates once they have played.
    """
    return (config or SeedingConfig()).worst_rating
