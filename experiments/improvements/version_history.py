"""Every model version's match odds on the same matches (October 2026).

For the model accuracy view: how much each release improved the odds. Each
version's own `src` (a git worktree of its release commit, first on
PYTHONPATH) predicts every match 2016-2025 walk-forward, on today's data
(run from the repo root, so every version reads the same matches, xG and
squad values); `combine` scores them all on the matches every version
predicts, with the bookmakers' closing line as a reference.

How each version's odds are made, with its own code:
- elo-v1: each season seeded from the season before's final tables (built
  from its matches: v1 read live tables), then replayed match by match;
- elo-v2-v6: one continuous replay (`build_all_careers`, the offseason pull
  included), each season from its opening ratings, match by match -- the
  production path, through each version's own `updated_pair` and odds;
- elo-v7-v12: Elo `walk_forward` blended with the goals model the way that
  version's `research.cmd_run` scored the shipped odds;
- elo-v13 on: `backtest.shipped_cards`.
The only adapter: today's match files differ from older `Match` classes, which
do not know some fields (kickoff time, round; dropped) and require one
(`venue`; None, read by no rating code).

    # one per release, from the repo root, with that release's src first:
    PYTHONPATH=<worktree>/src .venv/Scripts/python experiments/improvements/version_history.py predict OUT.json
    # then, with today's src:
    .venv/Scripts/python experiments/improvements/version_history.py combine OUT_DIR data/model_versions.json
"""
from __future__ import annotations

import dataclasses
import inspect
import json
import math
import sys
from pathlib import Path

FIRST, LAST = 2016, 2025
# Release dates, from PROJECT_STATUS.md's "Model versions" table (minor
# releases that left the match odds alone are not scored).
RELEASED = {
    "elo-v1": "2026-08-09", "elo-v2": "2026-08-09", "elo-v3": "2026-08-09", "elo-v5": "2026-08-27",
    "elo-v6": "2026-08-29", "elo-v7": "2026-09-11", "elo-v8": "2026-09-13", "elo-v9": "2026-09-13",
    "elo-v10": "2026-09-16", "elo-v11": "2026-09-16", "elo-v11.1": "2026-09-16", "elo-v12.0": "2026-09-25",
    "elo-v13.0": "2026-10-16", "elo-v14.0": "2026-10-16", "elo-v15.0": "2026-10-17",
}


def _accepts(fn, name):
    return name in inspect.signature(fn).parameters


