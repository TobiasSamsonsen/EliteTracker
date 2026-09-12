/* EliteTracker front end.
   Plain modules, no framework: the whole payload is one JSON document and the
   page is a few pure render functions over it. */

const state = {
  reports: null,
  league: 'eliteserien',
  season: null,
  careers: null,
  // Default view is the league table as it actually stands.
  sort: { key: 'position', dir: 1 },
  // ISO date the whole page is rewound to; null means live.
  asof: null,
  rewindTimer: null,
  // Key of the league+season the compare pickers were last populated for.
  compareKey: '',
  // Active view tab: 'grid', 'table', 'ladder', 'next-up', 'played', 'compare', 'team', 'model'
  // ?view= still wins -- see applyViewParameter.
  activeView: 'grid',
  _prevActiveView: null,
  // Team focus: team_id when viewing the team tab, null otherwise.
  teamFocusId: null,
  // Pagination for played results.
  playedWeek: 0,
  // How many upcoming fixtures Next Up shows; "show more" adds a dozen.
  fixturesShown: 12,
  // Pagination for team focus view.
  teamFixturesPage: 0,
  teamResultsPage: 0,
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
    for (const team of report.history?.teams || []) team.team = shortName(team.team);
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
const teamLogo = (teamId, name) => {
  if (!teamId) return null;
  const img = el('img', 'team-logo');
  img.src = `/logos/${teamId}.png`;
  img.alt = '';
  img.loading = 'lazy';
  img.title = name;
  return img;
};

/* The em-dash threshold follows the precision: anything that would print as a
   bare 0% is shown as nothing instead, and the same at the top end. */
const smallestShown = (digits) => 0.5 / 10 ** digits / 100;

const pct = (value, digits = 1) => {
  const smallest = smallestShown(digits);
  if (value >= 1 - smallest) return '100%';
  if (value < smallest) return '—';
  return `${(value * 100).toFixed(digits)}%`;
};

const pctShort = (value) =>
  value < 0.005 ? '' : `${Math.round(value * 100)}`;

/* ---------- the sequential ramp -----------------------------------
   One gradient does all the quantitative colour on the page: probability in
   the finish grid, and finishing position in the season-shape chart.

   It is multi-hue by necessity. Sixteen stacked bands in a single hue are not
   tellable apart, so the ramp travels pale green -> teal -> blue -> deep navy,
   resampled at uniform OKLab lightness. That keeps lightness monotone (so it
   still reads as one ordered scale) while giving every neighbouring pair a
   real colour gap: worst adjacent dE 10.5 light, 11.3 dark.

   Step 0 is "as good as never" and stays at the surface, so a 16x16 grid of
   mostly-zero cells reads as empty rather than as pale noise. */

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

/* Text must stay legible as the fill moves away from the surface, which is a
   different direction in each theme. */
function heatTextClass(step) {
  const darkMode = document.documentElement.dataset.resolvedTheme === 'dark';
  return step >= (darkMode ? 5 : 4) ? 'cell--invert' : '';
}

/* ---------- tooltip ---------------------------------------------- */

const tooltip = $('#tooltip');

function showTooltip(event, html) {
  tooltip.innerHTML = html;
  tooltip.dataset.show = 'true';
  moveTooltip(event);
}

const coarsePointer = window.matchMedia('(pointer: coarse)');

function moveTooltip(event) {
  const box = tooltip.getBoundingClientRect();

  // A finger covers the thing it is pointing at, so on touch the readout is
  // parked above the navigation bar instead of chasing the contact point.
  if (coarsePointer.matches) {
    tooltip.style.left = `${Math.max(8, (window.innerWidth - box.width) / 2)}px`;
    tooltip.style.top = `${window.innerHeight - box.height - 68}px`;
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
}

/* ---------- bands ------------------------------------------------- */

/* The most specific band wins, so "Champions" beats the broader
   "Champions League qualification" block it sits inside. */
function bandFor(bands, position) {
  const matches = bands.filter((band) => position >= band.first && position <= band.last);
  if (!matches.length) return null;
  return matches.reduce((best, band) =>
    band.last - band.first < best.last - best.first ? band : best
  );
}

/* ---------- the finish grid --------------------------------------- */

/* Where the model expects a club to finish: the mean of its distribution.

   The grid is ordered by this rather than by the current table, so the heavy
   cells lie on the diagonal. Ordering by the live standings falls apart as
   soon as you rewind -- on 11 April 2026 it leaves only 2.00 of the 16.0
   probability mass on the diagonal against 3.86 for this ordering, which is
   what made the grid look like noise.

   The obvious alternative, walking the columns and taking whichever club is
   likeliest to land in each place, actually scores worse (3.26): it spends the
   strong clubs early and strands the rest. This is within 0.4% of the best
   ordering an exhaustive pairwise search can find. */
function expectedFinish(row) {
  return row.position_probabilities.reduce(
    (total, probability, index) => total + probability * (index + 1),
    0,
  );
}

function paintCell(cell, probability) {
  const step = heatStep(probability);
  const text = pctShort(probability);
  cell.className = `cell ${heatTextClass(step)}${text ? '' : ' cell--empty'}`.trim();
  cell.style.background = seqStepColor(step);
  cell.textContent = text;
  return cell;
}

/* The grid table, rebuilt from scratch. With `record` the row and cell
   elements are collected per team so the animation can update them in place. */
function buildGrid(report, tableData, record = null) {
  const table = $('#grid');
  const rows = [...tableData].sort(
    (a, b) => expectedFinish(a) - expectedFinish(b) || a.position - b.position,
  );
  const count = rows.length;
  const bands = report.league.bands;

  table.replaceChildren(table.querySelector('caption'));

  const head = el('thead');
  // The band strip lives inside the table so it inherits the column geometry
  // exactly; positioning it separately drifts as soon as the table is centred.
  const bandRow = el('tr', 'grid__bands');
  bandRow.appendChild(el('td', '', ''));
  const headRow = el('tr');
  headRow.appendChild(el('th', '', ''));
  for (let position = 1; position <= count; position += 1) {
    const band = bandFor(bands, position);
    const cell = el('td');
    const bar = el('span', 'band-strip__seg');
    if (band) {
      bar.style.background = bandColor(band, count);
      bar.title = band.label;
    }
    cell.appendChild(bar);
    bandRow.appendChild(cell);
    const th = el('th', '', String(position));
    th.scope = 'col';
    headRow.appendChild(th);
  }
  head.appendChild(bandRow);
  head.appendChild(headRow);
  table.appendChild(head);

  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    const label = el('th', 'grid__team');
    label.scope = 'row';
    label.appendChild(el('span', 'pos', String(row.position)));
    label.appendChild(sideBlock(row.team, row.team_id, true, 'grid__team-name'));
    tr.appendChild(label);

    const cells = [];
    row.position_probabilities.forEach((probability, index) => {
      const cell = paintCell(el('td'), probability);
      cell.style.setProperty('--col', String(index));
      const position = index + 1;
      const band = bandFor(bands, position);
      cell.addEventListener('pointerenter', (event) => {
        // Mid-animation the readout follows the last frame, not the build.
        const live = anim.gridTableData?.find((r) => r.team_id === row.team_id);
        const prob = live ? live.position_probabilities[index] : probability;
        showTooltip(event, `<b>${row.team}</b> ${ordinal(position)}<br>${pct(prob, 2)}` + (band ? `<br>${band.label}` : ''));
      });
      cell.addEventListener('pointermove', moveTooltip);
      cell.addEventListener('pointerleave', hideTooltip);
      cells.push(cell);
      tr.appendChild(cell);
    });
    body.appendChild(tr);
    if (record) {
      record.rows.set(row.team_id, tr);
      record.cells.set(row.team_id, cells);
    }
  }
  table.appendChild(body);
  $('#grid-count').textContent = '';
  return table;
}

function renderGrid(report) {
  const table = buildGrid(report, report.table);
  // Restart the load animation whenever the grid is rebuilt.
  const wrap = table.parentElement;
  wrap.classList.remove('grid-animate');
  void wrap.offsetWidth;
  wrap.classList.add('grid-animate');
}

/* ---------- finish-grid animation ---------------------------------- */

async function prefetchAnimReports() {
  const days = matchdays(state.reports[state.league]);
  if (days.length < 2) return null;
  const fetched = await Promise.all(
    days.map((d) => fetch(reportUrl(state.season, d.date)).then((r) => (r.ok ? r.json() : null))),
  );
  const map = new Map();
  fetched.forEach((r, i) => { if (r) map.set(i, r); });
  return map;
}

function lerpReport(a, b, t) {
  const bById = new Map(b.table.map((row) => [row.team_id, row]));
  return a.table.map((rowA) => {
    const rowB = bById.get(rowA.team_id);
    if (!rowB) return rowA;
    const probs = rowA.position_probabilities.map(
      (p, j) => p + (rowB.position_probabilities[j] - p) * t,
    );
    return {
      ...rowA,
      position_probabilities: probs,
      rating: rowA.rating + (rowB.rating - rowA.rating) * t,
    };
  });
}

/* Build the grid DOM once for animation, storing references for in-place
   updates. The cell background transitions are driven by CSS. */
function initGridAnimDOM(report, tableData) {
  const a = anim;
  a.gridRows = new Map();
  a.gridCells = new Map();
  a.gridTable = buildGrid(report, tableData, { rows: a.gridRows, cells: a.gridCells });
  a.gridTable.classList.add('grid-anim');
  a.gridTable.parentElement.classList.remove('grid-animate');
}

/* Update cell colours and text in place, then reorder rows to match sort. */
function updateGridAnimFrame(tableData) {
  const a = anim;
  a.gridTableData = tableData;
  const sorted = [...tableData].sort(
    (x, b) => expectedFinish(x) - expectedFinish(b) || x.position - b.position,
  );
  const body = a.gridTable.querySelector('tbody');
  for (const row of sorted) {
    const cells = a.gridCells.get(row.team_id);
    if (!cells) continue;
    row.position_probabilities.forEach((probability, index) => paintCell(cells[index], probability));
    body.appendChild(a.gridRows.get(row.team_id));
  }
}

const anim = state.anim;

/* One interpolated frame between the current matchday and the next. */
function animFrame(frac) {
  const cur = anim.reports.get(anim.matchdayIndex);
  const next = anim.reports.get(anim.matchdayIndex + 1);
  if (!cur || !next) return;
  if (state.activeView === 'ladder') {
    updateLadderAnimFrame({
      eliteserien: { table: lerpReport(cur.eliteserien, next.eliteserien, frac) },
      obosligaen: { table: lerpReport(cur.obosligaen, next.obosligaen, frac) },
    });
  } else {
    updateGridAnimFrame(lerpReport(cur[state.league], next[state.league], frac));
  }
}

function animTick(now) {
  if (!anim.playing) return;
  const report = state.reports[state.league];
  const days = matchdays(report);
  const msPerDay = anim.interval / anim.speed;

  if (now - anim.lastTick >= msPerDay) {
    anim.matchdayIndex++;
    anim.lastTick = now;
    if (anim.matchdayIndex >= days.length - 1) {
      animStop();
      return;
    }
    animUpdateTimeline(report, days);
  }

  animFrame(Math.min((now - anim.lastTick) / msPerDay, 1));
  anim.raf = requestAnimationFrame(animTick);
}

function animUpdateTimeline(report, days) {
  const range = $('#timeline-range');
  range.value = String(anim.matchdayIndex);
  const day = days[anim.matchdayIndex];
  if (day) {
    $('#timeline-when').textContent = t('timeline.animating', { when: longDate(day.date) });
  }
}

/* The grid and the ladder share one animation loop; the view decides which
   DOM is built and updated. */
async function animStart() {
  if (anim.playing) { animStop(); return; }

  const report = state.reports[state.league];
  const days = matchdays(report);
  if (days.length < 2) return;

  const ladder = state.activeView === 'ladder';
  const holder = $(ladder ? '#ladder-lanes' : '#grid').parentElement;
  holder.classList.add('grid-loading');

  anim.matchdayIndex = 0;
  anim.speed = 1;
  animUpdateSpeedButton();

  anim.reports = await prefetchAnimReports();
  holder.classList.remove('grid-loading');

  if (!anim.reports || anim.reports.size < 2 || !anim.reports.get(0)) return;

  if (ladder) initLadderAnimDOM(anim.reports);
  else initGridAnimDOM(report, anim.reports.get(0)[state.league].table);
  animUpdateTimeline(report, days);

  anim.playing = true;
  anim.lastTick = performance.now();
  $(ladder ? '#ladder-anim-play' : '#grid-anim-play').textContent = '⏸';
  $(ladder ? '#ladder-anim-controls' : '#grid-anim-controls').hidden = false;
  anim.raf = requestAnimationFrame(animTick);
}

function animStop() {
  anim.playing = false;
  if (anim.raf) { cancelAnimationFrame(anim.raf); anim.raf = null; }
  if (anim.gridTable) anim.gridTable.classList.remove('grid-anim');
  anim.gridRows = anim.gridCells = anim.gridTable = anim.gridTableData = null;
  anim.ladder = null;
  for (const view of ['grid', 'ladder']) {
    $(`#${view}-anim-play`).textContent = '▶';
    $(`#${view}-anim-controls`).hidden = true;
  }
  setTimeout(() => render(), 0);
}

function animToggleSpeed() {
  anim.speed = anim.speed >= 4 ? 1 : anim.speed * 2;
  animUpdateSpeedButton();
}

function animUpdateSpeedButton() {
  for (const btn of document.querySelectorAll('.grid-anim-speed')) btn.textContent = `${anim.speed}×`;
}

/* ---------- ladder animation --------------------------------------- */

function initLadderAnimDOM(allReports) {
  const track = $('#ladder-lanes');
  track.replaceChildren();
  // Stack depth over every matchday, so the track never resizes mid-animation.
  let maxStack = 0;
  for (const [, day] of allReports) {
    maxStack = Math.max(maxStack, layoutLadder(ladderTeams(day), track).depth - 1);
  }
  const teams = ladderTeams(allReports.get(0));
  ladderAxis(track, layoutLadder(teams, track, maxStack));
  const els = new Map();
  for (const team of teams) {
    const wrap = ladderTeamEl(team);
    placeLadderTeam(wrap, team);
    track.appendChild(wrap);
    els.set(team.teamId, wrap);
  }
  anim.ladder = { teams, els, track, maxStack };
}

/* Move every crest to its interpolated rating in place. */
function updateLadderAnimFrame(reports) {
  const l = anim.ladder;
  if (!l) return;
  const ratings = new Map(ladderTeams(reports).map((team) => [team.teamId, team.rating]));
  for (const team of l.teams) team.rating = ratings.get(team.teamId) ?? team.rating;
  ladderAxis(l.track, layoutLadder(l.teams, l.track, l.maxStack));
  for (const team of l.teams) placeLadderTeam(l.els.get(team.teamId), team);
}

/* Marker colour for a qualification band.

   Winning the league keeps its own gold; everything else takes the outcome
   family, so a marker never disagrees with the cells beneath it. The tone
   alone is not enough: a play-off is a good thing in OBOS-ligaen (promotion)
   and a bad one in Eliteserien (relegation). */
function bandColor(band, count) {
  if (band.tone === 'champion') return 'var(--band-champion)';
  return outcomeClass(band.first, [band], count) === 'good'
    ? 'var(--outcome-good)'
    : 'var(--outcome-bad)';
}

function ordinal(n) {
  if (currentLang === 'no') return `${n}. plass`;
  const suffix = ['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th';
  return `${n}${suffix} place`;
}

/* ---------- legends ----------------------------------------------- */

function renderGridLegend() {
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

  legend.appendChild(el('span', '', t('grid.legend.hint')));
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
    key.appendChild(el('span', '', `${band.label} (${range})`));
    legend.appendChild(key);
  }
}

function renderOddsLegend() {
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
}

/* ---------- standings --------------------------------------------- */

/* Rows with the two derived probability columns folded in, so sorting can see
   the same values the table shows. */
function standingsRows(report) {
  const bands = report.league.bands;
  const relegation = bands.find((band) => band.tone === 'relegation');
  const promotion = report.league.slug === 'obosligaen';
  const sum = (values) => values.reduce((total, value) => total + value, 0);

  return report.table.map((row) => ({
    ...row,
    // Promotion for the second tier is the top band, not just the title.
    up: promotion ? sum(row.position_probabilities.slice(0, 2)) : row.position_probabilities[0],
    down: relegation
      ? sum(row.position_probabilities.slice(relegation.first - 1, relegation.last))
      : 0,
  }));
}

/* Position and club read naturally smallest-first; every other column is a
   "more is notable" number, so it opens on the largest. */
const SORT_ASCENDING_FIRST = new Set(['position', 'team']);

function sortedStandings(rows) {
  const { key, dir } = state.sort;
  const compare = (a, b) => {
    if (key === 'team') return a.team.localeCompare(b.team, 'nb') * dir;
    const difference = (a[key] - b[key]) * dir;
    // League position is the tiebreak, so equal values keep table order and
    // the sort stays stable and predictable.
    return difference || a.position - b.position;
  };
  return [...rows].sort(compare);
}

function toggleSort(key) {
  if (!state.reports) return; // headers are bound at boot, before the first fetch lands
  const opening = SORT_ASCENDING_FIRST.has(key) ? 1 : -1;
  state.sort =
    state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: opening };
  renderStandings(state.reports[state.league]);
}

