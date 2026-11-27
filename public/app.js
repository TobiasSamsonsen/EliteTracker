/* EliteTracker front end.
   Plain modules, no framework: the whole payload is one JSON document and the
   page is a few pure render functions over it. */

const state = {
  reports: null,
  league: 'eliteserien',
  season: null,
  careers: null,
  // All-time meetings (h2h.json), fetched when Compare first wants them.
  h2h: null,
  // Referee stats (referees.json), fetched lazily for Explore and Team views.
  referees: null,
  refereeScope: 'all',
  refereeMetric: 'perMatch',
  refereeMinMatches: 5,
  refereeActiveOnly: false,
  refereeSelected: null,
  refereeClubSelected: null,
  refereePairingMode: 'referee',
  refereePairingTeam: null,
  refereeSort: { key: 'matches', dir: -1 },
  refereeSection: 'overview',
  refereeExplainOpen: false,
  clubDisciplineMetric: 'cards',
  clubDisciplineView: 'chart',
  clubDisciplineSort: { key: 'netCardsPerMatch', dir: -1 },
  teamRefereeSelected: null,
  // Default view is the league table as it actually stands.
  sort: { key: 'position', dir: 1 },
  // Table view mode: 'current' shows live stats, 'prediction' shows model stats.
  tableView: (typeof localStorage !== 'undefined' && localStorage.getItem('elitetracker-table-view')) || 'current',
  // Last sort used in each table view, restored when switching back to it.
  sortByView: {},
  // ISO date the whole page is rewound to; null means live.
  asof: null,
  rewindTimer: null,
  // Key of the league+season the compare pickers were last populated for.
  compareKey: '',
  // Active view tab: 'overview', 'grid', 'table', 'ladder', 'matches', 'compare', 'explore', 'team', 'model'
  // ?view= still wins -- see applyViewParameter.
  activeView: 'overview',
  // Open visualisation in the explore view (?viz=); null shows the gallery.
  exploreItem: null,
  raceBand: null,
  _prevActiveView: null,
  // Team focus: team_id when viewing the team tab, null otherwise.
  teamFocusId: null,
  // Open group in the team view: 'overview', 'forecast' or 'history'.
  teamTab: 'overview',
  // Week index on the Matches timeline; null opens on the current week.
  matchesWeek: null,
  // The what-if page: match_id -> locked [home, away] score, and its own week index.
  whatIfLocks: new Map(),
  // The locks the auto-fill set, which its button can take away again.
  whatIfAuto: new Set(),
  // Which list the what-if page shows: 'week' or 'changes'; whether the auto-filled group is open.
  whatIfView: 'week',
  runInMode: 'average',
  whatIfAutoOpen: false,
  whatIfWeek: null,
  // Pagination for team focus view.
  teamFixturesPage: 0,
  teamResultsPage: 0,
  teamResultsOpen: false,
  teamSeasonsPage: 0,
  // Finish-grid animation state.
  anim: {
    playing: false,
    matchdayIndex: 0,
    speed: 1,       // 1, 2, or 4
    reports: null,   // Map<int, {eliteserien, obosligaen}> once prefetched
    raf: null,
    lastTick: 0,
    interval: 600,   // ms per matchday at 1x
    // DOM references for in-place grid updates
    gridRows: null,  // Map<team_id, HTMLTableRowElement>
    gridCells: null, // Map<team_id, HTMLTableCellElement[]>
    gridTable: null,
    gridTableData: null,
    // In-place ladder updates: { teams, els: Map<team_id, HTMLElement>, track, maxStack }
    ladder: null,
  },
};
const anim = state.anim;

function localeDate() { return currentLang === 'no' ? 'nb-NO' : 'en-GB'; }

/* fotmob stores clubs under their registered names. These are what people
   actually call them -- HamKam brands itself that way, and "Odds Ballklubb"
   is the formal form of a club everyone calls Odd. Applied once to the
   payload rather than at each render, so the table, ladder, results, compare
   tool and career panel can never disagree about a club's name. Ratings and
   fixtures join on team_id, so this touches nothing but the labels. */
const SHORT_NAMES = {
  'Hamarkameratene': 'HamKam',
  'Odds Ballklubb': 'Odd',
  'Arendal Fotball': 'Arendal',
  'Stjørdals Blink': 'Blink',
  'FK Haugesund': 'Haugesund',
  'Øygarden FK': 'Øygarden',
};

const shortName = (name) => SHORT_NAMES[name] || name;

function applyShortNames(reports) {
  for (const report of Object.values(reports || {})) {
    for (const row of report.table || []) row.team = shortName(row.team);
    for (const list of [report.fixtures, report.results]) {
      for (const match of list || []) {
        match.home = shortName(match.home);
        match.away = shortName(match.away);
      }
    }
    for (const stake of report.high_stakes || []) {
      stake.team = shortName(stake.team);
      stake.opponent = shortName(stake.opponent);
    }
    for (const team of report.history?.teams || []) team.team = shortName(team.team);
    for (const [id, name] of Object.entries(report.relegation_playoff?.teams || {})) report.relegation_playoff.teams[id] = shortName(name);
  }
  return reports;
}

function applyShortNamesToCareers(careers) {
  for (const team of careers?.teams || []) team.team = shortName(team.team);
  return careers;
}

/* One URL scheme for both hosts. Firebase serves these as files built by
   build_site; the local server computes the same names on request, so nothing
   here has to know which one is answering.
     /data/report.json                    current season
     /data/report-<season>.json           that season, live
     /data/report-<season>-<asof>.json    rewound to that date */
function reportUrl(season, asof = null) {
  if (asof) return `/data/report-${season}-${asof}.json`;
  if (season) return `/data/report-${season}.json`;
  return '/data/report.json';
}

const $ = (selector) => document.querySelector(selector);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/* Club crests, served locally from the prebuilt logo bundle so the page stays
   dependency-free at render time. Keyed by the same fotmob team id the data
   uses, so a missing crest fails silently rather than breaking a row. */
/* `decorative`: the club's name is written beside the crest, so a screen
   reader would hear it twice; the crest then has no alt text of its own. */
const teamLogo = (teamId, name, decorative = false) => {
  if (!teamId) return null;
  const img = el('img', 'team-logo');
  img.src = `/logos/${teamId}.webp`;
  img.alt = decorative ? '' : name;
  img.loading = 'lazy';
  img.title = name;
  return img;
};


/* ---------- accessibility utilities ---------------------------------- */

