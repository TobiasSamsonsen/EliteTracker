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

from elitetracker.model.attack_defence import ADConfig, AttackDefence, KEEPING_LEAGUE_ROWS, OUTCOME_BLEND, man_advantage
from elitetracker.model.career import SeasonSlice, TeamCareer, build_careers, replay, team_ids
from elitetracker.model.elo import (
    MODEL_VERSION, EloConfig, effective_home_advantage, era_config, expected_score, model_xg, xg_implied_score,
    xg_score_part,
)
from elitetracker.model.initial_ratings import SeedingConfig, TeamRating, initial_ratings, rating_for_unseeded_team
from elitetracker.model.pricing import SURFACE_LEAGUE, elo_odds, match_odds
from elitetracker.model.probabilities import match_probabilities
from elitetracker.model.ratings import build_rating_table
from elitetracker.model import stakes as table_stakes
from elitetracker.model.table import table_from_matches
from elitetracker.normalize.matches import Match
from elitetracker.normalize.standings import load_standings
from elitetracker.normalize.surfaces import SURFACE_EDGE, is_grass, surface_edge
from elitetracker.sources.fotmob import RED_CARDS_PATH, REFEREES_PATH, XG_PATH, load_red_cards, load_referees, load_xg
# Transfermarkt squad values per club-season, for the goals model's offseason
# pull (`ADConfig.value_pull`); `research market-values` adds a season by hand.
from elitetracker.sources.transfermarkt import MARKET_VALUES_PATH
from elitetracker.simulation.history import (
    HistoryConfig,
    HistorySnapshot,
    SnapshotKey,
    as_of_date,
    build_history,
    build_snapshot,
)
from elitetracker.simulation.playoffs import LADDER_FROM, Opponent, Playoffs
from elitetracker.simulation.season import (
    SeasonProjection, SimulationConfig, bracket_winners, kept_at, play_postseason, simulate_season,
)

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


def _referees_path(root: Path) -> Path:
    return Path(root).parent / REFEREES_PATH.name


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
        config=elo_config, shots=shot_table(root), values=market_values(root), playoffs=playoff_played(root),
    )


@functools.cache
def shot_table(root: Path = NORMALIZED_DIR) -> dict[str, tuple[float, ...]]:
    """match_id -> expected goals: fotmob for Eliteserien, Sofascore for OBOS.

    Entries are (home_xg, away_xg) and, where the source has it, xG on target,
    npxG and the first red card's minute after them (`load_xg`); everything
    downstream reads the first two.
    """
    return {match_id: tuple(values) for match_id, values in load_xg(_xg_path(root))["matches"].items()}


@functools.cache
def red_table(root: Path = NORMALIZED_DIR) -> dict[str, float]:
    """match_id -> the home side's man advantage (`attack_defence.man_advantage`)
    for every match with a red card in `data/red_cards.json`, for the goals
    model (elo-v19.0)."""
    path = Path(root).parent / RED_CARDS_PATH.name
    return {match_id: man_advantage(reds) for match_id, reds in load_red_cards(path).items() if reds}


@functools.cache
def referee_table(root: Path = NORMALIZED_DIR) -> dict[str, dict[str, Any]]:
    """match_id -> {referee, yellow, red, fouls} from `data/referees.json`."""
    return load_referees(_referees_path(root)).get("matches", {})


# FotMob transliterated Norwegian characters (ø -> oe, å -> aa) and shortened
# middle names in earlier seasons; fold known variants to one canonical name.
_REFEREE_ALIASES: dict[str, str] = {
    "Espen Eskaas": "Espen Eskås",
    "Joergen Haugen": "Jørgen Haugen",
    "Marius Hansen Groetta": "Marius Hansen Grøtta",
    "Marius Hansen Grotta": "Marius Hansen Grøtta",
    "Mathias Stoefringshaug": "Mathias Støfringshaug",
    "Mischa Huru": "Mischa Huru Kellerhals",
    "Mischa Kellerhals": "Mischa Huru Kellerhals",
    "Mischa Schaub Kellerhals": "Mischa Huru Kellerhals",
    "Mohammad Aslam": "Mohammad Usman Aslam",
    "Usman Aslam": "Mohammad Usman Aslam",
    "Ola Nielsen": "Ola Hobber Nilsen",
    "Sivert Amland": "Sivert Øksnes Amland",
    "Sivert Oeksnes Amland": "Sivert Øksnes Amland",
    "Stian Roevig Sletner": "Stian Røvig Sletner",
    "Svein Torre Sinnes": "Svein Tore Sinnes",
}


def normalize_referee_name(name: str) -> str:
    """Map FotMob's historical spelling variants to one canonical referee name."""
    cleaned = " ".join(name.split())
    return _REFEREE_ALIASES.get(cleaned, cleaned)


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
    return AttackDefence.from_slices(slices, ADConfig(), shots=shot_table(root), values=market_values(root),
                                     reds=red_table(root)).replay(
        [match for slice_ in slices if slice_.season < season for match in slice_.matches]
    )


@functools.cache
def season_end_rates(root: Path) -> dict[tuple[str, int], list[tuple[float, float]]]:
    """Each division's clubs as they ended each season, in expected goals for
    and against per match against an average side (the table's `attack` and
    `defence`). Every season is replayed once, in order."""
    slices = load_slices(root)
    ad = AttackDefence.from_slices(slices, ADConfig(), shots=shot_table(root), values=market_values(root),
                                   reds=red_table(root))
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
    for loader in (load_slices, shot_table, referee_table, stakes_table, market_values, prior_attack_defence,
                   season_end_rates, first_xg_seasons, match_performance):
        loader.cache_clear()


