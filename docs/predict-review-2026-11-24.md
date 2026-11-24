# Predict Pre-Merge Review (2026-11-24)

**Branch:** `predict`  
**Test status:** `523 passed, 37 skipped` (Python, emulator tests skipped without `FIRESTORE_EMULATOR_HOST`), `172 passed` (Node: `tests/frontend.test.js`, `tests/predict.test.js`, `tests/predict-ui.test.js`).  
**Verdict:** **Not ready to merge and publish yet.** There are **4 P0 launch blockers** (3 in CI/backend that will break live scoring on `main`, and 1 in the tutorial → Google sign-in flow) plus **1 mandatory manual Firebase deploy** before merging.

---

## 1. P0 — Launch Blockers

### 1.1 First CI run will silently discard `locked_odds.json`, making matches unscorable
- **Where:** `.github/workflows/predict.yml` (lines 75–82)
- **Root cause:** Line 75 checks `if git diff --quiet -- data/predict public/predict/rounds.ics`. `git diff` ignores untracked files. None of `data/predict/*` or `public/predict/rounds.ics` are tracked in git yet. On the first live run (and any later run that creates a new file such as `locked_tables.json` or `shadow.json`), `git diff --quiet` exits `0` (`"Nothing to commit."`) and discards the snapshotted model odds. After kick-off, those matches are permanently `unscorable`.
- **Fix:** Check untracked files as well:
  ```bash
  if [ -z "$(git status --porcelain -- data/predict public/predict/rounds.ics)" ]; then
    echo "Nothing to commit."
    exit 0
  fi
  ```

### 1.2 Duplicate writes to the same document in one Firestore `documents:commit` batch
- **Where:** `src/elitetracker/predict/sync.py` (lines 240–250, 376–384, 406–432)
- **Root cause A (`meta/sync`):** Real Firestore `documents:commit` rejects a batch containing multiple write operations targeting the same document path (`400 INVALID_ARGUMENT`). On the first live run (~60 rounds), `sync.py` appends 60+ separate `Write.merge("meta/sync", ...)` operations into `writes` (lines 243, 250), plus `indexed` (line 377), `standings` (line 384), and `meta_updates` (line 432). The in-memory fake and emulator did not catch this.
- **Root cause B (`boards/*` on deletion + scoring):** When `stripped` is non-empty in the same run that scores change, `_boards()` appends `Write.set("boards/...", new_board)` (line 407) and then `_strip_boards()` reads the stale pre-commit boards from Firestore and appends a second `Write.set("boards/...", ...)` (line 421) for the same document — failing the commit or overwriting the newly scored board with stale data.
- **Fix:**
  1. Accumulate all `meta/sync` updates (`fixtures`, `tablegames`, `indexed`, `indexed_settled`, `scored`, `revealed`, `model_rounds`, `crowd_rounds`, `tabled`, `joins`, `swept`) into `meta_updates` and emit a single `Write.merge("meta/sync", meta_updates)` at the end.
  2. Pass the set of board IDs already rebuilt by `_boards()` (available in `summary["boards"]`) to `_strip_boards()` so it skips them and only strips boards `_boards()` did not rewrite (e.g., past-season boards and `tables_*`).

### 1.3 `rounds.ics` triggers 24 commits + 24 full site deploys per day for an unlinked file
- **Where:** `src/elitetracker/predict/ics.py` (line 43), `.github/workflows/predict.yml` (lines 75–82), `.github/workflows/deploy.yml` (lines 20–21)
- **Root cause:** Commit `1bd280a` removed the calendar button from the UI (nothing in `public/` links to `rounds.ics`). Meanwhile, `ics.py` writes `DTSTAMP:{_stamp(now)}` on every hourly run. Once `rounds.ics` is tracked, it changes every hour → `predict.yml` commits with `REFRESH_PAT` every hour → `deploy.yml` (which only ignores `data/predict/**`) rebuilds and redeploys Firebase Hosting 24 times a day.
- **Fix:** Either stabilize `DTSTAMP` (e.g., derive it from `doc['closes']` or only rewrite `rounds.ics` when the event list/details actually change) or stop generating/committing `rounds.ics` until it is linked in the UI again.