/* Focus trap for modal dialogs. Returns a cleanup function. */
function trapFocus(element) {
  const focusable = element.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  function handleTab(event) {
    if (event.key !== 'Tab') return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  element.addEventListener('keydown', handleTab);
  first?.focus();

  return () => element.removeEventListener('keydown', handleTab);
}

const SEQ_STEPS = 7;
const HEAT_STOPS = [0.005, 0.02, 0.05, 0.1, 0.2, 0.35, 0.6];

function heatStep(probability) {
  let step = 0;
  while (step < HEAT_STOPS.length && probability >= HEAT_STOPS[step]) step += 1;
  return step; // 0 = effectively never, 1..7 = the ramp
}

function seqStepColor(step) {
  return step <= 0 ? 'var(--panel-sunk)' : `var(--seq-${Math.min(step, SEQ_STEPS)})`;
}

/* A continuous position on the ramp, for encodings with more levels than the
   ramp has stops. t = 0 sits nearest the surface, t = 1 furthest from it. */
function seqColor(t) {
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (SEQ_STEPS - 1);
  const lower = Math.floor(scaled);
  const upper = Math.min(SEQ_STEPS - 1, lower + 1);
  const blend = (scaled - lower) * 100;
  return `color-mix(in oklab, var(--seq-${upper + 1}) ${blend.toFixed(1)}%, var(--seq-${lower + 1}))`;
}

function outcomeClass(position, bands, count) {
  const band = bandFor(bands, position);
  if (!band) return 'neutral';
  // A band in the top half of the table is something to win, one in the
  // bottom half something to avoid. Used only for the qualification markers,
  // which are labelled status marks rather than part of the data encoding.
  return band.first < (count + 1) / 2 ? 'good' : 'bad';
}

/* Text must stay legible as the fill darkens (light theme) or brightens (dark
   theme). Step 5 is where the other ink clears 4.5:1 in both palettes: on
   light step 4 dark ink is 4.7:1 but white only 3.8:1. */
function heatTextClass(step) {
  return step >= 5 ? 'cell--invert' : '';
}

/* ---------- tooltip ---------------------------------------------- */

const tooltip = $('#tooltip');
let tooltipTrigger = null;

function showTooltip(event, html, triggerElement = null) {
  tooltip.innerHTML = html;
  tooltip.dataset.show = 'true';
  if (triggerElement) {
    // The readout is announced through the thing that raised it, so a
    // keyboard user hears the cell's text when focus lands on it.
    tooltipTrigger?.removeAttribute('aria-describedby');
    tooltipTrigger = triggerElement;
    triggerElement.setAttribute('aria-describedby', 'tooltip');
  }
  moveTooltip(event);
}

const coarsePointer = window.matchMedia('(pointer: coarse)');
/* The phone layout (the tab bar, bottom sheets): the same 760px as the CSS. */
const PHONE_SHEETS = window.matchMedia('(max-width: 760px)');

// Where the pointer is, so an animation frame can re-check what is under it
// without waiting for the next pointer event. Tracked on the whole document:
// updated only over cells, it went stale when the pointer left the grid, and
// every frame then found a cell at the old spot and kept the readout up.
const lastPointer = { x: -1, y: -1 };
document.addEventListener('pointermove', (event) => {
  lastPointer.x = event.clientX;
  lastPointer.y = event.clientY;
}, { passive: true });

/* The screen's bottom inset (a phone's home indicator), measured once from a
   probe sized by env(), since script cannot read env() directly. */
let safeBottomProbe = null;
function safeBottom() {
  if (!safeBottomProbe) {
    safeBottomProbe = el('div');
    safeBottomProbe.setAttribute('aria-hidden', 'true');
    safeBottomProbe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none';
    document.body.appendChild(safeBottomProbe);
  }
  return safeBottomProbe.offsetHeight;
}

/* The top of whatever is docked at the foot of the screen (the tab bar, What
   if's bar, the consent banner), or the screen's foot above its inset. */
function bottomObstacle() {
  let floor = window.innerHeight - safeBottom();
  for (const node of document.querySelectorAll('#mobilebar, .whatif__bar, #consent')) {
    if (node.hidden || node.closest('[hidden]')) continue;
    const rect = node.getBoundingClientRect();
    if (!rect.height || getComputedStyle(node).position !== 'fixed') continue;
    if (rect.bottom >= window.innerHeight - 4 - safeBottom() && rect.top < floor) floor = rect.top;
  }
  return floor;
}

function moveTooltip(event) {
  const box = tooltip.getBoundingClientRect();

  // A finger covers the thing it is pointing at, so on touch the readout is
  // parked above whatever is docked at the foot of the screen instead of
  // chasing the contact point.
  if (coarsePointer.matches) {
    tooltip.style.left = `${Math.max(8, (window.innerWidth - box.width) / 2)}px`;
    tooltip.style.top = `${Math.max(8, bottomObstacle() - box.height - 8)}px`;
    return;
  }

  const pad = 14;
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + box.width > window.innerWidth - 8) x = event.clientX - box.width - pad;
  if (y + box.height > window.innerHeight - 8) y = event.clientY - box.height - pad;
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
}


function hideTooltip() {
  tooltip.dataset.show = 'false';
  tooltipTrigger?.removeAttribute('aria-describedby');
  tooltipTrigger = null;
}

/* A hover readout that also works on touch. A tap fires pointerenter and then
   pointerleave straight away, which cleared the readout before it could be
   read; on touch it now stays until the next tap lands somewhere else. */
function attachTip(target, html) {
  target.addEventListener('pointerenter', (event) => showTooltip(event, typeof html === 'function' ? html() : html, target));
  target.addEventListener('pointermove', (event) => { if (event.pointerType !== 'touch') moveTooltip(event); });
  target.addEventListener('pointerleave', (event) => { if (event.pointerType !== 'touch') hideTooltip(); });
}

document.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'touch' && tooltipTrigger && !tooltipTrigger.contains(event.target)) hideTooltip();
}, { passive: true });

document.addEventListener('pointermove', (event) => {
  if (event.pointerType !== 'touch' && tooltipTrigger && (!tooltipTrigger.isConnected || !tooltipTrigger.contains(event.target))) {
    hideTooltip();
  }
}, { passive: true });


/* Address of the page on show. build_site writes a static page for each
   club of the current season and each Explore tool (pages.py); the app keeps
   the view in the query as well, so a link that predates the pages, or one to
   a club with no page, still opens the same view. `clubSlug` and
   `EXPLORE_SLUGS` mirror pages.py (a test compares them). */
const EXPLORE_SLUGS = {
  mountain: 'sesongfjellet', attack: 'angrep-mot-forsvar', luck: 'flakstabellen',
  referees: 'dommere', races: 'kapplopene', whatif: 'hva-om', runin: 'restprogrammet', playoff: 'nedrykkskvalik',
};
const routeClubs = new Set(); // slugs of the clubs that have a page, set at boot


function routePath() {
  if (state.activeView === 'team' && state.teamFocusId) {
    const slug = clubSlug(String(teamNameById(state.teamFocusId)));
    if (routeClubs.has(slug)) return `/klubb/${slug}/`;
  } else if (state.activeView === 'explore' && EXPLORE_SLUGS[state.exploreItem]) {
    return `/utforsk/${EXPLORE_SLUGS[state.exploreItem]}/`;
  } else if (state.activeView === 'predict') {
    return '/predict/';
  }
  return state.league === 'eliteserien' ? '/' : '/obos-ligaen/';
}

/* The query, plus what a route page names (its <meta name="et-route">) for
   whatever the query leaves out. Only until boot has finished: after that the
   address is the whole truth, and a stale route must not answer for it. */
function pageParams() {
  const params = new URLSearchParams(window.location.search);
  if (booted) return params;
  try {
    const route = JSON.parse(document.querySelector('meta[name="et-route"]')?.content || '{}');
    // A query that names a view or a club is a link of its own: the route then
    // only says which division the page belongs to.
    const own = params.has('view') || params.has('team');
    for (const [key, value] of Object.entries(route)) if (!params.has(key) && (!own || key === 'league')) params.set(key, value);
  } catch {
    // A malformed route leaves the address as it is.
  }
  return params;
}

/* The history entry's state follows the view on show: a club's entry remembers
   the club only while that club is open, so Back from a later club lands on a
   club or on the view the reader left, never on a stale one. */
function entryState() {
  return window.history.state;
}

/* A popup or sheet over the page takes an entry of its own, so Back closes it and stays. It reuses an
   entry that already is one (a popup opened from a sheet) and is not pushed while the page is still booting
   (a link that opens one has nothing to go back to). */
function pushOverlay(kind) {
  if (!booted) return;
  const current = window.history.state || {};
  // An entry that already is an overlay's is reused when this is the only one open (a popup opened from a
  // sheet, which closed first); one over another (the share sheet over the popup) gets its own.
  if (current.overlay && openOverlays() <= 1) { window.history.replaceState({ ...current, overlay: kind }, ''); return; }
  window.history.replaceState({ ...current, y: window.scrollY }, '');
  window.history.pushState({ n: historyDepth() + 1, overlay: kind }, '', window.location.href);
}
/* The × / scrim / swipe of an overlay: it closes at once, and its entry, when it has one, is stepped back off
   (the popstate then finds nothing left to close). */
