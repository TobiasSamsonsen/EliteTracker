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
  the `current` asset.
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
tar -czf past-seasons.tar.gz -C public/data $(cd public/data && ls report-*.json | grep -v "^report-$CURRENT")
gh release upload past-seasons past-seasons.tar.gz --clobber
```

The deploy unpacks it into `public/data/`, then builds the current season
over it. Without the asset it still deploys, with only the current season
browsable.
