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
| 4 | One notation everywhere | Field Rank | 1 | ☐ |
| 3 | A mark and a motif | Lando Norris | 1 | ☐ |
| 6 | Motion that explains | Lusion, Lando Norris | 2 | ☐ |
| 11 | Colour that changes as you scroll | Lando Norris | 2 | ☐ |
| 2 | Headlines written from the data | The Immortals, Lando Norris | 2 | ☐ |
| 8 | The season as an experience | Lusion, The Immortals | 3 | ☐ |
| 7 | Club colours on the club page | — | 3 | ☐ |
| 10 | A sign-off footer | Lando Norris | 4 | ☐ |
| 9 | Share cards per club | — | 4 | ☐ |

**Why this order.** Round 1 changes how the site looks at rest: type,
spacing and a mark. Everything later builds on it, and it is cheap to try.
Round 2 makes it feel alive. Round 3 is the larger work (a story page, club
colours), worth doing once the base is settled. Round 4 is finishing.

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

**Decision:**

### 3. A mark and a motif

**Seen (Lando Norris).** A small "LN" monogram sits at the top centre and
returns in the content and loader. Faint topographic contour lines cover the
whole page as texture and change colour with each section; they come from his
helmet design, so the texture means something.

**To do**
- [ ] A mark drawn from the finish grid: a small grid of cells with one in
      electric blue. SVG, so it works from 16 px up.
- [ ] Use it everywhere: favicon, `public/icons/`, the manifest, `og.png`, and
      beside the wordmark.
- [ ] A motif: contour lines. Norway is mountains, and the site already has a
      season mountain (`vendor/three/`, the season mountain view). Generate a
      contour SVG from that mountain's height field and lay it very faintly
      behind the hero and section starts, never behind data.

**Decide by.** Is the mark recognisable at 16 px in a browser tab? Is the
contour texture felt rather than seen, in both themes?

**Decision:**

---

## Round 2: alive

### 6. Motion that explains

**Seen.** Lusion's paragraph text fills in word by word as you scroll, and a
headline swaps letters as it settles. Lando's signature draws itself as you
scroll to it, and the photos move at different speeds. Both show a thin
scroll-progress bar on the right.

**To do** (no library: browser features only)
- [ ] The View Transitions API for switching tabs, and for a table row
      growing into the club page.
- [ ] Scroll-driven CSS (`animation-timeline: view()`) to bring in panels and
      the finish grid row by row. Detect support; browsers without it simply
      show everything.
- [ ] Numbers count to their new value on first load and when the rewind
      moves.
- [ ] Lines draw themselves: a club's rating history in the club and compare
      views draws in when it scrolls into view (Lando's signature, as data).
- [ ] Word-by-word fill on the model card's explanation (Lusion).

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

## Round 3: the bigger pieces

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

## Round 4: finishing

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
