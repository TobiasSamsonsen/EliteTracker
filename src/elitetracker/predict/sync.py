"""The hourly Predict job (docs/predict-plan.md, section 4), as one function.

``run`` reads the normalized fixtures and the published report, talks to
Firestore through a store (sources.firestore.Firestore, or a fake in the
tests), and writes:

  Firestore  fixtures/*, tablegames/*   what the browser may pick and when it locks
             stats/{uid}, boards/*      scores and leaderboards
             meta/sync                  what has been done, so a run is idempotent
  git        data/predict/locked_odds.json   the model's odds as published at kick-off
             data/predict/crowd.json         anonymous per-match aggregates, n >= 5
  site       public/predict/rounds.ics       the "round closes" calendar feed

Reads are the scarce resource on the free plan (50,000 a day), so a round's
entries are fetched only when something new needs them: a match has kicked off
(crowd aggregate) or another has settled (scores). Scores are recomputed for a
whole round and *set*, never incremented, so a run that dies half way is simply
repeated.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

from elitetracker.model import crowd as crowd_model
from elitetracker.model.table import table_from_matches
from elitetracker.normalize.matches import Match
from elitetracker.predict import boards as boards_mod
from elitetracker.predict import nicknames, tables
from elitetracker.predict.curve import CURVE_VERSION
from elitetracker.predict.ics import calendar
from elitetracker.predict.scoring import MIN_CROWD, outcome, score_round
from elitetracker.sources.firestore import FirestoreError, Write

LEAGUES = ("eliteserien", "obosligaen")
MAX_SLOTS = 8                       # the rules know slots s1..s8
OPENS_BEFORE = timedelta(days=7)    # a round opens a week before its first kick-off
SNAPSHOT_AHEAD = timedelta(hours=3)  # keep the model's odds fresh for matches about to start
INACTIVE_AFTER = timedelta(days=730)  # 24 months
HOUR = 3600.0


def round_key(season: int, slug: str, rnd: int) -> str:
    return f"{season}_{slug}_{rnd}"


def kickoff_of(match: Match) -> datetime | None:
    if not match.kickoff_utc:
        return None
    return datetime.fromisoformat(match.kickoff_utc.replace("Z", "+00:00"))


def _digest(doc: Mapping) -> str:
    return hashlib.sha1(json.dumps(doc, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]


def _match_order(match: Match) -> tuple:
    return (0, int(match.match_id)) if match.match_id.isdigit() else (1, match.match_id)


# ---- fixtures and the table game -------------------------------------------

def build_fixtures(matches_by_slug: Mapping[str, Sequence[Match]], season: int) -> dict[str, dict]:
    """fixtures/{season}_{league}_{round}: the round's matches in stable slots.

    Slot s1..s8 follow the match id, not the kick-off, so a postponed match
    keeps its slot and a pick made for it still points at the same game."""
    docs: dict[str, dict] = {}
    for slug, matches in matches_by_slug.items():
        by_round: dict[int, list[Match]] = {}
        for match in matches:
            if match.round is not None and kickoff_of(match) is not None:
                by_round.setdefault(match.round, []).append(match)
        for rnd, group in by_round.items():
            group = sorted(group, key=_match_order)[:MAX_SLOTS]
            first = min(kickoff_of(m) for m in group)
            docs[round_key(season, slug, rnd)] = {
                "season": season, "league": slug, "round": rnd,
                "opens": first - OPENS_BEFORE, "closes": first,
                "slots": {f"s{i + 1}": {"id": m.match_id, "home": m.home, "away": m.away, "home_id": m.home_id,
                                         "away_id": m.away_id, "kickoff": kickoff_of(m)}
                          for i, m in enumerate(group)}}
    return docs


def build_tablegames(matches_by_slug: Mapping[str, Sequence[Match]], season: int, now: datetime,
                     opened: Mapping[str, Any]) -> dict[str, dict]:
    """tablegames/{season}_{league}: open from the day the season's fixtures
    exist until its first kick-off, while nothing has been played."""
    docs: dict[str, dict] = {}
    for slug, matches in matches_by_slug.items():
        kicks = [kickoff_of(m) for m in matches if kickoff_of(m)]
        if not kicks or any(m.played for m in matches) or min(kicks) <= now:
            continue
        key = f"{season}_{slug}"
        names: dict[str, str] = {}
        for m in matches:
            names[m.home_id], names[m.away_id] = m.home, m.away
        started = opened.get(key)
        docs[key] = {"season": season, "league": slug, "opens": started if isinstance(started, datetime) else now,
                     "closes": min(kicks), "clubs": sorted(names), "names": dict(sorted(names.items()))}
    return docs


def rounds_index(docs: Mapping[str, dict], season: int) -> dict:
    """meta/rounds: one small public document that lists the season's rounds, so a
    page load needs one read instead of the whole fixtures collection."""
    rounds = [{"key": key, "league": d["league"], "round": d["round"], "opens": d["opens"], "closes": d["closes"],
               "last": max(v["kickoff"] for v in d["slots"].values()), "n": len(d["slots"])} for key, d in sorted(docs.items(), key=lambda kv: (kv[1]["round"], kv[1]["league"]))]
    return {"season": season, "rounds": rounds}


def reveal_doc(doc: Mapping, by_id: Mapping[str, Match], snaps: Mapping, crowd_file: Mapping, now: datetime) -> dict:
    """reveal/{key}: what a player may see once a match has kicked off: the model's
    odds as published at kick-off, the crowd's aggregate (n >= 5) and the result."""
    matches = {}
    for slot, info in doc["slots"].items():
        if info["kickoff"] > now:
            continue
        match = by_id[info["id"]]
        entry: dict[str, Any] = {"id": info["id"]}
        if info["id"] in snaps:
            entry["model"] = {k: snaps[info["id"]][k] for k in ("h", "d", "a", "v")}
        published = crowd_file.get(info["id"], {})
        if published.get("n"):
            entry["crowd"] = {k: published[k] for k in ("n", "h", "d", "a", "med") if k in published}
        if match.played and match.home_goals is not None:
            entry["result"] = {"hg": match.home_goals, "ag": match.away_goals}
        matches[slot] = entry
    return {"season": doc["season"], "league": doc["league"], "round": doc["round"], "matches": matches}


