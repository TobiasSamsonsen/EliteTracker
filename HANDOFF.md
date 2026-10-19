# Handoff: the Explore views, one branch each

The model work is on `main` and deployed: elo-v16.0 (commit b571718,
2026-10-17; PROJECT_STATUS.md, "Model versions"). What is left is the Explore
views the owner kept that are not on the site yet. Each waits on a branch of
its own, to be improved there and released alone when it is finished. The
owner decides what each one needs next.

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
  data (whatever version you last built). A full rebuild is `.venv/Scripts/python -m
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

## The luck measure: last season's finishing (changed 2026-10-19)

The luck table (`public/app.js`: `LUCK_FINISHING` and `luckChances` at line
~2575, `luckRows`, `luckTrend`, `withTrend`, `renderLuck`, `luckSeasons`)
now scales each match's xG by each side's finishing last season (goals
against xG, against the division, x 0.5; 0 for a club new to the division),
then measures luck against the Poisson xG points of those chances plus the
trend on xG points a match. That replaced the rolling finishing 20 + keeping
10 on the owner's call. Frontend only, no model change or version bump:
`luckChances` takes the division's season reports; keeping and
`luck.how.formNoKeeping` are gone; the copy in both languages, the tests,
README and PROJECT_STATUS.md follow. Both test suites and `explore_smoke.py`
pass. The tooltip names it "last season's finishing".

The record is PROJECT_STATUS.md, "Luck: more signals, and the measure
re-tested" and "Luck: which signals take out the skill"; read them before
changing the measure again. What led here, from the first re-test:

- **The shipped finishing 20 + keeping 10 takes out luck, not skill.** It was
  picked on the mean squared luck of a club season (-17.3, t -3.0), and that
  measure rewards any term that follows this season's luck: a lucky spell
  raises the usual points after it, and the later luck cancels the earlier.
  On simulated seasons with no skill at all (goals drawn Poisson from the
  xG), the shipped method still cuts the mean square from 41.5 to 25.6, as
  much as on the real data. Its luck correlates +0.70 with the true luck,
  and the two halves of a season -0.21 (real -0.15, plain xG +0.05).
- **The honest measure is per match**: log loss of each result under its own
  scaled chances, with the form read from earlier matches. On it the shipped
  form is +0.0329 against plain xG (t +4.58), and every rolling keeping
  window hurts. Use this measure (and the no-skill world as a check) for any
  further test; the season mean square is only a secondary figure.
- **The one real signal is last season's finishing** (club goals / xG over
  last season against the division's, fixed before the season): per match
  w 0.5 -0.0045 (t -2.62), w 0.25 -0.0027 (t -3.16); in the no-skill world it
  costs (+0.0033), and halves stay at +0.03. Last season's keeping adds
  nothing.
- No other signal helped: shots one by one or with same-minute rebounds as
  one chance, penalties at the division's rate, the closing market as the
  trend's quality or blended into the usual points, a curved trend,
  finishing from xG on target, red cards (+0.18 a match for the side a man
  up, too small to matter). Game-state weighting was not tested on purpose
  (the score is the scorer's luck).

**Re-tested for every signal on 2026-10-19** (`luck_skill.py`, out in
`out/luck_skill.txt`; PROJECT_STATUS.md, "Luck: which signals take out the
skill"). Points minus xG points hold about 13 points squared of skill a club
season (se 9) beside about 37 of luck. Last season's finishing x 0.5 plus the
trend takes out 80 % of that skill, and the rest is no more than a prior's
own noise. The shipped rolling form takes out 202 %: luck too. The only other
signal with skill in it is shot-level. Shots one by one explain about 40 % of
the trend as the Poisson's bias. Shot by shot (each shot's luck weighted by
what the match hung on it) reaches 90 %, but it needs every shot in the
report and Eliteserien only. Squad value, the pre-season rating, keeping,
several seasons of finishing, game state and chance quality add nothing. In
OBOS-ligaen last season's finishing neither helps nor hurts, and it hurts if
relegated clubs bring their Eliteserien finishing. So read it from the same
division only.

Settled with it: OBOS-ligaen takes the same rule (it costs nothing there:
+0.0001 log loss, t +0.05); promoted clubs keep 0 (their OBOS-ligaen
finishing is no better); the weight picked out of sample is 0.7-1.0, while
w 0.5 has the best t (-0.0049 log loss, t -3.02), so 0.5 is a judgement. The
browser's chances match `luck_skill.py` to 0.041 a club season.

Open: shot by shot is the one later step worth having. It needs every
shot's minute, side, xG and outcome in the data the view reads (a new file
beside the reports, not in each dated report) and works for Eliteserien
only, since OBOS-ligaen has no shots.

Reproduce (the output in `out/` is git-ignored):

```bash
.venv/Scripts/python -W ignore experiments/improvements/luck_signals.py > experiments/improvements/out/luck_signals.txt
PYTHONIOENCODING=utf-8 .venv/Scripts/python -W ignore experiments/improvements/luck_skill.py > experiments/improvements/out/luck_skill.txt
```

`luck_signals.py` reimplements the old rolling luck in Python (it matches
the logged sd 5.29 / 6.59) and holds the first re-test: `per_match`,
`per_match_null`, `null_world`, `prior_test`, `prior_scales`.
`luck_skill.py` (about 90 seconds) holds the second: the per-match tests,
the skill left in a club season, both no-skill worlds, shot by shot,
OBOS-ligaen and the champions.

Committed with it: the decisive-match dot outside the rating on fixture
cards, stacked one above the other when a club has a stake in more than one
band (`.stake-dots`); shorter tooltips everywhere (`public/app.js`,
`i18n.js`, `styles.css`, `index.html`); and `p_draw` in the report's
`high_stakes` / `next_stakes` (`pipeline.py`, so the dot's tooltip reads
W/D/L). Promotion has its own colour since (`bandColor`: the blue
`--outcome-good`, where it shared the champions' yellow), so a club decisive for
both shows two different dots, and OBOS-ligaen's promotion place and line are
blue across the site.

## Other open items

- Past seasons: rebuilt on elo-v16.0 (`past-seasons.yml`, 2026-10-17). Rerun
  it after the next model release (docs/operations.md, "Publishing past seasons").
- The contact-form service (PROJECT_STATUS.md, "Contact form - planned").
- Next season: `research market-values --season 2027` once 2027 is over, and a
  line in `normalize/surfaces.py` for any club changing surface or a grass club
  coming up.
- The old `explore-view` branch has nothing that is not on `main`; it can go.

## Working notes

- Run everything from the repo root with `.venv/Scripts/python`.
- In the Bash tool, heredocs holding `'''` strings broke; write edit scripts to
  a file and run them instead.
