# Design plan: identity and feel

Started 2026-10-23. Eleven design ideas, each tested on its own and then kept
or dropped. The palette (dark navy, one electric blue) shipped just before this
plan and is not up for change here, except where item 11 asks a narrow question
about it.

## How we work through it

1. Take the next item in the order below. Every item is built on the one
   branch, `design/identity`, as its own commit(s) named "Design item N: …",
   so a dropped item is reverted by its commits. One PR for the whole branch
   gives a Firebase preview URL to try on a phone.
2. Screenshot before and after at desktop (1440 wide) and phone (390 wide), in
   light and dark, in Norwegian and English.
3. Run the checks every item must pass (below), then decide: keep, drop, or
   change and test again. Write the decision and a one-line reason under the
   item.
4. When every item is decided, its summary moves into `PROJECT_STATUS.md` and
   this file retires, as `IMPROVEMENTS.md` did.

**Checks for every item**
- `python -m pytest -q && node --test tests/frontend.test.js` pass.
- Text and data contrast stay at WCAG AA in both themes.
- Anything that moves is wrapped in `prefers-reduced-motion: no-preference`.
- No sideways scroll at 390 px; no layout shift on load (CLS under 0.1).
- Decimal point in both languages; every new string in `i18n.js` in both.
- Saturated colour on charts and tables still means data.
- Any new font, library or asset has its case written down (AGENTS.md).

**Status:** ☐ to do · ◐ testing · ✓ kept · ✗ dropped

| # | Item | Inspired by | Round | Status |
|---|---|---|---|---|
| 1 | Type at display scale | Lando Norris, Lusion | 1 | ◐ |
| 5 | Card typography and spacing | Field Rank | 1 | ◐ |
| 4 | One notation everywhere | Field Rank | 1 | ◐ |
| 3 | A mark and a motif | Lando Norris | 1 | ◐ |
| 12 | Overview page and a way into Explore | — | 2 | ◐ |
| 6 | Motion that explains | Lusion, Lando Norris | 3 | ☐ |
| 11 | Colour that changes as you scroll | Lando Norris | 3 | ☐ |
| 2 | Headlines written from the data | The Immortals, Lando Norris | 3 | ☐ |
| 8 | The season as an experience | Lusion, The Immortals | 4 | ☐ |
| 7 | Club colours on the club page | — | 4 | ☐ |
| 10 | A sign-off footer | Lando Norris | 5 | ☐ |
| 9 | Share cards per club | — | 5 | ☐ |

**Why this order.** Round 1 changes how the site looks at rest: type,
spacing and a mark. Everything later builds on it, and it is cheap to try.
Round 2 is the overview page: it fronts the numbers the later rounds will
dress up, and it builds on Round 1's type and cards as they are. Round 3 makes
it feel alive. Round 4 is the larger work (a story page, club colours), worth
doing once the base is settled. Round 5 is finishing.

