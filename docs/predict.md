# Predict

The prediction game: players tip home / draw / away probabilities with a slider,
are scored against the model and each other, and (later, if it earns it) the
crowd sharpens the odds. This page is the lookup for what is built. The reasoning
and the product decisions are in [predict-plan.md](predict-plan.md); the privacy
copy is drafted in [predict-privacy-draft.md](predict-privacy-draft.md).

**Status (2026-11-23): ready to launch from the `predict` branch.** Rules and indexes are
deployed, the Google consent screen is in production with the privacy URL, and on the branch the
page is deployable (no `hosting.ignore`), indexable, linked from the site footer and the sitemap,
with the hourly job scheduled. Nothing is on `main` yet, so nothing is public: merging and pushing
is the launch. The crowd does not touch any published number.

## Where things are

| What | Where |
|---|---|
| Frozen price curve, whole-percent rounding | `predict/curve.py` (twin: `public/predict-core.js`, `public/elo-curve.js`) |
| Scoring: Brier, RPS, Accuracy against the median (the model is a voter) | `predict/scoring.py`, `model/scores.py` (shared with `model/backtest.py`) |
| Table game: footrule and bonuses | `predict/tables.py` |
| Streaks (a freeze every fifth round), boards, nicknames, calendar feed | `predict/streaks.py`, `boards.py`, `nicknames.py`, `ics.py` |
| The crowd's signal, stage 1 (shadow only; not in `pricing.py`) | `model/crowd.py` |
| Firestore over REST (urllib, no SDK) | `sources/firestore.py` |
| The hourly job | `predict/sync.py`, run by `python -m elitetracker.predict_sync` |
| Security rules and indexes | `firestore.rules`, `firestore.indexes.json` (`firebase.json`) |
| The game's pages | `public/predict/`, `predict.js`, `predict-api.js`, `predict-core.js`, `predict.css` ([frontend.md](frontend.md)) |
| Shared test vectors (Python is the source) | `tests/fixtures/predict_vectors.json`, made by `tools/predict_vectors.py` |

## Data in Firestore

Project `elitetrackerno`, `(default)` database, `europe-north1`, Spark plan (free).
"Job" is the `predict-sync` service account, which bypasses the rules.

| Path | Written by | Readable by | What |
|---|---|---|---|
| `meta/rounds` | job | anyone (get) | the season's round index: key, league, round, opens, closes, matches |
| `fixtures/{season}_{league}_{round}` | job | anyone (get) | slots `s1..s8` (by match id, so a postponement keeps its slot), kick-offs, `opens` = 7 days before the first |
| `tablegames/{season}_{league}` | job | anyone (get) | the pre-season table game: opens with the fixtures, closes at the first kick-off, the clubs |
| `entries/{uid}/rounds/{key}` | the player | the player | `p.sN = {g, k, h, d, a, t}` (gap, draw tenths, whole percents, **server** time of the last change), `r` = round key, `curve` = 1 |
| `tables/{uid}/picks/{key}` | the player | the player | `order` (club ids), `r`, `t` |
| `users/{uid}`, `nicknames/{key}` | the player | the player (a claim: get) | profile; the nickname claim is keyed in ASCII (`~e ~o ~a` for æ ø å) and valid only with the profile that uses it |
| `reveal/{key}` | job | anyone (get) | after kick-off: the model's odds as published, the crowd's aggregate (n >= 5, plus the field's median score once settled), the result |
| `stats/{uid}` | job | the player | per-round totals (`n, b, r, ab, ar, vm, m`), last pick time |
| `boards/{id}` | job | anyone (get, not list) | `season_`, `round_`, `last10_{season}_{league}` and `league_{code}` (a mini-league, named by its secret code) |
| `leagues/{code}` + `members/{uid}` | the player | get / own | mini-leagues, codes `[A-Z2-9]{8}` |
| `reports/{id}` | the player (create) | job | a name report; three different reporters hide a name |
| `deleteRequests/{uid}` | the player (create) | job | asks the job to erase the account |
| `meta/sync` | job | nobody | what the job has done (digests, scored rounds, sweep date) |

Rules in one breath: only the owner reads or writes an entry; a write may change
only slots whose kick-off is ahead and whose round has opened, with `t` equal to
the request's server time; values are whole percents in 2..96 summing to 100, `g`
in -700..700 (enough to reach the clip), draw tenths 5..18. Entries and tables cannot be deleted from the
browser (a bad pick must not vanish before it is scored); deletion is a request.
The browser writes with a REST `commit` of the changed slots only: an update mask
on `p.sN.g|k|h|d|a`, `r`, `curve`, and a `REQUEST_TIME` transform on `p.sN.t`.

Quotas that shaped this (Spark: 50,000 reads, 20,000 writes, 20,000 deletes a
day, 1 GiB): one document per player per round (a save is one write, plus one read: the rules `get()` the fixture to check the kick-off); the page
reads about ten small documents; the job reads a round's entries only when a
match has newly kicked off or settled, and scores a round by **setting** its
totals, never incrementing, so a failed run is just repeated.

## The job (`predict/sync.py`)

1. `fixtures`, `meta/rounds` and `tablegames` from `data/normalized` (written only when their digest changes).
2. Snapshot the model's odds from the live site's `report.json` for matches kicking off within three hours: `data/predict/locked_odds.json` (git). Archived reports are re-rated by later releases, so this is the only honest "odds at kick-off".
3. Deletion requests: erase entries, table picks, profile, claim, stats, mini-league memberships; strip the player's rows from every board.
4. Per round with news: read its entries (collection-group query on `r`), publish the crowd aggregate for matches that kicked off (`data/predict/crowd.json`, git; `{"hidden": true}` below five players), compute the shadow delta (`model/crowd.py`), score settled matches, write `stats`, the `reveal` document.
5. When a division's season is complete: score the table game (footrule less bonuses, against the model's expected table as locked while the game was open: `data/predict/locked_tables.json`), write `stats/{uid}.tables.{key}` and `boards/tables_{key}`.
6. Rebuild this season's boards and the mini-league boards. An earlier season's boards are never rebuilt: they are the kept final scores.
7. Once a day: delete accounts unused for 24 months (the board rows stay).
8. `public/predict/rounds.ics`, the "round closes" calendar feed.

