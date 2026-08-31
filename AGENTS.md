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
- Routes: `/`, `/api/health`, `/api/seasons`, `/api/careers`, `/api/report`,
  `/api/report/<league>[/<season>]`
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
- **Compare Clubs** — pick any two clubs for a fictional match
- **Model Card** — states known limits

### Deploy
- GitHub Action: refresh daily, build site, deploy to Firebase Hosting on push to `main`
- Deployed at `elitetrackerno.web.app`

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
```

313 tests. Required coverage:
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
