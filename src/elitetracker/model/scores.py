"""The two proper scores for a home / draw / away forecast, in one place.

Used by the walk-forward backtest (model.backtest) and by the Predict game
(predict.scoring), so a player's score and the model's score are computed by the
same functions. ``outcome`` is one of the labels in model.probabilities.
"""

from __future__ import annotations

from elitetracker.model.probabilities import AWAY_WIN, DRAW, HOME_WIN


def brier(home: float, draw: float, away: float, outcome: str) -> float:
    """Multi-outcome Brier score, 0 to 2, lower is better: the squared miss on
    each of the three outcomes, summed. A 40/30/30 call on a home win is 0.54."""
    return sum((value - (1.0 if key == outcome else 0.0)) ** 2
               for key, value in ((HOME_WIN, home), (DRAW, draw), (AWAY_WIN, away)))


def rps(home: float, draw: float, away: float, outcome: str) -> float:
    """Ranked probability score over the ordered outcomes home win < draw <
    away win: the mean squared gap between the predicted and the realised
    cumulative distributions. 0 to 1, lower is better."""
    home_hit = 1.0 if outcome == HOME_WIN else 0.0
    home_or_draw_hit = 1.0 if outcome in (HOME_WIN, DRAW) else 0.0
    return ((home - home_hit) ** 2 + (home + draw - home_or_draw_hit) ** 2) / 2.0
