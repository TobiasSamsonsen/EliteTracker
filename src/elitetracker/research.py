"""Model research: the Elo model against the bookmaker closing line, and the data
pulls a candidate model would need (closing odds, fotmob xG).

    python -m elitetracker.research odds                     # closing odds -> data/odds_closing.json
    python -m elitetracker.research xg --seasons 2020-2026   # fotmob xG + xGoT -> data/xg.json (resumable)
    python -m elitetracker.research run --score-from 2019    # Elo, the shipped blend and the market, paired

The 2026-09 candidates (Dixon-Coles, pi-ratings, an Elo/DC blend, xG-informed
Elo) and their numbers are in PROJECT_STATUS.md; the code lives in git history.
A new candidate needs two methods, predict(home_id, away_id, on) and
observe(match), and a ~12-line chronological loop over both divisions that
scores with Scorecard.observe(..., match_id) so `paired` can compare it.
"""

from __future__ import annotations

import argparse
import time

from elitetracker.model import benchmark
from elitetracker.model.backtest import Scorecard, paired, walk_forward
from elitetracker.model.elo import EloConfig
from elitetracker.pipeline import load_matches, load_slices, seed_ratings
from elitetracker.sources.fotmob import FetchError, fetch_match_xg, load_xg, save_xg


# ---------- data pulls -------------------------------------------------

def cmd_odds(args: argparse.Namespace) -> int:
    if args.refresh or not benchmark.CSV_PATH.exists():
        benchmark.download_csv()
    matches = [m for s in load_slices() if s.league == "eliteserien" for m in s.matches]
    joined, unmatched = benchmark.build_odds(matches)
    played = sum(1 for m in matches if m.played)
    print(f"joined {joined} of {played} played Eliteserien matches; {len(unmatched)} unmatched")
    if unmatched:
        print("  unmatched ids:", unmatched[:20])
    return 0


def cmd_xg(args: argparse.Namespace) -> int:
    first, last = (int(part) for part in args.seasons.split("-"))
    data = load_xg()
    # Entries from the first scrape hold only [xg, xg]; the current shape adds xG on target.
    done = {mid for mid, values in data["matches"].items() if len(values) == 4 and not args.refresh} | set(data["none"])
    todo = [
        m for s in load_slices() if s.league == "eliteserien" and first <= s.season <= last
        for m in s.matches if m.played and m.match_id not in done
    ]
    print(f"{len(todo)} matches to fetch ({len(data['matches'])} done, {len(data['none'])} without xG)")
    # ponytail: raw match details are not archived (230 kB each); re-scrape if
    # shot-level data is ever needed.
    for index, match in enumerate(todo[: args.limit] if args.limit else todo, 1):
        for attempt in range(4):
            try:
                xg = fetch_match_xg(match.match_id)
                break
            except FetchError as exc:
                if attempt == 3:
                    print(f"  giving up on {match.match_id}: {exc}")
                    xg = "skip"
                else:
                    time.sleep(2 ** (attempt + 1))
        if xg == "skip":
            continue
        if xg is None:
            data["none"].append(match.match_id)
        else:
            data["matches"][match.match_id] = list(xg)
        if index % 25 == 0:
            save_xg(data)
            print(f"  {index}/{len(todo)} ({match.date})", flush=True)
        time.sleep(args.delay)
    save_xg(data)
    print(f"done: {len(data['matches'])} with xG, {len(data['none'])} without")
    return 0


# ---------- the comparison ---------------------------------------------

def _halves(card: Scorecard, dates: dict[str, str]) -> tuple[Scorecard, Scorecard]:
    """Split a card's scored matches into the earlier and later half by date."""
    ids = sorted(card.losses, key=lambda i: dates[i])
    cut = len(ids) // 2
    early, late = Scorecard(name=card.name + " early"), Scorecard(name=card.name + " late")
    for part, chunk in ((early, ids[:cut]), (late, ids[cut:])):
        for match_id in chunk:
            part.losses[match_id] = card.losses[match_id]
    return early, late


def cmd_run(args: argparse.Namespace) -> int:
    """Elo alone, the shipped Elo + attack/defence blend, and the closing line, match by match."""
    from elitetracker.model.attack_defence import ADConfig, AttackDefence, blend_outcomes
    from elitetracker.model.career import team_ids
    from elitetracker.model.probabilities import outcome_of
    from elitetracker.normalize.matches import Match

    slices = load_slices()
    seeds = {team_id: seed.rating for team_id, seed in seed_ratings().items()}
    dates = {m.match_id: m.date for s in slices for m in s.matches}
    shots = {k: tuple(v) for k, v in load_xg()["matches"].items()}
    elo = walk_forward(slices, seeds, EloConfig(), score_from_season=args.score_from, name="elo", shots=shots)
    shipped = Scorecard(name="elo + attack/defence")
    ad = AttackDefence.from_slices(slices, ADConfig(), shots=shots)
    for match in sorted((m for s in slices for m in s.matches if m.played), key=Match.sort_key):
        home, away = team_ids(match)
        if match.match_id in elo.predictions:
            odds = blend_outcomes(elo.predictions[match.match_id][0], ad.grid(home, away, match.date))
            shipped.observe(odds, outcome_of(match), match.match_id)
        ad.observe(match)
    matches = [m for s in slices for m in s.matches if int(m.date[:4]) >= args.score_from]
    pinnacle = benchmark.benchmark_card(benchmark.load_odds(), matches)
    print(f"Scored from season {args.score_from}\n\n{elo.summary()}\n{shipped.summary()}\n{pinnacle.summary()}\n")
    print("paired per-match log loss (negative = first is better; |t| >= 2 counts):")
    for card, other in ((shipped, elo), (elo, pinnacle), (shipped, pinnacle)):
        n, mean, t = paired(card, other)
        early_a, late_a = _halves(card, dates)
        early_b, late_b = _halves(other, dates)
        _, mean_early, t_early = paired(early_a, early_b)
        _, mean_late, t_late = paired(late_a, late_b)
        print(f"  {card.name:<22} vs {other.name:<16} n={n} d={mean:+.5f} t={t:+.2f}"
              f"   early d={mean_early:+.5f} t={t_early:+.2f}   late d={mean_late:+.5f} t={t_late:+.2f}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    odds = sub.add_parser("odds"); odds.add_argument("--refresh", action="store_true"); odds.set_defaults(func=cmd_odds)
    xg = sub.add_parser("xg"); xg.add_argument("--seasons", default="2020-2026"); xg.add_argument("--delay", type=float, default=1.0)
    xg.add_argument("--limit", type=int); xg.add_argument("--refresh", action="store_true", help="refetch matches already stored")
    xg.set_defaults(func=cmd_xg)
    run = sub.add_parser("run"); run.add_argument("--score-from", type=int, default=2019); run.set_defaults(func=cmd_run)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
