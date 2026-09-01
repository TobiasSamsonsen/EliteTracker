"""One continuous rating history across every season we hold.

Ratings are seeded once, from the final tables of the season *before* the first
one we replay, and then every played match from then to now is applied in
kickoff order. Nothing is re-seeded at a season boundary: a club carries its
rating from December into March, which is the whole point of tracking a career.

Both divisions are replayed together on one scale. A club that is promoted or
relegated simply keeps its rating and starts meeting different opponents.

Clubs that appear without any previous-season record -- a side coming up from
the third tier -- start at the ladder floor and are corrected by results.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

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


def build_careers(
    slices: list[SeasonSlice],
    seeds: dict[str, TeamRating],
    *,
    config: EloConfig | None = None,
) -> dict[str, TeamCareer]:
    """Replay every season in order and record each club's rating over time."""
    config = config or EloConfig()

    ratings: dict[str, float] = {team_id: seed.rating for team_id, seed in seeds.items()}
    names: dict[str, str] = {team_id: seed.team for team_id, seed in seeds.items()}
    careers: dict[str, TeamCareer] = {}

    def career_for(team_id: str, name: str) -> TeamCareer:
        names.setdefault(team_id, name)
        if team_id not in careers:
            careers[team_id] = TeamCareer(team_id=team_id, team=name)
        # Keep the most recent spelling of a club's name.
        careers[team_id].team = name
        return careers[team_id]

    # Seasons run in parallel across the two divisions, so group by season and
    # replay each season's matches from both leagues in one chronological pass.
    seasons_sorted = sorted({slice_.season for slice_ in slices})
    first_season = seasons_sorted[0] if seasons_sorted else None
    for season in seasons_sorted:
        in_season = [slice_ for slice_ in slices if slice_.season == season]

        # Mean-revert ratings across the close season (except before the first
        # replayed year, whose ratings are the deliberate seed from the standings),
        # toward each division's own mean over the teams that will actually play
        # this season. Pulling per division preserves the inter-division gap and
        # leaves dormant clubs (never pruned from `ratings`) untouched instead of
        # dragging them toward the combined pool mean.
        if season != first_season and config.season_regression < 1.0:
            active: dict[str, str] = {}
            for slice_ in in_season:
                for match in slice_.matches:
                    active[match.home_id or match.home] = slice_.league
                    active[match.away_id or match.away] = slice_.league
            by_league: dict[str, list[str]] = {}
            for team_id, league in active.items():
                if team_id in ratings:
                    by_league.setdefault(league, []).append(team_id)
            factor = config.season_regression
            for team_ids in by_league.values():
                mean = sum(ratings[team_id] for team_id in team_ids) / len(team_ids)
                for team_id in team_ids:
                    ratings[team_id] = mean + factor * (ratings[team_id] - mean)

        rating_start: dict[str, float] = {}
        for slice_ in in_season:
            for match in slice_.matches:
                for team_id, name in ((match.home_id, match.home), (match.away_id, match.away)):
                    key = team_id or name
                    career_for(key, name)
                    if key not in ratings:
                        ratings[key] = rating_for_unseeded_team()
                    rating_start.setdefault(key, ratings[key])

        played = sorted(
            (match for slice_ in in_season for match in slice_.matches if match.played),
            key=Match.sort_key,
        )

        # Record the regressed (or carried) rating as a snapshot the day before
        # the first match so that buildRatingChanges in the frontend sees the
        # regression as its own event instead of folding it into the first
        # match's delta.
        if season != first_season and config.season_regression < 1.0 and played:
            first_date = played[0].date
            snapshot_date = str(date.fromisoformat(first_date) - timedelta(days=1))
            for team_id in rating_start:
                careers[team_id].points.append((snapshot_date, round(ratings[team_id], 1)))
        for match in played:
            home = match.home_id or match.home
            away = match.away_id or match.away
            ratings[home], ratings[away] = updated_pair(
                ratings[home], ratings[away], match.home_goals, match.away_goals, config
            )
            careers[home].points.append((match.date, round(ratings[home], 1)))
            careers[away].points.append((match.date, round(ratings[away], 1)))

        # Season summary per league, once its matches have been applied.
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
