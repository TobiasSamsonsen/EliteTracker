ladder phone list, played-card xG, three Compare blocks incl. real head-to-head,
Model Card strength-shock row, team-view summary bullets, and a rewritten
"Key stats explained" (xPts = simulation mean, attack/defence = �% display of
the rates, xG-form trend thresholds).

## Contact form - planned

The footer's email link was taken out before the site went into Google Search
Console, so the address is not harvested once the site is indexed. Replace it
with a contact form (Firebase Hosting is static, so a hosted form service or a
small function) and put a "Contact" link back in `footer.text` (both languages
in `public/i18n.js`) and the static footer in `public/index.html`.

## Explore / Utforsk: other ways to look at the data (October 2026) - shipped

`?view=explore` is a gallery of cards (thumbnail, name, short description; two
across, one on phones) that each open a visualisation in the same panel, with
`?viz=` for links. Adding one = an id in `EXPLORE_ITEMS`, a thumbnail in
`exploreThumb`, a render function and its `explore.<id>.*` strings.

- **Attack vs defence** (`viz=attack`): crests placed by `table[].attack`
  against `defence` (fewest at the top). These are the model's ratings as
  expected goals per match against an average side, not season xG (attack
  includes finishing), so they carry over between seasons and allow for
  opponent and venue; the labels say so here and on the team page. A
  best-fit trend line (orthogonal regression, since neither axis is the
  outcome of the other) splits "better defence than their level suggests"
  from "better attack", with direction guides on both axes; each tooltip
  says by how much. Tried and dropped: an average crosshair with quadrant
  labels, the y = x line with +/-0.5 bands, and a fixed-slope equal-total
  line. A 15-match rolling window for early season was considered and
  rejected: the ratings already carry over and adjust for opponents, and a
  separate number would disagree with the rest of the site. Follows the
  rewind slider; a click opens the club.
- **Season mountain** (`viz=mountain`): the prototype below, ported into
  `app.js`. Layers come from files the site already has: the pre-season view
  (see "Pre-season view") as flat ground tiles with no height, then one
  rewound matchday report per "~ round k" standing on it (cached per URL; both
  leagues are in each file), then "now". Meshed as a voxel surface (only faces
  open to the air) with baked per-corner ambient occlusion (`MOUNTAIN_AO`);
  layers 0.3 high; club names printed flat on the floor so they never swing
  into each other. three.js r147 is vendored in `public/vendor/three/` and
  fetched only when the mountain opens. Controls: division and season pickers
  (through the hero's own switches; on phones they replace the hero row), row
  order (predicted finish
  by default / pre-season / table; "Sluttabell" and no table button once a
  season is over), build-up slider with play, cut-off (0.5 % by default),
  vertical cut to one club and/or one place. The camera glides to the middle
  of the wall a cut leaves (its blocks' bounding box) and moves in to fit it.
  On desktop, opening it (from the gallery or a fresh link, not a reload)
  glides the page down to it; on phones it fills the screen between the bars
  with the page locked and the extras hidden (`fitMountain`).
- **Key figures** under each visualisation (`exploreFacts`): a number, a
  title and one sentence on reading it, recomputed with league, season and
  rewind. Attack: trend slope, correlation, most attack-led and defence-led
  club. Mountain (bottom layer vs the top one built, whole division, cut
  ignored): possible places per club (>= 5 %), the pre-season favourite's
  title chance then and now, biggest climber and faller by expected finish,
  surest outcome. When the top layer is a finished season's final table they
  become a scorecard for the pre-season prediction: hit rate (finished within
  two places of the expected finish), favourite's chance -> final place,
  climber and faller as predicted -> finished, and the biggest surprise (the
  final place with the smallest pre-season chance). The mountain's ⓘ button
  opens them in a `<dialog>`; the phone layout has no other way to them.

Original prototype notes:

A possible future view where users explore the model's output in less
conventional visualisations. First candidate, built as a one-off prototype:
the **season mountain** (`experiments/season_mountain/`). The floor is the
site's position grid (team rows, places 1-16 across, bands along the top
edge); each round stacks another layer of position probabilities on top, from
a rewound pre-season report to the final table. Unlikely cells fade along the
site's `--seq` ramp (blended smoothly between the `HEAT_STOPS`) and cells under
a cut-off are dropped, so the stack narrows into the final table. Controls:
season (2015 to now), league, rows by pre-season prediction or final table,
build-up slider with play, cut-off, layer height, colour by probability or
team, full or probability-sized blocks. three.js from jsDelivr, one
self-contained page:
`python experiments/season_mountain/build.py` -> `build/season-mountain.html`
(needs `public/data` built).

Layer k is the first matchday with 8k matches played, so it is "about round
k": a postponed match counts when it was played, teams within a layer can have
games in hand, and a busy weekend can overshoot the count. Kept as is; if this
ships, label layers by matches played (or "~ round k") rather than as rounds.
Not wired into the site; it would need the per-round layers from the build
rather than its own extraction, and a lighter payload (1.2 MB for all seasons).
(Shipped since without either: the site version fetches the per-round rewound
reports it needs and caches them.)

## Pre-season view (October 2026) - shipped

Every season has a view dated the day before either division's first match
(`pipeline.preseason_date`, carried as `league.preseason` in every report):
the prediction before a ball was kicked, built by `build_site` like any other
rewound date. It is the rewind slider's first stop ("Spådom før sesongen"),
so the grid and ladder playback start from it; the hero then reads "Før
første kamp gjør modellen X til favoritt" instead of naming an alphabetical
"leader" on 0 points; and it is the season mountain's ground. No
`MODEL_VERSION` bump (no prediction changed, there is one more view), but the
pipeline source changed, so every view's stamp did: the next full build
rebuilds everything. Past seasons get the view when the `past-seasons`
workflow is rerun; until then a build without the field simply has no
pre-season stop.

## Explore: candidate visualisations - ideas

Each is buildable from data the site already ships (a report per matchday,
`careers.json`), so none needs a pipeline change unless noted. Rough order of
value for effort.

1. **Prediction scorecard across seasons.** Pre-season expected finish
   against final place for every club and season 2015-2026, one dot each, a
   y = x line, and per season the hit rate the mountain already computes. Data:
   the pre-season view and the final table per season (needs the past-seasons
   rerun for the pre-season views). Answers "how good is the model before a
   ball is kicked", which the model card only states in log loss.
2. **Race lines.** A club's chance of each race (title, Europe, promotion,
   relegation) over the season as lines, one per club in the race, from the
   pre-season stop to now. Data: the per-matchday rewound reports the mountain
   and the grid playback already fetch. The race-over-time view the grid
   playback shows frame by frame, in one picture.
