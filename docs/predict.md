# Predict

The prediction game: players tip home / draw / away probabilities with a slider,
are scored against the model and each other, and (later, if it earns it) the
crowd sharpens the odds. This page is the lookup for what is built. The reasoning
and the product decisions are in [predict-plan.md](predict-plan.md); the privacy
copy is drafted in [predict-privacy-draft.md](predict-privacy-draft.md).

**Status (2026-11-23): ready to launch from the `predict` branch.** Rules and indexes are
deployed, the Google consent screen is in production with the privacy URL, and on the branch the
game is a tab of the site (the Predict view; `/predict/` its route page, 2026-11-24), indexable,
linked from the masthead, the footer and the sitemap, with the job scheduled. Nothing is on `main` yet, so nothing is public: merging and pushing
is the launch. The crowd does not touch any published number.

## Where things are

| What | Where |
|---|---|
| Frozen price curve, whole-percent rounding | `predict/curve.py` (twin: `public/predict-core.js`, `public/elo-curve.js`) |
| Scoring: Brier, RPS, Accuracy against the median (the model is a voter) | `predict/scoring.py`, `model/scores.py` (shared with `model/backtest.py`) |
| Table game: footrule and bonuses | `predict/tables.py` |
| Boards, nicknames | `predict/boards.py`, `nicknames.py` |
| The crowd's signal, stage 1 (shadow only; not in `pricing.py`) | `model/crowd.py` |
| Firestore over REST (urllib, no SDK) | `sources/firestore.py` |
| The job | `predict/sync.py`, run by `python -m elitetracker.predict_sync` |
| Security rules and indexes | `firestore.rules`, `firestore.indexes.json` (`firebase.json`) |
| The game's view | the Predict view of `public/index.html` (`/predict/` is its route page, `pages.py`), `predict.js`, `predict-api.js`, `predict-core.js`, `predict-util.js`, `predict.css`, loaded by `app.js` when the view opens ([frontend.md](frontend.md), "The Predict view") |
| Shared test vectors (Python is the source) | `tests/fixtures/predict_vectors.json`, made by `tools/predict_vectors.py` |

## Data in Firestore

Project `elitetrackerno`, `(default)` database, `europe-north1`, Spark plan (free).
"Job" is the `predict-sync` service account, which bypasses the rules.

| Path | Written by | Readable by | What |
|---|---|---|---|
| `meta/rounds` | job | anyone (get) | the season's round index: key, league, round, opens, closes, last, matches (`n`), every distinct kick-off (`ks`: a gap in it is a round in progress, not live) and how many matches are scored (`settled`) |
| `meta/standings` | job | anyone (get) | each division's current table as club ids, best first, the clubs' names and matches played: the table game's "your table against the table now", and the table shown (with the bonus places marked) while the next season's game is not open yet |
| `fixtures/{season}_{league}_{round}` | job | anyone (get) | slots `s1..s8` (by match id, so a postponement keeps its slot), kick-offs, `opens` = 7 days before the first |
| `tablegames/{season}_{league}` | job | anyone (get) | the pre-season table game: opens with the fixtures, closes at the first kick-off, the clubs |
| `entries/{uid}/rounds/{key}` | the player | the player | `p.sN = {g, k, h, d, a, t}` (gap, draw tenths, whole percents, **server** time of the last change), `r` = round key, `curve` = 1 |
| `tables/{uid}/picks/{key}` | the player | the player | `order` (club ids), `r`, `t` |
| `users/{uid}`, `nicknames/{key}` | the player | the player (a claim: get) | profile (`leagues`: the codes of the mini-leagues the player is in, at most 20, so they follow a sign-in and a purge knows which memberships to remove); the nickname claim is keyed in ASCII (`~e ~o ~a` for æ ø å) and valid only with the profile that uses it; a change of case only is a plain update of `nick` (no new claim, no new `nickAt`) |
| `reveal/{key}` | job | anyone (get) | after kick-off: the model's odds as published, the crowd's aggregate (n >= 5, plus the field's median score once settled), the result |
| `stats/{uid}` | job | the player | per-round totals (`n, b, r, ab, ar, vm, m`), last pick time; points and accuracy are worked out from `n` and `b` |
| `boards/{id}` | job | anyone (get, not list) | `season_`, `round_`, `last10_{season}_{league}`, `season_{season}_all` (both divisions together), `round_{season}_{league}_{n}` (every round scored, kept as that round's board), `tables_{season}_{league}` and `league_{code}` (a mini-league, named by its secret code; the current season's, with each season also kept as `league_{season}_{code}`) |
| `leagues/{code}` + `members/{uid}` | the player | get / own | mini-leagues, codes `[A-Z2-9]{8}` |
| `reports/{nickKey}_{uid}` | the player (create) | job | a name report: one per reporter and name (the rules check the id, a repeat is an update and is refused); three different reporters hide a name |
| `deleteRequests/{uid}` | the player (create, and again as an update) | job | asks the job to erase the account |
| `meta/sync` | job | nobody | what the job has done (digests, scored rounds, the index version and scored counts, the newest mini-league join seen, sweep date) |

Rules in one breath: only the owner reads or writes an entry; a write may change
only slots whose kick-off is ahead and whose round has opened, with `t` equal to
the request's server time; values are whole percents in 1..98 summing to 100 (the curve's own picks stay in 2..96; only a fine-tuned pick goes to 1), `g`
in -700..700 (enough to reach the clip), draw tenths 5..18. Entries and tables cannot be deleted from the
browser (a bad pick must not vanish before it is scored); deletion is a request.
The browser writes with a REST `commit` of the changed slots only: an update mask
on `p.sN.g|k|h|d|a`, `r`, `curve`, and a `REQUEST_TIME` transform on `p.sN.t`.

