# Data

## What is in `data/`

| Path | What | Written by |
|---|---|---|
| `normalized/<league>_<season>_matches.json` | every fixture and result, canonical `Match` schema | `refresh` (hourly in CI) |
| `normalized/<league>_<season>_standings.json` | final tables (2014, 2015, 2025); 2014 seeds the ratings | by hand |
| `normalized/uefa_ranks.json` | Norway's UEFA rank per season (the European places) | `refresh` |
| `xg.json` | xG per match: fotmob (Eliteserien, with xG on target) and Sofascore (OBOS-ligaen) | `refresh`; `research xg-obos` |
| `market_values.json` | Transfermarkt squad value per club-season | `research market-values`, once a year |
| `odds_closing.json`, `odds_closing_prices.json` | football-data.co.uk closing odds, the benchmark | `research odds --refresh` |
| `model_versions.json` | the model-accuracy view's history of versions | `experiments/improvements/version_history.py combine` |
| `raw/` | raw source payloads and the football-data CSV | the fetchers |

Reports read these through `pipeline.py` only ("the model's inputs"):
`xg.json` and `market_values.json` are found beside whichever normalized
directory a report is built from, so a test's temporary directory never
reads the working copy's data.

## Sources

- **fotmob**: fixtures and results for both divisions, and Eliteserien xG,
  from the one request per page `refresh` already makes (`sources/fotmob.py`).
- **Sofascore**: OBOS-ligaen xG, which fotmob lacks (`sources/sofascore.py`).
  Run by hand (`research xg-obos`): every request from a GitHub Actions runner
  answers 403 (`sources/sofascore.py`).
- **Transfermarkt**: squad values for the goals model's offseason pull
  (`sources/transfermarkt.py`).
- **football-data.co.uk**: Eliteserien closing odds, for the benchmark
  (`model/benchmark.py`).
- **UEFA**: Norway's association rank (`sources/uefa.py`).

## Scraping rules

The project depends on free, polite access to fotmob, Sofascore and
Transfermarkt. A rate limit, an IP ban or a Cloudflare block would force it
onto paid APIs and break the site. So:

- Never add HTTP requests per match or per run to `refresh` or
  `research xg-obos`.
- Never re-scrape past seasons in bulk from tests, CI or model sweeps, and
  never loop over extra endpoints (no Sofascore for Eliteserien, no extra
  fotmob endpoints).
- A new field must come from the payload already fetched for a newly finished
  match, or from files already in `data/`.
- If evaluating an idea would need a network backfill, do not scrape it
  automatically: write the parser for payloads already on disk, note it in
  `PROJECT_STATUS.md`, and if a backfill is ever needed, make it a manual,
  opt-in command: one request at a time, a jittered 4-8 s wait between
  requests, the file saved after every match, honest headers, and a stop at
  the first 403 or 429. `research xg` and `research market-values` follow
  this.

## Once a year, after the season

- **Squad values** for the new season, two pages:

  ```bash
  .venv/Scripts/python -m elitetracker.research market-values --season 2027 --dry-run   # check the join
  .venv/Scripts/python -m elitetracker.research market-values --season 2027             # write it
  ```

  Never from CI or the hourly refresh. A missing season only switches the
  value pull off for the next one.
- **Surfaces**: a line in `normalize/surfaces.py` for a club that changes
  ground or surface, or a promoted club on grass. The table's sources were
  checked ground by ground on 2026-10-16 (the module docstring).
- **UEFA rank**: stored by `refresh`; a season not yet ranked takes the newest
  rank known (`pipeline.bands_for`).