function renderSortHeaders() {
  for (const header of document.querySelectorAll('#standings th[data-sort-col]')) {
    const active = header.dataset.sortCol === state.sort.key;
    header.setAttribute('aria-sort', active ? (state.sort.dir === 1 ? 'ascending' : 'descending') : 'none');
    header.classList.toggle('is-sorted', active);
    const caret = header.querySelector('.sort-btn__caret');
    if (caret) caret.textContent = active ? (state.sort.dir === 1 ? '\u25b2' : '\u25bc') : '';
  }
}

function renderStandings(report) {
  const body = $('#standings tbody');
  body.replaceChildren();

  const bands = report.league.bands;
  const count = report.table.length;

  const promotion = report.league.slug === 'obosligaen';
  $('#head-first').textContent = promotion ? t('table.promotion') : t('table.champion');
  $('#head-first-short').textContent = promotion ? t('table.promotionShort') : t('table.championShort');
  $('#head-first-desc').textContent = promotion
    ? t('table.promotionDesc')
    : t('table.championDesc');
  $('#head-last').textContent = t('table.relegation');
  renderSortHeaders();

  const formByTeamName = formByTeam(report.results);
  const rows = standingsRows(report).map((row) => ({
    ...row,
    form: formPoints(formByTeamName[row.team]),
  }));

  // Find the team with the highest rating rise for the champion-yellow arrow
  const trends = new Map();
  for (const row of rows) {
    const t = computeRatingTrend(row.team, report);
    if (t) trends.set(row.team, t);
  }
  let topRiser = null;
  for (const [team, t] of trends) {
    if (!topRiser || t.diff > topRiser.diff) topRiser = { team, diff: t.diff };
  }

  for (const row of sortedStandings(rows)) {
    const tr = el('tr');
    const band = bandFor(bands, row.position);

    const position = el('td', 'pos');
    const mark = el('span', 'band-mark');
    if (band) {
      mark.style.background = bandColor(band, count);
      mark.title = band.label;
    }
    position.appendChild(mark);
    position.appendChild(document.createTextNode(String(row.position)));
    tr.appendChild(position);

    // The club name is the control. Marking the whole <tr> role="button" made
    // every cell presentational, which hid the scores from screen readers and
    // stopped the new aria-sort from ever being announced.
    const club = el('td', 'club');
    const clubButton = el('button', 'club-btn');
    clubButton.type = 'button';
    clubButton.classList.add('club-btn--crest');
    const crest = teamLogo(row.team_id, row.team);
    if (crest) clubButton.appendChild(crest);
    clubButton.appendChild(document.createTextNode(row.team));
    clubButton.addEventListener('click', (event) => {
      event.stopPropagation();
      openTeamView(row.team_id, row.team);
    });
    club.appendChild(clubButton);
    tr.appendChild(club);
    // 'extra' marks the tallies a phone drops -- see .col--extra in the CSS.
    for (const [key, extra] of [
      ['played', true], ['wins', true], ['draws', true],
      ['losses', true], ['goals_for', true], ['goals_against', true],
    ]) {
      tr.appendChild(el('td', `num muted${extra ? ' col--extra' : ''}`, String(row[key])));
    }
    tr.appendChild(el('td', 'num col--extra', row.goal_difference > 0 ? `+${row.goal_difference}` : String(row.goal_difference)));
    const points = el('td', 'num', String(row.points));
    points.style.fontWeight = '700';
    tr.appendChild(points);

    const ratingCell = el('td', 'num sep');
    ratingCell.appendChild(document.createTextNode(row.rating.toFixed(0)));
    const trend = computeRatingTrend(row.team, report);
    if (trend) {
      const isTop = topRiser && topRiser.team === row.team && topRiser.diff > 0;
      const arrow = el('span', `rating-trend rating-trend--${trend.direction}${isTop ? ' rating-trend--top' : ''}`);
      arrow.innerHTML = trend.svg;
      ratingCell.appendChild(arrow);
    }
    tr.appendChild(ratingCell);
    tr.appendChild(el('td', 'num muted col--extra', row.expected_points.toFixed(1)));
    const formTd = el('td', 'num form col--extra');
    formTd.appendChild(formChipsEl(formByTeamName[row.team]));
    tr.appendChild(formTd);

    tr.appendChild(meterCell(row.up, 'up'));
    tr.appendChild(meterCell(row.down, 'down'));

    // Clicking anywhere on the row is a mouse convenience on top of that
    // button; it adds no keyboard or ARIA semantics of its own.
    tr.addEventListener('click', () => openTeamView(row.team_id, row.team));
    body.appendChild(tr);
  }
}

const METER_DIGITS = 0;

/* `kind` is 'up' or 'down' -- the good column and the bad one. Colour is a
   second channel here, not the only one: the columns are labelled, fixed in
   place, and the percentage is printed beside the bar. */
function meterCell(value, kind) {
  const clamped = Math.max(0, Math.min(1, value));
  const cell = el('td', 'num');
  // Whole percent: sampling error is +/-0.5pp and the model's own calibration
  // error is +/-1.5pp, so a tenth of a percent here would be noise dressed as
  // precision. The bar carries the finer detail.
  const empty = clamped < smallestShown(METER_DIGITS);
  const meter = el('span', `meter meter--${kind}${empty ? ' meter--empty' : ''}`);

  const track = el('span', 'meter__track');
  const fill = el('span', 'meter__fill');
  fill.style.width = `${clamped * 100}%`;
  track.appendChild(fill);

  meter.appendChild(track);
  meter.appendChild(el('span', 'meter__value', pct(value, METER_DIGITS)));
  cell.appendChild(meter);
  return cell;
}

/* ---------- season shape: stacked area over the season ------------- */

/* Finishing position on the same sequential ramp. First place sits furthest
   from the surface and last place nearest it, so a club's chart darkens as it
   climbs. Band boundaries are carried by the tooltip and the table's own
   markers rather than by a hue change, which keeps this one ordered scale. */
function positionColor(position, count) {
  return seqColor(count > 1 ? (count - position) / (count - 1) : 1);
}

/* Career points are dated by matchday, not by clock time. Midday UTC keeps a
   point on its own day in every timezone the page is read in. */
const pointTime = (point) => Date.parse(`${point[0]}T12:00:00Z`);

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};


/* ---------- rating ladder ----------------------------------------- */

function ladderTeams(reports) {
  return Object.entries(reports).flatMap(([slug, report]) =>
    report.table.map((row) => ({
      team: row.team, teamId: row.team_id, rating: row.rating, tier: slug === 'eliteserien' ? 1 : 2,
    })));
}

/* Both divisions on one axis, which is the only place the model compares
   them directly. A narrow track runs vertically (rem down the track, crests
   stacking into columns); otherwise horizontally (percent across it, crests
   stacking into rows). Ranks and placement are written onto the team objects;
   the ticks (every 50 points) and track size come back. `maxStack` reserves
   extra stacking depth so an animated track keeps one size. */
