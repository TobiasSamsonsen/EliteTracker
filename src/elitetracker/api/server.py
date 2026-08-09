"""Backend API for the EliteTracker site, on the standard library alone.

Reports are built once at start-up (a full run is well under a second) and held
in memory, so page loads never trigger a simulation and never touch the network.
``--reload`` rebuilds on every request instead, which is what you want while
editing the model.

    python -m elitetracker.api.server --port 8000

Routes:
    GET /                      the site
    GET /api/health            build status
    GET /api/report            every league
    GET /api/report/<slug>     one league
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import threading
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import date
from urllib.parse import parse_qs
from pathlib import Path
from typing import Any

from elitetracker.model.elo import MODEL_VERSION, EloConfig
from elitetracker.pipeline import (
    LEAGUE_SPECS,
    NORMALIZED_DIR,
    available_seasons,
    build_all_careers,
    build_report,
    careers_payload,
    current_season,
)
from elitetracker.simulation.history import HistoryConfig
from elitetracker.simulation.season import SimulationConfig

WEB_DIR = Path(__file__).resolve().parents[3] / "web"


class ReportStore:
    """Careers plus a lazily-filled cache of per-season reports.

    The rating replay spans every season and is done once. Individual season
    reports are expensive enough (a simulation plus twenty rewound ones) that
    building all of them up front would cost half a minute, so they are built
    on first request and kept.
    """

    def __init__(
        self,
        root: Path = NORMALIZED_DIR,
        *,
        elo_config: EloConfig | None = None,
        simulation: SimulationConfig | None = None,
        history: HistoryConfig | None = None,
        always_reload: bool = False,
    ) -> None:
        self.root = root
        self.elo_config = elo_config or EloConfig()
        self.simulation = simulation or SimulationConfig()
        self.history = history or HistoryConfig()
        self.always_reload = always_reload
        self._lock = threading.RLock()
        self._careers: dict[str, Any] | None = None
        self._reports: dict[tuple[str, int, str | None], Any] = {}

    # Rewound views are for browsing, not for the headline projection, so they
    # run fewer simulations. The Monte Carlo error at 3,000 runs is under a
    # point of probability, which no one is reading off a history slider.
    def _configs(self, asof: str | None) -> tuple[SimulationConfig, HistoryConfig]:
        if not asof:
            return self.simulation, self.history
        return (
            SimulationConfig(simulations=3_000, seed=self.simulation.seed),
            HistoryConfig(simulations=1_200, seed=self.history.seed, max_snapshots=12),
        )

    def careers(self) -> dict[str, Any]:
        with self._lock:
            if self._careers is None or self.always_reload:
                self._careers = build_all_careers(self.root, elo_config=self.elo_config)
            return self._careers

    def seasons(self) -> list[int]:
        return available_seasons(self.root)

    def report(self, slug: str, season: int, asof: str | None = None) -> Any:
        key = (slug, season, asof)
        with self._lock:
            if key not in self._reports or self.always_reload:
                simulation, history = self._configs(asof)
                self._reports[key] = build_report(
                    slug,
                    season,
                    root=self.root,
                    careers=self.careers(),
                    elo_config=self.elo_config,
                    simulation=simulation,
                    history=history,
                    asof=asof,
                )
            return self._reports[key]

    def reports(self, season: int | None = None, asof: str | None = None) -> dict[str, Any]:
        target = season or current_season(self.root)
        return {slug: self.report(slug, target, asof) for slug in LEAGUE_SPECS}


class Handler(BaseHTTPRequestHandler):
    server_version = "EliteTracker"
    protocol_version = "HTTP/1.1"

    def __init__(self, *args: Any, store: ReportStore, web_dir: Path, **kwargs: Any) -> None:
        self.store = store
        self.web_dir = web_dir
        super().__init__(*args, **kwargs)

    # Quieter than the default one-line-per-asset logging.
    def log_message(self, format: str, *args: Any) -> None:
        if self.path.startswith("/api/"):
            super().log_message(format, *args)

    def do_GET(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        path = self.path.split("?", 1)[0]
        try:
            if path == "/api/health":
                self._json({"status": "ok", "model": MODEL_VERSION, "leagues": sorted(LEAGUE_SPECS)})
            elif path == "/api/seasons":
                self._json(
                    {
                        "seasons": self.store.seasons(),
                        "current": current_season(self.store.root),
                    }
                )
            elif path == "/api/careers":
                self._json(careers_payload(self.store.careers()))
            elif path == "/api/report":
                self._json(self.store.reports(self._season_param(), self._asof_param()))
            elif path.startswith("/api/report/"):
                self._report_route(path.removeprefix("/api/report/"))
            elif path.startswith("/api/"):
                self._json({"error": "no such endpoint"}, status=404)
            else:
                self._static(path)
        except BrokenPipeError:
            pass  # the browser navigated away mid-response
        except Exception as exc:  # keep one bad request from killing the server
            self.log_error("%s", exc)
            self._json({"error": str(exc)}, status=500)

    def _season_param(self) -> int | None:
        """?season=2019 on any report route."""
        if "?" not in self.path:
            return None
        query = parse_qs(self.path.split("?", 1)[1])
        values = query.get("season")
        if not values:
            return None
        try:
            return int(values[0])
        except ValueError:
            return None

    def _asof_param(self) -> str | None:
        """?asof=2026-05-01 rewinds the whole report to that evening."""
        if "?" not in self.path:
            return None
        values = parse_qs(self.path.split("?", 1)[1]).get("asof")
        if not values:
            return None
        candidate = values[0].strip()
        try:
            date.fromisoformat(candidate)
        except ValueError:
            return None
        return candidate

    def _report_route(self, rest: str) -> None:
        """/api/report/<league> or /api/report/<league>/<season>."""
        parts = [part for part in rest.split("/") if part]
        if not parts or parts[0] not in LEAGUE_SPECS:
            self._json({"error": f"unknown league {parts[0] if parts else ''!r}"}, status=404)
            return

        slug = parts[0]
        season = self._season_param()
        if len(parts) > 1:
            try:
                season = int(parts[1])
            except ValueError:
                self._json({"error": f"bad season {parts[1]!r}"}, status=400)
                return

        season = season or current_season(self.store.root)
        if season not in self.store.seasons():
            self._json({"error": f"no data for season {season}"}, status=404)
            return
        self._json(self.store.report(slug, season, self._asof_param()))

    def _json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _static(self, path: str) -> None:
        relative = "index.html" if path == "/" else path.lstrip("/")
        target = (self.web_dir / relative).resolve()
        # Refuse anything that escapes the web directory.
        if not target.is_file() or self.web_dir.resolve() not in target.parents:
            self._json({"error": "not found"}, status=404)
            return

        body = target.read_bytes()
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type == "application/javascript":
            content_type += "; charset=utf-8"

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def serve(
    host: str = "127.0.0.1",
    port: int = 8000,
    *,
    store: ReportStore | None = None,
    web_dir: Path = WEB_DIR,
) -> None:
    store = store or ReportStore()
    handler = partial(Handler, store=store, web_dir=web_dir)
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
    parser.add_argument("--simulations", type=int, default=SimulationConfig.simulations)
    parser.add_argument("--seed", type=int, default=SimulationConfig.seed)
    parser.add_argument("--k-factor", type=float, default=EloConfig.k_factor)
    parser.add_argument("--home-advantage", type=float, default=EloConfig.home_advantage)
    parser.add_argument("--history-simulations", type=int, default=HistoryConfig.simulations)
    parser.add_argument("--reload", action="store_true", help="rebuild reports on every request")
    parser.add_argument("--root", type=Path, default=NORMALIZED_DIR)
    args = parser.parse_args(argv)

    store = ReportStore(
        args.root,
        elo_config=EloConfig(k_factor=args.k_factor, home_advantage=args.home_advantage),
        simulation=SimulationConfig(simulations=args.simulations, seed=args.seed),
        history=HistoryConfig(simulations=args.history_simulations, seed=args.seed),
        always_reload=args.reload,
    )
    print("replaying every season...")
    careers = store.careers()
    seasons = store.seasons()
    print(f"  {len(careers)} clubs across {seasons[0]}-{seasons[-1]}")
    print(f"building the current season ({args.simulations:,} simulations per league)...")
    store.reports()
    print("ready -- older seasons are built on first view")

    serve(args.host, args.port, store=store)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
