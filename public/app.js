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
  // Table view mode: 'current' shows live stats, 'prediction' shows model stats.
  tableView: (typeof localStorage !== 'undefined' && localStorage.getItem('elitetracker-table-view')) || 'current',
  // Last sort used in each table view, restored when switching back to it.
  sortByView: {},
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
  // Next Up is paged by ISO week too; 0 is the nearest week.
  fixturesWeek: 0,
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
  for (const meetings of Object.values(careers?.head_to_head || {})) {
    for (const match of meetings) {
      match.home = shortName(match.home);
      match.away = shortName(match.away);
    }
  }
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
  img.alt = name;
  img.loading = 'lazy';
  img.title = name;
  return img;
};

/* The em-dash threshold follows the precision: anything that would print as a
   bare 0% is shown as nothing instead, and the same at the top end. */
const smallestShown = (digits) => 0.5 / 10 ** digits / 100;

/* Numbers in the reader's convention. Norwegian writes a decimal comma, a
   space between thousands (not at four digits, so ratings stay "1794") and
   a space before the percent sign: "70,3 %", "50 000". */
function localeNumber() { return currentLang === 'no' ? 'nb-NO' : 'en-GB'; }

const num = (value, digits = 0) => value.toLocaleString(localeNumber(), {
  minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: 'min2',
});

/* Signed on the shown value, so ±0.04 at one digit reads "0.0", not "+0.0". */
const signed = (value, digits = 0) => {
  const shown = Math.round(value * 10 ** digits) / 10 ** digits || 0;
  return (shown > 0 ? '+' : '') + num(shown, digits);
};

const percentSign = () => (currentLang === 'no' ? String.fromCharCode(160) + '%' : '%'); // no-break space

const pct = (value, digits = 1) => {
  const smallest = smallestShown(digits);
  if (value >= 1 - smallest) return `100${percentSign()}`;
  if (value < smallest) return '—';
  return `${num(value * 100, digits)}${percentSign()}`;
};

const pctShort = (value) =>
  value < 0.005 ? '' : `${Math.round(value * 100)}`;

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

// Where the pointer is, so an animation frame can re-check what is under it
// without waiting for the next pointer event. Tracked on the whole document:
// updated only over cells, it went stale when the pointer left the grid, and
// every frame then found a cell at the old spot and kept the readout up.
const lastPointer = { x: -1, y: -1 };
document.addEventListener('pointermove', (event) => {
  lastPointer.x = event.clientX;
  lastPointer.y = event.clientY;
}, { passive: true });

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
  tooltipTrigger?.removeAttribute('aria-describedby');
  tooltipTrigger = null;
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

/* The widest band covering `position`, or null for the mid-table stretch.
   Complement to bandFor: where bandFor names the tightest block (the title sits
   inside the CL slot), zoneFor names the whole region, so the table can draw
   one divider where a zone starts instead of one per nested band. */
function zoneFor(bands, position) {
  const matches = bands.filter((band) => position >= band.first && position <= band.last);
  if (!matches.length) return null;
  return matches.reduce((best, band) =>
    band.last - band.first > best.last - best.first ? band : best
  );
}

/* The position whose median points set a band's threshold: the cut a club must
   reach. A band worth reaching (title, qualification, promotion play-off) is
   entered at its last place; a band worth avoiding (relegation) at its first.
   Mirrors outcomeClass: good bands are reached from below, bad ones left
   above. */
function thresholdPosition(band, count) {
  const good = band.first < (count + 1) / 2;
  return good ? band.last : band.first;
}

/* A band's full name in the reader's language; the report carries English. */
function bandName(band) {
  const key = `band.${band.label}`;
  return t(key) === key ? band.label : t(key);
}

/* Short category label for the table's zone badges. tone alone cannot tell a
   good play-off from a bad one (OBOS promotion vs Elite relegation), so the
   top/bottom half decides like outcomeClass does, and whether the top band is
   the title race or promotion. */
