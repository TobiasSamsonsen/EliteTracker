# EliteTracker (model upgrade) Complete Research & Implementation Plan

## 0. CRITICAL OPERATING RULES & ANTI-BAN SCRAPING GUARDRAILS (READ FIRST)

1. **Read Project Context First:**
   Before writing or modifying any code, read:
   - `AGENTS.md`
   - `PROJECT_STATUS.md`
   - `README.md`
   - `src/elitetracker/model/elo.py`
   - `src/elitetracker/model/attack_defence.py`
   - `src/elitetracker/model/career.py`
   - `src/elitetracker/model/probabilities.py`
   - `src/elitetracker/model/ratings.py`
   - `src/elitetracker/simulation/season.py`
   - The backtest harness (`backtest.py` / `backtest_cli.py`) and existing scraper modules (`src/elitetracker/sources/`).

2. **STRICT ANTI-BAN SCRAPING POLICY (FotMob, SofaScore, Transfermarkt):**
   - This project relies on free, polite scraping of FotMob (fixtures + Eliteserien xG) and SofaScore (`xg-obos` for OBOS-ligaen xG). Getting rate-limited, IP-banned, or Cloudflare-blocked would force the project onto expensive commercial APIs and break the site.
   - **NEVER add extra HTTP requests per match or per cron run** to `elitetracker.refresh` or `elitetracker.research xg-obos`.
   - **NEVER run automated bulk historical re-scrapes** across past seasons during tests, CI, or model sweeps.
   - **NEVER scrape SofaScore for Eliteserien or FotMob for extra endpoints in a loop.**
   - Any new field extracted from FotMob or SofaScore (`npxG`, `red_min`, shot counts, lineup ratings/values, closing odds) **MUST piggyback strictly on the JSON payload already fetched** in the single existing request for newly completed matches, OR read from already-cached local files in `data/`.
   - If a feature would require backfilling historical seasons over the network to be evaluated, **DO NOT scrape it automatically**. Write the parser for already-fetched payloads, add a comment in `PROJECT_STATUS.md`, and if a backfill is ever needed, only provide a manual, opt-in CLI command with heavy polite throttling (e.g., jittered `time.sleep(random.uniform(4.0, 8.0))`, incremental save after every match, strict `User-Agent` / header hygiene, and immediate abort on HTTP 403/429).

3. **Walk-Forward Backtest Discipline:**
   - Every model change in Phase 1 and Phase 2 must be tested *individually* on the walk-forward backtest (`2016–2026` overall and the `2020+` / `2023+` xG windows) before deciding whether to ship it.
   - Measure **Log Loss**, **Brier Score**, **Ranked Probability Score (RPS)**, **Calibration Error (ECE)**, and **paired t-statistics** across both halves of the period and across both divisions (Eliteserien and OBOS-ligaen).
   - Only ship changes that improve out-of-sample metrics consistently, and shrink chosen parameters toward the no-change baseline (matching the `elo-v12.0` convention).
   - Document *every* tested hypothesis—both **shipped** and **rejected**—with exact log-loss/Brier/RPS deltas and t-stats in `PROJECT_STATUS.md`.
   - Bump `MODEL_VERSION` once at the end if any shipped change alters ratings, probabilities, or simulation outputs.

---

## PHASE 1: Model & Mathematical Improvements (Zero Network Traffic — Local Data Only)

All items in Phase 1 use strictly data already on disk in `data/`. Test them one at a time in the walk-forward backtest.

### 1.1 Fix the `xg_margin` Sign-Inversion Bug on Lucky Wins (`src/elitetracker/model/elo.py`)
- **The Bug:** In `updated_pair()` (`elo.py` lines 242–245):
  ```python
  if config.xg_margin and home_goals != away_goals and home_xg > 0 and away_xg > 0:
      winner = 1.0 if home_goals > away_goals else -1.0
      bonus = config.xg_margin * math.log(1.0 + abs(math.log(home_xg / away_xg)))
      scored_home = min(1.0, max(0.0, scored_home + winner * bonus))

```

