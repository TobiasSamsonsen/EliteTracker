"""Luck view: signals that might separate more of the skill from the luck
(October 2026, the owner's idea).

The shipped luck (public/app.js `luckChances`, `luckRows`, `luckTrend`,
`withTrend`): each match's xG scaled by each side's finishing over its last
20 matches and the other side's keeping over its last 10, Poisson xG points
of those chances, a trend on xG points a match, and luck the points left
over. Reproduced here first (against the plain xG points it should give the
logged -17.3 in mean squared luck a club season), then each candidate:

- shots: the goals of each side from its shots one by one (Poisson-binomial)
  instead of a Poisson on the match total; the same finishing and keeping
  scale. Many small chances score less often than one big chance of the
  same xG, which the total cannot see.
- shots, rebounds: the shots a side takes in the same minute as one chance
  (they cannot both score), 1 - prod(1 - p); with and without rescaling to
  the match xG.
- penalties: each side's penalty xG replaced by the division's penalty xG a
  side-match (being given one is mostly luck).
- market trend: the trend on the closing market's expected points a match
  instead of (or beside) the xG points a match; quality priced before the
  matches rather than read off the same season's chances.
- market blend: the usual points per match partly the market's expected
  points, (1 - lam) * chances + lam * market.
- red cards: a diagnostic of what is left over in matches with a sending-off.

Game-state weighting is left out on purpose: a side is ahead because it
scored, so weighting its xG by the score would hand the scorer's luck back
to it as "usual".

Eliteserien only (shots, xGoT and closing odds for every match 2020-2025);
fitted on the 96 club seasons 2020-2025 as the view is, scored on the 80 of
2021-2025 (2020 has no form before it), paired against the shipped luck.

    .venv/Scripts/python experiments/improvements/luck_signals.py
"""

from __future__ import annotations

import json
import math

import numpy as np

SEASONS = range(2020, 2026)
SCORED = range(2021, 2026)
FINISHING, KEEPING, LEAGUE = 20, 10, 240

XG = json.load(open("data/xg.json", encoding="utf-8"))["matches"]
EXTRAS = json.load(open("data/raw/fotmob_match_extras.json", encoding="utf-8"))
ODDS = json.load(open("data/odds_closing.json", encoding="utf-8"))


def load() -> list[dict]:
    out = []
    for season in SEASONS:
        for m in json.load(open(f"data/normalized/eliteserien_{season}_matches.json", encoding="utf-8")):
            x = XG.get(m["match_id"])
            if not m.get("played") or m.get("home_goals") is None or not x:
                continue
            out.append({
                "id": m["match_id"], "season": season, "date": m["date"], "home": m["home_id"], "away": m["away_id"],
                "hg": m["home_goals"], "ag": m["away_goals"], "xg": (x[0], x[1]),
                "xgot": (x[2], x[3]) if len(x) >= 4 else None,
            })
    out.sort(key=lambda r: (r["date"], r["home"]))
    return out


MATCHES = load()


# --- goals distributions and points --------------------------------------

def poisson(lam: float, kmax: int = 12) -> list[float]:
    p, out = math.exp(-lam), []
    for k in range(kmax + 1):
        if k:
            p *= lam / k
        out.append(p)
    return out


def pbinom(ps: list[float]) -> list[float]:
    dist = [1.0]
    for p in ps:
        p = min(p, 0.97)
        new = [0.0] * (len(dist) + 1)
        for k, v in enumerate(dist):
            new[k] += v * (1 - p)
            new[k + 1] += v * p
        dist = new
    return dist


def outcomes(dh: list[float], da: list[float]) -> tuple[float, float]:
    """(home win, draw) from the two goals distributions."""
    mh, ma = sum(dh), sum(da)
    below = [0.0]
    for v in da:
        below.append(below[-1] + v)
    home = sum(v * below[min(k, len(da))] for k, v in enumerate(dh))
    draw = sum(v * da[k] for k, v in enumerate(dh) if k < len(da))
    return home / (mh * ma), draw / (mh * ma)


def points(dh: list[float], da: list[float]) -> tuple[float, float]:
    mh, ma = sum(dh), sum(da)
    cum, home, draw = 0.0, 0.0, 0.0
    below = [0.0]
    for v in da:
        below.append(below[-1] + v)
    for k, v in enumerate(dh):
        home += v * below[min(k, len(da))]
        if k < len(da):
            draw += v * da[k]
    home, draw = home / (mh * ma), draw / (mh * ma)
    return 3 * home + draw, 3 * (1 - home - draw) + draw


