# Phase 1 — Ideation (Divergent)

> **Superseded status source: `TRIAGE.md` v2 (authoritative).** A prior-art pass
> over `PROJECT_STATUS.md` killed most candidates below as already measured and
> rejected (D1, D2, D3, D4, D5, D7, D9, D10, D12, D13, D15, D19, #10, #12).
> Live survivors: E-GRID (D6+D11), D8 (diagnostic-gated), S4 (Phase 4).
> Ideas here are raw material — check TRIAGE v2 before running anything.

Evaluation scope: Eliteserien 2019+, n=1848, seed 20260809 (see `LOG.md`).
Baselines: shipped blend 0.97980, market 0.97266, climatology 1.05840 (log loss).
Known gaps to attack: home wins under-priced, big favourites under-confident,
late-season gap.

Sources: @librarian literature scan (2026-09-28) + in-repo data recon (2026-09-28).
Every candidate below is NOT already in elo-v12.0 (verified against
`model/elo.py`, `model/attack_defence.py`, `model/probabilities.py`).

## Already implemented — do not resubmit

Squad-strength/Transfermarkt prior, ordered-logit, Dixon-Coles as outcome model,
pi-ratings, Elo/DC blend, market-value prior (all measured and rejected,
PROJECT_STATUS.md). Also already shipped: xg_margin, spread=1.10, finishing
regression 0.70, era-switched K, draw_base/draw_scale refit, rho=-0.05 grid
correction, 25/75 Elo/grid blend, season regression 0.88.

## Data availability map (in-repo)

| Signal | Where | Coverage |
|---|---|---|
| Match dates/kickoff times | `data/normalized/*_matches.json` | 2015–2026 both divisions → rest days, season phase |
| xG per match | `data/xg.json` (2485 matches) | ES 2020+, OBOS 2023+ |
| Closing odds (de-vigged) | `data/odds_closing.json` (2792) | Eliteserien only |
| Squad market values | `data/market_values.json` | 2015–2024 (rejected as input) |
| Cards, shots, goals per match | `data/raw/fotmob_match_extras.json` (1608 matches, keys: shots/cards/goals) | partial — red cards usable |
| Standings archives | `data/raw/fotmob_*_standings.json` | 2014–2026 |

## Candidates

| # | Name | One-line mechanism | Source | Data | Leak risk |
|---|---|---|---|---|---|
| 1 | Adaptive K (volatility) | K rises when ratings move abnormally (recent-update variance), falls when stable | eloratings.net; PMC12682724; decay-elo.pdf (opt k≈0.1) | Y (ratings history) | L |
| 2 | Time-varying home advantage | HA as function of season/era (post-COVID decline ~10%) instead of constant 60 | Benz & Lopez 2021; Wunderlich 2021; arXiv 2411.12509 (U-shaped HA) | Y (dates) | M |
| 3 | Bivariate Poisson draw coupling | Add shared λ3 component so P(draw) captures goal correlation the Elo draw lookup misses | Karlis & Ntzoufras 2003 RSS | Y | L |
| 4 | Diagonal draw inflation | Extra inflation τ on scoreline diagonal in the grid (separate from λ3) | Karlis & Ntzoufras 2003; 2024 replication | Y | L/M |
| 5 | Promotion/relegation Elo transfer | Transfer promoted clubs' ratings with decay toward division mean instead of pure seed ladder | Lacy 2018; pena.lt 2013; 538 decay 0.80 | Y | M |
| 6 | MOV-weighted Elo updates | Scale K by sqrt(|goal diff|) (G-Elo) so big wins move ratings more | Szczecinski & Djebbi 2020 (arXiv 2010.11187) | Y | L |
| 7 | Walk-forward temperature scaling | Single T on logit of shipped probabilities, fitted rolling on past matches only | Gevorgyan 2026 (T best, ECE .045→.036); isotonic overfits small N | Y | L/M |
| 8 | Rest-days modifier | Multiply K or shift odds by days since team's last match (fixture congestion) | MetricGate; FIFPRO; Sage congestion meta-analysis | Y (dates) | L |
| 9 | Late-season/session effects | Rating/HA drift across winter break and title/relegation run-in | arXiv 2411.12509; Football Proof AI session effects | Y (dates) | M |
| 10 | Shrinkage toward market | Blend shipped odds toward de-vigged closing line | 538 blend; Groll et al. combination | Y (ES only) | **H** (closing line ≈ kickoff, forecasts published earlier) |
| 11 | Streak-based K | K up during win/loss streaks, down after quiet patches (complement to #1) | PMC12682724 | Y | M |
| 12 | Red-card-aware updates | Shrink result weight when a win came vs 10 men (post-match info, updates only) | general MOV literature | Y (extras, 1608 matches) | L |
| 13 | Per-class one-vs-rest calibration | Separate small recalibration per outcome class instead of one temperature | Gevorgyan 2026; Football Proof AI (draw ECE 0.91%) | Y | M |
| 14 | Match-level time decay | Exponential decay of past matches' influence inside season (opt k≈0.1) | decay-elo.pdf; 538 (0.95/season) | Y | L |
| 15 | Elo+grid weight tuning | Learn blend weight (currently fixed 25/75) walk-forward instead of hand-set | Groll et al. | Y | M |
| 16 | Draw-model refit | Re-fit draw_base/draw_scale on recent seasons (AGENTS "What's left") | in-repo TODO | Y | L |
| 17 | K/HA/regression re-sweep | Re-run backtest_cli sweep on data through 2025 (AGENTS "What's left") | in-repo TODO | Y | L |
| 18 | Overdispersed scoreline grid | Negative-binomial (or variance inflation) instead of Poisson — real scores are overdispersed | DC 1997 follow-on literature | Y | L |
| 19 | In-season regression | Regress ratings toward mean mid-season, not only at offseason boundary | standard Elo hygiene | Y | L |
| 20 | Match-importance weighting | K boost for title/relegation deciders (late-season gap hypothesis) | general MOI literature | Y | M |
| 21 | Favourite sharpening | Gap-dependent sharpening of extreme Elo probabilities (fixes under-confidence on favourites) | calibration literature (T-scaling family) | Y | L/M |
| 22 | xG-based home advantage | Estimate HA from xG differentials (less noisy than goals) | xG literature | partial (ES 2020+) | M |

## Pre-screening notes (not a ranking — Phase 3 owns that)

- Directly targets known gaps: #2/#22 (home under-priced), #7/#13/#21
  (favourite under-confidence + calibration), #9/#20 (late-season gap).
- #10 is the highest-ceiling candidate but the leakage ruling matters:
  closing odds are effectively the efficient-market benchmark; blending at
  forecast time (pre-kickoff) is not generally available. Gate B must rule.
- #12's card data covers only 1608 matches with unknown season spread —
  coverage must be checked before it can be costed.
- #16/#17 are cheap refits promised in AGENTS.md; expected gains small but
  nearly free.
