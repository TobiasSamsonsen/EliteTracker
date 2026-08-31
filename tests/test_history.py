import pytest

from elitetracker.model.initial_ratings import TeamRating
from elitetracker.normalize.matches import Match
from elitetracker.simulation.history import (
    HistoryConfig,
    as_of_date,
    build_history,
    snapshot_dates,
)

FAST = HistoryConfig(simulations=60)


def match(match_id, home, away, date, round_number=None, score=None):
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
        round=round_number,
        home_id=home,
        away_id=away,
    )


def two_team_season(played=2, total=4):
    """Matches on 1..total March, the first `played` of them completed."""
    return [
        match(day, "A", "B", f"2026-03-{day:02d}", round_number=day, score=(2, 0) if day <= played else None)
        for day in range(1, total + 1)
    ]


SEEDS = {
    "A": TeamRating("A", "A", 1500, "seed"),
    "B": TeamRating("B", "B", 1500, "seed"),
}


class TestAsOfDate:
    def test_later_matches_revert_to_unplayed(self):
        rewound = as_of_date(two_team_season(), "2026-03-01")
        assert [m.played for m in rewound] == [True, False, False, False]

    def test_the_boundary_date_is_included(self):
        """A snapshot is the state at the *end* of its day."""
        rewound = as_of_date(two_team_season(), "2026-03-02")
        assert [m.played for m in rewound] == [True, True, False, False]

    def test_scores_are_cleared_when_rewound(self):
        later = as_of_date(two_team_season(), "2026-03-01")[1]
        assert (later.home_goals, later.away_goals) == (None, None)

    def test_earlier_matches_are_untouched(self):
        original = two_team_season()
        rewound = as_of_date(original, "2026-03-02")
        assert rewound[:2] == original[:2]

    def test_rewinding_before_the_season_clears_everything(self):
        assert all(not m.played for m in as_of_date(two_team_season(), "2026-01-01"))

    def test_the_fixture_list_never_shrinks(self):
        """Snapshots stay comparable only if every one simulates a full season."""
        original = two_team_season()
        for day in range(1, 6):
            assert len(as_of_date(original, f"2026-03-{day:02d}")) == len(original)

    def test_out_of_order_rounds_are_rewound_by_date_not_round(self):
        """Round 12 of Eliteserien 2026 is played after rounds 13-16."""
        games = [
            match("late-round", "A", "B", "2026-08-01", round_number=12, score=(1, 0)),
            match("early-round", "A", "B", "2026-05-01", round_number=16, score=(0, 1)),
        ]
        rewound = as_of_date(games, "2026-06-01")
        assert [m.played for m in rewound] == [False, True]


class TestSnapshotDates:
    def test_includes_preseason_then_every_match_day(self):
        assert snapshot_dates(two_team_season(played=3, total=5), 20) == [
            "2026-02-28", "2026-03-01", "2026-03-02", "2026-03-03",
        ]

    def test_preseason_is_the_day_before_the_first_match(self):
        assert snapshot_dates(two_team_season(), 20)[0] == "2026-02-28"

    def test_dates_are_chronological(self):
        dates = snapshot_dates(two_team_season(played=4, total=4), 20)
        assert dates == sorted(dates)

    def test_several_matches_on_one_day_give_one_snapshot(self):
        games = [
            match(1, "A", "B", "2026-03-01", score=(1, 0)),
            match(2, "C", "D", "2026-03-01", score=(2, 2)),
        ]
        assert snapshot_dates(games, 20) == ["2026-02-28", "2026-03-01"]

    def test_nothing_played_gives_no_snapshots(self):
        assert snapshot_dates(two_team_season(played=0), 20) == []

    def test_thinning_respects_the_cap(self):
        games = [
            match(day, "A", "B", f"2026-03-{day:02d}", score=(1, 0)) for day in range(1, 29)
        ]
        picked = snapshot_dates(games, 6)
        assert len(picked) <= 7
        assert picked[0] == "2026-02-28"
        assert picked[-1] == "2026-03-28"

    def test_thinning_keeps_dates_ordered_and_unique(self):
        games = [
            match(day, "A", "B", f"2026-03-{day:02d}", score=(1, 0)) for day in range(1, 29)
        ]
        picked = snapshot_dates(games, 6)
        assert picked == sorted(set(picked))


