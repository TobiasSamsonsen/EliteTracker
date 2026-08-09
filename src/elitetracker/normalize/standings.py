"""The canonical final-league-table schema.

Initial ELO ratings are derived from the previous season's finishing positions,
so this is the only historical data the model consumes.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

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

    @property
    def expected_points(self) -> int:
        """Points implied by the results, before any deduction is applied."""
        return self.wins * POINTS_FOR_WIN + self.draws * POINTS_FOR_DRAW


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


def dump_standings(standings: list[Standing], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    records: list[dict[str, Any]] = []
    for standing in standings:
        record = asdict(standing)
        record["goal_difference"] = standing.goal_difference
        records.append(record)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(records, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
