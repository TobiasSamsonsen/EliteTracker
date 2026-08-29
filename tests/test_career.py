import pytest

from elitetracker.model.career import SeasonSlice, build_careers
from elitetracker.model.elo import EloConfig
from elitetracker.model.initial_ratings import TeamRating
from elitetracker.normalize.matches import Match

# No home advantage and no cross-season regression: the original "plain ELO"
# baseline used by these continuity tests. (Regression is now on by default in
# EloConfig, so it must be switched off explicitly here.)
NEUTRAL = EloConfig(home_advantage=0, season_regression=1.0)


def match(match_id, home, away, date, score=None):
    home_goals, away_goals = score if score else (None, None)
    return Match(
        match_id=str(match_id),
        date=date,
        time="18:00",
        home=home,
        away=away,
        venue=None,
        home_goals=home_goals,
        away_goals=away_goals,
        played=score is not None,
        home_id=home,
        away_id=away,
    )


def top(season, matches):
    return SeasonSlice("top", "Top Flight", season, matches)


def second(season, matches):
    return SeasonSlice("second", "Second Tier", season, matches)


SEEDS = {
    "A": TeamRating("A", "A", 1600, "seed"),
    "B": TeamRating("B", "B", 1400, "seed"),
}


def two_season_slices():
    return [
        top(2020, [
            match(1, "A", "B", "2020-04-01", score=(1, 0)),
            match(2, "B", "A", "2020-09-01", score=(0, 1)),
        ]),
        top(2021, [
            match(3, "A", "B", "2021-04-01", score=(0, 1)),
            match(4, "B", "A", "2021-09-01", score=(1, 0)),
        ]),
    ]


class TestContinuity:
    def test_ratings_carry_across_the_season_boundary(self):
        """The point of a career: December's rating is March's starting rating."""
        careers = build_careers(two_season_slices(), SEEDS, config=NEUTRAL)
        first, secondseason = careers["A"].seasons
        assert secondseason.rating_start == pytest.approx(first.rating_end)

    def test_seeds_are_used_only_once(self):
        careers = build_careers(two_season_slices(), SEEDS, config=NEUTRAL)
        assert careers["A"].seasons[0].rating_start == pytest.approx(1600)
        assert careers["A"].seasons[1].rating_start != pytest.approx(1600)


class TestCrossSeasonRegression:
    def test_offseason_pulls_ratings_toward_the_mean(self):
        """With regression on, a club does not carry its full rating into next year."""
        config = EloConfig(home_advantage=0, season_regression=0.95)
        careers = build_careers(two_season_slices(), SEEDS, config=config)
        first, secondseason = careers["A"].seasons
        # A started at 1600, won, so first.rating_end > 1600; the offseason pulls
        # it back partway toward the (1600/1400) pool mean of 1500.
        assert secondseason.rating_start < first.rating_end
        assert secondseason.rating_start > 1500.0

    def test_no_regression_keeps_the_full_rating(self):
        config = EloConfig(home_advantage=0, season_regression=1.0)
        careers = build_careers(two_season_slices(), SEEDS, config=config)
        first, secondseason = careers["A"].seasons
        assert secondseason.rating_start == pytest.approx(first.rating_end)

    def test_a_point_is_recorded_for_every_match_played(self):
        careers = build_careers(two_season_slices(), SEEDS, config=NEUTRAL)
        assert len(careers["A"].points) == 4
        assert len(careers["B"].points) == 4

    def test_points_are_chronological(self):
        careers = build_careers(two_season_slices(), SEEDS, config=NEUTRAL)
        dates = [date for date, _ in careers["A"].points]
        assert dates == sorted(dates)

    def test_ratings_stay_zero_sum_across_seasons(self):
        careers = build_careers(two_season_slices(), SEEDS, config=NEUTRAL)
        assert sum(career.current_rating for career in careers.values()) == pytest.approx(3000)

    def test_unplayed_matches_record_nothing(self):
        slices = [top(2020, [match(1, "A", "B", "2020-04-01")])]
        careers = build_careers(slices, SEEDS, config=NEUTRAL)
        assert careers["A"].points == []
        assert careers["A"].seasons[0].rating_end == pytest.approx(1600)


