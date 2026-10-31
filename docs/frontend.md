# Frontend

Plain HTML, CSS and JavaScript in `public/`: no framework and no build step.
Scripts load with `<script defer>`.

| File | What |
|---|---|
| `index.html` + `app.js` + `i18n.js` + `styles.css` | the site |
| `model.html` + `model.js` | the model page (`/model.html`), self-contained |
| `season-sim.js` | the what-if page's season simulation (a Web Worker) and its re-rating of the clubs (`rerateSeason`, a port of the Elo and attack/defence updates); also loaded as a plain script and required by the node tests |
| `thumbs.js` | the sliding pill of every segmented control, on both pages |
| `i18n.js` | `translations.en` and `translations.no`, one key table each; `t(key, vars)` |
| `vendor/three/` | three.js r147, vendored; loaded only when the season mountain opens |
| `fonts/`, `logos/`, `og.png` | assets |
| `icons/mark.svg`, `contours.svg` | the mark (favicon and wordmark) and the contour motif behind the hero; `tools/brand/` makes them and, from them, the PNG icons and `og.png` (see the scripts' headers) |
| `personvern.html`, `404.html`, `robots.txt`, `sitemap.xml` | static pages |
| `data/` | the built reports (git-ignored; see [operations.md](operations.md)) |

## `app.js`, by section

Sections start with a `/* ---------- name ---` header; search for the name.
In file order:

- **state and formatting** (top): the `state` object, report URLs, number
  formatting
- **accessibility utilities**, **tooltip**, **bands**, **legends**
- the views: **the finish grid** (and its animation), **standings**,
  **season shape**, **rating ladder** (and its animation), **fixtures**,
  **high stakes**, **played results**, **hero & model card**,
  **model card: how accurate the model is**, **team** (one club's focus view),
  **compare clubs**
- **explore**: the gallery, what the further views share, race lines, the luck table, **what if** (lock a score on any match, or auto-fill the rest; the Matches cards made editable with a By week / Your changes switch, the clubs re-rated, the chances beside them)
- **season rewind**, **theme**, **skeleton loading helpers**
- **wiring**: `render()`, the URL parameters, `popstate`, `boot`
- **analytics**, **mobile gestures**

The views share one `state` object and redraw through `render()`. The URL
is read at boot and on `popstate`, and written by `render()` and
`openTeamView`.

## Rules that bite

- **Decimal point in both languages** (AGENTS.md): `0.26`, `69.2 %`, inputs
  accept a typed comma. Thousands: a space in Norwegian (`50 000`, none at four
  digits), a comma in English.
- Every user-visible string goes through `i18n.js`, in both languages.
- Reports from older model versions (the past-seasons archive) can lack
  newer fields; the fallbacks for them are deliberate.

## Tests

`tests/frontend.test.js` (`node --test`) evaluates functions copied out of
`app.js` and `model.js`, and requires `season-sim.js` whole (`pick`, which slices a `function name(` declaration
out of the source; arrow-function constants cannot be picked). The model's
arithmetic is checked against `tests/fixtures/match_odds.json`, which the
Python model writes ([model.md](model.md), "The browser's copies").
`tests/season-shape.dom.js` boots the real page in jsdom (dev only).
