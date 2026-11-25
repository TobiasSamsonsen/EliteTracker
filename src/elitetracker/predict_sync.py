"""Run the Predict job once (docs/predict.md, "The hourly job").

    python -m elitetracker.predict_sync                  # the real thing, against Firestore
    python -m elitetracker.predict_sync --dry-run        # print what it would do, write nothing
    FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 python -m elitetracker.predict_sync   # the local emulator

Credentials: FIRESTORE_ACCESS_TOKEN (CI, from google-github-actions/auth with
Workload Identity) or a logged-in ``gcloud``; see sources/firestore.py. The
model's published odds are read from the live site's report.json (the odds a
player could have seen), or from ``--report`` (a path or URL).
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from elitetracker.pipeline import NORMALIZED_DIR, available_seasons, current_season, load_matches
from elitetracker.predict.sync import LEAGUES, run
from elitetracker.sources.firestore import PROJECT, Firestore

REPORT_URL = "https://elitetracker.no/data/report.json"
REPORT_RETRY_DELAYS = (2.0, 5.0, 10.0, 15.0)


def load_report(
    source: str,
    *,
    retries: tuple[float, ...] = REPORT_RETRY_DELAYS,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    if not source.startswith(("http://", "https://")):
        return json.loads(Path(source).read_text(encoding="utf-8"))
    request = urllib.request.Request(source, headers={"User-Agent": "elitetracker-predict-sync"})
    for attempt in range(len(retries) + 1):
        try:
            with urllib.request.urlopen(request, timeout=60) as reply:
                return json.loads(reply.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if attempt >= len(retries) or not (error.code == 429 or 500 <= error.code < 600):
                raise
        except (OSError, ValueError):
            if attempt >= len(retries):
                raise
        sleep(retries[attempt])
    raise AssertionError("unreachable")


LOCAL_REPORT = Path("public/data/report.json")


def load_report_or_local(
    source: str,
    local: Path = LOCAL_REPORT,
    *,
    retries: tuple[float, ...] = REPORT_RETRY_DELAYS,
    sleep: Callable[[float], None] = time.sleep,
) -> tuple[dict, str | None]:
    """The published report, or (when the live site cannot be reached) the one built in this checkout,
    with a warning: those are the odds of the last build, not necessarily what a player saw. A match
    left without odds is unscorable for good, so a close copy beats none."""
    try:
        return load_report(source, retries=retries, sleep=sleep), None
    except (OSError, ValueError) as error:          # URLError and HTTPError are OSErrors; a bad body is a ValueError
        if not source.startswith(("http://", "https://")) or not local.exists():
            raise
        return load_report(str(local)), f"the odds come from {local} ({str(error)[:80]}): the live report.json could not be read"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--project", default=PROJECT)
    parser.add_argument("--report", default=REPORT_URL, help="the published report.json (path or URL)")
    parser.add_argument("--data-dir", type=Path, default=Path("data/predict"))
    parser.add_argument("--now", help="override the clock (ISO 8601, for testing)")
    parser.add_argument("--dry-run", action="store_true", help="compute everything, commit and write nothing")
    parser.add_argument("--no-purge", action="store_true", help="skip deletion requests and the 24-month sweep")
    args = parser.parse_args(argv)

    now = datetime.fromisoformat(args.now) if args.now else datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    season = current_season()
    store = Firestore(args.project)
    report, warning = load_report_or_local(args.report)
    if warning:
        print(f"warning: {warning}", file=sys.stderr)
    results = {}
    # When the next season's fixtures are already in, the season that just ended may still have rounds to
    # score and its table game to settle: the job would otherwise never look at it again.
    # (Only a season the job has played: its fixtures are in meta/sync. Seasons from before launch are left be.)
    ran = any(str(k).startswith(f"{season - 1}_") for k in ((store.get("meta/sync") or {}).get("fixtures") or {}))
    if ran and season - 1 in available_seasons(NORMALIZED_DIR):
        earlier = {slug: load_matches(NORMALIZED_DIR / f"{slug}_{season - 1}_matches.json") for slug in LEAGUES
                   if (NORMALIZED_DIR / f"{slug}_{season - 1}_matches.json").exists()}
        if earlier:
            results[season - 1] = run(store, now=now, matches_by_slug=earlier, season=season - 1, report=report,
                                      data_dir=args.data_dir, purge=False, dry_run=args.dry_run, publish=False)
    matches = {slug: load_matches(NORMALIZED_DIR / f"{slug}_{season}_matches.json") for slug in LEAGUES}
    results[season] = run(store, now=now, matches_by_slug=matches, season=season, report=report,
                          data_dir=args.data_dir, purge=not args.no_purge, dry_run=args.dry_run)
    if warning:
        for done in results.values():
            done["warnings"].append(warning)
    print(json.dumps(results[season] if len(results) == 1 else results, indent=1, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
