"""The local server answers the same /data names build_site writes."""

from elitetracker import build_site
from elitetracker.api import server


def test_every_name_the_static_build_writes_is_served(monkeypatch, tmp_path):
    written = []
    monkeypatch.setattr(build_site, "write_payload", lambda path, _payload: written.append(path.name) or 1)
    for stub in ("build_report", "build_all_careers", "careers_payload", "calibration_payload"):
        monkeypatch.setattr(build_site, stub, lambda *a, **kw: {})
    monkeypatch.setattr(build_site, "matchday_dates", lambda root, season: ["2026-05-01"])
    monkeypatch.setattr(build_site, "preseason_date", lambda season, root: "2026-04-30")
    monkeypatch.setattr(build_site, "available_seasons", lambda root: [2026])
    monkeypatch.setattr(build_site, "current_season", lambda root: 2026)
    monkeypatch.setattr(build_site, "view_stamp", lambda *a, **kw: "stamp")
    monkeypatch.setattr(build_site, "careers_stamp", lambda *a, **kw: "stamp")
    from tests.test_build_site import _SyncPool
    monkeypatch.setattr(build_site, "Pool", _SyncPool)
    build_site.build_site(out_dir=tmp_path)

    for stub in ("build_report", "careers_payload", "calibration_payload"):
        monkeypatch.setattr(server, stub, lambda *a, **kw: {"served": True})
    monkeypatch.setattr(server, "build_all_careers", lambda root: {})
    monkeypatch.setattr(server, "available_seasons", lambda root: [2026])
    monkeypatch.setattr(server, "current_season", lambda root: 2026)
    for cache in (server.careers, server.calibration, server.report):
        cache.cache_clear()
    assert written
    for name in written:
        payload, status = server.data_payload(tmp_path, name)
        assert status == 200, name
    assert server.data_payload(tmp_path, "nope.json")[1] == 404
