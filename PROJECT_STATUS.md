# Project Status

Decision log and research notes. What the code does and how to run it lives in
`AGENTS.md`; this file records *why* the numbers are what they are and what was tried
and rejected, so nobody re-runs a dead experiment.

## ⚠️ Decisions worth knowing

**parse.bot is gone.** The original scraper 404s for every tournament with a valid key.
fotmob replaced it; on Eliteserien 2026 the two sources agreed on every played result and
fixture date before the switch. `API_KEY` / `.env` are unused.

**elo-v2 changes predictions.** Ratings used to be re-seeded from the previous season's
final table. They are now one continuous replay from 2014, which is what makes a rating
history meaningful. It also changes who the model favours: with 11 years of evidence
Bodø/Glimt (1850) lead Eliteserien 2026 ahead of Viking (1830), where the old
single-season seeding had Viking on top.

**Ratings are not capped at 1700.** The seed ladder range (currently 1670–1330, fit by
backtest) is honoured by the *initial* seeding; a free-running ELO then moves beyond it.
Bodø/Glimt's climb from 1508 in 2015 to 1850 today is the model working, not drifting.

**Season shape is sampled by date, not by round.** Rounds are not chronological — the
furthest round reached jumps from 4 on 11 April 2026 to 15 on 15 April — so a round axis
would show results before they happened.

**Abandoned fixtures are dropped.** Eliteserien 2024 lists both the abandoned Rosenborg v
Lillestrøm of 21 July and its replay on 21 August, so the raw feed has 241 rows for a
240-match season.

**Rating trend uses a weighted average of the last 6 matches.** The table and team focus
arrows no longer use the simple delta between the current rating and the rating five
matches ago. Instead, each of the last 6 rating changes is weighted linearly
([0.1, 0.2, 0.3, 0.4, 0.5, 0.6] from oldest to newest) and divided by the weight sum
(2.1), so the result stays on the same per-match scale as the old diff. Thresholds were
re-tuned on the full replay corpus (48 teams, 11,568 matches): >6 strong rise, >1.5 rise,
>=-1.5 steady, >=-6 fall, otherwise strong fall. This produced a balanced spread across
the five categories (roughly 15-27% each) instead of most teams landing on steady.
The weighting is deliberately flatter than an exponential decay — recent matches matter
more, but a single outlier result cannot dominate the arrow.

## 🏷️ Model versions

`MODEL_VERSION` (`model/elo.py`) is `elo-vMAJOR.MINOR`, one bump per release
(a deployed change set), never per working step; rejected or unreleased work
takes no number. A release takes the largest bump any of its changes needs:

- **MAJOR** -- the ratings or the match odds change: a new model term, a refit
  constant, new data the model reads.
- **MINOR** -- ratings and match odds unchanged, the season simulation's
  published chances move: a simulation rule (tiebreak, play-offs, strength
  shock), the run count, the random stream.
- **none** -- nothing the model publishes changes: new fields derived from
  unchanged numbers, presentation, documentation, data parsed but not read.

Written down in October 2026. Every published version, from git, with the kind
of change it was under these rules; the numbers stay as published (archived
reports and `careers.json` carry them).

