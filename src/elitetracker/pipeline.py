"""End-to-end: normalized data in, league reports out.

This is the seam the backend API sits on. It reads only local files, so it runs
without network access and is safe to call on every server start.

Ratings come from one continuous replay of every season we hold (see
`model.career`), so the number shown against a club in 2019 and the number
shown in 2026 are on the same scale and connected by its results in between.
"""

from __future__ import annotations

import functools
import hashlib
import json
import re
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np

from elitetracker.model.attack_defence import ADConfig, AttackDefence, OUTCOME_BLEND
from elitetracker.model.career import SeasonSlice, TeamCareer, build_careers, team_ids
from elitetracker.model.elo import (
    MODEL_VERSION, EloConfig, effective_home_advantage, era_config, expected_score, xg_implied_score,
)
from elitetracker.model.initial_ratings import SeedingConfig, TeamRating, initial_ratings, rating_for_unseeded_team
from elitetracker.model.pricing import SURFACE_LEAGUE, elo_odds, match_odds
from elitetracker.model.probabilities import match_probabilities
from elitetracker.model.ratings import build_rating_table
from elitetracker.model import stakes as table_stakes
from elitetracker.model.table import table_from_matches
from elitetracker.normalize.matches import Match
from elitetracker.normalize.standings import load_standings
from elitetracker.normalize.surfaces import SURFACE_EDGE, is_grass
from elitetracker.sources.fotmob import XG_PATH, load_xg
# Transfermarkt squad values per club-season, for the goals model's offseason
# pull (`ADConfig.value_pull`); `research market-values` adds a season by hand.
from elitetracker.sources.transfermarkt import MARKET_VALUES_PATH
from elitetracker.simulation.history import HistoryConfig, as_of_date, build_history
from elitetracker.simulation.playoffs import LADDER_FROM, Opponent, Playoffs
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
# Seasons that fed older access lists, written out by hand and checked against
# each season's final table. 2016 and 2018 were Rosenborg doubles, so 4th
# reached Europe only through the cup spot passing down -- left out, like 2015
# and 2021. 2020 had no cup, so its 4th was a league place outright.
_ELITESERIEN_EUROPE: dict[int, tuple[tuple[str, int, int], ...]] = {
    2015: ((_CL, 1, 1), (_EL, 2, 3)),
    2016: ((_CL, 1, 1), (_EL, 2, 3)),
    2017: ((_CL, 1, 1), (_EL, 2, 3)),
    2018: ((_CL, 1, 1), (_EL, 2, 3)),
    2019: ((_CL, 1, 1), (_EL, 2, 3)),
    2020: ((_CL, 1, 1), (_CONF, 2, 4)),
    2021: ((_CL, 1, 1), (_CONF, 2, 3)),
    2022: ((_CL, 1, 1), (_CONF, 2, 3)),
}

# From 2023 on (the 2024-25 access list) the places follow from Norway's UEFA
# association rank alone: the ranking at the end of the European season that
# finishes in the same year (Eliteserien 2026 -> June 2026 -> 2027-28). It is
# provisional until then. These are UEFA's final ranks; `refresh` fetches the
# current season's into uefa_ranks.json beside the match files, which wins.
_UEFA_RANKS = {2023: 16, 2024: 14, 2025: 11, 2026: 14}
UEFA_RANKS_FILE = "uefa_ranks.json"


def _europe_by_rank(rank: int) -> tuple[tuple[str, int, int], ...]:
    """The league places a UEFA association rank leads into Europe.

    Access list in force since 2024-25: champions and runners-up of ranks
    7-15 enter the Champions League, third-placed teams of 7-12 the Europa
    League, fourth-placed of 7-15 and third-placed of 13-50 the Conference
    League, as do runners-up from 16 down. Ranks outside 7-50 are out of
    Norway's reach and not modelled. Revisit when UEFA changes the list.
    """
    if 7 <= rank <= 12:
        return ((_CL, 1, 2), (_EL, 3, 3), (_CONF, 4, 4))
    if 13 <= rank <= 15:
        return ((_CL, 1, 2), (_CONF, 3, 4))
    if 16 <= rank <= 50:
        return ((_CL, 1, 1), (_CONF, 2, 3))
    raise ValueError(f"no access-list rule for UEFA association rank {rank}")


def uefa_ranks(root: Path = NORMALIZED_DIR) -> dict[int, int]:
    """Norway's rank per league season: the built-in table, then the file."""
    ranks = dict(_UEFA_RANKS)
    path = Path(root) / UEFA_RANKS_FILE
    if path.exists():
        ranks.update({int(season): int(rank) for season, rank in json.loads(path.read_text(encoding="utf-8")).items()})
    return ranks


def _eliteserien_bands(season: int, ranks: dict[int, int] = _UEFA_RANKS) -> tuple[Band, ...]:
    if season in _ELITESERIEN_EUROPE:
        europe = _ELITESERIEN_EUROPE[season]
    else:
        # A season UEFA has not ranked yet takes the newest rank known.
        europe = _europe_by_rank(ranks.get(season, ranks[max(ranks)]))
    return (
        _CHAMPIONS,
        *(Band(label, first, last, "top" if label == _CL else "europe") for label, first, last in europe),
        *_BOTTOM,
    )


