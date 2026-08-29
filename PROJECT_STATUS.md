# Project Status

Norwegian top-two-division prediction and history, 2015–2026. ELO ratings, Monte Carlo
season simulation, and a website on Firebase Hosting — all standard library, no runtime
dependencies. The same frontend runs two ways: against the live Python API server, or as
pure static files on Firebase Hosting.

```bat
REM one-time setup (Python 3.12)
python -m venv .venv
.venv\Scripts\pip install -e .

REM local, live API server  ->  http://127.0.0.1:8000
.venv\Scripts\python.exe -m elitetracker.api.server --port 8000

REM build the static site and preview it  ->  http://127.0.0.1:8000
.venv\Scripts\python.exe -m elitetracker.build_site
.venv\Scripts\python.exe -m http.server --directory public 8000

REM fast path: rebuild only the current season (what CI runs between model changes)
.venv\Scripts\python.exe -m elitetracker.build_site --only-season 2026

REM pull the latest results for the current season
.venv\Scripts\python.exe -m elitetracker.refresh

REM run the test suite
.venv\Scripts\python.exe -m pytest
```

## ✅ Done

### Data (Phases 1–3)
- `sources/fotmob.py` — parameterized by league and season, no API key. `sources/cache.py`
  is a read-through disk cache that validates payloads **on read as well as on write**,
  so a stale or foreign-schema entry can never be served.
- `refresh.py` — **one command to pull finished matches into the model.** Fetches both
  divisions, normalizes, validates and rewrites the match files atomically
  (`python -m elitetracker.refresh`). A bad fetch or a payload that fails validation
  leaves the previous normalized data untouched.
- `normalize/` — canonical `Match` and `Standing` schemas with per-source adapters
  (`fotmob`, `parse_bot`), so dedupe, ordering and validation are written once.
- `validation/` — errors vs. warnings, non-zero exit on error.
- **24 season-league match files (2015–2026) plus 2014 seed tables, all validating clean.**

### Model (elo-v5)
- `model/elo.py` — `expected_score` / `actual_score` / `update` kept separate. K-factor 20
  (flat across 18-24, so left at 20); **home advantage refit 75 → 60** by full-season
  walk-forward backtest (the 0.61 marginal rate implies ~75, but prediction prefers 60);
  **cross-season regression 0.95** — each close season pulls every rating 5% toward the
  pool mean, so a freak year does not carry. Both fitted by backtest, not eyeballed.
- `model/career.py` — **one continuous rating replay.** Seeded once from the 2014 final
  tables, then every played match from 2015 to now applied in kickoff order. Ratings
  carry across seasons and across divisions; at each offseason they mean-revert by the
  configured regression factor.
- `model/probabilities.py` — three-way odds where `P(win) + 0.5·P(draw)` reproduces the
  rating-implied expectation exactly.