function shortBandLabel(band, report) {
  const count = report.table.length;
  const good = band.first < (count + 1) / 2;
  let key = `table.zone.${good ? 'good' : 'bad'}.${band.tone}`;
  if (band.tone === 'top' && report.league.slug === 'obosligaen') key = 'table.zone.good.promotion';
  return t(key) === key ? bandName(band) : t(key);
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
  table.setAttribute('role', 'grid'); // cells below are role=gridcell, so the table must be their grid
  const rows = [...tableData].sort(
    (a, b) => expectedFinish(a) - expectedFinish(b) || a.position - b.position,
  );
  const count = rows.length;
  const bands = report.league.bands;

  // A rebuild removes the cell under the pointer without a pointerleave, which
  // left the readout stuck on screen after the animation.
  hideTooltip();
  table.replaceChildren(table.querySelector('caption'));

  const head = el('thead');
  // The band strip lives inside the table so it inherits the column geometry
  // exactly; positioning it separately drifts as soon as the table is centred.
  const bandRow = el('tr', 'grid__bands');
  bandRow.setAttribute('aria-hidden', 'true'); // colour strip only, the th row below carries the numbers
  bandRow.appendChild(el('td', '', ''));
  const headRow = el('tr');
  // The corner names the small number before each club: where it stands now.
  const corner = el('th', 'grid__corner');
  corner.scope = 'col';
  const now = el('abbr', 'pos', t('grid.nowPos'));
  now.title = t('grid.nowPos.desc');
  corner.appendChild(now);
  headRow.appendChild(corner);
  for (let position = 1; position <= count; position += 1) {
    const band = bandFor(bands, position);
    const cell = el('td');
    const bar = el('span', 'band-strip__seg');
    if (band) {
      bar.style.background = bandColor(band, count);
      bar.title = bandName(band);
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
    const rowIndex = rows.indexOf(row);
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
      cell.setAttribute('aria-label', t('aria.gridCell', { team: row.team, position: ordinal(position), pct: pct(probability, 2) }));
      const band = bandFor(bands, position);
      // Mid-animation the readout follows the last frame, not the build.
      cell.tip = () => {
        const live = anim.gridTableData?.find((r) => r.team_id === row.team_id);
        const prob = live ? live.position_probabilities[index] : probability;
        return `<b>${row.team}</b> ${ordinal(position)}<br>${pct(prob, 2)}` + (band ? `<br>${bandName(band)}` : '');
      };
      // Roving tabindex: one stop for the whole grid, arrows move within it.
      cell.setAttribute('tabindex', rowIndex === 0 && index === 0 ? '0' : '-1');
      cell.setAttribute('role', 'gridcell');
      cell.addEventListener('pointerenter', (event) => showTooltip(event, cell.tip(), cell));
      cell.addEventListener('pointermove', moveTooltip);
      cell.addEventListener('pointerleave', hideTooltip);
      cell.addEventListener('focus', () => {
        table.querySelectorAll('[role="gridcell"]').forEach((c) => { c.tabIndex = -1; });
        cell.tabIndex = 0;
        const rect = cell.getBoundingClientRect();
        showTooltip({ clientX: rect.left + rect.width / 2, clientY: rect.top }, cell.tip(), cell);
      });
      cell.addEventListener('blur', hideTooltip);
      cell.addEventListener('keydown', (event) => handleGridKeydown(event, cell, rows, index, rowIndex));
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

/* Keyboard navigation for the finish grid: arrow keys move between cells. */
function handleGridKeydown(event, cell, rows, cellIndex, rowIndex) {
  const count = rows.length;
  const maxCol = count - 1;
  const maxRow = count - 1;
  let targetCell = null;

  switch (event.key) {
    case 'ArrowRight':
      if (cellIndex < maxCol) {
        event.preventDefault();
        targetCell = cell.parentElement.querySelectorAll('[role="gridcell"]')[cellIndex + 1];
      }
      break;
    case 'ArrowLeft':
      if (cellIndex > 0) {
        event.preventDefault();
        targetCell = cell.parentElement.querySelectorAll('[role="gridcell"]')[cellIndex - 1];
      }
      break;
    case 'ArrowDown':
      if (rowIndex < maxRow) {
        event.preventDefault();
        const nextRow = cell.parentElement.nextElementSibling;
        if (nextRow) {
          targetCell = nextRow.querySelectorAll('[role="gridcell"]')[cellIndex];
        }
      }
      break;
    case 'ArrowUp':
      if (rowIndex > 0) {
        event.preventDefault();
        const prevRow = cell.parentElement.previousElementSibling;
        if (prevRow) {
          targetCell = prevRow.querySelectorAll('[role="gridcell"]')[cellIndex];
        }
      }
      break;
    case 'Home':
      event.preventDefault();
      targetCell = cell.parentElement.querySelector('[role="gridcell"]');
      break;
    case 'End':
      event.preventDefault();
      targetCell = cell.parentElement.querySelectorAll('[role="gridcell"]')[maxCol];
      break;
    case 'Escape':
      hideTooltip();
      cell.blur();
      break;
  }

  if (targetCell) {
    targetCell.focus();
    showTooltip({ clientX: targetCell.getBoundingClientRect().left, clientY: targetCell.getBoundingClientRect().top }, targetCell.tip(), targetCell);
  }
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
    days.map((d) => fetch(reportUrl(state.season, d.date)).then((r) => (r.ok ? r.json().then(applyShortNames) : null))),
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
  // Rows move under a still pointer and fire no pointer events, so the
  // readout is refreshed for whichever cell is there now, or hidden.
  if (tooltip.dataset.show === 'true') {
    const under = document.elementFromPoint(lastPointer.x, lastPointer.y);
    if (under?.tip) tooltip.innerHTML = under.tip();
    else hideTooltip();
  }
}

const anim = state.anim;

/* One interpolated frame between the current matchday and the next. */
function animFrame(frac) {
  animUpdateProgress(frac);
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
    range.setAttribute('aria-valuetext', longDate(day.date));
    $('#timeline-when').textContent = t('timeline.animating', { when: longDate(day.date) });
    $(`#${animView()}-anim-when`).textContent = formatDate(day.date);
  }
}

/* Which view's controls the animation drives. */
function animView() {
  return state.activeView === 'ladder' ? 'ladder' : 'grid';
}

/* The progress bar follows the interpolated frame, not just whole matchdays,
   so it moves as smoothly as the cells do. */
function animUpdateProgress(frac) {
  const days = matchdays(state.reports[state.league]).length;
  const done = days > 1 ? (anim.matchdayIndex + frac) / (days - 1) : 1;
  $(`#${animView()}-anim-fill`).style.transform = `scaleX(${Math.min(1, done).toFixed(4)})`;
}

/* Play and Stop are one button: the icon, the label and aria-pressed follow
   the state. The label keeps a data-i18n key, so a language switch mid-play
   still reads Stop. */
function animSetPlayButtons(playing) {
  for (const view of ['grid', 'ladder']) {
    const button = $(`#${view}-anim-play`);
    const on = playing && view === animView();
    button.setAttribute('aria-pressed', String(on));
    button.querySelector('.grid-anim-btn__icon').textContent = on ? '■' : '▶';
    const label = button.querySelector('.grid-anim-btn__label');
    label.dataset.i18n = on ? 'anim.stop' : 'anim.play';
    label.textContent = t(label.dataset.i18n);
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
  holder.dataset.loadingText = t('anim.loading');
  holder.classList.add('grid-loading');
  // One prefetch at a time: a second click while loading would start another.
  const playButton = $(`#${animView()}-anim-play`);
  playButton.disabled = true;

  anim.matchdayIndex = 0;
  animUpdateSpeedButton(); // the speed picked last time carries over

  const started = `${state.season} ${state.league} ${state.activeView}`;
  anim.reports = await prefetchAnimReports();
  holder.classList.remove('grid-loading');
  playButton.disabled = false;

  // The prefetch takes a while; a season, division or view picked meanwhile
  // wins, rather than an animation of the old one playing over it.
  if (`${state.season} ${state.league} ${state.activeView}` !== started) return;
  if (!anim.reports || anim.reports.size < 2 || !anim.reports.get(0)) return;

  if (ladder) initLadderAnimDOM(anim.reports);
  else initGridAnimDOM(report, anim.reports.get(0)[state.league].table);
  animUpdateTimeline(report, days);

  anim.playing = true;
  anim.lastTick = performance.now();
  animSetPlayButtons(true);
  animUpdateProgress(0);
  $(`#${animView()}-anim-controls`).hidden = false;
  anim.raf = requestAnimationFrame(animTick);
}

function animStop() {
  anim.playing = false;
  if (anim.raf) { cancelAnimationFrame(anim.raf); anim.raf = null; }
  if (anim.gridTable) anim.gridTable.classList.remove('grid-anim');
  anim.gridRows = anim.gridCells = anim.gridTable = anim.gridTableData = null;
  anim.ladder = null;
  animSetPlayButtons(false);
  for (const view of ['grid', 'ladder']) $(`#${view}-anim-controls`).hidden = true;
  setTimeout(() => render(), 0);
}

function animSetSpeed(speed) {
  anim.speed = speed;
  animUpdateSpeedButton();
}

function animUpdateSpeedButton() {
  for (const btn of document.querySelectorAll('.grid-anim-speed [data-speed]')) {
    btn.setAttribute('aria-pressed', String(Number(btn.dataset.speed) === anim.speed));
  }
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
  return currentLang === 'no' ? `${n}. plass` : `${ordinalShort(n)} place`;
}

/* "3rd" / "3.": for tiles where the label already says it is a position. */
function ordinalShort(n) {
  if (currentLang === 'no') return `${n}.`;
  const suffix = ['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th';
  return `${n}${suffix}`;
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

  legend.appendChild(el('span', '', t(coarsePointer.matches ? 'grid.legend.hintTouch' : 'grid.legend.hint')));
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

  const attackVals = report.table.map((r) => r.attack);
  const defenceVals = report.table.map((r) => r.defence);
  const attackAvg = attackVals.reduce((s, v) => s + v, 0) / (attackVals.length || 1);
  const defenceAvg = defenceVals.reduce((s, v) => s + v, 0) / (defenceVals.length || 1);

  const attackPcts = report.table.map((r) => (r.attack / attackAvg - 1) * 100);
  const defencePcts = report.table.map((r) => (1 - r.defence / defenceAvg) * 100);
  const attackPctMin = Math.min(...attackPcts);
  const attackPctMax = Math.max(...attackPcts);
  const defencePctMin = Math.min(...defencePcts);
  const defencePctMax = Math.max(...defencePcts);

  return report.table.map((row) => {
    const attack_pct = (row.attack / attackAvg - 1) * 100;
    const defence_pct = (1 - row.defence / defenceAvg) * 100;
    // Normalised position in diverging ramp: -1 = league worst, 0 = avg, 1 = league best
    const attack_k = attack_pct <= 0 && attackPctMin < 0 ? attack_pct / Math.abs(attackPctMin)
      : attack_pct >= 0 && attackPctMax > 0 ? attack_pct / attackPctMax : 0;
    const defence_k = defence_pct <= 0 && defencePctMin < 0 ? defence_pct / Math.abs(defencePctMin)
      : defence_pct >= 0 && defencePctMax > 0 ? defence_pct / defencePctMax : 0;
    return {
      ...row,
      up: promotion ? sum(row.position_probabilities.slice(0, 2)) : row.position_probabilities[0],
      down: relegation
        ? sum(row.position_probabilities.slice(relegation.first - 1, relegation.last))
        : 0,
      attack_pct,
      defence_pct,
      attack_k,
      defence_k,
    };
  });
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

/* Each view opens on its natural order: the table as it stands, or the
   projection by expected points. A sort picked within a view is kept for it. */
const DEFAULT_SORT = {
  current: { key: 'position', dir: 1 },
  prediction: { key: 'expected_points', dir: -1 },
};

function toggleTableView(view) {
  state.sortByView[state.tableView] = state.sort;
  state.tableView = view;
  state.activeView = 'table';
  state.sort = state.sortByView[view] || DEFAULT_SORT[view];
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('elitetracker-table-view', view);
  }
  if (state.reports) renderStandings(state.reports[state.league]);
  else applyTableView();
}

/* Visibility only: renderStandings calls this after building the rows. */
function applyTableView() {
  const view = state.tableView;
  // Lets the phone layout drop columns per view (see the CSS).
  $('#standings').dataset.view = view;
  // Update toggle button states.
  for (const button of document.querySelectorAll('.table-control-btn')) {
    button.setAttribute('aria-pressed', button.dataset.tableMode === view ? 'true' : 'false');
    button.classList.toggle('is-active', button.dataset.tableMode === view);
  }
  // Update column visibility based on table view mode.
  // Show fixture difficulty column only in prediction mode.
  for (const header of document.querySelectorAll('#standings th[data-table-view]')) {
    const views = header.dataset.tableView.split(' ');
    header.hidden = !views.includes(view);
  }
  for (const cell of document.querySelectorAll('#standings td[data-table-view]')) {
    const views = cell.dataset.tableView.split(' ');
    cell.hidden = !views.includes(view);
  }
  // Update section visibility to ensure table is shown.
  for (const section of document.querySelectorAll('[data-section]')) {
    const views = section.dataset.section.split(' ');
    section.hidden = !views.includes(state.activeView);
  }
  renderSortHeaders();
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

   const formByTeamName = formByTeam(report.results);
  const rows = standingsRows(report).map((row) => ({
    ...row,
    form: formPoints(formByTeamName[row.team]),
    expected_goal_difference: row.expected_goals_for - row.expected_goals_against,
  }));

// Fixture difficulty is read against the league's own mean run-in: with
   // draws, even an average side's run-in is worth well under 1.5 points a
   // match. Clubs with no fixtures left (0) are left out.
   const runIns = rows.map((row) => row.fixture_difficulty).filter((value) => value > 0);
   const neutralRunIn = runIns.reduce((sum, value) => sum + value, 0) / (runIns.length || 1);
   // Max absolute gap from mean across the league (for normalising fixture difficulty ramp)
   const maxFixtureGap = runIns.length
     ? Math.max(...runIns.map((v) => Math.abs(v - neutralRunIn)))
     : 0;

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

  const positionPoints = report.model.position_points || [];

  // Threshold dividers only for position and xPTS sorts.
  // They attach to visual position (1st, 6th, etc.) in the sorted output,
  // not to the team's live table position.
  const showDividers = state.sort.key === 'position' || state.sort.key === 'expected_points';

  // Pre-calculate divider boundaries: after each band's threshold position.
  // User wants thresholds one team further down:
  // Good bands: divider after (thresholdPos + 1)
  // Bad bands: divider after thresholdPos (since threshold was at band.first - 1, now band.first)
  const dividerBoundaries = new Map(); // visual position (1-based) -> {zone, cut, label}
  if (showDividers) {
    for (const band of bands) {
      const thresholdPos = thresholdPosition(band, count);
      const cut = positionPoints[thresholdPos - 1];
      if (cut !== undefined) {
        const good = band.first < (count + 1) / 2;
        const afterPos = good ? thresholdPos + 1 : thresholdPos;
        if (afterPos >= 1 && afterPos < count) {
          dividerBoundaries.set(afterPos, { band, cut, label: shortBandLabel(band, report) });
        }
      }
    }
  }

// Build a divider row for a boundary
function dividerRow(boundary) {
      const tr = el('tr', 'zone-divider');
      tr.style.setProperty('--band-color', bandColor(boundary.band, count));
      const td = el('td');
      td.colSpan = 21;  // full table width (21 columns)
     // Format: "======== Expected CL Threshold: 67p ========"
     const label = el('span', 'zone-divider__wrap',
       t('table.threshold', { band: boundary.label, points: boundary.cut }));
     td.appendChild(label);
     tr.appendChild(td);
     return tr;
   }

  const sorted = sortedStandings(rows);
  for (let visualIndex = 0; visualIndex < sorted.length; visualIndex++) {
    const row = sorted[visualIndex];
    const zone = zoneFor(bands, row.position);
    const tr = el('tr');
    const band = bandFor(bands, row.position);

    const position = el('td', 'pos');
    position.dataset.tableView = 'current prediction';
    const mark = el('span', 'band-mark');
    if (band) {
      mark.style.background = bandColor(band, count);
      mark.title = bandName(band);
    }
    position.appendChild(mark);
    position.appendChild(document.createTextNode(String(row.position)));
    tr.appendChild(position);

    // The club name is the control. Marking the whole <tr> role="button" made
    // every cell presentational, which hid the scores from screen readers and
    // stopped the new aria-sort from ever being announced.
    const club = el('td', 'club');
    club.dataset.tableView = 'current prediction';
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
    // 'extra' marks the columns a phone drops -- see .col--extra in the CSS.
    for (const [key, extra] of [
      ['played', false], ['wins', true], ['draws', true],
      ['losses', true], ['goals_for', true], ['goals_against', true],
    ]) {
      const td = el('td', `num muted${extra ? ' col--extra' : ''}`, String(row[key]));
      td.dataset.tableView = 'current';
      tr.appendChild(td);
    }
    const gdTd = el('td', 'num', row.goal_difference > 0 ? `+${row.goal_difference}` : String(row.goal_difference));
    gdTd.dataset.tableView = 'current';
    tr.appendChild(gdTd);
    const points = el('td', 'num', String(row.points));
    points.style.fontWeight = '700';
    points.dataset.tableView = 'current';
    tr.appendChild(points);

    // Form sits beside the points it explains; the rating opens the model
    // columns, marked by its separator.
    const formTd = el('td', 'num form col--extra');
    formTd.dataset.tableView = 'current';
    formTd.appendChild(formChipsEl(formByTeamName[row.team]));
    tr.appendChild(formTd);
    const ratingCell = el('td', 'num sep');
    ratingCell.dataset.tableView = 'current prediction';
    ratingCell.appendChild(document.createTextNode(num(row.rating)));
    const trend = trends.get(row.team);
    if (trend) {
      const isTop = topRiser && topRiser.team === row.team && topRiser.diff > 0;
      const arrow = el('span', `rating-trend rating-trend--${trend.direction}${isTop ? ' rating-trend--top' : ''}`);
      arrow.innerHTML = trend.svg;
      arrow.setAttribute('role', 'img');
      arrow.setAttribute('aria-label', trend.detail);
      arrow.title = trend.detail;
      ratingCell.appendChild(arrow);
    }
    tr.appendChild(ratingCell);
    // Attack and Defence — model-derived stats like Elo, Current view only
    // Percent vs division average; defence inverted so higher = better on both
    const attackPct = row.attack_pct;
    const defencePct = row.defence_pct;

    const attackCell = el('td', 'num col--extra');
    attackCell.dataset.tableView = 'current';
    attackCell.appendChild(makePctPill(attackPct, row.attack_k));
    tr.appendChild(attackCell);

    const defenceCell = el('td', 'num col--extra');
    defenceCell.dataset.tableView = 'current';
    defenceCell.appendChild(makePctPill(defencePct, row.defence_k));
    tr.appendChild(defenceCell);
    const xpTd = el('td', 'num muted', num(row.expected_points, 1));
    xpTd.dataset.tableView = 'prediction';
    tr.appendChild(xpTd);

    // Season totals, averaged over the simulations: goals so far plus the
    // simulated rest. Whole goals: a tenth of a goal over a season is noise.
    // Reports built before these totals existed show a dash, not a crash.
    const known = row.expected_goals_for != null;
    for (const [text, muted] of [
      [known ? num(row.expected_goals_for) : '—', true],
      [known ? num(row.expected_goals_against) : '—', true],
      [known ? signed(row.expected_goal_difference) : '—', false],
    ]) {
      const td = el('td', `num${muted ? ' muted' : ''} col--extra`, text);
      td.dataset.tableView = 'prediction';
      tr.appendChild(td);
    }

    // Fixture difficulty: expected points per remaining match for an average
    // side. Red below the league mean (a harder run-in), gray at mean, green above.
    const fixtureCell = el('td', 'num', '');
    fixtureCell.dataset.tableView = 'prediction';
    if (row.fixture_difficulty > 0) {
      const value = row.fixture_difficulty;
      const gap = value - neutralRunIn;
      const pill = el('span', 'fixture-difficulty-pill', num(value, 2));
      // Normalised k: -1 = hardest in league, 0 = mean, 1 = easiest in league
      const k = maxFixtureGap > 0 ? gap / maxFixtureGap : 0;
      makeFixturePill(pill, k);
      fixtureCell.appendChild(pill);
    } else {
      // A finished season (or a club done early) has no run-in to rate.
      fixtureCell.textContent = '—';
      fixtureCell.classList.add('muted');
      fixtureCell.title = t('table.noFixturesLeft');
    }
    tr.appendChild(fixtureCell);


    const upCell = meterCell(row.up, 'up');
    upCell.dataset.tableView = 'prediction';
    tr.appendChild(upCell);
    const downCell = meterCell(row.down, 'down');
    downCell.dataset.tableView = 'prediction';
    tr.appendChild(downCell);

    // Clicking anywhere on the row is a mouse convenience on top of that
    // button; it adds no keyboard or ARIA semantics of its own.
    tr.addEventListener('click', () => openTeamView(row.team_id, row.team));

    // Insert divider row AFTER this row if there's a boundary here (visual position)
    if (dividerBoundaries.has(visualIndex + 1)) {
      body.appendChild(dividerRow(dividerBoundaries.get(visualIndex + 1)));
    }

body.appendChild(tr);
   }

   // Apply the current view mode to the rendered cells.
   applyTableView();
}

/* Pill for attack/defence % — diverging red–gray–blue ramp.
   k in [-1, 1]: -1 = league worst (red), 0 = avg (gray), 1 = league best (blue).
   Hue fixed per side (0° red, 218° blue), S interpolated with sqrt curve for more mid-range chroma,
   L/alpha linear. Flat background, alpha 0.1..0.45. Text hue-derived per fixture-pill pattern. */
function makePctPill(pct, k) {
  const pill = el('span', 'attack-defence-pill', `${signed(pct)}${percentSign()}`);
  // Clamp k
  const kk = Math.max(-1, Math.min(1, k));
  // Red side (k < 0): hue 0, S 0→85% (sqrt), L 55→45%
  // Blue side (k > 0): hue 218, S 0→92% (sqrt), L 55→42%
  // Gray at k=0: S=0%, L=55%
  if (kk < 0) {
    const t = -kk; // 0..1
    const s = Math.round(85 * Math.sqrt(t));   // 0% → 85% (sqrt curve for mid-range chroma)
    const l = Math.round(55 - 10 * t);         // 55% → 45%
    pill.style.setProperty('--ad-hue', '0');
    pill.style.setProperty('--ad-sat', `${s}%`);
    pill.style.setProperty('--ad-light', `${l}%`);
  } else {
    const t = kk; // 0..1
    const s = Math.round(92 * Math.sqrt(t));   // 0% → 92% (sqrt curve for mid-range chroma)
    const l = Math.round(55 - 13 * t);         // 55% → 42%
    pill.style.setProperty('--ad-hue', '218');
    pill.style.setProperty('--ad-sat', `${s}%`);
    pill.style.setProperty('--ad-light', `${l}%`);
  }
  // Alpha: 0.1 at k=0, 0.45 at |k|=1
  const alpha = 0.1 + 0.35 * Math.abs(kk);
  pill.style.setProperty('--ad-alpha', alpha.toFixed(3));
  return pill;
}

/* Pill for fixture difficulty — diverging red–gray–green ramp.
   k in [-1, 1]: -1 = hardest (red), 0 = mean (gray), 1 = easiest (green).
   Hue fixed per side (0° red, 135° green), S/L monotone for CVD safety.
   Red end: darker (L=35%), Green end: lighter (L=49%), Gray middle: L=45%.
   This ensures luminance separates the ends for protan/deutan viewers. */
function makeFixturePill(pill, k) {
  const kk = Math.max(-1, Math.min(1, k));
  if (kk < 0) {
    const t = -kk; // 0..1
    // Red side: S 0→70%, L 45→35% (darker at extreme)
    const s = Math.round(70 * t);
    const l = Math.round(45 - 10 * t);
    pill.style.setProperty('--fd-hue', '0');
    pill.style.setProperty('--fd-sat', `${s}%`);
    pill.style.setProperty('--fd-light', `${l}%`);
  } else {
    const t = kk; // 0..1
    // Green side: S 0→70%, L 45→49% (lighter at extreme, CVD-safe with monotone L)
    const s = Math.round(70 * t);
    const l = Math.round(45 + 4 * t);
    pill.style.setProperty('--fd-hue', '135');
    pill.style.setProperty('--fd-sat', `${s}%`);
    pill.style.setProperty('--fd-light', `${l}%`);
  }
  // Alpha: 0.1 at k=0, 0.45 at |k|=1
  const alpha = 0.1 + 0.35 * Math.abs(kk);
  pill.style.setProperty('--fd-alpha', alpha.toFixed(3));
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
   them directly. A wide track is a strip: crests at their rating, percent
   across it, stacking into rows where they collide. A narrow track (a phone)
   is a ranked list instead -- one row per club at its rank, with the rating
   as a dot on a shared scale -- because crests alone cannot be told apart at
   that size. Ranks and placement are written onto the team objects; the ticks
   (every 50 points on the strip, 100 in the list) and track size come back.
   `maxStack` reserves extra stacking depth so an animated strip keeps one size. */
const LADDER_ROW = 2.75;    // rem per club in the list (44px at 16px base = 44px touch target)
const LADDER_HEAD = 1.75;   // rem above the first row, for the scale labels

function layoutLadder(teams, track, maxStack = 0) {
  const ratings = teams.map((t) => t.rating);
  const low = Math.min(...ratings);
  const high = Math.max(...ratings);
  const trackWidth = track.clientWidth || 1000;
  const list = trackWidth < 500;
  teams.sort((a, b) => a.rating - b.rating || a.team.localeCompare(b.team));
  teams.forEach((t, i) => { t._rank = teams.length - i; });
  const fraction = (rating) => (high === low ? 0.5 : (rating - low) / (high - low));
  // In the list the scale has a 0.5rem margin at each end, so the extreme dots
  // are not cut in half by the panel edge.
  const along = (f) => `calc(0.5rem + ${f.toFixed(4)} * (100% - 1rem))`;

  // The list's scale is a third of a phone's width: lines every 100 points,
  // labelled every 200, where the strip has room for every 50.
  const step = list ? 100 : 50;
  const ticks = [];
  for (let r = Math.ceil(low / step) * step; r <= high; r += step) {
    const label = !list || r % 200 === 0 ? String(r) : '';
    ticks.push({ label, left: list ? along(fraction(r)) : `${2 + fraction(r) * 96}%` });
  }

  if (list) {
    for (const team of teams) {
      team._tip = `#${team._rank}  ${team.team}  ${Math.round(team.rating)}`;
      team._top = `${LADDER_HEAD + (team._rank - 1) * LADDER_ROW}rem`;
      team._left = '0';
      team._x = along(fraction(team.rating));
    }
    return { list, ticks, depth: 1, height: `${LADDER_HEAD + teams.length * LADDER_ROW}rem`, width: '' };
  }

  const crestPx = parseFloat(getComputedStyle(document.documentElement).fontSize) * 1.5;
  const overlap = Math.min(50, ((crestPx + 2) / trackWidth) * 100);
  const pos = (rating) => 2 + fraction(rating) * 96;

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
    team._top = `${0.5 + team._stack * rowHeight}rem`;
    team._left = `${pos(team.rating)}%`;
  }
  return { list, ticks, depth, height: `${4 + (depth - 1) * rowHeight}rem`, width: '' };
}

function ladderAxis(track, layout) {
  track.querySelector('.ladder__axis')?.remove();
  track.classList.toggle('ladder__track--list', layout.list);
  const axis = el('div', 'ladder__axis');
  for (const tick of layout.ticks) {
    const node = el('div', 'ladder__tick');
    node.style.left = tick.left;
    node.appendChild(el('span', '', tick.label));
    axis.appendChild(node);
  }
  track.appendChild(axis);
  track.style.height = layout.height;
  track.style.width = layout.width;
}

/* One club. On the strip only the crest shows; the list row adds rank, name,
   rating and the dot, which the CSS hides on the strip. A button either way:
   it opens the club, as a row does in the table. */
function ladderTeamEl(team) {
  const wrap = el('button', 'ladder__team');
  wrap.type = 'button';
  wrap.dataset.tier = String(team.tier);
  wrap.dataset.teamId = team.teamId;
  wrap.dataset.team = team.team;
  wrap.appendChild(el('span', 'ladder__rank'));
  const img = el('img');
  img.src = `logos/${team.teamId}.png`;
  img.alt = team.team;
  wrap.appendChild(img);
  wrap.appendChild(el('span', 'ladder__name', team.team));
  wrap.appendChild(el('span', 'ladder__rating'));
  const scale = el('span', 'ladder__scale');
  scale.appendChild(el('span', 'ladder__dot'));
  wrap.appendChild(scale);
  return wrap;
}

function placeLadderTeam(wrap, team) {
  wrap.style.top = team._top;
  wrap.style.left = team._left;
  if (team._x) wrap.style.setProperty('--x', team._x);
  wrap.dataset.tip = team._tip;
  wrap.setAttribute('aria-label', team._tip);
  wrap.querySelector('.ladder__rank').textContent = String(team._rank);
  wrap.querySelector('.ladder__rating').textContent = String(Math.round(team.rating));
}

/* Bound once: the track outlives every render, and a listener added per
   render stacked up until each tap toggled the tip an even number of times.
   A list row opens the club; on the strip a tap shows the crest's tip on
   touch screens, where there is no hover, and a click opens the club. */
function bindLadderClicks(track) {
  if (track.dataset.bound) return;
  track.dataset.bound = 'true';
  track.addEventListener('click', (event) => {
    const wrap = event.target.closest('.ladder__team');
    if (!wrap) return;
    event.stopPropagation();
    const tapToPeek = coarsePointer.matches && !track.classList.contains('ladder__track--list');
    if (tapToPeek && !wrap.hasAttribute('data-tip-visible')) {
      track.querySelectorAll('.ladder__team[data-tip-visible]').forEach((other) => other.removeAttribute('data-tip-visible'));
      wrap.setAttribute('data-tip-visible', '');
      return;
    }
    openTeamView(wrap.dataset.teamId, wrap.dataset.team);
  });
  track.addEventListener('keydown', (event) => handleLadderKeydown(event, track));
  document.addEventListener('click', () => {
    track.querySelectorAll('.ladder__team[data-tip-visible]').forEach((w) => w.removeAttribute('data-tip-visible'));
  }, { passive: true });
}

/* Keyboard navigation for the ladder: arrow keys move between teams. */
function handleLadderKeydown(event, track) {
  const items = [...track.querySelectorAll('.ladder__team')].filter((item) => item.offsetParent);
  if (!items.length) return;
  const activeIndex = items.findIndex((item) => item === document.activeElement);
  if (activeIndex === -1) return;

  let targetIndex = -1;
  switch (event.key) {
    case 'ArrowDown':
      if (track.classList.contains('ladder__track--list')) {
        event.preventDefault();
        targetIndex = Math.min(activeIndex + 1, items.length - 1);
      }
      break;
    case 'ArrowUp':
      if (track.classList.contains('ladder__track--list')) {
        event.preventDefault();
        targetIndex = Math.max(activeIndex - 1, 0);
      }
      break;
    case 'ArrowRight':
      if (!track.classList.contains('ladder__track--list')) {
        event.preventDefault();
        // On strip mode, move to next team by rating
        targetIndex = Math.min(activeIndex + 1, items.length - 1);
      }
      break;
    case 'ArrowLeft':
      if (!track.classList.contains('ladder__track--list')) {
        event.preventDefault();
        targetIndex = Math.max(activeIndex - 1, 0);
      }
      break;
    case 'Home':
      event.preventDefault();
      targetIndex = 0;
      break;
    case 'End':
      event.preventDefault();
      targetIndex = items.length - 1;
      break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      items[activeIndex].click();
      break;
    case 'Escape':
      hideTooltip();
      items[activeIndex].blur();
      break;
  }

  if (targetIndex >= 0 && targetIndex !== activeIndex) {
    items[targetIndex].focus();
    const target = items[targetIndex];
    if (target.dataset.tip) {
      showTooltip({
        clientX: target.getBoundingClientRect().left,
        clientY: target.getBoundingClientRect().top
      }, target.dataset.tip, target);
    }
  }
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

  bindLadderClicks(track);

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
  homeSide.appendChild(el('span', 'played-card__rating-value', num(fixture.home_rating)));
  homeSide.appendChild(sideBlock(fixture.home, fixture.home_id, false));
  matchup.appendChild(homeSide);

  const oddsCol = el('div', 'fixture__odds-col');
  oddsCol.appendChild(oddsBar(fixture.home, fixture.away, fixture));
  matchup.appendChild(oddsCol);

  const awaySide = el('div', 'played-card__side played-card__side--away');
  awaySide.appendChild(sideBlock(fixture.away, fixture.away_id, true));
  awaySide.appendChild(el('span', 'played-card__rating-value', num(fixture.away_rating)));
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
  card.appendChild(el('div', 'played-card__date', formatDate(match.date) + (match.round ? ` \u00b7 ${t('played.round', { n: match.round })}` : '')));

  const ratingBlock = (id) => {
    const info = ratingChanges.get(`${id}|${match.date}`);
    const node = el('div', 'played-card__rating');
    if (!info) return node;
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
  const score = el('div', 'played-card__score', `${match.home_goals}\u2013${match.away_goals}`);
  // xG under the score: the rating moves on both, so a "lucky" win shows why
  // it earned less than the scoreline suggests.
  if (match.xg) {
    const xg = el('span', 'played-card__xg', `xG ${num(match.xg[0], 1)}\u2013${num(match.xg[1], 1)}`);
    xg.title = t('played.xgHint');
    score.appendChild(xg);
  }
  matchup.appendChild(score);
  matchup.appendChild(awaySide);
  card.appendChild(matchup);
  return card;
}

function renderFixtures(report) {
  const holder = $('#fixtures');
  holder.replaceChildren();

  // Paged by ISO week like Played Results, nearest week first.
  const { weeks, byWeek } = groupByWeek([...report.fixtures].sort((a, b) => a.date.localeCompare(b.date)));
  if (!weeks.length) {
    $('#fixture-count').textContent = '';
    return;
  }
  state.fixturesWeek = Math.max(0, Math.min(state.fixturesWeek, weeks.length - 1));
  const week = weeks[state.fixturesWeek];
  const fixtures = byWeek.get(week);
  $('#fixture-count').textContent = t('next.count', { n: fixtures.length, total: report.fixtures.length });

  const go = (index) => () => { state.fixturesWeek = index; renderFixtures(report); };
  holder.appendChild(pageNav(
    t('played.week', { n: week }),
    state.fixturesWeek > 0 ? go(state.fixturesWeek - 1) : null,
    state.fixturesWeek < weeks.length - 1 ? go(state.fixturesWeek + 1) : null,
  ));
  for (const fixture of fixtures) holder.appendChild(buildFixtureCard(fixture));
}

/* Matches bucketed by ISO week, weeks in the order the list first meets them. */
function groupByWeek(matches) {
  const weeks = [];
  const byWeek = new Map();
  for (const match of matches) {
    const week = isoWeek(match.date);
    if (!byWeek.has(week)) {
      byWeek.set(week, []);
      weeks.push(week);
    }
    byWeek.get(week).push(match);
  }
  return { weeks, byWeek };
}

/* The one pagination control on the site, modelled on Played Results: Prev,
   what is on show, Next. Prev always goes back in time and Next forward; a
   missing handler disables that side. */
function pageNav(label, onPrev, onNext) {
  const nav = el('div', 'played-nav');
  const prev = el('button', 'played-nav__btn', t('played.prev'));
  const next = el('button', 'played-nav__btn', t('played.next'));
  for (const [button, handler] of [[prev, onPrev], [next, onNext]]) {
    button.type = 'button';
    button.disabled = !handler;
    if (handler) button.addEventListener('click', handler);
  }
  nav.appendChild(prev);
  nav.appendChild(el('span', 'played-nav__label', label));
  nav.appendChild(next);
  return nav;
}

/* ---------- played results ------------------------------------------ */

/* Build a map of rating changes per team per match date from careers data.
   career.points is an array of [date, rating] after each match.
   Returns a Map keyed "teamId|date" -> { change, rating } where rating is
   the rating after the match and change is the delta from the previous match.
   Built once per careers payload: the table asks for it on every row. */
const ratingChangesCache = new WeakMap();

function buildRatingChanges(careers) {
  const changes = new Map();
  if (!careers?.teams) return changes;
  if (ratingChangesCache.has(careers)) return ratingChangesCache.get(careers);
  ratingChangesCache.set(careers, changes);

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

  // Most recent week first, so Prev (back in time) is the next index up.
  const { weeks, byWeek } = groupByWeek(sorted);
  state.playedWeek = Math.min(state.playedWeek || 0, weeks.length - 1);
  const currentWeek = weeks[state.playedWeek];
  const weekMatches = byWeek.get(currentWeek);

  const go = (index) => () => { state.playedWeek = index; renderPlayedResults(report); };
  holder.appendChild(pageNav(
    t('played.week', { n: currentWeek }),
    state.playedWeek < weeks.length - 1 ? go(state.playedWeek + 1) : null,
    state.playedWeek > 0 ? go(state.playedWeek - 1) : null,
  ));

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
  for (const letter of last5) {
    const chip = el('span', `form__chip form__chip--${letter.toLowerCase()}`, letter);
    holder.appendChild(chip);
  }
  // Whole-form tooltip from i18n (e.g. "2W 1D 2L" / "2S 1U 2T")
  const w = last5.filter((r) => r === 'W').length;
  const d = last5.filter((r) => r === 'D').length;
  const l = last5.filter((r) => r === 'L').length;
  holder.title = t('form.tooltip', { w, d, l });
  return holder;
}

/* ---------- hero & model card ------------------------------------- */

function renderHero(report) {
  const model = report.model;
  const leader = report.table[0];
  const favourite = report.table.reduce((best, row) =>
    row.position_probabilities[0] > best.position_probabilities[0] ? row : best
  );

  // Build interactive title: clickable division name + clickable season year.
  const title = $('#hero-title');
  title.replaceChildren();
  // Each half of the heading is a button that opens a picker. The visible
  // text stays the accessible name -- an aria-label here would replace it, and
  // the page heading would read "Change division Change season" -- and a
  // hidden hint says what pressing it does.
  const titlePart = (text, role, menuId, hintKey) => {
    const part = el('span', 'hero-title-part', text);
    part.dataset.role = role;
    part.setAttribute('tabindex', '0');
    part.setAttribute('role', 'button');
    part.setAttribute('aria-expanded', 'false');
    part.setAttribute('aria-controls', menuId);
    part.appendChild(el('span', 'visually-hidden', `, ${t(hintKey)}`));
    return part;
  };
  const divSpan = titlePart(report.league.name, 'division', 'hero-league-menu', 'hero.changeDivision');
  const space = document.createTextNode(' ');
  const seasonSpan = titlePart(String(report.league.season), 'season', 'hero-season-menu', 'hero.changeSeason');
  title.appendChild(divSpan);
  title.appendChild(space);
  title.appendChild(seasonSpan);

  // The pickers live on freshly built title parts, so their listeners are
  // bound here, not once at boot: a rebuilt heading would be silent.
  const leagueMenu = $('#hero-league-menu');
  divSpan.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = !leagueMenu.hidden;
    closeAllMenus();
    if (open) return;
    for (const btn of leagueMenu.querySelectorAll('[data-league]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.league === state.league));
    }
    leagueMenu.hidden = false;
    divSpan.setAttribute('aria-expanded', 'true');
    const rect = divSpan.getBoundingClientRect();
    leagueMenu.style.position = 'fixed';
    leagueMenu.style.top = `${rect.bottom + 6}px`;
    leagueMenu.style.left = `${rect.left}px`;
    leagueMenu.style.width = `${rect.width}px`;
    menuFocusCleanup = trapFocus(leagueMenu);
  });
  divSpan.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); divSpan.click(); }
  });

  const seasonMenu = $('#hero-season-menu');
  seasonSpan.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = !seasonMenu.hidden;
    closeAllMenus();
    if (open) return;
    const seasons = report.league.seasons || [report.league.season];
    seasonMenu.replaceChildren();
    for (const s of [...seasons].reverse()) {
      const btn = el('button', 'popover-menu__btn', String(s));
      btn.type = 'button';
      btn.dataset.role = 'season-option';
      btn.setAttribute('aria-pressed', String(s === report.league.season));
      if (s === report.league.season) btn.setAttribute('aria-current', 'true');
      btn.addEventListener('click', () => {
        closeAllMenus();
        if (s !== state.season) loadSeason(s);
      });
      seasonMenu.appendChild(btn);
    }
    seasonMenu.hidden = false;
    seasonSpan.setAttribute('aria-expanded', 'true');
    const rect = seasonSpan.getBoundingClientRect();
    seasonMenu.style.position = 'fixed';
    seasonMenu.style.top = `${rect.bottom + 6}px`;
    seasonMenu.style.left = `${rect.left}px`;
    seasonMenu.style.width = `${rect.width}px`;
    menuFocusCleanup = trapFocus(seasonMenu);
  });
  seasonSpan.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); seasonSpan.click(); }
  });

  // Mark current league in division menu
  for (const btn of leagueMenu.querySelectorAll('[data-league]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.league === state.league));
  }

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
        simulations: num(model.simulations),
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
    [t('hero.simulated'), num(model.simulations), true],
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
  const rows = [
    [t('model.version'), model.version],
    [t('model.kfactor'), model.k_factor],
    [t('model.homeAdvantage'), `${model.home_advantage} ${t('model.pts')}`],
  ];
  if (model.home_advantage_beta) {
    rows.push([t('model.homeAdvantageBeta'), model.home_advantage_beta]);
  }
  rows.push(
    [t('model.xgAlpha'), pct(model.xg_alpha, 0)],
    [t('model.crossRegression'), `${pct(1 - model.season_regression, 0)} ${t('model.towardMean')}`],
  );
  if (model.attack_defence.blend_gamma) {
    rows.push([t('model.blendGamma'), model.attack_defence.blend_gamma]);
  }
  rows.push(
    [t('model.peakDraw'), pct(model.draw_base, 0)],
    [t('model.outcomeOdds'), t('model.outcomeOddsValue')],
    [t('model.scorelines'), t('model.scorelinesValue')],
    [t('model.simulations'), num(model.simulations)],
  );
  if (model.strength_sd) {
    rows.push([t('model.strengthSd'), `±${model.strength_sd}`]);
  }
  rows.push([t('model.seed'), model.seed]);
  for (const [name, value] of rows) {
    const cell = el('div');
    cell.appendChild(el('dt', '', name));
    cell.appendChild(el('dd', '', String(value)));
    grid.appendChild(cell);
  }
}