### 1.4 New Google sign-ins from Tutorial Step 8 or signed-out Me tab fail to save profile/nickname/settings
- **Where:** `public/predict.js` (lines 2222, 2272–2341, 2584–2596), `firestore.rules` (lines 149–165)
- **Root cause:** Tutorial Step 8 recommends signing in with Google before tipping. `switchToGoogle` creates a Firebase Auth session (`client.uid` is set) without creating `users/{uid}` (`S.profile` is `null`). If that user opens **Me** to set a nickname, toggle `hidden`, or pick a favourite club before tipping a match, `nicknameChangeWrites` / `profileUpdateWrites` sends a partial `writeMerge` missing required fields (`created`, `locale`, `hidden`, `nickAt`, etc.). `firestore.rules` rejects the document `create` with `403 denied`, and the nickname UI displays the misleading error `"That name is taken, or you changed it less than 30 days ago."`
- **Fix:** Ensure `users/{uid}` exists before any profile/nickname/settings write on the Me tab (e.g., call `await ensureAccount()` before committing in `profileSection` / `settingsSection`, or create the default profile in `switchToGoogle` when `users/{uid}` does not exist).

### 1.5 Mandatory manual Firebase deploy before merging
- **Where:** `docs/predict.md` (line 131), `firestore.rules`, `firestore.indexes.json`
- **Requirement:** Redeploy `firebase deploy --only firestore:rules,firestore:indexes` before merging `predict` into `main`. Otherwise `1%` fine-tune picks, `meta/standings`, `users.leagues`, new report IDs (`{nickKey}_{uid}`), and instant mini-league board builds (`members.joined` index) will fail in production.

---

## 2. P1 / P2 — Bugs & Edge Cases

1. **Script load retry crashes with `SyntaxError`**
   - **Where:** `public/app.js` (lines 10961–10965)
   - **Issue:** If `/predict.js` fails to load after `/predict-core.js` has already executed, `loadPredict()`'s `.catch()` removes all `<script>` elements and clears `predictScripts`. Clicking Retry re-executes `/predict-core.js` and throws `SyntaxError: Identifier 'FROZEN_CURVE' has already been declared`, breaking Predict until a full page reload.
   - **Fix:** Track loaded vs. failed scripts individually; only remove and retry scripts that failed to load.

2. **Overview Predict card ignores `live` / `partial` rounds**
   - **Where:** `public/app.js` (line 4267)
   - **Issue:** `upcoming` only matches `['open', 'future']`. When an early match has kicked off (`partial`) and remaining matches in the round are still open to tip, the Overview card falls back to the end-of-season `calm` summary instead of prompting the user to finish tipping.
   - **Fix:** Include `'partial'` (and `'live'` if any slots remain open) when checking for open matches in `loadOverviewPredict()`.

3. **Mini-league 20-league cap & duplicate-join error handling**
   - **Where:** `public/predict.js` (lines 1681–1701)
   - **Issue A:** Joining or creating a 21st league hits `firestore.rules`'s `nw.leagues.size() <= 20` limit with `403 denied`, showing the generic `"Not allowed: the match may have started, or the round is closed."` Furthermore, `create` commits `leagues/{code}` (line 1682) before `joinWrites` (line 1683), leaving an orphaned empty league if `joinWrites` fails.
   - **Issue B:** Joining a league you are already a member of attempts `writeSet` on an existing `leagues/{code}/members/{uid}` (`create`-only in `firestore.rules`), failing with the same misleading `403` error.
   - **Fix:** Check `profileLeagues().length >= 20` and `profileLeagues().includes(code)` client-side with clear messages, and combine `leagueCreateWrites` + `joinWrites` (or guard before creating `leagues/{code}`).

4. **3-player mini-league renders an empty table under the podium**
   - **Where:** `public/predict.js` (lines 1574–1581)
   - **Issue:** When a mini-league has exactly 3 players (and no Model/Crowd rows), all 3 rows move to `onPodium`, leaving an empty `<table>` header with 0 rows underneath.
   - **Fix:** Hide the `.pscroll` table wrapper when `rows.length === 0 && !sort`.

