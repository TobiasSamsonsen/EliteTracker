# Model

The site publishes three things the model makes: **ratings** (one Elo rating
per club, `careers.json` and the table), **match odds** (fixtures, the compare
tool) and **season chances** (the finish grid, the bands, play-offs). The
version they carry is `MODEL_VERSION` in `model/elo.py`; the version table
and every tested idea are in `PROJECT_STATUS.md`.

## Ratings

One continuous replay of every season held, both divisions in one pool,
seeded once from the 2014 final tables (`model/career.py`,
`initial_ratings.py`). Each match moves the two ratings by the surprise of
the result blended with its xG (`model/elo.py`, `xg_alpha`); each offseason
pulls clubs toward their division (`season_regression`, and squad values for
clubs relegated into OBOS-ligaen). From `BOUNDARY_SEASON` on the modern
config applies (`era_config`).

## The goals model

Four ratings per club on the log-goals scale: attack, defence, finishing and
keeping (`model/attack_defence.py`, `ADConfig`). Learnt online from goals and
xG; the offseason pull aims at the division average shifted by squad value.
Its rates make a Dixon-Coles score grid (0-8 goals a side).

## Pricing one match

`model/pricing.py` is the only place the recipe is written down:

1. **Elo side** (`elo_odds`): the home rating plus the prediction-time terms
   the ratings never carry -- the surface edge (Eliteserien only,
   `normalize/surfaces.py`) and the table stakes in the run-in
   (`model/stakes.py`) -- into the three-way Elo odds
   (`model/probabilities.py`).
2. **Goals side**: the goals model's rates at the gap the Elo odds were priced
   at, with the stakes on the goals too, into the score grid.
3. **Blend** (`match_odds`): Elo odds and the grid's own, geometrically, at
   `OUTCOME_BLEND` on Elo; the scorelines take who-wins from the blend and
   how-many from the grid.

The goals side's `home_beta` and the blend's `blend_gamma` read the gap the
Elo odds were priced at, surface edge and stakes included; both are 0 today. The season simulation does steps 2-3 as
arrays (`simulation/season.py`, `_fixtures`) from `goal_rates` and
`blend_weight`.

## Season chances

`simulation/season.py` plays the remaining fixtures 50,000 times from the
live table, at each fixture's odds, with one strength shock per club per run
(`STRENGTH_SD`). The run-in's stakes come from each run's own table. Play-offs
(`simulation/playoffs.py`) are played inside every run, against the other
division's simulated club; `simulation/history.py` re-runs the projection as it
stood on earlier dates for the history charts.

## Changing the model

1. Check `PROJECT_STATUS.md` for the idea. A logged rejection is a baseline,
   not a veto: re-test when the model, the data or the method has moved, and
   report the new numbers beside the old.
2. Test it walk-forward: `model/backtest.py` (`walk_forward`,
   `shipped_cards`), `python -m elitetracker.backtest_cli`, or the research
   harness in `experiments/improvements/harness.py`. Score log loss, Brier,
   RPS and calibration, with paired t-statistics, across both divisions and
   both halves of the period. The out-of-sample walk-forward decides; report
   the strict (|t| >= 2) and the relaxed reading.
3. Log the test in `PROJECT_STATUS.md` with its numbers, shipped or rejected.
4. Ship: bump `MODEL_VERSION` once per release (AGENTS.md, "Model
   Versioning"), add the row to the version table, and rebuild past seasons
   ([operations.md](operations.md), "Publishing past seasons").

## The browser's copies

Two pages redo some of the arithmetic in JavaScript: the compare tool
(`public/app.js`, "compare clubs") and the model page (`public/model.js`).
Their golden numbers live in `tests/fixtures/match_odds.json`, which the
Python model writes and checks (`tests/test_pricing.py`) and the JS tests read
(`tests/frontend.test.js`). After a deliberate model change:

```bash
.venv/Scripts/python -m tests.test_pricing     # rewrite the golden file
node --test tests/frontend.test.js             # then bring the ports up to it
```

The report's `model` section carries the settings the compare tool needs;
`model.js` keeps its own copy of the shipped defaults (`DEFAULTS`).