| version | released | commit | kind | what changed |
|---|---|---|---|---|
| elo-v1 | 2026-08-09 | 2132d1e | first | seeded from the final tables, Elo replay, match odds, season Monte Carlo |
| elo-v2 | 2026-08-09 | 32110a7 | major | one continuous replay from 2014 instead of re-seeding every season |
| elo-v3 | 2026-08-09 | 1d067ec | major | draw model refit, 0.22/250 -> 0.26/375 (ratings unchanged, odds changed) |
| -- | 2026-08-09 | e827d6b, b07ea7f | minor, not bumped | simulation runs 10,000 -> 200,000 -> 50,000 |
| elo-v4 | -- | never committed | -- | squad strength (injuries, lineups): investigated and rejected, yet given a number |
| elo-v5 | 2026-08-27 | 7f27347 | major | home advantage 75 -> 60, cross-season regression, gap-conditioned scorelines |
| -- | 2026-08-28 | 5083ab8 | minor, not bumped | rewound views simulated at 10,000 runs |
| elo-v6 | 2026-08-29 | 9c4ce9f | major | regression per division; seed ladder and regression refit together |
| elo-v7 | 2026-09-11 | 601437e | major | attack/defence goals model on xG; odds blended 50/50; its grid for scorelines |
| elo-v8 | 2026-09-13 | 85196ea | major | xG-informed Elo update (alpha 0.45); blend refit to 25/75 |
| elo-v9 | 2026-09-13 | 64b2928 | major | season-level finishing quality |
| elo-v10 | 2026-09-16 | 5d77044 | major | era-switched Elo, K 35 and alpha 0.50 from 2022 |
| elo-v11 | 2026-09-16 | 5d6d5e3 | major | OBOS-ligaen xG from Sofascore; served ratings = the model's; era per match |
| elo-v11.1 | 2026-09-16 | 1b73aa0 | major, numbered minor | modern K 35 -> 30, alpha 0.50 -> 0.30: every rating moved |
| elo-v12.0 | 2026-09-25 | 9724223 | major | xG margin in the Elo update, goals-model spread 1.10, strength shock 0.15 |
| elo-v12.1 | 2026-10-11 | 8e7c30c | minor | head-to-head tiebreak in the table and the simulation |
| elo-v12.2 | 2026-10-13 | fbbc061 | minor | season simulation on NumPy (a new random stream) |
| elo-v13.0 | 2026-10-16 | 28e49b1 | major | xG margin signed by xG; exact xG-implied score; squad-value offseason pull; early-season step; strength shock 0.20; surface edge in Eliteserien; play-offs simulated |
| elo-v14.0 | 2026-10-16 | 3909841 | major | keeping (xG on target, a club's last 45 matches) as the goals model's fourth part, its chances learnt 90 % from xG; the offseason pull per division (OBOS-ligaen 0.75 / 0.3); surface edge 10 -> 20 |
| elo-v15.0 | 2026-10-17 | adc21db | major | a club relegated into OBOS-ligaen keeps half its distance from the division's mean, toward a target set by its squad value (Elo 75 points per log value, its first use of squad values; the goals model its own value pull) |
| elo-v16.0 | 2026-10-17 | b571718 | major | the xG margin unclamped and 0.10 -> 0.12; late-season table stakes on the prediction (`model.stakes`), the season simulation reading them from each run's own table -- **the deployed version** |

Unbumped commits that only added output fields (`position_points`, projected
goals, high-stakes swings, the pre-season view) or touched presentation were
right not to bump. elo-v13.0 was worked on as "v13.0" and then "v13.1" in the
working tree before these rules existed; as one release it is one number.

**Every version on the same matches (October 2026).**
`experiments/improvements/version_history.py` replays each release with its
own `src` (a git worktree of the commit above) on today's data, walk-forward,
and scores all of them on the same 4,800 matches 2016-2025 (both divisions);
the result is `data/model_versions.json`, which `calibration_payload` passes
to the model accuracy view (rerun it after each release: `predict` once per
version, then `combine`). v1 is seeded each season from the season before's
table, v2-v6 run the careers (the production path), v7-v12 the Elo/goals blend
the way each version's `research.cmd_run` scored it, v13 on `shipped_cards`.
Better than base rates = 1 - log loss / 1.06202 (always the overall home/draw/away
shares; the xG seasons -- the 2,140 matches with xG, Eliteserien
from 2020 and OBOS-ligaen from 2023 -- 1.06251; Eliteserien 1.05915). The closing line (power method) on the same
2,400 Eliteserien matches: 0.98758, 6.8 % better than base rates.

| version | log loss, all | better than base rates | Eliteserien | xG seasons | step on the version before (t) |
|---|---|---|---|---|---|
| elo-v1 | 1.03505 | 2.5 % | 3.0 % | 3.8 % | -- |
| elo-v2 | 1.03235 | 2.8 % | 2.6 % | 3.5 % | -0.00270 (-1.21) |
| elo-v3 | 1.01294 | 4.6 % | 4.7 % | 5.2 % | -0.01941 (-6.88) |
| elo-v5 | 1.01020 | 4.9 % | 5.0 % | 5.7 % | -0.00274 (-2.82) |
| elo-v6 | 1.01019 | 4.9 % | 5.0 % | 5.7 % | -0.00001 (-0.03) |
| elo-v7 | 1.00570 | 5.3 % | 5.5 % | 6.6 % | -0.00449 (-4.47) |
| elo-v8 | 1.00554 | 5.3 % | 5.5 % | 6.8 % | -0.00017 (-0.29) |
| elo-v9 | 1.00514 | 5.4 % | 5.6 % | 6.9 % | -0.00040 (-1.03) |
| elo-v10 | 1.00476 | 5.4 % | 5.7 % | 7.0 % | -0.00037 (-2.31) |
| elo-v11 | 1.00476 | 5.4 % | 5.7 % | 7.0 % | +0.00000 (+0.00) |
| elo-v11.1 | 1.00483 | 5.4 % | 5.7 % | 7.0 % | +0.00007 (+1.07) |
| elo-v12.0 | 1.00386 | 5.5 % | 5.7 % | 7.1 % | -0.00097 (-3.12) |
| elo-v13.0 | 1.00252 | 5.6 % | 5.8 % | 7.2 % | -0.00135 (-3.64) |
| elo-v14.0 | 1.00062 | 5.8 % | 6.0 % | 7.4 % | -0.00190 (-3.99) |
| elo-v15.0 | 1.00030 | 5.8 % | 6.0 % | 7.3 % | -0.00032 (-1.60) |
| elo-v16.0 | 0.99966 | 5.9 % | 6.0 % | 7.4 % | -0.00064 (-2.60) |

elo-v11 shows nothing because its gain was data (OBOS-ligaen xG), which every
version reads here; elo-v10 needed its era switch passed explicitly, as its
production did. From elo-v1 to elo-v16.0 the model closed
81 % of its gap to the closing line on Eliteserien.
The xG seasons gain the most (3.8 % -> 7.4 %; the jump at elo-v7, the goals
model on xG), and their line ends above the closing line's, but that line is
Eliteserien over every season. Like for like, on Eliteserien's
1,440 xG-season matches: elo-v16.0 8.0 % better than base rates, the
closing line 8.3 %; the gap there is about half the 2016-2025 one.
The chart pairs the lines that way: its xG line is Eliteserien's xG seasons
(no OBOS-ligaen odds here), each Eliteserien line with a dashed closing line
in its colour on the same matches; both divisions' xG seasons stay a key
figure.

## 🔬 elo-v3: what the backtest found

Fitted with `model/backtest.py` on 2019-2026 (3,623 scored matches, walk-forward, no
leakage). Baseline elo-v2 scored 1.01754 log loss against 1.06015 for a constant
base-rate predictor — a real but thin edge — while its calibration error was 0.0396
against the constant model's 0.0043. That pointed at the probability mapping, not the
ratings, and that is where the whole gain turned out to be.

**Shipped: the draw model, refitted.** `draw_base` 0.22 → 0.26, `draw_scale` 250 → 375.

| | log loss | Brier | hit | calibration |
|---|---|---|---|---|
| elo-v2 | 1.01754 | 0.60443 | 51.97% | 0.0396 |
| elo-v3 | **1.00173** | 0.59819 | 51.97% | **0.0154** |

−0.0158 log loss, paired t = −4.98, and it holds in both halves (−0.0202 on 2019-2022,
−0.0109 on 2023-2026). The hit rate does not move: every bit of the gain is calibration,
none is better discrimination. **Ratings are byte-identical to elo-v2** — this is a
probability-only version bump, so stored ratings and career histories are untouched.

The old constants came from eyeballing 255 matches of a single part-season, which made the
draw model far too narrow.

**Tested and rejected — each of these looked good until it was measured properly:**

- **Margin of victory** (538-style damped log, plain log, √, linear caps, over a 120-cell
  K grid). Every form was *worse* than the baseline at its own best K. Norwegian margins
  are mostly noise: of 5,543 matches, 1,323 were draws and 2,060 were one-goal games, with
  only 159 at 5+ goals.
- **Goals as repeated mini-contests.** Tested literally, 84 settings, including fixes for
  the 0-0 problem (a goalless draw otherwise produces *no update at all*) and both
  sequential and simultaneous variants. Best solo result −0.0036 at t = −1.56, and its own
  control showed ~87% of that was recalibration rather than the goal information. Stacked
  on the final config it is **+0.0018 worse**. Algebraically it reduces to a goal-difference
  ELO, and 8.3% of its updates move the match *winner* down.
- **Home advantage 75 → 50** and **inter-season regression to the mean (0.15)**. Both real
  against elo-v2 in isolation, but ~90% redundant with the draw fix: marginal t = −0.46 and
  −0.16 once the mapping is refitted, and the sign flips between halves.
- **The autocorrelation damper** was the clearest trap: worth −0.0030 alone, but
  **+0.0031 worse** inside the stack (t = +3.40). It is a duplicate of the calibration fix
  and overshoots into under-confidence.
- Also rejected: dynamic K, EWMA form, per-league / per-season / per-team home advantage
  (including a COVID-seasons term — even an oracle version hurt).

The lesson worth keeping: four of these looked like wins against elo-v2 alone, and three
of them were the same calibration fix in disguise. Anything proposed next has to be
measured *marginally*, with the mapping refitted on both sides.

## 🎲 How many simulations a season needs

Measured, not guessed. Monte Carlo error falls as 1/√N, so the question is where it stops
mattering — and that is set by the model's own accuracy, not by the arithmetic. elo-v3's
calibration error is **1.54 percentage points**; sampling error well under a fifth of that
is already invisible.

Worst single grid cell, against a 4,000,000-run reference (Eliteserien 2026, 111 fixtures
remaining, six seeds per row):

| simulations | RMS error | worst cell | title % error | time per league |
|---|---|---|---|---|
| 10,000 | 0.209 pp | 1.31 pp | 0.54 pp | 0.07 s |
| 50,000 | 0.096 pp | 0.50 pp | 0.40 pp | 0.37 s |
| **200,000** | **0.045 pp** | **0.23 pp** | **0.17 pp** | **1.43 s** |
| 1,000,000 | 0.022 pp | 0.11 pp | 0.07 pp | 7.2 s |
| 10,000,000 | ~0.007 pp | ~0.04 pp | ~0.02 pp | ~72 s |

**Settled on 50,000** for the live projection. Its worst cell is 0.50pp — a third of the
model's own error, and half of one displayed digit now that the table rounds to whole
percent. Past that, each halving of sampling error costs four times the wait and buys
precision beneath both the display and the model. 10,000,000 would be two orders of
magnitude finer than the model can justify, for two hundred times the wait.

Also set from the same curve: **10,000** per history snapshot (a trend line read off a
chart, ~20 per league). Rewound views cut both the history to 2,500 × 8 *and* the grid to
10,000 (see the note under "Monte Carlo error" above) — otherwise a rewound day costs six
seconds instead of one and a half. They are cached per date. Start-up is 5.1s; a rewound
day builds in ~1.8s at the old 50,000 grid, and faster now that the rewound grid is 10,000.

The simulation loop works on integer indices with a single packed sort key. Drawing a
scoreline per match (see `model/scorelines.py`) adds one RNG draw and a goal-difference
update per fixture, so throughput is now ~28k runs/second — 50,000 runs still finishes a
league in ~1.8s. Against a 1,000,000-run reference the worst grid cell at 50,000 is
**0.45pp**, a third of the model's 1.54pp calibration error, so the count is unchanged.

The table's title and relegation columns print **whole percent**. Sampling error at 50,000
is ±0.50pp and the model's calibration error is ±1.54pp, so a tenth of a percent there was
noise dressed as precision, and no achievable simulation count would have fixed it. The
em-dash threshold follows the precision, so a value that would round to a bare `0%` shows
as nothing instead.

Rewound views (the `?asof=` slider and the static rewind reports) use a **10,000-run** grid
plus a 2,500 x 8 history, not the live 50,000. At 10,000 the worst grid cell is ~1.31pp --
still under the model's 1.54pp calibration error -- so dragging back loses no visible
fidelity, while the ~2,266 rewound reports build roughly 5x faster. The live view keeps
50,000 for full precision. (See `pipeline.rewound_configs`.)

## 🩹 elo-v4: squad strength — investigated and rejected

The proposal: rate a club lower for a match when its best players are injured, suspended
or sold. Investigated properly — a full lineup corpus was fetched (**5,542 of 5,544
matches, both divisions, 2015–2026, 100% coverage of both starting elevens**) and three
formulations were backtested. All three failed, and a ceiling calculation says no version
of this could have worked on this data.

**The ceiling is the whole answer.** A squad-strength term shifts a club's effective
rating by some amount each match; the spread of that shift caps what it can buy. Injecting
a *random* shift of the same spread measures the cap directly, because a perfectly
informative adjustment gains at most what a random one of the same size loses:

| shift spread | ceiling on the gain | what it corresponds to |
|---|---|---|
| 5.5 Elo | 0.00018 | inferred player ability (ridge-APM) |
| 8.6 Elo | 0.00055 | the injury list — the deployable version |
| 13.8 Elo | 0.00161 | value of the starting XI, squad wealth removed |
| 17.0 Elo | 0.00252 | value of the XI, best case and leaky |
| — | **0.00635** | **minimum detectable effect (t = 2, n = 3,624)** |

Knowing the exact starting eleven of both sides, perfectly, is worth at most **0.0025**
log loss — about **40% of what it would take to distinguish from noise**, and a sixth of
what the elo-v3 draw refit was worth. The deployable version, knowing only who is unfit,
tops out at **0.00055**: 9% of the detection floor. The reason is that the scenario is
rare — 67% of team-sides have nobody from their top five missing, and only 1.4% have three
or more out.

**Measured results, all three negative:**

- **Inferred player ability** (ridge-regularised adjusted plus-minus over the corpus, no
  external data, no anachronism): honest walk-forward **+0.0050 worse**, in both halves,
  hit rate 0.5197 → 0.5124.
- **Market value of the XI**: a real, correctly-signed effect (t = +3.15) but only 17 Elo
  of spread on 22.5% coverage, best Δ = −0.0014 with a confidence interval spanning zero,
  and the sign flips between halves. Leaky by construction: fotmob serves one present-day
  value per player, so the anachronism premium can never be measured away.
- **Injury list**: holdout **+0.0028 worse**, and the feed is provably back-stamped —
  41.9% of `unavailable` entries name a player whose first appearance for that club comes
  a median **545 days later**. It is reconstructed after the fact, not as it stood.

**It is also unshippable regardless.** Upcoming fixtures return `lineupType: "unavailable"`
with an empty `starters` list — the eleven does not exist until about an hour before
kickoff. The site projects ~111 remaining fixtures, so the adjustment would be zero for
every one of them.

Sample size needed to detect the best (leaky) effect at t = 3: **n ≈ 12,950**. The entire
replayable history of both Norwegian divisions since 2015 is 5,542 matches.

By-product worth remembering: `https://www.fotmob.com/api/data/matchDetails?matchId=<id>`
returns the same content as the match page at 313 kB against 1.19 MB — roughly a quarter
the bytes, and far less gzipped. Nothing currently fetches match detail, but that is the
route if anything ever does.

## 🧪 2026-09 model research: goals models, ensembles, xG

Question: can more data beat elo-v6? Harness: `python -m elitetracker.research run`
(walk-forward, predict-then-reveal, per-match log loss so two models are compared
on exactly the same matches with a paired t-test; `|t| >= 2` is the bar).
Benchmark: Pinnacle/average closing odds from football-data.co.uk, overround-
normalised, joined to all 2,792 Eliteserien matches 2015–2026 (`data/odds_closing.json`).

| model (scored 2016+, n=5,120) | log loss | vs elo-v6 | t |
|---|---|---|---|
| elo-v6 | 1.00774 | — | — |
| closing odds (Eliteserien only, n=2,552) | 0.98468 | −0.0186 | −5.5 |
| Dixon-Coles, literature defaults (ξ=0.0065, 3-season window, ridge 0.05, weekly refit) | 1.01758 | +0.0098 | +3.9 |
| Dixon-Coles, tuned (ξ=0.01, 5-season window, ridge 1, refit every 3 days) | 1.01361 | +0.0059 | +2.5 |
| pi-ratings (λ=0.035, γ=0.7, draw model on the expected goal difference) | 1.02119 | +0.0135 | +5.2 |
| blend(elo-v6, tuned DC), weight refit per season from prior seasons | 1.00688 | −0.0009 | −2.6 |

On 2019+ (n=3,680): tuned DC +0.0037 (t +1.4, not distinguishable), blend −0.0012
(t −2.6), market gap +0.0189.

**Dixon-Coles — rejected as a replacement.** Every axis was swept (decay 0.002–0.025,
window 550–1800 days, ridge 0–4, refit cadence 3–14 days, promoted-club priors); the
best setting is still 0.6 pp of log loss behind elo-v6 on 2016+ and only level on the
recent window. Longer windows and heavier shrinkage helped, which says the goals
signal is noisy here — the same conclusion the margin-of-victory Elo tests reached:
Norwegian scorelines are mostly one-goal games and draws. `model/dixoncoles.py` was
deleted with this note; it is in git history if a later season warrants a re-test.

**pi-ratings — rejected.** Worse than DC at every learning rate (0.02–0.08) and
propagation (0.5–0.9); hit rate under 0.50. Deleted.

**Ensemble — measured, not shipped.** A geometric blend puts 75–95 % of the weight on
Elo (drifting toward DC over the years) and gains 0.09–0.12 pp with t ≈ −2.6 in
both windows and both halves. Real, but a tenth of what the elo-v3 draw refit was
worth, for the cost of a second live model (per-view Poisson fits in `build_site`,
a Poisson port in the browser for Compare Clubs, a second set of model-card
parameters). Not worth carrying.

**xG-informed Elo — measured, not shipped.** fotmob has per-shot xG for Eliteserien
from 2020 (nothing for OBOS-ligaen or earlier years); `python -m elitetracker.research xg`
scraped all 1,592 matches into `data/xg.json` (kept: 60 kB, and a re-scrape is 30
minutes of requests). The variant replaces the Elo result with
`(1−α)·result + α·xG-implied score` (P(win)+P(draw)/2 under Poisson goals at the two
xG values); α=0 reproduces elo-v6 to the bit. Pre-declared bar: −0.011 log loss
(the smallest effect n≈1,350 Eliteserien matches can detect at t=2).

| scored 2021+ | Eliteserien (n=1,352) | both divisions (n=2,720) |
|---|---|---|
| α=0.25, K=20 | −0.0013 (t −1.2) | — |
| α=0.5, K=20 | −0.0011 (t −0.5) | −0.0008 (t −0.7) |
| α=1.0, K=20 | +0.0036 (t +0.9) | — |
| K=28 alone | — | −0.0004 (t −0.4) |
| α=0.25, K=28 vs K=28 alone | — | −0.0018 (t −2.7) |
| α=0.5, K=28 vs elo-v6 | — | −0.0029 (t −2.5) |

xG on its own is worth about a tenth of a percentage point; with a faster K it reaches
0.3 pp, but K=28 is flat-to-worse on the long window (K 20–28 are within 0.001 on
2016+), so that combination is a post-hoc pairing chosen after seeing the numbers.
Below the bar, and it would add a fetch of match details to every refresh. Recorded,
not shipped; the model code is in git history.

**Squad market value — measured, not shipped.** Transfermarkt's season pages
(`/eliteserien/startseite/wettbewerb/NO1/saison_id/<season−1>`, likewise `NO2`; robots.txt
allows generic crawlers) list every club's total squad value *as it stood that season* —
checked on the 2017 Rosenborg squad, whose retired players show their 2017 values. All
24 league-seasons 2015–2026 joined to our team ids (`data/market_values.json`, 384
club-seasons, three name aliases). Within a division, log value correlates 0.51 with final
points over 20 league-seasons (0.48 using the previous season's page, so the same-season
values carry little end-of-season hindsight), so it looked like the missing prior for promoted clubs and for the
offseason pull. Walk-forward, three uses were tried on top of elo-v6:

| variant (scored 2016+, n=5,120) | vs elo-v6 | t |
|---|---|---|
| offseason pull toward `mean + β·z(log value)` instead of the flat mean, β=25–100 | −0.0002 to −0.0004 | −0.3 to −1.7 |
| same, using the previous season's values (leak-free) | −0.0004 to −0.0005 | −0.6 to −1.5 |
| promoted third-tier clubs seeded from value instead of the ladder floor | +0.0018 | +1.6 |
| in-season gap term γ·Δz(log value), γ=10 / 20 / 40 | −0.0001 / +0.0018 / +0.0112 | −0.2 / +1.4 / +4.4 |
| β=100 with a stronger pull (regression 0.8 / 0.7) | −0.0003 / +0.0001 | −0.3 / +0.1 |

Same picture on 2019+ (best −0.0007, t −0.8). The value signal is real but already
inside the carried rating: by the time a club's value has moved, its results have moved
its Elo. The one place it should have helped, clubs arriving from the third tier, it hurt
— the floor is the better prior. Recorded, not shipped; the experiment loop is
30 lines over `career.replay`'s logic and is described here well enough to redo.

**Attack/defence ratings — shipped for scorelines (elo-v7), not for outcomes.**
Two numbers per club on the log-goals scale, updated online after every match by
the goals scored above or below expectation (`model/attack_defence.py`: expected
goals `exp(base + home + attack − defence)`, Poisson grid with the Dixon-Coles
low-score correction). The step size is the only knob that matters; everything
else is flat within noise around home 0.22, cap 4, regression 0.88, ρ −0.05.

| scored 2016+ (n=5,120) | outcome log loss vs elo-v6 | exact scoreline −log p vs the empirical table |
|---|---|---|
| k=0.010 | +0.0059 (t +3.2) | −0.073 (t −9) |
| **k=0.015** | +0.0023 (t +1.5) | **−0.079 (t −10)**; total goals −0.019 (t −5), goal difference −0.024 (t −6) |
| k=0.020 | +0.0009 (t +0.6) | −0.077 (t −10) |
| k=0.025 | +0.0005 (t +0.3) | −0.075 (t −9) |
| k=0.06 (a typical Elo-like step) | +0.0109 (t +3.7) | −0.047 |

On 2019+ the hybrid's scoreline gain is −0.045 (t −6.7), in both halves and in both
divisions; top-4 coverage (the four scorelines the site shows) 37 % against 35 %.
The empirical table was rebuilt walk-forward from prior seasons only, so the comparison
is fair to it. A geometric blend of the two outcome models with weight 0.25 on Elo
(0.75 on the grid) was fitted by sweeping 0.0–1.0 in 0.05 steps; the grid carries
more weight because it is the better predictor. What ships is the hybrid:
P(scoreline) = P_elo(outcome) × P_ad(scoreline | outcome), in "Next up", in Compare
Clubs (computed in the browser from `report.model.attack_defence`) and in the Monte
Carlo's goal-difference tiebreaks. The table carries each club's expected goals for
and against per match versus an average side of its division.

**…and with xG, for outcomes too.** With fotmob's expected goals blended into the
observed goals (`alpha` 0.75; xG on target measured worse at every setting) and a
faster step for those matches (`k_shots` 0.05 against 0.015 for goals-only matches,
because the cleaner signal earns a bigger move), the attack/defence model on its own
beats elo-v6 on Eliteserien, and its geometric blend with the Elo odds (weight 0.25
on Elo, 0.75 on the grid, refit from 50/50) is the robust form. The scoreline model
gains nothing from xG (−0.002, within noise); the outcome model does:

| Eliteserien, outcome log loss vs elo-v6 | attack/defence alone | 50/50 blend with Elo |
|---|---|---|
| scored 2021+ (n=1,352) | −0.0088 (t −2.1) | **−0.0075 (t −3.6)**, both halves negative |
| scored 2022+ (n=1,112, one xG season of burn-in) | −0.0114 (t −2.5) | **−0.0087 (t −3.8)**, both halves negative |
| OBOS-ligaen 2021+ (no xG, goals-only step) | +0.0021 (t +0.7) | −0.0007 (t −0.5) |

Blend weight: 0.3 on Elo gives more log loss (−0.0105 on 2022+) with worse calibration,
0.7 less (−0.0059) with better; 0.25 was chosen before the sweep and stays. As shipped
(`python -m elitetracker.research run`): both divisions 2021+ −0.0041 vs Elo (t −3.2),
2019+ −0.0032 (t −3.0); on Eliteserien the gap to the closing line falls from +0.0189
to +0.0114 (2021+) and +0.0117 (2019+). The research CLI prints the shipped blend
beside Elo and the market. The refresh job tops up
`data/xg.json` for newly played Eliteserien matches (one request per match,
non-fatal), so the ratings keep moving on xG. Matches played within the last
2 days are re-fetched on every run because FotMob refines xG values after the
initial post-match scrape — older matches are cached permanently.

**Where the remaining gap is.** The closing line beats elo-v6 by 1.9 pp on both
windows, and the gap widens in the second half of each window (3 pp on 2024–2026).
Everything tried here uses only public results and shot data; the market's edge is
team news, motivation and money, none of which is in a results feed. A model that
consumes odds would close it, but only for matches that already have a market,
which is not the season-long simulation the site is for.

## 🧪 elo-v8: xG-informed Elo ratings + outcome blend refit

**xG-informed Elo ratings — shipped.** The Elo update's "actual" score blends the
binary match result with an xG-implied expected score: `actual = (1−α)·result +
α·xg_implied_score`, where `xg_implied_score = P(win) + 0.5·P(draw)` under
independent Poisson(home_xg) vs Poisson(away_xg). α=0.45 means a lucky win
(xG favoured the opponent) moves ratings 55% as much as a plain Elo update.
Where xG is unavailable (OBOS-ligaen, pre-2020), the binary result is used.

Fitted walk-forward on 2021–2026 (Eliteserien, where fotmob has xG), sweeping
α ∈ {0.0, 0.1, …, 1.0} × K ∈ {15, 18, 20, 22, 25, 28, 30, 35}, then a fine
grid around the sweet spot:

| α | K | log loss vs plain Elo | t |
|---|---|---|---|
| 0.00 | 20 | 0.00000 (baseline) | — |
| 0.25 | 20 | −0.00081 | −1.51 |
| 0.32 | 27 | −0.00248 | −2.89 |
| **0.45** | **20** | **−0.00235** | **−2.58** |
| 0.50 | 30 | −0.00316 | −2.47 |

The parameter landscape is flat α=0.30–0.50, K=25–31; α=0.45 with K=20 was
chosen for the smallest deviation from the existing K while clearing the |t|≥2
bar. The ratings themselves now carry the xG signal; the attack/defence layer
still adds its own on top for odds and scorelines.

**xG on target (xGoT) — investigated and rejected.** The xGoT/xG ratio was
proposed as a "shot effectiveness" metric: a team with a good striker converts
low-xG shots into dangerous on-target attempts (high xGoT/xG), while a team
with a bad striker wastes high-xG positions (low ratio). Measured:
- Per-match R²: xGoT predicts goals better than xG (0.59 vs 0.34), but this
  is already captured by the attack/defence model's xG blending.
- Year-to-year stability of the ratio: r = 0.060 (n=81) — essentially noise.
- Ratio predicts next-season overperformance: r = 0.021 — no signal.

The ratio is not a persistent team trait in Norwegian football; "finishing
skill" does not accumulate across seasons at this sample size.

**Outcome blend refit — shipped.** The geometric blend of Elo odds and the
attack/defence grid's odds was swept from 0.0 (pure grid) to 1.0 (pure Elo)
in 0.05 steps. Best at 0.25/0.75 (Elo/grid):

| elo weight | ad weight | log loss | vs 0.50 | t |
|---|---|---|---|---|
| 0.25 | 0.75 | 0.99515 | −0.00044 | −2.51 |
| 0.30 | 0.70 | 0.99515 | −0.00044 | −2.68 |
| **0.50** | **0.50** | **0.99559** | — | — |
| 0.70 | 0.30 | 0.99671 | +0.00112 | −4.07 |

The grid is the better predictor and should carry more weight. Same pattern
holds with plain Elo ratings (no xG in ratings), so it is not an interaction
with elo-v8.

**Combined improvement (2021+, vs plain Elo baseline):**

| model | log loss | vs elo | t |
|---|---|---|---|
| plain Elo (K=20) | 1.00055 | — | — |
| elo-v8 alone (α=0.45) | 0.99820 | −0.00235 | −2.58 |
| elo-v7 blend (50/50) | 0.99638 | −0.00417 | −3.19 |
| **elo-v8 + ad blend (25/75)** | **0.99475** | **−0.00580** | **−3.38** |
| Pinnacle closing line | 0.96695 | −0.03360 | — |

The combined model closes the gap to the market from +0.0189 (elo-v6) to
+0.0098 (2021+ Eliteserien). The remaining gap is team news, motivation and
money — none of which is in a results feed.

## 🧪 elo-v9: season-level finishing quality

**Season-level finishing — shipped.** Match-level goals/xG was too noisy to be
useful (every config made things worse); the season-level signal is clean and
persistent. Each team's cumulative `log(total goals / total xG)` over a full
season is stored and carried into the next season with regression (0.70 toward
the mean). The rating feeds into expected goals alongside the attack/defence
ratings:

    home: exp(base + home + attack[home] − defence[away] + finishing[home])
    away: exp(base + attack[away] − defence[home] + finishing[away])

Fitted walk-forward on Eliteserien 2021–2026 (where fotmob has xG):

| variant | log loss vs no finishing | t |
|---|---|---|
| no finishing (elo-v8 baseline) | 0.00000 | — |
| match-level log(goals/xG) | −0.00039 | −1.04 |
| **season-level log(goals/xG), reg=0.70** | **−0.00039** | **−1.04** |

The effect is strongest in the first season with xG data (2021:
d=−0.00320, t=−1.70); after that the attack/defence model captures the
signal through the blended observation. Year-to-year odd/even correlation
of the finishing rating: r=0.533 (n=81) — a real persistent trait, unlike the
xGoT/xG ratio which was noise (r=0.06).

The net improvement over elo-v8 is −0.00243 log loss vs Elo-only (t=−1.82),
modest but free: finishing is computed from data already in the refresh pipeline.
Combined with elo-v8's other gains, the total vs plain Elo is −0.00823
(t=−3.6). The model card and team focus page display the finishing stat.

**Match-sliding window — rejected (09-2026).** The shipped stat uses the
previous full season and never moves within it; a rolling window was proposed
to make finishing update gradually. A 30-round season makes a 30-match window
the season-level stat that slides match by match, blending last season's tail
with the current one. Measured walk-forward (whole sample plus the Eliteserien
xG matches 2021+ that the stat can actually move):

| variant | focused xG logloss | vs shipped |
|---|---|---|
| no finishing | 0.97628 | +0.00166 |
| **season-level reg=0.70 (shipped)** | **0.97462** | — |
| rolling 20 | 0.98976 | +0.01514 |
| rolling 30 | 0.98326 | +0.00864 |
| rolling 45 | 0.98130 | +0.00668 |

The window only ever approaches the season-level result as it grows
(20→30→45), never beats it; shipped vs rolling-20 is t=−4.81 on the whole
sample. A partial recent window (half last season, half this) is noisier than
the clean prior full season, and the attack/defence model already absorbs
in-season conversion changes through its blended xG observation.

## ❗ Known limits (also stated on the site)
- Ratings are held fixed for the rest of the season inside a simulation.
- Simulated matches draw a scoreline from the empirical distribution of real results
  (`model/scorelines.py`), conditioned on the win/draw/loss outcome *and* the pre-match
  rating gap, so a heavy favourite draws bigger scorelines than a slight one (real margins
  grow with the gap) and goal difference moves within a simulation. Tied finishes resolve on
  simulated goal difference, not today's. The rating-implied probabilities remain the sole
  driver of who wins.
- Clubs promoted from the third tier start at the ladder floor.

## 🧪 elo-v11: OBOS-ligaen xG from Sofascore — shipped

**The problem.** fotmob serves no shotmap for the second division, so
`fetch_match_xg` returned None for every OBOS match and both xG-driven parts of
the model — the attack/defence observation (0.75 xG + 0.25 goals, with the
faster `k_shots` step) and the xG-informed Elo update — were dead for sixteen of
the thirty-two clubs. Half the model ran on goals alone.

**Sofascore has it, from 2023.** Every finished OBOS fixture carries
`hasXg`, and the value is at
`GET /api/v1/event/<id>/statistics` under `key: "expectedGoals"`. Checked round
5 of every season: 2020–2022 report `hasXg: false` on all eight fixtures, 2023
onward on all of them. Coverage in the end: 2023 221/240, 2024 239/240, 2025
240/240, 2026 176/176 — **876 matches**, against 1,600 for Eliteserien.

**The 403 in the earlier note was stale.** Sofascore is reachable from plain
Python with a browser `User-Agent`; curl, urllib and the API all return 200. The
two-phase webfetch-and-cache workflow this file described is gone, along with
the `data/sofascore_cache/` tree and `scripts/sofascore_merge.py` it needed —
`sources/sofascore.py` fetches, joins and stores in one pass, and
`python -m elitetracker.research xg-obos` runs it in about eleven minutes.

**Joining the two feeds.** Sofascore knows nothing of fotmob's match ids, and
the club names differ ("Odds BK" / "Odds Ballklubb", "IK Start" / "Start",
"Aalesunds FK" / "Aalesund"). Dropping the club-type words (FK, IL, IK, BK, SK,
Fotball, Ballklubb, Oslo) and a trailing "s" makes every one of the 32 clubs
agree, and an ordered pair of clubs meets exactly once a season, so
`(home, away)` is a unique key. The stored score is then checked against the
event's, which is what catches a bad join: all 876 agreed. The four extra
"finished" events each season are promotion play-offs against third-tier sides
(Tromsdalen, Brattvåg); they match no fixture we hold and are skipped.

Entries are stored two values long, `[home_xg, away_xg]` — Sofascore publishes
no xG on target, and a zero there would be read as a real one by anything that
later prefers that signal. Sofascore's xG is on the same scale as fotmob's:
goals/xG per season runs 0.92–1.07 for OBOS against 0.93–1.20 for Eliteserien.

**What it is worth** (walk-forward, paired per-match log loss, shipped blend):

| scored | n | vs elo-v10 | t |
|---|---|---|---|
| OBOS 2023+ (the matches it touches) | 896 | **−0.01325** | −3.41 |
| both divisions 2016+ | 5,136 | **−0.00247** | −3.53 |
| OBOS 2016+ | 2,576 | −0.00461 | −3.40 |
| Eliteserien 2016+ (rating pool only) | 2,560 | −0.00031 | −0.96 |

Negative in all four OBOS seasons (2023 −0.0150 t−2.26, 2024 −0.0232 t−2.71,
2025 −0.0039 t−0.53, 2026 −0.0101 t−1.18) and in both halves. Five times what
xG bought on Eliteserien, because it replaces goals rather than refining them.
Most of it arrives through the goals model; the ratings alone are worth −0.0057
(t = −1.84) on OBOS 2023+.

**Also shipped: the served ratings are the model's own.** `build_report` brought
its season up to date with a second replay loop in `model/ratings.py` that
passed neither the shot table nor the era config, so the live table, the
fixtures' odds and the Monte Carlo ran on K=20 with no xG while the backtest
measured K=35 with it. The gap on 2026 was a mean of **12 Elo, up to 38** —
about five points of win probability on the worst club. That module now
delegates to `career.replay`, and the two agree to 0.07 Elo (rounding in the
stored career points). Nothing in the backtest could have caught this: it never
called the duplicate.

**And the era switch is per match.** `replay` chose one config per season from
`any(slice.league == "eliteserien")`, which meant OBOS matches from 2022 were
rated with the modern config despite elo-v10's note saying they were not. It is
now `era_config(league, season)`, passed to every replay as
`config_for(league, season)`, which also replaced three parameters
(`modern_config`, `boundary_season`, `boundary_league`) with one and is how each
sweep below varied a division on its own. The documented per-division rule was
then measured with the OBOS corpus in hand and is **worse**: +0.00027 log loss
on both divisions 2016+ (t = +2.11). The code was right and the comment was
wrong, so the comment changed.

### The refit: everything swept against the doubled corpus

Each knob varied alone, walk-forward, against the shipped model with the new
data; `|t| >= 2` and the same sign in both halves is the bar. **Nothing moved.**

| swept | range | best marginal | verdict |
|---|---|---|---|
| OBOS K × xG alpha | K 20–50, α 0–0.75 | K 50: −0.0004 (t −0.9) | flat 35–50; K=20 is worse (+0.0008, t +1.35). Keep 35/0.50 |
| Eliteserien K × alpha | K 25–45, α 0.40–0.60 | −0.0001 (t −0.6) | flat. Keep 35/0.50 |
| era boundary, per division | 2020–2024, never | −0.00008 (t −0.91) | noise. Keep 2022, both divisions |
| attack/defence `k_shots` × `alpha` | 0.03–0.07 × 0.55–1.0 | 0.07/0.85: −0.0003 (t −0.77) | 0.05/0.75 sits in the basin. Keep |
| outcome blend weight | 0.10–0.40 | 0.40: −0.00016 (t −0.59) | worse on both recent windows. Keep 0.25 |
| Elo home advantage | 50–120, and per division | 90: −0.00029 (t −0.86) | all of it in the early half, reverses in the late. Keep 60 |
| attack/defence home | 0.14–0.30 | 0.26: −0.00025 (t −0.79) | same early/late reversal. Keep 0.22 |
| draw model | base 0.22–0.30 × scale 300–450 | ±0.00007 | 0.26/375 is the optimum. Keep |
| draw model, OBOS only | base 0.24–0.30, scale 300–550 | ±0.00016 (t < 0.8) | the divisions draw at 0.236 and 0.241. One model |
| seed ladder × regression | spread 240–440, offset 8–20 | −0.00038 (t −1.89) | the 2014 seeds have washed out by 2016. Keep 340/14 |
| third-tier promotion floor | 1230–1480 | 1280: −0.00037 (t −2.17) | entirely early-half (14 of 17 such clubs arrived before 2021), exactly 0.00000 late. Keep 1330 |
| attack/defence newcomer / division gap | 0.05–0.30 / 0.15–0.35 | −0.0005 / −0.0002 | early-half only. Keep 0.15 / 0.25 |
| attack/defence `k`, `cap`, `rho`, `base` | 0.010–0.020, 2–∞, −0.12–0, 0.31–0.43 | ≤ 0.00006 | keep. `base` cancels out entirely — the ratings absorb it |
| finishing regression | 0.50–1.00 | −0.00001 (t −0.10) | keep 0.70. Turning it off costs +0.00063 |
| Elo rating scale (400) | 300–500 | 350: −0.00037 (t −2.65) | early-half only (late t −0.70). Keep 400 |

**Cross-season regression — the one live candidate, not shipped.** Removing the
offseason pull entirely (0.88 → 1.00) is worth −0.00023 log loss on both
divisions 2016+ (t = −2.04), negative in every window tried and in both halves
(early −0.00006 t −0.35, late −0.00041 t −2.54), with calibration error
0.00937 against 0.00985 and no rating drift (2026 spread sd 142 against 138). It
is not a season-start effect — rounds 1–3 show −0.00022 (t −0.44), the same as
the full season — which reads as eleven years of compounded shrinkage leaving
the ladder slightly too narrow rather than as the pull failing at the boundary.
Split by era and division, no part carries it: modern-only −0.00013, OBOS-only
−0.00007, legacy-only −0.00010.

Left at 0.88. The effect is 2% of the model's own calibration error and a tenth
of what OBOS xG bought, the first half is null, and `t` sits on the bar rather
than over it. One constant flips it if a later season sharpens the evidence.

### Keeping it current

`refresh` tops up both divisions: fotmob for Eliteserien, Sofascore for OBOS,
re-fetching anything played in the last two days because both sources revise xG
after the final whistle. A Sofascore failure prints and is skipped — the model
falls back to goals for a match without xG, so it must never block a refresh.

## 🎯 2026-09: the shipped model vs the market, and what could close the gap

How far the shipped elo-v11.1 (Elo + attack/defence blend, 25/75) is from the
Pinnacle closing line and *where* it loses. Everything here is the answer to
"can structure, not constants, close it?" — the constants are done (the sweeps
above found nothing worth shipping).

### The gap, current numbers

`python -m elitetracker.research run`, both windows (Eliteserien, where odds
exist):

| scored 2019+ (n=1,832) | log loss | vs market | t |
|---|---|---|---|
| Elo alone | 0.98931 | +0.01751 | +4.56 |
| **shipped Elo + AD** | **0.98039** | **+0.00880** | **+2.50** |
| Pinnacle closing | 0.97266 | — | — |

| scored 2022+ (n=1,112) | log loss | vs market | t |
|---|---|---|---|
| Elo alone | 0.97400 | +0.01640 | +3.31 |
| **shipped Elo + AD** | **0.96449** | **+0.00724** | **+1.59** |
| Pinnacle closing | 0.95889 | — | — |

The shipped model clears the |t|≥2 bar on 2019+ but not the recent window
overall; it clears on that window's late half (+0.0133, t +2.19). Elo alone is
behind the market everywhere.

### Where exactly the market wins

Bucket analyses over 2019+ (Eliteserien, 1,832 matches): **the model leaks
probability to the wrong side in three specific places.**

**1. Home wins.** Mean home probability: model 0.451, market 0.464, base rate
0.467. The model prices away wins at 0.312 against a 0.298 base; the market
0.296. On matches that end in a home win the model is on average +0.040 log
loss worse; on away wins it *beats* the market (−0.033). The home-away
calibration is a genuine, stable gap — per season the model's home mean sits
0.448–0.454 while the market runs 0.447–0.477 and tracks the actual rate.

**2. Big favourites.** Where the model's favourite has p≥0.7 it actually wins
83.5% of the time — an under-confidence of 7.9pp (market is also under-confident
there, 5.8pp, but by less). The market's edge concentrates in the extreme
buckets — model max-p in [0.6,0.7) costs +0.0158 vs the market, [0.7,1.0)
+0.0056, while the middle of the range runs +0.008 to +0.014. The market is
sharper exactly where homes and favourites overlap.

**3. Late-season matches.** The gap after midsummer (+0.0152/match) is more
than double the early-season one (+0.0068). The market has team news, form and
motivation; our ratings only move on goals and xG. The one season we beat the
market outright is 2022 (−0.0095) — noise, or a COVID restart stumping the
bookies; two-sided hindsight.

### What could close it — structure, not constants

All constants are at their measured optimum, so every idea below changes the
*inputs* a prediction is built from. None is shipped; each is a candidate with
its own honest test.

1. **Home advantage shaped by the rating gap.** The model's home mean is pinned
   at ~0.45 across every season while the market rides 0.447→0.477 and lands on
   the base rate. A single ×0.465 is a constant (already swept — flat). The
   untried version: the home term scales with how much better the favourite is,
   i.e. `home_advantage × (1 + β·fav_gap)`. Zero new data, one new knob, and it
   is exactly where the calibration gap concentrates.

2. **Favourite sharpening.** Under-confident at the top of the confidence range
   is a sharper-blend problem: currently one fixed blend weight (0.25) for every
   match. A weight that changes with the rating gap (more grid when the favourite
   is heavy) is the natural form. Risk: this is a tuned-at-the-margin parameter,
   the same trap as the K/α candidate — a forward split is mandatory.

3. **In-season team news through the calendar.** The late-season gap is money,
   motivation and rotation. fotmob already returns every kickoff date, so
   rest-days and congestion are computable now: days-since-last-match for both
   sides, plus the Thursday→Sunday pattern of European weeks (Norway's European
   sides are the big favourites this hypothesis applies to). Pure new data — the
   model currently ignores the calendar entirely.

4. **Populated from odds — closed and noted.** Consuming the closing line for
   matches that have one would mechanically close the measured gap, but the
   project's position is unchanged: that is not the season-long simulation the
   site is for. Recorded so nobody re-derives it.

**Bottom line.** The shipped model is within ~1pp of the closing line over the
long window (t +2.5) and ~0.7pp over the recent (t +1.6), it matches or beats
the market on away wins and near-even matches, and its remaining loss sits in
three buckets — home wins, big favourites, late-season — all consistent with
"the market prices information the model doesn't see". Three structural
candidates (shaped home term, gap-dependent blend, calendar-derived rest days)
are the honest shots at those buckets with data already in hand or one scrape
away. Nothing ships until a walk-forward says it does.

## 🔧 Open items

**Next, in rough order of expected value:**
- [x] Home advantage shaped by the rating gap — coded, measured, rejected.
       Flat surface (t=−0.24 at best β).  See "elo-v12 candidates" section.
- [x] Favourite sharpening — coded, measured, rejected.  γ=0.0 is best;
       every non-zero value is worse.  See "elo-v12 candidates" section.
- [x] Calendar-derived rest days and congested weeks — measured with every
       UEFA and cup fixture of our clubs, no signal. See "elo-v12.0".
- [x] Per-era K/α — rejected out of sample (walk-forward). See "elo-v12.0".
- [x] xG-margin Elo term — shipped in elo-v12.0 (γ 0.05).
- [x] Penalty-adjusted xG and red-card-aware updates — measured on all 1,608
       Eliteserien matches 2020–2026, nothing to change. See "elo-v12.0".
- [ ] Check whether Sofascore backfills OBOS xG before 2023 (it 403s from the
      developer machine as of 2026-09-25; not checked from CI) (2020–2022 report
      `hasXg: false` today); it would add ~720 matches and is one re-run of
      `research xg-obos --seasons 2020-2026` if it ever appears.
- [ ] Re-test the offseason pull (0.88 vs 1.00) after 2027, when the modern era has
      one more season in it. The case is written up under elo-v11.
- [ ] Sofascore also has xG for Eliteserien. Comparing it against fotmob's on the
      same 1,600 matches would say how much of the model's xG noise is the provider's,
      and an average of the two would be a cheap variance reduction if they disagree.

- [x] Rebuild and re-upload the past-seasons archive: done on elo-v16.0
      (`past-seasons.yml` on a914f25, 2026-10-17), so 2015–2025 carry
      `results[].xg`, `results[].xg_form` and the projected goal totals. Rerun it
      after each model release (docs/operations.md, "Publishing past seasons").

**Ongoing:**
- [ ] Re-fit the draw model periodically as seasons accumulate.
- [ ] Re-run `backtest_cli` after each new season to keep K / home advantage / regression
      fitted (bump `MODEL_VERSION`).
- [ ] Head-to-head tool — current-season record between two clubs is now shown in Compare
      Clubs (filters `report.results` client-side). Cross-season history would need a new
      server-side payload from the normalized match files.
- [ ] "What-if" simulator — nudge a club's rating and see the grid/table update. Needs
      on-demand simulation, so it does not fit the static host until that story is settled.

## 📜 Shipped, in order

- elo-v2: one continuous rating replay from the 2014 tables instead of per-season re-seeding.
- elo-v3: draw model refit (0.22/250 → 0.26/375); ratings unchanged.
- elo-v5: home advantage 75 → 60, cross-season regression added (fit by walk-forward backtest).
- elo-v6: regression per division; seed ladder (340 spread, offset 14) and regression
  factor 0.88 jointly re-fit by `model/fit_params.py`.
- Scorelines conditioned on outcome and pre-match rating gap (`model/scorelines.py`),
  so goal difference moves inside a simulation and "Next up" shows likely scorelines.
- Site: rewind slider, finish grid, sortable table, ladder (horizontal, vertical on phones),
  grid and ladder animation, played results by ISO week, compare clubs (odds computed in
  the browser from `report.model`), team focus page with pre-season vs live prediction,
  NO/EN localisation, static build + Firebase Hosting deploy, scheduled data refresh.
- 2026-09 research: Dixon-Coles, pi-ratings, an Elo/DC blend and xG-informed Elo were
  measured walk-forward against elo-v6 and the closing line; none cleared the bar,
  nor did Transfermarkt squad values as an offseason prior. Kept: the paired-scoring
  harness, the odds benchmark, the xG corpus, the value table.
- elo-v7: online attack/defence goals model, updated on xG where fotmob has it. Its odds
  are blended 50/50 with Elo's; its Poisson grid replaces the empirical scoreline table.
- elo-v8: xG-informed Elo ratings (α=0.45): lucky wins move ratings less than deserved
  ones. Outcome blend refit to 25/75 (Elo/attack-defence). Combined improvement
  −0.00580 log loss vs plain Elo (t=−3.38). xGoT/xG ratio investigated as shot
  effectiveness metric — rejected (year-to-year r=0.06, no predictive signal).
- 2026-09 audit: removed the standings fetch path, the raw-fetch cache, the ordered-logit
  switch, the config validators, the build progress bar, the custom compare picker and a
  set of duplicated frontend renderers; one rating replay serves careers, the backtest and
  the scoreline corpus.
- 2026-09 CI fix: PAT push URL used `x-access-token:` (GitHub App syntax) which prevented
  the `on: push` trigger from firing the deploy workflow; switched to bare `${PAT}`.
  Refresh cron reduced from every 30 min to hourly to avoid run bunching.
- elo-v9: season-level finishing quality in the attack/defence model. Each team's
  log(goals/xG) over a full season carried forward with regression 0.70. Modest
  improvement (−0.00243 vs Elo-only, t=−1.82); strongest in the first xG season.
  Frontend: model card shows finishing regression, team summary shows finishing stat.
- elo-v10: era-switched Elo config. Legacy (K=20, xg_alpha=0.45) for warmup seasons;
  modern (K=35, xg_alpha=0.50) from 2022, in both divisions (the note said Eliteserien
  only; the code never did, and elo-v11 measured the code as right). home_advantage=60,
  cross-season regression=0.88 per division. Committed 5d77044.
- elo-v11: expected goals for OBOS-ligaen from Sofascore, 876 matches 2023-2026, which
  switches on the attack/defence xG observation and the xG-informed Elo update for the
  second division: -0.01325 log loss on the matches it touches (t=-3.41), -0.00247
  across both divisions (t=-3.53). With it, two fixes the backtest could not see: the
  rating table a report serves is now `career.replay`'s, not a duplicate loop's that
  passed neither xG nor the era config (it sat a mean 12 Elo away), and the era switch
  is chosen per match by `era_config(league, season)`. Every other model constant was
  re-swept against the doubled corpus and none moved.
- elo-v11.1: re-sweep with xG data loaded in the backtest (the elo-v11 sweep never
  passed xG to walk_forward, so the xG-informed Elo update was never tested).
  K=30 and xg_alpha=0.30 beat the shipped 35/0.50 by -0.00073 log loss on the xG
  window (Elite 2020+, OBOS 2023+; t=-0.98, not yet significant at |t|>=2 but
  consistent across divisions).  Also fixed backtest_cli.py to load shot_table()
  so future sweeps test the actual shipped model.  Attack/defence k_shots and alpha
  were swept but showed zero effect on outcome log loss (the AD grid's win/draw/loss
  odds are flat when team ratings are close).
- elo-v12.0: xG margin in the Elo update, the goals model's `spread` 1.10, a
  per-run strength shock in the season Monte Carlo.
- elo-v12.1: head-to-head tiebreak in the table and the simulation.
- elo-v12.2: the season Monte Carlo on NumPy (same model, new random stream).
- elo-v13.0: the IMPROVEMENTS.md sweep. The xG margin signed by xG (it was
  signed by the scoreline and paid lucky winners most), the exact xG-implied
  score, the goals model's offseason pull toward a squad-value-shifted mean
  and a bigger step in a club's first matches, the strength shock 0.15 ->
  0.20. -0.00127 log loss on both divisions 2016+ (t -3.51), season RPS
  -0.00097 (t -2.48). Everything else in the plan measured and rejected. In the
  same release: the play-offs simulated in every run and counted in promotion
  and relegation chances, and a +10 Elo home edge on Eliteserien predictions
  when the two clubs play on different surfaces (-0.00031, t -2.98).
- elo-v14.0: keeping (goals let in against xG on target, a club's last 45
  matches) as the goals model's fourth part, its chances learnt 90 % from xG;
  the offseason pull per division (OBOS-ligaen 0.75 / 0.3); the surface edge
  10 -> 20.
- elo-v15.0: a club relegated into OBOS-ligaen keeps half its distance from
  the division's mean, toward a target set by its squad value (Elo 75 points
  per log value; the goals model its own value pull).
