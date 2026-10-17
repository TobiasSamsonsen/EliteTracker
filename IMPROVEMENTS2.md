# Model Improvements Plan (Post-`elo-v15.0`)

Actionable research and engineering roadmap for improving **EliteTracker** beyond `elo-v15.0`. This document is structured for automated execution: each item states the exact hypothesis, the files and functions involved, the mathematical formulation, the scraping constraints, and the acceptance test required to ship it.

---

## 0. Execution & Backtesting Rules (Read First)

Before modifying any production code in `src/elitetracker/`, every candidate change must be evaluated through `experiments/improvements/harness.py` against the current shipped baseline (`elo-v15.0`):

1. **Identity Check First:** Every experiment script must first run `harness.identity()` (or verify that setting the new parameter to its null/default value reproduces the shipped `elo-v15.0` log loss to within $2 \times 10^{-16}$ across all played matches).
2. **Evaluation Windows:**
   * `all16`: Both divisions scored from 2016 onward ($n \approx 5,183$).
   * `eliteserien` and `obosligaen`: Scored separately from 2016 onward and on `2021+`.
   * `xg_window`: Matches carrying xG (Eliteserien $2020+$, OBOS-ligaen $2023+$, $n \approx 2,523$).
   * `fav70`: Matches where the model prices the favourite at $p \ge 0.70$ (to verify fixes for the heavy-favourite under-confidence ceiling).
3. **Ship Criteria:**
   * **One-knob / zero-data changes:** Walk-forward out-of-sample (OOS) selection (each season from 2019 onward scored using the parameter value that minimized log loss on all prior seasons) must be negative on **log loss, Brier score, and RPS**, have the **same sign in both date halves**, and achieve paired $t \le -1.0$ OOS (and $|t| \ge 2.0$ in-sample). Ship a value shrunk toward "no change", not the raw grid optimum.
   * **New data dependencies or structural terms:** Must clear paired $|t| \ge 2.0$ across the target window, improve or hold neutral on the Eliteserien closing-line benchmark (`model/benchmark.py`), and agree in sign across both halves.
4. **Marginal Stacking:** Do not ship two changes that solve the same calibration error. After testing candidates individually, stack the survivors and test each survivor *marginally* (removing one at a time from the stack) to confirm each still contributes.
5. **Single Version Bump:** Keep `MODEL_VERSION` untouched during experiments. Bump `MODEL_VERSION = "elo-v16.0"` in `src/elitetracker/model/elo.py` **once** at the very end when the winning bundle is merged, and log every accepted and rejected result in `PROJECT_STATUS.md`.

---

## Phase 1: Silent Code Bugs & Scraper Hygiene (Do First)

### 1.0 Fix Three Silent Bugs in `attack_defence.py` and `history.py`
**Target files:** `src/elitetracker/model/attack_defence.py`, `src/elitetracker/simulation/history.py`

#### Bug A: `finishing` regresses toward the division's prior-season luck (`mean_f`) instead of `0.0`
* **Diagnosis:** In `AttackDefence._start_season()` (`attack_defence.py` lines 230--235):
  ```python
  fin_known = [t for t in teams if t in self.finishing]
  if fin_known:
      mean_f = sum(self.finishing[t] for t in fin_known) / len(fin_known)
      for t in fin_known:
          self.finishing[t] = mean_f + cfg.finishing_regression * (self.finishing[t] - mean_f)
  ```
  Although the comment states *"Finishing regresses toward 0 (log-space average = 1.0x multiplier)"*, adding `mean_f` back preserves $100\%$ of the division-wide goals-to-xG offset from the previous season. When Eliteserien collectively overperformed xG in 2022 ($\text{goals}/\text{xG} = 1.20$), $\text{mean\_f} \approx \ln(1.20) = +0.182$ was carried unshrunk into 2023 for every club, inflating total expected goals ($\lambda, \mu$).
* **Fix:** Test both exact zero-centering (`self.finishing[t] = cfg.finishing_regression * (self.finishing[t] - mean_f)`) and direct shrinkage toward zero (`self.finishing[t] = cfg.finishing_regression * self.finishing[t]`) on outcome log loss and total-goals/scoreline log loss.

