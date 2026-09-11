"""Joint walk-forward fit of the offseason regression and the seed ladder.

* ``EloConfig.season_regression`` -- the pull toward each division's mean at
  every close season;
* the seed ``SeedingConfig`` -- only the ladder ``spread`` (best - worst) and
  the ``division_offset`` are identifiable, because every prediction depends
  only on rating *differences*; the absolute mean is fixed at 1500.

The search is coarse-to-fine so the (regression x spread x offset) grid stays
cheap: a wide coarse pass finds the basin, then a narrow refine hones it.

Run:

    python -m elitetracker.model.fit_params
    python -m elitetracker.model.fit_params --score-from 2016
"""

from __future__ import annotations

import argparse

from elitetracker.model.backtest import walk_forward
from elitetracker.model.elo import EloConfig
from elitetracker.model.initial_ratings import SeedingConfig
from elitetracker.pipeline import load_slices, seed_ratings


def _evaluate(slices, reg: float, spread: float, offset: int, score_from: int):
    """Return (log_loss, calibration) for one (reg, spread, offset) triple."""
    config = SeedingConfig(
        best_rating=1500.0 + spread / 2.0,
        worst_rating=1500.0 - spread / 2.0,
        division_offset=offset,
    )
    seeds = {team_id: seed.rating for team_id, seed in seed_ratings(seeding=config).items()}
    card = walk_forward(slices, seeds, EloConfig(season_regression=reg), score_from_season=score_from)
    return card.log_loss, card.calibration_error()


def _refine_grid(reg: float, spread: float, offset: int):
    for dreg in (-0.03, -0.02, -0.01, 0.0, 0.01, 0.02, 0.03):
        new_reg = round(reg + dreg, 3)
        if not (0.85 <= new_reg <= 1.0):
            continue
        for dspread in (-60, -40, -20, 0, 20, 40, 60):
            if spread + dspread < 100:
                continue
            for doff in (-2, -1, 0, 1, 2):
                if offset + doff >= 0:
                    yield new_reg, spread + dspread, offset + doff


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--score-from", type=int, default=2016,
                        help="first season scored (earlier seasons warm up the ratings)")
    args = parser.parse_args(argv)

    slices = load_slices()
    baseline_reg, baseline_spread, baseline_offset = 0.95, 400.0, 10
    base_ll, base_cal = _evaluate(slices, baseline_reg, baseline_spread, baseline_offset, args.score_from)

    best = None
    for reg in (0.86, 0.88, 0.90, 0.92, 0.94, 0.95, 0.96, 0.98, 1.0):
        for spread in range(200, 701, 100):
            for offset in range(4, 17):
                ll, calib = _evaluate(slices, reg, spread, offset, args.score_from)
                if best is None or ll < best[0]:
                    best = (ll, reg, spread, offset, calib)

    for reg, spread, offset in _refine_grid(best[1], best[2], best[3]):
        ll, calib = _evaluate(slices, reg, spread, offset, args.score_from)
        if ll < best[0]:
            best = (ll, reg, spread, offset, calib)

    best_ll, reg, spread, offset, calib = best
    print(f"Scored from season {args.score_from}")
    print(f"baseline (reg={baseline_reg}, spread={int(baseline_spread)}, offset={baseline_offset}): "
          f"logloss={base_ll:.5f}  calib={base_cal:.4f}")
    print(f"best:     reg={reg:.3f}  spread={int(round(spread))}  offset={int(offset)}  "
          f"logloss={best_ll:.5f}  calib={calib:.4f}")
    print(f"marginal: {best_ll - base_ll:+.5f} log loss")
    print()
    print("Recommended constants:")
    print(f"  EloConfig.season_regression = {reg:.3f}")
    print(f"  SeedingConfig.best_rating  = {1500.0 + spread / 2.0:.1f}")
    print(f"  SeedingConfig.worst_rating = {1500.0 - spread / 2.0:.1f}")
    print(f"  SeedingConfig.division_offset = {int(offset)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
