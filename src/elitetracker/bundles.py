"""Compact aggregates over the per-date report files already on disk.

The Play season animation and the Season mountain each read one small slice
(position, rating and finish chances per club) from every matchday's report.
Fetching ~70 full reports for that is megabytes; `timeline-<season>.json` is the
same numbers in one file. Nothing is recomputed: the values are copied from the
reports exactly as written, so the aggregate cannot disagree with them.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

# One report per matchday and one for the pre-season, both leagues each.
_DATED = re.compile(r"report-(?P<season>\d{4})-(?P<date>\d{4}-\d{2}-\d{2})\.json$")


def timeline_name(season: int) -> str:
    return f"timeline-{season}.json"


def timeline_payload(out_dir: Path, season: int) -> dict[str, Any] | None:
    """The season's per-date club rows, or None when no dated report exists.

    `dates` maps a date to `{league: [[team_id, position, rating, [finish
    chances...]], ...]}`, in each report's own row order.
    """
    dates: dict[str, dict[str, list[list[Any]]]] = {}
    for path in sorted(out_dir.glob(f"report-{season}-*.json")):
        match = _DATED.search(path.name)
        if not match or int(match["season"]) != season:
            continue
        report = json.loads(path.read_text(encoding="utf-8"))
        dates[match["date"]] = {
            league: [
                [row["team_id"], row["position"], row["rating"], row["position_probabilities"]]
                for row in body["table"]
            ]
            for league, body in report.items()
            if isinstance(body, dict) and "table" in body
        }
    if not dates:
        return None
    return {"season": season, "dates": dates}


def seasons_on_disk(out_dir: Path) -> list[int]:
    """Every season that has at least one dated report in `out_dir`."""
    found = {int(match["season"]) for path in out_dir.glob("report-*-*.json") if (match := _DATED.search(path.name))}
    return sorted(found)


def write_timelines(out_dir: Path, rebuilt: set[int]) -> list[str]:
    """Write `timeline-<season>.json` for every season that lacks one or whose
    reports were just rebuilt; returns the names written.

    A past season's reports come from the published archive and never change
    between archive rebuilds, so an existing timeline is kept. Reading all
    twelve seasons takes about ten seconds, so a deploy can afford to fill in
    the ones an older archive does not carry.
    """
    written = []
    for season in seasons_on_disk(out_dir):
        path = out_dir / timeline_name(season)
        if season not in rebuilt and path.exists():
            continue
        payload = timeline_payload(out_dir, season)
        if payload is None:
            continue
        path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        written.append(path.name)
    return written


def summary_name() -> str:
    return "seasons-summary.json"


_RESULT_FIELDS = ("match_id", "home_id", "away_id", "home", "away", "home_goals", "away_goals", "xg")


def summary_payload(out_dir: Path) -> dict[str, Any] | None:
    """What the Luck table and the prediction scorecard read from every season.

    Per season and league, shaped like the slice of the live report they use:
    `league` (season, preseason date), `model.matches_remaining`, `table`
    (id, name, final place), `results` (the match fields only) and `pre`, the
    pre-season finish chances (the pre-season report's, else the season
    shape's first snapshot where a build predates the first match; None when
    neither exists). Seasons without a live report on disk are left out.
    """
    seasons: dict[str, dict[str, Any]] = {}
    for season in seasons_on_disk(out_dir):
        path = out_dir / f"report-{season}.json"
        if not path.exists():
            continue
        live = json.loads(path.read_text(encoding="utf-8"))
        pre_reports: dict[str, Any] = {}
        by_league: dict[str, Any] = {}
        for league, body in live.items():
            if not (isinstance(body, dict) and "table" in body):
                continue
            preseason = (body.get("league") or {}).get("preseason")
            if preseason not in pre_reports:
                pre_path = out_dir / f"report-{season}-{preseason}.json"
                pre_reports[preseason] = (
                    json.loads(pre_path.read_text(encoding="utf-8")) if preseason and pre_path.exists() else None
                )
            pre_report = pre_reports[preseason]
            if pre_report and league in pre_report:
                pre = [
                    {"team_id": row["team_id"], "position_probabilities": row["position_probabilities"]}
                    for row in pre_report[league]["table"]
                ]
            else:
                history = body.get("history") or {}
                rounds = history.get("latest_rounds")
                if history.get("teams") and rounds and rounds[0] is None:
                    pre = [
                        {"team_id": team["team_id"], "position_probabilities": team["positions"][0]}
                        for team in history["teams"]
                    ]
                else:
                    pre = None
            by_league[league] = {
                "league": {"season": season, "slug": league, "preseason": preseason},
                "model": {"matches_remaining": (body.get("model") or {}).get("matches_remaining")},
                "table": [
                    {"team_id": row["team_id"], "team": row["team"], "position": row["position"]}
                    for row in body["table"]
                ],
                "results": [
                    {field: result.get(field) for field in _RESULT_FIELDS} for result in body.get("results") or []
                ],
                "pre": pre,
            }
        seasons[str(season)] = by_league
    return {"seasons": seasons} if seasons else None


def write_summary(out_dir: Path) -> str | None:
    """Write `seasons-summary.json` from the live reports on disk (always: the
    current season's changes with every result). Returns the name written."""
    payload = summary_payload(out_dir)
    if payload is None:
        return None
    path = out_dir / summary_name()
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return path.name
