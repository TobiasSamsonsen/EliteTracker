"""The ELO rating system: expectation, outcome, and rating updates.

Kept deliberately plain. The three steps are separate functions so each can be
tested on its own and so a later model can reuse the pieces it still agrees
with. Any change to how ratings are produced must bump MODEL_VERSION.

Defaults are fitted by walk-forward backtest over every season held (see
`model.backtest`), not by eyeballing one season:

* HOME_ADVANTAGE 60. The marginal 2026 home edge of 0.61 implies ~75, but a
  full-season sweep prefers 60: against the 0.61-implied value it is worth
  ~0.001 log loss on both the 2016+ and 2019+ windows (K is flat across 18-24,
  so K stays at 20). The full-season prediction is the more honest target.
* SEASON_REGRESSION 0.88. At each close season every rating is pulled 12% toward
  its own division's mean, so a club does not carry one freak year into the next
  and the Eliteserien/OBOS gap is preserved. Re-fit by walk-forward backtest on
  the per-division scheme (the 0.95 figure was fit on the old combined-pool
  pull).
* The draw model was originally set from 255 matches of a single part-season,
  which made it far too narrow. Refitting over 5,543 replayed matches moved it
  to 0.26/375 and cut the calibration error by more than half. That is the
  whole of elo-v3.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# Bump on any change that alters produced ratings or probabilities.
#
# elo-v2: ratings are no longer seeded from the previous season's table each
# year. They are seeded once, from the 2014 final tables, and every played
# match from 2015 onward is replayed in order, so a club carries its rating
# across seasons and across divisions.
#
# elo-v3: the draw model is refitted. Ratings are byte-identical to elo-v2 --
# only the mapping from a rating gap to win/draw/loss probabilities changes.
#
# elo-v4: player availability (injuries/suspensions/transfers) -- investigated
# by full backtest and rejected; see PROJECT_STATUS.md. Never shipped.
#
# elo-v5: home advantage refit 75 -> 60 and cross-season regression (5% toward
# the pool mean each close season) added. Both fitted by walk-forward backtest;
# ratings and therefore every probability change.
#
# elo-v6: offseason regression is now applied per division (each team pulled
# toward its own division's mean, not the combined pool mean), which stops the
# inter-division gap being compressed every close season; the seed ladder
# (spread + division offset) and the regression factor were jointly re-fit by
# walk-forward backtest on the per-division scheme. Ratings and therefore every
# probability change.
#
# elo-v7: an online attack/defence goals model (model/attack_defence.py) joins
# the Elo replay. It updates on xG where fotmob has it (Eliteserien from 2020),
# with a faster step for those matches. Outcome odds are a 50/50 geometric blend
# of the Elo odds and the goals model's own; scorelines come from its Poisson
# grid conditioned on those odds, replacing the gap-binned empirical table.
# Ratings and careers (the displayed ladder) are unchanged; odds, scorelines and
# the finishing-position matrix are not.
#
# elo-v8: xG-informed Elo ratings. The rating update's "actual" score blends
# the binary match result with an xG-implied expected score (the Poisson
# expectation under the two sides' expected goals). alpha=0.45 means 45% weight
# on the xG signal, 55% on the result; a lucky win moves ratings less than a
# deserved one. Fitted walk-forward on 2021-2026 (Eliteserien, where fotmob has
# xG): alpha=0.45, K=20 beats plain Elo by -0.00235 log loss (t=-2.58). Stacked
# on elo-v7's attack/defence blend the combined model reaches -0.00580 vs plain
# Elo (t=-3.38). The ratings themselves now carry the xG signal; the attack/
# defences layer still adds its own on top for odds and scorelines.
#
# elo-v9: season-level finishing quality in the attack/defence model. Each
# team's log(total goals / total xG) over a full season is stored and carried
# into the next season with regression (0.70 toward the mean).  Match-level
# goals/xG was too noisy to be useful (every config made things worse); the
# season-level signal is clean and persistent (r=0.533 odd/even).  Improves
# predictions modestly: -0.00039 log loss vs no finishing (t=-1.04) and
# -0.00243 vs Elo-only (t=-1.82).  The effect is strongest in the first
# season with xG data (2021: d=-0.00320, t=-1.70); after that the attack/
# defence model captures the signal through the blended observation.
#
# elo-v10: era-switched Elo.  Warmup years (all seasons before 2022) use the
# legacy config (K=20, xg_alpha=0.45); from 2022 a faster, more xG-responsive
# config (K=35, xg_alpha=0.50) takes over.  (This was written as an
# Eliteserien-only switch, but the code has always switched both divisions
# together, and elo-v11 measured that as the better of the two.)
# Fitted walk-forward on Eliteserien 2022+: era-switch K=35 a=0.50 beats
# shipped K=20 a=0.45 by -0.00400 log loss (train t=-2.62); holdout
# 2025-2026 delta=-0.00551 (t=-1.66, directionally right but not yet
# significant at |t|>=2).  Regression, draw model, home advantage unchanged.
# elo-v11: expected goals for OBOS-ligaen.  fotmob has no shotmap for the
# second division, so every OBOS match was rated on goals alone; Sofascore has
# xG for it from 2023, and 876 matches of it are now in data/xg.json.  Both
# xG-driven parts of the model switch on for those matches: the attack/defence
# observation (0.75 xG + 0.25 goals, the faster step) and the xG-informed Elo
# update.  Worth -0.01325 log loss on OBOS matches from 2023 (t=-3.41,
# negative in all four seasons) and -0.00247 across both divisions 2016+
# (t=-3.53) -- five times the gain xG bought on Eliteserien.
#
# Shipped with it: the served ratings are now the model's own.  The report
# built its current season with a second replay loop that passed neither xG nor
# the era config, so the live table sat a mean 12 Elo (max 38) away from the
# rating the backtest measured; `model/ratings.py` now delegates to
# `career.replay`.  The era switch moved from a per-season test over the
# league list to `era_config(league, season)`, applied per match -- the
# per-division form it was documented as (OBOS on the slow K) was measured with
# the new corpus and is worse.
#
# Everything else in the refit was swept against the doubled corpus and did not
# move: K and alpha in both divisions, the era boundary, the draw model (also
# per division), home advantage (both models'), the blend weight, the
# attack/defence steps, the seed ladder, the newcomer floor and the finishing
# regression.  See PROJECT_STATUS.md.
MODEL_VERSION = "elo-v11"

# A 400-point rating gap means the stronger side is expected to score 10 times
# as often as the weaker one; this is the constant that defines the ELO scale.
_RATING_SCALE = 400.0


@dataclass(frozen=True)
class EloConfig:
    """Tunable model parameters. Every prediction takes one of these."""

    k_factor: float = 20.0
    home_advantage: float = 60.0
    # Peak draw probability, reached when two sides are exactly level, and the
    # rating gap over which the chance of a draw decays.
    #
    # Fitted by walk-forward backtest on 2019-2026 (3,623 scored matches). Against
    # the previous 0.22/250 this is worth -0.0158 log loss (paired t = -4.98) and
    # halves the calibration error, 0.0396 -> 0.0154. It holds in both halves of
    # the period, -0.0202 on 2019-2022 and -0.0109 on 2023-2026.
    #
    # The hit rate does not move: every bit of the gain is better-calibrated
    # probabilities, none of it is better discrimination between teams.
    draw_base: float = 0.26
    draw_scale: float = 375.0
    # Pull every rating toward its own division's mean at each offseason. 1.0 is
    # a no-op (a club carries its full rating into the next year); smaller values
    # mean-revert. Applied per division now, so the inter-division gap is
    # preserved. Re-fit by walk-forward backtest on the per-division scheme.
    season_regression: float = 0.88
    # Weight on the xG-implied expected score in the rating update. 0.0 is pure
    # Elo (binary result only); 0.45 means 45% of the observation is the Poisson
    # expectation under the two sides' expected goals, so a lucky win moves
    # ratings less than a deserved one. Only active where xG data is available
    # (Eliteserien 2020+); falls back to binary result elsewhere.
    # Fitted walk-forward on 2021-2026: alpha=0.45 beats plain Elo by -0.00235
    # log loss (t=-2.58) and stacks on elo-v7's attack/defence blend for -0.00580
    # vs plain Elo (t=-3.38).
    xg_alpha: float = 0.45


# Era-switch constants.  Warmup seasons use the legacy config above; from the
# boundary season on, the modern one takes over -- in *both* divisions.  The
# per-division variant (OBOS kept on the slow K) was measured with the OBOS xG
# corpus in hand and is worse: +0.00027 log loss on both divisions 2016+
# (t=+2.11).  K is flat from 35 to 50 (|t| < 1.1) and alpha flat 0.30-0.60, so
# the fitted pair stands for both.
MODERN_K: float = 35.0
MODERN_XG_ALPHA: float = 0.50
MODERN_CONFIG = EloConfig(k_factor=MODERN_K, xg_alpha=MODERN_XG_ALPHA)
BOUNDARY_SEASON: int = 2022


def era_config(
    league: str, season: int, base: EloConfig | None = None, modern: EloConfig | None = None
) -> EloConfig:
    """The Elo config one match is rated with: modern from the boundary season
    on, the legacy `base` before it.

    Every replay takes a `config_for(league, season)` of this shape. The shipped
    rule ignores `league` -- both divisions switch together, which is what the
    backtest prefers -- but a sweep over one division is then a different
    function of the same shape rather than a new flag.
    """
    if season >= BOUNDARY_SEASON:
        return modern or MODERN_CONFIG
    return base or EloConfig()


def expected_score(rating: float, opponent_rating: float) -> float:
    """Expected points share (1 = win, 0.5 = draw) for `rating` against `opponent_rating`.

    Any home advantage must already be folded into the ratings passed in.
    """
    return 1.0 / (1.0 + 10.0 ** ((opponent_rating - rating) / _RATING_SCALE))


def xg_implied_score(home_xg: float, away_xg: float) -> float:
    """P(home_win) + 0.5*P(draw) under independent Poisson(home_xg) vs Poisson(away_xg).

    This is the expected points a side would earn if the match were replayed
    many times at the two xG rates. Used by elo-v8 to blend into the rating
    update so a lucky win moves ratings less than a deserved one.
    """
    p_draw = 0.0
    p_home = 0.0
    for k in range(10):
        p_hk = math.exp(-home_xg) * home_xg ** k / math.factorial(k)
        p_ak = math.exp(-away_xg) * away_xg ** k / math.factorial(k)
        p_draw += p_hk * p_ak
        for j in range(k):
            p_aj = math.exp(-away_xg) * away_xg ** j / math.factorial(j)
            p_home += p_hk * p_aj
    return p_home + 0.5 * p_draw


def actual_score(home_goals: int, away_goals: int) -> float:
    """The home side's realised score: 1 for a win, 0.5 for a draw, 0 for a loss."""
    if home_goals > away_goals:
        return 1.0
    if home_goals < away_goals:
        return 0.0
    return 0.5


