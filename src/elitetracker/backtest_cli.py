"""Walk-forward backtest runner over every season we hold.

Used to fit ELO parameters (K-factor, home advantage, cross-season regression)
by log loss rather than by eyeballing one season. The harness itself lives in
`model.backtest`; this is just the driver that loads the corpus, sweeps a grid
of `EloConfig` values, and reports each against the current defaults.

Run:

    python -m elitetracker.backtest_cli
    python -m elitetracker.backtest_cli --k-min 16 --k-max 32 --k-step 2 \\
        --home-min 55 --home-max 95 --home-step 10 --regression 1.0 0.9 0.8

The grid is exhaustive and deterministic; no randomness enters the scoring.
"""

from __future__ import annotations

import argparse

from elitetracker.model.backtest import compare, walk_forward
from elitetracker.model.elo import EloConfig
from elitetracker.pipeline import load_slices, seed_ratings


def _frange(start: float, stop: float, step: float) -> list[float]:
    return [round(start + i * step, 6) for i in range(int((stop - start) / step + 1e-9) + 1)]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--score-from", type=int, default=2016,
                        help="first season scored (earlier seasons warm up the ratings)")
    parser.add_argument("--k-min", type=float, default=16.0)
    parser.add_argument("--k-max", type=float, default=32.0)
    parser.add_argument("--k-step", type=float, default=2.0)
    parser.add_argument("--home-min", type=float, default=50.0)
    parser.add_argument("--home-max", type=float, default=100.0)
    parser.add_argument("--home-step", type=float, default=5.0)
    parser.add_argument("--regression", type=float, nargs="*", default=[EloConfig.season_regression],
                        help="season_regression values to try (default: the current one)")
    parser.add_argument("--top", type=int, default=10, help="how many configs to show")
    args = parser.parse_args(argv)

    slices = load_slices()
    seeds = {team_id: seed.rating for team_id, seed in seed_ratings().items()}

    cards = [walk_forward(slices, seeds, EloConfig(), score_from_season=args.score_from, name="base")]
    for k in _frange(args.k_min, args.k_max, args.k_step):
        for home in _frange(args.home_min, args.home_max, args.home_step):
            for reg in args.regression:
                config = EloConfig(k_factor=k, home_advantage=home, season_regression=reg)
                cards.append(walk_forward(slices, seeds, config, score_from_season=args.score_from,
                                          name=f"k={k:.0f} ha={home:.0f} reg={reg:.2f}"))

    shown = sorted(cards, key=lambda card: card.log_loss)[: max(1, args.top)]
    print(f"Scored from season {args.score_from}  |  {len(cards) - 1} configs + baseline\n")
    print(compare(shown, baseline="base"))
    best = min(cards, key=lambda card: card.log_loss)
    if best.name != "base":
        print(f"\nbest: {best.name}  log_loss={best.log_loss:.5f}  (baseline {cards[0].log_loss:.5f})")
    else:
        print("\nbaseline is best; no grid config beat the current defaults.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
