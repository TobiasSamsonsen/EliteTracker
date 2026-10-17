"""IMPROVEMENTS2.md Rank 1, on elo-v15.0: the "Bodo/Glimt ceiling".

1A  the xG margin's [0, 1] clamp in the Elo update widened to
    [-e, 1 + e], e 0.05-0.25 or none, with the margin gamma re-swept
    0.05-0.15 (shipped: e 0, gamma 0.10).
1B  the margin as a multiplier on the step where the xG ratio agrees with the
    surprise: change = K (s - E) (1 + m ln(1 + |r|)) when r (s - E) > 0,
    r = ln((xg_h + c) / (xg_a + c)); m 0.25-2, with the shipped margin kept
    or taken out.
1C  the goals model's surprise divided by max(rate, 0.40)^nu (a Pearson-style
    residual), nu 0.15-0.5 x k_shots 0.04-0.06; the plan's form, and one
    normalised by exp(base) so the average step is unchanged.

The Elo variants are judged on Elo's own odds (the displayed ratings, as the
xG margin was in elo-v12.0 and elo-v13.0) and on the shipped blend.

    PYTHONPATH=experiments/improvements .venv/Scripts/python experiments/improvements/rank1_ceiling.py
"""

from __future__ import annotations

import math
from dataclasses import replace

import numpy as np

import harness as h
import rules as r
from elitetracker.model.attack_defence import ADConfig
from elitetracker.model.career import team_ids
from elitetracker.model.elo import actual_score, xg_implied_score

INF = float("inf")


def capped(cap_ext: float, gamma: float):
    def score(hg, ag, hxg, axg, cfg):
        s = actual_score(hg, ag)
        if hxg is not None and axg is not None and cfg.xg_alpha > 0.0:
            s = (1.0 - cfg.xg_alpha) * s + cfg.xg_alpha * xg_implied_score(hxg, axg)
            if gamma:
                c = cfg.xg_margin_smoothing
                ratio = math.log((hxg + c) / (axg + c))
                bonus = math.copysign(gamma * math.log(1.0 + abs(ratio)), ratio)
                s = min(1.0 + cap_ext, max(-cap_ext, s + bonus))
        return s
    return score


def multiplier(m: float):
    def change(k, scored, expected, hxg, axg, cfg):
        d = scored - expected
        if hxg is None or axg is None:
            return k * d
        c = cfg.xg_margin_smoothing
        ratio = math.log((hxg + c) / (axg + c))
        return k * d * (1.0 + m * math.log(1.0 + abs(ratio))) if ratio * d > 0 else k * d
    return change


class Pearson(h.ADX):
    nu = 0.0
    floor = 0.40
    ref = 1.0

    def observe(self, match):
        if not self.nu:
            return super().observe(match)
        home, away = team_ids(match)
        lam, mu = self._learning_rates(home, away, match.date)
        obs_home, obs_away, k = self.observed(match)
        cfg = self.config
        home_surprise = max(-cfg.cap, min(cfg.cap, obs_home - lam)) / (max(lam, self.floor) / self.ref) ** self.nu
        away_surprise = max(-cfg.cap, min(cfg.cap, obs_away - mu)) / (max(mu, self.floor) / self.ref) ** self.nu
        k_home, k_away = k * self._early(home), k * self._early(away)
        self.attack[home] += k_home * home_surprise
        self.defence[away] -= k_away * home_surprise
        self.attack[away] += k_away * away_surprise
        self.defence[home] -= k_home * away_surprise
        self._played[home] = self._played.get(home, 0) + 1
        self._played[away] = self._played.get(away, 0) + 1
        if cfg.finishing_regression < 1.0:
            shots = self.shots.get(match.match_id)
            if shots and match.home_goals is not None and match.away_goals is not None:
                self._season_goals[home] = self._season_goals.get(home, 0.0) + match.home_goals
                self._season_xg[home] = self._season_xg.get(home, 0.0) + shots[0]
                self._season_goals[away] = self._season_goals.get(away, 0.0) + match.away_goals
                self._season_xg[away] = self._season_xg.get(away, 0.0) + shots[1]
        self._record_keeping(match)


