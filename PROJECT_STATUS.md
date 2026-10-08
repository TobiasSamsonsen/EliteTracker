ladder phone list, played-card xG, three Compare blocks incl. real head-to-head,
Model Card strength-shock row, team-view summary bullets, and a rewritten
"Key stats explained" (xPts = simulation mean, attack/defence = �% display of
the rates, xG-form trend thresholds).

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

**Threshold.** `MIN_SWING = 0.30` (30 pp). Only fixtures moving the band chance
by ≥30 pp are shown. At this level, a typical live Eliteserien state yields
~8 decisive matches out of ~70 remaining — signal over noise.

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

**Threshold tuning.** Swept 0.10 → 0.30. At 0.25 → ~34 matches; at 0.30 → 8
matches (11% of remaining). 0.30 chosen as the sweet spot where the feature
stops drowning in noise and only shows genuinely decisive fixtures.

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