3. **Luck table (points vs xPts from xG).** Actual points against the points
   each club's per-match xG would have earned on average (Poisson on
   `results[].xg`, computed in the browser), as a diverging bar per club.
   Shows who is riding finishing or goalkeeping, the thing xG form hints at.
4. **Run-in heatmap.** Clubs down, remaining fixtures across, each cell the
   club's win chance (`fixtures[].home_win / away_win`), sorted by fixture
   difficulty. Makes the Fix Diff column visible match by match.
5. **The lift between the divisions ("Heisen").** Every club's division each
   season 2015-2026 as lanes, with promotions and relegations as flows between
   them (a small Sankey or a lane chart). Data: `careers.json` seasons
   (league per season). Cheap and very Norwegian-football.
6. **Rating river / bump chart.** All clubs' Elo since 2015 on one axis (both
   divisions, as the ladder does), ranks swapping over time; hover a club to
   lift its line out. Data: `careers.json` points.
7. **Head-to-head matrix.** All-time results between every pair of clubs as a
   grid (cell = points per match for the row club), from
   `careers.head_to_head` (773 pairs). Compare Clubs shows one pair; this
   shows bogey teams across the league.
8. **Scorelines: predicted vs actual.** The league's most likely scorelines
   summed over `fixtures[].scorelines` next to how often each scoreline has
   actually happened in `results`. A calibration check readers can see.
9. **Stakes calendar.** Remaining rounds across, races down, each cell how
   much the decisive matches that round swing the race (`high_stakes`
   `swing`). Shows when a season will be decided. Small data, late-season
   only.
10. **Match-odds calibration.** A reliability diagram of pre-match odds
    against outcomes across all seasons. Needs a small export from the
    backtest (`backtest_cli`), since reports do not keep pre-match odds for
    played matches; the only idea here that touches the Python side.


## ?? Matches view; team view rows; readable charts (October 2026) - shipped

**Matches.** Next Up and Played Results are one view: a week a page on one
timeline, Prev back in time and Next forward (as on FotMob), opening on the
week of the next fixture. A part-played week shows its results and the matches
still to play under their own headings. `?view=next-up` / `?view=played` links
land on it. The freed phone-bar slot holds Ladder.

