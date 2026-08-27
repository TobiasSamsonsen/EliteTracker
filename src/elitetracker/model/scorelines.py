"""Sample goal difference for simulated matches from real scorelines.

The Monte Carlo loop already draws each fixture's win/draw/loss outcome from
the rating-implied probabilities. That decides the points, but historically the
simulation stopped there: goal difference could not move, so every tied finish
was broken on goal difference *as it stood today* (an artifact that favoured
whoever was already ahead on it).

This module supplies the missing piece. Given the outcome, it samples a concrete
scoreline -- and therefore a goal-difference swing -- so GD inside a simulation
reflects the simulated matches rather than the current table.

The distribution is conditioned on the outcome *and* the pre-match rating gap.
Real winning margins grow with the strength gap (verified on the corpus: mean
winning margin rises monotonically from ~1.7 to ~2.2 goals across gap quintiles,
corr ~0.18), so a heavy favourite draws bigger scorelines than a slight one.
That is an empirical fact about the data, not a cleverer model bolted on -- the
rating-implied probabilities remain the sole driver of *who* wins.

Bins are equal-count quantiles of the signed effective gap, so each bin holds a
comparable amount of evidence. A (outcome, bin) cell with too little data falls
back to that outcome's global distribution, so sampling never starves.
"""

from __future__ import annotations

import json
import random
import statistics
from dataclasses import dataclass, field
from pathlib import Path

# Outcome labels used as keys throughout the simulation.
HOME_WIN = "home_win"
DRAW = "draw"
AWAY_WIN = "away_win"

# Minimal per-outcome fallback so a corpus missing an outcome can never crash
# the sampler (a fixture can still produce that outcome).
_FALLBACK: dict[str, tuple[int, int]] = {
    HOME_WIN: (1, 0),
    DRAW: (0, 0),
    AWAY_WIN: (0, 1),
}


def _expand(pairs: dict[tuple[int, int], int]) -> list[tuple[int, int]]:
    """Repeat each scoreline by its weight into a flat list for O(1) sampling."""
    expanded: list[tuple[int, int]] = []
    for (home_goals, away_goals), weight in sorted(pairs.items()):
        expanded.extend((home_goals, away_goals) for _ in range(weight))
    return expanded


def _bin_for_gap(gap: float, edges: tuple[float, ...], bins: int) -> int:
    """Index of the bin a signed gap falls into (0 .. bins-1)."""
    index = 0
    for edge in edges:
        if gap > edge:
            index += 1
        else:
            break
    return min(index, bins - 1)


