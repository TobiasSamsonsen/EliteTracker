import pytest

from elitetracker.normalize.standings import Standing, dump_standings, load_standings
from elitetracker.validation.standings import validate


def table(team_count=4):
    """A self-consistent table: every team draws every match, home and away."""
    per_team = 2 * (team_count - 1)
    rows = []
    for index in range(team_count):
        rows.append(
            Standing(
                position=index + 1,
                team=f"Team {chr(ord('A') + index)}",
                team_id=str(100 + index),
                played=per_team,
                wins=0,
                draws=per_team,
                losses=0,
                goals_for=per_team,
                goals_against=per_team,
                points=per_team,
            )
        )
    return rows


def replace(row, **changes):
    return Standing(**{**row.__dict__, **changes})


class TestHealthyTable:
    def test_consistent_table_passes(self):
        report = validate(table(4), expected_teams=4)
        assert report.ok, report.errors

    def test_empty_table_fails(self):
        assert not validate([], expected_teams=4).ok


class TestRowArithmetic:
    def test_results_must_sum_to_played(self):
        rows = table(4)
        rows[0] = replace(rows[0], wins=1)
        report = validate(rows, expected_teams=4)
        assert any("does not sum to" in e for e in report.errors)

    def test_points_must_match_results(self):
        rows = table(4)
        rows[0] = replace(rows[0], points=99)
        report = validate(rows, expected_teams=4)
        assert any("implies" in e for e in report.errors)

    def test_deduction_is_accounted_for(self):
        """Raufoss 2025: 7W 9D = 30 points, docked 1, published as 29."""
        row = Standing(
            position=1, team="Raufoss", team_id="9812", played=30, wins=7, draws=9,
            losses=14, goals_for=43, goals_against=56, points=29, deduction=-1,
        )
        report = validate([row], expected_teams=1)
        assert not any("implies" in e for e in report.errors)

    def test_ignoring_a_deduction_is_caught(self):
        row = Standing(
            position=1, team="Raufoss", team_id="9812", played=30, wins=7, draws=9,
            losses=14, goals_for=43, goals_against=56, points=29, deduction=0,
        )
        report = validate([row], expected_teams=1)
        assert any("implies" in e for e in report.errors)

    def test_positive_deduction_is_rejected(self):
        rows = table(4)
        rows[0] = replace(rows[0], deduction=1, points=rows[0].points + 1)
        report = validate(rows, expected_teams=4)
        assert any("should be negative or zero" in e for e in report.errors)

    def test_negative_tally_is_rejected(self):
        rows = table(4)
        rows[0] = replace(rows[0], goals_for=-1)
        report = validate(rows, expected_teams=4)
        assert any("negative tally" in e for e in report.errors)


class TestTableShape:
    def test_wrong_team_count_is_rejected(self):
        report = validate(table(4), expected_teams=16)
        assert any("expected 16 teams" in e for e in report.errors)

    def test_positions_must_be_contiguous(self):
        rows = table(4)
        rows[2] = replace(rows[2], position=9)
        report = validate(rows, expected_teams=4)
        assert any("positions are not" in e for e in report.errors)

    def test_duplicate_team_id_is_rejected(self):
        rows = table(4)
        rows[1] = replace(rows[1], team_id=rows[0].team_id)
        report = validate(rows, expected_teams=4)
        assert any("duplicate team id" in e for e in report.errors)

    def test_duplicate_team_name_is_rejected(self):
        rows = table(4)
        rows[1] = replace(rows[1], team=rows[0].team)
        report = validate(rows, expected_teams=4)
        assert any("duplicate team name" in e for e in report.errors)

    def test_incomplete_season_is_rejected(self):
        rows = [replace(row, played=row.played - 1, draws=row.draws - 1, points=row.points - 1,
                        goals_for=row.goals_for - 1, goals_against=row.goals_against - 1)
                for row in table(4)]
        report = validate(rows, expected_teams=4)
        assert any("matches per team" in e for e in report.errors)


class TestLeagueTotals:
    def test_wins_must_equal_losses(self):
        rows = table(4)
        rows[0] = replace(rows[0], wins=1, draws=rows[0].draws - 1, points=rows[0].points + 2)
        report = validate(rows, expected_teams=4)
        assert any("wins but" in e for e in report.errors)

    def test_goals_scored_must_equal_goals_conceded(self):
        rows = table(4)
        rows[0] = replace(rows[0], goals_for=rows[0].goals_for + 5)
        report = validate(rows, expected_teams=4)
        assert any("conceded league-wide" in e for e in report.errors)


class TestOrder:
    def test_team_placed_above_a_higher_scorer_is_rejected(self):
        rows = [
            Standing(1, "A", "1", 2, 0, 2, 0, 2, 2, 2),
            Standing(2, "B", "2", 2, 1, 1, 0, 3, 2, 4),
        ]
        report = validate(rows, expected_teams=2)
        assert any("is placed above" in e for e in report.errors)

    def test_level_teams_with_inverted_goal_difference_warn_only(self):
        rows = [
            Standing(1, "A", "1", 2, 0, 2, 0, 1, 3, 2),
            Standing(2, "B", "2", 2, 0, 2, 0, 3, 1, 2),
        ]
        report = validate(rows, expected_teams=2)
        assert any("goal difference" in w for w in report.warnings)


class TestRoundTrip:
    def test_standings_survive_dump_and_load(self, tmp_path):
        path = tmp_path / "standings.json"
        original = table(4)
        dump_standings(original, path)
        assert load_standings(path) == original

    def test_dump_includes_derived_goal_difference(self, tmp_path):
        import json

        path = tmp_path / "standings.json"
        dump_standings([Standing(1, "A", "1", 2, 0, 2, 0, 5, 3, 2)], path)
        record = json.loads(path.read_text(encoding="utf-8"))[0]
        assert record["goal_difference"] == 2

    def test_load_rejects_non_list(self, tmp_path):
        path = tmp_path / "standings.json"
        path.write_text("{}", encoding="utf-8")
        with pytest.raises(ValueError):
            load_standings(path)
