"""The game's price curve, frozen.

The slider on a match card is a rating gap (home advantage already added, as on
the model page) and the odds it shows are the model's own Elo curve. This is a
FROZEN COPY of the constants (``CURVE_VERSION`` is kept apart from
``MODEL_VERSION``): a later refit of the model must not rescore picks made
under this curve, because scores use the stored whole percentages.
public/elo-curve.js and public/predict-core.js are the browser twins; the shared
vectors in tests/fixtures/predict_vectors.json pin all three.
"""

from __future__ import annotations

import math

CURVE_VERSION = 1
DRAW_BASE = 0.26
DRAW_SCALE = 375.0
# +-700 lets a strong favourite reach the clip (96 / 2 / 2); at +-400 a pick stopped at 87 / 8 / 5.
GAP_MIN, GAP_MAX, GAP_STEP = -700, 700, 5
K_MIN, K_MAX, K_DEFAULT = 5, 18, 10      # draw tendency in tenths: 0.5 to 1.8, 1.0 is the model's shape
PCT_MIN, PCT_MAX = 2, 96                  # whole-percent clip of every outcome


def expected_score(gap: float) -> float:
    return 1.0 / (1.0 + 10.0 ** (-gap / 400.0))


def odds(gap: float, k: int = K_DEFAULT) -> tuple[float, float, float]:
    """(home, draw, away) at an effective gap; ``k`` scales the draw mass."""
    expected = expected_score(gap)
    draw = DRAW_BASE * math.exp(-((gap / DRAW_SCALE) ** 2)) * (k / 10.0)
    draw = min(draw, 2.0 * min(expected, 1.0 - expected))
    return expected - draw / 2.0, draw, 1.0 - expected - draw / 2.0


def percentages(home: float, draw: float, away: float) -> tuple[int, int, int]:
    """Whole percents that sum to 100, each within the clip: clip, spread the
    surplus over the outcomes that can still move, round by largest remainder
    (ties to the lower index)."""
    total = home + draw + away
    values = [min(PCT_MAX, max(PCT_MIN, 100.0 * x / total)) for x in (home, draw, away)]
    for _ in range(4):
        excess = 100.0 - sum(values)
        if abs(excess) < 1e-9:
            break
        free = [i for i, v in enumerate(values) if (excess > 0 and v < PCT_MAX) or (excess < 0 and v > PCT_MIN)]
        if not free:
            break
        weight = sum(values[i] for i in free)
        for i in free:
            values[i] = min(PCT_MAX, max(PCT_MIN, values[i] + excess * values[i] / weight))
    floors = [math.floor(v) for v in values]
    remainder = 100 - sum(floors)
    for i in sorted(range(3), key=lambda i: (-(values[i] - floors[i]), i))[:remainder]:
        floors[i] += 1
    return floors[0], floors[1], floors[2]


def pick_percentages(gap: int, k: int = K_DEFAULT) -> tuple[int, int, int]:
    """What a card stores for a slider position."""
    return percentages(*odds(gap, k))


def equivalent_gap(home: float, draw: float) -> float:
    """The gap whose expected score equals home + draw / 2: the model's price
    for this match expressed on the slider's own axis (Elo points)."""
    expected = min(1.0 - 1e-9, max(1e-9, home + draw / 2.0))
    return 400.0 * math.log10(expected / (1.0 - expected))
