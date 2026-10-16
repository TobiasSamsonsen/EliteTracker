"""IMPROVEMENTS.md 1.4-1.6: xG/xGOT blend, provider calibration, the
finishing term in the learning rates, level drift, a tempo interaction.

    .venv/Scripts/python experiments/improvements/goals_model.py
"""

from __future__ import annotations

import json
import math
import sys

import numpy as np

sys.path.insert(0, "experiments/improvements")
from harness import (  # noqa: E402
    AG, HAS_XG, HG, LEAGUE, PLAYED, SEASON, SHOTS, WINDOWS, EloRun, ad_run, blend, elo_run, line,
    oos_report, report, shipped_score,
)
from elitetracker.model.career import team_ids  # noqa: E402
from elitetracker.model.elo import actual_score, xg_implied_score  # noqa: E402

BASE_ELO = elo_run()
BASE_AD = ad_run()
BASE_MIX = blend(BASE_ELO, BASE_AD.probs)
XG = WINDOWS["xg"]
A16 = WINDOWS["all16"]


def scoreline_lines(name, out, base=BASE_AD, keep=A16):
    """Exact-scoreline and over/under-2.5 log loss of the grid, paired."""
    over = (HG + AG) >= 3
    def ou(o):
        p = np.where(over, o.over, 1.0 - o.over)
        return -np.log(np.clip(p, 1e-12, 1))
    for label, a, b in (("exact", -np.log(np.clip(out.exact, 1e-12, 1)), -np.log(np.clip(base.exact, 1e-12, 1))),
                        ("o/u2.5", ou(out), ou(base))):
        d = (a - b)[keep]
        t = d.mean() / (d.std(ddof=1) / math.sqrt(len(d))) if d.std() else 0.0
        print(f"   {name} {label:<7} d={d.mean():+.5f} t={t:+.2f}")


def run_ad(name, windows=("all16", "xg"), scorelines=False, **kw):
    out = ad_run(**kw)
    mix = blend(BASE_ELO, out.probs)
    for w in windows:
        print(line(f"{name} blend [{w}]", mix, BASE_MIX, WINDOWS[w]))
    if scorelines:
        scoreline_lines(name, out)
    return out, mix


def xgot_observed(beta):
    def observed(ad, match):
        goals = (float(match.home_goals), float(match.away_goals))
        shots = ad.shots.get(match.match_id)
        cfg = ad.config
        if not shots:
            return goals[0], goals[1], cfg.k
        if len(shots) >= 4:
            sig = ((1 - beta) * shots[0] + beta * shots[2], (1 - beta) * shots[1] + beta * shots[3])
        else:
            sig = shots[0:2]
        a = cfg.alpha
        return (1 - a) * goals[0] + a * sig[0], (1 - a) * goals[1] + a * sig[1], cfg.k_shots or cfg.k
    return observed


def blended_shots(beta):
    return {k: (((1 - beta) * v[0] + beta * v[2], (1 - beta) * v[1] + beta * v[3]) if len(v) >= 4 else v)
            for k, v in SHOTS.items()}


