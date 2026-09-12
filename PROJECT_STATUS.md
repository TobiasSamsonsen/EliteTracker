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

## ❗ Known limits (also stated on the site)
- Ratings are held fixed for the rest of the season inside a simulation.
- Simulated matches draw a scoreline from the empirical distribution of real results
  (`model/scorelines.py`), conditioned on the win/draw/loss outcome *and* the pre-match
  rating gap, so a heavy favourite draws bigger scorelines than a slight one (real margins
  grow with the gap) and goal difference moves within a simulation. Tied finishes resolve on
  simulated goal difference, not today's. The rating-implied probabilities remain the sole
  driver of who wins.
- Clubs promoted from the third tier start at the ladder floor.

## 🔧 Open items

- [ ] Re-fit the draw model periodically as seasons accumulate.
- [ ] Re-run `python -m elitetracker.research run` after each season; the shipped blend's gap
      to the closing line is the number to watch. Re-sweep `k_shots`/`alpha` once OBOS-ligaen
      gets xG (`data/xg.json` is topped up by every refresh).
- [ ] Re-run `backtest_cli` after each new season to keep K / home advantage / regression
      fitted (bump `MODEL_VERSION`).
- [ ] Head-to-head tool — the same odds as Compare but framed as a rivalry: the two
      clubs' record against *each other* from the results, plus the model's current odds.
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