def inputs_digest(root: Path = NORMALIZED_DIR, season: int | None = None, asof: str | None = None) -> str:
    """A digest of every input a view of (`season`, `asof`) reads, taken from
    the files as they are now; with no `season`, of every input of every
    season (careers.json).

    With `asof` set, only results played on or before that date count, which
    is what makes a rewound view reusable. Unplayed fixtures always count: the
    view lists future fixtures, so a rescheduled match changes it whatever the
    date. A live view (`asof=None`) sees every result of its season, so any
    change to it invalidates it -- as it must.

    A season's view reads that season and the ones before it, never later
    seasons' matches or xG (checked: building 2016 and 2018 from a root holding
    only the files up to 2018 gives the same reports but for the list of seasons
    on offer), so with `season` set the later files are left out and a new
    weekend of 2026 does not restamp 2015-2025. The seasons on offer
    (`league.seasons`, `current_season`) are stamped themselves: a new season
    file changes them once a year.
    """
    root = Path(root)
    # Seed ratings come from the 2014 tables, which every view replays from.
    extras = [hashlib.sha256(standings.read_bytes()).hexdigest() for standings in sorted(root.glob("*_standings.json"))]

    shot_dates: dict[str, str] = {}
    records: list[dict[str, Any]] = []
    for path in sorted(root.glob("*_matches.json")):
        found = _MATCH_FILE.match(path.name)
        if season is not None and found and int(found["season"]) > season:
            continue
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

    # The play-off matches move the ratings and the play-off's chances: as the
    # match files, a later season's left out and a result after `asof` unplayed.
    for year, fixtures in sorted(playoff_matches(root).items()):
        if season is not None and year > season:
            continue
        for fixture in fixtures:
            record = {"playoff": year, **fixture}
            if asof and fixture["played"] and fixture["date"] > asof:
                record.update(played=False, home_goals=None, away_goals=None, eliminated=None)
            records.append(record)

    # Only xG for matches this view knows about. xG arriving for a later match
    # (a later date, or a later season) must not invalidate an earlier view.
    scoped = season is not None
    records += [
        {"match_id": match_id, "xg": values}
        for match_id, values in sorted(load_xg(_xg_path(root)).get("matches", {}).items())
        if (match_id in shot_dates if scoped else True) and (asof is None or shot_dates.get(match_id, "") <= asof)
    ]
    extras.append(repr(available_seasons(root)))

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


def build_history_snapshot(
    slug: str,
    season: int,
    on: str,
    *,
    root: Path = NORMALIZED_DIR,
    careers: dict[str, TeamCareer] | None = None,
    elo_config: EloConfig | None = None,
    seeding: SeedingConfig | None = None,
    config: HistoryConfig | None = None,
) -> HistorySnapshot:
    """One history snapshot for `(slug, season)` as of `on`, using the exact
    same inputs `build_report` passes to `build_history`."""
    elo_config = elo_config or EloConfig()
    careers = careers if careers is not None else build_all_careers(root, elo_config=elo_config, seeding=seeding)
    seeds = _season_seeds(careers, season)
    by_league = {other: load_matches(_matches_path(other, season, root)) for other in LEAGUE_SPECS}
    all_matches = [match for league_matches in by_league.values() for match in league_matches]
    matches = by_league[slug]
    return build_snapshot(
        on,
        matches,
        all_matches,
        seeds,
        prior=prior_attack_defence(root, season),
        elo_config=elo_config,
        config=config,
        shots=shot_table(root),
        league=slug,
        stakes_lines=stakes_lines(slug, season, matches, root),
    )


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
    share: dict[str, SeasonProjection] | None = None,
    history_cache: dict[SnapshotKey, HistorySnapshot] | None = None,
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
    # The play-off matches played by then move the ratings too (elo-v18.0), so a
    # finished one reprices the matches after it; the goals model leaves them out.
    ratings = build_rating_table(seeds, all_matches + playoff_played(root, asof).get(season, []),
                                 config=elo_config, shots=shots, before=pre_match)
    prior = prior_attack_defence(root, season)
    start = prior.copy()
    start.start_season(season)
    ad = prior.copy().replay(all_matches)
    ad.start_season(season)
    share = share if share is not None else {}
    surface = slug == SURFACE_LEAGUE
    lines = stakes_lines(slug, season, matches, root)
    bands = bands_for(spec, season, root)
    live_table = table_from_matches(matches)
    projection = _base_run(slug, season, root, by_league, ratings, ad, simulation, elo_config, share)
    _postseason(slug, season, root, by_league, ratings, ad, simulation, elo_config, projection, share)
    stakes_inputs = (
        projection.conditionals,
        # The clubs, in the live table's order, which is the order
        # simulate_season works in (a position index is one in this list).
        [row.team_id for row in live_table],
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
                row.team_id for row in live_table
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
        "rerate": rerate_payload(slug, matches, seeds, shots, start, era),
        "high_stakes": high_stakes,
        **({"relegation_playoff": tie} if (tie := _relegation_playoff_payload(
            projection, by_league, _settled_outcome(season, root, by_league) is not None,
            next((run.bracket_matches for run in (projection, *share.values()) if run.bracket_matches), None),
            playoff_matches(root).get(season, []),
        )) else {}),
        "next_stakes": _next_stakes(*stakes_inputs),
        "rival_watch": _rival_watch(
            projection.rivals, projection.rival_runs, stakes_inputs[1], stakes_inputs[2], stakes_inputs[3],
            bands, simulation,
        ),
        "history": _history_payload(
            build_history(matches, all_matches, seeds, prior=prior, elo_config=elo_config,
                          config=history, shots=shots, league=slug, stakes_lines=lines,
                          cache=history_cache),
            {row.team_id: row.team for row in live_table},
        ),
    }


