#!/usr/bin/env python3
"""Evaluation harness for Elitetracker football prediction model.

Real computation harness that imports and runs the actual model components
against validation data to produce verifiable metrics.
"""

import json
import math
import pathlib
import random
from collections import deque
from datetime import date
from typing import Dict, List, Tuple

from elitetracker.model.backtest import Scorecard, walk_forward, paired, ranked_probability_score
from elitetracker.model.benchmark import benchmark_card, load_odds
from elitetracker.model.career import build_careers, team_ids
from elitetracker.model.elo import EloConfig, era_config
from elitetracker.model.attack_defence import (
    AttackDefence, ADConfig, blend_outcomes, outcome_probabilities,
    gap_blend_weight, MatchProbabilities
)
from elitetracker.normalize.matches import Match
from elitetracker.pipeline import load_slices, seed_ratings
from elitetracker.sources.fotmob import load_xg

# Fixed seed for reproducibility
SEED = 20260809
random.seed(SEED)


def load_matches() -> List[Match]:
    """Load played Eliteserien matches from season 2019+ for evaluation.

    Eliteserien only: the market yardstick (data/odds_closing.json) covers that
    division alone, and `research.cmd_run` scores the same scope, so every row
    of the metrics table is over one common match set.
    """
    slices = load_slices()
    matches = [m for s in slices for m in s.matches
               if s.league == "eliteserien" and s.season >= 2019 and m.played]
    return matches


def _outcome(match: Match) -> str:
    """'home_win' / 'draw' / 'away_win' for a finished match."""
    assert match.home_goals is not None and match.away_goals is not None
    if match.home_goals > match.away_goals:
        return "home_win"
    if match.home_goals < match.away_goals:
        return "away_win"
    return "draw"


def _baseline_metrics(matches: List[Match], window: int | None = None, warmup: int = 100) -> Tuple[float, float, float, List[float]]:
    """Prequential baseline: predict each match from results strictly before it,
    then fold the result in (no self-inclusion, no full-sample headline).
    The first ``warmup`` results are a burn-in: they train but are not scored,
    same convention as `walk_forward`'s score_from_season.

    ``window=None`` keeps the full history (expanding climatology); a fixed
    ``window`` keeps only the last n results (rolling frequencies). Scoring
    matches `Scorecard`: log loss = -log p(outcome), Brier = sum (p - 1[out])^2,
    RPS over home < draw < away.
    """
    counts = {"home_win": 0, "draw": 0, "away_win": 0}
    recent: deque = deque(maxlen=window) if window else deque()
    n = 0
    ll = rps = brier = 0.0
    per_match: List[float] = []
    for match in matches:
        if match.home_goals is None or match.away_goals is None:
            continue
        outcome = _outcome(match)
        if n >= warmup:  # burn-in first: never score against a near-empty history
            probs = {key: value / n for key, value in counts.items()}
            loss = -math.log(max(probs[outcome], 1e-12))
            grid = MatchProbabilities(probs["home_win"], probs["draw"], probs["away_win"])
            per_match.append(loss)
            ll += loss
            rps += ranked_probability_score(grid, outcome)
            brier += sum((probs[key] - (1.0 if key == outcome else 0.0)) ** 2 for key in probs)
        if window is None:
            n += 1
        else:
            if len(recent) == window:
                counts[recent.popleft()] -= 1
            else:
                n += 1
            recent.append(outcome)
        counts[outcome] += 1
    if not per_match:
        return 0.0, 0.0, 0.0, []
    scored = len(per_match)
    return ll / scored, rps / scored, brier / scored, per_match


def get_climatology_metrics(matches: List[Match]) -> Tuple[float, float, float, List[float]]:
    """Expanding 1X2 frequencies: every match predicted from all prior results."""
    return _baseline_metrics(matches)


def get_rolling_frequencies_metrics(matches: List[Match]) -> Tuple[float, float, float, List[float]]:
    """Rolling 1X2 frequencies over the last 100 results (~one season)."""
    return _baseline_metrics(matches, window=100)


def compute_paired_test(card_a: Scorecard, card_b: Scorecard, metric: str = "log_loss") -> Tuple[int, float, float]:
    """Compute paired t-test between two cards using the actual paired function."""
    return paired(card_a, card_b, metric)


