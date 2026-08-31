import pytest
import random

from elitetracker.model.elo import EloConfig, expected_score
from elitetracker.model.initial_ratings import TeamRating
from elitetracker.model.probabilities import match_probabilities
from elitetracker.model.ratings import build_rating_table
from elitetracker.model.scorelines import DEFAULT_SCORELINE_MODEL, ScorelineModel
from elitetracker.model.table import table_from_matches
from elitetracker.normalize.matches import Match
from elitetracker.simulation.season import SimulationConfig, simulate_season

NEUTRAL = EloConfig(home_advantage=0)


def match(match_id, home, away, day=1, score=None, hour=18):
    home_goals, away_goals = score if score else (None, None)
    return Match(
        match_id=str(match_id),
        date=f"2026-03-{day:02d}",
        time=f"{hour:02d}:00",
        home=home,
        away=away,
        venue=None,
        home_goals=home_goals,
        away_goals=away_goals,
        played=score is not None,
        home_id=home,
        away_id=away,
    )


class TestMatchProbabilities:
    def test_probabilities_sum_to_one(self):
        for gap in (-600, -200, 0, 150, 900):
            probabilities = match_probabilities(1500 + gap, 1500)
            total = probabilities.home_win + probabilities.draw + probabilities.away_win
            assert total == pytest.approx(1.0)

    def test_all_probabilities_are_non_negative(self):
        for gap in (-1200, -400, 0, 400, 1200):
            probabilities = match_probabilities(1500 + gap, 1500)
            assert min(probabilities.home_win, probabilities.draw, probabilities.away_win) >= 0.0

    def test_the_elo_expectation_is_preserved(self):
        """P(win) + 0.5*P(draw) must equal the rating-implied expected score."""
        config = EloConfig()
        for gap in (-500, -100, 0, 100, 500):
            probabilities = match_probabilities(1500 + gap, 1500, config)
            expected = expected_score(1500 + gap + config.home_advantage, 1500)
            assert probabilities.expected_home_score == pytest.approx(expected)

    def test_equal_teams_on_neutral_ground_are_symmetric(self):
        probabilities = match_probabilities(1500, 1500, NEUTRAL)
        assert probabilities.home_win == pytest.approx(probabilities.away_win)

    def test_home_advantage_favours_the_home_side(self):
        probabilities = match_probabilities(1500, 1500, EloConfig(home_advantage=75))
        assert probabilities.home_win > probabilities.away_win

    def test_stronger_team_is_favoured(self):
        probabilities = match_probabilities(1700, 1300)
        assert probabilities.home_win > probabilities.away_win

    def test_a_big_mismatch_still_yields_a_valid_distribution(self):
        probabilities = match_probabilities(1300, 2500)
        assert probabilities.away_win > probabilities.home_win
        assert probabilities.home_win >= 0.0
        assert probabilities.home_win + probabilities.draw + probabilities.away_win == pytest.approx(1.0)

    def test_draw_is_most_likely_between_equals(self):
        even = match_probabilities(1500, 1500, NEUTRAL).draw
        lopsided = match_probabilities(1900, 1500, NEUTRAL).draw
        assert even > lopsided

    def test_reversing_the_fixture_mirrors_the_odds(self):
        forward = match_probabilities(1600, 1400, NEUTRAL)
        reverse = match_probabilities(1400, 1600, NEUTRAL)
        assert forward.home_win == pytest.approx(reverse.away_win)
        assert forward.draw == pytest.approx(reverse.draw)

    def test_draw_rate_across_even_fixtures_is_realistic(self):
        """2026 to date drew 16.9% of matches; the default must land near that."""
        gaps = range(-400, 401, 50)
        average = sum(match_probabilities(1500 + gap, 1500).draw for gap in gaps) / len(list(gaps))
        assert 0.10 < average < 0.25


