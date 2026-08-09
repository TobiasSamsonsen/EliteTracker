"""The ELO rating system: expectation, outcome, and rating updates.

Kept deliberately plain. The three steps are separate functions so each can be
tested on its own and so a later model can reuse the pieces it still agrees
with. Any change to how ratings are produced must bump MODEL_VERSION.

Defaults are calibrated against the 2026 season to date (255 played matches
across both divisions):

* Home teams took an expected score of 0.61, which is a rating edge of
  ``-400 * log10(1/0.61 - 1)`` ~= 78 points. HOME_ADVANTAGE defaults to 75.
* 16.9% of matches were drawn, which sets the draw model's scale.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# Bump on any change that alters produced ratings or probabilities.
MODEL_VERSION = "elo-v1"

# A 400-point rating gap means the stronger side is expected to score 10 times
# as often as the weaker one; this is the constant that defines the ELO scale.
_RATING_SCALE = 400.0


@dataclass(frozen=True)
class EloConfig:
    """Tunable model parameters. Every prediction takes one of these."""

    k_factor: float = 20.0
    home_advantage: float = 75.0
    # Peak draw probability, reached when two sides are exactly level.
    draw_base: float = 0.22
    # Rating gap over which the chance of a draw decays.
    draw_scale: float = 250.0

    def __post_init__(self) -> None:
        if self.k_factor <= 0:
            raise ValueError(f"k_factor must be positive, got {self.k_factor}")
        if not 0.0 <= self.draw_base <= 1.0:
            raise ValueError(f"draw_base must be a probability, got {self.draw_base}")
        if self.draw_scale <= 0:
            raise ValueError(f"draw_scale must be positive, got {self.draw_scale}")


def expected_score(rating: float, opponent_rating: float) -> float:
    """Expected points share (1 = win, 0.5 = draw) for `rating` against `opponent_rating`.

    Any home advantage must already be folded into the ratings passed in.
    """
    return 1.0 / (1.0 + 10.0 ** ((opponent_rating - rating) / _RATING_SCALE))


def actual_score(home_goals: int, away_goals: int) -> float:
    """The home side's realised score: 1 for a win, 0.5 for a draw, 0 for a loss."""
    if home_goals > away_goals:
        return 1.0
    if home_goals < away_goals:
        return 0.0
    return 0.5


def update(rating: float, expected: float, actual: float, k_factor: float) -> float:
    """Move a rating toward the surprise in the result."""
    return rating + k_factor * (actual - expected)


def updated_pair(
    home_rating: float,
    away_rating: float,
    home_goals: int,
    away_goals: int,
    config: EloConfig,
) -> tuple[float, float]:
    """Return both sides' ratings after one match.

    Ratings are zero-sum: whatever the home side gains, the away side loses.
    """
    expected_home = expected_score(home_rating + config.home_advantage, away_rating)
    scored_home = actual_score(home_goals, away_goals)
    change = config.k_factor * (scored_home - expected_home)
    return home_rating + change, away_rating - change


def draw_probability(rating_difference: float, config: EloConfig) -> float:
    """Chance of a draw given the effective rating gap (home advantage included).

    A bell curve centred on an even match: evenly matched sides draw most often
    and the chance falls away as the mismatch grows.
    """
    return config.draw_base * math.exp(-((rating_difference / config.draw_scale) ** 2))