#### Bug B: Stale `finishing` persists across non-xG seasons
* **Diagnosis:** In `AttackDefence._start_season()`, `self.finishing[team]` is only recomputed for teams present in `self._season_goals` (teams that had xG matches in `prev_season`). If a club had a non-zero `finishing` in Eliteserien 2021 and was relegated to OBOS-ligaen in 2022 (where no xG existed), its 2021 `finishing` was never cleared at the start of 2023.
* **Fix:** For any club in `self.finishing` that did not accumulate `self._season_xg` in `prev_season`, decay or reset its `finishing` value at `_start_season()`.

#### Bug C: `rates_against_average()` does not call `start_season(season)`
* **Diagnosis:** In `AttackDefence.rates_against_average(team_id, league, season)`, `self.start_season(season)` is never called (unlike `rates()`, which calls `self._ensure(on, ...)`). On a pre-season view (0 played matches in the current season), `prior.copy().replay(rewound_all)` is a no-op, so calling `rates_against_average()` before `rates()` reads un-regressed prior-season ratings without `value_pull`, newcomer placement, or updated `finishing`.
* **Fix:** Call `self.start_season(season)` at the top of `rates_against_average()`.

---

### 1.1 Anti-Blocking & Scraper Hygiene Upgrade
**Target files:** `src/elitetracker/sources/sofascore.py`, `src/elitetracker/sources/transfermarkt.py`, `src/elitetracker/sources/fotmob.py`, `src/elitetracker/refresh.py`

Sofascore and Transfermarkt sit behind Cloudflare/CDN bot protection that inspects TLS ClientHello (JA3/JA4) and HTTP/2 framing, causing standard `urllib` / `requests` calls to return HTTP `403` even with a browser `User-Agent`.

1. **TLS Impersonation via `curl_cffi`:**
   * Add a lightweight wrapper in `src/elitetracker/sources/_http.py` that uses `curl_cffi.requests.Session(impersonate="chrome124")` when installed (falling back gracefully to `urllib.request` if unavailable).
   * Reuse a single persistent `Session` per scrape run so HTTP/2 connections and Cloudflare cookies persist across requests.
2. **Browser Navigation Headers:**
   * Include realistic fetch headers on API requests:
     * `Accept: application/json, text/plain, */*`
     * `Accept-Language: nb-NO,nb;q=0.9,en-US;q=0.8,en;q=0.7`
     * `Referer: https://www.sofascore.com/` (for Sofascore) or `https://www.fotmob.com/` (for FotMob)
     * `Sec-Fetch-Dest: empty`, `Sec-Fetch-Mode: cors`, `Sec-Fetch-Site: same-origin`
3. **Schedule-Gated Refresh in CI (`refresh.py`):**
   * Before querying FotMob or Sofascore match-detail/xG endpoints in the hourly cron job, inspect the local normalized fixture dates. Only fetch xG for matches where `played` is true and either:
     * `match_id` is missing from `data/xg.json`, or
     * `0 <= (today - match_date).days <= 2` (to capture post-match xG revisions).
   * If zero matches in a division were played in the last 48 hours and none are kicking off today, skip external xG requests completely.
   * Maintain the strict circuit breaker: halt immediately on the first HTTP `403` or `429`, save progress after each match, and wait a jittered $4\text{--}8\text{ s}$ between backfill requests.

---

## Phase 2: Zero-Scraping Mathematical & Local-Data Improvements (Ranked by Gain)

### Rank 1: Unclamp `xg_margin` & Variance-Stabilize `AttackDefence` Updates (Fixing the "Bodø/Glimt Ceiling")
**Estimated Gain:** $-0.0015$ to $-0.0030$ log loss on favourites ($p \ge 0.70$), $-0.0005$ to $-0.0012$ overall.  
**Target files:** `src/elitetracker/model/elo.py`, `src/elitetracker/model/attack_defence.py`

#### The Problem
In `PROJECT_STATUS.md` ("Recalibration re-tested on elo-v14.0"), favourites priced at $p \ge 70\%$ in 2021--2026 won $82.9\%$ of the time vs. $76.7\%$ priced (half of that excess being Bodø/Glimt winning 49 of 53). Probability lookup tables failed because the ratings of dominant clubs lag behind their true strength. Two mathematical ceilings in the code cause this:

