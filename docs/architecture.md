# Architecture

## The flow

```
fotmob / Sofascore / Transfermarkt / football-data / UEFA
        │  sources/            fetch (refresh hourly in CI; the rest by hand)
        ▼
data/raw, data/xg.json, data/market_values.json, data/odds_*.json
        │  normalize/ + validation/   one canonical Match schema, checked
        ▼
data/normalized/<league>_<season>_matches.json, *_standings.json, uefa_ranks.json
        │  pipeline.py (the model's inputs: load_slices, shot_table, market_values, ...)
        ▼
model/      ratings (career replay), goals model, match odds (pricing.py)
simulation/ the remaining season, play-offs, the season's history
        │  pipeline.build_report  ->  one report payload per league
        ▼
build_site.py  -> public/data/*.json (static, Firebase)      api/server.py -> the same names, live
        │
        ▼
public/  app.js + i18n.js (the site), model.js (/model.html)
```

Nothing below `pipeline.py` touches the network, and nothing in `model/` or
`simulation/` touches the disk except `model/benchmark.py`, which reads the
closing odds.

## Modules and what they own

| Module | Owns |
|---|---|
| `sources/fotmob.py` | fixtures and results for both divisions, Eliteserien xG (`data/xg.json`) |
| `sources/sofascore.py` | OBOS-ligaen xG (by hand: `research xg-obos`) |
| `sources/transfermarkt.py` | squad values (`research market-values`, once a year) |
| `sources/uefa.py` | Norway's UEFA rank (stored by `refresh` as `uefa_ranks.json`) |
| `normalize/` | the canonical `Match` and standings schemas; `surfaces.py` the grass table and the surface edge |
| `validation/` | consistency checks; `refresh` stops on any error |
| `refresh.py` | the one command after a round: fetch, normalize, validate, replace |
| `model/elo.py` | `EloConfig`, the era switch, `MODEL_VERSION` |
| `model/career.py`, `ratings.py`, `initial_ratings.py` | one continuous rating replay from the 2014 tables, both divisions in one pool |
| `model/attack_defence.py` | the goals model: attack, defence, finishing, keeping; the score grid; the blend |
| `model/probabilities.py` | three-way Elo odds with the draw model |
| `model/stakes.py` | the run-in's table-stakes term |
| `model/pricing.py` | **how one match is priced**, for every caller (see [model.md](model.md)) |
| `model/backtest.py`, `benchmark.py`, `fit_params.py` | walk-forward scoring, the closing line, parameter fits |
| `simulation/season.py` | Monte Carlo of the remaining season (vectorised, NumPy) |
| `simulation/playoffs.py`, `history.py` | the post-season ties; the projection as it stood on each date |
| `pipeline.py` | league specs and bands, the model's inputs, `build_report` and every payload section |
| `build_site.py` | every view as static JSON, with the incremental-rebuild stamps |
| `api/server.py` | the same `/data/*.json` names, built on request |
| `research.py`, `backtest_cli.py` | research commands: odds, xG backfills, market values, calibration |

## Seams worth knowing

- **Match odds** (`model/pricing.py`). The published fixtures, the season
  simulation, the play-offs and the backtest price a match through it:
  `elo_odds` for the Elo side, `match_odds` for the published odds. Add a
  prediction-time term there, once.
- **The model's inputs** (`pipeline.py`, "the model's inputs"). Every file
  the model reads sits under one data directory: `load_slices`, `shot_table`,
  `market_values`, `stakes_table`, `prior_attack_defence`, each cached per
  root. `reload_inputs()` drops them all (the server's `--reload`);
  `inputs_digest(root, season, asof)` hashes them afresh for the build stamp.
  A new input goes in both, side by side.
- **The report payload** (`pipeline.build_report`). One dict per league:
  `league`, `model` (also the compare tool's ingredients), `table`,
  `fixtures`, `results`, `high_stakes`, `next_stakes`, `history`. The
  frontend reads only this, `careers.json` and `calibration.json`.
- **Two hosts, one URL scheme.** `build_site` writes `report.json`,
  `report-<season>.json`, `report-<season>-<date>.json`, `careers.json` and
  `calibration.json`; `api/server.data_payload` answers the same names live
  (`tests/test_server.py` holds it to that).
- **Rewind.** `asof` rewinds a report once, on the fixture list; everything
  downstream follows. Rewound views run the same 50,000
  simulations but take fewer history snapshots (`pipeline.rewound_configs`).

## Decisions not to re-litigate

Each is explained where it lives:

- The browser prices the compare tool itself rather than shipping every
  pairing (`app.js`, "compare clubs").
- The season simulation is vectorised (about 30x; `season.py`), and play-offs
  draw from their own random stream so finishing chances do not move with them.
- A rewound view's stamp masks results after its date, so it is built once
  (`pipeline.inputs_digest`, `build_site.py` "Incremental rebuild").
- One BLAS thread per build worker and recycled workers are measured choices
  (`build_site.py`).
- Short names are applied once on load and joins use `team_id` (`app.js`).
- The experiment harness replays older `src` from git worktrees with a
  bit-identity check (`experiments/improvements/harness.py`).