`winner` is determined by **actual goals** (`home_goals > away_goals`), whereas `bonus` is the unsigned magnitude `abs(ln(home_xg / away_xg))`. When a team steals a lucky 1–0 win despite getting outplayed 0.25 xG to 2.50 xG, `winner = +1.0` and `bonus` is huge—so the code **adds a positive bonus to the lucky winner**, rewarding them more the worse they were outplayed on xG! Additionally, dominant 1–1 draws (e.g., 2.80 xG vs 0.20 xG) and 0.00 xG shutouts get skipped (`home_goals != away_goals` and `home_xg > 0`).

* **What to Test:**
1. **Variant A (Fix sign on non-drawn matches):** Sign `bonus` by the xG winner (`1.0 if home_xg > away_xg else -1.0`), or zero out the bonus when `(home_goals - away_goals) * (home_xg - away_xg) < 0`.
2. **Variant B (Apply signed smoothed xG-ratio bonus to all xG matches, including draws and 0.0 xG games):**
```python
if config.xg_margin:
    xg_ratio = math.log((home_xg + c) / (away_xg + c))
    bonus = math.copysign(config.xg_margin * math.log(1.0 + abs(xg_ratio)), xg_ratio)
    scored_home = min(1.0, max(0.0, scored_home + bonus))

```


3. Sweep `xg_margin` across `{0.03, 0.05, 0.08, 0.10, 0.12}` and smoothing constant `c` across `{0.15, 0.25, 0.35}` on both Elo's own odds and the 25/75 blended odds.



### 1.2 Test Continuous Logistic xG-Margin Update vs. Poisson `xg_implied_score` (`src/elitetracker/model/elo.py`)

* **The Hypothesis:** Currently, `elo.py` computes `scored_home = (1 - xg_alpha) * actual_score + xg_alpha * xg_implied_score(home_xg, away_xg)`. Because `actual_score` is a step function `{1.0, 0.5, 0.0}`, a 1-goal win and a 4-goal win have identical `actual_score = 1.0`. An alternative is mapping a blended goal/xG margin $\Delta y = w_{\text{xg}}(xG_H - xG_A) + (1 - w_{\text{xg}})(G_H - G_A)$ through a smooth logistic link $S_{\text{obs}} = \frac{1}{1 + 10^{-\Delta y / c}}$ (or blending that continuous margin score with `actual_score`).
* **What to Test:**
* *[UNCERTAIN / VERIFY FIRST]:* `elo.py` comments note that raw goal margins were rejected in `elo-v3` because Norwegian goal margins are noisy. Test in walk-forward whether the existing `actual_score + xg_implied_score + fixed xg_margin` (from 1.1) beats the logistic margin form $\Delta y$, or if a hybrid works better. Keep whichever has the better out-of-sample log loss and RPS.



### 1.3 Exact $O(N)$ Recurrence for `xg_implied_score` (`src/elitetracker/model/elo.py`)

* **The Problem:** `xg_implied_score(home_xg, away_xg)` runs an $O(N^2)$ nested loop with `math.factorial` up to `range(10)` without normalizing by the truncated total mass (losing ~1% of the home win mass when a side generates 4.0+ xG).
* **What to Implement:** Replace with a single $O(N)$ loop up to `cap = 12` using the Poisson recurrence `p_k = p_{k-1} * lam / k`, tracking cumulative `cdf_away_prev`, and dividing by `total_h * total_a`.

### 1.4 Blend `xG` and `xGOT` Using the Existing 4-Tuple (`attack_defence.py` & `elo.py`)