# ---- files in git ------------------------------------------------------------

def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def _save(path: Path, data: Mapping) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=1, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def report_odds(report: Mapping) -> dict[str, dict]:
    """match id -> the model's published odds for every fixture in the report."""
    found: dict[str, dict] = {}
    for slug in LEAGUES:
        block = report.get(slug) or {}
        version = (block.get("model") or {}).get("version")
        for fixture in block.get("fixtures", []):
            found[str(fixture["match_id"])] = {"h": fixture["home_win"], "d": fixture["draw"], "a": fixture["away_win"],
                                               "v": version}
    return found


# ---- the run ------------------------------------------------------------------

def _entries(store: Any, key: str) -> dict[str, dict]:
    """uid -> the entry's slot map, for one round."""
    found = {}
    for path, data in store.query_group("rounds", "r", key):
        found[path.split("/")[1]] = data.get("p", {})
    return found


def _utc(value: Any) -> datetime | None:
    return value.astimezone(timezone.utc) if isinstance(value, datetime) else None


def run(store: Any, *, now: datetime, matches_by_slug: Mapping[str, Sequence[Match]], season: int,
        report: Mapping, data_dir: Path, ics_path: Path | None = None, purge: bool = True,
        dry_run: bool = False) -> dict:
    summary: dict[str, Any] = {"fixtures": 0, "snapshots": 0, "rounds": [], "scored_players": 0, "boards": [],
                               "purged": [], "unscorable": [], "warnings": []}
    writes: list[Write] = []
    meta = store.get("meta/sync") or {}
    known = dict(meta.get("fixtures", {}))
    scored = dict(meta.get("scored", {}))
    revealed = dict(meta.get("revealed", {}))

    # 1. what the browser may pick: fixtures and the table game
    docs = build_fixtures(matches_by_slug, season)
    for key, doc in docs.items():
        digest = _digest(doc)
        if known.get(key) != digest:
            writes += [Write.set(f"fixtures/{key}", doc), Write.merge("meta/sync", {"fixtures": {key: digest}})]
            summary["fixtures"] += 1
    tablegames = build_tablegames(matches_by_slug, season, now, meta.get("tablegames", {}))
    if summary["fixtures"] or not meta.get("indexed"):
        writes += [Write.set("meta/rounds", rounds_index(docs, season)), Write.merge("meta/sync", {"indexed": True})]
    for key, doc in tablegames.items():
        digest = _digest(doc)
        if known.get(f"table_{key}") != digest:
            writes += [Write.set(f"tablegames/{key}", doc),
                       Write.merge("meta/sync", {"fixtures": {f"table_{key}": digest}, "tablegames": {key: doc["opens"]}})]

    # 2. the model's odds as published, kept until each match kicks off
    snaps = _load(data_dir / "locked_odds.json")
    published = report_odds(report)
    for doc in docs.values():
        for slot in doc["slots"].values():
            if now < slot["kickoff"] <= now + SNAPSHOT_AHEAD and slot["id"] in published:
                snaps[slot["id"]] = {**published[slot["id"]], "at": now.isoformat(timespec="seconds")}
                summary["snapshots"] += 1
    crowd_file = _load(data_dir / "crowd.json")
    locked_tables = _load(data_dir / "locked_tables.json")
    for key in tablegames:                      # the model's expected table, kept fresh until the game closes
        order = report_table_order(report, key.split("_", 1)[1])
        if order:
            locked_tables[key] = order

    # 3. deletion requests first: a request removes the account before anything is scored
    stripped: set[str] = set()
    if purge:
        for uid, _ in store.list("deleteRequests"):
            writes += purge_user(store, uid)
            stripped.add(boards_mod.uid_hash(uid))
            summary["purged"].append(uid)

    # 4. rounds with something new: crowd aggregates for matches that kicked off, scores for those settled
    by_id = {m.match_id: m for ms in matches_by_slug.values() for m in ms}
    rounds_info: dict[str, list[dict]] = {slug: [] for slug in matches_by_slug}
    model_rounds = dict(meta.get("model_rounds", {}))
    crowd_rounds = dict(meta.get("crowd_rounds", {}))
    meta_updates: dict[str, Any] = {}
    changed_scores = bool(stripped)
    fresh: dict[str, dict] = {}     # uid -> {round key: totals} written in this run, not yet in the store
    for key, doc in sorted(docs.items(), key=lambda kv: (kv[1]["league"], kv[1]["round"])):
        slots = doc["slots"]
        kicked = {s: v for s, v in slots.items() if v["kickoff"] <= now}
        settled = {s: v for s, v in kicked.items() if by_id[v["id"]].played and v["id"] in snaps
                   and by_id[v["id"]].home_goals is not None}
        summary["unscorable"] += [v["id"] for s, v in kicked.items() if by_id[v["id"]].played and v["id"] not in snaps]
        if settled or scored.get(key):
            rounds_info[doc["league"]].append({"key": key, "round": doc["round"], "matches": len(slots),
                                               "settled": max(len(settled), scored.get(key, 0))})
        new_crowd = [s for s, v in kicked.items() if v["id"] not in crowd_file]
        played = [s for s, v in kicked.items() if by_id[v["id"]].played]
        if not new_crowd and len(settled) <= scored.get(key, 0) and len(played) <= revealed.get(key, 0):
            continue
        try:
            entries = _entries(store, key)
        except FirestoreError as error:
            # The collection-group index (firestore.indexes.json) is not deployed yet. A dry run
            # carries on with no entries; a live run must not mistake "no players" for "none picked".
            if not (dry_run and error.status == 400 and "index" in str(error).lower()):
                raise
            warning = "the collection-group index on rounds.r is not deployed (firestore.indexes.json)"
            if warning not in summary["warnings"]:
                summary["warnings"].append(warning)
            entries = {}
        summary["rounds"].append(key)

        for slot in new_crowd:
            match_id = slots[slot]["id"]
            picks = [p[slot] for p in entries.values() if slot in p]
            if len(picks) < MIN_CROWD:
                crowd_file[match_id] = {"hidden": True}
                continue
            n = len(picks)
            entry = {"n": n, "v": CURVE_VERSION,
                     "h": round(sum(p["h"] for p in picks) / n, 1), "d": round(sum(p["d"] for p in picks) / n, 1),
                     "a": round(sum(p["a"] for p in picks) / n, 1)}
            model = snaps.get(match_id)
            if model:
                kick = slots[slot]["kickoff"]
                rows = [(p["g"], max(0.0, (kick - (_utc(p["t"]) or kick)).total_seconds() / 86400.0)) for p in picks]
                entry["delta"] = round(crowd_model.signal(model["h"], model["d"], rows), 2)
                entry["model"] = model.get("v")
            crowd_file[match_id] = entry

        if len(settled) > scored.get(key, 0):
            matches = [{"slot": s, "result": outcome(by_id[v["id"]].home_goals, by_id[v["id"]].away_goals),
                        "model": (snaps[v["id"]]["h"], snaps[v["id"]]["d"], snaps[v["id"]]["a"])}
                       for s, v in sorted(settled.items())]
            picks = {uid: {s: (p[s]["h"], p[s]["d"], p[s]["a"]) for s in p if s in slots} for uid, p in entries.items()}
            result = score_round(picks, matches)
            for slot, detail in result["per_match"].items():        # the field's median, published once n >= 5
                entry = crowd_file.get(slots[slot]["id"])
                if entry and entry.get("n", 0) >= MIN_CROWD:
                    entry["med"] = {"b": round(detail["median_brier"], 5), "r": round(detail["median_rps"], 5)}
            for uid, totals in result["players"].items():
                latest = max((_utc(p[s]["t"]) for p in [entries[uid]] for s in p if _utc(p[s].get("t"))), default=None)
                data = {"rounds": {key: {**{k: (round(v, 5) if isinstance(v, float) else v) for k, v in totals.items()},
                                         "m": len(slots)}}}
                if latest:
                    data["last"] = latest
                writes.append(Write.merge(f"stats/{uid}", data))
                fresh.setdefault(uid, {})[key] = data["rounds"][key]
            summary["scored_players"] += len(result["players"])
            meta_updates.setdefault("scored", {})[key] = len(settled)
            meta_updates.setdefault("model_rounds", {})[key] = _rounded(result["model"])
            meta_updates.setdefault("crowd_rounds", {})[key] = _rounded(result["crowd"])
            model_rounds[key], crowd_rounds[key] = _rounded(result["model"]), _rounded(result["crowd"])
            scored[key] = len(settled)
            changed_scores = True
        writes.append(Write.set(f"reveal/{key}", reveal_doc(doc, by_id, snaps, crowd_file, now)))
        meta_updates.setdefault("revealed", {})[key] = len(played)
    for info_list in rounds_info.values():
        info_list.sort(key=lambda r: r["round"])

    # 4b. the pre-season table game, once a division's season is complete
    tabled = dict(meta.get("tabled", {}))
    for slug, league_matches in matches_by_slug.items():
        key = f"{season}_{slug}"
        truth = final_order(league_matches)
        if truth is None or tabled.get(key):
            continue
        if sorted(locked_tables.get(key, [])) != sorted(truth):
            summary["unscorable"].append(f"table:{key}")      # no locked model table for this season
            continue
        picks = {path.split("/")[1]: data["order"] for path, data in store.query_group("picks", "r", key)
                 if sorted(data.get("order", [])) == sorted(truth)}
        plan = tables.bonus_plan(slug, ((report.get(slug) or {}).get("league") or {}).get("bands", []))
        result = tables.score_tables(picks, truth, locked_tables[key], plan)
        writes += _table_results(store, key, result, now, set(summary["purged"]))
        meta_updates.setdefault("tabled", {})[key] = True
        summary["tables"] = summary.get("tables", []) + [key]

    # 5. leaderboards (only this season's: an earlier season's board is frozen as it was last built)
    if changed_scores:
        writes += _boards(store, season, matches_by_slug, rounds_info, model_rounds, crowd_rounds, now, summary,
                          fresh, set(summary["purged"]))
    if stripped:
        writes += _strip_boards(store, stripped)

    # 6. the oldest accounts, once a day
    today = now.date().isoformat()
    if purge and meta.get("swept") != today:
        meta_updates["swept"] = today
        for uid in _inactive(store, now):
            writes += purge_user(store, uid, keep_board_rows=True)
            summary["purged"].append(uid)

    if meta_updates:
        writes.append(Write.merge("meta/sync", meta_updates))

    if ics_path is not None and not dry_run:
        ics_path.parent.mkdir(parents=True, exist_ok=True)
        ics_path.write_text(calendar(docs.values(), now), encoding="utf-8", newline="")
    if not dry_run:
        store.commit(writes)
        _save(data_dir / "locked_odds.json", snaps)
        _save(data_dir / "crowd.json", crowd_file)
        if locked_tables:
            _save(data_dir / "locked_tables.json", locked_tables)
    summary["writes"] = len(writes)
    return summary


