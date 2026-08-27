"""Tests for the walk-forward backtest harness and the regression model."""

from elitetracker.model.backtest import (
    RatingModel,
    RegressionRatingModel,
    walk_forward,
)
from elitetracker.model.elo import EloConfig
from elitetracker.normalize.matches import Match


def _match(match_id, home, away, home_goals, away_goals, date="2020-03-01"):
    return Match(
        match_id=match_id,
        date=date,
        time="18:00",
        home=home,
        away=away,
        venue=None,
        home_goals=home_goals,
        away_goals=away_goals,
        played=True,
        home_id=home,
        away_id=away,
    )


def _seasons():
    # Season 1: A beats B, C beats D. Season 2: B beats A, D beats C.
    return [
        (
            2020,
            [
                _match("m1", "A", "B", 2, 0),
                _match("m2", "C", "D", 1, 0),
            ],
        ),
        (
            2021,
            [
                _match("m3", "B", "A", 2, 1),
                _match("m4", "D", "C", 2, 0),
            ],
        ),
    ]


def _seeds():
    return {"A": 1600.0, "B": 1400.0, "C": 1600.0, "D": 1400.0}


class TestWalkForwardScoringWindow:
    def test_only_scores_from_the_requested_season(self):
        card = walk_forward(_seasons(), _seeds(), RatingModel(EloConfig()), score_from_season=2021)
        assert card.matches == 2  # only the two 2021 matches are scored

    def test_scores_everything_when_window_reaches_back(self):
        card = walk_forward(_seasons(), _seeds(), RatingModel(EloConfig()), score_from_season=2020)
        assert card.matches == 4

    def test_reports_finite_loss_and_calibration(self):
        card = walk_forward(_seasons(), _seeds(), RatingModel(EloConfig()), score_from_season=2020)
        assert card.log_loss > 0 and card.log_loss < 10
        assert 0.0 <= card.calibration_error() <= 1.0


class TestRegressionModel:
    def test_no_regression_on_the_first_season(self):
        model = RegressionRatingModel(EloConfig(season_regression=0.5))
        model.seed({"A": 1700.0, "B": 1300.0})
        model.start_season(2020)
        assert model.ratings["A"] == 1700.0
        assert model.ratings["B"] == 1300.0

    def test_pulls_ratings_toward_the_mean_at_the_offseason(self):
        model = RegressionRatingModel(EloConfig(season_regression=0.95))
        model.seed({"A": 1700.0, "B": 1300.0})
        model.start_season(2020)
        model.start_season(2021)  # second call is the offseason pull
        assert model.ratings["A"] == 1500.0 + 0.95 * 200.0
        assert model.ratings["B"] == 1500.0 + 0.95 * (-200.0)

    def test_factor_of_one_is_a_no_op(self):
        model = RegressionRatingModel(EloConfig(season_regression=1.0))
        model.seed({"A": 1700.0, "B": 1300.0})
        model.start_season(2020)
        model.start_season(2021)
        assert model.ratings["A"] == 1700.0
        assert model.ratings["B"] == 1300.0
