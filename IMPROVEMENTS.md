```markdown
# EliteTracker Model upgrade Research & Implementation Plan

## 0. CRITICAL OPERATING RULES & SCRAPING GUARDRAILS (READ FIRST)

1. **Read Project Context First:**
   Before writing any code, read `AGENTS.md`, `PROJECT_STATUS.md`, `README.md`, `src/elitetracker/model/elo.py`, `src/elitetracker/model/attack_defence.py`, `src/elitetracker/model/career.py`, `src/elitetracker/model/probabilities.py`, and the backtest harness (`backtest.py` / `backtest_cli.py`).

2. **STRICT ANTI-BAN SCRAPING POLICY (FotMob & SofaScore):**
   - We rely on free, polite scraping of FotMob (fixtures + Eliteserien xG) and SofaScore (OBOS-ligaen xG). Getting rate-limited, IP-banned, or Cloudflare-blocked would force us onto expensive commercial APIs and break the project.
   - **NEVER add extra HTTP requests per match or per run** to `elitetracker.refresh` or `elitetracker.research xg-obos`.
   - **NEVER run automated bulk historical re-scrapes** across past seasons during tests, CI, or model sweeps.
   - Any new field extracted from FotMob or SofaScore (`npxG`, `red_min`, etc.) **MUST piggyback strictly on the JSON payload already fetched** in the single existing request for newly completed matches, or read from already-cached local files in `data/`.
   - If a feature would require backfilling historical seasons from the network to be backtested, **DO NOT scrape it automatically**. Instead, write the parser for already-fetched payloads, document a polite, opt-in, heavily rate-limited CLI command (e.g., jittered `sleep(3.0..6.0)`, incremental resume, caching), and ask the user before making network calls.

3. **Walk-Forward Backtest Discipline:**
   - Every model change in Phase 1 and Phase 2 must be tested *individually* on the walk-forward backtest (`2016–2026` overall and the `2020+` / `2023+` xG windows) before deciding whether to keep it.
   - Measure **Log Loss**, **Brier Score**, **Ranked Probability Score (RPS)**, and **paired t-statistics** across both halves of the sample and across both divisions (Eliteserien and OBOS-ligaen).
   - Only ship parameters that improve out-of-sample metrics consistently (or shrink chosen parameters toward the no-change baseline, matching the project's convention in `elo-v12.0`).
   - Record every experiment—both **shipped** and **rejected**—with exact deltas and t-stats in `PROJECT_STATUS.md`.
   - Bump `MODEL_VERSION` once at the end if any shipped change alters ratings, probabilities, or simulation outputs.

---

## PHASE 1: Model & Mathematical Improvements (Zero Network / Local Data Only)

Test each of the following in isolation using the existing local data in `data/`.

### 1.1 Fix `xg_margin` Sign-Inversion Bug on Lucky Wins (`src/elitetracker/model/elo.py`)
- **The Problem:** In `updated_pair()` (`elo.py` lines 242–245):
  ```python
  if config.xg_margin and home_goals != away_goals and home_xg > 0 and away_xg > 0:
      winner = 1.0 if home_goals > away_goals else -1.0
      bonus = config.xg_margin * math.log(1.0 + abs(math.log(home_xg / away_xg)))
      scored_home = min(1.0, max(0.0, scored_home + winner * bonus))

```

`winner` is determined by actual goals (`home_goals > away_goals`), while `bonus` is the unsigned magnitude of the xG ratio `abs(ln(home_xg / away_xg))`. When a team wins 1–0 despite losing the xG battle 0.25 to 2.50, `winner = +1.0` and `bonus` is large—so the code **rewards the lucky winner more the worse it was outplayed on xG**. Furthermore, dominant 1–1 draws (e.g., 2.8 xG vs 0.3 xG) and 0.00 xG shutouts receive zero adjustment.

* **What to Test:**
1. **Variant A (Keep `home_goals != away_goals`, fix sign):** Sign the bonus by who won the xG battle (or clamp `bonus = 0` when the match winner lost on xG).
2. **Variant B (Pure xG-ratio direction on all xG matches, including draws, with additive smoothing $+c$):**
```python
if config.xg_margin:
    xg_ratio = math.log((home_xg + 0.25) / (away_xg + 0.25))
    bonus = math.copysign(config.xg_margin * math.log(1.0 + abs(xg_ratio)), xg_ratio)
    scored_home = min(1.0, max(0.0, scored_home + bonus))

