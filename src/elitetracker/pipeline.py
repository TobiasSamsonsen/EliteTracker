"""End-to-end: normalized data in, league reports out.

This is the seam the backend API sits on. It reads only local files, so it runs
without network access and is safe to call on every server start.

Ratings come from one continuous replay of every season we hold (see
`model.career`), so the number shown against a club in 2019 and the number
shown in 2026 are on the same scale and connected by its results in between.
"""

from __future__ import annotations

import functools
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from elitetracker.model.attack_defence import ADConfig, AttackDefence, blend_outcomes, top_scorelines
from elitetracker.model.career import SeasonSlice, TeamCareer, build_careers
from elitetracker.model.elo import MODEL_VERSION, EloConfig
from elitetracker.model.initial_ratings import SeedingConfig, TeamRating, initial_ratings
from elitetracker.model.probabilities import match_probabilities
from elitetracker.model.ratings import build_rating_table
from elitetracker.model.table import table_from_matches
from elitetracker.normalize.matches import Match
from elitetracker.normalize.standings import load_standings
from elitetracker.sources.fotmob import load_xg
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
    bands: tuple[Band, ...]


# Position meanings follow the UEFA allocation for that season. Relegation has
# been a 16-team constant since 2009; only the European blocks move, so they
# are the only rows kept per season. Cup-displaced spots (e.g. 4th in 2018 or
# 5th in 2019) depend on who wins the cup, so they are not a league position a
# club can plan for and are left out.
_CHAMPIONS = Band("Champions", 1, 1, "champion")
_BOTTOM = (Band("Relegation play-off", 14, 14, "playoff"), Band("Relegation", 15, 16, "relegation"))
_CL = "Champions League qualification"
_EL = "Europa League qualification"
_CONF = "Conference League qualification"
_ELITESERIEN_EUROPE: dict[int, tuple[tuple[str, int, int], ...]] = {
    2015: ((_CL, 1, 1), (_EL, 2, 3)),
    2016: ((_CL, 1, 1), (_EL, 2, 4)),
    2017: ((_CL, 1, 1), (_EL, 2, 3)),
    2018: ((_CL, 1, 1), (_EL, 2, 4)),
    2019: ((_CL, 1, 1), (_EL, 2, 3)),
    2020: ((_CL, 1, 1), (_CONF, 2, 4)),
    2021: ((_CL, 1, 1), (_CONF, 2, 3)),
    2022: ((_CL, 1, 1), (_CONF, 2, 3)),
    2023: ((_CL, 1, 1), (_CONF, 2, 3)),
    2024: ((_CL, 1, 2), (_CONF, 3, 4)),
    2025: ((_CL, 1, 2), (_EL, 3, 3), (_CONF, 4, 4)),
    2026: ((_CL, 1, 2), (_CONF, 3, 4)),
}


def _eliteserien_bands(season: int) -> tuple[Band, ...]:
    europe = _ELITESERIEN_EUROPE.get(season, _ELITESERIEN_EUROPE[max(_ELITESERIEN_EUROPE)])
    return (
        _CHAMPIONS,
        *(Band(label, first, last, "top" if label == _CL else "europe") for label, first, last in europe),
        *_BOTTOM,
    )


