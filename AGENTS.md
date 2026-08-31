# AGENTS.md

## Project Overview

A Python-based website for predicting and ranking teams in the top two divisions of
Norwegian men's football: Eliteserien and OBOS-ligaen. Uses an ELO rating system
(elo-v6) to estimate team strength, match probabilities and season outcomes. The site
runs two ways: against a live Python API server, or as pure static files on Firebase
Hosting. Data comes from FotMob (no API key needed).

## Core Constraints

- All seasons 2015–2026 are in scope (historical data is already built)
- The model version is **elo-v6**; changes to predictions must bump `MODEL_VERSION`
- Avoid adding runtime dependencies — stdlib only
- No advanced prediction models yet (injury/squad-strength modelling was tested and rejected)
- Ponytail mode is active — shortest diff wins, YAGNI enforced

## Architectural Boundaries

```text
FotMob API -> Disk cache -> Normalize/Validate -> ELO model (elo-v6) ->
Scoreline model -> Monte Carlo simulation -> JSON reports -> Frontend (static or live API)
```

## Current State (what's done)

### Data
- `sources/fotmob.py` — parameterized by league and season, no API key
- `sources/cache.py` — read-through disk cache, validates on read and write
- `refresh.py` — one command pulls both divisions, normalizes, validates, writes atomically
- `normalize/` — canonical `Match` and `Standing` schemas with per-source adapters
- `validation/` — errors vs warnings, non-zero exit on error
- 24 season-league match files (2015–2026) plus 2014 seed tables

### Model (elo-v6)
- `model/elo.py` — `expected_score` / `actual_score` / `update` kept separate. K=20,
  home advantage 60, cross-season regression 0.88 (per division, not combined pool)
- `model/career.py` — one continuous rating replay from 2014 seed tables
- `model/probabilities.py` — three-way odds where `P(win) + 0.5·P(draw)` reproduces
  the rating-implied expectation exactly
- `model/scorelines.py` — scorelines conditioned on outcome AND pre-match rating gap
  (5 equal-count gap bins; empty cells fall back to global distribution)
- `model/backtest.py` — walk-forward harness for fitting parameters
- Seed ladder: 1670/1330, division_offset 14 (jointly fit with regression factor)

### Simulation
- `simulation/season.py` — seeded Monte Carlo, 50,000 runs, drawing a scoreline per fixture
- `simulation/history.py` — projection re-run by date, not by round
- Rewound views use 10,000 runs + 2,500×8 history for speed

### Backend
- `api/server.py` — `http.server`. Rating replay runs once at start-up; season reports
  built on first request and cached
- It answers the same `/data/*.json` names `build_site` writes, so the frontend has one
  URL scheme and no idea which host is behind it. Everything else comes from `public/`
- `build_site.py` — prebuilds every season's reports as JSON under `public/data/`
  for static hosting; `--only-season` for fast partial rebuilds

### Frontend (`public/`)
No framework, no build step. Tabbed views defaulting to Finish Grid:
- **Finish Grid** — 16×16 heat matrix of finishing-position probability
- **Table** — standings, rating, expected points, title/relegation odds (all columns sortable)
- **Ladder** — both divisions on one horizontal track, logos positioned by rating, stacked
  rows for overlaps, CSS tooltip with rank/name/rating on hover
- **Next Up** — three-way odds per fixture with predicted scorelines
- **Played Results** — completed-match feed navigated by ISO week, large rating+delta,
  gold gradient for winner
- **Season Shape** — per-club stacked area of position probability
- **Compare Clubs** — pick any two clubs for a fictional match. The odds are worked out
  in the browser from the two ratings plus the ~3 kB scoreline model carried in
  `report.model`, rather than shipping a precomputed matrix of every pairing
- **Model Card** — states known limits

### Deploy
- GitHub Action: refresh daily, then on push to `main` build **only the current season**
  and deploy to Firebase Hosting
- Past seasons are simulated on the developer's machine and uploaded once as a release
  asset; CI downloads it. Re-running a decade of Monte Carlo on every push was most of
  that job's runtime and none of it ever changed
- Deployed at `elitetrackerno.web.app`

#### Publishing past seasons

Only after a model change or a past-season backfill -- never for ordinary results, which
touch the current season alone:

```bash
python -m elitetracker.build_site          # every season, on your machine
CURRENT=$(python -c 'from elitetracker.pipeline import current_season; print(current_season())')
tar -czf past-seasons.tar.gz -C public/data $(cd public/data && ls report-*.json | grep -v "^report-$CURRENT")
gh release upload past-seasons past-seasons.tar.gz --clobber
```

The deploy job untars that into `public/data/`, then builds the current season over it.
With no such release it still deploys -- only the current season is browsable.

## What's left

- [ ] Re-fit draw model periodically as seasons accumulate
- [ ] Re-run `backtest_cli` after each new season to keep K/home advantage/regression fitted
- [ ] Team focus page — career modal + finish-grid row + fixtures in one view
- [ ] Head-to-head tool — rivalry view with record against each other
- [ ] "What-if" simulator — nudge a rating, see grid/table update (needs backend)

## ELO System Details

- elo-v6 parameters: K=20, home advantage=60, cross-season regression=0.88 (per division)
- Seed ladder: 1670 (best) / 1330 (worst), division_offset=14, midpoint fixed at 1500
- Draw model: `draw_base` 0.26, `draw_scale` 375 (refit in elo-v3)
- `expected_score` uses the standard logistic curve; draw probability is a separate lookup

## Testing

```bat
.venv\Scripts\python.exe -m pytest
node --test tests\frontend.test.js
```

303 Python tests, plus a small Node suite over the pure frontend logic (form chips, the
compare tool's odds port). Required coverage:
* ELO initialization, expected result, actual score, update
* Draw probability logic
* Home advantage handling
* Standings calculations
* Simulation logic
* Data normalization and validation

## Model Versioning

```text
elo-v6
```

Changes impacting predictions must increment `MODEL_VERSION` in `pipeline.py`.

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
