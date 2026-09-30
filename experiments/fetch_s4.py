"""Fetch Sofascore xG for Eliteserien 2020-2026 (S4, TEST_PLAN addendum).

Resumable: stored ids are skipped unless played within STALE_DAYS (Sofascore
revises xG shortly after a fixture -- same rule the fotmob pull uses).
The list endpoint's has_xg flag is unreliable for ES and must not gate the
statistics call (addendum, verified 2026-09-29). Stops on 403.
"""
import json
import sys
import time
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, "src")
sys.path.insert(0, "experiments")

from curl_cffi import requests as creq
import elitetracker.sources.sofascore as sc

SEASON_IDS_ES = {2020: 26799, 2021: 35403, 2022: 40405, 2023: 47806,
                 2024: 57322, 2025: 70174, 2026: 87809}
OUT = Path(__file__).parent / "data" / "xg_sofascore_es.json"
DELAY = 3.0  # 2026-09-29: WAF rate-blocked us at ~1.8s/request; back off (addendum floor 1.5)
STALE_DAYS = 2

_SAFARI_HEADERS = {
    "Referer": "https://www.sofascore.com/",
    "Origin": "https://www.sofascore",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
}


def _safari_dl(url: str) -> str:
    """safari17_0 passes the WAF; every Chrome profile 403s (probed 2026-09-29)."""
    try:
        r = creq.get(url, headers=_SAFARI_HEADERS, timeout=30,
                     impersonate="safari17_0")
    except Exception as exc:  # timeouts/network surface as FetchError downstream
        raise sc.FetchError(f"{url} unreachable: {exc}") from exc
    if r.status_code == 404:  # event_xg maps messages containing this to None
        raise sc.FetchError(f"{url} returned HTTP 404 (no statistics)")
    if r.status_code in (403, 429):
        raise sc.FetchError(f"{url} returned HTTP {r.status_code} (stop)")
    if r.status_code >= 400:
        raise sc.FetchError(f"{url} HTTP {r.status_code} ({r.reason})")
    return r.text


sc._download_sofascore = _safari_dl
sc.TOURNAMENT_ID = 20
sc.SEASON_IDS = SEASON_IDS_ES

from eval_harness import load_matches  # noqa: E402  (experiments/ on sys.path)


def save(data: dict) -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, indent=1, sort_keys=True))


def main() -> int:
    played = [m for m in load_matches() if m.played and int(m.date[:4]) >= 2020]
    stored = {}
    if OUT.exists():
        stored = json.loads(OUT.read_text())["matches"]
    stale = (date.today() - timedelta(days=STALE_DAYS)).isoformat()
    fetched = no_xg = skipped = 0

    for season in sorted(SEASON_IDS_ES):
        season_matches = [m for m in played if int(m.date[:4]) == season]
        by_pair = {(sc._key(m.home), sc._key(m.away)): m for m in season_matches}
        if len(by_pair) != len(season_matches):
            print(f"{season}: club names collide after normalisation, aborting")
            return 1
        try:
            events = sc.season_events(season, delay=DELAY)
        except sc.FetchError as exc:
            print(f"STOP at {season} fixture list: {exc}")
            save({"matches": stored})
            return 1
        print(f"{season}: {len(events)} finished fixtures / "
              f"{len(season_matches)} normalized matches", flush=True)

        for event in events:
            match = by_pair.get((sc._key(event["home"]), sc._key(event["away"])))
            if match is None:
                print(f"  no fixture for {event['home']} v {event['away']}")
                continue
            if (match.home_goals, match.away_goals) != (event["home_goals"],
                                                        event["away_goals"]):
                print(f"  score mismatch {match.match_id}, skipped")
                continue
            if match.match_id in stored and match.date <= stale:
                skipped += 1
                continue
            t0 = time.time()
            try:
                xg = sc.event_xg(event["id"])  # always called; has_xg not trusted
            except sc.FetchError as exc:
                if "403" in str(exc) or "429" in str(exc):
                    print(f"STOP at {match.match_id}: {exc}", flush=True)
                    save({"matches": stored})
                    return 1
                print(f"  xG {match.match_id} skipped: {exc}", flush=True)
                continue
            dt = time.time() - t0
            if xg is None:
                stored[match.match_id] = None  # confirmed absent; resume skips
                no_xg += 1
            else:
                stored[match.match_id] = [xg[0], xg[1]]
                fetched += 1
            save({"matches": stored})  # tiny file; durable progress per fixture
            print(f"  {len(stored)} stored {match.date} {xg} ({dt:.1f}s)",
                  flush=True)
            time.sleep(DELAY)
        save({"matches": stored})

    print(f"done: {fetched} fetched, {no_xg} without xG, {skipped} already "
          f"stored; file holds {len(stored)} entries")
    return 0


if __name__ == "__main__":
    sys.exit(main())
