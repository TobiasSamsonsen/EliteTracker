import sys
sys.path.insert(0, 'src')
import statistics
import math
from datetime import datetime
from eval_harness import (
    load_matches, get_shipped_blend_card, get_market_card, _outcome, get_production_card
)

SEED = 20260809


def get_season_dates(season: int, matches: list):
    """Get all match dates for a given season."""
    season_matches = [m for m in matches if int(m.date[:4]) == season]
    return sorted([m.date for m in season_matches])


def season_phase(season: int, date_str: str, matches: list) -> str:
    """Split season into thirds by chronological date position."""
    season_dates = get_season_dates(season, matches)
    try:
        date_index = season_dates.index(date_str)
    except ValueError:
        return "late"
    
    n_matches = len(season_dates)
    if n_matches == 0:
        return "middle"
    
    third = n_matches // 3
    
    if date_index < third:
        return "early"
    elif date_index < 2 * third:
        return "middle"
    else:
        return "late"


def favourite_confidence(probabilities) -> str:
    """Get confidence quartile based on market's max outcome probability."""
    max_prob = max(probabilities.home_win, probabilities.draw, probabilities.away_win)
    
    if max_prob < 0.5:
        return "least"
    elif max_prob < 0.6:
        return "q2"
    elif max_prob < 0.7:
        return "q3"
    else:
        return "most"


def outcome_class(match) -> str:
    """Get outcome class from actual match result."""
    if match.home_goals > match.away_goals:
        return "home_win"
    elif match.home_goals < match.away_goals:
        return "away_win"
    else:
        return "draw"


def main():
    # Load matches
    matches = load_matches()
    
    # Get cards
    prod_card = get_production_card(matches)
    shipped_card = get_shipped_blend_card(prod_card)
    market_card = get_market_card(matches)
    
    # Process matches for all buckets
    d_values = []
    early_d = []
    late_d = []
    
    # Buckets for storage
    season_buckets = {"early": [], "middle": [], "late": []}
    confidence_buckets = {"least": [], "q2": [], "q3": [], "most": []}
    outcome_buckets = {"home_win": [], "draw": [], "away_win": []}
    
    # Create lookups for market probabilities
    market_probs = {}
    for match_id, probs in market_card.predictions.items():
        market_probs[match_id] = probs[0]
    
    for match_id in shipped_card.losses:
        if match_id in market_card.losses:
            # Get data for this match
            ll_shipped = shipped_card.losses[match_id]
            ll_market = market_card.losses[match_id]
            
            match = None
            for m in matches:
                if m.match_id == match_id:
                    match = m
                    break
            
            if match is None:
                continue
            
            # Compute d_i
            d = ll_shipped - ll_market
            
            # Store for overall stats
            d_values.append(d)
            
            # Season phase bucket
            season = int(match.date[:4])
            phase = season_phase(season, match.date, matches)
            season_buckets[phase].append(d)
            
            # Favourite confidence bucket
            market_probs_for_match = market_probs.get(match_id)
            if market_probs_for_match:
                confidence = favourite_confidence(market_probs_for_match)
                confidence_buckets[confidence].append(d)
            
            # Outcome class bucket
            outcome = outcome_class(match)
            outcome_buckets[outcome].append(d)
            
            # D8 tracking
            if phase == "early":
                early_d.append(d)
            elif phase == "late":
                late_d.append(d)
    
    # Output compact tables (ASCII, <= 50 lines total)
    # Season phase
    print("Season phase buckets:")
    print("Phase | n   | mean d   | t-stat")
    print("------|-----|----------|-------")
    for phase in ["early", "middle", "late"]:
        bucket = season_buckets[phase]
        if len(bucket) >= 2:
            mean_d = statistics.mean(bucket)
            std_d = statistics.stdev(bucket)
            t_stat = mean_d / (std_d / math.sqrt(len(bucket))) if std_d else 0
            print(f"{phase:6} | {len(bucket):3} | {mean_d:8.5f} | {t_stat:6.2f}")
        else:
            print(f"{phase:6} | {len(bucket):3} | {'N/A':8} | {'N/A':6}")
    
    # Favourite confidence
    print("\nFavourite confidence buckets:")
    print("Conf  | n   | mean d   | t-stat")
    print("------|-----|----------|-------")
    for conf in ["least", "q2", "q3", "most"]:
        bucket = confidence_buckets[conf]
        if len(bucket) >= 2:
            mean_d = statistics.mean(bucket)
            std_d = statistics.stdev(bucket)
            t_stat = mean_d / (std_d / math.sqrt(len(bucket))) if std_d else 0
            print(f"{conf:6} | {len(bucket):3} | {mean_d:8.5f} | {t_stat:6.2f}")
        else:
            print(f"{conf:6} | {len(bucket):3} | {'N/A':8} | {'N/A':6}")
    
    # Outcome class
    print("\nOutcome class buckets:")
    print("Class | n   | mean d   | t-stat")
    print("------|-----|----------|-------")
    for outcome in ["home_win", "draw", "away_win"]:
        bucket = outcome_buckets[outcome]
        if len(bucket) >= 2:
            mean_d = statistics.mean(bucket)
            std_d = statistics.stdev(bucket)
            t_stat = mean_d / (std_d / math.sqrt(len(bucket))) if std_d else 0
            print(f"{outcome:6} | {len(bucket):3} | {mean_d:8.5f} | {t_stat:6.2f}")
        else:
            print(f"{outcome:6} | {len(bucket):3} | {'N/A':8} | {'N/A':6}")
    
    # D8 gate
    if len(early_d) >= 2 and len(late_d) >= 2:
        early_mean = statistics.mean(early_d)
        late_mean = statistics.mean(late_d)
        
        if late_mean >= 2 * early_mean and (early_mean >= 0 and late_mean >= 0) or \
           (early_mean <= 0 and late_mean <= 0):
            print("\nD8 GATE: FIRE")
        else:
            print("\nD8 GATE: NO-FIRE")
    else:
        print("\nD8 GATE: NO-FIRE (insufficient data)")


if __name__ == "__main__":
    main()