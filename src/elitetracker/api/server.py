"""Backend API for the EliteTracker site, on the standard library alone.

Reports are built on first request and held in memory, so page loads never
trigger a second simulation and never touch the network. ``--reload`` rebuilds
on every request instead, which is what you want while editing the model.

    python -m elitetracker.api.server --port 8000

It answers the same ``/data/*.json`` names ``build_site`` writes for Firebase,
so the frontend has one URL scheme and no idea which host is behind it. Anything
else is served from ``public/``.
"""

from __future__ import annotations

import argparse
import functools
import json
import re
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from elitetracker.model.elo import MODEL_VERSION
from elitetracker.pipeline import (
    LEAGUE_SPECS,
    NORMALIZED_DIR,
    available_seasons,
    build_all_careers,
    build_report,
    careers_payload,
    current_season,
    rewound_configs,
)

WEB_DIR = Path(__file__).resolve().parents[3] / "public"

# The filenames build_site writes: report.json, report-<season>.json and
# report-<season>-<date>.json.
_REPORT_NAME = re.compile(r"report(?:-(\d{4})(?:-(\d{4}-\d{2}-\d{2}))?)?\.json")


@functools.cache
def careers(root: Path) -> dict[str, Any]:
    return build_all_careers(root)


@functools.cache
def report(root: Path, slug: str, season: int, asof: str | None) -> Any:
    simulation, history = rewound_configs(asof)
    return build_report(
        slug, season, root=root, careers=careers(root),
        simulation=simulation, history=history, asof=asof,
    )


def data_payload(root: Path, name: str) -> tuple[Any, int]:
    """What the static build would have written under /data/<name>, plus a status."""
    if name == "careers.json":
        return careers_payload(careers(root)), 200
    match = _REPORT_NAME.fullmatch(name)
    if match is None:
        return {"error": "not found"}, 404
    season = int(match.group(1)) if match.group(1) else current_season(root)
    if season not in available_seasons(root):
        return {"error": f"no data for season {season}"}, 404
    return {slug: report(root, slug, season, match.group(2)) for slug in LEAGUE_SPECS}, 200


class Handler(SimpleHTTPRequestHandler):
    server_version = "EliteTracker"
    protocol_version = "HTTP/1.1"
    root: Path = NORMALIZED_DIR
    reload: bool = False

    # Quieter than the default one-line-per-asset logging.
    def log_message(self, format: str, *args: Any) -> None:
        if self.path.startswith("/data/"):
            super().log_message(format, *args)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        path = self.path.split("?", 1)[0]
        if not path.startswith("/data/"):
            return super().do_GET()
        if self.reload:
            careers.cache_clear()
            report.cache_clear()
        try:
            self._json(*data_payload(self.root, path.removeprefix("/data/")))
        except BrokenPipeError:
            pass  # the browser navigated away mid-response
        except Exception as exc:  # keep one bad request from killing the server
            self.log_error("%s", exc)
            self._json({"error": str(exc)}, 500)

    def _json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve(host: str = "127.0.0.1", port: int = 8000, *, web_dir: Path = WEB_DIR) -> None:
    handler = partial(Handler, directory=str(web_dir))
    with ThreadingHTTPServer((host, port), handler) as httpd:
        print(f"EliteTracker [{MODEL_VERSION}] serving on http://{host}:{port}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", action="store_true", help="rebuild reports on every request")
    parser.add_argument("--root", type=Path, default=NORMALIZED_DIR)
    args = parser.parse_args(argv)

    Handler.root = args.root
    Handler.reload = args.reload
    print("replaying every season...")
    seasons = available_seasons(args.root)
    print(f"  {len(careers(args.root))} clubs across {seasons[0]}-{seasons[-1]}")
    print("building the current season...")
    data_payload(args.root, "report.json")
    print("ready -- older seasons are built on first view")

    serve(args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
