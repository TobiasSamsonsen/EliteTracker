import math

import pytest

from elitetracker.model.elo import (
    MODEL_VERSION,
    EloConfig,
    actual_score,
    draw_probability,
    expected_score,
    update,
    updated_pair,
)


class TestExpectedScore:
    def test_equal_ratings_give_an_even_match(self):
        assert expected_score(1500, 1500) == pytest.approx(0.5)

    def test_four_hundred_points_is_ten_to_one(self):
        """The defining property of the ELO scale."""
        assert expected_score(1900, 1500) == pytest.approx(10 / 11)
        assert expected_score(1500, 1900) == pytest.approx(1 / 11)

    def test_expectations_are_complementary(self):
        assert expected_score(1650, 1450) + expected_score(1450, 1650) == pytest.approx(1.0)

    def test_stronger_team_is_always_favoured(self):
        assert expected_score(1600, 1500) > 0.5
        assert expected_score(1400, 1500) < 0.5

    def test_only_the_difference_matters(self):
        assert expected_score(1700, 1600) == pytest.approx(expected_score(1400, 1300))

    def test_bounded_between_zero_and_one(self):
        assert 0.0 < expected_score(1300, 2500) < 1.0
        assert 0.0 < expected_score(2500, 1300) < 1.0


class TestActualScore:
    def test_home_win(self):
        assert actual_score(2, 1) == 1.0

    def test_away_win(self):
        assert actual_score(1, 2) == 0.0

    def test_draw(self):
        assert actual_score(1, 1) == 0.5

    def test_goalless_draw(self):
        assert actual_score(0, 0) == 0.5

    def test_margin_is_ignored_in_v1(self):
        assert actual_score(5, 0) == actual_score(1, 0)


class TestUpdate:
    def test_meeting_expectations_leaves_the_rating_alone(self):
        assert update(1500, expected=0.5, actual=0.5, k_factor=20) == pytest.approx(1500)

    def test_winning_more_than_expected_raises_the_rating(self):
        assert update(1500, expected=0.25, actual=1.0, k_factor=20) == pytest.approx(1515)

    def test_losing_lowers_the_rating(self):
        assert update(1500, expected=0.75, actual=0.0, k_factor=20) == pytest.approx(1485)

    def test_k_factor_scales_the_movement(self):
        small = update(1500, 0.5, 1.0, k_factor=10) - 1500
        large = update(1500, 0.5, 1.0, k_factor=40) - 1500
        assert large == pytest.approx(4 * small)

    def test_beating_a_favourite_moves_more_than_beating_a_minnow(self):
        upset = update(1500, expected=0.1, actual=1.0, k_factor=20) - 1500
        routine = update(1500, expected=0.9, actual=1.0, k_factor=20) - 1500
        assert upset > routine


class TestUpdatedPair:
    def test_ratings_are_zero_sum(self):
        home, away = updated_pair(1500, 1500, 3, 0, EloConfig())
        assert home + away == pytest.approx(3000)

    def test_home_advantage_lowers_the_reward_for_winning_at_home(self):
        with_advantage = updated_pair(1500, 1500, 1, 0, EloConfig(home_advantage=100))[0]
        without = updated_pair(1500, 1500, 1, 0, EloConfig(home_advantage=0))[0]
        assert with_advantage < without

    def test_home_advantage_makes_an_away_win_more_valuable(self):
        _, away = updated_pair(1500, 1500, 0, 1, EloConfig(home_advantage=100))
        _, away_neutral = updated_pair(1500, 1500, 0, 1, EloConfig(home_advantage=0))
        assert away > away_neutral

    def test_an_even_draw_at_home_costs_the_home_team(self):
        """With home advantage the home side is favoured, so a draw underperforms."""
        home, away = updated_pair(1500, 1500, 1, 1, EloConfig(home_advantage=75))
        assert home < 1500
        assert away > 1500

    def test_a_draw_between_equals_on_neutral_terms_changes_nothing(self):
        home, away = updated_pair(1500, 1500, 0, 0, EloConfig(home_advantage=0))
        assert (home, away) == pytest.approx((1500, 1500))

    def test_margin_of_victory_is_ignored_in_v1(self):
        assert updated_pair(1500, 1500, 1, 0, EloConfig()) == updated_pair(1500, 1500, 6, 0, EloConfig())


class TestDrawProbability:
    def test_peaks_for_evenly_matched_teams(self):
        config = EloConfig(draw_base=0.22)
        assert draw_probability(0, config) == pytest.approx(0.22)

    def test_falls_away_as_the_mismatch_grows(self):
        config = EloConfig()
        values = [draw_probability(gap, config) for gap in (0, 100, 200, 400, 800)]
        assert values == sorted(values, reverse=True)

    def test_symmetric_in_the_favourite(self):
        config = EloConfig()
        assert draw_probability(250, config) == pytest.approx(draw_probability(-250, config))

    def test_approaches_zero_for_a_total_mismatch(self):
        assert draw_probability(2000, EloConfig()) < 1e-6


class TestConfig:
    def test_defaults_are_documented_values(self):
        config = EloConfig()
        assert (config.k_factor, config.home_advantage) == (20.0, 75.0)

    @pytest.mark.parametrize(
        "kwargs",
        [{"k_factor": 0}, {"k_factor": -5}, {"draw_base": 1.5}, {"draw_base": -0.1}, {"draw_scale": 0}],
    )
    def test_invalid_parameters_are_rejected(self, kwargs):
        with pytest.raises(ValueError):
            EloConfig(**kwargs)

    def test_model_version_is_declared(self):
        assert MODEL_VERSION == "elo-v1"


class TestCalibration:
    def test_default_home_advantage_matches_the_observed_edge(self):
        """2026 to date: home sides averaged an expected score of ~0.61."""
        implied = expected_score(1500 + EloConfig().home_advantage, 1500)
        assert implied == pytest.approx(0.61, abs=0.02)

    def test_implied_home_advantage_in_rating_points(self):
        observed = 0.61
        gap = -400 * math.log10(1 / observed - 1)
        assert gap == pytest.approx(EloConfig().home_advantage, abs=10)