def clamp_report() -> None:
    """How often the shipped clamp binds, on the matches with xG."""
    hit_top = hit_bottom = n = 0
    lost = []
    for m, lg, season in h.PLAYED:
        xg = h.SHOTS.get(m.match_id)
        if not xg:
            continue
        cfg = h.era_config(season)
        s = (1 - cfg.xg_alpha) * actual_score(m.home_goals, m.away_goals) + cfg.xg_alpha * xg_implied_score(xg[0], xg[1])
        c = cfg.xg_margin_smoothing
        ratio = math.log((xg[0] + c) / (xg[1] + c))
        raw = s + math.copysign(cfg.xg_margin * math.log(1 + abs(ratio)), ratio)
        n += 1
        if raw > 1:
            hit_top += 1
            lost.append(raw - 1)
        elif raw < 0:
            hit_bottom += 1
            lost.append(-raw)
    print(f"clamp: {n} xG matches; binds above 1 in {hit_top} ({hit_top / n:.1%}), below 0 in {hit_bottom} "
          f"({hit_bottom / n:.1%}); mean cut where it binds {np.mean(lost):.3f}, largest {max(lost):.3f}")


def bodo(p: np.ndarray) -> str:
    """Bodo/Glimt as a 70 %+ favourite, 2021+."""
    keep = h.mask((2021, 2100)) & (p.max(axis=1) >= 0.70)
    rows = [i for i in np.nonzero(keep)[0] if "8402" in team_ids(h.PLAYED[i][0])]
    won = sum(p[i].argmax() == h.Y[i] for i in rows)
    return f"Bodo/Glimt 70 %+ since 2021: {won} of {len(rows)}, priced {np.mean([p[i].max() for i in rows]):.3f}"