def report_table_order(report: Mapping, slug: str) -> list[str]:
    """The model's expected final table from the report: club ids by mean points, best first."""
    rows = (report.get(slug) or {}).get("table", [])
    return [str(r["team_id"]) for r in sorted(rows, key=lambda r: -r.get("mean_points", r.get("expected_points", 0)))]


def final_order(matches: Sequence[Match]) -> list[str] | None:
    """The final table's club ids, or None until every match of the season is played
    (the play-offs do not move places)."""
    if not matches or any(not m.played for m in matches):
        return None
    return [row.team_id for row in table_from_matches(list(matches))]


def _rounded(totals: Mapping) -> dict:
    return {k: (round(v, 5) if isinstance(v, float) else v) for k, v in totals.items()}


# ---- boards, mini-leagues, retention ----------------------------------------------

def _boards(store: Any, season: int, matches_by_slug: Mapping, rounds_info: Mapping[str, list],
            model_rounds: Mapping, crowd_rounds: Mapping, now: datetime, summary: dict,
            fresh: Mapping[str, Mapping], gone: set[str]) -> list[Write]:
    """The writes for this season's boards. ``fresh`` holds the totals scored in
    this run and ``gone`` the players purged in it: neither is in the store yet."""
    users = {uid: u for uid, u in store.list("users") if uid not in gone}
    stats = {uid: s for uid, s in store.list("stats") if uid not in gone}
    for uid, rounds in fresh.items():
        stats.setdefault(uid, {}).setdefault("rounds", {}).update(rounds)
    reports: dict[str, set] = {}
    for _, report in store.list("reports"):
        reports.setdefault(report.get("nickLower", ""), set()).add(report.get("by"))
    updated = now.isoformat(timespec="seconds")
    writes: list[Write] = []

    def shown(user: Mapping) -> tuple[str, bool]:
        nick = user.get("nick", "")
        flagged = nicknames.blocked(nick) or len(reports.get(nicknames.lower(nick), ())) >= nicknames.REPORTS_TO_HIDE
        return ("" if flagged else nick), bool(user.get("hidden")) or flagged or not nick

    for slug in matches_by_slug:
        prefix = f"{season}_{slug}_"
        players = {}
        for uid, s in stats.items():
            mine = {k: v for k, v in s.get("rounds", {}).items() if k.startswith(prefix)}
            if mine:
                nick, hidden = shown(users.get(uid, {}))
                players[uid] = {"nick": nick, "hidden": hidden, "rounds": mine}
        league_rounds = rounds_info.get(slug, [])
        made = boards_mod.build_season_boards(
            season, slug, players, rounds=league_rounds,
            model_rounds={k: v for k, v in model_rounds.items() if k.startswith(prefix)},
            crowd_rounds={k: v for k, v in crowd_rounds.items() if k.startswith(prefix)}, updated=updated)
        for board_id, board in made.items():
            writes.append(Write.set(f"boards/{board_id}", board))
            summary["boards"].append(board_id)

    # mini-leagues: one board per league over both divisions this season
    this_season = f"{season}_"
    for code, league in store.list("leagues"):
        members = [uid for uid, _ in store.list(f"leagues/{code}/members") if uid not in gone]
        rows = []
        for uid in members:
            s = stats.get(uid, {})
            mine = [v for k, v in s.get("rounds", {}).items() if k.startswith(this_season)]
            nick, hidden = shown(users.get(uid, {}))
            rows.append({"uid": uid, "nick": nick, "hidden": False if nick else True, "totals": boards_mod.combine(mine)})
        board = boards_mod.make_board("league", rows, model=None, crowd=None, updated=updated,
                                      extra={"season": season, "name": league.get("name", "")})
        writes.append(Write.set(f"boards/league_{code}", board))
        summary["boards"].append(f"league_{code}")
    return writes