1. **The `[0.0, 1.0]` Clamp in `elo.py` (`updated_pair`):**
   ```python
   scored_home = (1.0 - config.xg_alpha) * scored_home + config.xg_alpha * xg_score
   if config.xg_margin:
       c = config.xg_margin_smoothing
       ratio = math.log((home_xg + c) / (away_xg + c))
       bonus = math.copysign(config.xg_margin * math.log(1.0 + abs(ratio)), ratio)
       scored_home = min(1.0, max(0.0, scored_home + bonus))
   ```
   When a dominant team wins (`actual_score = 1.0`) and dominates on xG (`xg_score = 0.90`), `scored_home` before the margin bonus is $(0.70)(1.0) + (0.30)(0.90) = 0.97$. A typical `bonus` of $+0.12$ pushes `scored_home` to $1.09$, which `min(1.0, ...)` **truncates back to `1.0`**. Thus, `xg_margin` is almost completely discarded on dominant wins and only acts on draws or lucky wins! Meanwhile, because `scored_home` is capped at $1.0$, a heavy favourite with $\text{expected\_home} = 0.92$ can gain at most $K \times (1.0 - 0.92) = +2.4$ Elo from a $5\text{--}0$ blowout, while a single $1\text{--}1$ draw costs $-12.6$ Elo.
2. **Asymmetric Lower-Bound & Poisson Variance in `AttackDefence.observe()`:**
   In `attack_defence.py`, the update is `obs_home - lam`. Because observed goals/xG cannot be negative ($\text{obs} \ge 0$), an elite defence expected to concede $\mu = 0.55$ can achieve a maximum positive defensive surprise of $0.0 - 0.55 = -0.55$ on a clean sheet, whereas conceding 2 goals inflicts a $+1.45$ penalty. Conversely, a dominant attack with $\lambda = 2.60$ has high Poisson standard deviation ($\sqrt{\lambda} = 1.61$).

#### Experiments to Run (`experiments/improvements/rank1_ceiling.py`)
1. **Variant 1A (Unclamped / Widened `xg_margin` in `elo.py`):**
   * Test replacing `min(1.0, max(0.0, scored_home + bonus))` with `min(1.0 + cap_ext, max(-cap_ext, scored_home + bonus))` for $\text{cap\_ext} \in \{0.05, 0.10, 0.15, 0.25, \infty\}$, sweeping `xg_margin` $\gamma \in \{0.05, 0.08, 0.10, 0.12, 0.15\}$.
2. **Variant 1B (Surprise-Scaled xG Margin Multiplier in `elo.py`):**
   * Instead of adding `bonus` inside the `[0, 1]` clamp, test scaling the Elo update when the xG ratio agrees with the direction of `(scored_home - expected_home)` (or directly adding the unclamped xG margin after clamping the base score).
3. **Variant 1C (Variance-Stabilized / Pearson-Residual Step in `attack_defence.py`):**
   * In `AttackDefence.observe()`, scale the surprise by the expected rate to power $-\nu$:
     $$\text{home\_surprise} = \frac{\text{obs\_home} - \lambda}{\max(\lambda, 0.40)^{\nu}}, \qquad \text{away\_surprise} = \frac{\text{obs\_away} - \mu}{\max(\mu, 0.40)^{\nu}}$$
     Sweep $\nu \in \{0.0, 0.15, 0.25, 0.35, 0.50\} \times k_{\text{shots}} \in \{0.04, 0.05, 0.06\}$.
   * Check both overall OOS log loss and calibration in the $p \ge 0.70$ favourite bin.

---

### Rank 3: Game-State-Adjusted xG (Score-Effects) from Local Shot Timestamps
**Estimated Gain:** $-0.0010$ to $-0.0020$ log loss on xG matches.  
**Target files:** `src/elitetracker/sources/fotmob.py`, `src/elitetracker/model/attack_defence.py`, `src/elitetracker/model/elo.py`

#### The Problem
In `PROJECT_STATUS.md` ("Luck: can finishing and goalkeeping take the trend out?"), you found a strong quality residual ($r = +0.46$) where top teams consistently earn more points than their raw match xG predicts, even after accounting for finishing and goalkeeping. In football, teams that score early shift into defensive/counter-attacking game states, allowing trailing opponents to take low-efficiency volume shots late in matches ("score effects"). Raw xG sums all shots equally regardless of the scoreline when the shot was taken.