# The second-tier side OBOS-ligaen's 14th plays to stay up. It is outside the
# data, so it is rated as the model rates any club arriving from that tier: at
# the ladder floor, and its division's attack and defence less `newcomer`.
SECOND_TIER = "second-tier"
# Finished seasons' play-offs, as played (below), beside the match files.
PLAYOFF_OUTCOMES_FILE = "playoff_outcomes.json"


def _playoff_bands(slug: str, season: int, root: Path) -> tuple[Band | None, Band | None]:
    """(promotion bracket, survival tie): the play-off bands above mid-table
    and just above the relegation places."""
    bands = bands_for(LEAGUE_SPECS[slug], season, root)
    relegation = next(band for band in bands if band.tone == "relegation")
    playoff = [band for band in bands if band.tone == "playoff"]
    bracket = next((band for band in playoff if band.last < relegation.first - 1), None)
    survival = next((band for band in playoff if band.last == relegation.first - 1), None)
    return bracket, survival


def playoff_outcomes(root: Path = NORMALIZED_DIR) -> dict[int, dict[str, Any]]:
    """What the finished seasons' play-offs came to (`playoff_outcomes.json`):
    per season, the OBOS-ligaen bracket winner and whether it went up through the
    final against Eliteserien's 14th, and whether that 14th and OBOS-ligaen's 14th
    went down. Bracket winners from the season's Wikipedia articles where the
    next season's membership does not show them, and every flag checked against
    that membership (`tests/test_playoffs.py`)."""
    path = Path(root) / PLAYOFF_OUTCOMES_FILE
    if not path.exists():
        return {}
    return {int(season): outcome for season, outcome in json.loads(path.read_text(encoding="utf-8")).items()}


# This season's play-off matches as fotmob lists them, played and to come
# (`refresh.refresh_playoffs`), beside the match files.
PLAYOFF_FIXTURES_FILE = "playoff_fixtures.json"


def playoff_matches(root: Path = NORMALIZED_DIR) -> dict[int, list[dict[str, Any]]]:
    """Per season, the play-off matches stored by `refresh` (`normalize_playoff_matches`)."""
    path = Path(root) / PLAYOFF_FIXTURES_FILE
    if not path.exists():
        return {}
    return {int(season): matches for season, matches in json.loads(path.read_text(encoding="utf-8")).items()}


def save_playoff_matches(stored: dict[str, list[dict[str, Any]]], root: Path = NORMALIZED_DIR) -> None:
    """Write `playoff_fixtures.json` (season -> matches), LF line endings on every platform."""
    text = json.dumps(dict(sorted(stored.items())), indent=1, ensure_ascii=False) + "\n"
    (Path(root) / PLAYOFF_FIXTURES_FILE).write_bytes(text.encode("utf-8"))


def playoff_played(root: Path = NORMALIZED_DIR, asof: str | None = None) -> dict[int, list[Match]]:
    """Per season, the play-off matches played (by `asof`, where given), as the
    rating replay takes them."""
    out: dict[int, list[Match]] = {}
    for season, fixtures in playoff_matches(root).items():
        games = [
            Match(match_id=fixture["match_id"], date=fixture["date"], time=fixture["time"], home=fixture["home"],
                  away=fixture["away"], home_goals=fixture["home_goals"], away_goals=fixture["away_goals"],
                  played=True, kickoff_utc=fixture["kickoff_utc"], home_id=fixture["home_id"],
                  away_id=fixture["away_id"])
            for fixture in fixtures if fixture["played"] and (asof is None or fixture["date"] <= asof)
        ]
        if games:
            out[season] = games
    return out


def _sides(match: dict[str, Any]) -> tuple[str, str]:
    return match["home_id"] or match["home"], match["away_id"] or match["away"]


def _went_through(match: dict[str, Any]) -> str | None:
    """Who a played single match sent through: the side fotmob did not knock
    out, else the side that scored more (level and unmarked: not known yet)."""
    if not match["played"]:
        return None
    home, away = _sides(match)
    if match.get("eliminated") in (home, away):
        return away if match["eliminated"] == home else home
    if match["home_goals"] != match["away_goals"]:
        return home if match["home_goals"] > match["away_goals"] else away
    return None


def playoff_tie(matches: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str | None]:
    """The two-legged tie among a season's play-off matches (the one pairing that
    meets twice) and who won it once both legs are played: the side fotmob did
    not knock out, else the side ahead on aggregate."""
    pairs: dict[frozenset, list[dict[str, Any]]] = {}
    for match in matches:
        pairs.setdefault(frozenset(_sides(match)), []).append(match)
    legs = next((legs for legs in pairs.values() if len(legs) == 2), [])
    if len(legs) < 2 or not all(leg["played"] for leg in legs):
        return legs, None
    sides = set(_sides(legs[0]))
    knocked = next((leg["eliminated"] for leg in legs if leg.get("eliminated") in sides), None)
    if knocked:
        return legs, next(side for side in sides if side != knocked)
    goals = dict.fromkeys(sides, 0)
    for leg in legs:
        home, away = _sides(leg)
        goals[home] += leg["home_goals"]
        goals[away] += leg["away_goals"]
    first, second = sorted(sides)
    return legs, None if goals[first] == goals[second] else max(sides, key=goals.get)