function layoutLadder(teams, track, maxStack = 0) {
  const ratings = teams.map((t) => t.rating);
  const low = Math.min(...ratings);
  const high = Math.max(...ratings);
  const trackWidth = track.clientWidth || 1000;
  const vertical = trackWidth < 500;
  teams.sort((a, b) => a.rating - b.rating || a.team.localeCompare(b.team));
  teams.forEach((t, i) => { t._rank = teams.length - i; });

  const AXIS_WIDTH = 2.5;
  const COL_WIDTH = 1.8;
  const VERT_PAD = 1;
  const TRACK_CONTENT = Math.max(20, (high - low) / 50 * 6);
  const crestPx = parseFloat(getComputedStyle(document.documentElement).fontSize) * 1.5;
  const overlap = vertical ? 1.7 : Math.min(50, ((crestPx + 2) / trackWidth) * 100);
  const pos = (rating) => {
    if (high === low) return vertical ? VERT_PAD + TRACK_CONTENT / 2 : 50;
    const f = (rating - low) / (high - low);
    return vertical ? VERT_PAD + TRACK_CONTENT - f * TRACK_CONTENT : 2 + f * 96;
  };

  // Highest-rated first; a crest overlapping one already placed steps out one stack level.
  const placed = [];
  for (let i = teams.length - 1; i >= 0; i--) {
    const team = teams[i];
    let stack = 0;
    for (const p of placed) {
      if (Math.abs(pos(p.rating) - pos(team.rating)) <= overlap) stack = Math.max(stack, p._stack + 1);
    }
    team._stack = stack;
    placed.push(team);
  }
  const depth = Math.max(maxStack, ...teams.map((t) => t._stack)) + 1;
  const rowHeight = depth <= 1 ? 0 : 2.2;

  for (const team of teams) {
    team._tip = `#${team._rank}  ${team.team}  ${Math.round(team.rating)}`;
    team._top = vertical ? `${pos(team.rating)}rem` : `${0.5 + team._stack * rowHeight}rem`;
    team._left = vertical ? `${AXIS_WIDTH + team._stack * COL_WIDTH}rem` : `${pos(team.rating)}%`;
  }
  const ticks = [];
  for (let r = Math.ceil(low / 50) * 50; r <= high; r += 50) {
    ticks.push({ label: String(r), [vertical ? 'top' : 'left']: vertical ? `${pos(r)}rem` : `${pos(r)}%` });
  }
  return {
    ticks,
    depth,
    height: vertical ? `${VERT_PAD * 2 + TRACK_CONTENT}rem` : `${4 + (depth - 1) * rowHeight}rem`,
    width: vertical ? `${AXIS_WIDTH + depth * COL_WIDTH + 0.5}rem` : '',
  };
}

function ladderAxis(track, layout) {
  track.querySelector('.ladder__axis')?.remove();
  const axis = el('div', 'ladder__axis');
  for (const tick of layout.ticks) {
    const node = el('div', 'ladder__tick');
    if (tick.top) node.style.top = tick.top;
    else node.style.left = tick.left;
    node.appendChild(el('span', '', tick.label));
    axis.appendChild(node);
  }
  track.appendChild(axis);
  track.style.height = layout.height;
  track.style.width = layout.width;
}

function ladderTeamEl(team) {
  const wrap = el('div', 'ladder__team');
  wrap.dataset.tier = String(team.tier);
  const img = el('img');
  img.src = `logos/${team.teamId}.png`;
  img.alt = team.team;
  wrap.appendChild(img);
  return wrap;
}

function placeLadderTeam(wrap, team) {
  wrap.style.top = team._top;
  wrap.style.left = team._left;
  wrap.dataset.tip = team._tip;
}

function renderLadder(reports) {
  const track = $('#ladder-lanes');
  track.replaceChildren();
  const teams = ladderTeams(reports);
  ladderAxis(track, layoutLadder(teams, track));
  for (const team of teams) {
    const wrap = ladderTeamEl(team);
    placeLadderTeam(wrap, team);
    track.appendChild(wrap);
  }

  // Touch/click support for ladder tooltips on mobile (event delegation on track)
  if (coarsePointer.matches) {
    track.addEventListener('click', (e) => {
      const wrap = e.target.closest('.ladder__team');
      if (!wrap) return;
      e.stopPropagation();
      track.querySelectorAll('.ladder__team[data-tip-visible]').forEach((other) => {
        if (other !== wrap) other.removeAttribute('data-tip-visible');
      });
      wrap.toggleAttribute('data-tip-visible');
    });
    // Click outside to close — named handler so we don't leak listeners on re-render
    if (state._ladderOutsideHandler) document.removeEventListener('click', state._ladderOutsideHandler);
    state._ladderOutsideHandler = () => {
      track.querySelectorAll('.ladder__team[data-tip-visible]').forEach((w) => w.removeAttribute('data-tip-visible'));
    };
    document.addEventListener('click', state._ladderOutsideHandler, { passive: true });
  }

  // Legend
  const legend = $('#ladder-legend');
  legend.replaceChildren();
  for (const [tier, name] of [[1, 'Eliteserien'], [2, 'OBOS-ligaen']]) {
    const key = el('span', 'legend__key');
    const swatch = el('span', 'legend__swatch');
    swatch.style.background = tier === 1 ? 'var(--tier-1)' : 'var(--tier-2)';
    swatch.style.borderRadius = '2px';
    key.appendChild(swatch);
    key.appendChild(el('span', '', name));
    legend.appendChild(key);
  }
}

/* ---------- fixtures ---------------------------------------------- */

/* One half of a matchup: name button and crest, both opening the club's focus
   view. The crest sits toward the centre of the card, so away flips the order. */
function sideBlock(name, id, away, nameClass = 'played-card__team-name') {
  const team = el('span', 'played-card__team');
  const nameBtn = el('button', nameClass, name);
  nameBtn.addEventListener('click', () => openTeamView(id, name));
  const crest = teamLogo(id, name);
  if (crest) {
    crest.addEventListener('click', () => openTeamView(id, name));
    crest.style.cursor = 'pointer';
  }
  for (const node of away ? [crest, nameBtn] : [nameBtn, crest]) if (node) team.appendChild(node);
  return team;
}

function buildFixtureCard(fixture) {
  const card = el('div', 'played-card');
  card.appendChild(el('div', 'played-card__date', formatDate(fixture.date) + (fixture.time ? ` \u00b7 ${fixture.time}` : '')));

  const matchup = el('div', 'played-card__matchup');
  const homeSide = el('div', 'played-card__side played-card__side--home');
  homeSide.appendChild(el('span', 'played-card__rating-value', fixture.home_rating.toFixed(0)));
  homeSide.appendChild(sideBlock(fixture.home, fixture.home_id, false));
  matchup.appendChild(homeSide);

  const oddsCol = el('div', 'fixture__odds-col');
  oddsCol.appendChild(oddsBar(fixture.home, fixture.away, fixture));
  matchup.appendChild(oddsCol);

  const awaySide = el('div', 'played-card__side played-card__side--away');
  awaySide.appendChild(sideBlock(fixture.away, fixture.away_id, true));
  awaySide.appendChild(el('span', 'played-card__rating-value', fixture.away_rating.toFixed(0)));
  matchup.appendChild(awaySide);
  card.appendChild(matchup);

  if (fixture.scorelines && fixture.scorelines.length) {
    const lines = el('div', 'fixture__lines');
    for (const line of fixture.scorelines.slice(0, 4)) {
      const chip = el('span', 'fixture__line');
      chip.textContent = `${line.home_goals}-${line.away_goals} ${pct(line.probability, 0)}`;
      chip.setAttribute(
        'aria-label',
        t('aria.scoreline', { score: `${line.home_goals}-${line.away_goals}`, pct: pct(line.probability, 1) })
      );
      lines.appendChild(chip);
    }
    card.appendChild(lines);
  }

  return card;
}

/* A completed match: score in the middle, each side's rating after the match
   with the delta the result produced on the outside. */
function playedCard(match, ratingChanges) {
  const card = el('div', 'played-card');
  if (match.home_goals > match.away_goals) card.classList.add('played-card--home-win');
  else if (match.away_goals > match.home_goals) card.classList.add('played-card--away-win');
  card.appendChild(el('div', 'played-card__date', formatDate(match.date) + (match.round ? ` \u00b7 R${match.round}` : '')));

  const ratingBlock = (id) => {
    const info = ratingChanges.get(`${id}|${match.date}`) ?? { change: 0, rating: 0 };
    const node = el('div', 'played-card__rating');
    node.appendChild(el('span', 'played-card__rating-value', String(info.rating)));
    if (info.change !== 0) {
      const up = info.change > 0;
      node.appendChild(el('span', `played-card__delta played-card__delta--${up ? 'up' : 'down'}`,
        `${up ? '+' : ''}${info.change} ${up ? '\u25B2' : '\u25BC'}`));
    }
    return node;
  };

  const matchup = el('div', 'played-card__matchup');
  const homeSide = el('div', 'played-card__side played-card__side--home');
  homeSide.appendChild(ratingBlock(match.home_id));
  homeSide.appendChild(sideBlock(match.home, match.home_id, false));
  const awaySide = el('div', 'played-card__side played-card__side--away');
  awaySide.appendChild(sideBlock(match.away, match.away_id, true));
  awaySide.appendChild(ratingBlock(match.away_id));
  matchup.appendChild(homeSide);
  matchup.appendChild(el('div', 'played-card__score', `${match.home_goals}\u2013${match.away_goals}`));
  matchup.appendChild(awaySide);
  card.appendChild(matchup);
  return card;
}

function renderFixtures(report) {
  const holder = $('#fixtures');
  holder.replaceChildren();

  const next = report.fixtures.slice(0, state.fixturesShown);
  $('#fixture-count').textContent = t('next.count', { n: next.length, total: report.fixtures.length });

  for (const fixture of next) {
    holder.appendChild(buildFixtureCard(fixture));
  }
  if (next.length < report.fixtures.length) {
    const more = el('button', 'played-nav__btn fixtures__more', t('next.showMore', { n: Math.min(12, report.fixtures.length - next.length) }));
    more.type = 'button';
    more.addEventListener('click', () => { state.fixturesShown += 12; renderFixtures(report); });
    holder.appendChild(more);
  }
}

/* ---------- played results ------------------------------------------ */

/* Build a map of rating changes per team per match date from careers data.
   career.points is an array of [date, rating] after each match.
   Returns a Map keyed "teamId|date" -> { change, rating } where rating is
   the rating after the match and change is the delta from the previous match. */
function buildRatingChanges(careers) {
  const changes = new Map();
  if (!careers?.teams) return changes;

  for (const career of careers.teams) {
    const points = career.points;
    if (!points || points.length < 2) continue;

    for (let i = 1; i < points.length; i++) {
      const [date, ratingAfter] = points[i];
      const [, ratingBefore] = points[i - 1];
      changes.set(`${career.team_id}|${date}`, {
        change: Math.round(ratingAfter - ratingBefore),
        rating: Math.round(ratingAfter),
      });
    }
  }
  return changes;
}

/* ISO week number from an ISO date string. */
function isoWeek(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function renderPlayedResults(report) {
  const holder = $('#played-results');
  holder.replaceChildren();

  const results = report.results || [];
  if (!results.length) {
    holder.appendChild(el('p', 'muted', t('played.empty')));
    return;
  }

  const ratingChanges = buildRatingChanges(state.careers);
  const sorted = [...results].sort((a, b) => b.date.localeCompare(a.date));

  // Group matches by ISO week (most recent week first)
  const weeks = [];
  const weekMap = new Map();
  for (const m of sorted) {
    const wk = isoWeek(m.date);
    if (!weekMap.has(wk)) {
      weekMap.set(wk, []);
      weeks.push(wk);
    }
    weekMap.get(wk).push(m);
  }

  state.playedWeek = Math.min(state.playedWeek || 0, weeks.length - 1);
  const currentWeek = weeks[state.playedWeek];
  const weekMatches = weekMap.get(currentWeek);

  // Week navigation (at top)
  const nav = el('div', 'played-nav');
  const prev = el('button', 'played-nav__btn', t('played.prev'));
  prev.disabled = state.playedWeek >= weeks.length - 1;
  prev.addEventListener('click', () => { state.playedWeek++; renderPlayedResults(report); });

  const label = el('span', 'played-nav__label', t('played.week', { n: currentWeek }));

  const next = el('button', 'played-nav__btn', t('played.next'));
  next.disabled = state.playedWeek === 0;
  next.addEventListener('click', () => { state.playedWeek--; renderPlayedResults(report); });

  nav.appendChild(prev);
  nav.appendChild(label);
  nav.appendChild(next);
  holder.appendChild(nav);

  for (const match of weekMatches) holder.appendChild(playedCard(match, ratingChanges));
}

function formatDate(iso) {
  const date = new Date(`${iso}T12:00:00Z`);
  return date.toLocaleDateString(localeDate(), { weekday: 'short', day: 'numeric', month: 'short' });
}

function longDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(localeDate(), {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
  });
}

/* Recent results per club, newest last. Built from the played-results list so
   it follows the rewind slider (that list is per-asof). */
function formByTeam(results) {
  const map = {};
  const sorted = [...(results || [])].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  for (const r of sorted) {
    if (r.home_goals == null || r.away_goals == null) continue;
    const draw = r.home_goals === r.away_goals;
    (map[r.home] ||= []).push(draw ? 'D' : r.home_goals > r.away_goals ? 'W' : 'L');
    (map[r.away] ||= []).push(draw ? 'D' : r.home_goals > r.away_goals ? 'L' : 'W');
  }
  for (const name in map) map[name] = map[name].slice(-5);
  return map;
}