/* ---------- team: one club's focus view ----------------------------- */

/* Show the division the club plays in this season. Clubs move between the
   two, so this runs on opening a club and again whenever a season loads. */
function followTeamLeague(teamId) {
  const currentReport = state.reports?.[state.league];
  if (!currentReport || currentReport.table.some((t) => String(t.team_id) === String(teamId))) return;
  for (const [league, report] of Object.entries(state.reports)) {
    if (report.table.some((t) => String(t.team_id) === String(teamId))) {
      state.league = league;
      for (const button of document.querySelectorAll('[data-league]')) {
        button.setAttribute('aria-pressed', String(button.dataset.league === league));
      }
      return;
    }
  }
}

function openTeamView(teamId, fallbackName, { push = true } = {}) {
  if (anim.playing) animStop();
  followTeamLeague(teamId);
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
  
  if (!content) { console.error('[TeamView] team-content not found in DOM'); return; }
  content.replaceChildren();
  if (!teamId) { console.warn('[TeamView] no teamId'); return; }
  

  const back = el('button', 'team-back');
  back.type = 'button';
  back.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
  back.appendChild(el('span', '', t('team.back')));
  back.addEventListener('click', () => history.back());
  content.appendChild(back);

  const row = report.table.find((t) => String(t.team_id) === String(teamId));
  
  const career = careerById(teamId);
  
  const teamName = row?.team || career?.team || fallbackNameById(teamId) || 'Unknown';

  // Helper to safely render a section
  const safeRender = (fn, context = 'section') => {
    try { fn(); }
    catch (e) { console.error(`[TeamView] ${context} failed:`, e); }
  };

  // 1. Summary card
  safeRender(() => renderTeamSummary(teamId, row, career, report, content), 'summary');

  // 2. Finish grid row
  safeRender(() => renderTeamGridRow(teamId, row, report, content), 'gridRow');

  // 2b. Pre-season vs live prediction
  safeRender(() => renderPreSeasonComparison(teamId, row, report, content), 'preSeason');

  // 3. Rating history chart
  if (career && career.points?.length >= 2) {
    safeRender(() => {
      
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
        peakItem.appendChild(el('span', '', `${num(career.peak[1])} (${career.peak[0].slice(0, 4)})`));
        stats.appendChild(peakItem);
      }
      if (career.trough) {
        const troughItem = el('span', 'team-chart-stat');
        troughItem.appendChild(el('span', 'label', t('team.worst')));
        troughItem.appendChild(el('span', '', `${num(career.trough[1])} (${career.trough[0].slice(0, 4)})`));
        stats.appendChild(troughItem);
      }
      chartSection.appendChild(stats);
      content.appendChild(chartSection);
      drawTeamChart(career);
      
    }, 'ratingHistory');
  } else {
    
  }

  // 4. Season shape + season-by-season (combined)
  if (career && Array.isArray(career.seasons) && career.seasons.length) {
    safeRender(() => {
      
      renderSeasonBySeason(career, teamId, content, report);
      
    }, 'seasonShape');
  } else {
    
  }

  // 5. Upcoming fixtures for this team
  safeRender(() => {
    
    renderTeamFixtures(teamId, teamName, report, content);
    
  }, 'fixtures');

  // 6. Recent results for this team
  safeRender(() => {
    
    renderTeamResults(teamId, teamName, report, content);
    
  }, 'results');
}

