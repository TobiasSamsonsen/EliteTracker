# Frontend

Plain HTML, CSS and JavaScript in `public/`: no framework and no build step.
Scripts load with `<script defer>`.

| File | What |
|---|---|
| `index.html` + `app.js` + `i18n.js` + `styles.css` | the site |
| `model.html` + `model.js` | the model page (`/model.html`) |
| `elo-curve.js` | the model's price curve (`expectedScore`, `eloOdds`: `model/probabilities.py` in JavaScript), shared by the model page and the Predict game's slider; loaded before `model.js`, required by the node tests |
| `predict.js`, `predict.css` | the prediction game, the Predict view of `index.html` (`?view=predict`; `/predict/` is its route page, written by `pages.py`). `app.js` fetches them, with `elo-curve.js` and the three files below, the first time the view opens (`loadPredict`) ([predict.md](predict.md)) |
| `predict-core.js` | the game's pure logic: frozen price curve, whole-percent rounding, scoring, table error, nickname rules; the twin of `src/elitetracker/predict/`, pinned by `tests/fixtures/predict_vectors.json` |
| `predict-api.js`, `predict-util.js` | the game's network layer (Identity Toolkit and Firestore over `fetch`, no SDK; request builders are pure) and its small helpers (formatting, rounds, ring, badges) |
| `season-sim.js` | the what-if page's season simulation (a Web Worker) and its re-rating of the clubs (`rerateSeason`, a port of the Elo and attack/defence updates); also the finish grid's "how it happens" analysis (`simulateSeason` with `record`, `scenarioAnalysis`); loaded as a plain script and required by the node tests |
| `thumbs.js` | the sliding pill of every segmented control, on both pages |
| `share.js` | sharing, loaded before `app.js` (it uses `app.js`'s helpers only when called): `shareButton` (the share icon: three circles, an angle; `url` shares another address than the page's), the browser's share sheet (`navigator.share`) or our own (`openShareSheet`: the picture with Share or Download, the link with Copy or Share), and a canvas picture for each view shared as one, in the format and theme the reader picks in the sheet (`renderShare`: wide 1200 x 630 for link previews, square 1080 x 1080, portrait 1080 x 1350, story 1080 x 1920; the site's dark or light palette, defaulting to the theme on show; both remembered per browser). Each picture lays itself out for its shape (larger type on a tall one; the designs were picked format by format in a review, November 2026): the title race (`shareTitleRace`, the overview: two contenders as figures over the split bar, along the foot when wide and up the right side when tall, each club level with its share; three or more as a row each with its own bar, `shareRaceRows`), each other race (`shareRace`, the overview's race cards: the same rows, the bars in the band's colour, a line saying so when a simulated play-off is counted), the finish grid (`shareFinishGrid`, Sluttabell: the grid on wide and square, its cells at most half again as wide as tall; on portrait and story the predicted table, `shareFinishTable`, with the table's band marks and a small chart of each club's chance of every place), a club (`shareClub`, the club page: the rating after its trend arrow and its rank among every club (`rankText`); likeliest place, expected points, points now; attack and defence as the club page's bars from the division average; the chance of each race), a match (`shareMatch`, Sammenlign: the sides tagged home in blue and away in red, the odds bar under them named in the same colours, and the score grid from 0-0 to 4-4 with its axes named after the clubs) and a club's chance of a place (`shareFinish`, the finish-path popup: the likeliest season it happens in, the club's run-in and the rivals' results it rests on, from the popup's own analysis, the spare height of a tall picture shared between the parts; or, where those do not fit, the chance of every place with where the club stands). Crests come from `logos/share/` (256 px, FotMob's large crest, loaded only when a picture is drawn), else the 192 px PNG; the pages keep the 96 px WebP. "Hva om" shares its link only (the locked results are in `?lock=`). A view without a picture opens the browser's sheet straight away; one with a picture opens ours first, to choose. Names here must not clash with `app.js`'s: both are classic scripts, and a function of the same name silently replaces the other |
| `i18n.js` | `translations.en` and `translations.no`, one key table each; `t(key, vars)` |
| `vendor/three/` | three.js r147, vendored; loaded only when the season mountain opens |
| `fonts/`, `logos/`, `og.png` | assets (`logos/share/`: the larger crests the share pictures draw) |
| `icons/mark.svg`, `icons/favicon.svg`, `contours.svg` | the mark on its navy tile (the PNG icons' and `og.png`'s source), the favicon (the masthead's wordmark mark exactly: the cells without the tile, ink following the browser's colour scheme) and the contour motif behind the hero; keep every SVG file well-formed XML (no `--` inside a comment), or a browser shows nothing (`tests/test_svg_assets.py`); `tools/brand/` makes them and, from them, the PNG icons and `og.png` (see the scripts' headers) |
| `personvern.html`, `404.html`, `robots.txt` | static pages |
| `klubb/`, `utforsk/`, `obos-ligaen/`, `sitemap.xml` | generated by `build_site` (`pages.py`), git-ignored: `index.html` copies with their own head and a `<meta name="et-route">` |
| `data/` | the built reports (git-ignored; see [operations.md](operations.md)) |

## Navigation

Five primary views in one order everywhere (`VIEW_ORDER`): Oversikt, Tabell,
Kamper, Sluttabell, Utforsk; then **Mer** (Stige, Sammenlign, Modell), always
shown on a desktop. The phone bar has the first four and More (the sheet:
Utforsk, Stige, Sammenlign, Modell). The masthead never moves between views:
its right-hand group keeps the width it has with every picker on show
(`reserveMastheadEnd`), and the scrollbar's room is always kept
(`scrollbar-gutter: stable`), so `fitViews` folds a primary view into More
(from the end) by the window's width alone. From 761 to 1099px the strip
takes the room between the mark and the pickers (no centring), the wordmark
is its mark alone and the model badge steps out: four views fit at 761px,
all five from 800px.

**On a phone** (760px down unless said; `PHONE_SHEETS` in `app.js` is the
same query):

- *Shell.* The masthead holds the mark, the name (from 370px) and the
  division and season pill; the settings button goes (theme and language are
  in the More sheet, whose views carry icons, as the bar's do). From 480px
  down a view's panel runs edge to edge, and where the hero is empty
  (overview, club, ladder, compare, model, Explore) it starts right under the
  masthead. While the season loads, a skeleton of the view the address opens
  on (`html[data-boot-view]`, set by an inline script before the first paint)
  stands under the loading line. The consent banner is one row: a short
  wording beside the two answers.
- *Sheets.* The division, season and compare-club pickers open as bottom
  sheets over a scrim (`phoneMenu`); so do "what it takes" and a club's chance
  of every place, with a grip and a head that stays put while the rest
  scrolls. All of them, and the More sheet, close on a swipe down
  (`attachSheetDrag`). Touch readouts park above whatever is docked at the
  foot (`bottomObstacle`: the tab bar, What if's bar, the consent banner, the
  home indicator).
- *Overview.* The reader's own club (`overviewOwnClub`) leads where one is
  set; each division then shows the title race, the match of the week and the
  movers (side by side), and the other races.
- *Finish grid.* Zones (default) or All places (`gridMode`, kept per
  browser): Zones is a column per thing to win or lose (`gridZoneColumns`:
  Eliteserien title, Europe, play-off, relegation; OBOS-ligaen promotion,
  play-off, relegation) and a tap on a club opens its chance of every place
  (`openFinishSheet`); All places is the grid at 32px squares, scrolling
  sideways under a pinned club column (crest and `clubCode`: the initials
  Norwegian football writes, S08, RBK, AaFK, from `CLUB_CODES`). The season's
  replay paints the full grid in either. A tap on a square that opens what it
  takes goes straight to the popup, with no readout first.
- *Table.* Three column sets instead of columns dropped by width: Table
  (#, club, played, GD, points, form), Strength (rating, attack, defence; a
  phone's own mode, shown as Current on a wider screen, `effectiveTableView`)
  and Prediction (xPts, fixture difficulty, how it ends). Each fits 360px,
  rows 44px tall; from 375px Table adds W/D/L and Prediction the projected
  goal difference, from 430px Table adds goals for and against.
- *Matches and What if.* Cards show the clubs as crests, the name button
  stretched invisibly over each (the reader asked for the crest-only cards
  back). What if adds one-tap H / U / B pills (`whatIfOutcomeScore`: the
  likeliest score for that result) and its bar leads to the table of
  chances, which has a way back.
- *Club page.* The head is one row: back, the crest (44px), the name (two
  lines at most) and the star and share buttons at the right; the rating
  and its rank under it.
- *Explore.* A view's *Explore further* cards (`.tool-links`,
  `renderToolLinks`) stand under the panel's head on a desktop or a tablet
  (What if in Matches' head corner; the ladder's under the ladder,
  `data-place-wide="foot"`). On a phone the table's and the finish
  grid's move to the panel's foot under its legend (`placeToolLinks`, which
  moves them when the window crosses 760px), one row of cards that scrolls
  sideways, each its thumbnail over its name; the ladder's and Matches' stay
  at the top (`data-place="top"`) as pills the panel's width, a larger
  thumbnail beside the name and a short line under it (`explore.<id>.short`,
  `ladder.short`), so they lead on without drawing the eye from the view. The gallery is a list, a tool page's back button sits beside its
  name, and the luck table's "how it is measured" starts closed.
- *Touch.* Every control is at least 44px on its short side (24px inside
  dense tables and charts), through padding given back by a negative margin
  or an invisible `::before` hit area; chart labels render at 10px or more;
  sliders take `touch-action: pan-y`; pull to refresh starts only at the top,
  with nothing open over the page, not on a slider or sideways scroller, and
  only for a drag more down than sideways. A replay that has to fetch a
  report per matchday fetches six at a time with a count on screen
  (`inBatches`).

`experiments/mobile-audit/check.py` checks every view at 360, 375, 390 and
430px and on a desktop: no sideways overflow, no overlapping masthead parts
or bottom bars, the touch targets above, no console errors
([operations.md](operations.md), "Tests").

## `app.js`, by section

Sections start with a `/* ---------- name ---` header; search for the name.
In file order:

- **state and formatting** (top): the `state` object, report URLs, number
  formatting
- **accessibility utilities**, **tooltip**, **bands**, **legends**
- the views: **the overview** (`renderOverview`, the landing page: both divisions, each opening with the title race as a row of its own (`overviewTitleCard`: up to five contenders' chances in display type, one decimal each, over one bar split between them, the favourite's share in the title gold, the rest of the field in one dim slate, no medal colour), then each other open race as a card whose bars take the band's colour (`overviewRaceCard`: up to four clubs, each with its chance large and a thick bar). Every live chance carries its move since the last round (`overviewBefore`: the report of the last matchday before the latest round's first match; `chanceChange`: the table's arrow from `trendArrowSVG`, upright past 10 percentage points, in the good or bad tone for the club). Then the match of the week, the one Kamper's hero shows (`weekMatch`, shared with `heroMatch`): drawn as a scoreboard (each club's crest large over its name, the kick-off time between them before the match and the score after, the loser then stepped back), the odds bar under it before and each side's chance before the match under it after, and a line per club on what it decides or did, marked in its band's colour; beside it the climber and the faller (`overviewMovers`, labelled, the table's arrows and colours). A finished division opens on its champion instead (`overviewChampionCard`: the club and its points in display type, places 2-4 smaller under it, each place in its band's colour) and then its promotion and relegation cards (`overviewOutcomes`): the clubs already up or down in words, those still in a play-off with their chance and bar. Block titles take the heroes' label type and every figure the heroes' figure type (Archivo at width 125, weight 800). Each division ends with two tiles on to its table (who tops it) and its matches (`overviewDivisionLinks`: when the next round starts and how many matches it has); its heading holds only the name and the round. The Explore tools close the page: on a desktop or tablet the six tools with thumbnail and description (`overviewTools`), on a phone one large button whose picture is the first four thumbnails two by two (`overviewExploreButton`). Its widths: the phone layout from 760px down, the narrowest phones (two title contenders a row, stacked tiles, the Explore button's thumbnails over its text) from 380px down, and two container queries: three race cards where only two fit give the third the whole row, and the champion's places 2-4 run three across only where the card is 46rem wide. Checked at 22 widths from 320 to 1600px through a season (pre-season, round one, April to November, OBOS-ligaen's last day, a finished season) for sideways scroll, overflow, overlap and cut-off names. Built from the other views' own pieces; every block is one button, and a club in it opens the club), **the finish grid** (and its animation), **standings**,
  **season shape**, **rating ladder** (and its animation), **fixtures**,
  **high stakes**, **played results**, **hero & model card**,
  **model card: how accurate the model is**, **team** (one club's focus view),
  **compare clubs**
- **how a finish happens**: a click or Enter on a finish-grid cell opens a popup (`openScenario`, `?scenario=<team id>:<place>`), with the site's own pieces (the chance as the display figure; each match with the Matches page's odds bar over all simulations, the scenario's result lit, and "all → these" beside it; the club's own matches with a chip and an accent edge; the final table with places gained or lost and points taken; a result against the odds in the fold marked by a dotted underline, no colour): the likeliest season that ends this way (the finish is only a filter, so it is the one maximising the chance of its results times the chance of the finish given them, found by a branch-and-bound search over the matches that can still move the finish, not by hill-climbing; the second factor is 1 unless clubs are level on points, when goal difference decides and it is the chance from the simulations' own margins that it falls the club's way, which the popup's switch turns off to show the single likeliest run of results, with a note on why counting it is the default; scores: each result's commonest in all simulations, except in the matches of clubs level on points, where they are the likeliest scores that still hold the finish, so the lead is as small as it allows rather than one big win; exact, as `typical.exact` reports, unless the work budget or the 1.5 s deadline runs out or the joint chances of many level clubs grow too large to follow, in which case it is the best season found by then; with a hundred matches or more left, early in the season, most finishes are best-found rather than proven; matches count as independent, as the popup's per-match figures do; when clubs end level on points and goal difference the note names goals scored, then the table's order, as what decides)), with the other clubs' results in it that are clearly more common here than usually (8 points of share or more, six at most; a draw also counts as one side not winning; the season shown is picked to agree with them), the club's own matches with how often each result comes in all simulations and in these, the season's final table, and every result behind a fold (the club's matches lifted out, results the odds had against marked). The key matches (own and other) lock into What if as the scores of that season; What if re-rates the clubs for them, so its figures come out near the popup's, not equal. Runs in the what-if worker; pointing at a cell starts it
- **explore**: the gallery, what the further views share, race lines, the luck table, the **relegation play-off** (`renderPlayoff`, `/utforsk/nedrykkskvalik/`; colour is division throughout, Eliteserien `--tier-1` and OBOS-ligaen `--tier-2` as on the ladder, with no good/bad tones since neither side of the tie is the bad one): one sentence on the tie; the answer as a sentence in the division's own frame (the Eliteserien club stays up, or in OBOS-ligaen's view the OBOS-ligaen club goes up) over a hundred squares, one per season (`playoffHeadline`); how it is played (`playoffBracket`: a column per round climbing a step each round on the ladder, from 2019, or semi-finals before; each seed slot names the clubs likely to finish there from the OBOS-ligaen table, the 14th's slot those likely to finish 14th, a winner's slot ("Winner of round 1") the clubs likely to come through that match (`playoffWinners`, from `bracket`), and under a match not settled yet its three likeliest pairings of 1 % or more (`playoffLikely`, from `bracket`; not on the tie, whose pairings have their own section); dates from `PLAYOFF_CALENDAR`, NFF's draw, a season not listed shows none); who plays the play-off, the two sides next to each other (`playoffSide`: a bar and "N of 100 seasons", then what follows); the likeliest ties as scoreboards (`playoffCards`, pairings of 1 % or more, each club with its chance of winning the tie); every pairing in a closed grid (the Eliteserien club's chance, tinted in the favoured division's colour) and a closed how-it-works. One rule for the numbers: "of 100 seasons" is how often something happens, a percentage is who wins once it does. A played season shows the two clubs and the result; OBOS-ligaen's report adds its 14th's survival tie against the tier below. Read from `relegation_playoff` in the report: `pairs` (`top` the Eliteserien club, `bottom` the bracket winner, `p`, `stay`), `bracket` (OBOS-ligaen's play-off match by match, each pairing's `home`, `away`, `p`, `home_win`), `teams` (id to name), `survival`; both divisions' reports carry the same pairs since they are the same runs, thinner than `MIN_TIE_PAIR` left out; it follows the rewind slider; `playoffGrid` is the pure part), **what if** (lock a score on any match, or auto-fill the rest; the Matches cards made editable, an unset score as an empty slot, a set one flagged in its date line by a pill that undoes it; a By week / Your changes switch (Your changes disabled until a score is set, never hidden, so nothing shifts); the clubs re-rated, each fixture priced only on the locks of earlier weeks (`whatIfStages`), the chances beside them, the method in a closed "How it works" under them)
- **season rewind**, **theme**, **skeleton loading helpers**
- **wiring**: `render()`, the URL parameters, `popstate`, `boot`
- **analytics**, **mobile gestures**

