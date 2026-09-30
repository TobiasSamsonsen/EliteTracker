# Phase 3 — Triage (Ranked) — v2

**Status: authoritative.** v1 ranked ideas that a subsequent prior-art pass over
`PROJECT_STATUS.md` showed were already measured and rejected. Gate B (PASS,
3 fixes) was ruled on v1; fixes 1–2 are mooted by kills below, fix 3 became the
holdout protocol. Every kill cites its prior measurement — never redo logged work.

Gains below are log-loss on ES 2019+ (shipped 0.97980, market 0.97266, gap
0.00746, t=+2.06). Ceiling for market-chasing ideas: 0.00746.

## Prior-art kills (measured in PROJECT_STATUS.md — do not run)

| ID | Idea | Prior measurement | Evidence |
|---|---|---|---|
| D2 | K/HA/regression re-sweep | Swept Sept 2026: regression flat (0.88↔1.00 = 0.0001), K/α rejected OOS, HA swept in elo-v11 refit; "constants are done" | Post-elo-v11.1 knob sweeps; elo-v12.0; open-items [x] |
| D1 | Blend gamma | γ=0.0 best, every γ>0 worse (t +0.58…+0.82) | elo-v12 candidates; open-item [x] |
| D3/D16 | Draw refit | 0.24–0.28 × 300–450 all \|t\|<1.6, against elo-v12.0 | elo-v12.0 "left alone" |
| D4 | Temperature scaling | T 1.09–1.12 worth −0.0010 (t −1.4); listed under "Measured and rejected" | elo-v12.0 recalibration bullet |
| D5/D22 | Time-varying / xG-based HA | per-league/per-season/per-team HA rejected; gap-shaped HA rejected (t −0.24); HA swept repeatedly | elo-v3 rejections; elo-v12 candidates |
| D7 | Rest days / congestion | Full UEFA+cup calendar, every bucket \|t\|<1.7: "the late-season gap is not congestion" | elo-v12.0 calendar bullet; open-item [x] |
| D9/D1b | Adaptive / streak / dynamic K | dynamic K + EWMA form rejected | elo-v3 rejections line |
| D10 | Match-level time decay | EWMA form rejected; regression surface flat 0.80–1.00 | elo-v3; Sept-2026 sweeps |
| D12 | Promotion/relegation transfer | seed ladder + newcomer floor swept in elo-v11 refit, did not move | elo-v11 refit list |
| D13 | MOV-weighted K | goals-MOV rejected elo-v3; xG-MOV **shipped** as xg_margin 0.05 | elo-v3; elo-v12.0 |
| D15 | Blend weight tuning | OUTCOME_BLEND 0.0–1.0 swept, no change; 0.20–0.35 with spread \|t\|<1.6 | elo-v11 sweep; elo-v12.0 |
| D19 | In-season regression | regression axis flat across every window | Sept-2026 sweeps |
| D20 | Match-importance K | endogenous/ill-defined ex-ante (original kill) | — |
| #10 | Shrinkage toward market | closed by policy (not the simulation the site is for) | market-analysis §4 |
| #12 | Red cards | measured on all 1,608 ES 2020–2026 matches: "nothing to change" | elo-v12.0 red-card table |

Survivors (no prior measurement found by grep over PROJECT_STATUS.md):
**E-GRID (D6+D11)**, **D8 (diagnostic-gated)**, **S4** (queued, Phase 4).

## Gate B fixes, encoded

1. *(was D5)* Any trailing estimator (HA or otherwise) uses only data strictly
   before the match. D5 killed → principle binds on E-GRID fits and D8.
2. *(was D4)* Any post-hoc recalibrator needs trailing fit + burn-in, else not
   run. D4 killed → principle recorded for future candidates.
3. *(live)* **Holdout protocol** — selection window **2023–2024** (n≈480,
   forward; configs are fitted walk-forward ≤2022 and static thereafter);
   **confirmation = complement** 2019–2022 ∪ 2025–2026 (n≈1,368), which never
   informed config choice. Claim rides paired |t|≥2 on the complement + negative
   Δ on Brier and RPS + same sign in both complement date-halves (split at
   chronological midpoint). Full-scope numbers reported as context only.
   Power note: complement detects Δ≳0.003 at t=2; smaller = parked, not refuted
   (project convention). Oracle ruling: forward-split discipline adequate, no
   extra multiple-testing correction beyond one-claim-per-experiment.

## Live ranking

| Rank | ID | Experiment | Expected gain | Confidence | Cost | Gate |
|---|---|---|---|---|---|---|
| 1 | E-GRID (D6+D11) | Grid structure: bivariate draw coupling κ + NB overdispersion θ; selection on 2023–24, confirm on complement | 0.001–0.004 | M | M | runs now (Phase 5) |
| 2 | D8 | Session/season-phase term on HA or K | 0.001–0.003 | L | M | **only if** diagnostic D-1 shows late-phase gap ≥2× early-phase, same direction |
| 3 | S4 | Sofascore ES xG averaged with fotmob's (variance reduction) | 0.001–0.003? | L | L (fetch) | Phase 4, only if 1+2 leave gap >0.003 |

## Discarded

Prior-art kills above; plus no-extra-correction note from Gate B; plus queued
out-of-scope: OBOS xG backfill (ES-only eval), 2027 re-checks of parked K=70–90
/ xg_margin (future data).

## Advancement criteria (v2 — Gate C will verify)

1. E-GRID + diagnostic D-1 run now (both pre-registered in TEST_PLAN.md).
2. D8 builds only if D-1's gate fires; else killed without building.
3. S4 (Phase 4 fetch) only if live experiments leave gap >0.003.
4. One claim per experiment: E-GRID's winner (κ or θ or control) is confirmed once.
5. Bar = holdout protocol above. Then Gate C: oracle reviews pre-registration,
   results, leakage and selection discipline in one call.