@dataclass(frozen=True)
class ScorelineModel:
    # Number of gap bins; 1 means outcome-only (the historical behaviour).
    bins: int
    # Equal-count cut points on the signed effective gap (length bins-1).
    bin_edges: tuple[float, ...]
    # _flat[outcome][bin] = flat list of (home_goals, away_goals) repeated by
    # weight, ready for randrange in the hot loop.
    _flat: dict[str, list[list[tuple[int, int]]]] = field(default_factory=dict)
    # _global[outcome] = the outcome's overall flat list, used when a bin is empty.
    _global: dict[str, list[tuple[int, int]]] = field(default_factory=dict)

    @classmethod
    def from_counts(cls, counts: dict[str, dict[tuple[int, int], int]], bins: int = 1) -> "ScorelineModel":
        """Build an outcome-only model (or a single-bin model) from scoreline counts."""
        merged: dict[str, dict[tuple[int, int], int]] = {
            HOME_WIN: {_FALLBACK[HOME_WIN]: 1},
            DRAW: {_FALLBACK[DRAW]: 1},
            AWAY_WIN: {_FALLBACK[AWAY_WIN]: 1},
        }
        for outcome, pairs in counts.items():
            if pairs:
                merged[outcome] = dict(pairs)
        flat: dict[str, list[list[tuple[int, int]]]] = {}
        global_flat: dict[str, list[tuple[int, int]]] = {}
        for outcome in (HOME_WIN, DRAW, AWAY_WIN):
            expanded = _expand(merged[outcome])
            flat[outcome] = [expanded]
            global_flat[outcome] = expanded
        return cls(bins=1, bin_edges=(), _flat=flat, _global=global_flat)

    @classmethod
    def from_matches(cls, matches: list, bins: int = 1) -> "ScorelineModel":
        """Build from a corpus of played matches (outcome-only by default)."""
        counts: dict[str, dict[tuple[int, int], int]] = {
            HOME_WIN: {}, DRAW: {}, AWAY_WIN: {},
        }
        for match in matches:
            if not getattr(match, "played", False):
                continue
            home_goals = match.home_goals
            away_goals = match.away_goals
            if home_goals > away_goals:
                outcome = HOME_WIN
            elif home_goals < away_goals:
                outcome = AWAY_WIN
            else:
                outcome = DRAW
            pair = (home_goals, away_goals)
            counts[outcome][pair] = counts[outcome].get(pair, 0) + 1
        return cls.from_counts(counts, bins=bins)

    @classmethod
    def from_corpus(
        cls, labeled: list[tuple[str, float, tuple[int, int]]], bins: int = 5
    ) -> "ScorelineModel":
        """Build a gap-binned model.

        `labeled` is (outcome, effective_gap, (home_goals, away_goals)) per match.
        Falls back to outcome-only if there is not enough data to bin.
        """
        gaps = [gap for _, gap, _ in labeled]
        edges = tuple(statistics.quantiles(gaps, n=bins)) if bins > 1 and len(gaps) >= bins else ()

        if not edges:
            counts: dict[str, dict[tuple[int, int], int]] = {
                HOME_WIN: {}, DRAW: {}, AWAY_WIN: {},
            }
            for outcome, _, score in labeled:
                counts[outcome][score] = counts[outcome].get(score, 0) + 1
            return cls.from_counts(counts, bins=1)

        global_pairs: dict[str, dict[tuple[int, int], int]] = {
            o: {} for o in (HOME_WIN, DRAW, AWAY_WIN)
        }
        bin_pairs: dict[str, list[dict[tuple[int, int], int]]] = {
            o: [{} for _ in range(bins)] for o in (HOME_WIN, DRAW, AWAY_WIN)
        }
        for outcome, gap, score in labeled:
            global_pairs[outcome][score] = global_pairs[outcome].get(score, 0) + 1
            bin_index = _bin_for_gap(gap, edges, bins)
            bin_pairs[outcome][bin_index][score] = bin_pairs[outcome][bin_index].get(score, 0) + 1

        flat: dict[str, list[list[tuple[int, int]]]] = {}
        global_flat: dict[str, list[tuple[int, int]]] = {}
        for outcome in (HOME_WIN, DRAW, AWAY_WIN):
            global_flat[outcome] = _expand(global_pairs[outcome]) or [_FALLBACK[outcome]]
            flat[outcome] = []
            for bin_index in range(bins):
                cell = bin_pairs[outcome][bin_index]
                flat[outcome].append(_expand(cell) if cell else global_flat[outcome])
        return cls(bins=bins, bin_edges=edges, _flat=flat, _global=global_flat)

    def bin_for(self, effective_gap: float) -> int:
        if self.bins <= 1:
            return 0
        return _bin_for_gap(effective_gap, self.bin_edges, self.bins)

    def sample(self, outcome: str, rng: random.Random, effective_gap: float = 0.0) -> tuple[int, int]:
        """Draw a (home_goals, away_goals) pair consistent with outcome and gap."""
        table = self._flat[outcome][self.bin_for(effective_gap)]
        return table[rng.randrange(len(table))]

    def flat_tables(self) -> list[list[list[tuple[int, int]]]]:
        """The three outcomes' bin tables, in (home_win, draw, away_win) order."""
        return [self._flat[HOME_WIN], self._flat[DRAW], self._flat[AWAY_WIN]]

    def to_constants(self) -> dict:
        """Serializable form for embedding / the shipped JSON model."""

        def pack(pairs: dict[tuple[int, int], int]) -> list[list[int]]:
            return [[hg, ag, w] for (hg, ag), w in sorted(pairs.items())]

        global_counts = {o: pack(self._global_to_pairs(o)) for o in (HOME_WIN, DRAW, AWAY_WIN)}
        bins_data = {
            o: [pack(self._flat_to_pairs(o, b)) for b in range(self.bins)]
            for o in (HOME_WIN, DRAW, AWAY_WIN)
        }
        return {"bins": self.bins, "bin_edges": list(self.bin_edges),
                "global": global_counts, "bins_data": bins_data}

    @classmethod
    def from_constants(cls, data: dict) -> "ScorelineModel":
        bins = data["bins"]
        edges = tuple(data["bin_edges"])

        def unpack(cell: list[list[int]]) -> dict[tuple[int, int], int]:
            return {(hg, ag): w for hg, ag, w in cell}

        global_pairs = {o: unpack(data["global"][o]) for o in (HOME_WIN, DRAW, AWAY_WIN)}
        flat: dict[str, list[list[tuple[int, int]]]] = {}
        global_flat: dict[str, list[tuple[int, int]]] = {}
        for outcome in (HOME_WIN, DRAW, AWAY_WIN):
            global_flat[outcome] = _expand(global_pairs[outcome]) or [_FALLBACK[outcome]]
            flat[outcome] = []
            for bin_index in range(bins):
                cell = unpack(data["bins_data"][outcome][bin_index])
                flat[outcome].append(_expand(cell) if cell else global_flat[outcome])
        return cls(bins=bins, bin_edges=edges, _flat=flat, _global=global_flat)

    # -- helpers for (de)serialisation -----------------------------------
    def _global_to_pairs(self, outcome: str) -> dict[tuple[int, int], int]:
        counts: dict[tuple[int, int], int] = {}
        for hg, ag in self._global[outcome]:
            counts[(hg, ag)] = counts.get((hg, ag), 0) + 1
        return counts

    def _flat_to_pairs(self, outcome: str, bin_index: int) -> dict[tuple[int, int], int]:
        counts: dict[tuple[int, int], int] = {}
        for hg, ag in self._flat[outcome][bin_index]:
            counts[(hg, ag)] = counts.get((hg, ag), 0) + 1
        return counts


