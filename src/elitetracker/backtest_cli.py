"""Walk-forward backtest runner over every season we hold.

Used to fit ELO parameters (K-factor, home advantage, cross-season regression)
by log loss rather than by eyeballing one season. The harness itself lives in
`model.backtest`; this is just the driver that loads the corpus, sweeps a grid
of `EloConfig` values, and reports each against the current defaults.

Run:

    python -m elitetracker.backtest_cli
    python -m elitetracker.backtest_cli --k-min 16 --k-max 32 --k-step 2 \
        --home-min 55 --home-max 95 --home-step 10 --regression 1.0 0.9 0.8

    # A/B the ordered-logit probability mapping against the draw model, fitting
    # its slope and cutpoint (ratings held at the elo-v6 defaults).
    python -m elitetracker.backtest_cli --probability-model ordered_logit

The grid is exhaustive and deterministic; no randomness enters the scoring.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass

from elitetracker.model.backtest import (
    RatingModel,
    RegressionRatingModel,
    Scorecard,
    compare,
    walk_forward,
)
from elitetracker.model.elo import EloConfig
from elitetracker.pipeline import load_slices, seed_ratings


def _merged_seasons() -> list[tuple[int, list]]:
    """Both divisions merged per season, as `walk_forward` expects."""
    slices = load_slices()
    by_season: dict[int, list] = {}
    for slice_ in slices:
        by_season.setdefault(slice_.season, []).extend(slice_.matches)
    return sorted(by_season.items())


def _seeds() -> dict[str, float]:
    return {team_id: seed.rating for team_id, seed in seed_ratings().items()}


def _frange(start: float, stop: float, step: float) -> list[float]:
    values: list[float] = []
    current = start
    while current <= stop + 1e-9:
        values.append(round(current, 6))
        current += step
    return values


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[3])
    parser.add_argument("--score-from", type=int, default=2016,
                        help="first season scored (earlier seasons warm up the ratings)")
    parser.add_argument("--k-min", type=float, default=16.0)
    parser.add_argument("--k-max", type=float, default=32.0)
    parser.add_argument("--k-step", type=float, default=2.0)
    parser.add_argument("--home-min", type=float, default=50.0)
    parser.add_argument("--home-max", type=float, default=100.0)
    parser.add_argument("--home-step", type=float, default=5.0)
    parser.add_argument("--regression", type=float, nargs="*", default=None,
                        help="season_regression values to try (default: just 1.0)")
    parser.add_argument("--probability-model", choices=("draw", "ordered_logit"), default="draw",
                        help="which win/draw/loss map to score (default: draw)")
    parser.add_argument("--slope-min", type=float, default=0.003)
    parser.add_argument("--slope-max", type=float, default=0.012)
    parser.add_argument("--slope-step", type=float, default=0.001)
    parser.add_argument("--cut-min", type=float, default=0.3)
    parser.add_argument("--cut-max", type=float, default=1.0)
    parser.add_argument("--cut-step", type=float, default=0.1)
    parser.add_argument("--top", type=int, default=10, help="how many configs to show")
    args = parser.parse_args(argv)

    seasons = _merged_seasons()
    seeds = _seeds()

    if args.probability_model == "ordered_logit":
        return _ordered_logit_sweep(seasons, seeds, args)

    baseline = EloConfig(probability_model="draw")
    cards: list[Scorecard] = [
        walk_forward(seasons, seeds, RatingModel(baseline), score_from_season=args.score_from)
    ]

    regression_values = [float(v) for v in args.regression] if args.regression else [1.0]
    for k in _frange(args.k_min, args.k_max, args.k_step):
        for home in _frange(args.home_min, args.home_max, args.home_step):
            for reg in regression_values:
                config = EloConfig(k_factor=k, home_advantage=home, season_regression=reg,
                                   probability_model="draw")
                card = walk_forward(seasons, seeds, RegressionRatingModel(config),
                                    score_from_season=args.score_from)
                card.name = f"k={k:.0f} ha={home:.0f} reg={reg:.2f}"
                cards.append(card)

    shown = sorted(cards, key=lambda card: card.log_loss)[: max(1, args.top)]
    print(f"Scored from season {args.score_from}  |  {len(cards) - 1} configs + baseline\n")
    print(compare(shown, baseline="base"))
    best = min(cards, key=lambda card: card.log_loss)
    if best.name != "base":
        print(f"\nbest: {best.name}  log_loss={best.log_loss:.5f}  (baseline {cards[0].log_loss:.5f})")
    else:
        print(f"\nbaseline is best; no grid config beat the current defaults.")
    return 0


def _ordered_logit_sweep(seasons, seeds, args) -> int:
    """Fit the ordered-logit slope and cutpoint with ratings held at elo-v6 defaults.

    Only the probability mapping changes between the baseline and the grid, so the
    reported delta is the mapping gain measured marginally against the current
    draw model -- exactly the comparison the project asks for.
    """
    baseline = EloConfig(probability_model="draw")
    base_card = walk_forward(seasons, seeds, RatingModel(baseline), score_from_season=args.score_from)

    cards: list[Scorecard] = [base_card]
    for slope in _frange(args.slope_min, args.slope_max, args.slope_step):
        for cut in _frange(args.cut_min, args.cut_max, args.cut_step):
            config = EloConfig(probability_model="ordered_logit",
                               logit_slope=slope, logit_cutpoint=cut)
            card = walk_forward(seasons, seeds, RatingModel(config),
                                score_from_season=args.score_from)
            card.name = f"slope={slope:.4f} cut={cut:.2f}"
            cards.append(card)

    shown = sorted(cards, key=lambda card: card.log_loss)[: max(1, args.top)]
    print(f"Scored from season {args.score_from}  |  ordered_logit vs draw baseline "
          f"({len(cards) - 1} configs)\n")
    print(compare(shown, baseline="base"))
    best = min(cards, key=lambda card: card.log_loss)
    if best.name != "base":
        print(f"\nbest: {best.name}  log_loss={best.log_loss:.5f}  "
              f"(draw baseline {base_card.log_loss:.5f}, {best.log_loss - base_card.log_loss:+.5f})")
    else:
        print(f"\ndraw baseline is best; ordered logit did not improve on it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