def predict(out_path: str) -> None:
    import elitetracker.pipeline as P
    from elitetracker.model import elo as E
    from elitetracker.normalize.matches import Match

    fields = {f.name for f in dataclasses.fields(Match)}

    def load_matches(path):
        # Fields an older Match requires that today's files no longer carry
        # (`venue`) come in as None; no rating code reads them.
        with Path(path).open(encoding="utf-8") as handle:
            return [Match(**{**dict.fromkeys(fields), **{k: v for k, v in r.items() if k in fields}})
                    for r in json.load(handle)]

    P.load_matches = load_matches
    sort_key = getattr(Match, "sort_key", None) or (lambda m: (m.date, m.time or "", m.match_id))
    preds: dict[str, list[float]] = {}

    def keep(match_id, odds, season):
        if FIRST <= season <= LAST:
            preds[match_id] = [odds.home_win, odds.draw, odds.away_win]

    try:
        from elitetracker.model import backtest as B
    except ImportError:
        B = None
    try:
        from elitetracker.model import attack_defence as AD
    except ImportError:
        AD = None

    def shots_table():
        if hasattr(P, "shot_table"):
            return P.shot_table()
        try:
            from elitetracker.research import load_xg
        except ImportError:
            from elitetracker.sources.fotmob import load_xg
        return {k: tuple(v) for k, v in load_xg()["matches"].items()}

    if AD is None:
        # elo-v1 to elo-v6, Elo alone: the production path, each season from
        # its opening ratings (v1: the season before's final tables; v2-v6:
        # the careers, offseason pull included) replayed match by match with
        # the version's own update and odds.
        from types import SimpleNamespace

        from elitetracker.model.elo import EloConfig, updated_pair
        from elitetracker.model.initial_ratings import initial_ratings, rating_for_unseeded_team
        from elitetracker.model.probabilities import match_probabilities
        from elitetracker.model.table import table_from_matches

        root = P.NORMALIZED_DIR
        config = EloConfig()
        careers = P.build_all_careers() if hasattr(P, "build_all_careers") else None

        def season_matches(slug, season):
            path = P._matches_path(slug, season, root)
            return load_matches(path) if path.exists() else []

        def final_table(slug, season):
            # Standings files exist for the seed season only; v1 read them
            # live, so the season before's table is built from its matches.
            rows = table_from_matches(season_matches(slug, season))
            return [SimpleNamespace(position=i + 1, team_id=r.team_id, team=r.team) for i, r in enumerate(rows)]

        for season in range(FIRST, LAST + 1):
            if careers is not None:
                ratings = {t: s.rating for t, s in P._season_seeds(careers, season).items()}
            else:
                seeds = initial_ratings(final_table("eliteserien", season - 1), final_table("obosligaen", season - 1))
                ratings = {t: s.rating for t, s in seeds.items()}
            matches = season_matches("eliteserien", season) + season_matches("obosligaen", season)
            for m in matches:
                for t in (m.home_id, m.away_id):
                    ratings.setdefault(t, rating_for_unseeded_team())
            for m in sorted((m for m in matches if m.played), key=sort_key):
                h, a = ratings[m.home_id], ratings[m.away_id]
                keep(m.match_id, match_probabilities(h, a, config), season)
                ratings[m.home_id], ratings[m.away_id] = updated_pair(h, a, m.home_goals, m.away_goals, config)
    else:
        slices = P.load_slices()
        season_of = {m.match_id: s.season for s in slices for m in s.matches}
        seeds = {t: s.rating for t, s in P.seed_ratings().items()}
        if hasattr(B, "shipped_cards"):
            kwargs = {"shots": shots_table()}
            if _accepts(B.shipped_cards, "values"):
                kwargs["values"] = P.market_values()
            _, card = B.shipped_cards(slices, seeds, score_from_season=FIRST, **kwargs)
            for mid, (odds, _) in card.predictions.items():
                keep(mid, odds, season_of[mid])
        else:
            from elitetracker.model.elo import EloConfig
            kwargs = {}
            shots = None
            if _accepts(B.walk_forward, "modern_config"):
                # elo-v10 passed its era switch explicitly, in production and research alike.
                kwargs.update(modern_config=E.MODERN_CONFIG, boundary_season=E.BOUNDARY_SEASON,
                              boundary_league=getattr(E, "BOUNDARY_LEAGUE", None))
            if _accepts(B.walk_forward, "shots"):
                shots = shots_table()
                kwargs["shots"] = shots
            elo = B.walk_forward(slices, seeds, EloConfig(), score_from_season=FIRST, **kwargs)
            try:
                from elitetracker.model import attack_defence as AD
            except ImportError:
                AD = None
            if AD is None:
                for mid, (odds, _) in elo.predictions.items():
                    keep(mid, odds, season_of[mid])
            else:
                shots = shots if shots is not None else shots_table()
                ad = AD.AttackDefence.from_slices(slices, AD.ADConfig(), shots=shots)
                from elitetracker.model.career import team_ids
                grid_gap = _accepts(ad.grid, "elo_gap")
                for m in sorted((m for s in slices for m in s.matches if m.played), key=sort_key):
                    home, away = team_ids(m)
                    if m.match_id in elo.predictions:
                        elo_odds = elo.predictions[m.match_id][0]
                        gap = getattr(elo_odds, "rating_gap", 0.0)
                        grid = ad.grid(home, away, m.date, elo_gap=gap) if grid_gap else ad.grid(home, away, m.date)
                        if hasattr(AD, "gap_blend_weight"):
                            odds = AD.blend_outcomes(elo_odds, grid,
                                                     weight=AD.gap_blend_weight(gap, ad.config.blend_gamma))
                        else:
                            odds = AD.blend_outcomes(elo_odds, grid)
                        keep(m.match_id, odds, season_of[m.match_id])
                    ad.observe(m)
    Path(out_path).write_text(json.dumps({"version": E.MODEL_VERSION, "odds": preds}), encoding="utf-8")
    print(E.MODEL_VERSION, len(preds), "matches")


# ------------------------------------------------------------------ combine

def _scores(p, y):
    ll = -math.log(max(p[y], 1e-12))
    brier = sum((p[k] - (k == y)) ** 2 for k in range(3))
    c = (p[0] - (y == 0), p[0] + p[1] - (y <= 1))
    return ll, brier, (c[0] ** 2 + c[1] ** 2) / 2


def _t(d):
    n = len(d)
    mean = sum(d) / n
    sd = math.sqrt(sum((x - mean) ** 2 for x in d) / (n - 1))
    return mean / (sd / math.sqrt(n)) if sd else 0.0


