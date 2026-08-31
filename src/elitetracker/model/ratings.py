"""Replay played matches to bring seeded ratings up to date.

Matches are applied in kickoff order across both divisions at once, against a
single rating table. Order matters -- a rating update depends on the ratings at
the time of the match -- so the replay is strictly chronological and therefore
reproducible.
"""

from __future__ import annotations

from elitetracker.model.elo import EloConfig, updated_pair
from elitetracker.normalize.matches import Match
from elitetracker.model.initial_ratings import TeamRating, rating_for_unseeded_team


def _team_ids(match: Match) -> tuple[str, str]:
    if match.home_id is None or match.away_id is None:
        raise ValueError(
            f"match {match.match_id} has no team ids; ratings join on ids, not names"
        )
    return match.home_id, match.away_id


def build_rating_table(
    seeds: dict[str, TeamRating],
    matches: list[Match],
    *,
    config: EloConfig | None = None,
) -> dict[str, float]:
    """Seed from the previous season, then apply every played match in order.

    Teams appearing in `matches` without a seed start at the ladder floor.
    """
    config = config or EloConfig()
    ratings = {team_id: seed.rating for team_id, seed in seeds.items()}

    # Register everyone before replaying, so a rating never depends on which
    # match a team happens to appear in first.
    for match in matches:
        for team_id in _team_ids(match):
            ratings.setdefault(team_id, rating_for_unseeded_team())

    for match in sorted(matches, key=Match.sort_key):
        if not match.played:
            continue
        home_id, away_id = _team_ids(match)
        ratings[home_id], ratings[away_id] = updated_pair(
            ratings[home_id],
            ratings[away_id],
            match.home_goals,
            match.away_goals,
            config,
        )

    return ratings
