import json

import pytest

from elitetracker.normalize.matches import (
    Match,
    NormalizationError,
    deduplicate,
    dump,
    load_json,
    parse_score,
    parse_time,
)
from elitetracker.normalize.parse_bot import normalize, normalize_match, parse_date


def raw(**overrides):
    record = {
        "date": "søndag 09.08.26",
        "time": "14:30",
        "home": "Lillestrøm",
        "away": "Rosenborg",
        "result": "-",
        "venue": "Åråsen stadion",
        "match_id": "8986259",
    }
    record.update(overrides)
    return record


class TestParseDate:
    def test_strips_norwegian_weekday_prefix(self):
        assert parse_date("søndag 09.08.26") == "2026-08-09"

    def test_accepts_bare_date(self):
        assert parse_date("14.03.26") == "2026-03-14"

    def test_day_and_month_are_not_swapped(self):
        # 13.12.26 is 13 December, not 12 November.
        assert parse_date("13.12.26") == "2026-12-13"

    @pytest.mark.parametrize("value", [None, "", "-", "  "])
    def test_missing_date_is_rejected(self, value):
        with pytest.raises(NormalizationError):
            parse_date(value)

    @pytest.mark.parametrize("value", ["2026-08-09", "32.01.26", "09.13.26", "tirsdag"])
    def test_unparseable_date_is_rejected(self, value):
        with pytest.raises(NormalizationError):
            parse_date(value)


class TestParseTime:
    def test_valid_time(self):
        assert parse_time("18:00") == "18:00"

    @pytest.mark.parametrize("value", [None, "", "-", "–"])
    def test_absent_time_becomes_none(self, value):
        assert parse_time(value) is None

    @pytest.mark.parametrize("value", ["24:00", "18:60", "1800", "6pm"])
    def test_invalid_time_is_rejected(self, value):
        with pytest.raises(NormalizationError):
            parse_time(value)


class TestParseScore:
    def test_splits_score(self):
        assert parse_score("2 - 1") == (2, 1)

    def test_tolerates_missing_spaces_and_en_dash(self):
        assert parse_score("2-1") == (2, 1)
        assert parse_score("2 – 1") == (2, 1)

    def test_draw(self):
        assert parse_score("1 - 1") == (1, 1)

    def test_goalless_draw_is_not_confused_with_missing(self):
        assert parse_score("0 - 0") == (0, 0)

    def test_unplayed_match(self):
        assert parse_score("-") == (None, None)
        assert parse_score(None) == (None, None)

    @pytest.mark.parametrize("value", ["2:1", "two - one", "2 - "])
    def test_unparseable_result_is_rejected(self, value):
        with pytest.raises(NormalizationError):
            parse_score(value)


class TestNormalizeMatch:
    def test_upcoming_match(self):
        match = normalize_match(raw())
        assert match.date == "2026-08-09"
        assert match.time == "14:30"
        assert match.played is False
        assert (match.home_goals, match.away_goals) == (None, None)

    def test_played_match(self):
        match = normalize_match(raw(result="2 - 1", time=""))
        assert match.played is True
        assert (match.home_goals, match.away_goals) == (2, 1)
        # Played matches in this source carry no kickoff time.
        assert match.time is None

    def test_missing_venue_becomes_none(self):
        assert normalize_match(raw(venue="")).venue is None

    def test_team_names_keep_norwegian_characters(self):
        match = normalize_match(raw(home="Bodø/Glimt", away="Vålerenga"))
        assert match.home == "Bodø/Glimt"
        assert match.away == "Vålerenga"

    def test_missing_match_id_is_rejected(self):
        with pytest.raises(NormalizationError, match="match_id"):
            normalize_match(raw(match_id=None))

    def test_missing_team_is_rejected(self):
        with pytest.raises(NormalizationError, match="team name"):
            normalize_match(raw(away=""))

    def test_team_playing_itself_is_rejected(self):
        with pytest.raises(NormalizationError, match="plays itself"):
            normalize_match(raw(away="Lillestrøm"))


class TestDeduplicate:
    def test_identical_repeats_are_dropped(self):
        match = normalize_match(raw())
        assert deduplicate([match, match, match]) == [match]

    def test_conflicting_repeats_are_rejected(self):
        first = normalize_match(raw())
        second = normalize_match(raw(result="2 - 1"))
        with pytest.raises(NormalizationError, match="conflicting"):
            deduplicate([first, second])

    def test_distinct_matches_are_kept(self):
        first = normalize_match(raw(match_id="1"))
        second = normalize_match(raw(match_id="2", home="Brann"))
        assert len(deduplicate([first, second])) == 2


class TestNormalize:
    def test_sorts_chronologically_across_month_boundaries(self):
        records = [
            raw(match_id="c", date="13.12.26"),
            raw(match_id="a", date="14.03.26", home="Brann"),
            raw(match_id="b", date="09.08.26", home="Molde"),
        ]
        assert [m.match_id for m in normalize(records)] == ["a", "b", "c"]

    def test_sorts_by_time_within_a_day(self):
        records = [
            raw(match_id="late", time="19:15"),
            raw(match_id="early", time="14:30", home="Brann"),
        ]
        assert [m.match_id for m in normalize(records)] == ["early", "late"]

    def test_match_without_time_sorts_last_within_its_day(self):
        records = [
            raw(match_id="unknown", time="", home="Brann"),
            raw(match_id="known", time="19:15"),
        ]
        assert [m.match_id for m in normalize(records)] == ["known", "unknown"]

    def test_ties_broken_by_match_id_for_reproducibility(self):
        records = [
            raw(match_id="8986300", home="Brann"),
            raw(match_id="8986100"),
        ]
        assert [m.match_id for m in normalize(records)] == ["8986100", "8986300"]

    def test_empty_input(self):
        assert normalize([]) == []


class TestLoadJson:
    def test_null_payload_is_rejected(self, tmp_path):
        path = tmp_path / "empty.json"
        path.write_text("null", encoding="utf-8")
        with pytest.raises(NormalizationError, match="never succeeded"):
            load_json(path)

    def test_non_list_payload_is_rejected(self, tmp_path):
        path = tmp_path / "object.json"
        path.write_text('{"matches": []}', encoding="utf-8")
        with pytest.raises(NormalizationError, match="list of matches"):
            load_json(path)


class TestSerialization:
    def test_dates_survive_a_json_round_trip_as_strings(self, tmp_path):
        """Regression: the pandas version wrote dates as epoch milliseconds."""
        path = tmp_path / "out.json"
        dump(normalize([raw()]), path)
        record = json.loads(path.read_text(encoding="utf-8"))[0]
        assert record["date"] == "2026-08-09"
        assert isinstance(record["date"], str)

    def test_dumped_records_reload_as_matches(self, tmp_path):
        path = tmp_path / "out.json"
        original = normalize([raw()])
        dump(original, path)
        reloaded = [Match(**r) for r in json.loads(path.read_text(encoding="utf-8"))]
        assert reloaded == original