def xg_points(lam: float, mu: float) -> tuple[float, float]:
    return points(poisson(lam), poisson(mu))


# --- shots, the right way round (shots_local.py) ---------------------------

def shots_of(r: dict):
    e = EXTRAS.get(r["id"])
    if not e:
        return None
    shots = e["shots"]
    s = [sum(x[2] for x in shots if x[1] == k) for k in (0, 1)]
    same = abs(s[0] - r["xg"][0]) + abs(s[1] - r["xg"][1])
    swap = abs(s[1] - r["xg"][0]) + abs(s[0] - r["xg"][1])
    home = 1 if swap <= same else 0
    sides = [[x for x in shots if x[1] == home and not x[4]], [x for x in shots if x[1] != home and not x[4]]]
    cards = [[c for c in e.get("cards", []) if c[1] == home], [c for c in e.get("cards", []) if c[1] != home]]
    return sides, cards


SHOTS = {r["id"]: shots_of(r) for r in MATCHES}
PEN_SIDE = (
    sum(x[2] for v in SHOTS.values() if v for side in v[0] for x in side if x[3] == "Penalty")
    / (2 * sum(1 for v in SHOTS.values() if v))
)


def groups(side: list) -> list[float]:
    """Shots in the same minute as one chance: 1 - prod(1 - p)."""
    out, last, acc = [], None, None
    for x in sorted(side, key=lambda x: x[0]):
        if x[0] == last:
            acc *= 1 - min(x[2], 0.97)
        else:
            if acc is not None:
                out.append(1 - acc)
            acc, last = 1 - min(x[2], 0.97), x[0]
    if acc is not None:
        out.append(1 - acc)
    return out


# --- finishing and keeping before each match (luckChances) ----------------

def scales(fin_top: int = 0, n_fin: int = FINISHING, n_keep: int = KEEPING,
           w_fin: float = 1.0, w_keep: float = 1.0) -> dict[str, tuple[float, float]]:
    """match id -> (home, away) factor on the xG: exp(w_fin * finishing -
    w_keep * keeping), each over its window; the shipped at the defaults."""
    clubs: dict[str, list] = {}
    league: list = []

    def ratio(rows, top, bottom):
        a, b = sum(row[top] for row in rows), sum(row[bottom] for row in rows)
        return math.log(a / b) if a > 0 and b > 0 else None

    def form(team, n, top, bottom, reference):
        rows = [row for row in clubs.get(team, []) if (row[3] is not None and row[4] is not None) or top not in (3, 4)][-n:]
        if len(rows) < n // 2 or reference is None:
            return 0.0
        mine = ratio(rows, top, bottom)
        return 0.0 if mine is None else mine - reference

    out = {}
    for r in MATCHES:
        finishing = ratio([row for row in league if row[4] is not None or fin_top != 4], fin_top, 1)
        keeping = ratio([row for row in league if row[3] is not None], 3, 2)
        h, a = r["home"], r["away"]
        out[r["id"]] = (
            math.exp(w_fin * form(h, n_fin, fin_top, 1, finishing) - w_keep * form(a, n_keep, 3, 2, keeping)),
            math.exp(w_fin * form(a, n_fin, fin_top, 1, finishing) - w_keep * form(h, n_keep, 3, 2, keeping)),
        )
        xgot = r["xgot"]
        for team, row in ((h, [r["hg"], r["xg"][0], r["ag"], xgot[1] if xgot else None, xgot[0] if xgot else None]),
                          (a, [r["ag"], r["xg"][1], r["hg"], xgot[0] if xgot else None, xgot[1] if xgot else None])):
            clubs[team] = (clubs.get(team, []) + [row])[-200:]
            league.append(row)
        league = league[-LEAGUE:]
    return out


SCALE = scales()
SCALE_SHOOTING = scales(fin_top=4)


# --- the chances of each variant: match id -> (home, away) points ---------

def chances_plain(r):
    return xg_points(*r["xg"])


def chances_shipped(r):
    fh, fa = SCALE[r["id"]]
    return xg_points(r["xg"][0] * fh, r["xg"][1] * fa)


