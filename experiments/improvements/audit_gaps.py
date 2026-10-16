"""The parts of IMPROVEMENTS.md the first pass left out, on elo-v13.0 as
released (play-offs and the surface edge included):

1.5   separate k_shots / alpha for Sofascore's (OBOS-ligaen) xG
1.6B  online mean-centring of the attack - defence level
1.7   goals-model newcomers seeded from squad value; rounds 1-10 and the
      pre-season accuracy of the value pull
1.11  the dormant hooks and the main constants, re-swept on the release
1.12  an offseason IPF anchor for the online learner

    .venv/Scripts/python experiments/improvements/audit_gaps.py
"""
import json
import math
import sys
from dataclasses import replace
from datetime import date

import numpy as np

sys.path.insert(0, "experiments/improvements")
from harness import (  # noqa: E402
    AG, DATE, HG, IDS, LEAGUE, PLAYED, SEASON, SHOTS, WINDOWS, ADConfig, EloRun, ad_run, blend, elo_run, line,
    losses, oos_report,
)
from elitetracker.model.attack_defence import gap_blend_weight  # noqa: E402
from elitetracker.model.career import team_ids  # noqa: E402
from elitetracker.model.elo import MODERN_CONFIG, EloConfig  # noqa: E402

A16, XG = WINDOWS["all16"], WINDOWS["xg"]
gaps = np.zeros(len(IDS))
BASE_ELO = elo_run(gaps=gaps)
BASE_AD = ad_run()
BASE = blend(BASE_ELO, BASE_AD.probs)
LEAGUE_OF = {m.match_id: lg for m, lg, _ in PLAYED}

# matches each club has played this season before each match (for rounds 1-10)
COUNT, seen = {}, {}
for m, lg, s in PLAYED:
    for t in team_ids(m):
        COUNT[(t, m.date)] = seen.get((t, s), 0)
    for t in team_ids(m):
        seen[(t, s)] = seen.get((t, s), 0) + 1
EARLY = np.array([max(COUNT[(t, m.date)] for t in team_ids(m)) < 10 for m, _, _ in PLAYED])


def section(title):
    print(f"\n== {title} ==")


def provider_split():
    section("1.5 k_shots / alpha for Sofascore's xG (OBOS-ligaen) on their own")
    def observed(alpha, k):
        def hook(ad, match):
            if LEAGUE_OF[match.match_id] != "obosligaen" or match.match_id not in ad.shots:
                return type(ad).__mro__[1].observed(ad, match)
            s = ad.shots[match.match_id]
            return ((1 - alpha) * match.home_goals + alpha * s[0], (1 - alpha) * match.away_goals + alpha * s[1], k)
        return hook
    fam = {"base": BASE}
    for alpha in (0.6, 0.75, 0.9):
        for k in (0.035, 0.05, 0.065):
            if (alpha, k) == (0.75, 0.05):
                continue
            fam[(alpha, k)] = blend(BASE_ELO, ad_run(observed_hook=observed(alpha, k)).probs)
            print(line(f"OBOS alpha={alpha} k_shots={k}", fam[(alpha, k)], BASE, XG & (LEAGUE == "obosligaen")))
    oos_report("OBOS provider step", fam, "base", first=2024, restrict=HAS_OBOS_XG, windows=("ob16", "all16"))


HAS_OBOS_XG = np.array([m.match_id in SHOTS and lg == "obosligaen" for m, lg, _ in PLAYED])


