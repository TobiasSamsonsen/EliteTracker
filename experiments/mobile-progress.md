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

## Phase 4: P0 FIXES (⏳ next)

- Dispatch fixer: P0-A CSS animation toggle + P0-B `switchView` extraction (owns
  `public/styles.css` + `public/app.js`).
- Verify: `repro_more3.py` (expect baseline side to pass after real fix), `audit.py --out p0`
  at phone viewports; compare against baseline; commit.

## Phase 5: REMAINING FINDINGS (⏳)

Design/JS lanes (disjoint files): tap targets <44px, input font <16px (iOS zoom),
clipped text at 320, overlap pairs, PTR horizontal-guard if proven needed,
`touch-action` / `overscroll-behavior` static gaps.

## Phase 6: VERIFY + REVIEW (⏳)

- Full re-audit all 7 viewports → `after` report, before/after table.
- Desktop regression check (1440x900 must not regress).
- One @oracle review of the combined diff. Final report.

## Conventions

- Commit after each fix group on `mobile-ui`. No backend/model changes; no MODEL_VERSION bump.
- Screenshots (`shots-*/`) stay local (gitignored); reports JSON/MD are committed.
