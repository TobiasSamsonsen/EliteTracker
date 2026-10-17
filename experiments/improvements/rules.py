"""IMPROVEMENTS2.md (the plan after elo-v15.0), section 0: the windows and the
ship rules on the harness. Every script of that pass imports this.

Windows, all scored 2016+ unless the name says otherwise:
    all16  both divisions                 es16 / ob16  one division
    es21 / ob21  one division, 2021+      xg  the matches that carry xG
    fav70  the shipped odds price the favourite at 70 % or more
A script may add its own (rank6_tablestakes.py: the run-in).

The owner relaxed the |t| >= 2 bars for this pass (2026-10-17: every
improvement counts): "relaxed" is the out-of-sample part alone -- log loss,
Brier and RPS negative, both halves negative, t <= -1. Both verdicts print.

The rules (section 0.3):
- one knob, no new data: each season from 2019 scored with the value that did
  best on the seasons before it (`harness.oos`); out of sample log loss, Brier
  and RPS all negative, log loss negative in both date halves, t <= -1, and
  in-sample |t| >= 2 for the best value. Ship a value shrunk toward no change.
- new data or a structural term: |t| >= 2 in-sample on the target window,
  negative in both halves, and the Eliteserien closing-line gap (power
  de-vig, `model/benchmark.py`) not worse.

    PYTHONPATH=experiments/improvements .venv/Scripts/python -c "import rules"
"""

from __future__ import annotations

import numpy as np

import harness as h
from elitetracker.model.benchmark import devig, load_prices

BASE_ELO, BASE_AD, BASE = h.shipped()
W = dict(h.WINDOWS)
W["es21"] = h.mask((2021, 2100), "eliteserien")
W["ob21"] = h.mask((2021, 2100), "obosligaen")
W["fav70"] = h.mask() & (BASE.max(axis=1) >= 0.70)
ORDER = ("all16", "es16", "ob16", "es21", "ob21", "xg", "fav70")

PRICES = load_prices()
MARKET = np.full((len(h.IDS), 3), np.nan)
for _i, _mid in enumerate(h.IDS):
    if _mid in PRICES:
        MARKET[_i] = devig(PRICES[_mid], "power")
ODDS = W["es16"] & ~np.isnan(MARKET[:, 0])


def cells(var: np.ndarray, base: np.ndarray, keep: np.ndarray) -> str:
    c = h.compare(var, base, keep)
    hm, ht = c["ll_hmeans"], c["ll_halves"]
    return (f"{c['n']} | {c['ll'][0]:+.5f} ({c['ll'][1]:+.2f}) | {c['brier'][0]:+.5f} ({c['brier'][1]:+.2f}) | "
            f"{c['rps'][0]:+.5f} ({c['rps'][1]:+.2f}) | {hm[0]:+.5f} / {hm[1]:+.5f} ({ht[0]:+.2f} / {ht[1]:+.2f})")


HEAD = "| window | n | log loss (t) | Brier (t) | RPS (t) | halves, log loss (t) |\n|---|---|---|---|---|---|"


def table(name: str, var: np.ndarray, base: np.ndarray = BASE, windows=ORDER, extra: dict | None = None) -> None:
    """Paired against `base` (the shipped odds) on every window."""
    print(f"\n{name}\n{HEAD}")
    pool = {**W, **(extra or {})}
    for w in windows:
        print(f"| {w} | {cells(var, base, pool[w])} |")


def market_gap(p: np.ndarray) -> float:
    """Log loss above the Eliteserien closing line (power de-vig), 2016+."""
    return float(h.losses(p[ODDS], h.Y[ODDS])["ll"].mean() - h.losses(MARKET[ODDS], h.Y[ODDS])["ll"].mean())


def favourites(p: np.ndarray, keep: np.ndarray | None = None) -> str:
    """Favourites priced 70 %+ by `p` itself, 2016+: n, mean price, won."""
    keep = h.mask() if keep is None else keep
    fav = keep & (p.max(axis=1) >= 0.70)
    won = p[fav].argmax(axis=1) == h.Y[fav]
    return f"n {int(fav.sum())}, priced {p[fav].max(axis=1).mean():.3f}, won {won.mean():.3f}"