* **The Context:** `AttackDefence.shots` (`data/xg.json`) already stores a 4-tuple `(home_xg, away_xg, home_xgot, away_xgot)` where FotMob has shot data. In `ADConfig`, pure `signal = "xgot"` (100% xGOT) measured worse than 100% xG because pure xGOT assigns 0 to off-target/blocked shots.
* **The Hypothesis:** A convex combination `(1 - beta_xgot) * xG + beta_xgot * xGOT` captures both pre-shot chance creation (`xG`) and on-target shot placement quality (`xGOT`).
* **What to Test:**
* In `AttackDefence.observed()` (and optionally in `elo.py` when `len(shots) >= 4` and `shots[2:4]` are valid), sweep `beta_xgot` across `{0.15, 0.25, 0.35}`.
* Ensure clean fallback to `shots[0:2]` whenever a match only has a 2-tuple (such as SofaScore OBOS-ligaen matches if they lack xGOT).



### 1.5 Calibrate Provider Bias Between FotMob (Eliteserien) and SofaScore (OBOS-ligaen) (`attack_defence.py` & `elo.py`)

* **The Context:** Eliteserien xG comes from FotMob (Opta model), while OBOS-ligaen xG comes from SofaScore. Different xG providers often have a systematic scale offset (e.g., SofaScore xG averaging 3–6% higher or lower per goal than Opta xG), and both divisions share the same `AttackDefence` instance (`base = 0.37`) and `EloConfig`.
* **What to Test:**
* Measure the empirical `sum(goals) / sum(xg)` ratio on FotMob Eliteserien matches vs. SofaScore OBOS-ligaen matches in `data/xg.json`.
* *[UNCERTAIN / VERIFY FIRST]:* If SofaScore xG has a systematic calibration offset relative to FotMob xG (or relative to actual goals in OBOS), test multiplying OBOS xG by a constant provider-calibration scalar `c_provider` (or fitting separate `k_shots` / `alpha` per provider) in walk-forward. Also, if any matches have both FotMob and SofaScore xG stored locally, test averaging them (`0.5 * xg_fotmob + 0.5 * xg_sofascore`)—**without** scraping a second provider for matches that only have one.



### 1.6 Fix `finishing` Learning Contamination & Rating Drift (`src/elitetracker/model/attack_defence.py`)

* **Problem A (`finishing` in `_learning_rates`):**
In `_learning_rates()`, expected goals `lam` and `mu` include `1.0 * self.finishing.get(team_id, 0.0)`. However, in `observed()`, when `shots` are present, the observed signal is `0.75 * xG + 0.25 * goals`. Because `xG` has zero finishing overperformance by definition (`xG / xG = 1`), comparing an observation that is 75% `xG` against an expectation `lam` that includes 100% of `finishing` creates a systematic negative surprise for good finishers on every xG match, dragging down their `attack` rating and inflating opponents' `defence`.
* **Test:** In `_learning_rates()`, weight `finishing` by `(1.0 - cfg.alpha)` when the match has xG data in `self.shots` (since only the `1 - alpha = 0.25` goals share of `observed()` reflects finishing), while keeping `1.0 * finishing` in prediction `rates()`.


* **Problem B (Opposite-Sign Drift Between `attack` and `defence`):**
In `observe()`, `attack[home] += k * home_surprise` and `defence[away] -= k * home_surprise`. When league scoring differs from `exp(cfg.base + 0.5 * cfg.home)`, `mean(attack)` and `mean(defence)` drift in opposite directions, and `attack[home] - defence[away]` doubles that drift across seasons.
* **Test:** Center `attack` and `defence` per division at `_start_season` (or test online mean-centering) and measure impact on total goals calibration and log loss.


* **Problem C (Tempo Factor $T_i$ Decomposition):**
* *[UNCERTAIN / VERIFY FIRST]:* Currently `attack[home] - defence[away]` linearly combines attack and defence in log space, which naturally captures high-tempo teams (`attack > 0` and `defence < 0`). Test whether an explicit multiplicative tempo interaction term (e.g., when two high-event teams meet) improves Over/Under 2.5 and scoreline log loss, or if the additive log-linear parameterization is already optimal.



