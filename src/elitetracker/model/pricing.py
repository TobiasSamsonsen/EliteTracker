"""Match odds: how one match is priced, wherever the model prices one.

The published fixtures, the season simulation (and its play-offs) and the
walk-forward backtest all price a match the same way, in this order:

1. The Elo side: the home side's rating plus the prediction-time terms the
   ratings never carry -- the surface edge (Eliteserien only,
   `normalize.surfaces`) and the table stakes (STAKES_ELO per unit of
   P_home - P_away, `model.stakes`) -- into the Elo odds
   (`model.probabilities`). Their `rating_gap` is the gap every
   gap-dependent term below reads.
2. The goals side: the attack/defence rates at that gap (`home_beta`), with
   the stakes on the goals (STAKES_GOALS), into the score grid.
3. The blend: the Elo odds and the grid's own, geometrically, at the gap's
   weight on Elo (`blend_gamma`).

`elo_odds` is step 1 alone, for the Elo-only scorecard and for callers that
price the goals side later; `match_odds` takes those odds through steps 2
and 3. The season simulation builds its grids as arrays, so it takes step 2's
ingredients, `goal_rates` and `blend_weight`, and does the rest itself
(`simulation.season._fixtures`).
"""

from __future__ import annotations

from dataclasses import dataclass

from elitetracker.model.attack_defence import AttackDefence, blend_outcomes, gap_blend_weight, score_grid, top_scorelines
from elitetracker.model.career import team_ids
from elitetracker.model.elo import EloConfig
from elitetracker.model.probabilities import MatchProbabilities, match_probabilities
from elitetracker.model.stakes import STAKES_ELO, STAKES_GOALS
from elitetracker.normalize.matches import Match
from elitetracker.normalize.surfaces import surface_edge

# The surface edge is measured on Eliteserien only.
SURFACE_LEAGUE = "eliteserien"


@dataclass(frozen=True)
class Priced:
    """A match's published odds and the score grid behind them."""

    odds: MatchProbabilities
    grid: list[list[float]]

    def scorelines(self, n: int = 5) -> list[tuple[tuple[int, int], float]]:
        """The most likely scorelines: who wins from the odds, how many from the grid."""
        return top_scorelines(self.grid, self.odds, n)


def elo_odds(match: Match, home_rating: float, away_rating: float, config: EloConfig,
             league: str = "", stakes: float = 0.0) -> MatchProbabilities:
    """The Elo odds for `match` at these ratings. `league` is the division it
    is played in (the surface edge applies in SURFACE_LEAGUE); `stakes` is
    P_home - P_away in the run-in (`model.stakes`), 0 outside it."""
    home, away = team_ids(match)
    edge = surface_edge(home, away, match.date) if league == SURFACE_LEAGUE else 0.0
    return match_probabilities(home_rating + (edge + STAKES_ELO * stakes), away_rating, config)


def goal_rates(odds: list[MatchProbabilities], ad: AttackDefence, match: Match,
               stakes: list[float]) -> list[tuple[float, float]]:
    """Each side's expected goals for `match`, for each of `odds` (from
    `elo_odds`) with its `stakes`: at the gap it was priced at."""
    home, away = team_ids(match)
    return ad.rates_at(home, away, match.date, [(elo.rating_gap, STAKES_GOALS * s) for elo, s in zip(odds, stakes)])


def blend_weight(elo: MatchProbabilities, ad: AttackDefence) -> float:
    """The weight on the Elo odds in the blend, at the gap `elo` was priced at."""
    return gap_blend_weight(elo.rating_gap, ad.config.blend_gamma)


def match_odds(elo: MatchProbabilities, ad: AttackDefence, match: Match, stakes: float = 0.0) -> Priced:
    """The published odds: `elo` (from `elo_odds`, with the same `stakes`)
    blended with the attack/defence score grid."""
    (rates,) = goal_rates([elo], ad, match, [stakes])
    grid = score_grid(*rates, ad.config.rho)
    return Priced(blend_outcomes(elo, grid, weight=blend_weight(elo, ad)), grid)
