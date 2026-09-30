# Phase 2 — Deep Dive

> **Status source: `TRIAGE.md` v2 (authoritative).** Formulations below are
> kept; their *status* moved. Prior-art kills (D1–D5, D7, D9, D10, D12, D13,
> D15, D19, D20) and the live ranking (E-GRID > D8 > S4) are in TRIAGE v2.
> Pre-registration for everything that runs: `TEST_PLAN.md`.

Formulation, implementation sketch, data needs, leakage risk for each surviving
candidate. Variants merged (marked). Eval reference: ES 2019+, shipped blend
0.97980, market 0.97266, gap **0.00746 log loss (t=2.06)** — that gap is the
ceiling for anything that only chases the market.

Key codebase facts found this phase:

- `backtest_cli.py` already sweeps K / home advantage / regression AND has a
  `--blend` forward-split sweep of `blend_gamma` (fit first half, test second).
  Candidates implementable through these knobs are near-free to test.
- `EloConfig.home_advantage_beta` (elo.py:147) already implements *gap-dependent*
  HA, swept by `backtest_cli --beta`-style flags; time-varying HA is a
  different axis (calendar/era) and is NOT covered.
- `ADConfig.blend_gamma` defaults 0.0 → constant OUTCOME_BLEND=0.25 (shipped).
- Draw side: `draw_probability(gap)` = draw_base·exp(−(gap/draw_scale)²) on the
  Elo path; grid path uses Poisson + DC rho=−0.05. Two independent draw sources.
- `data/raw/fotmob_match_extras.json`: per-match shots/cards/goals, ES 2020+
  (1608/1848 = 87%), 194 red-card matches (11.5%). Not in normalized schema.
- `data/xg.json`: 2485 matches; ES 2020+ full, so xG-based HA can't predate 2020.

---

## D1 — Blend gamma sweep (from #15)

- **Formulation**: gamma > 0 makes Elo weight shrink with |rating gap|
  (grid dominates for big gaps). Grid already knows favourites better
  (attack/defence spread 1.10); current constant 0.25 may over-weight Elo
  where the known "big favourites under-confident" gap lives.
- **Sketch**: no new code — `backtest_cli --blend --gamma-min 0 --gamma-max 0.5
  --gamma-step 0.05`, forward-split. Winner must then be re-verified on the
  eval harness (0R) under full walk-forward.
- **Data**: none new. **Leak**: L (forward split built in).
- **Gain**: 0.001–0.003. **Cost**: S (one fixer call).

## D2 — K / HA / regression re-sweep on current corpus (from #17)

- **Formulation**: fitted constants predate 2024–2026 data; AGENTS.md explicitly
  lists this as owed work. Era configs (K=20/30, HA=60, regression 0.88) refit.
- **Sketch**: `backtest_cli` sweep (already exists), forward-split or
  season-holdout selection, then eval-harness verification of the winner.
- **Data**: none. **Leak**: M — selection must not be on the eval metric itself;
  use forward-split inside sweep, final confirmation once on harness.
- **Gain**: 0.001–0.003. **Cost**: S.

## D3 — Draw model refit (from #16)

- **Formulation**: draw_base 0.26 / draw_scale 375 fitted in elo-v3 era;
  refit on 2019+ corpus (draw rates drift).
- **Sketch**: small grid over the two params with forward split (can piggyback
  on backtest_cli or a 30-line experiment script).
- **Data**: none. **Leak**: L/M (same selection discipline as D2).
- **Gain**: 0.0005–0.002 (draws ≈ 25% of matches, RPS sensitive). **Cost**: S.

## D4 — Walk-forward temperature scaling (from #7, #13, #21 merged)

- **Formulation**: p′ = softmax(logit(p)/T), one global T (optionally one T per
  class as variant). Fitted on a trailing window of past walk-forward
  predictions only. T>1 softens overconfident favourites → directly targets
  "big favourites under-confident" and home-win underpricing at once.
- **Sketch**: purely post-hoc over harness predictions — no model change. Log
  T path per match in the experiment. Isotonic/Platt rejected a priori
  (literature: overfit at n≈1800; keep as one ablation at most).
- **Data**: harness output only. **Leak**: M — strict trailing-window fit;
  first W matches unscored (burn-in) or T frozen from first full season.
- **Gain**: 0.001–0.003 log loss (calibration fixes move log loss most).
- **Cost**: S–M. **Note**: production shape = one constant T + version bump.

## D5 — Time-varying home advantage (from #2, #22 merged)

- **Formulation**: HA = f(date) instead of 60. Simplest testable forms:
  (a) per-era step (pre/post 2022 or pre/post COVID), (b) linear drift per
  season, (c) estimate from xG differentials (ES 2020+ only) vs from goals.
  Distinct from existing `home_advantage_beta` (gap-dependent).
- **Sketch**: config-level if era steps (extend era_config rows); else small
  replay patch in experiments/ (copied replay loop, not production edit).
- **Data**: dates (have), xG (have, ES 2020+). **Leak**: M — HA for a match
  must be estimated from matches strictly before it.