Quotas that shaped this (Spark: 50,000 reads, 20,000 writes, 20,000 deletes a
day, 1 GiB): one document per player per round (a save is one write, plus one read: the rules `get()` the fixture to check the kick-off); the page
reads about ten small documents (the site's Overview adds up to four, `meta/rounds`, your stats, your entry for the next round and, once you have a scored round this season, the season board for your place, for a browser that holds a session, at most once every ten minutes per tab); the job reads a round's entries only when a
match has newly kicked off or settled, and scores a round by **setting** its
totals, never incrementing, so a failed run is just repeated.

## The job (`predict/sync.py`)

1. `fixtures`, `meta/rounds` and `tablegames` from `data/normalized` (written only when their digest changes).
2. Snapshot the model's odds from the live site's `report.json` for matches kicking off within 48 hours: `data/predict/locked_odds.json` (git). The latest published odds are kept until kick-off (rewritten only when they change), so the last run before it holds the final ones, and a missed run or two no longer leaves a match unscorable. The file is saved before the Firestore commit. Archived reports are re-rated by later releases, so this is the only honest "odds at kick-off".
   The crowd as it stood in the last run before each kick-off is kept apart in `data/predict/shadow.json` (one read of the round's entries per distinct kick-off, in the hour before it): the final aggregate in `crowd.json` includes picks made after that run, so the shadow test of a crowd term uses the shadow file.
3. Deletion requests: erase entries, table picks, profile, claim, stats, mini-league memberships; strip the player's rows from every board.
4. Per round with news: read its entries (collection-group query on `r`), publish the crowd aggregate for matches that kicked off (`data/predict/crowd.json`, git; `{"hidden": true}` below five players), compute the shadow delta (`model/crowd.py`), score settled matches, write `stats`, the `reveal` document.
5. When a division's season is complete: score the table game (footrule less bonuses, against the model's expected table as locked while the game was open: `data/predict/locked_tables.json`), write `stats/{uid}.tables.{key}` and `boards/tables_{key}`.
6. Rebuild this season's boards (and the season board of both divisions together), the board of every round scored in the run (`round_{season}_{league}_{n}`) and the mini-league boards. A league made or joined since the last run gets its board at once, from one collection-group query on `members.joined` (the index is in `firestore.indexes.json`; without it the job warns and skips this). An earlier season's boards are never rebuilt: they are the kept final scores. `meta/rounds` is rewritten when a fixture changes or another match is scored, and `meta/standings` when a match has been played.
   When the next season's fixtures are already in, `predict_sync` first runs the season before (`publish=False`: it scores and builds, and leaves the round index, the table game's opening, deletions and the calendar to the current season), if the job has played it.