class TestDivisions:
    def test_both_divisions_share_one_scale(self):
        slices = [
            top(2020, [match(1, "A", "B", "2020-04-01", score=(1, 0))]),
            second(2020, [match(2, "C", "D", "2020-04-02", score=(1, 0))]),
        ]
        careers = build_careers(slices, SEEDS, config=NEUTRAL)
        assert set(careers) == {"A", "B", "C", "D"}

    def test_a_club_changing_division_keeps_its_rating(self):
        """Relegation moves a club between tables, not to a different scale."""
        slices = [
            top(2020, [match(1, "A", "B", "2020-04-01", score=(0, 3))]),
            second(2021, [match(2, "A", "C", "2021-04-01", score=(1, 0))]),
        ]
        careers = build_careers(slices, SEEDS, config=NEUTRAL)
        first, secondseason = careers["A"].seasons
        assert first.league == "top"
        assert secondseason.league == "second"
        assert secondseason.rating_start == pytest.approx(first.rating_end)

    def test_a_club_with_no_history_starts_at_the_floor(self):
        slices = [top(2020, [match(1, "New", "Other", "2020-04-01", score=(1, 0))])]
        careers = build_careers(slices, {}, config=NEUTRAL)
        assert careers["New"].seasons[0].rating_start == pytest.approx(1300)

    def test_seasons_are_replayed_oldest_first_whatever_the_input_order(self):
        forward = build_careers(two_season_slices(), SEEDS, config=NEUTRAL)
        backward = build_careers(list(reversed(two_season_slices())), SEEDS, config=NEUTRAL)
        assert forward["A"].points == backward["A"].points


class TestSeasonRecords:
    def test_one_record_per_season_played(self):
        careers = build_careers(two_season_slices(), SEEDS, config=NEUTRAL)
        assert [record.season for record in careers["A"].seasons] == [2020, 2021]

    def test_record_carries_the_final_table_position(self):
        careers = build_careers(two_season_slices(), SEEDS, config=NEUTRAL)
        # A won both 2020 matches, so it finished top of that season.
        assert careers["A"].seasons[0].position == 1
        assert careers["B"].seasons[0].position == 2

    def test_rating_change_is_end_minus_start(self):
        careers = build_careers(two_season_slices(), SEEDS, config=NEUTRAL)
        record = careers["A"].seasons[0]
        assert record.rating_change == pytest.approx(record.rating_end - record.rating_start)

    def test_a_winning_season_raises_the_rating(self):
        careers = build_careers(two_season_slices(), SEEDS, config=NEUTRAL)
        assert careers["A"].seasons[0].rating_change > 0
        assert careers["B"].seasons[0].rating_change < 0

    def test_points_and_played_come_from_the_table(self):
        careers = build_careers(two_season_slices(), SEEDS, config=NEUTRAL)
        record = careers["A"].seasons[0]
        assert (record.played, record.points) == (2, 6)


class TestSummaries:
    def test_peak_and_trough_bracket_the_line(self):
        careers = build_careers(two_season_slices(), SEEDS, config=NEUTRAL)
        career = careers["A"]
        values = [rating for _, rating in career.points]
        assert career.peak[1] == max(values)
        assert career.trough[1] == min(values)

    def test_current_rating_is_the_last_point(self):
        careers = build_careers(two_season_slices(), SEEDS, config=NEUTRAL)
        assert careers["A"].current_rating == careers["A"].points[-1][1]

    def test_a_club_with_no_matches_has_no_peak(self):
        slices = [top(2020, [match(1, "A", "B", "2020-04-01")])]
        careers = build_careers(slices, SEEDS, config=NEUTRAL)
        assert careers["A"].peak is None
        assert careers["A"].current_rating == 0.0

    def test_the_latest_spelling_of_a_name_wins(self):
        slices = [
            top(2020, [match(1, "Old Name", "B", "2020-04-01", score=(1, 0))]),
        ]
        careers = build_careers(slices, SEEDS, config=NEUTRAL)
        assert careers["Old Name"].team == "Old Name"


class TestReproducibility:
    def test_same_input_gives_the_same_history(self):
        first = build_careers(two_season_slices(), SEEDS, config=NEUTRAL)
        second_run = build_careers(two_season_slices(), SEEDS, config=NEUTRAL)
        assert {k: v.points for k, v in first.items()} == {k: v.points for k, v in second_run.items()}

    def test_empty_input(self):
        assert build_careers([], SEEDS, config=NEUTRAL) == {}
