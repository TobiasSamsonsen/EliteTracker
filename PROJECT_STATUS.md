# Project Status

Norwegian top-two-division prediction and history, 2015–2026. ELO ratings, Monte Carlo
season simulation, and a local website — all standard library, no runtime dependencies.

```bash
.venv/bin/python -m elitetracker.api.server --port 8000   # then open http://127.0.0.1:8000
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

### Model (elo-v3)
- `model/elo.py` — `expected_score` / `actual_score` / `update` kept separate.
  K-factor 20 and home advantage 75, both calibrated against real results.
- `model/career.py` — **one continuous rating replay.** Seeded once from the 2014 final
  tables, then every played match from 2015 to now applied in kickoff order. Ratings
  carry across seasons and across divisions; nothing is re-seeded each year.
- `model/probabilities.py` — three-way odds where `P(win) + 0.5·P(draw)` reproduces the
  rating-implied expectation exactly.
- `simulation/season.py` — seeded Monte Carlo, 10,000 runs, ~10M match-samples/second.
- `model/backtest.py` — walk-forward harness. Every match is predicted from prior
  information only, then revealed. This is what elo-v3 was fitted with.
- `simulation/history.py` — the projection re-run at ~20 points **by date, not by round.**

### Site
- `api/server.py` — `http.server`. The rating replay runs once at start-up; individual
  season reports are built on first request and cached, so start-up stays quick.
  Routes: `/`, `/api/health`, `/api/seasons`, `/api/careers`, `/api/report`,
  `/api/report/<league>[/<season>]`.
- `web/` — no framework, no build step. Light/dark themes, keyboard focus, reduced
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
  - **Next up** — three-way odds per fixture, with each side's rating beside its name.
  - **Model card** stating the known limits.

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

**Settled on 200,000** for the live projection. Its worst cell is 0.23pp, about a seventh
of the model's own error; past that, each halving of sampling error costs four times the
wait and moves nothing anyone can see. 10,000,000 buys precision two orders of magnitude
finer than the model can justify, for fifty times the wait.

Also set from the same curve: **10,000** per history snapshot (a trend line read off a
chart, ~20 per league) and **25,000** for rewound views, which are dragged through and
cached per date. Start-up is 7.0s; a rewound day builds in 0.95s.

The simulation loop was rewritten to work on integer indices with a single packed sort
key, which is **1.53× faster** (91k → 139k runs/second) and bit-identical — verified
against the previous implementation on both divisions. That is 1.5× the accuracy for the
same wait.

One thing the numbers expose: the table prints title and relegation chances to one decimal
(`53.9%`), but at 200,000 runs the sampling error alone is ±0.23pp, and the model's
calibration error is ±1.54pp. **That decimal is noise in both directions.** Rounding those
two columns to whole percent would be more honest than raising the simulation count — no
achievable N makes a tenth of a percent meaningful here.

## ❗ Known limits (also stated on the site)
- Ratings are held fixed for the rest of the season inside a simulation.
- Simulated matches produce points but not scorelines, so ties break on goal difference
  as it stands today.
- No inter-season regression toward the mean; a club carries its full rating into the
  next year.
- Clubs promoted from the third tier start at the ladder floor.

## 🔧 Next steps
- [x] One-command refresh after each matchday: `python -m elitetracker.refresh` (fetches,
      normalizes, validates, writes; `--no-force` to reuse a fresh cache entry).
- [ ] Refresh on a schedule, e.g. a Windows Task Scheduler job pointing at the refresh command.
- [x] `elo-v3` — shipped. See below.
- [ ] Ordered-logit probability mapping. Worth a further ~0.0013 log loss, but it breaks
      the `expected = P(win) + 0.5·P(draw)` identity the rest of the model rests on.
- [ ] Re-fit the draw model periodically as seasons accumulate.
- [ ] Backtest elo-v2 against the seasons now held, and tune K and home advantage on it.

## Commands

```bash
# fetch (cached; --force to refresh)
.venv/bin/python -m elitetracker.sources.fotmob {matches|standings} {eliteserien|obosligaen} <season>

# one-command refresh of the current season's results
.venv/bin/python -m elitetracker.refresh [--season <year>] [--no-force]

# normalize / validate
.venv/bin/python -m elitetracker.normalize.fotmob {matches|standings} <raw.json> <out.json>
.venv/bin/python -m elitetracker.validation.matches <normalized.json> [--teams 16]
.venv/bin/python -m elitetracker.validation.standings <normalized.json> [--teams 16]

# model + site
.venv/bin/python -m elitetracker.pipeline [--season 2019] [--output data/reports.json]
.venv/bin/python -m elitetracker.api.server --port 8000
.venv/bin/python -m pytest
```

305 tests, all passing.