LEAGUE_SPECS: dict[str, LeagueSpec] = {
    "eliteserien": LeagueSpec(
        slug="eliteserien",
        name="Eliteserien",
        bands=_eliteserien_bands(max(_UEFA_RANKS)),
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


def bands_for(spec: LeagueSpec, season: int, root: Path = NORMALIZED_DIR) -> tuple[Band, ...]:
    """The position blocks that applied to `spec` in `season`.

    OBOS-ligaen's promotion structure has been constant, so it reuses its
    static spec bands. Eliteserien's European allocation drifts year to year
    with Norway's UEFA rank; a season not yet ranked takes the newest rank.
    """
    return _eliteserien_bands(season, uefa_ranks(root)) if spec.slug == "eliteserien" else spec.bands


def _matches_path(slug: str, season: int, root: Path) -> Path:
    return root / f"{slug}_{season}_matches.json"


def _standings_path(slug: str, season: int, root: Path) -> Path:
    return root / f"{slug}_{season}_standings.json"


def load_matches(path: Path) -> list[Match]:
    with path.open(encoding="utf-8") as handle:
        return [Match(**record) for record in json.load(handle)]


def preseason_date(season: int, root: Path = NORMALIZED_DIR) -> str | None:
    """The day before either division's first played match: the date of the
    season's pre-season view, the prediction before a ball was kicked in
    either league (a rewound report is per date and carries both). None
    while nothing has been played, when the live view is the pre-season."""
    played = [
        match.date
        for slug in LEAGUE_SPECS
        for match in load_matches(_matches_path(slug, season, root))
        if match.played
    ]
    if not played:
        return None
    return (date.fromisoformat(min(played)) - timedelta(days=1)).isoformat()


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


# -- the model's inputs ------------------------------------------------------
# Everything the model reads from disk sits under one data directory: the
# normalized match and standings files (and the UEFA ranks) in `root`, xg.json
# and market_values.json beside it. Each input is read once per root and kept;
# `reload_inputs` drops them all, and `inputs_digest` hashes them afresh for
# the static build's reuse check -- so an input added here is added there.

def _xg_path(root: Path) -> Path:
    return Path(root).parent / XG_PATH.name


def _values_path(root: Path) -> Path:
    return Path(root).parent / MARKET_VALUES_PATH.name


@functools.cache
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
    return build_careers(
        load_slices(root), seed_ratings(root, seeding=seeding),
        config=elo_config, shots=shot_table(root), values=market_values(root),
    )


@functools.cache
def shot_table(root: Path = NORMALIZED_DIR) -> dict[str, tuple[float, ...]]:
    """match_id -> expected goals: fotmob for Eliteserien, Sofascore for OBOS.

    Entries are (home_xg, away_xg) and, where the source has it, xG on target,
    npxG and the first red card's minute after them (`load_xg`); everything
    downstream reads the first two.
    """
    return {match_id: tuple(values) for match_id, values in load_xg(_xg_path(root))["matches"].items()}


def stakes_lines(slug: str, season: int, matches: list[Match], root: Path = NORMALIZED_DIR) -> tuple[int, ...]:
    """The lines of the table the stakes term measures from (`model.stakes`):
    the edges of the season's bands."""
    return table_stakes.lines(bands_for(LEAGUE_SPECS[slug], season, root), len(table_from_matches(matches)))


@functools.cache
def stakes_table(root: Path = NORMALIZED_DIR) -> dict[str, float]:
    """match_id -> P_home - P_away for every played match in the run-in
    (`model.stakes`), from the table before its date: what the backtest
    prices each played match with."""
    out: dict[str, float] = {}
    for slice_ in load_slices(root):
        lines = stakes_lines(slice_.league, slice_.season, slice_.matches, root)
        out.update(table_stakes.season_gaps(slice_.matches, lines))
    return out


@functools.cache
def market_values(root: Path = NORMALIZED_DIR) -> dict[int, dict[str, float]]:
    """season -> team_id -> squad value in EUR, as Transfermarkt listed it that
    season. A season's pull reads the season before, so a missing file or
    season only switches the value pull off."""
    return _read_values(_values_path(root))


def _read_values(path: Path) -> dict[int, dict[str, float]]:
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        raw = json.load(handle)
    return {int(season): {team_id: entry["total"] for team_id, entry in clubs.items() if entry.get("total")}
            for season, clubs in raw.items()}


@functools.cache
def prior_attack_defence(root: Path, season: int) -> AttackDefence:
    """Attack/defence ratings at the end of the season before `season`.

    Every season before it is replayed once and kept; callers `copy()` the
    state before replaying the season they are reporting on.
    """
    slices = load_slices(root)
    return AttackDefence.from_slices(slices, ADConfig(), shots=shot_table(root), values=market_values(root)).replay(
        [match for slice_ in slices if slice_.season < season for match in slice_.matches]
    )


@functools.cache
def season_end_rates(root: Path) -> dict[tuple[str, int], list[tuple[float, float]]]:
    """Each division's clubs as they ended each season, in expected goals for
    and against per match against an average side (the table's `attack` and
    `defence`). Every season is replayed once, in order."""
    slices = load_slices(root)
    ad = AttackDefence.from_slices(slices, ADConfig(), shots=shot_table(root), values=market_values(root))
    rates: dict[tuple[str, int], list[tuple[float, float]]] = {}
    for season in available_seasons(root):
        ad.replay([match for slice_ in slices if slice_.season == season for match in slice_.matches])
        for slug in LEAGUE_SPECS:
            clubs = sorted(team for (year, team), league in ad.divisions.items()
                           if year == season and league == slug and team in ad.attack)
            rates[(slug, season)] = [ad.rates_against_average(team, slug, season) for team in clubs]
    return rates


@functools.cache
def first_xg_seasons(root: Path) -> dict[str, int]:
    """Each division's first season with xG for at least 90% of its played
    matches (Eliteserien 2020; OBOS-ligaen 2023, at 92%). Every season before
    it has none, so its ratings stand on goals alone."""
    shots = shot_table(root)
    first: dict[str, int] = {}
    for slice_ in sorted(load_slices(root), key=lambda slice_: slice_.season):
        played = [match for match in slice_.matches if match.played]
        if played and sum(match.match_id in shots for match in played) >= 0.9 * len(played):
            first.setdefault(slice_.league, slice_.season)
    return first


def attack_trend(slug: str, season: int, root: Path = NORMALIZED_DIR) -> dict[str, Any] | None:
    """The attack map's trend line, from the seasons of `slug` before `season`
    rated the same way: the sums of squares and products of each season's
    clubs, centred on that season's own mean. The page adds the clubs of the
    day it shows and fits the slope by orthogonal regression.

    Sixteen clubs leave one season's slope to chance (Eliteserien's ran from
    -0.42 to -1.29 between seasons, OBOS-ligaen's went flat mid-2026), so the
    seasons are pooled; the centring keeps a division's scoring level, which
    moves from year to year, out of the slope. Ratings from xG and ratings from
    goals alone are not one measure, so a season from the division's first xG
    season on pools only with those, and one before it only with the seasons
    before it. Only earlier seasons count, so a view never changes when a later
    season is played. None before there is one.
    """
    rates = season_end_rates(Path(root))
    first_xg = first_xg_seasons(Path(root)).get(slug)
    since = first_xg if first_xg is not None and season >= first_xg else None
    seasons = [
        year for (league, year), clubs in rates.items()
        if league == slug and year < season and len(clubs) > 1
        and (year >= since if since is not None else first_xg is None or year < first_xg)
    ]
    sxx = syy = sxy = 0.0
    for year in seasons:
        clubs = rates[(slug, year)]
        mean_for = sum(scored for scored, _ in clubs) / len(clubs)
        mean_against = sum(conceded for _, conceded in clubs) / len(clubs)
        for scored, conceded in clubs:
            sxx += (scored - mean_for) ** 2
            syy += (conceded - mean_against) ** 2
            sxy += (scored - mean_for) * (conceded - mean_against)
    if not seasons:
        return None
    return {"sxx": round(sxx, 6), "syy": round(syy, 6), "sxy": round(sxy, 6), "first": min(seasons)}


def reload_inputs() -> None:
    """Forget every input read so far: the next read takes the files as they are now."""
    for loader in (load_slices, shot_table, stakes_table, market_values, prior_attack_defence, season_end_rates,
                   first_xg_seasons):
        loader.cache_clear()


def inputs_digest(root: Path = NORMALIZED_DIR, season: int | None = None, asof: str | None = None) -> str:
    """A digest of every input a view of (`season`, `asof`) reads, taken from
    the files as they are now; with no `season`, of every input of every
    season (careers.json).

    With `asof` set, only results played on or before that date count, which
    is what makes a rewound view reusable. Unplayed fixtures always count: the
    view lists future fixtures, so a rescheduled match changes it whatever the
    date. A live view (`asof=None`) sees every result, so any data change
    invalidates it -- as it must.
    """
    root = Path(root)
    # Seed ratings come from the 2014 tables, which every view replays from.
    extras = [hashlib.sha256(standings.read_bytes()).hexdigest() for standings in sorted(root.glob("*_standings.json"))]

    shot_dates: dict[str, str] = {}
    records: list[dict[str, Any]] = []
    for path in sorted(root.glob("*_matches.json")):
        for match in load_matches(path):
            shot_dates[match.match_id] = match.date
            record = asdict(match)
            if asof and match.played and match.date > asof:
                # A rewound view shows every match after its date as unplayed,
                # whether or not it has since been played -- the result is not
                # knowable back then. Both states must therefore hash the same,
                # or every fixture would churn the stamp of every earlier rewind.
                record.update(played=False, home_goals=None, away_goals=None)
            records.append(record)

    # Only xG for matches this view knows about. xG arriving for a later match
    # must not invalidate an earlier rewind.
    records += [
        {"match_id": match_id, "xg": values}
        for match_id, values in sorted(load_xg(_xg_path(root)).get("matches", {}).items())
        if asof is None or shot_dates.get(match_id, "") <= asof
    ]

    # The goals model's offseason pull reads each season's squad values from
    # the season before, so only the pages before this season count.
    records += [
        {"values": year, "clubs": clubs}
        for year, clubs in sorted(_read_values(_values_path(root)).items()) if season is None or year < season
    ]

    # The European places come from Norway's UEFA rank, which the refresh
    # updates in a data file rather than in code; a new rank must rebuild.
    extras.append(repr(bands_for(LEAGUE_SPECS["eliteserien"], season, root)) if season else repr(uefa_ranks(root)))
    blob = json.dumps(records, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256("\n".join(extras + [blob]).encode("utf-8")).hexdigest()


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
    # stay on one scale; only this league is tabled and simulated (the other
    # one only as far as its side of the play-off).
    by_league = {other: load_matches(_matches_path(other, season, root)) for other in LEAGUE_SPECS}

    # The slider spans every day this league actually played, taken from the
    # full fixture list so the range does not shrink as you rewind.
    matchdays = _matchdays(by_league[slug])

    if asof:
        by_league = {other: as_of_date(league_matches, asof) for other, league_matches in by_league.items()}
    all_matches = [match for league_matches in by_league.values() for match in league_matches]
    matches = by_league[slug]

    era = era_config(season, elo_config)
    pre_match: dict[str, tuple[float, float]] = {}
    shots = shot_table(root)
    ratings = build_rating_table(seeds, all_matches, config=elo_config, shots=shots, before=pre_match)
    prior = prior_attack_defence(root, season)
    ad = prior.copy().replay(all_matches)
    ad.start_season(season)
    playoffs, sim_ratings, sim_ad = _playoffs(slug, season, root, by_league, ratings, ad, simulation, elo_config)
    surface = slug == SURFACE_LEAGUE
    lines = stakes_lines(slug, season, matches, root)
    projection = simulate_season(
        matches, sim_ratings, ad=sim_ad, config=simulation, elo_config=elo_config, playoffs=playoffs,
        league=slug, stakes_lines=lines,
    )
    stakes_inputs = (
        projection.conditionals,
        # The conditionals' club axis is the live table's order,
        # which is the order simulate_season works in.
        [row.team_id for row in table_from_matches(matches)],
        [game for game in matches if not game.played],
        {team.team_id: team.position_probabilities for team in projection.teams},
        bands_for(spec, season, root),
        simulation,
    )
    high_stakes = _compute_high_stakes(*stakes_inputs)

    return {
        "league": {
            "slug": spec.slug,
            "name": spec.name,
            "season": season,
            "seasons": available_seasons(root),
            "current_season": current_season(root),
            "matchdays": matchdays,
            # The slider's first stop, before its matchdays (see preseason_date).
            "preseason": preseason_date(season, root),
            "asof": asof,
            "bands": [
                {"label": band.label, "first": band.first, "last": band.last, "tone": band.tone}
                for band in bands_for(spec, season, root)
            ],
        },
        # The card shows the config this season is actually rated with, which
        # from the boundary season on is the modern one, not the base defaults.
        "model": {
            "version": MODEL_VERSION,
            # The compare tool adds the surface edge to a fictional Eliteserien
            # match: the edge and which of the division's clubs play on grass.
            **({"surface": {"edge": SURFACE_EDGE, "grass": sorted(
                row.team_id for row in table_from_matches(matches)
                if is_grass(row.team_id, max((m.date for m in matches), default=f"{season}-12-31")))}}
               if surface else {}),
            "k_factor": era.k_factor,
            "home_advantage": era.home_advantage,
            "home_advantage_beta": era.home_advantage_beta,
            "xg_alpha": era.xg_alpha,
            "draw_base": era.draw_base,
            "draw_scale": era.draw_scale,
            "season_regression": era.season_regression,
            "finishing_regression": ad.config.finishing_regression,
            "seed_season": SEED_SEASON,
            "simulations": projection.simulations,
            "seed": projection.seed,
            "strength_sd": projection.strength_sd,
            # The table-stakes term in the run-in (model.stakes): rating points
            # and log goals per unit of pressure difference, from `from` played.
            "stakes": {"elo": table_stakes.STAKES_ELO, "goals": table_stakes.STAKES_GOALS,
                       "tau": table_stakes.STAKES_TAU, "from": table_stakes.STAKES_FROM},
            "matches_played": projection.matches_played,
            "matches_remaining": projection.matches_remaining,
            # Median points per finishing position: the expected points threshold
            # most clubs need to reach a band, shown on the table's separators.
            "position_points": projection.position_points,
            # The compare tool works out a fictional match in the browser, so it
            # needs the same ingredients the server uses: the draw model's
            # parameters above and both divisions' attack/defence/finishing/keeping ratings.
            "attack_defence": {
                "home": ad.config.home,
                "home_beta": ad.config.home_beta,
                "base": ad.config.base,
                "rho": ad.config.rho,
                "spread": ad.config.spread,
                "k": ad.config.k,
                "k_shots": ad.config.k_shots,
                "alpha": ad.config.alpha,
                "outcome_blend": OUTCOME_BLEND,
                "blend_gamma": ad.config.blend_gamma,
                "value_pull": ad.config.value_pull,
                "obos_season_regression": ad.config.obos_season_regression,
                "obos_value_pull": ad.config.obos_value_pull,
                "early_boost": ad.config.early_boost,
                "keeping_window": ad.config.keeping_window,
                "keeping_weight": ad.config.keeping_weight,
                # [attack, defence, finishing, keeping]: the compare tool lowers
                # a side's expected goals by the other side's keeping.
                "teams": {
                    team_id: [round(ad.attack[team_id], 4), round(ad.defence[team_id], 4),
                              round(ad.finishing.get(team_id, 0.0), 4), round(ad.keeping(team_id), 4)]
                    for (year, team_id) in ad.divisions if year == season and team_id in ad.attack
                },
            },
        },
        "table": _table_payload(matches, ratings, projection, seeds, ad, spec.slug, season, era, high_stakes,
                                bands=bands_for(spec, season, root)),
        # The attack map's trend, pooled over the division's earlier seasons.
        "attack_trend": attack_trend(spec.slug, season, root),
        "fixtures": _fixtures_payload(matches, ratings, elo_config, ad, league=slug,
                                      stakes=table_stakes.fixture_gaps(matches, lines)),
        "results": _results_payload(matches, pre_match, era, shots=shots),
        "high_stakes": high_stakes,
        "next_stakes": _next_stakes(*stakes_inputs),
        "history": _history_payload(
            build_history(matches, all_matches, seeds, prior=prior, elo_config=elo_config,
                          config=history, shots=shots, league=slug, stakes_lines=lines),
            {row.team_id: row.team for row in table_from_matches(matches)},
        ),
    }


# The second-tier side OBOS-ligaen's 14th plays to stay up. It is outside the
# data, so it is rated as the model rates any club arriving from that tier: at
# the ladder floor, and its division's attack and defence less `newcomer`.
SECOND_TIER = "second-tier"


def _playoff_bands(slug: str, season: int, root: Path) -> tuple[Band | None, Band | None]:
    """(promotion bracket, survival tie): the play-off bands above mid-table
    and just above the relegation places."""
    bands = bands_for(LEAGUE_SPECS[slug], season, root)
    relegation = next(band for band in bands if band.tone == "relegation")
    playoff = [band for band in bands if band.tone == "playoff"]
    bracket = next((band for band in playoff if band.last < relegation.first - 1), None)
    survival = next((band for band in playoff if band.last == relegation.first - 1), None)
    return bracket, survival


def _playoffs(
    slug: str,
    season: int,
    root: Path,
    by_league: dict[str, list[Match]],
    ratings: dict[str, float],
    ad: AttackDefence,
    simulation: SimulationConfig | None,
    elo_config: EloConfig,
) -> tuple[Playoffs, dict[str, float], AttackDefence]:
    """The post-season ties this league's simulation plays, and the ratings
    and goals model it plays them with (the second-tier side added).

    A tie with the other division takes that division's side run by run from
    a simulation of it (the same seed and inputs as its own report, so the
    same tables), so a promotion final is against the club that finished
    14th in that run, with the strength it finished there with."""
    simulation = simulation or SimulationConfig()
    bracket, survival = _playoff_bands(slug, season, root)
    ladder = season >= LADDER_FROM
    places = lambda band: tuple(range(band.first, band.last + 1)) if band else ()
    opponent_of_bracket = opponent_of_survival = None
    for other in LEAGUE_SPECS:
        if other == slug or not by_league.get(other):
            continue
        other_bracket, other_survival = _playoff_bands(other, season, root)
        if bracket and other_survival:
            # Our bracket winner meets their survival place: keep it per run.
            opponent_of_bracket = simulate_season(
                by_league[other], ratings, ad=ad, config=simulation, elo_config=elo_config,
                tally_conditionals=False, keep_position=other_survival.first, league=other,
                stakes_lines=stakes_lines(other, season, by_league[other], root),
            ).kept
        if survival and other_bracket:
            # Our survival place meets their bracket winner.
            opponent_of_survival = simulate_season(
                by_league[other], ratings, ad=ad, config=simulation, elo_config=elo_config,
                tally_conditionals=False, playoffs=Playoffs(bracket=places(other_bracket), ladder=ladder),
                league=other, stakes_lines=stakes_lines(other, season, by_league[other], root),
            ).bracket_winners
    sim_ratings, sim_ad = ratings, ad
    if survival and bracket and opponent_of_survival is None:
        # The bottom division (the one with a promotion bracket): its survival
        # tie is against the tier below. A top division whose partner has no
        # fixture list simply plays no survival tie.
        sim_ratings = {**ratings, SECOND_TIER: rating_for_unseeded_team()}
        sim_ad = ad.copy()
        peers = [team for (year, team), league in ad.divisions.items() if year == season and league == slug]
        for ratings_of in (sim_ad.attack, sim_ad.defence):
            ratings_of[SECOND_TIER] = sum(ratings_of[team] for team in peers) / len(peers) - ad.config.newcomer
        sim_ad.finishing[SECOND_TIER] = 0.0
        rng = np.random.default_rng([simulation.seed, 2])
        opponent_of_survival = Opponent(
            (SECOND_TIER,), np.zeros(simulation.simulations, dtype=np.intp),
            rng.normal(0.0, simulation.strength_sd, simulation.simulations),
        )
    playoffs = Playoffs(
        bracket=places(bracket), ladder=ladder, final=opponent_of_bracket,
        survival_position=survival.first if survival else None, survival=opponent_of_survival,
    )
    return playoffs, sim_ratings, sim_ad


# A club must already have at least this chance of finishing in a
# band for a remaining match to be high-stakes in it, and the gap
# between winning and losing the match must clear this bar to be
# worth a badge.
MIN_BAND_P = 0.10
MIN_SWING = 0.25
# Badges are a run-in feature. Backtested over 2015-2025 (490 rewound
# snapshots), a swing told nothing about which fixture would end up
# deciding a band until about ten rounds were left: before that, the
# badged fixtures were decisive no more often than any other.
RUN_IN_ROUNDS = 10
# The team view's next-match line is left off below this swing: a
# line saying the chance is 99% either way says nothing.
MIN_NEXT_SWING = 0.05
# A branch thinner than this is Monte Carlo noise rather than a
# probability, so the fixture is left off instead of divided into.
# The floor scales with the run count because noise falls as
# 1/sqrt(runs); it is 1% of the runs for every shipped config.
MIN_BRANCH = 500


def _contender_legs(
    conditionals: list[list[list[list[int]]]] | None,
    clubs: list[str],
    fixtures: list[Match],
    unconditional: dict[str, list[float]],
    bands: tuple[Band, ...],
    config: SimulationConfig | None = None,
):
    """Per contender and band, its swing on every fixture it has left.

    `conditionals` is `SeasonProjection.conditionals`: per unplayed
    fixture (in `fixtures` order), per outcome (0 home win, 1 draw,
    2 away win), per club, how many runs finished the club in each
    position given that outcome. Yields (team_id, band, baseline,
    legs), one leg per fixture with the band's chance given the
    favourable result, the draw and the unfavourable result. Relegation is the one
    band a loss brings closer, so its favourable side is the loss.
    """
    if not conditionals or not clubs or not fixtures:
        return
    index_of = {team_id: index for index, team_id in enumerate(clubs)}
    # The fixtures left per club, as (conditionals index, match).
    remaining: dict[int, list[tuple[int, Match]]] = {index: [] for index in range(len(clubs))}
    names: dict[str, str] = {}
    for fixture_index, game in enumerate(fixtures):
        home_id = game.home_id or game.home
        away_id = game.away_id or game.away
        names[home_id] = game.home
        names[away_id] = game.away
        home = index_of.get(home_id)
        if home is not None:
            remaining[home].append((fixture_index, game))
        away = index_of.get(away_id)
        if away is not None:
            remaining[away].append((fixture_index, game))
    min_branch = max(MIN_BRANCH, (config or SimulationConfig()).simulations // 100)

    for club_index, team_id in enumerate(clubs):
        chances = unconditional.get(team_id) or []
        for band in bands:
            span = slice(band.first - 1, band.last)
            baseline = sum(chances[span])
            if baseline < MIN_BAND_P:
                continue  # not in contention for this band
            relegation = band.tone == "relegation"
            legs: list[dict[str, Any]] = []
            for fixture_index, game in remaining[club_index]:
                branches = conditionals[fixture_index]
                is_home = index_of[game.home_id or game.home] == club_index
                win_branch, loss_branch = (0, 2) if is_home else (2, 0)
                wins = branches[win_branch][club_index]
                losses = branches[loss_branch][club_index]
                n_win = sum(wins)
                n_loss = sum(losses)
                if n_win < min_branch or n_loss < min_branch:
                    continue  # branch too thin to divide into
                win_band = sum(wins[span]) / n_win
                loss_band = sum(losses[span]) / n_loss
                # The draw is only read out, never ranked on, so a thin
                # draw branch leaves out the figure rather than the fixture.
                draws = branches[1][club_index]
                n_draw = sum(draws)
                draw_band = sum(draws[span]) / n_draw if n_draw >= min_branch else None
                # Relegation reads the other way round: the loss is
                # what brings it closer, so it is the favourable side.
                favourable, unfavourable = (
                    (loss_band, win_band) if relegation else (win_band, loss_band)
                )
                opponent_id = (game.away_id or game.away) if is_home else (game.home_id or game.home)
                legs.append({
                    "team": names[team_id],
                    "opponent_id": opponent_id,
                    "opponent": names[opponent_id],
                    "match_id": game.match_id,
                    "date": game.date,
                    "home_id": game.home_id or game.home,
                    "away_id": game.away_id or game.away,
                    "p_favourable": favourable,
                    "p_unfavourable": unfavourable,
                    "p_draw": draw_band,
                    "swing": favourable - unfavourable,
                })
            yield team_id, band, baseline, legs


def _stake_entry(
    team_id: str, band: Band, baseline: float, chosen: dict[str, Any], legs: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "team_id": team_id,
        "team": chosen["team"],
        "opponent_id": chosen["opponent_id"],
        "opponent": chosen["opponent"],
        "band_label": band.label,
        "band_first": band.first,
        "band_last": band.last,
        "band_tone": band.tone,
        "match_id": chosen["match_id"],
        "leg_match_ids": [leg["match_id"] for leg in legs],
        "date": chosen["date"],
        "home_id": chosen["home_id"],
        "away_id": chosen["away_id"],
        "p_baseline": round(baseline, 4),
        "p_favourable": round(chosen["p_favourable"], 4),
        "p_unfavourable": round(chosen["p_unfavourable"], 4),
        "p_draw": None if chosen["p_draw"] is None else round(chosen["p_draw"], 4),
        "swing": round(chosen["swing"], 4),
    }


def _compute_high_stakes(
    conditionals: list[list[list[list[int]]]] | None,
    clubs: list[str],
    fixtures: list[Match],
    unconditional: dict[str, list[float]],
    bands: tuple[Band, ...],
    config: SimulationConfig | None = None,
) -> list[dict[str, Any]]:
    """The remaining fixtures that swing a contender's band chance most.

    A fixture is high-stakes for a club when the chance of its band
    differs between the club winning the fixture and losing it by at
    least MIN_SWING, and only once the season is in its last
    RUN_IN_ROUNDS rounds. Per opponent pairing the higher-swing leg
    is the one named, with both legs attached.
    """
    if len(fixtures) > RUN_IN_ROUNDS * max(1, len(clubs) // 2):
        return []  # before the run-in no fixture is knowably decisive
    entries: list[dict[str, Any]] = []
    for team_id, band, baseline, legs in _contender_legs(
        conditionals, clubs, fixtures, unconditional, bands, config
    ):
        # One entry per opponent: the pairing collapses to its
        # higher-swing leg, with both legs recorded.
        pairings: dict[str, list[dict[str, Any]]] = {}
        for leg in legs:
            if leg["swing"] >= MIN_SWING:
                pairings.setdefault(leg["opponent_id"], []).append(leg)
        for pairing in pairings.values():
            chosen = max(pairing, key=lambda leg: leg["swing"])
            entries.append(_stake_entry(team_id, band, baseline, chosen, pairing))
    entries.sort(key=lambda entry: -entry["swing"])
    return entries


def _next_stakes(
    conditionals: list[list[list[list[int]]]] | None,
    clubs: list[str],
    fixtures: list[Match],
    unconditional: dict[str, list[float]],
    bands: tuple[Band, ...],
    config: SimulationConfig | None = None,
) -> list[dict[str, Any]]:
    """Per club, what its next fixture does to the band it rides on most.

    Unlike the badges this holds all season: it claims only the two
    conditional chances, not that the match will decide anything.
    Same entry shape as `_compute_high_stakes`, one per club at most.
    """
    first: dict[str, str] = {}
    for game in sorted(fixtures, key=Match.sort_key):
        first.setdefault(game.home_id or game.home, game.match_id)
        first.setdefault(game.away_id or game.away, game.match_id)
    best: dict[str, tuple[float, dict[str, Any]]] = {}
    for team_id, band, baseline, legs in _contender_legs(
        conditionals, clubs, fixtures, unconditional, bands, config
    ):
        for leg in legs:
            if leg["match_id"] != first.get(team_id) or leg["swing"] < MIN_NEXT_SWING:
                continue
            if team_id not in best or leg["swing"] > best[team_id][0]:
                best[team_id] = (leg["swing"], _stake_entry(team_id, band, baseline, leg, [leg]))
    return sorted((entry for _, entry in best.values()), key=lambda entry: -entry["swing"])


def rewound_configs(asof: str | None) -> tuple[SimulationConfig, HistoryConfig]:
    """Simulation settings for a live view or a rewound one.

    Every simulation runs the same 50,000 runs; a rewound view only takes
    season-shape snapshots at each matchweek rather than the 20 sampled days.
    """
    if not asof:
        return SimulationConfig(), HistoryConfig()
    return SimulationConfig(), HistoryConfig(by_round=True)


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
    elo_config: EloConfig,
    high_stakes: list[dict[str, Any]] | None = None,
    bands: tuple[Band, ...] = (),
) -> list[dict[str, Any]]:
    projections = {team.team_id: team for team in projection.teams}
    # Promotion and relegation counted to the end, play-offs included: the
    # places that go straight up or down, plus the runs a club goes through
    # the final or out through the survival tie.
    top = next((band for band in bands if band.tone == "top"), None) if slug == "obosligaen" else None
    down = next((band for band in bands if band.tone == "relegation"), None)
    within = lambda team, band: sum(team.position_probabilities[band.first - 1:band.last])
    # League-average rating for this division (not hardcoded 1500)
    league_avg_rating = sum(p.rating for p in projections.values()) / len(projections) if projections else 1500.0
    # The high-stakes matches each club has left, as match ids.
    stakes_by_team: dict[str, list[str]] = {}
    for entry in high_stakes or []:
        stakes_by_team.setdefault(entry["team_id"], []).append(entry["match_id"])
    # Pre-compute remaining fixtures per team.
    remaining: dict[str, list[tuple[str, float]]] = {team_id: [] for team_id in ratings}
    for match in matches:
        if match.played:
            continue
        home_id = match.home_id or match.home
        away_id = match.away_id or match.away
        if home_id in remaining:
            remaining[home_id].append(("home", ratings.get(away_id, 1500.0)))
        if away_id in remaining:
            remaining[away_id].append(("away", ratings.get(home_id, 1500.0)))
    payload = []
    for position, row in enumerate(table_from_matches(matches), start=1):
        team = projections[row.team_id]
        started = seeds[row.team_id].rating if row.team_id in seeds else ratings[row.team_id]
        scored, conceded = ad.rates_against_average(row.team_id, slug, season)
        # Calculate fixture difficulty: average expected points per match for a league-average team
        # against each of the team's remaining opponents.
        opp_fixtures = remaining.get(row.team_id, [])
        if opp_fixtures:
            expected_points = 0.0
            for venue, opp_rating in opp_fixtures:
                if venue == "home":
                    prob = match_probabilities(league_avg_rating, opp_rating, elo_config)
                    expected_points += prob.home_win * 3 + prob.draw * 1
                else:
                    prob = match_probabilities(opp_rating, league_avg_rating, elo_config)
                    expected_points += prob.away_win * 3 + prob.draw * 1
            expected_points /= len(opp_fixtures)
        else:
            expected_points = 0.0  # No remaining fixtures
        
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
                "expected_goals_for": round(team.expected_goals_for, 1),
                "expected_goals_against": round(team.expected_goals_against, 1),
                "fixture_difficulty": round(expected_points, 2),  # Lower = harder fixtures
                "position_probabilities": [round(value, 6) for value in team.position_probabilities],
                # The high-stakes fixtures left for this club, so the
                # team view can find its entries without scanning them.
                "high_stakes_match_ids": stakes_by_team.get(row.team_id, []),
                # Expected goals for and against per match, against an average
                # side of the division: the readable form of the attack/defence ratings.
                "attack": round(scored, 2),
                "defence": round(conceded, 2),
                "finishing": round(ad.finishing.get(row.team_id, 0.0), 4),
                **({"promotion_probability": round(within(team, top) + team.promoted_via_playoff, 6),
                    "playoff_win_probability": round(team.playoff_win, 6)} if top else {}),
                **({"relegation_probability": round(within(team, down) + team.relegated_via_playoff, 6)} if down else {}),
            }
        )
    return payload


def _fixtures_payload(
    matches: list[Match], ratings: dict[str, float], elo_config: EloConfig, ad: AttackDefence,
    *, league: str = "", stakes: dict[str, float] | None = None,
) -> list[dict[str, Any]]:
    """Upcoming fixtures with three-way odds and the most likely scorelines,
    priced as everywhere else (`model.pricing`). `stakes` (match_id ->
    P_home - P_away, `model.stakes.fixture_gaps`) adds the table-stakes term,
    from the table as it stands."""
    stakes = stakes or {}
    payload = []
    for match in matches:
        if match.played:
            continue
        home_id, away_id = team_ids(match)
        gap = stakes.get(match.match_id, 0.0)
        priced = match_odds(elo_odds(match, ratings[home_id], ratings[away_id], elo_config, league, stakes=gap),
                            ad, match, stakes=gap)
        probabilities = priced.odds
        scorelines = priced.scorelines()
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


def xg_form(home_rating: float, away_rating: float, home_xg: float, away_xg: float, config: EloConfig) -> float:
    """How far the home side played above its rating, by the chances alone.

    The rating change the match would have produced had only its xG counted:
    K * (xG-implied score - expected score). The away side's is the negative.
    Measured over 3,738 club-season windows, a recent average of this tracks
    the next few matches (r ~0.17) where an average of actual rating changes
    does not (~0.05), which is why the trend arrow is built on it.
    """
    expected = expected_score(home_rating + effective_home_advantage(config, home_rating, away_rating), away_rating)
    return config.k_factor * (xg_implied_score(home_xg, away_xg) - expected)


def _results_payload(
    matches: list[Match], pre_match: dict[str, tuple[float, float]] | None = None, config: EloConfig | None = None,
    *, shots: dict[str, tuple[float, ...]] | None = None,
) -> list[dict[str, Any]]:
    """Played results; `shots` (`shot_table`) adds each match's xG where known."""
    pre_match = pre_match or {}
    shots_of = shots or {}
    config = config or EloConfig()
    payload = []
    for match in matches:
        if not match.played:
            continue
        result = {
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
        # Shown under the score so a rating move reads against the chances as
        # well as the result; left out where the match has no xG.
        shots = shots_of.get(match.match_id)
        if shots:
            result["xg"] = [round(shots[0], 2), round(shots[1], 2)]
            # xG on target (fotmob, Eliteserien), for the luck table's keeping:
            # goals let in against the xG on target faced.
            if len(shots) >= 4:
                result["xgot"] = [round(shots[2], 2), round(shots[3], 2)]
            if match.match_id in pre_match:
                form = xg_form(*pre_match[match.match_id], shots[0], shots[1], config)
                result["xg_form"] = [round(form, 2), round(-form, 2)]
        payload.append(result)
    return payload


def careers_payload(careers: dict[str, TeamCareer], *, root: Path = NORMALIZED_DIR) -> dict[str, Any]:
    """Rating history per club, one point per match.

    Not thinned: Played Results and the table's trend arrows read each match's
    rating change off these points by date, so a dropped point is a wrong delta.
    """
    teams = []
    for team_id, career in sorted(careers.items(), key=lambda kv: kv[1].team):
        points = career.points
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
    return {"seed_season": SEED_SEASON, "model": MODEL_VERSION, "teams": teams, "head_to_head": _build_head_to_head(root)}


def _build_head_to_head(root: Path = NORMALIZED_DIR) -> dict[str, list[dict[str, Any]]]:
    """All-time head-to-head results keyed by the sorted pair of team ids."""
    h2h: dict[str, list[dict[str, Any]]] = {}
    for path in sorted(root.glob("*_matches.json")):
        found = _MATCH_FILE.match(path.name)
        if not found:
            continue
        season = int(found["season"])
        for m in load_matches(path):
            if not m.played:
                continue
            key = tuple(sorted((m.home_id, m.away_id)))
            entry = {
                "date": m.date,
                "home": m.home,
                "away": m.away,
                "home_id": m.home_id,
                "away_id": m.away_id,
                "home_goals": m.home_goals,
                "away_goals": m.away_goals,
                "season": season,
            }
            h2h.setdefault(f"{key[0]}\t{key[1]}", []).append(entry)
    return h2h


