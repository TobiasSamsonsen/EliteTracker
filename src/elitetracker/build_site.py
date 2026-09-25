"""Prebuild the whole site as static JSON for Firebase Hosting.

The local API server computes reports on request; a static host cannot run it.
This module runs the same pipeline offline and writes the full set of report
payloads into a directory that Firebase Hosting serves as plain files.

Files written for every season:

    report.json                     current season, both leagues
    report-<season>.json            live view of that season
    report-<season>-<date>.json     rewound to a matchday (both leagues)

plus careers.json. Rewound reports use exactly the same config the server
applies to a rewound request (see pipeline.rewound_configs), so the static
site shows the same numbers the local one would.

The unit of work is one *view* -- both leagues for a (season, date) -- and the
worker writes its own file, so a 270 MB build moves no report payloads between
processes. Every view for every season is queued in one go; the expensive live
reports go in first, since a long task started late is what sets the finishing
time.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from multiprocessing import Pool
from pathlib import Path
from typing import Any

import psutil

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
    rewound_configs,
)


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


# Per-process state, set once by the pool initializer.
_ROOT = Path()
_OUT = Path()
_ELO = EloConfig()
_CAREERS: dict[str, Any] = {}


def _init_worker(root: str, out_dir: str, season_regression: float, careers: dict[str, Any]) -> None:
    global _ROOT, _OUT, _ELO, _CAREERS
    _ROOT, _OUT = Path(root), Path(out_dir)
    _ELO = EloConfig(season_regression=season_regression)
    _CAREERS = careers


def _build_view(spec: tuple[int, str | None, bool]) -> str:
    """Both leagues for one view, written to disk. Runs in a worker process."""
    season, asof, is_default = spec
    simulation, history = rewound_configs(asof)
    report = {
        slug: build_report(
            slug, season, root=_ROOT, careers=_CAREERS, elo_config=_ELO,
            simulation=simulation, history=history, asof=asof,
        )
        for slug in LEAGUE_SPECS
    }
    name = f"report-{season}-{asof}.json" if asof else f"report-{season}.json"
    write_payload(_OUT / name, report)
    if is_default:
        # The frontend's first request asks for a fixed name, so the current
        # season is written twice rather than redirected.
        write_payload(_OUT / "report.json", report)
    return name


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
    # Cap at physical cores: Windows spawn mode hits kernel limits (commit charge /
    # process handle table) at physical_core_count+1 concurrent processes.
    # Logical cores (hyperthreads) share the same physical resources.
    physical_cores = psutil.cpu_count(logical=False) or os.cpu_count() or 1
    jobs = min(jobs, physical_cores)

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

    print(f"building {len(specs)} views across {len(seasons)} season(s) on {jobs} workers", flush=True)
    started = time.perf_counter()

    elo = EloConfig(season_regression=season_regression)
    careers = build_all_careers(root, elo_config=elo)

    # Use multiprocessing.Pool with maxtasksperchild to recycle workers and
    # prevent unbounded memory growth from accumulated garbage in long-running
    # simulation tasks. Each worker is replaced after 2 views at high concurrency
    # (>=16) to keep memory bounded; 5 at lower counts.
    max_tasks = 2 if jobs >= 16 else 5
    with Pool(
        processes=jobs,
        initializer=_init_worker,
        initargs=(str(root), str(out_dir), season_regression, careers),
        maxtasksperchild=max_tasks,
    ) as pool:
        for done, name in enumerate(pool.imap_unordered(_build_view, specs), 1):
            print(f"  {done}/{len(specs)} {name}", flush=True)

    write_payload(out_dir / "careers.json", careers_payload(careers, root=root))
    print(f"built {len(specs)} views in {time.perf_counter() - started:.0f}s", flush=True)


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