function renderSeasonBySeason(career, teamId, container, currentReport) {
  if (!career || !Array.isArray(career.seasons) || !career.seasons.length) return;
  const seasonsDesc = [...career.seasons].reverse();
  const PAGE = 8;
  const totalPages = Math.ceil(seasonsDesc.length / PAGE);

  // The stored season comes from whichever club was open last; a club that
  // never played it would show "no shape data". Anything this career does not
  // hold falls back to the season on show now.
  const stored = state.activeSeasonShape;
  const storedOk = !!stored && career.seasons.some(
    (s) => String(s.season) === String(stored.season) && s.league === stored.league
  );
  if (stored && !storedOk) state.activeSeasonShape = null;
  const initialSeason = storedOk ? stored.season : currentReport.league.season;
  const initialLeague = storedOk ? stored.league : currentReport.league.slug;

  // Open on the page holding the season on show; paging later never re-checks.
  const activeIdx = seasonsDesc.findIndex(
    (s) => String(s.season) === String(initialSeason) && s.league === initialLeague
  );
  state.teamSeasonsPage = activeIdx >= 0
    ? Math.floor(activeIdx / PAGE)
    : Math.min(state.teamSeasonsPage ?? 0, totalPages - 1);

  // Compute max absolute rating change for scaling bars
  const maxAbsChange = Math.max(...career.seasons.map(s => Math.abs(s.rating_change)), 1);

  const section = el('div', 'team-section team-seasons');
  const header = el('div', 'team-section__header');
  header.appendChild(el('div', 'label', t('team.seasonBySeason', { n: career.seasons.length })));
  section.appendChild(header);

  // The colours are explained once, under the heading, so the words stay put
  // while seasons swap underneath them.
  section.appendChild(el('p', 'team-section__hint', t('team.shapeHint')));

  const shapeContainer = el('div', 'team-shape-container');
  shapeContainer.id = 'team-shape-container';
  shapeContainer.setAttribute('aria-live', 'polite');
  section.appendChild(shapeContainer);

  // Attached before the chart draws: drawTeamShape sizes itself to the
  // container, which is zero while the section is still a fragment.
  container.appendChild(section);

  renderSeasonShapeInContainer(initialSeason, initialLeague, teamId, shapeContainer, currentReport);

  // The list is the picker: its rows swap the chart above. Paging re-renders
  // the list alone, so a page turn no longer tears down and rebuilds the chart.
  const list = el('div', 'seasons-list-compact');
  section.appendChild(list);
  const pagerBox = el('div', 'seasons-pager');
  if (totalPages > 1) section.appendChild(pagerBox);

  const paint = () => {
    const page = Math.min(state.teamSeasonsPage ?? 0, totalPages - 1);
    state.teamSeasonsPage = page;
    const active = state.activeSeasonShape || { season: initialSeason, league: initialLeague };
    list.replaceChildren(...seasonsDesc.slice(page * PAGE, (page + 1) * PAGE).map(
      (record) => createCompactSeasonRow(
        record, teamId, container, currentReport,
        active.season, active.league, maxAbsChange, shapeContainer
      )
    ));
    if (totalPages > 1) {
      pagerBox.replaceChildren(
        paginator(page, totalPages, (p) => { state.teamSeasonsPage = p; paint(); }, true)
      );
    }
  };
  paint();
}