def combine(in_dir: str, out_path: str) -> None:
    from elitetracker.model import benchmark
    from elitetracker.model.probabilities import AWAY_WIN, DRAW, HOME_WIN, outcome_of
    from elitetracker.pipeline import load_slices, shot_table

    runs = sorted((json.loads(p.read_text(encoding="utf-8")) for p in Path(in_dir).glob("*.json")),
                  key=lambda r: [int(x) for x in r["version"].removeprefix("elo-v").split(".")])
    slices = load_slices()
    meta = {m.match_id: (s.league, s.season, outcome_of(m), m) for s in slices for m in s.matches
            if m.played and FIRST <= s.season <= LAST}
    common = set(meta).intersection(*(set(r["odds"]) for r in runs))
    order = sorted(common)
    y = {mid: (HOME_WIN, DRAW, AWAY_WIN).index(meta[mid][2]) for mid in order}
    es = [mid for mid in order if meta[mid][0] == "eliteserien"]
    # The xG seasons: the matches with xG (Eliteserien from 2020, OBOS-ligaen from 2023).
    shots = shot_table()
    xg = [mid for mid in order if mid in shots]
    es_xg = [mid for mid in es if mid in shots]

    # The closing line on the Eliteserien matches it prices (power method).
    prices = benchmark.load_prices()
    market_card = benchmark.market_cards(prices, [meta[mid][3] for mid in es]).get("power") if prices else None
    priced = [mid for mid in es if market_card and mid in market_card.predictions]

    def score(odds, ids):
        rows = [_scores(odds[mid], y[mid]) for mid in ids]
        return [sum(r[i] for r in rows) / len(rows) for i in range(3)], [r[0] for r in rows]

    out = {"first_season": FIRST, "last_season": LAST, "n": len(order), "n_eliteserien": len(es), "n_xg": len(xg),
           "n_priced": len(priced), "versions": []}
    previous = None
    for run in runs:
        (ll, brier, rps), lls = score(run["odds"], order)
        (es_ll, _, _), _ = score(run["odds"], es)
        (xg_ll, _, _), _ = score(run["odds"], xg)
        (es_xg_ll, _, _), _ = score(run["odds"], es_xg)
        (pr_ll, _, _), _ = score(run["odds"], priced) if priced else ((None, None, None), None)
        row = {"version": run["version"], "released": RELEASED.get(run["version"]), "log_loss": round(ll, 5), "brier": round(brier, 5), "rps": round(rps, 5),
               "log_loss_eliteserien": round(es_ll, 5), "log_loss_xg": round(xg_ll, 5), "log_loss_eliteserien_xg": round(es_xg_ll, 5),
               "log_loss_priced": round(pr_ll, 5) if pr_ll is not None else None}
        if previous:
            d = [a - b for a, b in zip(lls, previous)]
            row["vs_previous"] = round(sum(d) / len(d), 5)
            row["t_vs_previous"] = round(_t(d), 2)
        out["versions"].append(row)
        previous = lls
        print(f"{run['version']:>10}  LL {ll:.5f}  Brier {brier:.5f}  RPS {rps:.5f}  ES {es_ll:.5f}"
              f"  priced {pr_ll if pr_ll is None else round(pr_ll, 5)}"
              f"  vs prev {row.get('vs_previous', 0):+.5f} (t {row.get('t_vs_previous', 0):+.2f})")
    if priced:
        odds = {mid: [market_card.predictions[mid][0].of(o) for o in (HOME_WIN, DRAW, AWAY_WIN)] for mid in priced}
        (m_ll, _, _), _ = score(odds, priced)
        out["market_log_loss_priced"] = round(m_ll, 5)
        # The same, on Eliteserien's xG seasons: the like-for-like check for the xG line.
        (m_xg, _, _), _ = score(odds, [mid for mid in es_xg if mid in odds])
        out["market_log_loss_eliteserien_xg"] = round(m_xg, 5)
        print(f"closing line (power) on the {len(priced)} priced Eliteserien matches: {m_ll:.5f}")
    base = {k: sum(1 for mid in order if y[mid] == k) / len(order) for k in range(3)}
    out["base_rate_log_loss"] = round(sum(-math.log(base[y[mid]]) for mid in order) / len(order), 5)
    base_es = {k: sum(1 for mid in es if y[mid] == k) / len(es) for k in range(3)}
    out["base_rate_log_loss_eliteserien"] = round(sum(-math.log(base_es[y[mid]]) for mid in es) / len(es), 5)
    base_xg = {k: sum(1 for mid in xg if y[mid] == k) / len(xg) for k in range(3)}
    base_es_xg = {k: sum(1 for mid in es_xg if y[mid] == k) / len(es_xg) for k in range(3)}
    out["base_rate_log_loss_eliteserien_xg"] = round(sum(-math.log(base_es_xg[y[mid]]) for mid in es_xg) / len(es_xg), 5)
    out["n_eliteserien_xg"] = len(es_xg)
    out["base_rate_log_loss_xg"] = round(sum(-math.log(base_xg[y[mid]]) for mid in xg) / len(xg), 5)
    print(f"base rates alone: {out['base_rate_log_loss']:.5f}; {len(order)} matches ({len(es)} Eliteserien)")
    Path(out_path).write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    if sys.argv[1] == "predict":
        predict(sys.argv[2])
    else:
        combine(sys.argv[2], sys.argv[3])
