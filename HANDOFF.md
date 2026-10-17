# Handoff: the Explore views, one branch each

The model work is done and on `main`: elo-v13.0 (commit 28e49b1, pushed
2026-10-16; PROJECT_STATUS.md, "elo-v13.0" in two parts and "Model versions").
What is left is the seven Explore views the owner kept. They are built but not
on the site: each waits on a branch of its own, to be improved there and
released alone when it is finished. The owner decides what each one needs next.

## The branches

```
main                       the site: Explore shows attack vs defence, the season mountain and the luck table;
                           the model card has the model accuracy panel
└─ explore/base            what the views share (on main since the luck table's release)
   ├─ explore/accuracy     model accuracy, a panel of the model card (no longer an Explore view):
   │   the version history, the calibration and the scorecard
   │   (merges explore/scorecard and explore/calibration, which it replaces) -- released 2026-10-17 (merged into main)
   ├─ explore/luck         luck table -- released 2026-10-16 (merged into main)
   ├─ explore/runin        run-in heatmap
   ├─ explore/races        race lines
   ├─ explore/stakes       stakes calendar
   ├─ explore/h2h          head to head
   └─ explore/later        the lift, rating river and scorelines: stored code, not wired in
```

`explore/base` is one commit on `main`:

- the hero's title pickers (division and season) for every Explore view of one
  division and season (`public/styles.css`, beside the other views' hero rules);
- `EXPLORE_REWIND`, the views that follow the rewind slider (`attack`; the luck
  branch adds `luck`);
- `fetchedReport`, one fetch per report file, which the mountain uses too;
- `renderTimeAxis` and `runInStart`: the views with a time axis (races, run-in,
  stakes) take no rewind and read the season's latest report; the run-in and
  stakes calendar show a finished season as it stood with ten rounds left, with
  a line above saying so (`explore.runInFrom`);
- `.explore-note`;
- the two browser checks, `experiments/improvements/explore_smoke.py` and
  `explore_seasons.py`, which open only the views in the branch's `EXPLORE_ITEMS`.

Each view branch is `explore/base` plus one commit that touches only the view's
own places: its section in `public/app.js` (render function and helpers), its
thumbnail branch in `exploreThumb`, its route in `renderExplore`, its id in
`EXPLORE_ITEMS`, its block at the end of `public/styles.css` with class names of
its own, its strings in both languages of `public/i18n.js`, its tests at the
end of `tests/frontend.test.js`, and its bullet in README.md's Explore list. The
data they read is already on `main` (`careers.json`, the report's `history` and
`high_stakes`, `calibration.json` from `build_site`).

## Working on a view

```bash
git switch explore/luck
# ... edit ...
.venv/Scripts/python -m pytest -q && node --test tests/frontend.test.js
.venv/Scripts/python experiments/improvements/explore_smoke.py <out-dir>
.venv/Scripts/python experiments/improvements/explore_seasons.py <out-dir>
git commit -am "Explore luck: ..." && git push
```

- `public/data/` is untracked, so every branch shows the same locally built
  data (elo-v13.0). A full rebuild is `.venv/Scripts/python -m
  elitetracker.build_site --jobs 8`, 10+ minutes.
- `python -m http.server --directory public 8000` serves whatever branch is
  checked out.
- Keep a view's code in its own places, so it can still be released alone. Two
  shared class names were split off for that: the stakes calendar had borrowed
  `runin__scroll`, the scorecard `calibration__diagonal`.
- A change several views need goes on `explore/base` first; then
  `git merge explore/base` into each view branch that wants it.
- Model or data changes belong on `main` (and follow AGENTS.md's versioning),
  not on these branches. A view-only change needs no version bump.

## Releasing a view

1. On its branch, take in `main`: `git switch explore/<id> && git merge main`.
   The luck table went first (2026-10-16), so every later one conflicts where
   each view adds a line at the same spot. A dry run (race lines released, then the
   luck table) gave 10 conflicts in 5 files: `EXPLORE_ITEMS`, the
   `exploreThumb` branches, the `renderExplore` routes and the view sections in
   `app.js`; the strings in `i18n.js` (both languages); the end of
   `styles.css`; the end of `frontend.test.js`; README's Explore list. Keep
   both sides in each. In `EXPLORE_ITEMS`, list both ids, in the gallery order
   you want.
2. Run the tests and both browser checks on the branch.
3. Open a pull request, `gh pr create --base main --head explore/<id>`.
   `deploy.yml` builds a Firebase preview channel for pull requests from this
   repo, so the view can be checked live before it goes out.
4. Merge it. A push to `main` deploys.
5. In PROJECT_STATUS.md, mark the view as released: the "Explore: which views
   stay" section and the view's line in "Explore / Utforsk". README's bullet
   came with the branch.
6. Delete the branch if you like: `git push origin --delete explore/<id>`.

## Where each view stands

| view | season controls | known limits |
|---|---|---|
| accuracy (model card, released) | season (hero), division (its own switch) | the scorecard: every finished season at once, archives before the pre-season view fall back to the first season-shape snapshot; the calibration pools both divisions and every season since 2016 |
| luck (released) | division, season, rewind | xG only from 2020 (Eliteserien) and 2023 (OBOS-ligaen); earlier seasons say so; keeping only where there is xG on target (Eliteserien) |
| runin | division, season | a finished season shows the run-in as it stood with ten rounds left |
| races | division, season | the snapshots count places only, so promotion and relegation leave out the play-offs (the note says so) |
| stakes | division, season | decisive matches are marked only in the last ten rounds |
| h2h | division, season | the record runs from 2015 to the end of the season shown |

The three stored views, and what each needs before it comes back, are in
`experiments/explore-later/README.md` on `explore/later`.

## Other open items

- Past seasons: the owner reruns them on elo-v13.0 (`gh workflow run
  past-seasons.yml`). Until then the site's current season is elo-v13.0 and
  the past seasons elo-v12.2.
- The contact-form service (PROJECT_STATUS.md, "Contact form - planned").
- Next season: `research market-values --season 2027` once 2027 is over, and a
  line in `normalize/surfaces.py` for any club changing surface or a grass club
  coming up.
- The old `explore-view` branch has nothing that is not on `main`; it can go.

## Working notes

- Run everything from the repo root with `.venv/Scripts/python`.
- `QUESTIONS.md` holds the first round of questions, all answered 2026-10-16.
- In the Bash tool, heredocs holding `'''` strings broke; write edit scripts to
  a file and run them instead.