def update(rating: float, expected: float, actual: float, k_factor: float) -> float:
    """Move a rating toward the surprise in the result."""
    return rating + k_factor * (actual - expected)


def updated_pair(
    home_rating: float,
    away_rating: float,
    home_goals: int,
    away_goals: int,
    config: EloConfig,
    home_xg: float | None = None,
    away_xg: float | None = None,
) -> tuple[float, float]:
    """Return both sides' ratings after one match.

    Ratings are zero-sum: whatever the home side gains, the away side loses.
    When xG data is provided and config.xg_alpha > 0, the observation blends
    the binary result with the xG-implied expected score (elo-v8).
    """
    expected_home = expected_score(home_rating + config.home_advantage, away_rating)
    scored_home = actual_score(home_goals, away_goals)
    if home_xg is not None and away_xg is not None and config.xg_alpha > 0.0:
        xg_score = xg_implied_score(home_xg, away_xg)
        scored_home = (1.0 - config.xg_alpha) * scored_home + config.xg_alpha * xg_score
    change = config.k_factor * (scored_home - expected_home)
    return home_rating + change, away_rating - change


def draw_probability(rating_difference: float, config: EloConfig) -> float:
    """Chance of a draw given the effective rating gap (home advantage included).

    A bell curve centred on an even match: evenly matched sides draw most often
    and the chance falls away as the mismatch grows.
    """
    return config.draw_base * math.exp(-((rating_difference / config.draw_scale) ** 2))
