"""Display-only fixture payload, kept out of the simulation signature.

Everything here turns already-computed ratings and odds into the "Next up"
view. It never feeds the Monte Carlo, so a change to this package must not
invalidate cached past-season reports -- a completed season has no upcoming
fixtures, and the current season is rebuilt on every deploy regardless.
"""

from __future__ import annotations

from elitetracker.model.elo import EloConfig
from elitetracker.model.scorelines import (
    AWAY_WIN,
    DEFAULT_SCORELINE_MODEL,
    DRAW,
    HOME_WIN,
    ScorelineModel,
)
from elitetracker.model.probabilities import match_probabilities
from elitetracker.normalize.matches import Match


def top_scorelines(
    outcome_probabilities: dict[str, float],
    effective_gap: float,
    model: ScorelineModel | None = None,
    n: int = 5,
) -> list[tuple[tuple[int, int], float]]:
    """Most likely scorelines for a fixture, by probability.

    Each outcome's empirical scoreline frequencies (for the gap's bin) are
    weighted by that outcome's probability, so ``P(2-1) == P(home win) *
    P(2-1 | home win, gap)``. This is the full distribution, not a sample, so
    it is deterministic for a fixed model and matches the Monte Carlo's
    conditioning exactly. Returns the ``n`` highest-probability
    ``((home_goals, away_goals), probability)`` pairs, descending.
    """
    model = model or DEFAULT_SCORELINE_MODEL
    bin_index = model.bin_for(effective_gap)
    combined: dict[tuple[int, int], float] = {}
    for outcome, outcome_prob in outcome_probabilities.items():
        if outcome_prob <= 0.0:
            continue
        table = model.flat_tables()[_outcome_index(outcome)][bin_index]
        if not table:
            continue
        total = len(table)
        counts: dict[tuple[int, int], int] = {}
        for pair in table:
            counts[pair] = counts.get(pair, 0) + 1
        for pair, count in counts.items():
            combined[pair] = combined.get(pair, 0.0) + outcome_prob * (count / total)
    ranked = sorted(combined.items(), key=lambda item: item[1], reverse=True)
    return ranked[:n]


def _outcome_index(outcome: str) -> int:
    return {HOME_WIN: 0, DRAW: 1, AWAY_WIN: 2}[outcome]


def build_fixtures_payload(
    matches: list[Match],
    ratings: dict[str, float],
    elo_config: EloConfig,
    scoreline_model: ScorelineModel | None = None,
) -> list[dict]:
    """Upcoming fixtures with three-way odds and the most likely scorelines."""
    scoreline_model = scoreline_model or DEFAULT_SCORELINE_MODEL
    payload = []
    for match in matches:
        if match.played:
            continue
        home_id = match.home_id or match.home
        away_id = match.away_id or match.away
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
        payload.append(
            {
                "match_id": match.match_id,
                "date": match.date,
                "time": match.time,
                "round": match.round,
                "home": match.home,
                "away": match.away,
                "home_id": home_id,
                "away_id": away_id,
                "home_rating": round(ratings[home_id], 1),
                "away_rating": round(ratings[away_id], 1),
                "home_win": round(probabilities.home_win, 4),
                "draw": round(probabilities.draw, 4),
                "away_win": round(probabilities.away_win, 4),
                "scorelines": scorelines,
            }
        )
    return payload
