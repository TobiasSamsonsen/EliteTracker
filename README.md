# EliteTracker

Predictive model for Norwegian men's football: **Eliteserien** (tier 1) and
**OBOS-ligaen** (tier 2). Uses an ELO rating system (elo-v14.0) to estimate team
strength, match probabilities and season outcomes. Fixtures and results come
from FotMob (xG from FotMob for Eliteserien, Sofascore for OBOS-ligaen);
benchmark odds from football-data.co.uk, squad values from Transfermarkt.

Deployed at [elitetracker.no](https://elitetracker.no).

## Quick start

```bash
python -m venv .venv && .venv\Scripts\pip install -e '.[dev]'
.venv\Scripts\python -m elitetracker.refresh                       # pull latest results
.venv\Scripts\python -m elitetracker.research xg-obos              # OBOS xG (Sofascore, skipped in CI)
.venv\Scripts\python -m elitetracker.api.server                    # live server at :8000
```

Or preview the static build:

```bash
.venv\Scripts\python -m elitetracker.build_site --only-season 2026
.venv\Scripts\python -m http.server --directory public 8000
```

## How the model works

Each club carries one **ELO rating**. After a match, the winner gains points and
the loser loses them -- more if the result was unexpected. The update uses xG
(expected goals) to dampen lucky wins: a team that won but was outplayed gains
less than one that dominated, and a match one side dominated on xG moves the
ratings its way even when it ends level. From 2022 on, in **both** divisions,
the model uses a faster K-factor and a *lower* xG weight (K=30, α=30 %);
earlier seasons use the legacy config (K=20, α=45 %).

Two sets of odds are blended for each fixture:

- **ELO odds** -- derived from the rating gap, home advantage and draw model
- **Attack/defence odds** -- from a Poisson goals model with Dixon-Coles
  correction, updated match-by-match on goals and xG. Each offseason it is
  pulled toward its division's average shifted by the club's squad market
  value the season before, and a club's first matches of a season move it
  further, so it catches up with the winter's transfers sooner

The shipped prediction is a 25/75 blend (ELO/attack-defence). Scorelines come
from the attack/defence grid, conditioned on the blended outcome odds. In
Eliteserien a home side whose visitor normally plays on the other surface
(grass or artificial turf) gets a small edge on the prediction
(`normalize/surfaces.py`).

The season simulation also plays the play-offs in every run (OBOS-ligaen 3rd-6th
for a two-legged final against Eliteserien's 14th, OBOS-ligaen's 14th against a
second-tier side), so the promotion and relegation chances count them.

## Views

Seven views switch from the top nav (a bottom bar plus a "More" sheet on
phones); the eighth, Team Focus, opens from any club name or crest.

### Finish Grid

A 16x16 heat matrix. Each row is a team, each column a finishing position
(1st through 16th). Cell colour and number show the **probability** of that
team finishing in that position. Teams are sorted by expected finish, not
current position, so the high-probability cells sit on the diagonal.

Colour scale: pale green (low) to deep navy (high) in light mode; dark mode
inverts the ramp so the extremes keep their contrast. Cells below 0.5% are
effectively blank. The band strip along the top marks title, European
qualification and promotion/relegation zones for the division.

### Table

Standard league table with additional model columns. A **Current / Prediction**
toggle above the table swaps between the results so far and the season forecast;
which columns belong to which view is noted below.

| Column | View | What it means |
|---|---|---|
| **Rating** | both | Current ELO rating (integer). The arrow shows how far the rating moved over the last 5 matches -- the five in the form column. |
| **Attack / Defence** | Current | Chances created and conceded per match against an average side, as ±% vs the division average (defence turned round, so higher is better). Colour-coded red→blue pill, sortable by either. |
| **Form** | Current | Last 5 results as individual W/D/L blocks (blue / grey / red); the column sorts by the points those five total (out of 15). |
| **xPts** | Prediction | Expected final points — the mean total across the season's simulations (goals so far plus the simulated rest). |
| **GF / GA / GD** | Prediction | Projected final goals and goal difference, from the same simulations. |
| **Fix Diff** | Prediction | Expected points per remaining match for a league-average team against this club's run-in, centred on the league's mean run-in (red = harder, green = easier). |
| **Title / Promotion** | Prediction | Probability of finishing 1st (Title). For OBOS-ligaen the column is Promotion: the summed probability of the top 2 spots. |
| **Relegation** | Prediction | Probability of finishing in the relegation zone. |

Every column is sortable. The default sort is league position.

### Ladder

Both divisions on a single ELO rating axis. Team crests are positioned along
the axis so you can see the rating gap between any two clubs, even across
divisions. A horizontal strip on wide screens; on phones a ranked list, one row
per club, with its rating as a dot on a shared scale.

### Matches

Results and fixtures on one timeline, a week a page: Prev goes back in time and
Next forward, as on FotMob, opening on the current week. Played matches show
the score, both teams' ratings after the match, the rating change and the xG
where the data has it; fixtures show three-way odds (home win / draw / away
win) as a proportional bar plus the four likeliest scorelines, and a dot beside
a club whose title, European or relegation race the match is decisive for.

### Compare Clubs

Pick any two clubs from a dropdown. Three blocks: a **fictional match** with
three-way odds and top scorelines (swap home/away with ⇄), a **rating history**
chart overlaying both clubs' trajectories, and the **head-to-head** — the real
record (wins–draws–wins and goals) with every meeting listed, newest first,
paged five at a time.

### Explore

A gallery of other ways to look at the model's numbers: a card per
visualisation (thumbnail, name, short description) that opens it in place,
with `?view=explore&viz=<id>` links. Each one ends with **key figures** -- a
number, what it is, and one sentence on how to read it.

A visualisation of one division and season follows the division and season
picked in the title above it. The ones read off a single day follow the rewind
slider too; the ones with time along an axis of their own take none.

- **Attack vs defence** (`viz=attack`) -- every club placed by its attack and
  defence ratings (expected goals for and against per match against an average
  side), with a best-fit trend line through the division. Above the line a club
  defends better than its attack would suggest, below it the other way round;
  the tooltip says by how much. Key figures: the trend's slope (how many fewer
  goals a club concedes per extra goal it creates), the correlation, and the
  most attack-led and defence-led clubs. Follows the rewind slider.
