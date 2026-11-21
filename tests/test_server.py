"""The local server answers the same /data names build_site writes."""

from elitetracker import build_site
from elitetracker.api import server


def test_every_name_the_static_build_writes_is_served(monkeypatch, tmp_path):
    written = []
    monkeypatch.setattr(build_site, "write_payload", lambda path, _payload: written.append(path.name) or 1)
    for stub in ("build_report", "build_all_careers", "careers_payload", "h2h_payload", "calibration_payload"):
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

    for stub in ("build_report", "careers_payload", "h2h_payload", "calibration_payload"):
        monkeypatch.setattr(server, stub, lambda *a, **kw: {"served": True})
    monkeypatch.setattr(server, "build_all_careers", lambda root: {})
    monkeypatch.setattr(server, "available_seasons", lambda root: [2026])
    monkeypatch.setattr(server, "current_season", lambda root: 2026)
    for cache in (server.careers, server.calibration, server.reports):
        cache.cache_clear()
    assert written
    for name in written:
        payload, status = server.data_payload(tmp_path, name)
        assert status == 200, name
    assert server.data_payload(tmp_path, "nope.json")[1] == 404


def test_a_club_address_without_a_page_opens_the_app(tmp_path):
    import threading
    import urllib.request
    from functools import partial
    from http.server import ThreadingHTTPServer

    (tmp_path / "index.html").write_text("<html>the app</html>", encoding="utf-8")
    (tmp_path / "app.js").write_text("// js", encoding="utf-8")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), partial(server.Handler, directory=str(tmp_path)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        assert b"the app" in urllib.request.urlopen(f"{base}/klubb/viking/?view=team").read()
        assert b"// js" in urllib.request.urlopen(f"{base}/app.js").read()
        with __import__("pytest").raises(urllib.error.HTTPError) as missing:
            urllib.request.urlopen(f"{base}/missing.js")
        assert missing.value.code == 404
    finally:
        httpd.shutdown()
        httpd.server_close()
