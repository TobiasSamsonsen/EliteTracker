# UI/UX audit — EliteTracker

Audited 2026-09-25 on the static build (`public/`), desktop (1920px) and phone
widths (390px, 320px), in both themes and both languages.

## Method

Findings are measured, not eyeballed. Each one names the standard it breaks:

- **WCAG 2.2 AA** (W3C): text contrast 4.5:1 (3:1 for large text), non-text
  contrast 3:1 (1.4.11), reflow at 320px (1.4.10), bypass blocks (2.4.1), focus
  order (2.4.3), label in name (2.5.3), target size 24×24px minimum (2.5.8),
  name/role/value (4.1.2).
- **Nielsen's 10 usability heuristics** (NN/g): mainly #1 visibility of system
  status, #4 consistency and standards, #6 recognition rather than recall.
- **WAI-ARIA Authoring Practices**: menu, dialog and slider patterns.
- **Platform touch guidance** (Apple HIG 44pt, Material 48dp) for phone targets.

Tools used:
- a contrast script over the CSS colour tokens (WCAG relative luminance);
- an in-page script that lists every visible text node's contrast, interactive
  elements without an accessible name, targets under 24px, landmarks and
  headings;
- a sweep of the Norwegian UI for untranslated English;
- a 320px reflow check.

Checks that passed are listed at the end.

Status legend: **[x] resolved** · **[ ] open**

---

## Research basis — the principles this audit checks against

Each principle below comes from a published source. Each says how it was
checked on this site and which findings it produced. A principle with no
findings was checked and passed.

