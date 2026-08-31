"""End-to-end: normalized data in, league reports out.

This is the seam the backend API sits on. It reads only local files, so it runs
without network access and is safe to call on every server start.

Ratings come from one continuous replay of every season we hold (see
`model.career`), so the number shown against a club in 2019 and the number
shown in 2026 are on the same scale and connected by its results in between.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from elitetracker.model.career import SeasonSlice, TeamCareer, build_careers
from elitetracker.model.elo import MODEL_VERSION, EloConfig
from elitetracker.model.initial_ratings import SECOND_TIER, TOP_TIER, SeedingConfig, TeamRating, initial_ratings
from elitetracker.model.ratings import build_rating_table
from elitetracker.model.scorelines import DEFAULT_SCORELINE_MODEL
from elitetracker.model.table import table_from_matches
from elitetracker.display import build_fixtures_payload
from elitetracker.normalize.matches import Match
from elitetracker.normalize.standings import load_standings
from elitetracker.simulation.history import HistoryConfig, as_of_date, build_history
from elitetracker.simulation.season import SeasonProjection, SimulationConfig, simulate_season

NORMALIZED_DIR = Path("data/normalized")

# Ratings are seeded from this season's final tables and every season after it
# is replayed. Nothing before it is used.
SEED_SEASON = 2014


@dataclass(frozen=True)
class Band:
    """A block of finishing positions that means something, e.g. relegation."""

    label: str
    first: int  # 1-indexed, inclusive
    last: int  # inclusive
    tone: str  # a hint for the UI, not a colour


@dataclass(frozen=True)
class LeagueSpec:
    slug: str
    name: str
    tier: int
    bands: tuple[Band, ...]


# Position meanings follow the UEFA allocation for that season. Relegation has
# been a 16-team constant since 2009; the European blocks have moved almost
# every year, so Eliteserien has a per-season map. Cup-displaced spots (e.g.
# 4th in 2018 or 5th in 2019) depend on who wins the cup, so they are not a
# league position a club can plan for and are left out.
ELITESERIEN_BANDS_BY_SEASON: dict[int, tuple[Band, ...]] = {
    2015: (
        Band("Champions", 1, 1, "champion"),
        Band("Champions League qualification", 1, 1, "top"),
        Band("Europa League qualification", 2, 3, "europe"),
        Band("Relegation play-off", 14, 14, "playoff"),
        Band("Relegation", 15, 16, "relegation"),
    ),
    2016: (
        Band("Champions", 1, 1, "champion"),
        Band("Champions League qualification", 1, 1, "top"),
        Band("Europa League qualification", 2, 3, "europe"),
        Band("Relegation play-off", 14, 14, "playoff"),
        Band("Relegation", 15, 16, "relegation"),
    ),
    2017: (
        Band("Champions", 1, 1, "champion"),
        Band("Champions League qualification", 1, 1, "top"),
        Band("Europa League qualification", 2, 2, "europe"),
        Band("Relegation play-off", 14, 14, "playoff"),
        Band("Relegation", 15, 16, "relegation"),
    ),
    2018: (
        Band("Champions", 1, 1, "champion"),
        Band("Champions League qualification", 1, 1, "top"),
        Band("Europa League qualification", 2, 2, "europe"),
        Band("Relegation play-off", 14, 14, "playoff"),
        Band("Relegation", 15, 16, "relegation"),
    ),
    2019: (
        Band("Champions", 1, 1, "champion"),
        Band("Champions League qualification", 1, 1, "top"),
        Band("Europa League qualification", 2, 2, "europe"),
        Band("Relegation play-off", 14, 14, "playoff"),
        Band("Relegation", 15, 16, "relegation"),
    ),
    2020: (
        Band("Champions", 1, 1, "champion"),
        Band("Champions League qualification", 1, 1, "top"),
        Band("Conference League qualification", 2, 2, "europe"),
        Band("Relegation play-off", 14, 14, "playoff"),
        Band("Relegation", 15, 16, "relegation"),
    ),
    2021: (
        Band("Champions", 1, 1, "champion"),
        Band("Champions League qualification", 1, 1, "top"),
        Band("Conference League qualification", 2, 2, "europe"),
        Band("Relegation play-off", 14, 14, "playoff"),
        Band("Relegation", 15, 16, "relegation"),
    ),
    2022: (
        Band("Champions", 1, 1, "champion"),
        Band("Champions League qualification", 1, 1, "top"),
        Band("Conference League qualification", 2, 2, "europe"),
        Band("Relegation play-off", 14, 14, "playoff"),
        Band("Relegation", 15, 16, "relegation"),
    ),
    2023: (
        Band("Champions", 1, 1, "champion"),
        Band("Champions League qualification", 1, 1, "top"),
        Band("Conference League qualification", 2, 2, "europe"),
        Band("Relegation play-off", 14, 14, "playoff"),
        Band("Relegation", 15, 16, "relegation"),
    ),
    2024: (
        Band("Champions", 1, 1, "champion"),
        Band("Champions League qualification", 1, 2, "top"),
        Band("Conference League qualification", 3, 3, "europe"),
        Band("Relegation play-off", 14, 14, "playoff"),
        Band("Relegation", 15, 16, "relegation"),
    ),
    2025: (
        Band("Champions", 1, 1, "champion"),
        Band("Champions League qualification", 1, 2, "top"),
        Band("Europa League qualification", 3, 3, "europe"),
        Band("Conference League qualification", 4, 4, "europe"),
        Band("Relegation play-off", 14, 14, "playoff"),
        Band("Relegation", 15, 16, "relegation"),
    ),
    2026: (
        Band("Champions", 1, 1, "champion"),
        Band("Champions League qualification", 1, 2, "top"),
        Band("Conference League qualification", 3, 3, "europe"),
        Band("Relegation play-off", 14, 14, "playoff"),
        Band("Relegation", 15, 16, "relegation"),
    ),
}

LEAGUE_SPECS: dict[str, LeagueSpec] = {
    "eliteserien": LeagueSpec(
        slug="eliteserien",
        name="Eliteserien",
        tier=TOP_TIER,
        bands=ELITESERIEN_BANDS_BY_SEASON[max(ELITESERIEN_BANDS_BY_SEASON)],
    ),
    "obosligaen": LeagueSpec(
        slug="obosligaen",
        name="OBOS-ligaen",
        tier=SECOND_TIER,
        bands=(
            Band("Champions", 1, 1, "champion"),
            Band("Promotion", 1, 2, "top"),
            Band("Promotion play-off", 3, 6, "playoff"),
            Band("Relegation play-off", 14, 14, "playoff"),
            Band("Relegation", 15, 16, "relegation"),
        ),
    ),
}

_MATCH_FILE = re.compile(r"^(?P<league>[a-z]+)_(?P<season>\d{4})_matches\.json$")


def bands_for(spec: LeagueSpec, season: int) -> tuple[Band, ...]:
    """The position blocks that applied to `spec` in `season`.

    OBOS-ligaen's promotion structure has been constant, so it reuses its
    static spec bands. Eliteserien's European allocation drifts year to year;
    unknown future seasons fall back to the newest known layout.
    """
    if spec.slug != "eliteserien":
        return spec.bands
    return ELITESERIEN_BANDS_BY_SEASON.get(
        season, ELITESERIEN_BANDS_BY_SEASON[max(ELITESERIEN_BANDS_BY_SEASON)]
    )


def _matches_path(slug: str, season: int, root: Path) -> Path:
    return root / f"{slug}_{season}_matches.json"


def _standings_path(slug: str, season: int, root: Path) -> Path:
    return root / f"{slug}_{season}_standings.json"


def load_matches(path: Path) -> list[Match]:
    with path.open(encoding="utf-8") as handle:
        return [Match(**record) for record in json.load(handle)]


def available_seasons(root: Path = NORMALIZED_DIR) -> list[int]:
    """Seasons with match data for every league, oldest first."""
    per_league: dict[str, set[int]] = {slug: set() for slug in LEAGUE_SPECS}
    for path in root.glob("*_matches.json"):
        found = _MATCH_FILE.match(path.name)
        if found and found["league"] in per_league:
            per_league[found["league"]].add(int(found["season"]))
    complete = set.intersection(*per_league.values()) if per_league else set()
    return sorted(season for season in complete if season > SEED_SEASON)


def current_season(root: Path = NORMALIZED_DIR) -> int:
    seasons = available_seasons(root)
    if not seasons:
        raise FileNotFoundError(f"no normalized match data in {root}")
    return seasons[-1]


def seed_ratings(root: Path = NORMALIZED_DIR, *, seeding: SeedingConfig | None = None):
    """Starting ratings, from the final tables of the season before the replay."""
    return initial_ratings(
        load_standings(_standings_path("eliteserien", SEED_SEASON, root)),
        load_standings(_standings_path("obosligaen", SEED_SEASON, root)),
        config=seeding,
    )


def load_slices(root: Path = NORMALIZED_DIR) -> list[SeasonSlice]:
    return [
        SeasonSlice(
            league=slug,
            league_name=spec.name,
            season=season,
            matches=load_matches(_matches_path(slug, season, root)),
        )
        for season in available_seasons(root)
        for slug, spec in LEAGUE_SPECS.items()
    ]


def build_all_careers(
    root: Path = NORMALIZED_DIR,
    *,
    elo_config: EloConfig | None = None,
    seeding: SeedingConfig | None = None,
) -> dict[str, TeamCareer]:
    return build_careers(load_slices(root), seed_ratings(root, seeding=seeding), config=elo_config)


def _season_seeds(careers: dict[str, TeamCareer], season: int) -> dict[str, TeamRating]:
    """Every club's rating as that season kicked off."""
    seeds: dict[str, TeamRating] = {}
    for team_id, career in careers.items():
        for record in career.seasons:
            if record.season == season:
                seeds[team_id] = TeamRating(
                    team_id=team_id,
                    team=career.team,
                    rating=record.rating_start,
                    source=f"carried into {season}",
                )
    return seeds