### 1.7 Transfermarkt Squad Market Values: Offseason Prior & In-Season Covariate (`career.py` & `attack_defence.py`)

* **The Context:** `README.md` notes that `data/` already contains squad market values from Transfermarkt, yet neither `career.py` nor `attack_defence.py` uses them.
* **What to Test:**
1. **Inspect Local Transfermarkt Data & Check for Look-Ahead Bias:** Check the structure and timestamps of the Transfermarkt files in `data/`. *[CRITICAL]:* If a season's market value file was snapshotted at the *end* of that season, use `season - 1` (or opening values) when predicting `season` so there is zero look-ahead leakage.
2. **Hypothesis A (Market-Anchored Offseason Regression Target):**
At `_start_season` in `career.py` and `attack_defence.py`, instead of pulling every club 12% (`season_regression = 0.88`) toward the flat division mean, pull each club toward a market-value-adjusted equilibrium target:
`v_rel[team] = math.log(mv[team] / geom_mean_mv_in_division)`
`target[team] = division_mean + beta_mv * v_rel[team]`
`rating[team] = target[team] + regression * (rating[team] - target[team])`
Also test initializing unseeded newcomers (`rating_for_unseeded_team` / `ADConfig.newcomer`) using `v_rel[team]`.
3. **Hypothesis B (Direct In-Season Covariate / Shrinkage in `AttackDefence.rates()`):**
Test adding `+ gamma_mv * (v_rel[home] - v_rel[away])` directly into `AttackDefence.rates()` (potentially decaying with matchday $m$ as real match results accumulate: `gamma_mv * exp(-m / tau_mv)`).
4. Measure both full-season walk-forward log loss/RPS and **Rounds 1–10 / Pre-season Scorecard** accuracy.



### 1.8 Early-Season Uncertainty Step Multiplier (Glicko-lite Decay in Rounds 1–6)

* **The Context:** In `attack_defence.py`, `ADConfig.spread = 1.10` was introduced because fixed-step online updates lag after offseason compression and winter squad turnover.
* **What to Test:**
* Track `matches_played_in_season[team]` ($m = 0, 1, 2, \dots$) inside `career.replay` and `AttackDefence`.
* Test scaling the learning step `k` on match $m$ of the season by `k_eff = k * (1.0 + gamma_early * math.exp(-m / tau))`.
* Sweep `gamma_early` in `{0.20, 0.35, 0.50}` and `tau` in `{3.0, 5.0}`, and check whether `ADConfig.spread` should be re-swept alongside it.



### 1.9 Rest Days, Midweek Congestion & UEFA Fixtures (`elo.py` & `attack_defence.py`)

* **The Context:** `Match.date` gives exact kickoff dates for every domestic league match. Additionally, top Norwegian clubs (Bodø/Glimt, Molde, Brann, Viking, Rosenborg, Tromsø, etc.) play midweek UEFA Champions League / Europa League / Conference League qualifiers and league-phase matches from July through November.
* **What to Test:**
1. **Domestic Rest Differential:** Track `last_match_date[team]` during replay and prediction. Compute `rest_diff = min(10, rest_home) - min(10, rest_away)` and test adding `gamma_rest * math.tanh(rest_diff / 3.0)` to `effective_home_advantage` / `AttackDefence.rates()`.
2. **UEFA Midweek Congestion Indicator:** *[UNCERTAIN / VERIFY FIRST]:* Check if any local files in `data/` list UEFA fixture dates, or if domestic rest days alone capture postponed/shifted weekend games. Only keep if `|t| >= 2` in walk-forward.



### 1.10 Pitch Surface Mismatch (`kunstgress` vs. `grass`) Home Advantage Boost