def shot_chances(group: bool, rescale: bool):
    def chances(r):
        v = SHOTS[r["id"]]
        if not v:
            return chances_shipped(r)
        dists = []
        for side, (xg, f) in zip(v[0], zip(r["xg"], SCALE[r["id"]])):
            ps = groups(side) if group else [x[2] for x in side]
            total = sum(ps)
            k = f * (xg / total if rescale and total > 0 else (xg / sum(x[2] for x in side) if side and sum(x[2] for x in side) > 0 else 1.0))
            dists.append(pbinom([p * k for p in ps]) if ps else [1.0])
        return points(*dists)
    return chances


def chances_shooting(r):
    fh, fa = SCALE_SHOOTING[r["id"]]
    return xg_points(r["xg"][0] * fh, r["xg"][1] * fa)


def red_term(c: float):
    """The shipped chances, plus c to the side whose opponent alone was sent off (minus c to it)."""
    def chances(r):
        ch = list(chances_shipped(r))
        v = SHOTS[r["id"]]
        if v:
            reds = [any(x[2] in ("Red", "YellowRed") for x in side) for side in v[1]]
            if reds[0] != reds[1]:
                sign = 1 if reds[1] else -1
                ch[0] += sign * c
                ch[1] -= sign * c
        return tuple(ch)
    return chances


def chances_penalty(r):
    v = SHOTS[r["id"]]
    fh, fa = SCALE[r["id"]]
    if not v:
        return chances_shipped(r)
    pen = [sum(x[2] for x in side if x[3] == "Penalty") for side in v[0]]
    return xg_points((r["xg"][0] - pen[0] + PEN_SIDE) * fh, (r["xg"][1] - pen[1] + PEN_SIDE) * fa)


def market(r) -> tuple[float, float]:
    ph, pd, pa = ODDS[r["id"]]
    return 3 * ph + pd, 3 * pa + pd


# --- club seasons ----------------------------------------------------------

def club_seasons(chances, lam: float = 0.0) -> list[dict]:
    rows: dict[tuple, dict] = {}
    for r in MATCHES:
        plain, ch, mk = chances_plain(r), chances(r), market(r)
        for i, (team, scored, conceded) in enumerate(((r["home"], r["hg"], r["ag"]), (r["away"], r["ag"], r["hg"]))):
            row = rows.setdefault((team, r["season"]), {"team": team, "season": r["season"], "m": []})
            pts = 3 if scored > conceded else 1 if scored == conceded else 0
            row["m"].append((pts, plain[i], (1 - lam) * ch[i] + lam * mk[i], mk[i], r["id"], i))
    out = []
    for row in rows.values():
        arr = np.array([m[:4] for m in row["m"]])
        row.update(n=len(arr), points=arr[:, 0].sum(), xpts=arr[:, 1].sum(), chances=arr[:, 2].sum(), mkt=arr[:, 3].sum(), arr=arr)
        out.append(row)
    return out


def fit(rows: list[dict], trend: str) -> np.ndarray:
    """Least squares of the gap a match on the trend's quality terms."""
    if trend == "none":
        return np.zeros(4)
    y = np.array([(r["points"] - r["chances"]) / r["n"] for r in rows])
    cols = [np.ones(len(rows))]
    cols.append(np.array([r["xpts"] / r["n"] for r in rows]) if trend in ("xg", "both") else np.zeros(len(rows)))
    cols.append(np.array([r["mkt"] / r["n"] for r in rows]) if trend in ("mkt", "both") else np.zeros(len(rows)))
    cols.append(np.array([(r["xpts"] / r["n"]) ** 2 for r in rows]) if trend == "xg2" else np.zeros(len(rows)))
    if trend == "xg2":
        cols[1] = np.array([r["xpts"] / r["n"] for r in rows])
    X = np.column_stack(cols)
    used = [0] + [i for i in (1, 2, 3) if X[:, i].any()]
    coef = np.zeros(4)
    coef[used] = np.linalg.lstsq(X[:, used], y, rcond=None)[0]
    return coef


def luck(row: dict, coef: np.ndarray, arr: np.ndarray | None = None) -> float:
    a = row["arr"] if arr is None else arr
    # The curved term reads the club season's xG points a match, as the fit does.
    return (a[:, 0].sum() - a[:, 2].sum() - coef[0] * len(a) - coef[1] * a[:, 1].sum() - coef[2] * a[:, 3].sum()
            - coef[3] * (row["xpts"] / row["n"]) ** 2 * len(a))