- **Gain**: 0.002–0.005 (home underpricing is a *known* gap; literature says
  HA fell ~10% over the decade). **Cost**: M. **Rank driver**: biggest
  gap-aligned expected gain.

## D6 — Bivariate Poisson draw coupling (from #3)

- **Formulation**: grid gets a shared λ3 term so P(draw) rises with goal
  correlation; replaces/augments independent-Poisson diagonals on the grid side.
- **Sketch**: experiment-local score grid (P(0,0)+=λ3·... style, Karlis &
  Ntzoufras closed form), feed through existing blend_outcomes.
- **Data**: none. **Leak**: L (λ3 fit on trailing history only).
- **Gain**: 0.001–0.003 (draws are the model's weakest class — climatology
  beats it on draw-heavy samples). **Cost**: M (new grid code in experiments/).

## D7 — Rest-days modifier (from #8)

- **Formulation**: multiplicative K or odds nudge g(rest_days): midweek rounds
  after Sunday games, and the long winter break resumption.
- **Sketch**: derive rest from kickoff_utc between consecutive matches per team;
  apply as small log-odds shift, trailing-estimated coefficient.
- **Data**: kickoff_utc present 2015+ (verified). **Leak**: L (schedule known
  pre-match; coefficient trailing).
- **Gain**: 0.001–0.002. **Cost**: M.

## D8 — Late-season / session effects (from #9)

- **Formulation**: season-phase term on HA or K (title/relegation run-in,
  post-winter-break rust). Targets the measured "late-season gap".
- **Sketch**: calendar feature (matchday ≥ 25 flag, or weeks-since-break);
  trailing coefficient like D5/D7. Eval must slice losses by season phase to
  confirm the gap it claims to fix actually exists in harness data FIRST
  (cheap diagnostic before building).
- **Data**: dates. **Leak**: M (phase known pre-match; coefficient trailing).
- **Gain**: 0.001–0.003, contingent on the diagnostic. **Cost**: M.

## D9 — Adaptive / streak K (from #1, #11 merged)

- **Formulation**: K_t = K·h(rating volatility or recent update streak).
- **Sketch**: replay-level change → experiments/ copy of replay loop.
- **Data**: none. **Leak**: L (uses only past updates).
- **Gain**: 0.001–0.002. **Cost**: M. **Risk**: interacts with era K; sweep
  space grows → multiple-testing pressure.

## D10 — Match-level time decay (from #14)

- **Formulation**: weight past matches by exp(−k·age) within/across seasons
  (lit: k≈0.1), alternative to the one-shot offseason regression 0.88.
- **Sketch**: replay copy with decayed increments OR pre-decayed regression —
  the cheap form is to make regression a function of days elapsed, which may
  be config-level.
- **Data**: dates. **Leak**: L. **Gain**: 0.001–0.003. **Cost**: M.

## D11 — Overdispersed scoreline grid (from #18)

- **Formulation**: Poisson variance inflated (neg-binomial with shared
  dispersion, or simple var·(1+φ)) — real scorelines have fat tails; DC rho
  only fixes the low-score corner.
- **Sketch**: experiment-local grid replacement, same blend path as D6.
- **Data**: none. **Leak**: L (φ trailing-fitted).
- **Gain**: 0.0005–0.002. **Cost**: M. **Note**: overlaps D6 — one grid
  experiment can test both variants cheaply.

## D12 — Promotion/relegation transfer refinement (from #5)

- **Formulation**: promoted club keeps (its rating × decay) blended with seed
  ladder instead of pure 1670/1330; relegated club regresses toward OBOS mean.
- **Sketch**: initial_ratings.py logic is config-like; experiment variant in
  replay.
- **Data**: none (promotion facts in standings). **Leak**: L (known pre-season).
- **Gain**: 0.001–0.002. **Cost**: M.

## D13 — MOV-weighted K (from #6)

- **Formulation**: K·sqrt(|Δgoals|) (G-Elo); current model already uses xG
  margin (xg_margin) as a gentler version of the same idea — so marginal value
  over elo-v12 is uncertain.
- **Sketch**: replay copy, one multiplier line.
- **Data**: none. **Leak**: L. **Gain**: 0.000–0.002 (possibly redundant with
  xg_margin). **Cost**: M. **Rank**: low — mechanism partially shipped.

---

## Killed at deep dive (rationale carried to TRIAGE.md)

| # | Candidate | Kill reason |
|---|---|---|
| 4 | Diagonal draw inflation | DC rho=−0.05 already corrects the diagonal; λ3 (D6) subsumes the useful part |
| 10 | Shrinkage toward market | Closing odds form at kickoff; forecasts publish earlier → leakage for production. Keep as benchmark only (already is). |
| 12 | Red-card-aware updates | 11.5% of matches, needs schema extension of raw extras into normalized data; gain tiny vs cost. Revisit only if Tier-1 misses. |
| 19 | In-season regression | Distorts the live table (product feature) for a small, uncertain gain; offseason regression already exists |
| 20 | Match-importance K | "Decider" status endogenous to the season being predicted; ill-defined ex-ante, high overfit risk |