### 1. Accessibility: WCAG 2.2 AA
[W3C WCAG 2.2](https://www.w3.org/TR/WCAG22/) is the current recommendation.
It adds nine criteria to 2.1 ([summary](https://www.wcag22aa.org/new-criteria/)).
The ones that apply to a read-only data site are listed here.

| Criterion | What it asks | How it was checked | Result |
|---|---|---|---|
| 1.4.3 / 1.4.11 Contrast | 4.5:1 text, 3:1 UI | per-element sweep, both themes | C3, C4, H6, H9–H11 |
| 1.4.1 Use of colour | meaning not by colour alone | trend arrows, forced-dark test | H2, S1 |
| 1.4.10 Reflow | no 2-D scroll at 320px | 320/360/390 frames | R4, R5, S6 |
| 2.1.1 Keyboard | everything operable by keys | click handlers on non-controls | S2 |
| 2.4.1 Bypass blocks | skip the navigation | Tab order | H1 |
| 2.4.3 Focus order | modal takes focus | phone sheet | C5 |
| **2.4.11 Focus not obscured** (new) | sticky UI must not hide focus | sticky masthead, bottom bar | T1 |
| **2.5.7 Dragging movements** (new) | a non-drag alternative | the rewind slider has step buttons and arrow keys | passes |
| **2.5.8 Target size** (new) | 24×24px minimum | target sweep | N4 |
| 2.5.3 Label in name | visible text = accessible name | the heading switcher | C1 |
| 4.1.2 / 4.1.3 Name, role, value; status | state and busy announced | slider, rewind, season load | H4, T2 |
| 3.2.6 Consistent help (new) | help in one place | no help mechanism on the site | n/a |

### 2. Usability heuristics: Nielsen's ten (NN/g)
- **#1 Visibility of system status:** the grid readout (R1), loading and
  busy states (T2), and the Ladder error (C6).
- **#4 Consistency and standards:** translations (H5, S3, S4, S11), button
  styles (R6), one colour meaning per colour (R7), and number precision
  (S10).
- **#6 Recognition rather than recall:** the switcher affordance (H8), names
  beside crests (R2, S6), and the "Nå" label (S8).

### 3. The laws of UX
Jakob's, Hick's and Fitts's laws and the Doherty threshold
([overview](https://www.uxdesigninstitute.com/blog/laws-of-ux/)).
- **Jakob's law** (users expect what other sites do): Norwegian standings use
  K V U T + − MF P, as every Norwegian table does (S3). Numbers follow the
  local convention (S5).
- **Hick's law** (more choices, slower decisions): seven views on desktop;
  on phones four in the bar and three under "More". Checked, no change.
- **Fitts's law** (big, near targets are faster): touch targets are 44–52px
  on phones. The season rows' target is the whole year cell (S2).
- **Doherty threshold** (answer within 400ms): report fetches over that
  budget now show a busy state at once (T2). The rewind already dims within
  a frame.

### 4. Data visualisation: Tufte, Few, Heckbert
- **Data-ink ratio** (Tufte; Few's "data-pixel" version,
  [Few, dashboard design](https://www.perceptualedge.com/files/Dashboard_Design_Course.pdf)):
  - The grid leaves near-zero cells empty rather than printing "0".
  - Rules are hairlines.
  - The Model card lost a solid block that carried no data (S12).
- **Preattentive attributes** (colour, position): one sequential ramp for
  probability, and band colours reserved for league zones. S1 protects that
  encoding from forced-dark extensions.
- **Alignment for comparison:** Few's "support meaningful comparisons". The
  grid's position column now aligns (S8).
- **Nice numbers** (Heckbert, *Graphics Gems*, 1990): axis ticks on round
  steps (S9).

### 5. Loading and feedback patterns (NN/g)
[NN/g: Skeleton screens 101](https://www.nngroup.com/articles/skeleton-screens/):
- Under about a second, a subtle busy state beats a spinner.
- Over that, show progress.

Report loads here are usually under a second, so the page dims its content
and sets `aria-busy` (T2). The one long wait, the animation prefetch, gets
a labelled overlay.

### 6. Localisation and typography
- Norwegian number conventions:
  [SNL: tusenskille](https://snl.no/tusenskille),
  [Korrekturavdelingen: prosent](https://www.korrekturavdelingen.no/promille-prosent.htm)
  (S5).
- `lang="nb"` for hyphenation and the screen-reader voice (N3).
- An 11pt/sp floor for text, from Apple HIG and Material (S7).

### 7. Platform integration
- **Forced-dark extensions:** Dark Reader's documented opt-out
  ([CONTRIBUTING.md](https://github.com/darkreader/darkreader/blob/main/CONTRIBUTING.md))
  (S1).
- **Theme colour:** `theme-color` per scheme (N2).
- **Colour scheme:** `color-scheme` declared (S1).

---

## Critical — blocks or misleads users of assistive technology, or breaks WCAG AA in the core flow

- [x] **C1. The page heading is unreadable to screen readers.**
  `renderHero` put `aria-label="Change division"` / `"Change season"` on the two
  spans that make up the `<h1>`. An `aria-label` replaces the visible text, so
  the heading was read as "Change division Change season" and never named the
  league or year (WCAG 2.5.3 Label in Name, 1.3.1). The labels were also
  English-only.
  *Fix:* the visible text is the name again. `aria-haspopup` / `aria-expanded`
  say they open a menu, and a translated visually-hidden hint says what the
  menu changes.

- [x] **C2. Invisible controls in the tab order.** The hidden state holders (league
  switch, season `<select>`) sit in an `aria-hidden="true"` block but were
  still focusable. Keyboard users tabbed onto controls they could not see, and
  that screen readers had been told do not exist (WCAG 2.4.3, 4.1.2; ARIA:
  no focusable content inside `aria-hidden`).
  *Fix:* the block is `inert`.

- [x] **C3. Secondary text fails contrast in both themes.** `--ink-faint`, used for
  labels, column heads, hero stats, grid positions and the footer, measured
  2.61–3.07:1 in light and 3.58–3.94:1 in dark, against a 4.5:1 minimum
  (WCAG 1.4.3).
  *Fix:* retuned to ≥ 4.5:1 on every surface: light #647782, dark #7f939e.

- [x] **C4. Coloured text fails contrast in the light theme.**
  - The zone-divider labels are written in the band colour: title yellow
    1.82:1, CL blue 4.42:1, relegation red 3.95:1.
  - The outcome blue/red used for rating deltas and trend arrows measured
    3.36–4.42:1 (WCAG 1.4.3).

  *Fix:* text in a band colour is mixed toward `--ink` for the light theme, and
  the light outcome hues are deepened to ≥ 4.5:1 on white and on panel-sunk.

- [x] **C5. The phone "More" sheet is a modal that never takes focus.** It is
  announced as `role="dialog" aria-modal="true"`, but opening it left focus on
  the button behind it, and closing it did not bring focus back. Keyboard and
  screen-reader users were left outside the dialog (WCAG 2.4.3; ARIA dialog
  pattern).
  *Fix:* focus moves to the first item on open, Tab stays inside the sheet,
  and focus returns to the More button on close.

- [x] **C6. The Ladder view throws on every render.** `render()`'s ladder branch
  called `matchdays(reports[...])`, but `reports` was never defined. Each visit
  to the Ladder raised a `ReferenceError` after drawing the lanes, so the rest
  of the render never ran, including the step that hides the animate button.
  This has been there since the tabbed views were added. It was found when the
  contrast sweep re-rendered each view (Nielsen #1, visibility of system
  status: the button can show on a season with nothing to animate).
  *Fix:* it uses the `report` already in scope.

## High impact — real friction for many users, or a clear standards breach off the core flow

- [x] **H1. No way to skip the navigation.** Nine controls (seven views, the
  settings button, the hero switchers) come before the content on every page
  (WCAG 2.4.1 Bypass Blocks).
  *Fix:* a "Skip to content" link, visible on focus, is the first stop, and
  `<main>` is the target.

- [x] **H2. Rating trends are icon + colour only.** The ↗/↘ arrows beside every
  rating are unlabelled SVGs. A screen reader gets nothing, and colour-blind
  users must tell the arrows apart by angle alone (WCAG 1.1.1, 1.4.1).
  *Fix:* each arrow is `role="img"` with a translated label ("Rising sharply",
  "Steady", …).

- [x] **H3. The standings table has no accessible name** (WCAG 1.3.1). The finish
  grid has a caption, but the main table did not.
  *Fix:* `aria-labelledby` points at the panel's heading.

- [x] **H4. The rewind slider announces a number, not a date.** Screen readers
  read "47" (the matchday index) rather than the date it stands for (WCAG
  4.1.2; ARIA slider pattern: `aria-valuetext`).
  *Fix:* `aria-valuetext` carries the date, or "Live".

- [x] **H5. English left in the Norwegian UI.** The zone dividers ("Expected
  Title Threshold: 71p"), the hero switcher labels and the hidden "Season"
  label stayed English. That's Nielsen #4, consistency and standards, and a
  screen reader speaks the English with Norwegian pronunciation.
  *Fix:* all of them are routed through `t()`.

- [x] **H6. Fixture-difficulty pill text fails contrast.** The new tinted pills
  measured 3.56–4.07:1 in dark and 3.37–3.60:1 in light (WCAG 1.4.3).
  *Fix:* the text lightness moves further from the tint in each theme (≥ 4.5:1
  at every strength).

- [x] **H7. Popovers claim to be ARIA menus but don't act like them.** The settings,
  division and season popovers are `role="menu"`. A screen reader then promises
  arrow-key menu navigation, which isn't implemented, and the settings popover
  holds toggle groups, which aren't menu items at all.
  *Fix:*
  - The division and season pickers are plain groups of pressed-state
    buttons. `aria-pressed` was already set.
  - Settings is a labelled `group`.
  - Escape still closes all of them.

- [x] **H8. The division/season switcher isn't discoverable.** Only a dashed
  underline hinted that the heading is a control (Nielsen #6, recognition
  rather than recall; affordance).
  *Fix:* a chevron after each part, which turns with `aria-expanded`.

- [x] **H9. Some finish-grid numbers fail contrast.** One heat step left
  its numbers under 4.5:1. In dark mode, both inks on step 4 (`#1f83b9`)
  measured 4.2:1. In light mode, step 4 used white text at 3.8:1 when dark
  ink would give 4.7:1 (WCAG 1.4.3). Found by the post-fix contrast sweep.
  *Fix:*
  - Dark `--seq-4` is `#1d7aac`: white at 4.7:1, still ordered between steps 3
    and 5.
  - The ink switches at step 5 in both themes.

- [x] **H10. Odds bar labels and the Compare legend fail contrast.** The white
  percentages on the home/away segments of every odds bar (Next Up, Compare
  Clubs) measured 3.2–3.6:1 in dark and 4.0–4.4:1 in light. The Compare
  rating-history legend's hard-coded line colours measured 3.1–4.1:1 as text
  (WCAG 1.4.3). Found by the post-fix sweep of the remaining views.
  *Fix:*
  - Light `--home`/`--away` take the deepened outcome hues: white labels at
    5.3–5.9:1.
  - The dark theme's brighter segments take dark labels, at 4.9–5.5:1.
  - The legend text is mixed toward `--ink`, which works in both themes.

- [x] **H11. The team page's pre-season → current delta fails contrast.** The
  "+41" / "−12" between the two boxes sat on a fill of `--rule`, a line colour
  darker than any text surface. It measured 3.72:1 in dark and 4.18:1 in light
  (WCAG 1.4.3).
  *Fix:* the fill is `--panel-sunk`, with `--rule` as the divider lines, giving
  ≥ 5:1 in both themes.

## Nice to have — polish that improves clarity or comfort

- [x] **N1. Grid decimals: the instructions assume a mouse.** The legend says
  "Hover for decimal figure" on phones too, where it is a tap, and screen
  readers had only the rounded number.
  *Fix:*
  - The hint reads "Tap" on coarse pointers.
  - Every cell has an `aria-label` with team, position and the two-decimal
    figure.

- [x] **N2. The browser toolbar ignores the theme.** There is no `theme-color`, so
  on phones the browser toolbar stays white above the dark page.
  *Fix:* `theme-color` metas for both colour schemes.

- [x] **N3. The language tag is too loose.** `lang="no"` is the macrolanguage.
  `nb` (Bokmål) gives screen readers and hyphenation the right dictionary.
  *Fix:* the document language is set to `nb` when Norwegian is chosen. The
  stored preference key is unchanged.

- [x] **N4. The club-name button is under the minimum target size.** It measured
  56×22px, below WCAG 2.5.8's 24px. The row is clickable for mouse users, but
  the focusable target is the button.
  *Fix:* `min-height: 28px`.

- [x] **N5. Norwegian naming clash.** The phone tab for the finish grid is
  "Prognose", the table's prediction toggle is also "Prognose", and the grid's
  heading is "Sluttabellen". One word points to two places (Nielsen #4).
  *Fix:* the tab is "Sluttabell", matching the heading.

---

## Verification (after the fixes)

Re-run on the same build, in the browser, after all fixes:

- **Contrast:** the per-element sweep reports no text below its WCAG threshold
  in any view (Grid, Table, Ladder, Next Up, Played, Compare, Model, Team), in
  either theme.
- **Semantics:**
  - The `<h1>` reads "Eliteserien, change division 2026, change season".
  - The skip link is the first Tab stop, and following it focuses `<main>`.
  - The hidden `<select>` cannot take focus.
  - The table is named "Table".
  - The trend arrows are `role="img"` with text, and no `role="menu"` remains.
  - The club button is 28px tall.
  - The slider has `aria-valuetext`.
  - A grid cell reads "Bodø/Glimt, 1st place: 70.30%".
- **Hero switcher:** `aria-expanded` goes true on open and false on Escape;
  the pickers are `role="group"`.
- **Phone sheet:** focus moves to "Ladder" on open. Tab from the last item
  wraps to the first. Escape closes the sheet and returns focus to More, and
  `aria-expanded` goes back to false.
- **Norwegian:** a scan of every view's text and `aria-label`s finds no English.
  `lang="nb"`. The grid tab is "Sluttabell", distinct from "Prognose".
- **Stability:** no console errors across all views (the Ladder no longer
  throws).
- **Tests:** 269 Python tests and 12 Node tests pass.

## Checked and passing

- Reflow at 320px: no page-level horizontal scroll; wide tables scroll inside
  their own panel (1.4.10).
- Every `<img>` has an `alt`, and every interactive element has an accessible
  name except the two decorative `<select>`s, which are `tabindex="-1"` and
  hidden.
- Visible focus: a global `:focus-visible` outline.
- `prefers-reduced-motion` disables animation and transitions.
- Sortable columns expose `aria-sort`.
- The phone bottom bar's targets are 52px tall, above both HIG and Material.
- `<header>`, `<main>`, `<nav>` and `<footer>` landmarks are present, and the
  heading order runs h1 → h2.

---

## Round 2 — phone layout, animation and consistency (2026-09-25)

Raised in review: the finish-grid tooltip never disappearing during the
animation; the phone layout in general, especially the grid, table and
ladder; and design consistency across the site. Measured at 390, 360 and
320px.

- [x] **R1. The grid tooltip stuck on screen during and after the animation.**
  Each frame re-sorts the rows by moving them in the DOM, and stopping the
  animation rebuilds the grid. The cell under a still pointer moves away or
  is replaced without a `pointerleave`, so the tooltip stayed up with a stale
  value (Nielsen #1).
  *Fix:*
  - Every rebuild hides the tooltip.
  - Each animation frame checks what is under the pointer: it refreshes the
    tooltip for that cell, or hides it.
  - *Verified:* while the rows re-sort under a still cursor, the readout
    follows the club now under it (Viking → Bodø/Glimt) with live values, and
    it hides on leaving.
  - *Follow-up:* the readout still stuck when the pointer left the grid
    mid-animation. The pointer position was only recorded over cells, so after
    leaving it still pointed into the grid, and every frame found a cell there
    and kept the readout up, covering part of the grid.
    - The position is now tracked on the whole document.
    - Leaving `#grid` hides the readout.
    - *Verified mid-animation:* live values over a cell (Molde 8th:
      10.52% → 6.33%); hidden on every sample after moving outside and after a
      fast jump to the far corner; hidden after stopping.

- [x] **R2. The ladder on phones was crests in a tall, mostly empty strip.**
  Clubs could not be identified without tapping each crest. A stray scroll
  track floated on the right, and two-thirds of the width was blank.
  *Fix:*
  - Under 500px the ladder is a ranked list: one row per club with rank,
    crest, name and rating, plus a dot on a shared rating scale (lines every
    100, labels every 200). That keeps the "both divisions on one axis" idea.
  - Rows sit at their rank, so the animation now moves them as a bump chart.
  - A tap opens the club, as in the table.
  - The desktop strip is unchanged.

- [x] **R3. Every re-render added another ladder tap handler.** Once
  handlers had stacked, each tap toggled the tooltip an even number of times,
  so on phones a tap could appear to do nothing.
  *Fix:* the handler is bound once per track (`bindLadderClicks`).

- [x] **R4. The finish grid on phones showed 7 of 16 places.** It scrolled
  sideways behind a fade that read as washed-out cells, so the grid's
  pattern was never visible whole.
  *Fix:* under 760px the grid fits the screen: fixed layout, crest-only club
  column, 1px gaps, cells of about 18px (13px at 320) and a tap for the exact
  figure.

- [x] **R5. The table's phone column set was never applied.**
  - `.col--extra` was documented as the columns a phone drops, but no rule
    hid it.
  - The phone padding rule lost to a more specific base rule, so every cell
    kept 9.6px of side padding.
  - Prediction ran 23–39px past the screen.

  *Fix:*
  - The extras are hidden on phones.
  - The padding rule matches the base rule's specificity.
  - Fixture difficulty has a short header ("Fix" / "Takt").
  - Prediction drops Elo on phones (it's in Current).
  - Both views now fit a 390px phone exactly (349/349px).

- [x] **R6. Secondary buttons looked different in every view.**
  - Corners were 4px, 8px, 14px or full pills.
  - Fills were `--panel` or `--panel-sunk`.
  - Borders were `--rule` or `--rule-strong`.
  - Wrapped text turned "← Prev" into a two-line blob (Nielsen #4).

  *Fix:*
  - One secondary-button style: a pill, hairline border, panel fill, the
    same hover, on one line.
  - The play button is a circle at the same 44px touch size as the rewind
    step buttons.
  - Nested items (popover options, compare menu options) take `--radius-sm`
    inside `--radius` containers.
  - The prediction box uses the card radius.

- [x] **R7. Result cards used the title gold to mark the winner.** Gold means
  "champion" everywhere else, and it rendered olive on the dark panel.
  *Fix:* a neutral ink wash marks the winner's side.

- [x] **R8. The phone layouts of the other views were cramped.**
  - Compare Clubs broke names mid-word ("Vikin g").
  - The Played results week label had a fixed 10rem width, which pushed both
    buttons past the panel edge at 360px.
  - The team page stacked two 1.25rem gutters (40px a side).

  *Fix:*
  - The compare cards stack the crest above the name on phones.
  - The week label flexes between the buttons.
  - The team page keeps one layer of gutter.

**Verification:**
- No page-level horizontal scroll at 320px in any view. At 390px only the
  standings table could scroll, and neither of its views overflows.
- No contrast failures in the phone layouts in either theme.
- No console errors.
- 269 Python tests and 12 Node tests pass.


---

## Round 3 — fresh pass: localisation, keyboard, phone fixtures (2026-09-25)

A new audit of the whole site in Norwegian at 1920px and at 390px (phone
frames), with a text-size sweep (every visible text node under 12px, per view)
and a scan of the Norwegian dictionary for keys missing from it or left equal
to the English.

Added sources:
- **Språkrådet / Norwegian typographic practice:** decimal comma, a space as
  thousands separator (optional at four digits), and a space before `%`
  ([SNL: tusenskille](https://snl.no/tusenskille),
  [Korrekturavdelingen: prosent](https://www.korrekturavdelingen.no/promille-prosent.htm)).
- **Dark Reader's site opt-out**, the `darkreader-lock` meta
  ([CONTRIBUTING.md](https://github.com/darkreader/darkreader/blob/main/CONTRIBUTING.md)).
- **Heckbert, "Nice numbers for graph labels"** (Graphics Gems, 1990): axis
  ticks at 1, 2 or 5 × 10ⁿ.
- **Minimum text size:** Apple HIG and Material both put the smallest legible
  caption at 11pt/sp. No content text should sit below that.

### Critical

- [x] **S1. A forced-dark extension erases the data colours.** With Dark
  Reader on (in the browser this audit ran in), the finish grid loses every
  heat colour, and the legend ramp and the band strip go blank. The core view
  becomes a table of bare numbers. The page already has its own dark theme,
  so the extension adds nothing and removes the encoding (WCAG 1.4.1 in
  effect: the meaning was carried by colour that no longer renders).
  *Fix:* `<meta name="darkreader-lock">` and `<meta name="color-scheme"
  content="light dark">`. *Verified:* with the extension on, the page is no
  longer processed (`data-darkreader-mode` absent), and the ramp, legend and
  band strip render in the site's own colours.
- [x] **S2. The team page's season rows are mouse-only.** Each row of the
  season-by-season table loads that season's shape chart on click, but the
  rows are `<tr>`s with a click handler. They cannot be focused or activated
  from the keyboard, and nothing tells a screen reader they do anything
  (WCAG 2.1.1 Keyboard, 4.1.2).
  *Fix:* the year in each row is a `<button>` ("2023: vis sesongform"). Its
  click bubbles to the row, so mouse behaviour is unchanged. The chart
  section is `aria-live="polite"`, so the swap is announced. *Verified:*
  focus plus Enter loads "Sesongform 2023".

### High impact

- [x] **S3. The standings headers are English in Norwegian.** P, W, D, L, GF,
  GA, GD, Pts and xPts are hard-coded in the HTML, and so are their
  screen-reader expansions ("played", "wins", …). Norwegian tables read
  K, V, U, T, +, −, MF, P (Nielsen #4).
  *Fix:* every header label and expansion goes through `t()` (`th.*` keys).
  Norwegian reads # Lag K V U T + − MF P, with "kamper", "vunnet", … for
  screen readers. English is unchanged.
- [x] **S4. The band names are English in Norwegian.** The table's zone
  dividers read "FORVENTET GRENSE FOR TITLE / CL / QUAL. / RELEG. PLAY-OFF /
  REL.", because the short labels are missing from the Norwegian dictionary.
  The full names ("Champions League qualification", "Relegation play-off") in
  grid tooltips, the band legend and the band strip come straight from the
  backend in English.
  *Fix:*
  - The Norwegian short labels are Tittel, CL, Europa, Kvalik, Opprykk,
    Nedrykkskvalik and Nedrykk.
  - A `bandName()` helper translates the full names (`band.*` keys) in the
    grid tooltips, the band legend, the band strip and the table's zone
    marks.
- [x] **S5. Numbers are formatted the English way in Norwegian.** The
  sentence reads "favoritt med 70.3%", and the stats "50,000 simulerte
  sesonger". In Norwegian, "50,000" reads as fifty with three decimals. The
  standard is "70,3 %" and "50 000".
  *Fix:* `num()`, `signed()` and `pct()` format for the UI language (nb-NO /
  en-GB).
  - Grouping starts at five digits, so ratings stay "1794".
  - Norwegian percentages take a no-break space.
  - Hand-built percentages (Model card, odds segments, the season-shape axis)
    use the same helpers.

  *Verified:* "favoritt med 70,3 %", "50 000"; English still reads "70.3%".
- [x] **S6. Next Up and Played Results hide club names on phones.** Under
  760px each fixture shows only two crests and two ratings. The user has to
  know about 30 crests by heart to read the list (Nielsen #6, recognition
  rather than recall: the same problem R2 fixed for the ladder).
  *Fix:* on phones the name sits under the crest at 11px (crest 28px),
  ellipsised past 4.75rem. The rating delta stacks under the rating, which
  also cures a pre-existing overflow: at 360/320px the away delta ran off the
  card. *Verified:* no card overflows and no name truncates at 390, 360 or
  320px.
- [x] **S7. Data text below the legible minimum.** The table's form chips and
  the fixtures' scoreline chips are 10px. On phones the Compare card's
  "Hjemme/Borte" and "Klikk for å endre" are 9.6px, and the head-to-head
  goals label is 10.4px.
  *Fix:* an 11px floor (0.6875rem) for:
  - form chips, scoreline chips and zone-threshold tags;
  - ladder ticks and the phone table heads;
  - the Compare side and hint labels, and the head-to-head goals label.

  *Verified:* the per-view sweep finds no text under 11px outside the phone
  bottom bar (platform-standard 10pt tab labels) and the 16-column heat maps
  on phones, where a tap gives the figure.

### Nice to have

- [x] **S8. The finish grid's club column is ragged.** Club names are
  right-aligned, so the current table position, the small number before each
  crest, lands at a different x on every row. It sits below the text
  baseline and has no label saying it is the current position.
  *Fix:* the column is left-aligned, the number is vertically centred on the
  crest (measured: centres within 0.01px), and the corner header reads "Nå"
  ("Plass i tabellen nå" on hover).
- [x] **S9. The Compare chart's rating axis ticks are odd numbers**
  (1456, 1559, 1662, 1765, 1868): the range split into four equal parts.
  Round ticks (1500, 1600, …) are far easier to read off (Heckbert).
  *Fix:* ticks step by 1, 2 or 5 × 10ⁿ, aiming for four to six. *Verified:*
  1500, 1600, 1700, 1800.
- [x] **S10. Rating precision changes between views.** Ratings are whole
  numbers everywhere except the team page's season table and peak/low line
  ("1794.3", "Høyeste 1811.3"). The change column mixes "+78" and "+49.8".
  *Fix:* the season table, peak and low show whole numbers, with a signed
  change ("+78", "+50"), as everywhere else.
- [x] **S11. Strings still English in Norwegian:** the season picker's
  "(live)", the "Rating start" column head, and the played cards' "R22"
  round label.
  *Fix:* "(direkte)", "Rating ved start" / "Rating ved slutt",
  "Runde 22" / "Round 22".
- [x] **S12. The Model card grid fills its empty trailing cells** with a sunk
  block, which reads as a missing card rather than empty space.
  *Fix:* each card draws its own right and bottom rule, and the container
  clips the outer ones. The empty cells are plain panel.

**Verification (Round 3):**
- **Localisation:** the Norwegian dictionary scan finds no missing keys. What
  it still lists as equal to English is language-neutral: Rating, Elo, Form,
  xG, xGA, xGD, CL, #.
- **Stability:** no console errors or unhandled rejections across all seven
  views and the team page.
- **Phone:** no page-level horizontal scroll at 390, 360 or 320px, and the
  standings table still fits exactly (349/349px).
- **Tests:** 269 Python tests and 12 Node tests pass.


---

## Round 4 — findings from the research pass (2026-09-25)

Found by checking each principle in the research basis against the site.

### High impact

- [x] **T1. Keyboard focus could land under the sticky masthead or the phone
  bottom bar** (WCAG 2.2 2.4.11 Focus Not Obscured, new in 2.2).
  - The masthead is sticky and the phone bar is fixed, and nothing offset
    scrolling for them.
  - Shift+Tab up the long table, or following the skip link, could scroll
    the focused control under the masthead.

  *Fix:* `scroll-padding-top: 76px` on the root, plus a bottom padding the
  height of the bar (safe area included) on phones. *Verified:* the root
  reports a 76px padding, and a focused table button sits clear below the
  masthead.
- [x] **T2. Changing season gave no sign of loading** (Nielsen #1, Doherty
  threshold).
  - A past season is a separate download.
  - The visible switcher changed nothing until the new report arrived, so a
    slow fetch looked like a dead click.
  - Screen readers got nothing, and a load error went into a `#status` box
    that was not a live region.
  - The animation overlay's text, "Loading matchdays…", was hard-coded in
    the CSS in English. Its escape `…` is not valid CSS, so the
    ellipsis rendered as "u2026".

  *Fix:*
  - A season load dims the content (as a rewind does) and sets
    `aria-busy="true"`. A rewind now sets `aria-busy` too.
  - `#status` is `role="status"`.
  - The overlay text comes from `t('anim.loading')` through
    `attr(data-loading-text)`.

  *Verified:*
  - `aria-busy` is "true" during the 2019 load and cleared after.
  - The overlay reads "Laster kampdager…".
  - No console errors.

**Tests:** 269 Python tests and 12 Node tests pass.