5. **Leaderboard season picker lists pre-launch seasons**
   - **Where:** `public/predict.js` (line 1385)
   - **Issue:** `[0, 1, 2, 3].map((back) => current - back)` offers `2025`, `2024`, `2023`, which have no boards and waste a Firestore read.
   - **Fix:** Filter seasons to `>= 2026` (the launch season).

6. **`resetLocal()` leaves stale tip/card caches**
   - **Where:** `public/predict.js` (lines 2652–2658)
   - **Issue:** `S.tipTried` is not reset (skipping tip refresh if a switched account has the same `statsTotalN()`), and `sessionStorage.removeItem('predict.card')` is not called.
   - **Fix:** Reset `tipTried: undefined`, `tipRefreshing: false` in `resetLocal()`, and clear `sessionStorage` `predict.card`.

7. **Mobile audit script only tested the tutorial on `predict`, `predict:table`, and `predict:how`**
   - **Where:** `experiments/mobile-audit/check.py` (lines 252–255)
   - **Issue:** `check.py` does not set `localStorage.setItem('predict.intro', 'seen')` (unlike `tests/test_predict_browser.py:78`), so `predict`, `predict:table`, and `predict:how` all rendered the tutorial overlay instead of the actual match cards, sticky `.pnav` bar, Fine-tune inputs, draggable table game, or guide.
   - **Fix:** Set `predict.intro` to `'seen'` in `check.py` (and optionally add a separate `predict:tutorial` view if the tutorial should also be audited), then re-run `experiments/mobile-audit/check.py`.

8. **Side-panel `bellChart` `aria-label` uses wrong division on fallback**
   - **Where:** `public/predict.js` (line 2042)
   - **Issue:** Uses `LEAGUE_NAME[S.league]` even when `sidePanel(season, league)` fell back to the other division because the selected division has 0 scored matches.
   - **Fix:** Pass `league` into `bellChart` and use `LEAGUE_NAME[league]`.

9. **i18n & copy polish**
   - **English `%` spacing:** `public/i18n.js` lines 1236 (`predict.board.key`), 1289 (`predict.how.s5.text`), 1324 (`predict.tut.points.text`) have `100 %` instead of `100%`; `public/app.js` lines 4489 and 4521 use `${fixed(..., 1)} %` instead of `percentText(..., lang(), 1)`.
   - **Hardcoded Norwegian board names:** `src/elitetracker/predict/boards.py` line 29 stores `MODEL_NAME = "Modellen"` and `CROWD_NAME = "Folket"` in Firestore, so English users see `Modellen [Model]` and `Folket [Average]`. (Optional: localize display name on the client by `row.kind`.)
   - **Playing Style trait units:** `public/i18n.js` lines 1369–1370 (`{v} points more/less`) and 2778–2779 (`{v} poeng mer/mindre`) collide with game points (`10 × (1 − Brier)`). Prefer `percentage points` / `prosentpoeng` (matching `predict.side.next`).

10. **2026 OBOS-ligaen `unscorable` log noise**
    - **Where:** `src/elitetracker/predict/sync.py` (lines 388–395)
    - **Issue:** Because OBOS-ligaen 2026 is already finished (`240/240` played) with no `locked_tables.json`, every hourly run logs `"table:2026_obosligaen"` in `summary["unscorable"]` until 2027 fixtures arrive (harmless, zero extra reads).

---

## 3. UX & Clarity Issues

1. **8-step mandatory tutorial has no Skip button & Step 7 has premature copy**
   - **Where:** `public/predict.js` (lines 2202–2268), `public/i18n.js` (lines 1326, 2735)
   - **Issue:** First-time visitors (and returning users on a new browser/cleared storage before signing in) are blocked from seeing matches until they complete 8 steps and 3 gated interactive actions (`drag`, `fine-tune`, `pick a result`). `leave` is only rendered when `S.replay` is true. Additionally, Step 7 (`predict.tut.table.text`) says *"You have seen it all: time to tip."* even though Step 8 (*Sign in to play*) is next.
   - **Fix:** Offer a subtle Skip button on first visit (setting `predict.intro = 'seen'`), and adjust Step 7's closing line.

