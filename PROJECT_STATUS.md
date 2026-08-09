# Project Status

## ✅ Done

### Phase 1 — project structure
- [x] `pyproject.toml`; **zero runtime dependencies** (`pytest` only for dev).
- [x] `.venv` with the package installed editable (`pip install -e ".[dev]"`).
- [x] Layout per the AGENTS.md boundary diagram: `src/elitetracker/{sources,normalize,validation}/`.

### Phase 2 — normalization + validation
- [x] `normalize/matches.py` — canonical `Match` schema plus source-independent
      dedupe / sort / (de)serialization. ISO `YYYY-MM-DD` dates.
- [x] `normalize/parse_bot.py`, `normalize/fotmob.py` — per-source adapters, both
      producing `Match`, so downstream code is written once.
- [x] `validation/matches.py` — errors vs. warnings, non-zero exit on error.

### Phase 3 — data sources
- [x] `sources/cache.py` — read-through disk cache (request → validate → store → use).
      Payloads are validated on **write and on read**, so a stale or foreign-schema
      entry can never be served.
- [x] `sources/fotmob.py` — parameterized by league and season, no API key needed.
      Both divisions registered; `--force` bypasses a fresh cache entry.
- [x] `normalize/standings.py` + `validation/standings.py` — final-table schema and checks
      (row arithmetic, points vs. deductions, league-wide totals, position ordering).
- [x] **OBOS-ligaen data acquired** — 240 matches, 129 played.
- [x] **2025 final standings acquired** for both divisions.
- [x] 136 tests, all passing.

### Data on disk (all validating clean)
| File | Rows |
|---|---|
| `data/normalized/eliteserien_2026_matches.json` | 240 (126 played) |
| `data/normalized/obosligaen_2026_matches.json` | 240 (129 played) |
| `data/normalized/eliteserien_2025_standings.json` | 16 — won by Viking |
| `data/normalized/obosligaen_2025_standings.json` | 16 — won by Lillestrøm |

## ⚠️ Source change: parse.bot → fotmob

**The parse.bot scraper was deleted upstream.** Every tournament now returns
`404 {"error":"Scraper with ID 508d9362-… not found"}` with a valid key (a
missing key still returns 401, so this is not an auth problem). It could never
have supplied OBOS-ligaen.

fotmob replaces it and is strictly better: no API key, both divisions, historical
seasons, stable numeric team ids, UTC kickoff times and round numbers. Its page
HTML embeds the rendered data in a `__NEXT_DATA__` script tag, so no browser is needed.

**`API_KEY` / `.env` are no longer used by anything** — `.env.example` was removed.

The two sources were cross-checked against each other before the switch: on
Eliteserien 2026 they agree on **all 126 played results and every fixture date**.
`data/raw/parsebot_eliteserien_2026_matches.json` is kept as that archive, and
`normalize/parse_bot.py` still reads it.

## 🔧 Next steps — Phase 4 (ELO v1)

- [ ] `model/elo/initial_ratings.py` — deterministic finishing-position → 1700…1300 map.
- [ ] `model/elo/ratings.py` — separate `expected_score()` / `actual_score()` / `update()`;
      configurable K-factor and home advantage; replay played matches.
- [ ] Tests: ELO init, expected result, equal-rating symmetry, home advantage, draw logic.

### Decisions Phase 4 must make
1. **Promoted teams.** All 16 Eliteserien 2026 teams have a 2025 record (13 stayed up,
   3 promoted: Lillestrøm #1, Start #2, Aalesund #4). Seeding a promoted team from its
   *OBOS* position needs an explicit cross-division offset.
2. **No 2025 record at all.** OBOS-ligaen 2026 contains **Sandnes Ulf** and **Strømmen**,
   promoted from tier 3, which is outside the project's data scope. They need a
   documented default rating.
3. **Points deductions.** Kristiansund (Eliteserien) and Raufoss (OBOS) were each docked
   1 point in 2025. Seeding uses finishing position, so the deduction is already baked in.

## Commands

```bash
# fetch (cached; --force to refresh)
.venv/bin/python -m elitetracker.sources.fotmob {matches|standings} {eliteserien|obosligaen} <season>

# normalize
.venv/bin/python -m elitetracker.normalize.fotmob {matches|standings} <raw.json> <out.json>

# validate (exits non-zero on error)
.venv/bin/python -m elitetracker.validation.matches <normalized.json> [--teams 16]
.venv/bin/python -m elitetracker.validation.standings <normalized.json> [--teams 16]

.venv/bin/python -m pytest
```
