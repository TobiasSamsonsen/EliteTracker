"""Build a live league table from played matches.

Norwegian league football ranks on points, then goal difference, then goals
scored. Team name is the final tiebreak so the order is always deterministic
rather than dependent on dictionary insertion order.
"""

from __future__ import annotations

from dataclasses import dataclass

from elitetracker.normalize.matches import Match
from elitetracker.normalize.standings import POINTS_FOR_DRAW, POINTS_FOR_WIN


@dataclass
class TableRow:
    team_id: str
    team: str
    played: int = 0
    wins: int = 0
    draws: int = 0
    losses: int = 0
    goals_for: int = 0
    goals_against: int = 0

    @property
    def goal_difference(self) -> int:
        return self.goals_for - self.goals_against

    @property
    def points(self) -> int:
        return self.wins * POINTS_FOR_WIN + self.draws * POINTS_FOR_DRAW

    def record(self, scored: int, conceded: int) -> None:
        self.played += 1
        self.goals_for += scored
        self.goals_against += conceded
        if scored > conceded:
            self.wins += 1
        elif scored < conceded:
            self.losses += 1
        else:
            self.draws += 1


def ranking_key(row: TableRow) -> tuple[int, int, int, str]:
    """Sort key placing the best team first."""
    return (-row.points, -row.goal_difference, -row.goals_for, row.team)


def table_from_matches(matches: list[Match]) -> list[TableRow]:
    """Current standings. Every team in `matches` appears, even with 0 played."""
    rows: dict[str, TableRow] = {}

    def row_for(team_id: str | None, name: str) -> TableRow:
        key = team_id or name
        if key not in rows:
            rows[key] = TableRow(team_id=key, team=name)
        return rows[key]

    for match in matches:
        home = row_for(match.home_id, match.home)
        away = row_for(match.away_id, match.away)
        if match.played:
            home.record(match.home_goals, match.away_goals)
            away.record(match.away_goals, match.home_goals)

    return sorted(rows.values(), key=ranking_key)