function formPoints(form) {
  if (!form || !form.length) return 0;
  return form.reduce((total, letter) => total + (letter === 'W' ? 3 : letter === 'D' ? 1 : 0), 0);
}

function formChipsEl(form) {
  const holder = el('span', 'form__chips');
  const last5 = (form || []).slice(-5);
  if (!last5.length) return holder;
  const pts = formPoints(last5);
  const chip = el('span', 'form__chip', `${pts}/15`);
  const ratio = pts / 15;
  chip.style.background = `color-mix(in oklch, var(--outcome-good) ${Math.round(ratio * 100)}%, var(--outcome-bad))`;
  const w = last5.filter((r) => r === 'W').length;
  const d = last5.filter((r) => r === 'D').length;
  const l = last5.filter((r) => r === 'L').length;
  chip.title = t('form.tooltip', { w, d, l });
  holder.appendChild(chip);
  return holder;
}

/* ---------- hero & model card ------------------------------------- */

function renderHero(report) {
  const model = report.model;
  const leader = report.table[0];
  const favourite = report.table.reduce((best, row) =>
    row.position_probabilities[0] > best.position_probabilities[0] ? row : best
  );

  $('#hero-title').textContent = `${report.league.name} ${report.league.season}`;
  $('#model-badge').textContent = model.version;

  // A finished season has nothing left to simulate, so it gets told as history.
  if (model.matches_remaining === 0) {
    $('#hero-lede').textContent =
      t('hero.lede.finished', {
        team: leader.team,
        points: leader.points,
        matches: model.matches_played,
      });
  } else {
    const lede =
      favourite.team === leader.team
        ? t('hero.lede.agrees', {
            team: leader.team,
            points: leader.points,
            pct: pct(favourite.position_probabilities[0]),
          })
        : t('hero.lede.disagrees', {
            team: leader.team,
            points: leader.points,
            favourite: favourite.team,
            pct: pct(favourite.position_probabilities[0]),
          });
    $('#hero-lede').textContent =
      t('hero.lede.remaining', {
        lede,
        remaining: model.matches_remaining,
        simulations: model.simulations.toLocaleString(),
      });
  }

  const meta = $('#hero-meta');
  meta.replaceChildren();
  // The last three describe how the model was built rather than where the
  // season stands. They are the Model Card's job, and on a phone they cost
  // three lines above the table, so they are marked to drop there.
  for (const [name, value, provenance] of [
    [t('hero.played'), `${model.matches_played}`, false],
    [t('hero.remaining'), `${model.matches_remaining}`, false],
    [t('hero.simulated'), model.simulations.toLocaleString(), true],
    [t('hero.model'), model.version, true],
    [t('hero.ratingsFrom'), `${model.seed_season} ${t('hero.onward')}`, true],
  ]) {
    const cell = el('div', provenance ? 'hero__meta-provenance' : '');
    cell.appendChild(el('span', '', name));
    cell.appendChild(el('b', '', value));
    meta.appendChild(cell);
  }
}

function renderModelCard(report) {
  const model = report.model;
  const grid = $('#model-grid');
  grid.replaceChildren();
  for (const [name, value] of [
    [t('model.version'), model.version],
    [t('model.kfactor'), model.k_factor],
    [t('model.homeAdvantage'), `${model.home_advantage} ${t('model.pts')}`],
    [t('model.xgAlpha'), `${Math.round(model.xg_alpha * 100)}%`],
    [t('model.crossRegression'), `${Math.round((1 - model.season_regression) * 100)}% ${t('model.towardMean')}`],
    [t('model.peakDraw'), pct(model.draw_base, 0)],
    [t('model.outcomeOdds'), t('model.outcomeOddsValue')],
    [t('model.scorelines'), t('model.scorelinesValue')],
    [t('model.simulations'), model.simulations.toLocaleString()],
    [t('model.seed'), model.seed],
  ]) {
    const cell = el('div');
    cell.appendChild(el('dt', '', name));
    cell.appendChild(el('dd', '', String(value)));
    grid.appendChild(cell);
  }
}


/* ---------- team: one club's focus view ----------------------------- */

function openTeamView(teamId, fallbackName, { push = true } = {}) {
  if (anim.playing) animStop();
  // If the team isn't in the current league's report, find the right one
  const currentReport = state.reports?.[state.league];
  if (currentReport && !currentReport.table.some((t) => t.team_id === teamId)) {
    for (const [league, report] of Object.entries(state.reports)) {
      if (report.table.some((t) => t.team_id === teamId)) {
        state.league = league;
        for (const button of document.querySelectorAll('[data-league]')) {
          button.setAttribute('aria-pressed', String(button.dataset.league === league));
        }
        break;
      }
    }
  }
  state.teamFocusId = teamId;
  state.teamFixturesPage = 0;
  state.teamResultsPage = 0;
  state.teamSeasonsPage = 0;
  state.activeView = 'team';
  markActiveView();
  if (push) history.pushState({ team: true }, '');
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderTeamView(report) {
  const teamId = state.teamFocusId;
  const content = $('#team-content');
  content.replaceChildren();
  if (!teamId) return;

  const row = report.table.find((t) => t.team_id === teamId);
  const career = careerById(teamId);
  const teamName = row?.team || career?.team || fallbackNameById(teamId) || 'Unknown';

  // 1. Summary card
  renderTeamSummary(teamId, row, career, report, content);

  // 2. Finish grid row
  renderTeamGridRow(teamId, row, report, content);

  // 2b. Pre-season vs live prediction
  renderPreSeasonComparison(teamId, row, report, content);

  // 3. Rating history chart
  if (career && career.points.length >= 2) {
    const chartSection = el('div', 'team-section');
    chartSection.appendChild(el('div', 'label', t('team.ratingHistory')));
    const chart = svgEl('svg', { class: 'chart', id: 'team-chart', role: 'img' });
    chartSection.appendChild(chart);
    const desc = el('p', 'visually-hidden');
    desc.id = 'team-chart-desc';
    chartSection.appendChild(desc);

    // Peak and worst rating stats beneath the chart
    const stats = el('div', 'team-chart-stats');
    if (career.peak) {
      const peakItem = el('span', 'team-chart-stat');
      peakItem.appendChild(el('span', 'label', t('team.peak')));
      peakItem.appendChild(el('span', '', `${career.peak[1]} (${career.peak[0].slice(0, 4)})`));
      stats.appendChild(peakItem);
    }
    if (career.trough) {
      const troughItem = el('span', 'team-chart-stat');
      troughItem.appendChild(el('span', 'label', t('team.worst')));
      troughItem.appendChild(el('span', '', `${career.trough[1]} (${career.trough[0].slice(0, 4)})`));
      stats.appendChild(troughItem);
    }
    chartSection.appendChild(stats);

    content.appendChild(chartSection);
    drawTeamChart(career);
  }

  // 4. Season shape for this team
  if (report.history) {
    renderTeamShape(teamId, report, content);
  }

  // 5. Season stats table
  if (career && career.seasons.length) {
    const seasonSection = el('div', 'team-section');
    const header = el('div', 'team-section__header');
    header.appendChild(el('div', 'label', t('team.seasonBySeason', { n: career.seasons.length })));
    const seasonsDesc = [...career.seasons].reverse();
    const PAGE = 5;
    const totalPages = Math.ceil(seasonsDesc.length / PAGE);
    state.teamSeasonsPage = Math.min(state.teamSeasonsPage, totalPages - 1);
    const page = state.teamSeasonsPage;
    if (totalPages > 1) {
      header.appendChild(paginator(page, totalPages, (p) => { state.teamSeasonsPage = p; renderTeamView(report); }, true));
    }
    seasonSection.appendChild(header);
    const scroller = el('div', 'scroller');
    const table = el('table', 'standings career-table');
    const thead = el('thead');
    const seasonHeaders = [
      [t('team.season'), 'pos'],
      [t('team.division'), 'club'],
      [t('team.pos'), 'num'],
      [t('team.pl'), 'num'],
      [t('team.ptsShort'), 'num'],
      [t('team.gd'), 'num'],
      [t('team.ratingStart'), 'num sep'],
      [t('team.ratingEnd'), 'num'],
      [t('team.change'), 'num'],
    ];
    const headRow = el('tr');
    for (const [label, cls] of seasonHeaders) {
      const th = el('th', cls, label);
      th.scope = 'col';
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const record of seasonsDesc.slice(page * PAGE, (page + 1) * PAGE)) {
      const tr = el('tr');
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', async () => {
        const existing = content.querySelector('#team-shape-section');
        if (!existing) return;
        existing.classList.add('team-shape--loading');
        existing.replaceChildren(el('div', '', t('team.loadingShape', { year: record.season })));
        try {
          const res = await fetch(reportUrl(record.season));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const reports = applyShortNames(await res.json());
          const report = reports[record.league];
          const team = report.history?.teams?.find((t) => t.team_id === teamId);
          existing.classList.remove('team-shape--loading');
          if (!team) { existing.replaceChildren(el('div', '', t('team.noShape'))); return; }
          const chart = svgEl('svg', { class: 'chart', role: 'img' });
          chart.setAttribute('aria-label', t('team.seasonShapeYear', { year: record.season }));
          drawTeamShape(report, team, chart);
          const frag = document.createDocumentFragment();
          frag.appendChild(el('div', 'label', t('team.seasonShapeYear', { year: record.season })));
          frag.appendChild(chart);
          existing.replaceChildren(frag);
        } catch (err) {
          existing.classList.remove('team-shape--loading');
          existing.replaceChildren(el('div', '', t('team.loadError', { error: err.message })));
        }
      });
      tr.appendChild(el('td', 'pos', String(record.season)));
      tr.appendChild(el('td', 'club', record.league_name));
      tr.appendChild(el('td', 'num', String(record.position)));
      tr.appendChild(el('td', 'num muted', String(record.played)));
      tr.appendChild(el('td', 'num', String(record.points)));
      tr.appendChild(el('td', 'num muted', record.goal_difference > 0 ? `+${record.goal_difference}` : String(record.goal_difference)));
      tr.appendChild(el('td', 'num sep muted', String(record.rating_start)));
      tr.appendChild(el('td', 'num', String(record.rating_end)));
      const change = el('td', `num ${record.rating_change >= 0 ? 'up' : 'down'}`);
      change.textContent = record.rating_change >= 0 ? `+${record.rating_change}` : String(record.rating_change);
      tr.appendChild(change);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroller.appendChild(table);
    seasonSection.appendChild(scroller);
    content.appendChild(seasonSection);
  }

  // 5. Upcoming fixtures for this team
  renderTeamFixtures(teamId, teamName, report, content);

  // 6. Recent results for this team
  renderTeamResults(teamId, teamName, report, content);
}

function fallbackNameById(teamId) {
  return allTeams().find((t) => t.team_id === teamId)?.team;
}

/* Arrows step through pages; `reversed` lists (newest first) page the other way. */
function paginator(page, totalPages, go, reversed = false) {
  const nav = el('div', 'team-pagination');
  const step = reversed ? -1 : 1;
  const prev = el('button', 'team-pagination__btn', '\u2190');
  prev.disabled = reversed ? page >= totalPages - 1 : page === 0;
  prev.addEventListener('click', () => go(page - step));
  nav.appendChild(prev);
  nav.appendChild(el('span', 'team-pagination__label', `${page + 1} / ${totalPages}`));
  const next = el('button', 'team-pagination__btn', '\u2192');
  next.disabled = reversed ? page === 0 : page >= totalPages - 1;
  next.addEventListener('click', () => go(page + step));
  nav.appendChild(next);
  return nav;
}

