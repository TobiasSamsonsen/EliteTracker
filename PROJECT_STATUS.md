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
- `normalize/` — canonical `Match` and `Standing` schemas with per-source adapters
  (`fotmob`, `parse_bot`), so dedupe, ordering and validation are written once.
- `validation/` — errors vs. warnings, non-zero exit on error.
- **24 season-league match files (2015–2026) plus 2014 seed tables, all validating clean.**

### Model (elo-v2)
- `model/elo.py` — `expected_score` / `actual_score` / `update` kept separate.
  K-factor 20 and home advantage 75, both calibrated against real results.
- `model/career.py` — **one continuous rating replay.** Seeded once from the 2014 final
  tables, then every played match from 2015 to now applied in kickoff order. Ratings
  carry across seasons and across divisions; nothing is re-seeded each year.
- `model/probabilities.py` — three-way odds where `P(win) + 0.5·P(draw)` reproduces the
  rating-implied expectation exactly.
- `simulation/season.py` — seeded Monte Carlo, 10,000 runs, ~10M match-samples/second.
- `simulation/history.py` — the projection re-run at ~20 points **by date, not by round.**

### Site
- `api/server.py` — `http.server`. The rating replay runs once at start-up; individual
  season reports are built on first request and cached, so start-up stays quick.
  Routes: `/`, `/api/health`, `/api/seasons`, `/api/careers`, `/api/report`,
  `/api/report/<league>[/<season>]`.
- `web/` — no framework, no build step. Light/dark themes, keyboard focus, reduced
  motion, mobile layout. `?league=`, `?season=`, `?team=`, `?career=` make any view linkable.
  - **The finish grid** — 16×16 heat matrix of finishing-position probability.
  - **Table** — standings, rating, expected points, title and relegation odds.
    Picking a club opens its full rating history.
  - **Season shape** — per-club stacked area of position probability over the season.
  - **The ladder** — both divisions on one line, sharing the rating scale.
  - **Career modal** — a club's rating across every season, plus a season-by-season table.
  - **Next up** and a **model card** stating the known limits.

### Colour
- **Sequential ramp** for all quantitative colour (grid probability, season shape).
  Multi-hue by necessity — sixteen stacked bands are not tellable apart in one hue — so
  it travels pale green → teal → blue → deep navy, resampled at uniform OKLab lightness.
  Lightness stays monotone and the worst adjacent pair is ΔE 10.5 light / 11.3 dark.
- Qualification markers and the division colours on the ladder are separate, labelled
  categorical marks, not part of the quantitative encoding.

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

## ❗ Known limits (also stated on the site)
- Ratings are held fixed for the rest of the season inside a simulation.
- Simulated matches produce points but not scorelines, so ties break on goal difference
  as it stands today.
- No inter-season regression toward the mean; a club carries its full rating into the
  next year.
- Clubs promoted from the third tier start at the ladder floor.

## 🔧 Next steps
- [ ] Refresh data on a schedule (the cache supports it; nothing calls it yet).
- [ ] `elo-v3`: let ratings drift inside a simulation and sample scorelines so goal
      difference moves — the first two limits above.
- [ ] Backtest elo-v2 against the seasons now held, and tune K and home advantage on it.

## Commands

```bash
# fetch (cached; --force to refresh)
.venv/bin/python -m elitetracker.sources.fotmob {matches|standings} {eliteserien|obosligaen} <season>

# normalize / validate
.venv/bin/python -m elitetracker.normalize.fotmob {matches|standings} <raw.json> <out.json>
.venv/bin/python -m elitetracker.validation.matches <normalized.json> [--teams 16]
.venv/bin/python -m elitetracker.validation.standings <normalized.json> [--teams 16]

# model + site
.venv/bin/python -m elitetracker.pipeline [--season 2019] [--output data/reports.json]
.venv/bin/python -m elitetracker.api.server --port 8000
.venv/bin/python -m pytest
```

275 tests, all passing.