- **Season mountain** (`viz=mountain`) -- the finish grid in 3D. The pre-season
  prediction is flat ground; every round stacks another layer of
  finishing-place chances on top, so the stack narrows into the table. Drag to
  turn, scroll or pinch to zoom; build it up round by round or press play;
  hide chances below a cut-off; order the rows by predicted finish, pre-season
  prediction or table; cut it down to one club's row and/or one place's column
  (the camera follows the cut). Key figures compare pre-season with the top
  layer built; on a finished season they become a scorecard for the
  pre-season prediction (hit rate, biggest climber, faller and surprise). The
  ⓘ button shows them in a popup. On phones the mountain fills the screen.
- **Luck table** (`viz=luck`) -- each club's points against what its chances
  usually earn, as a bar either side of zero, with each club's table place.
  The chances are each match's xG as points (both sides' goals Poisson at
  their xG), scaled before the match by the side's finishing over its last 20
  matches (goals against xG) and the other side's keeping over its last 10
  (goals let in against xG on target; Eliteserien only), both against the
  division; on top comes the trend below, since better sides still beat their
  chances. A "How luck is measured" box above the chart says so step by step,
  and the tooltip splits a club's usual points into those parts. Only matches
  with xG count. Follows the rewind slider; a click opens the club. Under it,
  "Do good teams have more luck?": every club season of the division's
  finished xG seasons (Eliteserien from 2020, OBOS-ligaen from 2023) as xG
  points against points above the scaled chances, champions as crests, with
  the trend line, and facts on the champions, the top quarter by xG points,
  the luckiest and unluckiest seasons and how much luck is left the season
  after.
- **Model accuracy** (`viz=accuracy`) -- how accurate the model is, in two
  parts. *Before the season*: every finished club-season of the division
  since 2015, where the model put it before the season (the order its
  expected finishes give) against where it finished, one circle a cell sized
  by how many land there, with the y = x line and the two-place band the hit
  rate counts; a strip of seasons under it, each with its hit rate and last
  season's table's, picks one season's clubs out by name. Key figures: hit
  rate, last season's table as a benchmark, average miss, best- and
  hardest-called season, biggest over- and under-achiever. *Match by match*:
  when the model gives an outcome 40 %, does it happen 40 % of the time? A
  reliability diagram of the pre-match odds of every match since 2016 (both
  divisions), the scores against the bookmakers' closing odds (three ways of
  removing their margin), and what quarter-Kelly betting on the model's
  edges would have returned.

### Model Card

Every tunable parameter in the shipped model:

| Parameter | Value | What it controls |
|---|---|---|
| K-factor | 20 (legacy) / 30 (2022+) | How much ratings move per match |
| Home advantage | 60 pts | Rating bonus for the home team |
| xG weight | 45 % (legacy) / 30 % (2022+) | How much xG dampens lucky wins in rating updates |
| Cross-season regression | 12% | How much ratings regress toward the mean each offseason |
| Peak draw rate | 26% | Maximum draw probability from the draw model |
| Outcome blend | 25/75 | ELO vs attack/defence weight for win/draw/loss odds |
| Goals model: xG weight | 90% | How much of the attack/defence update is xG rather than goals, where there is xG |
| Goals model: offseason pull | 12% / 25% | How far attack/defence regress toward the division each offseason (Eliteserien / OBOS-ligaen), aimed by squad value (0.2 / 0.3) |
| Goals model: keeping | last 45 matches | The keeper: goals let in against the xG on target faced, against the division (x 0.75), off the other side's expected goals (Eliteserien, where there is xG on target) |
| Scorelines | attack/defence | Source of scoreline predictions (not ELO) |
| Simulations | 50,000 | Monte Carlo runs per league (10,000 on rewound views) |
| Strength shock | ±0.20 | Per-run club strength noise (log-odds), so finishing odds carry rating uncertainty |
| Surface edge | 20 pts (Eliteserien) | Home side's extra rating when its visitor plays on the other surface (prediction only) |

