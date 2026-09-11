"""The canonical final-league-table schema.

Initial ELO ratings are derived from the seed season's finishing positions,
so this is the only historical data the model consumes.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

# Points awarded per result in Norwegian league football.
POINTS_FOR_WIN = 3
POINTS_FOR_DRAW = 1


@dataclass(frozen=True)
class Standing:
    position: int  # 1 = champions
    team: str
    team_id: str  # stable across seasons; the join key to match data
    played: int
    wins: int
    draws: int
    losses: int
    goals_for: int
    goals_against: int
    points: int  # as published, i.e. already including any deduction
    deduction: int = 0  # negative when points were docked, else 0

    @property
    def goal_difference(self) -> int:
        return self.goals_for - self.goals_against


def load_standings(path: Path) -> list[Standing]:
    with path.open(encoding="utf-8") as handle:
        records = json.load(handle)
    if not isinstance(records, list):
        raise ValueError(f"{path} should contain a list of standings rows")
    # goal_difference is derived; ignore it if a previous dump wrote it out.
    return [
        Standing(**{key: value for key, value in record.items() if key != "goal_difference"})
        for record in records
    ]