def corr(a, b) -> float:
    return float(np.corrcoef(a, b)[0, 1])


def score(rows: list[dict], trend: str) -> dict:
    coef = fit(rows, trend)
    scored = sorted((r for r in rows if r["season"] in SCORED), key=lambda r: (r["season"], r["team"]))
    lk = np.array([luck(r, coef) for r in scored])
    # Leave one season out: the trend fitted without the season it scores.
    loso = np.array([luck(r, fit([q for q in rows if q["season"] != r["season"]], trend)) for r in scored])
    halves = [(luck(r, coef, r["arr"][0::2]), luck(r, coef, r["arr"][1::2])) for r in scored]
    by = {(r["team"], r["season"]): lk[i] / r["n"] for i, r in enumerate(scored)}
    pairs = [(v, by[(t, s + 1)]) for (t, s), v in by.items() if (t, s + 1) in by]
    return {
        "coef": coef, "luck": lk, "loso": loso,
        "sd": float(lk.std()),
        "q_xg": corr(lk / [r["n"] for r in scored], [r["xpts"] / r["n"] for r in scored]),
        "q_mkt": corr(lk / [r["n"] for r in scored], [r["mkt"] / r["n"] for r in scored]),
        "half": corr(*zip(*halves)),
        "y2y": corr(*zip(*pairs)), "n_y2y": len(pairs),
    }


def paired(a: np.ndarray, b: np.ndarray) -> str:
    d = a ** 2 - b ** 2
    return f"{d.mean():+.2f} (t {d.mean() / (d.std(ddof=1) / math.sqrt(len(d))):+.2f})"


