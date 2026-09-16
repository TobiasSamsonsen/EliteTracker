"""Replay one season's played matches to bring seeded ratings up to date.

Matches are applied in kickoff order across both divisions at once, against a
single rating table. Order matters -- a rating update depends on the ratings at
the time of the match -- so the replay is strictly chronological and therefore
reproducible.

The loop itself is `career.replay`, the same one the careers and the backtest
read off, so the ratings the site serves cannot drift from the ones the model
was measured with. (They had: before elo-v11 this module ran its own loop,
without xG and without the era switch, leaving the live table a mean 12 Elo --
and up to 38 -- away from the model's own.)
"""

from __future__ import annotations

from typing import Callable

from elitetracker.model.career import SeasonSlice, replay
from elitetracker.model.elo import EloConfig
from elitetracker.model.initial_ratings import TeamRating
from elitetracker.normalize.matches import Match


def _assert_ids(matches: list[Match]) -> None:
    for match in matches:
        if match.home_id is None or match.away_id is None:
            raise ValueError(
                f"match {match.match_id} has no team ids; ratings join on ids, not names"
            )


def build_rating_table(
    seeds: dict[str, TeamRating],
    matches: list[Match],
    *,
    config: EloConfig | None = None,
    shots: dict[str, tuple[float, ...]] | None = None,
    config_for: Callable[[str, int], EloConfig] | None = None,
    league: str = "",
) -> dict[str, float]:
    """Seed from the start of the season, then apply every played match in order.

    Teams appearing in `matches` without a seed start at the ladder floor. All
    the matches belong to one season, so no offseason regression applies here:
    `seeds` are already that season's opening ratings.
    """
    _assert_ids(matches)
    ratings = {team_id: seed.rating for team_id, seed in seeds.items()}
    if not matches:
        return ratings
    season = int(min(match.date for match in matches)[:4])
    # `league` labels the whole slice: the shipped era rule keys off the season
    # alone, so one label is enough for both divisions.
    slices = [SeasonSlice(league, league, season, matches)]
    for _, _, ratings, applied in replay(slices, ratings, config, shots=shots, config_for=config_for):
        for _ in applied:
            pass
    return ratings