let overlaySteppedBack = false;
function dismissOverlay(close) {
  const marked = Boolean(window.history.state && window.history.state.overlay);
  close();
  // The popstate this step fires closes nothing more: the share sheet over a popup opened by a link (which
  // has no entry of its own) steps back onto the page's entry, and the popup under it stays.
  if (marked) { overlaySteppedBack = true; window.history.back(); }
}
const dismissScenario = () => dismissOverlay(() => closeScenario());
const dismissSheet = () => dismissOverlay(() => closeSheet());
const shareOpen = () => typeof shareClose === 'function' && Boolean(shareClose);   // share.js
function openOverlays() {
  const sheet = $('#more-sheet');
  return (scenarioState.root ? 1 : 0) + (sheet && !sheet.hidden ? 1 : 0) + (shareOpen() ? 1 : 0);
}
function overlayOpen() {
  return openOverlays() > 0;
}

/* The links on Matches and Table into the Explore tools. */
function openTool(id) {
  if (anim.playing) animStop();
  state.activeView = 'explore';
  markActiveView();
  openExplore(id);
}

/* Marker colour for a qualification band.
   Each band gets its own distinct hue so the decisive-match dot is
   instantly recognisable without text. Tone alone is not enough:
   a play-off is a good thing in OBOS-ligaen (promotion) and a bad
   one in Eliteserien (relegation). Promotion takes the blue, not the
   champions' yellow: its top place is both, so a club decisive for both
   shows two dots that must differ. Blue is free in OBOS-ligaen and the
   colour-blind-safe partner of the relegation red. */
function bandColor(band, count) {
  const label = band.label;
  if (label === 'Champions') return 'var(--band-champion)';
  if (label === 'Champions League qualification') return 'var(--outcome-good)';
  if (label === 'Europa League qualification') return 'var(--edge-el)';
  if (label === 'Conference League qualification') return 'var(--edge-ecl)';
  if (label === 'Relegation') return 'var(--outcome-bad)';
  if (label === 'Relegation play-off') return 'var(--band-relegation-playoff)';
  if (label === 'Promotion') return 'var(--outcome-good)';
  if (label === 'Promotion play-off') return 'var(--edge-el)';
  // Fallback: good vs bad based on table half
  return outcomeClass(band.first, [band], count) === 'good'
    ? 'var(--outcome-good)'
    : 'var(--outcome-bad)';
}

function ordinal(n) {
  return currentLang === 'no' ? `${n}. plass` : `${ordinalShort(n)} place`;
}

/* "3rd" / "3.": for tiles where the label already says it is a position. */
function ordinalShort(n) {
  if (currentLang === 'no') return `${n}.`;
  const suffix = ['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th';
  return `${n}${suffix}`;
}

/* One notation for the same fact in every view (DESIGN_PLAN, Round 1 item 4;
   written out in docs/frontend.md). A rank standing alone is `3.` in
   Norwegian and `#3` in English, each language's own way (a rank inside a
   sentence stays an ordinal: "3rd place"); a
   change is an arrow and its size, ▲ up and ▼ down, in the outcome colours,
   with no sign (the arrow is the sign). Only for a change that rounds to
   something: callers leave a zero out. */
const rankText = (n) => (currentLang === 'no' ? `${n}.` : `#${n}`);
const changeText = (value, digits = 0) => `${value > 0 ? '▲' : '▼'} ${num(Math.abs(value), digits)}`;

/* ---------- legends ----------------------------------------------- */

function renderGridLegend(report) {
  const legend = $('#grid-legend');
  legend.replaceChildren();

  legend.appendChild(el('span', 'label', t('grid.legend.label')));
  const key = el('span', 'legend__key');
  key.appendChild(el('span', '', t('grid.legend.unlikely')));
  const ramp = el('span', 'legend__ramp');
  for (let step = 1; step <= SEQ_STEPS; step += 1) {
    const swatch = el('i');
    swatch.style.background = seqStepColor(step);
    ramp.appendChild(swatch);
  }
  key.appendChild(ramp);
  key.appendChild(el('span', '', t('grid.legend.likely')));
  legend.appendChild(key);

  // Where a square opens what it takes (a season left to play), the view's
  // description says so, for touch and mouse alike; the legend adds the
  // mouse's decimals, and on touch, where a tap opens it, nothing more.
  const opens = scenarioAvailable(report) ? 'Open' : '';
  const desc = $('#grid-desc');
  desc.dataset.i18n = opens ? 'grid.descOpen' : 'grid.desc';
  desc.textContent = t(desc.dataset.i18n);
  if (!(coarsePointer.matches && opens)) {
    legend.appendChild(el('span', '', t(coarsePointer.matches ? 'grid.legend.hintTouch' : `grid.legend.hint${opens}`)));
  }
}

function renderBandLegend(report) {
  const legend = $('#band-legend');
  legend.replaceChildren();
  for (const band of report.league.bands) {
    const key = el('span', 'legend__key');
    const swatch = el('span', 'legend__swatch');
    swatch.style.background = bandColor(band, report.table.length);
    key.appendChild(swatch);
    const range = band.first === band.last ? `${band.first}` : `${band.first}–${band.last}`;
    key.appendChild(el('span', '', `${bandName(band)} (${range})`));
    legend.appendChild(key);
  }
}

function renderOddsLegend(report) {
  const legend = $('#odds-legend');
  legend.replaceChildren();
  legend.appendChild(el('span', 'label', t('next.result')));
  for (const [outcome, key] of [['home', 'next.homeWin'], ['draw', 'next.draw'], ['away', 'next.awayWin']]) {
    const entry = el('span', 'legend__key');
    const swatch = el('span', 'legend__swatch');
    swatch.style.background = `var(--${outcome})`;
    entry.appendChild(swatch);
    entry.appendChild(el('span', '', t(key)));
    legend.appendChild(entry);
  }
  // The dots beside a club are otherwise explained only on hover.
  if (report?.high_stakes?.length) {
    const entry = el('span', 'legend__key');
    const dots = el('span', 'stake-flag__dots');
    for (const colour of ['--band-champion', '--outcome-good', '--outcome-bad']) {
      const dot = el('span', 'stake-flag__dot');
      dot.style.background = `var(${colour})`;
      dots.appendChild(dot);
    }
    entry.append(dots, el('span', '', t('next.decisive')));
    legend.appendChild(entry);
  }
}

/* ---------- season shape: stacked area over the season ------------- */

/* Career points are dated by matchday, not by clock time. Midday UTC keeps a
   point on its own day in every timezone the page is read in. */
const pointTime = (point) => Date.parse(`${point[0]}T12:00:00Z`);

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

/* Views and feature modules live in public/app/*.js, loaded before this file. */

/* ---------- theme -------------------------------------------------- */

function resolveTheme() {
  const chosen = localStorage.getItem('elitetracker-theme');
  document.documentElement.dataset.resolvedTheme = chosen === 'light' || chosen === 'dark' ? chosen
    : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  $('meta[name=theme-color]').content =
    document.documentElement.dataset.resolvedTheme === 'dark' ? '#080f1c' : '#e8edf5';
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === chosen));
    // With no choice made the device decides: its theme is outlined, not lit.
    button.toggleAttribute('data-auto', !chosen && button.dataset.themeChoice === document.documentElement.dataset.resolvedTheme);
  }
}

/* ---------- skeleton loading helpers ---------------------------------- */

/* Show skeleton placeholders while data loads. Called before render functions
   to provide immediate visual feedback. */
