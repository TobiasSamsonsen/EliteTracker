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


@dataclass(frozen=True)
class MatchProbabilities:
    home_win: float
    draw: float
    away_win: float

    @property
    def expected_home_score(self) -> float:
        return self.home_win + 0.5 * self.draw

    def as_dict(self) -> dict[str, float]:
        return {"home_win": self.home_win, "draw": self.draw, "away_win": self.away_win}


def match_probabilities(
    home_rating: float, away_rating: float, config: EloConfig | None = None
) -> MatchProbabilities:
    """Three-way probabilities for a match at the home team's ground."""
    config = config or EloConfig()

    effective_gap = (home_rating + config.home_advantage) - away_rating
    expected_home = expected_score(home_rating + config.home_advantage, away_rating)

    draw = draw_probability(effective_gap, config)
    # Half the draw mass comes off each side, so neither can go negative: cap
    # the draw at twice the smaller of the two expectations.
    draw = min(draw, 2.0 * min(expected_home, 1.0 - expected_home))

    home_win = expected_home - draw / 2.0
    away_win = (1.0 - expected_home) - draw / 2.0
    return MatchProbabilities(home_win=home_win, draw=draw, away_win=away_win)