def online_centring():
    section("1.6B online centring of the level, after every match")
    def after(fraction):
        def hook(ad, match):
            league = ad.divisions.get((ad.season, team_ids(match)[0]))
            teams = [t for (y, t), lg in ad.divisions.items() if y == ad.season and lg == league and t in ad.attack]
            level = (sum(ad.attack[t] for t in teams) - sum(ad.defence[t] for t in teams)) / len(teams)
            for t in teams:
                ad.attack[t] -= fraction * level / 2
                ad.defence[t] += fraction * level / 2
        return hook
    fam = {0: BASE}
    for fraction in (0.005, 0.02, 0.05):
        out = ad_run(after_observe=after(fraction))
        fam[fraction] = blend(BASE_ELO, out.probs)
        print(line(f"online centring {fraction}", fam[fraction], BASE, A16))
        over = (HG + AG) >= 3
        ou = lambda o: -np.log(np.clip(np.where(over, o.over, 1 - o.over), 1e-12, 1))
        d = (ou(out) - ou(BASE_AD))[A16]
        print(f"   o/u 2.5 d={d.mean():+.5f} t={d.mean() / (d.std(ddof=1) / math.sqrt(len(d))):+.2f}; "
              f"predicted goals {(out.lam + out.mu)[A16].mean():.3f} v actual {(HG + AG)[A16].mean():.3f} "
              f"(base {(BASE_AD.lam + BASE_AD.mu)[A16].mean():.3f})")
    oos_report("online centring", fam, 0)


def newcomers_and_early():
    section("1.7 goals-model newcomers from squad value, and the value pull early in a season")
    mv = json.load(open("data/market_values.json", encoding="utf-8"))
    def seed(beta):
        known = set()
        def hook(ad, season):
            page = {t: e["total"] for t, e in mv.get(str(season), {}).items() if e.get("total")}
            by_league = {}
            for (y, t), lg in ad.divisions.items():
                if y == season:
                    by_league.setdefault(lg, []).append(t)
            for lg, teams in by_league.items():
                logs = {t: math.log(page[t]) for t in teams if t in page}
                if not logs:
                    continue
                mean = sum(logs.values()) / len(logs)
                for t in teams:
                    if t not in known and t in logs and ad.season == season and known:
                        ad.attack[t] += beta * (logs[t] - mean)
                        ad.defence[t] += beta * (logs[t] - mean)
            known.update(t for teams in by_league.values() for t in teams)
        return hook
    fam = {0: BASE}
    for beta in (0.1, 0.2, 0.3):
        fam[beta] = blend(BASE_ELO, ad_run(season_hook=seed(beta)).probs)
        print(line(f"AD newcomer seeded by value b={beta} (same season)", fam[beta], BASE, A16))
    oos_report("AD newcomer by value", fam, 0)
    no_pull = blend(BASE_ELO, ad_run(config=replace(ADConfig(), value_pull=0.0)).probs)
    print(line("value pull 0.2 v none, all matches", BASE, no_pull, A16))
    print(line("value pull 0.2 v none, rounds 1-10", BASE, no_pull, A16 & EARLY))
    print(line("value pull 0.2 v none, rounds 11+", BASE, no_pull, A16 & ~EARLY))


def resweep():
    section("1.11 re-sweep on elo-v13.0 as released")
    fam = {0.25: BASE}
    for w in (0.10, 0.20, 0.30, 0.40):
        fam[w] = blend(BASE_ELO, BASE_AD.probs, w)
    oos_report("OUTCOME_BLEND", fam, 0.25)
    fam = {0.0: BASE}
    for gamma in (0.1, 0.3, 0.6):
        fam[gamma] = blend(BASE_ELO, BASE_AD.probs, np.array([gap_blend_weight(g, gamma) for g in gaps]))
    oos_report("blend_gamma", fam, 0.0)
    fam = {-0.05: BASE}
    for rho in (-0.11, -0.08, -0.04, 0.0):
        fam[rho] = blend(BASE_ELO, ad_run(config=replace(ADConfig(), rho=rho)).probs)
    oos_report("rho", fam, -0.05)
    fam = {0.0: BASE}
    for hb in (-0.3, 0.3, 0.6):
        fam[hb] = blend(BASE_ELO, ad_run(config=replace(ADConfig(), home_beta=hb), elo_gap=gaps).probs)
    oos_report("AD home_beta", fam, 0.0)
    fam = {0.0: BASE}
    for hb in (-0.3, 0.3, 0.6):
        cf = lambda lg, s, hb=hb: replace(MODERN_CONFIG if s >= 2022 else EloConfig(), home_advantage_beta=hb)
        fam[hb] = blend(elo_run(EloRun(config_for=cf)), BASE_AD.probs)
    oos_report("Elo home_advantage_beta", fam, 0.0)
    fam = {1.10: BASE}
    for sp in (1.0, 1.05, 1.15, 1.2):
        fam[sp] = blend(BASE_ELO, ad_run(config=replace(ADConfig(), spread=sp)).probs)
    oos_report("spread", fam, 1.10)
    fam = {0.2: BASE}
    for vp in (0.0, 0.1, 0.3, 0.4):
        fam[vp] = blend(BASE_ELO, ad_run(config=replace(ADConfig(), value_pull=vp)).probs)
    oos_report("value_pull", fam, 0.2)
    fam = {0.5: BASE}
    for eb in (0.0, 0.25, 1.0):
        fam[eb] = blend(BASE_ELO, ad_run(config=replace(ADConfig(), early_boost=eb)).probs)
    oos_report("early_boost", fam, 0.5)