The views share one `state` object and redraw through `render()`. The URL
is read at boot and on `popstate`, and written by `render()` and
`openTeamView`.

**Address.** `routePath()` gives the path for the view on show: `/klubb/<slug>/`
for a club of the current season (`routeClubs`), `/utforsk/<slug>/` for an
Explore tool, `/obos-ligaen/` or `/` otherwise; `render()` writes it, with the
query (`view`, `team`, `viz`, `season`, ...) after it, and sets the canonical
to it. `clubSlug`, `EXPLORE_SLUGS` and `SHORT_NAMES` mirror `pages.py` (pytest
compares them). A route page's `<meta name="et-route">` fills in what the
query leaves out, at boot only (`pageParams()`); a query naming a view or a
club wins. The local server answers any extension-less path with
`index.html`, so a club address works without the pages built.

**History.** `openTeamView` pushes an entry carrying `{ team, teamId }`;
`render()` rewrites the current entry's state from the view on show
(`entryState()`), so an entry names its club only while that club is open.
`popstate` reopens the club of the entry it lands on (Back from club B lands
on club A) and otherwise leaves the team view. Tabs, Explore tools and the
scenario popup still replace the entry rather than push.

**Bundles.** *Play season*, the *Season mountain*, the *Luck table* and the
scorecard read `timeline-<season>.json` / `seasons-summary.json`
(`fetchTimeline`, `timelineReports`, `fetchSummary`) and fall back to the
per-date and per-season reports where those are missing.

