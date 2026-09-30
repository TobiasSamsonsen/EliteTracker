"""E-GRID: grid-structure experiment (D6 bivariate kappa + D11 NB overdispersion).

Protocol: experiments/TEST_PLAN.md. The prediction path mirrors
eval_harness.get_shipped_blend_card exactly; only the scoreline kernel is
swapped (monkeypatched module-global, restored in finally). Control therefore
provably equals the shipped model, which the identity checks enforce before
any result is printed.
"""
import math
import statistics
import sys

sys.path.insert(0, "src")

from elitetracker.model import attack_defence as ad_mod
from elitetracker.model.attack_defence import (
    ADConfig, AttackDefence, gap_blend_weight, outcome_probabilities,
)
from elitetracker.model.backtest import Scorecard
from elitetracker.model.career import team_ids
from elitetracker.model.probabilities import MatchProbabilities, outcome_of
from elitetracker.normalize.matches import Match
from elitetracker.sources.fotmob import load_xg

import eval_harness as H

GOAL_CAP = 8
KAPPA_FAMILY = [0.02, 0.05, 0.10, 0.20]
THETA_FAMILY = [3, 5, 10, 20]

SELECTION_YEARS = {2023, 2024}
COMPLEMENT_YEARS = {2019, 2020, 2021, 2022, 2025, 2026}

EARLY_KILL = 0.001
T_BAR = 2.0
CONTROL_LL_TARGET = 0.97980
ID_TOL = 1e-9


# ---------------------------------------------------------------- kernels --

def _cells(p_home, p_away, lam, mu, rho, cap):
    grid = [[p_home[i] * p_away[j]
             * max(ad_mod.tau(i, j, lam, mu, rho), 0.0)
             for j in range(cap + 1)] for i in range(cap + 1)]
    total = sum(map(sum, grid))
    return [[v / total for v in row] for row in grid]


def kappa_grid(lam, mu, kappa, rho, cap=GOAL_CAP):
    """Bivariate Poisson: shared component kappa, marginals preserved."""
    if lam <= kappa or mu <= kappa:
        return ad_mod.score_grid(lam, mu, rho, cap)
    lam_r, mu_r = lam - kappa, mu - kappa
    p_home = [math.exp(-lam_r) * lam_r ** i / math.factorial(i) for i in range(cap + 1)]
    p_away = [math.exp(-mu_r) * mu_r ** j / math.factorial(j) for j in range(cap + 1)]
    return _cells(p_home, p_away, lam_r, mu_r, rho, cap)


def nb_pmf(k, mean, size):
    if size > 1_000_000:  # theta -> infinity limit is the Poisson
        return math.exp(-mean) * mean ** k / math.factorial(k)
    return math.comb(int(k + size - 1), int(k)) \
        * (size / (size + mean)) ** size * (mean / (size + mean)) ** k


def theta_grid(lam, mu, theta, rho, cap=GOAL_CAP):
    """Negative binomial: same mean, size theta (Var = lam + lam^2/theta)."""
    p_home = [nb_pmf(i, lam, theta) for i in range(cap + 1)]
    p_away = [nb_pmf(j, mu, theta) for j in range(cap + 1)]
    return _cells(p_home, p_away, lam, mu, rho, cap)


def make_kernel(variant):
    if variant["kappa"] is not None:
        k = variant["kappa"]
        return lambda lam, mu, rho, cap=GOAL_CAP: kappa_grid(lam, mu, k, rho, cap)
    if variant["theta"] is not None:
        t = variant["theta"]
        return lambda lam, mu, rho, cap=GOAL_CAP: theta_grid(lam, mu, t, rho, cap)
    return None  # control: production score_grid untouched


def variants():
    vs = [{"name": f"kappa_{k:.2f}", "kappa": k, "theta": None} for k in KAPPA_FAMILY]
    vs += [{"name": f"theta_{t}", "kappa": None, "theta": t} for t in THETA_FAMILY]
    vs += [{"name": "control", "kappa": None, "theta": None}]
    return vs


# ------------------------------------------------------------ card builder --