function renderTeamSummary(teamId, row, career, report, container) {
  const card = el('div', 'team-summary');

  const header = el('div', 'team-summary__header');

  // Crest
  const crest = teamLogo(teamId, row?.team || career?.team || '');
  if (crest) {
    crest.classList.add('team-logo--large');
    header.appendChild(crest);
  }

  // Name (pushes right side to the end)
  const nameBlock = el('div', 'team-summary__name-block');
  nameBlock.appendChild(el('h3', 'team-summary__name', row?.team || career?.team || 'Unknown'));
  header.appendChild(nameBlock);

  // Rating block: [arrow + rating] / position
  const ratingBlock = el('div', 'team-summary__rating-block');
  const ratingLine = el('div', 'team-summary__rating-line');
  const trend = computeRatingTrend(row?.team || career?.team, report);
  if (trend) {
    const trendEl = el('span', `team-summary__trend team-summary__trend--${trend.direction}`);
    trendEl.innerHTML = trend.svg;
    trendEl.title = trend.detail;
    ratingLine.appendChild(trendEl);
  }
  const rating = Math.round(row?.rating || career?.current_rating || 0);
  ratingLine.appendChild(el('span', 'team-summary__rating', String(rating)));
  ratingBlock.appendChild(ratingLine);
  // Rank by rating across both divisions, like the ladder
  const allTeams = state.reports
    ? Object.values(state.reports).flatMap((r) => r.table.map((t) => ({ team_id: t.team_id, rating: t.rating })))
    : [];
  allTeams.sort((a, b) => b.rating - a.rating);
  const crossRank = allTeams.findIndex((t) => t.team_id === teamId);
  const totalTeams = allTeams.length || report.table.length;
  ratingBlock.appendChild(el('span', 'team-summary__rating-pos', t('team.rankOf', { rank: ordinal(crossRank >= 0 ? crossRank + 1 : (row?.position ?? 0)), total: totalTeams })));
  header.appendChild(ratingBlock);

  card.appendChild(header);

  // Stats row
  const stats = el('div', 'team-summary__stats');
  if (row) {
    stats.appendChild(summaryStat(t('team.position'), ordinal(row.position)));
    stats.appendChild(summaryStat(t('team.points'), String(row.points)));
    stats.appendChild(summaryStat(t('team.gd'), row.goal_difference > 0 ? `+${row.goal_difference}` : String(row.goal_difference)));
    stats.appendChild(summaryStat(t('team.played'), String(row.played)));
    stats.appendChild(summaryStat(t('team.attack'), row.attack.toFixed(2), t('team.ratesHint')));
    stats.appendChild(summaryStat(t('team.defence'), row.defence.toFixed(2), t('team.ratesHint')));
  } else if (career) {
    stats.appendChild(summaryStat(t('team.matches'), String(career.points.length)));
  }
  card.appendChild(stats);

  // Form chips
  const formByTeamName = formByTeam(state.reports[state.league].results);
  const teamName = row?.team || career?.team;
  if (teamName) {
    const form = formByTeamName[teamName];
    if (form && form.length) {
      const formRow = el('div', 'team-summary__form');
      formRow.appendChild(el('span', 'label', t('team.form')));
      formRow.appendChild(formChipsEl(form));
      card.appendChild(formRow);
    }
  }

  container.appendChild(card);
}

/* Rating trend: 5 degrees based on how much the rating changed since 5 matches ago. */
function computeRatingTrend(teamName, report) {
  if (!teamName) return null;
  const results = [...(report.results || [])].sort((a, b) => a.date.localeCompare(b.date));
  const ratingChanges = buildRatingChanges(state.careers);
  const ratings = [];
  for (const r of results) {
    if (r.home_goals == null) continue;
    const isHome = r.home === teamName;
    const isAway = r.away === teamName;
    if (!isHome && !isAway) continue;
    const id = isHome ? r.home_id : r.away_id;
    const info = ratingChanges.get(`${id}|${r.date}`);
    if (info) ratings.push(info.rating);
  }
  if (ratings.length < 6) return null;

  const current = ratings[ratings.length - 1];
  const fiveAgo = ratings[ratings.length - 6];
  const diff = current - fiveAgo;

  // 5 degrees: strong rise, rise, steady, fall, strong fall
  const key = diff > 20 ? 'strongRise' : diff > 5 ? 'rise' : diff >= -5 ? 'steady' : diff >= -20 ? 'fall' : 'strongFall';
  const direction = key.replace('strongR', 'strong-r').replace('strongF', 'strong-f');
  const n = Math.round(key === 'steady' ? Math.abs(diff) : diff);
  return { direction, svg: trendArrowSVG(direction), detail: t(`trend.${key}`, { n }), diff };
}

function trendArrowSVG(direction) {
  const rotation = {
    'strong-rise': '0',
    'rise': '45',
    'steady': '90',
    'fall': '135',
    'strong-fall': '180',
  }[direction];

  return `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(${rotation}deg)"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg>`;
}

function summaryStat(label, value, title) {
  const item = el('div', 'team-summary__stat');
  if (title) item.title = title;
  item.appendChild(el('span', 'team-summary__stat-label', label));
  item.appendChild(el('span', 'team-summary__stat-value', value));
  return item;
}

function renderTeamGridRow(teamId, row, report, container) {
  if (!row) return;
  const section = el('div', 'team-section');
  section.appendChild(el('div', 'label', t('team.finishProbs')));

  const wrap = el('div', 'team-grid-row');
  const bands = report.league.bands;
  for (let i = 0; i < row.position_probabilities.length; i++) {
    const prob = row.position_probabilities[i];
    const position = i + 1;
    const step = heatStep(prob);
    const cell = el('div', `team-grid-row__cell ${heatTextClass(step)}`.trim());
    cell.style.background = seqStepColor(step);
    cell.textContent = pctShort(prob);
    if (!cell.textContent) cell.classList.add('team-grid-row__cell--empty');

    const band = bandFor(bands, position);
    cell.addEventListener('pointerenter', (event) =>
      showTooltip(event, `<b>${row.team}</b> ${ordinal(position)}<br>${pct(prob, 2)}` + (band ? `<br>${band.label}` : ''))
    );
    cell.addEventListener('pointermove', moveTooltip);
    cell.addEventListener('pointerleave', hideTooltip);

    const posLabel = el('span', 'team-grid-row__pos', String(position));
    const cellWrap = el('div', 'team-grid-row__cell-wrap');
    cellWrap.appendChild(posLabel);
    cellWrap.appendChild(cell);
    wrap.appendChild(cellWrap);
  }
  section.appendChild(wrap);
  container.appendChild(section);
}

function renderPreSeasonComparison(teamId, row, report, container) {
  const historyTeam = report.history?.teams?.find((t) => t.team_id === teamId);
  if (!historyTeam || historyTeam.positions.length < 2 || !row) return;

  const prePositions = historyTeam.positions[0];
  const preBest = prePositions.indexOf(Math.max(...prePositions));
  const liveBest = row.position_probabilities.indexOf(Math.max(...row.position_probabilities));
  const preRating = historyTeam.ratings[0];
  const delta = preRating != null ? Math.round(row.rating - preRating) : null;

  const section = el('div', 'team-section');
  section.appendChild(el('div', 'label', t('team.prediction')));

  const box = el('div', 'pred-box');
  const from = el('div', 'pred-box__from');
  from.appendChild(el('div', 'pred-box__sub', t('team.predPreSeason')));
  from.appendChild(el('div', 'pred-box__pos', ordinal(preBest + 1)));
  box.appendChild(from);
  const mid = el('div', 'pred-box__mid');
  if (delta != null) {
    const cls = delta > 0 ? 'up' : delta < 0 ? 'down' : '';
    mid.appendChild(el('span', `pred-box__delta ${cls}`, delta > 0 ? `+${delta}` : String(delta)));
  }
  mid.appendChild(el('div', 'pred-box__arrow', '\u2192'));
  box.appendChild(mid);
  const to = el('div', 'pred-box__to');
  to.appendChild(el('div', 'pred-box__sub', t('team.predCurrent')));
  to.appendChild(el('div', 'pred-box__pos', ordinal(liveBest + 1)));
  box.appendChild(to);
  section.appendChild(box);
  container.appendChild(section);
}

function drawTeamChart(career) {
  const chart = $('#team-chart');
  if (!chart) return;
  const points = career.points;

  const width = 940;
  const height = 260;
  const pad = { top: 14, right: 16, bottom: 30, left: 46 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
  chart.replaceChildren();

  const times = points.map(pointTime);
  const first = times[0];
  const span = (times[times.length - 1] - first) || 1;
  const ratings = points.map(([, rating]) => rating);

  const low = Math.floor(Math.min(...ratings) / 50) * 50;
  const high = Math.ceil(Math.max(...ratings) / 50) * 50;
  const x = (time) => pad.left + ((time - first) / span) * plotWidth;
  const y = (rating) => pad.top + (1 - (rating - low) / (high - low || 1)) * plotHeight;

  for (let value = low; value <= high; value += 50) {
    chart.appendChild(
      svgEl('line', { class: 'grid-line', x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value) })
    );
    const label = svgEl('text', { class: 'tick', x: pad.left - 8, y: y(value) + 3.5, 'text-anchor': 'end' });
    label.textContent = String(value);
    chart.appendChild(label);
  }

  for (const record of career.seasons) {
    const start = Date.parse(`${record.season}-01-01T12:00:00Z`);
    if (start < first || start > times[times.length - 1]) continue;
    chart.appendChild(
      svgEl('line', { class: 'season-split', x1: x(start), x2: x(start), y1: pad.top, y2: pad.top + plotHeight })
    );
    const label = svgEl('text', { class: 'season-label', x: x(start) + 3, y: pad.top + 10 });
    label.textContent = String(record.season);
    chart.appendChild(label);
  }

  const line = points.map(([date, rating], index) => `${x(times[index])},${y(rating)}`).join(' ');
  chart.appendChild(
    svgEl('polygon', {
      class: 'career-area',
      points: `${pad.left},${pad.top + plotHeight} ${line} ${pad.left + plotWidth},${pad.top + plotHeight}`,
    })
  );
  chart.appendChild(svgEl('polyline', { class: 'career-line', points: line }));
  chart.appendChild(
    svgEl('circle', {
      class: 'career-dot',
      cx: x(times[times.length - 1]),
      cy: y(ratings[ratings.length - 1]),
      r: 4,
    })
  );

  const axis = svgEl('text', { class: 'axis-title', x: pad.left, y: height - 6 });
    axis.textContent = t('season.shape.axis');
  chart.appendChild(axis);

  // Crosshair readout
  const crosshair = svgEl('line', { class: 'crosshair', y1: pad.top, y2: pad.top + plotHeight, x1: -10, x2: -10 });
  crosshair.style.opacity = '0';
  chart.appendChild(crosshair);

  const surface = svgEl('rect', {
    x: pad.left, y: pad.top, width: plotWidth, height: plotHeight, fill: 'transparent',
  });
  surface.addEventListener('pointermove', (event) => {
    const box = chart.getBoundingClientRect();
    const localX = (event.clientX - box.left) * (width / box.width);
    let index = 0;
    for (let candidate = 1; candidate < times.length; candidate += 1) {
      if (Math.abs(x(times[candidate]) - localX) < Math.abs(x(times[index]) - localX)) index = candidate;
    }
    crosshair.setAttribute('x1', x(times[index]));
    crosshair.setAttribute('x2', x(times[index]));
    crosshair.style.opacity = '1';
    const when = new Date(times[index]).toLocaleDateString(localeDate(), {
      day: 'numeric', month: 'short', year: 'numeric',
    });
    showTooltip(event, `<b>${career.team}</b><br>${when}<br>${t('chart.rating', { n: points[index][1] })}`);
  });
  surface.addEventListener('pointerleave', () => {
    crosshair.style.opacity = '0';
    hideTooltip();
  });
  chart.appendChild(surface);

  chart.setAttribute('aria-label', t('chart.ratingFrom', { team: career.team, from: points[0][0], to: points[points.length - 1][0] }));
  const desc = $('#team-chart-desc');
  if (desc) desc.textContent =
    t('chart.ratingMoved', { team: career.team, from: points[0][1], to: career.current_rating, seasons: career.seasons.length });
}

function renderTeamFixtures(teamId, teamName, report, container) {
  const allFixtures = (report.fixtures || []).filter(
    (f) => f.home_id === teamId || f.away_id === teamId
  );
  if (!allFixtures.length) return;

  const PAGE = 5;
  const totalPages = Math.ceil(allFixtures.length / PAGE);
  state.teamFixturesPage = Math.min(state.teamFixturesPage, totalPages - 1);
  const page = state.teamFixturesPage;
  const fixtures = allFixtures.slice(page * PAGE, (page + 1) * PAGE);

  const section = el('div', 'team-section');
  const header = el('div', 'team-section__header');
  header.appendChild(el('div', 'label', t('team.upcomingFixtures', { n: allFixtures.length })));
  if (totalPages > 1) {
    header.appendChild(paginator(page, totalPages, (p) => { state.teamFixturesPage = p; renderTeamView(report); }));
  }
  section.appendChild(header);

  for (const fixture of fixtures) {
    section.appendChild(buildFixtureCard(fixture));
  }
  container.appendChild(section);
}

