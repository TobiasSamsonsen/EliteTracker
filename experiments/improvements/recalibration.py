"""Recalibration layers on the shipped odds, re-tested on elo-v14.0 (October 2026).

The reliability diagram (Explore, model accuracy) still shows heavy
favourites winning more often than priced. The elo-v12 log tested
temperature and outcome biases walk-forward (-0.0010, t -1.4); since then the
spread (1.10) and elo-v13/v14 changed the odds underneath. This re-tests
those and adds a lookup table: each outcome's chance mapped to how often it
happened in 5 % bins, shrunk toward no change, interpolated, renormalised.

Every layer is fitted on the seasons before the one it scores (expanding
window over the scored seasons from 2016) and paired against the shipped odds
on the same matches: log loss, Brier, RPS, t, both date halves.

    .venv/Scripts/python experiments/improvements/recalibration.py
"""
from __future__ import annotations

import numpy as np

from elitetracker.model.backtest import shipped_cards
from elitetracker.model.elo import MODEL_VERSION
from elitetracker.model.probabilities import AWAY_WIN, DRAW, HOME_WIN
from elitetracker.research import load_slices, load_xg, market_values, seed_ratings

FIRST_TEST = 2018
OUTCOMES = (HOME_WIN, DRAW, AWAY_WIN)


def shipped():
    slices = load_slices()
    seeds = {team_id: seed.rating for team_id, seed in seed_ratings().items()}
    shots = {k: tuple(v) for k, v in load_xg()["matches"].items()}
    _, card = shipped_cards(slices, seeds, score_from_season=2016, shots=shots, values=market_values())
    meta = {m.match_id: (int(m.date[:4]), m.date, s.league) for s in slices for m in s.matches}
    ids = sorted(card.predictions, key=lambda mid: meta[mid][1])
    p = np.array([[card.predictions[mid][0].of(o) for o in OUTCOMES] for mid in ids])
    y = np.array([OUTCOMES.index(card.predictions[mid][1]) for mid in ids])
    season = np.array([meta[mid][0] for mid in ids])
    league = np.array([meta[mid][2] for mid in ids])
    return p, y, season, league


def losses(p, y):
    onehot = np.eye(3)[y]
    ll = -np.log(np.clip(p[np.arange(len(y)), y], 1e-12, 1))
    brier = ((p - onehot) ** 2).sum(1)
    rps = (((np.cumsum(p, 1) - np.cumsum(onehot, 1))[:, :2]) ** 2).sum(1) / 2
    return {"log_loss": ll, "brier": brier, "rps": rps}


def norm(p):
    return p / p.sum(1, keepdims=True)


# --- layers: fit(p, y) -> apply(p) ------------------------------------------

def fit_temperature(p, y):
    grid = np.arange(0.90, 1.41, 0.01)
    best = min(grid, key=lambda t: losses(norm(p ** t), y)["log_loss"].mean())
    return lambda q: norm(q ** best), f"T {best:.2f}"


def fit_temperature_bias(p, y, steps=400, lr=0.5):
    # Multinomial logistic on log p: softmax(T log p + b), b[home] = 0.
    lp = np.log(p)
    t, b = 1.0, np.zeros(3)
    onehot = np.eye(3)[y]
    for _ in range(steps):
        z = t * lp + b
        q = norm(np.exp(z - z.max(1, keepdims=True)))
        g = q - onehot
        t -= lr * (g * lp).sum(1).mean()
        b[1:] -= lr * g[:, 1:].mean(0)
    return lambda r: norm(np.exp(t * np.log(r) + b)), f"T {t:.2f} b {b[1]:+.2f}/{b[2]:+.2f}"


def fit_lut(p, y, width=0.05, prior=50.0):
    # Per outcome: bin by predicted chance, the bin's rate shrunk toward its
    # mean prediction with `prior` pseudo-matches, linear between bin centres.
    tables = []
    edges = np.arange(0, 1 + 1e-9, width)
    for k in range(3):
        pk, hit = p[:, k], (y == k).astype(float)
        idx = np.minimum((pk / width).astype(int), len(edges) - 2)
        xs, ys = [], []
        for i in range(len(edges) - 1):
            sel = idx == i
            n = sel.sum()
            if not n:
                continue
            mean_p = pk[sel].mean()
            xs.append(mean_p)
            ys.append((hit[sel].sum() + prior * mean_p) / (n + prior))
        tables.append((np.array(xs), np.array(ys)))

    def apply(q):
        out = np.empty_like(q)
        for k, (xs, ys) in enumerate(tables):
            # Outside the fitted range keep the table's offset at the end.
            v = np.interp(q[:, k], xs, ys)
            lo, hi = q[:, k] < xs[0], q[:, k] > xs[-1]
            v[lo] = q[lo, k] + (ys[0] - xs[0])
            v[hi] = q[hi, k] + (ys[-1] - xs[-1])
            out[:, k] = np.clip(v, 0.005, 0.995)
        return norm(out)
    return apply, f"LUT {width:.0%} prior {prior:.0f}"


