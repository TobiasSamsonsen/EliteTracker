"""Card events (minute, side, type) for the matches data/raw/fotmob_match_extras.json
does not cover: Eliteserien 2015-2019 and 2026's later rounds, OBOS-ligaen 2015-2026.
For the red-card re-test (red_cards_v18.py), November 2026.

A manual, opt-in backfill by the scraping rules (docs/data.md): fotmob's
matchDetails, one request at a time, a jittered 4-8 s wait, the file saved after
every match, a stop at the first 403 or 429. Matches already stored are skipped,
so it resumes where it stopped. The November 2026 run used a 4-8 s wait for its
first 495 matches and `--delay 2` (2-4 s) for the rest, on the owner's call.

    .venv/Scripts/python experiments/improvements/fetch_red_cards.py [--limit N] [--ids ID ...]

Output data/raw/fotmob_match_cards.json: {"matches": {id: {"cards": [[minute,
side, type], ...], "goals": n goal events}}, "none": [ids without events]}.
"none" holds matches with goals on the scoreboard but no goal events (no event
data, so an empty card list would be a guess).
"""
import argparse, json, random, sys, time
from pathlib import Path

from elitetracker.pipeline import load_slices
from elitetracker.sources.fotmob import FetchError, fetch_match_payload

OUT = Path("data/raw/fotmob_match_cards.json")
EXTRAS = Path("data/raw/fotmob_match_extras.json")


def parse_cards(data: dict) -> tuple[list, int]:
    facts = (data.get("content") or {}).get("matchFacts") or {}
    home_team = str((data.get("general") or {}).get("homeTeam", {}).get("id"))
    cards, goals = [], 0
    for ev in ((facts.get("events") or {}).get("events")) or []:
        if not isinstance(ev, dict):
            continue
        if ev.get("type") == "Goal":
            goals += 1
        if ev.get("type") != "Card":
            continue
        home = bool(ev["isHome"]) if ev.get("isHome") is not None else str(ev.get("teamId")) == home_team
        cards.append([int(ev.get("time") or 0), 0 if home else 1, ev.get("card")])
    return cards, goals


def load() -> dict:
    return json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {"matches": {}, "none": []}


def save(data: dict) -> None:
    OUT.write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int)
    ap.add_argument("--delay", type=float, default=4.0)
    ap.add_argument("--ids", nargs="*", help="fetch and print these, store nothing")
    args = ap.parse_args()
    if args.ids:
        for i, mid in enumerate(args.ids):
            if i:
                time.sleep(random.uniform(args.delay, 2 * args.delay))
            print(mid, parse_cards(fetch_match_payload(mid)))
        return 0
    extras = set(json.loads(EXTRAS.read_text(encoding="utf-8")))
    data = load()
    done = set(data["matches"]) | set(data["none"]) | extras
    todo = [m for s in load_slices() for m in s.matches
            if m.played and m.match_id not in done and (s.league == "obosligaen" or s.season < 2020 or s.season == 2026)]
    todo.sort(key=lambda m: m.date)
    print(f"{len(todo)} matches to fetch ({len(data['matches'])} stored, {len(data['none'])} without events)", flush=True)
    for index, m in enumerate(todo[: args.limit] if args.limit else todo, 1):
        if index > 1:
            time.sleep(random.uniform(args.delay, 2 * args.delay))
        try:
            cards, goals = parse_cards(fetch_match_payload(m.match_id))
        except FetchError as exc:
            if "HTTP 403" in str(exc) or "HTTP 429" in str(exc):
                print(f"  stopping at {m.match_id}: {exc}", flush=True)
                return 1
            print(f"  skipped {m.match_id}: {exc}", flush=True)
            continue
        if goals == 0 and m.home_goals + m.away_goals > 0:
            data["none"].append(m.match_id)
        else:
            data["matches"][m.match_id] = {"cards": cards, "goals": goals}
        save(data)
        if index % 50 == 0:
            print(f"  {index}/{len(todo)} ({m.date})", flush=True)
    print(f"done: {len(data['matches'])} stored, {len(data['none'])} without events", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
