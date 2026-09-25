"""Walk-forward evaluation of the rating model against real results.

Every match is predicted using only what was known before it kicked off, then
the result is revealed and the model updates. That ordering is the whole point:
a model tuned on results it has already absorbed will always look good.

Scoring uses log loss as the headline (it punishes confident mistakes, which is
what matters for a probability model) with the Brier score, the ranked
probability score and hit rate alongside. RPS treats home/draw/away as ordered,
so a draw is a smaller miss than the wrong winner. Lower is better for all three.

A burn-in period is excluded from scoring so every variant starts from ratings
that have already settled, and none is judged on its first, wildest guesses.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field
from typing import Callable, Iterable

from elitetracker.model.career import SeasonSlice, replay
from elitetracker.model.elo import EloConfig, era_config
from elitetracker.model.probabilities import AWAY_WIN, DRAW, HOME_WIN, MatchProbabilities, match_probabilities, outcome_of

# Guards log(0) when a model is certain and wrong.
_FLOOR = 1e-12


def ranked_probability_score(probabilities: MatchProbabilities, outcome: str) -> float:
    """RPS over the ordered outcomes home win < draw < away win: the mean squared
    gap between the predicted and realised cumulative distributions."""
    home = 1.0 if outcome == HOME_WIN else 0.0
    home_or_draw = 1.0 if outcome in (HOME_WIN, DRAW) else 0.0
    return ((probabilities.home_win - home) ** 2
            + (probabilities.home_win + probabilities.draw - home_or_draw) ** 2) / 2.0


@dataclass
class Scorecard:
    name: str = ""
    matches: int = 0
    log_loss_total: float = 0.0
    brier_total: float = 0.0
    rps_total: float = 0.0
    hits: int = 0
    # Reliability: predicted vs realised, bucketed by predicted probability.
    buckets: dict[int, list[float]] = field(default_factory=dict)
    # match_id -> -log p(outcome), so two cards can be compared match by match;
    # the Brier and RPS per match alongside, for `paired(..., metric=...)`.
    losses: dict[str, float] = field(default_factory=dict)
    brier_losses: dict[str, float] = field(default_factory=dict)
    rps_losses: dict[str, float] = field(default_factory=dict)
    # match_id -> (probabilities, outcome), so cards can be blended or restricted.
    predictions: dict[str, tuple[MatchProbabilities, str]] = field(default_factory=dict)

    @property
    def log_loss(self) -> float:
        return self.log_loss_total / self.matches if self.matches else float("nan")

    @property
    def brier(self) -> float:
        return self.brier_total / self.matches if self.matches else float("nan")

    @property
    def rps(self) -> float:
        return self.rps_total / self.matches if self.matches else float("nan")

    @property
    def accuracy(self) -> float:
        return self.hits / self.matches if self.matches else float("nan")

    def observe(self, probabilities: MatchProbabilities, outcome: str, match_id: str = "") -> None:
        predicted = {
            HOME_WIN: probabilities.home_win,
            DRAW: probabilities.draw,
            AWAY_WIN: probabilities.away_win,
        }
        self.matches += 1
        loss = -math.log(max(predicted[outcome], _FLOOR))
        self.log_loss_total += loss
        brier = sum((value - (1.0 if key == outcome else 0.0)) ** 2 for key, value in predicted.items())
        rps = ranked_probability_score(probabilities, outcome)
        if match_id:
            self.losses[match_id] = loss
            self.brier_losses[match_id] = brier
            self.rps_losses[match_id] = rps
            self.predictions[match_id] = (probabilities, outcome)
        self.brier_total += brier
        self.rps_total += rps
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
            f"logloss={self.log_loss:.5f}  brier={self.brier:.5f}  rps={self.rps:.5f}  hit={self.accuracy:.4f}  calib={self.calibration_error():.4f}"
        )


def walk_forward(
    slices: list[SeasonSlice],
    seeds: dict[str, float],
    config: EloConfig | None = None,
    *,
    score_from_season: int,
    name: str = "",
    shots: dict[str, tuple[float, ...]] | None = None,
    league: str | None = None,
    config_for: Callable[[str, int], EloConfig] | None = None,
) -> Scorecard:
    """Replay every season in order, scoring only from `score_from_season` on.

    Both divisions share one rating pool and the offseason regression is applied
    per division, exactly as in production (see `career.replay`).

    ``shots`` is an optional mapping of match_id to (home_xg, away_xg, ...)
    from fotmob; when provided and config.xg_alpha > 0, the rating update
    blends the binary result with the xG-implied score (elo-v8).

    ``league`` restricts scoring to matches in that league slug (ratings still
    warm on both divisions).

    ``config_for(league, season)`` picks the Elo config each match is rated and
    predicted with -- the shipped era switch by default (see `elo.era_config`),
    a per-division variant when one is being fitted.
    """
    config = config or EloConfig()
    config_for = config_for or (lambda lg, season: era_config(season, config))
    card = Scorecard(name=name)
    match_league = {m.match_id: s.league for s in slices for m in s.matches}
    for season, _, _, matches in replay(slices, seeds, config, shots=shots, config_for=config_for):
        for match, (home_before, away_before) in matches:
            match_in = match_league.get(match.match_id, "")
            if season >= score_from_season and (league is None or match_in == league):
                card.observe(
                    match_probabilities(home_before, away_before, config_for(match_in, season)),
                    outcome_of(match), match.match_id,
                )
    return card


def restrict(card: Scorecard, keep: set[str], name: str | None = None) -> Scorecard:
    """The same predictions, scored only on `keep`."""
    out = Scorecard(name=name or card.name)
    for match_id, (probabilities, outcome) in card.predictions.items():
        if match_id in keep:
            out.observe(probabilities, outcome, match_id)
    return out


def paired(a: Scorecard, b: Scorecard, metric: str = "log_loss") -> tuple[int, float, float]:
    """(n, mean of a-b per-match loss, t-stat) over the matches both scored.

    `metric` is "log_loss", "brier" or "rps". Negative means `a` is better. For
    the ship rule (|t| >= 2, or the out-of-sample rule for one-knob changes)
    see PROJECT_STATUS.md, "elo-v12.0".
    """
    pick = {"log_loss": "losses", "brier": "brier_losses", "rps": "rps_losses"}[metric]
    first, second = getattr(a, pick), getattr(b, pick)
    ids = first.keys() & second.keys()
    diffs = [first[i] - second[i] for i in ids]
    n = len(diffs)
    if n < 2:
        return n, float("nan"), float("nan")
    mean = statistics.fmean(diffs)
    sd = statistics.stdev(diffs)
    return n, mean, mean / (sd / math.sqrt(n)) if sd else float("inf")


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