### Team Focus

Click any club name or crest to open a detailed view:

- **Summary** -- rating with its 5-match trend arrow, cross-division rank and
  xG form; position, points, goal difference and played
- **Outlook** -- likeliest finish, expected points and the chance of each race
  the club is in (title, Europe, promotion, relegation), with the pre-season
  call and the rating change since as one line
- **Attack/defence** -- as ±% vs the division average
- **Next match and decisive matches** -- what the next result does to the
  club's main race all season ("Title 31% → 35% with a win · 16% with a
  loss"), plus, in the last ten rounds, the matches most likely to decide it
- **Finish row** -- single-row heat map of finishing position probabilities
- **Rating history** -- ELO trajectory across all seasons, with peak/trough
- **Seasons** -- each season's shape (the chance of every finishing place after
  every match, coloured by what the place is worth) above a picker listing
  position and rating start/change/end per season
- **Fixtures & results** -- one row per match from the club's side: home or
  away, the opponent, then win/draw/loss odds or the result with xG and rating
  change

## Key stats explained

**Attack** and **Defence** are the readable form of the model's log-goals
ratings: expected goals for and against per match against an average side (a
team with 1.35 attack scores roughly 1.35 against an average opponent, one
with 0.90 defence concedes roughly 0.90). Everywhere they appear -- the table's
pill columns and the team view -- they are shown as a percentage of the
division average, with defence turned round so higher is always better: `+20 %`
attack means a fifth more than an average side, `+20 %` defence means a fifth
fewer.

**Expected points (xPts)** is the mean final points over the season's
simulations: the goals and points already banked plus the simulated rest of the
season, not a formula over the remaining fixtures.

**Fixture difficulty** (Fix Diff) is the one number computed directly from the
odds: expected points per remaining match for a league-average team against
this club's run-in, centred on the league's mean run-in rather than a fixed
baseline.

**Rating trend** is the total rating change over the last 5 matches, the
same five as the table's form column: steady within ±8 points, rising or
falling beyond, fast beyond ±20. **xG form** (team view) is a weighted average
of the last 6 matches (weights 0.1..0.6) of how far the side played above its
rating by the chances alone; it is the one that looks ahead.

**Table order** follows the league: points, goal difference, goals scored,
then the head-to-head record between the clubs still level.

## Rewind

A slider on the grid, table and ladder views (and the attack vs defence map)
lets you scrub to any matchday. Every view rebuilds from only the results known
on that date, so you can see how the predictions evolved through the season.
The first stop is the **pre-season prediction**, dated the day before either
division's first match; the grid and ladder playback start from it, and it is
the season mountain's ground.

## Tests

```bash
.venv\Scripts\python -m pytest              # Python tests
node --test tests/frontend.test.js          # Frontend logic tests
```

## Backtests

```bash
.venv\Scripts\python -m elitetracker.backtest_cli --market --score-from 2016   # vs the closing line, Kelly
.venv\Scripts\python -m elitetracker.backtest_cli --calibration out.json       # the Explore calibration file
.venv\Scripts\python -m elitetracker.research odds --refresh                  # closing odds + raw prices
```

`--market` scores the shipped odds, Elo alone and the closing line (de-vigged
proportionally, by the power method and by Shin's method) match by match, and
stakes quarter Kelly on the model's edges at the closing prices.
`data/market_values.json` (Transfermarkt squad values, one entry per
club-season) gets the new season once a year, after it ends:

```bash
.venv\Scripts\python -m elitetracker.research market-values --season 2027 --dry-run   # check the join
.venv\Scripts\python -m elitetracker.research market-values --season 2027             # write it
```

Two pages, 4-8 seconds apart, stopping at the first 403/429. Never run it from
CI or the hourly refresh.

## Project structure

```
src/elitetracker/        Python package (model, pipeline, API, normalize, simulation, sources, validation)
public/                  Frontend (no build step, no framework)
public/vendor/three/     three.js r147, vendored; loaded only when the season mountain opens
data/                    Match data, xG, odds, market values
tests/                   Python + Node test suites
.github/workflows/       CI: deploy on push, refresh cron every hour
```

See `AGENTS.md` for full architecture details and `PROJECT_STATUS.md` for the
decision log and research notes.