function renderTeamResults(teamId, teamName, report, container) {
  const allResults = (report.results || []).filter(
    (r) => r.home_id === teamId || r.away_id === teamId
  );
  if (!allResults.length) return;

  const ratingChanges = buildRatingChanges(state.careers);
  const sorted = [...allResults].sort((a, b) => b.date.localeCompare(a.date));

  const PAGE = 5;
  const totalPages = Math.ceil(sorted.length / PAGE);
  state.teamResultsPage = Math.min(state.teamResultsPage, totalPages - 1);
  const page = state.teamResultsPage;
  const matches = sorted.slice(page * PAGE, (page + 1) * PAGE);

  const section = el('div', 'team-section');
  const header = el('div', 'team-section__header');
  header.appendChild(el('div', 'label', t('team.recentResults', { n: allResults.length })));
  if (totalPages > 1) {
    header.appendChild(paginator(page, totalPages, (p) => { state.teamResultsPage = p; renderTeamView(report); }, true));
  }
  section.appendChild(header);

  for (const match of matches) section.appendChild(playedCard(match, ratingChanges));
  container.appendChild(section);
}

/* ---------- team focus: season shape -------------------------------- */

function renderTeamShape(teamId, report, container) {
  const history = report.history;
  if (!history) return;

  const team = history.teams.find((t) => t.team_id === teamId);
  if (!team) return;

  const section = el('div', 'team-section');
  section.id = 'team-shape-section';
  section.appendChild(el('div', 'label', t('team.seasonShape')));

  const chart = svgEl('svg', { class: 'chart', role: 'img' });
  chart.setAttribute('aria-label', t('shape.stackedArea', { team: team.team }));
  section.appendChild(chart);

  container.appendChild(section);
  drawTeamShape(report, team, chart);
}

function drawTeamShape(report, team, chart) {
  const history = report.history;
  const count = report.table.length;
  const snapshots = history.dates.length;

  const width = 900;
  const height = 280;
  const pad = { top: 10, right: 12, bottom: 30, left: 40 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
  chart.replaceChildren();

  const x = (index) => pad.left + (index / (snapshots - 1 || 1)) * plotWidth;
  const y = (cumulative) => pad.top + cumulative * plotHeight;

  const cumulative = history.dates.map((_, index) => {
    const running = [0];
    for (let position = 0; position < count; position += 1) {
      running.push(running[position] + team.positions[index][position]);
    }
    return running;
  });

  for (let gridline = 0; gridline <= 4; gridline += 1) {
    const value = gridline / 4;
    chart.appendChild(
      svgEl('line', { class: 'grid-line', x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value) })
    );
    const label = svgEl('text', { class: 'tick', x: pad.left - 6, y: y(value) + 3, 'text-anchor': 'end' });
    label.textContent = `${100 - gridline * 100 / 4}%`;
    chart.appendChild(label);
  }

  for (let position = 1; position <= count; position += 1) {
    const upper = [];
    const lower = [];
    for (let index = 0; index < snapshots; index += 1) {
      upper.push(`${x(index)},${y(cumulative[index][position - 1])}`);
      lower.push(`${x(index)},${y(cumulative[index][position])}`);
    }
    const band = svgEl('polygon', {
      class: 'band',
      points: [...upper, ...lower.reverse()].join(' '),
      fill: positionColor(position, count),
    });

    const bandLabel = bandFor(report.league.bands, position);
    band.addEventListener('pointerenter', (event) => {
      const latest = team.positions[snapshots - 1][position - 1];
      showTooltip(
        event,
        `<b>${ordinal(position)}</b>${bandLabel ? ` · ${bandLabel.label}` : ''}<br>` +
          t('shape.now', { pct: pct(latest, 1) })
      );
    });
    band.addEventListener('pointermove', moveTooltip);
    band.addEventListener('pointerleave', hideTooltip);
    chart.appendChild(band);
  }

  chart.appendChild(
    svgEl('line', { class: 'axis-line', x1: pad.left, x2: width - pad.right, y1: y(1), y2: y(1) })
  );

  // Build a list of months to label, including gaps (e.g. June during summer break).
  // For each month, interpolate its x position between the two nearest snapshots.
  const firstDate = new Date(`${history.dates[0]}T12:00:00Z`);
  const lastDate = new Date(`${history.dates[history.dates.length - 1]}T12:00:00Z`);
  const firstMonthIdx = firstDate.getUTCMonth();
  const firstMonthYear = firstDate.getUTCFullYear();
  const lastMonthIdx = lastDate.getUTCMonth();
  const lastMonthYear = lastDate.getUTCFullYear();
  const totalMonths = (lastMonthYear - firstMonthYear) * 12 + (lastMonthIdx - firstMonthIdx) + 1;

  // Snapshots as timestamps for interpolation
  const snapTimes = history.dates.map((iso) => Date.parse(`${iso}T12:00:00Z`));

  for (let m = 0; m < totalMonths; m += 1) {
    const monthIdx = (firstMonthIdx + m) % 12;
    const year = firstMonthYear + Math.floor((firstMonthIdx + m) / 12);
    const monthName = new Date(Date.UTC(year, monthIdx, 1))
      .toLocaleDateString(localeDate(), { month: 'short' });

    // 1st of this month as a timestamp
    const firstOfMonth = Date.UTC(year, monthIdx, 1);

    // Find the snapshot index just after this date
    let afterIdx = snapTimes.findIndex((t) => t >= firstOfMonth);
    if (afterIdx === -1) afterIdx = snapTimes.length - 1;
    const beforeIdx = Math.max(0, afterIdx - 1);

    // Lerp between the two nearest snapshots
    const beforeTime = snapTimes[beforeIdx];
    const afterTime = snapTimes[afterIdx];
    const fraction = beforeTime === afterTime ? 0
      : Math.max(0, Math.min(1, (firstOfMonth - beforeTime) / (afterTime - beforeTime)));
    const xPos = x(beforeIdx) + fraction * (x(afterIdx) - x(beforeIdx));

    const label = svgEl('text', { class: 'tick', x: xPos, y: height - pad.bottom + 12, 'text-anchor': 'middle' });
    label.textContent = monthName;
    chart.appendChild(label);
    chart.appendChild(
      svgEl('line', { class: 'grid-line', x1: xPos, x2: xPos, y1: pad.top, y2: y(1) })
    );
  }

  const axisTitle = svgEl('text', { class: 'axis-title', x: pad.left, y: height - 4 });
  axisTitle.textContent = t('shape.seasonAxis', { year: history.dates[0].slice(0, 4) });
  chart.appendChild(axisTitle);

  attachTeamShapeCrosshair(chart, report, team, { x, pad, plotWidth, plotHeight, width, height, snapshots, count });
}

function attachTeamShapeCrosshair(chart, report, team, geometry) {
  const { x, pad, plotWidth, plotHeight, width, snapshots, count } = geometry;
  const history = report.history;
  const line = svgEl('line', { class: 'crosshair', y1: pad.top, y2: pad.top + plotHeight, x1: -10, x2: -10 });
  line.style.opacity = '0';
  chart.appendChild(line);

  const relegation = report.league.bands.find((band) => band.tone === 'relegation');
  const top = report.league.bands.find((band) => band.tone === 'top');
  const totalMatches = report.model.matches_played + report.model.matches_remaining;

  const surface = svgEl('rect', {
    x: pad.left, y: pad.top, width: plotWidth, height: plotHeight, fill: 'transparent',
  });
  surface.addEventListener('pointermove', (event) => {
    const box = chart.getBoundingClientRect();
    const scale = width / box.width;
    const localX = (event.clientX - box.left) * scale;
    let index = 0;
    for (let candidate = 1; candidate < snapshots; candidate += 1) {
      if (Math.abs(x(candidate) - localX) < Math.abs(x(index) - localX)) index = candidate;
    }

    line.setAttribute('x1', x(index));
    line.setAttribute('x2', x(index));
    line.style.opacity = '1';

    const probabilities = team.positions[index];
    const best = probabilities.indexOf(Math.max(...probabilities));
    const sum = (band) => (band ? probabilities.slice(band.first - 1, band.last).reduce((a, b) => a + b, 0) : 0);
    const when = new Date(`${history.dates[index]}T12:00:00Z`).toLocaleDateString(localeDate(), {
      day: 'numeric', month: 'short', year: 'numeric',
    });
    const played = history.matches_played[index];

    showTooltip(
      event,
      `<b>${team.team}</b> · ${played === 0 ? t('shape.preseason') : when}<br>` +
        `${t('shape.matchesPlayed', { n: played, total: totalMatches })}<br>` +
        `${t('shape.rating', { n: team.ratings[index] })}<br>` +
        `${t('shape.mostLikely', { n: ordinal(best + 1) })} (${pct(probabilities[best])})<br>` +
        `${top ? `${t('shape.topN', { n: top.last, pct: pct(sum(top)) })} · ` : ''}${t('shape.bottomN', { n: count - (relegation ? relegation.first - 1 : count), pct: pct(sum(relegation)) })}`
    );
  });
  surface.addEventListener('pointerleave', () => {
    line.style.opacity = '0';
    hideTooltip();
  });
  chart.appendChild(surface);
}


/* ---------- season rewind ------------------------------------------
   The slider moves the entire page, not just one panel: the server rebuilds
   the report from only the results known on the chosen day, so the grid, the
   table, the ratings and the fixtures all agree with each other. */

function matchdays(report) {
  return report.league.matchdays || [];
}

function renderTimeline(report) {
  const panel = $('#timeline');
  const days = matchdays(report);
  const range = $('#timeline-range');

  // A season with nothing played has nothing to rewind through.
  panel.hidden = days.length < 2;
  if (panel.hidden) return;

  if (Number(range.max) !== days.length - 1) {
    range.max = String(days.length - 1);
    range.step = '1';
  }

  const index = state.asof
    ? Math.max(0, days.findIndex((day) => day.date === state.asof))
    : days.length - 1;
  range.value = String(index);

  const day = days[index];
  const live = !state.asof || index === days.length - 1;
  panel.classList.toggle('is-past', !live);
  $('#timeline-now').hidden = live;

  const when = longDate(day.date);
  $('#timeline-when').textContent = live
    ? t('timeline.liveCount', { n: day.matches_played })
    : t('timeline.asOf', { when, n: day.matches_played, total: report.model.matches_played + report.model.matches_remaining });

  $('#timeline-back').disabled = index <= 0;
  $('#timeline-forward').disabled = index >= days.length - 1;

  const scale = $('#timeline-scale');
  scale.replaceChildren();
  const first = new Date(`${days[0].date}T12:00:00Z`);
  const last = new Date(`${days[days.length - 1].date}T12:00:00Z`);
  const month = (d) => d.toLocaleDateString(localeDate(), { month: 'short', year: 'numeric' });
  scale.appendChild(el('span', '', month(first)));
  scale.appendChild(el('span', '', t('timeline.matchdays', { n: days.length })));
  scale.appendChild(el('span', '', month(last)));
}

/* Dragging fires continuously; only the value you settle on is worth a fetch. */
function onTimelineInput(event) {
  const report = state.reports[state.league];
  const days = matchdays(report);
  const index = Number(event.target.value);
  const day = days[index];
  if (!day) return;

  // If animating, scrub within prefetched data instead of fetching
  if (anim.playing) {
    anim.matchdayIndex = index;
    anim.lastTick = performance.now();
    animFrame(0);
    $('#timeline-when').textContent = t('timeline.paused', { when: longDate(day.date) });
    return;
  }

  const live = index === days.length - 1;
  $('#timeline-when').textContent = live ? t('timeline.scrubLive') : t('timeline.scrubAsOf', { when: longDate(day.date) });
  $('#timeline').classList.toggle('is-past', !live);

  clearTimeout(state.rewindTimer);
  state.rewindTimer = setTimeout(() => rewindTo(live ? null : day.date), 220);
}

async function rewindTo(asof) {
  if (asof === state.asof) return;
  const content = $('#content');
  content.classList.add('is-rewinding');
  try {
    const response = await fetch(reportUrl(state.season, asof));
    if (!response.ok) throw new Error(`server returned ${response.status}`);
    state.reports = applyShortNames(await response.json());
    state.asof = asof;
    render();
  } catch (error) {
    $('#timeline-when').textContent = t('status.couldNotRewind', { error: error.message });
  } finally {
    content.classList.remove('is-rewinding');
  }
}

/* ---------- theme -------------------------------------------------- */

function resolveTheme() {
  const chosen = localStorage.getItem('elitetracker-theme');
  document.documentElement.dataset.resolvedTheme = chosen === 'light' || chosen === 'dark' ? chosen
    : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === chosen));
  }
}

/* ---------- wiring -------------------------------------------------- */

