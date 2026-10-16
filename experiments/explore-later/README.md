# Explore views stored for later

Three Explore views built in October 2026 and taken off the site until they
are worked on. Their code, styles, strings and tests are here as they were;
none of it runs on its own.

| view | id | what it shows | what it needs before it comes back |
|---|---|---|---|
| The lift ("Heisen") | `lift` | every club's place in both divisions since 2015 as two lanes, promotions blue and relegations red | 48 clubs' lines are a tangle: a club picker (or highlight on hover that dims the rest for real), labels on the moves, a clearer phone layout |
| Rating river | `river` | every club's rating since 2015 on one axis, the division's clubs in colour | too many lines to read: pick clubs to follow (or search), fewer colours, end labels that do not crowd |
| Scorelines | `scorelines` | each scoreline's share of matches against the model's average chance of it (0-0 to 4+ a side) | per division and per season (it pools everything since 2016), and a clearer read of the gap than two numbers per cell |

## Files

- `views.js` -- the render functions and their helpers (`liftRows`, `liftMoves`,
  `monthlyRatings`, `riverSegments`, `scorelineCells`), the gallery thumbnails
  and the `renderExplore` routes, as cut from `public/app.js`.
- `styles.css` -- their rules from `public/styles.css`.
- `i18n.js` -- their strings, English and Norwegian.
- `tests.js` -- their tests from `tests/frontend.test.js`.

## Putting one back

0. Start a branch for it off `explore/base` (`git switch -c explore/<id>
   explore/base`) and copy these files' pieces in there; see HANDOFF.md on
   `main` for how a view goes from its branch to the site.
1. Add its id to `EXPLORE_ITEMS` in `public/app.js` (and to `EXPLORE_REWIND`
   if it follows the rewind slider; none of these three does).
2. Paste its section from `views.js` above the season mountain's section, its
   thumbnail branch into `exploreThumb` and its route into `renderExplore`.
3. Append its rules from `styles.css` as a block of its own. When it was cut
   it shared a few rules with the race lines and head to head (the padding,
   for `river` also `races__line`, `races__label` and the focus rule); those
   views now have rules of their own, so copy what it needs into its block.
4. Put its strings back into both languages of `public/i18n.js`.
5. Put its tests back (with the `eval(pick(...))` line at the top of `tests.js`).
6. Decide whether the hero shows for it (`public/styles.css`, the Explore rules
   under "The league hero only where it is the page's own story").

The lift and the river read `careers.json` (all seasons); the scorelines read
the `scorelines` block of `public/data/calibration.json`, which
`research.calibration_payload` still writes so the view can come back as is.
