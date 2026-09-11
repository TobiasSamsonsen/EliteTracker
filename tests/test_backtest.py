"""Tests for the walk-forward backtest harness and the shared season replay."""

import math

import pytest

from elitetracker.model.backtest import walk_forward
from elitetracker.model.career import SeasonSlice, replay
from elitetracker.model.elo import EloConfig
from elitetracker.normalize.matches import Match


def _match(match_id, home, away, home_goals=None, away_goals=None, date="2020-03-01"):
    return Match(
        match_id=match_id,
        date=date,
        time="18:00",
        home=home,
        away=away,
        home_goals=home_goals,
        away_goals=away_goals,
        played=home_goals is not None,
        home_id=home,
        away_id=away,
    )


def _slices():
    # Season 1: A beats B, C beats D. Season 2: B beats A, D beats C.
    return [
        SeasonSlice("top", "Top", 2020, [_match("m1", "A", "B", 2, 0), _match("m2", "C", "D", 1, 0)]),
        SeasonSlice("top", "Top", 2021, [_match("m3", "B", "A", 2, 1), _match("m4", "D", "C", 2, 0)]),
    ]


def _seeds():
    return {"A": 1600.0, "B": 1400.0, "C": 1600.0, "D": 1400.0}


class TestWalkForwardScoringWindow:
    def test_only_scores_from_the_requested_season(self):
        card = walk_forward(_slices(), _seeds(), EloConfig(), score_from_season=2021)
        assert card.matches == 2  # only the two 2021 matches are scored

    def test_scores_everything_when_window_reaches_back(self):
        card = walk_forward(_slices(), _seeds(), EloConfig(), score_from_season=2020)
        assert card.matches == 4

    def test_reports_finite_loss_and_calibration(self):
        card = walk_forward(_slices(), _seeds(), EloConfig(), score_from_season=2020)
        assert 0 < card.log_loss < 10
        assert 0.0 <= card.calibration_error() <= 1.0

    def test_predicts_before_it_learns(self):
        """A certain-looking result must still be scored on the pre-match rating."""
        slices = [SeasonSlice("top", "Top", 2020, [_match("m", "A", "B", 5, 0)])]
        card = walk_forward(slices, {"A": 1500.0, "B": 1500.0}, EloConfig(home_advantage=0), score_from_season=2020)
        # Level sides, no home edge: P(home win) = 0.5 - 0.26 / 2, whatever the score was.
        assert card.log_loss == pytest.approx(-math.log(0.5 - 0.13))


def _season_starts(slices, seeds, config):
    """Ratings as each season kicks off."""
    return {season: dict(ratings) for season, _, ratings, _ in replay(slices, seeds, config)}


class TestOffseasonRegression:
    def _unplayed(self, season, league, pairs):
        return SeasonSlice(league, league, season, [
            _match(f"{season}{h}{a}", h, a, date=f"{season}-04-01") for h, a in pairs
        ])

    def test_no_regression_on_the_first_season(self):
        starts = _season_starts([self._unplayed(2020, "top", [("A", "B")])], {"A": 1700.0, "B": 1300.0},
                                EloConfig(season_regression=0.5))
        assert starts[2020] == {"A": 1700.0, "B": 1300.0}

    def test_pulls_ratings_toward_the_mean_at_the_offseason(self):
        slices = [self._unplayed(2020, "top", [("A", "B")]), self._unplayed(2021, "top", [("A", "B")])]
        starts = _season_starts(slices, {"A": 1700.0, "B": 1300.0}, EloConfig(season_regression=0.95))
        assert starts[2021]["A"] == 1500.0 + 0.95 * 200.0
        assert starts[2021]["B"] == 1500.0 + 0.95 * (-200.0)

    def test_factor_of_one_is_a_no_op(self):
        slices = [self._unplayed(2020, "top", [("A", "B")]), self._unplayed(2021, "top", [("A", "B")])]
        starts = _season_starts(slices, {"A": 1700.0, "B": 1300.0}, EloConfig(season_regression=1.0))
        assert starts[2021] == {"A": 1700.0, "B": 1300.0}

    def test_per_division_pulls_toward_each_division_mean(self):
        seeds = {"A": 1800.0, "B": 1600.0, "C": 1400.0, "D": 1200.0, "E": 1500.0}
        slices = [
            self._unplayed(2020, "top", [("A", "B")]), self._unplayed(2020, "second", [("C", "D")]),
            self._unplayed(2021, "top", [("A", "B")]), self._unplayed(2021, "second", [("C", "D")]),
        ]
        ratings = _season_starts(slices, seeds, EloConfig(season_regression=0.95))[2021]
        assert ratings["A"] == pytest.approx(1700.0 + 0.95 * 100.0)
        assert ratings["B"] == pytest.approx(1700.0 + 0.95 * -100.0)
        assert ratings["C"] == pytest.approx(1300.0 + 0.95 * 100.0)
        assert ratings["D"] == pytest.approx(1300.0 + 0.95 * -100.0)
        # Dormant team is frozen, not pulled toward any mean.
        assert ratings["E"] == 1500.0

    def test_a_season_is_completed_even_if_the_caller_skips_its_matches(self):
        starts = _season_starts(_slices(), _seeds(), EloConfig(season_regression=1.0, home_advantage=0))
        assert starts[2021]["A"] > 1600.0  # 2020's win was applied before 2021 started
