"""S4: averaged fotmob + Sofascore xG experiment (TEST_PLAN addendum, Phase 4).

Treatment: a fotmob xG entry with a Sofascore counterpart becomes the mean of
both xG pairs (fotmob's xG-on-target pair kept when present). Single-source
matches pass through byte-identical -- no coverage change, so any difference
is attributable to the averaging alone. The table feeds BOTH consumers (Elo
walk_forward shots and AttackDefence shots). Control = fotmob-only table,
which must reproduce the shipped model exactly before any result prints.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, "src")

from elitetracker.normalize.matches import Match
from elitetracker.sources.fotmob import load_xg

import eval_harness as H
import grid_experiment as G

SOF_PATH = Path(__file__).parent / "data" / "xg_sofascore_es.json"
MIN_BOTH = 500  # incomplete fetch guard (expect ~1300-1500 both-present)


def elo_card_for(name, shots):
    """Mirror of get_production_card with a swappable shots table."""
    seeds = {team_id: seed.rating
             for team_id, seed in H.seed_ratings().items()}
    return H.walk_forward(
        H.load_slices(), seeds, H.EloConfig(),
        score_from_season=2019, name=name, shots=shots,
        league="eliteserien",
        config_for=lambda lg, s: H.era_config(s, H.EloConfig()),
    )


def probs(card, mid):
    p = card.predictions[mid][0]
    return (p.home_win, p.draw, p.away_win)


def max_diff(a, b, ids):
    return max(max(abs(x - y) for x, y in zip(probs(a, mid), probs(b, mid)))
               for mid in ids)


def build_shots():
    """Averaged table per the addendum; single-source entries untouched."""
    if not SOF_PATH.exists():
        print(f"missing {SOF_PATH} - run fetch_s4.py first")
        sys.exit(1)
    sof = json.loads(SOF_PATH.read_text())["matches"]
    control = {k: tuple(v) for k, v in load_xg()["matches"].items()}
    averaged = dict(control)
    both = 0
    for mid, sxg in sof.items():
        if not sxg:  # stored null: Sofascore confirmed no xG for it
            continue
        fot = control.get(mid)
        if fot is None:
            continue  # Sofascore-only: stays absent (pass-through)
        averaged[mid] = (0.5 * (fot[0] + sxg[0]),
                         0.5 * (fot[1] + sxg[1])) + tuple(fot[2:])
        both += 1
    sof_only = sum(1 for mid, v in sof.items() if v and mid not in control)
    return control, averaged, both, sof_only


def main():
    control_shots, avg_shots, both, sof_only = build_shots()
    print(f"S4 experiment - {both} both-present (averaged), "
          f"{sof_only} Sofascore-only (pass-through)")
    if both < MIN_BOTH:
        print(f"TOO FEW both-present matches ({both} < {MIN_BOTH}) - "
              "incomplete fetch, aborting")
        sys.exit(1)

    slices = H.load_slices()
    matches = H.load_matches()  # ES 2019+, n=1848
    print("S4 experiment - identity checks")
    checks_ok = True

    # 1. Local Elo mirror with control shots == production card
    production = H.get_production_card(matches)
    elo_mirror = elo_card_for("s4_control", control_shots)
    common = sorted(set(elo_mirror.predictions) & set(production.predictions))
    diff = max_diff(elo_mirror, production, common)
    ok = diff < G.ID_TOL and len(common) == len(production.predictions)
    checks_ok &= ok
    print(f"ID elo mirror vs production: {'PASS' if ok else 'FAIL'} "
          f"(max diff {diff:.2e} over {len(common)} matches)")

    # 2. Control blend card reproduces shipped per-match probabilities
    shipped = H.get_shipped_blend_card(production)
    control = G.build_card("s4_control", None, production, slices, control_shots)
    common = sorted(set(control.predictions) & set(shipped.predictions))
    diff = max_diff(control, shipped, common)
    ok = diff < G.ID_TOL and len(common) == len(shipped.predictions)
    checks_ok &= ok
    print(f"ID control vs shipped probs: {'PASS' if ok else 'FAIL'} "
          f"(max diff {diff:.2e} over {len(common)} matches)")

    # 3. Control full-scope log loss
    ll_diff = abs(control.log_loss - G.CONTROL_LL_TARGET)
    ok = ll_diff <= 1e-5
    checks_ok &= ok
    print(f"ID control log loss: {'PASS' if ok else 'FAIL'} "
          f"({control.log_loss:.5f} vs {G.CONTROL_LL_TARGET:.5f}, "
          f"diff {ll_diff:.2e})")

    if not checks_ok:
        print("IDENTITY CHECKS FAILED - aborting experiment")
        sys.exit(1)

    # ------------------------------------------------------------ treatment --
    avg_elo = elo_card_for("s4_average", avg_shots)
    treatment = G.build_card("s4_average", None, avg_elo, slices, avg_shots)
    cards = {"control": control, "s4_average": treatment}

    # ------------------------------------------------------------- windows --
    selection = sorted((m for m in matches if int(m.date[:4]) in G.SELECTION_YEARS),
                       key=Match.sort_key)
    complement = sorted((m for m in matches if int(m.date[:4]) in G.COMPLEMENT_YEARS),
                        key=Match.sort_key)
    half = len(complement) // 2
    h1, h2 = complement[:half], complement[half:]
    print(f"Windows: selection 2023-2024 n={len(selection)} | "
          f"complement n={len(complement)} (H1={len(h1)}, H2={len(h2)})")

    # ------------------------------------------------ selection + one claim --
    sel_ll = {n: G.mean(G.window_losses(c, selection)) for n, c in cards.items()}
    winner = min(sel_ll, key=lambda n: sel_ll[n])
    gain = sel_ll["control"] - sel_ll[winner]

    comp_ll = comp_delta = brier_delta = rps_delta = t = h1_delta = h2_delta = None
    if winner == "control":
        verdict = "CLAIM-REJECTED: control wins (treatment not better)"
    elif gain < G.EARLY_KILL:
        verdict = f"PARKED: early-kill (<0.001 selection gain, got {gain:.5f})"
    else:
        w, c = cards[winner], cards["control"]
        wl, cl = G.window_losses(w, complement), G.window_losses(c, complement)
        n, comp_delta, t = G.paired_t(wl, cl)
        comp_ll = G.mean(wl)
        brier_delta = (G.mean(G.window_losses(w, complement, "brier_losses"))
                       - G.mean(G.window_losses(c, complement, "brier_losses")))
        rps_delta = (G.mean(G.window_losses(w, complement, "rps_losses"))
                     - G.mean(G.window_losses(c, complement, "rps_losses")))
        h1_delta = G.mean(G.window_losses(w, h1)) - G.mean(G.window_losses(c, h1))
        h2_delta = G.mean(G.window_losses(w, h2)) - G.mean(G.window_losses(c, h2))
        passed = (t <= -G.T_BAR and brier_delta < 0 and rps_delta < 0
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
    for name in ("control", "s4_average"):
        sel_d = sel_ll[name] - sel_ll["control"]
        if name == winner and comp_ll is not None:
            cells = [f"{comp_ll:>8.5f}", dash(comp_delta), f"{t:>7.2f}",
                     dash(brier_delta), dash(rps_delta), dash(h1_delta), dash(h2_delta)]
        else:
            cells = [f"{'-':>8}"] * 7
        print(f"{name:<12} {sel_ll[name]:>8.5f} {sel_d:>8.5f} " + " ".join(cells))
    print("-" * len(hdr))
    print(f"verdict: {verdict}")


if __name__ == "__main__":
    main()
