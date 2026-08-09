import pytest

from elitetracker.normalize.matches import NormalizationError
from elitetracker.normalize.fotmob import (
    normalize_match,
    normalize_matches,
    normalize_standing,
    normalize_standings,
)


def raw_match(**overrides):
    record = {
        "round": "1",
        "roundName": 1,
        "id": "5104842",
        "home": {"name": "Hamarkameratene", "shortName": "HamKam", "id": "8448"},
        "away": {"name": "Viking", "shortName": "Viking", "id": "8478"},
        "status": {
            "utcTime": "2026-03-14T15:00:00Z",
            "finished": True,
            "started": True,
            "cancelled": False,
            "scoreStr": "2 - 1",
        },
    }
    record.update(overrides)
    return record


def raw_standing(**overrides):
    record = {
        "name": "Viking",
        "id": 8478,
        "played": 30,
        "wins": 22,
        "draws": 5,
        "losses": 3,
        "scoresStr": "77-36",
        "goalConDiff": 41,
        "pts": 71,
        "idx": 1,
        "deduction": None,
    }
    record.update(overrides)
    return record


class TestNormalizeMatch:
    def test_finished_match(self):
        match = normalize_match(raw_match())
        assert match.match_id == "5104842"
        assert match.played is True
        assert (match.home_goals, match.away_goals) == (2, 1)
        assert match.round == 1
        assert (match.home_id, match.away_id) == ("8448", "8478")

    def test_keeps_utc_kickoff_alongside_local_time(self):
        match = normalize_match(raw_match())
        assert match.kickoff_utc == "2026-03-14T15:00:00Z"
        # 14 March is CET (UTC+1) in Oslo.
        assert match.date == "2026-03-14"
        assert match.time == "16:00"

    def test_summer_kickoff_uses_cest(self):
        match = normalize_match(
            raw_match(status={**raw_match()["status"], "utcTime": "2026-08-09T15:00:00Z"})
        )
        # 9 August is CEST (UTC+2).
        assert match.date == "2026-08-09"
        assert match.time == "17:00"

    def test_late_utc_kickoff_belongs_to_the_next_local_day(self):
        """The matchday is the local date, not the UTC one."""
        match = normalize_match(
            raw_match(status={**raw_match()["status"], "utcTime": "2026-08-09T23:30:00Z"})
        )
        assert match.date == "2026-08-10"
        assert match.time == "01:30"

    def test_unfinished_match_has_no_score(self):
        status = {"utcTime": "2026-08-09T15:00:00Z", "finished": False, "cancelled": False}
        match = normalize_match(raw_match(status=status))
        assert match.played is False
        assert (match.home_goals, match.away_goals) == (None, None)

    def test_cancelled_match_is_not_treated_as_played(self):
        status = {
            "utcTime": "2026-08-09T15:00:00Z",
            "finished": True,
            "cancelled": True,
            "scoreStr": "2 - 1",
        }
        match = normalize_match(raw_match(status=status))
        assert match.played is False
        assert (match.home_goals, match.away_goals) == (None, None)

    def test_finished_without_a_score_is_rejected(self):
        status = {"utcTime": "2026-08-09T15:00:00Z", "finished": True, "cancelled": False}
        with pytest.raises(NormalizationError, match="no score"):
            normalize_match(raw_match(status=status))

    def test_missing_kickoff_is_rejected(self):
        with pytest.raises(NormalizationError, match="kickoff"):
            normalize_match(raw_match(status={"finished": False}))

    def test_missing_team_is_rejected(self):
        with pytest.raises(NormalizationError, match="team"):
            normalize_match(raw_match(home={}))

    def test_team_playing_itself_is_rejected(self):
        with pytest.raises(NormalizationError, match="plays itself"):
            normalize_match(raw_match(away={"name": "HamKam", "id": "8448"}))

    def test_round_falls_back_to_the_string_field(self):
        record = raw_match(roundName=None, round="7")
        assert normalize_match(record).round == 7

    def test_unparseable_round_becomes_none(self):
        record = raw_match(roundName="Final", round="Final")
        assert normalize_match(record).round is None


class TestNormalizeMatches:
    def test_sorts_chronologically(self):
        late = raw_match(id="b", status={**raw_match()["status"], "utcTime": "2026-12-13T15:00:00Z"})
        early = raw_match(id="a")
        assert [m.match_id for m in normalize_matches([late, early])] == ["a", "b"]

    def test_deduplicates(self):
        assert len(normalize_matches([raw_match(), raw_match()])) == 1


class TestNormalizeStanding:
    def test_full_row(self):
        row = normalize_standing(raw_standing())
        assert row.position == 1
        assert row.team == "Viking"
        assert row.team_id == "8478"
        assert (row.goals_for, row.goals_against) == (77, 36)
        assert row.goal_difference == 41
        assert row.points == 71
        assert row.deduction == 0

    def test_null_deduction_becomes_zero(self):
        assert normalize_standing(raw_standing(deduction=None)).deduction == 0

    def test_negative_deduction_is_kept(self):
        row = normalize_standing(raw_standing(name="Raufoss", wins=7, draws=9, losses=14, pts=29, deduction=-1))
        assert row.deduction == -1
        # 7*3 + 9 = 30, minus the docked point.
        assert row.expected_points + row.deduction == row.points

    def test_negative_goal_difference(self):
        row = normalize_standing(raw_standing(scoresStr="22-80"))
        assert row.goal_difference == -58

    def test_team_id_is_stringified(self):
        assert normalize_standing(raw_standing(id=8478)).team_id == "8478"

    def test_missing_identity_is_rejected(self):
        with pytest.raises(NormalizationError, match="team identity"):
            normalize_standing(raw_standing(name=None))

    def test_malformed_row_is_rejected(self):
        with pytest.raises(NormalizationError, match="malformed"):
            normalize_standing(raw_standing(pts="many"))

    def test_unparseable_goals_are_rejected(self):
        with pytest.raises(NormalizationError):
            normalize_standing(raw_standing(scoresStr="lots"))


class TestNormalizeStandings:
    def test_sorted_by_position(self):
        rows = [raw_standing(idx=3, name="C", id=3), raw_standing(idx=1, name="A", id=1)]
        assert [r.position for r in normalize_standings(rows)] == [1, 3]