- elo-v16.0: the xG margin unclamped and 0.10 -> 0.12; late-season table
  stakes on the prediction (`model.stakes`), the season simulation reading
  them from each run's own table. See "IMPROVEMENTS2.md, phases 1 and 2".
- No version (2026-10-18): one module prices a match for every caller
  (`model/pricing.py`), the model's inputs read and digested in one place
  (`pipeline.py`), byte-identical reports. The model-accuracy view's Kelly
  drawdown no longer depends on hash order (0.9051, it moved between 0.903 and
  0.906 from run to run); the local server serves `calibration.json`.

## 🧪 elo-v12 candidates: gap-dependent home advantage and favourite sharpening — measured, rejected

Two structural candidates were coded up (defaults 0.0, backward-compatible) and
swept walk-forward on 2022+ (Eliteserien, n=1,121 scored matches).  Both are
flat across their parameter ranges and fail |t|≥2.

### Gap-dependent home advantage (`home_advantage_beta`)

`effective_home = base × (1 + β × gap)` where gap = (home − away)/400.  Both
the Elo home_advantage (60 pts) and the AD home term (0.22 log goals) scale.

| β | log loss | paired d vs β=0 | t |
|---|---|---|---|
| 0.0 | 0.97454 | — | — |
| 0.1 | 0.97429 | −0.00002 | −0.31 |
| 0.2 | 0.97429 | −0.00003 | −0.27 |
| 0.3 | 0.97429 | −0.00005 | −0.24 |
| 0.4 | 0.97430 | +0.00001 | +0.02 |
| 0.5 | 0.97431 | +0.00002 | +0.03 |

Surface flat within 0.00005 across β=−0.5…0.5.  The model's home-win
calibration gap is real but appears to be structural to the Elo framework,
not fixable by scaling the constant with the gap.

### Favourite sharpening (`blend_gamma`)

`weight = clamp(0.25 − γ × |gap|, 0.05, 0.50)` — more grid weight for heavy
favourites.  Forward-split: fit on <2023, test on 2023+.

| γ | train ll | test ll | vs γ=0 | t |
|---|---|---|---|---|
| 0.0 | 0.97477 | 0.97128 | — | — |
| 0.3 | 0.97679 | 0.97167 | +0.00039 | +0.82 |
| 0.6 | 0.97799 | 0.97217 | +0.00089 | +0.66 |
| 1.0 | 0.97818 | 0.97248 | +0.00120 | +0.58 |

γ=0.0 (constant blend) is the best; every non-zero value is worse.  The
under-confidence on heavy favourites is a real gap to the market but is
not addressable by shifting the blend weight with the rating gap.

### Combined sweep

| β | γ | log loss | vs elo | t |
|---|---|---|---|---|
| 0.0 | 0.0 | 0.97202 | −0.00252 | −0.72 |
| 0.2 | 0.0 | 0.97147 | −0.00303 | −0.88 |
| 0.4 | 0.0 | 0.97101 | −0.00348 | −1.02 |
| 0.4 | 0.3 | 0.97152 | −0.00297 | −0.79 |

No combination clears |t|≥2.  The code stays in the repo (defaults 0.0,
backward-compatible) but is not shipped; the model version stays at
elo-v11.1.  `MatchProbabilities.rating_gap` is kept as a useful carry
field for future candidates.

## 🧪 Post-elo-v11.1 knob sweeps (September 2026)

Full walk-forward on the xG-availability window (Eliteserien 2020+, OBOS-ligaen
2023+; n=2,640 scored, n=2,496 with xG). All sweeps use `backtest.paired()` with
the shipped elo-v11.1 model as the baseline. |t|≥2 and the same sign in both
halves is the bar.

### Cross-season regression

`season_regression` 0.80–1.00 by 0.02 (coarse) and 0.85–1.00 by 0.01 (fine)
on three windows:

| window | n | best | log loss | t |
|---|---|---|---|---|
| Eliteserien 2022+ | 1,120 | 0.88 or 1.00 | 0.9949 | −0.8 |
| both divisions 2016+ | 5,136 | 0.88 or 0.90 | 1.0033 | −0.7 |
| xG window (both divs) | 2,496 | 1.00 (no regression) | 0.9939 | −1.2 |

The surface is flat across every window; 0.88 and 1.00 (no regression) are
within 0.0001 of each other. 0.88 was kept because removing regression entirely
(t=−2.04 on the full 2016+ window) showed a tiny but consistent benefit in
the elo-v11 refit, and the current value sits in the flat basin. **No change.**

### Per-era K / xg_alpha (corrected boundary)

The era boundary was corrected from calendar-2022 to xG-availability:
Eliteserien 2020+ (xG present), OBOS-ligaen 2023+ (xG present). The legacy era
uses plain binary results; the modern era uses xG-informed Elo updates.

Coarse grid (K=30–100, α=0.30–1.00) then fine grid (K=55–90, α=0.50–0.80)
on n=2,640 (full xG window):

| K | α | log loss | vs shipped (30/0.30) | t |
|---|---|---|---|---|
| 30 | 0.30 | 0.9943 | — (baseline) | — |
| 70 | 0.70 | 0.9889 | −0.0054 | −2.2 |
| 75 | 0.75 | 0.9889 | −0.0054 | −2.4 |
| 80 | 0.75 | 0.9889 | −0.0054 | −2.6 |
| 85 | 0.75 | 0.9889 | −0.0054 | −2.5 |
| 90 | 0.75 | 0.9890 | −0.0053 | −2.3 |

Winner region: K=70–90, α=0.70–0.80. Per-season: 9/11 better, but gains
concentrate in Eliteserien 2022 (−0.025) and OBOS 2023/24 (−0.010/+0.005).
Per-league: Eliteserien t=−1.45, OBOS t=−1.74.

Holdout (split-half):
- forward (fit 2020–2022, test 2023–2026): d=−0.0026, t=−0.75 — not significant
- reverse (fit 2023–2026, test 2020–2022): d=−0.0021, t=−1.99 — borderline

**Verdict: direction robust but not significant at |t|≥2 on holdout.** The
legacy era (pre-xG) is fine: shipped K=20/α=0.45 vs best K=18/α=0.0 shows
t=−1.63 and the split shows gain only pre-2020. **Not shipped — needs 2027
holdout to confirm.**

### xG margin of victory in the Elo update (`xg_margin`) — measured, parked

The elo-v3 rejection of margin-of-victory used **goals** margin; the xG form was
never tested. The scored term gets the 538-style damped-log bonus on the side
that won, symmetrically on both ratings:

    scored = (1−α)·result + α·xg_implied_score + sign · γ · ln(1 + |ln(home_xg/away_xg)|)

clamped to [0,1] (zero on draws), only where xG exists. Walk-forward on the
shipped blend card, restricted to matches that actually carry xG (Eliteserien
2020+, OBOS-ligaen 2023+; n=2,479):

| γ | logloss | d vs γ=0 | t | early (t) | late (t) |
|---|---|---|---|---|---|
| 0.00 | 0.98546 | — | — | — | — |
| 0.05 | 0.98522 | −0.00023 | −2.69 | −1.91 | −2.31 |
| 0.10 | 0.98514 | −0.00031 | −2.36 | −1.72 | −1.97 |
| 0.15 | 0.98510 | −0.00036 | −2.29 | −1.77 | −1.83 |
| 0.20 | 0.98508 | −0.00038 | −2.13 | −1.84 | −1.62 |
| 0.25–0.30 | 0.98507 | −0.00038 | ~−1.9 | ~−1.9 | < −1.5 |

Signal real and monotone (negative on both halves at every γ), best head-to-head
t at γ=0.05 (−2.69) — but the early half never clears −2, so the same-split
independence bar is not met. The optimum is flat γ=0.05–0.30 around −0.0004,
the same order as elo-v9's finishing quality.

**Stacked on the K=80/α=0.75 candidate** (the per-era winner region above), the
two effects add. K=80/α=0.75/γ=0.10 is the best absolute model measured to date
(−0.00106 log loss vs shipped on the xG window, t=−1.60), but the entire gain
rides the late half (early t≈−1.8) — the same independence failure that kept
K=80 out. Nothing clears |t|≥2 on both halves, so nothing ships.

Two side notes worth keeping:
- The margin bonus is a *rating* change, not a prediction change directly — but
  it did not move the matchup against the (already-shipped) K=70–90 candidate's
  prediction blend, which is why it works additively rather than redundantly.
- It does not serve the "smaller upset awards" intuition: a 2.6xG-favoured away
  win like Rosenborg's 3-1 @ Kristiansund gets a *bigger* move, not a smaller
  one; the blend-expected Elo update (expected = 25/75 Elo×AD odds, which would
  shrink it to K·(1−0.663)=10.1 at K=30) was also measured and is worse on every
  window (t=+2.5 on elite 2019+) — the classic calibration-fix-in-disguise trap.

**Verdict: parked with the K=70–90 case — re-check both on 2027 as holdout.**

### Blend weight (OUTCOME_BLEND)

Swept `OUTCOME_BLEND` 0.0–1.0 (weight on Elo odds; 1.0−w on the AD grid) for
both the shipped config (K=30/0.30) and the candidate (K=80/0.75):

| w (Elo) | AD (1−w) | log loss | vs w=0.25 | t |
|---|---|---|---|---|
| 0.00 | 1.00 | 0.9879 | −0.0010 | −1.1 |
| 0.25 | 0.75 | 0.9889 | — (baseline) | — |
| 0.50 | 0.50 | 0.9910 | +0.0021 | +2.3 |
| 0.75 | 0.25 | 0.9932 | +0.0043 | +3.8 |
| 1.00 | 0.00 | 0.9979 | +0.0090 | +5.2 |

Grid alone (w=0) beats Elo alone (w=1) significantly in both leagues
(Eliteserien t=−2.42, OBOS t=−2.11). Blend weight 0.25 sits on flat ground
— any w=0–0.30 is within 0.0003, |t|<1.1. The same pattern holds for the
candidate Elo config. **No change to OUTCOME_BLEND=0.25.**

### Attack/defence model knobs

Swept k, k_shots, alpha, home, rho, base, cap, season_regression,
finishing_regression. Coarse grid: 16,464 configs (k 0.005–0.025,
k_shots 0.03–0.07, alpha 0.50–1.00, home 0.14–0.30, rho −0.12–0.00).
Fine grid: 17,745 configs around the winner.

| parameter | shipped | best | surface |
|---|---|---|---|
| k (goals step) | 0.015 | 0.019 | flat 0.012–0.022 |
| k_shots (xG step) | 0.05 | 0.055 | flat 0.04–0.06 |
| alpha (xG weight) | 0.75 | 0.80 | flat 0.65–0.90 |
| home (log goals) | 0.22 | 0.235 | flat 0.18–0.28 |
| rho (Dixon-Coles) | −0.05 | −0.03 | flat −0.10–0.00 |
| cap | 4.0 | 4.0 | flat 3–8 |
| base | 0.37 | 0.37 | cancels out entirely |
| season_regression | 0.88 | 0.88 | flat 0.85–0.95 |
| finishing_regression | 0.70 | 0.70 | flat 0.50–0.95 |

Winner: k=0.019, k_shots=0.055, alpha=0.80, home=0.235, rho=−0.03,
logloss=0.98458 vs baseline 0.98495 (d=−0.00037, t=−0.78). Per-season:
5/7 Eliteserien, 2/4 OBOS better (max |t|=1.67). The surface is extremely
flat — every shipped value sits in the basin. **All AD values stay.**

Secondary knobs (finishing_regression, cap, season_regression): all flat
within 0.0001 across the tested ranges. No change warranted.

- Frontend quick wins: CSS dedup (3 dead rules removed), pred-box gradient fix
  (undefined --cell-bg/--accent/--band-europa replaced with --panel and
  --outcome-good), season animation button hidden when <2 matchdays, careers.json
  fetch errors propagated instead of silently swallowed, back button in team focus
  view, head-to-head section in Compare Clubs (current-season record from
  report.results), mobile header reworked — theme and language toggles moved into
  the More sheet to free a row in the masthead grid (3 columns → 2).

## 🎨 Threshold dividers in standings table

The standings table now shows clear zone-separator rows with the expected points
threshold for each band (Champion, CL, EQ, Rel playoff, Relegation). Each
divider sits **one team below the threshold position** so the gap reads as
"above this line = in the zone":

- Champion: between 2nd–3rd
- CL: between 3rd–4th
- EQ: between 5th–6th
- Rel playoff: between 14th–15th
- Relegation: between 15th–16th

Format: `======== Expected CL Threshold: 67p ========` with zone-colored lines
extending to the table edges, large vertical gaps (1.25rem), and small
horizontal gaps (0.2rem). Implemented as dedicated `tr.zone-divider` rows with
`colSpan=15` so lines span all columns.

## 🧪 Frontend: Current/Prediction table toggle

The table now has a Current/Prediction toggle in the panel header. The toggle
persists to `localStorage` under `elitetracker-table-view`. Column membership is
encoded with `data-table-view="current"`, `"prediction"`, or `"current prediction"`.

- Current view: position, club, P/W/D/L, GF/GA/GD, Pts, rating, form.
- Prediction view: position, club, rating, xPts, fixture difficulty, form,
  title probability, relegation probability.
- Fixture difficulty shows as a green/amber/red pill: expected points per
  remaining match for a league-average team (rating 1500) against each team's
  upcoming opponents; higher = easier fixtures.

**Render-order fix:** `toggleTableView()` was called inside `renderStandings()`
after `body.replaceChildren()` but before rows were built, so the visibility
toggle ran against an empty table and had no effect. Moved the call to the end
of `renderStandings()`, after `body.appendChild(tr)`, so all `<td>` cells exist
when the toggle runs.

**Actual root cause of the disappearing table:** `state.activeView` defaults to
`grid` and controls which `[data-section]` panel is visible, while the
Current/Prediction buttons only changed the separate `state.tableView` value.
The table section therefore stayed hidden. `toggleTableView()` now also sets
`state.activeView = 'table'`, making the section visible before applying column
visibility.

## 🔧 build_site parallelism: BrokenProcessPool at high worker counts

**Problem.** `python -m elitetracker.build_site` crashes with
`BrokenProcessPool` when `--jobs` exceeds ~12 on a 20-core Windows machine.
The error means a worker process was terminated mid-task by the OS. 8 workers
completes in ~35s; 12 in ~29s; 14+ dies partway through (non-deterministic,
sometimes 3/79 views, sometimes 48/79). The user reports ~15 GB free RAM.

**Root cause (confirmed).** `ProcessPoolExecutor` on Windows uses the `spawn`
start method: each worker is a fresh process. Two redundant computations
amplified the memory spike:

1. **`_init_worker` called `build_all_careers()` independently per worker.**
   With N workers, N full Elo replays (24 JSON file reads + 11-season replay
   of ~5,760 matches) ran concurrently at startup. Each replay creates ~7 MB
   of transient Python objects (Match instances, lists) that must be allocated
   and freed before the GC can reclaim them.

2. **`prior_attack_defence()` was called ~2x per view with no caching.**
   Each call re-read all 24 match JSON files via `load_slices()` and replayed
   all prior seasons. For a single-season build (79 views) that is ~158 calls
   across all workers, each loading ~1.7 MB of JSON and creating ~7 MB of
   Python objects.

3. **`load_slices()` had no caching** — every call to `prior_attack_defence`
   or `build_all_careers` re-read all 24 match files from disk.

The aggregate memory spike from N concurrent processes each doing heavy
allocation is what Windows kills. The failure is non-deterministic because it
depends on timing: which workers are mid-allocation when the commit charge
hits the system limit.

**Fixes shipped (complete):**

1. **`@functools.cache` on `prior_attack_defence`** (pipeline.py). Callers
   always `.copy()` before mutating, so the cached `AttackDefence` is safe.
   Reduces calls from ~158 to ~1 per season per worker (the cache is
   per-process).

2. **`@functools.cache` on `load_slices`** (pipeline.py). Avoids re-reading
   24 JSON files on every call. The returned `list[SeasonSlice]` is read-only
   by all callers (`SeasonSlice` and `Match` are `frozen=True`).

3. **Precompute careers once in the main process** (build_site.py).
   `build_all_careers()` is now called once before the pool starts, and the
   result is passed to workers as an initarg (0.3 MB pickled, ~48 teams).
   Workers receive the careers dict directly instead of recomputing.

4. **Switch to `multiprocessing.Pool` with `maxtasksperchild`** (build_site.py).
   Workers are recycled after 2 tasks at high concurrency (≥physical cores)
   or 5 tasks at lower counts, preventing memory growth from accumulated garbage.

5. **Adaptive worker cap at physical cores** (build_site.py). Windows `spawn`
   mode hits a kernel resource limit (commit charge / process handle table) at
   `physical_cores + 1` concurrent processes, causing BSOD. The cap now uses
   `psutil.cpu_count(logical=False)` to detect physical cores (14 on this
   machine) and caps workers there. Logical cores (hyperthreads) share the
   same physical resources and don't help CPU-bound simulation work.
   Per-process memory is only ~35 MB RSS; the crash is a system-level limit,
   not Python memory exhaustion.

**Test results (final):**
- 269 tests pass.
- 8 workers: 35s single / ~7 min full. ✅
- 12 workers: 29s single / 387s full. ✅
- 14 workers (physical cores): 29s single / 359s full. ✅
- 16 workers: single OK, full build unstable. ❌
- 20 workers (logical cores): BSOD. ❌

