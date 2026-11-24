"""The crowd's signal, stage 1 (docs/predict-plan.md, section 6): shadow only.

Nothing here reaches a published number. ``pricing.py`` has no crowd term; this
module only computes, for a settled-or-locked match, what the crowd would have
said, so the shadow phase can test it walk-forward before any release.

Each player's pick is a gap g_u on the Elo axis. The model's own price for the
match, written on the same axis, is g_m (the equivalent gap). A player's
*deviation* y_u = g_u - g_m is what they add to the model: a copier deviates by
about nothing and so adds about nothing. The state is the model's error
``delta`` on this match, with prior N(0, tau^2); each deviation is an
observation with variance R_u that grows with the pick's age at kick-off
(a stale pick is a noisier one); the posterior mean is the standard Kalman
update.

TAU, R0 and Q are placeholders, to be fitted on the shadow data. Below
MIN_EFFECTIVE players the signal is 0 by rule.
"""

from __future__ import annotations

from typing import Iterable, Sequence

from elitetracker.predict.curve import equivalent_gap

TAU = 25.0          # Elo points: prior sd of the model's error on one match
R0 = 150.0 ** 2     # Elo points squared: one fresh player's noise
Q = 100.0 ** 2      # extra variance per day of age
MIN_EFFECTIVE = 30  # players needed before the signal is used at all


def posterior(deviations: Sequence[float], ages_days: Sequence[float],
              tau: float = TAU, r0: float = R0, q: float = Q) -> float:
    """The posterior mean of the model's error on this match, in Elo points."""
    precision = 1.0 / (tau * tau)
    weighted = 0.0
    for y, age in zip(deviations, ages_days):
        r = r0 + q * max(0.0, age)
        precision += 1.0 / r
        weighted += y / r
    return weighted / precision


def signal(model_home: float, model_draw: float, picks: Iterable[tuple[float, float]],
           min_effective: int = MIN_EFFECTIVE) -> float:
    """The crowd's correction for one match in Elo points: ``picks`` are
    (gap, age in days) per player; 0.0 below ``min_effective`` players."""
    rows = list(picks)
    if len(rows) < min_effective:
        return 0.0
    g_model = equivalent_gap(model_home, model_draw)
    return posterior([g - g_model for g, _ in rows], [age for _, age in rows])
