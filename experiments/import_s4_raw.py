"""Join browser-fetched raw Sofascore xG into xg_sofascore_es.json (S4).

Usage (repo root):  python experiments/import_s4_raw.py [raw.json] [--dry-run]
Default raw: ~/Downloads/xg_sofascore_es_raw.json.
Mirrors fetch_s4's join: per-season club-name stems + score check. An existing
with-xG entry is never downgraded by a raw row without xG.
"""
import json
import sys
from pathlib import Path

import fetch_s4  # noqa: F401  (runs the sys.path setup for src/ and experiments/)
from fetch_s4 import OUT, save, SEASON_IDS_ES
from eval_harness import load_matches
import elitetracker.sources.sofascore as sc

_MISSING = object()

# Sofascore club names that don't match fotmob's after _key; maps raw-key -> our-key.
ALIASES = {"hamkam": "hamarkameratene"}


def main() -> int:
    dry = "--dry-run" in sys.argv
    args = [a for a in sys.argv[1:] if a != "--dry-run"]
    raw_path = (Path(args[0]) if args
                else Path.home() / "Downloads" / "xg_sofascore_es_raw.json")
    if not raw_path.exists():
        print(f"no raw file at {raw_path}")
        return 1
    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    stored = (json.loads(OUT.read_text())["matches"] if OUT.exists() else {})
    played = [m for m in load_matches()
              if m.played and int(m.date[:4]) >= 2020]

    by_season: dict = {}

    def pair_index(season: int):
        if season not in by_season:
            ms = [m for m in played if int(m.date[:4]) == season]
            idx = {(sc._key(m.home), sc._key(m.away)): m for m in ms}
            if len(idx) != len(ms):
                print(f"{season}: club names collide after normalisation, aborting")
                raise SystemExit(1)
            by_season[season] = idx
        return by_season[season]

    added = changed = same = mismatch = nofixture = 0
    examples = []
    for ev_id, row in raw.items():
        season = int(row["y"])
        key = tuple(ALIASES.get(k, k) for k in
                    (sc._key(row["h"]), sc._key(row["a"])))
        match = pair_index(season).get(key)
        if match is None:
            nofixture += 1
            if len(examples) < 5:
                examples.append(f"{ev_id} {row['h']} v {row['a']}")
            continue
        if (match.home_goals, match.away_goals) != (row["hg"], row["ag"]):
            mismatch += 1
            # e.g. 2025-11-22 Valerenga-Kristiansund: pitch 3-3, ruled 3-0
            print(f"  score-mismatch {match.match_id} {match.date}: "
                  f"ours {match.home_goals}-{match.away_goals}, "
                  f"raw {row['hg']}-{row['ag']} - skipped")
            continue
        xg = row.get("xg")
        new = [xg[0], xg[1]] if (xg and xg[0] is not None
                                 and xg[1] is not None) else None
        prev = stored.get(match.match_id, _MISSING)
        if new is None and prev is not _MISSING and prev is not None:
            same += 1  # keep the existing with-xG entry
            continue
        if prev == new:
            same += 1
        else:
            stored[match.match_id] = new
            added += 1 if prev is _MISSING else 0
            changed += 0 if prev is _MISSING else 1

    print(f"raw rows: {len(raw)} | joined: {added + changed + same} "
          f"(new {added}, changed {changed}, same {same}) | "
          f"score-mismatch: {mismatch} | no-fixture: {nofixture}")
    for ex in examples:
        print(f"  unmatched: {ex}")

    print(f"{'season':>6} {'matches':>7} {'stored':>7} {'null':>5} "
          f"{'with-xg':>7} {'missing':>7}")
    for y in sorted({int(m.date[:4]) for m in played}):
        ms = [m for m in played if int(m.date[:4]) == y]
        have = [m for m in ms if m.match_id in stored]
        print(f"{y:>6} {len(ms):>7} {len(have):>7} "
              f"{sum(1 for m in have if stored[m.match_id] is None):>5} "
              f"{sum(1 for m in have if stored[m.match_id] is not None):>7} "
              f"{len(ms) - len(have):>7}")

    if dry:
        print("dry-run: not written")
        return 0
    save({"matches": stored})
    print(f"wrote {OUT} ({len(stored)} entries)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