function showSkeleton(view) {
  const section = document.querySelector(`[data-section="${view}"]`);
  if (!section) return;

  const panel = section.querySelector('.panel');
  if (!panel) return;

  // Clear existing content except panel head
  const panelHead = panel.querySelector('.panel__head');
  const scroller = panel.querySelector('.scroller');
  const legend = panel.querySelector('.legend');
  const fixtures = panel.querySelector('.fixtures');
  const compareOutput = panel.querySelector('#compare-output');
  const modelGrid = panel.querySelector('.model-grid');
  const caveats = panel.querySelector('.caveats');
  const ladderTrack = panel.querySelector('.ladder__track');
  const gridAnimBar = panel.querySelector('.grid-anim-bar');

  // Remove old skeletons
  panel.querySelectorAll('.skeleton-row, .skeleton-fixture, .skeleton-played-card, .skeleton-grid-cell, .skeleton-ladder-row').forEach(el => el.remove());

  if (view === 'table' || view === 'grid') {
    const table = scroller?.querySelector('table') || panel.querySelector('table');
    if (table) {
      const tbody = table.querySelector('tbody');
      if (tbody) {
        // Add 8 skeleton rows
        for (let i = 0; i < 8; i++) {
          const tr = document.createElement('tr');
          tr.className = 'skeleton-row';
          if (view === 'grid') {
            // Grid has 17 columns (pos + 16 positions)
            for (let j = 0; j < 17; j++) {
              const td = document.createElement('td');
              td.className = 'skeleton skeleton-grid-cell';
              tr.appendChild(td);
            }
          } else {
            // Standings table
            for (let j = 0; j < 10; j++) {
              const td = document.createElement('td');
              td.className = 'skeleton skeleton-cell';
              tr.appendChild(td);
            }
          }
          tbody.appendChild(tr);
        }
      }
    }
  } else if (view === 'ladder') {
    if (ladderTrack) {
      for (let i = 0; i < 10; i++) {
        const div = document.createElement('div');
        div.className = 'skeleton skeleton-ladder-row';
        ladderTrack.appendChild(div);
      }
    }
  } else if (view === 'matches') {
    if (fixtures) {
      for (let i = 0; i < 5; i++) {
        const div = document.createElement('div');
        div.className = 'skeleton skeleton-fixture';
        fixtures.appendChild(div);
      }
    }
  }
}

/* ---------- Predict: the prediction game, a view of its own ----------

   Its code (predict*.js, predict.css; docs/predict.md) is fetched the first
   time the view opens, so the rest of the site never pays for it. It reads
   none of the season report, so a link to /predict/ draws the game at once
   instead of waiting for the report (bootPredict). */
const PREDICT_HASHES = new Set(['table', 'boards', 'leagues', 'me', 'how']);
const PREDICT_FILES = ['/elo-curve.js', '/predict-core.js', '/predict-util.js', '/predict-api.js', '/predict.js'];
let predictLoad = null;

/* One script, once: the game and the Overview's Predict card share the first four, and a classic
   script run twice is a redeclaration error. Scripts added in order run in order. */
const predictScript = (src) => loadScript(src);
const predictScriptsInOrder = (files) => loadScriptsInOrder(files);

function loadPredict() {
  if (window.PredictGame) return Promise.resolve();
  if (!predictLoad) {
    const css = document.querySelector('link[rel="stylesheet"][href="/predict.css"]') ? Promise.resolve() : new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/predict.css';
      link.onload = resolve;
      link.onerror = resolve; // the game still works unstyled
      document.head.appendChild(link);
    });
    // One after the other: each needs the one before. A failure leaves the files that did load alone, so
    // the retry runs only the rest (running a loaded file again is a redeclaration error).
    predictLoad = Promise.all([css, predictScriptsInOrder(PREDICT_FILES)]).catch((error) => {
      predictLoad = null;
      throw error;
    });
  }
  return predictLoad;
}

function renderPredict() {
  if (window.PredictGame) {
    window.PredictGame.show();
    return;
  }
  loadPredict().then(() => {
    if (state.activeView === 'predict') window.PredictGame.show();
  }).catch((error) => {
    console.warn('[Predict] could not load', error);
    track('load_error', { file: 'predict', message: error.message });
    const retry = el('button', 'pbtn', t('predict.retry'));
    retry.type = 'button';
    retry.addEventListener('click', renderPredict);
    $('#predict-view').replaceChildren(el('p', 'pempty', t('predict.err.load')), retry);
  });
}

/* Before the season report has landed (or when it failed): the sections for
   the open view, and the game if that is the view. Every other view waits for
   the report, which draws the page again when it lands. */
function renderWithoutReport() {
  for (const section of document.querySelectorAll('[data-section]')) {
    section.hidden = !section.dataset.section.split(' ').includes(state.activeView);
  }
  document.body.dataset.view = state.activeView;
  document.body.dataset.viz = '';
  const params = new URLSearchParams(window.location.search);
  params.set('view', state.activeView);
  const path = state.activeView === 'predict' ? '/predict/' : window.location.pathname;
  window.history.replaceState(window.history.state, '', `${path}?${params.toString()}${window.location.hash}`);
  if (state.activeView === 'predict') renderPredict();
}

/* A link to the game opens it at once, before the report has loaded. */
function bootPredict() {
  if (pageParams().get('view') !== 'predict') return;
  state.activeView = 'predict';
  markActiveView();
  $('#status').hidden = true;
  $('#content').hidden = false;
  renderWithoutReport();
}

/* Clear skeletons after render */
function clearSkeleton(view) {
  const section = document.querySelector(`[data-section="${view}"]`);
  if (!section) return;
  section.querySelectorAll('.skeleton-row, .skeleton-fixture, .skeleton-played-card, .skeleton-grid-cell, .skeleton-ladder-row').forEach(el => el.remove());
}

/* ---------- wiring -------------------------------------------------- */

