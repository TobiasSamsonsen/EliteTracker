"""Model research: the Elo model against the bookmaker closing line, and the data
pulls a candidate model would need (closing odds, fotmob xG).

    python -m elitetracker.research odds                     # closing odds -> data/odds_closing.json
    python -m elitetracker.research xg --seasons 2020-2026   # fotmob xG, xGoT, npxG, red cards -> data/xg.json (manual backfill)
    python -m elitetracker.research xg-obos                  # sofascore xG for OBOS-ligaen (2023+)
    python -m elitetracker.research run --score-from 2019    # Elo, the shipped blend and the market, paired
    python -m elitetracker.research market-values --season 2027 [--dry-run]  # Transfermarkt squad values

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
from elitetracker.model.backtest import Scorecard, paired, reliability, restrict, shipped_cards
from elitetracker.pipeline import NORMALIZED_DIR, load_matches, load_slices, market_values, seed_ratings, stakes_table
from elitetracker.sources.fotmob import FetchError, fetch_match_xg, load_xg, save_xg
from elitetracker.sources.sofascore import DEFAULT_DELAY


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
    """The manual, opt-in fotmob backfill (refresh only ever asks for new
    matches). Polite by the scraping rules of IMPROVEMENTS.md: one request at a
    time, a jittered wait of `--delay` to twice that between them (4-8 s by
    default), the file saved after every match, and a stop at the first 403 or
    429 -- asking again would only make a refusal stick. Entries that already
    hold xG on target are skipped unless --refresh (which re-reads them, e.g.
    to add npxG and red cards to older seasons: ~1,600 requests, hours)."""
    import random

    first, last = (int(part) for part in args.seasons.split("-"))
    data = load_xg()
    done = {mid for mid, values in data["matches"].items() if len(values) >= 4 and not args.refresh} | set(data["none"])
    todo = [
        m for s in load_slices() if s.league == "eliteserien" and first <= s.season <= last
        for m in s.matches if m.played and m.match_id not in done
    ]
    print(f"{len(todo)} matches to fetch ({len(data['matches'])} done, {len(data['none'])} without xG)")
    # ponytail: raw match details are not archived (230 kB each); re-scrape if
    # shot-level data is ever needed.
    for index, match in enumerate(todo[: args.limit] if args.limit else todo, 1):
        if index > 1:
            time.sleep(random.uniform(args.delay, 2 * args.delay))
        try:
            xg = fetch_match_xg(match.match_id)
        except FetchError as exc:
            if "HTTP 403" in str(exc) or "HTTP 429" in str(exc):
                print(f"  stopping at {match.match_id}: {exc}")
                return 1
            print(f"  skipped {match.match_id}: {exc}")
            continue
        if xg is None:
            if match.match_id not in data["none"]:
                data["none"].append(match.match_id)
        else:
            data["matches"][match.match_id] = list(xg)
        save_xg(data)
        if index % 25 == 0:
            print(f"  {index}/{len(todo)} ({match.date})", flush=True)
    save_xg(data)
    print(f"done: {len(data['matches'])} with xG, {len(data['none'])} without")
    return 0


def cmd_xg_obos(args: argparse.Namespace) -> int:
    """OBOS-ligaen xG from Sofascore; fotmob has no shotmap for the second division."""
    from elitetracker.sources.sofascore import (
        DEFAULT_DELAY, FIRST_XG_SEASON, SEASON_IDS, SofascoreBlocked,
        pending_obos_xg, update_obos_xg,
    )

    # "--seasons 2026" is as natural as "2023-2026"; both mean one year or many.
    parts = [int(part) for part in args.seasons.split("-")]
    first, last = (parts[0], parts[0]) if len(parts) == 1 else parts
    total = 0
    for season in range(max(first, FIRST_XG_SEASON), last + 1):
        if season not in SEASON_IDS:
            print(f"OBOS {season}: no Sofascore season id, skipped")
            continue
        matches = load_matches(NORMALIZED_DIR / f"obosligaen_{season}_matches.json")
        # Same rule as refresh: never fetched, or fetched inside the settle
        # window and possibly revised since. Check before asking, because
        # season_events() costs a request per page.
        todo = pending_obos_xg(matches)
        if not todo:
            print(f"OBOS {season}: nothing outstanding, skipped")
            continue
        newest = max(m.date for m in todo)
        print(f"OBOS {season}: {len(todo)} to fetch (newest {newest})")
        try:
            added = update_obos_xg(matches, season, delay=args.delay,
                                   only=todo, verbose=True)
        except SofascoreBlocked as exc:
            print(f"OBOS {season}: {exc}")
            return 1
        print(f"OBOS {season}: {added} match(es) recorded")
        total += added
    if not total:
        print("nothing to fetch")
    data = load_xg()
    print(f"done: {len(data['matches'])} with xG, {len(data['none'])} without")
    return 0


def cmd_market_values(args: argparse.Namespace) -> int:
    """Transfermarkt squad values for one season or a range (two pages each,
    4-8 s apart, stop at a 403/429). --dry-run prints the join and the change
    against what is stored without writing."""
    import random

    from elitetracker.sources.transfermarkt import load_values, update_values

    parts = [int(part) for part in args.season.split("-")]
    first, last = (parts[0], parts[0]) if len(parts) == 1 else parts
    for season in range(first, last + 1):
        by_league = {slug: load_matches(NORMALIZED_DIR / f"{slug}_{season}_matches.json")
                     for slug in ("eliteserien", "obosligaen")}
        if not all(by_league.values()):
            print(f"{season}: no fixture list for both divisions, skipped")
            continue
        if season > first:
            time.sleep(random.uniform(4.0, 8.0))
        stored = load_values().get(str(season), {})
        try:
            entries, unmatched = update_values(season, by_league, write=not args.dry_run)
        except FetchError as exc:
            print(f"{season}: {exc}")
            return 1
        clubs = {team for matches in by_league.values() for m in matches for team in (m.home_id, m.away_id)}
        print(f"{season}: {len(entries)} of {len(clubs)} clubs joined"
              + (f"; Transfermarkt names left over: {', '.join(unmatched)}" if unmatched else ""))
        for team_id, entry in sorted(entries.items(), key=lambda item: -item[1]["total"]):
            before = stored.get(team_id, {}).get("total")
            change = f"  (stored {before / 1e6:.2f}m)" if before else "  (new)"
            print(f"  {entry['league'][:4]} {entry['name']:<18} {entry['total'] / 1e6:7.2f}m{change}")
        if args.dry_run:
            print("  dry run: nothing written")
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
            part.brier_losses[match_id] = card.brier_losses[match_id]
            part.rps_losses[match_id] = card.rps_losses[match_id]
    return early, late


def market_comparison(score_from: int) -> int:
    """Elo alone, the shipped Elo + attack/defence blend and the closing line
    (de-vigged three ways), match by match, then quarter-Kelly staking on the
    shipped odds at the closing prices. Eliteserien only: the CSV has no OBOS."""
    slices = load_slices()
    seeds = {team_id: seed.rating for team_id, seed in seed_ratings().items()}
    dates = {m.match_id: m.date for s in slices for m in s.matches}
    shots = {k: tuple(v) for k, v in load_xg()["matches"].items()}
    elo, shipped = shipped_cards(slices, seeds, score_from_season=score_from, shots=shots,
                                 values=market_values(), league="eliteserien", stakes=stakes_table())
    matches = [m for s in slices for m in s.matches
               if s.league == "eliteserien" and int(m.date[:4]) >= score_from]
    prices = benchmark.load_prices()
    markets = benchmark.market_cards(prices, matches) if prices else {
        "proportional": benchmark.benchmark_card(benchmark.load_odds(), matches)}
    print(f"Scored from season {score_from}\n\n{elo.summary()}\n{shipped.summary()}")
    for card in markets.values():
        print(card.summary())
    pinnacle = markets["proportional"]
    print("\npaired per-match loss (negative = first is better):")
    for metric in ("log_loss", "brier", "rps"):
        print(f" {metric}")
        pairs = [(shipped, elo), (elo, pinnacle)] + [(shipped, market) for market in markets.values()]
        for card, other in pairs:
            n, mean, t = paired(card, other, metric)
            early_a, late_a = _halves(card, dates)
            early_b, late_b = _halves(other, dates)
            _, mean_early, t_early = paired(early_a, early_b, metric)
            _, mean_late, t_late = paired(late_a, late_b, metric)
            print(f"  {card.name:<22} vs {other.name:<20} n={n} d={mean:+.5f} t={t:+.2f}"
                  f"   early d={mean_early:+.5f} t={t_early:+.2f}   late d={mean_late:+.5f} t={t_late:+.2f}")
    if prices:
        order = sorted(shipped.predictions, key=lambda mid: dates[mid])
        print("\nquarter Kelly at the closing price (cap 2.5 % a bet; closing-line value needs"
              " pre-closing prices the CSV does not have):")
        for min_edge in (0.02, 0.03, 0.05):
            for card in (shipped, elo):
                k = benchmark.kelly(card, prices, order, min_edge=min_edge)
                print(f"  {card.name:<22} edge >= {min_edge:.0%}: {k['bets']} bets, hit {k['hit_rate']:.1%}, "
                      f"ROI {k['roi']:+.1%}, bankroll x{k['bankroll']:.3f}, max drawdown {k['max_drawdown']:.1%}")
    return 0


def calibration_payload(score_from: int = 2016, root=NORMALIZED_DIR) -> dict:
    """The Explore view's match-odds calibration (`viz=calibration`): the
    shipped odds' reliability over every scored match of both divisions, and
    the scores against the closing line, three ways de-vigged, on the
    Eliteserien matches it prices."""
    from elitetracker.model.elo import MODEL_VERSION

    slices = load_slices(root)
    seeds = {team_id: seed.rating for team_id, seed in seed_ratings(root).items()}
    shots = {k: tuple(v) for k, v in load_xg()["matches"].items()}
    scorelines: dict[tuple[int, int], list[float]] = {}
    elo, shipped = shipped_cards(slices, seeds, score_from_season=score_from, shots=shots, values=market_values(),
                                 scorelines=scorelines, stakes=stakes_table(root))
    dates = {m.match_id: m.date for s in slices for m in s.matches}
    league = {m.match_id: s.league for s in slices for m in s.matches}
    es = [m for s in slices for m in s.matches if s.league == "eliteserien" and int(m.date[:4]) >= score_from]
    prices = benchmark.load_prices()
    markets = benchmark.market_cards(prices, es) if prices else {}
    common = set(shipped.losses) & set.intersection(*(set(card.losses) for card in markets.values())) if markets else set()

    def scores(card: Scorecard) -> dict:
        return {"n": card.matches, "log_loss": round(card.log_loss, 5), "brier": round(card.brier, 5),
                "rps": round(card.rps, 5), "calibration": round(card.calibration_error(), 4)}

    model_es = restrict(shipped, common, "model")
    market = None
    if common:
        market = {"model": scores(model_es), "elo": scores(restrict(elo, common, "elo"))}
        for method, card in markets.items():
            market[method] = {**scores(restrict(card, common)), "paired_t": round(paired(model_es, card)[2], 2)}
    order = sorted(common, key=lambda mid: dates[mid])
    return {
        "version": MODEL_VERSION,
        "first_season": score_from,
        "last_season": max(int(dates[mid][:4]) for mid in shipped.losses),
        "scores": {
            "all": scores(shipped),
            **{lg: scores(restrict(shipped, {m for m in shipped.losses if league[m] == lg}))
               for lg in ("eliteserien", "obosligaen")},
        },
        "reliability": reliability(shipped),
        # Per scoreline (4 = 4 or more): the share of matches the model gave it
        # on average against the share that ended that way.
        "scorelines": [
            {"home": i, "away": j, "predicted": round(chance / shipped.matches, 5),
             "observed": round(count / shipped.matches, 5)}
            for (i, j), (chance, count) in sorted(scorelines.items())
        ] if shipped.matches else [],
        "market": market,
        "kelly": {key: (round(value, 4) if isinstance(value, float) else value)
                  for key, value in benchmark.kelly(model_es, prices, order).items()} if common else None,
    }


def cmd_run(args: argparse.Namespace) -> int:
    return market_comparison(args.score_from)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    odds = sub.add_parser("odds"); odds.add_argument("--refresh", action="store_true"); odds.set_defaults(func=cmd_odds)
    xg = sub.add_parser("xg"); xg.add_argument("--seasons", default="2020-2026"); xg.add_argument("--delay", type=float, default=4.0)
    xg.add_argument("--limit", type=int); xg.add_argument("--refresh", action="store_true", help="refetch matches already stored")
    xg.set_defaults(func=cmd_xg)
    obos = sub.add_parser("xg-obos"); obos.add_argument("--seasons", default="2023-2026")
    obos.add_argument("--delay", type=float, default=DEFAULT_DELAY)
    obos.set_defaults(func=cmd_xg_obos)
    run = sub.add_parser("run"); run.add_argument("--score-from", type=int, default=2022); run.set_defaults(func=cmd_run)
    values = sub.add_parser("market-values"); values.add_argument("--season", required=True, help="YYYY or YYYY-YYYY")
    values.add_argument("--dry-run", action="store_true"); values.set_defaults(func=cmd_market_values)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