**Team view rows.** Fixtures and results are compact rows from the club's
side (date, H/A, opponent, then win/draw/loss odds or W/D/L, score, xG and
rating change) instead of the league-wide cards that repeated the club's own
name and rating each row. The decisive dot is a shared `stakeDot`.

**Charts.** Season shape colours each place by its band (the table markers'
colours, fading within a band, neutral mid-table) with a legend underneath;
the dashed edge lines and their colliding labels are gone, and month labels
skip one that would overlap. The rating history gets a phone-width viewBox
(100-point ticks, '16 labels) like the season shape. The jsdom smoke test
(`tests/season-shape.dom.js`) checks colours and legend instead of edges.

## elo-v12.2: the season simulation on NumPy (October 2026) - shipped

The Monte Carlo in `simulation.season` was ~98% of building a report (profiled:
12.8 s of 13.0 s for a rewound view under cProfile). It now runs a chunk of
1,000 runs at a time as arrays: strength shocks per run and club, outcome rolls
per run and fixture, scorelines drawn from Walker alias tables (two lookups
per draw; built for every fixture's three tables at once, padded to one width
of 36), per-club points and goals by a matrix
product with a fixture-club incidence matrix (float, so it runs on BLAS; the
integer product was half the time), one sort per run on the same packed key,
and the tallies by `bincount`. The scoring grids (`_fixtures`) are arrays too:
every fixture's Poisson grid with the Dixon-Coles correction, blend and
per-outcome tables at once (the 9x9 grid splits into the same 36 home-win, 9
draw and 36 away-win cells for every fixture, so the tables need no padding).
The season-shape snapshots skip the per-fixture
branch tallies (`tally_conditionals=False`), which only the high-stakes swings
read. `build_site` pins BLAS to one thread per worker.

Same model and same draws per run, different random stream: at 200,000 runs
against the pure-Python loop the worst of 256 cells differed by 0.34 pp
(median 0.01 pp) in Eliteserien and 0.30 pp in OBOS-ligaen, expected points by
at most 0.10, i.e. Monte Carlo noise. Hence the version bump with no model
change. Speed, on an 8-core/16-thread Ryzen AI 7 350:

| | pure Python | NumPy |
|---|---|---|
| rewound view, one process | 6.5 s | 1.0 s |
| 200,000 runs, one league | 9.5 s | 1.7 s |
| season 2025 (96 views), 16 workers | 91 s | 45 s |
| same, 8 workers | | 38 s |

The parallel gain is smaller than the single-process one because the second
hardware thread per core helped the interpreter loop and does nothing for
array code; `--jobs 8` is the better setting on this machine. With every core
busy a view costs about 2.5x what it does alone (clocks drop, memory bandwidth
is shared); recycling workers less often (25 views instead of 2) changed
nothing, so it stays. The alias tables took a quarter off a single view
(1.3 s -> 1.0 s) but not off this parallel build, for the same reason; on
fewer cores (CI) the single-view gain is what counts.

NumPy is the first dependency added under the new rule that each one is
justified where it is declared (`pyproject.toml`; see AGENTS.md).

## ?? elo-v12.1: head-to-head tiebreak; team view pass (October 2026) - shipped

**Tiebreak.** Eliteserien ranks on points, goal difference, goals scored, then
head-to-head. `model.table` broke the last tie on team name, so Bodø/Glimt led
Viking on identical lines (17-2-3, 56-20) although Viking won their meeting 5-0.
Level clubs are now ordered by a mini-table of their meetings (points, GD,
goals). The simulation's final tiebreak follows the live table's order, hence
the version bump; ratings and match odds are unchanged.

**Trend arrow.** Back to rating change (it had become xG form): the total over
the last 5 matches, steady within ±8, fast beyond ±20. Window tested on every
club-season since 2015: 5 agrees best with the table's 5-match form column
(r 0.85; 3: 0.65, 8: 0.73) and flips rise<->fall between matches 2.5% of the
time. xG form stays in the team view as its own labelled line (the signal that
looks ahead, r ~0.17).

**Team view.** League hero reduced to its pickers; an Outlook row (likeliest
finish, expected points, chance of each race >= 1%, pre-season call as one line)
replaces the Prediction card; stake lines read "Title 31% -> 35% with a win vs X
· 16% with a loss", decisive ones dated; season list has column headings and a
"now" marker; team pagers say Older/Newer and Earlier/Later. Site-wide: hero
vitals hidden on phones; Next Up legend explains the decisive dots; dots and
team-view readouts work on touch (tap raises, next tap elsewhere clears).

## ?? European places from Norway's UEFA rank (October 2026) - shipped

Audited `_ELITESERIEN_EUROPE` against every season's final table (Wikipedia
table notes). Convention: league places only; a cup spot passed down the table
(cup winner already qualified) is left out. 2016 and 2018 broke it (Rosenborg
doubles, 4th in via the cup) and are now EL 2-3, like 2015 and 2021. 2020 keeps
ECL 2-4: no cup that year.