function render() {
  const scrolled = window.scrollY;         // before the sections change: a page that shortens clamps it
  const report = state.reports[state.league];
  // A readout raised on the old view would float over the new one: a tap on
  // a club name both raises the stake readout and opens the club.
  hideTooltip();
  if (state.activeView !== 'predict') {
    window.PredictGame?.hide();
  }
  // The season is still on its way (or failed to come): only the game, which
  // does not read it, can be drawn (bootPredict).
  if (!report) {
    renderWithoutReport();
    return;
  }

  // Always render these (they're either always visible or quick)
  renderSeasonOptions(report);
  renderTimeline(report);
  renderHero(report);
  renderBackdrop(report);

  // Show/hide sections based on active view
  for (const section of document.querySelectorAll('[data-section]')) {
    const views = section.dataset.section.split(' ');
    section.hidden = !views.includes(state.activeView);
  }

  renderToolLinks(report);

  // Hide the rewind timeline on views where it isn't relevant
  const noRewind = new Set(['matches', 'compare', 'model', 'team', 'predict']);
  // In explore only the views of one rewound report follow it (EXPLORE_REWIND);
  // the mountain has its own build-up.
  placeTimeline(!noRewind.has(state.activeView)
    && (state.activeView !== 'explore' || EXPLORE_REWIND.has(state.exploreItem))
    && liveMatchdaysFor(state.league).length >= 2);
  // Lets the stylesheet slim the league hero down in a club's view, and fit
  // the season mountain to a phone's screen.
  document.body.dataset.view = state.activeView;
  document.body.dataset.viz = state.activeView === 'explore' ? state.exploreItem || '' : '';
  // The hero just set the model badge beside the wordmark, which can take
  // room from the tabs.
  fitViews();

  // Team view requires a selected team; fall back to table if none
  if (state.activeView === 'team' && !state.teamFocusId) {
    state.activeView = 'table';
    markActiveView();
  }

  // View-specific renders
  // Clear skeletons from previous view
  clearSkeleton(state._prevActiveView);
  clearSkeleton(state.activeView);
  switch (state.activeView) {
    case 'overview':
      renderOverview();
      break;
    case 'table':
      renderStandings(report);
      renderBandLegend(report);
      break;
    case 'grid':
      if (!anim.playing) {
        renderGrid(report);
        renderGridLegend(report);
        $('#grid-anim-play').hidden = liveMatchdaysFor(state.league).length < 2;
      }
      break;
    case 'ladder':
      if (!anim.playing) {
        renderLadder(state.reports);
        const days = liveMatchdaysFor(state.league);
        $('#ladder-anim-play').hidden = days.length < 2;
      }
      break;
    case 'matches':
      if (state._prevActiveView !== 'matches') state.matchesWeek = null;
      renderMatches(report);
      renderOddsLegend(report);
      break;
    case 'compare':
      populateCompare(report);
      renderCompare(report);
      break;
    case 'team':
      renderTeamView(report);
      break;
    case 'explore':
      renderExplore(report);
      break;
    case 'model':
      renderModelCard(report);
      break;
    case 'predict':
      renderPredict();
      break;
  }

  // Persist active view to URL for linkability
  const params = new URLSearchParams(window.location.search);
  params.set('view', state.activeView);
  if (state.activeView === 'team' && state.teamFocusId) {
    const teamName = (state.reports[state.league].table.find((t) => String(t.team_id) === String(state.teamFocusId)) || careerById(state.teamFocusId) || {}).team;
    if (teamName) params.set('team', teamName);
    else params.delete('team');
  } else {
    params.delete('team');
  }
  if (state.activeView === 'explore' && state.exploreItem) params.set('viz', state.exploreItem);
  else params.delete('viz');
  if (state.activeView !== 'compare') params.delete('compare'); // renderCompare writes it
  if (state.activeView !== 'predict') params.delete('join');
  const locked = state.activeView === 'explore' && state.exploreItem === 'whatif' ? lockParam(state.whatIfLocks, report) : '';
  if (locked) params.set('lock', locked);
  else params.delete('lock');
  // Season and rewind date too, so a reload or a shared link lands where the
  // reader was; boot reads both back.
  if (report.league.season !== report.league.current_season) params.set('season', report.league.season);
  else params.delete('season');
  if (state.asof) params.set('asof', state.asof);
  else params.delete('asof');
  if (state.league !== 'eliteserien') params.set('league', state.league);
  else params.delete('league');

  // One search result per division: the canonical keeps only the league, so
  // view, team, season and rewind links all fold into their division's page.
  const meta = { league: report.league.name, season: report.league.season, chances: t(`meta.chances.${state.league}`) };
  document.title = t('meta.title', meta);
  if (state.activeView === 'team' && state.teamFocusId) {
    document.title = t('meta.team.title', { team: teamNameById(state.teamFocusId), season: meta.season });
  } else if (state.activeView === 'explore' && EXPLORE_ITEMS.includes(state.exploreItem)) {
    document.title = t('meta.tool.title', { tool: t(`explore.${state.exploreItem}.title`), league: meta.league, season: meta.season });
  }
  if (state.activeView === 'predict') document.title = window.PredictGame?.title() || `${t('predict.title')} — EliteTracker`;
  document.querySelector('meta[name=description]').content = state.activeView === 'predict' ? t('predict.tagline') : t('meta.desc', meta);
  // The newest result the numbers rest on (the report holds no build time).
  const through = report.league.matchdays?.at(-1)?.date;
  $('#footer-data').textContent = through
    ? t('footer.data', { date: new Date(`${through}T12:00:00Z`).toLocaleDateString(localeDate(), { day: 'numeric', month: 'long', year: 'numeric' }) })
    : '';
  let canonical = document.querySelector('link[rel=canonical]');
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.rel = 'canonical';
    document.head.appendChild(canonical);
  }
  const route = routePath();
  canonical.href = `https://elitetracker.no${route}`;
  // The game's own addresses (#boards, #leagues, #me, ...) are not another view's.
  const hash = state.activeView !== 'predict' && PREDICT_HASHES.has(window.location.hash.slice(1)) ? '' : window.location.hash;
  const address = `${route}?${params.toString()}${hash}`;
  const key = pageKeyOf(params);
  const here = window.history.state || {};
  if (lastPageKey !== null && key !== lastPageKey) {
    // A new page. Remember where the old one was scrolled to; an overlay's entry becomes the new page's.
    if (!here.overlay) {
      window.history.replaceState({ ...here, y: scrolled }, '');
      window.history.pushState({ n: historyDepth() + 1 }, '', address);
    } else {
      window.history.replaceState({ n: here.n }, '', address);
    }
  } else {
    window.history.replaceState(entryState(), '', address);
  }
  lastPageKey = key;
  // After the title, which the page view carries.
  pageView();
  state._prevActiveView = state.activeView;
}

