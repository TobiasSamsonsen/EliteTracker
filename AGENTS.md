# AGENTS.md

## Project Overview

A Python-based website for predicting and ranking teams in the top two divisions of
Norwegian men's football: Eliteserien and OBOS-ligaen. Uses an ELO rating system
(elo-v7) to estimate team strength, match probabilities and season outcomes. The site
runs two ways: against a live Python API server, or as pure static files on Firebase
Hosting. Data comes from FotMob (no API key needed). `PROJECT_STATUS.md` holds the
decision log: why the constants are what they are and what was tried and rejected.

## Core Constraints

- All seasons 2015–2026 are in scope (historical data is already built)
- The model version is **elo-v7**; changes to predictions must bump `MODEL_VERSION`
- No runtime dependencies — stdlib only (`tzdata` on Windows is the one exception)
- No advanced prediction models: squad strength, ordered-logit, Dixon-Coles, pi-ratings,
  an Elo/DC blend, xG-informed Elo and a market-value prior were all measured and
  rejected (PROJECT_STATUS.md)
- Ponytail mode is active — shortest diff wins, YAGNI enforced

## Architectural Boundaries

```text
FotMob page -> data/raw/ archive -> Normalize/Validate -> data/normalized/ ->
Elo replay + attack/defence ratings (on xG where fotmob has it) -> blended odds, Poisson scorelines -> Monte Carlo -> JSON reports -> Frontend
```

## Layout

### Data
- `sources/fotmob.py` — downloads a league season's fixture list from the page's
  `__NEXT_DATA__`, validates the count, archives it under `data/raw/`, returns it
- `refresh.py` — one command pulls both divisions, normalizes, validates, writes atomically,
  then tops up `data/xg.json` for newly played Eliteserien matches (non-fatal). A guard
  skips a league with no unplayed match whose kickoff has passed; `--force` overrides
- `normalize/` — canonical `Match` schema (`matches.py`) and the fotmob adapter; `Standing`
  is only read, from the 2014 seed tables
- `validation/matches.py` — errors vs warnings; `refresh` refuses to write on an error
- 24 season-league match files (2015–2026) plus 2014 seed tables; `data/odds_closing.json`,
  `data/market_values.json` (Transfermarkt squad totals) is a research input; `data/xg.json`
  (fotmob xG and xG on target per Eliteserien match, 2020→) feeds the shipped model

### Model (elo-v7)
- `model/elo.py` — `expected_score` / `actual_score` / `updated_pair`. K=20, home
  advantage 60, cross-season regression 0.88 per division
- `model/career.py` — `replay()` is the single season-by-season rating loop (per-division
  regression, ladder floor for unseeded clubs, chronological updates). `build_careers`,
  the backtest and the scoreline corpus all read off it
- `model/probabilities.py` — three-way odds where `P(win) + 0.5·P(draw)` reproduces the
  rating-implied expectation exactly
- `model/attack_defence.py` — two ratings per club on the log-goals scale, updated
  online by goals above/below expectation; where fotmob has xG (Eliteserien 2020→,
  `data/xg.json`) the observation is 0.75 xG + 0.25 goals and the step is 0.05 instead
  of 0.015. Each fixture gets a Poisson scoreline grid (Dixon-Coles corrected); the
  shipped outcome odds are `blend_outcomes`: a 50/50 geometric blend of the Elo odds
  and the grid's own, and scorelines are the grid conditioned on those odds. Feeds
  fixtures, Compare Clubs (ported to the browser: `blendOdds`, `scoreGrid`) and the
  Monte Carlo. `pipeline.prior_attack_defence` caches the state at the end of each
  previous season; a report copies it and replays its own season
- `model/backtest.py` — walk-forward scorecard with per-match losses; `paired(a, b)` is
  the test for "model a beats model b" (|t| >= 2). `backtest_cli.py` sweeps K / home
  advantage / regression, `model/fit_params.py` jointly fits regression + seed ladder
- `model/benchmark.py` + `research.py` — the bookmaker closing line (football-data.co.uk,
  joined to every Eliteserien match in `data/odds_closing.json`) as the yardstick:
  `python -m elitetracker.research run` prints Elo, the shipped blend and the market.
  `research xg` (re)scrapes `data/xg.json`; the refresh keeps it current
- `model/initial_ratings.py` — seed ladder 1670/1330, division_offset 14

### Simulation
- `simulation/season.py` — seeded Monte Carlo, 50,000 runs; per fixture the blended odds pick
  the outcome and the attack/defence grid, conditioned on it, the scoreline
- `simulation/history.py` — projection re-run by date, not by round
- `pipeline.rewound_configs()` — rewound views use 10,000 runs + 2,500×8 history

### Backend
- `pipeline.py` — `build_report(slug, season, asof=...)` is the seam everything sits on;
  bands per season, table/fixtures/results/history payloads, `careers_payload`
