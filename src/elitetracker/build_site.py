"""Prebuild the whole site as static JSON for Firebase Hosting.

The local API server computes reports on request; a static host cannot run it.
This module runs the same pipeline offline and writes the full set of report
payloads into a directory that Firebase Hosting serves as plain files.

Files written for every season:

    report.json                     current season, both leagues
    report-<season>.json            live view of that season
    report-<season>-<date>.json     rewound to a matchday (both leagues)

plus careers.json. Rewound reports use exactly the same config the server
applies to a rewound request (see api.server.ReportStore._configs), so the
static site shows the same numbers the local one would.

The unit of work is one *view* -- both leagues for a (season, date) -- and the
worker writes its own file. Nothing but a name, a size and a duration crosses
back, so a 270 MB build moves no report payloads between processes. Every view
for every season is queued in one go, so the pool never drains between seasons;
the expensive live reports go in first, since a long task started late is what
sets the finishing time.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from elitetracker.model.elo import EloConfig
from elitetracker.pipeline import (
    LEAGUE_SPECS,
    NORMALIZED_DIR,
    available_seasons,
    build_all_careers,
    build_report,
    careers_payload,
    current_season,
    load_matches,
)
from elitetracker.simulation.history import HistoryConfig
from elitetracker.simulation.season import SimulationConfig

# Matches ReportStore._configs(asof): the grid keeps the live simulation count
# but the season-shape history is thinned so a rewound view builds fast.
REWOUND_HISTORY = HistoryConfig(simulations=2_500, max_snapshots=8)

# The rewound grid is also thinned: dragging back through the season reads off
# the same finish-probability matrix, but it is a trend view, not a number off
# the live table. At 10,000 the worst grid cell is ~1.31 pp -- still below the
# model's 1.54 pp calibration error -- so the drop in fidelity is invisible at
# whole-percent display, while the rewound reports build roughly 5x faster than
# at the live 50,000. The live view keeps 50,000 for full precision.
REWOUND_SIM = SimulationConfig(simulations=10_000)


def matchday_dates(root: Path, season: int) -> list[str]:
    """Every day either league played on, in order.

    The rewind slider steps one date at a time, and a rewound report always
    carries both leagues, so the union of the two fixture lists is the set of
    dates worth prebuilding.
    """
    dates: set[str] = set()
    for slug in LEAGUE_SPECS:
        matches = load_matches(root / f"{slug}_{season}_matches.json")
        dates.update(match.date for match in matches if match.played)
    return sorted(dates)


def write_payload(path: Path, payload: Any) -> int:
    """Write `payload` as compact JSON; returns the bytes written."""
    blob = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    path.write_bytes(blob)
    return len(blob)


class _Worker:
    """Per-process state: the careers replay, the root, and where to write."""

    root: Path = Path()
    out_dir: Path = Path()
    careers: dict[str, Any] = {}
    elo_config: EloConfig = EloConfig()

    @classmethod
    def init(cls, root: str, out_dir: str, season_regression: float) -> None:
        cls.root = Path(root)
        cls.out_dir = Path(out_dir)
        cls.elo_config = EloConfig(season_regression=season_regression)
        cls.careers = build_all_careers(cls.root, elo_config=cls.elo_config)


@dataclass(frozen=True)
class _Done:
    """What a finished view reports back. Deliberately tiny."""

    name: str
    season: int
    size: int
    seconds: float


def _build_view(spec: tuple[int, str | None, bool]) -> _Done:
    """Both leagues for one view, written to disk. Runs in a worker process."""
    season, asof, is_default = spec
    started = time.perf_counter()

    report = {
        slug: build_report(
            slug,
            season,
            root=_Worker.root,
            careers=_Worker.careers,
            elo_config=_Worker.elo_config,
            simulation=REWOUND_SIM if asof else SimulationConfig(),
            history=REWOUND_HISTORY if asof else HistoryConfig(),
            asof=asof,
        )
        for slug in LEAGUE_SPECS
    }

    name = f"report-{season}-{asof}.json" if asof else f"report-{season}.json"
    size = write_payload(_Worker.out_dir / name, report)
    if is_default:
        # The frontend's first request asks for a fixed name, so the current
        # season is written twice rather than redirected.
        write_payload(_Worker.out_dir / "report.json", report)
    return _Done(name, season, size, time.perf_counter() - started)


# ---------- progress and stats ----------------------------------------

def _duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes, seconds = divmod(int(seconds), 60)
    if minutes < 60:
        return f"{minutes}m{seconds:02d}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes:02d}m"


def _megabytes(size: int) -> str:
    return f"{size / 1_000_000:.1f} MB"


class _Progress:
    """A one-line bar on a terminal, occasional lines in a log.

    CI captures stdout to a file, where a carriage-returned bar would be a
    single unreadable line thousands of characters long, so a non-tty gets a
    plain line every 10% instead.
    """

    WIDTH = 28

    def __init__(self, total: int, stream=sys.stderr) -> None:
        self.total = total
        self.stream = stream
        self.tty = hasattr(stream, "isatty") and stream.isatty()
        self.done = 0
        self.started = time.perf_counter()
        self._next_log = 0.1
        self._last_draw = 0.0

    def advance(self) -> None:
        self.done += 1
        elapsed = time.perf_counter() - self.started
        fraction = self.done / self.total if self.total else 1.0

        if not self.tty:
            if fraction >= self._next_log or self.done == self.total:
                self._next_log = fraction + 0.1
                print(
                    f"  {self.done}/{self.total} views ({fraction:.0%}) "
                    f"in {_duration(elapsed)}",
                    file=self.stream,
                    flush=True,
                )
            return

        # Redrawing on every completion is wasted work at 20 views a second.
        if self.done < self.total and time.perf_counter() - self._last_draw < 0.1:
            return
        self._last_draw = time.perf_counter()

        filled = int(self.WIDTH * fraction)
        bar = "█" * filled + "░" * (self.WIDTH - filled)
        eta = (elapsed / self.done) * (self.total - self.done) if self.done else 0.0
        self.stream.write(
            f"\r  [{bar}] {self.done}/{self.total} {fraction:>4.0%}  "
            f"{_duration(elapsed)} elapsed  eta {_duration(eta)}   "
        )
        self.stream.flush()

    def finish(self) -> None:
        if self.tty:
            self.stream.write("\r\033[K")
            self.stream.flush()


@dataclass
class _Stats:
    views: list[_Done] = field(default_factory=list)
    wall: float = 0.0
    workers: int = 0

    def report(self, extra_files: int, extra_bytes: int) -> str:
        total_bytes = sum(view.size for view in self.views) + extra_bytes
        cpu = sum(view.seconds for view in self.views)
        files = len(self.views) + extra_files
        slowest = max(self.views, key=lambda view: view.seconds, default=None)

        lines = [
            f"built {len(self.views)} views in {_duration(self.wall)} "
            f"on {self.workers} workers",
            f"  files       {files:>6}   {_megabytes(total_bytes)}",
            f"  throughput  {len(self.views) / self.wall:>6.1f} views/s",
            f"  cpu         {_duration(cpu)} of work, "
            f"{cpu / self.wall:.1f}x speed-up",
        ]
        if slowest is not None:
            lines.append(
                f"  slowest     {slowest.name} ({_duration(slowest.seconds)})"
            )

        by_season: dict[int, list[_Done]] = {}
        for view in self.views:
            by_season.setdefault(view.season, []).append(view)
        if len(by_season) > 1:
            lines.append("  per season:")
            for season in sorted(by_season):
                group = by_season[season]
                lines.append(
                    f"    {season}  {len(group):>4} views  "
                    f"{_megabytes(sum(v.size for v in group)):>9}  "
                    f"{_duration(sum(v.seconds for v in group)):>8} cpu"
                )
        return "\n".join(lines)


# ---------- the build ---------------------------------------------------

def build_site(
    root: Path = NORMALIZED_DIR,
    out_dir: Path = Path("public/data"),
    jobs: int | None = None,
    season_regression: float = EloConfig.season_regression,
    only_season: int | None = None,
) -> None:
    """Write every season's live and rewound reports as static JSON.

    With ``only_season`` set, only that season's views are written (careers.json
    is still built, since the current view needs it). That is what the deploy
    workflow runs: past seasons come from the published archive instead.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    jobs = jobs or os.cpu_count() or 1

    all_seasons = available_seasons(root)
    if not all_seasons:
        raise FileNotFoundError(f"no normalized match data in {root}")
    if only_season is not None:
        if only_season not in all_seasons:
            raise ValueError(f"no normalized match data for season {only_season}")
        seasons = [only_season]
    else:
        seasons = all_seasons
    current = current_season(root)

    # Live views first: at 50,000 simulations each is worth about five rewinds,
    # and the pool finishes when its longest straggler does.
    specs: list[tuple[int, str | None, bool]] = [
        (season, None, season == current) for season in seasons
    ]
    specs += [
        (season, asof, False)
        for season in seasons
        for asof in matchday_dates(root, season)
    ]

    print(
        f"building {len(specs)} views across {len(seasons)} season(s) "
        f"on {jobs} workers",
        flush=True,
    )

    stats = _Stats(workers=jobs)
    progress = _Progress(len(specs))
    started = time.perf_counter()

    with ProcessPoolExecutor(
        max_workers=jobs,
        initializer=_Worker.init,
        initargs=(str(root), str(out_dir), season_regression),
    ) as executor:
        futures = [executor.submit(_build_view, spec) for spec in specs]
        for future in as_completed(futures):
            stats.views.append(future.result())
            progress.advance()

    progress.finish()
    stats.wall = time.perf_counter() - started

    careers = build_all_careers(root)
    careers_bytes = write_payload(out_dir / "careers.json", careers_payload(careers))

    # report.json is a second copy of the current season's live view.
    extra_files = 1 + sum(1 for spec in specs if spec[2])
    print(stats.report(extra_files, careers_bytes), flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=NORMALIZED_DIR)
    parser.add_argument("--out", type=Path, default=Path("public/data"))
    parser.add_argument("--jobs", type=int, help="worker processes (default: CPU count)")
    parser.add_argument("--regression", type=float, default=EloConfig.season_regression,
                        help="cross-season mean reversion (1.0 = none)")
    parser.add_argument("--only-season", type=int, default=None,
                        help="rebuild just this season (default: all seasons)")
    args = parser.parse_args(argv)

    build_site(
        args.root,
        args.out,
        jobs=args.jobs,
        season_regression=args.regression,
        only_season=args.only_season,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