// Switch the active view: shared by top-strip/bar clicks and the bar swipe.
// The page slides the way the tabs run (a swipe passes its own way, so the
// page follows the finger); see "Switching tab" in the stylesheet. On a
// phone the views in the More sheet are not beside the bar's, so going to
// one the page rises from below, as the sheet did, and coming back it sinks.
function switchView(view, { dir } = {}) {
  closeSheet();
  if (anim.playing && view !== state.activeView) animStop();
  const order = VIEW_ORDER;
  const from = order.indexOf(state.activeView);
  const to = order.indexOf(view);
  const inSheet = (v) => !!document.querySelector(`.sheet__item[data-view="${v}"]`);
  const bar = $('#mobilebar');
  const vertical = dir === undefined && bar && getComputedStyle(bar).display !== 'none'
    && (inSheet(view) || inSheet(state.activeView));
  const update = () => {
    // The Explore tab always opens on its gallery.
    if (view === 'explore') state.exploreItem = null;
    state.activeView = view;
    markActiveView();
    render();
    hideTooltip();
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  if (view === state.activeView || !document.startViewTransition
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return;
  }
  const root = document.documentElement;
  // The old view's picture leaves from where it stood (see "Switching tab").
  root.style.setProperty('--view-scroll', `${window.scrollY}px`);
  if (vertical) {
    root.dataset.transition = 'vertical';
    root.style.setProperty('--view-dir', inSheet(view) ? '1' : '-1');
  } else {
    root.style.setProperty('--view-dir', String(dir ?? (from >= 0 && to >= 0 && to < from ? -1 : 1)));
  }
  document.startViewTransition(update).finished.finally(() => { delete root.dataset.transition; });
}

function wire() {
  for (const button of document.querySelectorAll('[data-league]')) {
    button.addEventListener('click', () => {
      closeAllMenus();
      if (anim.playing) animStop();
      state.league = button.dataset.league;
      for (const other of document.querySelectorAll('[data-league]')) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      render();
      hideTooltip();
    });
  }

  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.addEventListener('click', () => {
      const choice = button.dataset.themeChoice;
      const current = localStorage.getItem('elitetracker-theme');
      if (current === choice) localStorage.removeItem('elitetracker-theme');
      else localStorage.setItem('elitetracker-theme', choice);
      resolveTheme();
      render();
      track('set_theme', { theme: localStorage.getItem('elitetracker-theme') || 'system' });
    });
  }

  for (const button of document.querySelectorAll('[data-lang]')) {
    button.addEventListener('click', async () => {
      const lang = button.dataset.lang;
      try {
        await ensureLang(lang);
      } catch (error) {
        console.warn('[i18n] language load failed', error);
        return;
      }
      setLang(lang);
      track('set_language', { language: lang });
      for (const other of document.querySelectorAll('[data-lang]')) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      render();
    });
  }

  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => {
      switchView(button.dataset.view);
    });
  }
  // A plain link to a view (the footer's to the game) stays in the page.
  for (const link of document.querySelectorAll('[data-view-link]')) {
    link.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      switchView(link.dataset.viewLink);
    });
  }

  // Panel descriptions are clamped to two lines on a phone; a tap opens one.
  // Delegated, because every view rebuilds its own panel content.
  document.addEventListener('click', (event) => {
    const description = event.target.closest('.panel__head p');
    if (description) description.classList.toggle('is-expanded');
  });

  // Settings gear: toggle settings popover.
  const settingsBtn = $('#settings-btn');
  const settingsMenu = $('#settings-menu');
  settingsBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = !settingsMenu.hidden;
    settingsMenu.hidden = open;
    settingsBtn.setAttribute('aria-expanded', String(!open));
    if (!open) {
      positionPopover(settingsMenu, settingsBtn);
      menuFocusCleanup = trapFocus(settingsMenu);
    } else {
      menuFocusCleanup?.();
      menuFocusCleanup = null;
    }
  });

  // Masthead More tab: the views the strip has no room for.
  const viewsMore = $('#views-more');
  const viewsMenu = $('#views-more-menu');
  viewsMore.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = !viewsMenu.hidden;
    closeAllMenus();
    if (open) return;
    viewsMenu.hidden = false;
    viewsMore.setAttribute('aria-expanded', 'true');
    positionPopover(viewsMenu, viewsMore);
    menuFocusCleanup = trapFocus(viewsMenu);
  });
  viewsMenu.addEventListener('click', (event) => {
    if (event.target.closest('[data-view]')) closeAllMenus();
  });
  window.addEventListener('resize', () => {
    if (!viewsMenu.hidden) closeAllMenus();
    fitViews();
  });
  document.fonts?.ready.then(fitViews);

  // Mobile More button: toggle the sheet.
  const moreButton = $('#more-button');
  const moreSheet = $('#more-sheet');
  if (moreButton) {
    moreButton.addEventListener('click', () => {
      if (moreSheet.hidden) openSheet();
      else dismissSheet();
    });
  }
  for (const closer of document.querySelectorAll('[data-close-sheet]')) {
    closer.addEventListener('click', dismissSheet);
  }

  const stepMatchday = (delta) => {
    const range = $('#timeline-range');
    range.value = String(Number(range.value) + delta);
    range.dispatchEvent(new Event('input', { bubbles: true }));
  };
  $('#timeline-back').addEventListener('click', () => stepMatchday(-1));
  $('#timeline-forward').addEventListener('click', () => stepMatchday(1));

  $('#grid-anim-play').addEventListener('click', animStart);
  // The finish grid as a picture (share.js), or its link.
  $('[data-section="grid"] .panel__tools').append(shareButton({
    title: () => `${t('grid.title')} · ${state.reports[state.league]?.league.name || ''}`,
    image: () => shareFinishGrid(state.reports[state.league]),
  }));
  // Leaving the grid always clears its readout, even when the cell that had
  // the pointer was moved or replaced mid-animation and fires no leave itself.
  $('#grid').addEventListener('pointerleave', hideTooltip);

  $('#ladder-anim-play').addEventListener('click', animStart);
  for (const button of document.querySelectorAll('.grid-anim-speed [data-speed]')) {
    button.addEventListener('click', () => animSetSpeed(Number(button.dataset.speed)));
  }

  for (const button of document.querySelectorAll('#standings .sort-btn')) {
    button.addEventListener('click', () => toggleSort(button.dataset.sortKey));
  }

  // Bind table view toggle buttons.
  for (const button of document.querySelectorAll('[data-table-mode]')) {
    button.addEventListener('click', () => {
      toggleTableView(button.dataset.tableMode);
      track('set_table_view', { table_view: button.dataset.tableMode });
    });
  }

  $('#season-select').addEventListener('change', async (event) => {
    await loadSeason(Number(event.target.value));
  });

  $('#timeline-range').addEventListener('input', onTimelineInput);
  $('#timeline-now').addEventListener('click', () => { if (anim.playing) animStop(); rewindTo(null); });
  // Folding the panel on a rewound page goes back to live as well: a page
  // that shows an old day must keep the slider that says so.
  $('#timeline-toggle').addEventListener('click', () => {
    const open = !$('#timeline').classList.contains('is-open');
    setTimelineOpen(open);
    if (!open && state.asof) {
      if (anim.playing) animStop();
      rewindTo(null);
    }
  });

  for (const select of [$('#compare-a'), $('#compare-b')]) {
    select.addEventListener('change', () => {
      renderCompare(state.reports[state.league]);
      track('compare_clubs', { club_a: $('#compare-a').selectedOptions[0]?.text, club_b: $('#compare-b').selectedOptions[0]?.text });
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeAllMenus();
  });

// Close menus when clicking outside.
  document.addEventListener('pointerdown', (event) => {
    const settingsMenu = $('#settings-menu');
    const settingsBtn = $('#settings-btn');
    const leagueMenu = $('#hero-league-menu');
    const seasonMenu = $('#hero-season-menu');
    const viewsMenu = $('#views-more-menu');
    if (!viewsMenu.hidden && !viewsMenu.contains(event.target) && !event.target.closest('#views-more')) {
      viewsMenu.hidden = true;
      $('#views-more').setAttribute('aria-expanded', 'false');
      menuFocusCleanup?.();
      menuFocusCleanup = null;
    }
    if (!settingsMenu.hidden && !settingsMenu.contains(event.target) && event.target !== settingsBtn) {
      settingsMenu.hidden = true;
      settingsBtn.setAttribute('aria-expanded', 'false');
      menuFocusCleanup?.();
      menuFocusCleanup = null;
    }
    if (!leagueMenu.hidden && !leagueMenu.contains(event.target) && !event.target.closest('.hero-title-part[data-role="division"]')) {
      leagueMenu.hidden = true;
      menuFocusCleanup?.();
      menuFocusCleanup = null;
    }
    if (!seasonMenu.hidden && !seasonMenu.contains(event.target) && !event.target.closest('.hero-title-part[data-role="season"]')) {
      seasonMenu.hidden = true;
      menuFocusCleanup?.();
      menuFocusCleanup = null;
    }
  });

  // Mobile gesture handling: swipe navigation, pull-to-refresh, swipe-to-dismiss sheet
  initMobileGestures();

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    resolveTheme();
    render();
  });

  document.addEventListener('click', (event) => {
    const link = event.target.closest('[data-open-tool]');
    if (link) openTool(link.dataset.openTool);
  });

  window.addEventListener('popstate', (event) => restoreFromAddress(event.state));
}

/* Back and Forward: the page the address names. A popup or sheet open over the page closes first (Back
   from it stays on the page); a different page (view, tool, club) is read back from the query, whatever it
   leaves out reset to its default. The game's own entries (a tab's #hash) are its own. */
function restoreFromAddress(entry) {
  if (!booted || !state.reports[state.league]) return;
  const params = new URLSearchParams(window.location.search);
  const ownStep = overlaySteppedBack;      // an overlay's ×, scrim or Escape stepping off its entry (dismissOverlay)
  overlaySteppedBack = false;
  // Landed on an overlay's own entry (Back from the share sheet over the popup): only what lies above it closes.
  if (entry && entry.overlay) {
    if (entry.overlay !== 'share' && shareOpen()) shareClose();
    return;
  }
  // A popup, sheet or picker still open belongs to the page being left.
  if (!ownStep) {
    if (shareOpen()) shareClose();
    closeScenario({ restore: false });
    closeAllMenus();
  }
  const key = pageKeyOf(params);
  if (key === lastPageKey) return;
  lastPageKey = key;                       // so the draw below replaces the entry instead of pushing
  if (anim.playing) animStop();
  const league = params.get('league');
  state.league = league && state.reports[league] ? league : 'eliteserien';
  for (const button of document.querySelectorAll('[data-league]')) {
    button.setAttribute('aria-pressed', String(button.dataset.league === state.league));
  }
  state.teamFocusId = null;
  state.exploreItem = null;
  applyViewParameter();
  if (state.activeView === 'team') applyTeamParameter();
  if (state.activeView !== 'team' || !state.teamFocusId) render();
  window.scrollTo({ top: (entry && entry.y) || 0, behavior: 'instant' });
}

/* ?league=obosligaen&team=Viking makes any view linkable. Team is matched on
   name so a shared link stays readable. */