def one_knob(name: str, family: dict, base_key, target: str = "all16", restrict=None, first: int = 2019,
             ship=None) -> dict:
    """Section 0.3, first bullet. `family` maps each value to its odds (n x 3);
    `restrict` limits the walk-forward selection (e.g. to xG matches). The
    in-sample bar applies to `ship`, the shrunk value that would ship, or
    without one to the best value in-sample."""
    chosen, picks = h.oos(family, base_key, first=first, restrict=restrict)
    base = family[base_key]
    keep = W[target] & (h.SEASON >= first)
    c = h.compare(chosen, base, keep)
    best_key, best = None, None
    for k, v in family.items():
        if k == base_key:
            continue
        ci = h.compare(v, base, W[target])
        if best is None or ci["ll"][0] < best["ll"][0]:
            best_key, best = k, ci
    judged = h.compare(family[ship], base, W[target]) if ship is not None else best
    checks = {
        "OOS LL, Brier, RPS < 0": all(c[m][0] < 0 for m in ("ll", "brier", "rps")),
        "both halves < 0": all(x < 0 for x in c["ll_hmeans"]),
        "OOS t <= -1": c["ll"][1] <= -1.0,
        f"in-sample |t| >= 2 ({'ship ' + str(ship) if ship is not None else 'best'})":
            judged is not None and judged["ll"][0] < 0 and abs(judged["ll"][1]) >= 2.0,
    }
    print(f"\n{name}: walk-forward picks " + " ".join(f"{s}:{p}" for s, p in picks.items()))
    print(f"{HEAD}\n| {target} {first}+ OOS | {cells(chosen, base, keep)} |")
    if best is not None:
        print(f"| {target} in-sample, best ({best_key}) | {cells(family[best_key], base, W[target])} |")
    if ship is not None and ship != best_key:
        print(f"| {target} in-sample, to ship ({ship}) | {cells(family[ship], base, W[target])} |")
    print(f"market gap: shipped {market_gap(base):+.5f}, OOS {market_gap(chosen):+.5f}")
    relaxed = all(list(checks.values())[:3])
    print("rule: " + "; ".join(f"{k} {'yes' if v else 'NO'}" for k, v in checks.items())
          + f" -> strict {'PASS' if all(checks.values()) else 'fail'}, relaxed {'PASS' if relaxed else 'fail'}")
    return {"chosen": chosen, "picks": picks, "oos": c, "best": (best_key, best), "pass": all(checks.values()),
            "relaxed": relaxed}


def structural(name: str, var: np.ndarray, base: np.ndarray = BASE, target: str = "all16",
               extra: dict | None = None) -> bool:
    """Section 0.3, second bullet."""
    keep = {**W, **(extra or {})}[target]
    c = h.compare(var, base, keep)
    d_gap = market_gap(var) - market_gap(base)
    dl = h.losses(var[ODDS], h.Y[ODDS])["ll"] - h.losses(base[ODDS], h.Y[ODDS])["ll"]
    t_gap = h.tstat(dl)
    checks = {
        f"{target} t <= -2": c["ll"][0] < 0 and c["ll"][1] <= -2.0,
        "both halves < 0": all(x < 0 for x in c["ll_hmeans"]),
        "closing-line gap not worse": d_gap <= 0 or t_gap < 1.0,
    }
    print(f"{name}: market gap {market_gap(base):+.5f} -> {market_gap(var):+.5f} ({d_gap:+.5f}, t {t_gap:+.2f}); rule: "
          + "; ".join(f"{k} {'yes' if v else 'NO'}" for k, v in checks.items())
          + f" -> {'PASS' if all(checks.values()) else 'fail'}")
    return all(checks.values())


if __name__ == "__main__":
    h.identity()
    for w in ORDER:
        print(h.summary(f"shipped [{w}]", BASE, W[w]))
    print(f"closing line, Eliteserien 2016+ (n {int(ODDS.sum())}): shipped gap {market_gap(BASE):+.5f}")
    print("favourites, shipped: " + favourites(BASE))
