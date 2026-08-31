"""`build_site` writes one file per view, and can rebuild a single season only."""

from concurrent.futures import Future

import pytest

from elitetracker import build_site


class _SyncExecutor:
    """Runs the worker calls inline so monkeypatched stubs stay in effect."""

    def __init__(self, max_workers=None, initializer=None, initargs=()):
        if initializer:
            initializer(*initargs)

    def submit(self, fn, *args):
        future: Future = Future()
        try:
            future.set_result(fn(*args))
        except BaseException as exc:  # surfaced by future.result(), as in the pool
            future.set_exception(exc)
        return future

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def stubbed(monkeypatch, tmp_path):
    written = []

    def fake_write(path, _payload):
        written.append(path.name)
        return 100

    # _build_view runs for real -- naming the files is what is worth testing.
    monkeypatch.setattr(build_site, "write_payload", fake_write)
    monkeypatch.setattr(build_site, "build_report", lambda *a, **kw: {})
    monkeypatch.setattr(
        build_site, "matchday_dates", lambda root, season: ["2026-05-01", "2026-05-08"]
    )
    monkeypatch.setattr(build_site, "build_all_careers", lambda root, **kw: {})
    monkeypatch.setattr(build_site, "careers_payload", lambda careers, **kw: {})
    monkeypatch.setattr(build_site, "ProcessPoolExecutor", _SyncExecutor)
    monkeypatch.setattr(build_site, "available_seasons", lambda root: [2024, 2025, 2026])
    monkeypatch.setattr(build_site, "current_season", lambda root: 2026)

    return written


def test_only_season_builds_just_that_season(stubbed, tmp_path):
    build_site.build_site(out_dir=tmp_path, only_season=2026)

    assert stubbed == [
        "report-2026.json",
        "report.json",
        "report-2026-2026-05-01.json",
        "report-2026-2026-05-08.json",
        "careers.json",
    ]
    # No past-season files are written.
    assert not any(name.startswith(("report-2024", "report-2025")) for name in stubbed)


def test_default_build_covers_every_season(stubbed, tmp_path):
    build_site.build_site(out_dir=tmp_path)

    for season in (2024, 2025, 2026):
        assert f"report-{season}.json" in stubbed
        assert f"report-{season}-2026-05-01.json" in stubbed
    assert "report.json" in stubbed
    # Only the current season gets the fixed-name copy.
    assert stubbed.count("report.json") == 1


def test_live_views_are_queued_before_the_rewinds(stubbed, tmp_path):
    """A 50,000-simulation view started last would set the finishing time."""
    build_site.build_site(out_dir=tmp_path)

    rewinds = [name for name in stubbed if name.count("-") > 1]
    live = [name for name in stubbed if name.startswith("report-") and name not in rewinds]
    assert stubbed.index(live[-1]) < stubbed.index(rewinds[0])


def test_only_season_rejects_unknown_season(stubbed, tmp_path):
    with pytest.raises(ValueError):
        build_site.build_site(out_dir=tmp_path, only_season=1999)
