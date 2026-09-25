# EliteTracker

Predictive model for Norwegian men's football: **Eliteserien** (tier 1) and
**OBOS-ligaen** (tier 2). Uses an ELO rating system (elo-v12.0) to estimate team
strength, match probabilities and season outcomes. Data comes from FotMob.

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
less than one that dominated. Since Eliteserien 2022 the model uses a faster
K-factor and higher xG weight (K=30, α=30 %); earlier seasons and OBOS-ligaen
use the legacy config (K=20, α=45 %).

Two sets of odds are blended for each fixture:

- **ELO odds** -- derived from the rating gap, home advantage and draw model
- **Attack/defence odds** -- from a Poisson goals model with Dixon-Coles
  correction, updated match-by-match on goals and xG

The shipped prediction is a 25/75 blend (ELO/attack-defence). Scorelines come
from the attack/defence grid, conditioned on the blended outcome odds.

## Views

The site has eight views, switchable from the top nav.

### Finish Grid

A 16x16 heat matrix. Each row is a team, each column a finishing position
(1st through 16th). Cell colour and number show the **probability** of that
team finishing in that position. Teams are sorted by expected finish, not
current position, so the high-probability cells sit on the diagonal.

Colour scale: pale green (low) to deep navy (high). Cells below 0.5% are
effectively blank. The band strip along the top marks title, European
qualification and relegation zones.

### Table

Standard league table with additional model columns:

| Column | What it means |
|---|---|
| **Rating** | Current ELO rating (integer). The arrow shows recent trend based on a weighted average of the last 6 matches. |
| **xPts** | Expected final points -- the model's prediction of total season points. |
| **Form** | Last 5 results as points out of 15, colour-coded green-to-red. |
| **Title / Promotion** | Probability of finishing 1st. For OBOS-ligaen this includes both promoted spots. |
| **Relegation** | Probability of finishing in the relegation zone. |

Every column is sortable. The default sort is league position.

### Ladder

Both divisions on a single ELO rating axis. Team crests are positioned along
the axis so you can see the rating gap between any two clubs, even across
divisions. Horizontal on desktop, vertical on phones.

### Next Up

Upcoming fixtures with three-way odds (home win / draw / away win) shown as a
proportional bar, plus the top 4 most likely scorelines. Odds are computed
client-side from the model parameters shipped in the JSON report.

### Played Results

Completed matches grouped by ISO week. Each card shows the score, both teams'
ratings after the match, and the rating change from the previous match.

### Compare Clubs

Pick any two clubs from a dropdown. Shows a fictional head-to-head with odds
and scorelines, plus a rating history chart overlaying both clubs' trajectories
over time.

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
| Simulations | 50,000 | Monte Carlo runs per league |

### Team Focus

Click any club name or crest to open a detailed view:

- **Summary** -- rating, rank, points, attack/defence stats, form
- **Finish row** -- single-row heat map of finishing position probabilities
- **Pre-season vs live** -- how the prediction has changed since the season started
- **Rating history** -- ELO trajectory across all seasons, with peak/trough
- **Season shape** -- how title/relegation chances shifted after every match
- **Season-by-season** -- career table with rating start/end per season
- **Fixtures & results** -- upcoming and completed matches for this team

## Key stats explained

**Attack** and **Defence** are on the log-goals scale. Attack is expected goals
scored per match against an average side; defence is expected goals conceded.
Higher attack is better, lower defence is better. A team with attack 0.30 and
defence -0.10 scores roughly 1.35 goals per match against an average opponent
and concedes about 0.90.

**Expected points (xPts)** is the model's forecast of total season points,
computed from the remaining fixtures and each team's current rating.

**Rating trend** uses a weighted average of the last 6 matches (weights
[0.1, 0.2, 0.3, 0.4, 0.5, 0.6], oldest to newest), classified as:
strong rise (>6), rising (>1.5), steady (≥-1.5), falling (≥-6), strong fall (below -6).

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