def _bracket_decided(matches: list[dict[str, Any]], runs: SeasonProjection, bracket: tuple[int, ...],
                     ladder: bool) -> tuple[tuple[int, str], ...]:
    """The ladder's matches already played, as `Playoffs.decided`: a match is
    known by its host, the higher seed (5th, then 4th, then 3rd), once the
    table is final (every run has the same club in that place)."""
    if not ladder or len(bracket) != 4 or runs.run_order is None:
        return ()
    hosts = {bracket[2]: 0, bracket[1]: 1, bracket[0]: 2}
    place_of = {}
    for place in hosts:
        clubs = runs.run_order[:, place - 1]
        if (clubs == clubs[0]).all():
            place_of[runs.club_ids[clubs[0]]] = place
    legs = playoff_tie(matches)[0]
    decided = []
    for match in matches:
        through = None if match in legs else _went_through(match)
        index = hosts.get(place_of.get(_sides(match)[0]))
        if through is not None and index is not None:
            decided.append((index, through))
    return tuple(sorted(decided))


def _settled_outcome(season: int, root: Path, by_league: dict[str, list[Match]]) -> dict[str, Any] | None:
    """The play-offs as they went, for a season that is over and has them on file."""
    outcome = playoff_outcomes(root).get(season)
    played = all(match.played for league_matches in by_league.values() for match in league_matches)
    return outcome if outcome and played else None


def _settle_playoffs(projection: SeasonProjection, slug: str, outcome: dict[str, Any]) -> None:
    """The play-off chances of a season whose play-offs are over: 1 or 0, as they went."""
    winner, down = outcome.get("bracket_winner"), set()
    if winner and outcome.get("eliteserien_14th"):
        stayed = 0.0 if outcome.get("eliteserien_14th_relegated") else 1.0
        projection.tie_pairs = [(outcome["eliteserien_14th"], winner, 1.0, stayed)]
    if slug == "obosligaen" and outcome.get("obosligaen_14th"):
        projection.survival_ties = {outcome["obosligaen_14th"]: (1.0, 0.0 if outcome.get("obosligaen_14th_relegated") else 1.0)}
    if outcome.get("eliteserien_14th_relegated"):
        down.add(("eliteserien", outcome["eliteserien_14th"]))
    if outcome.get("obosligaen_14th_relegated"):
        down.add(("obosligaen", outcome["obosligaen_14th"]))
    for team in projection.teams:
        if slug == "obosligaen":
            team.playoff_win = 1.0 if team.team_id == winner else 0.0
            team.promoted_via_playoff = 1.0 if team.team_id == winner and outcome.get("promoted") else 0.0
        team.relegated_via_playoff = 1.0 if (slug, team.team_id) in down else 0.0


def _base_run(
    slug: str, season: int, root: Path, by_league: dict[str, list[Match]], ratings: dict[str, float],
    ad: AttackDefence, simulation: SimulationConfig, elo_config: EloConfig, share: dict[str, SeasonProjection],
) -> SeasonProjection:
    """One league's season simulation without its play-offs (it keeps its runs for
    them), once per view: `share` holds it for the other league's report, whose
    ties are played against these runs. The two leagues' reports of a view
    take the same ratings and goals model, so each is what its own report simulates."""
    if slug not in share:
        matches = by_league[slug]
        bands = bands_for(LEAGUE_SPECS[slug], season, root)
        share[slug] = simulate_season(
            matches, ratings, ad=ad, config=simulation, elo_config=elo_config, league=slug,
            stakes_lines=stakes_lines(slug, season, matches, root),
            rival_bands=tuple((band.first, band.last) for band in bands), keep_runs=True,
        )
    return share[slug]


def _postseason(
    slug: str, season: int, root: Path, by_league: dict[str, list[Match]], ratings: dict[str, float],
    ad: AttackDefence, simulation: SimulationConfig, elo_config: EloConfig, projection: SeasonProjection,
    share: dict[str, SeasonProjection],
) -> None:
    """Play this league's post-season ties over its kept runs (or, for a finished
    season, take them as they went), writing the chances into `projection`.

    The one tie both divisions play (the OBOS-ligaen bracket winner against
    Eliteserien's 14th) is played from the two divisions' runs by the same draws
    in either report (`simulation.playoffs`): Eliteserien's relegations through
    it and OBOS-ligaen's promotions through it are the same runs. The other
    division's runs are its own report's base simulation (`share`)."""
    simulation = simulation or SimulationConfig()
    outcome = _settled_outcome(season, root, by_league)
    if outcome:
        _settle_playoffs(projection, slug, outcome)
        return
    bracket, survival = _playoff_bands(slug, season, root)
    furthest = max(bracket.last if bracket else 0, survival.first if survival else 0)
    if furthest > len(projection.club_ids):
        return  # a league too small for a play-off place plays none
    ladder = season >= LADDER_FROM
    places = lambda band: tuple(range(band.first, band.last + 1)) if band else ()
    on = max(match.date for league_matches in by_league.values() for match in league_matches)
    final = survival_opponent = None
    from_below = False
    # The play-off matches played so far go as they went in every run.
    played = playoff_matches(root).get(season, [])
    decided = _bracket_decided(played, projection, places(bracket), ladder) if bracket else ()
    for other in LEAGUE_SPECS:
        if other == slug or not by_league.get(other):
            continue
        other_bracket, other_survival = _playoff_bands(other, season, root)
        runs = _base_run(other, season, root, by_league, ratings, ad, simulation, elo_config, share)
        if bracket and other_survival:
            # Our bracket winner meets their survival place, run by run.
            final = kept_at(runs, other_survival.first)
        if survival and other_bracket:
            # Our survival place meets their bracket winner: the same tie.
            survival_opponent = bracket_winners(
                runs, places(other_bracket), ladder, ratings, ad, elo_config, on,
                decided=_bracket_decided(played, runs, places(other_bracket), ladder))
            from_below = True
    sim_ratings, sim_ad = ratings, ad
    if survival and bracket and survival_opponent is None:
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
        survival_opponent = Opponent(
            (SECOND_TIER,), np.zeros(simulation.simulations, dtype=np.intp),
            rng.normal(0.0, simulation.strength_sd, simulation.simulations),
        )
    playoffs = Playoffs(
        bracket=places(bracket), ladder=ladder, final=final,
        survival_position=survival.first if survival else None, survival=survival_opponent,
        survival_from_below=from_below, decided=decided, tie_through=playoff_tie(played)[1],
    )
    play_postseason(projection, playoffs, sim_ratings, sim_ad, elo_config, on)