def _table_results(store: Any, key: str, result: Mapping, now: datetime, gone: set[str]) -> list[Write]:
    """stats/{uid}.tables.{key} for every player and one board: tables_{key}."""
    users = {uid: u for uid, u in store.list("users") if uid not in gone}
    writes, rows = [], []
    for uid, score in result["players"].items():
        if uid in gone:
            continue
        writes.append(Write.merge(f"stats/{uid}", {"tables": {key: {"error": score["error"],
                                                                  "accuracy": round(score["accuracy"], 4)}}}))
        user = users.get(uid, {})
        nick = user.get("nick", "")
        if nick and not user.get("hidden") and not nicknames.blocked(nick):
            rows.append({"u": boards_mod.uid_hash(uid), "nick": nick, "kind": "player", "error": score["error"],
                         "accuracy": round(score["accuracy"], 4)})
    rows.append({"u": "model", "nick": boards_mod.MODEL_NAME, "kind": "model", "error": result["model"]["error"],
                 "accuracy": round(result["model"]["accuracy"], 4)})
    rows.sort(key=lambda r: (-r["accuracy"], r["error"], r["u"]))
    for rank, row in enumerate(rows[:boards_mod.ROW_LIMIT], 1):
        row["rank"] = rank
    writes.append(Write.set(f"boards/tables_{key}", {"scope": "tables", "key": key,
                                                      "updated": now.isoformat(timespec="seconds"),
                                                      "players": len(result["players"]), "median": result["median"],
                                                      "rows": rows[:boards_mod.ROW_LIMIT]}))
    return writes