def bootstrap_ci(scores_list, n_bootstrap: int = 1000) -> tuple:
    """Bootstrap confidence interval from a list of scores (or a match_id->loss dict)."""
    if isinstance(scores_list, dict):
        scores_list = list(scores_list.values())
    if len(scores_list) < 2:
        return 0.0, 0.0, 0.0
    
    boot_means = []
    for _ in range(n_bootstrap):
        resample = random.choices(scores_list, k=len(scores_list))
        boot_means.append(sum(resample) / len(resample))
    
    boot_means.sort()
    lower = boot_means[int(0.025 * n_bootstrap)]
    upper = boot_means[int(0.975 * n_bootstrap)]
    mean = sum(boot_means) / len(boot_means)
    
    return mean, lower, upper


def analyze_season_matches():
    """Analyze matches per season for scope verification."""
    try:
        normalized_dir = pathlib.Path("data/normalized")
        if not normalized_dir.exists():
            return {"error": "data/normalized not found"}
        
        season_counts = {}
        total_played = 0
        scope_2019plus = 0
        
        for match_file in normalized_dir.glob("*_matches.json"):
            filename = match_file.name
            if "_matches.json" not in filename:
                continue
            
            # Extract season from filename
            import re
            match = re.search(r'(\d{4})_matches\.json$', filename)
            if not match:
                continue
            
            season = int(match.group(1))
            league = filename.split(f"{season}_matches.json")[0].rstrip('_')
            
            # Count matches in file
            try:
                with open(match_file, 'r') as f:
                    data = json.load(f)
                    played = sum(1 for match in data if match.get('played', False))
                    
                    season_counts[f"{league}_{season}"] = played
                    total_played += played
                    
                    if season >= 2019:
                        season_counts[f"{league}_{season}_2019plus"] = played
                        scope_2019plus += played
            except Exception:
                pass
        
        return {
            "season_counts": season_counts,
            "total_played": total_played,
            "scope_2019plus": scope_2019plus
        }
    except Exception as e:
        return {"error": str(e)}


def get_production_card(matches: List[Match]) -> Scorecard:
    """Get pure Elo walk forward card."""
    slices = load_slices()
    seeds = {team_id: seed.rating for team_id, seed in seed_ratings().items()}
    shots = {k: tuple(v) for k, v in load_xg()["matches"].items()}
    
    card = walk_forward(
        slices, seeds, EloConfig(), 
        score_from_season=2019, 
        name="production",
        shots=shots,
        league="eliteserien",
        config_for=lambda lg, s: era_config(s, EloConfig())
    )
    
    return card


def get_shipped_blend_card(elo_card: Scorecard) -> Scorecard:
    """Shipped blend card from an existing Elo card's predictions (research.cmd_run logic)."""
    slices = load_slices()
    shots = {k: tuple(v) for k, v in load_xg()["matches"].items()}
    ad = AttackDefence.from_slices(slices, ADConfig(), shots=shots)
    from elitetracker.model.probabilities import outcome_of
    shipped = Scorecard(name="elo + attack/defence")
    
    for match in sorted((m for s in slices for m in s.matches if m.played), key=Match.sort_key):
        home, away = team_ids(match)
        if match.match_id in elo_card.predictions:
            elo_odds = elo_card.predictions[match.match_id][0]
            
            # Calculate blend weight
            blend_weight = gap_blend_weight(elo_odds.rating_gap, ad.config.blend_gamma)
            
            # Calculate grid odds
            grid = ad.grid(home, away, match.date, elo_gap=elo_odds.rating_gap)
            own = outcome_probabilities(grid)
            
            # Blend the odds
            raw = [e ** blend_weight * g ** (1.0 - blend_weight) 
                   for e, g in zip((elo_odds.home_win, elo_odds.draw, elo_odds.away_win),
                                 (own.home_win, own.draw, own.away_win))]
            total = sum(raw)
            blend_odds = MatchProbabilities(*(value / total for value in raw))
            
            # Observe the result
            shipped.observe(blend_odds, outcome_of(match), match.match_id)
        
        ad.observe(match)
    
    return shipped