/* ?sort=rating&dir=desc — the table view is linkable like the rest. */
function applySortParameter() {
  const params = new URLSearchParams(window.location.search);
  const key = params.get('sort');
  state.sort = DEFAULT_SORT[state.tableView] || DEFAULT_SORT.current;
  if (!key) return;
  const known = document.querySelector(`#standings th[data-sort-col="${CSS.escape(key)}"]`);
  if (!known) return;
  const dir = params.get('dir') === 'asc' ? 1 : params.get('dir') === 'desc' ? -1
    : SORT_ASCENDING_FIRST.has(key) ? 1 : -1;
  state.sort = { key, dir };
}

function applyLeagueParameter() {
  const league = pageParams().get('league');
  if (!league || !state.reports[league]) return;
  state.league = league;
  for (const button of document.querySelectorAll('[data-league]')) {
    button.setAttribute('aria-pressed', String(button.dataset.league === league));
  }
}

/* Team is matched on name so a shared link stays readable. Applied after the
   first render, once the club list exists. */
function applyTeamParameter() {
  const wanted = pageParams().get('team');
  if (!wanted) return;
  const pool = state.careers?.teams || Object.values(state.reports).flatMap((r) => r.table);
  const club = pool.find((team) => team.team.toLowerCase() === wanted.toLowerCase());
  if (club) openTeamView(club.team_id, club.team);
}

/* The tab strip, mobile bar, and any other data-view buttons are marked from
   here. On desktop the strip scrolls sideways once it outgrows its container,
   so its active tab is pulled back into sight. On mobile the fixed bar shows
   four views; when the current one lives in the sheet, More carries the mark
   so the bar is never blank. */
/* The masthead's tabs that do not fit go behind a "More" tab, last first, as
   the phone's More sheet holds what its bottom bar has no room for; More is
   marked when the open view is among them. Measured rather than set by a
   breakpoint, since the labels' width differs by language. A phone hides the
   whole strip for its bottom bar. */
/* The views in the navigation's order: the five the masthead always shows,
   then the three under More. A slide between views moves this way. */
const VIEW_ORDER = ['overview', 'table', 'matches', 'grid', 'explore', 'predict', 'ladder', 'compare', 'model'];

/* The masthead's right-hand group keeps the width it has with every picker
   on show, so the views that hide the division picker (the overview, the
   ladder, ...) leave its room empty rather than hand it to the tabs, and the
   tabs never move between views. */
function reserveMastheadEnd() {
  const end = $('.masthead__end');
  if (!end) return;
  end.style.minWidth = '';
  document.body.classList.add('masthead-measure');
  const width = end.getBoundingClientRect().width;
  document.body.classList.remove('masthead-measure');
  end.style.minWidth = `${Math.ceil(width)}px`;
}

/* The masthead's tabs: the five primary views, More always after them (the
   ladder, the compare tool and the model card). Only when the window is too
   narrow for all five does one fold into More, from the end; what folds
   depends on the window's width alone, never on the view open. */
function fitViews() {
  const holder = $('.masthead__views');
  const more = $('#views-more');
  if (!holder || !more) return;
  reserveMastheadEnd();
  const tabs = [...holder.querySelectorAll('.switch [data-view]')];
  const items = new Map([...document.querySelectorAll('#views-more-menu [data-view]')].map((item) => [item.dataset.view, item]));
  for (const tab of tabs) {
    tab.hidden = false;
    items.get(tab.dataset.view).hidden = true;
  }
  const fits = () => holder.scrollWidth <= holder.clientWidth + 1;
  if (holder.offsetParent && !fits()) {
    for (const tab of [...tabs].reverse()) {
      if (fits() || tab.dataset.view === 'overview') break;
      tab.hidden = true;
      items.get(tab.dataset.view).hidden = false;
    }
  }
  const inMenu = [...items.values()].some((item) => !item.hidden && item.dataset.view === state.activeView);
  more.setAttribute('aria-pressed', String(inMenu));
}

