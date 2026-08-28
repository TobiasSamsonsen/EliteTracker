"""Prebuild the whole site as static JSON for Firebase Hosting.

The local API server computes reports on request; a static host cannot run it.
This module runs the same pipeline offline and writes the full set of report
payloads into a directory that Firebase Hosting serves as plain files. The
frontend falls back to these when ``/api/*`` is absent.

Files written for every season:

    report.json                     current season, both leagues
    report-<season>.json            live view of that season
    report-<season>-<date>.json     rewound to a matchday (both leagues)

plus careers.json. Rewound reports use exactly the same config the server
applies to ``?asof=`` (see api.server.ReportStore._configs), so the static
site shows the same numbers the local one would.

The per-date rewinds dominate the build (about a thousand of them), so they
are farmed out to worker processes; the Monte Carlo is CPU-bound.
"""

from __future__ import annotations

import argparse
import json
import os
from concurrent.futures import ProcessPoolExecutor
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
# whole-percent display, while the ~2,266 rewound reports build roughly 5x
# faster than at the live 50,000. The live view keeps 50,000 for full precision.
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


class _Worker:
    """Holds the careers replay and root in each worker process."""

    root: Path = Path()
    careers: dict[str, Any] = {}
    elo_config: EloConfig = EloConfig()

    @classmethod
    def init(cls, root: str, k_factor: float, home_advantage: float, season_regression: float) -> None:
        cls.root = Path(root)
        cls.elo_config = EloConfig(
            k_factor=k_factor, home_advantage=home_advantage, season_regression=season_regression
        )
        cls.careers = build_all_careers(cls.root, elo_config=cls.elo_config)


def _build_league(spec: tuple[str, int, str | None]) -> dict[str, Any]:
    """One league report; a picklable entry point for the process pool."""
    slug, season, asof = spec
    return build_report(
        slug,
        season,
        root=_Worker.root,
        careers=_Worker.careers,
        elo_config=_Worker.elo_config,
        simulation=REWOUND_SIM if asof else SimulationConfig(),
        history=REWOUND_HISTORY if asof else HistoryConfig(),
        asof=asof,
    )


def _build_pair(
    season: int, asof: str | None, executor: ProcessPoolExecutor
) -> dict[str, dict[str, Any]]:
    """Both leagues for one (season, asof) view, keyed by league slug."""
    specs = [(slug, season, asof) for slug in LEAGUE_SPECS]
    reports = list(executor.map(_build_league, specs))
    return dict(zip(LEAGUE_SPECS, reports))


def write_payload(path: Path, payload: Any) -> None:
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)


def build_site(
    root: Path = NORMALIZED_DIR,
    out_dir: Path = Path("public/data"),
    jobs: int | None = None,
    season_regression: float = EloConfig.season_regression,
    only_season: int | None = None,
) -> None:
    """Write every season's live and rewound reports as static JSON.

    With ``only_season`` set, only that season's live and rewound reports are
    written (careers.json is still built once, since the current view needs it).
    This lets the deploy workflow refresh just the current season while reusing
    cached past-season reports, rather than rerunning every simulation.
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

    with ProcessPoolExecutor(
        max_workers=jobs,
        initializer=_Worker.init,
        initargs=(str(root), EloConfig().k_factor, EloConfig().home_advantage, EloConfig().season_regression),
    ) as executor:
        # Live view of every season, plus a copy of the current one under a
        # fixed name so the frontend's default request has a stable URL.
        for season in seasons:
            report = _build_pair(season, None, executor)
            write_payload(out_dir / f"report-{season}.json", report)
            if season == current:
                write_payload(out_dir / "report.json", report)
            print(f"report-{season}.json")

        # Every rewind date for every season. Submit the whole season's batch
        # in one go so all workers are kept busy; each date's two league reports
        # come back in spec order, so they are grouped as the stream is read.
        for season in seasons:
            dates = matchday_dates(root, season)
            specs = [
                (slug, season, asof) for asof in dates for slug in LEAGUE_SPECS
            ]
            per_date: dict[str, dict[str, Any]] = {
                asof: {} for asof in dates
            }
            for spec, report in zip(specs, executor.map(_build_league, specs, chunksize=20)):
                per_date[spec[2]][spec[0]] = report
            for asof, report in per_date.items():
                write_payload(out_dir / f"report-{season}-{asof}.json", report)
            print(f"rewinds for {season}: {len(dates)} dates")

    careers = build_all_careers(root)
    write_payload(out_dir / "careers.json", careers_payload(careers))
    print(f"careers.json  ({len(careers)} clubs)")


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
