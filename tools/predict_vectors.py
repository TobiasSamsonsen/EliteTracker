"""Make the shared test vectors for Predict: tests/fixtures/predict_vectors.json.

Python is the source of truth for the game's arithmetic; the browser twin
(public/predict-core.js) must give the same numbers. Both test suites read the
file, and tests/test_predict_core.py fails if it is out of date. Regenerate with

    .venv/Scripts/python tools/predict_vectors.py
"""

from __future__ import annotations

import json
from pathlib import Path

from elitetracker.predict import curve, nicknames, scoring, tables

PATH = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "predict_vectors.json"


def r(value: float) -> float:
    return round(value, 10)


def make() -> dict:
    grid = {str(k): [list(curve.pick_percentages(g, k)) for g in range(curve.GAP_MIN, curve.GAP_MAX + 1, curve.GAP_STEP)]
            for k in range(curve.K_MIN, curve.K_MAX + 1)}
    raw = [(0.3333, 0.3333, 0.3334), (0.98, 0.01, 0.01), (0.01, 0.01, 0.98), (0.5, 0.0, 0.5), (0.455, 0.27, 0.275),
           (0.1, 0.9, 0.0), (0.0, 0.0, 1.0), (0.605, 0.205, 0.19), (0.25, 0.5, 0.25)]
    percent_cases = [{"in": list(x), "out": list(curve.percentages(*x))} for x in raw]

    picks = {"a": (45, 27, 28), "b": (70, 20, 10), "c": (10, 20, 70), "d": (34, 33, 33), "e": (2, 2, 96), "f": (60, 25, 15)}
    scoring_cases = []
    for result in ("home_win", "draw", "away_win"):
        scored = scoring.score_match(picks, (0.5, 0.25, 0.25), result)
        scoring_cases.append({
            "picks": {k: list(v) for k, v in picks.items()}, "model": [0.5, 0.25, 0.25], "result": result,
            "players": {k: {f: r(x) for f, x in row.items()} for k, row in scored["players"].items()},
            "model_row": {f: r(x) for f, x in scored["model"].items()},
            "crowd": {f: r(x) for f, x in scored["crowd"].items()} if scored["crowd"] else None,
            "median_brier": r(scored["median_brier"]), "median_rps": r(scored["median_rps"])})

    truth = list("ABCDEFGHIJKLMNOP")
    plan_es = tables.bonus_plan("eliteserien", [{"first": 1, "last": 1, "tone": "champion"},
                                                {"first": 1, "last": 2, "tone": "top"},
                                                {"first": 15, "last": 16, "tone": "relegation"}])
    plan_obos = tables.bonus_plan("obosligaen", [{"first": 1, "last": 1, "tone": "champion"},
                                                 {"first": 1, "last": 2, "tone": "top"},
                                                 {"first": 15, "last": 16, "tone": "relegation"}])
    shuffled = list("BACDEFGHIJKLMNPO")
    reversed_ = truth[::-1]
    table_cases = [{"order": o, "truth": truth, "plan": p, "footrule": tables.footrule(o, truth),
                    "bonus": tables.bonus(o, truth, p), "error": tables.error(o, truth, p)}
                   for o in (truth, shuffled, reversed_, list("ACBDEFGHIJKLMNOP")) for p in (plan_es, plan_obos)]

    names = ["Tipper_1", "Øyvind_9", "ÆØÅ æøå", "ab", "Modellen", "FOLKET", " lead", "trail ", "x" * 21, "bad!name",
             "Sh1t_head", "Greit-Navn", "Ola Nordmann", "a_b", "Åse",
             "Thore", "Håkon_Thore", "Scunthorpe", "Hore", "Hore_99", "h0re", "h_o_r_e", "Pikk10", "Pikkolo", "Nazir",
             "Cunt-face", "Fitte", "Mr Hitler", "Torshovdal"]
    nick_cases = [{"nick": n, "key": nicknames.key(n), "problems": nicknames.problems(n), "blocked": nicknames.blocked(n)}
                  for n in names]
    gaps = [{"home": h, "draw": d, "gap": r(curve.equivalent_gap(h, d))} for h, d in
            ((0.5, 0.25), (0.3, 0.3), (0.8, 0.1), (0.1, 0.1), (0.455, 0.27))]
    return {"curve_version": curve.CURVE_VERSION, "grid": grid, "percentages": percent_cases, "scoring": scoring_cases,
            "tables": table_cases, "nicknames": nick_cases, "equivalent_gap": gaps}


def main() -> None:
    PATH.parent.mkdir(parents=True, exist_ok=True)
    PATH.write_text(json.dumps(make(), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print("wrote", PATH)


if __name__ == "__main__":
    main()
