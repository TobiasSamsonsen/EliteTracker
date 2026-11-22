# Data

## What is in `data/`

| Path | What | Written by |
|---|---|---|
| `normalized/<league>_<season>_matches.json` | every fixture and result, canonical `Match` schema | `refresh` (hourly in CI) |
| `normalized/<league>_<season>_standings.json` | final tables (2014, 2015, 2025); 2014 seeds the ratings | by hand |
| `normalized/playoff_fixtures.json` | every season's play-off matches as fotmob lists them (its "Eliteserien Qualification", league 60): OBOS-ligaen's bracket and the tie with Eliteserien's 14th, played and to come; played ones move the Elo ratings, and in the running season go as they went in every simulated run | `refresh` (the running season, only while the play-off is on); `research playoffs` (2015-2025, a manual backfill) |
| `normalized/playoff_outcomes.json` | how each finished season's play-offs went (2015-2025): bracket winner, who went down; checked against the next season's membership | by hand, once a season |
| `normalized/uefa_ranks.json` | Norway's UEFA rank per season (the European places) | `refresh` |
| `xg.json` | xG per match: fotmob (Eliteserien, with xG on target) and Sofascore (OBOS-ligaen) | `refresh`; `research xg-obos` |
| `market_values.json` | Transfermarkt squad value per club-season | `research market-values`, once a year |
| `odds_closing.json`, `odds_closing_prices.json`, `odds_closing_books.json` (the book each price came from) | football-data.co.uk closing odds, the benchmark | `research odds --refresh` |
| `odds_norsktipping.json` | Norsk Tipping's 1X2 prices (home/draw/away) for 119 Eliteserien matches (100 of 2024, 20 of 2026; one 2024 page had none), read from FotMob's match pages; measurement only: the model view's betting fact at Norsk Tipping's prices (`research.calibration_payload`) and `experiments/improvements/norsk_tipping.py` | by hand in the browser, 22 November 2026; not refreshed |
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
  `research xg-obos`. The one exception, asked for in November 2026, is the
  play-off (`refresh.refresh_playoffs`): one fotmob page, only from
  OBOS-ligaen's last round until the tie is decided, and inside that window
  only the first time, after a kickoff still without a result, and at
  06 and 18 UTC (`PLAYOFF_CHECK_HOURS`); a failed fetch is skipped.
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
  the first 403 or 429. `research xg`, `research market-values` and
  `research playoffs` follow this.

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
