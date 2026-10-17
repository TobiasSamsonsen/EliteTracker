"""Monte Carlo simulation of the remaining season.

Every unplayed match is sampled from its win/draw/loss probabilities, points are
accumulated on top of the live table, and the resulting order is recorded. Doing
that many times gives each team a distribution over finishing positions.

Runs use a seeded random number generator, so the same inputs and seed always
produce the same matrix. No network access is involved.

Two deliberate simplifications, both documented rather than hidden:

* Ratings are not updated inside a simulation: a team does not get stronger
  by winning simulated matches. What each run does draw is one strength shock
  per club, held for the rest of that run (`STRENGTH_SD`), because today's
  rating is an estimate and a club's true level drifts over a season. Without
  it every run replays the same strengths and the finishing odds come out too
  sure of themselves.
* Who wins comes from the Elo odds; how many goals from the two sides' attack
  and defence ratings (`model.attack_defence`), conditioned on that outcome.
  So goal difference moves within a simulation and tied finishes resolve on
  simulated goal difference, not today's, and a fixture between two free-scoring
  sides is simulated as one.

The run-in's table stakes (`model.stakes`) are read from each run's own
table: a fixture in it is decided once that run's results before its date
are in, at the odds its two sides' pressure in that run gives.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from elitetracker.model.attack_defence import GOAL_CAP, AttackDefence, gap_blend_weight
from elitetracker.model.elo import EloConfig, effective_home_advantage, _RATING_SCALE
from elitetracker.model.probabilities import match_probabilities
from elitetracker.model.stakes import STAKES_ELO, STAKES_FROM, STAKES_GOALS, run_pressures
from elitetracker.model.table import TableRow, table_from_matches
from elitetracker.normalize.matches import Match
from elitetracker.normalize.standings import POINTS_FOR_DRAW, POINTS_FOR_WIN
from elitetracker.normalize.surfaces import surface_edge
from elitetracker.simulation.playoffs import Knockout, Opponent, Playoffs, PlayoffTally

# Chosen by measurement, not taste. Monte Carlo error falls as 1/sqrt(N), and
# the point of diminishing returns is set by the model's own accuracy: elo-v3
# has a calibration error of 1.54 percentage points, so sampling error well
# under a fifth of that is already invisible.
#
# Measured against a 4,000,000-run reference, worst single cell in the grid
# (times from the pure-Python loop this replaced; NumPy runs them about 5x
# faster, which leaves the trade-off where it was):
#
#      10,000   1.31 pp    0.07 s per league
#      50,000   0.50 pp    0.37 s     <- here
#     200,000   0.23 pp    1.43 s
#   1,000,000   0.11 pp    7.2  s
#  10,000,000   0.04 pp   72    s
#
# 50,000 keeps the worst cell at a third of the model's error while the page
# still shows whole percent, where 0.5pp is half a displayed digit. Going
# further buys precision beneath both the display and the model.
DEFAULT_SIMULATIONS = 50_000
DEFAULT_SEED = 20260809
# Runs drawn per batch of arrays (see simulate_season).
SIMULATION_CHUNK = 1_000

# Per-run strength shock, in log-odds of home win against away win: a club
# drawn +0.15 has every remaining fixture's win odds multiplied by exp(0.15)
# (1.16x) against its loss odds, draws renormalised. Fitted by backtest on the
# finished seasons 2016-2025, both divisions, simulating from the start, a
# quarter, half and three quarters in and scoring the final table (t clustered
# by season-league, 20 clusters):
#
#     sd     RPS over positions      log loss of the actual position
#     0.10   -0.00049 (t -3.0)       -0.0113 (t -2.9)
#     0.15   -0.00084 (t -2.7)       -0.0183 (t -3.0)
#     0.20   -0.00105 (t -2.3)       -0.0205 (t -2.3)
#     0.25   -0.00098 (t -1.6)       -0.0178 (t -1.6)
#
# Negative on both halves (2016-2020, 2021-2025) and in both divisions; 0.15
# is the middle of the basin. The shock does not touch single-match odds.
#
# Re-fit for elo-v13.0 the same way (10,000 runs; against sd 0.15 on the same
# model, which the correctly signed xG margin had made slightly over-sure:
# log loss of the place +0.0015, t +2.8, with no shock change):
#
#     sd     RPS over positions      log loss of the actual position
#     0.20   -0.00051 (t -3.2)       -0.0125 (t -2.6)
#     0.25   -0.00077 (t -2.4)       -0.0177 (t -2.2)
#     0.30   -0.00071 (t -1.5)       -0.0127 (t -1.2)
#
# 0.20 already beat 0.15 on elo-v12.2 with the seasons since (RPS t -2.6), so
# part of the move is the data. Against elo-v12.2 as shipped (sd 0.15), the
# whole of elo-v13.0 is RPS -0.00097 (t -2.5), log loss -0.0098 (t -2.6),
# negative in both halves and both divisions. 0.20 is the shrunk value.
#
# Re-checked on elo-v16.0 (the unclamped margin spreads the ratings again):
# 0.225 / 0.25 against 0.20, RPS -0.00016 (t -1.90) / -0.00026 (t -1.56), but
# walk-forward over 0.15-0.30 the pick wanders and 2019-2021 come out worse
# (RPS +0.00010), so 0.20 stays (experiments/improvements/season_sd_oos.py).
STRENGTH_SD = 0.20


@dataclass(frozen=True)
class SimulationConfig:
    simulations: int = DEFAULT_SIMULATIONS
    seed: int = DEFAULT_SEED
    strength_sd: float = STRENGTH_SD


@dataclass
class TeamProjection:
    team_id: str
    team: str
    rating: float
    current_position: int
    current_points: int
    current_goal_difference: int
    played: int
    # position_probabilities[0] is the chance of finishing 1st.
    position_probabilities: list[float]
    expected_points: float
    # Season totals averaged over the runs: goals already scored plus the
    # simulated scorelines of the remaining fixtures.
    expected_goals_for: float = 0.0
    expected_goals_against: float = 0.0
    # With play-offs (`simulation.playoffs`): the chance of winning the
    # promotion bracket, of going up through its final, and of going down
    # through the survival tie.
    playoff_win: float = 0.0
    promoted_via_playoff: float = 0.0
    relegated_via_playoff: float = 0.0


@dataclass
class SeasonProjection:
    teams: list[TeamProjection]
    simulations: int
    seed: int
    matches_remaining: int
    matches_played: int
    # position_points[0] is the median points of the team finishing 1st.
    position_points: list[int] | None = None
    strength_sd: float = 0.0
    # conditionals[fixture][outcome][club][position] counts the runs in which that
    # club finished in that position *given* that fixture came out that way
    # (0 home win, 1 draw, 2 away win). Index order matches `_fixtures`, so
    # fixture i here is the i-th unplayed match in `matches`.
    conditionals: list[list[list[list[int]]]] | None = None
    # Run by run, for the other division's play-off tie: the bracket winner
    # (with a bracket) and the club at `keep_position`, each with its shock.
    bracket_winners: Opponent | None = None
    kept: Opponent | None = None


# The score grid's cells, row-major (home goals i, away goals j), split by the
# result each one is: the same 36 home wins, 9 draws and 36 away wins for every
# fixture, so every fixture's three scoreline tables have the same lengths.
_CELLS = [(i, j) for i in range(GOAL_CAP + 1) for j in range(GOAL_CAP + 1)]
_BY_OUTCOME = [
    np.array([k for k, (i, j) in enumerate(_CELLS) if keep(i, j)])
    for keep in (lambda i, j: i > j, lambda i, j: i == j, lambda i, j: i < j)
]
# One width for every table (the 9 draws padded with scorelines of chance 0,
# which an alias table never keeps), and each table's scorelines in order.
TABLE_WIDTH = max(len(cells) for cells in _BY_OUTCOME)
SCORELINE_TABLES = np.zeros((3, TABLE_WIDTH, 2))
for _code, _cells in enumerate(_BY_OUTCOME):
    SCORELINE_TABLES[_code, :len(_cells)] = [_CELLS[k] for k in _cells]
_FACTORIAL = np.array([math.factorial(n) for n in range(GOAL_CAP + 1)], dtype=float)
# The pressure differences a run-in fixture's odds are worked out at; a run's
# odds are interpolated between them (the odds are smooth in it).
STAKES_GAPS = np.linspace(-1.0, 1.0, 21)


@dataclass
class Fixtures:
    """Everything the simulation needs per unplayed fixture, as arrays.

    Each fixture has a scoreline table per result (home win, draw, away win):
    `chances[fixture, outcome, column]` is the chance of the scoreline in
    `SCORELINE_TABLES[outcome, column]` given that result. `accept` and
    `alias` are the same tables as alias tables (Walker's method), flat by
    (fixture * 3 + outcome) * TABLE_WIDTH + column: a draw lands on a column
    uniformly, keeps it with chance `accept`, and otherwise takes the
    column's `alias`, so a scoreline costs two lookups instead of a search."""
    home: np.ndarray
    away: np.ndarray
    home_win: np.ndarray
    home_or_draw: np.ndarray
    chances: np.ndarray
    accept: np.ndarray
    alias: np.ndarray
    # The run-in (`model.stakes`): each fixture's date (as an index), the
    # fixtures in the run-in, and for each of those its home-win and
    # home-or-draw odds at every STAKES_GAPS value.
    day: np.ndarray | None = None
    stakes: np.ndarray | None = None
    stakes_home_win: np.ndarray | None = None
    stakes_home_or_draw: np.ndarray | None = None

    def __len__(self) -> int:
        return len(self.home)


def _score_grids(lam: np.ndarray, mu: np.ndarray, rho: float) -> np.ndarray:
    """score_grid for every row of `lam` and `mu` at once, flattened to
    (rows, cells): Poisson for each side, the Dixon-Coles correction on the
    four low scores (clipped at zero), renormalised."""
    count = len(lam)
    lam = lam.reshape(count, 1)
    mu = mu.reshape(count, 1)
    goals = np.arange(GOAL_CAP + 1)
    grid = (np.exp(-lam) * lam ** goals / _FACTORIAL)[:, :, None] * (np.exp(-mu) * mu ** goals / _FACTORIAL)[:, None, :]
    lam, mu = lam[:, 0], mu[:, 0]
    grid[:, 0, 0] *= np.maximum(1.0 - lam * mu * rho, 0.0)
    grid[:, 0, 1] *= np.maximum(1.0 + lam * rho, 0.0)
    grid[:, 1, 0] *= np.maximum(1.0 + mu * rho, 0.0)
    grid[:, 1, 1] *= max(1.0 - rho, 0.0)
    grid = grid.reshape(count, (GOAL_CAP + 1) ** 2)
    return grid / grid.sum(axis=1, keepdims=True)


def _blended(grid: np.ndarray, elo: np.ndarray, weight: np.ndarray | None) -> tuple[np.ndarray, np.ndarray]:
    """(the grid's own result odds, the outcome odds): blend_outcomes, a
    geometric blend with the Elo odds, or the Elo odds alone (no weight)."""
    own = np.stack([grid[:, cells].sum(axis=1) for cells in _BY_OUTCOME], axis=1)
    if weight is None:
        return own, elo
    odds = elo ** weight * own ** (1.0 - weight)
    return own, odds / odds.sum(axis=1, keepdims=True)


def _fixtures(
    matches: list[Match], ratings: dict[str, float], index_of: dict[str, int], config: EloConfig,
    ad: AttackDefence, blend: bool = True, surface: bool = False, played: np.ndarray | None = None,
    stakes: bool = False,
) -> Fixtures:
    """Every unplayed fixture's outcome odds and scoreline tables, computed
    once and all together: the scoring grids of `model.attack_defence`
    (score_grid, blend_outcomes, conditional_scorelines) as arrays, one row
    per fixture, rather than a Python grid each. With `surface` (Eliteserien)
    each fixture's Elo odds carry the surface edge (`normalize.surfaces`).
    With `stakes`, the fixtures both of whose sides will have played
    STAKES_FROM by their date (`played`: each club's count today) also get
    their odds at every STAKES_GAPS value, for the run-in (`model.stakes`)."""
    unplayed = [match for match in matches if not match.played]
    home, away, lam, mu, elo, weight, rated = [], [], [], [], [], [], []
    for match in unplayed:
        home_id = match.home_id or match.home
        away_id = match.away_id or match.away
        home_rating = ratings[home_id] + (surface_edge(home_id, away_id, match.date) if surface else 0.0)
        gap = (home_rating + effective_home_advantage(config, home_rating, ratings[away_id]) - ratings[away_id]) / _RATING_SCALE
        rates = ad.rates(home_id, away_id, match.date, elo_gap=gap)
        odds = match_probabilities(home_rating, ratings[away_id], config)
        home.append(index_of[home_id])
        away.append(index_of[away_id])
        lam.append(rates[0])
        mu.append(rates[1])
        elo.append((odds.home_win, odds.draw, odds.away_win))
        weight.append(gap_blend_weight(gap, ad.config.blend_gamma))
        rated.append((home_rating, ratings[away_id]))
    count = len(unplayed)
    lam = np.array(lam, dtype=float)
    mu = np.array(mu, dtype=float)
    weight = np.array(weight, dtype=float).reshape(count, 1)
    grid = _score_grids(lam, mu, ad.config.rho)
    own, odds = _blended(grid, np.array(elo, dtype=float).reshape(count, 3), weight if blend else None)
    days = {date: index for index, date in enumerate(sorted({match.date for match in unplayed}))}
    day = np.array([days[match.date] for match in unplayed], dtype=np.intp)
    run_in = np.zeros(0, dtype=np.intp)
    stakes_home_win = stakes_home_or_draw = None
    if stakes and count:
        # Each side's matches by a fixture's date: today's, plus its unplayed
        # fixtures dated before it.
        home_at, away_at = np.array(home, dtype=np.intp), np.array(away, dtype=np.intp)
        by_then = np.empty((count, 2), dtype=np.int64)
        for f in range(count):
            before = day < day[f]
            done = played + np.bincount(home_at[before], minlength=len(played)) \
                + np.bincount(away_at[before], minlength=len(played))
            by_then[f] = done[home_at[f]], done[away_at[f]]
        run_in = np.nonzero(by_then.min(axis=1) >= STAKES_FROM)[0]
        if len(run_in):
            gaps = np.tile(STAKES_GAPS, len(run_in))
            rows = np.repeat(run_in, len(STAKES_GAPS))
            shifted = [match_probabilities(rated[f][0] + STAKES_ELO * g, rated[f][1], config) for f, g in zip(rows, gaps)]
            shifted_elo = np.array([(p.home_win, p.draw, p.away_win) for p in shifted], dtype=float)
            _, shifted_odds = _blended(
                _score_grids(lam[rows] * np.exp(STAKES_GOALS * gaps), mu[rows] * np.exp(-STAKES_GOALS * gaps),
                             ad.config.rho),
                shifted_elo, weight[rows] if blend else None)
            shape = (len(run_in), len(STAKES_GAPS))
            stakes_home_win = shifted_odds[:, 0].reshape(shape)
            stakes_home_or_draw = (shifted_odds[:, 0] + shifted_odds[:, 1]).reshape(shape)
    # conditional_scorelines then the per-outcome tables: within an outcome the
    # cells keep the grid's own proportions, so each table is the grid's cells
    # of that result over their total (an outcome the grid gives no mass, which
    # Poisson cells never quite are, falls back to its last scoreline).
    chances = np.zeros((count, 3, TABLE_WIDTH))
    for code, cells in enumerate(_BY_OUTCOME):
        total = own[:, code:code + 1]
        chances[:, code, :len(cells)] = grid[:, cells] / np.where(total > 0, total, 1.0)
        chances[total[:, 0] <= 0, code, len(cells) - 1] = 1.0
    accept, alias = _alias_tables(chances.reshape(count * 3, TABLE_WIDTH))
    return Fixtures(
        home=np.array(home, dtype=np.intp),
        away=np.array(away, dtype=np.intp),
        home_win=odds[:, 0].copy(),
        home_or_draw=odds[:, 0] + odds[:, 1],
        chances=chances,
        accept=accept.ravel(),
        alias=alias.ravel(),
        day=day,
        stakes=run_in,
        stakes_home_win=stakes_home_win,
        stakes_home_or_draw=stakes_home_or_draw,
    )


def _alias_tables(chances: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Walker alias tables for every row of `chances` at once (rows sum to 1).

    Robin Hood pairing, in lockstep across the rows: each round closes the
    smallest open column of every row, keeping its own scaled chance and
    handing the rest of its slot to the row's largest open column. A column
    of chance 0 always hands over, so padding is never drawn."""
    rows, width = chances.shape
    scaled = chances * width
    accept = np.ones((rows, width))
    alias = np.tile(np.arange(width), (rows, 1))
    open_ = np.ones((rows, width), dtype=bool)
    every = np.arange(rows)
    for _ in range(width - 1):
        small = np.argmin(np.where(open_, scaled, np.inf), axis=1)
        large = np.argmax(np.where(open_, scaled, -np.inf), axis=1)
        accept[every, small] = scaled[every, small]
        alias[every, small] = large
        scaled[every, large] -= 1.0 - scaled[every, small]
        open_[every, small] = False
    return accept, alias


def simulate_season(
    matches: list[Match],
    ratings: dict[str, float],
    *,
    ad: AttackDefence | None = None,
    config: SimulationConfig | None = None,
    elo_config: EloConfig | None = None,
    tally_conditionals: bool = True,
    playoffs: Playoffs | None = None,
    keep_position: int | None = None,
    surface: bool = False,
    stakes_lines: tuple[int, ...] = (),
) -> SeasonProjection:
    """`ad` is the attack/defence state as of the matches given; the outcome odds
    are its blend with the Elo odds. Without one every club is an average side,
    the Elo odds stand alone and only shape the scorelines. With
    `tally_conditionals` off the per-fixture branch tallies (`conditionals`,
    for the high-stakes swings) are skipped and left None: a fifth of the work,
    which the season-shape snapshots never read.

    `playoffs` plays the post-season ties in every run, on a random stream of
    their own, so the finishing chances are the same with them as without;
    `keep_position` records that place's club and shock per run, for the
    division whose play-off it meets. `surface` (Eliteserien) adds the
    surface edge to its fixtures' odds; the play-off ties go without.
    `stakes_lines` (`pipeline.stakes_lines`) switches on the run-in's table
    stakes, each run's from its own table; the play-off ties go without."""
    config = config or SimulationConfig()
    elo_config = elo_config or EloConfig()
    blend = ad is not None
    ad = ad or AttackDefence()

    current: list[TableRow] = table_from_matches(matches)
    positions = {row.team_id: index + 1 for index, row in enumerate(current)}
    by_id = {row.team_id: row for row in current}
    team_ids = list(by_id)

    missing = [team_id for team_id in team_ids if team_id not in ratings]
    if missing:
        raise KeyError(f"no rating for {missing}")

    # Runs are drawn a chunk at a time as arrays -- runs down, fixtures or
    # clubs across -- rather than one run at a time in Python: the same draws
    # and the same arithmetic per run, about 30x the throughput. A chunk keeps
    # each array to a few megabytes whatever the run count.
    count = len(team_ids)
    index_of = {team_id: index for index, team_id in enumerate(team_ids)}
    rows = [by_id[team_id] for team_id in team_ids]
    cuts = tuple(b for b in stakes_lines if b < count)
    played_now = np.array([row.played for row in rows], dtype=np.int64)
    fixtures = _fixtures(matches, ratings, index_of, elo_config, ad, blend, surface, played_now, bool(cuts))
    fixture_count = len(fixtures)
    home, away = fixtures.home, fixtures.away
    home_chance, home_or_draw_chance = fixtures.home_win, fixtures.home_or_draw
    # Fixture -> club incidence, so a chunk's per-fixture points and goals
    # become per-club totals with one matrix product each. Floats, which the
    # product runs on BLAS for (integer products do not, and were half the
    # time); the sums are small whole numbers, so they come back exact.
    at_home = np.zeros((fixture_count, count))
    at_home[np.arange(fixture_count), home] = 1.0
    away_side = np.zeros((fixture_count, count))
    away_side[np.arange(fixture_count), away] = 1.0
    to_clubs = lambda per_fixture, incidence: np.rint(per_fixture @ incidence).astype(np.int64)
    accept, alias = fixtures.accept, fixtures.alias
    scoreline_tables = SCORELINE_TABLES.reshape(3 * TABLE_WIDTH, 2)
    home_points = np.array([POINTS_FOR_WIN, POINTS_FOR_DRAW, 0], dtype=float)
    away_points = np.array([0, POINTS_FOR_DRAW, POINTS_FOR_WIN], dtype=float)
    base_points = np.array([row.points for row in rows], dtype=np.int64)
    base_goals_for = np.array([row.goals_for for row in rows], dtype=np.int64)
    base_goals_against = np.array([row.goals_against for row in rows], dtype=np.int64)

    # Clubs level on simulated points are separated on simulated goal
    # difference, then simulated goals scored. Both accrue from the scorelines
    # drawn below, so the tiebreak is the finish as simulated -- not today's
    # table, which already has this season's points baked into it.
    #
    # The sort key packs points | goal_difference | goals_for | index into one
    # integer, best first. Goal difference is signed, so it is shifted by a
    # fixed offset before packing; the constants below comfortably cover a full
    # season (current GD plus at most 8 * remaining matches either way).
    goals_width = 10  # 1024 slots: covers GD +/- ~500 and goals_for up to ~1000
    offset_gd = 1 << (goals_width - 1)  # 512, keeps signed GD inside [0, 1024)
    index_width = count.bit_length()
    club_index = np.arange(count, dtype=np.int64)

    # Tallies. counts[club][position]; conditionals[fixture][outcome][club]
    # [position] counts the runs in which that club finished there *given*
    # that fixture came out that way (the high-stakes swings); position_hist
    # [position][points] gives the median points per finishing position, which
    # the frontend states as a band's threshold.
    counts = np.zeros(count * count, dtype=np.int64)
    points_total = np.zeros(count, dtype=np.int64)
    goals_for_total = np.zeros(count, dtype=np.int64)
    goals_against_total = np.zeros(count, dtype=np.int64)
    max_points = int(base_points.max(initial=0)) + 3 * fixture_count
    position_hist = np.zeros(count * (max_points + 1), dtype=np.int64)
    conditionals = np.zeros(fixture_count * 3 * count * count if tally_conditionals else 0, dtype=np.int64)
    fixture_slot = np.arange(fixture_count, dtype=np.int64) * 3

    # The run-in, by date: its fixtures, their rows in the stakes odds, each
    # club's matches left on that date, and how many fixtures (in date order)
    # come before it. Each run's table is built up once per chunk, a date's
    # block of fixtures at a time.
    by_day = np.argsort(fixtures.day, kind="stable")
    sorted_days = fixtures.day[by_day]
    run_in_days = []
    rounds = 2 * (count - 1)
    for date in sorted(set(fixtures.day[fixtures.stakes].tolist())):
        rows_in = np.nonzero(fixtures.day[fixtures.stakes] == date)[0]
        before = fixtures.day < date
        done = played_now + np.bincount(home[before], minlength=count) + np.bincount(away[before], minlength=count)
        members = fixtures.stakes[rows_in]
        # The clubs playing that day, and where each fixture's two sides sit among them.
        clubs = np.unique(np.concatenate([home[members], away[members]]))
        run_in_days.append((members, rows_in, rounds - done, int(np.searchsorted(sorted_days, date)), clubs,
                            np.searchsorted(clubs, home[members]), np.searchsorted(clubs, away[members])))
    gap_step = STAKES_GAPS[1] - STAKES_GAPS[0]

    rng = np.random.default_rng(config.seed)
    strength_sd = config.strength_sd
    knockout = tally = None
    # A league too small for a play-off place (test fixtures) plays none.
    if playoffs is not None and max((*playoffs.bracket, playoffs.survival_position or 0), default=0) > count:
        playoffs = None
    if keep_position is not None and keep_position > count:
        keep_position = None
    if playoffs is not None:
        knockout = Knockout(playoffs, team_ids, ratings, ad, elo_config, max(match.date for match in matches),
                            blend, np.random.default_rng([config.seed, 1]))
        tally = PlayoffTally(*(np.zeros(count, dtype=np.int64) for _ in range(3)), [], [])
    kept_club: list[np.ndarray] = []
    kept_shock: list[np.ndarray] = []
    done = 0
    while done < config.simulations:
        runs = min(SIMULATION_CHUNK, config.simulations - done)
        done += runs
        home_win = np.broadcast_to(home_chance, (runs, fixture_count))
        home_or_draw = np.broadcast_to(home_or_draw_chance, (runs, fixture_count))
        shock = np.zeros((runs, count))
        if strength_sd:
            # exp(shock) per club: a fixture's win odds scale by boost[home] /
            # boost[away], its loss odds by the inverse, and the three renormalise.
            shock = rng.normal(0.0, strength_sd, (runs, count))
            boost = np.exp(shock)
            ratio = boost[:, home] / boost[:, away]
            home_weight = home_win * ratio
            draw_weight = home_or_draw - home_win
            total = home_weight + draw_weight + (1.0 - home_or_draw) / ratio
            home_win = home_weight / total
            home_or_draw = (home_weight + draw_weight) / total
        roll = rng.random((runs, fixture_count))
        # 0 home win, 1 draw, 2 away win.
        outcome = (roll >= home_win).astype(np.int64) + (roll >= home_or_draw)
        if run_in_days:
            # The run-in, a date at a time, at the odds each run's own table
            # gives it (the same rolls; every fixture before it decided).
            # int32: the pressure's arithmetic runs twice as fast as on int64.
            table_points = np.tile(base_points.astype(np.int32), (runs, 1))
            walked = 0
            for members, rows_in, left, upto, clubs, home_at, away_at in run_in_days:
                if upto > walked:
                    block = by_day[walked:upto]
                    table_points += to_clubs(home_points[outcome[:, block]], at_home[block]) \
                        + to_clubs(away_points[outcome[:, block]], away_side[block])
                    walked = upto
                pressure = run_pressures(table_points, left, cuts, clubs)
                gap = pressure[:, home_at] - pressure[:, away_at]
                # Linear interpolation between the odds at STAKES_GAPS.
                position = (gap - STAKES_GAPS[0]) / gap_step
                below = np.minimum(position.astype(np.intp), len(STAKES_GAPS) - 2)
                share = position - below
                column = np.arange(len(members))
                tables = (fixtures.stakes_home_win[rows_in], fixtures.stakes_home_or_draw[rows_in])
                win, win_or_draw = (table[column, below] + share * (table[column, below + 1] - table[column, below])
                                    for table in tables)
                if strength_sd:
                    weighted = win * ratio[:, members]
                    total = weighted + (win_or_draw - win) + (1.0 - win_or_draw) / ratio[:, members]
                    win, win_or_draw = weighted / total, (weighted + win_or_draw - win) / total
                outcome[:, members] = (roll[:, members] >= win).astype(np.int64) + (roll[:, members] >= win_or_draw)
        # The scoreline, from the fixture's alias table for that outcome: the
        # draw's whole part picks a column, its fraction keeps it or takes the
        # alias.
        slot = rng.random((runs, fixture_count)) * TABLE_WIDTH
        column = slot.astype(np.int64)
        table = (fixture_slot + outcome) * TABLE_WIDTH
        column = np.where(slot - column < accept[table + column], column, alias[table + column])
        home_goals = scoreline_tables[outcome * TABLE_WIDTH + column, 0]
        away_goals = scoreline_tables[outcome * TABLE_WIDTH + column, 1]

        points = base_points + to_clubs(home_points[outcome], at_home) + to_clubs(away_points[outcome], away_side)
        goals_for = base_goals_for + to_clubs(home_goals, at_home) + to_clubs(away_goals, away_side)
        goals_against = base_goals_against + to_clubs(away_goals, at_home) + to_clubs(home_goals, away_side)
        packed = (
            ((points << goals_width) + (goals_for - goals_against + offset_gd)) << goals_width
        ) + goals_for
        packed = (packed << index_width) + club_index
        order = np.argsort(-packed, axis=1)  # club per finishing position, best first
        position = np.empty_like(order)
        position[np.arange(runs)[:, None], order] = club_index

        if knockout is not None:
            knockout.play(order, shock, done - runs, tally)
        if keep_position is not None:
            kept_club.append(order[:, keep_position - 1])
            kept_shock.append(shock[np.arange(runs), order[:, keep_position - 1]])
        counts += np.bincount((club_index * count + position).ravel(), minlength=count * count)
        points_total += points.sum(axis=0)
        goals_for_total += goals_for.sum(axis=0)
        goals_against_total += goals_against.sum(axis=0)
        position_hist += np.bincount((position * (max_points + 1) + points).ravel(), minlength=position_hist.size)
        if tally_conditionals:
            branch = (fixture_slot + outcome) * count
            for side in (home, away):
                cells = (branch + side) * count + position[:, side]
                conditionals += np.bincount(cells.ravel(), minlength=conditionals.size)

    counts = counts.reshape(count, count)
    if tally_conditionals:
        conditionals = conditionals.reshape(fixture_count, 3, count, count)
        # Each run leaves a fixture's two clubs in exactly one outcome branch,
        # so per club the three branches must sum to the run count.
        for fixture_index in range(fixture_count):
            for club in (home[fixture_index], away[fixture_index]):
                assert conditionals[fixture_index, :, club].sum() == config.simulations, (
                    f"branch tally mismatch at fixture {fixture_index}"
                )

    halfway = (config.simulations + 1) // 2
    position_points = [
        int(np.searchsorted(np.cumsum(hist), halfway))
        for hist in position_hist.reshape(count, max_points + 1)
    ]

    simulations = config.simulations
    projections = [
        TeamProjection(
            team_id=team_id,
            team=rows[index].team,
            rating=ratings[team_id],
            current_position=positions[team_id],
            current_points=rows[index].points,
            current_goal_difference=rows[index].goal_difference,
            played=rows[index].played,
            position_probabilities=(counts[index] / simulations).tolist(),
            expected_points=float(points_total[index] / simulations),
            expected_goals_for=float(goals_for_total[index] / simulations),
            expected_goals_against=float(goals_against_total[index] / simulations),
            **({} if tally is None else {
                "playoff_win": float(tally.bracket_wins[index] / simulations),
                "promoted_via_playoff": float(tally.promoted[index] / simulations),
                "relegated_via_playoff": float(tally.relegated[index] / simulations),
            }),
        )
        for index, team_id in enumerate(team_ids)
    ]
    projections.sort(key=lambda projection: (-projection.expected_points, projection.team))

    return SeasonProjection(
        teams=projections,
        simulations=simulations,
        seed=config.seed,
        matches_remaining=len(fixtures),
        matches_played=sum(1 for match in matches if match.played),
        position_points=position_points,
        strength_sd=strength_sd,
        conditionals=conditionals.tolist() if tally_conditionals else None,
        bracket_winners=Opponent(tuple(team_ids), np.concatenate(tally.winner_club), np.concatenate(tally.winner_shock))
        if tally is not None and tally.winner_club else None,
        kept=Opponent(tuple(team_ids), np.concatenate(kept_club), np.concatenate(kept_shock)) if kept_club else None,
    )