## Rules that bite

- **Decimal point in both languages** (AGENTS.md): `0.26`, `69.2 %`, inputs
  accept a typed comma. Thousands: a space in Norwegian (`50 000`, none at four
  digits), a comma in English.
- Every user-visible string goes through `i18n.js`, in both languages.
- **One notation for the same fact** (`rankText`, `changeText`): a rank standing
  alone is `3.` in Norwegian and `#3` in English (inside a sentence it stays an
  ordinal, "3rd place"); a change is an arrow and its size, `▲ 8` up and `▼ 8` down, in the
  outcome colours, with no sign (the arrow is the sign), left out when it rounds
  to zero. Rating, place moves and race-chance moves all use it. A probability is
  `71.0 %` (the page's own decimals); a thin bar under it only where the figure
  stands alone (the overview's race cards), never in a table, the grid or an
  odds bar. The table's five-step rating trend arrows are a trend, not a change
  figure, and stay as they are. The hero's headline figure (the movers at display size) keeps its plain sign: the
  arrow is for compact figures. No monospace (Round 1 item 5 took it out).
- Reports from older model versions (the past-seasons archive) can lack
  newer fields; the fallbacks for them are deliberate.

## Tests

`tests/frontend.test.js` (`node --test`) evaluates functions copied out of
`app.js` and `model.js`, and requires `season-sim.js` and `elo-curve.js` whole (`pick`, which slices a `function name(` declaration
out of the source; arrow-function constants cannot be picked). The model's
arithmetic is checked against `tests/fixtures/match_odds.json`, which the
Python model writes ([model.md](model.md), "The browser's copies").
`tests/season-shape.dom.js` boots the real page in jsdom (dev only).

## The Predict view

Predict is a view of the app like the rest: a masthead tab after Explore (folded into More when the
masthead is narrow; in the phone's More sheet), `<section data-section="predict">` in `index.html`,
and `/predict/` its route page (`pages.py`, `{"view": "predict"}`). Its code is not on the page until
the view opens: `renderPredict` in `app.js` loads `predict.css` and the five scripts (side by side,
run in order) and calls `window.PredictGame.show()`; leaving the view calls `hide()`, which stops the
game's clock and address handling. The game reads none of the season report, so `bootPredict` draws it
at once on a link to it, before `report.json` has landed (`render` draws only the game while there
is no report: `renderWithoutReport`). The game's classic scripts share the page's global scope with
`app.js`: a top-level name in both is a load error (a `const`) or a silent replacement (a `function`),
which is why `predict-util.js` says `signedScore`, not `signed`. The masthead's division picker and
the title race are hidden on the view: the game has its own division switch and plays the current
season only. Theme and language are the site's settings; a language change redraws the game and
updates a signed-in player's profile locale.

`public/predict.js` renders the game from plain DOM calls; strings are the `predict.*` block of
`i18n.js` (nb + en, held to parity by `tests/frontend.test.js`). It reads about ten small Firestore
documents per page load (never a public collection) and writes a pick as a `commit` of the changed
slots only, so the free plan's daily quota is not the limit. localStorage (drafts, the session, the
fine-tune choice) is always in try/catch and the page works without it. The odds bar is the matches
view's own `.odds` / `.odds__seg`; the card's drag is `touch-action: pan-y` so the page still scrolls.

The bar is the control: the grey draw block is the handle, and because its middle is always at the
expected score (home + draw / 2), the gap under a finger is the logit of the finger's position
(`gapUnder` in `predict.js`), so the block follows the finger whatever the draw tendency. **The size of the draw block is only
set with fine-tune on:** on the curve the whole block moves with the finger and its width is the model's
(the ends are no handles, no ridges are drawn, and the width input is disabled); with fine-tune on each
end of the block is a handle (a ridge just inside it) that moves that end alone and holds the other
(`dragBar` in `predict.js` decides by where the finger lands, and a grab keeps its distance from what it
took, so nothing jumps. A finger, unlike a mouse, waits for a sideways move before it counts, so a scroll or a tap on the bar never moves a pick; on a card that already has one it must also start on the draw block (20px of slack), so the block never jumps to where a finger came down, and a drag that moved such a pick leaves an Undo for eight seconds; `positionForEdges` in `predict-util.js` still turns an end into a curve position
for a pick saved earlier). **Fine-tune** is a toggle pill on each card (every untouched card starts on the curve, with it off, unless Meg's "Always use fine-tune" is on: a switch kept in this browser as `predict.fine.always`, which opens every card with it on and hides the pill): on, the pick is three whole percents of its
own, off the curve, every part moving a percent at a time with no limit but 1..98 (`freeEdges`; the
middle slides the block at its width), the numbers can be typed (`freeTyped`), and the save stores
those percents with the nearest curve position beside them (`freePosition`: the rules want a `g` and a
`k`, and the crowd's signal reads the gap); off, it snaps back to the curve. A saved pick whose
percents are not the curve's comes back with fine-tune on (`isFreePick`). On the curve, "Modellens
uavgjort" puts a dragged draw back to the model's. Two native range inputs sit invisibly on top for
keyboards and screen readers (the position and the width: gap and tendency on the curve, home and
draw percent with fine-tune on; the focus ring is drawn on the bar, `aria-valuetext` reads the three
percents). `pickSlider` is that control, shared by the cards and the guide's demo. After kick-off the card leads with a verdict (beat the model or not), dims the outcomes
that did not happen, and keeps the Brier score behind "The scores". The reveal scores the stored whole
percents, never the slider position. `styles.css` turns `.odds` into a padded scroller under 480px;
`predict.css` resets that for the game's bars.

Each section has an address (`#table`, `#boards`, `#leagues`, `#me`; the tip view is the bare `/predict/`), so links can
open it and Back works (another view's render drops these hashes); the chosen division is remembered. The browser session is stored per
project (`sessionKey`: the live project keeps `predict.session`, an emulator `demo-*` project gets
its own key), and a public document (`meta/rounds`, `fixtures/`, `reveal/`, `boards/`,
`tablegames/`) is read again without a token if a stored token is rejected, so a broken session
never hides the game. Matches are grouped by matchday in kick-off order; the card shows the time,
the day is its heading.

No Predict card carries a coloured edge (a thick left or top border): where a place or a row needs a
mark it is the Tabell view's band mark, a 3px stripe on the row's leading edge (the table game's
zones, your own leaderboard row), and the overview's cards have none either (its places 2-4 take
the inline band mark). The table game (Tabelltipp) is a table like Tabell's (square rows on the panel, a line between them, no rounded box to cut the stripes) and drag only, with no arrow buttons and no save button: a club is
picked up (a mouse anywhere on its row; a finger on the six-dot handle at once, or anywhere on the
row after a 280 ms hold, so a swipe there still scrolls) and moves in its own lane as far as it is
taken, the others sliding aside while the numbers and zone stripes show where everything lands
(`dropIndex`, `moveItem` in `predict-util.js`); near the top or the bottom of the screen the page
scrolls along, so a club goes from first to last in one drag. On the handle the keyboard moves it
(arrows a place, Page Up and Down five, Home and End), the focus stays with the club and its new
place is read out. The order saves itself a moment after each move, like a match tip (the draft in
the browser holds it until the save is in, and an order left from an earlier visit is saved on the
next); the line beside the zone legend (each zone with its bonus) says saved, saving or failed.

The first visit is a tutorial, not a box: until `predict.intro` is `seen` (set when it is finished, when the guide's
button is pressed or when a first pick is saved; a player with an account is never asked) the tip, table and guide
views show eight steps one at a time (`TUTORIAL`, `renderTutorial` in `predict.js`) on the guide's own working demo
(`guideDemo`: a bar to drag, Fine-tune, a result to pick; nothing is saved). Steps 2 to 4 wait for the player to do
it (`need`: the demo's `moved`, `fine` and `picked` flags) before Next opens; only that button and its hint change
while the bar is dragged, so a drag is never rebuilt under the finger. Boards and Me stay open. Afterwards the guide
has a button to start the tutorial again (`S.replay`, with a way back). The last step, shown only to a player with no
account yet, asks them to sign in with Google (the Me tab's flow, `googleFlow` and `switchToGoogle`; the script loads on
the button press) and offers "Play anonymously" as the quieter way on; signing in leaves the tutorial at once.

The guide is a section of its own at `#how` (the panel head's link points to it):
six steps with a working demo bar and a scoring demo (pick a result, see the Brier score against an
even guess), then questions. The page answers the player: each card reads the pick in words as it
moves (`pickReading`), a phone ticks when the pick swings sides, a save pulses its dot, a live round
breathes, a completed round pops its ring once, a reveal grows its bars into place the first time it
is seen (IntersectionObserver), and a 30-second clock keeps the countdown current and locks a match
that kicks off while the page is open. All motion stops under `prefers-reduced-motion`. A bar
segment keeps its number while the number fits, measured against the bar's real width (`labelFits`),
not a fixed 12 % cut-off.

The layout is built for a glance (a UI pass in Chrome, November 2026). The view is one site panel:
its head holds the title, the guide link and the four sections as a switch, so the first match sits
about 250px from the top on a desktop. The tip view opens on one sticky bar under the masthead
(`--predict-top`, measured from it): the division on the left, the round in the middle (its name
opens the native list of rounds, laid invisibly over it), the deadline and your progress ring on the
right; on a phone the division and the ring make the first row and the round and the deadline the
second; the ring holds its own count (`3/8`) and is the height of the bar's other controls. Under each card's bar is one line: a dot for the save state (grey untipped, amber pending,
green saved, red failed), the pick in words (`pickReading`, with the three numbers added only when a
segment is too narrow to show its own), a short save word, and Clear and Fine-tune as small pills at the end (the
full "saved 2 min ago" is its tooltip). Every button is the site's secondary pill (`.pbtn`, as
`.whatif-reset`) or its accent pill, never bare text; controls are 2.5rem tall (switches 2rem
inside their rim), small pills 2rem, and all 44px on touch. Sharing is the site's: the round recap
has the share icon (`shareButton`), whose sheet draws the recap as a picture in share.js's frame
(`sharePredictRound`), and a mini-league's invite is shared the same way (`shareButton`'s `url`).
Crests stand beside clubs on the cards, the recap, the table game and the playing style's matches,
and beside the club you follow on Meg. Matchday headings are the site's small uppercase labels. Cards
are `--panel-sunk` wells inside the panel. The first-visit box is three numbered steps side by side.
Notes (`#predict-note`) float at the foot of the screen, over the phone's tab bar. The game redraws a section whole on each tap, so nothing may flash
between two draws: a switch drawn anew hands its pill to the sliding one at once (styles.css: the
pressed button drops its own pill with no fade, or two pills showed for a few frames), a board read
in the last five minutes is drawn at once (`cachedBoard`, `loadBoard`; the season panel's board is the
same document), one not read yet leaves the board on show dimmed until it arrives, and the table
game's documents are kept for the visit (`S.tables`, your pick updated when you save).

From 1000px the matches are the left column and "your season" the right one (`renderSide`,
on the tip and table views; the boards take the whole width, and Meg has the full numbers). It is kept
visual and short: your season points counting up; your tier in one line, by the share of players you beat
(Elite 90 %, Ekspert 75 %, Analytiker 50 %, otherwise Utfordrer), with your rank; a bell curve fitted to the
board's percentile table (median as the middle, half the 16th-84th spread as the sd: `normalFit`), cut into
the tiers' colours at the board's own 50th, 75th and 90th percentiles, strong for the part you beat and faint
ahead, your marker sliding in, and how far the next tier is as its one caption; three tiles (accuracy, matches,
against the model); your points per recent round (on the floor, or split at a middle line once a round went
below zero). The tier list with its explanation is the leaderboard's (its standing card); the badges are in Meg. The rank
counts people only (board ranks include the model and crowd rows). Narrower than that the panel is one
short strip above the matches (tier and rank, score, the same inset on every side), the rest behind a disclosure, and the strip is left out until you have a settled match. A division you have not played this season keeps your season on screen: the strip shows the division you have played, its label naming it ("Poeng i Eliteserien"). The maths is in `predict-util.js` (`beatShare`, `normalFit`, `tierOf`, `roundForm`).

Two numbers, kept apart ([predict-plan.md](predict-plan.md), section 5, "Revised 2026-11-24"):
**points** (Poeng), 10 x (1 - Brier) a tipped match (a mark out of 10), summed, which rank the leaderboard; and
**accuracy** (Treffsikkerhet), the average Brier as a percent, 100 x (1 - Brier / 2). Both come
from a player's matches and summed Brier (`totalPoints`, `accuracyPercent` in `predict-core.js`), so
the stats documents and old boards need nothing new (`rowPts`, `rowAcc` fill them in for a board
built before the job wrote `pts` and `acc`). Points show one decimal with the language's grouping
(`ptsText`), accuracy two (`pctText`), Brier and "against the model" three. Everything is Brier:
the job still computes RPS and Accuracy against the median (`stats/`, the boards' `ab`, `ar`, `r`),
but the page reads only `ab`, for the "beat the field" badge. A match's details (Poengene) show its points,
its accuracy, its Brier and its Brier against the model, with no explanation under them; Meg shows points, accuracy, matches and against the
model; the round recap and its picture show the round's points. A long leaderboard is shortened (`boardWindow` in
`predict-util.js`): the top 10, the five rows above and below yours, and the model and the average
wherever they stand, with one row for each run left out ("23 spillere til") that opens the whole
list, as does the button under it ("Vis alle 64", then "Vis topp 10 og deg"). The division switch
has Begge too: both divisions together, a season board only (`season_{season}_all`; Round and Last 10
are disabled while it is on). The leaderboard's controls start at the table's left edge, the season and round pickers
last, so the round's picker (Runden) appears without moving anything; on a phone each switch has a
row and the pickers share one. A row's controls are one height: 40px, and 52px on touch, where a
switch's 44px buttons sit in its rim (the pickers, the round bar's arrows and its ring follow). A board's rows are all one height, and its sort arrow shows only once
a column is sorted, hanging outside the label so a header lines up with its numbers. The window follows a
column sort; "Gå til raden min" shows only in the whole list.

Meg has "your playing style" (`analysisSection`): your settled picks (own entries, plus the round's
`reveal` and `fixtures` documents; a finished round is cached in the browser, so it costs reads
once) compared with the model's locked odds and the results (`analysePlay` in `predict-util.js`,
from five matches): you against the model match by match and what following it would have
scored; four style tracks against the model (favourites, draws, home side, boldness); and tips,
strongest first, each opening to the matches behind it: favourites over/under-valued (checked
against how often they won), draws, home bias, a club you over/under-value (three matches or
more), bold or careful and whether it pays, going against the model, tipping long before the team
news. A division filter re-runs it; the top tip also shows in the season panel.

Run it against the local emulators (no cloud involved):

```bash
firebase emulators:start --only auth,firestore --project demo-elitetracker     # Auth :9099, Firestore :8085
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 .venv/Scripts/python -m elitetracker.predict_sync     --project demo-predict-ui --report public/data/report.json --data-dir /tmp/predict --no-purge
python -m http.server 8123 --directory public
# then open http://localhost:8123/?view=predict&emulator=1&project=demo-predict-ui
# (/predict/ itself is a route page: it exists once build_site, or pages.build_pages, has run)
```

`?emulator=1` is honoured on `localhost` / `127.0.0.1` only. Tests: `node --test tests/predict.test.js
tests/predict-ui.test.js`. Not testable without the real Google: the Google account link (its request
builder and error mapping are unit-tested; the sign-in itself needs the live OAuth client).

### The Predict view: the November 2026 usability pass

- **Round recap.** A card (`.precap`): the round's points and accuracy % as two big figures, then the counts
  (tipped x/y, beat the model x/y, points against the model), then the best and the worst call with their
  points against the model. The numbers are worked out in `recapOf` from the reveal and your entry (the same
  scoring as the job, scored matches only), so the card does not wait for `stats/{uid}`. The share picture
  (`sharePredictRound`) leads with the same two figures, big, and puts the counts, the round at a glance
  (one bar a match in kick-off order, up in blue when you beat the model and down in red when not, as tall as
  the difference in points) and the best and worst call with their crests on one panel; wide pictures set the
  figures beside the panel, tall ones put the panel under them, and every size scales to the room the format
  leaves (a story gives its spare height to the bars). The match reveal itself is unchanged.
- **Rank is said once.** The board's rank column counts people only (`humanRanks` in `predict-util.js`; the
  Folket and Modellen rows show a dash and take no place), the side panel says "Number 4 of 30 · beats 93 %"
  under your tier, and the bell chart carries no caption of its own. "Against the model" is in points
  everywhere (10 x the summed Brier difference).
- **Leaderboard.** Clean, with the reward in three places: your card, the podium and your row. Points first, accuracy
  next, matches quiet. There is no streak anywhere in the game (a freeze every fifth round was arbitrary, and was
  removed in November 2026). One card says where you stand (`standingCard`, its numbers from `standingOf` in
  `predict-util.js`): your tier's diamond and a tint of its colour, your name as its title, under it your tier (the share
  of players you beat, `tierOf`), the top share and the player count; your place, points and accuracy as three figures;
  the side panel's tier bar (steps at 50, 75 and 90 %), under it the percentage points to the next tier, a line that
  opens the tier guide ("Om nivåene", `tierGuide`: what a tier is and is not, the four with what each takes, yours
  tinted; the same guide is in the side panel's details and is the guide's last question); then one line: ▲ the points to the player ahead, ▼ your lead
  on the player behind (`rivalsOf`), and how far you are ahead of the model (or behind it). It replaces the note under
  the table when it shows. With three players or more the top three stand on a podium (`podiumOf`: the winner in the
  middle on the tallest step, each step in its metal, your step outlined; in place order for a screen reader) and the
  table in board order goes on from fourth place (the short list: the podium and seven more make the top 10); sorted by
  another column the table lists everyone again, places 1 to 3 with a flat chip. The model's row is a dashed line to
  beat: whoever is above it beats the model. A "Go to my row" button opens the full list first when your row is not in
  the short one (none when you are on the podium). Under the table: the show-all toggle, one line on the ranking, and
  "How points work" folded away. On a phone the table keeps rank, name, points and accuracy; "More columns" brings
  back the matches (sideways scroll). Places come from the board's own `place` (`make_board`), which counts players
  who hide their name, as the player count and the share beaten do: a hidden player above you is a skipped number,
  and the note under the table says so (`humanRanks` counts the listed players only on a board built before it).
  Tiers and places are kept apart: the podium's round medals are gold, silver and bronze, the tiers are Elite,
  Ekspert, Analytiker and Utfordrer, each a flat diamond in its own colour (`.plevel`: violet, sky, teal, grey).