def get_market_card(matches: List[Match]) -> Scorecard:
    """Get market benchmark card."""
    matches_in_scope = [m for m in matches if int(m.date[:4]) >= 2019]
    odds = load_odds()
    return benchmark_card(odds, matches_in_scope, name="market")


def write_log(date_str: str, seed: int, season_analysis: Dict, prod_ll: float, prod_lower: float, prod_upper: float, prod_rps: float, prod_brier: float,
              shipped_ll: float, shipped_lower: float, shipped_upper: float, shipped_rps: float, shipped_brier: float,
              market_ll: float, market_lower: float, market_upper: float, market_rps: float, market_brier: float,
              climato_ll: float, climato_lower: float, climato_upper: float, climato_rps: float, climato_brier: float,
              rolling_ll: float, rolling_lower: float, rolling_upper: float, rolling_rps: float, rolling_brier: float,
              ttest_n: int, ttest_diff: float, ttest_t: float,
              climato_losses: List[float], rolling_losses: List[float],
              prod_losses: Dict, shipped_losses: Dict, market_losses: Dict) -> None:
    """Write evaluation results to LOG.md - ASCII ONLY."""
    previous_trials = ""
    log_path = pathlib.Path("experiments/LOG.md")
    if log_path.exists():
        existing = log_path.read_text(encoding="utf-8")
        if "## Trial Log" in existing:
            previous_trials = existing.split("## Trial Log", 1)[1]
    with open(log_path, "w", encoding="utf-8") as f:
        f.write("# Elitetracker Model Evaluation Harness Log\n\n")
        f.write(f"**Date**: {date_str}\n")
        f.write(f"\n")
        
        # Data snapshot
        f.write(f"## Data Snapshot\n")
        f.write(f"- Normalized match files: `data/normalized/*.json`\n")
        if "total_played" in season_analysis:
            f.write(f"- Played matches 2019+ (both divisions): {season_analysis['scope_2019plus']}\n")
            f.write(f"- All seasons: {season_analysis['total_played']} played matches\n")
            f.write(f"- Evaluation scope: Eliteserien 2019+ only (market odds cover Eliteserien alone)\n")
        f.write(f"- Fixed seed: {seed}\n")
        f.write(f"\n")
        
        # Configuration findings
        f.write(f"## Configuration Analysis\n")
        f.write(f"\n")
        f.write(f"### Production Configuration (from source inspection)\n")
        f.write(f"1. **Production uses plain EloConfig()** (K=20, xg_alpha=0.45)\n")
        f.write(f"   - Evidence: `pipeline.py:245` - `elo_config = elo_config or EloConfig()`\n")
        f.write(f"2. **Production passes shots (xG data)**\n")
        f.write(f"   - Evidence: `pipeline.py:268` - `shots=shot_table()` passed to `build_rating_table()`\n")
        f.write(f"3. **Production uses era_config via default config_for**\n")
        f.write(f"   - Evidence: `career.py:109` - `config_for` defaults to `era_config(season, config)`\n")
        f.write(f"   - Era boundary at season 2022 (K=30, xg_alpha=0.30 from 2022)\n")
        f.write(f"\n")
        
        # Claim verification
        f.write(f"## Claim Verification\n")
        f.write(f"\n")
        f.write(f"| Claim | Verdict | File:Line | Evidence |\n")
        f.write(f"|-------|---------|-----------|----------|\n")
        f.write(f"| Production uses plain EloConfig() (K=20, xg_alpha=0.45) and no shots | PARTIALLY REFUTED | pipeline.py:245, 268 | EloConfig() used at pipeline.py:245, but shots=shot_table() passed to build_rating_table at pipeline.py:268 |\n")
        f.write(f"| Backtest uses era config + xG | VERIFIED | backtest.py:152 | era_config used at backtest.py:152, shots passed to walk_forward at backtest.py:155 |\n")
        f.write(f"\n")
        
        # Season analysis
        if "season_counts" in season_analysis:
            f.write(f"## Season Analysis\n")
            f.write(f"\n")
            f.write(f"| League | Season | Matches | 2019plus? |\n")
            f.write(f"|--------|--------|---------|----------|\n")
            for key, value in season_analysis["season_counts"].items():
                if "2019plus" in key:
                    season = key.replace("2019plus", "")
                    league = season.split('_')[0]
                    season_num = season.split('_')[1]
                    f.write(f"| {league} | {season_num} | {value} | X |\n")
            f.write(f"\n")
        
        # Metrics table
        f.write(f"## Metrics Table\n")
        f.write(f"\n")
        f.write(f"| Model | Log Loss [CI] | RPS | Brier | n |\n")
        f.write(f"|-------|---------------|-----|-------|---|\n")
        f.write(f"| Production (pure Elo) | {prod_ll:.5f} [{prod_lower:.5f}, {prod_upper:.5f}] | {prod_rps:.5f} | {prod_brier:.5f} | {len(prod_losses)} |\n")
        f.write(f"| Shipped blend (Elo + AD) | {shipped_ll:.5f} [{shipped_lower:.5f}, {shipped_upper:.5f}] | {shipped_rps:.5f} | {shipped_brier:.5f} | {len(shipped_losses)} |\n")
        f.write(f"| Market | {market_ll:.5f} [{market_lower:.5f}, {market_upper:.5f}] | {market_rps:.5f} | {market_brier:.5f} | {len(market_losses)} |\n")
        f.write(f"| League Climatology | {climato_ll:.5f} [{climato_lower:.5f}, {climato_upper:.5f}] | {climato_rps:.5f} | {climato_brier:.5f} | {len(climato_losses)} |\n")
        f.write(f"| Rolling Frequencies | {rolling_ll:.5f} [{rolling_lower:.5f}, {rolling_upper:.5f}] | {rolling_rps:.5f} | {rolling_brier:.5f} | {len(rolling_losses)} |\n")
        f.write(f"\n")
        
        # Paired t-test (shipped blend vs market)
        f.write(f"## Paired t-test (shipped blend - market)\n")
        f.write(f"\n")
        f.write(f"n={ttest_n}, delta_logloss={ttest_diff:.5f}, t={ttest_t:.2f}\n")
        if abs(ttest_t) >= 2:
            f.write(f"Result: Statistically significant difference (|t| >= 2)\n")
        else:
            f.write(f"Result: Not statistically significant (|t| < 2)\n")
        f.write(f"\n")
        
        # Trial log: entries from previous runs survive regeneration.
        f.write("## Trial Log")
        f.write(previous_trials)
        f.write(f"\n### Run {date_str}\n")
        f.write(f"- Seed: {seed}; scope: Eliteserien 2019+, n={len(prod_losses)} (market n={len(market_losses)})\n")
        f.write(f"- Production {prod_ll:.5f} [{prod_lower:.5f}, {prod_upper:.5f}]  "
                f"shipped {shipped_ll:.5f} [{shipped_lower:.5f}, {shipped_upper:.5f}]  "
                f"market {market_ll:.5f} [{market_lower:.5f}, {market_upper:.5f}]\n")
        f.write(f"- Climatology {climato_ll:.5f}, rolling {rolling_ll:.5f}; "
                f"shipped-market delta {ttest_diff:+.5f} t={ttest_t:.2f} (n={ttest_n})\n")