```


3. Sweep `xg_margin` across `{0.03, 0.05, 0.08, 0.10, 0.12}` and smoothing constant `c` across `{0.15, 0.25, 0.35}` on both Elo's own odds and the blended shipped odds.



### 1.2 Blend `xG` and `xGOT` Using the Existing 4-Tuple (`attack_defence.py` & `elo.py`)

* **The Context:** `AttackDefence.shots` (`data/xg.json`) already stores a 4-tuple `(home_xg, away_xg, home_xgot, away_xgot)` where available. Previously, `signal = "xgot"` (100% xGOT) measured worse than 100% xG because pure xGOT zeros out all off-target and blocked shots.
* **Hypothesis:** A convex blend `(1 - beta) * xG + beta * xGOT` combines pre-shot chance creation (`xG`) with on-target placement quality (`xGOT`).
* **What to Test:**
* In `AttackDefence.observed()` (and optionally in `elo.py` / `career.py` where `shots` has length 4 and `shots[2:4]` are non-null / > 0), test `beta_xgot` in `{0.15, 0.25, 0.35}`.
* *[UNCERTAIN / VERIFY FIRST]:* Check whether OBOS-ligaen (SofaScore) entries in `data/xg.json` have 2-tuples or 4-tuples, and ensure graceful fallback to `shots[0:2]` whenever `len(shots) < 4` or `xgot` is missing.



### 1.3 Fix `finishing` Learning Contamination & Rating Drift (`src/elitetracker/model/attack_defence.py`)

* **Problem A (`finishing` in `_learning_rates`):**
In `_learning_rates()`, expected goals include `1.0 * self.finishing.get(team_id, 0.0)`. However, in `observed()`, when `shots` are present, the observed signal is `0.75 * xG + 0.25 * goals`. Because `xG` contains zero finishing overperformance by definition, comparing `0.75 * xG + 0.25 * goals` against an expectation that includes `1.0 * finishing` systematically penalizes clinical finishers' `attack` rating on every xG-backed match.
* **Test:** In `_learning_rates(home_id, away_id, on)`, pass `has_shots: bool` (or scale `finishing` by `1.0 - cfg.alpha` when the match has xG data) while keeping full `1.0 * finishing` in prediction `rates()`.


* **Problem B (Zero-Sum Centering of `attack` and `defence`):**
In `observe()`, `attack[home] += k * surprise` and `defence[away] -= k * surprise`. If league scoring drifts above `exp(cfg.base + 0.5 * cfg.home)`, `mean(attack)` drifts positive while `mean(defence)` drifts negative, and `attack[home] - defence[away]` doubles that drift.
* **Test:** Recenter `attack` and `defence` per division at `_start_season` (or after each matchday) so `mean(attack) == mean(defence)` (or both have mean 0 for Eliteserien and `-division_gap` for OBOS), and check if total goals calibration and log loss improve.



### 1.4 Exact $O(N)$ Recurrence for `xg_implied_score` (`src/elitetracker/model/elo.py`)

* **The Problem:** `xg_implied_score(home_xg, away_xg)` currently runs an $O(N^2)$ nested loop with `math.factorial` up to `range(10)` without normalizing by the truncated total mass (losing ~1% probability mass when a team racks up 4.0+ xG).
* **What to Implement:** Replace with a single $O(N)$ loop up to `cap = 12` using the Poisson recurrence `p_k = p_{k-1} * lam / k`, tracking cumulative `cdf_away_prev`, and dividing by `total_h * total_a`. Verify if this changes any ratings by more than floating-point noise or slightly improves high-xG updates.

### 1.5 Transfermarkt Squad-Value Prior in Offseason Regression (`career.py` & `attack_defence.py`)

* **The Context:** `README.md` notes that `data/` already holds squad market values from Transfermarkt. Currently, offseason regression (`season_regression = 0.88`) pulls every club in a division toward the **flat division mean**. That under-rates financial heavyweights (Bodø/Glimt, Viking, Molde) and treats all promoted clubs identically in Rounds 1–8.
* **What to Test:**
* Inspect how Transfermarkt squad values are stored in `data/`.
* For each `(season, league)`, compute each club's log market value relative to the division's geometric mean:
`v_rel[team] = math.log(mv[team] / geom_mean_mv)`
* Instead of regressing toward `mean`, regress each club's Elo (in `career.py`) and `attack`/`defence` (in `attack_defence.py`) toward a market-value-informed target:
`target[team] = mean + beta_mv * v_rel[team]`
`rating[team] = target[team] + regression * (rating[team] - target[team])`
* Also test seeding unseeded newcomers using their `v_rel[team]` instead of a flat floor.
* Sweep `beta_mv` in walk-forward across `2016–2026`. Check both full-season log loss and **pre-season / Rounds 1–10** accuracy.
* *[UNCERTAIN / VERIFY FIRST]:* Verify that historical Transfermarkt values in `data/` reflect start-of-season (or prior-season) squad values without look-ahead bias from mid-season winter/summer rises. If timestamps are end-of-year, lag the market value lookup by `season - 1` so the backtest is strictly leak-free.



### 1.6 Early-Season Uncertainty Step Multiplier (Glicko-lite Decay in Rounds 1–6)

* **The Context:** In `attack_defence.py`, `spread = 1.10` was needed because fixed-step online updates lag after offseason regression and winter squad turnover.
* **What to Test:**
* Track `matches_played_in_season[team]` inside `career.replay` and `AttackDefence`.
* Scale the rating step `k` on match $m \in \{0, 1, 2, \dots\}$ of the season by `k_eff = k * (1.0 + gamma_early * math.exp(-m / tau))`.
* Sweep `gamma_early` in `{0.20, 0.35, 0.50}` and `tau` in `{3.0, 5.0}`, and check whether `ADConfig.spread` needs re-tuning when early steps are faster.



### 1.7 Rest Days & Midweek Congestion from `Match.date` (Zero Extra Data Needed)

* **The Context:** `Match.date` is already present on every fixture. In summer/autumn, Norwegian clubs in UEFA qualifiers/league phase (or after midweek league rounds) play on 3 days rest against opponents on 7+ days rest.
* **What to Test:**
* During replay and prediction, track `last_match_date[team]`.
* Compute `rest_home = min(10, (match_date - last_date_home).days)` and `rest_away = min(10, (match_date - last_date_away).days)` (defaulting to 7 at season start).
* Test adding a rest-differential term `gamma_rest * math.tanh((rest_home - rest_away) / 3.0)` to `effective_home_advantage` in `elo.py` and/or `effective_home` in `AttackDefence.rates()`.
* *[UNCERTAIN / VERIFY FIRST]:* Since `Match` only contains league games (not midweek UEFA or NM Cup matches unless those dates are stored), check whether league-only rest differentials carry significant signal (`|t| >= 2`) or if the effect is concentrated only on clubs in European competition.



### 1.8 Pitch Surface Mismatch (`kunstgress` vs. `grass`) Home Advantage Boost

* **The Context:** Most Norwegian clubs play on artificial turf (*kunstgress*), while a subset (e.g., Brann, Rosenborg, Fredrikstad, Lillestrøm, Bryne, Sandefjord prior to turf switch, Stabæk in grass years, Haugesund) play on natural grass. Natural-grass teams playing away on fast, watered artificial turf historically suffer a larger away drop-off.
* **What to Test:**
* Create a small static lookup module (e.g., `src/elitetracker/normalize/surfaces.py`) mapping `team_id` (and season ranges where a club switched surface) to `"kunstgress"` or `"grass"`.
* Test a surface-mismatch bonus on `home_advantage` (e.g., `+10` to `+25` Elo and `+0.04` to `+0.08` log goals in `AttackDefence`) when `surface(home) != surface(away)` (specifically when a `"grass"` club visits `"kunstgress"`).
* *[UNCERTAIN / VERIFY FIRST]:* Keep this only if walk-forward log loss and RPS improve across both halves of `2016–2026`.



### 1.9 Schedule-Adjusted IPF Check vs. Online `AttackDefence` & Power De-Vigging

* **What to Test:**
1. Compare the existing online gradient `AttackDefence` (`k = 0.015`, `k_shots = 0.05`, `spread = 1.10`) against a time-decayed Iterative Proportional Fitting (IPF) solver in a research script (`elitetracker.research`). As noted in `PROJECT_STATUS.md`, online ratings carry across seasons cleanly; only adopt IPF or hybrid ideas if they beat the online learner in strict walk-forward.
2. When comparing model probabilities against `football-data.co.uk` benchmark odds in `backtest` / `validation`, implement **Power Method de-vigging** (`sum((1/o_i)^k) = 1`) alongside proportional normalization so favourite-longshot bias in bookmaker margins doesn't skew the benchmark comparison.



---

## PHASE 2: Polite Piggybacked Scraper Enhancements (Strict Anti-Ban Protocol)

**REMINDER:** Do **NOT** execute bulk network scrapes. Only inspect existing scraper code (`src/elitetracker/sources/fotmob.py`, SofaScore research script, and cached files in `data/`).

### 2.1 Inspect Existing Payloads for `npxG` (Non-Penalty xG) and `red_min` (Earliest Red Card)

1. Check `src/elitetracker/sources/` and `data/xg.json` (plus any raw cached JSONs in `data/`).
2. Determine if the **exact same single HTTP response** currently fetched per match from FotMob / SofaScore already contains:
* Non-penalty xG (`Expected goals (xG) non-penalty` in FotMob stats, or penalty counts).
* Red card events (`content.matchFacts.events` in FotMob) with the minute of dismissal.


3. **If and only if** they are present in the already-fetched payload:
* Update the parser so future matches fetched by `refresh` optionally store `npxg` and `red_min` without making a single extra HTTP request, while keeping full backward compatibility with existing 2-tuple and 4-tuple entries in `data/xg.json`.
* *[UNCERTAIN / DO NOT AUTO-BACKFILL]:* Because historical matches in `data/xg.json` may only have the 4-tuple `(home_xg, away_xg, home_xgot, away_xgot)`, **do not** run a scraper loop over historical seasons to fetch `npxG` or `red_min`. Document in `PROJECT_STATUS.md` what is available locally vs. what would require a slow, multi-day polite backfill.



---

## PHASE 3: Pipeline Performance, Simulation & Frontend (`Explore`) Improvements

### 3.1 Recover the +32% `build_report` Slowdown (`simulation/season.py` & `pipeline.py`)

* **The Problem:** `PROJECT_STATUS.md` notes that `build_report` slowed down by +32% (`13.1s -> 17.4s`) after adding `high_stakes` because the 20 history snapshots (`10k` runs each) also pay the conditional branch tally cost, and `high_stakes` badges are gated to `RUN_IN_ROUNDS = 10` anyway.
* **The Fix:**
* Ensure `tally_conditionals=False` is passed whenever simulating snapshots or states that do not consume `high_stakes` / `next_stakes` (or compute conditional branch tallies only when needed).
* Verify with `pytest` (`tests/test_high_stakes.py`) that all output reports remain byte-identical while recovering the ~4s per report build.



### 3.2 Ship `Explore` Candidate #10: Match-Odds Calibration & Bookmaker Benchmark

* **The Goal:** Add the `viz=calibration` card to `?view=explore` (as listed in `PROJECT_STATUS.md` under "Explore: candidate visualisations").
* **Implementation:**
1. Extend `backtest_cli` (or a small build helper) to export a compact static JSON summary (or embed in the site data) containing:
* Predicted probability vs. observed frequency bins (10 deciles) across all replayed seasons (2015–2026) and by era/division.
* Overall and per-season Log Loss, Brier Score, and RPS for `elo-v12.x` vs. de-vigged `football-data.co.uk` closing odds (where available in `data/`).


2. In `public/app.js` and `public/i18n.js` (both English and Norwegian strings), add the `calibration` Explore item with a clean SVG reliability diagram (`y = x` diagonal, bin dots sized by match count, error bars) and `exploreFacts` key figures (Calibration error / ECE, Brier / Log Loss vs. bookmakers, sharpening over time).



### 3.3 Ship `Explore` Candidate #3: Luck Table (`Points vs. xPts from xG`)

* **The Goal:** Add `viz=luck` to `?view=explore` using data the browser already has (`results[].xg`), requiring **zero backend pipeline changes**.
* **Implementation:**
1. For every played match in the selected season/league (up to the current rewind slider date) that has `xg`, compute each club's single-match expected points `3 * P(win) + 1 * P(draw)` using independent Poisson on `(home_xg, away_xg)`.
2. Render a diverging horizontal bar chart per club (`Actual Points − xG Points`), showing who is outperforming via finishing/goalkeeping vs. who is underperforming their underlying chances.
3. Add bilingual strings in `public/i18n.js`, `exploreFacts` summary cards (Luckiest club, Most unlucky club, correlation between xG-points and actual table), and unit/DOM tests in `tests/frontend.test.js`.



### 3.4 OBOS-ligaen / Eliteserien *Kvalik* Playoff Modeling Check (`simulation/season.py`)

* *[UNCERTAIN / VERIFY FIRST]:* Check how `simulation/season.py` currently treats the playoff band (`band_tone == "playoff"`, 14th in Eliteserien and 3rd–6th in OBOS-ligaen). Confirm whether the UI reports "Probability of finishing in the Playoff positions" or "Probability of Promotion/Relegation via Playoff", and document whether simulating the seeded single-elimination OBOS bracket (3rd–6th) + 2-legged final against Eliteserien #14 is desirable as a secondary stat.

---

## PHASE 4: Execution Order & Verification Checklist

Execute in this exact sequence:

1. **Audit & Baseline:** Run `.venv/Scripts/python -m pytest`, `node --test tests/frontend.test.js`, and run the walk-forward backtest CLI to record the exact `elo-v12.2` baseline metrics (Log Loss, Brier, RPS, calibration error, and benchmark comparison vs. bookmaker odds).
2. **Phase 1 Sweep:** Implement and backtest items `1.1` through `1.9` one at a time. Keep only the changes that pass walk-forward validation.
3. **Phase 2 Audit:** Inspect the local scraper code and `data/xg.json` structure without making bulk network calls. Implement forward-compatible parsing if available in existing responses.
4. **Phase 3 Build:** Implement the `tally_conditionals` speedup (`3.1`) and the new Explore visualisations (`3.2` and `3.3`).
5. **Final Verification:**
* Ensure all Python tests (`pytest`) and Node tests (`node --test tests/frontend.test.js`) pass.
* Update `PROJECT_STATUS.md` and `README.md` (and `MODEL_VERSION` if predictions changed) following the exact prose style and conciseness of the existing files.



```

---

### Why this structure protects your scrapers while maximizing gains
* **Hard separation between Phase 1 and Phase 2:** By explicitly instructing Claude Code to test all mathematical improvements (`1.1`–`1.9`) against your local files in `data/` first[cite: 2], it will never touch `fotmob.py` or your SofaScore script (`elitetracker.research xg-obos`)[cite: 2] during model development.
* **Zero-request features come first:** Fixing the `xg_margin` sign inversion in `elo.py`[cite: 5], blending `xG` + `xGOT` from your existing 4-tuple in `attack_defence.py`[cite: 3], fixing the `finishing` scaling in `_learning_rates`[cite: 3], using your local Transfermarkt values for offseason regression[cite: 2, 3, 4], and computing rest days from `Match.date`[cite: 4, 7] require **zero network traffic**.
* **Explicit `[UNCERTAIN / DO NOT AUTO-BACKFILL]` gates:** Whenever Claude Code looks at `npxG` or `red_min`, it is strictly forbidden from running a historical backfill loop that could trigger a Cloudflare/IP block on FotMob or SofaScore[cite: 2].

```