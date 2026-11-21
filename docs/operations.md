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
.venv/Scripts/python -m pytest -q && node --test tests/frontend.test.js
```

Bare `pytest` cannot import the `tests` package. `tests/season-shape.dom.js`
is a dev-only jsdom smoke test of the team view (`npm i jsdom`, then
`node tests/season-shape.dom.js`; it reads the built `public/data`). CI does
not run any of these: run them before pushing.

## CI (`.github/workflows/`)

- **`refresh.yml`**, hourly: `elitetracker.refresh`, then a commit of
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
- **`past-seasons.yml`**, by hand: rebuilds every past season, one job each,
  replaces the `past-seasons` asset and starts a deploy.

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
