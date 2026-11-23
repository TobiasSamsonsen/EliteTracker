# Predict: a prediction game that sharpens the odds

Status: plan; phases 0 and 1 and most of phase 2 are built and tested but not live (2026-11-23, see
`predict.md` for what exists and "Going live" for what waits on the owner; section 0b below lists where
the build departs from this text). Revised 2026-11-23 after the owner's answers.
Nothing here changes a published number until the shadow phase (section 6)
says it should.

## 0. Decided

| Question | Decision |
|---|---|
| Section or subdomain | A section: `/predict/`, same origin as the site (theme, language, own club, consent carry over) |
| Name | **Predict** (nb and en) |
| Backend | Firebase, project `elitetrackerno`, on the free **Spark** plan; no server of our own |
| Divisions | Eliteserien and OBOS-ligaen from day one |
| Accounts | Anonymous first, upgrade with **Google** after the first reveal |
| Pre-season | A final-table game from the December play-offs to the opener |
| Entry | A slider that moves the odds bar of the Kamper view; a **Fine-tune** button turns it into a double slider (section 2) |
| Rounds open | 7 days before the round's first kick-off |
| Table game | Club order, scored by distance, with bonus points for the champion (promotion in OBOS-ligaen) and the relegation places |
| Retention | Picks and per-round scores while the account is used; after 24 months of inactivity they are deleted, the final season scores stay (section 7) |
| Firestore | Does not exist yet: created in phase 0 in `europe-north1` (Finland, nearest Norway), Native mode (section 4, "Console setup") |
| Scoring | FFI's Brier + "Accuracy against the median" (section 5) |
| Launch | The 2027 opener (late March / early April; check NFF's calendar); build over the winter |

## 0b. As built: where the code departs from the plan below

The plan text below is kept as the reasoning; the data model it shows changed in building. `predict.md` is the lookup.

- **Entries:** `entries/{uid}/rounds/{season}_{league}_{round}`, and a slot is a map
  `p.sN = {g, k, h, d, a, t}` (not an array), because a server timestamp can only be
  written to a field path, not an array index. Each document also carries `r` (the round
  key, so one collection-group query finds a round's picks; indexed in
  `firestore.indexes.json`) and `curve` = 1. Table picks: `tables/{uid}/picks/{key}`; the job writes `tablegames/{key}`.
- **No client deletes** of entries or tables: deleting a bad pick before it is scored
  would dodge the score. A player writes `deleteRequests/{uid}`; the job erases everything
  (and strips board rows), and the browser deletes the Auth account.
- **Cheap reads:** the job also writes `meta/rounds` (the round index) and `reveal/{key}`
  (the model's locked odds, the crowd aggregate, the result), so a page load reads ten
  small documents, not a collection.
- **The median** in "Accuracy against the median" needs every player's pick, which the
  browser cannot see. The reveal shows Brier, RPS and the score against the model at once
  (from `reveal/`), and the median-based Accuracy once the next job run has published it
  (`crowd.json` `med`, shown only for matches with at least five players).
- **Rules** are hand-written with one helper called for each of the eight slots (there was
  nothing for a generator to generate) and tested in the emulator with plain `urllib`: it
  takes `Bearer owner` and unsigned JWTs, so `@firebase/rules-unit-testing` (a new
  dependency) was not needed. Server timestamps on map fields and the rule's `t == request.time`
  were checked there. Two rules-language limits shaped the nickname rules: `lower()` is
  ASCII-only (the three Norwegian capitals are lowered by hand) and non-ASCII path segments
  fail in `existsAfter`, so a claim is keyed in ASCII (`~e ~o ~a`) and is valid only with the
  profile that uses it (no name squatting).
- **Workflow:** `predict.yml` is manual (dry run unless "live"), with no cron, until launch.
- **Frozen curve:** the game's constants live in `predict/curve.py` and `public/predict-core.js`
  (`CURVE_VERSION` 1); a test fails if the model's draw curve is refitted without a decision.

## 1. What the brief leaves out

1. **"Without telling them" cannot mean undisclosed.** `personvern.html` (nb +
   en) today promises nothing is stored server-side beyond consented GA. Accounts,
   nicknames and predictions need: controller, purposes, lawful basis,
   retention, deletion, processors (Google), art. 13 wording. One plain
   sentence covers the crowd use ("Anonymous, combined predictions help us
   improve the odds"); nothing in the game UI. The repo is public, so the code
   is visible anyway.
2. **No per-user data in git** (public repo; history cannot honour a deletion
   request). Git gets only anonymous per-match aggregates, hidden below 5
   predictions.
3. **Peeking.** The main site shows the model's odds on every fixture, so a
   player can look first. The filter therefore pools each player's *deviation
   from the model*, so a copier contributes about nothing instead of
   double-counting the model (section 6).
4. **Version rules.** Feeding the crowd into the odds is "new data the model
   reads": MAJOR (`AGENTS.md`), a `PROJECT_STATUS.md` entry with numbers, and
   the small-upgrade bar from memory (out-of-sample, both halves).
5. **No money.** Free, no cash or goods prizes, no bookmaker links (keeps it clear
   of Norwegian gambling and lottery rules).
6. **Dependencies (a case each, per AGENTS.md).** None planned. Browser: `fetch`
   against the Firebase REST APIs (the Firebase JS SDK would end the
   dependency-free `public/`). Python: `urllib` with an access token from
   `google-github-actions/auth` (Workload Identity, no key file); the filter uses
   the existing `numpy`. Google sign-in loads Google's own script on demand
   (section 4). Push notifications (phase 6) would be the one real dependency.
7. **Spark plan limits shape the design** (section 4): no Cloud Functions (we
   use none), and the free Firestore quota is counted per day (check the
   current numbers before launch: about 20,000 writes and 50,000 reads).
   Hence one document per player per round, not per match. Past the quota,
   writes fail until the daily reset; the escape is Blaze with a budget cap.
8. **Firestore's location is permanent once chosen**, and the project has no
   database yet. Create it in Native mode in `europe-north1` (Finland, nearest Norway; chosen
   2026-11-23) and check at creation that the location is covered by the free
   Spark quota. If it is not, fall back to `eur3`.

## 2. The player's loop

Cadence is the product: one league round a week, a reason to come back each
time.

```
round opens (7 days before its first kick-off)
  -> tip (under 30 s)           the commitment
  -> reminder, lineups          the trigger (opt-in)
  -> kick-off: locked, reveal   you vs model vs crowd, per match
  -> full time: your score      the variable reward
  -> round recap + share card   the investment and the spread
  -> next round opens
```

### The slider (the match card)

Each match card is the matches view's odds bar (`.odds` / `.odds__seg`, home
blue, draw, away red) with the player's own odds on it, moving live.

**Recommendation: one slider that follows the model's own curve, and a
second, optional one for draws.**

- **Slider 1, "who is stronger" (always shown).** Exactly the model page's
  figure: the control is the rating difference *Delta* (home advantage already
  added, as in `model.html`, where two equal clubs tilt to the home side), and
  the odds are `eloOdds(Delta)` (`expectedScore` and the draw curve). Dragging
  right grows the home segment and shrinks the away one; the draw segment
  swells near the middle and thins at the ends, because that is how the curve
  moves. You can drag anywhere across the bar itself (as the model figure's
  chart takes a drag) or use the range input (keyboard and screen readers get
  it free). Range -700..+700 in steps of 5 (widened from +-400 so a strong favourite can reach 96 / 2 / 2), the thumb 2.75 rem tall on a phone
  (the model page's rule), `touch-action: pan-y` on the bar so scrolling still
  works.
- **Slider 2, "draw tendency" (the "Fine-tune" button).** Each card shows one
  slider; Fine-tune on a card adds a second one under it, so the control becomes
  a double slider and both move the same bar. It is a multiplier on the curve's
  draw mass (about 0.5 to 1.8, step 0.1; 1.0 is the model's shape). It exists
  because one slider cannot say "this is a 0-0 kind of game". The choice of
  Fine-tune is remembered per player.
- **Why not two draggable boundaries on the bar?** With a 25 % draw the two
  handles sit a thumb apart and collide on a phone; they also allow
  incoherent forecasts (45 / 5 / 50). Cheap to add later as an expert mode.
- **Start position.** The generic even-clubs position, an average league
  match, not the model's number for this fixture. A card stays "untouched"
  (greyed, "Drag to tip") until the player moves it; untouched cards are not
  predictions. Moving the slider back to the middle is a real prediction.
- **Numbers.** The readout shows H / U / B in whole percent (decimal point,
  per AGENTS.md); each tap into the readout accepts typed numbers (comma read
  as a point), which re-derives the nearest slider position.

**A 7-day window.** Because a round opens a week ahead, picks can be old by
kick-off, and lineups (about an hour before) change what a good pick is. Every
changed slot carries its server timestamp, so the filter can discount old picks
(section 6); the card says "last changed 5 days ago" and an opt-in reminder can
say "lineups are out".

**What is stored.** The two slider values *and* the derived integer percentages
(sum 100, clipped to 2..96), with the time of the last change. The game's curve is a **frozen copy** of the model's
(a `curve` version number kept apart from `MODEL_VERSION`), so a later model
refit never rescores old picks; scores use the stored percentages.

**Entering a round (the 30-second rule).** One scrolling screen, 8 cards per
division with a division switch; no sign-up wall (the first pick silently
creates an anonymous account); every release of the slider saves (debounced,
the draft kept in the browser meanwhile); no submit button, a ring "5/8" and a
done state. Skipping a match costs nothing. Instant feedback that leaks
nothing: streak tick, "bold" or "safe" from the player's own numbers.

**Reveal (after kick-off, when the model and crowd are frozen).** Per match,
three bars stacked: yours, the model's, the crowd's; then the result and the
accuracy score ("+0.07 on the median, +0.04 on the model"). Round recap:
matches above the median, best call, boldest hit, percentile. Computed in the
browser as soon as the result is in the data (same scoring code as the
server, pinned by shared test vectors in `tests/frontend.test.js`); the board
follows with the next hourly run.

**Boards (FFI-style, section 5).** Season, round and rolling 10 rounds; columns:
rank, name, matches, Accuracy (Brier), Accuracy (RPS), average Brier, average
RPS, streak. The model and the crowd stand on the board as players: "can you
beat the model?" is the hook. Tiers and percentile badges, not only a
winner (a rank-only prize rewards extreme guesses). Names show only for the top
entries; players choose a display name and can opt out of public lists (as FFI
does). Private mini-leagues by invite code, no search or chat.

**Rituals.** Streak of completed rounds with a free freeze every fifth; a
calibration chart after 30 predictions ("when you say 70 %, it happens 66 %");
badges; a share card per round (`share.js`'s formats).

**Triggers, cheapest first.** A reminder on the main site's overview;
an `.ics` feed of "round closes" (no push infrastructure); Google sign-in
to keep the streak across devices (after the first reveal only); Web Push
last. FFI mails a coupon after each round; we have the Google address only
for those who sign in, so an email recap is optional and later.

### The pre-season table game

Opens when the 2027 divisions are known (the play-offs decide the last places;
early December) and closes at the first kick-off. One draggable list per
division (tap up/down for accessibility): put the 16 clubs in the order you
expect. The draft saves in the browser, then one document per player per
division.

**Scoring.** Against the final table after round 30 (play-offs do not move
places). The error is the sum of absolute place differences (a footrule), less
**bonus points** for the places that matter most, from the division's
`league.bands`:
- Eliteserien: the champion named right, and each of the two relegated clubs
  named (in either order);
- OBOS-ligaen: each of the two promoted clubs named (either order), and each
  of the two relegated.

Starting values: champion 6, a promotion place 4, a relegation place 3, the
numbers living in `predict/tables.py`. They are tuned before launch by scoring
many seasons from the model's own simulation (the bonuses should be a visible
but minor part of the spread of errors, about a tenth to a sixth). Then, as
for matches, **Accuracy = median error of all players and the model's expected
table minus yours** (positive: better than half; more bonus means less
error). Bonuses are in the rules text on the page and in the reveal ("champion
right: -6"). Checkpoints after a few rounds show
"your table vs the real one" for engagement; they are not scored. It doubles as a
shadow test of the season simulation (the crowd's table vs the model's), with
no effect on any published number.

## 3. Hosting decision

| | Firebase, Spark (chosen) | Self-host (`api/server.py` + SQLite on a VPS) |
|---|---|---|
| New moving parts | Firestore rules, one workflow | server, TLS, auth, rate limits, backups, patching |
| Lock at kick-off | rule compares server `request.time` with the fixture | handler code on your clock |
| Abuse | anonymous-auth throttling, rules, weight by track record | build all of it |
| Reads at scale | boards are one public document | you serve every request |
| GDPR | Google already your processor | new processor or your own breach duty |
| Cost | free quota; Blaze with a cap as the escape | VPS plus your time |

`api/server.py` is stdlib `http.server`: good for a dev preview, not for auth.
If Firestore is outgrown, Cloud Run + Postgres is the next step; only the CI
job reads the store, so the move is contained.

## 4. Architecture

```
browser (/predict/, REST + fetch; reuses styles.css, i18n.js, share.js, thumbs.js)
   | anonymous sign-in, write own round document, read own stats and boards
   v
Firestore  <--- rules: owner-only, valid values, every changed slot's kick-off in the future
   ^
   | hourly: predict.yml (REST, token via Workload Identity)
   |   1. sync fixtures docs from data/normalized (kick-off UTC, status, slot order)
   |   2. snapshot the model's published odds at lock -> data/predict/locked_odds.json (git)
   |   3. settled matches: score, medians, stats/{uid}, boards/*
   |   4. at kick-off: anonymous aggregate -> data/predict/crowd.json (git, n >= 5)
```

**Collections (sized for Spark).**
- `fixtures/{season}_{league}_{round}`: server-written; slots 1..8 with
  matchId, kickoff (timestamp), status.
- `entries/{season}_{league}_{round}_{uid}`: **one document per player per
  league round**, `p` = {slot: [g, k, h, d, a, t]}, `t` the server time of the
  last change. A save is one write however
  many matches changed, and scoring reads one document per player per round.
- `tables/{season}_{league}_{uid}`: the pre-season order; lock from a season
  fixture doc.
- `users/{uid}`: nickname, club, locale, public-list opt-out, notification
  choice; `nicknames/{lower}`: uniqueness. Nickname rules, the usual ones:
  3 to 20 characters, letters (including `æøå`), digits, spaces, `_` and `-`,
  unique ignoring case, a profanity check, the names "Modellen", "Folket" and
  the like reserved, one change every 30 days, a report link on every name on
  a board. The first nickname is a generated one (the player can start
  without choosing).
- `stats/{uid}` (server-written, owner-readable): totals, streak, calibration
  bins, badges. `boards/{scope}` (server-written, public): top 200 and a
  percentile table, one for each mini-league (`boards/league_<code>`).

**Rules that matter.** Only the owner reads or writes an entry, nobody reads
anyone else's pick (no herding, no leak). A write may change only slots whose
kick-off is still ahead and whose round has opened (7 days before), with `t`
equal to the request's server time; the rule file is generated, one explicit
check per slot, because rules have no loops. Values: integer percentages within the
clip, summing to 100; `g` in -700..700; `k` in range. A postponement is just a
kick-off changing in the fixture document. Tested in the Firestore emulator in
CI.

**Google sign-in without the SDK.** On the player's tap (never earlier) load
Google Identity Services, take the ID token and send it to the Identity
Toolkit REST endpoint **linking it to the existing anonymous account**, so the
uid, picks and streak stay. If that Google account already plays on another
device (a different uid), the player is asked which history to keep; no
silent merge. Only the nickname is public; the Google name, photo and address
stay in Firebase Auth. Disclosed on the privacy page (a Google script loads
on request; Google processes the sign-in).

**Console setup (phase 0, yours to click, or run with the Firebase CLI).**
1. Firestore: create the (default) database, Native mode, `europe-north1`
   (section 1, point 8), start in locked mode; `firestore.rules` and
   `firestore.indexes.json` join `firebase.json`, deployed from CI with
   `firebase deploy --only firestore:rules` (the hosting service account needs the
   rules-admin role added, or a second one is made).
2. Authentication: enable the Anonymous and Google providers; add the site's
   domain to the authorised domains.
3. Google sign-in: an OAuth consent screen (app name, the personvern URL as
   privacy policy) and a web OAuth client id for Google Identity Services.
4. The web API key is public by design; restrict it to the site's domain
   (HTTP referrers) and to the Identity Toolkit and Firestore APIs.
5. For `predict.yml`: a Workload Identity pool for the GitHub repo and a
   service account with only the Firestore data role (no key file).
6. A budget alert in Google Cloud for the day Blaze is ever switched on.

**Console state (2026-11-23, project `elitetrackerno`, number `914037628709`, Spark).**
- Firestore `(default)`, Standard, `europe-north1`, locked rules. Free quota
  (Firebase docs): 1 GiB stored, 50,000 reads, 20,000 writes and 20,000
  deletes a day. The per-location price page was not readable, so confirm
  that the quota shows for `europe-north1` in the Usage tab once data flows.
- Auth: Anonymous (auto clean-up off: it deletes accounts after 30 days) and
  Google, public name "EliteTracker"; `elitetracker.no` is an authorised domain.
- Web OAuth client `914037628709-in1bfopj4gpc1q53etu1qi79vtphhb9a` (public id,
  auto-created by Firebase): origins now include `https://elitetracker.no`.
  The consent screen's privacy URL and publishing status wait for phase 2;
  until published, only test users can link Google.
- Browser API key: kept its 27 API targets, now limited to referrers
  `elitetracker.no`, `elitetrackerno.web.app`, `elitetrackerno.firebaseapp.com`,
  `localhost` and `127.0.0.1`.
- Keyless CI identity: service account `predict-sync@elitetrackerno.iam.gserviceaccount.com`
  with only `roles/datastore.user`; Workload Identity pool `github`, provider
  `github-oidc` (`projects/914037628709/locations/global/workloadIdentityPools/github/providers/github-oidc`),
  admitting only repo `TobiasSamsonsen/EliteTracker`. The 24-month account
  deletion step will also need an Auth admin role on this account (add when
  that step is built). `firebase deploy --only firestore:rules` still needs a
  rules-admin role on the deploy account (`github-action-1328853316@`) or on a
  second one.
- `gcloud` is installed locally and logged in; the repo's deploy workflow still
  uses a stored key for Hosting, untouched.

**Model-odds snapshot at lock.** Archived reports are re-rated by later releases, so
the comparison is the odds as published at kick-off, stored with the
`MODEL_VERSION`.

**Repo layout (proposed).**
- `sources/firestore.py`: the only network code (`urllib`), beside the other
  fetchers (so "nothing below `pipeline.py` touches the network" holds).
- `predict/scoring.py`, `boards.py`, `streaks.py`, `tables.py`: pure. Reuse
  `ranked_probability_score` and the Brier loop from `model/backtest.py`
  (lift into one shared function; do not copy).
- `model/crowd.py`: the filter (pure, numpy).
- `predict_sync.py`: the workflow's command; `.github/workflows/predict.yml`
  (its own concurrency group; commits only `data/predict/**`, ignored by the
  deploy trigger while the crowd is shadow-only).
- `public/predict/index.html`, `predict.js`; `elo-curve.js` (`expectedScore`,
  `eloOdds` pulled out of `model.js` so both pages and the node tests share it);
  a Norwegian and English block in `i18n.js`.
- Tests: scoring vectors in Python and Node; the curve parity test already
  pinning `model.js` to the Python model; rule tests.
- Docs: `docs/architecture.md` (diagram), new `docs/predict.md`,
  `docs/operations.md` (the workflow), `docs/frontend.md`, `personvern.html`.

## 5. Scoring spec (after FFI's tournament)

FFI's page you linked (`/om-prosjektet/`) has no scoring text; the rules are on
its FAQ (`/sporsmal-og-svar/`). What it does, and what we take:

- **Brier**, 0 to 2, lower is better, over all outcomes of a question (their
  examples: a 100 % call on what happens is 0, on what does not, 2; 50/50 on a
  yes/no is 0.5). Ours: per match, Brier = sum over H, U, B of (p - 1 if it
  happened else p - 0) squared; a 40/30/30 call on a home win is 0.54.
- **Accuracy score** = *median of all participants' Brier scores on that
  question minus your Brier*. Positive means better than at least half the
  players. The goal is the highest Accuracy. Used for overall and for groups.
- Skipping is allowed; answering more only helps if you beat half. No other
  penalty. FFI does not state how the cumulative score is built; we **sum** the
  per-match Accuracy (unplayed counts 0) and also show the average per answered
  match.

Our additions, where football differs:
- **RPS** next to Brier, because H < U < B is an order. Same function as
  `model/backtest.py`: ((h - 1_H)^2 + ((h + d) - (1_H + 1_D))^2) / 2. Accuracy
  (RPS) is computed the same way. Headline rank: Accuracy (Brier), as FFI;
  RPS a click away.
- **The model is a voter in the median.** The reference median is taken over all
  players *and* the model's own locked-odds score, once. A new match with three
  players still has a sensible median, and the pull toward the model fades as
  the player count grows.
- **Versus the model** shown separately on the reveal and as a badge ("beat the
  model": model score minus yours).
- A match's scores freeze when it is settled (all picks are locked at kick-off,
  so the median never moves afterwards).
- Both are proper scores and the median reference does not depend on your own
  pick (up to your one vote), so the honest forecast is the best strategy.
  Rank-only prizes are not proper (tournament risk-seeking), hence tiers and
  percentiles.
- Table game: Accuracy = median footrule error of players and the model minus
  yours.

## 6. From crowd to odds

**Stages, each earning the next.**

1. **Shadow, no filter** (from the 2027 opener). Store and score the crowd.
   Compute, per match, the precision-weighted mean of players' deviations
   from the locked model, shrunk toward 0. Walk-forward: model vs model +
   crowd on RPS, Brier and log loss with `backtest.paired`, both halves, both
   divisions; log it in `PROJECT_STATUS.md` whatever the result.
2. **Kalman, per match, in Elo points.** The slider makes this one-dimensional.
   Each pick's gap g_u is in Elo points; the model's *equivalent gap* g_m is the
   gap whose expected score equals its published P(home) + P(draw) / 2. The
   state is the model's error on this match, delta, prior N(0, tau^2) (tau
   fitted on the backtest). Each player's deviation y_u = g_u - g_m is an
   observation with variance R_u. Posterior = the standard Kalman update:
   delta_hat = (sum y_u / R_u) / (1 / tau^2 + sum 1 / R_u). Equal R_u at first, and an *older* pick is a noisier one: R grows with the
   pick's age at kick-off (R = R_u + q x days), q fitted on the shadow data. That
   is the dynamic part of the filter: the state is held between observations, and
   its uncertainty grows with elapsed time.
   The draw slider gets its own scalar filter (a multiplier on the draw mass)
   only if the gap one earns it.
3. **Kalman, per player.** Each player's usefulness is a slow random-walk
   state, updated after every settled match from how much their deviation
   would have improved the score, with empirical-Bayes shrinkage: a new or
   throwaway account has near-zero weight until about 20 settled matches,
   which makes sybil accounts harmless and "more predictions, more accuracy"
   true.

**Where it plugs in.** `pricing.py` already adds prediction-time terms to the
rating gap in one place (`elo_odds`: the surface edge and the run-in stakes). The
crowd is one more term there, `CROWD_ELO * delta_hat`, optional and default
zero, passed only by the fixtures builder, so the backtest, the Elo replay
and the play-offs keep the model's odds and ratings never read the crowd. The
goals model sees it through the same gap. `data/predict/crowd.json` joins
`load_slices` and `inputs_digest`; a rewound view sees only snapshots from before
its date. The season simulation stays on model odds at first (the crowd
covers only the open round); decide at ship time. Bump: MAJOR.

**Why deviations, and why late.** Pooling deviations from the model gives
copiers zero weight; what is left is what the Elo + xG model cannot see (late
news, lineups, injuries: squad strength was rejected as elo-v4). Players may
tip until kick-off, so the aggregate should be as late as the hourly job
allows; the shadow phase tests the snapshot the job *could have shipped* (the
last run before kick-off), not the final frozen one.

**Power.** About 240 matches per division and season and a paired-loss SD near
0.025 RPS: a gain of 0.001 needs several full-coverage seasons; 0.003 about
half a season of both divisions. Coverage is the constraint (under about 30
effective players per match the weight is 0 by rule). The likeliest first-year
outcome is "shadow only, not enough data yet". The game and the data are
worth building either way.

## 7. Privacy and legal checklist (before any real user)

- Rewrite `personvern.html` in both languages: controller (already Tobias
  Samsonsen, with the JS-hidden address, so the privacy contact is the same),
  purposes (the game, boards, anonymous statistics to improve the odds, abuse
  prevention), basis, retention (below), rights, a delete
  button in the game, processors (Google Firestore, Google sign-in), no sale,
  no profiling of individuals. Have the Google-script wording checked.
- Nickname only (profanity filter, report link, no free text elsewhere); email
  stays in Firebase Auth.
- **Retention.** Predictions and per-round scores are kept while the account
  exists and is used, and deleted on request at any time. "As long as we like"
  is not a period GDPR accepts (art. 5(1)(e): a stated limit), so: an account
  unused for **24 months** is deleted together with all its entries, table
  picks and per-round scores, and a scheduled step in `predict.yml` carries it
  out. What stays: the **final season scores** (season totals and rank), kept
  under the nickname on past-season boards, with the Google link and email
  gone. A nickname with a score is still personal data, so the privacy page
  says it (purpose: the game's history; basis: legitimate interest), and a
  deletion request removes those too. The anonymous per-match aggregates in
  `data/predict/` stay as they are (n >= 5, no identity).
- Deletion removes the account, entries and stats; published aggregates stay
  (anonymous, n >= 5).
- Cookie banner: auth tokens are strictly necessary; the game's analytics events
  stay behind the existing consent.
- State the 13-year digital age of consent in the terms; no chat.

## 8. Phases

| Phase | When | Deliverable | Size |
|---|---|---|---|
| 0. Setup | now (2026-11-23: `elo-curve.js` extracted and tested, privacy draft in `predict-privacy-draft.md`; Firestore `(default)` created 2026-11-23 in `europe-north1`, Standard, locked rules, on Spark; Anonymous and Google providers enabled, anonymous auto clean-up left off because it deletes accounts after 30 days; `elitetracker.no` added as an authorised domain; API key restricted to the site's referrers; keyless GitHub identity created; web OAuth client has the site origin; still open: consent-screen privacy URL and publishing, which wait for the privacy page in phase 2; see "Console state" below) | the console setup below (Firestore, Auth providers, OAuth client, Workload Identity); privacy copy; the `elo-curve.js` extraction | S |
| 1. Core | Dec | rules (generated) + emulator tests; `firestore.py`; scoring with parity vectors; `predict.yml`; the slider card and round screen; reveal; own stats; optional pilot on the 2026 play-off ties; the table game opens | L |
| 2. Hooks | Jan to Feb | boards (model and crowd as players), streaks, share card, mini-leagues, nickname and Google flows, delete, `.ics` feed, privacy page live | L |
| 3. Closed beta | Mar | 20 to 50 invited players, abuse and rule tests, quota watch, copy review nb/en, mobile audit extended to the slider at four widths | M |
| 4. Launch + shadow | 2027 opener | public launch; `crowd.json` accumulates; weekly shadow report in `research` | M |
| 5. Decide the filter | after about 10 rounds, again at season's end | stage 1 analysis logged; ship, kill or keep collecting; stages 2 and 3 only on signal | M |
| 6. Push | if retention needs it | service worker and Web Push, with a dependency case | M |

Watch from day one (anonymous): new players per round, share completing a
round, week-4 and week-8 return, rounds per player, reveal views, crowd size
per match, Firestore writes per day against the quota.

## 9. Risks

- Too few players for the filter: likely; the game still earns its keep.
- The slider's curve nudges every forecast toward the model's shape. That is
  the price of the one-dimensional, coherent slider (and what makes the filter
  efficient); the draw slider is the release valve.
- Herding via the main site: handled by the deviation form; the game screen
  never links odds.
- Spark quota hit on a big matchday: one document per round keeps writes low;
  drafts survive in the browser; Blaze with a budget cap is the fallback.
- Abuse: throttling, per-player weight, n >= 5; Firebase App Check later if
  needed (loads another Google script).
- Board lag up to an hour; the reveal itself is instant in the browser. Add a
  match-day cron if it matters.
- Winter drop-off: the table game and the calendar feed are the bridge;
  measure, do not assume.

## 10. Still open

1. The exact privacy wording (drafted in phase 0, in both languages).
2. The table game's bonus values: the starting values in section 2 stand, to be
   tweaked after the first simulated-season runs, or after launch.

Settled with the owner: 24-month retention keeping final season scores;
`europe-north1`; the standard nickname rules (section 4).