function markActiveView() {
  for (const button of document.querySelectorAll('[data-view]')) {
    const active = button.dataset.view === state.activeView;
    button.setAttribute('aria-pressed', String(active));
    if (active && button.closest('.masthead__views')) {
      button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  // The mobile bar shows four views; when the current one lives in the sheet,
  // More carries the mark so the bar is never blank.
  const inBar = [...document.querySelectorAll('.mobilebar__item[data-view]')]
    .some((button) => button.dataset.view === state.activeView);
  const moreBtn = $('#more-button');
  if (moreBtn) moreBtn.setAttribute('aria-pressed', String(!inBar));
  fitViews();
}

/* Focus trap cleanup for whichever popover is open; only one can be, since
   every opener closes the rest first. */
let menuFocusCleanup = null;

function closeAllMenus() {
  for (const menu of document.querySelectorAll('.popover-menu')) menu.hidden = true;
  for (const part of document.querySelectorAll('.hero-title-part')) part.setAttribute('aria-expanded', 'false');
  const btn = $('#settings-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  $('#views-more')?.setAttribute('aria-expanded', 'false');
  menuFocusCleanup?.();
  menuFocusCleanup = null;
  hideMenuScrim();
  closeSheet();
}

/* On a phone a picker (division, season, a club to compare) opens as a
   bottom sheet over a scrim, as the More sheet does, instead of a dropdown
   as narrow as the pill that opened it. */
let menuScrimEl = null;
function phoneMenu(menu, close) {
  if (!PHONE_SHEETS.matches) return;
  if (!menuScrimEl) {
    menuScrimEl = el('div', 'menu-scrim');
    menuScrimEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(menuScrimEl);
  }
  menuScrimEl.hidden = false;
  menuScrimEl.onclick = (event) => { event.stopPropagation(); close(); };
  for (const prop of ['top', 'left', 'right', 'width']) menu.style[prop] = '';
  menu.classList.add('is-sheet');
  attachSheetDrag(menu, { scrim: menuScrimEl, dismiss: close });
  menu.querySelector('[aria-current="true"], [aria-selected="true"]')?.scrollIntoView({ block: 'center' });
}
function hideMenuScrim() {
  if (menuScrimEl) menuScrimEl.hidden = true;
  for (const menu of document.querySelectorAll('.is-sheet')) menu.classList.remove('is-sheet');
}

function positionPopover(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.right = `${window.innerWidth - rect.right}px`;
}

let sheetFocusCleanup = null;

function openSheet() {
  const sheet = $('#more-sheet');
  const btn = $('#more-button');
  if (!sheet) return;
  sheet.hidden = false;
  if (btn) btn.setAttribute('aria-expanded', 'true');
  sheetFocusCleanup = trapFocus(sheet.querySelector('.sheet__panel'));
  pushOverlay('sheet');
}

function closeSheet() {
  const sheet = $('#more-sheet');
  const btn = $('#more-button');
  if (!sheet || sheet.hidden) return;
  const hadFocus = sheet.contains(document.activeElement);
  sheet.hidden = true;
  if (sheetFocusCleanup) {
    sheetFocusCleanup();
    sheetFocusCleanup = null;
  }
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    if (hadFocus) btn.focus();
  }
}

/* ?view=grid makes any view linkable. Applied early so the first render
   shows the requested view instead of the default table. */
function applyViewParameter() {
  const params = pageParams();
  const asked = params.get('view');
  // Next Up and Played Results were merged into Matches; old links still land.
  const view = asked === 'next-up' || asked === 'played' ? 'matches' : asked;
  const validViews = new Set(['overview', 'table', 'grid', 'ladder', 'matches', 'compare', 'explore', 'team', 'model', 'predict']);
  if (view && validViews.has(view)) {
    state.activeView = view;
    if (EXPLORE_ITEMS.includes(params.get('viz'))) state.exploreItem = params.get('viz');
    state.whatIfLocks = parseLocks(params.get('lock'));
    markActiveView();
  }
}

/* Older seasons exist as static files (or are built on the live server the
   first time they are asked for), so this can take a moment. Say so rather
   than appearing to hang. */
async function loadSeason(season) {
  // Every way into a new season goes through here, so the animation and a
  // pending slider fetch (both tied to the old season) are stopped here too.
  if (anim.playing) animStop();
  clearTimeout(state.rewindTimer);
  const token = ++latestLoad;
  seasonLoading = true;
  const select = $('#season-select');
  select.disabled = true;
  const previous = state.season;
  // A past season is a larger download: dim the page and mark it busy, as a
  // rewind does, so a slow fetch does not look like a dead click.
  const content = $('#content');
  content.classList.add('is-rewinding');
  content.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(reportUrl(season));
    if (!response.ok) throw new Error(`server returned ${response.status}`);
    const reports = applyShortNames(await response.json());
    if (token !== latestLoad) return;
    state.reports = reports;
    rememberLiveMatchdays(reports);
    state.season = season;
    // Only now: a failed load leaves the old (possibly rewound) page up, and
    // state.asof must keep describing it.
    state.asof = requestedAsof = null;
    if (state.activeView === 'team' && state.teamFocusId) followTeamLeague(state.teamFocusId);
    $('#status').hidden = true; // clears an earlier failure's message
    render();
  } catch (error) {
    if (token !== latestLoad) return;
    requestedAsof = state.asof; // a rewind this load cancelled never landed
    select.value = String(previous);
    console.warn('[Season] load failed', error);
    showStatusError(t('status.couldNotLoad', { season }), () => loadSeason(season));
  } finally {
    if (token === latestLoad) {
      seasonLoading = false;
      select.disabled = false;
      content.classList.remove('is-rewinding');
      content.removeAttribute('aria-busy');
    }
  }
}

function renderSeasonOptions(report) {
  const select = $('#season-select');
  const seasons = report.league.seasons || [report.league.season];
  if (select.options.length !== seasons.length) {
    select.replaceChildren();
    for (const season of [...seasons].reverse()) {
      const option = el('option', '', season === report.league.current_season ? t('season.live', { season }) : String(season));
      option.value = String(season);
      select.appendChild(option);
    }
  }
  select.value = String(report.league.season);
}

async function boot() {
  // Back lands where the page was left (restoreFromAddress); the browser's own guess comes too early.
  try { window.history.scrollRestoration = 'manual'; } catch { /* the browser's own */ }
  resolveTheme();
  document.documentElement.lang = htmlLang(currentLang);
  for (const button of document.querySelectorAll('[data-lang]')) {
    button.setAttribute('aria-pressed', String(button.dataset.lang === currentLang));
  }
  // Start report + careers fetches immediately while the active language table finishes loading.
  const reportLoad = fetch(reportUrl(null)).then((r) => {
    if (!r.ok) throw new Error(`server returned ${r.status}`);
    return r.json();
  });
  const careersLoad = fetch('/data/careers.json').then((r) => {
    if (!r.ok) throw new Error(`/data/careers.json ${r.status}`);
    return r.json();
  });
  careersLoad.catch(() => {}); // reported by attachCareers, not as an unhandled rejection
  await ensureLang(currentLang);
  applyTranslations();
  wire();
  initConsent();
  bootPredict();

  // The report draws the page. careers.json (club histories, head-to-heads,
  // the rating each result moved) is several times its size, so it follows
  // behind and the views that read it are drawn again when it lands.
  try {
    const reports = await reportLoad;

    state.reports = applyShortNames(reports);
    rememberLiveMatchdays(state.reports);
    state.season = reports[state.league].league.season;

    $('#status').hidden = true;
    $('#content').hidden = false;

    // Read before the first render, which rewrites the query string.
    const params = pageParams();
    for (const r of Object.values(state.reports)) for (const row of r.table) routeClubs.add(clubSlug(row.team));
    applyLeagueParameter();
    applySortParameter();
    applyViewParameter();
    // A club link can name a club only careers.json knows (one from another
    // season), so that one link waits for it.
    // (a club in this season's tables, which a club page names, need not wait for it)
    const wantedClub = params.get('team')?.toLowerCase();
    const inTables = Object.values(state.reports).some((r) => r.table.some((row) => row.team.toLowerCase() === wantedClub));
    if (wantedClub && !inTables) await attachCareers(careersLoad);
    applyTeamParameter();

    render();
    if (!state.careers) {
      attachCareers(careersLoad).then((loaded) => {
        if (loaded && CAREER_VIEWS.has(state.activeView)) render();
      });
    }


    const wantedSeason = Number(params.get('season'));
    if (wantedSeason && wantedSeason !== state.season) await loadSeason(wantedSeason);

    const wantedAsof = params.get('asof');
    if (wantedAsof) await rewindTo(wantedAsof);
    applyScenarioParameter();
    // The browser resolved any #fragment while the content was still hidden,
    // so re-run it now that the sections exist.
    if (window.location.hash) {
      document.querySelector(window.location.hash)?.scrollIntoView();
    }
  } catch (error) {
    console.error('[Boot] ERROR:', error);
    track('load_error', { file: 'report', message: error.message });
    showStatusError(t('status.couldNotLoadSeason'), () => location.reload());
  }
  booted = true;
  pageView();
}

/* The views that read careers.json, drawn again when it lands: the rating
   each result moved (the table's trend arrows, the results' deltas), club
   histories and head-to-heads. */
const CAREER_VIEWS = new Set(['overview', 'table', 'matches', 'team', 'compare']);

/* Puts careers.json on the state once it lands; true when it did. A failure
   leaves those views without club history, and says so. */
async function attachCareers(load) {
  try {
    state.careers = applyShortNamesToCareers(await load);
    return true;
  } catch (error) {
    console.warn('[Boot] careers.json unavailable', error);
    track('load_error', { file: 'careers', message: error.message });
    showStatusError(t('status.couldNotLoadHistory'), () => location.reload());
    return false;
  }
}

/* A failed load in the reader's words, with a way to try again. The
   technical reason goes to the console and the load_error event instead. */
function showStatusError(message, retry) {
  const status = $('#status');
  status.hidden = false;
  status.replaceChildren(message);
  const button = el('button', 'status__retry', t('status.retry'));
  button.type = 'button';
  button.addEventListener('click', retry);
  status.append(' ', button);
}

window.addEventListener('orientationchange', handleOrientationChange);
let shapeResizeTimer;
window.addEventListener('resize', () => {
  // Only reinitialize gestures if crossing the mobile breakpoint
  const wasMobile = document.body.dataset.wasMobile === 'true';
  const isMobile = window.innerWidth <= 760;
  if (wasMobile !== isMobile) {
    document.body.dataset.wasMobile = String(isMobile);
    // Re-init would require removing old listeners; for simplicity, just refresh on next interaction
  }
  // The season-shape chart is sized to its container's width; redraw it when
  // a resize crosses the narrow/desktop split, and not on every pixel.
  clearTimeout(shapeResizeTimer);
  shapeResizeTimer = setTimeout(() => {
    if (lastTeamChart?.chart.isConnected) {
      const width = lastTeamChart.chart.getBoundingClientRect().width;
      if (width && (width < SHAPE_NARROW) !== lastTeamChart.narrow) drawTeamChart(lastTeamChart.career);
    }
    if (lastCompareChart?.svg.isConnected) {
      const { svg, careerA, careerB, labelA, labelB, narrow } = lastCompareChart;
      const width = svg.getBoundingClientRect().width;
      if (width && (width < SHAPE_NARROW) !== narrow) drawCompareHistory(svg, careerA, careerB, labelA, labelB);
    }
    if (!lastShape || !lastShape.chart.isConnected) return;
    const box = lastShape.chart.getBoundingClientRect().width;
    if (!box) return;
    if ((box < SHAPE_NARROW) !== lastShape.narrow || (box < SHAPE_COMPACT) !== lastShape.compact) {
      drawTeamShape(lastShape.report, lastShape.team, lastShape.chart, box);
    }
  }, 150);
});

// Initialize viewport height variable for CSS
handleOrientationChange();

boot();
