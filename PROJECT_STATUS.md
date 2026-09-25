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