function render() {
  const report = state.reports[state.league];

  // Always render these (they're either always visible or quick)
  renderSeasonOptions(report);
  renderTimeline(report);
  renderHero(report);

  // Show/hide sections based on active view
  for (const section of document.querySelectorAll('[data-section]')) {
    const views = section.dataset.section.split(' ');
    section.hidden = !views.includes(state.activeView);
  }

  // Hide the rewind timeline on views where it isn't relevant
  const noRewind = new Set(['next-up', 'compare', 'played', 'model', 'team']);
  const timelineSection = document.querySelector('.timeline-section');
  if (timelineSection) timelineSection.hidden = noRewind.has(state.activeView);

  // Team view requires a selected team; fall back to table if none
  if (state.activeView === 'team' && !state.teamFocusId) {
    state.activeView = 'table';
    markActiveView();
  }

  // View-specific renders
  switch (state.activeView) {
    case 'table':
      renderStandings(report);
      renderBandLegend(report);
      break;
    case 'grid':
      if (!anim.playing) {
        renderGrid(report);
        renderGridLegend();
      }
      break;
    case 'ladder':
      if (!anim.playing) renderLadder(state.reports);
      break;
    case 'next-up':
      renderFixtures(report);
      renderOddsLegend();
      break;
    case 'compare':
      populateCompare(report);
      renderCompare(report);
      break;
    case 'played':
      if (state._prevActiveView !== 'played') state.playedWeek = 0;
      renderPlayedResults(report);
      break;
    case 'team':
      renderTeamView(report);
      break;
    case 'model':
      renderModelCard(report);
      break;
  }

  // Persist active view to URL for linkability
  const params = new URLSearchParams(window.location.search);
  params.set('view', state.activeView);
  if (state.activeView === 'team' && state.teamFocusId) {
    const teamName = (state.reports[state.league].table.find((t) => t.team_id === state.teamFocusId) || {}).team;
    if (teamName) params.set('team', teamName);
    else params.delete('team');
  } else {
    params.delete('team');
  }
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}${window.location.hash}`);

  document.title = `${report.league.name} ${report.league.season} — EliteTracker`;
  state._prevActiveView = state.activeView;
}

function wire() {
  for (const button of document.querySelectorAll('[data-league]')) {
    button.addEventListener('click', () => {
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
    });
  }

  for (const button of document.querySelectorAll('[data-lang]')) {
    button.addEventListener('click', () => {
      const lang = button.dataset.lang;
      setLang(lang);
      for (const other of document.querySelectorAll('[data-lang]')) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      render();
    });
  }

  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => {
      if (anim.playing && button.dataset.view !== state.activeView) animStop();
      state.activeView = button.dataset.view;
      markActiveView();
      closeSheet();
      render();
      hideTooltip();
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
  }

  // Panel descriptions are clamped to two lines on a phone; a tap opens one.
  // Delegated, because every view rebuilds its own panel content.
  document.addEventListener('click', (event) => {
    const description = event.target.closest('.panel__head p');
    if (description) description.classList.toggle('is-expanded');
  });

  $('#more-button').addEventListener('click', () => {
    if ($('#more-sheet').hidden) openSheet();
    else closeSheet();
  });
  for (const closer of document.querySelectorAll('[data-close-sheet]')) {
    closer.addEventListener('click', closeSheet);
  }

  const stepMatchday = (delta) => {
    const range = $('#timeline-range');
    range.value = String(Number(range.value) + delta);
    range.dispatchEvent(new Event('input', { bubbles: true }));
  };
  $('#timeline-back').addEventListener('click', () => stepMatchday(-1));
  $('#timeline-forward').addEventListener('click', () => stepMatchday(1));

  $('#grid-anim-play').addEventListener('click', animStart);
  $('#grid-anim-speed').addEventListener('click', animToggleSpeed);

  $('#ladder-anim-play').addEventListener('click', animStart);
  $('#ladder-anim-speed').addEventListener('click', animToggleSpeed);

  for (const button of document.querySelectorAll('#standings .sort-btn')) {
    button.addEventListener('click', () => toggleSort(button.dataset.sortKey));
  }

  $('#season-select').addEventListener('change', async (event) => {
    if (anim.playing) animStop();
    state.asof = null; // a different season has a different timeline
    await loadSeason(Number(event.target.value));
  });

  $('#timeline-range').addEventListener('input', onTimelineInput);
  $('#timeline-now').addEventListener('click', () => { if (anim.playing) animStop(); rewindTo(null); });

  $('#compare-a').addEventListener('change', () => renderCompare(state.reports[state.league]));
  $('#compare-b').addEventListener('change', () => renderCompare(state.reports[state.league]));

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!$('#more-sheet').hidden) closeSheet();
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    resolveTheme();
    render();
  });

  window.addEventListener('popstate', () => {
    if (!state.teamFocusId) return;
    state.teamFocusId = null;
    applyViewParameter();
    render();
  });
}

/* ?league=obosligaen&team=Viking makes any view linkable. Team is matched on
   name so a shared link stays readable. */
/* ?sort=rating&dir=desc — the table view is linkable like the rest. */
function applySortParameter() {
  const params = new URLSearchParams(window.location.search);
  const key = params.get('sort');
  if (!key) return;
  const known = document.querySelector(`#standings th[data-sort-col="${CSS.escape(key)}"]`);
  if (!known) return;
  const dir = params.get('dir') === 'asc' ? 1 : params.get('dir') === 'desc' ? -1
    : SORT_ASCENDING_FIRST.has(key) ? 1 : -1;
  state.sort = { key, dir };
}

function applyLeagueParameter() {
  const league = new URLSearchParams(window.location.search).get('league');
  if (!league || !state.reports[league]) return;
  state.league = league;
  for (const button of document.querySelectorAll('[data-league]')) {
    button.setAttribute('aria-pressed', String(button.dataset.league === league));
  }
}

/* Team is matched on name so a shared link stays readable. Applied after the
   first render, once the club list exists. */
function applyTeamParameter() {
  const wanted = new URLSearchParams(window.location.search).get('team');
  if (!wanted) return;
  const pool = state.careers?.teams || state.reports[state.league].table || [];
  const club = pool.find((team) => team.team.toLowerCase() === wanted.toLowerCase());
  if (club) openTeamView(club.team_id, club.team, { push: false });
}

/* Three controls can name the current view -- the desktop strip, the phone bar
   and the More sheet -- and every one of them carries the same data-view, so
   they are all marked from here. The strip scrolls sideways once it outgrows
   its container, so its active tab is pulled back into sight; scrolling the
   fixed bar or the sheet would only jog the page. */
