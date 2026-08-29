"""Display-only pairwise odds payload, kept out of the simulation signature.

For every ordered pair of clubs in the league it computes the three-way odds of
a fictional match (with the first club at home) plus the most likely scorelines,
reusing the same machinery as the fixtures view. Useful for a "compare two clubs"
tool without running anything live -- it is precomputed into the report.
"""

from __future__ import annotations

from elitetracker.display.fixtures import top_scorelines
from elitetracker.model.elo import EloConfig
from elitetracker.model.probabilities import match_probabilities
from elitetracker.model.scorelines import (
    AWAY_WIN,
    DEFAULT_SCORELINE_MODEL,
    DRAW,
    HOME_WIN,
    ScorelineModel,
)


def build_pairwise_payload(
    ratings: dict[str, float],
    elo_config: EloConfig,
    scoreline_model: ScorelineModel | None = None,
) -> dict[str, dict[str, dict]]:
    """Three-way odds and top scorelines for every ordered pair of clubs.

    Returned as ``{home_id: {away_id: {home_win, draw, away_win, scorelines}}}``
    (a club never plays itself, so ``home_id == away_id`` is omitted).
    """
    scoreline_model = scoreline_model or DEFAULT_SCORELINE_MODEL
    team_ids = sorted(ratings)
    payload: dict[str, dict[str, dict]] = {}
    for home_id in team_ids:
        payload[home_id] = {}
        for away_id in team_ids:
            if home_id == away_id:
                continue
            probabilities = match_probabilities(ratings[home_id], ratings[away_id], elo_config)
            effective_gap = (ratings[home_id] + elo_config.home_advantage) - ratings[away_id]
            scorelines = [
                {"home_goals": home_goals, "away_goals": away_goals, "probability": round(probability, 4)}
                for (home_goals, away_goals), probability in top_scorelines(
                    {
                        HOME_WIN: probabilities.home_win,
                        DRAW: probabilities.draw,
                        AWAY_WIN: probabilities.away_win,
                    },
                    effective_gap,
                    scoreline_model,
                )
            ]
            payload[home_id][away_id] = {
                "home_win": round(probabilities.home_win, 4),
                "draw": round(probabilities.draw, 4),
                "away_win": round(probabilities.away_win, 4),
                "scorelines": scorelines,
            }
    return payload
