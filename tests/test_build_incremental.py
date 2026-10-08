"""Incremental rebuild: a view is reused when its date prefix has not moved.

The load-bearing claim is that a rewound report is a pure function of the
results played on or before its rewind date, so a later result cannot change
it. These tests pin that claim at the stamp level, which is what the reuse
logic actually reads, and they pin the safety rule that a stamp without its
file on disk is never enough to skip.
"""

import json
import shutil
from dataclasses import asdict

import pytest

from elitetracker import build_site
from elitetracker.normalize.matches import Match
from tests.test_build_site import _SyncPool


def match(match_id: str, date: str, played: bool = True) -> Match:
    return Match(
        match_id=match_id, date=date, time="15:00", home="Home", away="Away",
        home_goals=2 if played else None, away_goals=1 if played else None,
        played=played,
    )


def write_league(root, matches, league="eliteserien", season=2026):
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{league}_{season}_matches.json").write_text(
        json.dumps([asdict(m) for m in matches]), encoding="utf-8"
    )


@pytest.fixture
def two_matches(tmp_path):
    """A season already played to 2026-05-08, plus a later fixture."""
    root = tmp_path / "normalized"
    write_league(root, [
        match("1", "2026-05-01"),
        match("2", "2026-05-08"),
        match("3", "2026-09-01", played=False),
    ])
    return root


def stamp(root, asof=None, regression=0.88):
    return build_site.view_stamp(root, 2026, asof, season_regression=regression)


class TestPrefixStamping:
    def test_a_later_result_leaves_an_earlier_rewind_alone(self, two_matches):
        """The whole point: September's data must not invalidate May's view."""
        before = stamp(two_matches, "2026-05-08")
        write_league(two_matches, [
            match("1", "2026-05-01"),
            match("2", "2026-05-08"),
            match("3", "2026-09-01"),  # the September fixture now played
        ])
        assert stamp(two_matches, "2026-05-08") == before

    def test_a_later_result_does_change_the_live_view(self, two_matches):
        before = stamp(two_matches)
        write_league(two_matches, [
            match("1", "2026-05-01"),
            match("2", "2026-05-08"),
            match("3", "2026-09-01"),
        ])
        assert stamp(two_matches) != before

    def test_a_result_inside_the_rewind_invalidates_it(self, two_matches):
        """A corrected result before the rewind date is new knowledge."""
        before = stamp(two_matches, "2026-05-08")
        write_league(two_matches, [
            match("1", "2026-05-01"),
            match("2", "2026-05-08"),
            match("4", "2026-05-04"),  # new result inside the prefix
        ])
        assert stamp(two_matches, "2026-05-08") != before

    def test_a_rescheduled_future_fixture_invalidates_the_view(self, two_matches):
        """Unplayed fixtures count whatever their date: the view lists them."""
        before = stamp(two_matches, "2026-05-08")
        write_league(two_matches, [
            match("1", "2026-05-01"),
            match("2", "2026-05-08"),
            match("3", "2026-09-07", played=False),  # pushed back a week
        ])
        assert stamp(two_matches, "2026-05-08") != before

    def test_xg_after_the_rewind_does_not_invalidate_it(self, two_matches, monkeypatch):
        """xG keeps arriving late; a later match's must not disturb May."""
        monkeypatch.setattr(build_site, "load_xg", lambda *a, **k: {
            "matches": {}, "none": [], "pending": {}
        })
        before = stamp(two_matches, "2026-05-08")
        monkeypatch.setattr(build_site, "load_xg", lambda *a, **k: {
            "matches": {"3": [2.1, 0.4]}, "none": [], "pending": {}
        })  # match 3 is the September fixture, after the rewind
        assert stamp(two_matches, "2026-05-08") == before

    def test_xg_before_the_rewind_does_invalidate_it(self, two_matches, monkeypatch):
        monkeypatch.setattr(build_site, "load_xg", lambda *a, **k: {
            "matches": {}, "none": [], "pending": {}
        })
        before = stamp(two_matches, "2026-05-08")
        monkeypatch.setattr(build_site, "load_xg", lambda *a, **k: {
            "matches": {"2": [1.9, 0.8], "none": [], "pending": {}}
        })
        assert stamp(two_matches, "2026-05-08") != before

    def test_model_version_change_invalidates_everything(self, two_matches, monkeypatch):
        before = stamp(two_matches, "2026-05-08")
        monkeypatch.setattr(build_site, "MODEL_VERSION", "elo-v99.0")
        assert stamp(two_matches, "2026-05-08") != before

    def test_regression_change_invalidates_everything(self, two_matches):
        assert stamp(two_matches, "2026-05-08", regression=0.5) != stamp(two_matches, "2026-05-08")

    def test_a_live_and_a_rewound_view_differ(self, two_matches):
        """They run different simulation settings, so they need different stamps."""
        assert stamp(two_matches) != stamp(two_matches, "2026-05-08")