def main() -> None:
    n_shots = sum(1 for r in MATCHES if SHOTS[r["id"]])
    print(f"Eliteserien {SEASONS.start}-{SEASONS.stop - 1}: {len(MATCHES)} matches, shots for {n_shots}; "
          f"penalty xG a side-match {PEN_SIDE:.4f}")

    variants = [
        ("plain xG points, xG trend", chances_plain, 0.0, "xg"),
        ("shipped (fin 20 + keep 10, xG trend)", chances_shipped, 0.0, "xg"),
        ("shipped, no trend", chances_shipped, 0.0, "none"),
        ("shots one by one", shot_chances(False, False), 0.0, "xg"),
        ("shots, same-minute rebounds as one", shot_chances(True, False), 0.0, "xg"),
        ("shots, rebounds as one, rescaled to the xG", shot_chances(True, True), 0.0, "xg"),
        ("penalties at the division's rate", chances_penalty, 0.0, "xg"),
        ("market trend in place of the xG trend", chances_shipped, 0.0, "mkt"),
        ("market and xG trend together", chances_shipped, 0.0, "both"),
    ]
    variants += [
        ("finishing from xG on target (shooting), not goals", chances_shooting, 0.0, "xg"),
        ("a curved trend (xG points a match squared too)", chances_shipped, 0.0, "xg2"),
        ("red cards: +0.18 to the side a man up", red_term(0.18), 0.0, "xg"),
        ("shots, rebounds as one, + red cards", lambda r: (lambda a, b: (a[0] + b[0] - chances_shipped(r)[0], a[1] + b[1] - chances_shipped(r)[1]))(shot_chances(True, False)(r), red_term(0.18)(r)), 0.0, "xg"),
    ]
    variants += [(f"market blend lam {lam}, xG trend", chances_shipped, lam, "xg") for lam in (0.1, 0.2, 0.3, 0.5)]
    variants += [(f"market blend lam {lam}, market trend", chances_shipped, lam, "mkt") for lam in (0.2, 0.5)]
    results = {}
    for name, chances, lam, trend in variants:
        results[name] = score(club_seasons(chances, lam), trend)

    base, plain = results["shipped (fin 20 + keep 10, xG trend)"], results["plain xG points, xG trend"]
    print(f"\nreproduction: shipped against plain xG points {paired(base['luck'], plain['luck'])}"
          f" (logged -17.30, t -3.01); trend slope {base['coef'][1]:.3f} (logged 0.248)")
    print(f"\n{len(base['luck'])} club seasons {SCORED.start}-{SCORED.stop - 1}; mean squared luck a club season against the shipped, paired\n")
    print("| variant | mean sq luck | vs shipped (t) | trend left out of the fit's season (t) | sd | r quality xG / market | r halves | r year to year |")
    print("|---|---|---|---|---|---|---|---|")
    for name, s in results.items():
        print(f"| {name} | {np.mean(s['luck'] ** 2):.2f} | {paired(s['luck'], base['luck'])} | {paired(s['loso'], base['loso'])} | "
              f"{s['sd']:.2f} | {s['q_xg']:+.2f} / {s['q_mkt']:+.2f} | {s['half']:+.2f} | {s['y2y']:+.2f} (n {s['n_y2y']}) |")
    for name in ("market trend in place of the xG trend", "market and xG trend together"):
        print(f"{name}: coefficients a, xG, market = {', '.join(f'{c:+.3f}' for c in results[name]['coef'])}")

    # The floor: the luck a club season would have if every match were drawn
    # from the shipped chances themselves -- the variance of a match's points
    # under its own odds, summed. Luck at the floor has nothing left to find.
    floors = {}
    for label, dist in (("Poisson on the scaled xG", lambda r, i: poisson(r["xg"][i] * SCALE[r["id"]][i])),):
        per: dict[tuple, float] = {}
        for r in MATCHES:
            if r["season"] not in SCORED:
                continue
            w, d = outcomes(dist(r, 0), dist(r, 1))
            l = 1 - w - d
            for i, (pw, pl) in enumerate(((w, l), (l, w))):
                key = (r["home"] if i == 0 else r["away"], r["season"])
                per[key] = per.get(key, 0.0) + 9 * pw + d - (3 * pw + d) ** 2
        floors[label] = np.mean(list(per.values()))
    for label, f in floors.items():
        print(f"\nnoise floor ({label}): mean squared luck a club season {f:.2f}, against the shipped {np.mean(base['luck'] ** 2):.2f}")

    # Red cards: what is left over a match, by who was sent off.
    rows = club_seasons(chances_shipped)
    coef = fit(rows, "xg")
    left = {"own red": [], "opponent red": [], "none": []}
    for r in MATCHES:
        if r["season"] not in SCORED or not SHOTS[r["id"]]:
            continue
        cards = SHOTS[r["id"]][1]
        reds = [any(c[2] in ("Red", "YellowRed") for c in side) for side in cards]
        ch, plain = chances_shipped(r), chances_plain(r)
        for i, (scored, conceded) in enumerate(((r["hg"], r["ag"]), (r["ag"], r["hg"]))):
            pts = 3 if scored > conceded else 1 if scored == conceded else 0
            res = pts - ch[i] - coef[0] - coef[1] * plain[i]
            key = "own red" if reds[i] and not reds[1 - i] else "opponent red" if reds[1 - i] and not reds[i] else "none" if not any(reds) else None
            if key:
                left[key].append(res)
    print("\nred cards, points left over a match side (shipped luck):")
    for key, v in left.items():
        v = np.array(v)
        print(f"  {key}: n {len(v)}, {v.mean():+.3f} a match (t {v.mean() / (v.std(ddof=1) / math.sqrt(len(v))):+.2f})")


def null_world(runs: int = 20, seed: int = 2026) -> None:
    """The same matches with no skill in them: goals drawn Poisson from each
    side's xG, xG on target the division's share of it, so finishing and
    keeping carry nothing real and every point above the xG points is luck.
    A method that separates skill from luck should leave that luck as it is;
    one that shrinks it is soaking luck up into the usual points."""
    global MATCHES, SCALE
    real = MATCHES
    share = (sum(r["xgot"][0] + r["xgot"][1] for r in real) / sum(r["xg"][0] + r["xg"][1] for r in real))
    rng = np.random.default_rng(seed)
    rows_out = {"plain": [], "shipped": [], "plain, no trend": [], "shipped, no trend": []}
    for _ in range(runs):
        MATCHES = [{**r, "hg": int(rng.poisson(r["xg"][0])), "ag": int(rng.poisson(r["xg"][1])),
                    "xgot": (r["xg"][0] * share, r["xg"][1] * share)} for r in real]
        SCALE = scales()
        truth = score(club_seasons(chances_plain), "none")["luck"]
        for name, chances, trend in (("plain", chances_plain, "xg"), ("shipped", chances_shipped, "xg"),
                                     ("plain, no trend", chances_plain, "none"), ("shipped, no trend", chances_shipped, "none")):
            s = score(club_seasons(chances), trend)
            rows_out[name].append((np.mean(truth ** 2), np.mean(s["luck"] ** 2), corr(s["luck"], truth), s["half"]))
    MATCHES, SCALE = real, scales()
    print(f"\nno-skill world, {runs} runs (all of it luck; the true luck's mean square is the floor):")
    print("| method | true luck mean sq | measured luck mean sq | r with the true luck | r halves |")
    print("|---|---|---|---|---|")
    for name, v in rows_out.items():
        a = np.array(v)
        print(f"| {name} | {a[:, 0].mean():.2f} | {a[:, 1].mean():.2f} (sd {a[:, 1].std():.2f}) | {a[:, 2].mean():+.2f} | {a[:, 3].mean():+.2f} |")


