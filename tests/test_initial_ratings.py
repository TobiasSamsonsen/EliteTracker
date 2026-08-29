import pytest

from elitetracker.model.initial_ratings import (
    SECOND_TIER,
    TOP_TIER,
    SeedingConfig,
    equivalent_rank,
    initial_ratings,
    rating_for_rank,
    rating_for_unseeded_team,
)
from elitetracker.normalize.standings import Standing


def table(team_count=16, prefix="T"):
    """A final table where position n has 30-n points."""
    return [
        Standing(
            position=position,
            team=f"{prefix}{position}",
            team_id=f"{prefix}{position}",
            played=30,
            wins=0,
            draws=0,
            losses=30,
            goals_for=0,
            goals_against=0,
            points=0,
        )
        for position in range(1, team_count + 1)
    ]


class TestEquivalentRank:
    def test_top_tier_maps_to_itself(self):
        assert equivalent_rank(1, TOP_TIER, SeedingConfig()) == 1
        assert equivalent_rank(16, TOP_TIER, SeedingConfig()) == 16

    def test_second_tier_is_shifted_down(self):
        assert equivalent_rank(1, SECOND_TIER, SeedingConfig(division_offset=10)) == 11

    def test_offset_is_configurable(self):
        assert equivalent_rank(1, SECOND_TIER, SeedingConfig(division_offset=4)) == 5

    def test_invalid_position_is_rejected(self):
        with pytest.raises(ValueError):
            equivalent_rank(0, TOP_TIER, SeedingConfig())

    def test_unknown_tier_is_rejected(self):
        with pytest.raises(ValueError, match="unknown tier"):
            equivalent_rank(1, 3, SeedingConfig())


class TestRatingForRank:
    def test_best_rank_gets_the_ceiling(self):
        assert rating_for_rank(1, 26, SeedingConfig()) == pytest.approx(1670)

    def test_worst_rank_gets_the_floor(self):
        assert rating_for_rank(26, 26, SeedingConfig()) == pytest.approx(1330)

    def test_spacing_is_uniform(self):
        config = SeedingConfig()
        gaps = [
            rating_for_rank(rank, 26, config) - rating_for_rank(rank + 1, 26, config)
            for rank in range(1, 26)
        ]
        assert all(gap == pytest.approx(gaps[0]) for gap in gaps)

    def test_single_team_ladder(self):
        assert rating_for_rank(1, 1, SeedingConfig()) == pytest.approx(1670)


class TestInitialRatings:
    def test_ratings_span_exactly_the_target_range(self):
        """The seed ladder spans its configured best/worst ratings."""
        ratings = initial_ratings(table(), table(prefix="O"))
        values = [rating.rating for rating in ratings.values()]
        assert max(values) == pytest.approx(1670)
        assert min(values) == pytest.approx(1330)

    def test_every_team_from_both_divisions_is_seeded(self):
        ratings = initial_ratings(table(), table(prefix="O"))
        assert len(ratings) == 32

    def test_order_follows_finishing_position(self):
        ratings = initial_ratings(table(), [])
        values = [ratings[f"T{position}"].rating for position in range(1, 17)]
        assert values == sorted(values, reverse=True)

    def test_second_tier_champion_outranks_the_relegated_side(self):
        """The point of the division offset: a promoted champion is not the worst team."""
        ratings = initial_ratings(table(), table(prefix="O"))
        assert ratings["O1"].rating > ratings["T16"].rating

    def test_second_tier_champion_still_trails_the_top_flight_champion(self):
        ratings = initial_ratings(table(), table(prefix="O"))
        assert ratings["O1"].rating < ratings["T1"].rating

    def test_zero_offset_makes_the_divisions_equivalent(self):
        ratings = initial_ratings(table(), table(prefix="O"), config=SeedingConfig(division_offset=0))
        assert ratings["O1"].rating == pytest.approx(ratings["T1"].rating)

    def test_is_deterministic(self):
        assert initial_ratings(table(), table(prefix="O")) == initial_ratings(table(), table(prefix="O"))

    def test_source_explains_the_rating(self):
        ratings = initial_ratings(table(), table(prefix="O"))
        assert ratings["T1"].source == "Eliteserien 2025 #1"
        assert ratings["O4"].source == "OBOS-ligaen 2025 #4"

    def test_empty_input(self):
        assert initial_ratings([], []) == {}

    def test_top_tier_only(self):
        ratings = initial_ratings(table(), [])
        assert max(r.rating for r in ratings.values()) == pytest.approx(1670)
        assert min(r.rating for r in ratings.values()) == pytest.approx(1330)


class TestUnseededTeams:
    def test_a_third_tier_promotion_starts_at_the_floor(self):
        assert rating_for_unseeded_team() == pytest.approx(1330)

    def test_respects_a_custom_floor(self):
        assert rating_for_unseeded_team(SeedingConfig(worst_rating=1200)) == pytest.approx(1200)


class TestSeedingConfig:
    def test_inverted_range_is_rejected(self):
        with pytest.raises(ValueError, match="must exceed"):
            SeedingConfig(best_rating=1300, worst_rating=1700)

    def test_negative_offset_is_rejected(self):
        with pytest.raises(ValueError, match="must not be negative"):
            SeedingConfig(division_offset=-1)