def build_report(
    slug: str,
    season: int | None = None,
    *,
    root: Path = NORMALIZED_DIR,
    careers: dict[str, TeamCareer] | None = None,
    elo_config: EloConfig | None = None,
    seeding: SeedingConfig | None = None,
    simulation: SimulationConfig | None = None,
    history: HistoryConfig | None = None,
    asof: str | None = None,
) -> dict[str, Any]:
    """Ratings, table, odds, finishing-position matrix and its history.

    With `asof` set to an ISO date, the whole report is rewound: results after
    that day are treated as unplayed, so it shows what the site would have said
    on the evening of that date. Nothing else about the pipeline changes --
    the rewind happens once, on the fixture list, and everything downstream
    follows from it.
    """
    spec = LEAGUE_SPECS[slug]
    elo_config = elo_config or EloConfig()
    season = season or current_season(root)
    careers = careers if careers is not None else build_all_careers(root, elo_config=elo_config, seeding=seeding)

    seeds = _season_seeds(careers, season)

    # Both divisions feed the rating replay so promoted and relegated sides
    # stay on one scale; only this league is tabled and simulated.
    all_matches: list[Match] = []
    for other in LEAGUE_SPECS:
        all_matches.extend(load_matches(_matches_path(other, season, root)))
    matches = load_matches(_matches_path(slug, season, root))

    # The slider spans every day this league actually played, taken from the
    # full fixture list so the range does not shrink as you rewind.
    matchdays = _matchdays(matches)

    if asof:
        all_matches = as_of_date(all_matches, asof)
        matches = as_of_date(matches, asof)

    ratings = build_rating_table(seeds, all_matches, config=elo_config)
    projection = simulate_season(
        matches, ratings, config=simulation, elo_config=elo_config
    )

    return {
        "league": {
            "slug": spec.slug,
            "name": spec.name,
            "season": season,
            "seasons": available_seasons(root),
            "current_season": current_season(root),
            "matchdays": matchdays,
            "asof": asof,
            "bands": [
                {"label": band.label, "first": band.first, "last": band.last, "tone": band.tone}
                for band in bands_for(spec, season)
            ],
        },
        "model": {
            "version": MODEL_VERSION,
            "k_factor": elo_config.k_factor,
            "home_advantage": elo_config.home_advantage,
            "draw_base": elo_config.draw_base,
            "draw_scale": elo_config.draw_scale,
            "season_regression": elo_config.season_regression,
            "seed_season": SEED_SEASON,
            "simulations": projection.simulations,
            "seed": projection.seed,
            "matches_played": projection.matches_played,
            "matches_remaining": projection.matches_remaining,
            # The compare tool works out a fictional match in the browser, so it
            # needs the same two ingredients the server uses: the draw model's
            # parameters and the gap-binned scoreline table (~3 kB).
            "probability_model": elo_config.probability_model,
            "logit_slope": elo_config.logit_slope,
            "logit_cutpoint": elo_config.logit_cutpoint,
            "scorelines": DEFAULT_SCORELINE_MODEL.to_constants(),
        },
        "table": _table_payload(matches, ratings, projection, seeds),
        "fixtures": build_fixtures_payload(matches, ratings, elo_config),
        "results": _results_payload(matches),
        "history": _history_payload(
            build_history(matches, all_matches, seeds, elo_config=elo_config, config=history),
            {row.team_id: row.team for row in table_from_matches(matches)},
        ),
    }