def match_loss(scale: dict, shots: bool = False) -> np.ndarray:
    """Per scored match, the log loss of its result under its own chances
    scaled by `scale` (Poisson on the scaled xG, or its shots one by one
    with same-minute rebounds as one chance). The form before a match is
    read from the matches before it, so this is a forecast of each match and
    cannot be helped by soaking up a season's luck."""
    out = []
    for r in MATCHES:
        if r["season"] not in SCORED:
            continue
        f = scale[r["id"]]
        if shots and SHOTS[r["id"]]:
            dists = []
            for side, xg, k in zip(SHOTS[r["id"]][0], r["xg"], f):
                ps = groups(side)
                raw = sum(x[2] for x in side)
                dists.append(pbinom([p * k * (xg / raw if raw > 0 else 1.0) for p in ps]) if ps else [1.0])
        else:
            dists = [poisson(r["xg"][0] * f[0]), poisson(r["xg"][1] * f[1])]
        w, d = outcomes(*dists)
        p = w if r["hg"] > r["ag"] else d if r["hg"] == r["ag"] else 1 - w - d
        out.append(-math.log(max(p, 1e-9)))
    return np.array(out)


def prior_scales(w_fin: float, w_keep: float) -> dict:
    """match id -> factor from last season's finishing (log goals / xG) and
    keeping (log xG on target faced / goals let in), each against the
    division's that season; fixed before the season, so it cannot follow
    this season's luck. Clubs not in the division last season get 0."""
    tot: dict[tuple, list] = {}
    for r in MATCHES:
        for team, row in ((r["home"], (r["hg"], r["xg"][0], r["ag"], r["xgot"][1])),
                          (r["away"], (r["ag"], r["xg"][1], r["hg"], r["xgot"][0]))):
            acc = tot.setdefault((team, r["season"]), [0.0] * 4)
            for i, v in enumerate(row):
                acc[i] += v
    league = {}
    for (team, season), acc in tot.items():
        lg = league.setdefault(season, [0.0] * 4)
        for i, v in enumerate(acc):
            lg[i] += v
    fin = {k: math.log(v[0] / v[1]) - math.log(league[k[1]][0] / league[k[1]][1]) for k, v in tot.items() if v[0] > 0}
    keep = {k: math.log(v[3] / v[2]) - math.log(league[k[1]][3] / league[k[1]][2]) for k, v in tot.items() if v[2] > 0}
    out = {}
    for r in MATCHES:
        h, a, prev = r["home"], r["away"], r["season"] - 1
        out[r["id"]] = (
            math.exp(w_fin * fin.get((h, prev), 0.0) - w_keep * keep.get((a, prev), 0.0)),
            math.exp(w_fin * fin.get((a, prev), 0.0) - w_keep * keep.get((h, prev), 0.0)),
        )
    return out