def _strip_boards(store: Any, hashes: set[str]) -> list[Write]:
    """Remove a deleted player's rows from every board, past seasons included."""
    writes = []
    for board_id, board in store.list("boards"):
        rows = [r for r in board.get("rows", []) if r.get("u") not in hashes]
        if len(rows) != len(board.get("rows", [])):
            for rank, row in enumerate(rows, 1):
                row["rank"] = rank
            writes.append(Write.set(f"boards/{board_id}", {**board, "rows": rows}))
    return writes


def purge_user(store: Any, uid: str, keep_board_rows: bool = False) -> list[Write]:
    """Every document of one player: entries, table picks, profile, nickname claim,
    stats, mini-league memberships. (The Firebase Auth account is deleted by the
    browser for a request, and by an admin step for an inactive account.) Rows on
    the boards are left for ``keep_board_rows`` (the final season scores stay)."""
    writes = []
    user = store.get(f"users/{uid}")
    for doc_id, _ in store.list(f"entries/{uid}/rounds"):
        writes.append(Write.delete(f"entries/{uid}/rounds/{doc_id}"))
    for doc_id, _ in store.list(f"tables/{uid}/picks"):
        writes.append(Write.delete(f"tables/{uid}/picks/{doc_id}"))
    for code, _ in store.list("leagues"):
        writes.append(Write.delete(f"leagues/{code}/members/{uid}"))
    if user and user.get("nick"):
        writes.append(Write.delete(f"nicknames/{nicknames.key(user['nick'])}"))
    writes += [Write.delete(f"users/{uid}"), Write.delete(f"stats/{uid}"), Write.delete(f"deleteRequests/{uid}")]
    return writes


def _inactive(store: Any, now: datetime) -> list[str]:
    """Accounts unused for 24 months: the later of the last pick and the sign-up."""
    stats = dict(store.list("stats"))
    old = []
    for uid, user in store.list("users"):
        last = max([t for t in (_utc(user.get("created")), _utc(stats.get(uid, {}).get("last"))) if t], default=None)
        if last and now - last > INACTIVE_AFTER:
            old.append(uid)
    return old
