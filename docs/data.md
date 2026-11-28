# Data

## What is in `data/`

| Path | What | Written by |
|---|---|---|
| `normalized/<league>_<season>_matches.json` | every fixture and result, canonical `Match` schema | `refresh` (hourly in CI) |
| `normalized/<league>_<season>_standings.json` | final tables (2014, 2015, 2025); 2014 seeds the ratings | by hand |
| `history_standings.json`, `raw/wikipedia_standings/` | final tables before 2016 from Wikipedia's rendered season pages (a table per season: top tier 1963-2015, second tier 1991-2015, in two groups of 12 for 1991-96; earlier second-tier seasons were split into groups and are not fetched): position, club, played, W/D/L, goals, points as 3 W + D. Research only, nothing in the model reads it. Gate: 2014 and 2015 reproduce the repo's own tables (77 of 78 rows; Lillestrom 2015 is 44 in the repo, 45 from W and D: a deduction). The raw pages are not in git (12 MB, the fetch script reproduces them); parsed by `experiments/improvements/parse_wikipedia_standings.py` | `experiments/improvements/fetch_wikipedia_standings.py`, a manual opt-in backfill (78 pages, one request at a time, a 4-8 s jittered wait, saved as it goes, stops at the first 403 or 429), 23 November 2026 |
| `normalized/playoff_fixtures.json` | every season's play-off matches as fotmob lists them (its "Eliteserien Qualification", league 60): OBOS-ligaen's bracket and the tie with Eliteserien's 14th, played and to come; played ones move the Elo ratings, and in the running season go as they went in every simulated run | `refresh` (the running season, only while the play-off is on); `research playoffs` (2015-2025, a manual backfill) |
| `normalized/survival_results.json` | the running season's survival tie of OBOS-ligaen's 14th against the tier below, once played (club id → stayed up): fotmob does not list it, so by hand; the published chances then show it as played. Fold it into `playoff_outcomes.json` when the season ends | by hand |
| `normalized/playoff_outcomes.json` | how each finished season's play-offs went (2015-2025): bracket winner, who went down; checked against the next season's membership | by hand, once a season |
| `normalized/uefa_ranks.json` | Norway's UEFA rank per season (the European places) | `refresh` |
| `xg.json` | xG per match: fotmob (Eliteserien, with xG on target, and from 2020 npxG and the first red card's minute: `[xg, xg, xgot, xgot, npxg, npxg, red_minute]`; npxG for 2020-2026 filled from the local shots by `experiments/improvements/npxg_from_extras.py`) and Sofascore (OBOS-ligaen, `[xg, xg]`). The model reads npxG to weight penalty xG (`elo.model_xg`, elo-v19.0) | `refresh`; `research xg-obos` |
| `red_cards.json` | every red card (a second yellow too) the goals model reads (elo-v19.0): `{match_id: [[minute, side], ...]}`, side 0 the home side's, only matches with a red. Eliteserien 2015 on, OBOS-ligaen 2015-2026; the hourly refresh adds new Eliteserien matches from the match details it already fetches for xG (0 extra requests). OBOS-ligaen matches after November 2026 have none (fotmob's details for them are not fetched), so they get no correction | `refresh`; built once by `experiments/improvements/build_red_cards.py` from the two raw card files below |
| `referees.json` | referee, cards and fouls per match from fotmob `matchDetails` | `refresh` (piggybacked on newly finished Eliteserien matches, 0 extra requests); `research referees` (manual, opt-in polite backfill: 4-8 s jittered, saved after every match, stops on 403/429) |
| `raw/fotmob_match_extras.json` | Eliteserien 2020-2026 (1,608 matches): each shot `[minute, side, xg, situation, own_goal, event]`, red cards `[minute, side, type]`, goals `[minute, side]`. **`side` is 1 for the home team in almost every match** (not 0); orient each match by its shots against `xg.json`, as `experiments/improvements/shots_local.py` does. Research only | a one-off fotmob pull (September 2026) |
| `raw/fotmob_match_cards.json` | card events `[minute, side, type]` (side 0 is home, from fotmob's `isHome`) for Eliteserien 2015-2019 and late 2026 and OBOS-ligaen 2015-2026; `none` lists matches with no event data. Research only | `experiments/improvements/fetch_red_cards.py` (manual, opt-in polite backfill), November 2026 |
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
