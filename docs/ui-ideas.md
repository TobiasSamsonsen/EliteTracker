# UI and view ideas

A queue of ideas for later, not a plan: nothing here is decided or built. Each
has what it is, what our data already offers, and a rough size (S: a day or
less in `public/` only; M: a few days, or a small backend addition; L: a new
view with new published data). Anything that changes a published number also
needs the decision log in `PROJECT_STATUS.md` and a version bump
(`AGENTS.md`).

## From StatsUltra's Eliteserien forecast (2026-10-27)

Looked at `statsultra.com/forecasts/norway-eliteserien/`, desktop and a 390px
phone frame, club row and match opened, "Simulate a season" pressed. Their
page is one long scroll with a sticky section bar (Table, Matchday, Points
needed, Title race, Ratings, Head to head, FAQ), every figure from 15,000
simulated seasons, rebuilt daily. Ideas only: nothing is copied, and their
model, text and styling are theirs.

### What they show, and how

| Section | What it shows | How it is drawn |
|---|---|---|
| Headline | The title favourite's chance as one sentence ("... win the league in 56 % of 15,000 simulated seasons"), a paragraph naming the title and relegation stories | A big card; a split bar (favourite, challenger, everyone else); each figure with its change in 7 days |
| Race cards | Champions League (top two), Europe (top four), Relegation: only clubs with at least 5 %, most likely first, a change-this-week figure on each | Three side-by-side cards, a thin bar under each name; an empty state when no club is between 5 % and 99 % ("No club is between 5 % and 99 % for these places") |
| Table | Not the standings: expected finish. Rating, points with an eight-in-ten range, goal difference, title, top two, relegation chances, form | **"How seasons end"**: one stacked bar per club (title, Champions League, Europe, mid-table, relegation play-off hatched, relegated); the points range as a dot with a faint band and ticks at what 1st, 2nd and 13th usually need |
| Club row, opened | Four panels: how this club's seasons end, final points (median and range), rating over 90 days with a sparkline and rank, recent results and the next match with its odds | In place, under the row, no navigation; a link to the full club page |
| Matchday | Next matchday's fixtures: win, draw, win bar; expected goals; a "Top game" badge | Opened: four likeliest scorelines with bars, expected goals, both teams to score, over 2.5 goals, a match rating (average strength of the two sides) |
| Points needed | What it takes to win (72, eight in ten 69 to 74), finish top two, stay up (31, 29 to 33) | Three big figures, then ridge-style histograms of final points for the champion, 2nd and 13th place on one shared axis, the mode marked |
| Title race over time | Daily title probability for the contenders since the opening weekend | A line chart with an annotation on the biggest one-day swing and an end label per line; a "change this week" row under it |
| Ratings | Attack against defence for every club; biggest risers and fallers over 30 days | A scatter with the league average as crosshairs and a diagonal, the four corners named ("Defence first", "Strong at both ends", "Weak at both ends", "Attack first"); two short ranked lists |
| Head to head | Pick two clubs: how often one finishes above the other and by how much | "A finish above B in 52 of 100 random seasons", a split bar, a dot histogram of the gap in places or points; a list of the "closest battles" between neighbours in the table |
| Simulate a season | One random season out of the simulations | Pressing it replaces the table's columns with that season's result (each club's outcome as a label) under a banner ("Random season 22 of 100: ... win the league on 72 points, 6 ahead of ...") with simulate another, share, back to the forecast |
| Everywhere | A club picker that lays the chosen club's own range over the charts; share buttons (link, social, an image) on the table, a battle, a season; prose on how to read the numbers, a FAQ | |

On a phone the table keeps number, club, points, title, top two and down, and
drops rating, goal difference, the finish bar and form. The race cards stack,
with "Show 2 more" under a short list.

### How it compares with ours

We already have: the finish grid (every place for every club), a prediction
table, a ladder, a match view with scorelines, compare, a season mountain, an
attack-against-defence map, luck, and a team view (now with a forecast tab).
We do not have: a one-bar summary per club, finishing-order head-to-head,
league-wide race-over-time lines, a "points needed" view, a random season, a
change-this-week figure, risers and fallers.

### The ideas

Ordered by how much I would do them first. The top five are marked.

1. **TOP. "How seasons end" bar in the prediction table.** One stacked bar per
   club from the place probabilities and the league's bands (title, Europe,
   mid-table, play-off, drop). It condenses what the grid spreads over sixteen
   columns, and it is what a phone can keep when the table drops columns.
   Data: `position_probabilities` and `league.bands`, both in the report. Size S.
