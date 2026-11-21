"""The 70 %+ favourites, re-tested on elo-v17.0 (November 2026; audit batch 3, item 4).

Three candidates, each scored walk-forward on the matches the site scores
(both divisions 2016+) and paired against the shipped odds:

  spread    the goals model's rating stretch, the grid taken to 1.30 (the
            elo-v12 pick was capped at 1.10; later sweeps went to 1.20)
  gamma     blend_gamma, the gap-dependent Elo weight in the blend (0 shipped)
  davidson  Davidson's three-way model in place of the bell-curve draw taken
            off both sides: P(H) = th / (th + 1/th + nu), th = 10^(c * gap / 800)
            (the Elo expectation then no longer holds exactly; ratings are
            still updated on the Elo expectation)

(The temperature and lookup-table layers are recalibration.py.)

    .venv/Scripts/python experiments/improvements/favourites_batch3.py run <family> <out_dir>
    .venv/Scripts/python experiments/improvements/favourites_batch3.py report <out_dir>

`run` writes one .npz per variant (per-match probabilities); `report` reads them.
"""
from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

import numpy as np

import elitetracker.model.backtest as backtest
import elitetracker.model.probabilities as probabilities
from elitetracker.model.attack_defence import ADConfig
from elitetracker.model.probabilities import AWAY_WIN, DRAW, HOME_WIN, MatchProbabilities
from elitetracker.research import load_slices, load_xg, market_values, seed_ratings
from elitetracker.pipeline import stakes_table

OUTCOMES = (HOME_WIN, DRAW, AWAY_WIN)
FIRST_TEST = 2018
GRID = {
    "spread": [("spread", s) for s in (1.00, 1.05, 1.10, 1.15, 1.20, 1.25, 1.30)],
    "gamma": [("gamma", g) for g in (0.0, 0.05, 0.10, 0.20, 0.40)],
    "davidson": [("davidson", (nu, c)) for nu in (0.60, 0.70, 0.80) for c in (0.9, 1.0, 1.1, 1.2)],
}
SHIPPED = ("spread", 1.10)


def davidson(nu: float, c: float):
    original = probabilities._draw_model_probabilities

    def model(gap: float, config) -> MatchProbabilities:
        theta = 10.0 ** (c * gap / 800.0)
        total = theta + 1.0 / theta + nu
        return MatchProbabilities(home_win=theta / total, draw=nu / total, away_win=(1.0 / theta) / total,
                                  rating_gap=gap / 400.0)
    probabilities._draw_model_probabilities = model
    return original


def cards(variant):
    slices = load_slices()
    seeds = {team_id: seed.rating for team_id, seed in seed_ratings().items()}
    shots = {k: tuple(v) for k, v in load_xg()["matches"].items()}
    kind, value = variant
    restore = None
    config = ADConfig()
    if kind == "spread":
        config = replace(config, spread=value)
    elif kind == "gamma":
        config = replace(config, blend_gamma=value)
    elif kind == "davidson":
        restore = davidson(*value)
    backtest.ADConfig = lambda config=config: config
    try:
        _, card = backtest.shipped_cards(slices, seeds, score_from_season=2016, shots=shots,
                                         values=market_values(), stakes=stakes_table())
    finally:
        if restore:
            probabilities._draw_model_probabilities = restore
    meta = {m.match_id: (int(m.date[:4]), m.date, s.league) for s in slices for m in s.matches}
    ids = sorted(card.predictions, key=lambda mid: meta[mid][1])
    p = np.array([[card.predictions[mid][0].of(o) for o in OUTCOMES] for mid in ids])
    y = np.array([OUTCOMES.index(card.predictions[mid][1]) for mid in ids])
    season = np.array([meta[mid][0] for mid in ids])
    return ids, p, y, season


def name(variant):
    kind, value = variant
    return f"{kind}_" + ("_".join(f"{v:.2f}" for v in value) if isinstance(value, tuple) else f"{value:.2f}")


def run(family: str, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for variant in GRID[family] + ([SHIPPED] if family == "spread" else []):
        path = out / f"{name(variant)}.npz"
        if path.exists():
            continue
        ids, p, y, season = cards(variant)
        np.savez(path, ids=np.array(ids), p=p, y=y, season=season)
        print("done", name(variant), flush=True)


def loss(p, y):
    return -np.log(np.clip(p[np.arange(len(y)), y], 1e-12, 1))


def report(out: Path) -> None:
    data = {path.stem: np.load(path) for path in sorted(out.glob("*.npz"))}
    base = data[name(SHIPPED)]
    y, season = base["y"], base["season"]
    base_loss = loss(base["p"], y)
    half = np.arange(len(y)) >= len(y) // 2

    def paired(candidate):
        d = candidate - base_loss
        t = d.mean() / (d.std(ddof=1) / np.sqrt(len(d)))
        d1, d2 = d[~half], d[half]
        t1 = d1.mean() / (d1.std(ddof=1) / np.sqrt(len(d1)))
        t2 = d2.mean() / (d2.std(ddof=1) / np.sqrt(len(d2)))
        return d.mean(), t, d1.mean(), t1, d2.mean(), t2

    def heavy(p):
        top = p.max(1)
        sel = top >= 0.70
        won = (p.argmax(1) == y)[sel]
        return int(sel.sum()), top[sel].mean(), won.mean()

    print(f"shipped (spread 1.10): log loss {base_loss.mean():.5f}; >=70 %: n {heavy(base['p'])[0]}, "
          f"priced {heavy(base['p'])[1]:.3f}, won {heavy(base['p'])[2]:.3f}")
    for family in GRID:
        names = [name(v) for v in GRID[family]]
        names = [n for n in names if n in data]
        if not names:
            continue
        losses = {n: loss(data[n]["p"], y) for n in names}
        print(f"\n{family}: fixed value, whole sample (mean paired change vs shipped, t; halves; >=70 % n, priced, won)")
        for n in names:
            d, t, d1, t1, d2, t2 = paired(losses[n])
            h = heavy(data[n]["p"])
            print(f"  {n:<22} {d:+.5f} (t {t:+.2f})  halves {d1:+.5f} / {d2:+.5f}  >=70: {h[0]}, {h[1]:.3f}, {h[2]:.3f}")
        # Walk-forward: each season scored with the value that did best on the seasons before it.
        picked = np.empty(len(y))
        picks = {}
        for s in sorted(set(season[season >= FIRST_TEST])):
            prior = season < s
            best = min(names, key=lambda n: losses[n][prior].mean())
            picks[int(s)] = best
            picked[season == s] = losses[best][season == s]
        test = season >= FIRST_TEST
        d = picked[test] - base_loss[test]
        t = d.mean() / (d.std(ddof=1) / np.sqrt(len(d)))
        mid = np.arange(test.sum()) >= test.sum() // 2
        t1 = d[~mid].mean() / (d[~mid].std(ddof=1) / np.sqrt((~mid).sum()))
        t2 = d[mid].mean() / (d[mid].std(ddof=1) / np.sqrt(mid.sum()))
        print(f"  walk-forward ({FIRST_TEST}+): {d.mean():+.5f} (t {t:+.2f}), halves {d[~mid].mean():+.5f} (t {t1:+.2f}) / "
              f"{d[mid].mean():+.5f} (t {t2:+.2f}); picks {sorted(set(picks.values()))}")


if __name__ == "__main__":
    if sys.argv[1] == "run":
        run(sys.argv[2], Path(sys.argv[3]))
    else:
        report(Path(sys.argv[2]))