def pav(x, hit):
    order = np.argsort(x)
    xs, vals, w = list(x[order]), list(hit[order].astype(float)), [1.0] * len(x)
    blocks = []  # [sum, weight, x-sum]
    for xi, v in zip(xs, vals):
        blocks.append([v, 1.0, xi])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1]:
            s, n, xx = blocks.pop()
            blocks[-1][0] += s
            blocks[-1][1] += n
            blocks[-1][2] += xx
    return np.array([b[2] / b[1] for b in blocks]), np.array([b[0] / b[1] for b in blocks])


def fit_isotonic(p, y):
    tables = [pav(p[:, k], y == k) for k in range(3)]

    def apply(q):
        out = np.column_stack([np.interp(q[:, k], *tables[k]) for k in range(3)])
        return norm(np.clip(out, 0.005, 0.995))
    return apply, "isotonic"


def stretch_favourite(q, s, from_p):
    # The favourite's log-odds times s where it is priced at from_p or more;
    # the other two keep their ratio.
    out = q.copy()
    top = q.argmax(1)
    pmax = q[np.arange(len(q)), top]
    sel = pmax >= from_p
    logit = np.log(pmax[sel] / (1 - pmax[sel]))
    new = 1 / (1 + np.exp(-s * logit))
    rows = np.flatnonzero(sel)
    rest = (1 - new) / (1 - pmax[sel])
    out[rows] *= rest[:, None]
    out[rows, top[sel]] = new
    return out


def fit_favourite(p, y, from_p=0.6):
    grid = np.arange(0.90, 1.61, 0.02)
    best = min(grid, key=lambda s: losses(stretch_favourite(p, s, from_p), y)["log_loss"].mean())
    return lambda q: stretch_favourite(q, best, from_p), f"s {best:.2f}"


LAYERS = {
    "favourite stretch 60 %+": fit_favourite,
    "favourite stretch 70 %+": lambda p, y: fit_favourite(p, y, 0.7),
    "temperature": fit_temperature,
    "temperature + biases": fit_temperature_bias,
    "LUT 5 %, prior 50": lambda p, y: fit_lut(p, y, 0.05, 50),
    "LUT 5 %, prior 200": lambda p, y: fit_lut(p, y, 0.05, 200),
    "LUT 10 %, prior 50": lambda p, y: fit_lut(p, y, 0.10, 50),
    "isotonic": fit_isotonic,
}


def walk_forward(p, y, season, fit):
    out = p.copy()
    picks = []
    for s in sorted(set(season[season >= FIRST_TEST])):
        train, test = season < s, season == s
        apply, label = fit(p[train], y[train])
        out[test] = apply(p[test])
        picks.append(f"{s}: {label}")
    return out, picks


def tstat(d):
    return d.mean() / (d.std(ddof=1) / np.sqrt(len(d)))


def favourites(p, y, keep, lo=0.7):
    top = p.max(1)
    sel = keep & (top >= lo)
    return sel.sum(), top[sel].mean(), (p[sel].argmax(1) == y[sel]).mean()


def main():
    p, y, season, league = shipped()
    keep = season >= FIRST_TEST
    half = np.zeros(len(y), bool)
    test_idx = np.flatnonzero(keep)
    half[test_idx[len(test_idx) // 2:]] = True
    base = losses(p, y)
    print(f"{MODEL_VERSION}: {keep.sum()} matches scored {FIRST_TEST}-{season.max()}, both divisions, "
          f"fitted on the seasons before each")
    n, pred, won = favourites(p, y, keep)
    print(f"shipped favourites >= 70 %: {n} matches, priced {pred:.1%}, won {won:.1%}")
    print(f"{'layer':22s} {'log loss':>9s} {'t':>6s} {'Brier':>9s} {'t':>6s} {'RPS':>9s} {'t':>6s}  halves (ll)       fav >= 70 %")
    for name, fit in LAYERS.items():
        q, picks = walk_forward(p, y, season, fit)
        var = losses(q, y)
        cells = []
        for metric in ("log_loss", "brier", "rps"):
            d = (var[metric] - base[metric])[keep]
            cells.append(f"{d.mean():+9.5f} {tstat(d):+6.2f}")
        h1 = (var["log_loss"] - base["log_loss"])[keep & ~half]
        h2 = (var["log_loss"] - base["log_loss"])[keep & half]
        fn, fpred, fwon = favourites(q, y, keep)
        print(f"{name:22s} {' '.join(cells)}  {h1.mean():+.5f}/{h2.mean():+.5f}  {fn} at {fpred:.1%}, won {fwon:.1%}")
        if name in ("temperature", "temperature + biases") or name.startswith("favourite"):
            print("    " + "; ".join(picks))
    for lg in ("eliteserien", "obosligaen"):
        q, _ = walk_forward(p, y, season, fit_temperature)
        sel = keep & (league == lg)
        d = (losses(q, y)["log_loss"] - base["log_loss"])[sel]
        print(f"temperature, {lg}: {d.mean():+.5f} (t {tstat(d):+.2f}, n {sel.sum()})")


if __name__ == "__main__":
    main()