def _matchdays(matches: list[Match]) -> list[dict[str, Any]]:
    """Every date this league played on, with the running match count.

    Rounds are not chronological, so a matchday here is a calendar date, which
    is what "as it looked back then" actually means.
    """
    played = sorted((m for m in matches if m.played), key=Match.sort_key)
    days: list[dict[str, Any]] = []
    running = 0
    for match in played:
        running += 1
        if days and days[-1]["date"] == match.date:
            days[-1]["matches_played"] = running
            if match.round is not None:
                days[-1]["round"] = match.round
        else:
            days.append(
                {"date": match.date, "matches_played": running, "round": match.round}
            )
    return days


def _history_payload(snapshots: list[Any], names: dict[str, str]) -> dict[str, Any]:
    """Position probabilities per team over time, shaped for a stacked area chart.

    The axis is calendar dates. Rounds are not played in order, so they cannot
    carry the timeline; `latest_round` is along only as a label.
    """
    return {
        "dates": [snapshot.date for snapshot in snapshots],
        "latest_rounds": [snapshot.latest_round for snapshot in snapshots],
        "matches_played": [snapshot.matches_played for snapshot in snapshots],
        "teams": [
            {
                "team_id": team_id,
                "team": names.get(team_id, team_id),
                # positions[i][p] = chance of finishing (p+1)th at snapshot i
                "positions": [
                    [round(value, 5) for value in snapshot.positions[team_id]]
                    for snapshot in snapshots
                ],
                "ratings": [round(snapshot.ratings[team_id], 1) for snapshot in snapshots],
            }
            for team_id in names
        ],
    }