#### Data Already on Disk (Zero Scraping Required)
`data/raw/fotmob_match_extras.json` already holds every shot's `min`, `team_id`, `xg`, `situation`, and every goal's minute for all 1,608 Eliteserien matches (2020--2026), and `sources/fotmob.py` (`parse_match_details`) already parses the `shotmap` on every live refresh.

#### Experiments to Run (`experiments/improvements/rank3_gamestate_xg.py`)
1. For each match in `fotmob_match_extras.json`, reconstruct the live score difference $\Delta g = g_{\text{shooter}}(t) - g_{\text{opponent}}(t)$ immediately prior to each shot at minute $t$.
2. Weight each shot's xG by game state:
   $$w(\Delta g, t) = \begin{cases} 1 + \delta_{\text{lead}} & \text{if } \Delta g \ge 1 \\ 1.0 & \text{if } \Delta g = 0 \\ 1 - \delta_{\text{trail1}} & \text{if } \Delta g = -1 \\ 1 - \delta_{\text{trail2}} & \text{if } \Delta g \le -2 \end{cases}$$
   Also test a late-garbage-time damper when $|\Delta g| \ge 2$ and $t \ge 75'$.
3. Normalize across the corpus so mean match xG is preserved ($1.00\times$ scale).
4. Sweep $\delta_{\text{lead}} \in \{0.0, 0.05, 0.10, 0.15\}$ and $\delta_{\text{trail2}} \in \{0.0, 0.10, 0.20, 0.30\}$ in `AttackDefence.observed()` and `elo.updated_pair()`.
5. If it clears the OOS ship rule, append `[gs_home_xg, gs_away_xg]` to `parse_match_details` in `sources/fotmob.py` and backfill `data/xg.json` from the local `fotmob_match_extras.json` (0 network calls).

---

### Rank 5: Open-Play vs. Set-Piece xG Split in `AttackDefence`
**Estimated Gain:** $-0.0008$ to $-0.0015$ log loss on Eliteserien $2020+$.  
**Target files:** `src/elitetracker/sources/fotmob.py`, `src/elitetracker/model/attack_defence.py`

#### The Problem
While `elo-v12.0` proved that penalty xG should not be stripped (because winning penalties reflects box dominance), non-penalty xG still lumps together **open-play shots** (`RegularPlay`, `FastBreak`, `IndividualPlay`) and **set-piece shots** (`FromCorner`, `SetPiece`, `FreeKick`, `ThrowIn`). Open-play chance creation is significantly more persistent from match to match than corner-scramble xG.

#### Experiments to Run (`experiments/improvements/rank5_openplay_xg.py`)
1. Using the local `data/raw/fotmob_match_extras.json` shot situations, split each team's match xG into $\text{xG}_{\text{open}}$, $\text{xG}_{\text{set}}$, and $\text{xG}_{\text{pen}}$.
2. First measure year-to-year and split-half autocorrelation of $\text{xG}_{\text{open}}$ vs. $\text{xG}_{\text{set}}$ across teams.
3. Test weighting the xG signal fed into `AttackDefence.observed()`:
   $$\text{xG}_{\text{weighted}} = \frac{w_{\text{open}} \cdot \text{xG}_{\text{open}} + w_{\text{set}} \cdot \text{xG}_{\text{set}} + w_{\text{pen}} \cdot \text{xG}_{\text{pen}}}{c_{\text{norm}}}$$
   Sweep $w_{\text{set}} \in \{0.50, 0.65, 0.80, 1.00\}$ with $w_{\text{open}} = 1.0$ (and $c_{\text{norm}}$ keeping mean league xG constant).

---

### Rank 6: Late-Season Asymmetric Table-Stakes ("Dead Rubber" vs. "Must-Win")
**Estimated Gain:** $-0.0010$ to $-0.0020$ log loss in Rounds 25--30 ($-0.0003$ overall).  
**Target files:** `src/elitetracker/model/table.py`, `src/elitetracker/pipeline.py`

#### The Problem
In `PROJECT_STATUS.md` ("Where exactly the market wins"), the model's log-loss deficit to Pinnacle closing odds more than doubles in the second half of the season ($+0.0152$ vs. $+0.0068$). Calendar rest days did not explain this (`1.9`). In the final 5--6 rounds of a 30-round season, mid-table clubs safe from relegation and out of reach of Europe rotate youth players and drop intensity, while opponents fighting for survival, promotion, or medals play at maximum intensity.

