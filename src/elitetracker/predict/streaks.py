"""Streaks of completed rounds, with a free freeze every fifth.

A round is completed when the player tipped every match in it. The streak is
the run of completed rounds; each fifth one in the run earns a freeze (one can
be banked), and a missed round spends the banked freeze instead of breaking the
run (the run neither grows nor shrinks that round). Without a freeze a miss
resets the run to zero.
"""

from __future__ import annotations

from typing import Iterable

FREEZE_EVERY = 5


def streak(completed: Iterable[bool]) -> dict:
    """``completed``: one flag per finished round, oldest first. Returns the
    current run, the best run and the freezes banked (0 or 1)."""
    current = best = freezes = 0
    for done in completed:
        if done:
            current += 1
            if current % FREEZE_EVERY == 0:
                freezes = 1
            best = max(best, current)
        elif freezes:
            freezes = 0
        else:
            current = 0
    return {"current": current, "best": best, "freezes": freezes}