def main():
    """Main evaluation harness - real computation."""
    print("Elitetracker Evaluation Harness")
    print("=" * 60)
    print(f"Seed: {SEED}")
    
    # Analyze season matches for scope verification
    print("\nAnalyzing match scope...")
    season_analysis = analyze_season_matches()
    if "error" not in season_analysis:
        print(f"Total matches (all seasons): {season_analysis['total_played']}")
        print(f"Played matches 2019+ (both divisions): {season_analysis['scope_2019plus']}")
        print(f"Season counts available: {len(season_analysis['season_counts'])} seasons")
    
    # Load data
    print("\nLoading data...")
    matches = load_matches()
    print(f"Loaded {len(matches)} played Eliteserien matches from season 2019+")
    
    # Get production metrics (pure Elo)
    print("\nGetting production metrics...")
    prod_card = get_production_card(matches)
    
    # Get market metrics
    print("\nGetting market benchmark...")
    market_card = get_market_card(matches)
    
    # Get shipped blend metrics (from research.py)
    print("\nGetting shipped blend metrics...")
    shipped_card = get_shipped_blend_card(prod_card)
    
    # Get baseline metrics
    print("\nGetting baseline metrics...")
    climato_log_loss, climato_rps, climato_brier, climato_losses = get_climatology_metrics(matches)
    rolling_log_loss, rolling_rps, rolling_brier, rolling_losses = get_rolling_frequencies_metrics(matches)
    
    # Compute bootstrapped CIs using the correct bootstrap_ci function
    prod_ci_mean, prod_ci_lower, prod_ci_upper = bootstrap_ci(prod_card.losses)
    shipped_ci_mean, shipped_ci_lower, shipped_ci_upper = bootstrap_ci(shipped_card.losses)
    market_ci_mean, market_ci_lower, market_ci_upper = bootstrap_ci(market_card.losses)
    climato_ci_mean, climato_ci_lower, climato_ci_upper = bootstrap_ci(climato_losses)
    rolling_ci_mean, rolling_ci_lower, rolling_ci_upper = bootstrap_ci(rolling_losses)
    
    # Print production metrics
    print(f"\nProduction (pure Elo): log loss: {prod_card.log_loss:.5f}")
    print(f"Production (pure Elo): 95% CI: [{prod_ci_lower:.5f}, {prod_ci_upper:.5f}]")
    print(f"Production (pure Elo): RPS: {prod_card.rps:.5f}")
    print(f"Production (pure Elo): Brier: {prod_card.brier:.5f}")
    print(f"Production (pure Elo): n: {prod_card.matches}")
    
    # Print shipped blend metrics
    print(f"\nShipped blend (Elo + AD): log loss: {shipped_card.log_loss:.5f}")
    print(f"Shipped blend (Elo + AD): 95% CI: [{shipped_ci_lower:.5f}, {shipped_ci_upper:.5f}]")
    print(f"Shipped blend (Elo + AD): n: {shipped_card.matches}")
    
    # Print market metrics
    print(f"\nMarket: log loss: {market_card.log_loss:.5f}")
    print(f"Market: n: {market_card.matches}")
    
    # Print baseline metrics
    print(f"\nLeague Climatology: log_loss={climato_log_loss:.5f}, rps={climato_rps:.5f}, brier={climato_brier:.5f}, n={len(climato_losses)}")
    print(f"Rolling Frequencies: log_loss={rolling_log_loss:.5f}, rps={rolling_rps:.5f}, brier={rolling_brier:.5f}, n={len(rolling_losses)}")
    
    # Paired t-test (shipped blend vs market)
    print("\nPaired t-test (shipped blend - market):")
    n, mean_diff, t_stat = compute_paired_test(shipped_card, market_card, "log_loss")
    print(f"n={n}, delta_logloss={mean_diff:.5f}, t={t_stat:.2f}")
    if abs(t_stat) >= 2:
        print("  Result: Statistically significant difference (|t| >= 2)")
    else:
        print("  Result: Not statistically significant (|t| < 2)")
    
    # Also show pure Elo vs market for reference
    print("\nPaired t-test (pure Elo - market):")
    n2, mean_diff2, t_stat2 = compute_paired_test(prod_card, market_card, "log_loss")
    print(f"n={n2}, delta_logloss={mean_diff2:.5f}, t={t_stat2:.2f}")
    if abs(t_stat2) >= 2:
        print("  Result: Statistically significant difference (|t| >= 2)")
    else:
        print("  Result: Not statistically significant (|t| < 2)")
    
    print("\n" + "=" * 60)
    print("Evaluation completed!")

    write_log(
        str(date.today()), SEED, season_analysis,
        prod_card.log_loss, prod_ci_lower, prod_ci_upper, prod_card.rps, prod_card.brier,
        shipped_card.log_loss, shipped_ci_lower, shipped_ci_upper, shipped_card.rps, shipped_card.brier,
        market_card.log_loss, market_ci_lower, market_ci_upper, market_card.rps, market_card.brier,
        climato_log_loss, climato_ci_lower, climato_ci_upper, climato_rps, climato_brier,
        rolling_log_loss, rolling_ci_lower, rolling_ci_upper, rolling_rps, rolling_brier,
        n, mean_diff, t_stat,
        climato_losses, rolling_losses,
        prod_card.losses, shipped_card.losses, market_card.losses,
    )
    print("LOG.md updated from this run.")
    
if __name__ == "__main__":
    main()