def prior_test() -> None:
    """Last season's finishing and keeping, on both measures, and in the no-skill world."""
    global SCALE, MATCHES
    shipped_scale = SCALE
    plain_luck = score(club_seasons(chances_plain), "xg")["luck"]
    plain_ll = match_loss(scales(w_fin=0.0, w_keep=0.0))
    print("\nlast season's finishing and keeping, against the plain xG points (negative is better)")
    print("| finishing w / keeping w | mean sq luck a club season (t) | per-match log loss (t) | r halves |")
    print("|---|---|---|---|")
    grid = [(wf, wk) for wf in (0.0, 0.25, 0.5, 0.7, 1.0) for wk in (0.0, 0.25, 0.5) if wf or wk]
    for wf, wk in grid:
        SCALE = prior_scales(wf, wk)
        s = score(club_seasons(chances_shipped), "xg")
        print(f"| {wf} / {wk} | {paired(s['luck'], plain_luck)} | {paired_ll(match_loss(SCALE), plain_ll)} | {s['half']:+.2f} |")
    real = MATCHES
    share = (sum(r["xgot"][0] + r["xgot"][1] for r in real) / sum(r["xg"][0] + r["xg"][1] for r in real))
    rng = np.random.default_rng(11)
    d_luck, d_ll = [], []
    for _ in range(20):
        MATCHES = [{**r, "hg": int(rng.poisson(r["xg"][0])), "ag": int(rng.poisson(r["xg"][1])),
                    "xgot": (r["xg"][0] * share, r["xg"][1] * share)} for r in real]
        base_luck = score(club_seasons(chances_plain), "xg")["luck"]
        SCALE = prior_scales(0.5, 0.0)
        d_luck.append(np.mean(score(club_seasons(chances_shipped), "xg")["luck"] ** 2) - np.mean(base_luck ** 2))
        d_ll.append((match_loss(SCALE) - match_loss(scales(w_fin=0.0, w_keep=0.0))).mean())
    MATCHES, SCALE = real, shipped_scale
    print(f"no-skill world, 20 runs, last season's finishing x 0.5: mean sq luck {np.mean(d_luck):+.2f} (sd {np.std(d_luck):.2f}),"
          f" per-match log loss {np.mean(d_ll):+.5f} (sd {np.std(d_ll):.5f})")


def paired_ll(a: np.ndarray, b: np.ndarray) -> str:
    d = a - b
    return f"{d.mean():+.5f} (t {d.mean() / (d.std(ddof=1) / math.sqrt(len(d))):+.2f})"


GRID_FIN = [(n, w) for n in (20, 45, 90) for w in (0.25, 0.5, 1.0)]
GRID_KEEP = [(n, w) for n in (10, 20, 45) for w in (0.25, 0.5, 1.0)]


def per_match() -> None:
    plain = match_loss(scales(w_fin=0.0, w_keep=0.0))
    print(f"\nper match, {len(plain)} matches {SCORED.start}-{SCORED.stop - 1}: log loss of the result against the plain xG"
          f" (plain {plain.mean():.5f}); negative is better")
    print("| chances | log loss vs plain (t) |")
    print("|---|---|")
    rows = [("shipped: finishing 20 + keeping 10, full weight", scales())]
    rows += [(f"finishing {n} x {w}", scales(n_fin=n, w_fin=w, w_keep=0.0)) for n, w in GRID_FIN]
    rows += [(f"keeping {n} x {w}", scales(n_keep=n, w_keep=w, w_fin=0.0)) for n, w in GRID_KEEP]
    for name, scale in rows:
        print(f"| {name} | {paired_ll(match_loss(scale), plain)} |")
    print(f"| shots one by one, rebounds as one (no form) | {paired_ll(match_loss(scales(w_fin=0.0, w_keep=0.0), shots=True), plain)} |")
    print(f"| shots + shipped form | {paired_ll(match_loss(scales(), shots=True), plain)} |")


def per_match_null(runs: int = 20, seed: int = 7) -> None:
    """The same per-match test in the no-skill world: a form term can only
    hurt there, by how much is what the real data has to beat."""
    global MATCHES
    real = MATCHES
    share = (sum(r["xgot"][0] + r["xgot"][1] for r in real) / sum(r["xg"][0] + r["xg"][1] for r in real))
    rng = np.random.default_rng(seed)
    diffs = []
    for _ in range(runs):
        MATCHES = [{**r, "hg": int(rng.poisson(r["xg"][0])), "ag": int(rng.poisson(r["xg"][1])),
                    "xgot": (r["xg"][0] * share, r["xg"][1] * share)} for r in real]
        diffs.append((match_loss(scales()) - match_loss(scales(w_fin=0.0, w_keep=0.0))).mean())
    MATCHES = real
    print(f"no-skill world, {runs} runs: shipped form vs plain, per-match log loss {np.mean(diffs):+.5f} (sd {np.std(diffs):.5f})")


if __name__ == "__main__":
    main()
    null_world()
    per_match()
    per_match_null()
    prior_test()
