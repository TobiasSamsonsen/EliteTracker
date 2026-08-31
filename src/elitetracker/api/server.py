"""Backend API for the EliteTracker site, on the standard library alone.

Reports are built once at start-up (a full run is well under a second) and held
in memory, so page loads never trigger a simulation and never touch the network.
``--reload`` rebuilds on every request instead, which is what you want while
editing the model.

    python -m elitetracker.api.server --port 8000

It answers the same ``/data/*.json`` names ``build_site`` writes for Firebase,
so the frontend has one URL scheme and no idea which host is behind it. Anything
else is served from ``public/``.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import re
import threading
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
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

WEB_DIR = Path(__file__).resolve().parents[3] / "public"

# The filenames build_site writes: report.json, report-<season>.json and
# report-<season>-<date>.json.
_REPORT_NAME = re.compile(r"report(?:-(\d{4})(?:-(\d{4}-\d{2}-\d{2}))?)?\.json")


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

    # The rewound view thins both the grid (10,000) and the season-shape
    # history (2,500 x 8) versus the live view (50,000 grid). At 10,000 the
    # worst grid cell is ~1.31 pp -- still below the model's 1.54 pp
    # calibration error -- so the small fidelity step as you drag back is
    # invisible at whole-percent display, while rewound reports build far
    # faster. Results are cached per date, so that cost is paid once per day.
    def _configs(self, asof: str | None) -> tuple[SimulationConfig, HistoryConfig]:
        if not asof:
            return self.simulation, self.history
        return (
            SimulationConfig(simulations=10_000, seed=self.simulation.seed),
            HistoryConfig(simulations=2_500, seed=self.history.seed, max_snapshots=8),
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
        if self.path.startswith("/data/"):
            super().log_message(format, *args)

    def do_GET(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        path = self.path.split("?", 1)[0]
        try:
            if path.startswith("/data/"):
                self._data_route(path.removeprefix("/data/"))
            else:
                self._static(path)
        except BrokenPipeError:
            pass  # the browser navigated away mid-response
        except Exception as exc:  # keep one bad request from killing the server
            self.log_error("%s", exc)
            self._json({"error": str(exc)}, status=500)

    def _data_route(self, name: str) -> None:
        """Compute what the static build would have written under /data/."""
        if name == "careers.json":
            self._json(careers_payload(self.store.careers()))
            return
        match = _REPORT_NAME.fullmatch(name)
        if match is None:
            self._json({"error": "not found"}, status=404)
            return
        season = int(match.group(1)) if match.group(1) else current_season(self.store.root)
        if season not in self.store.seasons():
            self._json({"error": f"no data for season {season}"}, status=404)
            return
        self._json(self.store.reports(season, match.group(2)))

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
    parser.add_argument("--regression", type=float, default=EloConfig.season_regression,
                        help="cross-season mean reversion (1.0 = none)")
    parser.add_argument("--history-simulations", type=int, default=HistoryConfig.simulations)
    parser.add_argument("--reload", action="store_true", help="rebuild reports on every request")
    parser.add_argument("--root", type=Path, default=NORMALIZED_DIR)
    args = parser.parse_args(argv)

    store = ReportStore(
        args.root,
        elo_config=EloConfig(
            k_factor=args.k_factor,
            home_advantage=args.home_advantage,
            season_regression=args.regression,
        ),
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
