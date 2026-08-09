"""Consistency checks over a normalized final league table.

Run as a script it exits non-zero when any check fails, so it can gate the
pipeline before the table is used to seed ELO ratings.
"""

from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path

from elitetracker.normalize.standings import Standing, load_standings
from elitetracker.validation.matches import Report

DEFAULT_TEAM_COUNT = 16


def _check_rows(standings: list[Standing], report: Report) -> None:
    for row in standings:
        if row.wins + row.draws + row.losses != row.played:
            report.error(
                f"{row.team}: {row.wins}W+{row.draws}D+{row.losses}L does not sum to {row.played} played"
            )
        if min(row.wins, row.draws, row.losses, row.goals_for, row.goals_against) < 0:
            report.error(f"{row.team}: negative tally in {row}")
        if row.deduction > 0:
            report.error(f"{row.team}: deduction {row.deduction} should be negative or zero")

        # The published total must equal results minus any docked points.
        # A mismatch means we misread the deduction, which would silently skew
        # the finishing order used to seed ELO.
        if row.points != row.expected_points + row.deduction:
            report.error(
                f"{row.team}: {row.points} points but {row.wins}W/{row.draws}D "
                f"with deduction {row.deduction} implies {row.expected_points + row.deduction}"
            )


def _check_table_shape(standings: list[Standing], report: Report, expected_teams: int) -> None:
    if len(standings) != expected_teams:
        report.error(f"expected {expected_teams} teams, found {len(standings)}")

    positions = [row.position for row in standings]
    if positions != list(range(1, len(standings) + 1)):
        report.error(f"positions are not 1..{len(standings)}: {positions}")

    for label, values in (("team name", [r.team for r in standings]), ("team id", [r.team_id for r in standings])):
        duplicates = [value for value, count in Counter(values).items() if count > 1]
        if duplicates:
            report.error(f"duplicate {label}: {sorted(duplicates)}")

    played = {row.played for row in standings}
    if len(played) > 1:
        report.error(f"teams played different numbers of matches: {sorted(played)}")
    elif played:
        # A complete double round-robin: every team plays every other twice.
        expected_played = 2 * (expected_teams - 1)
        if played != {expected_played}:
            report.error(f"expected {expected_played} matches per team, found {played.pop()}")


def _check_totals(standings: list[Standing], report: Report) -> None:
    """League-wide identities that catch a partially-scraped table."""
    total_wins = sum(row.wins for row in standings)
    total_losses = sum(row.losses for row in standings)
    if total_wins != total_losses:
        report.error(f"{total_wins} wins but {total_losses} losses league-wide")

    if sum(row.draws for row in standings) % 2 != 0:
        report.error("total draws is odd; every draw should be counted by both teams")

    goals_for = sum(row.goals_for for row in standings)
    goals_against = sum(row.goals_against for row in standings)
    if goals_for != goals_against:
        report.error(f"{goals_for} goals scored but {goals_against} conceded league-wide")


def _check_order(standings: list[Standing], report: Report) -> None:
    """Positions must be consistent with points, then goal difference.

    Norwegian league tiebreaks go points -> goal difference -> goals scored, so
    a team placed above another with fewer points is a parsing error.
    """
    for higher, lower in zip(standings, standings[1:]):
        if higher.points < lower.points:
            report.error(
                f"{higher.team} ({higher.points} pts) is placed above "
                f"{lower.team} ({lower.points} pts)"
            )
        elif higher.points == lower.points and higher.goal_difference < lower.goal_difference:
            report.warn(
                f"{higher.team} and {lower.team} are level on {higher.points} pts but the "
                f"higher-placed team has the worse goal difference "
                f"({higher.goal_difference:+d} vs {lower.goal_difference:+d})"
            )


def validate(standings: list[Standing], *, expected_teams: int = DEFAULT_TEAM_COUNT) -> Report:
    report = Report()
    if not standings:
        report.error("no standings rows")
        return report

    _check_rows(standings, report)
    _check_table_shape(standings, report, expected_teams)
    _check_totals(standings, report)
    _check_order(standings, report)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("input", type=Path, help="normalized standings JSON")
    parser.add_argument("--teams", type=int, default=DEFAULT_TEAM_COUNT)
    args = parser.parse_args(argv)

    standings = load_standings(args.input)
    report = validate(standings, expected_teams=args.teams)

    for warning in report.warnings:
        print(f"WARN  {warning}")
    for error in report.errors:
        print(f"ERROR {error}")

    status = "OK" if report.ok else "FAILED"
    champion = standings[0].team if standings else "?"
    print(f"{status}: {len(standings)} teams, won by {champion} ({args.input})")
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