* **The Context:** Most Eliteserien and OBOS-ligaen clubs play on artificial turf (*kunstgress*), while a subset (e.g., Brann, Rosenborg, Fredrikstad, Lillestrøm, Bryne, Haugesund, plus clubs that switched surfaces over 2015–2026 like Sandefjord or Stabæk) play on natural grass. Grass teams visiting fast artificial turf historically experience a steeper away penalty.
* **What to Test:**
* Create a static lookup table (`src/elitetracker/normalize/surfaces.py`) mapping `(team_id, season)` to `"kunstgress"` or `"grass"`.
* Test an asymmetric surface bonus on `home_advantage` in `elo.py` and `ADConfig.home` in `attack_defence.py` when `surface(home) != surface(away)` (specifically grass visiting turf, and turf visiting grass).
* *[UNCERTAIN / VERIFY FIRST]:* Keep only if walk-forward log loss and RPS improve in both halves of `2016–2026`.



### 1.11 Re-Sweep Dormant Hooks Already in `elo.py` & `attack_defence.py` (`home_advantage_beta`, `home_beta`, `blend_gamma`, `rho`)

* **The Context:** `EloConfig` already has `home_advantage_beta: float = 0.0`, and `ADConfig` already has `home_beta: float = 0.0`, `blend_gamma: float = 0.0`, and `rho: float = -0.05`.
* **What to Test:** After applying any winning fixes from `1.1`–`1.10`, run a walk-forward re-sweep of:
* `home_advantage_beta` and `ADConfig.home_beta` (gap-scaled home advantage)
* `ADConfig.blend_gamma` (gap-dependent sharpening toward the Poisson grid for heavy favourites)
* `ADConfig.rho` (testing `-0.04` to `-0.11` for Dixon-Coles low-score dependence)
* `OUTCOME_BLEND` (currently `0.25` Elo / `0.75` AttackDefence grid)



### 1.12 Compare Online `AttackDefence` Against Schedule-Adjusted IPF & Synthetic Stat-xG Fallback

* **What to Test:**
1. **Iterative Proportional Fitting (IPF) Benchmark:** In a research script, compare the online gradient learner in `attack_defence.py` against a time-decayed opponent-adjusted IPF solver with empirical Bayes shrinkage ($\tau_0 = 6$ matches). Keep the online learner unless IPF (or an offseason IPF anchor) beats it out of sample.
2. **Synthetic Stat-xG Proxy ($\widehat{xG}_{\text{stat}}$) for Non-xG Seasons/Matches:** *[UNCERTAIN / VERIFY FIRST]:* Check whether `data/` (e.g., `football-data.co.uk` CSVs or cached FotMob match stats for 2015–2019 Eliteserien / 2015–2022 OBOS-ligaen) contains match Shots (`HS/AS`), Shots on Target (`HST/AST`), and Corners (`HC/AC`). If those columns already exist locally in `data/`, test constructing a synthetic shot-volume xG proxy:
`stat_xg = 0.30 * max(0, sot - goals) + 0.04 * max(0, shots - sot) + 0.03 * corners + 0.70 * goals`
for matches that lack FotMob/SofaScore xG, with an intermediate step size `k_stat` between `k = 0.015` and `k_shots = 0.05`. **Do NOT scrape historical match pages to get shots if they are not already on disk.**



### 1.13 Bookmaker Benchmarking: Power & Shin De-Vigging, CLV & Fractional Kelly (`backtest` / `research`)

* **The Context:** `data/` holds benchmark odds from `football-data.co.uk`.
* **What to Implement in `backtest` / `research`:**
1. Add **Power Method de-vigging** (`sum((1/o_i)^k) = 1`) and **Shin's Method de-vigging** alongside naive proportional normalization (`p_i / sum(p_j)`) so bookmaker favourite-longshot bias does not distort calibration and RPS comparisons.
2. Report model vs. bookmaker **Log Loss**, **Brier Score**, **RPS**, and simulated **Uncertainty-Damped Fractional Kelly ROI** (`0.25 * Kelly`, capped at 2.5%, with a minimum edge threshold) in `backtest_cli` output.



---

## PHASE 2: Polite Piggybacked Scraper Enhancements (Strict Anti-Ban Protocol)