# A pairing of the shared play-off tie is published from this share of the runs
# (10 of 50,000); rarer ones are noise and would only crowd the page's matrix.
MIN_TIE_PAIR = 0.0002


def _relegation_playoff_payload(
    projection: SeasonProjection, by_league: dict[str, list[Match]], settled: bool,
    bracket: list[list[tuple[str, str, float, float]]] | None = None,
    fixtures: list[dict[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """The tie between Eliteserien's 14th and OBOS-ligaen's bracket winner,
    pairing by pairing (the Explore page's matrix), and in OBOS-ligaen's report
    its 14th's survival tie against the tier below. Both divisions' reports carry
    the same pairs: they are the same runs. `bracket` is OBOS-ligaen's play-off match by
    match (from whichever division's simulation played it), each pairing with its share
    of the runs and the home side's win share; `fixtures`, the play-off's matches
    fotmob lists, played and to come (the page puts each beside its pairing).
    None where the season has no such play-off."""
    pairs = [pair for pair in projection.tie_pairs or [] if pair[2] >= MIN_TIE_PAIR]
    survival = projection.survival_ties or {}
    if not pairs and not survival:
        return None
    names = {}
    for league_matches in by_league.values():
        for match in league_matches:
            names[match.home_id or match.home] = match.home
            names[match.away_id or match.away] = match.away
    matches = [[pair for pair in match if pair[2] >= MIN_TIE_PAIR] for match in bracket or []]
    fixtures = [] if settled else (fixtures or [])
    used = ({team for top, bottom, _, _ in pairs for team in (top, bottom)} | set(survival)
            | {team for match in matches for home, away, _, _ in match for team in (home, away)}
            | {team for fixture in fixtures for team in _sides(fixture)})
    for fixture in fixtures:
        for team, name in zip(_sides(fixture), (fixture["home"], fixture["away"])):
            names.setdefault(team, name)
    return {
        "settled": settled,
        "teams": {team: names.get(team, team) for team in sorted(used)},
        "pairs": [
            {"top": top, "bottom": bottom, "p": round(share, 6), "stay": round(stay, 4)}
            for top, bottom, share, stay in sorted(pairs, key=lambda pair: -pair[2])
        ],
        **({"bracket": [
            [{"home": home, "away": away, "p": round(share, 6), "home_win": round(win, 4)}
             for home, away, share, win in sorted(match, key=lambda pair: -pair[2])]
            for match in matches
        ]} if matches and not settled else {}),
        **({"survival": [
            {"team_id": team, "p": round(share, 6), "stay": round(stay, 4)}
            for team, (share, stay) in sorted(survival.items(), key=lambda item: -item[1][0])
        ]} if survival else {}),
        **({"matches": [
            {"home": _sides(fixture)[0], "away": _sides(fixture)[1], "date": fixture["date"], "time": fixture["time"],
             "home_goals": fixture["home_goals"], "away_goals": fixture["away_goals"]}
            for fixture in fixtures
        ]} if fixtures else {}),
    }


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
# A match between two other clubs is listed for a club when its three results
# move a band the club has a real chance of by at least this much, and only the
# few that move it most (RIVAL_WATCH_SHOWN). Smaller than MIN_SWING: it is the
# club's rivals' match, so there is no decisiveness to claim, only a rooting interest.
MIN_RIVAL_SWING = 0.03
RIVAL_WATCH_SHOWN = 3


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
    2 away win), per side (0 home, 1 away), how many runs finished that
    club in each position given that outcome. Yields (team_id, band, baseline,
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
                side = 0 if is_home else 1  # the tally's club axis: home, away
                wins = branches[win_branch][side]
                losses = branches[loss_branch][side]
                n_win = sum(wins)
                n_loss = sum(losses)
                if n_win < min_branch or n_loss < min_branch:
                    continue  # branch too thin to divide into
                win_band = sum(wins[span]) / n_win
                loss_band = sum(losses[span]) / n_loss
                # The draw is only read out, never ranked on, so a thin
                # draw branch leaves out the figure rather than the fixture.
                draws = branches[1][side]
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


def _rival_watch(
    rivals: Any,
    rival_runs: Any,
    clubs: list[str],
    fixtures: list[Match],
    unconditional: dict[str, list[float]],
    bands: tuple[Band, ...],
    config: SimulationConfig | None = None,
) -> list[dict[str, Any]]:
    """Per club, the matches between *other* clubs that move a band it has a
    chance of most: the result that helps it, the one that hurts it, and its
    chance of the band after each (`SeasonProjection.rivals`).

    One entry per club and match, on the band the match moves most for it, the
    RIVAL_WATCH_SHOWN biggest swings per club, at least MIN_RIVAL_SWING. A
    match whose home-win or away-win branch is thinner than the high-stakes
    floor is left off; a thin draw only leaves the draw figure out. Relegation
    is the one band a result helps by lowering it."""
    if rivals is None or rival_runs is None or not clubs or not fixtures or not bands:
        return []
    min_branch = max(MIN_BRANCH, (config or SimulationConfig()).simulations // 100)
    names: dict[str, str] = {}
    for game in fixtures:
        names[game.home_id or game.home] = game.home
        names[game.away_id or game.away] = game.away
    result_of = ("home", "draw", "away")
    entries: list[dict[str, Any]] = []
    for club_index, team_id in enumerate(clubs):
        chances = unconditional.get(team_id) or []
        best: dict[int, dict[str, Any]] = {}
        for band_index, band in enumerate(bands):
            baseline = sum(chances[band.first - 1:band.last])
            if baseline < MIN_BAND_P:
                continue
            relegation = band.tone == "relegation"
            for fixture_index, game in enumerate(fixtures):
                home_id, away_id = game.home_id or game.home, game.away_id or game.away
                if team_id in (home_id, away_id):
                    continue  # its own matches are the stakes above
                runs = rival_runs[fixture_index]
                if runs[0] < min_branch or runs[2] < min_branch:
                    continue
                p = [rivals[fixture_index][k][club_index][band_index] / runs[k] if runs[k] >= min_branch else None
                     for k in range(3)]
                known = [(value, k) for k, value in enumerate(p) if value is not None]
                high, low = max(known), min(known)
                swing = high[0] - low[0]
                if swing < MIN_RIVAL_SWING or swing <= best.get(fixture_index, {}).get("swing", 0.0):
                    continue
                helps, hurts = (low, high) if relegation else (high, low)
                best[fixture_index] = {
                    "team_id": team_id,
                    "team": names.get(team_id, team_id),
                    "band_label": band.label,
                    "band_first": band.first,
                    "band_last": band.last,
                    "band_tone": band.tone,
                    "match_id": game.match_id,
                    "date": game.date,
                    "home_id": home_id,
                    "away_id": away_id,
                    "home": game.home,
                    "away": game.away,
                    "p_baseline": round(baseline, 4),
                    # The chance of the band after each result of the match (a thin draw: None).
                    "p_home_win": round(p[0], 4),
                    "p_draw": None if p[1] is None else round(p[1], 4),
                    "p_away_win": round(p[2], 4),
                    "helps": result_of[helps[1]],
                    "p_helps": round(helps[0], 4),
                    "hurts": result_of[hurts[1]],
                    "p_hurts": round(hurts[0], 4),
                    "swing": round(swing, 4),
                }
        entries.extend(sorted(best.values(), key=lambda entry: -entry["swing"])[:RIVAL_WATCH_SHOWN])
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
                # The mean beside the median: the what-if page adds its delta to it.
                "mean_points": round(team.mean_points, 1),
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
    from the table as it stands, for the fixtures that are both sides' next."""
    stakes = stakes or {}
    payload = []
    for match in matches:
        if match.played:
            continue
        home_id, away_id = team_ids(match)
        gap = stakes.get(match.match_id, 0.0)
        # What moved the odds beyond the ratings, in Elo points for the home side
        # (negative: for the away side); absent when it moved nothing.
        edge = surface_edge(home_id, away_id, match.date) if league == SURFACE_LEAGUE else 0.0
        moved = {key: round(value, 1) for key, value in (
            ("surface_elo", edge), ("stakes_elo", table_stakes.STAKES_ELO * gap)) if abs(value) >= 0.5}
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
                **moved,
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


def rerate_payload(
    slug: str, matches: list[Match], seeds: dict[str, TeamRating], shots: dict[str, tuple[float, ...]],
    start: AttackDefence, era: EloConfig,
) -> dict[str, Any]:
    """What the browser needs to replay one division's season with a result
    changed (the what-if page re-rates the clubs): the settings of both
    rating updates, each club's state as the season kicked off (`start`: the
    goals model after its offseason pull, Elo from `seeds`) and the played
    matches in kickoff order with their xG. `public/season-sim.js` replays
    them exactly as `career.replay` and `AttackDefence.observe` do, and a
    golden file holds the two to each other (`tests/test_rerate.py`).

    The keeping windows are the last matches' (goals let in, xG on target
    faced). A club whose reference division is another one (just promoted or
    relegated) reads that division's window as it stood at kickoff."""
    clubs = sorted({team for match in matches for team in team_ids(match)})
    cfg = start.config
    windows = {slug: [list(row) for row in start._keeping_league.get(slug, [])]}
    state = {}
    for team in clubs:
        reference = start._keeping_division.get(team, "")
        if reference and reference not in windows:
            windows[reference] = [list(row) for row in start._keeping_league.get(reference, [])]
        state[team] = {
            # A club not yet in the careers (just promoted, a new season's file)
            # starts at the ladder floor, as `build_rating_table` rates it.
            "elo": seeds[team].rating if team in seeds else rating_for_unseeded_team(),
            "attack": start.attack[team],
            "defence": start.defence[team],
            "finishing": start.finishing.get(team, 0.0),
            "keeping": [list(row) for row in start._keeping.get(team, [])],
            "reference": reference,
        }
    played = []
    for match in sorted((m for m in matches if m.played), key=Match.sort_key):
        shot = shots.get(match.match_id) or ()
        played.append([
            match.match_id, *team_ids(match), match.home_goals, match.away_goals,
            shot[0] if len(shot) >= 2 else None, shot[1] if len(shot) >= 2 else None,
            shot[2] if len(shot) >= 4 else None, shot[3] if len(shot) >= 4 else None,
        ])
    return {
        "league": slug,
        "elo": {
            "k_factor": era.k_factor, "home_advantage": era.home_advantage,
            "home_advantage_beta": era.home_advantage_beta, "xg_alpha": era.xg_alpha,
            "xg_margin": era.xg_margin, "xg_margin_smoothing": era.xg_margin_smoothing,
        },
        "ad": {
            "base": cfg.base, "home": cfg.home, "cap": cfg.cap, "k": cfg.k, "k_shots": cfg.k_shots,
            "alpha": cfg.alpha, "signal": cfg.signal, "early_boost": cfg.early_boost, "early_tau": cfg.early_tau,
            "keeping_window": cfg.keeping_window, "keeping_weight": cfg.keeping_weight,
            "league_rows": KEEPING_LEAGUE_ROWS,
        },
        "windows": windows,
        "start": state,
        "matches": played,
    }


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
    return {"seed_season": SEED_SEASON, "model": MODEL_VERSION, "teams": teams}


def h2h_payload(root: Path = NORMALIZED_DIR) -> dict[str, Any]:
    """All-time head-to-head results (`h2h.json`, which only the Compare page
    reads, so it is fetched when that page wants it, not with the careers).

    `matches` is keyed by the sorted pair of team ids, each meeting
    [date, season, home_id, away_id, home_goals, away_goals, home_name, away_name],
    the names as indexes into `names` (each club's name as the source spelled it
    that season): the same meetings as ever, without the repeated strings."""
    names: list[str] = []
    index: dict[str, int] = {}

    def name_of(name: str) -> int:
        if name not in index:
            index[name] = len(names)
            names.append(name)
        return index[name]

    matches: dict[str, list[list[Any]]] = {}
    for path in sorted(root.glob("*_matches.json")):
        found = _MATCH_FILE.match(path.name)
        if not found:
            continue
        season = int(found["season"])
        for m in load_matches(path):
            if not m.played:
                continue
            key = tuple(sorted((m.home_id, m.away_id)))
            matches.setdefault(f"{key[0]}\t{key[1]}", []).append(
                [m.date, season, m.home_id, m.away_id, m.home_goals, m.away_goals, name_of(m.home), name_of(m.away)])
    return {"names": names, "matches": matches}


def _expected_rating_change(
    config: EloConfig, expected: float, home_win: float, draw: float,
    goals: tuple[float, float] | None, calibrate: tuple[float, float],
) -> float:
    """The home side's rating change the published model expects before kickoff.

    Mirrors `elo.updated_pair`: K x (observed - expected), the observed score
    being the result at 1 - xg_alpha plus the xG part. The result part is
    taken at the published odds (P(win) + P(draw)/2); the xG part at the grid's
    expected goals, then mapped through `calibrate` (intercept, slope), which
    corrects the curvature of the xG part (its value at the mean xG is not its
    mean)."""
    result = home_win + 0.5 * draw
    if goals is None or config.xg_alpha <= 0.0:
        return config.k_factor * (result - expected)
    a, b = calibrate
    observed = (1.0 - config.xg_alpha) * result + a + b * xg_score_part(goals[0], goals[1], config)
    return config.k_factor * (observed - expected)


def _fit_line(xs: list[float], ys: list[float]) -> tuple[float, float]:
    """Least-squares (intercept, slope); (0, 1) when there is too little to fit."""
    n = len(xs)
    if n < 20:
        return 0.0, 1.0
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx <= 0.0:
        return 0.0, 1.0
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    return my - slope * mx, slope


@dataclass(frozen=True)
class MatchPerformance:
    """One scored match, from the home side: the rating change the shipped
    replay gave it, the change the published model expected before kickoff
    (`_expected_rating_change`) and the published expected points. The away
    side's changes are the negatives (the update is zero-sum)."""

    change: float
    expected: float
    home_xpts: float
    away_xpts: float

    @property
    def performance(self) -> float:
        return self.change - self.expected


@functools.cache
def match_performance(root: Path = NORMALIZED_DIR) -> dict[str, MatchPerformance]:
    """match_id -> `MatchPerformance` for every match the shipped model scored
    (both divisions, SEED_SEASON + 1 on). Read by the referee view and the
    club page's performance history; judged in PROJECT_STATUS.md, "Referee view
    metric"."""
    from elitetracker.model.backtest import shipped_cards

    slices = load_slices(root)
    seeds = {team_id: seed.rating for team_id, seed in seed_ratings(root).items()}
    shots = shot_table(root)
    values = market_values(root)
    playoffs = playoff_played(root)
    reds = red_table(root)
    goals: dict[str, tuple[float, float]] = {}
    _, shipped = shipped_cards(
        slices,
        seeds,
        score_from_season=SEED_SEASON + 1,
        shots=shots,
        values=values,
        stakes=stakes_table(root),
        playoffs=playoffs,
        goals=goals,
        reds=reds,
    )
    # Each match's rating change, Elo's own expectation and the config it was rated with.
    rated: dict[str, tuple[float, float, EloConfig]] = {}
    for season, _, ratings, matches in replay(slices, seeds, shots=shots, values=values, playoffs=playoffs):
        config = era_config(season, EloConfig())
        for match, (home_before, away_before) in matches:
            if match.match_id not in shipped.predictions:
                continue
            home_id, _ = team_ids(match)
            expected = expected_score(home_before + effective_home_advantage(config, home_before, away_before), away_before)
            rated[match.match_id] = (ratings[home_id] - home_before, expected, config)
    # The xG part at the expected goals against the xG part each match produced.
    with_xg = [mid for mid in rated if mid in shots and mid in goals]
    calibrate = _fit_line(
        [xg_score_part(*goals[mid], rated[mid][2]) for mid in with_xg],
        [xg_score_part(*model_xg(shots[mid]), rated[mid][2]) for mid in with_xg],
    )
    out: dict[str, MatchPerformance] = {}
    for mid, (change, expected, config) in rated.items():
        probs, _ = shipped.predictions[mid]
        out[mid] = MatchPerformance(
            change=change,
            expected=_expected_rating_change(
                config, expected, probs.home_win, probs.draw,
                goals.get(mid) if mid in shots else None, calibrate,
            ),
            home_xpts=3.0 * probs.home_win + probs.draw,
            away_xpts=3.0 * probs.away_win + probs.draw,
        )
    return out


def referees_payload(root: Path = NORMALIZED_DIR) -> dict[str, Any]:
    """Per-match referee, rating change against expectation, cards and fouls (`referees.json`).

    Compact row format:
    [match_id, date, season, league_idx, ref_idx, home_id, away_id,
     home_goals, away_goals, home_xpts, away_xpts,
     home_yellow, away_yellow, home_red, away_red, home_fouls, away_fouls,
     home_rating_change, home_expected_change, home_xg, away_xg].

    The changes are the home side's (`match_performance`); actual minus
    expected is the referee view's measure.
    """
    leagues = ["eliteserien", "obosligaen"]
    refs = referee_table(root)
    if not refs:
        return {"leagues": leagues, "referees": [], "teams": {}, "seasons": [], "matches": []}

    slices = load_slices(root)
    shots = shot_table(root)
    perf = match_performance(root)
    league_index = {slug: i for i, slug in enumerate(leagues)}
    played = sorted(
        ((m, s.league, s.season) for s in slices for m in s.matches
         if m.played and m.match_id in refs and m.match_id in perf),
        key=lambda item: Match.sort_key(item[0]),
    )
    ref_names = sorted({normalize_referee_name(refs[m.match_id]["referee"]) for m, _, _ in played})
    ref_index = {name: i for i, name in enumerate(ref_names)}
    teams: dict[str, str] = {}
    seasons_seen: set[int] = set()
    rows: list[list[Any]] = []
    for match, slug, season in played:
        entry = refs[match.match_id]
        ref_name = normalize_referee_name(entry["referee"])
        one = perf[match.match_id]
        xg = shots.get(match.match_id)
        home_id, away_id = team_ids(match)
        teams[home_id] = match.home
        teams[away_id] = match.away
        seasons_seen.add(season)
        yellow = entry.get("yellow") or [0, 0]
        red = entry.get("red") or [0, 0]
        fouls = entry.get("fouls")
        rows.append([
            match.match_id,
            match.date,
            season,
            league_index.get(slug, 0),
            ref_index[ref_name],
            home_id,
            away_id,
            match.home_goals,
            match.away_goals,
            round(one.home_xpts, 3),
            round(one.away_xpts, 3),
            yellow[0],
            yellow[1],
            red[0],
            red[1],
            fouls[0] if fouls else None,
            fouls[1] if fouls else None,
            round(one.change, 2),
            round(one.expected, 2),
            round(xg[0], 2) if xg else None,
            round(xg[1], 2) if xg else None,
        ])
    return {
        "leagues": leagues,
        "referees": ref_names,
        "teams": teams,
        "seasons": sorted(seasons_seen),
        "matches": rows,
    }


def performance_payload(root: Path = NORMALIZED_DIR) -> dict[str, Any]:
    """Every scored match's rating change against expectation (`performance.json`),
    which only the club page's history reads, so it is fetched when wanted.

    Compact row format, oldest first:
    [date, season, league_idx, home_id, away_id, home_goals, away_goals,
     home_rating_change, home_expected_change]; the away side's are the negatives.
    """
    leagues = ["eliteserien", "obosligaen"]
    league_index = {slug: i for i, slug in enumerate(leagues)}
    perf = match_performance(root)
    played = sorted(
        ((m, s.league, s.season) for s in load_slices(root) for m in s.matches if m.played and m.match_id in perf),
        key=lambda item: Match.sort_key(item[0]),
    )
    teams: dict[str, str] = {}
    rows: list[list[Any]] = []
    for match, slug, season in played:
        one = perf[match.match_id]
        home_id, away_id = team_ids(match)
        teams[home_id] = match.home
        teams[away_id] = match.away
        rows.append([
            match.date, season, league_index.get(slug, 0), home_id, away_id,
            match.home_goals, match.away_goals, round(one.change, 1), round(one.expected, 1),
        ])
    return {"leagues": leagues, "teams": teams, "matches": rows}


