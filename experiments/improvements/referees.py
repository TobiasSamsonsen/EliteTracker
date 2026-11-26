"""Walk-forward evaluation of referee terms against elo-v18.0.

Tests three online empirical-Bayes referee adjustments (predict-then-observe,
zero leakage, `shift_in_update=False` so club ratings remain clean):
  1. Referee home-advantage tilt
  2. Referee x club (both sides independently, no opponent interaction)
  3. Referee x club x opponent (ordered home/away matchup)

Reads `data/referees.json` locally; never touches the network.
"""

from __future__ import annotations

import statistics
import sys
from collections import Counter

import numpy as np

sys.path.insert(0, "experiments/improvements")
from harness import (  # noqa: E402
    IDS, INDEX, LEAGUE, PLAYED, SEASON, EloRun, ad_run, blend, elo_run, line, oos_report,
)
from elitetracker.model.career import team_ids  # noqa: E402
from elitetracker.model.elo import actual_score, effective_home_advantage, expected_score  # noqa: E402
from elitetracker.pipeline import normalize_referee_name  # noqa: E402
from elitetracker.sources.fotmob import load_referees  # noqa: E402


def main() -> int:
    raw = {
        mid: {**entry, "referee": normalize_referee_name(entry["referee"])}
        for mid, entry in load_referees().get("matches", {}).items()
    }
    covered = [i for i, mid in enumerate(IDS) if mid in raw]
    if len(covered) < 50:
        print(
            f"Only {len(covered)} played matches in data/referees.json (need >= 50).\n"
            "Run the polite backfill first:\n"
            "  .venv/Scripts/python -m elitetracker.research referees --seasons 2020-2026"
        )
        return 0

    keep = np.zeros(len(PLAYED), dtype=bool)
    keep[covered] = True

    ref_counts: Counter[str] = Counter()
    pair_counts: Counter[tuple[str, str]] = Counter()
    triple_counts: Counter[tuple[str, str, str]] = Counter()
    by_season: Counter[int] = Counter()
    for i in covered:
        m, _, season = PLAYED[i]
        ref = raw[m.match_id]["referee"]
        home, away = team_ids(m)
        by_season[season] += 1
        ref_counts[ref] += 1
        pair_counts[(ref, home)] += 1
        pair_counts[(ref, away)] += 1
        triple_counts[(ref, home, away)] += 1

    print(f"Covered matches: {len(covered)} across {dict(sorted(by_season.items()))}")
    print(f"Unique referees: {len(ref_counts)}, median {statistics.median(ref_counts.values()):.1f}, max {max(ref_counts.values())}")
    print(f"(referee, club) pairs: {len(pair_counts)}, median {statistics.median(pair_counts.values()):.1f}, max {max(pair_counts.values())}")
    print(f"(referee, home, away) triples: {len(triple_counts)}, median {statistics.median(triple_counts.values()):.1f}, max {max(triple_counts.values())}")

    base_elo = elo_run()
    base_ad = ad_run()
    base = blend(base_elo, base_ad.probs)

    # 1. Referee home-advantage tilt
    print("\n--- 1. Referee home-advantage tilt ---")
    fam_home: dict[object, np.ndarray] = {"base": base}
    for prior in (15, 30, 60):
        for scale in (20, 40, 80):
            state: dict[str, list[float]] = {}

            def shift_home(m, lg, season, ctx, _p=prior, _s=scale, _st=state):
                entry = raw.get(m.match_id)
                if not entry:
                    return 0.0
                ref = entry["referee"]
                s, n = _st.get(ref, (0.0, 0.0))
                return _s * (s / (n + _p))

            # Update state strictly after each match is predicted using a wrapper hook on k_mult
            # (k_mult runs after predict and before next match, returning 1.0).
            # Wait: harness calls home_shift before predicting, and k_mult after predicting!
            def obs_home(m, lg, season, ctx, _st=state):
                entry = raw.get(m.match_id)
                if entry:
                    ref = entry["referee"]
                    idx = INDEX[m.match_id]
                    p = base_elo[idx]
                    exp_h = p[0] + 0.5 * p[1]
                    act_h = actual_score(m.home_goals, m.away_goals)
                    s, n = _st.get(ref, [0.0, 0.0])
                    _st[ref] = [s + (act_h - exp_h), n + 1.0]
                return 1.0

            e = elo_run(EloRun(home_shift=shift_home, k_mult=obs_home, shift_in_update=False))
            p = blend(e, base_ad.probs)
            key = f"p{prior}_s{scale}"
            fam_home[key] = p
            print(line(f"home tilt {key}", p, base, keep))
    oos_report("ref home tilt", fam_home, "base", first=2021, restrict=keep, windows=("es16",))

    # 2. Referee x club (both sides independently, no opponent interaction)
    print("\n--- 2. Referee x club (independent) ---")
    fam_club: dict[object, np.ndarray] = {"base": base}
    for prior in (10, 25, 50):
        for scale in (20, 50, 100):
            state = {}

            def shift_club(m, lg, season, ctx, _p=prior, _s=scale, _st=state):
                entry = raw.get(m.match_id)
                if not entry:
                    return 0.0
                ref = entry["referee"]
                home, away = team_ids(m)
                sh, nh = _st.get((ref, home), (0.0, 0.0))
                sa, na = _st.get((ref, away), (0.0, 0.0))
                return _s * ((sh / (nh + _p)) - (sa / (na + _p)))

            def obs_club(m, lg, season, ctx, _st=state):
                entry = raw.get(m.match_id)
                if entry:
                    ref = entry["referee"]
                    home, away = team_ids(m)
                    idx = INDEX[m.match_id]
                    p = base_elo[idx]
                    exp_h = p[0] + 0.5 * p[1]
                    act_h = actual_score(m.home_goals, m.away_goals)
                    res = act_h - exp_h
                    sh, nh = _st.get((ref, home), [0.0, 0.0])
                    sa, na = _st.get((ref, away), [0.0, 0.0])
                    _st[(ref, home)] = [sh + res, nh + 1.0]
                    _st[(ref, away)] = [sa - res, na + 1.0]
                return 1.0

            e = elo_run(EloRun(home_shift=shift_club, k_mult=obs_club, shift_in_update=False))
            p = blend(e, base_ad.probs)
            key = f"p{prior}_s{scale}"
            fam_club[key] = p
            print(line(f"ref x club {key}", p, base, keep))
    oos_report("ref x club", fam_club, "base", first=2021, restrict=keep, windows=("es16",))

    # 3. Referee x club x opponent (ordered matchup)
    print("\n--- 3. Referee x club x opponent ---")
    fam_triple: dict[object, np.ndarray] = {"base": base}
    for prior in (5, 15, 30):
        for scale in (20, 50, 100):
            state = {}

            def shift_triple(m, lg, season, ctx, _p=prior, _s=scale, _st=state):
                entry = raw.get(m.match_id)
                if not entry:
                    return 0.0
                ref = entry["referee"]
                home, away = team_ids(m)
                s, n = _st.get((ref, home, away), (0.0, 0.0))
                return _s * (s / (n + _p))

            def obs_triple(m, lg, season, ctx, _st=state):
                entry = raw.get(m.match_id)
                if entry:
                    ref = entry["referee"]
                    home, away = team_ids(m)
                    idx = INDEX[m.match_id]
                    p = base_elo[idx]
                    exp_h = p[0] + 0.5 * p[1]
                    act_h = actual_score(m.home_goals, m.away_goals)
                    s, n = _st.get((ref, home, away), [0.0, 0.0])
                    _st[(ref, home, away)] = [s + (act_h - exp_h), n + 1.0]
                return 1.0

            e = elo_run(EloRun(home_shift=shift_triple, k_mult=obs_triple, shift_in_update=False))
            p = blend(e, base_ad.probs)
            key = f"p{prior}_s{scale}"
            fam_triple[key] = p
            print(line(f"ref x match {key}", p, base, keep))
    oos_report("ref x match", fam_triple, "base", first=2021, restrict=keep, windows=("es16",))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
