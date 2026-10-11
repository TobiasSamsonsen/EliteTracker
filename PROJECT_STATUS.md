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