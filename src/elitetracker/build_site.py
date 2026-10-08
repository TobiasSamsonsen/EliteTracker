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
import hashlib
import json
import os
import time
from dataclasses import asdict
from multiprocessing import Pool
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
    load_matches,
    rewound_configs,
)
from elitetracker.sources.fotmob import load_xg

MANIFEST_NAME = "build-manifest.json"

# The package's own source. Hashing it means any change to the model, the
# pipeline or the simulation invalidates every view; a frontend-only push
# touches none of it, so nothing is invalidated.
_PACKAGE_DIR = Path(__file__).resolve().parent


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


# --------------------------------------------------------------------------
# Incremental rebuild
#
# A rewound report is a pure function of the results played *on or before* its
# rewind date, so once written it is immutable and never needs rebuilding
# again -- a new result on Sunday cannot change what the site said on the 1st.
# Each view therefore carries its own stamp over its own date prefix, and is
# reused when that stamp is unchanged. A single global stamp would not do:
# any new result would invalidate every view and rebuild the whole season on
# every matchday, which is exactly the cost this avoids.
# --------------------------------------------------------------------------

# Records are hashed through sorted-key JSON so the digest is stable across
# runs and Python versions -- the manifest is compared across CI runs.
def _digest_records(records: list[dict[str, Any]], extras: list[str]) -> str:
    blob = json.dumps(records, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256("\n".join(extras + [blob]).encode("utf-8")).hexdigest()


def view_stamp(
    root: Path,
    season: int,
    asof: str | None,
    *,
    season_regression: float,
) -> str:
    """A digest of everything that can affect the view for (season, asof).

    When `asof` is set, only results played on or before that date count, which
    is what makes a rewound view reusable. Unplayed fixtures always count: the
    view lists future fixtures, so a rescheduled match changes it whatever the
    date. A live view (`asof=None`) sees every result, so any data change
    invalidates it -- as it must.
    """
    extras = [MODEL_VERSION, str(season), str(asof), str(season_regression)]

    # Model source. A frontend-only push changes none of this.
    for source in sorted(_PACKAGE_DIR.rglob("*.py")):
        extras.append(hashlib.sha256(source.read_bytes()).hexdigest())

    # Seed ratings come from the 2014 tables, which every view replays from.
    for standings in sorted(root.glob("*_standings.json")):
        extras.append(hashlib.sha256(standings.read_bytes()).hexdigest())

    shot_dates: dict[str, str] = {}
    records: list[dict[str, Any]] = []
    for path in sorted(root.glob("*_matches.json")):
        for match in load_matches(path):
            shot_dates[match.match_id] = match.date
            record = asdict(match)
            if asof and match.played and match.date > asof:
                # A rewound view shows every match after its date as unplayed,
                # whether or not it has since been played -- the result is not
                # knowable back then. Both states must therefore hash the same,
                # or every fixture would churn the stamp of every earlier rewind.
                record.update(
                    played=False,
                    home_goals=None,
                    away_goals=None,
                )
            records.append(record)

    # Only xG for matches this view knows about. xG arriving for a later match
    # must not invalidate an earlier rewind.
    shots = load_xg().get("matches", {})
    records += [
        {"match_id": match_id, "xg": values}
        for match_id, values in sorted(shots.items())
        if asof is None or shot_dates.get(match_id, "") <= asof
    ]

    extras.append(repr(rewound_configs(asof)))  # simulation settings differ live vs rewound
    return _digest_records(records, extras)


def careers_stamp(root: Path, *, season_regression: float) -> str:
    """Digest for careers.json, which spans every season and every result."""
    extras = [MODEL_VERSION, str(season_regression)]
    for source in sorted(_PACKAGE_DIR.rglob("*.py")):
        extras.append(hashlib.sha256(source.read_bytes()).hexdigest())
    records: list[dict[str, Any]] = []
    for path in sorted(root.glob("*_matches.json")):
        records += [asdict(match) for match in load_matches(path)]
    records += [
        {"match_id": match_id, "xg": values}
        for match_id, values in sorted(load_xg().get("matches", {}).items())
    ]
    return _digest_records(records, extras)


def reusable(names: list[str], stamp: str, previous: dict[str, str], out_dir: Path) -> bool:
    """True when every one of these files is already on disk and unchanged.

    Both conditions are required. A stamp without its file would let a wiped or
    partially-extracted out_dir ship an empty view, which is the one failure
    mode that must never happen.
    """
    return all(previous.get(name) == stamp and (out_dir / name).exists() for name in names)


def _read_manifest(out_dir: Path) -> dict[str, str]:
    """Previously written stamps. A missing or corrupt manifest just means
    nothing can be trusted yet, so everything is rebuilt."""
    try:
        loaded = json.loads((out_dir / MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _write_manifest(out_dir: Path, stamps: dict[str, str]) -> None:
    path = out_dir / MANIFEST_NAME
    temp = path.with_suffix(".json.tmp")
    temp.write_text(json.dumps(stamps, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temp, path)


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
    # Use all available CPU cores. BIOS update (0x12B microcode) fixed the
    # Raptor Lake CLOCK_WATCHDOG_TIMEOUT instability under sustained all-core load.
    # --jobs still overrides.
    jobs = jobs or (os.cpu_count() or 1)

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
    candidates: list[tuple[int, str | None, bool]] = [
        (season, None, season == current) for season in seasons
    ]
    candidates += [
        (season, asof, False)
        for season in seasons
        for asof in matchday_dates(root, season)
    ]

    # Drop the views whose inputs have not moved since they were last written.
    # The output must still be on disk: a stamp without its file means a wiped
    # or partial out_dir, and rebuilding is the only safe answer.
    previous = _read_manifest(out_dir)
    specs: list[tuple[int, str | None, bool]] = []
    # Reused views keep the stamp they were written under. Recording only the
    # views built now would drop the rest from the manifest, and the run after
    # next would rebuild all of them again.
    stamps: dict[str, str] = dict(previous)
    for spec in candidates:
        season, asof, is_default = spec
        stamp = view_stamp(root, season, asof, season_regression=season_regression)
        names = [f"report-{season}-{asof}.json" if asof else f"report-{season}.json"]
        if is_default:
            names.append("report.json")
        if reusable(names, stamp, previous, out_dir):
            continue  # unchanged since it was written; keep what is there
        specs.append(spec)
        for name in names:
            stamps[name] = stamp

    reused = len(candidates) - len(specs)
    if reused:
        print(f"reusing {reused}/{len(candidates)} unchanged views", flush=True)

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

    # careers.json spans every season and every result, so it is stamped on its
    # own inputs rather than on any view's date prefix.
    careers_digest = careers_stamp(root, season_regression=season_regression)
    if previous.get("careers.json") != careers_digest or not (out_dir / "careers.json").exists():
        write_payload(out_dir / "careers.json", careers_payload(careers, root=root))
    stamps["careers.json"] = careers_digest

    # Only written once the build succeeded: a manifest that claimed a view was
    # written when it was not would let the next run skip a missing file.
    _write_manifest(out_dir, stamps)
    print(f"built {len(specs)} views in {time.perf_counter() - started:.0f}s", flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=NORMALIZED_DIR)
    parser.add_argument("--out", type=Path, default=Path("public/data"))
    parser.add_argument("--jobs", type=int, help="worker processes (default: min(8, CPU count))")
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
