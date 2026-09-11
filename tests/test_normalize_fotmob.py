import pytest

from elitetracker.normalize.matches import NormalizationError
from elitetracker.normalize.fotmob import normalize_match, normalize_matches


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

