"""Season odds, old vs new model: every finished season 2016-2025, both
divisions, simulated from pre-season, a quarter, half and three quarters in
(10,000 runs), scored against the final table: RPS over the 16 places and the
log loss of the actual place, clustered by season-league for t.

Run once from the repo root (new code) and once from a worktree of the old
commit; writes out/season_<version>.json, then `--compare a.json b.json`.
"""
import json, math, sys
from pathlib import Path
import numpy as np
from elitetracker.model.elo import MODEL_VERSION
from elitetracker.model.table import table_from_matches
from elitetracker.pipeline import LEAGUE_SPECS, build_all_careers, build_report, load_matches, NORMALIZED_DIR
from elitetracker.simulation.history import HistoryConfig
from elitetracker.simulation.season import SimulationConfig

def run(out):
    careers = build_all_careers()
    rows = []
    for season in range(2016, 2026):
        for slug in LEAGUE_SPECS:
            matches = load_matches(NORMALIZED_DIR / f"{slug}_{season}_matches.json")
            final = {r.team_id: i for i, r in enumerate(table_from_matches(matches))}
            dates = sorted(m.date for m in matches if m.played)
            first = dates[0]
            cuts = {"pre": None, "q1": dates[len(dates) // 4], "q2": dates[len(dates) // 2], "q3": dates[3 * len(dates) // 4]}
            for label, asof in cuts.items():
                if asof is None:
                    from datetime import date, timedelta
                    asof = str(date.fromisoformat(first) - timedelta(days=1))
                rep = build_report(slug, season, careers=careers, asof=asof,
                                   simulation=SimulationConfig(simulations=10_000),
                                   history=HistoryConfig(simulations=200, max_snapshots=2))
                for row in rep["table"]:
                    probs = np.array(row["position_probabilities"])
                    place = final[row["team_id"]]
                    cdf, obs = np.cumsum(probs), (np.arange(len(probs)) >= place).astype(float)
                    rows.append({"season": season, "league": slug, "cut": label, "team": row["team_id"],
                                 "rps": float(((cdf - obs) ** 2)[:-1].mean()),
                                 "ll": float(-math.log(max(probs[place], 1e-6)))})
        print(season, flush=True)
    Path(out).write_text(json.dumps(rows))

def compare(a, b):
    A, B = json.loads(Path(a).read_text()), json.loads(Path(b).read_text())
    key = lambda r: (r["season"], r["league"], r["cut"], r["team"])
    bm = {key(r): r for r in B}
    for metric in ("rps", "ll"):
        for scope in ("all", "eliteserien", "obosligaen", "pre", "q2"):
            clusters = {}
            for r in A:
                if scope in ("eliteserien", "obosligaen") and r["league"] != scope: continue
                if scope in ("pre", "q2") and r["cut"] != scope: continue
                d = r[metric] - bm[key(r)][metric]
                clusters.setdefault((r["season"], r["league"]), []).append(d)
            means = np.array([np.mean(v) for v in clusters.values()])
            t = means.mean() / (means.std(ddof=1) / math.sqrt(len(means)))
            print(f"{metric:<4} {scope:<12} d={means.mean():+.5f} t={t:+.2f} (clusters {len(means)})")

if __name__ == "__main__":
    if sys.argv[1:2] == ["--compare"]:
        compare(sys.argv[2], sys.argv[3])
    else:
        run(sys.argv[1] if len(sys.argv) > 1 else f"experiments/improvements/out/season_{MODEL_VERSION}.json")