class TestManifest:
    def test_missing_manifest_reads_as_empty(self, tmp_path):
        assert build_site._read_manifest(tmp_path) == {}

    def test_corrupt_manifest_reads_as_empty(self, tmp_path):
        """A truncated manifest must rebuild everything, never skip."""
        (tmp_path / build_site.MANIFEST_NAME).write_text("{not json", encoding="utf-8")
        assert build_site._read_manifest(tmp_path) == {}

    def test_round_trip(self, tmp_path):
        build_site._write_manifest(tmp_path, {"report-2026.json": "abc"})
        assert build_site._read_manifest(tmp_path) == {"report-2026.json": "abc"}
        assert not list(tmp_path.glob("*.tmp"))  # atomic: no leftover temp

    def test_reused_views_keep_their_stamp(self, tmp_path, two_matches):
        """A view that was reused must stay in the manifest under its own stamp.

        Dropping it would look fine on this run and rebuild everything on the
        next, so the saving would quietly disappear after one extra deploy.
        """
        out = tmp_path / "out"
        out.mkdir()
        # Both leagues must exist before any stamp is taken: build_site reads
        # every match file in the root, so adding one later would change it.
        write_league(two_matches, [match("1", "2026-05-01")], league="obosligaen")

        live = stamp(two_matches)
        rewind = stamp(two_matches, "2026-05-08")
        build_site._write_manifest(out, {
            "report-2026.json": live,
            "report.json": live,
            "report-2026-2026-05-08.json": rewind,
            "careers.json": build_site.careers_stamp(two_matches, season_regression=0.88),
        })
        for name in ("report-2026.json", "report.json",
                     "report-2026-2026-05-08.json", "careers.json"):
            (out / name).write_text("{}", encoding="utf-8")

        monkeypatch = pytest.MonkeyPatch()
        monkeypatch.setattr(build_site, "build_report", lambda *a, **kw: {"stub": True})
        monkeypatch.setattr(build_site, "matchday_dates", lambda root, season: ["2026-05-08"])
        monkeypatch.setattr(build_site, "build_all_careers", lambda root, **kw: {})
        monkeypatch.setattr(build_site, "careers_payload", lambda careers, **kw: {})
        monkeypatch.setattr(build_site, "Pool", _SyncPool)
        try:
            build_site.build_site(root=two_matches, out_dir=out, jobs=1, only_season=2026)
        finally:
            monkeypatch.undo()

        manifest = build_site._read_manifest(out)
        # The rewind was reused (its file is untouched), so its entry must survive.
        assert manifest.get("report-2026-2026-05-08.json") == rewind
        assert "careers.json" in manifest

    def test_a_stamp_without_its_file_is_not_enough(self, tmp_path):
        """The safety rule: a matching stamp with a missing file still rebuilds,
        so a wiped or partial out_dir can never ship an empty view."""
        out = tmp_path / "out"
        out.mkdir()
        names = ["report-2026.json"]
        previous = {"report-2026.json": "abc"}

        assert not build_site.reusable(names, "abc", previous, out)  # file missing
        (out / "report-2026.json").write_text("{}", encoding="utf-8")
        assert build_site.reusable(names, "abc", previous, out)     # file present
        assert not build_site.reusable(names, "different", previous, out)  # inputs moved

    def test_report_json_counts_too(self, tmp_path):
        """The current season's live view is written twice, so both copies must
        be present before either may be skipped."""
        out = tmp_path / "out"
        out.mkdir()
        names = ["report-2026.json", "report.json"]
        previous = {name: "abc" for name in names}
        assert not build_site.reusable(names, "abc", previous, out)
        (out / "report-2026.json").write_text("{}", encoding="utf-8")
        assert not build_site.reusable(names, "abc", previous, out)  # report.json still missing
        (out / "report.json").write_text("{}", encoding="utf-8")
        assert build_site.reusable(names, "abc", previous, out)


class TestCareersStamp:
    def test_careers_span_every_season(self, tmp_path):
        root = tmp_path / "normalized"
        write_league(root, [match("1", "2016-05-01")], season=2016)
        before = build_site.careers_stamp(root, season_regression=0.88)
        write_league(root, [match("1", "2016-05-01"), match("2", "2016-06-01")], season=2016)
        assert build_site.careers_stamp(root, season_regression=0.88) != before


class TestRewriteInvariance:
    def test_rewound_view_is_independent_of_later_results(self, tmp_path):
        """The invariant the whole scheme rests on, at file level: building a
        report from full data and from data truncated to the rewind date gives
        the same stamp, so the view may safely be reused.

        (Byte-identical payloads were confirmed by hand; the stamp is what the
        build actually compares.)
        """
        live = tmp_path / "live"
        write_league(live, [
            match("1", "2026-05-01"),
            match("2", "2026-05-08"),
            match("3", "2026-09-01"),
        ])
        truncated = tmp_path / "truncated"
        write_league(truncated, [
            match("1", "2026-05-01"),
            match("2", "2026-05-08"),
            match("3", "2026-09-01", played=False),  # not yet played back then
        ])
        assert (
            build_site.view_stamp(live, 2026, "2026-05-08", season_regression=0.88)
            == build_site.view_stamp(truncated, 2026, "2026-05-08", season_regression=0.88)
        )