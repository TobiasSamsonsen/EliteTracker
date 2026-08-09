# Project Status

Norwegian top-two-division prediction, 2026 season. ELO ratings, Monte Carlo season
simulation, and a local website — all standard library, no runtime dependencies.

```bash
.venv/bin/python -m elitetracker.api.server --port 8000   # then open http://127.0.0.1:8000
```

## ✅ Done

### Phases 1–2 — structure, normalization, validation
- `pyproject.toml`, `.venv`, package layout per the AGENTS.md boundary diagram.
- `normalize/matches.py` — canonical `Match` schema + source-independent dedupe/sort/IO.
- `normalize/{parse_bot,fotmob}.py` — per-source adapters producing the same schema.
- `validation/matches.py` — errors vs. warnings, non-zero exit on error.

### Phase 3 — data sources
- `sources/cache.py` — read-through disk cache (request → validate → store → use).
  Payloads are validated **on read as well as on write**, so a stale or foreign-schema
  entry can never be served.
- `sources/fotmob.py` — parameterized by league and season, no API key.
- `normalize/standings.py` + `validation/standings.py` — final-table schema and checks.

### Phase 4 — ELO v1
- `model/elo.py` — `expected_score` / `actual_score` / `update` kept separate.
  Configurable K-factor (20) and home advantage (75).
- `model/initial_ratings.py` — deterministic seeding. Both divisions on one ladder;
  an OBOS finish counts as `division_offset` (10) places worse, mapped linearly onto
  1700…1300. That is what lets a promoted champion outrank a relegated top-flight side.
- `model/probabilities.py` — three-way odds where `P(win) + 0.5·P(draw)` reproduces the
  rating-implied expectation exactly, with the draw capped so nothing goes negative.
- `model/ratings.py`, `model/table.py` — chronological rating replay and the live table.

### Phase 5 — simulation
- `simulation/season.py` — seeded Monte Carlo, 10,000 runs by default, ~10M
  match-samples/second. Independent seeds agree to ±0.6%.
- `simulation/history.py` — the projection re-run as it stood at ~20 points in the season.

### Phases 6–7 — API and website
- `api/server.py` — `http.server`; reports built once at start-up (~2.5s), `--reload` to
  rebuild per request. Routes: `/`, `/api/health`, `/api/report`, `/api/report/<slug>`.
- `web/` — no framework, no build step. Light and dark themes, keyboard focus, reduced
  motion respected, responsive to mobile. `?league=…&team=…` makes any view linkable.
  - **The finish grid** — 16×16 heat matrix of finishing-position probability.
  - **Table** — standings, rating, expected points, title and relegation odds.
  - **Season shape** — per-club stacked area of position probability over the season.
  - **The ladder** — both divisions on the single rating scale the model uses.
  - **Next up** — three-way odds per fixture.
  - **Model card** — every parameter, plus the known limits stated plainly.

### Colour
Data colours come from the validated data-viz palette and were checked with its
validator in both themes:
- sequential blue 100–700 → probability in the finish grid;
- diverging blue ↔ grey ↔ red → home win / draw / away win (poles pass every gate,
  ΔE 19–32; midpoints picked at the CVD-safe step);
- diverging blue ↔ grey ↔ red → finishing position, mixed in oklab from three tokens
  so a theme switch recolours the chart for free.

## ⚠️ Decisions worth knowing

**parse.bot is gone.** The original scraper 404s for every tournament with a valid key
(a missing key still returns 401). fotmob replaced it: no API key, both divisions,
historical seasons, stable team ids, UTC kickoffs. Before switching, both sources were
normalized and compared on Eliteserien 2026 — they agree on all played results and every
fixture date. `API_KEY` / `.env` are no longer used by anything.

**Season shape is sampled by date, not by round.** Rounds are not chronological:
Eliteserien 2026 plays round 12 *after* rounds 13–16, and `latest_round` jumps from 4 on
11 April to 15 on 15 April. A round axis would have shown results before they happened.

## ❗ Known limits (also stated on the site)
- Ratings are held fixed for the rest of the season inside a simulation.
- Simulated matches produce points but not scorelines, so ties break on goal difference
  as it stands today.
- Seeding uses only 2025 finishing position — no transfers, injuries or European load.
- Sandnes Ulf and Strømmen came up from the third tier, outside this project's data
  scope; they start at the ladder floor and are corrected only by results.

## 🔧 Next steps
- [ ] Refresh data on a schedule (the cache already supports it; nothing calls it yet).
- [ ] `elo-v2`: let ratings drift inside a simulation, and sample scorelines so goal
      difference moves — the two limits above.
- [ ] Head-to-head and form-weighted adjustments once elo-v1 has a baseline to beat.

## Commands

```bash
# fetch (cached; --force to refresh)
.venv/bin/python -m elitetracker.sources.fotmob {matches|standings} {eliteserien|obosligaen} <season>

# normalize / validate
.venv/bin/python -m elitetracker.normalize.fotmob {matches|standings} <raw.json> <out.json>
.venv/bin/python -m elitetracker.validation.matches <normalized.json> [--teams 16]
.venv/bin/python -m elitetracker.validation.standings <normalized.json> [--teams 16]

# model + site
.venv/bin/python -m elitetracker.pipeline --output data/reports.json
.venv/bin/python -m elitetracker.api.server --port 8000
.venv/bin/python -m pytest
```

254 tests, all passing.