function createCompactSeasonRow(record, teamId, container, currentReport, activeSeason, activeLeague, maxAbsChange, shapeContainer) {
  const isActive = String(record.season) === String(activeSeason) && record.league === activeLeague;

  const row = el('button', `season-row-compact${isActive ? ' is-active' : ''}`);
  row.type = 'button';
  row.dataset.season = record.season;
  row.dataset.league = record.league;
  row.setAttribute('aria-label', t('team.showShape', { year: record.season }));
  row.setAttribute('aria-pressed', String(isActive));

  // Season year + league badge
  const seasonCell = el('div', 'season-row-compact__season');
  const year = el('span', 'season-row-compact__year', String(record.season));
  seasonCell.appendChild(year);

  const badge = el('span', `league-badge league-badge--${record.league === 'eliteserien' ? 'tier1' : 'tier2'} season-row-compact__badge season-row-compact__badge--${record.league === 'eliteserien' ? 'tier1' : 'tier2'}`);
  badge.textContent = record.league === 'eliteserien' ? 'ELITE' : 'OBOS';
  badge.title = record.league_name;
  seasonCell.appendChild(badge);

  row.appendChild(seasonCell);

  // Position only (league shown via badge)
  const mainCell = el('div', 'season-row-compact__main');
  mainCell.appendChild(el('div', 'season-row-compact__pos', `#${record.position}`));
  row.appendChild(mainCell);

  // Rating: start -> end with change indicator
  const ratingCell = el('div', 'season-row-compact__rating');
  ratingCell.appendChild(el('div', 'season-row-compact__rating-start', num(record.rating_start)));

  const change = record.rating_change;
  const changeWrap = el('div', `season-row-compact__change ${change >= 0 ? 'up' : 'down'}`);
  const changeVal = el('span', `season-row-compact__change-val ${change >= 0 ? 'up' : 'down'}`, signed(change));
  const changeBar = el('div', 'season-row-compact__change-bar');
  const barFill = el('div', `season-row-compact__change-fill season-row-compact__change-fill--${change >= 0 ? 'up' : 'down'}`);
  // Scale bar based on team's max absolute rating change across all seasons
  const barWidth = Math.min(Math.abs(change) / maxAbsChange * 100, 100);
  barFill.style.width = `${barWidth}%`;
  changeBar.appendChild(barFill);
  changeWrap.appendChild(changeVal);
  changeWrap.appendChild(changeBar);
  ratingCell.appendChild(changeWrap);

  ratingCell.appendChild(el('div', 'season-row-compact__rating-end', num(record.rating_end)));
  row.appendChild(ratingCell);

  // Click handler. The native button already fires on Enter and Space.
  row.addEventListener('click', () => {
    loadSeasonShape(record.season, record.league, teamId, shapeContainer, currentReport);
    // The chart sits above the list; a pick made from deep inside the list
    // would otherwise change a chart nobody can see.
    const box = shapeContainer.getBoundingClientRect();
    if (box.bottom < 0 || box.top > window.innerHeight) {
      shapeContainer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });

  return row;
}

/* Season reports are fetched once and kept: flipping back and forth through
   the picker should neither refetch nor flash a spinner. */
const seasonReportCache = new Map();

function loadSeasonReports(season) {
  if (season === state.season && state.reports) return Promise.resolve(state.reports);
  const hit = seasonReportCache.get(season);
  if (hit) return Promise.resolve(hit);
  const pending = fetch(reportUrl(season))
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then(applyShortNames)
    .then((reports) => { seasonReportCache.set(season, reports); return reports; })
    .catch((err) => { seasonReportCache.delete(season); throw err; });
  seasonReportCache.set(season, pending);
  return pending;
}

/* A slow fetch for one season must not land after the reader has already
   picked another. Only the newest request writes. */
let shapeRequest = 0;

function renderSeasonShapeInContainer(season, league, teamId, container, currentReport) {
  const request = ++shapeRequest;
  container.classList.add('team-shape--loading');
  container.replaceChildren(el('div', '', t('team.loadingShape', { year: season })));

  const show = (report) => {
    if (request !== shapeRequest || !container.isConnected) return;
    const team = report?.history?.teams?.find((t) => String(t.team_id) === String(teamId));
    container.classList.remove('team-shape--loading');
    if (!team) { container.replaceChildren(el('div', '', t('team.noShape'))); return; }
    const chart = svgEl('svg', { class: 'chart', role: 'img' });
    chart.setAttribute('aria-label', t('team.seasonShapeYear', { year: season }));
    drawTeamShape(report, team, chart, container.clientWidth);
    container.replaceChildren(
      el('div', 'label', t('team.seasonShapeYear', { year: season })),
      chart
    );
    // The rows highlight what is on show, so both branches record it.
    state.activeSeasonShape = { season, league };
    updateActiveSeasonRow(season, league);
  };

  // The season the page already carries needs no fetch; anything else does.
  if (season === currentReport.league.season && league === currentReport.league.slug) {
    show(currentReport);
    return;
  }
  loadSeasonReports(season)
    .then((reports) => show(reports[league]))
    .catch((err) => {
      if (request !== shapeRequest || !container.isConnected) return;
      container.classList.remove('team-shape--loading');
      container.replaceChildren(el('div', '', t('team.loadError', { error: err.message })));
    });
}

function updateActiveSeasonRow(season, league) {
  const section = document.querySelector('.team-seasons');
  if (!section) return;
  for (const row of section.querySelectorAll('.season-row-compact')) {
    const isActive = row.dataset.season === String(season) && row.dataset.league === league;
    row.classList.toggle('is-active', isActive);
    row.setAttribute('aria-pressed', String(isActive));
  }
}

async function loadSeasonShape(season, league, teamId, container, currentReport) {
  // Find the shape container within the team-seasons section
  const section = container.closest('.team-seasons') || container.querySelector('.team-seasons');
  const shapeContainer = section?.querySelector('#team-shape-container') || container.querySelector('#team-shape-container');
  if (!shapeContainer) return;
  await renderSeasonShapeInContainer(season, league, teamId, shapeContainer, currentReport);
}

function fallbackNameById(teamId) {
  return allTeams().find((t) => String(t.team_id) === String(teamId))?.team;
}

/* Numbered pages in the shared control. `reversed` lists run newest first,
   so going back in time (Prev) is the next page up. */
function paginator(page, totalPages, go, reversed = false) {
  const earlier = reversed ? page + 1 : page - 1;
  const later = reversed ? page - 1 : page + 1;
  const valid = (p) => p >= 0 && p < totalPages;
  return pageNav(
    t('page.of', { n: page + 1, total: totalPages }),
    valid(earlier) ? () => go(earlier) : null,
    valid(later) ? () => go(later) : null,
  );
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
    trendEl.setAttribute('role', 'img');
    trendEl.setAttribute('aria-label', trend.detail);
    // The site's own tooltip rather than a title: it shows at once, takes
    // the extra lines, and a tap brings it up on a phone.
    trendEl.addEventListener('pointerenter', (event) => showTooltip(event, trend.tip));
    trendEl.addEventListener('pointermove', moveTooltip);
    trendEl.addEventListener('pointerleave', hideTooltip);
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
  const crossRank = allTeams.findIndex((t) => String(t.team_id) === String(teamId));
  const totalTeams = allTeams.length || report.table.length;
  ratingBlock.appendChild(el('span', 'team-summary__rating-pos', t('team.rankOf', { rank: ordinal(crossRank >= 0 ? crossRank + 1 : (row?.position ?? 0)), total: totalTeams })));
  header.appendChild(ratingBlock);

  card.appendChild(header);

  // Two strips of tiles, big value over a small label: where the club stands,
  // then how it plays. Four short numbers fit one row even on a phone, which
  // the old run of label-value pairs never did.
  if (row) {
    const table = el('dl', 'team-stats');
    table.appendChild(summaryStat(t('team.position'), ordinalShort(row.position)));
    table.appendChild(summaryStat(t('team.points'), String(row.points)));
    table.appendChild(summaryStat(t('team.gd'), signed(row.goal_difference)));
    table.appendChild(summaryStat(t('team.played'), String(row.played)));
    card.appendChild(table);

    const xg = el('dl', 'team-stats team-stats--xg');
    xg.appendChild(xgStat(t('team.attack'), t('team.attackHint'), row.attack, report.table.map((r) => r.attack), true));
    xg.appendChild(xgStat(t('team.defence'), t('team.defenceHint'), row.defence, report.table.map((r) => r.defence), false));
    card.appendChild(xg);
  } else if (career) {
    const table = el('dl', 'team-stats');
    table.appendChild(summaryStat(t('team.matches'), String(career.points.length)));
    card.appendChild(table);
  }

  container.appendChild(card);
}

/* The arrow beside a rating: which way recent performances are pushing it.

   Built on xG form -- per match, K * (xG-implied score - expected score), the
   rating change the chances alone would have produced (`xg_form` in the
   results, from pipeline.xg_form). Measured on every club-season with xG, a
   recent average of it tracks the next few matches (r ~0.17), where an average
   of actual rating changes, which are mostly result luck, does not (~0.05).

   Weights 0.1..0.6 over the last 6 matches: the latest three carry 71 %, so
   the information is on average under two weeks old.

   Seasons or clubs without xG fall back to the actual rating changes, on
   their own cut-offs (that signal is about 1.5x as spread). */
const TREND_WEIGHTS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
const TREND_KINDS = {
  //       cut-offs: steady inside ±mild, strong beyond ±strong; label keys; digits
  xg: { mild: 1, strong: 4, prefix: 'form', digits: 1 },
  rating: { mild: 1.5, strong: 6, prefix: 'trend', digits: 0 },
};

function computeRatingTrend(teamName, report) {
  if (!teamName) return null;
  const results = [...(report.results || [])].sort((a, b) => a.date.localeCompare(b.date));
  const ratingChanges = buildRatingChanges(state.careers);
  const xgForm = [];
  const changes = [];
  for (const r of results) {
    if (r.home_goals == null) continue;
    const isHome = r.home === teamName;
    if (!isHome && r.away !== teamName) continue;
    if (r.xg_form) xgForm.push(r.xg_form[isHome ? 0 : 1]);
    const info = ratingChanges.get(`${isHome ? r.home_id : r.away_id}|${r.date}`);
    if (info) changes.push(info.change);
  }
  const kind = xgForm.length >= 6 ? 'xg' : 'rating';
  const values = (kind === 'xg' ? xgForm : changes).slice(-6);
  if (values.length < 6) return null;
  const { mild, strong, prefix, digits } = TREND_KINDS[kind];

  const diff = values.reduce((sum, v, i) => sum + v * TREND_WEIGHTS[i], 0)
    / TREND_WEIGHTS.reduce((a, b) => a + b, 0);

  // 5 degrees: strong rise, rise, steady, fall, strong fall
  const key = diff > strong ? 'strongRise' : diff > mild ? 'rise' : diff >= -mild ? 'steady' : diff >= -strong ? 'fall' : 'strongFall';
  const direction = key.replace('strongR', 'strong-r').replace('strongF', 'strong-f');
  const label = t(`${prefix}.${key}`);
  const perMatch = signed(diff, digits);
  // One line for the table's arrow and for screen readers; the team view
  // shows `tip`, which adds the matches behind the number.
  const detail = t(`${prefix}.detail`, { label, n: perMatch });
  const tip = `<b>${label}</b><br>${t(`${prefix}.tipPerMatch`, { n: perMatch })}`
    + `<br><span class="tooltip__muted">${t('trend.tipMatches', { list: values.map((v) => signed(v, digits)).join(' ') })}</span>`;
  return { direction, svg: trendArrowSVG(direction), detail, tip, diff };
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

/* One tile: the label comes first for screen readers (dt before dd) and the
   CSS lifts the value above it. */
function summaryStat(label, value, title) {
  const item = el('div', 'team-stats__tile');
  if (title) item.title = title;
  item.appendChild(el('dt', 'team-stats__label', label));
  item.appendChild(el('dd', 'team-stats__value', value));
  return item;
}

/* An xG rate as a percentage above or below the division average, the one
   number that says what the rate means. Defence is turned round (conceding
   fewer is the good direction) so + is better on both tiles. The bar
   diverges from a centre line at the average, scaled to the division's
   widest gap; the raw rate stays underneath. */
function xgStat(label, hint, value, division, higherIsBetter) {
  const average = division.reduce((sum, v) => sum + v, 0) / (division.length || 1);
  const relative = (v) => (higherIsBetter ? v / average - 1 : 1 - v / average);
  const share = relative(value);
  const widest = Math.max(...division.map((v) => Math.abs(relative(v))), Math.abs(share)) || 1;
  const item = summaryStat(label, `${signed(share * 100)}${percentSign()}`, hint);
  const half = (Math.abs(share) / widest) * 50;
  const bar = el('dd', `team-stats__bar team-stats__bar--${share >= 0 ? 'good' : 'bad'}`);
  bar.setAttribute('aria-hidden', 'true');
  bar.style.setProperty('--from', `${share >= 0 ? 50 : 50 - half}%`);
  bar.style.setProperty('--width', `${half}%`);
  item.appendChild(bar);
  item.appendChild(el('dd', 'team-stats__note', t('team.xgRaw', { value: num(value, 2), avg: num(average, 2) })));
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
      showTooltip(event, `<b>${row.team}</b> ${ordinal(position)}<br>${pct(prob, 2)}` + (band ? `<br>${bandName(band)}` : ''))
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
  const historyTeam = report.history?.teams?.find((t) => String(t.team_id) === String(teamId));
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

  // SVG accessibility: title and desc
  const title = svgEl('title');
  title.textContent = t('chart.rating', { n: career.team });
  chart.appendChild(title);
  const desc = svgEl('desc');
  desc.textContent = t('chart.ratingMoved', { team: career.team, from: points[0][1], to: career.current_rating, seasons: career.seasons.length });
  chart.appendChild(desc);

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
  const descEl = $('#team-chart-desc');
  if (descEl) descEl.textContent =
    t('chart.ratingMoved', { team: career.team, from: points[0][1], to: career.current_rating, seasons: career.seasons.length });
}

function renderTeamFixtures(teamId, teamName, report, container) {
  const allFixtures = (report.fixtures || []).filter(
    (f) => String(f.home_id) === String(teamId) || String(f.away_id) === String(teamId)
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
  section.appendChild(header);
  if (totalPages > 1) {
    section.appendChild(paginator(page, totalPages, (p) => { state.teamFixturesPage = p; renderTeamView(report); }));
  }

  for (const fixture of fixtures) {
    section.appendChild(buildFixtureCard(fixture));
  }
  container.appendChild(section);
}

function renderTeamResults(teamId, teamName, report, container) {
  const allResults = (report.results || []).filter(
    (r) => String(r.home_id) === String(teamId) || String(r.away_id) === String(teamId)
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
  section.appendChild(header);
  if (totalPages > 1) {
    section.appendChild(paginator(page, totalPages, (p) => { state.teamResultsPage = p; renderTeamView(report); }, true));
  }

  for (const match of matches) section.appendChild(playedCard(match, ratingChanges));
  container.appendChild(section);
}

/* Below this container width the chart gets a viewBox of its own width: a
   phone reads the 900-wide desktop box at ~0.4 scale, which shrinks the 10px
   ticks to 4px. `lastShape` is what a window resize redraws when the chart
   crosses that width. */
const SHAPE_NARROW = 640;
let lastShape = null;

function drawTeamShape(report, team, chart, boxWidth) {
  const history = report.history;
  const count = report.table.length;
  const snapshots = history.dates.length;

  const box = boxWidth || 900;
  const narrow = box < SHAPE_NARROW;
  const width = narrow ? Math.round(box) : 900;
  const height = narrow ? 300 : 280;
  // The desktop gutter (40/12 of 900) is a sixth of a phone's 340px box. The
  // narrow box trims it so the bands start where the rating chart's line does
  // above it; the "100%" tick hangs left into the section's own padding.
  const pad = narrow
    ? { top: 10, right: 6, bottom: 30, left: 20 }
    : { top: 10, right: 12, bottom: 30, left: 40 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  lastShape = { report, team, chart, narrow };

  chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
  chart.replaceChildren();

  // SVG accessibility: title and desc
  const title = svgEl('title');
  title.textContent = t('team.seasonShapeYear', { year: history.dates[0].slice(0, 4) });
  chart.appendChild(title);
  const desc = svgEl('desc');
  desc.textContent = t('shape.stackedArea', { team: team.team });
  chart.appendChild(desc);

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
    label.textContent = `${100 - gridline * 100 / 4}${percentSign()}`;
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
    band.setAttribute('role', 'img');
    band.setAttribute('aria-label', `${ordinal(position)}${bandLabel ? `, ${bandName(bandLabel)}` : ''}`);
    band.addEventListener('pointerenter', (event) => {
      const latest = team.positions[snapshots - 1][position - 1];
      showTooltip(
        event,
        `<b>${ordinal(position)}</b>${bandLabel ? ` · ${bandName(bandLabel)}` : ''}<br>` +
          t('shape.now', { pct: pct(latest, 1) })
      );
    });
    band.addEventListener('pointermove', moveTooltip);
    band.addEventListener('pointerleave', hideTooltip);
    band.addEventListener('focus', () => {
      const latest = team.positions[snapshots - 1][position - 1];
      const rect = band.getBoundingClientRect();
      showTooltip({ clientX: rect.left + rect.width / 2, clientY: rect.top }, `<b>${ordinal(position)}</b>${bandLabel ? ` · ${bandName(bandLabel)}` : ''}<br>` + t('shape.now', { pct: pct(latest, 1) }), band);
    });
    band.addEventListener('blur', hideTooltip);
    band.setAttribute('tabindex', '0');
    chart.appendChild(band);
  }

  chart.appendChild(
    svgEl('line', { class: 'axis-line', x1: pad.left, x2: width - pad.right, y1: y(1), y2: y(1) })
  );

  // The two edges the season hangs on: European qualification above,
  // relegation below -- the threshold is the *lowest* place that still goes to
  // Europe. Eliteserien's European allocation moves year to year and 2025
  // splits Europa (3rd) from Conference (4th), so the lowest europe band wins
  // (pipeline, _ELITESERIEN_EUROPE). OBOS has no European place and keeps its
  // direct-promotion threshold. Each is a curve -- the band boundary moves as
  // the probabilities move -- and takes the colour of its outcome. An edge
  // that never leaves a frame for the whole season says nothing the areas do
  // not -- it is dropped rather than drawn glued to the border.
  const edges = [];
  const europeBands = report.league.bands.filter((b) => b.tone === 'europe');
  const qualBand = europeBands.length
    ? europeBands.reduce((lowest, b) => (b.last > lowest.last ? b : lowest))
    : report.league.bands.find((b) => b.tone === 'top');
  const relegBand = report.league.bands.find((b) => b.tone === 'relegation');
  for (const [band, key] of [[qualBand, 'good'], [relegBand, 'bad']]) {
    if (!band) continue;
    const edge = key === 'bad' ? band.first - 1 : band.last;
    const values = cumulative.map((run) => run[edge]);
    if (Math.max(...values) < 0.1 || Math.min(...values) > 0.9) continue;
    // ponytail: ~1% display inset at the plot edges. A 0.000 line sits exactly
    // on the frame and is invisible; drop this if exact placement matters.
    const edgeY = (cum) => Math.min(Math.max(y(cum), pad.top + 6), pad.top + plotHeight - 6);
    edges.push({
      key,
      points: cumulative.map((run, index) => `${x(index)},${edgeY(run[edge])}`),
      label: bandName(band),
      // The label sits at the left, so it hangs on the line's left end: under
      // the qualification line, above the relegation one.
      labelY: Math.min(
        Math.max(edgeY(values[0]) + (key === 'bad' ? -5 : 12), pad.top + 10),
        pad.top + plotHeight - 4
      ),
    });
  }
  // Halos first: each line knocks out the frame, the gridlines and the blue
  // cells underneath (paper is what the chart sits on), so the colour shows.
  for (const e of edges) chart.appendChild(svgEl('polyline', { class: 'band-edge-halo', points: e.points.join(' ') }));
  for (const e of edges) {
    chart.appendChild(svgEl('polyline', { class: `band-edge band-edge--${e.key}`, points: e.points.join(' ') }));
    const tag = svgEl('text', {
      class: `band-edge-label band-edge-label--${e.key}`,
      x: pad.left + 4,
      y: e.labelY,
    });
    tag.textContent = e.label;
    chart.appendChild(tag);
  }

  // Position numbers inside the bands, at each band's thickest snapshot, so
  // the reader can name a band without a boundary line drawn across it. Bands
  // too thin to hold the text are left to the tooltip. Ink flips with the ramp
  // step exactly as heatTextClass does for the grid's cells.
  const MIN_BAND_LABEL = 16;
  for (let position = 1; position <= count; position += 1) {
    let best = 0;
    let bestAt = 0;
    for (let index = 0; index < snapshots; index += 1) {
      const probability = team.positions[index][position - 1];
      if (probability > best) { best = probability; bestAt = index; }
    }
    if (best * plotHeight < MIN_BAND_LABEL) continue;
    const step = Math.round(((count - position) / (count - 1)) * (SEQ_STEPS - 1)) + 1;
    const centre = cumulative[bestAt][position] - best / 2;
    // A band that peaks on the first or last snapshot would otherwise centre
    // its numeral half off the plot; hold it a little inside the edge.
    const NUMERAL_EDGE = 14;
    const label = svgEl('text', {
      class: `band-pos${step >= 5 ? ' band-pos--invert' : ''}`,
      x: Math.min(Math.max(x(bestAt), pad.left + NUMERAL_EDGE), pad.left + plotWidth - NUMERAL_EDGE),
      y: y(centre),
      'text-anchor': 'middle',
    });
    label.textContent = ordinalShort(position);
    chart.appendChild(label);
  }

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

  // The divisions play on different days, so after a league switch the
  // rewound date may not be one of this league's matchdays: sit on the last
  // one on or before it, which is what the data is showing.
  const index = state.asof
    ? Math.max(0, days.findLastIndex((day) => day.date <= state.asof))
    : days.length - 1;
  range.value = String(index);

  const day = days[index];
  const live = !state.asof || index === days.length - 1;
  panel.classList.toggle('is-past', !live);
  $('#timeline-now').hidden = live;

  const when = longDate(day.date);
  range.setAttribute('aria-valuetext', live ? t('timeline.scrubLive') : when);
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
    $(`#${animView()}-anim-when`).textContent = formatDate(day.date);
    return;
  }

  const live = index === days.length - 1;
  event.target.setAttribute('aria-valuetext', live ? t('timeline.scrubLive') : longDate(day.date));
  $('#timeline-when').textContent = live ? t('timeline.scrubLive') : t('timeline.scrubAsOf', { when: longDate(day.date) });
  $('#timeline').classList.toggle('is-past', !live);

  clearTimeout(state.rewindTimer);
  state.rewindTimer = setTimeout(() => rewindTo(live ? null : day.date), 220);
}

/* Rewinds and season loads share one counter: only the latest request may
   paint. Without it a slow response for an earlier date (or the previous
   season) could land after a newer one and leave the page showing data the
   slider no longer points at. */
let latestLoad = 0;
// The date last asked for, which is ahead of state.asof while a fetch is out.
let requestedAsof = null;
let seasonLoading = false;

async function rewindTo(asof) {
  // A new season's timeline replaces this one; the slider waits for it.
  if (seasonLoading || asof === requestedAsof) return;
  requestedAsof = asof;
  const token = ++latestLoad; // retires any rewind still in flight
  const season = state.season;
  const content = $('#content');
  content.classList.add('is-rewinding');
  content.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(reportUrl(season, asof));
    if (!response.ok) throw new Error(`server returned ${response.status}`);
    const reports = applyShortNames(await response.json());
    if (token !== latestLoad) return;
    state.reports = reports;
    state.asof = asof;
    render();
  } catch (error) {
    if (token !== latestLoad) return;
    requestedAsof = state.asof; // so the same date can be tried again
    $('#timeline-when').textContent = t('status.couldNotRewind', { error: error.message });
  } finally {
    if (token === latestLoad) {
      content.classList.remove('is-rewinding');
      content.removeAttribute('aria-busy');
    }
  }
}

/* ---------- theme -------------------------------------------------- */

function resolveTheme() {
  const chosen = localStorage.getItem('elitetracker-theme');
  document.documentElement.dataset.resolvedTheme = chosen === 'light' || chosen === 'dark' ? chosen
    : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  $('meta[name=theme-color]').content =
    document.documentElement.dataset.resolvedTheme === 'dark' ? '#0b1116' : '#e9edf1';
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === chosen));
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
  const playedResults = panel.querySelector('.played-results');
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
  } else if (view === 'next-up') {
    if (fixtures) {
      for (let i = 0; i < 5; i++) {
        const div = document.createElement('div');
        div.className = 'skeleton skeleton-fixture';
        fixtures.appendChild(div);
      }
    }
  } else if (view === 'played') {
    if (playedResults) {
      for (let i = 0; i < 6; i++) {
        const div = document.createElement('div');
        div.className = 'skeleton skeleton-played-card';
        playedResults.appendChild(div);
      }
    }
  }
}