- `api/server.py` — `SimpleHTTPRequestHandler` over `public/` plus the same `/data/*.json`
  names `build_site` writes, built on first request and cached (`--reload` to rebuild
  every request). Flags: `--host --port --reload --root`
- `build_site.py` — prebuilds every season's reports as JSON under `public/data/` for
  static hosting; `--only-season` for fast partial rebuilds

### Frontend (`public/`)
No framework, no build step. `app.js` renders one JSON report; `i18n.js` holds NO/EN
strings (`data-i18n` in the HTML, `t()` in JS). Tabbed views, default Finish Grid:
- **Finish Grid** — 16×16 heat matrix of finishing-position probability, animatable
- **Table** — standings, rating, expected points, title/relegation odds, all sortable
- **Ladder** — both divisions on one rating axis (vertical on phones), animatable
- **Next Up** — three-way odds per fixture with predicted scorelines
- **Played Results** — completed matches by ISO week with rating deltas
- **Compare Clubs** — two native selects; odds computed in the browser from `report.model`
- **Model Card** — parameters and known limits
- **Team focus** — summary (with expected goals for/against per match), finish row,
  pre-season vs live, rating history, season shape, season-by-season table, fixtures
  and results; opened from any club name or crest
- Rewind slider on grid/table/ladder rebuilds the page from a `report-<season>-<date>.json`

### Deploy
- `.github/workflows/deploy.yml` — every push to `main` builds **only the current season**
  and deploys live; a pull request from this repo gets a preview channel
- `.github/workflows/refresh.yml` — every 30 minutes, refresh results and commit if changed
- Past seasons are simulated on the developer's machine and uploaded once as a release
  asset; CI downloads it
- Deployed at `elitetrackerno.web.app`

#### Publishing past seasons

Only after a model change or a past-season backfill -- never for ordinary results, which
touch the current season alone:

```bash
python -m elitetracker.build_site          # every season, on your machine (~270 MB)
CURRENT=$(python -c 'from elitetracker.pipeline import current_season; print(current_season())')
# tar picks the members itself -- do not build the list with `ls`, whose output
# an interactive alias (eza, ls -l) can reshape into columns tar cannot stat.
tar -czf past-seasons.tar.gz -C public/data \
    --exclude="report-$CURRENT*" --exclude=report.json --exclude=careers.json .
gh release create past-seasons past-seasons.tar.gz   # first time
gh release upload past-seasons past-seasons.tar.gz --clobber   # afterwards
```

The current season, `report.json` and `careers.json` are excluded because CI rebuilds
them every deploy. About 1,078 files, ~36 MB gzipped.

## What's left

- [ ] Re-fit draw model periodically as seasons accumulate
- [ ] Re-run `backtest_cli` after each new season to keep K/home advantage/regression fitted
- [ ] Head-to-head tool — rivalry view with record against each other
- [ ] "What-if" simulator — nudge a rating, see grid/table update (needs backend)

## ELO System Details

- elo-v7 = elo-v6 ratings (K=20, home advantage=60, cross-season regression=0.88 per
  division) + attack/defence goals model (k=0.015 on goals, k_shots=0.05 with alpha=0.75 xG,
  home 0.22 in log goals, base 0.37, cap 4, regression 0.88, rho −0.05); outcome odds are
  the 50/50 geometric blend of the two, scorelines the Poisson grid conditioned on them
- Seed ladder: 1670 (best) / 1330 (worst), division_offset=14, midpoint fixed at 1500
- Draw model: `draw_base` 0.26, `draw_scale` 375 (refit in elo-v3)
- `expected_score` uses the standard logistic curve; draw probability is a separate lookup

## Commands

```bash
python -m venv .venv && .venv/bin/pip install -e '.[dev]'   # one-time (Windows: .venv\Scripts\...)
.venv/bin/python -m elitetracker.refresh                       # pull the latest results
.venv/bin/python -m elitetracker.api.server --port 8000        # live server, http://127.0.0.1:8000
.venv/bin/python -m elitetracker.build_site --only-season 2026 # static build of one season
.venv/bin/python -m http.server --directory public 8000        # preview the static build
.venv/bin/python -m pytest && node --test tests/frontend.test.js
```

## Testing

233 Python tests, plus a small Node suite over the pure frontend logic (form chips, the
compare tool's odds port). Required coverage:
* ELO initialization, expected result, actual score, update
* Draw probability logic
* Home advantage handling
* Standings calculations
* Simulation logic
* Data normalization and validation

## Model Versioning

```text
elo-v7
```

Changes impacting predictions must increment `MODEL_VERSION` in `model/elo.py`.

## Python Backend Rules

- Use type hints where clarity improves
- Keep functions small and focused
- Avoid clever code; use descriptive names
- Add comments for non-obvious logic (ELO calculations, simulations, data normalization)

## Git & Changes

- Keep changes focused
- Do not overwrite working functionality
- Preserve backwards compatibility when possible
- Never delete files without understanding purpose
