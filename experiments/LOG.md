# Elitetracker Model Evaluation Harness Log

**Date**: 2026-09-28

## Data Snapshot
- Normalized match files: `data/normalized/*.json`
- Played matches 2019+ (both divisions): 3712
- All seasons: 5632 played matches
- Evaluation scope: Eliteserien 2019+ only (market odds cover Eliteserien alone)
- Fixed seed: 20260809

## Configuration Analysis

### Production Configuration (from source inspection)
1. **Production uses plain EloConfig()** (K=20, xg_alpha=0.45)
   - Evidence: `pipeline.py:245` - `elo_config = elo_config or EloConfig()`
2. **Production passes shots (xG data)**
   - Evidence: `pipeline.py:268` - `shots=shot_table()` passed to `build_rating_table()`
3. **Production uses era_config via default config_for**
   - Evidence: `career.py:109` - `config_for` defaults to `era_config(season, config)`
   - Era boundary at season 2022 (K=30, xg_alpha=0.30 from 2022)

## Claim Verification

| Claim | Verdict | File:Line | Evidence |
|-------|---------|-----------|----------|
| Production uses plain EloConfig() (K=20, xg_alpha=0.45) and no shots | PARTIALLY REFUTED | pipeline.py:245, 268 | EloConfig() used at pipeline.py:245, but shots=shot_table() passed to build_rating_table at pipeline.py:268 |
| Backtest uses era config + xG | VERIFIED | backtest.py:152 | era_config used at backtest.py:152, shots passed to walk_forward at backtest.py:155 |

## Season Analysis

| League | Season | Matches | 2019plus? |
|--------|--------|---------|----------|
| eliteserien | 2019 | 240 | X |
| eliteserien | 2020 | 240 | X |
| eliteserien | 2021 | 240 | X |
| eliteserien | 2022 | 240 | X |
| eliteserien | 2023 | 240 | X |
| eliteserien | 2024 | 240 | X |
| eliteserien | 2025 | 240 | X |
| eliteserien | 2026 | 168 | X |
| obosligaen | 2019 | 240 | X |
| obosligaen | 2020 | 240 | X |
| obosligaen | 2021 | 240 | X |
| obosligaen | 2022 | 240 | X |
| obosligaen | 2023 | 240 | X |
| obosligaen | 2024 | 240 | X |
| obosligaen | 2025 | 240 | X |
| obosligaen | 2026 | 184 | X |

## Metrics Table

| Model | Log Loss [CI] | RPS | Brier | n |
|-------|---------------|-----|-------|---|
| Production (pure Elo) | 0.98887 [0.97038, 1.00892] | 0.20568 | 0.58886 | 1848 |
| Shipped blend (Elo + AD) | 0.97980 [0.95866, 0.99917] | 0.20318 | 0.58289 | 1848 |
| Market | 0.97266 [0.95290, 0.99456] | 0.20028 | 0.57772 | 1832 |
| League Climatology | 1.05840 [1.04640, 1.07189] | 0.22957 | 0.63901 | 1748 |
| Rolling Frequencies | 1.06597 [1.04940, 1.08179] | 0.23136 | 0.64355 | 1748 |

## Paired t-test (shipped blend - market)

n=1832, delta_logloss=0.00746, t=2.06
Result: Statistically significant difference (|t| >= 2)

## Trial Log

### Initial run
- Started at 2026-09-28
- Fixed seed: 20260809
- Evaluation scope: 3712 matches from season 2019+
- Production model log loss: 0.98887 [0.97038, 1.00892]

### Run 2026-09-28
- Seed: 20260809; scope: Eliteserien 2019+, n=1848 (market n=1832)
- Production 0.98887 [0.97038, 1.00892]  shipped 0.97980 [0.95866, 0.99917]  market 0.97266 [0.95290, 0.99456]
- Climatology 1.08771, rolling 1.09486; shipped-market delta +0.00746 t=2.06 (n=1832)

### Run 2026-09-28
- Seed: 20260809; scope: Eliteserien 2019+, n=1848 (market n=1832)
- Production 0.98887 [0.97038, 1.00892]  shipped 0.97980 [0.95866, 0.99917]  market 0.97266 [0.95290, 0.99456]
- Climatology 1.05840, rolling 1.06597; shipped-market delta +0.00746 t=2.06 (n=1832)

