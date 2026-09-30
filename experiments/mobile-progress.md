# Mobile Audit Progress Tracker

Branch: `mobile-ui` · audit tooling: `experiments/mobile-audit/` · dates: 2026-09-30

## Phase 1: RECON (✅ done)

- Views: `grid, table, ladder, next-up, played, compare, model, team`; mobile cutoff 760px.
- Mobile: bottom `#mobilebar` (grid/table/next-up/played) + `#more-sheet` (ladder/compare/model).
- Tab switch handler: `public/app.js:3283-3293` (click on `[data-view]`), `render()` at
  `public/app.js:3225-3244` (hidden flags + `history.replaceState`).
- Swipe on `.mobilebar`: touch handlers `public/app.js:4300-4345`.

## Phase 2: AUDIT (✅ done)

- `experiments/mobile-audit/audit.py` — 7 viewports, all views, More-menu taps, bar swipe
  (CDP touch), content swipe/PTR probe, tab-jump measurement; overflow / <44px targets /
  overlaps / input <16px / clipped text / CLS / console errors; PNGs per state.
- Repros: `repro_more.py`, `repro_more2.py` (event timeline), `repro_more3.py` (causal fix test).

## Phase 3: BASELINE (✅ done)

Run: `experiments/mobile-audit/baseline-report.md` / `.json` / `shots-baseline/` (88.2s).

- **P0-A (More menu) REPRODUCED at all 4 phone viewports**: item tap →
  `switched=NO sheet_closed=True`, `under_pointer=button.sheet__item` (tap landed correctly).
- **P0-B (swipe nav) REPRODUCED at all 4 phone viewports**:
  `pageerror: switchView is not defined`, view never changes, scroll stays (swipe dead).
- Tap-path tab switch jumps scroll 494–909 → 0 with doc-height delta ~783–827px, CLS 0.
- All 7 views load at every viewport; 0 console errors on cold load; no horizontal overflow.
- Small tap targets 7/17/25/29/7/77/143; inputs <16px = 10/page (range+select);
  overlaps 30/22/14/12/14/10/0; clipped text 7 at 320px only (sr-only excluded).

### P0 root causes (proven)

- **P0-A**: `styles.css` `.sheet__panel.is-dragging { animation: none }` (~line 1854) +
  touch handlers `app.js:4361-4403` adding/removing `is-dragging` on ANY touchstart/touchend.
  Removing the class re-triggers the `sheet-up` open animation → panel teleports to
  `translateY(100%)` before the compatibility mousedown/click → click hits `.sheet__scrim` →
  sheet closes, view never switches. Event timeline proven by `repro_more2.py`.
  **Fix validated causally by `repro_more3.py`**: keeping the animation name stable
  (`animation-name: sheet-up; animation-play-state: paused`) → `switched=YES`.
- **P0-B**: `switchView` is called at `app.js:4341` but never defined anywhere →
  ReferenceError on every bar swipe (and every bar tap, where `currentX` (default 0) −
  `startX` fakes a >50px delta; the compat click still switches the view, so taps appear
  to work while logging a pageerror). Fix: extract the click-handler body into
  `switchView(view)`, guard the fake-delta (track real movement), always clear the
  bar highlight.

## Phase 4: P0 FIXES (✅ done — commit `a0e8246`)

- P0-A: `.sheet__panel.is-dragging` keeps `animation-name: sheet-up` +
  `animation-play-state: paused` (`styles.css` ~1854).
- P0-B: top-level `function switchView(view)` before `wire()` in `app.js`; click handler
  calls it; swipe touchend wraps it in try/finally + `clearBarHighlight()`;
  `swipeState.currentX = swipeState.startX` on touchstart (kills tap fake-delta).
- Verified: `repro_more3.py` baseline side switched=YES; audit `items_ok=3/3` all 4
  phones, swipe switches views, 0 pageerrors. (Second commit `41b65e0` refined the
  audit's reachability check and refreshed the baseline.)

## Phase 5: REMAINING FINDINGS (✅ done — commit `f79d6ff`)

Designer lane, `public/styles.css` only, scoped `(pointer: coarse), (max-width: 760px)` /
`480px` / `360px`: 44px targets (swap-center, settings, ladder__team, played/grid
team-name, sort-btn, grid-anim-speed, wordmark via padding+negative margin),
`select/input/textarea` 16px on touch, played-card crest 40→44px, `.odds` horizontal
scroller ≤480, `.odds__seg` ellipsis ≤360. Audit hardening: WCAG 2.5.8 exemptions
(skip-link, inline links) + sr-only/inert exclusions in FONTS_JS.

## Phase 6: VERIFY + REVIEW (✅ audit done, oracle pending)

- Full after-audit green (`after-report.md`, 89.9s): touch viewports small/inputs/
  clipped/covered = 0/0/0/0; landscape+tablet 0 small, 3 inputs (range only, out of
  scope); no overflow, 0 console errors everywhere; desktop unchanged (179 small =
  mouse targets, intentional; drop from 193 = audit exemptions).
- Desktop screenshots eyeballed: layout intact, no regression.
- Deliberate design kept: view switch scrolls to top (tab reset); per-view scroll
  memory listed as possible enhancement only.
- Remaining: one @oracle review of `git diff main…mobile-ui`, then final report.

### Next-session pickup

- Oracle review attempts all failed on provider issues (degenerate output → 502
  ResourceExhausted → hung generation, session `ses_f0c883550ffeM2HbCQDI5T87GJ`
  aborted). Scope for the retry: **code-only diff** — `git diff main..mobile-ui --
  public/app.js public/styles.css` (~40 lines) + audit.py hunk; never the full diff
  (5k-line report JSON floods context). Check: P0-A paused-animation robustness,
  P0-B hoisted `switchView`, CSS media-query scope leaks, then verdict.
- After verdict: deliver final before/after report (baseline `baseline-report.md`,
  final `after-report.md`, shots local in `shots-*/`).

## Conventions

- Commit after each fix group on `mobile-ui`. No backend/model changes; no MODEL_VERSION bump.
- Screenshots (`shots-*/`) stay local (gitignored); reports JSON/MD are committed.