#### Experiments to Run (`experiments/improvements/rank6_tablestakes.py`)
1. With zero external data, for any match where both teams have played $n \ge 24$ matches, compute the live league table (`table_from_matches`) strictly from matches played prior to that kickoff date.
2. For each team $i$ with $r_i = 30 - n_i$ matches remaining, compute its minimum points distance $d_i$ to any active threshold boundary $B$ (1st place, last European/Top-2 spot, promotion play-off 6th spot, relegation play-off 14th spot, direct relegation 15th spot):
   $$d_i = \min_{b \in B} |\text{pts}_i - \text{pts}_{b}|$$
   Define table pressure:
   $$P_i = \exp\!\left(-\frac{\max(0, d_i - 1)}{\tau_{\text{pts}} \cdot r_i}\right) \in (0, 1]$$
   (If a team is mathematically eliminated from all bands above and safe from all bands below, $P_i \to 0$; if a team is within 1--3 points of a boundary, $P_i \to 1$).
3. Apply a prediction-only rating shift (identical in architecture to `SURFACE_EDGE` so career ratings are untouched):
   $$\Delta \text{Elo}_{\text{stakes}} = \gamma_{\text{stakes}} \cdot (P_{\text{home}} - P_{\text{away}})$$
   Sweep $\gamma_{\text{stakes}} \in \{0, 10, 20, 30, 45\}$ and $\tau_{\text{pts}} \in \{0.5, 0.8, 1.2\}$ walk-forward on $n \ge 24$ fixtures and across `all16`.

---

### Rank 8: Pairwise Travel Distance & Derby Compression on Home Advantage
**Estimated Gain:** $-0.0004$ to $-0.0009$ log loss across `all16`.  
**Target files:** `src/elitetracker/normalize/distances.py` (new), `src/elitetracker/model/elo.py`, `src/elitetracker/model/attack_defence.py`

#### The Problem
Per-team home advantage failed in `elo-v3` because fitting 48 separate parameters overfits noise. However, `normalize/surfaces.py` succeeded ($t = -2.98$) because it introduced a **single-parameter pairwise physical relationship** between the two clubs. In Norway, travel distances vary from $<10\text{ km}$ (Oslo/Akershus derbies: Vålerenga, KFUM, Lyn, Stabæk, Lillestrøm, Strømmen; Østfold derby: Fredrikstad vs. Sarpsborg 08) to $>1,100\text{ km}$ (trips to Tromsø, Bodø, Alta, Sogndal, Hødd). Local derbies have zero travel fatigue and heavy away support, compressing home advantage; long-haul trips expand it.

#### Experiments to Run (`experiments/improvements/rank8_distance.py`)
1. Create a static lookup of stadium `(lat, lon)` coordinates for all 48 clubs in the corpus (`normalize/distances.py`) and compute great-circle haversine distance $d(\text{home}, \text{away})$ in km.
2. Test two 1-knob formulations (prediction-only and rating+prediction):
   * **Continuous log-distance scaling:**
     $$\text{HA}_{\text{eff}} = \text{HA}_0 + \beta_{\text{dist}} \cdot \ln\!\left(\frac{\max(d, 15)}{280}\right)$$
   * **Derby damper only ($d < 35\text{ km}$):** Reduce `home_advantage` (and/or AD `home`) by $\Delta_{\text{derby}} \in \{15, 25, 35\}$ Elo points when two clubs are in the same metro area ($d < 35\text{ km}$).

---

## Phase 3: Low-Footprint External Data & Priors (Polite Scraping)

### Rank 2: Transfermarkt `stichtag` Snapshots (Pre-Season March 15 + Sept 1 Summer Window Impulse)
**Estimated Gain:** $-0.0015$ to $-0.0025$ log loss in Rounds 1--10 and Rounds 18--30.  
**Target files:** `src/elitetracker/sources/transfermarkt.py`, `src/elitetracker/model/attack_defence.py`, `src/elitetracker/model/career.py`

#### The Problem
1. **Winter Window Blind Spot:** `AttackDefence._pull_toward_value()` and `career.relegated_values()` use `self.values.get(season - 1, {})` to avoid end-of-season hindsight leakage. However, `saison_id = season - 1` reflects squad values at the end of the *previous* season (November), missing the entire December--March winter rebuild and leaving newly promoted PostNord-ligaen clubs without a value entry ($8.5\%$ missing).
2. **August Summer Transfer Window Shock:** The Norwegian season spans April--November, so the major European summer window (July--August) occurs midway through the season (Rounds 16--20). Selling a star striker or buying three starters in August shifts club strength immediately, contributing to the $+0.0152$ late-season market gap.