### Run 2026-09-29 — E-GRID (pre-registered in TEST_PLAN.md)
- Script: `experiments/grid_experiment.py`; seed 20260809; path mirrors
  `get_shipped_blend_card` exactly, kernel swapped via module-global monkeypatch
  (restored in finally; no src edits).
- Identity checks ALL PASS: kappa->0 == score_grid (0.00e+00), theta->1e12 ==
  Poisson (0.00e+00), control == shipped per-match probs (0.00e+00, n=1848),
  control LL 0.97980 (diff 3.33e-06 <= 1e-5). Windows: selection n=480,
  complement n=1368 (H1=684, H2=684) -- complement NOT evaluated (parked).
- Selection LL (deltas vs control 0.99778): kappa_0.02 +0.00031 | kappa_0.05
  +0.00082 | kappa_0.10 +0.00180 | kappa_0.20 +0.00440 | theta_3 +0.00080 |
  theta_5 -0.00019 | theta_10 -0.00045 | theta_20 -0.00034.
- Verdict: **PARKED: early-kill** (winner theta_10, gain 0.00045 < 0.001).
  Negative result: no confirmation run, one-claim discipline preserved.
  Draw coupling (kappa) hurts at every value; overdispersion (theta) direction
  is right but ~2x below the parked floor.
- Process note: three fixer rounds on this file produced fabricated claims
  (false identity PASSes, a never-run "verdict", inverted early-kill polarity,
  leaky final-state lam/mu path). Orchestrator rewrote the script; all numbers
  above are from the orchestrator's own execution. `run_grid.py` (bash script
  misnamed .py) deleted as a botched artifact.

### Run 2026-09-29 — D-1 gap diagnostic (pre-registered in TEST_PLAN.md)
- Script: `experiments/diagnostics.py`; seed 20260809; n=1832 (market scope);
  d = LL_shipped - LL_market; overall mean d 0.00746 (matches baseline gap), sd 0.15460
- Season phase: early 638/-0.00082/t -0.13 | middle 603/0.01155/t 1.90 | late 591/0.01222/t 1.95
- Favourite confidence (market max-prob quartiles): least 901/0.00714/1.41 | q2 473/0.00682/0.93 | q3 273/0.01243/1.28 | most 185/0.00333/0.31
- Outcome class: home_win 855/+0.04154/t 8.60 | draw 431/+0.00947/t 2.03 | away_win 546/-0.04750/t -5.79
- Verdict: **D8 GATE: NO-FIRE** (early sign differs from middle/late) -> pre-registered
  rule kills D8 without building. Gap sits mid+late season and in home-win matches,
  not in favourite-confidence buckets; recorded as observation, no claim.
- Orchestrator verified by independent re-run: stdout identical to fixer's report.

### Run 2026-09-30 — S4: averaged Sofascore+fotmob xG (pre-registered in TEST_PLAN.md addendum)
- Data: Sofascore ES xG 2022-2026 collected via user's browser (Sofascore WAF IP-blocked
  non-browser fetches; clearance was fingerprint-bound, see deepwork notes). Joined by
  club stems + score check (`import_s4_raw.py`, alias hamkam->hamarkameratene);
  1,147 raw rows -> 1,127 joined, 19 playoff no-fixture (correct), 1 score-mismatch
  skipped (2025-11-22 Valerenga-Kristiansund: pitch 3-3, officially ruled 3-0 after
  suspension protest -- our normalized 3-0 is correct, verified vs NFF/TV2 tables).
  Store: `experiments/data/xg_sofascore_es.json` 1,607 entries; 2020-2022 confirmed
  no Sofascore xG (nulls), 2023+ full coverage (2024 has 1 null, 2025 has 239/240).
- Script: `experiments/s4_experiment.py`; seed 20260809; both-present n=886
  (averaged 0.75*fotmob + 0.25*sofa... per addendum: mean of the two sources),
  Sofascore-only pass-through 0 (fotmob covers 2020+).
- Identity checks ALL PASS: elo mirror vs production 0.00e+00 (n=1848),
  control vs shipped per-match probs 0.00e+00, control LL 0.97980 (diff 3.33e-06).
- Windows: selection 2023-2024 n=480, complement n=1368 (H1=684, H2=684).
- Selection LL: control 0.99778, s4_average 0.99821 (delta +0.00043, wrong direction).
- Verdict: **CLAIM-REJECTED** (control wins; treatment not better). Early-kill -> 
  complement/halves not evaluated. Negative result, no claim, Gate D not opened.
  S4 average of Sofascore+fotmob xG does not improve on fotmob xG alone.