if __name__ == "__main__":
    clamp_report()
    ident = h.elo_run(h.EloRun(score=capped(0.0, 0.10)))
    assert abs(ident - r.BASE_ELO).max() == 0.0, "capped(0, 0.10) must be the shipped update"
    print("identity: capped(0, 0.10) = shipped Elo to the bit")
    print("shipped: " + r.favourites(r.BASE) + "; " + bodo(r.BASE))

    # ---- 1A ----
    elo_a = {(0.0, 0.10): r.BASE_ELO}
    for cap in (0.0, 0.05, 0.10, 0.15, 0.25, INF):
        for g in (0.05, 0.08, 0.10, 0.12, 0.15):
            if (cap, g) not in elo_a:
                elo_a[(cap, g)] = h.elo_run(h.EloRun(score=capped(cap, g)))
    print("\n1A in-sample, xG matches (Elo's own odds | blend):")
    for key, e in elo_a.items():
        if key == (0.0, 0.10):
            continue
        ce = h.compare(e, r.BASE_ELO, r.W["xg"])
        cb = h.compare(h.blend(e, r.BASE_AD.probs), r.BASE, r.W["xg"])
        print(f"  cap {key[0]} gamma {key[1]}: Elo {ce['ll'][0]:+.5f} (t {ce['ll'][1]:+.2f}) | blend "
              f"{cb['ll'][0]:+.5f} (t {cb['ll'][1]:+.2f})")
    for cap in (0.10, INF):
        e = elo_a[(cap, 0.10)]
        r.table(f"1A cap {cap}, gamma 0.10, Elo's own odds", e, r.BASE_ELO)
        r.table(f"1A cap {cap}, gamma 0.10, blend", h.blend(e, r.BASE_AD.probs))
        print("  " + r.favourites(h.blend(e, r.BASE_AD.probs)) + "; " + bodo(h.blend(e, r.BASE_AD.probs)))
    r.one_knob("1A walk-forward, Elo's own odds", elo_a, (0.0, 0.10), restrict=h.HAS_XG)
    res = r.one_knob("1A walk-forward, blend", {k: h.blend(v, r.BASE_AD.probs) for k, v in elo_a.items()},
                     (0.0, 0.10), restrict=h.HAS_XG)
    r.table("1A walk-forward pick, blend, 2019+", res["chosen"], r.BASE,
            extra={w: r.W[w] & (h.SEASON >= 2019) for w in r.ORDER})
    # The shrunk form: the clamp taken out, gamma left at the shipped 0.10.
    unclamped = {"shipped": r.BASE_ELO, "no clamp": elo_a[(INF, 0.10)]}
    r.one_knob("1A no clamp, gamma 0.10, Elo's own odds", unclamped, "shipped", restrict=h.HAS_XG, ship="no clamp")
    r.one_knob("1A no clamp, gamma 0.10, blend", {k: h.blend(v, r.BASE_AD.probs) for k, v in unclamped.items()},
               "shipped", restrict=h.HAS_XG, ship="no clamp")
    r.one_knob("1A gamma re-swept with no clamp, Elo's own odds",
               {"no clamp": elo_a[(INF, 0.10)], **{g: elo_a[(INF, g)] for g in (0.05, 0.08, 0.12, 0.15)}},
               "no clamp", restrict=h.HAS_XG)

    # ---- 1B ----
    elo_b = {"shipped": r.BASE_ELO}
    for keep_margin in (True, False):
        for m in (0.25, 0.5, 1.0, 2.0):
            run = h.EloRun(change=multiplier(m))
            if not keep_margin:
                run.score = capped(0.0, 0.0)
            elo_b[(m, "margin" if keep_margin else "no margin")] = h.elo_run(run)
    print("\n1B in-sample, xG matches (Elo's own odds | blend):")
    for key, e in elo_b.items():
        if key == "shipped":
            continue
        ce = h.compare(e, r.BASE_ELO, r.W["xg"])
        cb = h.compare(h.blend(e, r.BASE_AD.probs), r.BASE, r.W["xg"])
        print(f"  m {key[0]} {key[1]}: Elo {ce['ll'][0]:+.5f} (t {ce['ll'][1]:+.2f}) | blend "
              f"{cb['ll'][0]:+.5f} (t {cb['ll'][1]:+.2f})")
    r.table("1B m 0.5, margin kept, Elo's own odds", elo_b[(0.5, "margin")], r.BASE_ELO)
    r.one_knob("1B walk-forward, Elo's own odds", elo_b, "shipped", restrict=h.HAS_XG)
    r.one_knob("1B walk-forward, blend", {k: h.blend(v, r.BASE_AD.probs) for k, v in elo_b.items()}, "shipped",
               restrict=h.HAS_XG)
    # 1B on top of 1A (no clamp): does the multiplier still add?
    on_a = {"no clamp": elo_a[(INF, 0.10)]}
    for m in (0.25, 0.5, 1.0):
        on_a[m] = h.elo_run(h.EloRun(score=capped(INF, 0.10), change=multiplier(m)))
    r.one_knob("1B on top of 1A, Elo's own odds", on_a, "no clamp", restrict=h.HAS_XG, ship=0.25)
    r.one_knob("1B on top of 1A, blend", {k: h.blend(v, r.BASE_AD.probs) for k, v in on_a.items()}, "no clamp",
               restrict=h.HAS_XG, ship=0.25)

    # ---- 1C ----
    fam_c = {(0.0, 0.05, "-"): r.BASE}
    ref = math.exp(ADConfig().base)
    for form, rr in (("plan", 1.0), ("normalised", ref)):
        for nu in (0.0, 0.15, 0.25, 0.35, 0.5):
            for ks in (0.04, 0.05, 0.06):
                if nu == 0.0 and (form == "normalised" or ks == 0.05):
                    continue
                cls = type("P", (Pearson,), {"nu": nu, "ref": rr})
                out = h.ad_run(config=replace(ADConfig(), k_shots=ks), cls=cls)
                fam_c[(nu, ks, form if nu else "-")] = h.blend(r.BASE_ELO, out.probs)
    print("\n1C in-sample, all16 / fav70:")
    for key, p in fam_c.items():
        if key == (0.0, 0.05, "-"):
            continue
        ca = h.compare(p, r.BASE, r.W["all16"])
        cf = h.compare(p, r.BASE, r.W["fav70"])
        print(f"  nu {key[0]} k_shots {key[1]} {key[2]}: {ca['ll'][0]:+.5f} (t {ca['ll'][1]:+.2f}) | fav70 "
              f"{cf['ll'][0]:+.5f} (t {cf['ll'][1]:+.2f}) | {r.favourites(p)}")
    best = min((k for k in fam_c if k[0]), key=lambda k: h.losses(fam_c[k][r.W['all16']], h.Y[r.W['all16']])["ll"].mean())
    r.table(f"1C best in-sample: nu {best[0]}, k_shots {best[1]}, {best[2]}", fam_c[best])
    r.table("1C nu 0.25, k_shots 0.05, normalised", fam_c[(0.25, 0.05, "normalised")])
    r.one_knob("1C walk-forward (nu x k_shots x form)", fam_c, (0.0, 0.05, "-"))
    r.one_knob("1C walk-forward, normalised, k_shots 0.05", {k: v for k, v in fam_c.items()
               if k == (0.0, 0.05, "-") or (k[2] == "normalised" and k[1] == 0.05)}, (0.0, 0.05, "-"))
