import json
from datetime import date

import pytest

from elitetracker.normalize.matches import Match
from elitetracker.validation.matches import load_normalized, validate

TODAY = date(2026, 8, 9)


def make_match(match_id, home, away, day=1, time="18:00", score=None):
    home_goals, away_goals = score if score else (None, None)
    return Match(
        match_id=str(match_id),
        date=f"2026-03-{day:02d}",
        time=time,
        home=home,
        away=away,
        venue="Some Stadium",
        home_goals=home_goals,
        away_goals=away_goals,
        played=score is not None,
    )


def round_robin(team_count=4):
    """A complete, correctly ordered double round-robin for `team_count` teams."""
    teams = [f"Team {chr(ord('A') + i)}" for i in range(team_count)]
    matches, counter = [], 0
    for home in teams:
        for away in teams:
            if home == away:
                continue
            counter += 1
            matches.append(make_match(f"{counter:04d}", home, away, day=1 + counter // 10))
    return sorted(matches, key=Match.sort_key)


class TestHealthyData:
    def test_complete_season_passes(self):
        matches = round_robin(4)
        report = validate(matches, expected_teams=4, today=TODAY)
        assert report.ok, report.errors

    def test_empty_input_fails(self):
        assert not validate([], expected_teams=4, today=TODAY).ok


class TestIdentity:
    def test_duplicate_match_id_is_an_error(self):
        matches = round_robin(4)
        matches.append(matches[0])
        report = validate(sorted(matches, key=Match.sort_key), expected_teams=4, today=TODAY)
        assert any("duplicate match ids" in e for e in report.errors)

    def test_repeated_fixture_is_an_error(self):
        matches = round_robin(4)
        clone = matches[0]
        matches.append(
            Match(**{**clone.__dict__, "match_id": "9999"})
        )
        report = validate(sorted(matches, key=Match.sort_key), expected_teams=4, today=TODAY)
        assert any("more than once" in e for e in report.errors)


class TestFields:
    def test_played_match_without_score_is_an_error(self):
        bad = Match("1", "2026-03-01", "18:00", "A", "B", "V", None, None, played=True)
        report = validate([bad], expected_teams=2, today=TODAY)
        assert any("missing a score" in e for e in report.errors)

    def test_unplayed_match_with_score_is_an_error(self):
        bad = Match("1", "2026-03-01", "18:00", "A", "B", "V", 1, 0, played=False)
        report = validate([bad], expected_teams=2, today=TODAY)
        assert any("carries score" in e for e in report.errors)

    def test_negative_score_is_an_error(self):
        bad = Match("1", "2026-03-01", "18:00", "A", "B", "V", -1, 0, played=True)
        report = validate([bad], expected_teams=2, today=TODAY)
        assert any("negative score" in e for e in report.errors)

    def test_goalless_draw_is_valid(self):
        draw = Match("1", "2026-03-01", "18:00", "A", "B", "V", 0, 0, played=True)
        report = validate([draw], expected_teams=2, today=TODAY)
        assert not any("score" in e for e in report.errors)

    def test_non_iso_date_is_an_error(self):
        bad = Match("1", "01.03.26", "18:00", "A", "B", "V", None, None, played=False)
        report = validate([bad], expected_teams=2, today=TODAY)
        assert any("ISO" in e for e in report.errors)

    def test_epoch_millisecond_date_is_an_error(self):
        """Regression: the pandas pipeline emitted dates as integers."""
        bad = Match("1", 1773446400000, "18:00", "A", "B", "V", None, None, played=False)
        report = validate([bad], expected_teams=2, today=TODAY)
        assert any("ISO" in e for e in report.errors)

    def test_missing_venue_is_only_a_warning(self):
        matches = round_robin(4)
        matches[0] = Match(**{**matches[0].__dict__, "venue": None})
        report = validate(matches, expected_teams=4, today=TODAY)
        assert report.ok
        assert any("no venue" in w for w in report.warnings)


class TestOrder:
    def test_out_of_order_matches_are_an_error(self):
        matches = round_robin(4)
        reversed_matches = list(reversed(matches))
        report = validate(reversed_matches, expected_teams=4, today=TODAY)
        assert any("chronological order" in e for e in report.errors)

    def test_lexical_date_comparison_catches_december_before_march(self):
        matches = [
            make_match("1", "A", "B", day=1),
            Match("2", "2026-12-13", "18:00", "B", "A", "V", None, None, played=False),
        ]
        assert not any("chronological" in e for e in validate(matches, expected_teams=2, today=TODAY).errors)
        assert any("chronological" in e for e in validate(list(reversed(matches)), expected_teams=2, today=TODAY).errors)


class TestSchedule:
    def test_wrong_team_count_is_an_error(self):
        report = validate(round_robin(4), expected_teams=16, today=TODAY)
        assert any("expected 16 teams" in e for e in report.errors)

    def test_missing_fixture_is_an_error(self):
        matches = round_robin(4)[:-1]
        report = validate(matches, expected_teams=4, today=TODAY)
        assert any("expected 12 matches" in e for e in report.errors)
        assert any("away matches, expected 3" in e for e in report.errors)

    def test_unbalanced_home_and_away_is_an_error(self):
        matches = round_robin(4)
        # Flip one fixture so one team gains a home match and another loses one.
        original = matches[0]
        matches[0] = Match(**{**original.__dict__, "home": original.away, "away": original.home})
        report = validate(matches, expected_teams=4, today=TODAY)
        assert any("home matches, expected 3" in e for e in report.errors)


class TestCalendarAgreement:
    def test_future_match_with_a_result_is_an_error(self):
        future = Match("1", "2026-12-13", "18:00", "A", "B", "V", 2, 1, played=True)
        report = validate([future], expected_teams=2, today=TODAY)
        assert any("already carry a result" in e for e in report.errors)

    def test_past_match_without_a_result_is_only_a_warning(self):
        """Postponements are legitimate, so this must not fail the pipeline."""
        matches = round_robin(4)  # all dated March, none played
        report = validate(matches, expected_teams=4, today=TODAY)
        assert report.ok
        assert any("no result" in w for w in report.warnings)


class TestLoadNormalized:
    def test_reads_a_normalized_file(self, tmp_path):
        path = tmp_path / "matches.json"
        path.write_text(
            json.dumps([m.__dict__ for m in round_robin(4)], ensure_ascii=False),
            encoding="utf-8",
        )
        assert len(load_normalized(path)) == 12

    def test_rejects_non_list(self, tmp_path):
        path = tmp_path / "matches.json"
        path.write_text("{}", encoding="utf-8")
        with pytest.raises(ValueError):
            load_normalized(path)
