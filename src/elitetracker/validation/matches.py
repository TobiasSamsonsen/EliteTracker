"""Consistency checks over a normalized match file.

Run as a script it exits non-zero when any check fails, so it can gate the
pipeline. Problems are split into errors (the data is wrong and downstream code
would silently misbehave) and warnings (suspicious, but legitimately possible
for a mid-season snapshot).
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

from elitetracker.normalize.matches import Match

# A double round-robin: every team meets every other team home and away.
# 16 teams -> 30 matchdays -> 240 matches, 15 home + 15 away per team.
ELITESERIEN_TEAM_COUNT = 16
OBOSLIGAEN_TEAM_COUNT = 16


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def error(self, message: str) -> None:
        self.errors.append(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)


def load_normalized(path: Path) -> list[Match]:
    with path.open(encoding="utf-8") as handle:
        records = json.load(handle)
    if not isinstance(records, list):
        raise ValueError(f"{path} should contain a list of matches")
    return [Match(**record) for record in records]


def _check_identity(matches: list[Match], report: Report) -> None:
    duplicates = [mid for mid, count in Counter(m.match_id for m in matches).items() if count > 1]
    if duplicates:
        report.error(f"duplicate match ids: {sorted(duplicates)}")

    fixtures = Counter((m.home, m.away) for m in matches)
    repeated = [pair for pair, count in fixtures.items() if count > 1]
    if repeated:
        report.error(f"fixture played more than once: {sorted(repeated)}")


def _check_fields(matches: list[Match], report: Report) -> None:
    for match in matches:
        if match.home == match.away:
            report.error(f"match {match.match_id}: {match.home} plays itself")

        # A non-string date means an upstream serializer mangled it (pandas
        # used to emit epoch milliseconds), so check the type, not just the format.
        if not isinstance(match.date, str):
            report.error(f"match {match.match_id}: date {match.date!r} is not ISO YYYY-MM-DD")
        else:
            try:
                datetime.strptime(match.date, "%Y-%m-%d")
            except ValueError:
                report.error(f"match {match.match_id}: date {match.date!r} is not ISO YYYY-MM-DD")

        goals = (match.home_goals, match.away_goals)
        if match.played:
            if None in goals:
                report.error(f"match {match.match_id}: marked played but missing a score")
            elif any(goal < 0 for goal in goals):
                report.error(f"match {match.match_id}: negative score {goals}")
        elif goals != (None, None):
            report.error(f"match {match.match_id}: marked unplayed but carries score {goals}")

        if match.venue is None:
            report.warn(f"match {match.match_id}: no venue")


def _check_order(matches: list[Match], report: Report) -> None:
    for previous, current in zip(matches, matches[1:]):
        if current.sort_key() < previous.sort_key():
            report.error(
                f"matches out of chronological order: {previous.match_id} "
                f"({previous.date}) precedes {current.match_id} ({current.date})"
            )


def _check_schedule(matches: list[Match], report: Report, expected_teams: int) -> None:
    teams = sorted({m.home for m in matches} | {m.away for m in matches})
    if len(teams) != expected_teams:
        report.error(f"expected {expected_teams} teams, found {len(teams)}: {teams}")
        return

    expected_total = expected_teams * (expected_teams - 1)
    if len(matches) != expected_total:
        report.error(f"expected {expected_total} matches in a double round-robin, found {len(matches)}")

    home_counts = Counter(m.home for m in matches)
    away_counts = Counter(m.away for m in matches)
    per_team = expected_teams - 1
    for team in teams:
        if home_counts[team] != per_team:
            report.error(f"{team} has {home_counts[team]} home matches, expected {per_team}")
        if away_counts[team] != per_team:
            report.error(f"{team} has {away_counts[team]} away matches, expected {per_team}")


def _check_against_today(matches: list[Match], report: Report, today: date) -> None:
    """Played/unplayed should broadly agree with the calendar.

    These are warnings, not errors: a match can be postponed (date in the past,
    no result) and a result can be entered before midnight of matchday.
    """
    stale = [m.match_id for m in matches if not m.played and m.date < today.isoformat()]
    if stale:
        report.warn(f"{len(stale)} match(es) dated in the past with no result (postponed, or stale data): {stale[:5]}")

    early = [m.match_id for m in matches if m.played and m.date > today.isoformat()]
    if early:
        report.error(f"{len(early)} match(es) dated in the future already carry a result: {early[:5]}")


def validate(matches: list[Match], *, expected_teams: int = ELITESERIEN_TEAM_COUNT, today: date | None = None) -> Report:
    report = Report()
    if not matches:
        report.error("no matches")
        return report

    _check_identity(matches, report)
    _check_fields(matches, report)
    _check_schedule(matches, report, expected_teams)

    # Ordering and calendar checks compare dates, so they can only run on
    # records whose date survived _check_fields.
    dated = [m for m in matches if isinstance(m.date, str)]
    _check_order(dated, report)
    _check_against_today(dated, report, today or date.today())
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("input", type=Path, help="normalized match JSON")
    parser.add_argument(
        "--teams",
        type=int,
        default=ELITESERIEN_TEAM_COUNT,
        help="number of teams in the division (default: %(default)s)",
    )
    args = parser.parse_args(argv)

    matches = load_normalized(args.input)
    report = validate(matches, expected_teams=args.teams)

    for warning in report.warnings:
        print(f"WARN  {warning}")
    for error in report.errors:
        print(f"ERROR {error}")

    played = sum(1 for m in matches if m.played)
    status = "OK" if report.ok else "FAILED"
    print(f"{status}: {len(matches)} matches, {played} played, {len(matches) - played} upcoming ({args.input})")
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