**REMINDER:** Do **NOT** execute bulk network scrapes or add extra HTTP calls to `refresh` or `xg-obos`.

### 2.1 Inspect Local Scraper Code & Payloads for Piggybacked Fields

Inspect `src/elitetracker/sources/fotmob.py`, the SofaScore `xg-obos` script, and `data/xg.json` to see what is inside the **single JSON response already fetched** per match:

1. **Non-Penalty xG (`npxG`) & Penalty Counts:**
* Penalties carry ~0.78 xG and add high small-sample noise to `attack` updates and season-level `finishing = log(goals / xG)`.
* If the already-fetched FotMob/SofaScore payload includes `npxG` (or penalty events), update the normalizer so future scraped matches record `npxG` alongside `xG` and `xGOT` in `data/xg.json` (backward-compatible with existing 2-tuple and 4-tuple records).


2. **Earliest Red Card Minute (`red_min`):**
* Early dismissals (e.g., red card at 35') inflate the 11-man team's xG by ~1.0+ goal.
* If the already-fetched match payload includes card events, extract `earliest_red_min` (default `90`) so future or cached matches can test down-weighting rating updates by `r_k = 1.0 - 0.65 * ((90 - red_min) / 90)`.


3. **Starting-XI Valuation / Rating Ratio ($V_{\text{XI}}$) & Bench Drop-off ($D_{H,A}$):**
* *[UNCERTAIN / PREVIOUSLY REJECTED AS elo-v4]:* Note that `elo.py` records `elo-v4: player availability (injuries/suspensions/transfers) -- investigated by full backtest and rejected`. Do NOT add new lineup scraping calls. Only document in `PROJECT_STATUS.md` whether pre-match lineup market values or player ratings exist in the already-fetched FotMob payload and why `elo-v4` was previously rejected.


4. **Pre-Match Closing Odds in Match Payload:**
* If FotMob/SofaScore match payloads already include a pre-match odds block for matches not covered by `football-data.co.uk` (such as OBOS-ligaen), store them passively during `refresh` without making extra requests.



---

## PHASE 3: Pipeline Speed, Simulation & Frontend (`Explore` + Contact Form)

### 3.1 Recover the +32% `build_report` Slowdown (`simulation/season.py` & `pipeline.py`)

* **The Problem:** `PROJECT_STATUS.md` notes that `build_report` slowed down by +32% (`13.1s -> 17.4s`) after shipping `high_stakes` because the 20 history snapshots (`10k` runs each) also pay the conditional branch tally cost (`tally_conditionals=True`), even though `high_stakes` is gated to `RUN_IN_ROUNDS = 10` and historical snapshots don't display `high_stakes`.
* **The Fix:**
* Set `tally_conditionals=False` for history/rewound snapshot calls inside `build_report` / `pipeline.py` that do not consume `high_stakes` or `next_stakes`.
* Verify with `pytest` (`tests/test_high_stakes.py`) that all output reports remain byte-identical while recovering ~4 seconds per report build.



### 3.2 OBOS-ligaen / Eliteserien *Kvalik* Playoff Bracket Check (`simulation/season.py`)

* *[UNCERTAIN / VERIFY FIRST]:* Check how `simulation/season.py` and the table UI treat the playoff band (14th in Eliteserien, 3rd–6th in OBOS-ligaen). Currently the bands mark qualification for the playoff positions (`band_tone == "playoff"`). Check whether adding a lightweight analytical or simulated *Kvalik* winner probability (single-elimination 5th vs 6th -> vs 4th -> vs 3rd at the higher seed's home ground, followed by a two-legged play-off against Eliteserien #14) is useful for `exploreFacts` or Team Focus without cluttering the main table columns.

### 3.3 Implement `Explore` Visualisations from `PROJECT_STATUS.md` (`public/app.js` & `public/i18n.js`)

In `PROJECT_STATUS.md` ("Explore: candidate visualisations - ideas"), 10 candidates are ranked by value for effort. Implement the highest-leverage ones cleanly (following the existing `EXPLORE_ITEMS`, `exploreThumb`, `explore.<id>.*` bilingual EN/NO strings in `public/i18n.js`, `exploreFacts` key figures, and DOM tests in `tests/frontend.test.js`):

1. **Candidate #10 — Match-Odds Calibration & Bookmaker Benchmark (`viz=calibration`):**
* Export a compact JSON from `backtest_cli` (`public/data/calibration.json` or embedded) with decile reliability bins (predicted probability vs. observed win/draw/loss rate across 2015–2026) plus Log Loss, Brier, and RPS comparisons against Power/Shin de-vigged `football-data.co.uk` odds.
* Render a reliability diagram (`y = x` diagonal, bin markers, sample sizes) with `exploreFacts` comparing the model directly to bookmakers.


2. **Candidate #3 — Luck Table: Points vs. xPts from xG (`viz=luck`):**
* Zero backend changes needed: compute single-match expected points (`3 * P(win) + 1 * P(draw)`) in the browser from `results[].xg` using independent Poisson, sum across played matches up to the rewind slider, and render a diverging bar chart of `Actual Points − xG Points` per club.


3. **Candidate #1 — Prediction Scorecard Across Seasons (`viz=scorecard`):**
* Plot pre-season expected finish against actual final position for every club-season 2015–2026 (`y = x` line, hit rate within ±2 places, biggest over- and under-achievers) using the `preseason` views and final tables.


4. **Candidate #4 — Run-In Heatmap (`viz=runin`) & Candidate #8 — Scorelines: Predicted vs. Actual (`viz=scorelines`):**
* *[OPTIONAL / IF TIME PERMITS]:* Also evaluate Candidates #2 (Race lines), #4 (Run-in fixture difficulty heatmap), #5 ("Heisen" division lift Sankey/lane chart from `careers.json`), #6 (Rating river / bump chart), #7 (All-time 773-pair Head-to-Head matrix from `careers.head_to_head`), #8 (Predicted vs. actual scorelines calibration), and #9 (Stakes calendar). Prioritize #10, #3, and #1 first, or implement as many from the list of 10 as fit cleanly without bloating `public/app.js`.



### 3.4 Planned Contact Form (`PROJECT_STATUS.md` — "Contact form - planned")

* *[UNCERTAIN / ASK OR SCAFFOLD CLEANLY]:* `PROJECT_STATUS.md` notes replacing the removed footer email link with a static-hosting-compatible contact form (or modal/link) in `public/index.html` and `public/i18n.js` (`footer.text` in both EN and NO) so no raw email address is harvested by scrapers. Check how `footer.text` is currently rendered and scaffold a clean, spam-safe solution if appropriate.

---

## PHASE 4: Execution Sequence & Verification

1. **Baseline Snapshot:** Run `.venv/Scripts/python -m pytest`, `node --test tests/frontend.test.js`, and the walk-forward backtest CLI. Record exact `elo-v12.2` baseline numbers (Log Loss, Brier, RPS, ECE, and vs. bookmaker odds).
2. **Phase 1 Model Sweep:** Test items `1.1` through `1.13` one by one in `backtest_cli`. Keep only changes that demonstrably improve walk-forward metrics.
3. **Phase 2 Passive Parser Audit:** Inspect `sources/` and `data/xg.json` locally (zero bulk scraping) and add passive forward-compatible parsing for any extra fields already in the single match response.
4. **Phase 3 Pipeline & Frontend:** Ship the `tally_conditionals=False` speedup (`3.1`) and the new `Explore` visualisations (`3.3`).
5. **Final Test & Documentation Pass:**
* Run full `pytest` and `node --test` suites (adding unit tests for every new model feature and frontend view).
* Document all experiments (both shipped and rejected, with exact deltas and t-stats) in `PROJECT_STATUS.md` and update `README.md` in the repository's exact writing style.



```

```