function markActiveView() {
  for (const button of document.querySelectorAll('[data-view]')) {
    const active = button.dataset.view === state.activeView;
    button.setAttribute('aria-pressed', String(active));
    if (active && button.closest('.masthead__views')) {
      button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  // The bar shows four views; when the current one lives in the sheet, More
  // carries the mark so the bar is never blank.
  const inBar = [...document.querySelectorAll('.mobilebar__item[data-view]')]
    .some((button) => button.dataset.view === state.activeView);
  $('#more-button').setAttribute('aria-pressed', String(!inBar));
}

function openSheet() {
  $('#more-sheet').hidden = false;
  $('#more-button').setAttribute('aria-expanded', 'true');
}

function closeSheet() {
  $('#more-sheet').hidden = true;
  $('#more-button').setAttribute('aria-expanded', 'false');
}

/* ?view=grid makes any view linkable. Applied early so the first render
   shows the requested view instead of the default table. */
function applyViewParameter() {
  const view = new URLSearchParams(window.location.search).get('view');
  const validViews = new Set(['table', 'grid', 'ladder', 'next-up', 'compare', 'played', 'team', 'model']);
  if (view && validViews.has(view)) {
    state.activeView = view;
    markActiveView();
  }
}

/* Older seasons exist as static files (or are built on the live server the
   first time they are asked for), so this can take a moment. Say so rather
   than appearing to hang. */
async function loadSeason(season) {
  const select = $('#season-select');
  select.disabled = true;
  const previous = state.season;
  try {
    const response = await fetch(reportUrl(season));
    if (!response.ok) throw new Error(`server returned ${response.status}`);
    state.reports = applyShortNames(await response.json());
    state.season = season;
    render();
  } catch (error) {
    select.value = String(previous);
    $('#status').hidden = false;
    $('#status').textContent = t('status.couldNotLoad', { season, error: error.message });
  } finally {
    select.disabled = false;
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

/* ---------- compare clubs ----------------------------------------- */

function allTeams() {
  const seen = new Set();
  const teams = [];
  for (const report of Object.values(state.reports || {})) {
    for (const row of report.table || []) {
      if (seen.has(row.team_id)) continue;
      seen.add(row.team_id);
      teams.push(row);
    }
  }
  teams.sort((a, b) => a.team.localeCompare(b.team, 'nb'));
  return teams;
}

function teamNameById(id) {
  return allTeams().find((team) => team.team_id === id)?.team || id;
}

function careerById(id) {
  return (state.careers?.teams || []).find((team) => team.team_id === id);
}

function ratingById(id) {
  return allTeams().find((team) => team.team_id === id)?.rating ?? 0;
}

/* Three-way odds for a fictional match, ported from model/probabilities.py.
   Both divisions share one rating scale, so any two clubs can meet. Working it
   out here costs a few lines and saves shipping a 32x31 matrix of every
   possible pairing in every report file. */
function matchOdds(model, homeRating, awayRating) {
  const gap = homeRating + model.home_advantage - awayRating;
  // The ELO expectation of that gap against an even 1500 baseline. Half the
  // draw mass comes off each side, so home_win + 0.5*draw reproduces it exactly.
  const expected = 1 / (1 + 10 ** (-gap / 400));
  const draw = Math.min(
    model.draw_base * Math.exp(-((gap / model.draw_scale) ** 2)),
    2 * Math.min(expected, 1 - expected)
  );
  return { gap, home_win: expected - draw / 2, draw, away_win: 1 - expected - draw / 2 };
}

/* Most likely scorelines, ported from display/fixtures.py: each outcome's
   empirical frequencies for the gap's bin, weighted by that outcome's odds. */
/* Scoreline grid ported from model/attack_defence.py: Poisson goals at each
   side's expected rate with the Dixon-Coles low-score correction, 0-8 goals
   each way, renormalised. */
function scoreGrid(model, homeId, awayId) {
  const ad = model.attack_defence;
  const [homeAttack, homeDefence] = ad.teams[homeId] || [0, 0];
  const [awayAttack, awayDefence] = ad.teams[awayId] || [0, 0];
  const lam = Math.exp(ad.base + ad.home + homeAttack - awayDefence);
  const mu = Math.exp(ad.base + awayAttack - homeDefence);
  const fact = [1, 1, 2, 6, 24, 120, 720, 5040, 40320];
  const pois = (k, rate) => Math.exp(-rate) * rate ** k / fact[k];
  const tau = (i, j) => (i === 0 && j === 0 ? 1 - lam * mu * ad.rho
    : i === 0 && j === 1 ? 1 + lam * ad.rho
    : i === 1 && j === 0 ? 1 + mu * ad.rho
    : i === 1 && j === 1 ? 1 - ad.rho : 1);
  const grid = fact.map((_, i) => fact.map((__, j) => pois(i, lam) * pois(j, mu) * Math.max(tau(i, j), 0)));
  const total = grid.reduce((sum, row) => sum + row.reduce((s, v) => s + v, 0), 0);
  return grid.map((row) => row.map((v) => v / total));
}

/* The shipped outcome odds: a geometric blend of the Elo odds and the grid's
   own win/draw/loss sums, weight on Elo from the report. Ported from
   model/attack_defence.py blend_outcomes. */
function blendOdds(model, odds, homeId, awayId) {
  const grid = scoreGrid(model, homeId, awayId);
  const own = { home_win: 0, draw: 0, away_win: 0 };
  grid.forEach((row, i) => row.forEach((p, j) => { own[i > j ? 'home_win' : i === j ? 'draw' : 'away_win'] += p; }));
  const w = model.attack_defence.outcome_blend;
  const raw = ['home_win', 'draw', 'away_win'].map((o) => odds[o] ** w * own[o] ** (1 - w));
  const total = raw[0] + raw[1] + raw[2];
  return { gap: odds.gap, home_win: raw[0] / total, draw: raw[1] / total, away_win: raw[2] / total };
}

/* Most likely scorelines: who wins comes from the blended odds, how many goals
   from the grid -- each outcome's cells are rescaled to that outcome's odds. */
function topScorelines(model, odds, homeId, awayId, n = 5) {
  const grid = scoreGrid(model, homeId, awayId);
  const outcome = (i, j) => (i > j ? 'home_win' : i === j ? 'draw' : 'away_win');
  const own = { home_win: 0, draw: 0, away_win: 0 };
  grid.forEach((row, i) => row.forEach((p, j) => { own[outcome(i, j)] += p; }));
  const cells = [];
  grid.forEach((row, i) => row.forEach((p, j) => {
    const o = outcome(i, j);
    cells.push({ home_goals: i, away_goals: j, probability: own[o] > 0 ? p * (odds[o] / own[o]) : 0 });
  }));
  return cells.sort((a, b) => b.probability - a.probability).slice(0, n);
}

function compareTeamBlock(id, name, rating, crest, side) {
  const block = el('div', 'compare__team');
  const main = el('div', 'compare__card-main');
  if (crest) main.appendChild(crest);
  const text = el('div', 'compare__team-text');
  text.appendChild(el('div', 'compare__team-side', side));
  text.appendChild(el('div', 'compare__team-name', name));
  text.appendChild(el('div', 'compare__team-rating', String(Math.round(rating))));
  main.appendChild(text);
  block.appendChild(main);
  return block;
}

function oddsBar(homeName, awayName, entry) {
  const odds = el('div', 'odds');
  odds.setAttribute('role', 'img');
  odds.setAttribute(
    'aria-label',
    t('aria.odds', { home: homeName, hw: pct(entry.home_win), d: pct(entry.draw), away: awayName, aw: pct(entry.away_win) })
  );
  for (const [outcome, value, who] of [
    ['home', entry.home_win, homeName],
    ['draw', entry.draw, t('next.draw')],
    ['away', entry.away_win, awayName],
  ]) {
    const segment = el('div', 'odds__seg');
    segment.dataset.outcome = outcome;
    segment.style.flex = `${Math.max(value, 0.001)}`;
    segment.textContent = value >= 0.12 ? `${Math.round(value * 100)}%` : '';
    segment.addEventListener('pointerenter', (event) => showTooltip(event, `<b>${who}</b><br>${pct(value, 1)}`));
    segment.addEventListener('pointermove', moveTooltip);
    segment.addEventListener('pointerleave', hideTooltip);
    odds.appendChild(segment);
  }
  return odds;
}

function populateCompare(report) {
  // The picker spans both divisions, so the team list is the same every season
  // regardless of which division the page is showing; key on the season alone.
  const key = String(report.league.season);
  if (state.compareKey === key && $('#compare-a').options.length) return;
  state.compareKey = key;
  const a = $('#compare-a');
  const b = $('#compare-b');
  a.replaceChildren();
  b.replaceChildren();
  for (const team of allTeams()) {
    a.appendChild(el('option', '', team.team)).value = team.team_id;
    b.appendChild(el('option', '', team.team)).value = team.team_id;
  }
  // Sensible defaults: the two highest-rated clubs overall.
  const byRating = [...allTeams()].sort((x, y) => y.rating - x.rating);
  a.value = byRating[0].team_id;
  b.value = byRating[1]?.team_id || byRating[0].team_id;
}

function renderCompare(report) {
  const holder = $('#compare-output');
  holder.replaceChildren();

  const aId = $('#compare-a').value;
  const bId = $('#compare-b').value;
  // A club cannot play itself.
  for (const option of $('#compare-a').options) option.disabled = option.value === bId;
  for (const option of $('#compare-b').options) option.disabled = option.value === aId;
  const homeId = aId;
  const awayId = bId;
  const homeName = teamNameById(homeId);
  const awayName = teamNameById(awayId);

  const homeRating = ratingById(homeId);
  const awayRating = ratingById(awayId);
  const odds = blendOdds(report.model, matchOdds(report.model, homeRating, awayRating), homeId, awayId);
  const entry = { ...odds, scorelines: topScorelines(report.model, odds, homeId, awayId) };

  // Fictional match: the two clubs, who hosts, and the model's odds + scorelines.
  const matchBlock = el('div', 'compare__block');
  matchBlock.appendChild(el('h3', 'compare__subhead', t('compare.match')));

  const teamsRow = el('div', 'compare__teams');
  const homeBlock = compareTeamBlock(homeId, homeName, homeRating, teamLogo(homeId, homeName), t('compare.home'));
  const awayBlock = compareTeamBlock(awayId, awayName, awayRating, teamLogo(awayId, awayName), t('compare.away'));
  const swapBtn = el('button', 'compare__swap-center', '⇄');
  swapBtn.type = 'button';
  swapBtn.setAttribute('aria-label', t('compare.swap'));
  swapBtn.addEventListener('click', () => {
    const a = $('#compare-a');
    const b = $('#compare-b');
    const swap = a.value;
    a.value = b.value;
    b.value = swap;
    renderCompare(report);
  });
  teamsRow.appendChild(homeBlock);
  teamsRow.appendChild(swapBtn);
  teamsRow.appendChild(awayBlock);

  matchBlock.appendChild(teamsRow);
  matchBlock.appendChild(el('p', 'compare__note', t('compare.note', { team: homeName })));

  matchBlock.appendChild(oddsBar(homeName, awayName, entry));
  const linesWrap = el('div', 'compare__scorelines');
  linesWrap.appendChild(el('div', 'compare__scorelines-label', t('compare.scorelines')));
  const lines = el('div', 'compare__scorelines-chips');
  for (const line of entry.scorelines.slice(0, 4)) {
    const chip = el('span', 'compare__scoreline');
    chip.textContent = `${line.home_goals}–${line.away_goals}`;
    chip.appendChild(el('span', 'compare__scoreline-prob', pct(line.probability, 0)));
    chip.setAttribute('aria-label', t('aria.scoreline', { score: `${line.home_goals}-${line.away_goals}`, pct: pct(line.probability, 1) }));
    lines.appendChild(chip);
  }
  linesWrap.appendChild(lines);
  matchBlock.appendChild(linesWrap);
  holder.appendChild(matchBlock);

  // Rating history: both clubs overlaid on one time axis.
  const careerA = careerById(aId);
  const careerB = careerById(bId);
  if (careerA && careerB) {
    const histBlock = el('div', 'compare__block');
    histBlock.appendChild(el('h3', 'compare__subhead', t('compare.ratingHistory')));
    const svg = svgEl('svg', { class: 'chart', role: 'img' });
    svg.setAttribute('aria-label', t('chart.ratingHistoryFor', { home: homeName, away: awayName }));
    drawCompareHistory(svg, careerA, careerB, teamNameById(aId), teamNameById(bId));
    histBlock.appendChild(svg);
    const legend = el('div', 'legend');
    legend.appendChild(el('span', 'compare-legend__a', teamNameById(aId)));
    legend.appendChild(el('span', 'compare-legend__b', teamNameById(bId)));
    histBlock.appendChild(legend);
    holder.appendChild(histBlock);
  }
}

function drawCompareHistory(svg, careerA, careerB, labelA, labelB) {
  const width = 900;
  const height = 320;
  const pad = { top: 14, right: 18, bottom: 34, left: 46 };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren();

  const series = [careerA.points || [], careerB.points || []];
  const all = series.flat();
  if (!all.length) return;
  const times = all.map(pointTime);
  const ratings = all.map((point) => point[1]);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  let rMin = Math.min(...ratings);
  let rMax = Math.max(...ratings);
  const rPad = (rMax - rMin) * 0.08 || 20;
  rMin -= rPad;
  rMax += rPad;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const x = (t) => pad.left + ((t - tMin) / (tMax - tMin || 1)) * plotW;
  const y = (r) => pad.top + (1 - (r - rMin) / (rMax - rMin || 1)) * plotH;

  for (let i = 0; i <= 4; i += 1) {
    const value = rMin + (i / 4) * (rMax - rMin);
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value) }));
    const tick = svgEl('text', { class: 'tick', x: pad.left - 8, y: y(value) + 3.5, 'text-anchor': 'end' });
    tick.textContent = String(Math.round(value));
    svg.appendChild(tick);
  }

  svg.appendChild(svgEl('line', { class: 'axis-line', x1: pad.left, x2: width - pad.right, y1: height - pad.bottom, y2: height - pad.bottom }));
  svg.appendChild(svgEl('line', { class: 'axis-line', x1: pad.left, x2: pad.left, y1: pad.top, y2: height - pad.bottom }));

  // One vertical tick per season present, so the axis reads as years.
  const seen = new Set();
  for (const point of all) {
    const year = point[0].slice(0, 4);
    if (seen.has(year)) continue;
    seen.add(year);
    const px = x(Math.max(tMin, Math.min(tMax, Date.parse(`${year}-01-01T12:00:00Z`))));
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: px, x2: px, y1: pad.top, y2: height - pad.bottom }));
    const label = svgEl('text', { class: 'tick', x: px, y: height - pad.bottom + 15, 'text-anchor': 'middle' });
    label.textContent = year;
    svg.appendChild(label);
  }

  const colors = ['#2a78d6', '#e0682a'];
  series.forEach((points, index) => {
    if (!points.length) return;
    const line = points.map((point) => `${x(pointTime(point))},${y(point[1])}`).join(' ');
    svg.appendChild(svgEl('polyline', { class: `compare-line compare-line--${index === 0 ? 'a' : 'b'}`, points: line, stroke: colors[index] }));
    const last = points[points.length - 1];
    svg.appendChild(svgEl('circle', { cx: x(pointTime(last)), cy: y(last[1]), r: 3, fill: colors[index] }));
  });

  const xTitle = svgEl('text', { class: 'axis-title', x: pad.left + plotW / 2, y: height - 4, 'text-anchor': 'middle' });
  xTitle.textContent = t('compare.season');
  svg.appendChild(xTitle);
  const yTitle = svgEl('text', { class: 'axis-title', x: -(pad.top + plotH / 2), y: 12, transform: 'rotate(-90)', 'text-anchor': 'middle' });
  yTitle.textContent = t('compare.rating');
  svg.appendChild(yTitle);

  // Crosshair + tooltip reading out both clubs' rating at the hovered date.
  const line = svgEl('line', { class: 'crosshair', y1: pad.top, y2: height - pad.bottom, x1: -10, x2: -10 });
  line.style.opacity = '0';
  svg.appendChild(line);
  // Parsed once per series: this runs on every pointermove.
  const seriesTimes = series.map((points) => points.map(pointTime));
  const nearest = (index, localX) => {
    const times = seriesTimes[index];
    let best = 0;
    for (let i = 1; i < times.length; i += 1) {
      if (Math.abs(x(times[i]) - localX) < Math.abs(x(times[best]) - localX)) best = i;
    }
    return best;
  };
  const surface = svgEl('rect', { x: pad.left, y: pad.top, width: plotW, height: plotH, fill: 'transparent' });
  surface.addEventListener('pointermove', (event) => {
    const box = svg.getBoundingClientRect();
    const localX = (event.clientX - box.left) * (width / box.width);
    const ia = nearest(0, localX);
    const ib = nearest(1, localX);
    const pa = series[0][ia];
    const pb = series[1][ib];
    const px = (x(seriesTimes[0][ia]) + x(seriesTimes[1][ib])) / 2;
    line.setAttribute('x1', px);
    line.setAttribute('x2', px);
    line.style.opacity = '1';
    const when = new Date(pointTime(pa)).toLocaleDateString(localeDate(), { month: 'short', year: 'numeric' });
    showTooltip(event, `<b>${labelA}</b> ${Math.round(pa[1])} · <b>${labelB}</b> ${Math.round(pb[1])}<br>${when}`);
  });
  surface.addEventListener('pointerleave', () => {
    line.style.opacity = '0';
    hideTooltip();
  });
  svg.appendChild(surface);
}

async function boot() {
  resolveTheme();
  document.documentElement.lang = currentLang;
  for (const button of document.querySelectorAll('[data-lang]')) {
    button.setAttribute('aria-pressed', String(button.dataset.lang === currentLang));
  }
  applyTranslations();
  wire();
  try {
    const [reports, careers] = await Promise.all([
      fetch(reportUrl(null)).then((r) => {
        if (!r.ok) throw new Error(`server returned ${r.status}`);
        return r.json();
      }),
      fetch('/data/careers.json').then((r) => (r.ok ? r.json() : null)),
    ]);
    state.reports = applyShortNames(reports);
    state.careers = applyShortNamesToCareers(careers);
    state.season = reports[state.league].league.season;
    $('#status').hidden = true;
    $('#content').hidden = false;
    applyLeagueParameter();
    applySortParameter();
    applyViewParameter();
    applyTeamParameter();
    render();

    const params = new URLSearchParams(window.location.search);
    const wantedSeason = Number(params.get('season'));
    if (wantedSeason && wantedSeason !== state.season) await loadSeason(wantedSeason);

    const wantedAsof = params.get('asof');
    if (wantedAsof) await rewindTo(wantedAsof);
    // The browser resolved any #fragment while the content was still hidden,
    // so re-run it now that the sections exist.
    if (window.location.hash) {
      document.querySelector(window.location.hash)?.scrollIntoView();
    }
  } catch (error) {
    $('#status').textContent =
      t('status.couldNotLoadSeason', { error: error.message });
  }
}

boot();