def _table_payload(
    matches: list[Match],
    ratings: dict[str, float],
    projection: SeasonProjection,
    seeds: dict[str, TeamRating],
) -> list[dict[str, Any]]:
    projections = {team.team_id: team for team in projection.teams}
    payload = []
    for position, row in enumerate(table_from_matches(matches), start=1):
        team = projections[row.team_id]
        started = seeds[row.team_id].rating if row.team_id in seeds else ratings[row.team_id]
        payload.append(
            {
                "position": position,
                "team_id": row.team_id,
                "team": row.team,
                "played": row.played,
                "wins": row.wins,
                "draws": row.draws,
                "losses": row.losses,
                "goals_for": row.goals_for,
                "goals_against": row.goals_against,
                "goal_difference": row.goal_difference,
                "points": row.points,
                "rating": round(ratings[row.team_id], 1),
                "rating_start": round(started, 1),
                "rating_change": round(ratings[row.team_id] - started, 1),
                "expected_points": round(team.expected_points, 1),
                "position_probabilities": [round(value, 6) for value in team.position_probabilities],
            }
        )
    return payload


def _results_payload(matches: list[Match]) -> list[dict[str, Any]]:
    return [
        {
            "match_id": match.match_id,
            "date": match.date,
            "round": match.round,
            "home": match.home,
            "away": match.away,
            "home_id": match.home_id,
            "away_id": match.away_id,
            "home_goals": match.home_goals,
            "away_goals": match.away_goals,
        }
        for match in matches
        if match.played
    ]


def careers_payload(careers: dict[str, TeamCareer], *, max_points: int = 400) -> dict[str, Any]:
    """Rating history per club, thinned so the payload stays small.

    The first and last points are always kept, so the line starts and ends
    where the club actually did.
    """
    teams = []
    for team_id, career in sorted(careers.items(), key=lambda kv: kv[1].team):
        points = career.points
        if len(points) > max_points:
            step = len(points) / max_points
            kept = {0, len(points) - 1}
            kept.update(int(index * step) for index in range(max_points))
            points = [points[index] for index in sorted(kept)]
        teams.append(
            {
                "team_id": team_id,
                "team": career.team,
                "current_rating": round(career.current_rating, 1),
                "peak": career.peak,
                "trough": career.trough,
                "points": points,
                "seasons": [
                    {
                        "season": record.season,
                        "league": record.league,
                        "league_name": record.league_name,
                        "position": record.position,
                        "played": record.played,
                        "points": record.points,
                        "goal_difference": record.goal_difference,
                        "rating_start": record.rating_start,
                        "rating_end": record.rating_end,
                        "rating_change": round(record.rating_change, 1),
                    }
                    for record in career.seasons
                ],
            }
        )
    return {"seed_season": SEED_SEASON, "model": MODEL_VERSION, "teams": teams}


