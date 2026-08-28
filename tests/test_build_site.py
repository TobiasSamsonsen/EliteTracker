"""`build_site` should be able to rebuild a single season only."""

import pytest

from elitetracker import build_site


class _SyncExecutor:
    """Runs the worker calls inline so monkeypatched stubs stay in effect."""

    def __init__(self, max_workers=None, initializer=None, initargs=()):
        if initializer:
            initializer(*initargs)

    def map(self, fn, iterable, chunksize=1):
        return map(fn, iterable)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def stubbed(monkeypatch, tmp_path):
    written = []

    monkeypatch.setattr(build_site, "write_payload", lambda p, _: written.append(p.name))
    monkeypatch.setattr(build_site, "_build_pair", lambda season, asof, ex: {"x": {}})
    monkeypatch.setattr(build_site, "_build_league", lambda spec: {})
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
    assert not any(name.startswith("report-2024") or name.startswith("report-2025") for name in stubbed)


def test_default_build_covers_every_season(stubbed, tmp_path):
    build_site.build_site(out_dir=tmp_path)

    assert any(name == "report-2024.json" for name in stubbed)
    assert any(name == "report-2025.json" for name in stubbed)
    assert any(name == "report-2026.json" for name in stubbed)
    assert "report.json" in stubbed


def test_only_season_rejects_unknown_season(stubbed, tmp_path):
    with pytest.raises(ValueError):
        build_site.build_site(out_dir=tmp_path, only_season=1999)
