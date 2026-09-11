"""Win / draw / loss probabilities for a single match.

ELO gives an expected score, not a three-way split, so a draw model is layered
on top. The split is built so the three probabilities reproduce the ELO
expectation exactly:

    expected = P(home win) + 0.5 * P(draw)

Taking half the draw mass from each side preserves that identity, so the
probabilities can never disagree with the ratings they came from.
"""

from __future__ import annotations

from dataclasses import dataclass

from elitetracker.model.elo import EloConfig, draw_probability, expected_score


# Outcome labels used as keys throughout the model and the simulation.
HOME_WIN = "home_win"
DRAW = "draw"
AWAY_WIN = "away_win"


@dataclass(frozen=True)
class MatchProbabilities:
    home_win: float
    draw: float
    away_win: float

    def of(self, outcome: str) -> float:
        return {HOME_WIN: self.home_win, DRAW: self.draw, AWAY_WIN: self.away_win}[outcome]


def outcome_of(match) -> str:
    if match.home_goals > match.away_goals:
        return HOME_WIN
    if match.home_goals < match.away_goals:
        return AWAY_WIN
    return DRAW


def match_probabilities(
    home_rating: float, away_rating: float, config: EloConfig | None = None
) -> MatchProbabilities:
    """Three-way probabilities for a match at the home team's ground."""
    config = config or EloConfig()
    effective_gap = (home_rating + config.home_advantage) - away_rating
    return _draw_model_probabilities(effective_gap, config)


def _draw_model_probabilities(rating_difference: float, config: EloConfig) -> MatchProbabilities:
    """Historical bell-curve draw layered on the ELO expectation.

    Half the draw mass comes off each side, so P(win) + 0.5*P(draw) equals the
    ELO expected score exactly.
    """
    # The effective gap already folds in home advantage, so the ELO expectation
    # is just the score of that gap against an even 1500 baseline.
    expected_home = expected_score(rating_difference + 1500.0, 1500.0)
    draw = draw_probability(rating_difference, config)
    draw = min(draw, 2.0 * min(expected_home, 1.0 - expected_home))

    home_win = expected_home - draw / 2.0
    away_win = (1.0 - expected_home) - draw / 2.0
    return MatchProbabilities(home_win=home_win, draw=draw, away_win=away_win)