def main() -> None:
    print("== 1.4 xG / xGOT convex blend ==")
    fam_mix, fam_elo = {0.0: BASE_MIX}, {0.0: BASE_ELO}
    for beta in (0.15, 0.25, 0.35, 0.5):
        _, fam_mix[beta] = run_ad(f"1.4 AD beta={beta}", observed_hook=xgot_observed(beta))
        e = elo_run(EloRun(shots=blended_shots(beta)))
        fam_elo[beta] = e
        print(line(f"1.4 Elo beta={beta} elo [xg]", e, BASE_ELO, XG))
        both = ad_run(observed_hook=xgot_observed(beta))
        print(line(f"1.4 both beta={beta} blend [xg]", blend(e, both.probs), BASE_MIX, XG))
    oos_report("1.4 AD", fam_mix, 0.0, first=2021, restrict=HAS_XG)
    oos_report("1.4 Elo", fam_elo, 0.0, first=2021, restrict=HAS_XG)

    print("\n== 1.5 provider calibration ==")
    for league in ("eliteserien", "obosligaen"):
        keep = (LEAGUE == league) & HAS_XG
        g = (HG + AG)[keep].sum()
        x = sum(SHOTS[PLAYED[i][0].match_id][0] + SHOTS[PLAYED[i][0].match_id][1] for i in np.nonzero(keep)[0])
        per = []
        for s in sorted(set(SEASON[keep].tolist())):
            ks = keep & (SEASON == s)
            xs = sum(SHOTS[PLAYED[i][0].match_id][0] + SHOTS[PLAYED[i][0].match_id][1] for i in np.nonzero(ks)[0])
            per.append(f"{s}:{(HG + AG)[ks].sum() / xs:.3f}")
        print(f"  {league}: goals/xG {g / x:.3f} over {keep.sum()} matches; " + " ".join(per))
    obos = {PLAYED[i][0].match_id for i in np.nonzero(LEAGUE == "obosligaen")[0]}
    fam_mix, fam_elo = {1.0: BASE_MIX}, {1.0: BASE_ELO}
    for c in (0.94, 0.97, 1.03, 1.06):
        scaled = {k: (tuple(x * c for x in v) if k in obos else v) for k, v in SHOTS.items()}
        e = elo_run(EloRun(shots=scaled))
        out = ad_run(shots=scaled)
        fam_mix[c] = blend(e, out.probs)
        fam_elo[c] = e
        print(line(f"1.5 OBOS xG x{c} blend [ob xg]", fam_mix[c], BASE_MIX, XG & (LEAGUE == "obosligaen")))
    oos_report("1.5 provider scalar", fam_mix, 1.0, first=2024, restrict=HAS_XG & (LEAGUE == "obosligaen"))
    # Sofascore's Eliteserien xG (collected 2026-09, experiments/data) averaged in.
    sofa = json.load(open("experiments/data/xg_sofascore_es.json", encoding="utf-8"))["matches"]
    both = [k for k, v in sofa.items() if v and k in SHOTS]
    pairs = np.array([(SHOTS[k][0] + SHOTS[k][1], v[0] + v[1]) for k, v in sofa.items() if v and k in SHOTS])
    print(f"  ES matches with both providers: {len(both)}; fotmob xG/match {pairs[:, 0].mean():.3f}, "
          f"Sofascore {pairs[:, 1].mean():.3f}, corr {np.corrcoef(pairs.T)[0, 1]:.3f}")
    fam = {0.0: BASE_MIX}
    for w in (0.25, 0.5):
        avg = dict(SHOTS)
        for k in both:
            f, s = SHOTS[k], sofa[k]
            avg[k] = ((1 - w) * f[0] + w * s[0], (1 - w) * f[1] + w * s[1]) + tuple(f[2:])
        fam[w] = blend(elo_run(EloRun(shots=avg)), ad_run(shots=avg).probs)
        print(line(f"1.5 ES sofa weight {w} blend [es xg]", fam[w], BASE_MIX, XG & (LEAGUE == "eliteserien")))
    oos_report("1.5 provider average", fam, 0.0, first=2024, restrict=HAS_XG & (LEAGUE == "eliteserien"))

    print("\n== 1.6A finishing in the learning rates ==")
    def learn_weighted(ad, home, away, on, mode):
        cfg = ad.config
        has = ad._current_match_has_xg
        fh, fa = ad.finishing.get(home, 0.0), ad.finishing.get(away, 0.0)
        xh = math.exp(cfg.base + cfg.home + ad.attack[home] - ad.defence[away])
        xa = math.exp(cfg.base + ad.attack[away] - ad.defence[home])
        if not has:
            return xh * math.exp(fh), xa * math.exp(fa)
        a = cfg.alpha
        if mode == "log":
            return xh * math.exp((1 - a) * fh), xa * math.exp((1 - a) * fa)
        return a * xh + (1 - a) * xh * math.exp(fh), a * xa + (1 - a) * xa * math.exp(fa)

    def run_learn(mode):
        from harness import ADX, SLICES, Y  # noqa
        from elitetracker.model.attack_defence import ADConfig
        class Flagged(ADX):
            _current_match_has_xg = False
            def observe(self, match):
                self._current_match_has_xg = bool(self.shots.get(match.match_id)) and self.config.alpha > 0
                super().observe(match)
                self._current_match_has_xg = False
        import harness
        old = harness.ADX
        harness.ADX = Flagged
        try:
            return run_ad(f"1.6A finishing {mode}", learn_hook=lambda ad, h, a, on: learn_weighted(ad, h, a, on, mode))
        finally:
            harness.ADX = old
    fin = {"base": BASE_MIX}
    for mode in ("log", "mixture"):
        _, fin[mode] = run_learn(mode)
    oos_report("1.6A", fin, "base", first=2021, restrict=HAS_XG)

    print("\n== 1.6B the attack - defence level, per division ==")
    for s in sorted(set(SEASON.tolist())):
        for lg in ("eliteserien", "obosligaen"):
            k = (SEASON == s) & (LEAGUE == lg)
            print(f"  {s} {lg[:4]} predicted goals/match {(BASE_AD.lam + BASE_AD.mu)[k].mean():.3f} "
                  f"actual {(HG + AG)[k].mean():.3f}", end="" if lg == "eliteserien" else "\n")
    def center(fraction):
        def hook(ad, season):
            active = {}
            for (year, team), lg in ad.divisions.items():
                if year == season and team in ad.attack:
                    active.setdefault(lg, []).append(team)
            for lg, teams in active.items():
                level = (sum(ad.attack[t] for t in teams) - sum(ad.defence[t] for t in teams)) / len(teams)
                for t in teams:
                    ad.attack[t] -= fraction * level / 2
                    ad.defence[t] += fraction * level / 2
        return hook
    lev = {0.0: BASE_MIX}
    for fraction in (0.25, 0.5, 1.0):
        out, lev[fraction] = run_ad(f"1.6B centre level x{fraction}", scorelines=True, season_hook=center(fraction))
    oos_report("1.6B", lev, 0.0)

    print("\n== 1.6C tempo interaction ==")
    def tempo(tau_):
        def hook(ad, home, away, on, lam, mu):
            season = int(on[:4])
            def event(t):
                return ad.attack[t] - ad.defence[t]
            peers = [t for (y, t), lg in ad.divisions.items() if y == season and t in ad.attack
                     and lg == ad.divisions.get((season, home))]
            mean = sum(event(t) for t in peers) / len(peers) if peers else 0.0
            f = math.exp(tau_ * (event(home) - mean) * (event(away) - mean))
            return lam * f, mu * f
        return hook
    tem = {0.0: BASE_MIX}
    for tau_ in (-1.0, -0.5, 0.5, 1.0, 2.0):
        _, tem[tau_] = run_ad(f"1.6C tempo tau={tau_}", scorelines=True, rates_hook=tempo(tau_))
    oos_report("1.6C", tem, 0.0)


if __name__ == "__main__":
    main()