**Correction (2026-09-25): the blue screens are the CPU, not the build.** A full
elo-v12.0 build at the default 14 workers blue-screened with bugcheck **0x101
CLOCK_WATCHDOG_TIMEOUT** (a core stopped answering the clock interrupt; minidump
`C:\Windows\Minidumps\092526-9906-01.dmp`). The machine is an i5-14600KF on a
December 2023 BIOS, which predates Intel's 0x129/0x12B microcode for the Raptor
Lake Vmin instability; 0x101 under sustained all-core load is that fault's
signature, and Python in user mode cannot cause a bugcheck on its own. The
physical-core cap and psutil are gone: `build_site` now defaults to
`min(8, cpu_count)` workers, measured stable. The real fix is a BIOS update
with 0x12B or later microcode (and Intel's default power profile).

**Simulation count analysis (for GitHub Actions context):**

The CI pipeline runs two workflows:
- **refresh.yml** — every 30 min, pulls new results; only commits if data changed
- **deploy.yml** — on push, builds *only the current season* (79 views: 1 live + 78 rewound)

| View | Grid | History (per snapshot × snapshots) | Total per view | Time (2 leagues) |
|------|------|-----------------------------------|----------------|------------------|
| Live | 50,000 | 10,000 × 20 = 200,000 | 250,000 | ~3.5s |
| Rewound | 10,000 | 2,500 × 8 = 20,000 | 30,000 | ~0.4s |

Total per deploy: 1 × 250K + 78 × 30K ≈ **2.6M simulations** → **29s at 14 workers, 35s at 8 workers**.

**Why current counts are optimal (no change needed):**

- Model calibration error: **1.54 pp** (elo-v11.1)
- 50,000 grid → **0.50 pp** worst-cell sampling error (⅓ of model error)
- 10,000 history → **1.31 pp** worst band (below 1 pp display resolution)
- 2,500 rewound history → **~2.6 pp** (acceptable for trend lines)

Increasing to 200,000 grid would cost **4× time** (1.43s → 5.7s per league) for only **2× accuracy** (0.50 pp → 0.23 pp) — invisible on the 1 pp display. The current 50K/10K/2.5K choices sit exactly at the diminishing-returns knee.

**GitHub Actions impact:** CI runners have 2–4 cores. At 2 cores the deploy takes ~2.3 min; at 4 cores ~1.2 min. The 30-min refresh cadence means most runs skip the deploy entirely (no data change). No CI optimization needed.

## 🎯 Prediction table enhancements — shipped

The Prediction view of the table now:

- **Sorts itself on switch:** Prediction opens on xPts ↓, Current on position ↑.
  A sort picked inside a view is remembered for that view (in memory) and
  restored on switching back. `?sort=` still overrides on load.
- **Adds xG / xGA / xGD** (1 decimal, xGD signed): the attack/defence ratings
  read as goals per match against an average side of the division
  (`row.attack` / `row.defence`), sortable as `attack`, `defence`, `xg_diff`.
  *Replaced (September 2026):* the columns are now projected final **GF / GA /
  GD** -- goals so far plus the simulated rest, averaged over the runs
  (`expected_goals_for` / `expected_goals_against`). Labelled like the Current
  view's goal columns rather than "xG", which on this site means the match
  statistic from FotMob/Sofascore.
- **Drops Form**, which is now Current-only.
- **Shows Fixture Difficulty with 2 decimals** (`pipeline` rounds it to 2 now)
  as a pill centred on the **league's mean run-in**, not 1.50. With draws, an
  average side against average opponents earns about (3 − P(draw))/2 ≈ 1.37
  points a match, so a 1.50 neutral painted nearly every club red. Within
  ±0.02 of the mean the pill is transparent with a border. Below the mean it is
  red (harder), above it green (easier), reaching full colour at ±0.15, which
  is about the real spread.

`toggleTableView` (button handler: sort + re-render) is split from
`applyTableView` (visibility only, called at the end of `renderStandings`). The
stored plan had the handler call `renderStandings`, which already called the
handler, and that recursed.

## 🧪 elo-v12.0: sharper goals model, xG margin, and season odds with a strength shock (September 2026)

Scored with the **ranked probability score** alongside log loss and Brier: RPS
over home/draw/away for single matches, and RPS over the sixteen finishing
positions for season odds, where the order of the outcomes is the whole point.
Match-level comparisons are paired per match; season-level ones are
clustered by season-league (the sixteen clubs of one table are not
independent), so t has 20 clusters behind it, not 1,280 rows.

### Shipped: a strength shock in the Monte Carlo

The simulation held every club's strength fixed for the rest of the season, so
each run replayed the same odds and the finishing grid was too sure of itself.
Each run now draws one shock per club, N(0, 0.15) in log-odds of win against
loss, held for that run (`simulation/season.py`, `STRENGTH_SD`). Single-match
odds are untouched.

Backtest: every finished season 2016–2025, both divisions, simulated from the
start, a quarter, half and three quarters in, 10,000 runs each, scored against
the final table:

| sd | RPS (positions) | t | log loss of actual position | t | Brier | t |
|---|---|---|---|---|---|---|
| 0.05 | −0.00008 | −1.2 | +0.0019 | +0.9 | +0.0002 | +0.6 |
| 0.10 | −0.00049 | −3.0 | −0.0113 | −2.9 | −0.0008 | −1.3 |
| **0.15** | **−0.00084** | **−2.7** | **−0.0183** | **−3.0** | −0.0011 | −1.0 |
| 0.20 | −0.00105 | −2.3 | −0.0205 | −2.3 | −0.0005 | −0.3 |
| 0.25 | −0.00098 | −1.6 | −0.0178 | −1.6 | +0.0007 | +0.3 |

Negative in both divisions and both halves (2016–2020 small, 2021–2025
t ≈ −3.9 at 0.15, where K is faster and ratings move more). Re-measured through
the shipped `simulate_season`: RPS −0.00093 (t −3.1), log loss −0.016 (t −2.9).
Cost: about 45 % more CPU per simulation.

### Measured and rejected (match odds)

Baseline for all of these: the shipped blend, scored 2016+ (n=5,152): log loss
1.00178, Brier 0.59837, RPS 0.20926; −0.0039 / −0.0027 / −0.0012 against Elo
alone (t −2.8 / −2.7 / −2.5). Market gap on Eliteserien (n=2,552): +0.0114 log
loss, +0.0038 RPS.

- **Calendar: rest days, European and cup congestion — dead.** All UEFA
  competitions (qualifiers included, fotmob ids 10611/42/10613/73/10615/10216)
  and the NM Cup (206), 2014/15–2026/27, were pulled into
  `data/raw/fotmob_other_matches.json` (1,578 matches involving our clubs, ~85
  page requests). The shipped model's residual (actual points share minus the
  predicted one) against rest days of either side, rest-day difference, a
  European match within 4 days before or after, a cup match within 4 days
  before: every bucket |t| < 1.7, most < 1, no monotone pattern. The late-season
  and August market gap is not congestion.
- **Cup matches as extra rating updates — null.** 213 cup ties between two
  league clubs of that season, at K×0.5/K×1, with and without the attack/defence
  update, home or neutral: every variant within ±0.0001 log loss (|t| < 1).
- **Recalibration layers fitted walk-forward** (on all prior seasons, applied
  to the next): temperature on the blend settles at 1.09–1.12 and is worth
  −0.0010 (t −1.4); temperature + outcome biases −0.0006 (t −0.6); biases alone
  +0.0005; a multinomial stack of log Elo and log grid −0.0003. The home-bias
  that the market analysis found does not survive out of sample.
- **Multi-timescale ensembles** (attack/defence at ×0.5/×2/×3 the step,
  blended 50/50 with the shipped one; Elo at K 15 or 60 alongside): +0.0012 to
  −0.0002, nothing past |t| 1.1.
- **Offseason pull toward each club's own long-run level** (EWMA of its
  end-of-season deviation from the division mean) instead of the division
  mean, in Elo, attack/defence or both: best −0.0002 (t −1.8), and worse for
  Elo on its own.

### The ship rule, revised

`|t| >= 2` on a paired in-sample test was the bar for everything. At n ≈ 5,000
it has little power for effects of 0.0005 log loss, so small but consistent
gains (the spread below, the xG margin, each negative in every half) were parked
season after season, while the one thing it does not guard against, picking
the best of many sweeps, went unaddressed. For **cheap one-knob changes** the
bar is now:

1. the gain **out of sample** (the value chosen walk-forward from prior
   seasons only, scored on the next) is negative on log loss, Brier and RPS;
2. same sign in both date halves;
3. t ≤ −1 on that out-of-sample test;
4. ship a value shrunk toward "no change", not the sweep's best;

`|t| >= 2` stays for anything that adds complexity or a new data dependency.

### Shipped: de-shrinking the goals model (`ADConfig.spread` 1.10)

The grid is under-confident on favourites: where it prices the home side at
0.60–0.70 they win 0.72, at 0.70+ they win 0.81 (Elo: 0.67 / 0.77). Stretching
each side's attack − defence + finishing by s at prediction time (the online
update still learns against the unstretched rates, so the ratings are
unchanged):

| s, fixed, 2016+ | log loss | t | Brier | t | RPS | t |
|---|---|---|---|---|---|---|
| 1.05 | −0.00046 | −3.2 | −0.00026 | −2.8 | −0.00011 | −2.6 |
| 1.10 | −0.00080 | −2.8 | −0.00045 | −2.4 | −0.00019 | −2.2 |
| 1.15 | −0.00104 | −2.4 | −0.00056 | −2.0 | −0.00024 | −1.8 |

It survives refitting the blend weight on both sides (the best weight at s=1.0
gains only −0.00007) and is the same size at every stage of the season, so it
is not the offseason pull; it reads as the lag of a fixed-step online update.
**Walk-forward** from {1.0, 1.05, 1.10}: 1.10 is picked in every season
2019–2026, and out of sample it is worth −0.0011 log loss (t −3.0), Brier
t −2.6, RPS t −2.3; halves −0.0012 (t −2.7) / −0.0009 (t −1.7). With the grid
open to 1.20 the pick drifts to 1.20 and the out-of-sample gain is no larger
(−0.0014, t −2.1), so 1.10 is the shrunk value. Ported to the browser
(`scoreGrid`, `report.model.attack_defence.spread`).

### Shipped: xG margin of victory in the Elo update (`EloConfig.xg_margin` 0.05)

The term parked under "Post-elo-v11.1 knob sweeps", judged this time on Elo's
own odds, since what it changes is the displayed rating. Walk-forward from
{0, 0.05, 0.10}: −0.0007 log loss out of sample (t −2.0), Brier t −1.8,
RPS t −1.7, halves t −1.5 / −1.4. In-sample, γ 0.05 keeps 90 % of 0.10's gain
at a better t (−0.00055, t −3.2 against −0.00062, t −2.4). On top of the
spread its contribution to the blend is small (−0.00006), the reason it ships
is the ratings.

### Rejected out of sample: per-era K / α (K 50–80, α 0.5–0.75)

Walk-forward over K {30, 50, 80} × α {0.3, 0.5, 0.75}: the blend is +0.0002
*worse* out of sample, and Elo alone −0.0008 with the first half +0.0005.
The full-window sweep that found K=70–90 was selection, not signal. Closed.

### elo-v12.0 against elo-v11.1, all together

| scored 2016+ (n=5,152) | log loss | t | Brier | t | RPS | t |
|---|---|---|---|---|---|---|
| shipped odds (blend) | −0.00087 | −2.8 | −0.00048 | −2.3 | −0.00021 | −2.1 |
| Elo alone (the ratings) | −0.00055 | −3.2 | −0.00036 | −3.1 | −0.00016 | −3.0 |

Gap to the Eliteserien closing line: +0.0114 → +0.0107 log loss. The season
shock re-measured on top of the new match odds: sd 0.15 is worth RPS −0.0012
(t −3.7), log loss −0.023 (t −3.4) over the positions; 0.10 and 0.20 bracket it.

### Why are the favourites under-priced? Regression and lag, measured

The obvious suspect for compressed ratings is the offseason pull toward the
division mean. Swept jointly, Elo pull × attack/defence pull {0.80, 0.88, 0.94,
1.00} × finishing pull {0.50, 0.70, 0.85, 1.00} × spread {1.00–1.20}, against
elo-v12.0 (0.88/0.88/0.70, spread 1.10):

- No pull in the goals model (1.00) makes every metric worse (+0.0005 log loss)
  and still wants a spread of 1.10–1.15. A *stronger* pull (0.80) wants a
  *larger* spread (1.20). The compression is not the pull.
- Elo alone: 0.88 is still the best pull (0.80 +0.0002, 0.94 +0.0001, 1.00
  +0.0006).
- Walk-forward over the pulls at spread 1.10: +0.00015 (worse); with the
  spread free as well: −0.0004 (t −1.1), first half t −0.6. Nothing to change.
- A faster attack/defence step (×1.5, ×2) does not remove the need for the
  spread either; it is worse at every spread (×2: +0.0022, t +2.2).

So the stretch stays a prediction-time correction; its cause is not the pull
and not simple lag.

Also measured against elo-v12.0 and left alone:
- **Elo-side spread** (the rating gap × c at prediction): in-sample −0.0003
  (t −2.4) at c 1.10, and walk-forward picks 1.10 every season, but out of
  sample the gain is entirely in the first half (t −3.4); the second half is
  flat on log loss and slightly positive on Brier and RPS. Fails rule 2.
- **Draw model** (0.24–0.28 × 300–450), **ρ** (−0.12 to 0), **blend weight**
  (0.20–0.35) with the spread in place: all within |t| < 1.6.
- **Spread per division**, walk-forward (OBOS picks 1.20, Eliteserien
  1.00–1.20): +0.00005 against the single 1.10.

### Momentum, re-tested on the xG-era model — rejected again

The elo-v3 rejections (EWMA form, the autocorrelation damper) were on plain
Elo. The spread finding (ratings too close together) reopened the question: a
rating trailing a club that is still rising would look exactly like that. Three
readings, all at prediction time on top of elo-v12.0, scored 2016+:

- **Residual xG form** (EWMA of a club's recent xG difference above what the
  model expected, as a log-odds shift): worse in both directions at every
  weight (+0.2: +0.0086, t +4.0; −0.2: +0.015, t +7.0). Once the ratings have
  absorbed a result, nothing of recent form is left to add.