LEAGUE_SPECS: dict[str, LeagueSpec] = {
    "eliteserien": LeagueSpec(
        slug="eliteserien",
        name="Eliteserien",
        bands=_eliteserien_bands(max(_ELITESERIEN_EUROPE)),
    ),
    "obosligaen": LeagueSpec(
        slug="obosligaen",
        name="OBOS-ligaen",
        bands=(
            _CHAMPIONS,
            Band("Promotion", 1, 2, "top"),
            Band("Promotion play-off", 3, 6, "playoff"),
            *_BOTTOM,
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
    return _eliteserien_bands(season) if spec.slug == "eliteserien" else spec.bands


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


@functools.cache
def prior_attack_defence(root: Path, season: int) -> AttackDefence:
    """Attack/defence ratings at the end of the season before `season`.

    Every season before it is replayed once and kept; callers `copy()` the
    state before replaying the season they are reporting on.
    """
    slices = load_slices(root)
    shots = {match_id: tuple(values) for match_id, values in load_xg()["matches"].items()}
    return AttackDefence.from_slices(slices, ADConfig(), shots=shots).replay(
        [match for slice_ in slices if slice_.season < season for match in slice_.matches]
    )


def _season_seeds(careers: dict[str, TeamCareer], season: int) -> dict[str, TeamRating]:
    """Every club's rating as that season kicked off."""
    seeds: dict[str, TeamRating] = {}
    for team_id, career in careers.items():
        for record in career.seasons:
            if record.season == season:
                seeds[team_id] = TeamRating(team_id, career.team, record.rating_start)
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
    prior = prior_attack_defence(root, season)
    ad = prior.copy().replay(all_matches)
    ad.start_season(season)
    projection = simulate_season(
        matches, ratings, ad=ad, config=simulation, elo_config=elo_config
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
            # needs the same ingredients the server uses: the draw model's
            # parameters above and both divisions' attack/defence ratings.
            "attack_defence": {
                "home": ad.config.home,
                "base": ad.config.base,
                "rho": ad.config.rho,
                "k": ad.config.k,
                "k_shots": ad.config.k_shots,
                "alpha": ad.config.alpha,
                "outcome_blend": blend_outcomes.__defaults__[0],
                "teams": {
                    team_id: [round(ad.attack[team_id], 4), round(ad.defence[team_id], 4)]
                    for (year, team_id) in ad.divisions if year == season and team_id in ad.attack
                },
            },
        },
        "table": _table_payload(matches, ratings, projection, seeds, ad, spec.slug, season),
        "fixtures": _fixtures_payload(matches, ratings, elo_config, ad),
        "results": _results_payload(matches),
        "history": _history_payload(
            build_history(matches, all_matches, seeds, prior=prior, elo_config=elo_config, config=history),
            {row.team_id: row.team for row in table_from_matches(matches)},
        ),
    }


def rewound_configs(asof: str | None) -> tuple[SimulationConfig, HistoryConfig]:
    """Simulation settings for a live view or a rewound one.

    The rewound view thins both the grid (10,000) and the season-shape history
    (2,500 x 8) against the live view (50,000 grid). At 10,000 the worst grid
    cell is ~1.31 pp -- still below the model's 1.54 pp calibration error -- so
    the small fidelity step as you drag back is invisible at whole-percent
    display, while rewound reports build roughly 5x faster.
    """
    if not asof:
        return SimulationConfig(), HistoryConfig()
    return SimulationConfig(simulations=10_000), HistoryConfig(simulations=2_500, max_snapshots=8)


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
    ad: AttackDefence,
    slug: str,
    season: int,
) -> list[dict[str, Any]]:
    projections = {team.team_id: team for team in projection.teams}
    payload = []
    for position, row in enumerate(table_from_matches(matches), start=1):
        team = projections[row.team_id]
        started = seeds[row.team_id].rating if row.team_id in seeds else ratings[row.team_id]
        scored, conceded = ad.rates_against_average(row.team_id, slug, season)
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
                # Expected goals for and against per match, against an average
                # side of the division: the readable form of the attack/defence ratings.
                "attack": round(scored, 2),
                "defence": round(conceded, 2),
            }
        )
    return payload


def _fixtures_payload(
    matches: list[Match], ratings: dict[str, float], elo_config: EloConfig, ad: AttackDefence
) -> list[dict[str, Any]]:
    """Upcoming fixtures with three-way odds and the most likely scorelines."""
    payload = []
    for match in matches:
        if match.played:
            continue
        home_id = match.home_id or match.home
        away_id = match.away_id or match.away
        grid = ad.grid(home_id, away_id, match.date)
        probabilities = blend_outcomes(match_probabilities(ratings[home_id], ratings[away_id], elo_config), grid)
        scorelines = top_scorelines(grid, probabilities)
        payload.append(
            {
                "match_id": match.match_id,
                "date": match.date,
                "time": match.time,
                "round": match.round,
                "home": match.home,
                "away": match.away,
                "home_id": home_id,
                "away_id": away_id,
                "home_rating": round(ratings[home_id], 1),
                "away_rating": round(ratings[away_id], 1),
                "home_win": round(probabilities.home_win, 4),
                "draw": round(probabilities.draw, 4),
                "away_win": round(probabilities.away_win, 4),
                "scorelines": [
                    {"home_goals": hg, "away_goals": ag, "probability": round(probability, 4)}
                    for (hg, ag), probability in scorelines
                ],
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