From 2023 the places are derived, not hand-written: `_europe_by_rank(rank)`
encodes the access list in force since 2024-25 (ranks 7-12: CL 1-2, EL 3,
ECL 4; 13-15: CL 1-2, ECL 3-4; 16-50: CL 1, ECL 2-3), checked against 2023
(rank 16), 2024 (14), 2025 (11) and 2026 (14). Season S uses UEFA's ranking at
the end of the European season ending in S (`seasonYear=S` in UEFA's keyless
coefficients API), provisional until June. `refresh` stores it hourly in
`data/normalized/uefa_ranks.json` until a stored rank reaches August, then stops
asking; failures and unmodelled ranks are non-fatal (newest known rank is
used). The build stamp includes the bands, so a rank change rebuilds views.
Manual step left: when UEFA changes the access list, update `_europe_by_rank`.

## ?? Season shape: all threshold edges, short labels, per-league colours (October 2026) - shipped

The season-shape chart drew one European edge only (the lowest europe band,
so only "Conference League qualification" showed) with the full i18n band
name and the generic good/bad colours. Frontend-only (`public/app.js`,
`i18n.js`, `styles.css`; no `MODEL_VERSION` bump).

- **Every threshold now draws**: all `tone === "europe"` bands plus the
  `tone === "top"` band (CL for Eliteserien, direct Promotion for OBOS), then
  Relegation as before - same `edge = band.last` / `band.first - 1` maths and
  the same `<0.1`/`>0.9` drop rule. Handles 1-3 European bands per season
  (2026 is CL + Conference only; 2025 adds Europa). OBOS is unchanged:
  Promotion + Relegation.
- **Short line labels**: new `band.edge.CL/EL/ECL` keys - EN "CL quali" /
  "EL quali" / "ECL quali", NO "CL-kvalik" / "EL-kvalik" / "ECL-kvalik" -
  via `bandEdgeName()`; tooltips and aria keep the full `bandName`. Promotion
  and Relegation keep their (already short) full names.
- **Colours**: CL = `--outcome-good` blue, EL = orange (`#e07b1f` light /
  `#f09c3a` dark), ECL = green (`#1e8a49` light / `#4ade80` dark) as
  `--edge-*` tokens; all �4.5:1 as label text on the chart surface in both
  themes. `--good`/`--bad` remain for OBOS promotion/relegation.
- **Label collisions**: good-edge labels stack with a 10px min gap
  (CL/EL/ECL/Promotion order), no text measuring.

Validation: node 13/13, pytest 276, build_site 80 views.

## ?? High-stakes matches: swing-based decisive fixtures (October 2026) - shipped

For each club that genuinely contests a band (title, qualification spot, or
relegation), the report now exposes the single remaining fixture whose result
swings that club's band probability the most — the "deciding match". Shipped
across backend (`src/elitetracker/simulation/season.py`, `src/elitetracker/pipeline.py`)
and frontend (`public/app.js`, `i18n.js`, `styles.css`).

**Statistic.** For club C, remaining fixture f, target band B:
- `p_favourable` = P(C finishes inside B | C wins f) for getting-in bands
  (champion, top, europe, playoff), or P(C finishes inside B | C loses f) for
  the relegation band (where a loss brings it closer).
- `p_unfavourable` = the opposite outcome.
- **swing** = p_favourable − p_unfavourable (always positive = the favourable
  outcome helps).

Only clubs with unconditional `P(in band) ≥ 0.10` are considered contenders.
A minimum branch count of 500 runs per outcome (1% of the 50k runs) guards
against Monte Carlo noise.

**Pairing collapse.** Norwegian leagues play a double round-robin; the two legs
of a pairing carry identical points and near-identical win probability. Their
swings differ by a median of 0.015 — 70% of pairings sit within 0.02. The
higher-swing leg is chosen as the headline match; both legs' dates and IDs are
recorded.