/* Clear skeletons after render */
function clearSkeleton(view) {
  const section = document.querySelector(`[data-section="${view}"]`);
  if (!section) return;
  section.querySelectorAll('.skeleton-row, .skeleton-fixture, .skeleton-played-card, .skeleton-grid-cell, .skeleton-ladder-row').forEach(el => el.remove());
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
  // Clear skeletons from previous view
  clearSkeleton(state._prevActiveView);
  clearSkeleton(state.activeView);
  switch (state.activeView) {
    case 'table':
      renderStandings(report);
      renderBandLegend(report);
      break;
    case 'grid':
      if (!anim.playing) {
        renderGrid(report);
        renderGridLegend();
        $('#grid-anim-play').hidden = matchdays(report).length < 2;
      }
      break;
    case 'ladder':
      if (!anim.playing) {
        renderLadder(state.reports);
        const days = matchdays(report);
        $('#ladder-anim-play').hidden = days.length < 2;
      }
      break;
    case 'next-up':
      if (state._prevActiveView !== 'next-up') state.fixturesWeek = 0;
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
  // Season and rewind date too, so a reload or a shared link lands where the
  // reader was; boot reads both back.
  if (report.league.season !== report.league.current_season) params.set('season', report.league.season);
  else params.delete('season');
  if (state.asof) params.set('asof', state.asof);
  else params.delete('asof');
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}${window.location.hash}`);

  document.title = `${report.league.name} ${report.league.season} — EliteTracker`;
  state._prevActiveView = state.activeView;
}

// Switch the active view: shared by top-strip/bar clicks and the bar swipe.
function switchView(view) {
  closeSheet();
  if (anim.playing && view !== state.activeView) animStop();
  state.activeView = view;
  markActiveView();
  render();
  hideTooltip();
  window.scrollTo({ top: 0, behavior: 'instant' });
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
      switchView(button.dataset.view);
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

  // Mobile More button: toggle the sheet.
  const moreButton = $('#more-button');
  const moreSheet = $('#more-sheet');
  if (moreButton) {
    moreButton.addEventListener('click', () => {
      if (moreSheet.hidden) openSheet();
      else closeSheet();
    });
  }
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
    button.addEventListener('click', () => toggleTableView(button.dataset.tableMode));
  }

  $('#season-select').addEventListener('change', async (event) => {
    await loadSeason(Number(event.target.value));
  });

  $('#timeline-range').addEventListener('input', onTimelineInput);
  $('#timeline-now').addEventListener('click', () => { if (anim.playing) animStop(); rewindTo(null); });

  $('#compare-a').addEventListener('change', () => renderCompare(state.reports[state.league]));
  $('#compare-b').addEventListener('change', () => renderCompare(state.reports[state.league]));

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
  state.sort = DEFAULT_SORT[state.tableView] || DEFAULT_SORT.current;
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

/* The tab strip, mobile bar, and any other data-view buttons are marked from
   here. On desktop the strip scrolls sideways once it outgrows its container,
   so its active tab is pulled back into sight. On mobile the fixed bar shows
   four views; when the current one lives in the sheet, More carries the mark
   so the bar is never blank. */
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
}

/* Focus trap cleanup for whichever popover is open; only one can be, since
   every opener closes the rest first. */
let menuFocusCleanup = null;

function closeAllMenus() {
  for (const menu of document.querySelectorAll('.popover-menu')) menu.hidden = true;
  for (const part of document.querySelectorAll('.hero-title-part')) part.setAttribute('aria-expanded', 'false');
  const btn = $('#settings-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  menuFocusCleanup?.();
  menuFocusCleanup = null;
  closeSheet();
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
    $('#status').hidden = false;
    $('#status').textContent = t('status.couldNotLoad', { season, error: error.message });
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

/* ---------- compare clubs ----------------------------------------- */

function allTeams() {
  const seen = new Set();
  const teams = [];
  for (const report of Object.values(state.reports || {})) {
    for (const row of report.table || []) {
      const id = String(row.team_id);
      if (seen.has(id)) continue;
      seen.add(id);
      teams.push(row);
    }
  }
  teams.sort((a, b) => a.team.localeCompare(b.team, 'nb'));
  return teams;
}

function teamNameById(id) {
  return allTeams().find((team) => String(team.team_id) === String(id))?.team || id;
}

function careerById(id) {
  return (state.careers?.teams || []).find((team) => String(team.team_id) === String(id));
}

function ratingById(id) {
  return allTeams().find((team) => String(team.team_id) === String(id))?.rating ?? 0;
}

/* Three-way odds for a fictional match, ported from model/probabilities.py.
   Both divisions share one rating scale, so any two clubs can meet. Working it
   out here costs a few lines and saves shipping a 32x31 matrix of every
   possible pairing in every report file. */
function matchOdds(model, homeRating, awayRating) {
  const gap = (homeRating - awayRating) / 400;
  const beta = model.home_advantage_beta || 0;
  const effective_ha = model.home_advantage * (1 + beta * gap);
  const effectiveGap = homeRating + effective_ha - awayRating;
  // The ELO expectation of that gap against an even 1500 baseline. Half the
  // draw mass comes off each side, so home_win + 0.5*draw reproduces it exactly.
  const expected = 1 / (1 + 10 ** (-effectiveGap / 400));
  const draw = Math.min(
    model.draw_base * Math.exp(-((effectiveGap / model.draw_scale) ** 2)),
    2 * Math.min(expected, 1 - expected)
  );
  return { gap: effectiveGap, home_win: expected - draw / 2, draw, away_win: 1 - expected - draw / 2 };
}

/* Most likely scorelines, ported from display/fixtures.py: each outcome's
   empirical frequencies for the gap's bin, weighted by that outcome's odds. */
/* Scoreline grid ported from model/attack_defence.py: Poisson goals at each
   side's expected rate with the Dixon-Coles low-score correction, 0-8 goals
   each way, renormalised. */
function scoreGrid(model, homeId, awayId, eloGap) {
  const ad = model.attack_defence;
  const [homeAttack, homeDefence, homeFinishing] = ad.teams[homeId] || [0, 0, 0];
  const [awayAttack, awayDefence, awayFinishing] = ad.teams[awayId] || [0, 0, 0];
  const gap = eloGap || 0;
  const effective_home = ad.home * (1 + (ad.home_beta || 0) * gap);
  const spread = ad.spread ?? 1;
  const lam = Math.exp(ad.base + effective_home + spread * (homeAttack - awayDefence + (homeFinishing || 0)));
  const mu = Math.exp(ad.base + spread * (awayAttack - homeDefence + (awayFinishing || 0)));
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
  const grid = scoreGrid(model, homeId, awayId, odds.gap / 400);
  const own = { home_win: 0, draw: 0, away_win: 0 };
  grid.forEach((row, i) => row.forEach((p, j) => { own[i > j ? 'home_win' : i === j ? 'draw' : 'away_win'] += p; }));
  const gamma = model.attack_defence.blend_gamma || 0;
  const gap = Math.abs(odds.gap) / 400;
  const w = gamma ? Math.max(0.05, Math.min(0.50, model.attack_defence.outcome_blend - gamma * gap)) : model.attack_defence.outcome_blend;
  const raw = ['home_win', 'draw', 'away_win'].map((o) => odds[o] ** w * own[o] ** (1 - w));
  const total = raw[0] + raw[1] + raw[2];
  return { gap: odds.gap, home_win: raw[0] / total, draw: raw[1] / total, away_win: raw[2] / total };
}

/* Most likely scorelines: who wins comes from the blended odds, how many goals
   from the grid -- each outcome's cells are rescaled to that outcome's odds. */
function topScorelines(model, odds, homeId, awayId, n = 5) {
  const grid = scoreGrid(model, homeId, awayId, odds.gap / 400);
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
  block.appendChild(el('div', 'compare__pick-hint', t('compare.hint')));
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
    segment.textContent = value >= 0.12 ? pct(value, 0) : '';
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

let compareMenuEl = null;
let compareMenuFocusCleanup = null;
let compareMenuActiveIndex = -1;

function closeCompareMenu() {
  if (compareMenuEl) {
    compareMenuEl.remove();
    compareMenuEl = null;
  }
  if (compareMenuFocusCleanup) {
    compareMenuFocusCleanup();
    compareMenuFocusCleanup = null;
  }
  compareMenuActiveIndex = -1;
  document.removeEventListener('pointerdown', compareMenuOutside, true);
  document.removeEventListener('keydown', compareMenuKey);
  window.removeEventListener('scroll', compareMenuScroll, true);
}

function compareMenuOutside(event) {
  if (compareMenuEl && !compareMenuEl.contains(event.target)) closeCompareMenu();
}

function compareMenuKey(event) {
  if (event.key === 'Escape') {
    closeCompareMenu();
    return;
  }
  if (!compareMenuEl) return;
  const options = [...compareMenuEl.querySelectorAll('[role="option"]:not([disabled])')];
  if (!options.length) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    compareMenuActiveIndex = Math.min(compareMenuActiveIndex + 1, options.length - 1);
    options[compareMenuActiveIndex].focus();
    compareMenuEl.setAttribute('aria-activedescendant', options[compareMenuActiveIndex].id);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    compareMenuActiveIndex = Math.max(compareMenuActiveIndex - 1, 0);
    options[compareMenuActiveIndex].focus();
    compareMenuEl.setAttribute('aria-activedescendant', options[compareMenuActiveIndex].id);
  } else if (event.key === 'Home') {
    event.preventDefault();
    compareMenuActiveIndex = 0;
    options[0].focus();
    compareMenuEl.setAttribute('aria-activedescendant', options[0].id);
  } else if (event.key === 'End') {
    event.preventDefault();
    compareMenuActiveIndex = options.length - 1;
    options[compareMenuActiveIndex].focus();
    compareMenuEl.setAttribute('aria-activedescendant', options[compareMenuActiveIndex].id);
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (compareMenuActiveIndex >= 0) options[compareMenuActiveIndex].click();
  }
}

function compareMenuScroll(event) {
  if (compareMenuEl && compareMenuEl.contains(event.target)) return;
  closeCompareMenu();
}

function openCompareMenu(box, side, report) {
  closeCompareMenu();
  const menu = el('div', 'compare__menu');
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', t('compare.chooseClub'));
  menu.dataset.side = side;
  const select = side === 'home' ? $('#compare-a') : $('#compare-b');
  const otherId = side === 'home' ? $('#compare-b').value : $('#compare-a').value;
  let selectedIndex = -1;
  const teams = allTeams();
  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    const option = el('button', 'compare__option');
    option.type = 'button';
    option.setAttribute('role', 'option');
    option.id = `compare-option-${side}-${team.team_id}`;
    if (team.team_id === otherId) option.disabled = true;
    if (team.team_id === select.value) {
      option.setAttribute('aria-selected', 'true');
      selectedIndex = i;
    }
    const crest = teamLogo(team.team_id, team.team);
    if (crest) option.appendChild(crest);
    option.appendChild(el('span', 'compare__option-name', team.team));
    option.addEventListener('click', () => {
      select.value = team.team_id;
      select.dispatchEvent(new Event('change'));
      closeCompareMenu();
    });
    menu.appendChild(option);
  }
  const rect = box.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${rect.left}px`;
  menu.style.width = `${rect.width}px`;
  menu.style.setProperty('--menu-left', `${rect.left}px`);
  menu.style.setProperty('--menu-width', `${rect.width}px`);
  document.body.appendChild(menu);
  compareMenuEl = menu;
  compareMenuActiveIndex = selectedIndex;
  if (selectedIndex >= 0) {
    const selectedOption = menu.querySelector('[aria-selected="true"]');
    if (selectedOption) menu.setAttribute('aria-activedescendant', selectedOption.id);
  }
  compareMenuFocusCleanup = trapFocus(menu);
  setTimeout(() => {
    document.addEventListener('pointerdown', compareMenuOutside, true);
    document.addEventListener('keydown', compareMenuKey);
    window.addEventListener('scroll', compareMenuScroll, true);
  }, 0);
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

  const makePicker = (box, side) => {
    box.setAttribute('role', 'button');
    box.setAttribute('tabindex', '0');
    box.setAttribute('aria-label', t('compare.chooseClub'));
    box.setAttribute('aria-haspopup', 'listbox');
    box.title = t('compare.chooseClub');
    const toggle = () => {
      if (compareMenuEl && compareMenuEl.dataset.side === side) closeCompareMenu();
      else openCompareMenu(box, side, report);
    };
    box.addEventListener('click', toggle);
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
  };
  makePicker(homeBlock, 'home');
  makePicker(awayBlock, 'away');
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

  // Head-to-head: all-time results between the two clubs from careers data.
  const h2hKey = [aId, bId].sort().join('\t');
  const h2hAll = (state.careers?.head_to_head || {})[h2hKey] || [];
  const h2h = h2hAll.filter(
    (r) => (r.home_id === aId && r.away_id === bId) || (r.home_id === bId && r.away_id === aId),
  );
  if (h2h.length) {
    h2h.sort((a, b) => b.date.localeCompare(a.date));
    const h2hBlock = el('div', 'compare__block');
    h2hBlock.appendChild(el('h3', 'compare__subhead', t('compare.h2h')));
    let aWins = 0; let bWins = 0; let draws = 0; let aGoals = 0; let bGoals = 0;
    for (const m of h2h) {
      const aIsHome = m.home_id === aId;
      const aG = aIsHome ? m.home_goals : m.away_goals;
      const bG = aIsHome ? m.away_goals : m.home_goals;
      aGoals += aG;
      bGoals += bG;
      if (aG > bG) aWins++;
      else if (bG > aG) bWins++;
      else draws++;
    }
    const record = el('div', 'compare__h2h-record');
    record.appendChild(el('span', 'compare__h2h-team', homeName));
    record.appendChild(el('span', 'compare__h2h-stat', `${aWins} \u2013 ${draws} \u2013 ${bWins}`));
    record.appendChild(el('span', 'compare__h2h-team', awayName));
    const goalsBlock = el('div', 'compare__h2h-goals');
    goalsBlock.appendChild(el('span', 'compare__h2h-goals-label', t('compare.h2h.goalsLabel')));
    goalsBlock.appendChild(el('span', 'compare__h2h-goals-stat', `${aGoals} – ${bGoals}`));
    h2hBlock.appendChild(record);
    h2hBlock.appendChild(goalsBlock);
    const PAGE_SIZE = 5;
    const totalPages = Math.ceil(h2h.length / PAGE_SIZE);
    // The shared page control sits above the list, as on Played Results;
    // meetings run newest first, so Prev goes back in time.
    const navSlot = el('div');
    const list = el('div', 'compare__h2h-list');
    h2hBlock.appendChild(navSlot);
    h2hBlock.appendChild(list);
    const renderH2hPage = (h2hPage) => {
      navSlot.replaceChildren();
      if (totalPages > 1) navSlot.appendChild(paginator(h2hPage, totalPages, renderH2hPage, true));
      list.replaceChildren();
      const start = h2hPage * PAGE_SIZE;
      for (const m of h2h.slice(start, start + PAGE_SIZE)) {
        const card = el('div', 'played-card');
        if (m.home_goals > m.away_goals) card.classList.add('played-card--home-win');
        else if (m.away_goals > m.home_goals) card.classList.add('played-card--away-win');
        card.appendChild(el('div', 'played-card__date', `${formatDate(m.date)} \u00b7 ${m.season}`));
        const matchup = el('div', 'played-card__matchup');
        const homeSide = el('div', 'played-card__side played-card__side--home');
        homeSide.appendChild(sideBlock(m.home, m.home_id, false));
        matchup.appendChild(homeSide);
        matchup.appendChild(el('div', 'played-card__score', `${m.home_goals}\u2013${m.away_goals}`));
        const awaySide = el('div', 'played-card__side played-card__side--away');
        awaySide.appendChild(sideBlock(m.away, m.away_id, true));
        matchup.appendChild(awaySide);
        card.appendChild(matchup);
        list.appendChild(card);
      }
    };
    renderH2hPage(0);
    holder.appendChild(h2hBlock);
  }
}

