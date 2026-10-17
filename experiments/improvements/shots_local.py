"""The shots in data/raw/fotmob_match_extras.json (Eliteserien 2020-2026), the
right way round, for rank3_gamestate_xg.py and rank5_openplay_xg.py.

Each shot is [minute, side, xg, situation, own_goal, event]. `side` is 1 for
the home side, not 0: summed by side, the shots give the stored xG
(data/xg.json) the other way round in 1,570 of 1,608 matches, and the goal
list the other way round likewise. extras.py (elo-v13.0's penalty re-test)
read side 0 as home, so it moved the wrong side's penalties; rank5 re-runs it.

`reweigh(weight)` gives a shots table (harness.SHOTS's shape) whose first two
values are the stored xG scaled by each side's weighted share of its own
shots, `weight(shot, ctx) -> float`, times one constant over the corpus so
total xG is unchanged. With every weight 1 it is SHOTS to the bit.
"""

from __future__ import annotations

import json

import numpy as np

import harness as h

X = json.load(open("data/raw/fotmob_match_extras.json", encoding="utf-8"))
MATCH = {m.match_id: m for m, _, _ in h.PLAYED}


def home_side(mid: str) -> int | None:
    """The `side` value of the home team: the orientation whose summed xG is
    nearer the stored xG, unless the goals say otherwise."""
    shots, stored = X[mid]["shots"], h.SHOTS.get(mid)
    if not stored or mid not in MATCH:
        return None
    s = [sum(x[2] for x in shots if x[1] == k) for k in (0, 1)]
    same = abs(s[0] - stored[0]) + abs(s[1] - stored[1])
    swap = abs(s[1] - stored[0]) + abs(s[0] - stored[1])
    return 1 if swap <= same else 0


HOME = {mid: home_side(mid) for mid in X}
HOME = {mid: side for mid, side in HOME.items() if side is not None}


def timeline(mid: str):
    """Each shot as (minute, is_home, xg, situation, home score, away score
    before it), in the feed's order; goals from the shot events (an own goal
    counts for the other side)."""
    hs = HOME[mid]
    score = [0, 0]  # home, away
    out = []
    for minute, side, xg, situation, own, event in X[mid]["shots"]:
        is_home = side == hs
        out.append((minute, is_home, xg, situation, score[0], score[1]))
        if event == "Goal":
            scorer_home = is_home != bool(own)
            score[0 if scorer_home else 1] += 1
    return out, tuple(score)


def check() -> None:
    agree = sum(1 for mid in HOME if timeline(mid)[1] == (MATCH[mid].home_goals, MATCH[mid].away_goals))
    ordered = sum(1 for mid in HOME if [s[0] for s in X[mid]["shots"]] == sorted(s[0] for s in X[mid]["shots"]))
    print(f"shots: {len(HOME)} matches; home is side 1 in {sum(HOME.values())}; the shots' goals give the final "
          f"score in {agree}; shots in minute order in {ordered}")


def reweigh(weight, normalise: bool = True) -> dict:
    per = {}
    raw_total = weighted_total = 0.0
    for mid in HOME:
        sums = {True: [0.0, 0.0], False: [0.0, 0.0]}  # is_home -> [raw, weighted]
        shots, _ = timeline(mid)
        for shot in shots:
            w = weight(shot)
            sums[shot[1]][0] += shot[2]
            sums[shot[1]][1] += w * shot[2]
        per[mid] = sums
        raw_total += sums[True][0] + sums[False][0]
        weighted_total += sums[True][1] + sums[False][1]
    norm = raw_total / weighted_total if normalise else 1.0
    out = dict(h.SHOTS)
    for mid, sums in per.items():
        s = h.SHOTS[mid]
        ratio = [sums[side][1] / sums[side][0] if sums[side][0] > 0 else 1.0 for side in (True, False)]
        out[mid] = (s[0] * ratio[0] * norm, s[1] * ratio[1] * norm) + tuple(s[2:])
    return out


def signal_hook(table: dict):
    """AttackDefence.observed with the xG signal from `table`; finishing and
    keeping keep reading the stored values."""
    def observed(ad, match):
        goals = (float(match.home_goals), float(match.away_goals))
        shots = ad.shots.get(match.match_id)
        cfg = ad.config
        if not shots or cfg.alpha == 0.0:
            return goals[0], goals[1], cfg.k
        sig = table.get(match.match_id, shots)
        a = cfg.alpha
        return (1 - a) * goals[0] + a * sig[0], (1 - a) * goals[1] + a * sig[1], cfg.k_shots or cfg.k
    return observed


def run(table: dict, elo: bool = True, ad: bool = True) -> np.ndarray:
    """The shipped blend with `table` as the xG signal of the Elo update
    and/or the goals model's observation."""
    import rules as r
    e = h.elo_run(h.EloRun(shots=table)) if elo else r.BASE_ELO
    g = h.ad_run(observed_hook=signal_hook(table)).probs if ad else r.BASE_AD.probs
    return h.blend(e, g)


EXTRAS = np.array([m.match_id in HOME for m, _, _ in h.PLAYED])
