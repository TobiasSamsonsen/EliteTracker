"""One continuous rating history across every season we hold.

Ratings are seeded once, from the final tables of the season *before* the first
one we replay, and then every played match from then to now is applied in
kickoff order. Nothing is re-seeded at a season boundary: a club carries its
rating from December into March, which is the whole point of tracking a career.

Both divisions are replayed together on one scale. A club that is promoted or
relegated simply keeps its rating and starts meeting different opponents.

Clubs that appear without any previous-season record -- a side coming up from
the third tier -- start at the ladder floor and are corrected by results.

`replay` is the one loop that does this; careers, the scoreline corpus and the
backtest all read off it, so they can never disagree about a rating.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Iterator

from elitetracker.model.elo import EloConfig, updated_pair
from elitetracker.model.initial_ratings import TeamRating, rating_for_unseeded_team
from elitetracker.model.table import ranking_key, table_from_matches
from elitetracker.normalize.matches import Match


@dataclass(frozen=True)
class SeasonSlice:
    """One league's matches for one season."""

    league: str
    league_name: str
    season: int
    matches: list[Match]


@dataclass
class SeasonRecord:
    season: int
    league: str
    league_name: str
    position: int
    played: int
    points: int
    goal_difference: int
    rating_start: float
    rating_end: float

    @property
    def rating_change(self) -> float:
        return self.rating_end - self.rating_start


@dataclass
class TeamCareer:
    team_id: str
    team: str
    # (date, rating) after every match the club played, oldest first.
    points: list[tuple[str, float]] = field(default_factory=list)
    seasons: list[SeasonRecord] = field(default_factory=list)

    @property
    def current_rating(self) -> float:
        return self.points[-1][1] if self.points else 0.0

    @property
    def peak(self) -> tuple[str, float] | None:
        return max(self.points, key=lambda point: point[1]) if self.points else None

    @property
    def trough(self) -> tuple[str, float] | None:
        return min(self.points, key=lambda point: point[1]) if self.points else None


def team_ids(match: Match) -> tuple[str, str]:
    return (match.home_id or match.home, match.away_id or match.away)


def replay(
    slices: list[SeasonSlice],
    seeds: dict[str, float],
    config: EloConfig | None = None,
    shots: dict[str, tuple[float, ...]] | None = None,
) -> Iterator[tuple[int, list[SeasonSlice], dict[str, float], Iterator[tuple[Match, tuple[float, float]]]]]:
    """Replay every season in order against one shared rating table.

    Yields once per season, after the offseason regression and once every club
    in it has a rating: ``(season, slices_in_season, ratings, matches)``.
    ``matches`` applies that season's played matches in kickoff order, yielding
    ``(match, (home_before, away_before))`` after each update; ``ratings`` is
    the live table. A season is always completed before the next is yielded.

    ``shots`` is an optional mapping of match_id to (home_xg, away_xg, ...)
    from fotmob; when provided and config.xg_alpha > 0, the rating update
    blends the binary result with the xG-implied score (elo-v8).
    """
    config = config or EloConfig()
    shots = shots or {}
    ratings = dict(seeds)
    seasons = sorted({slice_.season for slice_ in slices})
    for season in seasons:
        in_season = [slice_ for slice_ in slices if slice_.season == season]

        # Mean-revert ratings across the close season (except before the first
        # replayed year, whose ratings are the deliberate seed), toward each
        # division's own mean over the teams that will actually play. Pulling
        # per division preserves the inter-division gap and leaves dormant
        # clubs untouched.
        if season != seasons[0] and config.season_regression < 1.0:
            active: dict[str, str] = {}
            for slice_ in in_season:
                for match in slice_.matches:
                    for team_id in team_ids(match):
                        active[team_id] = slice_.league
            by_league: dict[str, list[str]] = {}
            for team_id, league in active.items():
                if team_id in ratings:
                    by_league.setdefault(league, []).append(team_id)
            for ids in by_league.values():
                mean = sum(ratings[team_id] for team_id in ids) / len(ids)
                for team_id in ids:
                    ratings[team_id] = mean + config.season_regression * (ratings[team_id] - mean)

        for slice_ in in_season:
            for match in slice_.matches:
                for team_id in team_ids(match):
                    ratings.setdefault(team_id, rating_for_unseeded_team())

        played = sorted(
            (match for slice_ in in_season for match in slice_.matches if match.played),
            key=Match.sort_key,
        )

        def apply() -> Iterator[tuple[Match, tuple[float, float]]]:
            for match in played:
                home, away = team_ids(match)
                before = (ratings[home], ratings[away])
                match_shots = shots.get(match.match_id)
                home_xg = match_shots[0] if match_shots and len(match_shots) >= 2 else None
                away_xg = match_shots[1] if match_shots and len(match_shots) >= 2 else None
                ratings[home], ratings[away] = updated_pair(
                    ratings[home], ratings[away], match.home_goals, match.away_goals,
                    config, home_xg, away_xg,
                )
                yield match, before

        matches = apply()
        yield season, in_season, ratings, matches
        for _ in matches:  # finish the season if the caller stopped early
            pass


def build_careers(
    slices: list[SeasonSlice],
    seeds: dict[str, TeamRating],
    *,
    config: EloConfig | None = None,
    shots: dict[str, tuple[float, ...]] | None = None,
) -> dict[str, TeamCareer]:
    """Replay every season in order and record each club's rating over time."""
    config = config or EloConfig()
    careers: dict[str, TeamCareer] = {}
    first_season = min((slice_.season for slice_ in slices), default=None)

    def career_for(team_id: str, name: str) -> TeamCareer:
        if team_id not in careers:
            careers[team_id] = TeamCareer(team_id=team_id, team=name)
        # Keep the most recent spelling of a club's name.
        careers[team_id].team = name
        return careers[team_id]

    ratings_by_id = {team_id: seed.rating for team_id, seed in seeds.items()}
    for season, in_season, ratings, matches in replay(slices, ratings_by_id, config, shots=shots):
        rating_start: dict[str, float] = {}
        for slice_ in in_season:
            for match in slice_.matches:
                for team_id, name in ((match.home_id, match.home), (match.away_id, match.away)):
                    key = team_id or name
                    career_for(key, name)
                    rating_start.setdefault(key, ratings[key])

        # The regressed rating is recorded as a snapshot the day before the
        # first match, so the frontend sees the regression as its own event
        # instead of folding it into the first match's delta.
        snapshot_pending = season != first_season and config.season_regression < 1.0
        for match, _ in matches:
            if snapshot_pending:
                snapshot_date = str(date.fromisoformat(match.date) - timedelta(days=1))
                for team_id, rating in rating_start.items():
                    careers[team_id].points.append((snapshot_date, round(rating, 1)))
                snapshot_pending = False
            for team_id in team_ids(match):
                careers[team_id].points.append((match.date, round(ratings[team_id], 1)))

        for slice_ in in_season:
            for position, row in enumerate(sorted(table_from_matches(slice_.matches), key=ranking_key), 1):
                careers[row.team_id].seasons.append(
                    SeasonRecord(
                        season=slice_.season,
                        league=slice_.league,
                        league_name=slice_.league_name,
                        position=position,
                        played=row.played,
                        points=row.points,
                        goal_difference=row.goal_difference,
                        rating_start=round(rating_start[row.team_id], 1),
                        rating_end=round(ratings[row.team_id], 1),
                    )
                )

    return careers
