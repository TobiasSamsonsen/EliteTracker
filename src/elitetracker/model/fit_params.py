"""Joint walk-forward fit of the offseason regression and the seed ladder.

Two model knobs were fit on the old *combined-pool* offseason regression and
are re-fit here together now that regression is applied per division:

* ``EloConfig.season_regression`` -- the pull toward each division's mean at
  every close season;
* the seed ``SeedingConfig`` -- only the ladder ``spread`` (best - worst) and
  the ``division_offset`` are identifiable, because every prediction depends
  only on rating *differences*; the absolute mean is fixed at 1500.

The search is coarse-to-fine so the (regression x spread x offset) grid stays
cheap: a wide coarse pass finds the basin, then a narrow refine hones it. The
harness and grid are deterministic (no randomness in scoring), and everything
is stdlib-only.

Run:

    python -m elitetracker.fit_params
    python -m elitetracker.fit_params --score-from 2016 --top 12
"""

from __future__ import annotations

import argparse

from elitetracker.model.backtest import RegressionRatingModel, walk_forward
from elitetracker.model.elo import EloConfig
from elitetracker.model.initial_ratings import SeedingConfig
from elitetracker.pipeline import load_slices, seed_ratings


def _merged_seasons(slices) -> list[tuple[int, list]]:
    """Both divisions merged per season, as ``walk_forward`` expects."""
    by_season: dict[int, list] = {}
    for slice_ in slices:
        by_season.setdefault(slice_.season, []).extend(slice_.matches)
    return sorted(by_season.items())


def _division_map(slices) -> dict[int, dict[str, str]]:
    """team_id -> league slug for every team active in each season."""
    mapping: dict[int, dict[str, str]] = {}
    for slice_ in slices:
        season_map = mapping.setdefault(slice_.season, {})
        for match in slice_.matches:
            season_map[match.home_id or match.home] = slice_.league
            season_map[match.away_id or match.away] = slice_.league
    return mapping


def _evaluate(merged, div_map, reg: float, spread: float, offset: int, score_from: int):
    """Return (log_loss, calibration) for one (reg, spread, offset) triple."""
    config = SeedingConfig(
        best_rating=1500.0 + spread / 2.0,
        worst_rating=1500.0 - spread / 2.0,
        division_offset=offset,
    )
    seeds = {team_id: seed.rating for team_id, seed in seed_ratings(seeding=config).items()}
    elo = EloConfig(season_regression=reg)
    card = walk_forward(
        merged, seeds, RegressionRatingModel(elo),
        score_from_season=score_from, division_map=div_map,
    )
    return card.log_loss, card.calibration_error()


def _coarse_grid() -> tuple[list[float], list[int], list[int]]:
    regs = [0.86, 0.88, 0.90, 0.92, 0.94, 0.95, 0.96, 0.98, 1.0]
    spreads = list(range(200, 701, 100))
    offsets = list(range(4, 17, 1))
    return regs, spreads, offsets


def _refine_grid(reg: float, spread: float, offset: int):
    deltas_reg = [-0.03, -0.02, -0.01, 0.0, 0.01, 0.02, 0.03]
    deltas_spread = [-60, -40, -20, 0, 20, 40, 60]
    deltas_offset = [-2, -1, 0, 1, 2]
    for dreg in deltas_reg:
        new_reg = round(reg + dreg, 3)
        if not (0.85 <= new_reg <= 1.0):
            continue
        for dspread in deltas_spread:
            new_spread = spread + dspread
            if new_spread < 100:
                continue
            for doff in deltas_offset:
                new_offset = offset + doff
                if new_offset < 0:
                    continue
                yield new_reg, new_spread, new_offset


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[3])
    parser.add_argument("--score-from", type=int, default=2016,
                        help="first season scored (earlier seasons warm up the ratings)")
    parser.add_argument("--top", type=int, default=10, help="how many configs to show")
    args = parser.parse_args(argv)

    slices = load_slices()
    merged = _merged_seasons(slices)
    div_map = _division_map(slices)

    baseline_reg, baseline_spread, baseline_offset = 0.95, 400.0, 10
    base_ll, base_cal = _evaluate(
        merged, div_map, baseline_reg, baseline_spread, baseline_offset, args.score_from
    )

    regs, spreads, offsets = _coarse_grid()
    best = None
    for reg in regs:
        for spread in spreads:
            for offset in offsets:
                ll, calib = _evaluate(merged, div_map, reg, spread, offset, args.score_from)
                if best is None or ll < best[0]:
                    best = (ll, reg, spread, offset, calib)

    best_reg, best_spread, best_offset = best[1], best[2], best[3]
    for reg, spread, offset in _refine_grid(best_reg, best_spread, best_offset):
        ll, calib = _evaluate(merged, div_map, reg, spread, offset, args.score_from)
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
