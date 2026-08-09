# Project Status

## ✅ Done

### Data acquisition
- [x] Fetched raw Eliteserien 2026 matches into `data/raw/eliteserien_2026_matches.json` (258 rows).
- [x] Fetch script moved to `src/elitetracker/sources/parse_bot.py`.

### Project structure (Phase 1)
- [x] `pyproject.toml` with pinned runtime deps (`requests`, `python-dotenv`) and a `dev` extra (`pytest`).
- [x] `.venv` created; package installed in editable mode (`pip install -e ".[dev]"`).
- [x] `.env.example` added; `API_KEY` is required only by the fetch scripts.
- [x] Package layout under `src/elitetracker/`: `sources/` → `normalize/` → `validation/`.

### Normalization + validation (Phase 2)
- [x] `src/elitetracker/normalize/matches.py` — stdlib-only normalizer replacing the pandas script.
  - Parses `"søndag 09.08.26"` → ISO `"2026-08-09"`.
  - Splits `"2 - 1"` into `home_goals` / `away_goals`; `"-"` → `None` + `played: false`.
  - **Deduplicates by `match_id`** (the scraper repeated the current round: 258 → 240).
  - Sorts by `(date, time, match_id)`; matches with no published kickoff time sort last within their day.
- [x] `src/elitetracker/validation/matches.py` — reports errors vs. warnings, exits non-zero on error.
  - Unique ids, no repeated fixture, ISO dates, score/`played` consistency, chronological order,
    16 teams × 15 home + 15 away = 240 matches, future matches carrying results.
- [x] 67 unit tests in `tests/`, all passing.
- [x] `data/normalized/eliteserien_2026_matches.json` generated and validating clean:
      240 matches, 126 played, 114 upcoming, 2026-03-14 → 2026-12-13.

### Bugs found and fixed
- `matches_sorted.json` stored `date` as **epoch milliseconds** (pandas `to_json`), not the
  `DD.MM.YY` string the old `validate.py` asserted — that script crashed on line 9.
  Both are replaced; a regression test covers the integer-date case.
- The old chronological check compared `DD.MM.YY` strings lexically, so `"13.12.26" < "14.03.26"`.
  ISO dates now sort correctly; a regression test covers December-before-March.
- `sort_matches.py` contained the entire script duplicated twice.
- 18 duplicate match records were never removed, making home/away counts 15/16/17 per team.

## ❗ Not done

- [ ] **OBOS-ligaen has no data.** `data/raw/obosligaen_matches.json` contains `null` —
      `parse_bot.py` hardcodes `tournament='eliteserien'`.
- [ ] **No 2025 final standings.** Blocks initial ELO ratings.
- [ ] No caching layer; every fetch hits the API.
- [ ] No `.env`, so re-fetching is currently impossible.

## 🔧 Next steps

**Phase 3 — complete the data scope**
- [ ] Parameterize `parse_bot.py` by tournament; add request → validate → store → cache pipeline.
- [ ] Fetch OBOS-ligaen; normalize and validate it with `--teams 16`.
- [ ] Load 2025 final standings for both divisions (user is providing these) into `data/raw/`.

**Phase 4 — ELO v1**
- [ ] `model/elo/initial_ratings.py`: deterministic finishing-position → 1700…1300 mapping,
      with a documented rule for promoted/relegated teams.
- [ ] `model/elo/ratings.py`: separate `expected_score()`, `actual_score()`, `update()`;
      configurable K-factor and home advantage; replay the 126 played matches.
- [ ] Tests: ELO init, expected result, equal-rating symmetry, home advantage, draw logic.

**Phase 5+** — match probabilities, Monte Carlo season simulation, position probability
matrix, backend API, frontend (per the AGENTS.md workflow order).

## Commands

```bash
.venv/bin/python -m elitetracker.normalize.matches data/raw/<raw>.json data/normalized/<out>.json
.venv/bin/python -m elitetracker.validation.matches data/normalized/<out>.json [--teams 16]
.venv/bin/python -m pytest
```