**Threshold.** `MIN_SWING = 0.25` (25 pp), and badges only in the run-in
(`RUN_IN_ROUNDS = 10`: no entries while more than ten rounds of fixtures
remain). See "Threshold tuning" below.

**Output.** Top-level `report.high_stakes` array (sorted by swing desc) and
per-club `high_stakes_match_ids` in the table payload. Each entry carries:
`team_id`, `team`, `band_label`, `band_tone`, `band_first/last`, the chosen
`match_id` + both `leg_match_ids`, `date`, `opponent`, `home_id/away_id`,
`p_baseline`, `p_favourable`, `p_unfavourable`, `swing` (all 4dp).

**Frontend.** Three surfaces:
- **Next Up / team fixtures**: a `stake-flag` badge on the fixture card showing
  a tone dot and "Decisive for Club (Band)" — merged when multiple clubs share
  a fixture.
- **Team view**: one line per own stake — tone dot + consequence sentence
  ("Win vs X and the Title chance is 92% / Lose and it falls to 31%") + both
  leg dates.
- **Model Card**: honest explanation — "Even a large swing is only the gap
  between two simulated chances, not a guarantee; the two legs count almost the
  same, so the more decisive leg is the one named."

**Band labels.** Badges use `bandEdgeName()`: CL/EL/ECL quali, Title (for the
champion band), Relegation — never the generic "Europe".

**Relegation orientation.** The favourable outcome is a *loss*; the badge reads
"Lose vs X and the Relegation chance is 78% / Win and it falls to 31%".
Orientation is explicit in the payload: `p_favourable` is always P(inside band |
favourable outcome), with favourable = loss for `relegation` tone.

**Threshold tuning (revised October 2026).** Backtested on 2015-2025, both
leagues, 490 rewound snapshots (every other matchday from a third of the season
in, 10k runs). Ground truth per candidate: holding every other real result,
would winning 1-0 vs losing 0-1 have changed the club's band? The swing is
calibrated against that from ~0.25 up (0.34 -> 34% decisive, 0.44 -> 45%), so
the threshold is the minimum chance a badged match really decides the band.
- F1-optimal T is 0.15 (stable leave-one-season-out) but useless: ~7 badges a
  week at 19% precision against a 17% base rate.
- Before ~10 rounds remain, nothing is knowably decisive: badged next-week
  fixtures were decisive no more often than any other (lift <= 1.0x), and the
  swing ranks fixtures no better than chance (AUC ~0.5 within a week).
- With <= 5 rounds left the week's top fixture is decisive 45% vs 27%.
- Rejected: "match of the week" top-k (alive all season but noise early),
  swing relative to the club's own average (near-dead, weak), and removing the
  strength-shock confound from the conditionals (real but small: +2-3 pp
  precision, no ranking gain, costs a second simulation pass).
- Chosen: T=0.25 gated to the last 10 rounds. Run-in weeks with a badge
  72% -> 86%, precision 43% -> 38% (1.6x lift); removes the early-season badges
  (7% of weeks, 16% precision = noise).

**Next-match line.** `report.next_stakes`: per club, its next fixture (by date)
and the contended band it moves most, same entry shape as `high_stakes`, shown
all season in the team view above the decisive list (skipped below a 5 pp swing
or when the same match/band is already listed as decisive). It claims only the
two conditional chances, not decisiveness, so it needs no backtest gate.

**Tests.** 11 new pytest tests (`tests/test_high_stakes.py`): orientation
(getting-in vs relegation), pairing collapse (higher-swing leg chosen),
MIN_BAND_P filter, MIN_BRANCH guard, determinism, branch-sum invariant
(three outcome branches sum exactly to run count). All 331 Python + 25
frontend tests pass.

**Performance.** 50k runs: +27.7% live state (1.58s → 2.02s), +39.3% full
season (4.21s → 5.87s). End-to-end `build_report` +32% (13.1s → 17.4s)
because the 20 history snapshots (10k runs each) also pay the tally cost.
A skip flag for callers that don't need conditionals would recover most of
this if the "always compute" pin is revisited.

**No MODEL_VERSION bump.** The simulation's position probabilities are
byte-identical; the feature is a derived view on existing Monte Carlo runs.

**Files.** `src/elitetracker/simulation/season.py`, `src/elitetracker/pipeline.py`,
`tests/test_high_stakes.py` (new), `public/app.js`, `public/i18n.js`,
`public/styles.css`, `tests/frontend.test.js`.