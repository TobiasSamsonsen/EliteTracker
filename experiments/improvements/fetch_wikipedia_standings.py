"""Manual, opt-in backfill of Norwegian final tables before 2016 from Wikipedia's rendered
season pages (docs/data.md, "Scraping rules": one request at a time, a jittered 4-8 s wait,
every page saved as it arrives, a rerun skips saved pages, honest headers, stop at the first
403 or 429). Standard library only. Raw HTML goes to data/raw/wikipedia_standings/.

    .venv/Scripts/python experiments/improvements/fetch_wikipedia_standings.py [--from 1963] [--to 2015]

Top tier: 1963-1989 "N Norwegian First Division", 1990-2016 "N Tippeligaen". Second tier,
one table: 1991- "N Norwegian First Division" (1963-1990 "Norwegian Second Division" was
split into groups and is not fetched).
"""
import json, random, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "data" / "raw" / "wikipedia_standings"
UA = {"User-Agent": "EliteTrackerResearch/1.0 (personal football-rating research; one request at a time)"}

def title(tier, year):
    if tier == 1:
        return f"{year} Norwegian First Division" if year <= 1989 else (f"{year} Tippeligaen" if year <= 2016 else f"{year} Eliteserien")
    return f"{year} Norwegian First Division" if year >= 1991 else None

def main():
    args = sys.argv[1:]
    lo = int(args[args.index("--from") + 1]) if "--from" in args else 1963
    hi = int(args[args.index("--to") + 1]) if "--to" in args else 2015
    OUT.mkdir(parents=True, exist_ok=True)
    jobs = [(t, y) for y in range(lo, hi + 1) for t in (1, 2) if title(t, y)]
    done = 0
    for tier, year in jobs:
        path = OUT / f"tier{tier}_{year}.html"
        if path.exists():
            continue
        url = "https://en.wikipedia.org/w/api.php?" + urllib.parse.urlencode(
            dict(action="parse", page=title(tier, year), prop="text", redirects=1, format="json", formatversion=2))
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                body = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (403, 429):
                print(f"STOP: HTTP {e.code} at {title(tier, year)}", flush=True); return 1
            print(f"skip {title(tier, year)}: HTTP {e.code}", flush=True); time.sleep(random.uniform(4, 8)); continue
        if "parse" not in body:
            print(f"skip {title(tier, year)}: {body.get('error', {}).get('info')}", flush=True)
        else:
            path.write_text(body["parse"]["text"], encoding="utf-8"); done += 1
            print(f"saved {path.name} ({title(tier, year)})", flush=True)
        time.sleep(random.uniform(4, 8))
    print(f"done, {done} new pages")
    return 0

if __name__ == "__main__":
    sys.exit(main())