def build_card(name, kernel, elo_card, slices, shots):
    """Mirror of get_shipped_blend_card; kernel=None leaves production intact."""
    original = ad_mod.score_grid
    if kernel is not None:
        ad_mod.score_grid = kernel
    try:
        ad = AttackDefence.from_slices(slices, ADConfig(), shots=shots)
        card = Scorecard(name=name)
        for match in sorted((m for s in slices for m in s.matches if m.played),
                            key=Match.sort_key):
            if match.match_id in elo_card.predictions:
                home, away = team_ids(match)
                elo_odds = elo_card.predictions[match.match_id][0]
                weight = gap_blend_weight(elo_odds.rating_gap, ad.config.blend_gamma)
                grid = ad.grid(home, away, match.date,
                               elo_gap=elo_odds.rating_gap)
                own = outcome_probabilities(grid)
                raw = [e ** weight * g ** (1.0 - weight)
                       for e, g in zip(
                           (elo_odds.home_win, elo_odds.draw, elo_odds.away_win),
                           (own.home_win, own.draw, own.away_win))]
                total = sum(raw)
                blend = MatchProbabilities(*(v / total for v in raw))
                card.observe(blend, outcome_of(match), match.match_id)
            ad.observe(match)
        return card
    finally:
        ad_mod.score_grid = original


# ------------------------------------------------------------ metric utils --

def year_of(match_id, by_id):
    return int(by_id[match_id].date[:4])


def window_losses(card, matches, metric="losses"):
    tbl = getattr(card, metric)
    return {m.match_id: tbl[m.match_id] for m in matches if m.match_id in tbl}


def mean(d):
    return sum(d.values()) / len(d) if d else float("nan")


def paired_t(a, b):
    """t of per-match (a - b) over their common keys."""
    keys = sorted(set(a) & set(b))
    d = [a[k] - b[k] for k in keys]
    if len(d) < 2:
        return len(d), float("nan"), float("nan")
    m = statistics.mean(d)
    sd = statistics.stdev(d)
    return len(d), m, (m / (sd / math.sqrt(len(d))) if sd else float("inf"))


def outcome_of_id(mid, by_id):
    m = by_id[mid]
    if m.home_goals > m.away_goals:
        return "home_win"
    if m.home_goals < m.away_goals:
        return "away_win"
    return "draw"


# ------------------------------------------------------------------- main --

