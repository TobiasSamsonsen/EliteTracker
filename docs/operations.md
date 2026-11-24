# Operations

Run everything from the repo root with the venv's Python
(`.venv/Scripts/python` on Windows, `.venv/bin/python` elsewhere).

## Locally

```bash
python -m venv .venv && .venv/Scripts/pip install -e '.[dev]'
.venv/Scripts/python -m elitetracker.refresh                   # latest results (--force skips the guard)
.venv/Scripts/python -m elitetracker.research xg-obos          # OBOS-ligaen xG, by hand only
.venv/Scripts/python -m elitetracker.api.server                # live at :8000; --reload rereads the data per request
.venv/Scripts/python -m elitetracker.build_site --only-season 2026   # the static build into public/data
```

## Tests

```bash
.venv/Scripts/python -m pytest -q && node --test tests/frontend.test.js tests/predict.test.js tests/predict-ui.test.js
```

The Predict tests that need the Firestore emulator skip by default; to run them
start the emulators and set `FIRESTORE_EMULATOR_HOST=127.0.0.1:8085` (see
[predict.md](predict.md), "Running it locally"). Java 21 is needed for the emulator.

Bare `pytest` cannot import the `tests` package. `tests/season-shape.dom.js`
is a dev-only jsdom smoke test of the team view (`npm i jsdom`, then
`node tests/season-shape.dom.js`; it reads the built `public/data`). The
mobile check drives the built site in Playwright's Chromium at four phone
widths and a desktop (`.venv/Scripts/python experiments/mobile-audit/check.py`,
`--only 360x800 --views grid,table --shots` to narrow it and keep
screenshots); `tests/test_mobile_audit.py` runs it at 360 and 375px when
`ELITETRACKER_MOBILE_AUDIT=1` is set. CI does not run any of these: run them
before pushing.

## CI (`.github/workflows/`)

- **`refresh.yml`**, by the outside scheduler below every 15 minutes, and by its own (unreliable) hourly cron as the net: `elitetracker.refresh`, then a commit of
  `data/normalized` and `data/xg.json` if anything changed. The refresh guard
  skips a league with no unplayed match past its kickoff, so quiet hours cost
  nothing.