#### Polite Data Collection (4 Requests per Season, Manual CLI Only)
* Transfermarkt supports historical cut-off dates (`stichtag`) on competition pages:
  `/eliteserien/startseite/wettbewerb/NO1/plus/?saison_id={season-1}&stichtag={YYYY}-03-15` (and `{YYYY}-09-01`).
* **Verify first on 1 page (`--dry-run`):** Fetch a single historical `stichtag` page (e.g. `2023-03-15`) and verify that it returns true pre-season squad values without hindsight.
* If Transfermarkt's `stichtag` endpoint requires no extra requests beyond 2 pages per season-date (spaced $5\text{--}8\text{ s}$ apart via `curl_cffi`), store `preseason` (`YYYY-03-15`) and `midseason` (`YYYY-09-01`) values in `data/market_values_snapshots.json`. Never call this from `refresh` or CI.

#### Experiments to Run (`experiments/improvements/rank2_transfer_windows.py`)
1. **Pre-Season Snapshot (`YYYY-03-15`):** Replace `values.get(season - 1)` in `_pull_toward_value()` and `relegated_values()` with the March 15 pre-season snapshot (which includes promoted 3rd-tier clubs and winter transfers, with zero in-season hindsight).
2. **Post-Summer Window Impulse (`YYYY-09-01`):** Before the first match on or after September 1 each season, compute each club's relative summer squad-value change:
   $$\Delta v_{\text{summer}, i} = \left(v_{i, \text{Sept 1}} - \bar{v}_{\text{Sept 1}}\right) - \left(v_{i, \text{March 15}} - \bar{v}_{\text{March 15}}\right)$$
   Test applying a mid-season rating adjustment $\beta_{\text{summer}} \cdot \Delta v_{\text{summer}, i}$ to `attack` and `defence` (sweeping $\beta_{\text{summer}} \in \{0.05, 0.10, 0.15, 0.20\}$) and/or partially resetting `_played[t]` so `early_boost` accelerates learning for clubs with $|\Delta v_{\text{summer}, i}| > 0.15$.

---

### Rank 4: Synthetic xG from Shot/Box/Big-Chance Volume for Pre-xG Matches
**Estimated Gain:** $-0.0020$ to $-0.0040$ log loss on pre-xG seasons (Eliteserien 2017--2019, OBOS 2018--2022).  
**Target files:** `src/elitetracker/sources/fotmob.py`, `src/elitetracker/sources/sofascore.py`, `src/elitetracker/model/attack_defence.py`

#### The Problem
Over $55\%$ of the historical replay (Eliteserien 2015--2019 and OBOS-ligaen 2015--2022) lacks xG, forcing `AttackDefence` to fall back to raw goals with a $3.3\times$ slower step (`k = 0.015` vs. `k_shots = 0.05`) and disabling `xg_alpha` in Elo. Yet `PROJECT_STATUS.md` notes that FotMob `matchDetails` carries **total shots, shots on target, shots inside the box, and big chances** for Eliteserien back to 2017, and Sofascore `/statistics` carries the same for OBOS-ligaen back to 2018.

#### Experiments to Run (`experiments/improvements/rank4_synthetic_xg.py`)
1. **Zero-Scrape Calibration Study First:** Using the 1,608 Eliteserien matches already in `data/raw/fotmob_match_extras.json` (2020--2026), aggregate per-match shot counts (`shots_in_box`, `shots_out_box`, `shots_on_target`, `big_chances`) and fit a strictly non-negative ridge/Poisson model to predict `(home_xg, away_xg)`.
2. Measure how well synthetic xG replaces true xG on 2020--2026 when true xG is masked out. If synthetic xG recovers $\ge 60\%$ of the log-loss gain that true xG achieves over goals-only updates:
3. **Polite One-Off Backfill CLI (`research synth-xg`):** Fetch FotMob `matchDetails` for Eliteserien 2017--2019 (720 matches, cached permanently to disk at $4\text{--}8\text{ s}$ jittered intervals) and evaluate the walk-forward improvement on `all16`.

---

