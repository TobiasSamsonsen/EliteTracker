"""Tests for the walk-forward backtest harness and the shared season replay."""

import math

import pytest

from elitetracker.model.backtest import walk_forward
from elitetracker.model.career import SeasonSlice, replay
from elitetracker.model.elo import EloConfig, era_config
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

    def test_league_filter_scores_only_that_league(self):
        slices = _slices() + [SeasonSlice("second", "Second", 2020, [_match("m5", "E", "F", 1, 0)])]
        seeds = {**_seeds(), "E": 1500.0, "F": 1500.0}
        card = walk_forward(slices, seeds, EloConfig(), score_from_season=2020, league="top")
        assert card.matches == 4  # only top-league matches scored


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


class TestEraSwitch:
    """`config_for(league, season)` is how a match picks its Elo config."""

    def _slices_three_seasons(self):
        return [
            SeasonSlice("eliteserien", "Eliteserien", 2021, [
                _match("m21", "A", "B", 2, 0, "2021-04-01"),
            ]),
            SeasonSlice("eliteserien", "Eliteserien", 2022, [
                _match("m22", "B", "A", 1, 0, "2022-04-01"),
            ]),
            SeasonSlice("eliteserien", "Eliteserien", 2023, [
                _match("m23", "A", "B", 0, 1, "2023-04-01"),
            ]),
        ]

    def _cards(self, boundary_season, boundary_league):
        slices = self._slices_three_seasons()
        seeds = {"A": 1600.0, "B": 1400.0}
        legacy, modern = EloConfig(k_factor=10), EloConfig(k_factor=50)

        def config_for(league, season):
            return modern if season >= boundary_season and league == boundary_league else legacy

        return (
            walk_forward(slices, seeds, legacy, score_from_season=2021, config_for=config_for),
            walk_forward(slices, seeds, legacy, score_from_season=2021,
                         config_for=lambda league, season: legacy),
        )

    def test_modern_config_used_when_boundary_matches(self):
        switched, legacy_only = self._cards(2022, "eliteserien")
        # K=50 on 2022 moves ratings more than K=10, so 2023 predictions differ
        assert switched.log_loss != legacy_only.log_loss

    def test_legacy_config_used_when_boundary_season_misses(self):
        switched, legacy_only = self._cards(2023, "eliteserien")
        assert switched.log_loss == legacy_only.log_loss  # 2023 is scored on pre-match ratings

    def test_legacy_config_used_when_boundary_league_misses(self):
        switched, legacy_only = self._cards(2022, "obosligaen")
        assert switched.log_loss == legacy_only.log_loss

    def test_the_switch_is_per_match_not_per_season(self):
        """A modern Eliteserien season must not drag its OBOS twin along."""
        slices = [
            SeasonSlice("eliteserien", "Eliteserien", 2022, [_match("e", "A", "B", 1, 0, "2022-04-01")]),
            SeasonSlice("obosligaen", "OBOS-ligaen", 2022, [_match("o", "C", "D", 1, 0, "2022-04-02")]),
            SeasonSlice("obosligaen", "OBOS-ligaen", 2023, [_match("o2", "D", "C", 1, 0, "2023-04-01")]),
        ]
        seeds = {"A": 1600.0, "B": 1400.0, "C": 1600.0, "D": 1400.0}
        legacy, modern = EloConfig(k_factor=10), EloConfig(k_factor=50)
        switched = walk_forward(
            slices, seeds, legacy, score_from_season=2023,
            config_for=lambda league, season: modern if league == "eliteserien" else legacy,
        )
        legacy_only = walk_forward(slices, seeds, legacy, score_from_season=2023,
                                   config_for=lambda league, season: legacy)
        assert switched.log_loss == legacy_only.log_loss

    def test_default_is_the_shipped_era_switch(self):
        slices = self._slices_three_seasons()
        seeds = {"A": 1600.0, "B": 1400.0}
        config = EloConfig(k_factor=10)
        default = walk_forward(slices, seeds, config, score_from_season=2021)
        explicit = walk_forward(slices, seeds, config, score_from_season=2021,
                                config_for=lambda league, season: era_config(season, config))
        assert default.log_loss == explicit.log_loss