class TestOrderedLogitProbabilities:
    def _config(self, slope=0.0055, cut=0.55):
        return EloConfig(probability_model="ordered_logit", logit_slope=slope,
                         logit_cutpoint=cut)

    def test_probabilities_sum_to_one(self):
        config = self._config()
        for gap in (-600, -200, 0, 150, 900):
            p = match_probabilities(1500 + gap, 1500, config)
            assert p.home_win + p.draw + p.away_win == pytest.approx(1.0)

    def test_all_probabilities_are_non_negative(self):
        config = self._config()
        for gap in (-1200, -400, 0, 400, 1200):
            p = match_probabilities(1500 + gap, 1500, config)
            assert min(p.home_win, p.draw, p.away_win) >= 0.0

    def test_draw_is_even_in_the_gap(self):
        config = EloConfig(probability_model="ordered_logit", logit_slope=0.0055,
                           logit_cutpoint=0.55, home_advantage=0)
        for gap in (100, 300, 500):
            forward = match_probabilities(1500 + gap, 1500, config).draw
            reverse = match_probabilities(1500 - gap, 1500, config).draw
            assert forward == pytest.approx(reverse)

    def test_draw_at_even_match_is_tanh_of_half_the_cutpoint(self):
        import math
        config = EloConfig(probability_model="ordered_logit", logit_slope=0.0055,
                           logit_cutpoint=0.55, home_advantage=0)
        draw = match_probabilities(1500, 1500, config).draw
        assert draw == pytest.approx(math.tanh(0.55 / 2.0), abs=1e-6)

    def test_stronger_home_side_is_favoured_and_monotone(self):
        config = self._config()
        prev = -1.0
        for gap in range(-600, 601, 100):
            p = match_probabilities(1500 + gap, 1500, config)
            assert p.home_win >= prev
            prev = p.home_win

    def test_expectation_does_not_equal_the_elo_score(self):
        """Documented break: ordered logit refits the discrimination, so its
        P(win) + 0.5*P(draw) is no longer the ELO expected_score."""
        config = self._config()
        p = match_probabilities(1700, 1400, config)
        elo_expected = expected_score(1700 + config.home_advantage, 1400)
        assert p.expected_home_score != pytest.approx(elo_expected, abs=1e-3)


class TestRatingTable:
    def test_seeds_are_used_when_no_matches_are_played(self):
        seeds = {"A": TeamRating("A", "A", 1600, "seed"), "B": TeamRating("B", "B", 1400, "seed")}
        table = build_rating_table(seeds, [match(1, "A", "B")])
        assert table["A"] == pytest.approx(1600)

    def test_a_win_raises_the_winner_and_lowers_the_loser(self):
        seeds = {"A": TeamRating("A", "A", 1500, "s"), "B": TeamRating("B", "B", 1500, "s")}
        table = build_rating_table(seeds, [match(1, "A", "B", score=(2, 0))])
        assert table["A"] > 1500 > table["B"]

    def test_total_rating_is_conserved(self):
        seeds = {"A": TeamRating("A", "A", 1500, "s"), "B": TeamRating("B", "B", 1500, "s")}
        table = build_rating_table(seeds, [match(1, "A", "B", score=(2, 0)), match(2, "B", "A", day=2, score=(1, 1))])
        assert sum(table.values()) == pytest.approx(3000)

    def test_unseeded_team_starts_at_the_floor(self):
        table = build_rating_table({}, [match(1, "New", "Other")])
        assert table["New"] == pytest.approx(1330)
        assert table["Other"] == pytest.approx(1330)

    def test_replay_is_chronological_not_input_order(self):
        seeds = {t: TeamRating(t, t, 1500, "s") for t in "ABC"}
        games = [match(1, "A", "B", day=1, score=(1, 0)), match(2, "A", "C", day=2, score=(0, 1))]
        forward = build_rating_table(seeds, games)
        backward = build_rating_table(seeds, list(reversed(games)))
        assert forward == pytest.approx(backward)

    def test_unplayed_matches_do_not_move_ratings(self):
        seeds = {"A": TeamRating("A", "A", 1500, "s"), "B": TeamRating("B", "B", 1500, "s")}
        table = build_rating_table(seeds, [match(1, "A", "B")])
        assert table == pytest.approx({"A": 1500, "B": 1500})

    def test_matches_without_team_ids_are_rejected(self):
        bad = Match("1", "2026-03-01", "18:00", "A", "B", None, None, None, played=False)
        with pytest.raises(ValueError, match="no team ids"):
            build_rating_table({}, [bad])


class TestLiveTable:
    def test_points_are_awarded_correctly(self):
        rows = table_from_matches(
            [match(1, "A", "B", score=(2, 0)), match(2, "A", "C", day=2, score=(1, 1))]
        )
        by_team = {row.team: row for row in rows}
        assert by_team["A"].points == 4
        assert by_team["B"].points == 0
        assert by_team["C"].points == 1

    def test_goal_difference_is_tracked_both_ways(self):
        rows = {r.team: r for r in table_from_matches([match(1, "A", "B", score=(3, 1))])}
        assert rows["A"].goal_difference == 2
        assert rows["B"].goal_difference == -2

    def test_ranking_uses_points_then_goal_difference(self):
        rows = table_from_matches(
            [
                match(1, "A", "C", score=(1, 0)),
                match(2, "B", "D", score=(5, 0)),
                match(3, "C", "A", day=2, score=(0, 0)),
                match(4, "D", "B", day=2, score=(0, 0)),
            ]
        )
        assert [row.team for row in rows][:2] == ["B", "A"]

    def test_teams_with_no_played_matches_still_appear(self):
        rows = table_from_matches([match(1, "A", "B")])
        assert {row.team for row in rows} == {"A", "B"}
        assert all(row.played == 0 for row in rows)


