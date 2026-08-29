"""Walk-forward evaluation of rating models against real results.

Every match is predicted using only what was known before it kicked off, then
the result is revealed and the model updates. That ordering is the whole point:
a model tuned on results it has already absorbed will always look good.

Scoring uses log loss as the headline (it punishes confident mistakes, which is
what matters for a probability model) with the Brier score and hit rate
alongside. Lower is better for both losses.

A burn-in period is excluded from scoring so every variant starts from ratings
that have already settled, and none is judged on its first, wildest guesses.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Iterable

from elitetracker.model.elo import EloConfig, expected_score
from elitetracker.model.probabilities import MatchProbabilities, match_probabilities
from elitetracker.normalize.matches import Match

# Guards log(0) when a model is certain and wrong.
_FLOOR = 1e-12


@dataclass
class Scorecard:
    name: str
    matches: int = 0
    log_loss_total: float = 0.0
    brier_total: float = 0.0
    hits: int = 0
    # Reliability: predicted vs realised, bucketed by predicted probability.
    buckets: dict[int, list[float]] = field(default_factory=dict)

    @property
    def log_loss(self) -> float:
        return self.log_loss_total / self.matches if self.matches else float("nan")

    @property
    def brier(self) -> float:
        return self.brier_total / self.matches if self.matches else float("nan")

    @property
    def accuracy(self) -> float:
        return self.hits / self.matches if self.matches else float("nan")

    def observe(self, probabilities: MatchProbabilities, outcome: str) -> None:
        predicted = {
            "home": probabilities.home_win,
            "draw": probabilities.draw,
            "away": probabilities.away_win,
        }
        self.matches += 1
        self.log_loss_total += -math.log(max(predicted[outcome], _FLOOR))
        self.brier_total += sum(
            (value - (1.0 if key == outcome else 0.0)) ** 2 for key, value in predicted.items()
        )
        if max(predicted, key=predicted.get) == outcome:
            self.hits += 1

        for key, value in predicted.items():
            bucket = min(9, int(value * 10))
            entry = self.buckets.setdefault(bucket, [0.0, 0.0, 0.0])
            entry[0] += value                                  # predicted mass
            entry[1] += 1.0 if key == outcome else 0.0         # realised count
            entry[2] += 1.0                                    # predictions in bucket

    def calibration_error(self) -> float:
        """Count-weighted mean gap between predicted and realised frequency.

        A model can score well on log loss while being systematically over- or
        under-confident; this is the check for that.
        """
        gap = 0.0
        total = 0.0
        for predicted_sum, realised_sum, count in self.buckets.values():
            if not count:
                continue
            gap += abs(predicted_sum - realised_sum)
            total += count
        return gap / total if total else float("nan")

    def summary(self) -> str:
        return (
            f"{self.name:<34} n={self.matches:<5} "
            f"logloss={self.log_loss:.5f}  brier={self.brier:.5f}  hit={self.accuracy:.4f}  calib={self.calibration_error():.4f}"
        )


def outcome_of(match: Match) -> str:
    if match.home_goals > match.away_goals:
        return "home"
    if match.home_goals < match.away_goals:
        return "away"
    return "draw"


class RatingModel:
    """A model that predicts a match and then learns from it.

    Subclass and override `update_ratings` (and `predict` if the probability
    mapping itself changes). `ratings` is a plain dict keyed by team id, so a
    variant can hold whatever extra state it needs alongside.
    """

    name = "base"

    def __init__(self, config: EloConfig | None = None, *, floor_rating: float = 1300.0) -> None:
        self.config = config or EloConfig()
        self.floor_rating = floor_rating
        self.ratings: dict[str, float] = {}

    # -- lifecycle -------------------------------------------------------
    def seed(self, seeds: dict[str, float]) -> None:
        self.ratings = dict(seeds)

    def ensure(self, team_id: str) -> None:
        self.ratings.setdefault(team_id, self.floor_rating)

    def start_season(self, season: int, divisions: dict[str, str] | None = None) -> None:
        """Hook for anything that happens between seasons (e.g. regression).

        Pass `divisions` (team_id -> league slug for the teams active this
        season) to regress each team toward its *own division's* mean instead
        of the combined pool mean. That keeps the inter-division gap from being
        compressed every close season and avoids dragging dormant clubs (which
        are never pruned from `ratings`) toward the pool mean. With
        `divisions=None` the historical combined-pool behaviour is preserved.
        """

    # -- prediction ------------------------------------------------------
    def effective_home_advantage(self, home_id: str, away_id: str) -> float:
        return self.config.home_advantage

    def predict(self, home_id: str, away_id: str) -> MatchProbabilities:
        # match_probabilities() adds config.home_advantage itself, so a variant
        # with its own advantage cancels that out and supplies its own.
        advantage = self.effective_home_advantage(home_id, away_id)
        return match_probabilities(
            self.ratings[home_id] + advantage - self.config.home_advantage,
            self.ratings[away_id],
            self.config,
        )

    # -- learning --------------------------------------------------------
    def update_ratings(self, match: Match, home_id: str, away_id: str) -> None:
        """Plain ELO: fixed K, result only, zero-sum."""
        advantage = self.effective_home_advantage(home_id, away_id)
        expected_home = expected_score(self.ratings[home_id] + advantage, self.ratings[away_id])
        scored = 1.0 if match.home_goals > match.away_goals else 0.0 if match.home_goals < match.away_goals else 0.5
        change = self.config.k_factor * (scored - expected_home)
        self.ratings[home_id] += change
        self.ratings[away_id] -= change

    def observe(self, match: Match, home_id: str, away_id: str) -> None:
        self.update_ratings(match, home_id, away_id)


def team_ids(match: Match) -> tuple[str, str]:
    return (match.home_id or match.home, match.away_id or match.away)


class RegressionRatingModel(RatingModel):
    """Plain ELO plus a pull toward the pool mean at every offseason.

    `config.season_regression` of 1.0 is a no-op (the historical behaviour: a
    club carries its full rating into the next year); smaller values
    mean-revert. The first replayed season is the seed and is left alone.
    """

    def __init__(self, config: EloConfig | None = None, *, floor_rating: float = 1300.0) -> None:
        super().__init__(config, floor_rating=floor_rating)
        self._first_season = True

    def start_season(self, season: int, divisions: dict[str, str] | None = None) -> None:
        factor = self.config.season_regression
        if self._first_season or factor >= 1.0:
            self._first_season = False
            return
        if not self.ratings:
            self._first_season = False
            return
        if divisions is None:
            # Historical behaviour: pull every rating toward the combined pool
            # mean across the close season.
            ratings = list(self.ratings.values())
            mean = sum(ratings) / len(ratings)
            for team_id in list(self.ratings):
                self.ratings[team_id] = mean + factor * (self.ratings[team_id] - mean)
            self._first_season = False
            return
        # Per-division regression: group the active teams by league and pull
        # each toward its own division's mean. Dormant teams (absent from
        # `divisions`) are left untouched, so their rating is frozen between
        # appearances and the inter-division gap is preserved.
        by_league: dict[str, list[str]] = {}
        for team_id, league in divisions.items():
            if team_id in self.ratings:
                by_league.setdefault(league, []).append(team_id)
        for team_ids in by_league.values():
            mean = sum(self.ratings[team_id] for team_id in team_ids) / len(team_ids)
            for team_id in team_ids:
                self.ratings[team_id] = mean + factor * (self.ratings[team_id] - mean)
        self._first_season = False



def walk_forward(
    seasons: list[tuple[int, list[Match]]],
    seeds: dict[str, float],
    model: RatingModel,
    *,
    score_from_season: int,
    division_map: dict[int, dict[str, str]] | None = None,
) -> Scorecard:
    """Replay every season in order, scoring only from `score_from_season` on.

    `seasons` is [(season, matches)] with both divisions already merged, so the
    rating pool is shared exactly as it is in production. When `division_map`
    maps each season to its active team_id -> league slug, the offseason
    regression (if the model performs one) is applied per division.
    """
    model.seed(seeds)
    card = Scorecard(name=model.name)

    for season, matches in sorted(seasons, key=lambda pair: pair[0]):
        model.start_season(
            season, division_map.get(season) if division_map else None
        )
        for team_id in {tid for match in matches for tid in team_ids(match)}:
            model.ensure(team_id)

        for match in sorted(matches, key=Match.sort_key):
            if not match.played:
                continue
            home_id, away_id = team_ids(match)
            if season >= score_from_season:
                card.observe(model.predict(home_id, away_id), outcome_of(match))
            model.observe(match, home_id, away_id)

    return card


def compare(cards: Iterable[Scorecard], baseline: str | None = None) -> str:
    """Table of results, with the change against a named baseline."""
    cards = list(cards)
    reference = next((card for card in cards if card.name == baseline), None)
    lines = []
    for card in cards:
        line = card.summary()
        if reference is not None and card is not reference:
            delta = card.log_loss - reference.log_loss
            better = "better" if delta < 0 else "worse"
            line += f"   [{delta:+.5f} log loss, {better}]"
        lines.append(line)
    return "\n".join(lines)