def ipf_anchor():
    section("1.12 an offseason IPF anchor for the online learner")
    teams = sorted({t for m, _, _ in PLAYED for t in team_ids(m)})
    tix = {t: i for i, t in enumerate(teams)}
    H = np.array([tix[team_ids(m)[0]] for m, _, _ in PLAYED])
    A = np.array([tix[team_ids(m)[1]] for m, _, _ in PLAYED])
    oh, oa = HG.astype(float).copy(), AG.astype(float).copy()
    for i, (m, _, _) in enumerate(PLAYED):
        s = SHOTS.get(m.match_id)
        if s:
            oh[i], oa[i] = 0.25 * HG[i] + 0.75 * s[0], 0.25 * AG[i] + 0.75 * s[1]
    day = np.array([date.fromisoformat(d).toordinal() for d in DATE])

    def fit(before, half_life=365, tau0=6, iters=40):
        past = day < before
        w = 0.5 ** ((before - day[past]) / half_life)
        h, a, x, y = H[past], A[past], oh[past], oa[past]
        mean = (w * (x + y)).sum() / (2 * w.sum())
        home = math.sqrt((w * x).sum() / (w * y).sum())
        att = dfn = np.ones(len(teams))
        for _ in range(iters):
            num = np.bincount(h, w * x, len(teams)) + np.bincount(a, w * y, len(teams))
            den = np.bincount(h, w * mean * home * dfn[a], len(teams)) + np.bincount(a, w * mean / home * dfn[h], len(teams))
            att = (num + tau0 * mean) / (den + tau0 * mean)
            num = np.bincount(a, w * x, len(teams)) + np.bincount(h, w * y, len(teams))
            den = np.bincount(a, w * mean * home * att[h], len(teams)) + np.bincount(h, w * mean / home * att[a], len(teams))
            dfn = (num + tau0 * mean) / (den + tau0 * mean)
        return np.log(att), -np.log(dfn)

    starts = {s: day[SEASON == s].min() for s in sorted(set(SEASON.tolist()))}
    fits = {s: fit(d) for s, d in starts.items() if s > min(starts)}

    def anchor(weight):
        def hook(ad, season):
            if season not in fits:
                return
            log_att, log_def = fits[season]
            by_league = {}
            for (y, t), lg in ad.divisions.items():
                if y == season and t in ad.attack and t in tix:
                    by_league.setdefault(lg, []).append(t)
            for lg, members in by_league.items():
                for ratings, logs in ((ad.attack, log_att), (ad.defence, log_def)):
                    ours = np.mean([ratings[t] for t in members])
                    theirs = np.mean([logs[tix[t]] for t in members])
                    for t in members:
                        target = ours + logs[tix[t]] - theirs
                        ratings[t] = (1 - weight) * ratings[t] + weight * target
        return hook
    fam = {0: BASE}
    for weight in (0.15, 0.3, 0.5):
        fam[weight] = blend(BASE_ELO, ad_run(season_hook=anchor(weight)).probs)
        print(line(f"IPF anchor w={weight}", fam[weight], BASE, A16))
    oos_report("IPF anchor", fam, 0)


if __name__ == "__main__":
    for part in sys.argv[1:] or ["provider", "centring", "newcomers", "resweep", "ipf"]:
        {"provider": provider_split, "centring": online_centring, "newcomers": newcomers_and_early,
         "resweep": resweep, "ipf": ipf_anchor}[part]()
