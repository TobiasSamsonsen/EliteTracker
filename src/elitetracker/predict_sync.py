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
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from elitetracker.pipeline import NORMALIZED_DIR, current_season, load_matches
from elitetracker.predict.sync import LEAGUES, run
from elitetracker.sources.firestore import PROJECT, Firestore

REPORT_URL = "https://elitetracker.no/data/report.json"


def load_report(source: str) -> dict:
    if source.startswith(("http://", "https://")):
        request = urllib.request.Request(source, headers={"User-Agent": "elitetracker-predict-sync"})
        with urllib.request.urlopen(request, timeout=60) as reply:
            return json.loads(reply.read().decode("utf-8"))
    return json.loads(Path(source).read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--project", default=PROJECT)
    parser.add_argument("--report", default=REPORT_URL, help="the published report.json (path or URL)")
    parser.add_argument("--data-dir", type=Path, default=Path("data/predict"))
    parser.add_argument("--ics", type=Path, default=Path("public/predict/rounds.ics"))
    parser.add_argument("--now", help="override the clock (ISO 8601, for testing)")
    parser.add_argument("--dry-run", action="store_true", help="compute everything, commit and write nothing")
    parser.add_argument("--no-purge", action="store_true", help="skip deletion requests and the 24-month sweep")
    args = parser.parse_args(argv)

    now = datetime.fromisoformat(args.now) if args.now else datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    season = current_season()
    matches = {slug: load_matches(NORMALIZED_DIR / f"{slug}_{season}_matches.json") for slug in LEAGUES}
    summary = run(Firestore(args.project), now=now, matches_by_slug=matches, season=season,
                  report=load_report(args.report), data_dir=args.data_dir, ics_path=args.ics,
                  purge=not args.no_purge, dry_run=args.dry_run)
    print(json.dumps(summary, indent=1, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