def two_team_season(played=None, remaining=2):
    games = list(played or [])
    games += [match(100 + i, "A", "B", day=10 + i) for i in range(remaining)]
    return games


class TestScorelineModel:
    def test_sample_respects_the_outcome(self):
        """A home_win must never come back as a draw or an away_win, etc."""
        rng = random.Random(1)
        for outcome, sign in (("home_win", 1), ("draw", 0), ("away_win", -1)):
            for _ in range(500):
                home_goals, away_goals = DEFAULT_SCORELINE_MODEL.sample(outcome, rng)
                assert (home_goals - away_goals) * sign > 0 or (
                    outcome == "draw" and home_goals == away_goals
                )

    def test_sample_is_deterministic_for_a_seed(self):
        first = [DEFAULT_SCORELINE_MODEL.sample(o, random.Random(42)) for o in ("home_win", "draw", "away_win")]
        second = [DEFAULT_SCORELINE_MODEL.sample(o, random.Random(42)) for o in ("home_win", "draw", "away_win")]
        assert first == second

    def test_from_matches_builds_the_conditional_distribution(self):
        matches = [
            match(1, "A", "B", score=(2, 1)),
            match(2, "A", "B", score=(1, 1)),
            match(3, "A", "B", score=(0, 2)),
            match(4, "A", "B", score=(2, 1)),
        ]
        model = ScorelineModel.from_matches(matches)
        # (2,1) appears twice among three scored home/away wins plus a draw.
        counts = {}
        rng = random.Random(0)
        for _ in range(3000):
            hg, ag = model.sample("home_win", rng)
            counts[(hg, ag)] = counts.get((hg, ag), 0) + 1
        assert counts[(2, 1)] > counts.get((1, 0), 0)