2. **Hidden / rank 201+ players get no percentile feedback on `Round` and `Last 10` boards**
   - **Where:** `public/predict.js` (line 1624)
   - **Issue:** `percentileNote()` returns early unless `S.scope === 'season' || S.boardAll`, so hidden players or players ranked below #200 see no personal summary on `Round` or `Last 10` boards.

---

## 4. Firestore Spark Capacity Analysis

Spark free-tier limits: **50,000 reads/day**, **20,000 writes/day**, **20,000 deletes/day**, **1 GiB storage**, **10 GiB/month egress**.

### Current Bottlenecks ($U$ = active players)
- **Daily Reads (~30–40 × $U$):** **~1,200–1,600 active users** ceiling on a staggered matchday.
  - `_boards()` lists **all** `users` + `stats` + `leagues/*/members` on every hourly run a match settles (often 3× on a staggered Sunday).
  - `_inactive()` lists **all** `users` + `stats` daily.
  - `rounds` collection-group queries run per distinct kick-off (`shadow.json`, `crowd.json`, scoring).
  - Dormant anonymous accounts accumulate in `users` for 24 months, consuming 2 reads per scoring run even when inactive.
- **Daily Writes (~9–11 × $U$):** **~1,800–2,200 active users** tipping on the same matchday (700 ms debounce + multiple `stats/{uid}` updates per staggered round).
- **Storage (1 GiB):** **Hidden 10× auto-index tax.** `firestore.indexes.json` currently has no single-field exemptions for `rounds.p` (48 leaf fields/round × 2 index entries ≈ 9 KB/round vs ~0.7 KB raw) or `stats.rounds` (420 leaf fields/season × 2 ≈ 75 KB/season vs ~5.5 KB raw). That puts 1 GiB at **~1,500–3,000 users** in Year 1 instead of **~15,000+ users**.

### Recommended Capacity Fixes
1. **Exempt `p` (collection `rounds`) and `rounds` (collection `stats`) from single-field indexing** in `firestore.indexes.json` (neither map's subfields are ever queried). Deploy with `firebase deploy --only firestore:indexes`.
2. **Run `_inactive()` weekly** instead of daily (saves `2 × total_users` reads/day).

---

## 5. Future Expansion & Data Longevity

- **Already future-proof:**
  - `entries/{uid}/rounds/{key}` stores resolved whole percents `(h, d, a)` alongside `(g, k)` and `curve: 1`, so changing the slider curve (`curve: 2`) or scoring rules never invalidates or rescores historical picks.
  - `stats/{uid}` stores raw sufficient stats (`n, b, r, ab, ar, vm, m`) including both Brier and RPS, enabling new leaderboards, badges, or points formulas without re-reading `entries/`.
  - `data/predict/locked_odds.json` + pre-kickoff `shadow.json` + final `crowd.json` cleanly support walk-forward testing of `model/crowd.py` before bumping `MODEL_VERSION`.
  - Stable `s1..s8` slots mapped to permanent FotMob `match_id`s keep `fixtures/*` and `reveal/*` joinable long-term.
- **Caveats for future changes:**
  1. **Mini-league boards overwrite across seasons:** `sync.py` (line 559) writes `boards/league_{code}` using only `this_season = f"{season}_"`. When 2027 starts, 2026 mini-league standings will be overwritten unless keyed by season (e.g., `boards/league_{season}_{code}`) or archived.
  2. **Hardcoded `s1..s8` & two divisions:** `firestore.rules` hardcodes `s1..s8` and `nw.curve == 1`; `sync.py`, `predict.js`, and `app.js` hardcode `['eliteserien', 'obosligaen']`. Expanding to cup rounds, play-offs, or new tip formats will need a rules update (or a new subcollection).
  3. **`public/predict.js` size:** At ~2,790 lines in one IIFE, splitting by tab/module before adding major new modes is recommended.