- **Attack/defence trend** (extrapolate the last 3/5/8 matches' change): flat
  or worse, up to +0.0028 (t +2.5).
- **Elo trend** (rating + β × its change over the last n matches): the one
  with a sign, consistently small gains in-sample (n 8, β 0.25–1.0: −0.00014
  to −0.00032, t −0.9 to −1.6) and mean reversion clearly worse (β −0.5:
  +0.0004, t +2.3). Walk-forward over n {5, 8, 12} × β {0–1} × within/across
  seasons: −0.00005 (t −0.1) out of sample, first half −0.0005 (t −2.1),
  second half +0.0004. The pick wanders (n 5→12→8, β 0→1). Rejected.

### Penalties and red cards — measured, nothing to change

fotmob's match details for every Eliteserien match 2020–2026 (1,608) are in
`data/raw/fotmob_match_extras.json`: each shot's minute, side, xG and situation
(penalty or not), red-card minutes and goal minutes. Pulled at one request
started every 1.75 s. xG rebuilt from the shots reproduces the stored values to
+0.00002 log loss (fotmob revises recent matches). Against elo-v12.0, both the
Elo xG update and the attack/defence observation switched together:

| variant | log loss | t | Brier | t | RPS | t | halves (log loss t) |
|---|---|---|---|---|---|---|---|
| penalty xG ×0 (non-penalty xG) | +0.00089 | +2.4 | +0.00057 | +2.2 | +0.00021 | +1.8 | +1.7 / +1.8 |
| penalty xG ×0.5 | +0.00035 | +1.9 | +0.00022 | +1.7 | +0.00007 | +1.3 | +1.5 / +1.4 |
| penalty xG ×1.5 | −0.00016 | −0.9 | −0.00008 | −0.7 | −0.00002 | −0.3 | −1.0 / −0.5 |
| half step after a red before 70' (106 matches) | −0.00002 | −0.1 | −0.00005 | −0.4 | −0.00003 | −0.5 | **+2.7** / −1.2 |
| same, before 60' | +0.00003 | +0.2 | −0.00002 | −0.1 | −0.00001 | −0.2 | +2.1 / −0.7 |
| no update after a red before 70' | +0.00020 | +0.5 | +0.00006 | +0.2 | +0.00001 | +0.1 | +2.9 / −0.7 |
| xG only up to the red, scaled to 90' | +0.00043 | +1.4 | +0.00022 | +1.0 | +0.00010 | +0.9 | +1.9 / +0.8 |

Penalties are signal, not noise: a side that wins them dominates the box, and
taking them out costs in both halves. Weighting them up is picked every season
walk-forward and is worth −0.00005 (t −0.2) out of sample, with Brier and RPS
slightly positive — nothing. Red cards flip sign between the halves; walk-forward
keeps the plain update every season. Both closed.

### Data sources, for the record

Sofascore now answers 403 from this machine on every endpoint (the OBOS xG
refresh included); FBref sits behind Cloudflare (403). Neither was retried.
fotmob's match details carry shot counts, shots on target and big chances for
Eliteserien back to at least 2017, but nothing for OBOS-ligaen before 2023.

## 🎯 Trend arrow on xG form (September 2026) — shipped

The arrow beside a rating (table and team view) was a weighted average of the
last 6 actual rating changes. Those are mostly result luck: an Elo change is the
surprise in a result, and surprises do not persist. Measured on 3,738
club-season windows with xG (Eliteserien 2020→, OBOS 2023→), correlation of the
arrow's value with the next 3 matches:

| window | signal | next 3 by xG | next 3 by rating Δ | mean age | label flips |
|---|---|---|---|---|---|
| linear 0.1…0.6, last 6 (old) | rating Δ | −0.01 | 0.06 | 13 d | 53 % |
| **linear 0.1…0.6, last 6 (shipped)** | **xG form** | **0.17** | **0.15** | **13 d** | 47 % |
| equal, last 6 | xG form | 0.17 | 0.16 | 19 d | 39 % |
| equal, last 3 | xG form | 0.14 | 0.13 | 8 d | 55 % |
| decay, half-life 21 days | xG form | 0.17 | 0.15 | 20 d | 46 % |

xG form per match is `K · (xG-implied score − expected score)`: the rating change
the chances alone would have produced (`pipeline.xg_form`, served per result as
`xg_form: [home, away]`). With it the window barely matters; the linear weights
keep the most recent information (the last three matches carry 71 %) at full
signal. Cut-offs ±1 / ±4 per match keep the old mix of arrows (the signal's sd is
2.9 against 4.3). Clubs or seasons without six xG matches fall back to the old
rating-change arrow and wording. Display only: no prediction changes, no
`MODEL_VERSION` bump.

## 🎨 Site pass: rewind/season bugs, projected goals, UI consistency (September 2026) — shipped

Display and data-payload changes only; predictions are untouched, `MODEL_VERSION`
stays elo-v12.0.

**New data in the report**
- `results[].xg` (`[home, away]`) printed under every played score, so a rating
  move can be read against the chances. `results[].xg_form` feeds the trend arrow
  (section above).
- `table[].expected_goals_for` / `expected_goals_against`: season totals averaged
  over the simulations -- goals so far plus the simulated scorelines. The Monte
  Carlo already drew them for the tiebreak; it now sums them. No extra random
  draws, so every probability is bit-identical. Shown in the Prediction table as
  projected **GF / GA / GD** (not "xG", which on this site means the match
  statistic); older reports without the fields show a dash.
- `careers.json` is no longer thinned to 400 points per club: Played Results and
  the arrows read each match's rating change by date, and the longest career
  (364 points) would have crossed the cap in 2027.

**Rewind and season-switch bugs fixed**
- Slider sat on matchday 1 after switching division while rewound (the divisions
  play on different dates): now the last matchday on or before the rewound date.
- Out-of-order responses: rewinds and season loads share one request counter, so
  a slow earlier fetch can no longer paint over a newer one; a pending slider
  fetch and the animation are stopped by every season change; a season load that
  fails keeps `state.asof` describing the page still on screen.
- `?season=` / `?asof=` are written back to the URL, so a reload or shared link
  lands where the reader was.
- Team view follows a promoted/relegated club into its division when the season
  changes, instead of showing today's rating and no matches.
- Finished seasons show "—" for fixture difficulty (no run-in) rather than a blank.
- Short club names (HamKam, Odd, ...) also applied to head-to-head meetings and to
  the matchday reports the finish-grid/ladder animation prefetches.
- Status line: a careers failure stays visible; a later successful season load
  clears an earlier error.

**UI**
- One pagination control (`pageNav`) everywhere, modelled on Played Results: Next
  Up is paged by ISO week, the team page and Compare head-to-head by page.
- Animation controls: labelled Play/Stop button, a bar under the panel head with
  the date on show, a progress bar and a 1×/2×/4× segmented speed control.
- Team view: tile strips for position/points/GD/played and for attack/defence as
  ± % against the division average (defence inverted, + is better), with a
  diverging bar; a quieter back button; form removed.
- Phones: rewind slider keeps its place above the view (it jumped mid-drag);
  Played Results and Next Up show crests only, larger.
- Model card: the modern era's xG weight is *lower* (30 %) than the legacy 45 %.

## 🎨 Team view mobile consistency (September 2026)

The "Played Results" and "Next Up" tabs already showed crests only (no team names) on mobile, with 40px crests and invisible-but-accessible name buttons overlaid. The team view's match cards used the same render functions but rendered inside `#team-content` instead of the main tab containers, so the mobile-only CSS selector missed them.

Extended the CSS selector from `:is(#played-results, #fixtures)` to `:is(#played-results, #fixtures, #team-content)` so the team view now matches the main tabs exactly: 40px crests, hidden names, accessible overlay. No JS changes needed — the existing `sideBlock`/`buildFixtureCard`/`playedCard` output already had the right classes.

## 🎨 Standings attack/defence columns and pill ramps (October 2026) — shipped

Frontend-only pass over the Table view (no `MODEL_VERSION` bump; `elo-v12.0` unchanged).

**Attack/defence columns.** `rateRow` already carried `attack`/`defence` as
`rates_against_average` (expected goals per match vs an average side); the table
now renders them as ±% vs the division average (`attack_pct`, `defence_pct` —
defence inverted so higher is always better) in red→gray→blue diverging pills
(`makePctPill`), sortable. The `Math.abs()` sign bug on the saturation term is
fixed (extremes now reach ~85 %/92 %), contrast verified AA at both ends
(5.01 / 5.65). i18n gained `th.attack.desc`/`th.defence.desc` (team-view hints
reused as `title=` tooltips).

**Fixture-difficulty pill.** The coarse three-step chip became a granular
monotone red→gray→green ramp (hue 0/135, flat background) scaled by the
league's own max |gap|, so the run-in reads as one axis rather than three
buckets — the extreme is now the league's hardest/easiest run-in, not an
arbitrary cutoff.

**Form.** Reverted to the git-history design (`9ebf7b5~1`): five W/D/L blocks
blue/gray/red, whole-form tooltip from new `form.tooltip` i18n key
(EN `{w}W {d}D {l}L`, NO `{w}S {d}U {l}T`). The column still sorts by the last
five's points (`formPoints`, out of 15). Form stays Current-view only — the
Prediction toggle drops it.

**Copy.** `Kamptakt` → `Kampprogram` in NO/EN.

**Validation.** `node --test tests/frontend.test.js` 13/13, `pytest` 276,
`build_site --only-season 2026` 79 views — all green after the final CSS change.

**Docs.** README audited line-by-line against the code and corrected: data
sources (Sofascore/football-data/Transfermarkt), era config applies to both
divisions from 2022 with xG weight *lower* not higher, 7 nav tabs + Team Focus,
Finish Grid dark-mode ramp/bands, the new Current/Prediction table columns,
ladder phone list, played-card xG, three Compare blocks incl. real head-to-head,
Model Card strength-shock row, team-view summary bullets, and a rewritten
"Key stats explained" (xPts = simulation mean, attack/defence = ±% display of
the rates, xG-form trend thresholds).

## 🧪 elo-v13.0: the IMPROVEMENTS.md sweep (October 2026) - shipped

Every model item in `IMPROVEMENTS.md` was measured one at a time against
elo-v12.2, then the survivors together, then the dormant hooks and the main
constants re-swept on top of them. Old rejections were re-run on the current
model rather than taken from this log (some came back different). Harness:
`experiments/improvements/harness.py`, a replay that reproduces the shipped
model to 2e-16 over all 5,663 played matches; each item's script and its
output are beside it (`out/*.txt`). The scripts import the model from `src`,
so they measured against elo-v12.2 when they ran; to reproduce them exactly,
put a worktree of `ed7b2b0`'s `src` first on `PYTHONPATH`.

Scoring as in elo-v12.0: log loss, Brier and RPS over home/draw/away, paired
per match; `all16` is both divisions scored 2016+ (n = 5,183), the xG window
the matches that carry xG (Eliteserien 2020+, OBOS-ligaen 2023+, n = 2,523).
"Out of sample" (OOS) means each season scored with the value that did best on
the seasons before it, 2019 onward (n = 3,743; 2021 onward for xG-only
changes), the ship rule for one-knob changes. Baseline elo-v12.2, all16: log
loss 1.00047, Brier 0.59760, RPS 0.20881, calibration 0.0084.

### Shipped

| change | what | out of sample |
|---|---|---|
| xG margin signed by xG (`EloConfig.xg_margin` 0.10, `xg_margin_smoothing` 0.25) | 1.1: a bug fix, below | Elo's own odds -0.00105 (t -2.91), Brier t -2.95, RPS t -2.79 |
| `xg_implied_score` by recurrence to 12 goals, normalised | 1.3 | neutral (Elo -0.000004, t -1.3); a correctness fix |
| offseason pull toward a value-shifted mean (`ADConfig.value_pull` 0.2) | 1.7 | -0.00127 (t -2.84), Brier t -2.74, RPS t -2.62 |
| early-season step (`ADConfig.early_boost` 0.5, `early_tau` 3) | 1.8 | -0.00080 (t -1.54), Brier t -1.32, RPS t -1.30 |
| strength shock 0.15 -> 0.20 (`simulation.season.STRENGTH_SD`) | season odds, below | RPS over places t -3.2 against 0.15 on the same model |

**All together against elo-v12.2**, all16: log loss -0.00127 (t -3.51), Brier
-0.00086 (t -3.41), RPS -0.00040 (t -3.34), halves t -2.44 / -2.53; OBOS
-0.00210 (t -4.00), Eliteserien -0.00043 (t -0.86), xG window -0.00079
(t -1.61). Elo's own odds (the displayed ratings): -0.00065 (t -3.10), on the
xG window -0.00132 (t -3.09). New figures: log loss 0.99920, Brier 0.59674,
RPS 0.20841, calibration 0.0095. Each part on top of the other two: value pull
-0.00078 (t -3.08), early step -0.00039 (t -1.80), margin -0.00003 on the
blend (its value is Elo's own odds).

**1.1, the xG margin was signed by the scoreline.** elo-v12.0's term added
`winner * gamma * ln(1 + |ln(home_xg / away_xg)|)`, `winner` from the goals:
a 1-0 win on 0.25 xG to 2.50 got the *largest* bonus, for being outplayed the
most, and draws and 0.0 xG were skipped. Variants, judged OOS on Elo's own
odds like elo-v12.0 judged the original:

| variant | Elo, all16 2019+ | t | halves t | blend |
|---|---|---|---|---|
| old form, gamma re-swept 0-0.12 | +0.00004 | +0.24 | +0.19 / +0.17 | -0.00000 |
| A1: signed by the xG winner, decided matches only | -0.00074 | -2.67 | -0.95 / -2.50 | -0.00006 |
| A2: zero when goals and xG disagree | -0.00045 | -2.41 | -1.15 / -2.12 | -0.00004 |
| **B: signed by ln((xg_h + c) / (xg_a + c)), every xG match** | **-0.00105** | **-2.91** | -1.63 / -2.46 | -0.00008 |

B picks gamma 0.12 and c 0.15 from 2021 on, the edge of the planned grid
(0.03-0.12 x 0.15-0.35). Widened to 0.4 the gain keeps growing (gamma 0.4:
-0.0026 in-sample) but the per-match t peaks at gamma 0.05-0.12 (-3.2) and the
OOS pick drifts to 0.3-0.4 at t -1.85, which reads as the margin standing in for
a larger xG weight. Shipped at 0.10 with c 0.25: c 0.05-0.25 are within
0.00015 and the larger c is the safer one at 0.0 xG.

**1.2, a logistic of a goal/xG margin instead of the result: rejected.**
S = 1 / (1 + 10^(-dy / c)), dy = w (xG_h - xG_a) + (1 - w)(G_h - G_a), w
0.5-1.0, c 1.5-4. Alone OOS -0.00105 (t -1.21) with the first half flat; blended
50/50 with the shipped observation -0.00124 (t -2.54) but the first half
positive (+0.77); for the matches without xG (a goal margin, rejected in elo-v3)
-0.00046 (t -0.37) and calibration worse (0.0142 against 0.0119). None of the
three moves the blended odds (+0.00018, +0.00004, 0).

**1.3.** The double loop stopped at 9 goals unnormalised: 5.0 v 0.3 xG scored
0.957 against 0.989. The recurrence is within 1e-6 of the untruncated sum at
ordinary xG and 2e-4 at 4+ a side. Effect on the odds: none to measure.

**1.7, squad market values: shipped in the goals model, not in Elo.** The
2026-09 test above put the pull on the Elo ratings only. Re-run, with
leak-free values (each season's target from the *previous* season's page;
91.5 % of club-seasons have one, the rest are up from the third tier) and with
the same-season page as a check:

| variant (all16) | in-sample | OOS 2019+ |
|---|---|---|
| goals model pulled toward mean + beta * v, beta 0.05 / 0.1 / 0.2 / 0.3 | -0.00025 (t -3.70) / -0.00047 (t -3.53) / -0.00085 (t -3.17) / -0.00113 (t -2.81) | picks 0.3 every season: **-0.00127 (t -2.84)**, halves t -2.87 / -0.80 |
| same, with the pull at 0.80 | beta 0.4: -0.00178 (t -2.29) | picks (0.4, 0.80): -0.00194 (t -2.53), OBOS only |
| same-season page (possible hindsight) | beta 0.05: -0.00022 (t -3.29) | -0.00097 (t -2.21) |
| Elo pulled the same way, beta 25-150 | Elo's own odds -0.00021 (t -2.16) at 25 | Elo -0.00031 (t -0.63); blend -0.00049 (t -2.83), halves -2.95 / -0.97 |
| Elo pull on top of the goals-model pull | | -0.00029 (t -1.68), xG window -0.00001 |
| newcomers seeded from value (Elo) | +0.00020 / +0.00097 at beta 50 / 100 | |
| in-season covariate gamma * dv in the rates | gamma 0.05: -0.00076 (t -2.44) | picks 0.1: -0.00120 (t -1.62), halves -1.95 / -0.41 |

Where it lands: OBOS-ligaen -0.00426 OOS (t -3.59), Eliteserien +0.00042; the
xG window -0.00021 (t -0.50); 2023+ Eliteserien +0.00004, OBOS -0.00067
(t -0.96). It is the prior that helps where results alone are noisy, so its
value now that OBOS has xG is small. Shipped at 0.2 (the pick is 0.3-0.4, and
a value pull clears |t| >= 2 as a new data dependency). The displayed Elo
ratings stay free of market values. The yearly data step is in docs/data.md.

**1.8, an early-season step: shipped.** Step k * (1 + g exp(-n / tau)), n the
club's matches so far that season, per club in the goals model (the zero-sum
Elo update uses the pair's mean n):

| g x tau | goals model, all16 | Elo | OOS |
|---|---|---|---|
| 0.2 x 3 | -0.00021 (t -2.42) | -0.00017 (t -1.47) | |
| 0.5 x 3 | -0.00045 (t -2.10) | -0.00030 (t -1.04) | |
| 1.0 x 3 | -0.00065 (t -1.58) | -0.00019 (t -0.34) | goals model picks it every season: -0.00080 (t -1.54), halves -1.08 / -1.11; Elo -0.00029 (t -0.62) |

Wider (g to 2.0) the pick wanders 1.0-2.0 and OOS falls to -0.00063
(t -0.97); re-sweeping the spread alongside (1.0-1.15) gives -0.00061 (t -1.47),
so `spread` stays 1.10. 2023+: Eliteserien -0.00044, OBOS -0.00079 (t -1.21).
Shipped at g 0.5 (half the pick), tau 3, goals model only.

**Season odds and the strength shock.** Every finished season 2016-2025, both
divisions, simulated from pre-season, a quarter, half and three quarters in
(10,000 runs) and scored on the final table, t clustered by season-league
(`experiments/improvements/season_check.py`):

| against | RPS over places | t | log loss of the place | t |
|---|---|---|---|---|
| elo-v13.0 at sd 0.15 vs elo-v12.2 | -0.00046 | -1.12 | +0.00268 | +0.54 |
| the margin change alone | +0.00001 | +0.43 | +0.00146 | +2.81 |
| elo-v13.0: 0.20 vs 0.15 | -0.00051 | -3.22 | -0.0125 | -2.58 |
| 0.25 vs 0.15 | -0.00077 | -2.44 | -0.0177 | -2.20 |
| 0.30 vs 0.15 | -0.00071 | -1.52 | -0.0127 | -1.24 |
| elo-v12.2: 0.20 vs 0.15 | -0.00040 | -2.60 | -0.0071 | -2.19 |
| **elo-v13.0 at 0.20 vs elo-v12.2 as shipped** | **-0.00097** | **-2.48** | **-0.0098** | **-2.58** |

The correctly signed margin spreads the ratings a little, so with the old shock
the season odds came out slightly too sure (Eliteserien place log loss
+0.0124, t +1.82). 0.20 beat 0.15 on elo-v12.2 as well, so part of the move is
the seasons added since elo-v12.0. The whole change is negative in both halves
(RPS 2016-2020 t -1.32, 2021-2025 t -2.12) and both divisions (OBOS RPS t -2.76).

### Rejected (or re-rejected)

- **1.4 xG/xGOT blend** in the goals model's observation, beta 0.15-0.5:
  +0.00002 to +0.00026, OOS +0.00027 (t +1.13); in the Elo update within
  ±0.00004. The xGOT signal stays out (as pure xGOT did in elo-v7).
- **1.5 provider calibration.** Goals per xG: FotMob (Eliteserien) 1.025 over
  1,616 matches (0.94-1.20 a season), Sofascore (OBOS) 0.987 over 907
  (0.92-1.07): no offset beyond season noise. A scalar on OBOS xG: x1.03
  -0.00044 (t -1.50) in-sample, OOS (picks 1.06) -0.00022 (t -0.53), second half
  +0.01. Sofascore's Eliteserien xG (886 matches with both, 3.17 a match against
  FotMob's 3.08, r 0.857) averaged in at 0.25 / 0.5: +0.00010 / +0.00030
  (matches the S4 result in experiments/LOG.md).
- **1.6A finishing in the learning rates.** The 0.75 xG + 0.25 goals
  observation does pull a good finisher's attack down against a target that
  includes all of its finishing; weighting finishing by 1 - alpha there (or the
  exact mixture) is worse: +0.00023 / +0.00024, OOS +0.00128 (t +1.86), Brier
  t +2.10, RPS t +2.45. The "contamination" works as shrinkage of the finishing
  term and stays.
- **1.6B centring the attack - defence level.** The opposite drift of mean
  attack and mean defence is the model learning the scoring rate (`base`
  cancels, see elo-v11): predicted goals a match track actual within about 0.1
  most seasons (worst: Eliteserien 2022, 2.88 against 3.25). Re-centring at
  each season start (x0.25 / 0.5 / 1) leaves outcomes flat (+0.00002 to
  +0.00010) and hurts scorelines (exact score +0.00388, t +2.98; over/under 2.5
  +0.00305, t +2.89, at full).
- **1.6C a tempo interaction** exp(tau e_h e_a), e = attack - defence against
  the division: outcomes within ±0.0001 (tau -1 to 2), exact scorelines worse
  for every tau > 0 (tau 1: +0.00202, t +3.15). The log-linear form is enough.
- **1.9 rest days and UEFA congestion, again.** Rest-day difference (64 % of
  matches equal), any competition or league only, as a shift on home advantage
  in either model: in-sample |t| < 1.9, OOS -0.00004 (t -0.44) and -0.00013
  (t -0.64). A UEFA match in the 4 days before (115 home, 122 away cases): OOS
  +0.00029 (t +1.87). Same verdict as elo-v12.0.
- **1.10 pitch surface: parked here, shipped in the second part** once the
  table was checked and the Eliteserien-only form found (see "elo-v13.0, second
  part"). Grass from Wikipedia's list of Eliteserien
  venues (Rosenborg, Brann, Lillestrøm, Haugesund, Bryne throughout; Viking to
  2017, Vålerenga to 2016, Stabæk to July 2023, Sandefjord to 2023; a few
  second-tier grounds guessed, since checked: normalize/surfaces.py). Both mismatch directions point
  the same way (the home side on its own surface does better), and one term
  for any mismatch, +10 Elo points, is -0.00017 in-sample (t -2.33) but all of
  it 2016-2020 (halves -2.52 / -0.83); OOS -0.00024 (t -0.55), Eliteserien
  alone -0.00093 (t -1.53), Elo's own odds worse (+0.00059). Fails the |t| >= 2
  bar a maintained table needs.
- **1.11 the dormant hooks and the constants, on the bundle.** OOS:
  `OUTCOME_BLEND` (picks 0.3-0.4) +0.00019; `blend_gamma` 0.1-0.6 never picked;
  `rho` -0.11 to 0 +0.00004; `ADConfig.home_beta` -0.00022 (t -0.56, second half
  +); `home_advantage_beta` +0.00001; `spread` +0.00033; Elo home advantage
  -0.00024 (t -0.92, second half +); goals-model home -0.00014 (t -0.26); modern
  K x alpha, Elo's own odds -0.00146 (t -2.06) but all of it from 2023 (picks
  K 45, alpha 0.6; first half 0.00) and the blend +0.00011, the K=70-90 trap
  again. Nothing moves.
- **1.12 refitted IPF instead of the online learner.** A time-decayed,
  opponent-adjusted multiplicative fit with empirical-Bayes shrinkage (tau0
  pseudo-matches at the mean), refit every matchday on everything before it,
  same observation and grid: half-life 120-730 days x tau0 3-12, every one
  +0.012 to +0.021 log loss against the online grid (t +5.5 to +7.7). The online
  learner stays. The synthetic shot-volume xG for matches without xG cannot be
  built from local data: the only shot counts on disk are FotMob's match extras
  for Eliteserien 2020-2026, which already have xG, and football-data's
  Norwegian CSV has no shots. Not scraped.

### Bookmaker benchmark (1.13)

`model/benchmark.py` keeps the raw closing prices beside the probabilities
(`data/odds_closing_prices.json`, from the same CSV) and de-vigs three ways.
Eliteserien 2016+, n = 2,576:

| | log loss | Brier | RPS | calibration | elo-v13.0 vs it |
|---|---|---|---|---|---|
| elo-v13.0 | 0.99475 | 0.59378 | 0.20649 | 0.0134 | |
| close, proportional | 0.98472 | 0.58670 | 0.20295 | 0.0089 | +0.01003 (t +3.37) |
| close, power | 0.98390 | 0.58632 | 0.20280 | 0.0078 | +0.01084 (t +3.53) |
| close, Shin | 0.98416 | 0.58643 | 0.20284 | 0.0076 | +0.01059 (t +3.48) |

Removing the favourite-longshot bias makes the market better, so the honest
gap is about 0.0108, not 0.0100. Quarter-Kelly on the model's edges at the
closing price (cap 2.5 % a bet, edge >= 3 %): 1,947 bets, 30 % won, ROI -1.5 %,
bankroll x0.31 (Elo alone -6.8 %). Closing-line value needs pre-closing prices,
which the CSV does not carry. `python -m elitetracker.backtest_cli --market`
(or `research run`) prints all of it; `--calibration` writes the Explore view's
file, which `build_site` also writes every build.

### Scrapers (phase 2): nothing added (passive parsing came later: see "IMPROVEMENTS.md, checked item by item")

Re-tested on elo-v13.0 with the local match extras (Eliteserien 2020-2026,
1,608 matches, 503 penalties, 185 red cards): penalty xG x0 / x0.5 / x1.5
+0.00058 / 0.00000 / +0.00078, OOS +0.00045 (t +0.87); a step down-weighted by
an early red card (r = 1 - s (90 - minute) / 90, s 0.35 / 0.65) +0.00040 /
+0.00055 and never picked OOS. Neither is used, so neither gets a parser.
Lineup values: elo-v4 above (even a perfect starting XI is worth at most 0.0025;
upcoming lineups do not exist before kickoff; FotMob serves present-day
values). Odds in a payload already fetched: `refresh` asks FotMob's match
details for Eliteserien only (football-data covers those) and Sofascore's
statistics endpoint for OBOS-ligaen, which has no odds, so there is nothing to
piggyback on. No request was added anywhere; the one network call in this pass
was football-data's CSV, once, to store the raw prices.

### Pipeline (3.1)

Already done in elo-v12.2: the season-shape snapshots run with
`tally_conditionals=False` (`simulation/history.py`), which is where the
+32 % in "High-stakes matches" came from.

## 🧪 elo-v13.0, second part: play-offs in the simulation, the surface edge (October 2026) - shipped

The owner's answers to the first part's questions, in the same release (worked
on as "elo-v13.1" before the version rules; see "Model versions").

**Play-offs (`simulation/playoffs.py`).** The table's promotion and relegation
chances used to stop at the places: OBOS-ligaen's top two and both divisions'
15th-16th. Each Monte Carlo run now plays the ties after the last round, in
the format of that season (NFF, checked against Wikipedia's play-off articles):

- OBOS-ligaen 3rd-6th, single matches at the higher-placed club: from 2019 a
  ladder (5th v 6th, the winner away at 4th, then away at 3rd); 2015-2018 3rd v
  6th and 4th v 5th, the winners meeting at the higher-placed one's ground.
- The bracket winner v Eliteserien's 14th over two legs: promotion for one,
  relegation for the other.
- OBOS-ligaen's 14th v a second-tier side over two legs to stay up. That side is
  outside the data, so it is rated the way the model rates any club arriving
  from that tier: the Elo ladder floor (1330), its division's attack and defence
  less `newcomer`.
- A tie level after 90 (or 180) minutes: extra time settles half (30 minutes at
  Norwegian scoring rates leave it level about half the time), in proportion to
  the two sides' win odds; the rest is a coin on penalties.

Each match is drawn like a season fixture (the blended odds, the run's strength
shocks, a scoreline from the goals model for the two-legged ties), on a random
stream of its own, so the finishing chances are exactly what they were. A tie
with the other division takes its side run by run from a simulation of that
division at the same seed (the same tables its own report draws), with the
strength it finished there with. Reports carry `promotion_probability` (OBOS),
`relegation_probability` and `playoff_win_probability` per club; the table's
up/down columns and the team view's Outlook read them (older reports fall back
to the places). The season-shape snapshots and the race lines stay on places.

On 2026 (14 October, 50,000 runs): Aalesund, 14th in 29 % of runs, goes down
through the play-off in about 35 % of those (relegation 48 % against 38 % from
15th-16th alone); OBOS-ligaen's bracket winner wins the final 35-40 % of the
time; OBOS-ligaen's 14th loses to the second tier about 39 % of the time. For
comparison, Eliteserien's 14th went down 5 times in 2014-2024. Cost: one
preliminary simulation of the other division per report (history snapshots
skip it): a full build of every season went from 421 s to 554 s on 8 workers.

**The surface edge (`normalize/surfaces.py`).** IMPROVEMENTS 1.10 pursued with a
checked table (the Eliteserien venue list, then Nye Høddvoll, Melløs, Øster Hus
Arena, Nammo stadion and Bislett one by one: Hødd and Raufoss turned out to be
on turf, Sandnes Ulf on grass only until 2019). On elo-v13.0, both divisions
2016+, the mismatch edge (home side on a different surface from its visitor):

| form (all on Eliteserien unless said) | in-sample | out of sample 2019+ |
|---|---|---|
| any mismatch, Elo, both divisions | | -0.00021 (t -0.90); Eliteserien -0.00065 (t -1.77), OBOS +0.00022 |
| same, goals model / both models | | Eliteserien -0.00113 (t -1.25) / -0.00080 (t -0.71); OBOS worse |
| grass hosting turf / turf hosting grass, Elo | | Eliteserien -0.00032 (t -1.72) / -0.00038 (t -2.06) |
| Eliteserien only, Elo, in the rating update too, +10 | -0.00031 (t -2.91), halves -1.96 / -2.16 | grid 10-80 picks 80: -0.00116 (t -1.19) |
| **Eliteserien only, the prediction only, +10** | **-0.00031 (t -2.98), halves -2.13 / -2.08** | grid 0-20: **-0.00045 (t -1.88)**, Brier and RPS too, both halves |

Familiarity rather than one surface being harder: both directions point the
same way. It lives in Eliteserien (45 % of its matches are mismatched, 24 % of
OBOS-ligaen's, where it is slightly worse). Shipped as the prediction-only
Eliteserien form at +10 Elo points, the value shrunk from walk-forward's 20-60:
it clears |t| >= 2 in-sample as a new data dependency and the out-of-sample
rule. The ratings and their history never see it; the backtest, the fixture
odds, the season simulation, the season-shape snapshots and the compare tool
(`report.model.surface`) all do. The table needs a line when a club changes
surface or a grass club comes up.

The gap to the Eliteserien closing line (2016+, n = 2,576, proportional
de-vig) across the pass: +0.0107 log loss on elo-v12.2, +0.0100 after the
first part, +0.0097 with the second (t +3.29). All matches 2016+: 1.00047 ->
0.99920 -> 0.99905.

**Market values, fetched politely.** `python -m elitetracker.research
market-values --season YYYY [--dry-run]` (`sources/transfermarkt.py`): two
Transfermarkt competition pages a season, 4-8 s apart, a browser fingerprint,
stop at the first 403/429, joined to our clubs by folded name (the Sofascore
stems plus Transfermarkt's "FF", aliases for HamKam, KFUM-Kameratene, Lyn 1896,
Ullensaker/Kisa, then a unique containment), saved per league. Season S is
stored from saison_id S - 1, the file's own convention (the stored 2026 values
are saison_id 2025's). Checked with one dry run for 2026: 32 of 32 clubs joined,
values within a few percent of September's. Run it once a year after the
season; never from `refresh` or CI.

**Explore views, all ten candidates.** Added `races` (race lines from the season
shape, a race picker), `lift` ("Heisen": both divisions as lanes, promotions blue
and relegations red), `river` (every club's rating since 2015, the division's
clubs in colour), `h2h` (all-time points a match for every pairing in the
division), `scorelines` (each scoreline's share against the model's average
chance, from a new block in `calibration.json`) and `stakes` (the run-in's
decisive matches by race and date). The scoreline check over 5,183 matches: 1-1
11.4 % against 10.9 % expected, 0-0 5.0 % against 5.8 %, 2-2 6.1 % against
5.5 %. Which views stay is the owner's call after seeing them (seven kept;
they wait on `explore/*` branches -- see "Explore: which views stay").

## 🔎 IMPROVEMENTS.md, checked item by item (October 2026)

A read-through of the plan against what was done found five tests the first
pass had left out and one instruction it had skipped. All on elo-v13.0 as released
(`experiments/improvements/audit_gaps.py`, out-of-sample = walk-forward pick
from prior seasons, 2019+):

| item | test | result |
|---|---|---|
| 1.5 | separate `alpha` x `k_shots` for Sofascore's xG (OBOS-ligaen), 0.6-0.9 x 0.035-0.065 | OOS 2024+ -0.00044 (t -0.25); in-sample best -0.00115 (t -0.75). Rejected |
| 1.6B | online centring of the attack - defence level after every match (0.5-5 % a match) | never picked OOS; over/under 2.5 worse as it grows (+0.0033, t +1.5 at 5 %). Rejected |
| 1.7 | goals-model newcomers seeded from squad value (same-season page, beta 0.1-0.3) | OOS -0.00012 (t -0.42), xG window +0.00021. Rejected (as in Elo) |
| 1.7 | the shipped value pull by stage | rounds 1-10 -0.00136 (t -2.33), rounds 11+ -0.00049 (t -2.02): it is the early-season prior it was meant to be. Season odds from pre-season, elo-v13.0 against elo-v12.2: RPS over places -0.00179 (t -2.15), log loss of the place -0.0151 (t -2.02); a quarter in -0.00124 (t -2.31), three quarters -0.00030 (t -1.91) |
| 1.11 | the dormant hooks and the constants re-swept after the surface edge | nothing moves: `OUTCOME_BLEND` +0.00015, `blend_gamma` never picked, `rho` +0.00004, `home_beta` -0.00022 (t -0.56, second half +), `home_advantage_beta` -0.00005, `spread` +0.00036, `early_boost` -0.00013 (t -0.52); `value_pull` still wants 0.3-0.4 (-0.00057, t -2.02, second half -0.40), so 0.2 stays the shrunk value |
| 1.12 | an offseason IPF anchor: at each season start, blend the online ratings toward an IPF fit of everything before (half-life 365 days, tau0 6) | worse at every weight (0.15: +0.00030; 0.5: +0.00166, t +2.53); never picked OOS. Rejected |

**2.1, passive parsing, added.** The plan asks to record npxG and the first red
card's minute from the payload already fetched, even though neither feeds the
model. `sources/fotmob.parse_match_details` now takes both from the same
match-details response `refresh` has always read: entries in `data/xg.json`
grow from `[xg, xg, xgot, xgot]` to `[..., npxg, npxg, red_minute]` (90 when
there was no red card) for every match fetched from now on; 2- and 4-value
entries stay valid, and every reader takes the first two (xGOT the next two
where there are four or more). No request was added. Older seasons only get
them through the manual backfill, `research xg --refresh --seasons ...`, which
now follows the scraping rules: a 4-8 s jittered wait, the file saved after
every match, a stop at the first 403 or 429 (it used to retry with backoff at
1 s). Checked on one payload (match 5104878, fetched once): xG and xGOT equal
the stored values, npxG removes the two 0.79 penalties, the red card at 39'.

What the payload has besides (2.1.3 and 2.1.4): finished matches' lineups carry
each starter's `marketValue` and match rating and the team's
`totalStarterMarketValue` -- the present-day values elo-v4 found leaky, for
lineups that do not exist before kickoff (see elo-v4); and `matchFacts.poll`
is FotMob's fan poll ("Who will win?"), not bookmaker prices. Sofascore's
statistics response (OBOS-ligaen) could not be checked for penalties: Sofascore
answers 403 from this machine.

**Model version.** The plan asked for one bump at the end. The working tree
carried two (v13.0, then v13.1, when the owner's answers added the play-offs and
the surface edge) until the version rules were written down ("Model versions"):
nothing between them was released, so the whole pass is one release, elo-v13.0.
The passive parsing changes no output and needs no bump.

## 🧪 Keeping and finishing from xG on target, in the goals model (October 2026) - elo-v14.0

The owner's idea: rate shooting (xG to xGoT) and keeping (xGoT to goals
conceded) and match them up, so a good finisher against a poor keeper is
expected to score more. In log goals the parts add: a side's rate gets
`shoot + beat - keep[opponent]` on top of attack - defence, each a
season-level term from last season (as elo-v9's finishing), measured against
its division that season and shrunk to w of itself:
`shoot = log(xGoT / xG)`, `beat = log(goals / xGoT)`,
`keep = log(xGoT faced / goals conceded)`. FotMob's xGoT, so Eliteserien from
2020 only; a club without xGoT last season keeps the shipped finishing. In the
predicted rates and the learning rates alike (the way finishing is), scored as
the shipped grid/Elo blend, paired against the shipped model;
`experiments/improvements/keeping.py` (identity to the shipped model: 0.0).

| variant | Eliteserien 2021+ LL (t) | all 2016+ LL (t) |
|---|---|---|
| keeping on top of finishing, w 0.25 | -0.00013 (-0.44) | -0.00004 (-0.40) |
| keeping, w 0.5 | -0.00013 (-0.22) | -0.00003 (-0.14) |
| keeping, w 1.0 | +0.00024 (+0.21) | +0.00013 (+0.36) |
| keeping, walk-forward pick | -0.00005 (-0.20) | +0.00000 (+0.00) |
| split, shooting 0.7 / beating 0.35 | +0.00022 (+0.41) | -0.00001 (-0.04) |
| split, shooting 0.35 / beating 0.7 | +0.00062 (+1.08) | +0.00031 (+1.64) |
| split, shooting 0 / beating 0.7 | +0.00140 (+1.59) | +0.00067 (+2.35) |
| split, walk-forward pick | -0.00007 (-0.17) | -0.00001 (-0.03) |
| full: shooting 0.7, beating 0.7, keeping 0.5 | -0.00012 (-0.17) | -0.00002 (-0.11) |
| full: shooting 0.35, beating 0.7, keeping 0.5 | +0.00049 (+0.63) | +0.00027 (+1.10) |
| full, walk-forward pick | +0.00045 (+1.23) | +0.00028 (+1.14) |
| keeping 0.5, predictions only (not learnt) | +0.00148 (+1.23) | +0.00066 (+1.90) |
| shipped finishing centred on its division, w 0.9 | -0.00052 (-0.79) | +0.00004 (+0.15) |
| centred, walk-forward pick | -0.00039 (-0.61) | +0.00026 (+0.55) |

Nothing beats the shipped model. Keeping adds nothing on top of finishing at
any weight. Splitting finishing does not help either: shrinking the shooting
part harder than the rest makes it worse (to t +2.35), so xG to xGoT carries
as much of the lasting signal as xGoT to goals, which is what the single
log(goals / xG) term already uses. Measuring finishing against the division
(so 2022's league-wide goals over xG is not carried into 2023) leans the right
way on Eliteserien (-0.0004 walk-forward) but is noise (t -0.6). The same
answer as the luck view's points test (Explore, "Luck: can finishing and
goalkeeping take the trend out?"): last season's keeping does not predict this
season. Club-level keeping mixes keepers, who change between seasons; a
keeper-level rating would need line-ups, which the data does not have. No
version bump.

**Re-test over a rolling window (the owner: squads change between seasons).**
Each term over the club's last N matches with the data, across season
boundaries, against its division's last ~240 such matches, shrunk to w, from
`max(5, N/2)` matches on; `experiments/improvements/keeping_rolling.py`
(identity 0.0). elo-v9 had rejected a rolling finishing window unshrunk
(rolling 20: +0.015); these are shrunk.

| variant | all 2016+ LL (t) | Eliteserien 2021+ LL (t) |
|---|---|---|
| keeping, N 15, w 1.0 | +0.00226 (+2.74) | +0.00735 (+2.59) |
| keeping, N 20, w 0.5 | +0.00048 (+1.48) | +0.00173 (+1.57) |
| keeping, N 30, w 0.25 | -0.00006 (-0.51) | -0.00008 (-0.20) |
| **keeping, N 45, w 0.25** | **-0.00014 (-1.77)** | **-0.00034 (-1.31)** |
| keeping, N 45, w 0.5 | -0.00025 (-1.54) | -0.00058 (-1.11) |
| keeping, N 60, w 0.25 | -0.00008 (-1.18) | -0.00035 (-1.46) |
| keeping, N 90, w 0.5 | -0.00003 (-0.30) | -0.00026 (-0.65) |
| keeping, N 120, w 0.5 | +0.00003 (+0.36) | -0.00014 (-0.51) |
| keeping, walk-forward pick (N 45, w 1.0 every season) | -0.00037 (-0.68) | -0.00074 (-0.71) |
| finishing in place of the season-level term, N 45, w 0.25 | +0.00084 (+2.20) | +0.00259 (+2.53) |
| finishing, N 15, w 1.0 | +0.00899 (+6.76) | +0.02114 (+6.01) |
| split, N 45, shooting 0.5 / beating 0.25 | +0.00069 (+2.15) | +0.00245 (+2.34) |
| full, N 45, s 0.5 / b 0.5 / k 1.0 | +0.00057 (+1.23) | +0.00259 (+1.71) |

Rolling finishing, split or not, is worse than the season-level term at every
window and weight (t +2 to +7), and the shorter the worse: the attack rating
already learns this season's goals (a quarter of its observation), so a
window over the same matches counts them twice; last season's finishing does
not overlap. Rolling keeping is the first keeping term to lean the right way:
short windows hurt, it turns at about 30 matches, peaks at 45-60 (a season
and a half to two) and fades by 90-120. At N 45, w 0.25 it is negative on log
loss, Brier (t -1.55) and RPS (t -1.74) and in both halves (t -1.46/-1.19),
but -0.00014 overall, short of the |t| 2 bar, and the walk-forward pick is
t -0.7. Not shipped; worth re-testing at N 45-60 once 2026 is over, with a
seventh season of xGoT.

**A finishing / chances / defence / keeping model (the owner's idea).** The
luck view gained from rolling finishing and keeping (Explore, "Luck:
finishing and keeping in the chances"), so the goals model was rebuilt the
same way: attack and defence learn chances (alpha, the xG share of the
observation, up from 0.75; at 1.0 against rates without finishing and
keeping), and rolling finishing (N, w) and keeping (M, w) carry the goals;
`experiments/improvements/fcdk.py` (identity 0.0). Paired against the shipped
model; Eliteserien 2021+ is where xGoT exists.

| variant | all 2016+ LL (t) | Eliteserien 2021+ LL (t) |
|---|---|---|
| alpha 0.9, nothing else | -0.00019 (-0.68) | -0.00118 (-1.60) |
| alpha 1.0, nothing else | -0.00009 (-0.20) | -0.00156 (-1.27) |
| f/c/d/k grid, best (alpha 0.9, finishing 45 x 0.5, keeping 45 x 0.5) | +0.00046 (+0.98) | +0.00105 (+0.84) |
| f/c/d/k grid, walk-forward pick | +0.00160 (+2.16) | +0.00192 (+1.45) |
| alpha 0.9, finishing 90 x 0.25 | +0.00058 (+1.07) | +0.00102 (+0.72) |
| alpha 0.9, keeping 45 x 0.5, season-level finishing kept | -0.00055 (-1.92) | -0.00221 (-2.92) |
| **alpha 0.9, keeping 45 x 0.75, season-level finishing kept** | **-0.00068 (-2.06)** | **-0.00256 (-2.86)** |
| alpha 0.9, keeping 45 x 1.0 | -0.00076 (-1.98) | -0.00281 (-2.58) |
| alpha 0.95, keeping 60 x 0.75 | -0.00048 (-1.26) | -0.00290 (-2.93) |
| alpha / keeping, walk-forward pick (keeping 45 x 0.75 every season; alpha 0.75 -> 0.95) | -0.00090 (-1.46) | -0.00199 (-2.15) |

Rolling finishing hurts the model in every form (every window, weight and
alpha in the grid, t up to +3), even with chances learnt from xG alone: the
season-level term stays. The luck view gains from it because it has no
ratings, only the match's own xG; the model's ratings already carry a club's
level. Keeping is the part that transfers: a club's keeping over its last 45
matches, with the chances learnt mostly from xG (so goals let in are not
already in the defence rating), is the first goals-model change from xGoT to
clear the bar on Eliteserien: Brier (t -2.75) and RPS (t -3.02) agree, both
halves of the walk-forward pick are negative (t -1.48/-1.58), OBOS-ligaen
(no xGoT, so alpha only) +0.0007 (t +0.4). The weight's t peaks at 0.75; the
step for xG matches (k_shots) stays best at 0.05. Candidate for elo-v14.0
(alpha 0.9, keeping 45 matches x 0.75); not shipped yet.

**Every setting re-swept on 2021-2026 (October 2026, the owner's request).**
`experiments/improvements/sweep2021.py`: each setting moved alone around the
elo-v14.0 candidate, scored on every match 2021-2026 and per division,
paired, with a walk-forward pick (seasons from 2016 before each); then the
movers together (`sweep2021_joint.py`), the offseason pull per division
(`sweep2021_division.py`, identity 0.0 at today's values) and the lot
(`sweep2021_final.py`). The Elo settings swept are the modern era's (2022 on).

Flat, kept (best single move, all 2021+ LL, t; walk-forward): goals-model
k (-0.00009, -0.32; +0.00026), k_shots (-0.00006; +0.00037), alpha (0.95:
-0.00013, -0.79; 1.0 +0.00168, t +2.24), home, base, cap, division_gap,
newcomer, rho, finishing_regression (0.6-0.9 flat; 1.0 = off +0.00146),
early_boost, early_tau, keeping window (45 picked every season) and weight
(1.0: -0.00009, -0.66); Elo k_factor, home_advantage, xg_alpha, xg_margin,
draw_base (0.22-0.24: -0.0002, t -0.6/-0.9), draw_scale, season_regression;
the Elo weight in the blend (0.20-0.25). spread 1.15-1.2 leans better
(-0.00024, t -1.08; walk-forward -0.00017, t -0.40): kept at 1.10.

Movers:
- **The goals model's offseason pull, per division.** One season regression
  and value pull for both divisions could not serve both: lower regression
  and a stronger pull helped OBOS-ligaen (t -3) and cost Eliteserien a little.
  Per division, Eliteserien flat over regression 0.84-0.92 x pull 0.1-0.3
  (within ±0.0001); OBOS-ligaen better in every cell of 0.70-0.88 x 0.2-0.5
  (t -2 to -3, Brier and RPS too), walk-forward 0.70 / 0.4 every season,
  -0.00174 all 2021+ (t -2.40). Kept at **OBOS-ligaen (0.75, 0.3)**, the
  highest t (-0.00227 on OBOS-ligaen 2021+, t -3.00), Eliteserien (0.88, 0.2).
  Squads turn over more there between seasons, and the squad value says more.
- **The surface edge, 20 Elo points.** Better all the way to 40 (20: -0.00014,
  t -2.08; 40: -0.00039, t -1.91), walk-forward 20 then 40 every season.
  elo-v13.0 shipped 10 as the shrunk value of a walk-forward pick of 20-60; a
  second, later look asks for 20-40 again.

| final (candidate + per-division pull + edge 20) vs shipped | LL (t) | Brier t | RPS t | halves t |
|---|---|---|---|---|
| all 2021+ | -0.00262 (-3.74) | -3.69 | -3.73 | -3.82 / -1.62 |
| Eliteserien 2021+ | -0.00289 (-3.16) | -3.05 | -3.29 | -2.86 / -1.65 |
| OBOS-ligaen 2021+ | -0.00236 (-2.23) | -2.25 | -2.14 | -2.60 / -0.72 |
| all 2016+ | -0.00190 (-4.05) | -4.08 | -3.99 | -2.48 / -3.20 |

Final vs the candidate alone: -0.00130 on all 2021+ (t -3.34), -0.00122 on
2016+ (t -3.73). A walk-forward pick among shipped, candidate and final picks
final in every season 2021-2026. Candidate for elo-v14.0: the goals model's
alpha 0.9, keeping over the last 45 matches x 0.75 (xGoT), the offseason pull
per division (Eliteserien 0.88 / 0.2, OBOS-ligaen 0.75 / 0.3), the surface
edge 20. Shipped as elo-v14.0 (below).

Rolling finishing re-tested on the final model (in place of last season's;
the owner asked whether the full F/C/D/K had been tried): worse at every
setting, more clearly than on the candidate. All 2021+: 20 matches x 0.5
+0.00427 (t +3.81), x 1.0 +0.00925 (t +4.90); 45 x 0.5 +0.00210 (t +2.98);
90 x 0.25 +0.00150 (t +1.93); Eliteserien worst throughout (20 x 1.0
+0.01507, t +5.47). So the four parts stay as: chances (attack/defence, 90 %
from xG), last season's finishing, the defence, and keeping over the last 45
matches.

Recent matches weighted more (the owner: a match a season and a half ago
should count less), on the final model, `experiments/improvements/fcdk_decay.py`
(identity 0.0 for the flat window through the same hooks):
- Keeping as a decayed average (each match's weight halving every h
  matches), h 10-60 x w 0.5-1.0: worse than the flat 45 x 0.75 at every
  setting, all 2021+ +0.00058 to +0.00163 (t +1.8 to +2.1), 2016+ t +2.6 to
  +2.9; the walk-forward picks the flat window every season. Long half-lives
  lose too, so what the flat window has is its cut-off: a keeper from two
  seasons ago drops out entirely, where a decayed average keeps a long tail.
- Keeping tapered inside a window (newest 1, the window's oldest 1 / N, older
  none), N 45-120: no better either, +0.00016 (t +0.41) at 90 x 1.0 to
  +0.00056 (t +1.26) at 45 x 1.0.
- Finishing as a decayed average in place of last season's, h 10-90 x
  0.25-0.5: worse throughout, +0.00179 (t +2.38) at best.
The flat 45-match keeping window stays.

Finishing and keeping learnt online, the way attack and defence are (the
owner, on elo-v15.0, October 2026), `experiments/improvements/fcdk_online.py`
(the subclass with both off is the shipped model to 0.0): each a rating of
its own that takes a step after every match with the data, k times the
Poisson surprise -- finishing F += k (goals - xG x the division's goals per
xG x e^F), keeping K += k (xGoT faced x the division's goals per xGoT x e^-K
- let in), the surprise capped like attack/defence's -- with w x the rating
in the predicted and learning rates. Online F replaces last season's
finishing (with and without the 0.7 offseason pull), online K the flat
window. k 0.005-0.08 (roughly a memory of 200 down to 10 matches) x w
0.25-1.0, paired against elo-v15.0:

| variant | all 2016+ LL (t) | Brier t | RPS t | all 2021+ LL (t) | Eliteserien 2021+ LL (t) |
|---|---|---|---|---|---|
| K, best (k 0.005, w 0.25) | +0.00046 (+1.93) | +1.70 | +1.82 | +0.00060 (+1.50) | +0.00141 (+1.84) |
| K, worst (k 0.08, w 1.0) | +0.00282 (+3.59) | +3.70 | +3.57 | +0.00405 (+3.04) | +0.00840 (+3.25) |
| F, no pull, best (k 0.005, w 0.25) | +0.00079 (+1.99) | +1.79 | +1.65 | +0.00152 (+2.05) | +0.00249 (+2.26) |
| F, pull 0.7, best (k 0.005, w 0.25) | +0.00081 (+2.02) | +1.82 | +1.68 | +0.00155 (+2.08) | +0.00255 (+2.29) |
| F, worst (k 0.08, w 1.0) | +0.00708 (+5.31) | +5.09 | +4.84 | +0.01364 (+5.76) | +0.02015 (+5.60) |
| F and K, best (k 0.01, w 0.5) | +0.00144 (+3.13) | +2.81 | +2.70 | +0.00257 (+3.09) | +0.00468 (+3.59) |

Worse at every speed and weight; the best settings are the slowest and
lightest, that is the part switched off, and they cost about what the shipped
part is worth (season-level finishing off was +0.00146 in the elo-v14.0
sweep). The walk-forward keeps the shipped model in every season but one
(2021, where it is worse: t +4 to +5). Same verdict as the decayed averages
above: finishing is best as last season's whole-season figure and keeping as
a flat window with a hard cut-off; a rating that keeps learning from every
match carries a club's old finishing and old keeper too long, and reacts to
single matches too much once it learns fast enough to forget them.

**Shipped as elo-v14.0.** `ADConfig.alpha` 0.9, `keeping_window` 45,
`keeping_weight` 0.75 (`AttackDefence.keeping`, in the predicted and the
learning rates, and in `rates_against_average`'s goals against),
`obos_season_regression` 0.75 and `obos_value_pull` 0.3 (`ADConfig.offseason`),
`normalize.surfaces.SURFACE_EDGE` 20. The report carries each club's keeping
as the fourth number in `model.attack_defence.teams`, so the compare tool
prices a fictional match the same way, and `results[].xgot` for the luck
table. Checked against the sweep: with elo-v14.0's `src` the harness's
shipped model is the experiment's final model to 2e-16 (Elo odds exact), and
`harness.identity()` holds.

## 🧪 Recalibration re-tested on elo-v14.0: a lookup table for the favourites (October 2026) - rejected

The owner's question, from the model accuracy view's 5 % bins: heavy
favourites win more often than priced, so would a lookup table (or similar)
on the predicted chances help? Re-test of the elo-v12 recalibration layers
(temperature −0.0010, t −1.4; temperature + biases −0.0006) with new ones.
`experiments/improvements/recalibration.py`: the shipped odds (the same as
`calibration.json`), each layer fitted on every scored season before the one
it scores (2016 on), scored 2018–2026, both divisions, 4,223 matches, paired
against the shipped odds:

| layer | log loss | t | Brier | t | RPS | t | halves (log loss) | favourites ≥ 70 %: n, priced, won |
|---|---|---|---|---|---|---|---|---|
| shipped | | | | | | | | 296, 76.3 %, 81.1 % |
| temperature (picks 0.99–1.06) | −0.00004 | −0.13 | +0.00003 | +0.17 | +0.00002 | +0.20 | +0.00028 / −0.00036 | 365, 76.4 %, 79.2 % |
| temperature + outcome biases | +0.00048 | +0.65 | +0.00043 | +0.95 | +0.00017 | +0.80 | −0.00053 / +0.00150 | 383, 76.5 %, 79.6 % |
| LUT, 5 % bins, shrunk with 50 pseudo-matches | +0.00166 | +1.85 | +0.00098 | +1.76 | +0.00035 | +1.37 | −0.00074 / +0.00405 | 424, 75.9 %, 78.8 % |
| LUT, 5 % bins, 200 pseudo-matches | +0.00073 | +1.20 | +0.00043 | +1.14 | +0.00014 | +0.81 | −0.00120 / +0.00266 | 386, 75.7 %, 78.5 % |
| LUT, 10 % bins, 50 pseudo-matches | +0.00114 | +1.44 | +0.00070 | +1.44 | +0.00025 | +1.12 | −0.00051 / +0.00279 | 402, 76.3 %, 78.1 % |
| isotonic per outcome | +0.00852 | +2.90 | +0.00230 | +2.24 | +0.00078 | +1.83 | +0.00582 / +0.01122 | 502, 80.5 %, 76.9 % |
| favourite's log-odds × s from 60 % (s 0.90–1.34) | −0.00019 | −0.34 | +0.00002 | +0.05 | −0.00001 | −0.10 | −0.00017 / −0.00022 | 430, 77.8 %, 77.9 % |
| favourite's log-odds × s from 70 % (s 0.90–1.22) | −0.00022 | −0.95 | −0.00009 | −0.71 | −0.00004 | −0.84 | +0.00017 / −0.00060 | 268, 78.3 %, 82.5 % |

Every layer fails the one-knob rule (no t ≤ −1, halves disagree, Brier and
RPS not both negative); the lookup tables are worse out of sample, more so
the freer they are. The temperature the elo-v12 test found (1.09–1.12) is
down to about 1.05: the spread (1.10) took most of it. A layer that sharpens
the top moves more matches into the ≥ 70 % bin, and the newcomers win less
often than the old ones.

Why it does not transfer: the favourites' gap is not a fixed curve. Priced
70 %+, they won 72.1 % against 74.9 % in 2016–2020 (86 matches, se 4.7 pp)
and 82.9 % against 76.7 % in 2021–2026 (234, se 2.7 pp). Half of the recent
excess is one club: Bodø/Glimt won 49 of 53 at 78.7 % priced (+7.3 wins of
+14.6 for all clubs); Brann +2.6, Vålerenga +2.4, Viking +1.8, Molde −0.4.
Earlier, Rosenborg −2.8. So it reads as the ratings of a dominant club
running behind it, not as odds that are too flat. The lead, if it is taken
up: a club-level ceiling or the top of the rating scale, not a probability
mapping.

**The offseason pull toward each club's own level, re-tested on elo-v14.0 -
rejected again.** elo-v12 era: −0.0002 (t −1.8). `experiments/improvements/own_level.py`
(harness, identity to the bit): the target is mean + w × L, L an EWMA (memory
λ, from 0) of the club's pre-pull deviation from its division mean, reset when
it changes division; in Elo, in the goals model (attack and defence each,
on top of the squad-value shift), or both. λ {0.5, 0.7, 0.85} × w {0.5, 1}, 2016+:

| where | best in-sample | walk-forward 2019+ (all / ES / OBOS) |
|---|---|---|
| Elo | −0.00001 (t −0.15) | +0.00005 (t +1.14) / +0.00006 / +0.00003 |
| goals model | +0.00001 (λ 0.85, w 0.5) | +0.00016 (t +1.53) / −0.00001 / +0.00033 (t +1.75) |
| both | +0.00002 | +0.00014 (t +1.52) / +0.00003 / +0.00025 |

Elo is flat at every setting (2021+ at best −0.00005, t −0.35); the goals
model is worse the more it leans on the club's own level (w 1, λ 0.5:
+0.00031, t +1.02), OBOS-ligaen most. The favourites priced 70 %+ since 2021
do not move (234 → 236 matches, won 82.9 % → 83.1 %). The elo-v12-era hint
has gone; a likely reason, not tested, is the squad-value pull (elo-v13.0),
which already moves the goals model's target by a club's resources. So the
dominant clubs' excess is not the offseason pull either, and stays open.

**The gap between the divisions set by squad value - rejected.** The
owner's idea: base the difference between Eliteserien and OBOS-ligaen on
their clubs' average or median squad value. Today that gap is seeded once
(the 2014 ladder; `division_gap` 0.25) and carried: the pull is per division
and no match crosses, so only the clubs going up and down move it.
`experiments/improvements/division_value_gap.py` (a new optional `offseason`
hook in the harness's Elo replay; identity to the bit): each offseason,
after the pull, last season's OBOS-ligaen clubs move a fraction k of the way
to a value-implied gap -- the run's own mean gap of the seasons before,
scaled by this season's log median (or mean) value gap over theirs; for the
goals model also 0.2 × the value gap, the value pull's own rule.

The carried gap has grown while the value gap shrank: Elo 162 → 206 points
2016 → 2025 (216 in 2026), the defence gap 0.23 → 0.46, the median value gap
1.45 → 1.19. So the idea narrows the gap, and the results disagree. 2016+,
all 5,183 matches / the 2,192 with a club new to its division:

| variant | all | new to the division |
|---|---|---|
| Elo, k 0.25 / 0.5 / 1 | +0.00007 / +0.00014 / +0.00029 (t +1.69) | +0.00015 / +0.00032 / +0.00065 |
| goals model, k 0.25 / 0.5 / 1 | +0.00002 / +0.00009 / +0.00025 | +0.00013 / +0.00039 / +0.00092 |
| both, k 0.25 / 0.5 / 1 | +0.00012 / +0.00034 / +0.00079 (t +1.48) | +0.00036 / +0.00094 / +0.00216 (t +1.76) |
| both, k 0.5, mean value | −0.00000 | +0.00014 |
| goals model, absolute 0.2, k 0.5 / 1 | +0.00009 / +0.00032 | +0.00036 / +0.00102 |

Every first half worse (t +1.5 to +3.4 on the new-to-the-division matches),
second halves flat. Walk-forward 2019+: Elo never picks it; goals model
+0.00029 (t +1.94; OBOS-ligaen +0.00057, t +2.64); both +0.00033 (t +2.40).
Squad values understate how far apart the divisions have grown, whether
because OBOS-ligaen squads are valued generously for how they play or
because Eliteserien's top has pulled away (not tested).

**Clubs changing division placed by their own squad value - relegated
clubs shipped as elo-v15.0.** The owner's follow-up: not the whole gap, but each promoted or
relegated club placed more by its value against its new division. Today
such a club is pulled like any other: toward its new division's mean,
keeping 0.88 of its distance (goals model: 0.88 Eliteserien / 0.75
OBOS-ligaen, target moved by `value_pull` 0.2 / 0.3 × log value against the
division's); Elo has no value term. `experiments/improvements/value_crossers.py`
(identity to the bit, and the hooks at shipped settings give the shipped odds
back): for clubs whose division changed, keep r_c of the distance, and move
the target by c Elo points (Elo) or m × `value_pull` (goals model) per log
value. 1,503 matches 2016+ have such a club. 2016+, all matches:

| variant | log loss | t | Brier t | RPS t | halves t |
|---|---|---|---|---|---|
| Elo, keep 0.5, no value (control) | −0.00002 | −0.19 | −0.20 | −0.40 | −0.50 / +0.26 |
| Elo, keep shipped, c 75 | −0.00003 | −1.38 | −1.53 | −1.41 | −0.55 / −1.51 |
| Elo, keep 0.5, c 75 | −0.00019 | −2.57 | −2.74 | −2.83 | −2.28 / −1.42 |
| Elo, keep 0.25, c 150 | −0.00045 | −2.25 | −2.46 | −2.42 | −1.49 / −1.71 |
| Elo, keep 0, c 150 | −0.00057 | −2.13 | −2.34 | −2.31 | −1.47 / −1.56 |
| goals model, keep 0.5, ×1 | −0.00053 | −2.18 | −2.37 | −2.47 | −2.11 / −0.86 |
| goals model, keep 0.25, ×1 | −0.00079 | −1.81 | −2.01 | −2.11 | −1.82 / −0.63 |
| goals model, keep 0.25, ×2 | +0.00069 | +0.60 | +0.22 | +0.29 | +0.66 / +0.07 |
| both, keep 0.5, ×1, c 75 | −0.00066 | −2.22 | −2.41 | −2.50 | −2.16 / −0.91 |
| relegated clubs only, keep 0.5, ×1, c 75 | −0.00047 | −2.43 | −2.67 | −2.71 | −1.83 / −1.60 |
| promoted clubs only, keep 0.5, ×1, c 75 | −0.00019 | −0.82 | −0.88 | −0.97 | −1.29 / +0.28 |

The value is what helps: a stronger pull alone does nothing (Elo keep 0.5 or
0.25 with c 0: t −0.2 / +0.03). Walk-forward 2019+ (each season the
setting that did best on the seasons before): Elo −0.00053 (t −1.86; Brier
t −1.87, RPS t −2.13; halves −2.34 / −0.63; picks keep 0, c 150 mostly);
relegated clubs, both models −0.00094 (t −1.75; halves −1.69 / −0.69);
both directions, both models −0.00071 (t −1.30); the goals model alone
+0.00004 (it picks keep 0 from 2020, which overshoots: fragile); promoted
clubs only −0.00003. So it is the relegated clubs: a club coming down is
better placed by what its squad is worth than by the Eliteserien rating it
brings (which clubs gain was not broken down). It adds a value term to Elo
and a second pull for one group of clubs, so the |t| >= 2 bar applies: met
in-sample (relegated only, t −2.43, both halves negative on all three
metrics), not out of sample (t −1.75). If it is taken up, the cleanest form
is relegated clubs only, keep 0.5, the goals model's own value shift, Elo
75 points per log value.

Shipped as elo-v15.0 on the owner's call (2026-10-17), without a forward
split: `EloConfig.relegated_regression` 0.5 and `relegated_value_pull` 75
(the Elo replay reads squad values for the first time: `career.replay`,
`build_careers`, `walk_forward` take `values`), `ADConfig.relegated_regression`
0.5. The harness carries it (identity to the bit). Against elo-v14.0, the
same matches:

| window | log loss | t | Brier t | RPS t | halves t |
|---|---|---|---|---|---|
| all 2016+ (5,183) | −0.00046 | −2.32 | −2.57 | −2.61 | −1.84 / −1.42 |
| Eliteserien | +0.00005 | +0.45 | +0.37 | +0.29 | +0.55 / −0.05 |
| OBOS-ligaen | −0.00095 | −2.51 | −2.76 | −2.79 | −2.12 / −1.42 |
| 2021+ (2,783) | −0.00042 | −1.57 | −1.60 | −1.82 | −1.10 / −1.12 |
| matches with a relegated club (757) | −0.00348 | −2.72 | −2.98 | −3.02 | −2.61 / −1.19 |

## 🧪 IMPROVEMENTS2.md, phases 1 and 2, on elo-v15.0 (October 2026) - shipped as elo-v16.0

The plan written after elo-v15.0 (`IMPROVEMENTS2.md`): phase 1's three suspected
bugs in the goals model, and phase 2's model items that need no scraping (Ranks
1, 3, 5, 6, 8). Each on the harness against elo-v15.0 (identity: Elo 0.0, blend
2.2e-16 over 5,663 matches). `experiments/improvements/rules.py` adds the plan's
windows (Eliteserien and OBOS-ligaen 2021+; `fav70`, the 331 matches 2016+
where the shipped odds price the favourite at 70 %+) and its two rules; each
item's script and output sit beside it (`out/*.txt`). Baseline elo-v15.0,
all16: log loss 0.99669, Brier 0.59493, RPS 0.20756; the gap to the
Eliteserien closing line (power de-vig, 2,576 matches) +0.00903.

**The bar.** Section 0: the walk-forward pick (each season 2019+ scored with
the value that did best before it) negative on log loss, Brier and RPS,
negative in both date halves, t <= -1, and in-sample |t| >= 2; for new data or
a structural term |t| >= 2 and a closing line no worse. The owner relaxed it
for this pass (2026-10-17: "you may implement changes that have a t <= 2, as
we need to find all the improvements possible"): **relaxed** is the
out-of-sample part alone. Both verdicts below.

| item | what | out of sample, all16 2019+ (t) | strict | relaxed |
|---|---|---|---|---|
| 1.0 A | finishing regressed toward 0 (centred, or r x f) instead of the division's mean | +0.00017 (+1.82) | fail | fail |
| 1.0 B | a club without xG last season: stale finishing reset or halved | -0.00000 (-0.02) | fail | fail |
| 1.0 C | `rates_against_average` without `start_season` | no odds change; reports unaffected | -- | fix (no output change) |
| Rank 1A | the xG margin's [0, 1] clamp taken out (margin 0.10) | blend -0.00010 (-1.86); Elo's own odds -0.00067 (-2.95) | **pass** | **pass** |
| Rank 1A | margin 0.10 -> 0.12 with no clamp (pick 0.15) | blend -0.00010 (-1.25); Elo -0.00053 (-1.61) | fail | **pass** |
| Rank 1B | the margin as a step multiplier where xG agrees with the surprise | blend -0.00047 (-0.90); on top of 1A, Elo -0.00078 (-0.62) | fail | fail |
| Rank 1C | Pearson-residual step in the goals model, nu x k_shots | +0.00029 (+0.80) | fail | fail |
| Rank 3 | game-state xG, the planned weights (leading side up, trailing down) | worse at every setting | fail | fail |
| Rank 3 | late damper (two-goal margin from 75') | Eliteserien -0.00042 (-1.08); widened grid +0.00012 | fail | fail (fragile) |
| Rank 5 | set-piece xG weighted 0.5-0.8 | Eliteserien +0.00036 (+0.75) | fail | fail |
| Rank 5 | penalties x1.5 (sides corrected) | Eliteserien -0.00040 (-0.73), first half + | fail | fail |
| Rank 6 | table stakes, Elo prediction (gamma 10-45) | -0.00027 (-2.57) | **pass** | **pass** |
| Rank 6 | table stakes, both models (gamma 0-80 x kappa 0-0.15) | -0.00070 (-1.88) | fail | **pass** |
| Rank 8 | log travel distance / derby damper on the home advantage | +0.00011 / +0.00001 | fail | fail |

**1.0 A, finishing toward the division's mean: not a bug to fix.** The comment
says toward 0; the code pulls toward the division's mean finishing, so a
league-wide year carries over (Eliteserien starts 2023 at +0.156, 2022's goals
over xG). Taking it out is worse:

| variant (r = 0.70 unless said) | all16 log loss (t) | Brier (t) | RPS (t) | OBOS-ligaen 2021+ | exact score / over-under 2.5 |
|---|---|---|---|---|---|
| centred, r (f - mean) | +0.00020 (+1.69) | +0.00013 (+1.67) | +0.00005 (+1.64) | +0.00076 (+2.13) | -0.00009 (-0.17) / -0.00024 (-0.65) |
| toward zero, r f | +0.00005 (+1.39) | +0.00003 (+1.38) | +0.00001 (+1.36) | +0.00020 (+1.90) | -0.00013 (-0.91) / -0.00017 (-1.52) |
| walk-forward over both x r 0.5 / 0.7 / 0.85 | +0.00017 (+1.82) | +0.00012 (+1.87) | +0.00006 (+1.93) | | |

The scorelines lean the other way (t up to -1.5), the outcomes do not. The
shipped pull stays; only its comment is wrong.

**1.0 B, stale finishing.** 37 club-seasons carry finishing from a season with
xG into one without (relegated into OBOS-ligaen before 2023, back from the third
tier). Reset: all16 -0.00001 (t -0.06), Eliteserien 2021+ -0.00015 (t -0.77);
halved: -0.00003 (t -0.37); walk-forward -0.00000, first half 0. Nothing.

**1.0 C.** Called before `start_season`, `rates_against_average` reads the
un-pulled ratings: up to 0.55 goals a match off pre-season (2026), 0.23-0.48 in
other seasons. `build_report` calls `ad.start_season(season)` first
(pipeline.py), so no published number is affected; the one-line guard changes
no output.

**Rank 1A, the clamp.** On the 2,523 xG matches the observed score plus the
margin passes 1 in 14.9 % and 0 in 5.9 %; the cut where it binds averages 0.042
(at most 0.137, so any widening past 0.15 is the same as none). The planned
grid, cap 0-0.25 or none x gamma 0.05-0.15, walk-forward picks (none, 0.15)
every season from 2021. The clamp taken out, gamma left at 0.10:

| no clamp, margin 0.10 | log loss (t) | Brier (t) | RPS (t) | halves (t) |
|---|---|---|---|---|
| Elo's own odds, all16 | -0.00060 (-3.60) | -0.00041 (-3.62) | -0.00019 (-3.56) | -3.07 / -3.00 |
| Elo's own odds, xG matches | -0.00122 (-3.58) | -0.00083 (-3.59) | -0.00038 (-3.54) | -2.48 / -2.60 |
| Elo's own odds, fav70 | -0.00425 (-3.68) | -0.00226 (-3.22) | -0.00098 (-3.53) | -2.62 / -3.06 |
| Elo's own odds, walk-forward 2019+ | -0.00067 (-2.95) | -0.00045 (-2.94) | -0.00020 (-2.88) | -1.17 / -2.72 |
| blend, all16 | -0.00009 (-2.30) | -0.00006 (-2.04) | -0.00002 (-1.92) | -1.59 / -2.01 |
| blend, walk-forward 2019+ | -0.00010 (-1.86) | -0.00006 (-1.61) | -0.00003 (-1.47) | -0.60 / -1.77 |

With no clamp the margin is re-swept 0.05-0.15: 0.15 picked every season,
blend -0.00010 OOS (t -1.25), Elo -0.00053 (t -1.61); 0.12, the shrunk value,
in-sample blend -0.00004 (t -1.50). The bigger move is on the displayed
ratings; the blend gains little, and the 70 %+ favourites it prices do not
move (priced 0.762, won 0.799 against 0.798).

**Rank 1B, a step multiplier** (K (1 + m ln(1 + |r|)) where the xG ratio r
agrees with the surprise, m 0.25-2, margin kept or not): large in-sample on
Elo (m 1.0, no margin, xG matches -0.00426, t -3.52), but the pick runs to the
grid's edge (m 2.0) and out of sample the blend is -0.00047 (t -0.90), on top
of 1A Elo -0.00078 (t -0.62). A bigger K on xG-backed surprises: the K = 70-90
trap of elo-v12.0 again. Rejected.

**Rank 1C, a Pearson-residual step** (surprise / max(rate, 0.40)^nu, nu
0.15-0.5 x k_shots 0.04-0.06, as planned and normalised by exp(base)): best
in-sample -0.00018 (t -1.06, nu 0.25, k_shots 0.06), walk-forward +0.00029
(t +0.80); normalised at k_shots 0.05 +0.00005. The favourites priced 70 %+
win 0.79-0.80 in every variant. Rejected.

**fotmob's shot sides.** In `data/raw/fotmob_match_extras.json` a shot's
`side` is 1 for the home side, not 0: summed by side the shots match the
stored xG the other way round (1,606 of 1,608 matches nearer that way), and
read so their goals give the final score in 1,605. elo-v13.0's penalty re-test (`extras.py`) read 0 as home and
moved the wrong side's penalties; `shots_local.py` orients each match and is
what Ranks 3 and 5 read. Corrected (no rescaling, as elo-v12.0), Eliteserien
2016+: penalty xG x0 +0.00302 (t +3.33), x0.5 +0.00119 (t +2.67), x1.5
-0.00061 (t -1.41); walk-forward picks 1.5 from 2021, -0.00040 (t -0.73) with
the first half positive. elo-v12.0's verdict (penalties are signal) stands,
more strongly; x1.5 fails.

**Rank 3, game-state xG** (`rank3_gamestate_xg.py`, `followups_v15.py`; each
shot weighted by the score when it was taken, each side's stored xG rescaled by
its weighted share, one constant keeping the corpus's total; the signal of the
Elo update and the goals model's observation, finishing and keeping on the
stored xG; Eliteserien 2020-2026). The side ahead takes 30.2 % of the xG at
0.130 a shot, level 42.7 % at 0.110, behind 27.1 % at 0.105-0.106: the side
ahead creates better chances, it does not sit back. The planned weights (ahead
x(1 + d_lead), behind by one x(1 - d_trail / 2), by two x(1 - d_trail)) are
worse at every setting, on the 1,608 matches with shots up to +0.00223
(t +1.72) at (0.15, 0.30), and the reverse leans the right way only to -0.00019
(t -0.51), walk-forward +0.00007. The one form that helps damps garbage time,
shots at a two-goal margin from the 75th minute:

| late damper | matches with shots, log loss (t) | walk-forward, Eliteserien 2019+ (t) |
|---|---|---|
| x0.75 / x0.5 | -0.00037 (-1.57) / -0.00065 (-1.35) | planned grid: -0.00042 (-1.08), halves -1.81 / -0.21 |
| strength 0.25-1 x from 60/70/75/80' x margin 2/3 | best (1.0, 80', 2) -0.00124 (-1.40) | the pick wanders: +0.00012 (+0.14) |
| strength only, from 75', margin 2 | | -0.00043 (-0.55), second half +0.00041 |

It passes only on the planned grid and fails as soon as its own strength is
free; not shipped. In the stack below it adds -0.00018 (t -1.17), both halves;
worth a re-test once 2026 is in, and it would need a parsed field per match
(OBOS-ligaen has no shots).

**Rank 5, set pieces** (`rank5_openplay_xg.py`). Open play is the more
persistent across clubs, as planned (xG a match, r season to season / between
a season's odd and even matches): open play for 0.72 / 0.62, against 0.46 /
0.50; set pieces for 0.50 / 0.44, against 0.27 / 0.30; penalties for 0.36,
against 0.04. But weighting set pieces down does not help the model:
Eliteserien 2016+ x0.5 +0.00012 (t +0.25), x0.65 +0.00002, x0.8 -0.00002
(t -0.12), x1.2 +0.00009; walk-forward +0.00036 (t +0.75). The online ratings
already average the noise out. Rejected.

**Rank 6, table stakes** (`rank6_tablestakes.py`, `followups_v15.py`). The
run-in: 968 matches 2016+ where both sides have played 24 of 30. From the table
before the match's date, each side's distance d in points to the nearest line
of its season's bands (title, European or promotion places, promotion
play-off, relegation play-off, relegation), to the first club across it, and
its pressure P = exp(-max(0, d - 1) / (tau r)), r its matches left. The shipped
odds miss the way the plan says: where the away side is under more pressure
(P_home - P_away < -0.3, 219 matches) the home side takes 0.064 of a point
share less than expected (t -2.31); about even -0.007; home under more
pressure +0.030 (t +1.12). On the prediction only, as the surface edge:

| form | all16 log loss (t) | run-in (t) | walk-forward 2019+ (t) | halves OOS | closing line |
|---|---|---|---|---|---|
| Elo + 30 (P_h - P_a), tau 0.8 | -0.00016 (-2.41) | -0.00086 (-2.41) | planned grid (10-45 x tau 0.5-1.2, picks 45): -0.00027 (-2.57) | -0.00015 / -0.00040 | -0.00030 (t -1.97) at 45 |
| Elo + 45 / 80 / 130 | -0.00023 (-2.32) / -0.00038 (-2.12) / -0.00053 (-1.84) | | 0-130, picks 130: -0.00066 (-2.17) | -0.00032 / -0.00101 | |
| goals model, rates x exp(+-0.05 / 0.10 / 0.15 x (P_h - P_a)) | -0.00033 (-2.13) / -0.00053 (-1.73) / -0.00061 (-1.33) | | -0.00074 (-1.90) | -0.00025 / -0.00122 | |
| **both, gamma 30, kappa 0.05** | **-0.00043 (-1.97)**, Brier t -1.98, RPS t -2.05 | -0.00233 (-1.98) | over gamma 0-80 x kappa 0-0.15: -0.00070 (-1.88) | -0.00028 / -0.00113 | -0.00055 (t -1.74) |

tau is flat (0.5-1.2 within 0.00003). The gain grows past where t peaks (Elo
30, goals model 0.05): the pick is 45-130 and 0.10-0.15. The candidate is one
pressure term in both models at the t-peak values, gamma 30 and kappa 0.05,
tau 0.8; Eliteserien 2021+ -0.00081 (t -1.97), OBOS-ligaen 2021+ -0.00025
(t -0.67). It reads as the market's late-season edge ("Where exactly the
market wins") being motivation, which rest days were not.

**Rank 8, travel distance** (`rank8_distance.py`, each club's ground from known
locations, great circle; median trip 310 km, 204 matches under 35 km). The
shipped odds' miss by distance band is flat (|t| < 1.5, no slope); log distance
on the Elo home advantage (beta -10 to 20 points, prediction only or in the
update too) |t| < 0.65, walk-forward +0.00011; a derby damper (15-35 points
under 35 km) -0.00003 on all16, walk-forward +0.00001; the goals model's home
term by log distance walk-forward +0.00017. Rejected, like per-club home
advantage in elo-v3.

**Stacked** (`bundle_v16.py`), against elo-v15.0:

| bundle | all16 log loss (t) | Brier t | RPS t | halves | OOS 2019+ (t) | Elo's own odds, all16 (t) | closing line |
|---|---|---|---|---|---|---|---|
| no clamp + stakes | -0.00053 (-2.35) | -2.29 | -2.33 | -0.00033 / -0.00073 | -0.00067 (-2.70) | -0.00114 (-3.58) | +0.00838 |
| **no clamp + margin 0.12 + stakes** | **-0.00056 (-2.44)** | -2.36 | -2.38 | -0.00033 / -0.00079 | -0.00072 (-2.79) | -0.00136 (-3.64) | +0.00835 |
| the same + late damper | -0.00074 (-2.71) | -2.66 | -2.66 | -0.00053 / -0.00095 | -0.00097 (-2.94) | -0.00137 (-3.58) | +0.00793 |

Each part taken out of the candidate again: stakes -0.00043 (t -1.97), the
clamp -0.00009 (t -2.28), margin 0.12 -0.00003 (t -1.48); all negative in both
halves, so none is redundant. The candidate by window: Eliteserien -0.00068
(t -2.00), OBOS-ligaen -0.00044 (t -1.43), Eliteserien 2021+ -0.00097 (t -2.06),
OBOS-ligaen 2021+ -0.00049 (t -1.25), xG matches -0.00086 (t -2.59), fav70
-0.00129 (t -1.55), the run-in -0.00257 (t -2.15). The favourites priced 70 %+
by the blend still win more than priced (0.763 against 0.795): the ceiling is
in the goals model, which neither part touches outside the run-in.

**Shipped as elo-v16.0** (2026-10-17, the owner's go): the clamp taken out of
`elo.updated_pair`, `EloConfig.xg_margin` 0.12, and the table stakes as
`model.stakes` (`STAKES_ELO` 30, `STAKES_GOALS` 0.05, `STAKES_TAU` 0.8, from
24 played) on every prediction: the backtest (`walk_forward` and
`shipped_cards` take `stakes`, `pipeline.stakes_table`), the published fixture
odds (from the table as it stands, each side's matches played by then counted
from the schedule) and the season simulation, which reads it from each run's
own table: the fixtures outside the run-in are decided as before, then the
run-in a date at a time, each run's table built from its results so far, its
odds interpolated between the exact odds at 21 pressure differences
(-1 to 1), the strength shock on top and the same random draws. The play-off
ties go without. `src`'s shipped cards are the tested candidate to 4e-16, and
`harness.py` now carries elo-v16.0 as its shipped model (both parts switch
themselves off on an older `src`).

| elo-v16.0 against elo-v15.0 | log loss | Brier | RPS |
|---|---|---|---|
| all 2016+ (5,183), harness | -0.00056 (t -2.44) | -0.00039 (t -2.36) | -0.00019 (t -2.38) |
| the same, walk-forward between the two, 2019+ | -0.00072 (t -2.79) | -0.00051 (t -2.76) | -0.00024 (t -2.71) |
| Elo's own odds (the displayed ratings), all 2016+ | -0.00136 (t -3.64) | | |
| closing line, Eliteserien 2016+ (2,576), power de-vig | +0.00903 -> +0.00835 (t +2.77) | +0.00625 -> +0.00580 | +0.00308 -> +0.00287 |
| the same, proportional / Shin | +0.00821 -> +0.00753 / +0.00878 -> +0.00809 | | |

The second half of the 2016+ window is now +0.00397 behind the closing line
(t +0.89; +0.00503 on elo-v15.0). Calibration error, all 2016+, 0.0077 ->
0.0062. Quarter-Kelly at the closing price, edge >= 3 %: ROI +0.8 % (+0.7 %).

**Season odds** (`season_check.py`, every finished season 2016-2025 from
pre-season, a quarter, half and three quarters in, 10,000 runs, t over the 20
season-leagues):

| | RPS over places | log loss of the place |
|---|---|---|
| elo-v16.0 against elo-v15.0 | -0.00001 (t -0.32) | +0.00039 (t +0.38) |
| the per-run stakes (elo-v16.0 against it without them) | -0.00002 (t -0.79); half-way t -1.22 | -0.00026 (t -0.35) |
| the margin change alone (unclamped, 0.12; the simulation without the stakes, against elo-v15.0) | +0.00000 (t +0.12); Eliteserien +0.00005 | +0.00065 (t +0.83); Eliteserien +0.00175 (t +1.20) |
| strength shock 0.15 / 0.225 / 0.25 / 0.30 against 0.20 | +0.00052 (t +3.11) / -0.00016 (t -1.90) / -0.00026 (t -1.56) / -0.00019 (t -0.59) | +0.01214 / -0.00222 / -0.00318 / +0.00253 |
| the shock walk-forward over 0.15-0.30 (`season_sd_oos.py`), 2019+ | -0.00013 (t -1.16), 2019-2021 +0.00010 | -0.00148 (t -0.88), 2019-2021 +0.00100 |

The season odds hold: the unclamped margin spreads the ratings and makes
Eliteserien's a little surer (as the signed margin did in elo-v13.0), and the
stakes take part of that back. A larger shock is better in-sample again
(0.225-0.25, Eliteserien log loss t -2.3), but walk-forward the pick wanders
between 0.20 and 0.25 and the first half is positive, so `STRENGTH_SD` stays
0.20; worth a re-test once 2026 is in.

**Cost.** The per-run stakes take a report from 2.3 s to 4.1 s late in a
season (most of it the 20 season-shape snapshots' run-ins) and 1.9 s to 2.5 s
before it; the first cut ran at 5.1 s, vectorised to the same output to the
bit. A deploy only rebuilds the views that changed.

**Also in the release, changing nothing published.** 1.0 C:
`rates_against_average` runs the offseason pull itself. 1.0 A: the comment on
finishing's offseason pull says what the code does (toward the division's
mean). 1.1, the two scraper findings of the audit above: Sofascore's `Origin`
header is `https://www.sofascore.com`; and `update_xg` follows Sofascore's
pending rule: a FotMob match is fetched when first seen and once more after
its settle window (`fotmob.SETTLE_HOURS`, 48, the two days the old rule
re-fetched for), recorded under xg.json's `pending`, so the hourly job asks
about a match twice instead of up to 48 times. The other 1.1 items (a shared
curl_cffi session for FotMob, browser headers on its requests) are not
needed: FotMob serves plain requests from both this machine and CI.

## 🔭 Explore: which views stay, and a season in each (October 2026) - luck table and model accuracy released, five on branches

The owner kept seven of the ten new views -- race lines, prediction scorecard,
luck table, run-in heatmap, stakes calendar, head to head, match-odds
calibration -- beside the attack map and the season mountain. The lift, the
rating river and the scorelines are stored in `experiments/explore-later/`
(code, styles, strings, tests, and what each needs before it returns).

The prediction scorecard and the match-odds calibration became one view on
2026-10-17, **Model accuracy** (`viz=accuracy`, branch `explore/accuracy`,
which merged both branches): every look at how accurate the model is in one
place, before the season (the scorecard) and match by match (the
calibration), one section each with its own key figures. The hero offers the
division, which the first part follows; the second pools both divisions.
On 2026-10-17 it gained a third part (every model version on the same
matches), the parts were put in reverse order, and the owner moved it out of
Explore into the model card, as a panel under the settings ("How accurate is
the model?", `#model-accuracy`, drawn by `renderModelCard`); the model card's
hero offers only the season, so the scorecard has a division switch of its
own (`state.accuracyLeague`). Released 2026-10-17 with elo-v16.0 in its
version history (`explore/accuracy` merged into `main`).

The luck table was the first released (2026-10-16, after elo-v14.0), which
brought `explore/base` to `main`. Each of the other six waits on a branch of
its own, `explore/<id>`, off `explore/base`, which holds what they share (the hero
rules for a season per view, `EXPLORE_REWIND`, `fetchedReport`,
`renderTimeAxis` and `runInStart`, `.explore-note`, the two browser checks). A
view reaches the site when its branch is merged into `main`; the first one
brings `explore/base` with it. The stored three are on `explore/later`.
HANDOFF.md has the workflow.

The season, where it means something, through the same control the attack map
already used: the hero's title, slimmed to its two pickers (division and
season), and the rewind slider below it -- but only for the views read off one
day. The views with time along an axis of their own lost the slider the same
day (the owner: it only cut short what the chart already shows over time).

| view | division / season | rewind | why |
|---|---|---|---|
| luck table | both | yes | one season's results and expected goals, up to the date |
| race lines | both | no | time runs along the chart; the lines always run the whole season so far |
| run-in heatmap, stakes calendar | both | no | the fixtures ahead in date order; a finished season shows them as they stood with ten rounds left, where the stakes start (`runInStart`; a line above says so) |
| head to head | both | no | the season sets the clubs; the record now runs from 2015 to the end of that season |
| model accuracy | division | no | the scorecard spans every season; the calibration pools both divisions and every season |
| season mountain | -- | no | the mountain has pickers of its own |

`EXPLORE_REWIND` in `app.js` lists the views that follow the slider (attack,
luck); the time-axis views read the season's latest report even when the URL
carries a rewind (`renderTimeAxis`). The hero rules sit in `styles.css` beside
the other views'. Checked in a browser on 2019
(`experiments/improvements/explore_seasons.py`, on `explore/base`): each view on a past season,
the race lines ignoring a rewind, 2019's run-in and stakes from ten rounds out
and 2026's run-in from today, the hero and slider where the table says, and a season change through the hero's own picker re-drawing the
luck table (2024: Viking, Fredrikstad, Brann; 2021: Viking, Bodø/Glimt, Molde).

## Contact form - planned

The footer's email link was taken out before the site went into Google Search
Console, so the address is not harvested once the site is indexed. Replace it
with a contact form (Firebase Hosting is static, so a hosted form service or a
small function) and put a "Contact" link back in `footer.text` (both languages
in `public/i18n.js`) and the static footer in `public/index.html`.

Options, as laid out in October 2026 (pick one, and the address mail goes to):

- **A form service** (Formspree, Web3Forms, Getform): a plain HTML form posting
  to the service's endpoint, a honeypot field against bots, the address never
  in the page. A free tier is enough. Needs an account and its endpoint key.
- **A Firebase function** that sends the mail: needs the Blaze plan and a mail
  provider (SendGrid or similar). Most control, most setup.
- **No form**: a "Contact" link whose mailto address is put together in
  JavaScript on click, so crawlers reading the HTML never see it. No account;
  scrapers that run JavaScript can still find it.

Whichever it is: a modal or a small page in the site's style, both languages,
the link in `footer.text` and the static footer, a privacy line in
`personvern.html` if a third party receives the message.

## Explore / Utforsk: other ways to look at the data (October 2026) - shipped

`?view=explore` is a gallery of cards (thumbnail, name, short description; two
across, one on phones) that each open a visualisation in the same panel, with
`?viz=` for links. Adding one = an id in `EXPLORE_ITEMS`, a thumbnail in
`exploreThumb`, a render function and its `explore.<id>.*` strings. On the
site: attack vs defence, the season mountain and the luck table; the views
below that name a branch wait on it (see "Explore: which views stay").

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
- **Prediction scorecard** (candidate #1; since 2026-10-17 the first part of model accuracy, in the model card, released 2026-10-17): every finished
  club-season of the division, the place the pre-season view called (the
  order of the expected finishes) against its final place, one circle a cell
  sized by its count, the y = x line and the two-place band the hit rate
  counts. Fetches each season's live report and pre-season view (the
  mountain's cache); an archive built before the pre-season view falls back
  to the season shape's first snapshot when that predates the first match.
  A strip of seasons (hit rate, last season's table's as a tick) picks one
  season's clubs out by name. Facts: hit rate, last season's table as a
  benchmark, average miss in places, best and hardest season, biggest over-
  and under-achiever.
  **The call is the order, not the average (October 2026).** The first
  version counted hits against the expected finish itself. An average bunches
  towards the middle (no club expected better than about 1.3 or worse than
  14.5), so the clubs at the ends missed by more than the model did, and the
  view showed the model losing to last season's table. 2016-2025, elo-v13.0
  data, within two places / Spearman rank correlation per season:

  | call | Eliteserien | OBOS-ligaen |
  |---|---|---|
  | expected finish | 39 % / 0.55 | 31 % / 0.50 |
  | the model's order | 52 % / 0.55 | 49 % / 0.50 |
  | last season's table (clubs coming down first, up last) | 48 % / 0.49 | 48 % / 0.46 |

  The view now calls by the order, and shows last season's table beside it.
- **Luck table** (`viz=luck`, #3; released 2026-10-16): per club, points against the points its
  matches' xG would have earned on average (both sides Poisson at their xG,
  the same sum as `xg_implied_score`), as a diverging bar; follows the rewind
  slider; only matches with xG count on both sides. Facts: luckiest,
  unluckiest, the club with the most xG points against the table leader,
  coverage. Under it, every club season of the finished xG seasons
  (`luckSeasons`: over, and xG for at least 90 % of the matches; the note
  names the seasons, why the earlier ones are missing and the matches left
  out). What it shows (October 2026, elo-v13.0 data): good teams do beat
  their chances. Eliteserien 2020-2025 (96 club seasons): every champion,
  6 of 6, above its xG points, +12.9 on average; Molde 2022 (+19.2) and
  Viking 2025 (+15.7, third on xG points) won without the most; the top four
  by xG points +5.6 a season, the middle -2.0, the bottom four -1.9; luck
  against xG points per match r 0.42, against the pre-season rating 0.29. It
  mostly does not last: the 19 clubs 5+ above their chances were +9.8, the
  season after +2.8 (year-to-year r 0.14). OBOS-ligaen 2023-2025 (48): 3 of
  3 champions, +13.9; top four +4.2, bottom four -3.3. Each club's luck
  splits in three in points (`luckRows`: its own match xG scaled by its
  season's goals/xG, then the xG against by goals against/xG against, the
  rest left over), in the tooltips and the top-four fact; see "Luck: can
  finishing and goalkeeping take the trend out?" below.

  **Luck: can finishing and goalkeeping take the trend out? (October 2026)**
  The owner's idea: track finishing (goals vs xG, tried before as elo-v9's
  season-level stat) and goalkeeping (goals against vs xG on target against,
  FotMob, so Eliteserien only) to take the "good teams have more luck" trend
  out of the luck. Eliteserien 2020-2025, 96 club seasons; scripts in the
  session scratchpad, not kept.
  - xG points themselves are calibrated: every match side 2020-2025 (2,140
    matches, both divisions) binned by xG points, actual minus expected is
    within ±0.13 points in every bin, favourites included. So the trend is
    not the Poisson-on-match-xG method, as first guessed above.
  - In points, top four by xG points: luck +5.6 = finishing +2.5, on-target
    against (xG to xGoT) +0.7, keeping (xGoT to goals against) -1.3, the
    rest +3.7. Middle -2.0, bottom four -1.9; keeping is about -1.3 to -1.7
    everywhere (own goals carry no xGoT). OBOS-ligaen (no xGoT, so keeping
    and defending together): top four +4.2 = finishing +1.7, conceding
    +1.5, rest +1.1.
  - Correlation with quality (xG points a match): luck +0.42, finishing
    +0.32, keeping -0.03, on target -0.07, rest +0.46. Keeping explains a
    lot of a single season's luck (r +0.42 with it) but none of the trend.
    Luck minus finishing: r +0.31; minus finishing and keeping: +0.39.
  - Year to year, same club, per match (n 81, se ~0.11): finishing +0.26,
    keeping +0.25, on target -0.08, rest +0.02, luck +0.20.
  - Out of sample, 2021-2025 (80 club seasons): each match's xG scaled by
    last season's finishing and keeping relative to the league, weighted w
    toward 1, then the luck recounted. Finishing helps: w 0.25, mean squared
    luck -3.5 (t -2.6), w 0.5 -5.7 (t -2.3), quality trend r 0.38 to 0.33;
    w 1.0, r 0.21 but t -1.5. Keeping hurts at every weight (w 0.5 +1.8,
    t +1.1; w 1.0 +6.9, t +2.0) and adds nothing on top of finishing.
  - Verdict: finishing is a real, lasting part of the edge (about 45 % of
    it, in both divisions) and the view now shows it. Goalkeeping by xGoT is
    not the answer: unrelated to how good a side is, and last season's does
    not predict this season's points. The largest part, the rest, goes with
    quality within a season but not with the club from one season to the
    next. No model change follows; a goalkeeping term in the attack/defence
    model was not backtested, as the out-of-sample points test above
    already finds no carry-over to use.

  **Luck against the trend (October 2026, the owner's idea).** Since better
  sides beat their xG points, luck is now measured against the trend:
  `luckTrend` fits the gap a match on xG points a match over the counted
  club seasons, least squares (Eliteserien: -0.476 + 0.340 x xG points a
  match; OBOS-ligaen -0.616 + 0.433), and a club's luck is its points minus
  its xG points minus that over its matches (`withTrend`). Eliteserien
  2020-2025: luck against quality r 0.42 to 0.00, spread 7.40 to 6.70;
  fitted without the season itself, 6.76 and -0.01, so the in-sample fit
  stands. Year to year r 0.17 to 0.05; clubs 5+ above it were +8.7, the
  season after -0.9 (against xG points alone +9.8 to +2.8). All 6 champions
  are still above the trend, +7.5 on average (+12.9 above xG points);
  OBOS-ligaen 3 of 3, +7.7. Without a finished xG season the view falls back
  to xG points alone and says so.

  **Luck: finishing and keeping in the chances (October 2026, the owner's
  idea).** Before each match its xG is scaled by each side's finishing over
  its last N matches (log goals / xG) and the other side's keeping over its
  last M (log xGoT faced / goals let in), each against the division's last 240
  club matches, shrunk to w, from N/2 matches on; luck is then points minus
  the xG points of those chances minus the trend (refitted on them). Scored on
  Eliteserien club seasons 2021-2025 (80): the change in mean squared gap a
  club season, paired, against the plain xG points; and a leave-one-season-out
  pick against overfitting the grid.
  - Last season's terms first (w 0.7 finishing, as elo-v9): -6.85 (t -2.02);
    keeping on top (45 matches, 0.25) adds little: -7.61 (t -2.22).
  - Finishing alone, N 10-120 x w 0.25-1.0: flat at N 10-30 (w 1.0: -9.3,
    t -1.9), fading from 45 (-7.3) to 120 (-0.9); leave-one-season-out -7.22
    (t -1.42).
  - Finishing + keeping, N and M 10-90, w and keeping weight swept: keeping
    over the last 10 is best and adds -8.0 on top of finishing (t -2.28;
    15: -7.1, 20: -6.7, 30: -4.5, 45: -2.0, 90: -0.2). Best fin 10 + keep 10
    -17.31 (t -3.03), fin 20 + keep 10 -17.30 (t -3.01); leave-one-season-out
    -15.61 (t -2.61), keep 10 picked every season. Shipped: finishing 20,
    keeping 10, both at full weight (the edge of the grid); 20 for a steadier
    finishing at no cost. Unlike the goals model (keeping.py,
    keeping_rolling.py), short windows work here: the luck view has no rating
    that already learns this season's goals, so nothing is counted twice.
  - With the shipped finishing 20 + keeping 10: the trend slope 0.287 to
    0.248 (finishing 20 alone: 0.196; keeping is unrelated to quality), luck
    sd 6.59 to 5.29; with 20 + 20, year-to-year r of luck -0.09 to -0.07
    (still none). The browser's scaled xG points match this Python to 0.052 a
    club season over Eliteserien 2020-2026 (the report rounds xG to 2
    decimals).
  - OBOS-ligaen has no xGoT, so finishing only; 2024-2025 (32 club seasons),
    finishing 20: -5.67 (t -0.93), 10: -11.91 (t -1.96). The same rule in
    both divisions, so luck means the same thing; the view says keeping is
    left out there.
  - Data: `results[].xgot` in the report (pipeline.py, fotmob's xGoT where the
    shot table has it). No model change, no version bump.
  - What it moves (2026 so far, fin 20 + keep 20 against the trend):
    Viking +7.1 to +1.0, Sarpsborg 08 -4.6 to +0.3, Fredrikstad +8.4 to +4.9;
    Bodø/Glimt 2021 +6.2 to +1.7, Viking 2025 +11.9 to +8.1, Molde 2022 +14.4
    to +13.0.
  The view opens with "How luck is measured" (chances, finishing and keeping,
  the trend, luck), and the tooltip splits a club's usual points into xG
  points, finishing and keeping, and the trend.

  **Luck: more signals, and the measure re-tested (October 2026, the owner's
  idea).** `experiments/improvements/luck_signals.py`, out in
  `out/luck_signals.txt`; Eliteserien, fitted on 2020-2025 (96 club seasons),
  scored on 2021-2025 (80). The shipped luck reproduces at sd 5.30 (logged
  5.29; plain xG points 6.61, logged 6.59), and -15.7 (t -2.9) in mean
  squared luck against the plain xG points (logged -17.3; the gap is the
  trend fitted on 96 club seasons here).
  - **The mean squared luck rewards soaking up luck.** In a no-skill world
    (the same matches, goals drawn Poisson from the xG, xG on target the
    division's share, 20 runs), where all of it is luck, the shipped
    finishing 20 + keeping 10 still takes the mean square from 41.5 to 25.6,
    as much as it does on the real data; its luck correlates only +0.70
    with the true luck, and the halves of a season -0.21 (real -0.15; plain
    +0.05). A form over this season's matches follows its luck: a lucky
    spell raises the usual points after it, and the luck after it cancels
    the luck before. The grid that shipped 20 + 10 (keeping 10, the
    shortest window, best) measured this, not finishing or keeping.
  - **Scored match by match instead** (log loss of each result under its
    own scaled chances, 1,200 matches; the form is read from the matches
    before, so nothing can be soaked up): the shipped form +0.0329 against
    the plain xG (t +4.58; the no-skill world +0.0546). Rolling finishing
    20 x 1.0 +0.0141 (t +3.05), 45 x 0.25 -0.0008 (t -0.96), 90 x 0.25
    -0.0002; rolling keeping hurts at every window and weight (10 x 1.0
    +0.0210, t +3.73; 45 x 0.25 +0.0005).
  - **Last season's finishing is the signal.** Each club's goals / xG over
    last season against the division's, fixed before the season: per match
    w 0.25 -0.0027 (t -3.16), w 0.5 -0.0045 (t -2.62), w 0.7 -0.0053
    (t -2.18), w 1.0 -0.0053 (t -1.53); mean squared luck w 0.5 -3.0
    (t -1.67); halves of a season +0.03 (nothing soaked up); in the no-skill
    world it costs (+3.8, +0.0033), so the gain is real. Last season's
    keeping adds nothing (w 0.25 on top of finishing 0.5: +0.0004).
  - **Other signals, against the shipped luck** (mean squared luck a club
    season; per match against the plain xG where run):
    shots one by one instead of a Poisson on the total -0.9 (t -1.4);
    same-minute rebounds as one chance -1.3 (t -1.6), per match -0.0004
    (t -0.1): the total's Poisson loses nothing measurable.
    Penalties at the division's rate (being given one as luck) +4.0
    (t +2.2): a penalty won is a chance, not luck.
    The closing market's expected points as the trend's quality: +0.4
    (t +0.4); beside the xG trend -0.03 (market coefficient 0.05): the
    market knows nothing about who beats their xG that the xG points a
    match do not. Blending the market into the usual points hurts at every
    weight (0.1 +0.5, 0.5 +5.9).
    A curved trend -0.3 (t -0.4). Finishing from xG on target (shooting)
    instead of goals +4.5 (t +1.9).
    Red cards: a side whose opponent alone was sent off takes +0.18 points
    a match over its chances (t +1.7; its opponent -0.18, t -1.9), 132
    matches; as a term -0.4 (t -1.3), about a third of a point a club
    season. Not a signal worth its rule.
    Game state left out: a side leads because it scored, so weighting xG by
    the score hands the scorer's luck back to it.
  - Verdict: the in-season finishing and keeping in the luck view take luck
    out, not skill; last season's finishing (w 0.5) is the one term that
    separates skill, and shots, penalties, the market, red cards and a
    curved trend add nothing. Proposed: the view's chances from last
    season's finishing x 0.5 in place of the rolling 20 + 10. Not changed
    yet (the owner's call). No model change, no version bump.

  **Luck: which signals take out the skill (October 2026, the owner's
  question).** `experiments/improvements/luck_skill.py`, out in
  `out/luck_skill.txt`. Every term is fixed before the season or read off
  this season's xG, never its goals. Scored per match out of sample (each
  season's weights fitted on the other seasons; Eliteserien 2021-2026, 1,379
  matches), by the skill left in a club season's luck (2021-2025, 80: the
  spread of the clubs' mean luck a match beyond its noise, within each
  season, in points squared a club season, bootstrap se), and in a no-skill
  world (goals Poisson from the xG, 20 runs) where it should find nothing.
  - **How much skill there is.** Points minus xG points: mean square 50.6 a
    club season, of which 13.3 (se 9.0) is skill and the rest luck (the
    no-skill world: -0.1). The se is what 80 club seasons allow; no method
    is placed closer than about ±7.
  - **What carries skill.** The trend on this season's xG points a match:
    per match -0.0138 points squared (t -2.13), the same from each club's
    other matches only (-0.0144, t -2.18), skill left 5.8 (56 % taken).
    Last season's finishing: x 0.5 -0.0049 log loss (t -3.02), every weight
    0.1-1.0 helps, the weight picked out of sample 0.7-1.0 (-0.0053, t
    -1.97). Both, x 0.5 then the trend: -0.0338 (t -2.97), skill left 2.7
    (se 7.0, 80 % taken), against 4.1 for the same rule in the no-skill
    world (a prior's own noise): no skill left that the data can find. Its
    luck correlates +0.01 with the pre-season rating, +0.05 between halves
    of a season (the no-skill level is +0.02 to +0.05), -0.10 year to year.
  - **The shipped rolling 20 + 10 takes out luck** (as above): skill left
    -13.5 (202 % taken), -18.0 in the no-skill world. It shrinks the
    luckiest and unluckiest seasons most, against the trend alone:
    Lillestrøm 2022 +10.8 to +2.8, Brann 2021 -18.9 to -8.6, Kristiansund
    2022 -12.2 to -4.3 (the proposed: +11.5, -16.6, -10.3).
  - **Shots one by one, re-tested without the trend.** Goals from many
    shots spread less than a Poisson on their total, so strong sides win
    more than plain xG points say with no skill at all: in a shot world (the
    real shots, each in with its xG, 30 runs) plain luck correlates +0.16
    with xG points a match and +0.12 with the pre-season rating, the shots
    one by one -0.01. On the real data alone: skill left 8.1 (39 % taken),
    r with xG points +0.38 to +0.24, per match -0.0053 (t -0.48). So about
    40 % of "good sides beat their xG" is the Poisson, not skill; the trend
    takes it out as well (with finishing and the trend: 2.2, 83 %).
  - **Shot by shot** (each shot's goal minus xG times the expected points it
    moves at its minute and score, a clock at the match's own xG; a sum
    that averages zero for any club whatever the score did, so it hands no
    scorer's luck back, and a shot at 3-0 counts for little): alone 6.7
    (49 %); with finishing x 0.5 1.9 (86 %, no trend); with the trend too
    1.3 (90 %), mean square 35.8, the lowest; r 0.965 with the true luck in
    the shot world. Within noise of the plain rule, and it needs every shot
    in the report; OBOS-ligaen has none.
  - **Game state is weak here.** xG a minute by the shooting side's lead
    -2, -1, 0, +1, +2: 0.98, 1.06, 0.97, 0.99, 1.06 of its season's
    average. A clock that answers the score moves shot by shot 6.7 to 6.4.
  - **What does not carry skill** (per match against the plain; skill
    left): squad value as the trend's quality -0.0006 (t -0.20), 13.2; the
    pre-season rating -0.0102 (t -1.54), 9.7; the closing market's points
    a match -0.0188 (t -2.42), 4.2, the best single trend, but the market
    moves with results and no world here can check that, so not taken (the
    last entry's market tests were on the mean square). Finishing over two
    or three seasons (-0.0031, -0.0029 log loss) is weaker than one;
    non-penalty, or shrunk by 20 or 40 xG, the same as raw; promoted clubs'
    OBOS-ligaen finishing -0.0051 against -0.0053 without; shooting (xG on
    target / xG) -0.0022; last season's keeping +0.0002, conceding (goals
    against / xG against) picked at 0; last season's whole gap +0.0097
    (t +1.09); a home term +0.0009; beside the trend, xG a shot +0.0028
    (t +2.01), xG a shot against and shot share nothing.
  - **OBOS-ligaen** (2024-2026, 686 matches, Sofascore xG): the trend
    -0.0187 (t -1.47); last season's finishing there x 0.5 +0.0001 log loss
    (t +0.05), nothing; relegated clubs bringing their Eliteserien
    finishing +0.0031 (t +1.43), x 1.0 +0.0095 (t +2.18). Finishing year to
    year, same club and division: Eliteserien r +0.26 (n 81), OBOS-ligaen
    -0.06 (n 33).
  - **A champion is lucky with no skill at all**: in the shot world the
    club that finishes first is +5.3 (sd 4.9) above its usual points,
    because finishing first picks the lucky. The real champions 2021-2025
    on average: points minus xG points +11.7, the trend alone +7.7, shipped
    +4.3 (below the no-skill level), proposed +6.5, shot by shot +5.7.
  - Verdict: two signals carry skill, the trend on this season's xG points
    (partly the Poisson's bias, partly finishing) and last season's
    finishing in Eliteserien; together they leave none the data can find.
    Nothing else tested helps. The proposal stands, now with its edge:
    last season's finishing x 0.5 in place of the rolling 20 + 10, read in
    the same division only (a club new to it gets 0, so OBOS-ligaen's
    neither gains nor loses), the trend kept. Made on the owner's call,
    2026-10-19: `luckChances` reads each club's finishing from the season
    before (`LUCK_FINISHING` 0.5), keeping is gone from the view and its
    copy; the browser's scaled chances match this Python to 0.041 a club
    season (the report rounds xG to 2 decimals), and finishing moves a club
    season's usual points by sd 1.5 (Eliteserien 2021-2025, -3.2 to +4.1).
    Shot by shot is the one later step worth having (the trend mostly
    explained instead of fitted), at the cost of the shots in the report.
    No model change, no version bump.
- **Run-in heatmap** (`viz=runin`, #4; branch `explore/runin`): clubs down, their remaining fixtures
  across in date order, each cell the opponent's crest, H/A and the club's win
  chance on the `--seq` ramp; rows by points a match the odds are worth,
  hardest first (the Fix Diff column, match by match). Scrolls sideways on
  phones with the club column pinned. Facts: hardest and easiest run-in, the
  gap between them, the surest win left.
- **Match-odds calibration** (#10; since 2026-10-17 the second part of model accuracy, in the model card, released 2026-10-17): a reliability diagram of
  the shipped odds over every match since 2016 (home, draw, away, in 5 % bins since 2026-10-17, a band through the bins' 95 % Wilson intervals (error bars first,
  the owner preferred a band); one panel per outcome zoomed to
  its own range, bins under 50 matches left out; dot size by count), the scores against the closing line three ways
  de-vigged, and facts (calibration error, favourites priced 70 %+, the gap to
  the market, the quarter-Kelly bankroll -- not the return per stake, which
  can be positive while the bankroll falls: +0.7 % on stakes, bankroll 60 % on
  elo-v15.0). Data: `public/data/calibration.json`, written
  by `build_site` from a walk-forward run (`research.calibration_payload`, about
  a second).

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

(All ten built in October 2026; seven wait on `explore/*` branches and three
are stored on `explore/later` -- see "Explore: which views stay".)

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
  `--edge-*` tokens; all ≥4.5:1 as label text on the chart surface in both
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