### Rank 9: PostNord-ligaen (Tier 3) Promoted Club Priors & Dormant-Season Decay
**Estimated Gain:** $-0.0015$ to $-0.0030$ log loss on matches involving promoted/returning 3rd-tier clubs.  
**Target files:** `src/elitetracker/model/career.py`, `src/elitetracker/model/attack_defence.py`, `src/elitetracker/simulation/playoffs.py`

#### The Problem
1. **Frozen Dormant Ratings in `career.py`:** In `career.replay()` (`career.py` lines 113--135), offseason regression is only applied to clubs in `active` (clubs playing in Eliteserien or OBOS-ligaen that season):
   > *"Pulling per division preserves the inter-division gap and leaves dormant clubs untouched."*
   If a club is relegated from OBOS-ligaen to the 3rd tier at a rating of `1460`, spends 3 years in the 3rd tier, and gets promoted back to OBOS-ligaen, it re-enters at its frozen `1460` rating instead of the newcomer floor (`1330`), whereas a first-time promoted club starts at `1330`. The same happens in `AttackDefence` (`known = [t for t in teams if t in self.attack]`).
2. **Flat Newcomer Seed:** Promoted 3rd-tier champions that won their PostNord-ligaen group by 18 points and $+50$ goal difference (e.g., Fredrikstad 2021, Lyn 2024) are seeded identically to play-off winners that scraped up with $+8$ GD.

#### Experiments to Run (`experiments/improvements/rank9_newcomers.py`)
1. **Dormant-Season Decay (Zero Data):** Track `last_active_season[team_id]` in `career.replay()` and `AttackDefence._start_season()`. When a club returns to OBOS-ligaen after $m = \text{season} - \text{last\_active\_season} - 1 \ge 1$ seasons in the 3rd tier, pull its carried Elo and AD ratings toward the newcomer seed (`1330` Elo / `mean - newcomer` AD) by $\gamma_{\text{dormant}}^m$ (sweep $\gamma_{\text{dormant}} \in \{0.0, 0.3, 0.5, 0.7, 1.0\}$).
2. **Tier-3 Goal-Difference Prior:** Add a small static dictionary in `normalize/postnord.py` recording the prior-season 2. divisjon goal difference per game ($\text{GD}/26$) for the ~35 club-seasons promoted into OBOS-ligaen since 2015, and test shifting their initial Elo (`1330 + beta_t3 * gd_per_game`) and AD newcomer offset.

---

### Rank 10: Mid-Season Managerial Changes (`early_boost` Trigger)
**Estimated Gain:** $-0.0005$ to $-0.0012$ log loss on matches following a coaching change.  
**Target files:** `src/elitetracker/model/attack_defence.py`

#### The Problem
`AttackDefence._early(team_id)` gives a club a $1.5\times$ faster learning step (`1.0 + 0.5 * exp(-played / 3.0)`) in its first matches of a season so ratings adapt quickly to winter transfers. When a club changes head coach mid-season, its tactical profile (pressing height, tempo, attack/defence balance) shifts abruptly, but `_played[team_id]` is $\ge 12$, so `early_boost` is $0$ and the model adapts slowly.

#### Experiments to Run (`experiments/improvements/rank10_managers.py`)
1. Compile a static `data/manager_changes.json` of mid-season head-coach departures in Eliteserien and OBOS-ligaen (2015--2026, sourced once from Wikipedia / Transfermarkt `trainerwechsel` pages, ~2 pages per league).
2. In `AttackDefence.observe()`, when a match date crosses a recorded coaching change for `team_id`, reset `self._played[team_id] = 0` (and optionally regress `attack[team_id]` and `defence[team_id]` slightly toward the division mean by $\rho_{\text{coach}} \in \{0.92, 0.96, 1.00\}$).
3. Test OOS on `all16` and specifically on the 10 matches following each coaching change.

---

### Rank 11: Match-Kickoff Wind & Heavy Precipitation (MET Norway Open API)
**Estimated Gain:** $-0.0003$ to $-0.0008$ log loss on scorelines / total goals (`over/under 2.5`) and draw odds.  
**Target files:** `src/elitetracker/sources/met.py` (new), `src/elitetracker/model/attack_defence.py`