A dry run (`--dry-run`, also the default of a manual `predict.yml` run) reads Firestore and
writes nothing. Before the collection-group index is deployed it warns instead of failing;
a live run fails loudly rather than treating "no index" as "no players".

Known limits: a player who only plays the table game and never has a match scored has no
`last` activity date, so the 24-month sweep counts from sign-up; the sweep reads every
user once a day; a round's entries are re-read at each distinct kick-off time (the read
budget above is for a few thousand players, and Blaze with a budget cap is the escape).

Not done by the job: deleting the **Firebase Auth** account of an inactive player
(needs an Auth admin role on `predict-sync`, not granted) and of a deletion request
(the browser deletes its own account after writing the request).

## Running it locally

```bash
firebase emulators:start --only auth,firestore --project demo-elitetracker   # Auth :9099, Firestore :8085
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 .venv/Scripts/python -m pytest -q     # the emulator tests run instead of skipping
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 .venv/Scripts/python -m elitetracker.predict_sync --project demo-x --report public/data/report.json --now 2026-11-27T12:00:00Z --data-dir /tmp/predict --ics /tmp/rounds.ics
.venv/Scripts/python -m elitetracker.predict_sync --dry-run                  # the real project, read-only (gcloud login)
.venv/Scripts/python tools/predict_vectors.py                                # after changing curve, scoring, tables or nickname rules
```

The rules tests (`tests/test_firestore_rules.py`) and the end-to-end loop
(`tests/test_predict_emulator.py`) skip unless `FIRESTORE_EMULATOR_HOST` is set.
Both use plain `urllib`: the emulator takes `Bearer owner` (admin) and unsigned
JWTs (a player), so no Firebase SDK is needed.

## Going live

Done (2026-11-23):

- Rules and indexes deployed (`firebase deploy --only firestore:rules,firestore:indexes`); the job's
  collection-group query works against the real project.
- Privacy text in `public/personvern.html` (both languages), on the branch.
- The page unblocked on the branch: `hosting.ignore` no longer lists it, `noindex` is gone, a footer
  link on the front page and a sitemap entry (`pages.py`) point to it.
- `predict.yml` scheduled hourly (on the branch; it runs once the file is on `main`).
- Google consent screen: home page, privacy-policy URL and `elitetracker.no` set; the app is
  "In production" for external users (basic scopes only, so no user cap applies). Brand
  verification (showing the app name and a logo on Google's screen) is optional and needs the
  domain verified in Google Search Console.

Left, all the owner's:

1. Review the two **[CHECK]** items in the privacy text (HTML comments in `personvern.html`: the
   Google-script wording and the age limit).
2. **Launch:** merge `predict` into `main` and push. That deploys the page and the privacy text, and
   starts the hourly job.
3. After the first runs: the Firestore Usage tab should show the free quota against `europe-north1`.
4. Optional IAM: an Auth admin role on `predict-sync` for the 24-month sweep of Auth accounts.

## Not in this build

Web Push (phase 6, needs a dependency case); the stage 2 and 3 filters and any crowd
term in `pricing.py` (they have to earn it in the shadow phase, and would be a MAJOR
bump); tuning the table game's bonus values; the walk-forward shadow analysis (needs a
season of data; log it in `PROJECT_STATUS.md` whatever it shows).