def main():
    slices = H.load_slices()
    shots = {k: tuple(v) for k, v in load_xg()["matches"].items()}
    matches = H.load_matches()  # ES 2019+, n=1848
    by_id = {m.match_id: m for m in matches}

    print("E-GRID experiment - identity checks")
    checks_ok = True

    # 1. kappa -> 0 reproduces the shipped cells
    probes = [(0.5, 0.3), (1.2, 1.0), (2.5, 1.8), (0.8, 2.2), (3.5, 0.7)]
    rho = ADConfig().rho
    diff = max(
        max(abs(a - b) for row_a, row_b in zip(
            kappa_grid(lam, mu, 0.0, rho), ad_mod.score_grid(lam, mu, rho))
            for a, b in zip(row_a, row_b))
        for lam, mu in probes)
    ok = diff < ID_TOL
    checks_ok &= ok
    print(f"ID kappa->0 vs score_grid: {'PASS' if ok else 'FAIL'} (max diff {diff:.2e})")

    # 2. theta -> 1e12 reproduces the Poisson cells
    diff = max(
        max(abs(a - b) for row_a, row_b in zip(
            theta_grid(lam, mu, 1e12, rho), ad_mod.score_grid(lam, mu, rho))
            for a, b in zip(row_a, row_b))
        for lam, mu in probes)
    ok = diff < ID_TOL
    checks_ok &= ok
    print(f"ID theta->1e12 vs Poisson: {'PASS' if ok else 'FAIL'} (max diff {diff:.2e})")

    # Reference: production Elo card + shipped blend card (Gate-A verified path)
    elo_card = H.get_production_card(matches)
    shipped = H.get_shipped_blend_card(elo_card)

    # 3. Control card must reproduce shipped per-match probabilities
    control = build_card("control", None, elo_card, slices, shots)
    common = sorted(set(control.predictions) & set(shipped.predictions))
    diff = max(
        max(abs(x - y) for x, y in zip(
            (control.predictions[mid][0].home_win, control.predictions[mid][0].draw,
             control.predictions[mid][0].away_win),
            (shipped.predictions[mid][0].home_win, shipped.predictions[mid][0].draw,
             shipped.predictions[mid][0].away_win)))
        for mid in common)
    ok = diff < ID_TOL and len(common) == len(shipped.predictions)
    checks_ok &= ok
    print(f"ID control vs shipped probs: {'PASS' if ok else 'FAIL'} "
          f"(max diff {diff:.2e} over {len(common)} matches)")

    # 4. Control full-scope log loss
    ll_diff = abs(control.log_loss - CONTROL_LL_TARGET)
    ok = ll_diff <= 1e-5
    checks_ok &= ok
    print(f"ID control log loss: {'PASS' if ok else 'FAIL'} "
          f"({control.log_loss:.5f} vs {CONTROL_LL_TARGET:.5f}, diff {ll_diff:.2e})")

    if not checks_ok:
        print("IDENTITY CHECKS FAILED - aborting experiment")
        sys.exit(1)

    # ------------------------------------------------------------- windows --
    selection = sorted((m for m in matches if int(m.date[:4]) in SELECTION_YEARS),
                       key=Match.sort_key)
    complement = sorted((m for m in matches if int(m.date[:4]) in COMPLEMENT_YEARS),
                        key=Match.sort_key)
    half = len(complement) // 2
    h1, h2 = complement[:half], complement[half:]
    print(f"Windows: selection 2023-2024 n={len(selection)} | "
          f"complement n={len(complement)} (H1={len(h1)}, H2={len(h2)})")

    # ------------------------------------------------ selection (all nine) --
    cards = {"control": control}
    for v in variants():
        if v["name"] == "control":
            continue
        cards[v["name"]] = build_card(v["name"], make_kernel(v), elo_card, slices, shots)

    sel_ll = {n: mean(window_losses(c, selection)) for n, c in cards.items()}
    winner = min(sel_ll, key=lambda n: sel_ll[n])
    gain = sel_ll["control"] - sel_ll[winner]

    # --------------------------------------------------- claim (one run) ---
    comp_ll = comp_delta = brier_delta = rps_delta = t = h1_delta = h2_delta = None
    verdict = None
    if winner == "control":
        verdict = "CLAIM-REJECTED: control wins"
    elif gain < EARLY_KILL:
        verdict = f"PARKED: early-kill (<0.001 selection gain, got {gain:.5f})"
    else:
        w, c = cards[winner], cards["control"]
        wl, cl = window_losses(w, complement), window_losses(c, complement)
        n, comp_delta, t = paired_t(wl, cl)
        comp_ll = mean(wl)
        brier_delta = mean(window_losses(w, complement, "brier_losses")) - \
            mean(window_losses(c, complement, "brier_losses"))
        rps_delta = mean(window_losses(w, complement, "rps_losses")) - \
            mean(window_losses(c, complement, "rps_losses"))
        h1_delta = mean(window_losses(w, h1)) - mean(window_losses(c, h1))
        h2_delta = mean(window_losses(w, h2)) - mean(window_losses(c, h2))
        passed = (t <= -T_BAR and brier_delta < 0 and rps_delta < 0
                  and h1_delta < 0 and h2_delta < 0)
        verdict = (f"CLAIM-CONFIRMED: {winner}" if passed
                   else f"CLAIM-REJECTED: {winner} failed claim bar")

    # ---------------------------------------------------------------- table --
    print()
    hdr = (f"{'config':<12} {'selLL':>8} {'selD':>8} {'compLL':>8} {'compD':>8} "
           f"{'t':>7} {'BrD':>8} {'RpsD':>8} {'H1D':>8} {'H2D':>8}")
    print(hdr)
    print("-" * len(hdr))
    dash = lambda v: f"{v:>8.5f}" if isinstance(v, float) else f"{'-':>8}"
    for v in variants():
        n = v["name"]
        sel_d = sel_ll[n] - sel_ll["control"]
        if n == winner and comp_ll is not None:
            cells = [f"{comp_ll:>8.5f}", dash(comp_delta), f"{t:>7.2f}",
                     dash(brier_delta), dash(rps_delta), dash(h1_delta), dash(h2_delta)]
        else:
            cells = [f"{'-':>8}"] * 7
        print(f"{n:<12} {sel_ll[n]:>8.5f} {sel_d:>8.5f} " + " ".join(cells))
    print("-" * len(hdr))
    print(f"verdict: {verdict}")


if __name__ == "__main__":
    main()