7. Once a week: delete accounts unused for 24 months (the board rows stay).
8. (There is no calendar feed: a "round closes" `.ics` was built and dropped on 24 November, unlinked, because a file that changes every hour is a commit and a full site deploy every hour. The plan's calendar reminder can come back as a feed that is rewritten only when a round opens or closes.)

One run names each document once in its commit (`meta/sync` is one merge at the end), reads a round's entries once however many steps need them, and leaves a board it has already rebuilt out of the deleted-player strip (the strip reads the stored, older copy). `predict.yml` decides what to commit with `git status` (the files are untracked on the first run, which `git diff` does not see; `data/predict` is all it commits) and retries the rebase and push, because the run's locked odds and shadow crowd exist only in that commit.

### When the job runs

Not every hour. GitHub's `schedule` is best effort: `refresh.yml`'s "hourly" cron ran 100 times in 27 days
in November 2026 (about 4 a day; median gap 6.5 hours, 58 % of gaps over 6 hours, longest 12.3 hours; one more gap of 40.8 hours, 5 to 6 November, was probably a GitHub account suspension), and the same
cron on this job will do no better. So `predict.yml` runs on two triggers: after every successful Deploy of a push to
`main` (which is how new results arrive: `refresh.yml` pushes, the push deploys), and on a schedule as the net
(minute 41, off the top of the hour). The reliable trigger is an outside scheduler that starts `refresh.yml` every 15
minutes through `workflow_dispatch` (cron-job.org, with a fine-grained token that has `actions: write` on this repository
only; the owner's setup, steps in [operations.md](operations.md), "Starting the refresh on time"). Until it is set up, or
whenever it is down, expect this:

- Scores, the reveal (the model's odds and the crowd after kick-off) and mini-league boards follow the results by minutes
  when a refresh brought them, and by hours (a day at worst) when the schedule did. A deletion request is carried out in the
  same way: the copy says "within a few days", not "within the hour".
- The locked odds are the latest published ones from a run up to 96 hours before kick-off (`SNAPSHOT_AHEAD`), so a match
  keeps its snapshot through the usual gaps of up to half a day and even through an outage of a day or two (an account suspension); the odds a player never sees (they are hidden until kick-off) can be
  a few hours older than the site's.
- The shadow crowd is taken only by a run in the hour before a kick-off, which a sparse schedule mostly misses: `shadow.json`
  will have gaps, and the walk-forward test of a crowd term has to use the matches it has. Nothing published depends on it.
- A kick-off that is moved shows in `fixtures/*` at the next run; until then the rules go by the old time.
- Fewer runs read less: the quota ceilings above are the worst case (every hour with news).

A dry run (`--dry-run`, also the default of a manual `predict.yml` run) reads Firestore and
writes nothing. Before the collection-group index is deployed it warns instead of failing;
a live run fails loudly rather than treating "no index" as "no players".

Reads in the free plan: a scoring run lists every profile and stats document once (and every league and its members), and the weekly sweep lists every profile and stats document. Measured by running the job over the busiest 2025 weekend (both divisions, 16 matches, five scoring runs in a day), the job costs about 20 reads per registered player on the peak day (about 17 for one division), and the page about 12 a visit: the ceiling is roughly **1,300 to 2,500 registered players** (registered, not active: a dormant account is listed in every run). The first cheap levers are rebuilding the boards less often than every settled match and keeping the nickname in `stats`; after that Blaze with a budget cap is the escape. Storage: Firestore's automatic indexes made a pick document about 12 KB (48 indexed fields, two entries each) against 0.65 KB of data, and `stats.rounds` about 75 KB a player-season; `firestore.indexes.json` exempts `rounds.p` and `stats.rounds` (nothing queries them), which is a fifteenth of that (estimates, +-30 %: about 26 KB for a full season of one division, so tens of thousands of players to the 1 GiB). The hourly extras this audit added are small: one members query a run, one meta/sync read more for the season before, and the shadow read in the hour before each kick-off.

Known limits: a player who only plays the table game and never has a match scored has no
`last` activity date, so the 24-month sweep counts from sign-up; the sweep reads every
user once a week; a round's entries are re-read at each distinct kick-off time (the read
budget above is for a few thousand players, and Blaze with a budget cap is the escape).

Not done by the job: deleting the **Firebase Auth** account of an inactive player
(needs an Auth admin role on `predict-sync`, not granted) and of a deletion request
(the browser deletes its own account after writing the request).

## Running it locally

```bash
firebase emulators:start --only auth,firestore --project demo-elitetracker   # Auth :9099, Firestore :8085
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 .venv/Scripts/python -m pytest -q     # the emulator tests run instead of skipping
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 .venv/Scripts/python -m elitetracker.predict_sync --project demo-x --report public/data/report.json --now 2026-11-27T12:00:00Z --data-dir /tmp/predict
.venv/Scripts/python -m elitetracker.predict_sync --dry-run                  # the real project, read-only (gcloud login)
.venv/Scripts/python tools/predict_vectors.py                                # after changing curve, scoring, tables or nickname rules
```

`firebase emulators:exec --only auth,firestore --project demo-elitetracker "<command>"` starts the emulators, sets
`FIRESTORE_EMULATOR_HOST`, runs the command and stops them; on Windows the command runs under `cmd`, so use
`.venv\Scripts\python`. CI does the same (`.github/workflows/predict-tests.yml`).

The rules tests (`tests/test_firestore_rules.py`), the end-to-end loop
(`tests/test_predict_emulator.py`) and the page driven in Chromium (`tests/test_predict_browser.py`, needs Playwright)
skip unless `FIRESTORE_EMULATOR_HOST` is set.
Both use plain `urllib`: the emulator takes `Bearer owner` (admin) and unsigned
JWTs (a player), so no Firebase SDK is needed.

## Going live

Done (2026-11-23):

- Rules and indexes deployed (`firebase deploy --only firestore:rules,firestore:indexes`); the job's
  collection-group query works against the real project.
- Privacy text in `public/personvern.html` (both languages), on the branch.
- The game unblocked on the branch: a view of the site with a masthead tab, a footer link and a
  route page with a sitemap entry (`pages.py`); `noindex` is gone.
- `predict.yml` set to run after every deploy of `main` and on a schedule (on the branch; it runs once the file is on `main`).
- Google consent screen: home page, privacy-policy URL and `elitetracker.no` set; the app is
  "In production" for external users (basic scopes only, so no user cap applies). Brand
  verification (showing the app name and a logo on Google's screen) is optional and needs the
  domain verified in Google Search Console.

Left, all the owner's:

0. **Deploy the rules and indexes again** (`firebase deploy --only firestore:rules,firestore:indexes`) before merging (checked on 24 November: the deployed rules are still the 23 November ones). The 24 November audit changed the report ids, added `users.leagues` and `meta/standings` to the rules, and added the `members.joined` index; the UI pass lowered the percent floor to 1 (fine-tune), which the deployed rules refuse until then; the review that followed lets a deletion request be made again (an update), and exempts `rounds.p` and `stats.rounds` from indexing (an exemption applies to documents written after it; there are none yet).
1. Glance at the two items that were **[CHECK]** comments in `personvern.html` (the Google-script wording, the age limit): both were checked on 24 November against the code and Norwegian law (13) and the comments replaced by notes saying so; change the wording if you disagree.
2. **Launch:** merge `predict` into `main` and push. That deploys the page and the privacy text, and
   starts the job.
3. After the first runs: the Firestore Usage tab should show the free quota against `europe-north1`.
4. Optional IAM: an Auth admin role on `predict-sync` for the 24-month sweep of Auth accounts. Until then the privacy text says the sweep leaves the Authentication record (a random ID, and the email for a Google-linked account) until the player deletes from the game or asks.

## Not in this build

Web Push (phase 6, needs a dependency case); the stage 2 and 3 filters and any crowd
term in `pricing.py` (they have to earn it in the shadow phase, and would be a MAJOR
bump); tuning the table game's bonus values; the walk-forward shadow analysis (needs a
season of data; log it in `PROJECT_STATUS.md` whatever it shows).