**Not doing** (unless a test says otherwise): smooth-scroll or animation
libraries (Lenis, GSAP); scroll-jacking; a loading screen in front of the data
(Lusion's counter suits a showcase, not a page people open for the numbers);
WebGL on the main page.

**Parked: to bring back in some other way.**
- *The season sentence under the hero*: who leads on how many points, how
  many matches are left and how many times they are simulated, or "All 240
  matches played" for a finished season (keys `hero.lede.*` in git history).
  Taken out of the hero on 2026-10-23 so the hero is only the race. Could
  return as item 2's data-written headline, as a line in the rewind panel
  beside "Live — 184 matches played", or in the model card.

---

## Round 1: how it looks at rest

### 1. Type at display scale

**Seen.** Lando Norris sets the headline across the full width in capitals,
mixing a high-contrast serif (Brier) with a grotesk (Mona Sans), with the key
words in the accent: "REDEFINING limits, fighting for WINS". Lusion sets
"Bold Ideas, Brought to Lite" at about 140 px. EliteTracker's hero `h1` stops
at 2.5rem (`public/styles.css`, `.hero h1`), and Archivo at `wdth 125` / 800 is
made for much larger.

**To do**
- [x] Hero: one key number very large (`clamp(4rem, 12vw, 9rem)`), such as the
      leader's title chance `71.0 %`, with the sentence under it at its current
      size. Pick the number per league and state of the season.
- [x] Panel titles (`h2`) one step larger, with more space above.
- [x] Table figures at a narrower width (`wdth` 75 and 85, try both; 85 built): a
      scoreboard look, and more columns fit on a phone.
- [ ] Variant B, only if A is kept: a serif for one accent word per headline,
      as Lando does. Needs a second font file and its case (size, licence).
      Candidates to compare: Instrument Serif, Fraunces.

**Decide by.** Does the hero read in one glance on a phone? Do the narrower
figures stay readable at 13 px?

**Built.** The figure is the favourite's
title chance while the season runs, the champion's points once it is over,
with the club's crest and a caption under it; it shows only where the lede
does. Panel titles 1.25 → 1.5rem. Table figures at `wdth` 85.

**First review: "quite bad and cluttered".** The figure was added without
taking anything away. Now it replaces: the stats column beside the hero
(played, remaining, ratings from) is gone, and the sentence no longer repeats
the number ("Bodø/Glimt leder med 56 poeng. 56 kamper igjen, simulert 50 000
ganger."). Open: is the favourite's title chance the right figure at all?

**Second review: the picker was the clutter; show a race, not one club.**
The division and season pickers moved from the hero to the masthead's right
side (the hero keeps a visually hidden `h1`). The figure became a race: the
clubs still contending for one band (chance from 5 % to under 90 %, at most
four), each with its chance, side by side. Which race: the reader's own club's
first open band (chance between 10 % and 90 %), else the first open band down
the table, so a settled title hands over to the places below it. A finished
season shows its champion on points. "Your club" is a pill on each club page,
kept in `localStorage` on the device only.

**Third review: thresholds and clubs already through.** A race is open while
some club is between 10 % and 90 % (symmetric; 95 % was too kind). In a band
of several places, the clubs already through (90 % and up) stay in the race,
first and with a muted figure, so it shows how many places are left (7
December 2020: Molde 100, Vålerenga 96.9, then Rosenborg, Kristiansund and
Odd for the last Conference League place).

**The pickers in the masthead** are one pill like the view switch, its two
halves (division, season) each opening a list exactly as wide as itself,
the options' text in line with the half's. Tighter halves on a phone, so the
pill fits beside the wordmark and the settings button down to 360 px.

**The sentence under the race is gone** (parked, see "Parked" above). The
race now holds its height while the rewind scrubs, as the sentence did, so
the slider never moves under the thumb.

**The hero follows the view** (2026-10-24). Sluttabell keeps the race. Tabell
shows the climber and faller by rating over their last five matches, the
rating trend's window, so the hero and the table's arrows agree ("+15
rating, KFUM, 1568 → 1583"; until 2026-10-25 it was four weeks of the rating
history, and an earlier try measured expected final place instead). Kamper
shows the match of the week for the week on show, moving as you page. It is
chosen on the week's eve and kept while the week is played: from the
rewind's report for the evening before the week's first match, which the
week's results cannot change, so a result coming in neither drops the match
nor swaps it (until 2026-10-25 the pick was redone over the fixtures left on
every refresh). The fixture score, each measure 0 to 1: 0.5 decisive (per
club, the swing of its band's chance between winning and losing from
`next_stakes` / `high_stakes`, weighed by how high the band sits, the title
whole and the bottom place half, the two clubs added, 0.8 counting as all),
0.3 even (1 − |home − away|) and 0.2 expected goals (two none, four all). It
shows home / draw / away and the stake ("Lillestrøm · ECL: 37.5 % med seier,
12.6 % med tap"), then, once played, its result. A week played in full turns
to its best result: 0.3 decisive (as for a fixture, on the eve), 0.2 tight
(goals and xG alike: a draw whole, three goals or 1.5 xG apart none), 0.25
shock (its own pre-match chance from 40 % down to 10 %, or a margin the
scoreline grid gave little chance, −log10 over 2.5, whichever is more), 0.1
chances (two to five xG) and 0.15 goals (six all). Week 33 of 2026 is the
case it was tuned on: on its eve Rosenborg–Viking (a title chaser against a
Europe chaser, the most decisive even match); played, Aalesund 5–5
Vålerenga (6.1 xG) over Rosenborg 2–1 Viking (2.9 xG, the expected
winner's 36 %). It shows the score, each side's chance before the match and
the stake that moved furthest, as the eve's report conditioned it. All fall back to the race. On a phone three figures stand
in one row; under 400 px the masthead shows the mark without the name, so
the division pill and settings fit.

**Variant B deferred (2026-11-21).** It depends on variant A being kept, which
has no decision yet, and it needs a second font with its case.

**Decision:**

### 5. Card typography and spacing

**Seen (Field Rank).** Each card has a header row with the title on the left
and "Full standings →" on the right, a hairline under it, and about 20 px of
padding inside. Column heads are small, uppercase, widely spaced and in a
monospace face, in faint ink. Rows are about 52 px tall with hairline
dividers. Metadata (race, date, rank moves) is monospace; names are the sans.
The three explainer cards are numbered `01 02 03`, each on a different
surface. It is calm because there are only two text sizes per card and the
spacing repeats exactly.

**To do**
- [x] A spacing scale as tokens (4, 8, 12, 16, 20, 24, 32) and use it inside
      panels, so padding and row heights repeat exactly.
- [x] ~~A monospace for metadata and column heads.~~ Tried and taken out (see below). Try the system stack
      (`ui-monospace, "Cascadia Mono", Menlo, monospace`) first, since it needs
      no download; if it looks too different across systems, compare
      self-hosting Geist Mono (OFL), with its case.
- [ ] Panel heads: a "→" link on the right where the panel leads somewhere
      (the table to a club, matches to all fixtures).
- [x] The model card's explanation as numbered `01 02 03` cards.
- [ ] Variant B: one view (the table) with no box, only hairline rules and the
      grid, to see whether a more editorial page suits the site better than
      cards.

**Decide by.** Put a Field Rank card and the reworked table side by side at
the same width: is ours as calm?

**Built.** Spacing tokens `--space-1..7`, used for the panel head padding and
the table's row padding (rows about 36 → 41 px). The model card's "how it
works" is three numbered steps, Rating / Goals / Simulation, in both
languages. Not yet: the "→" panel links (few panels lead anywhere further)
and variant B.

**First review: "quite bad and cluttered".** The monospace on every label
was a third type voice on panels already dense with data; Field Rank can
carry one because its cards hold little. Taken out again (labels back in
Archivo). The model card's steps lost their boxes (boxes in a box in a
panel) and are plain columns. The spacing stays.

**Built (2026-11-21).** The "→" panel links, with the overview: each block
there leads on with the club page's quiet link style ("Alle kamper →",
"Hele tabellen →", "Kappløpene →", "Alle verktøy →"), and Sluttabell and
Stige gained links into the Explore tools. Variant B (a table with no box)
is **deferred**: it is a comparison prototype that restyles Tabell, and
nothing has been decided about the cards it would replace.

**Decision:**

### 4. One notation everywhere

**Seen (Field Rank).** `#23 → #2` in monospace, coloured green for a rise,
appears in every list. One small convention, repeated, becomes part of the
brand.

**To do**
- [ ] Define the notation: rank `#3`; a move `#5 → #2` in the monospace from
      item 5, coloured by direction with the outcome colours; probability
      `71.0 %` with a thin bar under it; rating with a ▲/▼ change.
- [ ] Find every place a rank, rank change, probability or rating change is
      shown (table, ladder, team, matches, explore) and apply it.
- [ ] Once kept, write the notation into `docs/frontend.md`.

**Decide by.** Does the same fact look the same in every view?

**Built (2026-11-21).** `rankText` and `changeText` (`app.js`, by
`ordinalShort`), written out in `docs/frontend.md`. A rank standing alone is
`#3` in English and `3.` in Norwegian (changed 2026-11-21 from `#3` in both,
on review of the share pictures): the club page's rating rank ("1. av 32 på
rating"), the ladder's tooltip, the club's season rows,
its place tile and its expected place. A change is an arrow and its size,
▲ up and ▼ down, no sign: the played results' rating change, the club
page's match rows, the finish-grid popup's place move, the race lines'
change chip and the overview's movers. Two departures from the spec, with
reasons: no monospace (item 5's review took it out; the figures keep
Archivo with tabular numbers), and the thin bar under a probability only
where the figure stands alone (the overview's race cards), not in the
table, the grid or the odds bars, which already show the value. The
table's five-step rating trend arrows are a trend, not a change figure, and
stay. A rank inside a sentence ("3rd place") stays an ordinal.

**Decision:**

### 3. A mark and a motif

**Seen (Lando Norris).** A small "LN" monogram sits at the top centre and
returns in the content and loader. Faint topographic contour lines cover the
whole page as texture and change colour with each section; they come from his
helmet design, so the texture means something.

**To do**
- [x] A mark drawn from the finish grid: a small grid of cells with one in
      electric blue. SVG, so it works from 16 px up.
- [x] Use it everywhere: favicon, `public/icons/`, the manifest, `og.png`, and
      beside the wordmark.
- [x] A motif: contour lines. Norway is mountains, and the site already has a
      season mountain (`vendor/three/`, the season mountain view). Generate a
      contour SVG from that mountain's height field and lay it very faintly
      behind the hero and section starts, never behind data.

**Decide by.** Is the mark recognisable at 16 px in a browser tab? Is the
contour texture felt rather than seen, in both themes?

**Built.** The mark is a 3 × 3 corner of the finish grid: the diagonal
(each club's likeliest place) bright, its neighbours at 35 %, the far corners
at 10 %, and the top left, the title, in the electric blue
(`public/icons/mark.svg`). It sits before the wordmark and is the favicon on
every page; `tools/brand/render.mjs` draws the PNG icons and a new `og.png`
from it with the installed Chrome (the old `og.png` was a screenshot from
elo-v12). The motif is the season mountain's contour map, drawn per season. The
mountain stacks a block for every snapshot in which a club still had a
chance (0.5 % or more, its default cut) of a place, places across and clubs
deep in finishing order, so its height field is square: per club and place,
how many snapshots kept the place open. `renderBackdrop` (app.js) draws it
in the browser from the report in view, so every season and division has its
own and the live season stays current without a build step. It is shown
once at the top of the page and scrolls with it: as wide as the page and at
least as tall as the screen, centred, fading out towards its foot (repeating
it down the page, every other copy flipped, was tried and dropped; covering
the whole page made it jump between views of different lengths). Its lines
are Catmull-Rom curves through thinned points, smooth at any size; faint
(`--backdrop-alpha`, 5.5 % light, 8 % dark), and shows only around the
opaque panels. `tools/brand/contours.py` draws the same map for 2025 as a
fixed `contours.svg`, for the share image and the 404 page, which have no
season of their own. (The first try, behind the hero only, drew how settled
each place was over time from 2025 alone.)

**Decision:**

---

## Round 2: an overview page, and a way into Explore

Planned 2026-11-21 from a walk through every page (desktop, and 390 px in a
frame). Nothing here is built. **Published numbers: none change** (every figure
is already in the report), so there is no `MODEL_VERSION` bump.

### What the walk found

- The first thing a visitor meets is the finish grid (Sluttabell). It is the
  densest view; the answer to "what is going on in the league" is spread over
  the hero, Tabell, Kamper and Utforsk.
- The hero changes with the view (`renderRace`: Tabell shows `heroMovers`,
  Kamper `heroMatch`, the rest `heroRaceModel`). So no single place shows the
  race, the week and the movers together.
- Explore is the seventh of seven tabs and, on a phone, inside **Mer**. Its six
  tools (Sesongfjellet, Angrep mot forsvar, Flakstabellen, Kappløpene, Hva om,
  Restprogrammet) are reached only through its own gallery, whose thumbnails
  are large (two per row, about 250 px tall) and carry no number.
- Other views link into Explore in two places only: Tabell ("Flakstabellen →",
  "Restprogrammet →") and Kamper ("Endre resultater i Hva om →").

### The page: Oversikt (`?view=overview`)

Built only from builders that exist, so it adds composition, not logic.

| # | Section | Reuses | Notes |
|---|---|---|---|
| 1 | The race | `heroRace` / `heroRaceModel` | Already null-safe (settled or finished season). |
| 2 | Three race cards: title, Europe, relegation | `league.bands`, `bandChance` | Clubs at 5 % or more, most likely first. Bands come from the league, so OBOS-ligaen's play-off bands work without a special case. |
| 3 | This round's key matches (2-3) | `pickFixture`, `buildFixtureCard`, `stakes` | Link "Alle kamper →". Hidden when no round is left (archived or finished season). |
| 4 | Risers and fallers | `heroMovers` | Needs `state.careers`; hidden until loaded, as in Tabell. |
| 5 | Utforsk strip | `exploreThumb`, `explore.<id>.title/desc` | Six compact cards (three per row on desktop, a horizontal row on a phone), each opening its tool directly through `openExplore`. |

**Change since last round** (on the race cards) and **a live number on each
Explore card** are phase 3: the first needs the history reports
(`mountainLayers`, async, already cached for Kappløpene), the second needs the
explore renderers' facts split from their drawing. Neither is free, so neither
blocks phases 1-2.

### Making Explore reachable (the other half)

1. The Utforsk strip on Oversikt (above).
2. Contextual links, in the pattern Tabell and Kamper already use: Sluttabell
   -> Sesongfjellet and Kappløpene; Stige -> Angrep mot forsvar; Klubb ->
   Angrep mot forsvar. Small, `public/` only.
3. Smaller gallery thumbnails in Explore itself (grid, not the 16:9 shape:
   `.explore-morph` depends on the aspect ratio for the open animation).

### Navigation

- Desktop: Oversikt first in the strip; check the **Mer** overflow still
  collapses cleanly with eight tabs.
- Phone: four view slots plus **Mer**; Oversikt takes one, so **Stige** moves
  into the sheet (the thinnest page in the walk).

### States to design for, and test

Pre-season (nothing played: no movers, no key matches, race from the prior);
archived season (no next round: section 3 hidden, race null, champion told);
finished season; OBOS-ligaen (different bands, play-off); Norwegian and
English; light and dark; 390 px with no sideways scroll.

### Places to touch

`activeView` default and `validViews` (`app.js` near 9559); the URL builder by
`EXPLORE_SLUGS` (near 680); `index.html` (strip, mobile bar, sheet, popover);
both languages in `i18n.js`; `pages.py`, the sitemap and `tests/test_pages.py`
(route mirrors); `tests/frontend.test.js`. No new dependency.

### Phases

1. **The view, at its own route, in the nav; `/` still opens Sluttabell.**
   Reversible, sections 1-5, the contextual links.
2. **Oversikt becomes the landing page**; Sluttabell gets its own path. Titles,
   og tags, canonical and the sitemap change, and so does what every search
   result lands on.
3. Change since last round on the race cards; a live number per Explore card.

**Built (2026-11-21), phases 1 and 2.** `?view=overview`, the first tab and
the default view, so `/` and `/obos-ligaen/` open it (the route pages carry no
view, so `pages.py` is unchanged; Sluttabell is `?view=grid`). The hero above
it is section 1; below it come the other open races (one card per band from
`league.bands`, between `RACE_OPEN` and `RACE_SETTLED`, without the band the
hero shows, at most four, a thin bar under each chance), the three matches
most worth watching in the next round (`scoreFixtures`, the score the match
of the week is chosen with), the climber and faller, and the six Explore
tools as thumbnails (three across; the gallery itself is now three across
too, two under 1000 px). Blocks with nothing to show are left out, so a
finished season (checked on 2025 and on OBOS-ligaen 2026) shows the champion,
the movers and the tools. On the phone bar Oversikt replaces Stige, which
moved into the sheet; on a desktop Utforsk moved ahead of Stige so it stays
in the strip when the masthead has room for six tabs. Contextual links:
Sluttabell to the season mountain and race lines, Stige to attack against
defence. Checked in Chrome: the live season in Norwegian dark and English light at
about 1520 px wide, Norwegian dark at 390 px (a frame; no sideways scroll),
the finished 2025 season, OBOS-ligaen (as `/obos-ligaen/` and by query) and
the pre-season (rewound to 13 March 2026: five clubs in the race, four race
cards, the round's matches, no movers). Not checked: English at 390 px, light
at 390 px, and 1440 exactly.

**Revised after review (2026-11-21).** The page has no title and no heading
over each kind of block; it covers both divisions (a small division name over
each group, the hero hidden here, the division picker with it). Each division
has one card per open race in the band's own colour (relegation red, the
Champions League blue), and the play-off is not a card of its own: the
relegation card's chance already includes it (`bandChance`), as does the
promotion card's in OBOS-ligaen. A finished division shows its champion. Two
matches per division, then the movers, then links to that division's table and
matches; the Explore tools close the page.

**Second revision (2026-11-21), after looking at eloserien.samsonsen.org's
overview, and a third after the owner said the second was a copy of it.** The
idea taken from it is only that an overview opens each division with its
headline figures and the round's key match; everything is drawn in
EliteTracker's own voice. Each division has the hero's display figures in
miniature (the title race, the round's key match as home, draw and away),
shared with the page's hero through `raceList`; a card in the band's own colour
for each other open race (relegation, with its play-off, in red); the clubs on
the move as chips, and for a finished division who went up and down; divisions
told apart by a hairline and the ladder's identity hue, not by boxes. Dropped
as too close to the reference: the split title bar and its sentence, the key
match as a card with an odds bar, the highest-rating list and the biggest-change
card. Every block is one button (a race block opens the race lines on that race,
the match block opens Kamper, the champion block the final table), and a club
in it opens the club.

**Fourth revision (2026-11-21), after the owner was not happy with the third.**
A second look at eloserien.samsonsen.org, for principles rather than layout.
*Worth taking:* each block answers a plain question; a sentence under the
numbers says why they are what they are (the gap, what a match moves); a
finished division takes one labelled line, not a block; every group of chips
has a label. *Not worth taking:* the boxed sub-cards inside one panel, the
highest-rating list (little information), the underlined text links, and the
long About text. *What the third revision got wrong:* the key match as three
equal display figures with decimals (no favourite stands out, and the stake
note read as jargon); a finished division headed by its points total, not its
champion; chips with no label, and in "+40 rating" against the site's own ▲ ▼
notation; the Explore thumbnails took half the page and said nothing. *Built:*
each division opens with a sentence (`overviewLede`); every race, the title
included, is a corner of the finish grid (the places it is decided in, the
grid's cells and band strip, the band's chance at the end), a view the
reference has no counterpart for and the site's signature; the key match is
Kamper's own row with its biggest stake as a sentence; chips are grouped under
labels (rating over the last five matches, promoted, relegated, play-off still
on with its chance); the Explore tools are a compact list with each tool's
description. Checked in Chrome: live season (Norwegian dark, English light),
390 px frame (no sideways scroll), the finished 2025 season, the pre-season
(13 March 2026: four races, two by two).

**Fifth revision (2026-11-21): glanceable.** The owner found the fourth
cluttered, wanted bars on the race cards, and found OBOS-ligaen's section very
bad. The finish-grid corners were too dense to read at a glance and are gone.
Each race card is now a club per row with its chance large (display type) and
a thick bar in the band's colour, four clubs at most, no caption beyond
"play-off included"; a two-club race (most often the title) takes display
size. The key match lost Kamper's row (ratings, scorelines, modifiers, dots):
the two clubs over one odds bar and its stake in one sentence, with the movers
as a small card beside it (▲ ▼, rating before and after). A finished division
is the champion's sentence and a promotion and a relegation card: the clubs
already up or down in words with no bar, a hairline, then the clubs still in a
play-off with their chance and bar; the chips are gone. Checked: live season
(desktop, 390 px frame, no sideways scroll), finished 2025, the pre-season in
light.

Then, on the owner's word, the title race was raised to a row of its own,
with a bar like the reference's: each contender's chance in display type (the
first at the left, the last at the right) over one bar split between them in
proportion. Not the reference's gold-and-silver: a second colour reads as
"second place", which breaks with three contenders. A darker gold for the
rest was tried and dropped on the owner's word (it reads as a lesser prize),
and so was one gold for every segment (the favourite's share no longer stood
out at a glance). Settled: the favourite's share in the title gold, the rest of
the field in one dim slate (no medal colour), told apart by the gaps and by
their order (the clubs' own, left to right); what the shown clubs leave over is
the bare track. Up to five contenders (the
pre-season has five); on a phone three to a row.

The sentence that opened each division was removed on the owner's word: the
division now opens on the title race. A finished division, whose champion
only the sentence named, gets a champion card in that row instead: the club in
display type, its points and margin over second in small type.

The Tabell and Kamper buttons in each division's heading did not fit there and
were too easy to miss (owner). They are now two tiles across the width at the
end of the division: the name in the accent colour with a fact from behind it
(who tops the table and on how many points, or "the final table"; how many
matches are left, or that all are played) and an arrow that moves on hover.
The heading keeps only the name and the round.

A finished division also shows its final table's top four (owner), as the
first card in the row with promotion and relegation: place (marked in its
band's colour, as the table marks it), club and points; it opens the table.

**Review round (2026-11-21), owner's answers to eight suggestions.**
1. *Change since the last round*, built: every live chance shows its move
   against the report of the last matchday before the latest round's first
   match, in the table's rating arrows (`trendArrowSVG`, upright past 10
   percentage points) and the good or bad tone for the club (a relegation
   chance that falls is good); the movers card takes the same arrows. The
   phase 3 item deferred above is done: the earlier report is one cached fetch.
2. *Settled clubs* stay where they are; the site's one "as good as certain"
   threshold (`RACE_SETTLED`, the heroes' races and the overview) is now 95 %,
   not 90 % (the 10 %-90 % wording above predates it).
3. *Champion*: one enlarged card, the club and its points in display type,
   places 2-4 smaller under it; the separate top-four card is gone.
4. *Kamper tile*: when the next round starts and how many matches it has.
5. *Top padding*: kept; on a phone it is already 16 px.
6. *Match of the week*: the one Kamper's hero shows (`weekMatch`, now shared
   by both), with a stake line for each club before it and each side's chance
   before it under the score after.
7. *Movers*: "Climber" and "Faller" labels, the table's arrows and colours, the
   rating before and after.
8. *Explore*: one large button naming the six tools (later: on a phone only,
   with the first four thumbnails; the tool list as before on wider screens).

**Every width, every point of a season (2026-11-21).** Swept in Chrome at 22
widths (320-1600px, both sides of each breakpoint) through ten states
(pre-season, round one, April, May, July, September, 1 November with
OBOS-ligaen live, its last day, today, the finished 2025 season), Norwegian
and English, checking for sideways scroll, content outside its card,
overlapping figures and cut-off names, then by eye. Fixed: three or more title
contenders now wrap in columns with the change under the figure (they ran out
of their columns at 761px and on phones); the narrowest phones (380px and
under) get two contenders a row, stacked tiles, a smaller champion and the
Explore thumbnails over their text; the match of the week's names wrap on a
phone; three race cards where two fit give the third the whole row, and the
champion's places 2-4 go one column unless three fit (container queries); the
movers caption is "Siste fem kamper" (the rows already say "Rating").

**Deferred, with reasons.**
- *Change since last round on the race cards* (phase 3): it needs the history
  reports (`mountainLayers`, async) moved into a shared function; a later job.
- *A live number on each Explore card* (phase 3): it means separating six
  renderers' facts from their drawing code.
- *A link from the club page to attack against defence*: the club view has no
  panel head to hang it on yet.
- With eight tabs the masthead has room for six on a typical desktop:
  Sammenlign and Modell sit under **Mer** (Utforsk was moved up so it stays).
- The route pages under `public/klubb/`, `utforsk/` and `obos-ligaen/` are
  build output (git-ignored); old local copies lack the overview, so run
  `build_site` (or `pages.build_pages`) after pulling. The overview's render
  returns quietly where its block is missing.

Phase 2 was built on the go-ahead to implement Rounds 1 and 2; to put
Sluttabell back as the landing page is one line (`activeView` in the state).

**Decision:**

**Decision:**

---

## Round 3: alive

### 6. Motion that explains

**Seen.** Lusion's paragraph text fills in word by word as you scroll, and a
headline swaps letters as it settles. Lando's signature draws itself as you
scroll to it, and the photos move at different speeds. Both show a thin
scroll-progress bar on the right.

**To do** (no library: browser features only)
- [ ] The View Transitions API for switching tabs, and for a table row
      growing into the club page.
- [x] Explore: a visualisation grows out of its card's thumbnail and shrinks
      back into it (a shared view-transition name). The mountain grows to
      fill the window; the attack map and the luck table, which run long,
      only to the panel's width in the thumbnail's own 16:9 shape, the view
      fading in beneath. Done early, 2026-10-24.
- [x] On a phone, views in the More sheet rise from below (the page sinks
      on the way back), since they are not beside the bar's tabs. Done
      early, 2026-10-24.
- [ ] Scroll-driven CSS (`animation-timeline: view()`) to bring in panels and
      the finish grid row by row. Detect support; browsers without it simply
      show everything.
- [ ] Numbers count to their new value on first load and when the rewind
      moves.
- [ ] Lines draw themselves: a club's rating history in the club and compare
      views draws in when it scrolls into view (Lando's signature, as data).
- [ ] Word-by-word fill on the model card's explanation (Lusion).
- [ ] The backdrop moves: the season mountain's contours (item 3) could grow
      round by round as the rewind plays or a season loads, the way the
      mountain builds up in Explore, or drift slowly. `renderBackdrop` already
      redraws for each date the rewind picks.

**Decide by.** Profile on a phone (CPU slowed 4×): no stutter when scrolling
the table, no layout shift. Every motion must say something (what changed,
where you went); drop any that only decorates.

**Decision:**

### 11. Colour that changes as you scroll

**Seen (Lando Norris).** The page background moves from cream to dark olive to
grey-green and back as sections pass, with one loud lime accent throughout.
It makes a long page feel like several rooms.

**To do**
- [ ] Try one section of the page on a different surface: for example the
      model card on the light paper while the rest is dark, or the hero number
      on a full-width electric-blue band.
- [ ] Animate the change between surfaces with the scroll, not as a hard edge.
- [ ] Write down the exception if kept: today the accent is for interface
      only, and a full-width blue band would break that rule.

**Decide by.** Does the change of room help you know where you are, or only
distract? Do the data colours still work on the new surface?

**Decision:**

### 2. Headlines written from the data

**Seen.** The Immortals titles each World Cup as a story ("Against All
Odds", "The Finest Margins") instead of "1994". Lando's headline is a
statement, not a label. EliteTracker's hero says "Where everyone finishes",
which never changes.

**To do**
- [ ] A list of headline rules, in priority order, read from the report the
      page already has: title decided (above 95 %), two-horse race, a
      three-way relegation fight, the biggest change in title chance this week,
      a promoted club above its expected place.
- [ ] Each rule an `i18n.js` key with variables, in both languages. The
      current title stays as the fallback.
- [ ] Works with the rewind: the headline is the one for the chosen day.

**Decide by.** Read the headline for every matchday of three past seasons
(using the rewind) in both languages: does it ever say something wrong or odd?

**Decision:**

---

## Round 4: the bigger pieces

### 8. The season as an experience

**Seen (Lusion).** The site is one continuous journey: an opening 3D scene,
"Scroll to explore", then chapter after chapter. The Immortals does the same
for an archive: one chapter per tournament.

**To do**
- [ ] A separate story page, so the main page stays fast. One chapter per
      turning point in the season, found from the rewind data (the largest
      swings in title or relegation chance, the decisive matches).
- [ ] Each chapter: a data-written headline (item 2), the date, and the finish
      grid as it stood that day.
- [ ] The season mountain as the opening scene, loaded only on this page.
- [ ] A progress bar with a tick for each chapter.
- [ ] A link to it from the hero and from each past season.

**Decide by.** Does it tell the 2025 season in a way you'd want to share? Is
it still usable on a phone?

**Decision:**

### 7. Club colours on the club page

**To do**
- [ ] A table of each club's colours (main and second), for every club in
      both divisions since 2015.
- [ ] Use them only on the club page's header strip or hero wash, never in a
      chart or table.
- [ ] A contrast check over every club in both themes.

**Decide by.** Do the club pages feel like the club's own, without the data
colours losing their meaning?

**Decision:**

---

## Round 5: finishing

### 10. A sign-off footer

**Seen (Lando Norris).** The page ends with very large words ("ON TRACK / OFF
TRACK"), so you know you've reached the end.

**To do**
- [ ] A large wordmark with the mark (item 3), the seasons covered, the model
      version, the links already in the footer.

**Decision:**

### 9. Share cards per club

**To do**
- [ ] Decide how to draw them. Social sites need a PNG, not SVG: either
      Pillow in `build_site.py` (a new dependency, needs its case) or
      screenshotting an HTML template with headless Chrome at build time
      (check that CI has Chrome).
- [ ] Crawlers don't run JavaScript, so each club needs its own small HTML
      file carrying its `og:image`; `build_site.py` would write them.
- [ ] Card content: the mark, the club, one number ("Rosenborg: 12 % chance
      of Europe"), the date.

**Decide by.** Paste a link into a chat app and see the card.

**Decision:**
