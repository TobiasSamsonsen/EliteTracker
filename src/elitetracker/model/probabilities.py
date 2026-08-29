"""Win / draw / loss probabilities for a single match.

ELO gives an expected score, not a three-way split, so a draw model is layered
on top. The split is built so the three probabilities reproduce the ELO
expectation exactly:

    expected = P(home win) + 0.5 * P(draw)

Taking half the draw mass from each side preserves that identity, so the
probabilities can never disagree with the ratings they came from.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from elitetracker.model.elo import EloConfig, draw_probability, expected_score


@dataclass(frozen=True)
class MatchProbabilities:
    home_win: float
    draw: float
    away_win: float

    @property
    def expected_home_score(self) -> float:
        return self.home_win + 0.5 * self.draw


def match_probabilities(
    home_rating: float, away_rating: float, config: EloConfig | None = None
) -> MatchProbabilities:
    """Three-way probabilities for a match at the home team's ground."""
    config = config or EloConfig()
    effective_gap = (home_rating + config.home_advantage) - away_rating
    if config.probability_model == "ordered_logit":
        return ordered_logit_probabilities(effective_gap, config)
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


def ordered_logit_probabilities(rating_difference: float, config: EloConfig) -> MatchProbabilities:
    """Three-way probabilities from an ordered logistic on the rating gap.

    The gap is a single linear predictor x; a logistic CDF F gives the
    cumulative chances of falling at or below each outcome, with symmetric
    thresholds +/- `logit_cutpoint`. Larger gaps push more mass onto the
    favourite, and the cutpoint sets where the draw band sits.

    Unlike the draw model this does *not* reproduce the ELO expected_score: its
    P(win) + 0.5*P(draw) is 0.5 + 0.5*(F(c + b*x) - F(c - b*x)), a logistic of
    its own scale (b, c), which is the whole point -- refitting the slope buys
    calibration the fixed ELO scale cannot.
    """
    beta = config.logit_slope
    cut = config.logit_cutpoint
    x = rating_difference

    def logist(z: float) -> float:
        return 1.0 / (1.0 + math.exp(-z))

    upper = logist(cut - beta * x)   # P(draw or loss)
    lower = logist(-cut - beta * x)  # P(loss)
    draw = upper - lower
    away_win = lower
    home_win = 1.0 - upper
    return MatchProbabilities(home_win=home_win, draw=draw, away_win=away_win)
