"""Season mountain: a one-off 3D view of the position grid through a season.

Each team keeps one row of the site's grid (positions 1-16 across); every
round stacks another layer of position probabilities on top, from a rewound
pre-season report up to the final (or current) table. Layer k is the first
matchday on which 8k matches had been played, so a postponed fixture counts
where it was actually played, not in its nominal round.

Reads the per-matchday reports in public/data (run build_site first) and
writes one self-contained page:

    python experiments/season_mountain/build.py [out.html]

Default output is build/season-mountain.html (gitignored).
"""
import json
import sys
from multiprocessing import Pool
from pathlib import Path

sys.path.insert(0, "src")

from elitetracker.pipeline import build_all_careers, build_report, rewound_configs

DATA = Path("public/data")
HERE = Path(__file__).parent
LEAGUES = ("eliteserien", "obosligaen")
_CAREERS = None


def _init():
    global _CAREERS
    _CAREERS = build_all_careers()


def _probs(report):
    return {r["team_id"]: r["position_probabilities"] for r in report["table"]}


def _preseason(job):
    slug, season = job
    asof = f"{season}-01-15"
    simulation, history = rewound_configs(asof)
    report = build_report(slug, season, careers=_CAREERS, simulation=simulation, history=history, asof=asof)
    return job, _probs(report)


def _league(slug, season, final, pre):
    F = final[slug]
    days, n = F["league"]["matchdays"], len(F["table"])
    played, remaining = F["model"]["matches_played"], F["model"]["matches_remaining"]
    per_round = n // 2
    layers = [("Pre-season", pre)]
    for k in range(1, played // per_round + 1):
        if remaining == 0 and k * per_round == played:
            layers.append((f"Round {k} · {days[-1]['date']}", _probs(F)))
            continue
        day = next(d for d in days if d["matches_played"] >= k * per_round)
        report = json.loads((DATA / f"report-{season}-{day['date']}.json").read_text(encoding="utf-8"))[slug]
        layers.append((f"Round {k} · {day['date']}", _probs(report)))
    if remaining:
        layers.append((f"Now · {days[-1]['date']}", _probs(F)))
    teams = [{"id": r["team_id"], "name": r["team"], "final": r["position"]} for r in F["table"]]
    expected = {t: sum((i + 1) * p for i, p in enumerate(ps)) for t, ps in pre.items()}
    for i, t in enumerate(sorted(teams, key=lambda t: expected[t["id"]])):
        t["predicted"] = i + 1
    return {
        "name": F["league"]["name"], "bands": F["league"]["bands"], "done": remaining == 0, "teams": teams,
        "layers": [{"label": label, "p": [[round(x, 4) for x in ps[t["id"]]] for t in teams]} for label, ps in layers],
    }


def main(out: Path) -> None:
    seasons = sorted(int(p.stem.split("-")[1]) for p in DATA.glob("report-????.json"))
    with Pool(8, initializer=_init) as pool:
        pre = dict(pool.map(_preseason, [(slug, s) for s in seasons for slug in LEAGUES]))
    data = {}
    for season in seasons:
        final = json.loads((DATA / f"report-{season}.json").read_text(encoding="utf-8"))
        data[season] = {slug: _league(slug, season, final, pre[(slug, season)]) for slug in LEAGUES}
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    html = (HERE / "template.html").read_text(encoding="utf-8").replace("/*DATA*/null", payload)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"{out}: {len(seasons)} seasons, {len(html) // 1024} KB")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path("build/season-mountain.html"))
