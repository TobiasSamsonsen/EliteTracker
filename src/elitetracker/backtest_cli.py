"""Walk-forward backtest runner over every season we hold.

Used to fit ELO parameters (K-factor, home advantage, cross-season regression)
by log loss rather than by eyeballing one season. The harness itself lives in
`model.backtest`; this is just the driver that loads the corpus, sweeps a grid
of `EloConfig` values, and reports each against the current defaults.

Run:

    python -m elitetracker.backtest_cli
    python -m elitetracker.backtest_cli --k-min 16 --k-max 32 --k-step 2 \\
        --home-min 55 --home-max 95 --home-step 10 --regression 1.0 0.9 0.8
    python -m elitetracker.backtest_cli --blend --split-season 2023

The grid is exhaustive and deterministic; no randomness enters the scoring.
The --blend flag runs a forward-split sweep of the blend_gamma parameter:
fit on [score_from, split_season), test on [split_season, ...].
"""

from __future__ import annotations

import argparse
from dataclasses import replace

from elitetracker.model.backtest import Scorecard, compare, paired, walk_forward
from elitetracker.model.elo import EloConfig, MODERN_CONFIG, era_config
from elitetracker.pipeline import load_slices, seed_ratings, shot_table


def _frange(start: float, stop: float, step: float) -> list[float]:
    return [round(start + i * step, 6) for i in range(int((stop - start) / step + 1e-9) + 1)]


def _blend_forward_split(slices, seeds, shots, score_from, split_season, gamma_values, top):
    """Forward-split sweep of blend_gamma: fit on first half, test on second."""
    from elitetracker.model.attack_defence import ADConfig, AttackDefence, blend_outcomes, gap_blend_weight
    from elitetracker.model.career import team_ids
    from elitetracker.model.probabilities import outcome_of
    from elitetracker.normalize.matches import Match

    dates = {m.match_id: m.date for s in slices for m in s.matches}

    # Elo-only card for all matches (the baseline to blend against).
    elo_card = walk_forward(slices, seeds, EloConfig(), score_from_season=score_from,
                            name="elo", shots=shots, league="eliteserien")

    # Replay AD over the full corpus once per gamma value.
    cards = []
    for gamma in gamma_values:
        ad_config = replace(ADConfig(), blend_gamma=gamma)
        ad = AttackDefence.from_slices(slices, ad_config, shots=shots)
        card = Scorecard(name=f"g={gamma:.2f}")
        for match in sorted((m for s in slices for m in s.matches if m.played), key=Match.sort_key):
            home, away = team_ids(match)
            if match.match_id not in elo_card.predictions:
                continue
            elo_odds = elo_card.predictions[match.match_id][0]
            gw = gap_blend_weight(elo_odds.rating_gap, gamma)
            blended = blend_outcomes(elo_odds, ad.grid(home, away, match.date, elo_gap=elo_odds.rating_gap),
                                     weight=gw)
            card.observe(blended, outcome_of(match), match.match_id)
            ad.observe(match)

        # Split into train/test by season.
        train = Scorecard(name=f"g={gamma:.2f} train")
        test = Scorecard(name=f"g={gamma:.2f} test")
        for match_id, (probs, outcome) in card.predictions.items():
            # Find the season this match belongs to.
            season = int(dates[match_id][:4]) if match_id in dates else 0
            target = train if season < split_season else test
            target.observe(probs, outcome, match_id)
        cards.append((gamma, train, test))

    # Report.
    elo_split = Scorecard(name="elo test")
    for match_id, (probs, outcome) in elo_card.predictions.items():
        season = int(dates[match_id][:4]) if match_id in dates else 0
        if season >= split_season:
            elo_split.observe(probs, outcome, match_id)

    print(f"Forward split: fit on <{split_season}, test on {split_season}+\n")
    print(f"{'config':<20} {'train ll':>10} {'test ll':>10} {'vs elo':>10} {'t':>8}")
    print("-" * 62)
    for gamma, train, test in cards:
        _, mean, t = paired(test, elo_split)
        better = "better" if mean < 0 else "worse"
        print(f"g={gamma:<17} {train.log_loss:>10.5f} {test.log_loss:>10.5f} {mean:>+10.5f} {t:>+7.2f}  {better}")

    best = min(cards, key=lambda c: c[2].log_loss)
    print(f"\nbest: g={best[0]:.2f}  test_log_loss={best[2].log_loss:.5f}  (elo baseline {elo_split.log_loss:.5f})")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--score-from", type=int, default=2022,
                        help="first season scored (earlier seasons warm up the ratings)")
    parser.add_argument("--k-min", type=float, default=16.0)
    parser.add_argument("--k-max", type=float, default=32.0)
    parser.add_argument("--k-step", type=float, default=2.0)
    parser.add_argument("--home-min", type=float, default=50.0)
    parser.add_argument("--home-max", type=float, default=100.0)
    parser.add_argument("--home-step", type=float, default=5.0)
    parser.add_argument("--beta-min", type=float, default=-0.5,
                        help="home_advantage_beta minimum (0.0 = constant)")
    parser.add_argument("--beta-max", type=float, default=0.5)
    parser.add_argument("--beta-step", type=float, default=0.1)
    parser.add_argument("--regression", type=float, nargs="*", default=[EloConfig.season_regression],
                        help="season_regression values to try (default: the current one)")
    parser.add_argument("--top", type=int, default=10, help="how many configs to show")
    # Forward-split blend sweep mode.
    parser.add_argument("--blend", action="store_true",
                        help="run forward-split sweep of blend_gamma instead of the Elo grid")
    parser.add_argument("--split-season", type=int, default=2023,
                        help="season boundary for the forward split")
    parser.add_argument("--gamma-min", type=float, default=0.0)
    parser.add_argument("--gamma-max", type=float, default=1.0)
    parser.add_argument("--gamma-step", type=float, default=0.1)
    args = parser.parse_args(argv)

    slices = load_slices()
    seeds = {team_id: seed.rating for team_id, seed in seed_ratings().items()}
    shots = shot_table()

    if args.blend:
        gammas = _frange(args.gamma_min, args.gamma_max, args.gamma_step)
        return _blend_forward_split(slices, seeds, shots, args.score_from,
                                    args.split_season, gammas, args.top)

    cards = [walk_forward(slices, seeds, EloConfig(), score_from_season=args.score_from, name="base",
                           league="eliteserien", shots=shots)]
    for k in _frange(args.k_min, args.k_max, args.k_step):
        for home in _frange(args.home_min, args.home_max, args.home_step):
            for reg in args.regression:
                for beta in _frange(args.beta_min, args.beta_max, args.beta_step):
                    # The scored matches (Eliteserien from the boundary season) are
                    # rated with the modern config, so the sweep has to move that
                    # one; the legacy config still warms the ratings up to it.
                    legacy = EloConfig(home_advantage=home, season_regression=reg,
                                       home_advantage_beta=beta)
                    modern = replace(MODERN_CONFIG, k_factor=k, home_advantage=home,
                                     season_regression=reg, home_advantage_beta=beta)
                    cards.append(walk_forward(slices, seeds, legacy,
                                              score_from_season=args.score_from,
                                              name=f"k={k:.0f} ha={home:.0f} reg={reg:.2f} b={beta:.2f}",
                                              league="eliteserien", shots=shots,
                                              config_for=lambda lg, s, l=legacy, m=modern: era_config(s, l, m)))

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