- **Round list.** Each round in the picker carries, once something of yours is scored in it, how many of its
  matches you tipped and what it earned; it is filled in when `stats/{uid}` has arrived.
- **Fine-tune.** Every untouched card starts on the curve (the remembered default is gone, so one tap no longer
  opens eight cards' worth of number boxes); the explanation shows on the card where the pill was just
  switched on. A saved off-curve pick still opens with fine-tune on.
- **Table game, not open.** Says when it opens (early December, when the clubs and fixtures are known) and
  shows the current table with the bonus places marked (`meta/standings`, now with the club names).
- **Phone.** The first-visit box is one sentence (the three steps are for wider screens); an empty side
  panel is not drawn at all on a phone and shows no bell chart on a wide one; the stats strip loses its
  accuracy line so nothing overlaps.
- **Meg's order.** Your nickname (`profileSection`), then your numbers (`statsSection`), your playing style,
  the settings (`settingsSection`: hide from the boards, always fine-tune, the club you follow) and your data;
  one column at every width.
- **Club names.** Every document is read through `shortClubNames` (`predict-util.js`) with app.js's
  `SHORT_NAMES`, so a card, the recap, the table game and the pictures say HamKam and Odd, as the table does.
- **The round bar on a phone.** The division switch across the top; under it the round, with its dates
  and its deadline as a line under its name (`statusLine`, in place of the badge), and the progress ring.
  The recap's best and worst tips are scorelines on one grid (home | – | away), the dash in the same place
  on both lines; on a phone the label and the points stand over the match.
- **Your season (Meg).** A season picker (when you have played more than one), the accuracy through the
  season (`seasonChart`: your running accuracy and the model's over the same matches, one point a round,
  tap, drag or arrow keys to read a round), the best round, and in how many rounds you were ahead of the
  model. Its share icon draws the same as a picture (`sharePredictSeason`). Built from `stats/{uid}`
  only, so it costs no extra reads; badges are shown for the current season only.
- **The Overview's Predict card.** For a browser that holds a Predict session (Google or anonymous): its card
  when there is anything to show, else nothing, never the invite (a browser with a session is signed in). Short words throughout: room is short on a phone. Left: where the open round stands (`data-state` on
  `.overview-predict`): **empty** ("Runde 28: ikke tippet", the invite's accent border and glow from the top
  right, a "Tipp nå →" pill), **partial** ("Runde 28: 3 av 8 tippet", the glow fainter, a "Fullfør →" pill),
  each with the time left ("3 dager igjen", bold under a day); **done** ("Tipsene dine er inne": a check in a
  filled circle of the good colour, the card tinted from the left, "Runde 28: alle 8 tippet, 2 dager og 5
  timer igjen"); or **soon** ("Runde 29 åpner om 2 dager og 4 timer"). Spans are written out
  (`predictSpanLong`: "2 dager og 4 timer" under three days, else one unit, never "2 d"). The pill
  (`predictPill`) is the site's primary pill with an arrow icon, its words given 0.12em more room on top and
  the icon lifted 0.06em, so both sit on its middle in Archivo; on hover the arrow moves. Right: your place on
  the season board ("Tabellen": "12." "av 340 spillere", among people only, `humanRanks`; past the board's
  200 rows or with a hidden name, "Topp 35 %" from its percentile table, `beatShare`), a hairline, then the
  last scored round as points and accuracy % (from your stats document). With no round ahead (**calm**) the
  card is your season instead, across its width: "Sesongen din i Eliteserien 2026" over six figures with
  hairlines between (place, points, accuracy, rounds played, best round, rounds ahead of the model;
  `seasonSeries` and `seasonHighlights` from your stats), three a row under 900px. The done card's check is
  lifted 0.2rem: centred on its two lines it hung below the second one's baseline and read as low.
  **On a phone** (640px down) every card keeps to its essentials: no "Tipsene dine" caption; the pill stands
  beside the round's title and its time left; under a hairline, the season card's strip in small, two
  columns with a hairline between: your place ("12." over "av 340 spillere") and the last round's points
  ("+31.4" over "poeng i runde 27", the round in the label as the strip has no headings). The round's
  accuracy is left to the game (three columns wrapped their labels and ran "Topp 35 %" into the points at
  320px). The check is smaller; from 480px down the season keeps its first three figures in one row
  ("av 340" without "spillere"), each column as wide as its figure with the spare room shared evenly (equal
  thirds left the place a wide empty column and pressed the points against their hairline); from 380px down the invite's question is set narrower to keep to one line.
  At 390px the cards are 95 to 163px tall (the invite 252px).
  The whole card opens the game. `app.js` loads the game's first four scripts through the shared
  `predictScript` (once each, so opening the game later does not run them twice), reads `meta/rounds`,
  `stats/{uid}`, your entry for the next round and (with a scored round this season)
  `boards/season_{season}_{league}`, and keeps the answer for ten minutes in the tab's session storage under
  the player's id (saving a pick clears it). A browser without a session fetches nothing.
- **The Overview's Predict invite.** For a browser with no session at all (a signed-in browser is never
  shown it, whatever it has tipped). Built from the season report alone (`fillPredictInvite`; nothing is fetched): "Klarer du å slå
  modellen?" in display type, one line on the game ("Sett dine egne odds og bli målt mot modellen og alle
  andre."), a "Prøv nå →" pill with the round's matches and first day ("8 kamper
  fra lørdag 28. november"), or "Ta en titt →" and "Åpner lørdag 21. november" while the round is not open;
  on the right, the round's hardest match to call (`predictInviteRound`: the smallest top chance among the
  next full round's matches, a lone postponed match giving way) under "Runde 28: vanskeligst å tippe", with
  the model's odds bar and "Modellens odds. Hva tror du?". The division is the game's (`predict.league`),
  else Eliteserien, else OBOS-ligaen; between seasons there is no card. An accent border and a glow from the
  top right; it comes in once (no loop, none at all with reduced motion). On a phone it is one column (the
  match loses its box and its question; the question in narrower type from 380px down, so it keeps to one
  line). The × rests it for two weeks (`predict.invite.rest` in local storage).