2. **TOP. A race-over-time chart.** One line per contender for a chosen band
   (title, Europe, relegation), the biggest one-day swing annotated, end labels,
   and a "change this week" row. A band picker makes it the relegation story
   too. Data: `report.history` holds every club's place probabilities at each
   snapshot. Size S to M, a new Explore item.
3. **TOP. A "points needed" view.** What it takes to win, to finish second and to
   stay up, each with an eight-in-ten range, over histograms of final points
   per place. Fits our new median xPts: the simulation already holds
   `position_hist` (place by points) for the thresholds, and `points_hist` (club
   by points, added with the median change). Publishing the percentiles, or a
   compact histogram for chosen places, is a small backend addition. Size M.
4. **TOP. Simulate a season.** A button that shows one random simulated season in
   the prediction table: each club's final points and outcome label, a banner
   in words, simulate another, share. It makes the probabilities tangible.
   Needs a sample of whole simulated tables published with the report (a few
   hundred final tables of sixteen places and points is small). Size L, the most
   engaging of the lot.
5. **TOP. Finishing-order head-to-head and "closest battles".** "A finishes above
   B in N of 100 seasons", a split bar, the spread of the gap, and a list of
   neighbours in the table whose seasons split most evenly. Our compare tool
   prices an imagined match and shows rating history; this answers the
   league-table question instead. Needs a published pairwise matrix (sixteen by
   sixteen, or counted from sampled tables, see idea 4). Size M.
6. **A points range beside xPts.** Show the median with its eight-in-ten range
   ("70, 66-74") in the table and the team view's tile, and as a dot with a band
   on a shared scale with ticks at the champion, runner-up and safety totals.
   Needs the percentiles from idea 3. Size S after that.
7. **Change this week next to every chance.** "Title 57 % (+26.5)" in the hero,
   the race lists and the table. Rewound reports already exist
   (`report-<season>-<date>.json`), so the figure is a difference between two
   reports; the cost is one more fetch per page. Size S to M.
8. **Race cards for every band.** A compact panel (Champions League, Europe,
   relegation) listing only clubs with at least 5 %, most likely first, with the
   empty state "no club is between 5 % and 99 %". Our hero shows one race at a
   time; this shows all of them, which suits a phone. Size S.
9. **A peek under a table row.** Open a club in place: its outcome split, its
   points range, rating sparkline, last five and next match with odds, and a
   link to the team view. Saves a navigation on a phone. We have the pieces
   (`renderTeamGlance`, the rating series). Size M.
10. **Rising and falling lists, and named quadrants on attack against defence.**
    The biggest rating moves over 30 days (the career series has them), and the
    four corners of the map named in words. Size S.
11. **More in an opened match.** Both teams to score, over 2.5 goals, expected
    goals and a "top game" badge. The score grid in `model.js` gives the first
    two; the match of the week already picks a top game. Size S.
12. **Your club everywhere.** The starred club highlighted in every table and
    its own range laid over the charts. We have the star (it steers the hero);
    this carries it into the table, ladder and charts. Size S to M.
13. **Share as an image.** A share button on the table, a head-to-head and a
    random season that renders a card. A growth feature, not a data one; needs
    a case for any image library (`AGENTS.md`). Size M.
14. **Sentences that say what the numbers mean.** A generated line under the
    hero ("Start and Kristiansund are the likeliest to go down, 92 % and 82 %"),
    and captions in plain words under charts ("eight in ten seasons: 69 to 74").
    Both languages. Size S.

### Things to leave

- Their 33 competitions and cross-league strength page: we are two divisions.
- Advertising slots, newsletter and feedback boxes.
- Their one-page-long scroll with a sticky section bar: we have views, and our
  mobile bar works. A sticky section bar inside a long view (the team view's
  tabs already do this) is the part worth borrowing.

### Mobile notes

Their phone table is the lesson: fewer columns, one summary bar, tap to open.
Ideas 1, 8 and 9 are phone-first. Ideas 2, 3 and 5 need a width of about 340px
for a chart and a label gutter, as the season shape does (a key under the
chart, not a margin). Our own phone checks are listed in `DESIGN_PLAN.md`.