# Outcome-only fallback embedded so the default model is always available even
# before the gap-binned JSON is generated. The shipped model replaces this.
_DEFAULT_COUNTS: dict[str, dict[tuple[int, int], int]] = {
    "home_win": {
        (2, 1): 473, (1, 0): 453, (2, 0): 341, (3, 1): 267, (3, 0): 250,
        (3, 2): 202, (4, 0): 125, (4, 1): 111, (4, 2): 79, (5, 1): 68,
        (5, 0): 62, (4, 3): 33, (5, 2): 26, (6, 0): 20, (6, 1): 19,
        (5, 4): 7, (6, 2): 6, (5, 3): 5, (7, 0): 5, (7, 2): 5, (7, 1): 3,
        (6, 3): 1, (6, 4): 1, (7, 3): 1, (8, 0): 1, (8, 3): 1,
    },
    "draw": {
        (1, 1): 635, (2, 2): 334, (0, 0): 280, (3, 3): 67, (4, 4): 9, (5, 5): 1,
    },
    "away_win": {
        (1, 2): 391, (0, 1): 333, (0, 2): 220, (1, 3): 162, (2, 3): 147,
        (0, 3): 126, (1, 4): 80, (2, 4): 51, (0, 4): 50, (3, 4): 23,
        (0, 5): 20, (1, 5): 15, (2, 5): 12, (1, 6): 9, (4, 5): 7,
        (0, 6): 6, (1, 7): 5, (2, 6): 5, (3, 5): 3, (0, 7): 2, (0, 8): 1, (3, 6): 1,
    },
}

_DATA_PATH = Path(__file__).resolve().parent.parent.parent.parent / "data" / "scoreline_model.json"


def _load_default() -> "ScorelineModel":
    try:
        with _DATA_PATH.open(encoding="utf-8") as handle:
            return ScorelineModel.from_constants(json.load(handle))
    except FileNotFoundError:
        return ScorelineModel.from_counts(_DEFAULT_COUNTS)


DEFAULT_SCORELINE_MODEL = _load_default()