function drawCompareHistory(svg, careerA, careerB, labelA, labelB) {
  const width = 900;
  const height = 320;
  const pad = { top: 14, right: 18, bottom: 34, left: 46 };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren();

  // SVG accessibility: title doubles as the accessible name
  const title = svgEl('title');
  title.textContent = t('chart.ratingHistoryFor', { home: labelA, away: labelB });
  svg.appendChild(title);

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

  // Ticks on round ratings (1, 2 or 5 x 10^n apart, four to six of them), not
  // the range cut into equal quarters, which gave 1456, 1559, 1662...
  const rough = (rMax - rMin) / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const tickStep = [1, 2, 5, 10].map((m) => m * magnitude).find((v) => v >= rough);
  for (let value = Math.ceil(rMin / tickStep) * tickStep; value <= rMax; value += tickStep) {
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
  document.documentElement.lang = htmlLang(currentLang);
  for (const button of document.querySelectorAll('[data-lang]')) {
    button.setAttribute('aria-pressed', String(button.dataset.lang === currentLang));
  }
  applyTranslations();
  wire();
  
  try {
    const reports = await fetch(reportUrl(null)).then((r) => {
      if (!r.ok) throw new Error(`server returned ${r.status}`);
      return r.json();
    });
    
    let careers = null;
    try {
      careers = await fetch('/data/careers.json').then((r) => {
        if (!r.ok) throw new Error(`/data/careers.json ${r.status}`);
        return r.json();
      });
      
    } catch (error) {
      console.warn('[Boot] careers.json unavailable', error);
      $('#status').hidden = false;
      $('#status').textContent = t('status.couldNotLoad', { season: 'careers', error: error.message });
    }
    
    state.reports = applyShortNames(reports);
    state.careers = applyShortNamesToCareers(careers);
    state.season = reports[state.league].league.season;
    
    // Left up when careers failed, so the warning above stays readable.
    if (careers) $('#status').hidden = true;
    $('#content').hidden = false;
    
    // Read before the first render, which rewrites the query string.
    const params = new URLSearchParams(window.location.search);
    applyLeagueParameter();
    applySortParameter();
    applyViewParameter();
    applyTeamParameter();
    
    render();
    

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
    console.error('[Boot] ERROR:', error);
    $('#status').textContent =
      t('status.couldNotLoadSeason', { error: error.message });
  }
}

/* ---------- mobile gestures ----------------------------------------- */

/* Mobile gesture handling: swipe navigation, pull-to-refresh, swipe-to-dismiss sheet */
function initMobileGestures() {
  // Only on mobile
  if (window.innerWidth > 760) return;

  const content = $('#content');
  const mobilebar = $('#mobilebar');
  const sheet = $('#more-sheet');
  const sheetPanel = sheet?.querySelector('.sheet__panel');
  const viewsInBar = [...mobilebar.querySelectorAll('.mobilebar__item[data-view]')].map(b => b.dataset.view);

  // Pull-to-refresh
  let ptrState = { startY: 0, currentY: 0, pulling: false, triggered: false };
  const ptrIndicator = createPullToRefreshIndicator();
  content.prepend(ptrIndicator);

  // Swipe navigation on bottom bar
  let swipeState = { startX: 0, startY: 0, currentX: 0, swiping: false };

  // Swipe-to-dismiss sheet
  let sheetSwipeState = { startY: 0, currentY: 0, dragging: false };

  // Touch ripple for interactive elements
  addTouchRipple();

  // --- Pull to Refresh ---
  content.addEventListener('touchstart', (e) => {
    if (window.scrollY > 0) return; // Only at top of page
    if (ptrState.pulling) return;
    ptrState.startY = e.touches[0].clientY;
    ptrState.pulling = true;
    ptrState.triggered = false;
  }, { passive: true });

  content.addEventListener('touchmove', (e) => {
    if (!ptrState.pulling || window.scrollY > 0) {
      ptrState.pulling = false;
      return;
    }
    ptrState.currentY = e.touches[0].clientY;
    const delta = ptrState.currentY - ptrState.startY;
    if (delta <= 0) {
      ptrState.pulling = false;
      return;
    }
    e.preventDefault(); // Prevent native scroll bounce
    const pullDistance = Math.min(delta * 0.5, 80); // Resistance
    ptrIndicator.style.transform = `translateY(${-60 + pullDistance}px)`;
    ptrIndicator.style.opacity = '1';
    ptrIndicator.classList.toggle('pulling', pullDistance > 40);
    if (pullDistance > 60 && !ptrState.triggered) {
      ptrState.triggered = true;
      ptrIndicator.querySelector('.ptr-text').textContent = t('ptr.release');
      // Haptic feedback simulation
      if (navigator.vibrate) navigator.vibrate(10);
    }
  }, { passive: false });

  content.addEventListener('touchend', async () => {
    if (!ptrState.pulling || !ptrState.triggered) {
      resetPullToRefresh();
      return;
    }
    // Trigger refresh
    ptrIndicator.classList.remove('pulling');
    ptrIndicator.classList.add('loading');
    ptrIndicator.querySelector('.ptr-text').textContent = t('ptr.loading');
    ptrIndicator.querySelector('.ptr-spinner').style.display = 'block';

    // Reload current season data
    try {
      await loadSeason(state.season);
    } catch (err) {
      console.warn('Pull to refresh failed:', err);
    }
    resetPullToRefresh();
  }, { passive: true });

  function resetPullToRefresh() {
    ptrState.pulling = false;
    ptrState.triggered = false;
    ptrIndicator.classList.remove('pulling', 'loading', 'visible');
    ptrIndicator.style.transform = 'translateY(-100%)';
    ptrIndicator.style.opacity = '0';
    ptrIndicator.querySelector('.ptr-spinner').style.display = 'none';
    ptrIndicator.querySelector('.ptr-text').textContent = t('ptr.pull');
  }

  function createPullToRefreshIndicator() {
    const div = document.createElement('div');
    div.className = 'ptr-indicator';
    div.innerHTML = `
      <div class="ptr-spinner" style="display:none;"></div>
      <span class="ptr-text">${t('ptr.pull')}</span>
    `;
    return div;
  }

  // --- Swipe Navigation on Bottom Bar ---
  mobilebar?.addEventListener('touchstart', (e) => {
    const target = e.target.closest('.mobilebar__item[data-view]');
    if (!target) return;
    swipeState.startX = e.touches[0].clientX;
    swipeState.startY = e.touches[0].clientY;
    swipeState.currentX = swipeState.startX;  // a tap must not fake a swipe delta
    swipeState.swiping = true;
  }, { passive: true });

  mobilebar?.addEventListener('touchmove', (e) => {
    if (!swipeState.swiping) return;
    swipeState.currentX = e.touches[0].clientX;
    const deltaX = swipeState.currentX - swipeState.startX;
    const deltaY = Math.abs(e.touches[0].clientY - swipeState.startY);
    // Allow vertical scroll if vertical movement > horizontal
    if (deltaY > Math.abs(deltaX) * 1.5) {
      swipeState.swiping = false;
      return;
    }
    e.preventDefault();
    // Visual feedback on the bar items
    const threshold = 50;
    if (Math.abs(deltaX) > threshold) {
      const direction = deltaX > 0 ? 1 : -1; // right = previous, left = next
      const currentIndex = viewsInBar.indexOf(state.activeView);
      const nextIndex = (currentIndex + direction + viewsInBar.length) % viewsInBar.length;
      const nextView = viewsInBar[nextIndex];
      highlightBarItem(nextView);
    }
  }, { passive: false });

  mobilebar?.addEventListener('touchend', () => {
    if (!swipeState.swiping) return;
    swipeState.swiping = false;
    const deltaX = swipeState.currentX - swipeState.startX;
    const threshold = 50;
    if (Math.abs(deltaX) > threshold) {
      const direction = deltaX > 0 ? 1 : -1;
      const currentIndex = viewsInBar.indexOf(state.activeView);
      const nextIndex = (currentIndex + direction + viewsInBar.length) % viewsInBar.length;
      const nextView = viewsInBar[nextIndex];
      switchView(nextView);
      if (navigator.vibrate) navigator.vibrate(15);
    }
    clearBarHighlight();
  }, { passive: true });

  function highlightBarItem(view) {
    mobilebar.querySelectorAll('.mobilebar__item[data-view]').forEach(btn => {
      btn.style.opacity = btn.dataset.view === view ? '1' : '0.4';
      btn.style.transform = btn.dataset.view === view ? 'scale(1.05)' : 'scale(0.95)';
    });
  }
  function clearBarHighlight() {
    mobilebar.querySelectorAll('.mobilebar__item[data-view]').forEach(btn => {
      btn.style.opacity = '';
      btn.style.transform = '';
    });
  }

  // --- Swipe to Dismiss Sheet ---
  sheetPanel?.addEventListener('touchstart', (e) => {
    if (sheet.hidden) return;
    if (sheetPanel.getAnimations().some(a => a.playState === 'running')) return;
    sheetSwipeState.startY = e.touches[0].clientY;
    sheetSwipeState.dragging = true;
    sheetPanel.classList.add('is-dragging');
  }, { passive: true });

  sheetPanel?.addEventListener('touchmove', (e) => {
    if (!sheetSwipeState.dragging) return;
    sheetSwipeState.currentY = e.touches[0].clientY;
    const deltaY = sheetSwipeState.currentY - sheetSwipeState.startY;
    if (deltaY <= 0) return; // Only dismiss on downward swipe
    e.preventDefault();
    const pullDistance = Math.min(deltaY * 0.4, 200);
    sheetPanel.style.transform = `translateY(${pullDistance}px)`;
    sheetPanel.style.opacity = String(1 - pullDistance / 300);
    sheet.querySelector('.sheet__scrim').style.opacity = String(0.45 * (1 - pullDistance / 300));
  }, { passive: false });

  sheetPanel?.addEventListener('touchend', () => {
    if (!sheetSwipeState.dragging) return;
    sheetSwipeState.dragging = false;
    sheetPanel.classList.remove('is-dragging');
    const deltaY = sheetSwipeState.currentY - sheetSwipeState.startY;
    if (deltaY > 100) {
      // Dismiss
      sheetPanel.classList.add('is-dismissed');
      setTimeout(() => {
        closeSheet();
        sheetPanel.classList.remove('is-dismissed');
        sheetPanel.style.transform = '';
        sheetPanel.style.opacity = '';
        sheet.querySelector('.sheet__scrim').style.opacity = '';
        if (navigator.vibrate) navigator.vibrate(20);
      }, 250);
    } else {
      // Snap back
      sheetPanel.style.transition = 'transform 0.2s var(--ease), opacity 0.2s var(--ease)';
      sheetPanel.style.transform = '';
      sheetPanel.style.opacity = '';
      sheet.querySelector('.sheet__scrim').style.opacity = '';
      setTimeout(() => sheetPanel.style.transition = '', 200);
    }
  }, { passive: true });
}

/* Touch ripple effect for buttons and interactive elements */
function addTouchRipple() {
  const interactiveSelectors = [
    'button:not(.switch button):not(.sort-btn):not(.grid-anim-speed button)',
    '.club-btn',
    '.played-card',
    '.ladder__team',
    '.compare__team',
    '.team-logo',
    '.hero-title-part',
    '.timeline__step',
    '.grid-anim-btn',
    '.played-nav__btn',
    '.timeline__now',
    '.compare__swap-center',
    '.sheet__item',
    '.mobilebar__item',
    '.settings-btn',
    '.popover-menu__btn',
    '.compare__option',
    '.pred-box__from',
    '.pred-box__to',
    '.team-grid-row__cell-wrap',
  ];

  // Use event delegation for performance
  document.addEventListener('touchstart', (e) => {
    const target = e.target.closest(interactiveSelectors.join(', '));
    if (!target) return;
    // Don't add ripple to elements that already have visual feedback
    if (target.classList.contains('switch') || target.closest('.switch')) return;
    if (target.classList.contains('sort-btn')) return;
    if (target.classList.contains('grid-anim-speed') || target.closest('.grid-anim-speed')) return;

    target.classList.add('touch-ripple');
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    const target = e.target.closest('.touch-ripple');
    if (target) {
      // Remove after animation
      setTimeout(() => target.classList.remove('touch-ripple'), 300);
    }
  }, { passive: true });

  document.addEventListener('touchcancel', (e) => {
    const target = e.target.closest('.touch-ripple');
    if (target) target.classList.remove('touch-ripple');
  }, { passive: true });
}

/* Reduced motion check for gestures */
function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* Smooth scroll to element with offset for fixed headers */
function smoothScrollTo(element, offset = 0) {
  if (prefersReducedMotion()) {
    element.scrollIntoView({ block: 'start' });
    return;
  }
  const headerHeight = document.querySelector('.masthead')?.offsetHeight || 0;
  const mobilebarHeight = window.innerWidth <= 760 ? (document.querySelector('.mobilebar')?.offsetHeight || 0) : 0;
  const targetPosition = element.getBoundingClientRect().top + window.scrollY - headerHeight - mobilebarHeight - offset;
  window.scrollTo({ top: targetPosition, behavior: 'smooth' });
}

/* Handle orientation change */
function handleOrientationChange() {
  // Recalculate viewport heights for fixed elements
  const vh = window.innerHeight * 0.01;
  document.documentElement.style.setProperty('--vh', `${vh}px`);

  // Close any open menus/sheets on orientation change
  closeAllMenus();

  // Re-render if needed (e.g., grid animation bar)
  if (state.anim.playing) {
    renderAnimBar();
  }
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
    if (!lastShape || !lastShape.chart.isConnected) return;
    const box = lastShape.chart.getBoundingClientRect().width;
    if (!box) return;
    if ((box < SHAPE_NARROW) !== lastShape.narrow) {
      drawTeamShape(lastShape.report, lastShape.team, lastShape.chart, box);
    }
  }, 150);
});

// Initialize viewport height variable for CSS
handleOrientationChange();

boot();