#### The Problem
Coastal and northern Norwegian grounds (Bodø, Tromsø, Haugesund, Molde, Ålesund, Kristiansund, Sogndal, Hødd) experience extreme wind ($>12\text{ m/s}$) and sleet/rain in spring and late autumn, systematically depressing total goals (`cfg.base`) and elevating low-scoring draws (`0-0`, `1-1`).

#### Zero-Risk Official Open Data
* **MET Norway** (`frost.met.no` for historical weather observations and `api.met.no/weatherapi/locationforecast/2.0` for live forecasts) is an official, free Norwegian government API with zero Cloudflare blocking (requires only a descriptive `User-Agent: elitetracker.no`).
* Using the stadium coordinates from Rank 8, pull historical kickoff wind speed ($w$ in $\text{m/s}$) and 1-hour precipitation ($p$ in $\text{mm}$) into `data/weather.json` once.
* In `AttackDefence.rates()`, test subtracting a weather damper from `cfg.base` when wind exceeds $w_0 = 8\text{ m/s}$:
  $$\text{base}_{\text{eff}} = \text{base} - \beta_{\text{wind}} \max(0, w - 8.0) - \beta_{\text{rain}} \min(p, 5.0)$$
* Evaluate on both outcome log loss and exact-scoreline / over-under 2.5 log loss.

---

## Phase 4: Execution Checklist for Claude

When executing this file, work through the phases in order:

- [ ] **Step 1 (Baseline & Bug Audit):** Run `pytest` and verify `experiments/improvements/harness.py` reproduces `elo-v15.0` to $2 \times 10^{-16}$. Test and fix the three bugs in **Item 1.0** (`attack_defence.py` finishing centering, stale finishing decay, and `rates_against_average` `start_season` call). Record their exact impact.
- [ ] **Step 2 (Scraper Hygiene):** Implement `sources/_http.py` with `curl_cffi` session support and schedule-gated xG fetching in `refresh.py` (**Item 1.1**).
- [ ] **Step 3 (Zero-Scrape Model Sweeps):** Implement standalone experiment scripts in `experiments/improvements/` for:
  - [ ] **Rank 1:** Unclamping `xg_margin` in `elo.py` and variance-stabilized (`Pearson`) steps in `attack_defence.py`.
  - [ ] **Rank 3:** Game-state-adjusted xG from `data/raw/fotmob_match_extras.json`.
  - [ ] **Rank 5:** Open-play vs. set-piece xG weighting from `data/raw/fotmob_match_extras.json`.
  - [ ] **Rank 6:** Late-season table-stakes pressure (`played >= 24`).
  - [ ] **Rank 8:** Pairwise club travel distance and derby home-advantage compression.
  - [ ] **Rank 9 (Part 1):** Dormant-season decay for clubs returning from the 3rd tier.
- [ ] **Step 4 (Low-Footprint Data Sweeps):** Where polite scraping is permitted and passes `--dry-run` without 403/429:
  - [ ] **Rank 2:** Test Transfermarkt `stichtag` pre-season (`YYYY-03-15`) and post-summer (`YYYY-09-01`) snapshots.
  - [ ] **Rank 4:** Test synthetic xG from shot/box/big-chance counts on `fotmob_match_extras.json` first, then backfill 2017--2019 if the masked test succeeds.
  - [ ] **Rank 9 (Part 2), Rank 10 & Rank 11:** Test Tier-3 GD priors, manager change resets, and MET Norway kickoff weather.
- [ ] **Step 5 (Marginal Bundle & Season Simulation Check):**
  - Combine all items that cleared the OOS ship rule into one candidate bundle.
  - Test removing each item one by one from the bundle to verify none became redundant.
  - Run `experiments/improvements/season_check.py` to check whether `STRENGTH_SD` ($0.20$) needs adjustment on the new ratings.
  - Run `python -m elitetracker.backtest_cli --market --score-from 2016` to record the new gap to Pinnacle closing odds (proportional, power, and Shin de-vig).
- [ ] **Step 6 (Ship & Document):**
  - Port any prediction-time changes needed by Compare Clubs into `public/app.js` and `pipeline.py` (`report.model`).
  - Bump `MODEL_VERSION = "elo-v16.0"` in `src/elitetracker/model/elo.py` (once for the entire release).
  - Run `pytest` and `node --test tests/frontend.test.js`.
  - Append a complete research section to `PROJECT_STATUS.md` with tables for both shipped and rejected items, and update `README.md` if Model Card parameters changed.