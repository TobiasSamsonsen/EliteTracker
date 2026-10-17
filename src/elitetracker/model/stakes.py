"""Late-season table stakes on the prediction (elo-v16.0).

In the run-in, a side near a line of the table plays as if stronger than its
ratings say, and a side with nothing left to play for as if weaker. The lines
are the edges of the season's bands (`pipeline.bands_for`): the title, the
European or promotion places, the promotion play-off, the relegation play-off
and relegation. Once both sides have played STAKES_FROM matches, each side's
distance d in points to its nearest line (to the first club across it) and
its matches left r give its pressure

    P = exp(-max(0, d - 1) / (STAKES_TAU * r))

which is 1 within a point of a line and falls off as the gap outgrows what is
left to play. The prediction moves by P_home - P_away: STAKES_ELO rating
points on the Elo side, and the goals model's rates times exp(+-STAKES_GOALS
times it). Like the surface edge, the ratings never see it.

The table is the one before the match's date. In the season simulation that
is each run's own simulated table (`simulation.season`); for a published
fixture it is the table as it stands, with each side's matches left counted
from the schedule (`fixture_gaps`).

Measured on elo-v15.0 (PROJECT_STATUS.md, "IMPROVEMENTS2.md, phases 1 and
2"): the 968 matches 2016+ with both sides past 24 played, where the away side
is under more pressure the home side takes 0.064 of a point share less than
the odds expected (t -2.31). Both divisions 2016+:

    Elo + 30 alone:                  -0.00016 log loss (t -2.41)
    Elo 30 and the goals model 0.05: -0.00043 (t -1.97), Brier t -1.98,
                                     RPS t -2.05, both halves negative
    walk-forward over 0-80 x 0-0.15: -0.00070 out of sample (t -1.88)

tau is flat over 0.5-1.2. The gain grows past where t peaks (the walk-forward
picks 45-130 points and 0.10-0.15); 30 and 0.05 are the t-peak values.
"""

from __future__ import annotations

import math
from typing import Iterable

import numpy as np

from elitetracker.model.career import team_ids
from elitetracker.model.table import table_from_matches
from elitetracker.normalize.matches import Match

STAKES_FROM = 24      # matches both sides must have played
STAKES_TAU = 0.8
STAKES_ELO = 30.0     # Elo rating points per unit of P_home - P_away
STAKES_GOALS = 0.05   # log goals per unit of P_home - P_away


def lines(bands: Iterable, teams: int) -> tuple[int, ...]:
    """Positions b with a line between b and b + 1, from a season's bands."""
    edges: set[int] = set()
    for band in bands:
        edges |= {band.first - 1, band.last}
    return tuple(sorted(b for b in edges if 1 <= b < teams))


def distance(points: int, above: int, below: int) -> int:
    """Points from a line for a club on `points`, where `above` and `below`
    are the points of the clubs either side of it. The same for clubs level
    on points whichever way the tiebreak orders them."""
    return points - below if points > below else above - points


def pressure(distance: int, left: int, tau: float = STAKES_TAU) -> float:
    return math.exp(-max(0, distance - 1) / (tau * max(left, 1)))


def _gaps(points: dict[str, int], played: dict[str, int], cuts: tuple[int, ...], rounds: int,
          fixtures: Iterable[tuple[str, str, str, dict[str, int] | None]]) -> dict[str, float]:
    ranked = sorted(points.values(), reverse=True)
    if not cuts or len(ranked) <= max(cuts):
        return {}

    def side(team: str, done: int) -> float:
        d = min(distance(points[team], ranked[b - 1], ranked[b]) for b in cuts)
        return pressure(d, rounds - done)

    out = {}
    for match_id, home, away, by_then in fixtures:
        done = by_then or played
        if home in points and away in points and min(done[home], done[away]) >= STAKES_FROM:
            out[match_id] = side(home, done[home]) - side(away, done[away])
    return out


def season_gaps(matches: list[Match], cuts: tuple[int, ...]) -> dict[str, float]:
    """P_home - P_away for every played match of one league season, from the
    table before its date; matches outside the run-in are left out."""
    rounds = 2 * (len({t for m in matches for t in team_ids(m)}) - 1)
    played = sorted((m for m in matches if m.played), key=Match.sort_key)
    out: dict[str, float] = {}
    for day in sorted({m.date for m in played}):
        table = table_from_matches([m for m in played if m.date < day])
        points = {row.team_id: row.points for row in table}
        done = {row.team_id: row.played for row in table}
        out.update(_gaps(points, done, cuts, rounds,
                         ((m.match_id, *team_ids(m), None) for m in played if m.date == day)))
    return out


def fixture_gaps(matches: list[Match], cuts: tuple[int, ...]) -> dict[str, float]:
    """P_home - P_away for every unplayed fixture of one league season, from
    the table as it stands, each side's matches played by then counted from
    the schedule."""
    table = table_from_matches(matches)
    rounds = 2 * (len(table) - 1)
    points = {row.team_id: row.points for row in table}
    played = {row.team_id: row.played for row in table}
    unplayed = [m for m in matches if not m.played]

    def by_then(match: Match) -> dict[str, int]:
        done = dict(played)
        for other in unplayed:
            if other.date < match.date:
                for t in team_ids(other):
                    done[t] = done.get(t, 0) + 1
        return done

    return _gaps(points, played, cuts, rounds, ((m.match_id, *team_ids(m), by_then(m)) for m in unplayed))


def run_pressures(points: np.ndarray, left: np.ndarray, cuts: tuple[int, ...],
                  clubs: np.ndarray | None = None) -> np.ndarray:
    """The pressure in each run of a simulation of every club, or of `clubs`
    (indices) only: `points` runs x clubs, `left` each club's matches left."""
    ranked = -np.sort(-points, axis=1)
    at = np.asarray(cuts)
    own, left = (points, left) if clubs is None else (points[:, clubs], left[clubs])
    # No club's points fall strictly between the two either side of a line,
    # so `distance` is max(points - below, above - points): lines x runs x 1.
    below, above = ranked[:, at].T[:, :, None], ranked[:, at - 1].T[:, :, None]
    nearest = np.maximum(own[None] - below, above - own[None]).min(axis=0)
    return np.exp(-np.maximum(0, nearest - 1) / (STAKES_TAU * np.maximum(left, 1)))