class TestSimulation:
    def test_position_probabilities_sum_to_one_per_team(self):
        projection = simulate_season(
            two_team_season(), {"A": 1500, "B": 1500}, config=SimulationConfig(simulations=200)
        )
        for team in projection.teams:
            assert sum(team.position_probabilities) == pytest.approx(1.0)

    def test_position_probabilities_sum_to_one_per_position(self):
        projection = simulate_season(
            two_team_season(), {"A": 1500, "B": 1500}, config=SimulationConfig(simulations=200)
        )
        for position in range(len(projection.teams)):
            total = sum(team.position_probabilities[position] for team in projection.teams)
            assert total == pytest.approx(1.0)

    def test_same_seed_reproduces_the_run(self):
        args = (two_team_season(), {"A": 1500, "B": 1500})
        first = simulate_season(*args, config=SimulationConfig(simulations=300, seed=7))
        second = simulate_season(*args, config=SimulationConfig(simulations=300, seed=7))
        assert [t.position_probabilities for t in first.teams] == [
            t.position_probabilities for t in second.teams
        ]

    def test_different_seeds_give_different_runs(self):
        args = (two_team_season(remaining=10), {"A": 1500, "B": 1500})
        first = simulate_season(*args, config=SimulationConfig(simulations=300, seed=1))
        second = simulate_season(*args, config=SimulationConfig(simulations=300, seed=2))
        assert [t.position_probabilities for t in first.teams] != [
            t.position_probabilities for t in second.teams
        ]

    def test_a_completed_season_is_certain(self):
        """With nothing left to play the table is already final."""
        games = [match(1, "A", "B", score=(3, 0)), match(2, "B", "A", day=2, score=(0, 1))]
        projection = simulate_season(games, {"A": 1500, "B": 1500}, config=SimulationConfig(simulations=50))
        winner = next(t for t in projection.teams if t.team == "A")
        assert winner.position_probabilities[0] == pytest.approx(1.0)
        assert projection.matches_remaining == 0

    def test_a_stronger_team_wins_the_title_more_often(self):
        projection = simulate_season(
            two_team_season(remaining=10),
            {"A": 1800, "B": 1300},
            config=SimulationConfig(simulations=500),
        )
        strong = next(t for t in projection.teams if t.team == "A")
        assert strong.position_probabilities[0] > 0.9

    def test_a_big_lead_is_hard_to_overturn(self):
        played = [match(i, "A", "B", day=i, score=(3, 0)) for i in range(1, 6)]
        projection = simulate_season(
            two_team_season(played=played, remaining=1),
            {"A": 1500, "B": 1500},
            config=SimulationConfig(simulations=400),
        )
        leader = next(t for t in projection.teams if t.team == "A")
        assert leader.position_probabilities[0] == pytest.approx(1.0)

    def test_expected_points_lie_between_current_and_maximum(self):
        projection = simulate_season(
            two_team_season(remaining=4), {"A": 1500, "B": 1500}, config=SimulationConfig(simulations=300)
        )
        for team in projection.teams:
            assert team.current_points <= team.expected_points <= team.current_points + 3 * 4

    def test_position_probabilities_sum_to_one(self):
        projection = simulate_season(
            two_team_season(), {"A": 1500, "B": 1500}, config=SimulationConfig(simulations=100)
        )
        for team in projection.teams:
            assert sum(team.position_probabilities) == pytest.approx(1.0)

    def test_missing_rating_is_reported(self):
        with pytest.raises(KeyError, match="no rating"):
            simulate_season(two_team_season(), {"A": 1500}, config=SimulationConfig(simulations=10))

    def test_zero_simulations_is_rejected(self):
        with pytest.raises(ValueError, match="at least 1"):
            SimulationConfig(simulations=0)

    def test_clubs_level_on_points_are_split_on_goal_difference(self):
        """Regression: the tiebreak must not be read off the current table.

        The table is already ordered by points, so using its order as the
        tiebreak lets today's points decide a finish between clubs who end the
        season level -- which is precisely what the tiebreak exists to avoid.

        Here A leads on points but trails on goal difference. B is certain to
        win its last match and draw level, at which point B must finish above A.
        """
        played = [
            match(1, "A", "C", day=1, score=(1, 0)),
            match(2, "A", "D", day=2, score=(1, 0)),
            match(3, "B", "C", day=3, score=(5, 0)),
            match(4, "D", "B", day=4, score=(1, 0)),
        ]
        # A: 6 pts, GD +2.  B: 3 pts, GD +4.
        games = played + [match(5, "B", "C", day=9)]
        projection = simulate_season(
            games,
            {"A": 1500, "B": 2400, "C": 1000, "D": 1500},
            config=SimulationConfig(simulations=400),
        )
        by_team = {team.team: team for team in projection.teams}
        assert by_team["B"].position_probabilities[0] > 0.9
        assert by_team["B"].position_probabilities[0] > by_team["A"].position_probabilities[0]

    def test_goal_difference_moves_within_a_simulation(self):
        """Regression: tied teams must not be split on today's goal difference.

        A and B are level on points and on goal difference going into the last
        round, each facing a weak side. Under the old frozen tiebreak they would
        always be separated by the current table (a fixed name/order tiebreak),
        so one of them would be certain to finish first. With scorelines drawn,
        the two clubs' simulated margins differ, so the title is a toss-up.
        """
        played = [
            match(1, "A", "C", day=1, score=(1, 0)),
            match(2, "B", "D", day=2, score=(1, 0)),
        ]
        # A: 3 pts, GD +1.  B: 3 pts, GD +1.  Each has one game left.
        games = played + [match(3, "A", "D", day=9), match(4, "B", "C", day=9)]
        projection = simulate_season(
            games,
            {"A": 1800, "B": 1800, "C": 1000, "D": 1000},
            config=SimulationConfig(simulations=2000, seed=3),
        )
        by_team = {team.team: team for team in projection.teams}
        for team in ("A", "B"):
            first = by_team[team].position_probabilities[0]
            assert 0.3 < first < 0.7

    def test_a_passed_scoreline_model_reproduces_the_run(self):
        model = ScorelineModel.from_matches(
            [match(i, "A", "B", score=(2, 1)) for i in range(1, 30)]
        )
        args = (two_team_season(remaining=8), {"A": 1500, "B": 1500})
        first = simulate_season(*args, config=SimulationConfig(simulations=300, seed=11), scoreline_model=model)
        second = simulate_season(*args, config=SimulationConfig(simulations=300, seed=11), scoreline_model=model)
        assert [t.position_probabilities for t in first.teams] == [
            t.position_probabilities for t in second.teams
        ]

    def test_counts_of_played_and_remaining(self):
        projection = simulate_season(
            two_team_season(played=[match(1, "A", "B", score=(1, 0))], remaining=3),
            {"A": 1500, "B": 1500},
            config=SimulationConfig(simulations=20),
        )
        assert (projection.matches_played, projection.matches_remaining) == (1, 3)
