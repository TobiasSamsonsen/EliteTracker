"""Tests for the gap-binned scoreline model."""

import random
import statistics as st

from elitetracker.model.scorelines import (
    AWAY_WIN,
    DRAW,
    HOME_WIN,
    ScorelineModel,
)


def _corpus(home_wins, away_wins, draws):
    """Build a labeled corpus: (outcome, gap, score)."""
    labeled = []
    gap = -200.0
    for _ in range(home_wins):
        labeled.append((HOME_WIN, gap, (2, 1)))
        gap += 400.0 / max(home_wins - 1, 1)
    gap = -200.0
    for _ in range(away_wins):
        labeled.append((AWAY_WIN, gap, (1, 2)))
        gap += 400.0 / max(away_wins - 1, 1)
    gap = -200.0
    for _ in range(draws):
        labeled.append((DRAW, gap, (1, 1)))
        gap += 400.0 / max(draws - 1, 1)
    return labeled


class TestBinConstruction:
    def test_bins_when_there_is_enough_data(self):
        model = ScorelineModel.from_corpus(_corpus(600, 600, 600), bins=5)
        assert model.bins == 5
        assert len(model.bin_edges) == 4

    def test_falls_back_to_outcome_only_with_too_little_data(self):
        model = ScorelineModel.from_corpus([(HOME_WIN, 0.0, (2, 1))], bins=5)
        assert model.bins == 1

    def test_bin_for_maps_a_gap_to_an_index(self):
        model = ScorelineModel.from_corpus(_corpus(600, 600, 600), bins=5)
        low = model.bin_for(-1000.0)
        high = model.bin_for(1000.0)
        assert low == 0
        assert high == model.bins - 1

    def test_bin_for_is_always_zero_for_outcome_only_models(self):
        model = ScorelineModel.from_counts({HOME_WIN: {(2, 1): 10}})
        assert model.bin_for(123.0) == 0


class TestGapConditioning:
    def test_home_win_margin_grows_with_the_gap(self):
        # Real corpus: a bigger strength gap produces a bigger winning margin, so
        # the top gap bin should out-score the bottom one.
        from elitetracker.model.scorelines import DEFAULT_SCORELINE_MODEL as model

        assert model.bins > 1
        bottom = [hg - ag for hg, ag in model._flat[HOME_WIN][0]]
        top = [hg - ag for hg, ag in model._flat[HOME_WIN][-1]]
        assert st.mean(top) > st.mean(bottom)

    def test_empty_cell_falls_back_to_the_global_distribution(self):
        # Only home wins present across the whole gap range, plus a single away
        # win buried in the bottom bin. The higher away-win bins must fall back
        # to the global away-win list rather than stay empty.
        labeled = [(HOME_WIN, float(i), (2, 1)) for i in range(-200, 201, 1)]
        labeled.append((AWAY_WIN, -200.0, (1, 2)))
        model = ScorelineModel.from_corpus(labeled, bins=4)
        assert model._flat[AWAY_WIN][-1] == model._global[AWAY_WIN]
        assert model._flat[AWAY_WIN][0] == model._global[AWAY_WIN]


class TestSerialization:
    def test_constants_round_trip(self):
        model = ScorelineModel.from_corpus(_corpus(600, 600, 600), bins=5)
        restored = ScorelineModel.from_constants(model.to_constants())
        assert restored.bins == model.bins
        assert restored.bin_edges == model.bin_edges
        assert restored.flat_tables() == model.flat_tables()


class TestShippedModel:
    def test_default_model_is_gap_binned(self):
        from elitetracker.model.scorelines import DEFAULT_SCORELINE_MODEL as model

        assert model.bins > 1

    def test_default_model_samples_without_error(self):
        from elitetracker.model.scorelines import DEFAULT_SCORELINE_MODEL as model

        rng = random.Random(1)
        for gap in (-300.0, 0.0, 300.0):
            hg, ag = model.sample(HOME_WIN, rng, gap)
            assert isinstance(hg, int) and isinstance(ag, int)
