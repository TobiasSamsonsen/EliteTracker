# Predict Feature Audit & Improvement Suggestions

**Scope:** End-to-end audit of `/predict/` (UI, UX, client REST layer, scoring, Firestore security rules, hourly sync job, privacy, and QA) on the `predict` branch as of 2026-11-23.

---

## 1. How Predict Works & Current Strengths

Predict is a zero-dependency, client-first prediction game hosted at `/predict/` and backed by Firebase Auth + Firestore on the Spark free plan:

- **Client & Price Curve:** [`public/predict/index.html`](../public/predict/index.html), [`public/predict.js`](../public/predict.js), [`public/predict-api.js`](../public/predict-api.js), [`public/predict-core.js`](../public/predict-core.js), [`public/predict-util.js`](../public/predict-util.js), and [`public/elo-curve.js`](../public/elo-curve.js) implement the UI and Firestore REST client without a Firebase SDK. Match picks use a frozen Elo price curve (`CURVE_VERSION = 1`) mirrored between [`src/elitetracker/predict/curve.py`](../src/elitetracker/predict/curve.py) and [`public/predict-core.js`](../public/predict-core.js), pinned by shared test vectors.
- **Security & Rules:** [`firestore.rules`](../firestore.rules) restricts `entries/{uid}/rounds/{round}` and `tables/{uid}/picks/{key}` to owner-only reads/writes, validates integer probabilities (`2..96` summing to `100`), enforces `request.time` server timestamps, and locks each slot at its fixture kick-off.
- **Hourly Sync & Scoring:** [`src/elitetracker/predict_sync.py`](../src/elitetracker/predict_sync.py) and [`src/elitetracker/predict/sync.py`](../src/elitetracker/predict/sync.py) run hourly via GitHub Actions ([`.github/workflows/predict.yml`](../.github/workflows/predict.yml)) using keyless Workload Identity OIDC. The job syncs fixtures, snapshots model odds, aggregates anonymous crowd picks (`n >= 5`), scores settled matches via proper Brier and RPS rules with the model as one voter in the median ([`src/elitetracker/predict/scoring.py`](../src/elitetracker/predict/scoring.py)), builds leaderboards ([`src/elitetracker/predict/boards.py`](../src/elitetracker/predict/boards.py)), scores the pre-season table game ([`src/elitetracker/predict/tables.py`](../src/elitetracker/predict/tables.py)), computes the shadow Kalman signal ([`src/elitetracker/model/crowd.py`](../src/elitetracker/model/crowd.py)), and generates [`public/predict/rounds.ics`](../public/predict/rounds.ics).

### Key Strengths
- **Frictionless entry:** Anonymous auth on the first pick with optional Google account linking later keeps onboarding under 30 seconds.
- **Spark-friendly read/write architecture:** One document per player per round, a single `meta/rounds` index, and pre-built `reveal/{key}` and `boards/{id}` documents keep daily reads low.
- **Sound incentive design:** Proper scoring (Brier/RPS) against the field median (with the model as a voter) plus tiers/percentiles avoids tournament risk-seeking, and deviation-based crowd pooling avoids double-counting the model.
- **Strong onboarding sandbox:** The interactive "How to play" guide lets new players test the slider and see Brier consequences (including why going all-in at 96 % fails) without saving anything.

---

## 2. P0 — Critical Bugs & Launch Blockers

These issues should be fixed before merging `predict` into `main`:

1. **Google account switch wipes the new session from `localStorage`**
   - **Where:** [`public/predict.js:1403`](../public/predict.js#L1403), [`public/predict.js:1430-1433`](../public/predict.js#L1430-L1433), [`public/predict-api.js:252`](../public/predict-api.js#L252), [`public/predict-api.js:267`](../public/predict-api.js#L267)
   - **Issue:** After `await client.signInGoogle(credential, location.origin)` writes the new session to `predict.session`, the very next call `resetLocal()` deletes every `localStorage` key starting with `predict.`, including `predict.session`. On the next page reload, the user is signed out. In addition, `resetLocal()` fails to clear in-memory `S.history`, `S.sideBoards`, `S.myLeagues`, `S.counted`, and `S.revealSeen`.
   - **Fix:** Add a `{ keepSession: true }` option to `resetLocal()` (preserving `sessionKey(config)`) and clear all in-memory user state fields.

2. **Stale draft slots permanently break saving for the rest of a round**
   - **Where:** [`public/predict.js:177-204`](../public/predict.js#L177-L204), [`public/predict.js:640`](../public/predict.js#L640), [`firestore.rules:46-52`](../firestore.rules#L46-L52)
   - **Issue:** `flushSave(key)` commits every slot in `S.drafts[key]` in one batch. If any drafted slot kicks off before saving succeeds (e.g., offline or tab closed mid-round), `firestore.rules` rejects the entire commit with `403 denied`. `flushSave` never drops locked slots from the draft, blocking every remaining open match in that round. Furthermore, `roundBody()` only auto-flushes drafts when `status === 'open'`, not when `status === 'live'` (first match started, later matches still open).
   - **Fix:** Filter out locked slots (`isLocked(fixture.slots[s].kickoff, now())`) from `S.drafts[key]` before committing (and prune them from `localStorage`), and allow draft flushing for open slots during `live` rounds as well.

3. **Mini-leagues stay empty until a match settles, and invite code vanishes on creation**
   - **Where:** [`src/elitetracker/predict/sync.py:325`](../src/elitetracker/predict/sync.py#L325), [`public/predict.js:840-841`](../public/predict.js#L840-L841), [`public/predict.js:853-854`](../public/predict.js#L853-L854)
   - **Issue:** On the backend, `_boards()` (which writes `boards/league_{code}`) only runs when `changed_scores` is true, so creating or joining a mini-league between rounds leaves `boards/league_{code}` missing (`"No scores yet."`) for up to a week. On the frontend, `leaguesSection()` writes the generated invite code to `message.textContent` and immediately calls `render()`, destroying the DOM node before the user can read or copy it.
   - **Fix:** Detect new/changed mini-leagues or memberships in `sync.py` so mini-league boards rebuild on the next hourly run even without newly settled matches; show the created invite code persistently (via `toast` or state + a copy button) instead of wiping it with `render()`.

4. **Returning Google users have no way to sign in on a new device**
   - **Where:** [`public/predict.js:1235`](../public/predict.js#L1235), [`public/predict.js:1425`](../public/predict.js#L1425)
   - **Issue:** When `!client.uid`, `renderMe()` calls `dataSection(false)`, which omits `googleBlock()`. A returning player on a new phone has to tip a match anonymously, trigger anonymous profile creation, try to link Google, hit `already_linked`, and then switch accounts.
   - **Fix:** Render a direct "Sign in with Google" button (calling `client.signInGoogle`) on the signed-out "Me" tab.

5. **Case-only nickname changes fail with a misleading error**
   - **Where:** [`public/predict-api.js:135-140`](../public/predict-api.js#L135-L140), [`firestore.rules:153-154`](../firestore.rules#L153-L154), [`firestore.rules:165`](../firestore.rules#L165)
   - **Issue:** `nicknameChangeWrites()` always sends `writeSet('nicknames/{key}', { uid })` and `nickAt: SERVER_TIME`. For a case-only edit (e.g., `ola_1` → `Ola_1`), `nicknames/{key}` already exists (`firestore.rules` forbids `update`) and `users/{uid}` requires unchanged `nickAt` when `nickLower` is unchanged. The UI displays `"That name is taken, or you changed it less than 30 days ago."`
   - **Fix:** When `nickLower(oldNick) === nickLower(newNick)`, send only `writeMerge('users/{uid}', { nick: newNick })`, leaving `nickAt` and the existing claim untouched.

6. **`calibration()` permanently caches unsettled rounds**
   - **Where:** [`public/predict.js:1346`](../public/predict.js#L1346)
   - **Issue:** `calibration()` caches a round once `Object.values(reveal.matches).length === Object.keys(data.p || {}).length`. If a player tipped 3 matches in an 8-match round and 3 matches have kicked off without results yet, an empty array is permanently cached in `localStorage` and never refreshed.
   - **Fix:** Only cache a round once every tipped slot in `data.p` (or `fixture.slots`) has a settled `result`, and share a single history cache with `loadHistory()`.

7. **Collapsing "Fine-tune" silently resets draw tendency and overwrites the saved pick**
   - **Where:** [`public/predict.js:407`](../public/predict.js#L407)
   - **Issue:** Collapsing the Fine-tune drawer resets `pos.k = DRAW_TENTHS.normal` and triggers `touch(); release()`, silently overwriting a user's previously saved custom draw tendency.
   - **Fix:** Make collapsing the drawer purely visual; add an explicit "Reset to 1.0×" action if a reset is desired.

8. **Account deletion leaves stale UI and mishandles Auth delete errors**
   - **Where:** [`public/predict.js:1416-1423`](../public/predict.js#L1416-L1423)
   - **Issue:** `render()` is not called after deletion, leaving profile, stats, and delete controls visible. If `client.deleteAccount()` fails (e.g., `CREDENTIAL_TOO_OLD_LOGIN_AGAIN` on a Google-linked account), `deleteRequests/{uid}` has already been committed while the browser never clears local state.
   - **Fix:** Re-render after deletion, handle `CREDENTIAL_TOO_OLD_LOGIN_AGAIN` gracefully (prompt re-auth or inform the user that Firestore deletion is queued and sign out locally), and ensure `resetLocal()` completes cleanly.

9. **Missing concurrency guard on `ensureAccount()` & stale `S.profile.club`**
   - **Where:** [`public/predict.js:157-170`](../public/predict.js#L157-L170), [`public/predict.js:1273`](../public/predict.js#L1273)
   - **Issue:** `ensureAccount()` has no in-flight promise lock, so two concurrent actions while signed out can create duplicate anonymous accounts. Separately, changing the favourite club commits to Firestore without updating `S.profile.club`, so switching tabs reverts the displayed input until reload.
   - **Fix:** Deduplicate concurrent `ensureAccount()` calls with a shared in-flight promise, and update `S.profile.club` in memory on save.

10. **Scunthorpe false positives in nickname profanity filter**
    - **Where:** [`src/elitetracker/predict/nicknames.py:18`](../src/elitetracker/predict/nicknames.py#L18), [`src/elitetracker/predict/nicknames.py:42-44`](../src/elitetracker/predict/nicknames.py#L42-L44), [`public/predict-core.js:134`](../public/predict-core.js#L134), [`public/predict-core.js:152-155`](../public/predict-core.js#L152-L155)
    - **Issue:** Raw substring matching on `"hore"` silently hides valid Norwegian names like `Thore` or `Håkon_Thore` from all leaderboards.
    - **Fix:** Use word-boundary/token-aware checks or refine the blocklist, and surface blocked status (or reject at rename time) instead of silently hiding players without notice.

---

## 3. P1 — Backend Logic, Scoring, Sync & Scalability ("How It Works")

1. **Model-odds snapshot fragility (`SNAPSHOT_AHEAD = 3h`)**
   - **Where:** [`src/elitetracker/predict/sync.py:42`](../src/elitetracker/predict/sync.py#L42), [`src/elitetracker/predict/sync.py:206`](../src/elitetracker/predict/sync.py#L206), [`src/elitetracker/predict/sync.py:346-350`](../src/elitetracker/predict/sync.py#L346-L350)
   - **Issue:** Odds are only snapshotted within 3 hours before kick-off from `https://elitetracker.no/data/report.json`. A GitHub Actions cron delay/outage or transient fetch error permanently renders a match `unscorable` (zero points, broken streaks).
   - **Suggestion:** Widen `SNAPSHOT_AHEAD` (e.g., 24–48 h, continuously refreshing until kick-off so the final pre-kickoff snapshot is kept), persist `locked_odds.json` even if a later Firestore batch fails, and support a local fallback report path.

2. **Shadow crowd signal look-ahead bias**
   - **Where:** [`docs/predict-plan.md:429`](../docs/predict-plan.md#L429), [`src/elitetracker/predict/sync.py:234`](../src/elitetracker/predict/sync.py#L234), [`src/elitetracker/predict/sync.py:241`](../src/elitetracker/predict/sync.py#L241), [`src/elitetracker/predict/sync.py:258-274`](../src/elitetracker/predict/sync.py#L258-L274)
   - **Issue:** The plan specifies testing the snapshot the job *could have shipped* before kick-off, but `sync.py` aggregates picks *after* kick-off (including picks submitted in the final minutes after the last hourly run).
   - **Suggestion:** Record a pre-kickoff shadow snapshot during the last run before kick-off alongside (or separate from) the final locked crowd aggregate.

3. **Streak mismatch & false drops**
   - **Where:** [`public/predict.js:1057`](../public/predict.js#L1057), [`public/predict.js:1307-1325`](../public/predict.js#L1307-L1325), [`src/elitetracker/predict/boards.py:104`](../src/elitetracker/predict/boards.py#L104)
   - **Issue:** `predict.js` treats a round as finished 3 hours after `last` kick-off (`roundStatus === 'done'`), whereas `boards.py` waits until `settled >= matches`. Between full-time and the next hourly sync, the UI falsely displays a broken streak (or spent freeze). Moreover, `streakNow()` picks the higher streak across both divisions and displays it in the division-specific side panel.
   - **Suggestion:** Compute streak per division (`streakFor(league)`) and only count rounds whose `reveal` / `stats` confirm the round has been scored (or have the job write `streak` directly into `stats/{uid}`).

4. **Early-rescheduled / postponed matches break `roundStatus` & `currentRoundIndex`**
   - **Where:** [`src/elitetracker/predict/sync.py:80`](../src/elitetracker/predict/sync.py#L80), [`src/elitetracker/predict/sync.py:112-113`](../src/elitetracker/predict/sync.py#L112-L113), [`public/predict-util.js:55-60`](../public/predict-util.js#L55-L60)
   - **Issue:** `closes` is `min(kickoff)` and `last` is `max(kickoff)`. If one match in Round 5 is played 3 weeks early, `roundStatus` marks Round 5 `live` ("Playing" with pulsing red dot) for 3 weeks, and `currentRoundIndex` keeps landing on Round 5.
   - **Suggestion:** Distinguish partially started rounds (`partial`) from actively `live` ones (a match within `[kickoff, kickoff + 3h]`), and select `currentRoundIndex` by the earliest round with upcoming open matches.

5. **History pagination truncation & duplicate Firestore reads**
   - **Where:** [`public/predict-api.js:352`](../public/predict-api.js#L352), [`public/predict.js:880`](../public/predict.js#L880), [`public/predict.js:1332`](../public/predict.js#L1332)
   - **Issue:** `client.list(..., 100)` never follows `nextPageToken`, silently truncating history past 100 rounds (mid-Season 2). Meanwhile `loadHistory()` and `calibration()` independently list `entries` and fetch `reveal/*`.
   - **Suggestion:** Add `nextPageToken` pagination to `client.list()`, and share a single history loader/cache between Playing Style and Calibration.

6. **Spark quota, abuse hardening & minor math/data fixes**
   - **Report flooding:** `reports/{randomId}` ([`firestore.rules:175-182`](../firestore.rules#L175-L182), [`public/predict.js:809`](../public/predict.js#L809)) lets a single user create unlimited reports, and `_boards()` reads all `reports` on every board rebuild ([`sync.py:385`](../src/elitetracker/predict/sync.py#L385)). Key reports as `reports/{nickKey}_{uid}` to cap one report per reporter per target.
   - **Purge write amplification:** `purge_user()` ([`sync.py:478-479`](../src/elitetracker/predict/sync.py#L478-L479)) writes a delete to `leagues/{code}/members/{uid}` for *every* league even if the user never joined. Track joined leagues on `users/{uid}` or query memberships instead.
   - **Full-collection scans:** `_boards()` reads all `users`, `stats`, `leagues`, and `members` on every scoring run, and `_inactive()` reads all `users` + `stats` daily ([`sync.py:380-386`](../src/elitetracker/predict/sync.py#L380-L386), [`sync.py:488-494`](../src/elitetracker/predict/sync.py#L488-L494)). Document the ~2,000–3,000 active-user Spark ceiling and consider running the inactivity sweep weekly.
   - **Shared-browser draft leak:** `draftKey(null, key)` ([`public/predict.js:124`](../public/predict.js#L124), [`public/predict.js:130`](../public/predict.js#L130)) ignores `uid`, leaking drafts across accounts on a shared browser.
   - **Rounding & season rollover:** Use largest-remainder rounding for `crowd.json` `h/d/a` tenths so they sum to `100.0` ([`sync.py:266-267`](../src/elitetracker/predict/sync.py#L266-L267)); handle `current_season()` rollover in [`predict_sync.py:50-51`](../src/elitetracker/predict_sync.py#L50-L51) so late-season/table scoring is not skipped; deduplicate `beatShare()` between [`public/predict-util.js:176-179`](../public/predict-util.js#L176-L179) and [`public/predict.js:799`](../public/predict.js#L799) and fix its `-1` offset for small `N`.

---

## 4. P1/P2 — UI, UX & Accessibility Improvements

### Tip Screen & Match Cards
- **Withdraw / clear pick:** `firestore.rules:51` already permits withdrawing a pick before kick-off, and skipping = 0 is central to the scoring rule, yet the UI has no way to clear an open pick.
- **Prevent accidental picks on mobile scroll/tap:** `pointerdown` ([`public/predict.js:418`](../public/predict.js#L418)) immediately jumps the slider and commits a draft; require horizontal drag intent (or a small movement threshold) on untouched cards.
- **Always-visible H/D/A readout:** Narrow segments lose their labels via `labelFits()`, forcing users into Fine-tune just to read exact percentages. Show a compact `H / D / A` readout on every card.
- **Quick round picker:** Add a round selector dropdown or strip (with status and tipped counts) so users do not have to click `‹` 20 times to inspect earlier rounds.
- **Keyboard confirmation on untouched `37 / 26 / 37`:** Allow keyboard users to confirm the neutral `37 / 26 / 37` pick without nudging away and back.
- **Round recap fixes:** In `recapOf()` ([`public/predict.js:492-508`](../public/predict.js#L492-L508)), use `Object.keys(record.fixture.slots).length` as `total` (not `Object.keys(reveal).length`), surface round Accuracy (`ab`), wire up the unused `predict.recap.best` string, and add visual share cards via `share.js`.
- **Clearer waiting states:** Distinguish `"awaiting next hourly update"` (`!reveal`) and `"fewer than 5 players tipped"` (`!reveal.crowd`) from `"your score against the field follows with the next update"` ([`public/predict.js:477`](../public/predict.js#L477), [`public/predict.js:480-484`](../public/predict.js#L480-L484)).

### Table Game
- **Surface scored table results & leaderboard:** `sync.py:306-322` and `429-452` already compute `stats/{uid}.tables.{key}` and `boards/tables_{key}`, but none of it is rendered in the UI.
- **Mid-season live checkpoints:** Show "your table vs current standings" during the season (as planned in [`docs/predict-plan.md`](../docs/predict-plan.md)).
- **Draft persistence & accessibility:** Save unsaved table order drafts to `localStorage`; preserve focus on `↑`/`↓` clicks instead of replacing the entire `<ol>` ([`public/predict.js:695`](../public/predict.js#L695)); distinguish `"You did not enter"` from `"Your saved order"` when closed.

### Boards & Mini-Leagues
- **Sorting & navigation:** Add column sorting (Accuracy RPS, Avg Brier, Avg RPS, Streak) and a `"Jump to my row"` button.
- **Mobile columns:** Allow viewing extra columns on `< 640px` via horizontal scroll or a compact toggle instead of hiding them with `display: none`.
- **Correct empty/rank copy:** Fix `percentileNote()` ([`public/predict.js:797`](../public/predict.js#L797)) using `predict.board.notyet` (`"This board is not built yet."`) when the board exists and only the player has 0 scored matches. Reconcile the rank discrepancy between the table (`row.rank` includes Model & Crowd, [`public/predict.js:783`](../public/predict.js#L783)) and the side panel (human-only rank, [`public/predict.js:1035`](../public/predict.js#L1035)).
- **Report UX:** Add `confirmable()` confirmation to the nickname report button and raise its hit target from `32px` to `44px` ([`public/predict.css:266`](../public/predict.css#L266)).
- **Mini-league ergonomics:** Persist memberships in Firestore (so they follow Google sign-in across devices), add a **Copy invite code / `?join=CODE` link**, and expose **Leave league** (`firestore.rules:200` already allows deleting `members/{uid}`).
- **Historical browsing:** Allow browsing past rounds and past seasons.

### Side Panel & Mobile Ergonomics
- Below `960px` ([`public/predict.css:551-558`](../public/predict.css#L551-L558)), the bell curve, form chart, stats grid, and badges are hidden via `display: none`, making the bell curve unreachable on phones while the remaining strip pushes match cards down on every tab. Make it a compact collapsible card on mobile (and/or surface the bell curve under "Me").

### Me / Playing Style / Calibration
- **Sign out button:** `client.signOut()` exists in [`public/predict-api.js:383`](../public/predict-api.js#L383) but has no UI for Google-linked accounts.
- **Calibration chart polish:** Upgrade `calibrationChart()` ([`public/predict.js:1355-1364`](../public/predict.js#L1355-L1364)) with axis ticks (`0%`, `50%`, `100%`), axis labels, and hover/tap tooltips showing bin sample size `n` (matching [`public/app.js:6586-6607`](../public/app.js#L6586-L6607)).
- **Season filter & tip refresh:** Add a season filter to Playing Style (`loadHistory()` currently mixes all seasons), and refresh the cached side-panel tip (`predict.tip.{uid}`) when new rounds settle.

### Site Integration, Copy & CSS Cleanup
- **Discoverability:** `/predict/` is currently linked only in the footer ([`public/index.html:468`](../public/index.html#L468)); add a tasteful entry point in the main nav or Overview (without leaking model odds into `/predict/`).
- **Theme toggle & locale sync:** Add a light/dark theme toggle to `/predict/`'s top bar ([`public/predict/index.html:37-43`](../public/predict/index.html#L37-L43)), and sync `setLanguage()` back to `users/{uid}.locale` when signed in.
- **English percentage spacing:** Fix `{pct} %` vs `69.2%` inconsistency in [`public/i18n.js`](../public/i18n.js) (lines 1093, 1115, 1128–1132, 1148, 1176, 1217, 1221, 1223, 1254–1255 vs [`public/predict-util.js:28`](../public/predict-util.js#L28)).
- **CSS deduplication:** Consolidate overridden rules in [`public/predict.css`](../public/predict.css) (`.pnav` lines 41/48/415, `.phow` 68/428, `.pcard__bar .odds__seg` 121/132, `.pside__medal` 501–508, `.pside__form` 532/539).

---

## 5. Privacy, Security & QA Gaps

- **Unresolved privacy checks:** Resolve the two `<!-- CHECK before publishing -->` comments in [`public/personvern.html`](../public/personvern.html) (lines 54, 58, 97, 101) covering Google-script wording and the 13-year age limit.
- **24-month deletion & `hidden` copy:** Reconcile the 24-month inactivity promise in `personvern.html` ("without Google link and email") with the fact that `predict-sync` does not yet delete Firebase Auth records ([`docs/predict.md:85-87`](../docs/predict.md#L85-L87)), and clarify in the UI that `hidden` hides your name from *public* boards while mini-leagues still show your nickname ([`sync.py:421`](../src/elitetracker/predict/sync.py#L421)).
- **Mobile audit coverage:** Add `/predict/` (all tabs + slider at 360/375/390/430/1280 px) to [`experiments/mobile-audit/check.py`](../experiments/mobile-audit/check.py).
- **CI emulator coverage:** Add a CI workflow step running [`tests/test_firestore_rules.py`](../tests/test_firestore_rules.py) and [`tests/test_predict_emulator.py`](../tests/test_predict_emulator.py) against the Firebase emulator (currently skipped unless invoked manually).

---

## 6. Prioritized Roadmap

| Priority | Item | Effort | Primary Files |
|---|---|---|---|
| **P0** | Preserve `predict.session` in `resetLocal()` & clear all user state | S | `public/predict.js` |
| **P0** | Prune locked slots from drafts & flush open slots in `live` rounds | S | `public/predict.js` |
| **P0** | Rebuild mini-league boards on membership/league changes + keep invite code visible | M | `src/elitetracker/predict/sync.py`, `public/predict.js` |
| **P0** | Direct "Sign in with Google" on signed-out Me tab | S | `public/predict.js` |
| **P0** | Fix case-only nickname updates | S | `public/predict-api.js` |
| **P0** | Fix premature `calibration()` caching | S | `public/predict.js` |
| **P0** | Stop resetting `pos.k` when collapsing Fine-tune | S | `public/predict.js` |
| **P0** | Re-render on delete & handle `CREDENTIAL_TOO_OLD_LOGIN_AGAIN` | S | `public/predict.js` |
| **P0** | Lock `ensureAccount()` & update `S.profile.club` in memory | S | `public/predict.js` |
| **P0** | Fix substring false positives (`"hore"` / `Thore`) in nickname filter | S | `src/elitetracker/predict/nicknames.py`, `public/predict-core.js` |
| **P1** | Widen `SNAPSHOT_AHEAD` & decouple `locked_odds.json` save | M | `src/elitetracker/predict/sync.py` |
| **P1** | Record pre-kickoff shadow crowd snapshot (no look-ahead bias) | M | `src/elitetracker/predict/sync.py` |
| **P1** | Fix per-division streak & sync-aware round completion | M | `public/predict.js`, `src/elitetracker/predict/sync.py` |
| **P1** | Handle early-rescheduled matches in `roundStatus` & `currentRoundIndex` | M | `public/predict-util.js`, `src/elitetracker/predict/sync.py` |
| **P1** | Paginate `client.list()` & unify history/calibration cache | M | `public/predict-api.js`, `public/predict.js` |
| **P1** | Deduplicate reports (`reports/{nickKey}_{uid}`), optimize `purge_user()`, fix `draftKey(uid)` | M | `firestore.rules`, `public/predict.js`, `src/elitetracker/predict/sync.py` |
| **P1** | Resolve `personvern.html` `[CHECK]` items & Auth deletion gap | S | `public/personvern.html`, `docs/predict.md` |
| **P2** | Withdraw pick, mobile drag threshold, always-visible readout, quick round picker | M | `public/predict.js`, `public/predict.css` |
| **P2** | Table game results/leaderboard, live checkpoints, draft persistence, focus fix | L | `public/predict.js`, `public/predict.css` |
| **P2** | Board sorting, jump-to-me, mobile extra columns, mini-league invite links & leave | M | `public/predict.js`, `public/predict.css` |
| **P2** | Mobile collapsible side panel, Sign out button, upgraded calibration chart | M | `public/predict.js`, `public/predict.css` |
| **P2** | Main-site nav link, theme toggle, English `%` spacing, CSS cleanup | S | `public/index.html`, `public/predict/index.html`, `public/i18n.js`, `public/predict.css` |
| **P3** | Add `/predict/` to `mobile-audit/check.py` & emulator tests to CI | M | `experiments/mobile-audit/check.py`, `.github/workflows/` |
