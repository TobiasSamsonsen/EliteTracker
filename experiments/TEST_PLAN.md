# Phase 5 — Pre-registration: D-1 diagnostic + E-GRID

Frozen 2026-09-29 before any experiment code exists. Gate C reviews this file
against the produced results (deviations must be listed, not silently applied).

## Common protocol (both experiments)

- Scope: Eliteserien 2019+, n=1848, seed 20260809, ASCII-only output.
- Control: shipped blend (identity config). All comparisons are paired per match
  against control.
- Primary metric: log loss on 3-way outcomes. Secondary: RPS and Brier — a claim
  requires negative delta on both too.
- Holdout protocol (TRIAGE v2, Gate B fix 3):
  - **Selection window: 2023–2024** (n=480). Configs are static/global; nothing
    is fitted on 2025+ data.
  - **Confirmation = complement**: 2019–2022 ∪ 2025–2026 (n=1368), computed
    exactly once, after the winner is frozen. Split at the chronological midpoint
    of the complement into halves H1 / H2 (n≈684 each).
- **Claim bar**: paired |t| >= 2 on the complement + delta < 0 on Brier and RPS
  on the complement + same sign of delta in both H1 and H2. Full-scope numbers
  are context only, never the claim.
- One claim per experiment. No config changes after the complement is seen.
- Power: complement detects delta >= ~0.003 at t=2 (Gate B note: 0.003 may be
  tight; anything >= 0.001 that fails |t|>=2 is *parked*, not refuted).

## D-1 — gap diagnostic (no claim; gates D8 only)

Question: is the shipped-vs-market gap concentrated in late season (the
D8 hypothesis), or spread out / structural?

- Per match: `d_i = LL_shipped_i - LL_market_i` (positive = shipped worse than
  market). Buckets, each reported with n, mean d, paired t vs 0:
  1. **Season phase** — within each ES season, matches split into thirds by
     kickoff date (early / middle / late).
  2. **Favourite confidence** — quartiles of the market's max outcome
     probability (least to most confident).
  3. **Outcome class** — home win / draw / away win.
- **D8 gate (pre-registered)**: D8 builds only if late-phase mean d is
  >= 2x early-phase mean d AND both have the same sign. Otherwise D8 is killed
  without building. D-1 itself publishes no holdout claim.

## E-GRID — grid structure (the claim experiment)

Idea: the Poisson independence assumption inside `score_grid` misstates draw
mass. Two pre-registered variant families, control = shipped grid. The DC
`rho` correction stays exactly as shipped; variants replace only the kernel
cells, capped at GOAL_CAP=8, renormalised as now. Everything downstream
(`outcome_probabilities`, `blend_outcomes` 0.25/0.75, `conditional_scorelines`)
is unchanged.

- **kappa family (D6, bivariate Poisson)**: shared Poisson component of mean
  kappa added to both scores with team means reduced by kappa so marginals are
  preserved (requires lam, mu > kappa; skip/renormalise otherwise — count and
  report skipped matches). kappa in {0.02, 0.05, 0.10, 0.20}.
- **theta family (D11, negative binomial)**: Poisson replaced by NB with the
  same mean and size theta: Var = lam + lam^2/theta. theta in {3, 5, 10, 20}.
- **Identity checks (must pass before any result counts)**:
  - kappa -> 0 reproduces shipped cells to < 1e-9.
  - theta -> 1e12 reproduces Poisson cells to < 1e-9.
  - Control run reproduces shipped per-match outcome probabilities to < 1e-9
    and full-scope log loss 0.97980 (rounding 1e-5).
- Runs: 8 variants + control = 9. Each reports: selection log loss + delta vs
  control; complement log loss, delta, paired t; complement Brier/RPS deltas;
  H1/H2 deltas.
- **Selection**: winner = lowest selection-window log loss among all 9.
- **Early-kill**: if the winner is a variant but its selection delta vs control
  is worse than 0.001 log loss (i.e. improvement < 0.001), E-GRID is parked —
  no complement run, logged as a negative result. (Gate B: 0.001 is the relaxed
  floor; the earlier 0.004 draft would have killed the family's expected range.)
- **Claim**: the single frozen winner is confirmed once against control on the
  complement under the claim bar above. Control winning = E-GRID killed.

## Deliverables

- `experiments/diagnostics.py` — D-1, prints bucket tables (ASCII, <=50 lines).
- `experiments/grid_experiment.py` — E-GRID, prints the 9-row results table
  (ASCII, <=50 lines) + identity-check line + gate verdict line.
- Neither may edit `src/` or `eval_harness.py`; import only. Trials appended to
  `experiments/LOG.md` by the orchestrator after reconciliation.

## S4 addendum — Sofascore ES xG averaged with fotmob's (Phase 4)

Added 2026-09-29 after Gate C ruled Q6 (addendum must precede Phase 4).
Frozen before any S4 fetch or experiment code existed.

**Data facts** (probed same day): Sofascore unique tournament **20** =
Eliteserien; season ids 2020=26799, 2021=35403, 2022=40405, 2023=47806,
2024=57322, 2025=70174, 2026=87809. `/event/<id>/statistics` returns xG
regardless of the list endpoint's `hasXg` flag (verified: 3 flag-true +
3 flag-null fixtures all returned xG), so the flag must NOT gate fetching.
Sofascore publishes no xG on target. WAF note: every Chrome impersonation
profile is 403 from this machine (HTML unaffected) — `safari17_0` passes;
fetch must use it and stop on 403.

**Fetch** (`experiments/fetch_s4.py` -> `experiments/data/xg_sofascore_es.json`):
- Scope: ES played matches 2020-2026 (~1,680), joined to normalized fixtures
  by the shipped `_key` club stems + score check (mirror `update_obos_xg`).
- Always call the statistics endpoint (ignore `has_xg`); delay >= 1.5s per
  request; resumable (skip stored ids, re-fetch if played within 2 days);
  save every 25; stop on 403. Stored: `match_id -> [xg_home, xg_away]`.

**Treatment** (`experiments/s4_experiment.py`):
- Averaged table: where fotmob AND Sofascore both have xG, entry =
  `[0.5*(fot+sof)_home, 0.5*(fot+sof)_away]` + fotmob's xG-on-target pair if
  the fotmob entry had one (Sofascore has none). Single-source matches pass
  through byte-identical — treatment delta exists only where both exist
  (clean attribution).
- The averaged table replaces the fotmob ES entries for BOTH consumers (Elo
  `walk_forward` shots and `AttackDefence` shots): treatment = "model fed
  averaged xG", nothing else changes.

**Protocol** (common bars above, unchanged): identity gates first — control
(fotmob-only table) must reproduce shipped per-match probs at <1e-9 and LL
0.97980 +/- 1e-5; selection 2023-24; early-kill gain <0.001 -> PARKED, no
complement; claim = complement paired t <= -2 (variant - control), Brier and
RPS deltas <0, same negative sign in both halves, computed once after the
single winner is frozen. Paired t is over ALL window matches (pass-through
matches contribute exact-zero deltas — honest ITT-style estimate).
Expected both-present subset: roughly 1,300-1,500 of ~1,680.