- `model/scorelines.py` — scorelines sampled from the empirical result distribution,
  **conditioned on outcome *and* the pre-match rating gap** (5 equal-count gap bins; empty
  cells fall back to the outcome's global distribution). `build_scoreline_model.py` replays
  the corpus with the production config to label each match with its true gap and emits
  `data/scoreline_model.json`. So goal difference moves inside the simulation, a heavy
  favourite draws bigger scorelines, and ties resolve on simulated GD.
- `simulation/season.py` — seeded Monte Carlo, 50,000 runs, drawing a scoreline per
  fixture from `model/scorelines.py`.
- `model/backtest.py` — walk-forward harness. Every match is predicted from prior
  information only, then revealed. This is what elo-v3 was fitted with.
- `simulation/history.py` — the projection re-run at ~20 points **by date, not by round.**

### Site
- `api/server.py` — `http.server`. The rating replay runs once at start-up; individual
  season reports are built on first request and cached, so start-up stays quick.
  Routes: `/`, `/api/health`, `/api/seasons`, `/api/careers`, `/api/report`,
  `/api/report/<league>[/<season>]`.
- `public/` — no framework, no build step. Light/dark themes, keyboard focus, reduced
  motion, mobile layout. `?league=`, `?season=`, `?team=`, `?career=` make any view linkable.
  - **Rewind the season** — a slider over every matchday played. Moving it rebuilds the
    *whole page* from only the results known that evening, via `?asof=` on the API.
  - **The finish grid** — 16×16 heat matrix of finishing-position probability, rows
    ordered by expected finish so the mass sits on the diagonal at any point in the season.
  - **Table** — standings, rating, expected points, title and relegation odds.
    Every column sorts on click (`aria-sort`, keyboard-operable); the good and bad
    probability columns carry blue and red bars. Picking a club opens its rating history.
  - **Season shape** — per-club stacked area of position probability over the season.
  - **The ladder** — both divisions on one line, sharing the rating scale.
  - **Career modal** — a club's rating across every season, plus a season-by-season table.
   - **Next up** — three-way odds per fixture, with each side's rating beside its name and
     the most likely scorelines beneath the odds (e.g. `2-1 28% · 1-1 19%`), drawn from the
     same gap-conditioned scoreline model that feeds the Monte Carlo.
  - **Model card** stating the known limits.
- **Static build for Firebase Hosting** — `build_site.py` prebuilds every season's live
  and rewound reports plus careers as plain JSON under `public/data/`, so the same frontend
  works on a static host with no Python runtime. The browser probes `/api/health` once; on
  a static host that answers 404 and everything falls back to `/data/*.json`. Reports use
  the same configuration as the API's `?asof=` rewind, so static and live numbers match.
  The ~1,100 rewound dates are farmed across worker processes. A `--only-season
  <year>` flag rebuilds a single season, which the CI uses to refresh the current
  season without redoing every past one (see the deploy cache below).
- **Deployed at `elitetrackerno.web.app`.** A GitHub Action installs the package, runs
  `build_site`, and deploys `public/` on every push to `main` — no manual deploy needed.
  HTML and `app.js` are served `no-cache` and the script tag is versioned, so a new deploy
  is picked up without a hard refresh.

### Colour
- **Sequential ramp** for all quantitative colour (grid probability, season shape).
  Multi-hue by necessity — sixteen stacked bands are not tellable apart in one hue — so
  it travels pale green → teal → blue → deep navy, resampled at uniform OKLab lightness.
  Lightness stays monotone and the worst adjacent pair is ΔE 10.5 light / 11.3 dark.
- Qualification markers and the division colours on the ladder are separate, labelled
  categorical marks, not part of the quantitative encoding.
- **Table meters** reuse the qualification-marker colours — blue for the good column, red
  for the bad — so a row's leading stripe and its "Win it" bar mean the same thing in the
  same colour. Blue against red also holds CVD ΔE 21.6 light / 19.2 dark, well clear of
  green against red (12.4). Bars are drawn solid: diluted into washes any such pair
  collapses to ΔE ~3 and the two columns become indistinguishable.

## ⚠️ Decisions worth knowing

**parse.bot is gone.** The original scraper 404s for every tournament with a valid key.
fotmob replaced it; on Eliteserien 2026 the two sources agreed on every played result and
fixture date before the switch. `API_KEY` / `.env` are unused.

**elo-v2 changes predictions.** Ratings used to be re-seeded from the previous season's
final table. They are now one continuous replay from 2014, which is what makes a rating
history meaningful. It also changes who the model favours: with 11 years of evidence
Bodø/Glimt (1850) lead Eliteserien 2026 ahead of Viking (1830), where the old
single-season seeding had Viking on top.

**Ratings are not capped at 1700.** The 1700–1300 range in AGENTS.md is honoured by the
*initial* seeding; a free-running ELO then moves beyond it. Bodø/Glimt's climb from 1508
in 2015 to 1850 today is the model working, not drifting.

**Season shape is sampled by date, not by round.** Rounds are not chronological — the
furthest round reached jumps from 4 on 11 April 2026 to 15 on 15 April — so a round axis
would show results before they happened.

**Abandoned fixtures are dropped.** Eliteserien 2024 lists both the abandoned Rosenborg v
Lillestrøm of 21 July and its replay on 21 August, so the raw feed has 241 rows for a
240-match season.

**Display code is excluded from the rebuild cache.** `simulation_signature` hashes every
source module that influences simulation output, but the `elitetracker/display` package
(fixture odds + predicted scorelines) only turns already-computed ratings into the "Next up"
view and never feeds the Monte Carlo. It is skipped, so editing `display` — chips, copy,
scoreline count — leaves the cache key unchanged and does not trigger a past-season rebuild.
A model or simulation-setting change still flips the key and forces a full rebuild. The
rewound grid was thinned to 10,000 runs for the same reason (see "How many simulations a
season needs"): it is a display/trend view, not the live table.

## 🔬 elo-v3: what the backtest found

Fitted with `model/backtest.py` on 2019-2026 (3,623 scored matches, walk-forward, no
leakage). Baseline elo-v2 scored 1.01754 log loss against 1.06015 for a constant
base-rate predictor — a real but thin edge — while its calibration error was 0.0396
against the constant model's 0.0043. That pointed at the probability mapping, not the
ratings, and that is where the whole gain turned out to be.

**Shipped: the draw model, refitted.** `draw_base` 0.22 → 0.26, `draw_scale` 250 → 375.

| | log loss | Brier | hit | calibration |
|---|---|---|---|---|
| elo-v2 | 1.01754 | 0.60443 | 51.97% | 0.0396 |
| elo-v3 | **1.00173** | 0.59819 | 51.97% | **0.0154** |

−0.0158 log loss, paired t = −4.98, and it holds in both halves (−0.0202 on 2019-2022,
−0.0109 on 2023-2026). The hit rate does not move: every bit of the gain is calibration,
none is better discrimination. **Ratings are byte-identical to elo-v2** — this is a
probability-only version bump, so stored ratings and career histories are untouched.

The old constants came from eyeballing 255 matches of a single part-season, which made the
draw model far too narrow.

**Tested and rejected — each of these looked good until it was measured properly:**

- **Margin of victory** (538-style damped log, plain log, √, linear caps, over a 120-cell
  K grid). Every form was *worse* than the baseline at its own best K. Norwegian margins
  are mostly noise: of 5,543 matches, 1,323 were draws and 2,060 were one-goal games, with
  only 159 at 5+ goals.
- **Goals as repeated mini-contests.** Tested literally, 84 settings, including fixes for
  the 0-0 problem (a goalless draw otherwise produces *no update at all*) and both
  sequential and simultaneous variants. Best solo result −0.0036 at t = −1.56, and its own
  control showed ~87% of that was recalibration rather than the goal information. Stacked
  on the final config it is **+0.0018 worse**. Algebraically it reduces to a goal-difference
  ELO, and 8.3% of its updates move the match *winner* down.
- **Home advantage 75 → 50** and **inter-season regression to the mean (0.15)**. Both real
  against elo-v2 in isolation, but ~90% redundant with the draw fix: marginal t = −0.46 and
  −0.16 once the mapping is refitted, and the sign flips between halves.
- **The autocorrelation damper** was the clearest trap: worth −0.0030 alone, but
  **+0.0031 worse** inside the stack (t = +3.40). It is a duplicate of the calibration fix
  and overshoots into under-confidence.
- Also rejected: dynamic K, EWMA form, per-league / per-season / per-team home advantage
  (including a COVID-seasons term — even an oracle version hurt).

The lesson worth keeping: four of these looked like wins against elo-v2 alone, and three
of them were the same calibration fix in disguise. Anything proposed next has to be
measured *marginally*, with the mapping refitted on both sides.

## 🎲 How many simulations a season needs

Measured, not guessed. Monte Carlo error falls as 1/√N, so the question is where it stops
mattering — and that is set by the model's own accuracy, not by the arithmetic. elo-v3's
calibration error is **1.54 percentage points**; sampling error well under a fifth of that
is already invisible.

Worst single grid cell, against a 4,000,000-run reference (Eliteserien 2026, 111 fixtures
remaining, six seeds per row):

| simulations | RMS error | worst cell | title % error | time per league |
|---|---|---|---|---|
| 10,000 | 0.209 pp | 1.31 pp | 0.54 pp | 0.07 s |
| 50,000 | 0.096 pp | 0.50 pp | 0.40 pp | 0.37 s |
| **200,000** | **0.045 pp** | **0.23 pp** | **0.17 pp** | **1.43 s** |
| 1,000,000 | 0.022 pp | 0.11 pp | 0.07 pp | 7.2 s |
| 10,000,000 | ~0.007 pp | ~0.04 pp | ~0.02 pp | ~72 s |

**Settled on 50,000** for the live projection. Its worst cell is 0.50pp — a third of the
model's own error, and half of one displayed digit now that the table rounds to whole
percent. Past that, each halving of sampling error costs four times the wait and buys
precision beneath both the display and the model. 10,000,000 would be two orders of
magnitude finer than the model can justify, for two hundred times the wait.

Also set from the same curve: **10,000** per history snapshot (a trend line read off a
chart, ~20 per league). Rewound views cut both the history to 2,500 × 8 *and* the grid to
10,000 (see the note under "Monte Carlo error" above) — otherwise a rewound day costs six
seconds instead of one and a half. They are cached per date. Start-up is 5.1s; a rewound
day builds in ~1.8s at the old 50,000 grid, and faster now that the rewound grid is 10,000.

The simulation loop works on integer indices with a single packed sort key. Drawing a
scoreline per match (see `model/scorelines.py`) adds one RNG draw and a goal-difference
update per fixture, so throughput is now ~28k runs/second — 50,000 runs still finishes a
league in ~1.8s. Against a 1,000,000-run reference the worst grid cell at 50,000 is
**0.45pp**, a third of the model's 1.54pp calibration error, so the count is unchanged.

The table's title and relegation columns print **whole percent**. Sampling error at 50,000
is ±0.50pp and the model's calibration error is ±1.54pp, so a tenth of a percent there was
noise dressed as precision, and no achievable simulation count would have fixed it. The
em-dash threshold follows the precision, so a value that would round to a bare `0%` shows
as nothing instead.

Rewound views (the `?asof=` slider and the static rewind reports) use a **10,000-run** grid
plus a 2,500 x 8 history, not the live 50,000. At 10,000 the worst grid cell is ~1.31pp --
still under the model's 1.54pp calibration error -- so dragging back loses no visible
fidelity, while the ~2,266 rewound reports build roughly 5x faster. The live view keeps
50,000 for full precision. (See `build_site.REWOUND_SIM` and `api.server.ReportStore._configs`.)

The proposal: rate a club lower for a match when its best players are injured, suspended
or sold. Investigated properly — a full lineup corpus was fetched (**5,542 of 5,544
matches, both divisions, 2015–2026, 100% coverage of both starting elevens**) and three
formulations were backtested. All three failed, and a ceiling calculation says no version
of this could have worked on this data.

**The ceiling is the whole answer.** A squad-strength term shifts a club's effective
rating by some amount each match; the spread of that shift caps what it can buy. Injecting
a *random* shift of the same spread measures the cap directly, because a perfectly
informative adjustment gains at most what a random one of the same size loses:

| shift spread | ceiling on the gain | what it corresponds to |
|---|---|---|
| 5.5 Elo | 0.00018 | inferred player ability (ridge-APM) |
| 8.6 Elo | 0.00055 | the injury list — the deployable version |
| 13.8 Elo | 0.00161 | value of the starting XI, squad wealth removed |
| 17.0 Elo | 0.00252 | value of the XI, best case and leaky |
| — | **0.00635** | **minimum detectable effect (t = 2, n = 3,624)** |

Knowing the exact starting eleven of both sides, perfectly, is worth at most **0.0025**
log loss — about **40% of what it would take to distinguish from noise**, and a sixth of
what the elo-v3 draw refit was worth. The deployable version, knowing only who is unfit,
tops out at **0.00055**: 9% of the detection floor. The reason is that the scenario is
rare — 67% of team-sides have nobody from their top five missing, and only 1.4% have three
or more out.

**Measured results, all three negative:**

- **Inferred player ability** (ridge-regularised adjusted plus-minus over the corpus, no
  external data, no anachronism): honest walk-forward **+0.0050 worse**, in both halves,
  hit rate 0.5197 → 0.5124.
- **Market value of the XI**: a real, correctly-signed effect (t = +3.15) but only 17 Elo
  of spread on 22.5% coverage, best Δ = −0.0014 with a confidence interval spanning zero,
  and the sign flips between halves. Leaky by construction: fotmob serves one present-day
  value per player, so the anachronism premium can never be measured away.
- **Injury list**: holdout **+0.0028 worse**, and the feed is provably back-stamped —
  41.9% of `unavailable` entries name a player whose first appearance for that club comes
  a median **545 days later**. It is reconstructed after the fact, not as it stood.

**It is also unshippable regardless.** Upcoming fixtures return `lineupType: "unavailable"`
with an empty `starters` list — the eleven does not exist until about an hour before
kickoff. The site projects ~111 remaining fixtures, so the adjustment would be zero for
every one of them.

Sample size needed to detect the best (leaky) effect at t = 3: **n ≈ 12,950**. The entire
replayable history of both Norwegian divisions since 2015 is 5,542 matches.

By-product worth remembering: `https://www.fotmob.com/api/data/matchDetails?matchId=<id>`
returns the same content as the match page at 313 kB against 1.19 MB — roughly a quarter
the bytes, and far less gzipped. Nothing currently fetches match detail, but that is the
route if anything ever does.

## ❗ Known limits (also stated on the site)
- Ratings are held fixed for the rest of the season inside a simulation.
- Simulated matches draw a scoreline from the empirical distribution of real results
  (`model/scorelines.py`), conditioned on the win/draw/loss outcome *and* the pre-match
  rating gap, so a heavy favourite draws bigger scorelines than a slight one (real margins
  grow with the gap) and goal difference moves within a simulation. Tied finishes resolve on
  simulated goal difference, not today's. The rating-implied probabilities remain the sole
  driver of who wins.
- Clubs promoted from the third tier start at the ladder floor.

## 🔧 Next steps
- [x] One-command refresh after each matchday: `python -m elitetracker.refresh` (fetches,
      normalizes, validates, writes; `--no-force` to reuse a fresh cache entry).
- [ ] Refresh on a schedule, e.g. a Windows Task Scheduler job pointing at the refresh command.
- [x] Static build + CI deploy: `build_site` feeds Firebase Hosting, triggered by every
      push to `main` (`.github/workflows/firebase-hosting-merge.yml`).
- [x] `elo-v5` — shipped. See below. Home advantage refit 75→60 and cross-season regression
      (0.95) by walk-forward backtest (`backtest_cli`); scoreline margins now conditioned on
      the rating gap (`model/scorelines.py`, generated by `build_scoreline_model.py`).
- [x] Predicted scorelines on upcoming fixtures. For each unplayed match, the top few likely
       scorelines with their probabilities (e.g. 2-1 28%, 1-1 19%, 2-0 14%) are shown beneath
       the three-way odds in "Next up". The prediction draws from `model/scorelines.py`
       conditioned on the win/draw/loss outcome and the pre-match rating gap — the same model
       that feeds the Monte Carlo — so it reads straight off the existing three-way odds.
       Computed in the `elitetracker/display` package, which is excluded from
       `simulation_signature` (see decisions), so tweaking the display never rebuilds past
       seasons.
- [ ] Ordered-logit probability mapping. Worth a further ~0.0013 log loss, but it breaks
      the `expected = P(win) + 0.5·P(draw)` identity the rest of the model rests on.
- [ ] Re-fit the draw model periodically as seasons accumulate.
- [ ] Re-run `backtest_cli` after each new season to keep K / home advantage / regression
      fitted; regenerate `data/scoreline_model.json` with `build_scoreline_model.py`.
- [ ] Cross-season mean reversion is over the *combined* two-division pool, not per
      division (`model/career.py:101`, `model/backtest.py:171`). Teams never meet
      cross-division in-league, so within a season each division is zero-sum on its own;
      the global offseason pull therefore transfers rating mass from Eliteserien toward
      OBOS every close season and silently compresses the inter-division gap, instead of
      preserving the one-ladder gap the 2014 seed set. Per-division regression (each
      division toward its own mean, over teams *active* that season — the current mean also
      dilutes in dormant clubs never pruned from `ratings`) would conserve each division's
      sum and keep the gap. The regression step itself is total-conserving (Σ new = Σ old),
      so no points are created/destroyed; pool drift only comes from tier-3 entrants and
      relegated exits. If adopted, `season_regression` must be re-fit by walk-forward
      backtest and log-loss/calibration re-checked, since 0.95 was fit on the global mean.
- [ ] Fit the *starting* ratings by walk-forward backtest instead of taking them from the
      2014 final tables. The seed is the only place finishing position enters the model, so
      optimizing it is the open lever for early-season accuracy. Keep the position→rating
      ladder but fit it to minimize `backtest.walk_forward` log loss over 2015+, scoring
      from the first post-burn-in season. Only **two** parameters are identifiable: the
      ladder *spread* (`best_rating − worst_rating`, i.e. how far apart the seed ranks teams)
      and the `division_offset`. The absolute mean is **not** a free parameter — every
      prediction depends only on rating *differences* (see `model/elo.py`: `expected_score`,
      `updated_pair`, `draw_probability` are all difference-only), so adding a constant to
      every rating leaves all probabilities identical. 1500 is just the inherited convention
      (midpoint of the AGENTS.md 1700–1300 range), equal to 1000 or 1200 for accuracy; fix
      it for readability and only fit the spread + offset. Stdlib-only grid search over
      spread × offset; no new deps. Caveat: with `season_regression = 0.95` the seed's
      influence decays each close season, so the gain shows up mainly in the early seasons —
      measure it *marginally* (elo-v3 discipline: refit the draw mapping on both sides) and
      don't expect much movement in 2026's carried ratings.

## Commands

```bat
REM fetch raw data from fotmob (cached; --force to refresh)
.venv\Scripts\python.exe -m elitetracker.sources.fotmob {matches|standings} {eliteserien|obosligaen} <season>

REM one-command refresh of the current season's results
.venv\Scripts\python.exe -m elitetracker.refresh [--season <year>] [--no-force]

REM normalize / validate
.venv\Scripts\python.exe -m elitetracker.normalize.fotmob {matches|standings} <raw.json> <out.json>
.venv\Scripts\python.exe -m elitetracker.validation.matches <normalized.json> [--teams 16]
.venv\Scripts\python.exe -m elitetracker.validation.standings <normalized.json> [--teams 16]

REM model + site
.venv\Scripts\python.exe -m elitetracker.pipeline [--season 2019] [--output data\reports.json]
.venv\Scripts\python.exe -m elitetracker.api.server --port 8000
.venv\Scripts\python.exe -m elitetracker.build_site [--out public\data] [--jobs <n>] [--only-season <year>]
.venv\Scripts\python.exe -m pytest

REM show the deploy cache key (changes -> past seasons are rebuilt)
.venv\Scripts\python.exe -c "from elitetracker.pipeline import simulation_signature; print(simulation_signature())"
```

### Updating the stats

Run this whenever a round has finished — it pulls both divisions from fotmob, normalizes,
validates, and rewrites the 2026 (or `--season`) match files. Nothing else is needed for
the numbers to update.

```bat
.venv\Scripts\python.exe -m elitetracker.refresh
```

### Deploying to the website

1. Commit the refreshed `data/normalized/` files and push to `main`.
2. The GitHub Action (`firebase-hosting-merge.yml`) builds the site and deploys `public/`
   to Firebase Hosting live. Past-season reports are cached between runs and only rebuilt
   when the model code, simulation settings, scoreline model, or a past season's data
   change (tracked by `pipeline.simulation_signature`). An ordinary results refresh or a
   frontend fix rebuilds only the current season (or skips the build entirely), so routine
   deploys take minutes, not the full ~20-minute rebuild. Pass `workflow_dispatch` input
   `full_rebuild` to force a complete rebuild.
3. The site updates within a couple of minutes at `https://elitetrackerno.web.app`.

Worked example:

```bash
git add data/normalized
git commit -m "Refresh 2026 matchday results"
git push
```

The prebuilt `public/data/` is gitignored — the Action rebuilds it on the server, so the
committed input is just the normalized fixture files. To test the static site locally first:

```bat
.venv\Scripts\python.exe -m elitetracker.build_site
.venv\Scripts\python.exe -m http.server --directory public
```

347 tests, all passing.