- **`deploy.yml`**, on every push to `main` (the refresh's commits too) and
  on pull requests (a preview channel): unpacks the `past-seasons` and
  `current` release assets into `public/data`, builds the current season
  only, deploys to Firebase, and on a push re-uploads the current season as
  the `current` asset. The same build writes the route pages and the
  sitemap, and fills in any `timeline-<season>.json` the archive lacks (see
  below). Firebase Hosting keeps only the latest releases (Hosting, Release
  history, Release storage settings; set 2026-11-21). Unlimited, it kept every
  deploy: a matchday adds a few MB, but a model release changes every report
  (~330 MB), and the copies reached 9.7 of the project's 10 GB.
- **`predict.yml`**: the Predict job, with a keyless Workload Identity login as `predict-sync`.
  It runs after every successful deploy of a push to `main` (new results arrive that way), on a schedule
  as the net, and by hand: a manual run is a dry run unless "live" is ticked. `deploy.yml` ignores pushes
  that touch only `data/predict/**`. See [predict.md](predict.md), "When the job runs".

GitHub's `schedule` is best effort: `refresh.yml`'s "hourly" cron ran about 4 times a day in November
2026 (median gap 6.5 hours). To have the refresh run on time, an outside scheduler starts it: see the next section.

- **`past-seasons.yml`**, by hand: rebuilds every past season, one job each,
  replaces the `past-seasons` asset and starts a deploy.

## Starting the refresh on time (cron-job.org)

Why: [predict.md](predict.md), "When the job runs". A workflow started through the API
(`workflow_dispatch`) is not delayed or dropped the way a scheduled one is. `refresh.yml` takes about 20 seconds
and its guard skips quiet hours, so asking every 15 minutes costs next to nothing. A refresh that finds new
results pushes to `main`, the push deploys, and the deploy starts the Predict job, so one ping serves the
site and the game. The workflows' own `schedule:` stays as the net.

Do this **after `predict` is merged**: the API starts the workflow file that is on `main`.

**1. A token that can start workflows and nothing else.** GitHub, Settings, Developer settings, Personal access
tokens, Fine-grained tokens, Generate new token:

- Token name `cron-job.org dispatch`; Resource owner your account; Expiration the longest offered (up to a year).
- Repository access: Only select repositories, `EliteTracker`.
- Permissions, Repository permissions: **Actions: Read and write** (Metadata: Read-only is added by itself).
  Nothing else. It is not `REFRESH_PAT` (that one can push code); do not reuse it.
- Generate, and copy it once (it starts with `github_pat_`).

**2. Try it from a terminal** (Git Bash; the token never goes in a file):

```bash
read -rs TOKEN                      # paste the token, Enter
curl -i -X POST https://api.github.com/repos/TobiasSamsonsen/EliteTracker/actions/workflows/refresh.yml/dispatches   -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json"   -H "X-GitHub-Api-Version: 2022-11-28" -d '{"ref":"main"}'
```

`HTTP/2 204` means a run was queued: it shows under Actions, "Scheduled data refresh", event `workflow_dispatch`.
`401` is a wrong or expired token, `403` a missing Actions permission, `404` the wrong repository or a token
that cannot see it, `422` a workflow without `workflow_dispatch` or a `ref` that is not a branch.

**3. The job at [cron-job.org](https://cron-job.org)** (a free account; Create cronjob):

| Field | Value |
|---|---|
| Title | `EliteTracker refresh` |
| URL | `https://api.github.com/repos/TobiasSamsonsen/EliteTracker/actions/workflows/refresh.yml/dispatches` |
| Execution schedule | every 15 minutes |
| Advanced, Request method | `POST` |
| Advanced, Request body | `{"ref":"main"}` |
| Advanced, Headers | `Authorization: Bearer <the token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json`, `User-Agent: cron-job.org` (GitHub refuses a request without one) |
| Expected response | the default (any 2xx is a success; GitHub answers `204`) |
| Notifications | on failure, and again when it recovers |

Save, then "Test run": the history shows `204` and a refresh run appears in Actions. The token sits in the job's headers
at cron-job.org, so use a password of its own there and turn on two-factor sign-in.

**4. Optional: a second job for the Predict job itself** (a net for the rare deploy that does not happen, say a
round that kicks off with no new results since): the same, with the URL ending `.../workflows/predict.yml/dispatches` and the body
`{"ref":"main","inputs":{"live":"true"}}`, every 2 hours. (Without `live` the run is a dry run that writes nothing.)

**Upkeep.**

- The token expires: put the date in a calendar. When it does, the job starts failing, the notification arrives, and the
  workflows fall back to their own, slower, schedules. Make a new token and edit the header at cron-job.org.
- A suspended or locked GitHub account (the student pack renewal did it once, probably) kills the token the same way;
  nothing else needs doing when the account is back, only the token if it was revoked.
- To stop it: disable the job at cron-job.org and revoke the token under Developer settings.
- GitHub queues one run of a workflow per `concurrency` group, so a ping while a refresh is running waits; they never pile up.

## The incremental build

`build_site` stamps every view with a digest of the code, its settings and
the data it reads (`build-manifest.json`), and reuses a view whose stamp has
not moved. A rewound view counts only the results up to its date, so later
results never rebuild it. Any change to a `.py` file in the package rebuilds
every view.

## Publishing past seasons

Only after a model change or a change to what a report carries, never for
ordinary results (they touch the current season alone). Either run the
workflow:

```bash
gh workflow run past-seasons.yml
```

or build on your machine and upload the asset:

```bash
python -m elitetracker.build_site          # every season
CURRENT=$(python -c 'from elitetracker.pipeline import current_season; print(current_season())')
tar -czf past-seasons.tar.gz -C public/data $(cd public/data && ls report-*.json timeline-*.json | grep -v "^report-$CURRENT" | grep -v "^timeline-$CURRENT")
gh release upload past-seasons past-seasons.tar.gz --clobber
```

The deploy unpacks it into `public/data/`, then builds the current season
over it. Without the asset it still deploys, with only the current season
browsable.

## Bundles, route pages and caching

Three kinds of file are derived from the reports rather than simulated, each
written by the `build_site` run:

- `timeline-<season>.json` (`bundles.py`): every matchday's club rows
  (position, rating, finish chances), read by *Play season* and the *Season
  mountain* in place of ~70 report fetches. A past season's comes in the
  `past-seasons` asset (`past-seasons.yml` uploads it); one the asset lacks
  is built from the unpacked reports during the deploy (about ten seconds for
  all twelve seasons), so the archive does not need rebuilding for it.
- `seasons-summary.json` (`bundles.py`): the slice of every season's live
  report the *Luck table* and the prediction scorecard read. Rewritten on every
  build, since the current season's part moves with each result.
- the route pages and `sitemap.xml` (`pages.py`), beside `index.html`:
  `/obos-ligaen/`, `/klubb/<slug>/` for every club in the current season and
  `/utforsk/<slug>/` for each Explore tool, each a copy of `index.html` with its
  own title, description, canonical address and social card. All git-ignored;
  CI writes them.

The frontend falls back to the per-date and per-season reports wherever a
bundle is missing (an older archive, the local server, which does not serve
them), so none of these is required to run.

Firebase caches `/vendor/**` for 30 days; `/data/**`, `.js`, `.css` and
`.html` stay `no-cache` (they revalidate, mostly as 304s). A rewound report
must not be marked immutable: a model release re-rates old reports under the
same file name. After changing a vendored file, check the header on a preview
channel (`curl -I`), since `/vendor/**` also matches the `.js` rule above it.