class TestBuildHistory:
    def test_one_snapshot_per_sampled_date(self):
        games = two_team_season()
        history = build_history(games, games, SEEDS, config=FAST)
        assert [s.date for s in history] == ["2026-02-28", "2026-03-01", "2026-03-02"]

    def test_each_snapshot_is_a_probability_distribution(self):
        games = two_team_season()
        for snapshot in build_history(games, games, SEEDS, config=FAST):
            for probabilities in snapshot.positions.values():
                assert sum(probabilities) == pytest.approx(1.0)

    def test_preseason_snapshot_has_nothing_played(self):
        history = build_history(two_team_season(), two_team_season(), SEEDS, config=FAST)
        assert history[0].matches_played == 0
        assert history[0].latest_round is None

    def test_matches_played_grows_with_the_season(self):
        games = two_team_season()
        counts = [s.matches_played for s in build_history(games, games, SEEDS, config=FAST)]
        assert counts == [0, 1, 2]

    def test_preseason_ratings_are_the_seeds(self):
        history = build_history(two_team_season(), two_team_season(), SEEDS, config=FAST)
        assert history[0].ratings == pytest.approx({"A": 1500, "B": 1500})

    def test_a_winning_team_climbs_across_snapshots(self):
        games = two_team_season(played=4, total=4)
        ratings = [s.ratings["A"] for s in build_history(games, games, SEEDS, config=FAST)]
        assert ratings == sorted(ratings)
        assert ratings[-1] > ratings[0]

    def test_latest_round_reports_the_furthest_round_played(self):
        games = [
            match(1, "A", "B", "2026-03-01", round_number=5, score=(1, 0)),
            match(2, "A", "B", "2026-03-02", round_number=2, score=(0, 1)),
        ]
        history = build_history(games, games, SEEDS, config=FAST)
        # Round 2 was played last, but round 5 is still the furthest reached.
        assert [s.latest_round for s in history] == [None, 5, 5]

    def test_the_final_snapshot_matches_a_direct_simulation(self):
        from elitetracker.model.ratings import build_rating_table
        from elitetracker.simulation.season import SimulationConfig, simulate_season

        games = two_team_season()
        history = build_history(games, games, SEEDS, config=FAST)

        ratings = build_rating_table(SEEDS, games)
        direct = simulate_season(
            games, ratings, config=SimulationConfig(simulations=FAST.simulations, seed=FAST.seed)
        )
        for team in direct.teams:
            assert history[-1].positions[team.team_id] == pytest.approx(team.position_probabilities)

    def test_ratings_span_both_divisions(self):
        """Only the league's own matches are simulated, but ratings see everything."""
        league = two_team_season()
        other = [
            match(f"o{day}", "C", "D", f"2026-03-{day:02d}", score=(3, 0)) for day in range(1, 3)
        ]
        history = build_history(league, league + other, SEEDS, config=FAST)
        assert set(history[-1].positions) == {"A", "B"}

    def test_is_reproducible(self):
        games = two_team_season()
        first = build_history(games, games, SEEDS, config=FAST)
        second = build_history(games, games, SEEDS, config=FAST)
        assert [s.positions for s in first] == [s.positions for s in second]

    def test_no_played_matches_gives_no_history(self):
        games = two_team_season(played=0)
        assert build_history(games, games, SEEDS, config=FAST) == []

    @pytest.mark.parametrize("kwargs", [{"simulations": 0}, {"max_snapshots": 1}])
    def test_invalid_config_is_rejected(self, kwargs):
        with pytest.raises(ValueError):
            HistoryConfig(**kwargs)
