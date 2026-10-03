# EliteTracker

Predictive model for Norwegian men's football: **Eliteserien** (tier 1) and
**OBOS-ligaen** (tier 2). Uses an ELO rating system (elo-v12.0) to estimate team
strength, match probabilities and season outcomes. Fixtures and results come
from FotMob (xG from FotMob for Eliteserien, Sofascore for OBOS-ligaen);
benchmark odds from football-data.co.uk, squad values from Transfermarkt.

Deployed at [elitetrackerno.web.app](https://elitetrackerno.web.app).

## Quick start

```bash
python -m venv .venv && .venv\Scripts\pip install -e '.[dev]'
.venv\Scripts\python -m elitetracker.refresh          # pull latest results
.venv\Scripts\python -m elitetracker.api.server        # live server at :8000
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
less than one that dominated. From 2022 on, in **both** divisions, the model
uses a faster K-factor and a *lower* xG weight (K=30, α=30 %); earlier seasons
use the legacy config (K=20, α=45 %).

Two sets of odds are blended for each fixture:

- **ELO odds** -- derived from the rating gap, home advantage and draw model
- **Attack/defence odds** -- from a Poisson goals model with Dixon-Coles
  correction, updated match-by-match on goals and xG

The shipped prediction is a 25/75 blend (ELO/attack-defence). Scorelines come
from the attack/defence grid, conditioned on the blended outcome odds.

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
| **Rating** | both | Current ELO rating (integer). The arrow shows the recent trend: a weighted average of the last 6 matches' xG form (falls back to rating changes where a match has no xG). |
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

### Next Up

Upcoming fixtures with three-way odds (home win / draw / away win) shown as a
proportional bar, plus the top 4 most likely scorelines. Odds are computed
client-side from the model parameters shipped in the JSON report.

### Played Results

Completed matches grouped by ISO week. Each card shows the score, both teams'
ratings after the match, the rating change from the previous match, and the
match's xG where the data has it.

### Compare Clubs

Pick any two clubs from a dropdown. Three blocks: a **fictional match** with
three-way odds and top scorelines (swap home/away with ⇄), a **rating history**
chart overlaying both clubs' trajectories, and the **head-to-head** — the real
record (wins–draws–wins and goals) with every meeting listed, newest first,
paged five at a time.

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
| Scorelines | attack/defence | Source of scoreline predictions (not ELO) |
| Simulations | 50,000 | Monte Carlo runs per league (10,000 on rewound views) |
| Strength shock | ±0.15 | Per-run club strength noise (log-odds), so finishing odds carry rating uncertainty |

### Team Focus

Click any club name or crest to open a detailed view:

- **Summary** -- rating with trend arrow and cross-division rank, position,
  points, goal difference and played, then attack/defence as ±% vs the
  division average
- **Finish row** -- single-row heat map of finishing position probabilities
- **Pre-season vs live** -- how the prediction has changed since the season started
- **Rating history** -- ELO trajectory across all seasons, with peak/trough
- **Season shape** -- how title/relegation chances shifted after every match
- **Season-by-season** -- career table with rating start/end per season
- **Fixtures & results** -- upcoming and completed matches for this team

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

**Rating trend** takes a weighted average of the last 6 matches (weights
[0.1, 0.2, 0.3, 0.4, 0.5, 0.6], oldest to newest). It prefers the per-match xG
form -- how far the side played above its rating by the chances alone -- and
falls back to raw rating changes where a match has no xG. Classified as:
strong rise (>4 or >6), rising (>1 or >1.5), steady (within ±1 / ±1.5),
falling, strong fall; the cut-offs differ slightly between the xG and
rating-change scales.

## Rewind

A slider on the grid, table and ladder views lets you scrub to any matchday.
Every view rebuilds from only the results known on that date, so you can see
how the predictions evolved through the season.

## Tests

```bash
.venv\Scripts\python -m pytest              # Python tests
node --test tests/frontend.test.js          # Frontend logic tests
```

## Project structure

```
src/elitetracker/        Python package (model, pipeline, API, data)
public/                  Frontend (no build step, no framework)
data/                    Match data, xG, odds, market values
tests/                   Python + Node test suites
.github/workflows/       CI: deploy on push, refresh cron every hour
```

See `AGENTS.md` for full architecture details and `PROJECT_STATUS.md` for the
decision log and research notes.
