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
  // Active view tab: 'grid', 'table', 'ladder', 'matches', 'compare', 'explore', 'team', 'model'
  // ?view= still wins -- see applyViewParameter.
  activeView: 'grid',
  // Open visualisation in the explore view (?viz=); null shows the gallery.
  exploreItem: null,
  _prevActiveView: null,
  // Team focus: team_id when viewing the team tab, null otherwise.
  teamFocusId: null,
  // Open group in the team view: 'overview', 'forecast' or 'history'.
  teamTab: 'overview',
  // Week index on the Matches timeline; null opens on the current week.
  matchesWeek: null,
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
    for (const stake of report.high_stakes || []) {
      stake.team = shortName(stake.team);
      stake.opponent = shortName(stake.opponent);
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
  img.src = `/logos/${teamId}.webp`;
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

/* Short edge label for season-shape chart lines and stake badges.
   European bands map to CL/EL/ECL keys; champion maps to Title; others fall back. */
function bandEdgeName(band) {
  const label = band.label;
  let key;
  if (label === 'Champions') key = 'table.zone.good.champion'; // "Title"
  else if (label === 'Champions League qualification') key = 'band.edge.CL';
  else if (label === 'Europa League qualification') key = 'band.edge.EL';
  else if (label === 'Conference League qualification') key = 'band.edge.ECL';
  else return bandName(band);
  return t(key) === key ? bandName(band) : t(key);
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
  if (band.label === 'Europa League qualification') key = 'table.zone.good.EL';
  if (band.label === 'Conference League qualification') key = 'table.zone.good.ECL';
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
  const days = liveMatchdaysFor(state.league);
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
  const days = liveMatchdaysFor(state.league);
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
    range.setAttribute('aria-valuetext', dayLabel(day));
    $('#timeline-when').textContent = dayText(day, 'timeline.animating');
    $(`#${animView()}-anim-when`).textContent = dayShort(day);
  }
}

/* Which view's controls the animation drives. */
function animView() {
  return state.activeView === 'ladder' ? 'ladder' : 'grid';
}

/* The progress bar follows the interpolated frame, not just whole matchdays,
   so it moves as smoothly as the cells do. */
function animUpdateProgress(frac) {
  const days = liveMatchdaysFor(state.league).length;
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
  const days = liveMatchdaysFor(state.league);
  if (days.length < 2) return;
  track('play_animation', { view: state.activeView });

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
   Each band gets its own distinct hue so the decisive-match dot is
   instantly recognisable without text. Tone alone is not enough:
   a play-off is a good thing in OBOS-ligaen (promotion) and a bad
   one in Eliteserien (relegation). */
function bandColor(band, count) {
  const label = band.label;
  if (label === 'Champions') return 'var(--band-champion)';
  if (label === 'Champions League qualification') return 'var(--outcome-good)';
  if (label === 'Europa League qualification') return 'var(--edge-el)';
  if (label === 'Conference League qualification') return 'var(--edge-ecl)';
  if (label === 'Relegation' || label === 'Relegation play-off') return 'var(--outcome-bad)';
  if (label === 'Promotion') return 'var(--band-champion)';
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

/* ---------- standings --------------------------------------------- */

/* One club's chance of a band. Promotion (OBOS-ligaen's top band) and
   relegation count the play-offs where the report has them: the places that
   go straight up or down, plus the runs in which the club goes through the
   final or out through the survival tie (pipeline._table_payload). Older
   reports fall back to the places alone. */
function bandChance(row, band, slug) {
  if (band.tone === 'relegation' && row.relegation_probability != null) return row.relegation_probability;
  if (band.tone === 'top' && slug === 'obosligaen' && row.promotion_probability != null) return row.promotion_probability;
  return row.position_probabilities.slice(band.first - 1, band.last).reduce((a, b) => a + b, 0);
}

/* Whether bandChance counted the play-offs for this band. */
function bandWithPlayoff(row, band, slug) {
  return (band.tone === 'relegation' && row.relegation_probability != null)
    || (band.tone === 'top' && slug === 'obosligaen' && row.promotion_probability != null);
}

/* Rows with the two derived probability columns folded in, so sorting can see
   the same values the table shows. */
function standingsRows(report) {
  const bands = report.league.bands;
  const relegation = bands.find((band) => band.tone === 'relegation');
  const top = bands.find((band) => band.tone === 'top');
  const promotion = report.league.slug === 'obosligaen';

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
      up: promotion && top ? bandChance(row, top, report.league.slug) : row.position_probabilities[0],
      down: relegation ? bandChance(row, relegation, report.league.slug) : 0,
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
  img.src = `logos/${team.teamId}.webp`;
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

/* ---------- high stakes ------------------------------------------- */

/* The report's `high_stakes` array names, per contender, the one remaining
   fixture that swings its band chance most. All DOM-free, so the node suite
   can pin them: keep every body indented (pick() slices to the first
   column-zero `}`). */

/* One decimal, always: a 0.04 swing reads "4.0%", never rounded up into
   something bigger and never hidden as "—" the way pct() hides dust. */
function stakePct(value, lang) {
  if (!Number.isFinite(value)) return '—';
  const clamped = Math.max(0, Math.min(1, value));
  const locale = lang === 'no' ? 'nb-NO' : 'en-GB';
  const figure = (clamped * 100).toLocaleString(locale, {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  });
  return lang === 'no' ? `${figure} %` : `${figure}%`;
}

/* This club's entries, driven by its table row's high_stakes_match_ids.
   Older reports without that key fall back to matching team_id; a report
   without high_stakes at all yields nothing rather than throwing. */
function teamStakes(report, teamId) {
  const rows = (report && report.table) || [];
  const row = rows.find((r) => String(r.team_id) === String(teamId));
  const ids = row && Array.isArray(row.high_stakes_match_ids)
    ? new Set(row.high_stakes_match_ids.map(String))
    : null;
  const all = (report && report.high_stakes) || [];
  if (ids) {
    // Match on the club too: two clubs can hold stakes on the same fixture
    // (once per club, or one club twice for two bands), and the ids alone
    // cannot tell their entries apart.
    return all.filter((entry) => ids.has(String(entry.match_id)) && String(entry.team_id) === String(teamId));
  }
  return all.filter((entry) => String(entry.team_id) === String(teamId));
}

/* The stake of the club's next match, or null. Unlike the decisive entries
   this is there all season (reports without next_stakes simply have none). */
function nextStake(report, teamId) {
  return ((report && report.next_stakes) || []).find((entry) => String(entry.team_id) === String(teamId)) || null;
}

/* Every stake riding on one fixture: one club, or two, or one club twice
   (two bands). Returns all of them so the card merges the reasons into a
   single badge instead of dropping one or stacking two. */
function stakesForFixture(entries, matchId) {
  return (entries || []).filter((entry) => String(entry.match_id) === String(matchId));
}

/* Both legs of the pairing, oldest first, from the fixture list. Empty when
   the legs are unknown, so the team view names the pairing only when it can
   show both halves of it. */
function stakeLegs(entry, fixtures) {
  const legs = (entry && entry.leg_match_ids) || [];
  if (!legs.length) return [];
  const wanted = new Set(legs.map(String));
  return (fixtures || [])
    .filter((f) => wanted.has(String(f.match_id)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/* Plain-language consequence of an entry: the race, its chance now, and where
   the result takes it ("Title 31% → 35% with a win vs Fredrikstad" / "17% with
   a loss"). The tone decides the verb: every band but relegation is something
   to win toward, while relegation is what a loss brings closer -- never "a win
   seals relegation". */
function stakeCopy(entry, lang) {
  const loss = entry.band_tone === 'relegation';
  const args = {
    band: bandEdgeName({ label: entry.band_label }),
    opponent: entry.opponent,
    base: stakePct(entry.p_baseline, lang),
    fav: stakePct(entry.p_favourable, lang),
    unfav: stakePct(entry.p_unfavourable, lang),
  };
  const kind = loss ? 'lose' : 'win';
  return { main: t(`stake.${kind}.main`, args), sub: t(`stake.${kind}.sub`, args) };
}

/* The coloured dot that marks a decisive match, in its band's colour, with the
   stake as its readout. On touch the club name beside it opens the club, so
   the dot is its own tap target and explains itself without navigating. */
function stakeDot(entry, report, count) {
  const band = { first: entry.band_first, last: entry.band_last, tone: entry.band_tone, label: entry.band_label };
  const dot = el('span', 'stake-dot');
  dot.style.background = bandColor(band, count);
  dot.setAttribute('aria-hidden', 'true');
  const copy = stakeCopy(entry, currentLang);
  const legs = stakeLegs(entry, report.fixtures || []);
  const legsHtml = legs.length >= 2 ? `<div class="stake-dot__legs">${t('stake.legs', { a: formatDate(legs[0].date), b: formatDate(legs[1].date) })}</div>` : '';
  dot.tip = () => `<div class="stake-dot__tooltip"><strong>${entry.team} (${bandEdgeName(band)})</strong><br>${copy.main}<br>${copy.sub}${legsHtml}</div>`;
  attachTip(dot, dot.tip);
  dot.addEventListener('click', (event) => event.stopPropagation());
  return dot;
}

/* One merged badge for a fixture card, or null when nothing rides on it. The
   text always names whose stake it is ("Decisive for Bodø/Glimt (Title)"),
   never a bare "important match". The dots reuse the band palette, so the
   flag reads as informative rather than alarming. */
function stakeFlag(stakes, report) {
  if (!stakes || !stakes.length) return null;
  const count = (report.table || []).length || 16;
  const flag = el('div', 'stake-flag');
  const dots = el('span', 'stake-flag__dots');
  dots.setAttribute('aria-hidden', 'true');
  const items = [];
  for (const entry of stakes) {
    const band = { first: entry.band_first, last: entry.band_last, tone: entry.band_tone, label: entry.band_label };
    const dot = el('span', 'stake-flag__dot');
    dot.style.background = bandColor(band, count);
    dots.appendChild(dot);
    items.push(`${entry.team} (${bandEdgeName(band)})`);
  }
  flag.appendChild(dots);
  flag.appendChild(el('span', 'stake-flag__text', t('stake.badge', { list: items.join(' · ') })));
  return flag;
}

function buildFixtureCard(fixture, stakes, report) {
  const card = el('div', 'played-card');
  card.appendChild(el('div', 'played-card__date', formatDate(fixture.date) + (fixture.time ? ` \u00b7 ${fixture.time}` : '')));

  const matchup = el('div', 'played-card__matchup');
  const homeSide = el('div', 'played-card__side played-card__side--home');
  homeSide.appendChild(el('span', 'played-card__rating-value', num(fixture.home_rating)));
  const homeName = sideBlock(fixture.home, fixture.home_id, false);
  homeSide.appendChild(homeName);
  matchup.appendChild(homeSide);

  const oddsCol = el('div', 'fixture__odds-col');
  oddsCol.appendChild(oddsBar(fixture.home, fixture.away, fixture));
  matchup.appendChild(oddsCol);

  const awaySide = el('div', 'played-card__side played-card__side--away');
  const awayName = sideBlock(fixture.away, fixture.away_id, true);
  awaySide.appendChild(awayName);
  awaySide.appendChild(el('span', 'played-card__rating-value', num(fixture.away_rating)));
  matchup.appendChild(awaySide);
  card.appendChild(matchup);

  // Decisive-match dots: one per team that has a stake on this fixture.
  // Attached to the team name element with a tooltip on hover.
  if (stakes && stakes.length && report) {
    const count = report.table.length;
    for (const entry of stakes) {
      const isHome = entry.team_id === fixture.home_id;
      const nameEl = isHome ? homeName : awayName;
      if (!nameEl) continue;
      const dot = stakeDot(entry, report, count);
      // On the inside of the name: right of the home name, left of the away one.
      const nameBtn = nameEl.querySelector('.played-card__team-name');
      if (isHome) nameBtn.after(dot); else nameBtn.before(dot);
      attachTip(nameEl, dot.tip);
    }
  }
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

/* Results and fixtures on one timeline, a week a page: Prev goes back in time
   and Next forward, as on FotMob. It opens on the week of the next fixture --
   which in mid-round also holds the results already in -- or, once the season
   is over, on its last week. */
function renderMatches(report) {
  const holder = $('#fixtures');
  holder.replaceChildren();
  const played = (report.results || []).map((match) => ({ match, played: true }));
  const upcoming = (report.fixtures || []).map((match) => ({ match, played: false }));
  const timeline = [...played, ...upcoming].sort((a, b) =>
    `${a.match.date} ${a.match.time || ''}`.localeCompare(`${b.match.date} ${b.match.time || ''}`));
  if (!timeline.length) {
    $('#fixture-count').textContent = '';
    holder.appendChild(el('p', 'muted', t('played.empty')));
    return;
  }
  const { weeks, byWeek } = groupByWeek(timeline.map((item) => ({ ...item, date: item.match.date })));
  const firstUpcoming = timeline.find((item) => !item.played);
  const current = firstUpcoming ? weeks.indexOf(isoWeek(firstUpcoming.match.date)) : weeks.length - 1;
  if (state.matchesWeek == null) state.matchesWeek = current;
  state.matchesWeek = Math.max(0, Math.min(state.matchesWeek, weeks.length - 1));
  const items = byWeek.get(weeks[state.matchesWeek]);
  const results = items.filter((item) => item.played).map((item) => item.match);
  const fixtures = items.filter((item) => !item.played).map((item) => item.match);
  $('#fixture-count').textContent = t('matches.count', { played: results.length, upcoming: fixtures.length });

  const go = (index) => () => { state.matchesWeek = index; renderMatches(report); };
  holder.appendChild(pageNav(
    t('played.week', { n: weeks[state.matchesWeek] }) + (state.matchesWeek === current && firstUpcoming ? ` · ${t('matches.thisWeek')}` : ''),
    state.matchesWeek > 0 ? go(state.matchesWeek - 1) : null,
    state.matchesWeek < weeks.length - 1 ? go(state.matchesWeek + 1) : null,
  ));
  // A week that is part played gets a heading over each half.
  const both = results.length && fixtures.length;
  if (results.length) {
    if (both) holder.appendChild(el('div', 'label matches__group', t('matches.results')));
    const ratingChanges = buildRatingChanges(state.careers);
    for (const match of results) holder.appendChild(playedCard(match, ratingChanges));
  }
  if (fixtures.length) {
    if (both) holder.appendChild(el('div', 'label matches__group', t('matches.upcoming')));
    for (const fixture of fixtures) holder.appendChild(buildFixtureCard(fixture, stakesForFixture(report.high_stakes, fixture.match_id), report));
  }
  $('#odds-legend').hidden = !fixtures.length;
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

/* The one pagination control on the site, modelled on Matches: Prev,
   what is on show, Next. Prev always goes back in time and Next forward; a
   missing handler disables that side. */
function pageNav(label, onPrev, onNext, [prevText, nextText] = [t('played.prev'), t('played.next')]) {
  const nav = el('div', 'played-nav');
  const prev = el('button', 'played-nav__btn', prevText);
  const next = el('button', 'played-nav__btn', nextText);
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

function formatDate(iso) {
  const date = new Date(`${iso}T12:00:00Z`);
  return date.toLocaleDateString(localeDate(), { weekday: 'short', day: 'numeric', month: 'short' });
}

/* The rewind status's date: in full on a wide screen; on a phone without the
   year (the hero names the season), so the line keeps to its reserved room. */
function whenDate(iso) {
  return window.matchMedia('(max-width: 760px)').matches ? formatDate(iso) : longDate(iso);
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
    // Before a ball is kicked the table's "leader" is only the alphabet.
    const lede = model.matches_played === 0
      ? t('hero.lede.preseason', { favourite: favourite.team, pct: pct(favourite.position_probabilities[0]) })
      : favourite.team === leader.team
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
  // Scrubbing the rewind slider rewrites this sentence for every date. A
  // longer one may add a line, but a shorter one never takes it away again,
  // so the slider below does not bob up and down under the thumb. The hold
  // starts over with the league, season, language or width.
  const lede = $('#hero-lede');
  if (lede.offsetHeight) {
    const hold = `${state.league}|${report.league.season}|${currentLang}|${window.innerWidth}`;
    if (lede.dataset.hold !== hold) {
      lede.dataset.hold = hold;
      lede.style.minHeight = '';
    }
    lede.style.minHeight = `${lede.offsetHeight}px`;
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
  if (model.surface) rows.push([t('model.surfaceEdge'), `${model.surface.edge} ${t('model.pts')}`]);
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
  /* The decisive-match note lives here rather than in the static HTML so an
     empty high_stakes leaves no leftover explainer behind. */
  const how = document.querySelector('#model-how');
  if (how) {
    how.querySelector('[data-stake-note]')?.remove();
    if ((report.high_stakes || []).length) {
      const note = el('li', '', t('model.how5'));
      note.setAttribute('data-stake-note', 'true');
      how.appendChild(note);
    }
  }
}


/* ---------- explore: other ways to look at the numbers -------------- */

/* A gallery of cards, each opening one visualisation in the same panel. */
const EXPLORE_ITEMS = ['mountain', 'attack', 'luck'];
/* The visualisations that follow the rewind slider: they read one day's
   report. The rest take a whole season or every season, or carry time along
   an axis of their own, which the slider would only cut short. */
const EXPLORE_REWIND = new Set(['attack', 'luck']);

function exploreThumb(id) {
  const svg = svgEl('svg', { class: 'explore-card__thumb', viewBox: '0 0 160 90', 'aria-hidden': 'true' });
  if (id === 'mountain') {
    // A stepped peak, darker towards the top, like the stack it opens.
    [1, 2, 3, 5, 7, 9, 8, 6, 5, 3, 2, 1].forEach((height, column) => {
      for (let level = 0; level < height; level += 1) {
        svg.appendChild(svgEl('rect', {
          x: 20 + column * 10, y: 80 - (level + 1) * 7.5, width: 9, height: 6.5, rx: 1,
          style: `fill: var(--seq-${Math.min(SEQ_STEPS, level + 1)})`,
        }));
      }
    });
  } else if (id === 'luck') {
    // Bars either side of zero, longest at the ends.
    svg.appendChild(svgEl('line', { class: 'explore-thumb__avg', x1: 80, x2: 80, y1: 6, y2: 84 }));
    [34, 24, 15, 8, -6, -12, -22, -31].forEach((v, i) => {
      svg.appendChild(svgEl('rect', {
        x: v >= 0 ? 80 : 80 + v, y: 9 + i * 9.5, width: Math.abs(v), height: 6.5, rx: 1.5,
        style: `fill: var(${v >= 0 ? '--outcome-good' : '--outcome-bad'})`,
      }));
    });
  } else {
    svg.appendChild(svgEl('line', { class: 'explore-thumb__avg', x1: 82, x2: 82, y1: 10, y2: 80 }));
    svg.appendChild(svgEl('line', { class: 'explore-thumb__avg', x1: 16, x2: 144, y1: 46, y2: 46 }));
    for (const [x, y] of [[128, 20], [112, 30], [98, 18], [90, 54], [72, 36], [62, 60], [54, 28], [40, 68], [118, 62], [34, 44], [76, 72], [104, 40]]) {
      svg.appendChild(svgEl('circle', { cx: x, cy: y, r: 5.5, style: `fill: ${seqColor((x - y + 40) / 140)}` }));
    }
  }
  return svg;
}

function openExplore(id) {
  state.exploreItem = id;
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderExplore(report) {
  const item = EXPLORE_ITEMS.includes(state.exploreItem) ? state.exploreItem : null;
  $('#explore-title').textContent = t(item ? `explore.${item}.title` : 'explore.title');
  $('#explore-desc').textContent = t(item ? `explore.${item}.desc` : 'explore.desc');
  const back = $('#explore-back');
  back.hidden = !item;
  back.onclick = () => openExplore(null);
  const body = $('#explore-body');
  if (item !== 'mountain') mountainStop();
  if (item === 'mountain') return renderMountain(report, body);
  if (item === 'attack') return renderAttackMap(report, body);
  if (item === 'luck') return renderLuck(report, body);
  const gallery = el('div', 'explore-gallery');
  for (const id of EXPLORE_ITEMS) {
    const card = el('button', 'explore-card');
    card.type = 'button';
    card.appendChild(exploreThumb(id));
    card.appendChild(el('span', 'explore-card__title', t(`explore.${id}.title`)));
    card.appendChild(el('span', 'explore-card__desc', t(`explore.${id}.desc`)));
    card.addEventListener('click', () => openExplore(id));
    gallery.appendChild(card);
  }
  body.replaceChildren(gallery);
}

/* Key figures under a visualisation: each a number, what it is, and one
   sentence on how to read it. */
function exploreFacts(facts) {
  const box = el('div', 'explore-facts');
  box.appendChild(el('h3', 'explore-facts__title', t('explore.facts')));
  const grid = el('div', 'explore-facts__grid');
  for (const { value, label, text } of facts) {
    const fact = el('div', 'explore-fact');
    fact.appendChild(el('b', 'explore-fact__value', value));
    fact.appendChild(el('span', 'explore-fact__label', label));
    fact.appendChild(el('p', 'explore-fact__text', text));
    grid.appendChild(fact);
  }
  box.appendChild(grid);
  return box;
}

/* Each club where its expected goals put it: chances made across, chances
   given up down with the fewest at the top, crossed at the division average. */
function renderAttackMap(report, body) {
  const rows = report.table.filter((row) => row.attack != null && row.defence != null);
  if (!rows.length) {
    body.replaceChildren(el('p', 'explore-empty', t('attack.empty')));
    return;
  }
  const wrap = el('div', 'attack-map');
  const svg = svgEl('svg', { class: 'chart', role: 'group', 'aria-label': t('attack.aria') });
  wrap.appendChild(svg);
  body.replaceChildren(wrap);

  const box = wrap.getBoundingClientRect().width || 940;
  const narrow = box < SHAPE_NARROW;
  const width = narrow ? Math.round(box) : 940;
  const height = narrow ? width : 540;
  const pad = narrow ? { top: 30, right: 14, bottom: 34, left: 38 } : { top: 34, right: 24, bottom: 40, left: 48 };
  const crest = narrow ? 24 : 32;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const step = narrow ? 0.5 : 0.25;
  const domain = (values) => [
    Math.floor((Math.min(...values) - 0.1) / step) * step,
    Math.ceil((Math.max(...values) + 0.1) / step) * step,
  ];
  const [a0, a1] = domain(rows.map((row) => row.attack));
  const [d0, d1] = domain(rows.map((row) => row.defence));
  const right = width - pad.right;
  const bottom = height - pad.bottom;
  const x = (value) => pad.left + ((value - a0) / (a1 - a0)) * (right - pad.left);
  const y = (value) => pad.top + ((value - d0) / (d1 - d0)) * (bottom - pad.top);
  const text = (className, content, attrs) => {
    const node = svgEl('text', { class: className, ...attrs });
    node.textContent = content;
    svg.appendChild(node);
  };

  for (let i = 0; a0 + i * step <= a1 + 1e-9; i += 1) {
    const value = a0 + i * step;
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: x(value), x2: x(value), y1: pad.top, y2: bottom }));
    text('tick', num(value, 2), { x: x(value), y: bottom + 14, 'text-anchor': 'middle' });
  }
  for (let i = 0; d0 + i * step <= d1 + 1e-9; i += 1) {
    const value = d0 + i * step;
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: pad.left, x2: right, y1: y(value), y2: y(value) }));
    text('tick', num(value, 2), { x: pad.left - 6, y: y(value) + 3.5, 'text-anchor': 'end' });
  }

  const mean = (key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
  // The division's trend: a best fit through the clubs, by orthogonal
  // regression since neither axis is the outcome of the other. Along it, how
  // good a club is overall; above it, a club defends better than its attack
  // would suggest, below it, the other way round.
  const [ma, md] = [mean('attack'), mean('defence')];
  let [sxx, syy, sxy] = [0, 0, 0];
  for (const row of rows) {
    const [da, dd] = [row.attack - ma, row.defence - md];
    sxx += da * da;
    syy += dd * dd;
    sxy += da * dd;
  }
  const fit = sxy ? (syy - sxx + Math.hypot(syy - sxx, 2 * sxy)) / (2 * sxy) : 0;

  // Reference lines, defence = slope * attack + offset. Each label runs along
  // its line, at the stretch furthest from the crests and the corner labels.
  const diagonals = fit ? [[fit, md - fit * ma, 'attack-map__even', t('attack.trend')]] : [];
  const obstacles = rows.map((row) => [x(row.attack), y(row.defence)]);
  for (const [cx, cy, dir] of [[pad.left, pad.top + 10, 1], [right, bottom - 12, -1]]) {
    for (let s = 0; s <= 240; s += 30) obstacles.push([cx + dir * s, cy]);
  }
  for (const [slope, offset, className, content] of diagonals) {
    const defenceAt = (attack) => slope * attack + offset;
    const [e0, e1] = [(d0 - offset) / slope, (d1 - offset) / slope]; // where it leaves the defence range
    const lo = Math.max(a0, Math.min(e0, e1));
    const hi = Math.min(a1, Math.max(e0, e1));
    if (lo >= hi) continue;
    const [x1, y1, x2, y2] = [x(lo), y(defenceAt(lo)), x(hi), y(defenceAt(hi))];
    svg.appendChild(svgEl('line', { class: className, x1, y1, x2, y2 }));
    const label = svgEl('text', { class: 'attack-map__diag' });
    label.textContent = content;
    svg.appendChild(label);
    const length = label.getComputedTextLength();
    const span = Math.hypot(x2 - x1, y2 - y1);
    const [ux, uy] = [(x2 - x1) / span, (y2 - y1) / span];
    let best = null;
    for (let f = 0.03; f * span + length <= 0.97 * span; f += 0.02) {
      const [sx, sy] = [x1 + ux * f * span, y1 + uy * f * span];
      let clearance = Infinity;
      for (let s = 0; s <= length; s += length / 4 || 1) {
        for (const [ox, oy] of obstacles) clearance = Math.min(clearance, Math.hypot(sx + ux * s - ox, sy + uy * s - oy));
      }
      if (!best || clearance > best.clearance) best = { clearance, sx, sy };
    }
    if (!best) { label.remove(); continue; }
    const angle = (Math.atan2(uy, ux) * 180) / Math.PI;
    label.setAttribute('x', best.sx);
    label.setAttribute('y', best.sy - 5);
    label.setAttribute('transform', `rotate(${angle.toFixed(2)} ${best.sx} ${best.sy})`);
  }
  // The two sides of the trend, in the corners each one points to.
  text('attack-map__quad', t('attack.side.defence'), { x: pad.left + 6, y: pad.top + 14 });
  text('attack-map__quad', t('attack.side.attack'), { x: right - 6, y: bottom - 8, 'text-anchor': 'end' });
  // Which way is better, next to what each axis measures.
  const guide = (attrs, parts) => {
    const node = svgEl('text', attrs);
    parts.forEach(([className, content], i) => {
      const span = svgEl('tspan', { class: className, dx: i ? 8 : 0 });
      span.textContent = content;
      node.appendChild(span);
    });
    svg.appendChild(node);
  };
  guide({ x: right, y: height - 6, 'text-anchor': 'end' }, [['axis-title', t('attack.x')], ['attack-map__guide', t('attack.betterAttack')]]);
  guide({ x: pad.left, y: pad.top - 12 }, [['attack-map__guide', t('attack.betterDefence')], ['axis-title', t('attack.y')]]);

  // Which side of the trend a club is on, read along the axis that side is
  // better on: above it, how much less it concedes than the trend gives its
  // attack; below it, how much more it creates than the trend gives its
  // defence. `distance`, square to the line, ranks both sides alike.
  const balanceOf = (row) => {
    const conceded = md + fit * (row.attack - ma) - row.defence;
    const distance = conceded / Math.hypot(1, fit);
    return conceded > 0
      ? { side: 'defence', distance, v: conceded }
      : { side: 'attack', distance, v: row.attack - ma - (row.defence - md) / fit };
  };
  const balanceText = (b) => t(b.side === 'defence' ? 'attack.balanceDefence' : 'attack.balanceAttack', { v: num(b.v, 2) });

  for (const row of rows) {
    const cx = x(row.attack);
    const cy = y(row.defence);
    const tip = t('attack.tip', { for: num(row.attack, 2), against: num(row.defence, 2) });
    let balance = '';
    if (fit) {
      const b = balanceOf(row);
      balance = Math.abs(b.distance) < 0.05 ? t('attack.balanced') : balanceText(b);
    }
    const lines = [tip, balance].filter(Boolean);
    const club = svgEl('g', { class: 'attack-map__club', tabindex: 0, role: 'button', 'aria-label': `${row.team}: ${lines.join('. ')}` });
    club.appendChild(svgEl('circle', { cx, cy, r: crest / 2 + 2 }));
    club.appendChild(svgEl('image', { href: `/logos/${row.team_id}.webp`, x: cx - crest / 2, y: cy - crest / 2, width: crest, height: crest }));
    attachTip(club, `<b>${row.team}</b><br>${lines.join('<br>')}`);
    club.addEventListener('click', () => openTeamView(row.team_id, row.team));
    club.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openTeamView(row.team_id, row.team);
    });
    svg.appendChild(club);
  }

  if (!fit) return;
  const ranked = [...rows].sort((a, b) => balanceOf(b).distance - balanceOf(a).distance);
  const [defenceLed, attackLed] = [ranked[0], ranked[ranked.length - 1]];
  wrap.appendChild(exploreFacts([
    { value: num(Math.abs(fit), 2), label: t('attack.fact.slope'), text: t('attack.fact.slopeText', { v: num(Math.abs(fit), 2) }) },
    { value: num(sxy / Math.sqrt(sxx * syy), 2), label: t('attack.fact.r'), text: t('attack.fact.rText') },
    { value: attackLed.team, label: t('attack.fact.attack'), text: `${balanceText(balanceOf(attackLed))}.` },
    { value: defenceLed.team, label: t('attack.fact.defence'), text: `${balanceText(balanceOf(defenceLed))}.` },
  ]));
}

/* ---------- explore: shared by the further views ---------------------- */

/* One fetch per report file, kept for the page's life: the season mountain's
   layers, the scorecard's seasons and the time-axis views' other days. */
const fetchedReport = (url) => {
  if (!mountainReports.has(url)) {
    mountainReports.set(url, fetch(url)
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .catch((error) => { mountainReports.delete(url); throw error; }));
  }
  return mountainReports.get(url);
};

/* The views with a time axis of their own carry time across the chart, so
   they take no rewind: they read the season's latest report, not a rewound
   one. A finished season has nothing left to run in, so the ones that look
   ahead (`runIn`) stand where its last RUN_IN_ROUNDS rounds began, the point
   from which pipeline.py marks the decisive matches. */
const RUN_IN_ROUNDS = 10;
let timeAxisToken = 0;

/* The first matchday with at most RUN_IN_ROUNDS rounds' worth of matches
   left, or null. */
function runInStart(report) {
  const total = report.model.matches_played + report.model.matches_remaining;
  const left = RUN_IN_ROUNDS * Math.floor(report.table.length / 2);
  const day = (report.league.matchdays || []).find((d) => !d.preseason && total - d.matches_played <= left);
  return day ? day.date : null;
}

async function renderTimeAxis(item, report, body, draw, runIn) {
  const token = ++timeAxisToken;
  const { season, slug } = report.league;
  let shown = report;
  let from = null;
  try {
    if (state.asof) shown = applyShortNames(await fetchedReport(reportUrl(season)))[slug];
    from = runIn && !shown.model.matches_remaining ? runInStart(shown) : null;
    if (from) shown = applyShortNames(await fetchedReport(reportUrl(season, from)))[slug];
  } catch (error) {
    if (token === timeAxisToken) body.replaceChildren(el('p', 'explore-empty', t('status.couldNotLoad', { season, error: error.message })));
    return;
  }
  if (token !== timeAxisToken || state.activeView !== 'explore' || state.exploreItem !== item) return;
  draw(shown, body);
  if (from && !body.firstChild.matches('.explore-empty')) {
    body.firstChild.prepend(el('p', 'explore-note explore-note--lead', t('explore.runInFrom', { date: whenDate(from) })));
  }
}

/* ---------- explore: luck table (viz=luck) ----------------------------- */

/* Expected points from one match's xG: each side's goals Poisson at its xG,
   summed to 12 goals and normalised (as model.elo.xg_implied_score). */
function xgPoints(homeXg, awayXg) {
  let [ph, pa] = [Math.exp(-homeXg), Math.exp(-awayXg)];
  let [below, home, draw, homeMass] = [0, 0, 0, 0];
  for (let k = 0; k <= 12; k += 1) {
    if (k) {
      ph *= homeXg / k;
      pa *= awayXg / k;
    }
    home += ph * below;
    draw += ph * pa;
    below += pa;
    homeMass += ph;
  }
  const mass = homeMass * below;
  [home, draw] = [home / mass, draw / mass];
  return [3 * home + draw, 3 * (1 - home - draw) + draw];
}

/* Before each match its chances are scaled by each side's recent finishing
   (goals against xG over its last LUCK_FINISHING matches in the division) and
   the other side's recent keeping (xG on target faced against goals let in,
   last LUCK_KEEPING matches with xG on target), each against the division's
   last LUCK_LEAGUE club matches, from LUCK_FINISHING / 2 and LUCK_KEEPING / 2
   matches on. Swept over Eliteserien 2021-2025 (PROJECT_STATUS.md, "Luck:
   finishing and keeping in the chances"): -17.3 in mean squared luck a club
   season (t -3.0), the trend a third flatter. */
const LUCK_FINISHING = 20;
const LUCK_KEEPING = 10;
const LUCK_LEAGUE = 240;

/* match id -> [home, away] xG points from the chances scaled by finishing
   and keeping, as they stood before the match. `results` are one division's,
   over as many seasons as there are, so a season starts from the last one's
   form. Matches without xG are skipped; without xG on target, keeping is. */
function luckChances(results) {
  const played = results.filter((r) => r.home_goals != null && r.xg)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.home_id < b.home_id ? -1 : a.home_id > b.home_id ? 1 : 0));
  const clubs = new Map();  // team -> recent [goals, xg, conceded, xG on target faced or null]
  let league = [];
  const ratio = (rows, top, bottom) => {
    const [a, b] = [rows.reduce((sum, row) => sum + row[top], 0), rows.reduce((sum, row) => sum + row[bottom], 0)];
    return a > 0 && b > 0 ? Math.log(a / b) : null;
  };
  // Finishing reads (goals, xG); keeping (xG on target faced, conceded).
  const form = (team, n, top, bottom, reference) => {
    const rows = (clubs.get(team) || []).filter((row) => row[3] != null || top !== 3).slice(-n);
    if (rows.length < Math.floor(n / 2) || reference == null) return 0;
    const mine = ratio(rows, top, bottom);
    return mine == null ? 0 : mine - reference;
  };
  const out = new Map();
  for (const r of played) {
    const finishing = ratio(league, 0, 1);
    const keeping = ratio(league.filter((row) => row[3] != null), 3, 2);
    const [home, away] = [r.home_id, r.away_id];
    const lam = r.xg[0] * Math.exp(form(home, LUCK_FINISHING, 0, 1, finishing) - form(away, LUCK_KEEPING, 3, 2, keeping));
    const mu = r.xg[1] * Math.exp(form(away, LUCK_FINISHING, 0, 1, finishing) - form(home, LUCK_KEEPING, 3, 2, keeping));
    out.set(r.match_id, xgPoints(lam, mu));
    const sides = [
      [home, [r.home_goals, r.xg[0], r.away_goals, r.xgot ? r.xgot[1] : null]],
      [away, [r.away_goals, r.xg[1], r.home_goals, r.xgot ? r.xgot[0] : null]],
    ];
    for (const [team, row] of sides) {
      const rows = clubs.get(team) || [];
      rows.push(row);
      clubs.set(team, rows.slice(-200));
      league.push(row);
    }
    league = league.slice(-LUCK_LEAGUE);
  }
  return out;
}

/* Per club, over the played matches that have xG: its points, the points its
   xG would have earned on average (`xpts`), the same from the chances scaled
   by finishing and keeping (`chances`, from `luckChances`; the plain xG
   points where a match is missing from it) and the gap to those (`gap`). */
function luckRows(results, chances = new Map()) {
  const rows = new Map();
  for (const r of results) {
    if (r.home_goals == null || !r.xg) continue;
    const plain = xgPoints(r.xg[0], r.xg[1]);
    const scaled = chances.get(r.match_id) || plain;
    const sides = [
      [r.home_id, r.home, r.home_goals, r.away_goals, plain[0], scaled[0]],
      [r.away_id, r.away, r.away_goals, r.home_goals, plain[1], scaled[1]],
    ];
    for (const [id, team, scored, conceded, xpts, scaledPoints] of sides) {
      const row = rows.get(id) || { team_id: id, team, matches: 0, points: 0, xpts: 0, chances: 0 };
      row.matches += 1;
      row.points += scored > conceded ? 3 : scored === conceded ? 1 : 0;
      row.xpts += xpts;
      row.chances += scaledPoints;
      rows.set(id, row);
    }
  }
  return [...rows.values()]
    .map((row) => ({ ...row, form: row.chances - row.xpts, above: row.points - row.xpts, gap: row.points - row.chances }))
    .sort((a, b) => b.gap - a.gap || a.team.localeCompare(b.team));
}

/* The trend luck is measured against: better sides take more points than
   even their scaled chances, so the gap a match is fitted, least squares, on
   xG points a match over the counted club seasons (`a + b * xpts /
   matches`). Null with too few to fit. */
function luckTrend(rows) {
  if (rows.length < 3) return null;
  const [xs, ys] = [rows.map((row) => row.xpts / row.matches), rows.map((row) => row.gap / row.matches)];
  const mean = (list) => list.reduce((sum, v) => sum + v, 0) / list.length;
  const [mx, my] = [mean(xs), mean(ys)];
  const sxx = xs.reduce((sum, v) => sum + (v - mx) ** 2, 0);
  const b = sxx ? xs.reduce((sum, v, i) => sum + (v - mx) * (ys[i] - my), 0) / sxx : 0;
  return { a: my - b * mx, b };
}

/* A club's luck: points against what such chances usually earn (`usual`:
   the scaled chances plus the trend over its matches, `trendPoints`).
   Without a trend, against the scaled chances alone. */
function withTrend(row, trend) {
  const trendPoints = trend ? row.matches * trend.a + trend.b * row.xpts : 0;
  const usual = row.chances + trendPoints;
  return { ...row, trendPoints, usual, luck: row.points - usual };
}

/* One line under a club's luck: what its usual points are made of. */
const luckUsualText = (row) => t('luck.tipUsual', {
  xpts: num(row.xpts, 1), form: signed(row.form, 1), trend: signed(row.trendPoints, 1),
});

/* The season's table needs the form before each match (from the seasons
   before too) and the trend (every counted season of the division): all are
   drawn from one fetch of the seasons' reports, kept for the page's life, so
   a rewind redraws at once. */
let luckToken = 0;

async function renderLuck(report, body) {
  const token = ++luckToken;
  const { slug, seasons = [] } = report.league;
  if (!body.querySelector('.luck')) body.replaceChildren(el('p', 'explore-empty', t('luck.all.loading')));
  const reports = await Promise.all(seasons.map((season) =>
    fetchedReport(reportUrl(season)).then((all) => applyShortNames(all)[slug]).catch(() => null)));
  if (token !== luckToken || state.activeView !== 'explore' || state.exploreItem !== 'luck') return;
  const loaded = reports.filter((r) => r && r.results);
  const chances = luckChances(loaded.flatMap((r) => r.results));
  const history = luckSeasons(loaded, chances);
  const trend = luckTrend(history.rows);
  history.rows = history.rows.map((row) => withTrend(row, trend));
  const rows = luckRows(report.results || [], chances).map((row) => withTrend(row, trend))
    .sort((a, b) => b.luck - a.luck || a.team.localeCompare(b.team));
  const wrap = el('div', 'luck');
  body.replaceChildren(wrap);
  const keeping = (report.results || []).some((r) => r.xgot);
  wrap.appendChild(luckHow(trend, history, keeping));
  if (rows.length) drawLuckSeason(report, wrap, rows);
  else wrap.appendChild(el('p', 'explore-empty', t('luck.empty')));
  const across = el('section', 'luck-all');
  wrap.appendChild(across);
  drawLuckSeasons(report, across, history, trend);
}

/* What the luck is measured against, step by step, above the table. */
function luckHow(trend, history, keeping) {
  const box = el('details', 'luck-how');
  box.open = true;
  box.appendChild(el('summary', 'luck-how__title', t('luck.how.title')));
  const steps = el('ol', 'luck-how__steps');
  const list = seasonSpan(history.counted.map((c) => c.season));
  for (const text of [
    t('luck.how.chances'),
    keeping
      ? t('luck.how.form', { fin: LUCK_FINISHING, keep: LUCK_KEEPING })
      : t('luck.how.formNoKeeping', { fin: LUCK_FINISHING }),
    trend ? t('luck.how.trend', { list }) : t('luck.how.noTrend'),
    t('luck.how.luck'),
  ]) {
    // Each step leads with its name ("The chances."), set in bold.
    const [lead, ...rest] = text.split('. ');
    const item = el('li');
    item.append(el('b', null, `${lead}.`), ` ${rest.join('. ')}`);
    steps.appendChild(item);
  }
  box.appendChild(steps);
  return box;
}

function drawLuckSeason(report, wrap, rows) {
  const svg = svgEl('svg', { class: 'chart', role: 'group', 'aria-label': t('luck.aria') });
  wrap.appendChild(svg);
  const box = wrap.getBoundingClientRect().width || 940;
  const narrow = box < SHAPE_NARROW;
  const width = narrow ? Math.round(box) : 940;
  const rowHeight = 26;
  const pad = { top: 26, bottom: 30, left: narrow ? 132 : 180, right: 46 };
  const height = pad.top + rows.length * rowHeight + pad.bottom;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const reach = Math.max(3, Math.ceil(Math.max(...rows.map((row) => Math.abs(row.luck))) / 2) * 2);
  const x = (value) => pad.left + ((value + reach) / (2 * reach)) * (width - pad.left - pad.right);
  const text = (className, content, attrs) => {
    const node = svgEl('text', { class: className, ...attrs });
    node.textContent = content;
    svg.appendChild(node);
    return node;
  };
  const step = reach > 8 ? 4 : 2;
  for (let v = -reach; v <= reach; v += step) {
    svg.appendChild(svgEl('line', { class: v ? 'grid-line' : 'axis-line', x1: x(v), x2: x(v), y1: pad.top - 6, y2: height - pad.bottom }));
    text('tick', signed(v, 0), { x: x(v), y: height - pad.bottom + 14, 'text-anchor': 'middle' });
  }
  text('axis-title', t(narrow ? 'luck.xShort' : 'luck.x'), { x: width - pad.right, y: height - 4, 'text-anchor': 'end' });
  // Both sides' labels share one line, so phones get the short ones.
  text('luck__side', t(narrow ? 'luck.unluckyShort' : 'luck.unlucky'), { x: x(-reach), y: pad.top - 10 });
  text('luck__side', t(narrow ? 'luck.luckyShort' : 'luck.lucky'), { x: x(reach), y: pad.top - 10, 'text-anchor': 'end' });
  text('luck__side', t('luck.place'), { x: 18, y: pad.top - 10, 'text-anchor': 'end' });

  // The table place beside each name, so the lucky can be seen near the top.
  const place = new Map((report.table || []).map((row) => [row.team_id, row.position]));
  rows.forEach((row, i) => {
    const top = pad.top + i * rowHeight;
    const g = svgEl('g', { class: 'luck__row', tabindex: 0, role: 'button' });
    const [a, b] = [x(0), x(row.luck)];
    g.appendChild(svgEl('rect', {
      class: `luck__bar ${row.luck >= 0 ? 'luck__bar--up' : 'luck__bar--down'}`,
      x: Math.min(a, b), y: top + 5, width: Math.max(1, Math.abs(b - a)), height: rowHeight - 10, rx: 3,
    }));
    const rank = svgEl('text', { class: 'luck__place', x: 18, y: top + 17, 'text-anchor': 'end' });
    rank.textContent = place.get(row.team_id) ?? '';
    g.appendChild(rank);
    g.appendChild(svgEl('image', { href: `/logos/${row.team_id}.webp`, x: 24, y: top + 3, width: 20, height: 20 }));
    const name = svgEl('text', { class: 'luck__name', x: 50, y: top + 17 });
    name.textContent = shortName(row.team);
    g.appendChild(name);
    const value = svgEl('text', {
      class: 'luck__value', y: top + 17,
      x: row.luck >= 0 ? b + 5 : b - 5, 'text-anchor': row.luck >= 0 ? 'start' : 'end',
    });
    value.textContent = signed(row.luck, 1);
    g.appendChild(value);
    const tip = t('luck.tip', { points: row.points, usual: num(row.usual, 1), luck: signed(row.luck, 1), n: row.matches });
    g.setAttribute('aria-label', `${row.team}: ${tip}. ${luckUsualText(row)}`);
    attachTip(g, `<b>${row.team}</b><br>${tip}<br>${luckUsualText(row)}`);
    g.addEventListener('click', () => openTeamView(row.team_id, row.team));
    g.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openTeamView(row.team_id, row.team);
    });
    svg.appendChild(g);
  });

  const played = (report.results || []).filter((r) => r.home_goals != null).length;
  const withXg = (report.results || []).filter((r) => r.home_goals != null && r.xg).length;
  const [lucky, unlucky] = [rows[0], rows[rows.length - 1]];
  const chances = rows.reduce((best, row) => (row.xpts > best.xpts ? row : best));
  const leader = rows.find((row) => place.get(row.team_id) === 1);
  const moved = (name, row) => t(name, { luck: signed(row.luck, 1), usual: num(row.usual, 1), points: row.points });
  wrap.appendChild(exploreFacts([
    { value: lucky.team, label: t('luck.fact.lucky'), text: moved('luck.fact.luckyText', lucky) },
    { value: unlucky.team, label: t('luck.fact.unlucky'), text: moved('luck.fact.unluckyText', unlucky) },
    {
      value: chances.team,
      label: t('luck.fact.chances'),
      text: !leader || leader === chances
        ? t('luck.fact.chancesLead', { xpts: num(chances.xpts, 1) })
        : t('luck.fact.chancesBehind', { xpts: num(chances.xpts, 1), team: leader.team, luck: signed(leader.luck, 1) }),
    },
    { value: t('luck.fact.coverageValue', { n: withXg, of: played }), label: t('luck.fact.coverage'), text: t('luck.fact.coverageText') },
  ]));
}

/* A season counts across the seasons once it is over and expected goals
   cover this share of its matches (OBOS-ligaen 2023 has 221 of 240). */
const LUCK_XG_SHARE = 0.9;
/* The luck that "lasts": clubs with this many points of luck. */
const LUCK_CARRY = 5;

/* Every counted season of one division as club seasons (the luck table at
   the final whistle, with the final place), and the seasons counted. */
function luckSeasons(reports, chances = new Map()) {
  const counted = [];
  const rows = [];
  for (const report of reports) {
    const played = report.results.filter((r) => r.home_goals != null);
    const withXg = played.filter((r) => r.xg).length;
    if (report.model.matches_remaining || !played.length || withXg < LUCK_XG_SHARE * played.length) continue;
    const { season } = report.league;
    const place = new Map(report.table.map((row) => [row.team_id, row.position]));
    counted.push({ season, matches: withXg, of: played.length });
    for (const row of luckRows(report.results, chances)) rows.push({ ...row, season, place: place.get(row.team_id) });
  }
  return { counted, rows };
}

/* What the club seasons say, rows carrying their luck (`withTrend`): the
   points above plain xG points by rank on xG points (the top and bottom
   quarter: good sides beat their chances) and what the top quarter's comes
   from, the champions' luck, the luckiest and unluckiest, and how much luck
   is left the season after. */
function luckSummary(rows) {
  const bySeason = new Map();
  for (const row of rows) bySeason.set(row.season, [...(bySeason.get(row.season) || []), row]);
  const mean = (list) => list.reduce((sum, v) => sum + v, 0) / list.length;
  const [top, middle, bottom, champions] = [[], [], [], []];
  let quarter = 0;
  for (const list of bySeason.values()) {
    const ranked = [...list].sort((a, b) => b.xpts - a.xpts);
    quarter = Math.round(ranked.length / 4);
    ranked.forEach((row, i) => {
      (i < quarter ? top : i >= ranked.length - quarter ? bottom : middle).push(row);
      if (row.place === 1) champions.push({ ...row, mostChances: i === 0 });
    });
  }
  const byLuck = [...rows].sort((a, b) => b.luck - a.luck);
  const seasons = new Map(rows.map((row) => [`${row.team_id} ${row.season}`, row]));
  const carried = rows
    .filter((row) => row.luck >= LUCK_CARRY && seasons.has(`${row.team_id} ${row.season + 1}`))
    .map((row) => [row.luck, seasons.get(`${row.team_id} ${row.season + 1}`).luck]);
  const aboveOf = (list) => mean(list.map((row) => row.above));
  return {
    champions,
    quarter,
    top: aboveOf(top),
    topSplit: Object.fromEntries(['form', 'trendPoints', 'luck'].map((part) => [part, mean(top.map((row) => row[part]))])),
    middle: aboveOf(middle),
    bottom: aboveOf(bottom),
    luckiest: byLuck[0],
    unluckiest: byLuck[byLuck.length - 1],
    carried: carried.length ? { n: carried.length, before: mean(carried.map(([a]) => a)), after: mean(carried.map(([, b]) => b)) } : null,
  };
}

/* Seasons as a short list: a run of years as a span, "2020–2025". */
function seasonSpan(seasons) {
  const runs = [];
  for (const season of seasons) {
    const last = runs[runs.length - 1];
    if (last && season === last[1] + 1) last[1] = season;
    else runs.push([season, season]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}

/* Under the season's table: every counted season of the division at once,
   whatever the hero shows: whether good sides have more luck, and the trend
   the table's luck is measured against. */
function drawLuckSeasons(report, section, { counted, rows }, trend) {
  const { slug, seasons = [] } = report.league;
  section.appendChild(el('h3', 'luck-all__title', t('luck.all.title')));
  const why = t(`luck.all.why.${slug}`);
  const list = new Intl.ListFormat(localeNumber(), { type: 'conjunction' });
  const notes = [t('luck.all.seasons', { n: counted.length, list: seasonSpan(counted.map((c) => c.season)), clubs: rows.length })];
  const partial = counted.filter((c) => c.matches < c.of);
  if (partial.length) {
    notes.push(t('luck.all.partial', { list: list.format(partial.map((c) => t('luck.all.partialSeason', { season: c.season, n: c.matches, of: c.of }))) }));
  }
  notes.push(why === `luck.all.why.${slug}` ? t('luck.all.whyAny') : why);
  const running = seasons.find((season) => season === report.league.current_season && !counted.some((c) => c.season === season));
  if (running && rows.length) notes.push(t('luck.all.running', { season: running }));
  if (!trend) {
    section.append(el('p', 'explore-note explore-note--lead', `${t('luck.all.empty')} ${notes.slice(1).join(' ')}`));
    return;
  }
  section.appendChild(el('p', 'explore-note explore-note--lead', notes.join(' ')));

  const svg = svgEl('svg', { class: 'chart', role: 'group', 'aria-label': t('luck.all.aria') });
  section.appendChild(svg);
  const box = section.getBoundingClientRect().width || 940;
  const narrow = box < SHAPE_NARROW;
  const width = narrow ? Math.round(box) : 940;
  const height = narrow ? 300 : 380;
  const pad = { top: 22, right: 16, bottom: 34, left: 34 };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const reachY = Math.max(5, Math.ceil(Math.max(...rows.map((row) => Math.abs(row.gap))) / 5) * 5);
  const [loX, hiX] = [Math.floor(Math.min(...rows.map((row) => row.xpts)) / 10) * 10, Math.ceil(Math.max(...rows.map((row) => row.xpts)) / 10) * 10];
  const x = (value) => pad.left + ((value - loX) / (hiX - loX || 1)) * (width - pad.left - pad.right);
  const y = (value) => pad.top + ((reachY - value) / (2 * reachY)) * (height - pad.top - pad.bottom);
  const text = (className, content, attrs) => {
    const node = svgEl('text', { class: className, ...attrs });
    node.textContent = content;
    svg.appendChild(node);
  };
  for (let v = -reachY; v <= reachY; v += 5) {
    svg.appendChild(svgEl('line', { class: v ? 'grid-line' : 'axis-line', x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }));
    text('tick', signed(v, 0), { x: pad.left - 6, y: y(v) + 3.5, 'text-anchor': 'end' });
  }
  for (let v = loX; v <= hiX; v += 10) {
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: x(v), x2: x(v), y1: pad.top, y2: height - pad.bottom }));
    text('tick', num(v, 0), { x: x(v), y: height - pad.bottom + 14, 'text-anchor': 'middle' });
  }
  text('axis-title', t('luck.all.x'), { x: width - pad.right, y: height - 4, 'text-anchor': 'end' });
  text('axis-title', t('luck.all.y'), { x: pad.left, y: pad.top - 8 });

  // The trend in season totals, over the club seasons' usual length.
  const matches = rows.reduce((sum, row) => sum + row.matches, 0) / rows.length;
  const line = (xpts) => matches * trend.a + trend.b * xpts;
  svg.appendChild(svgEl('line', { class: 'luck-all__trend', x1: x(loX), y1: y(line(loX)), x2: x(hiX), y2: y(line(hiX)) }));
  text('luck-all__trend-label', t('luck.all.trend'), { x: x(hiX) - 4, y: y(line(hiX)) - 6, 'text-anchor': 'end' });

  // The season the hero shows on top of the rest, the champions on top of all.
  const shown = report.league.season;
  const finish = (row) => (row.place === 1 ? t('luck.all.champion') : t('luck.all.finished', { place: row.place }));
  const order = [...rows].sort((a, b) => (a.place === 1) - (b.place === 1) || (a.season === shown) - (b.season === shown));
  for (const row of order) {
    const champion = row.place === 1;
    const g = svgEl('g', { class: `luck-all__dot${row.season === shown ? ' luck-all__dot--shown' : ''}${champion ? ' luck-all__dot--champion' : ''}`, tabindex: 0 });
    const [cx, cy] = [x(row.xpts), y(row.gap)];
    g.appendChild(svgEl('circle', { class: 'luck-all__hit', cx, cy, r: 10 }));
    const crest = narrow ? 12 : 16;
    g.appendChild(svgEl('circle', { class: 'luck-all__mark', cx, cy, r: champion ? crest / 2 + 3 : 4 }));
    if (champion) g.appendChild(svgEl('image', { href: `/logos/${row.team_id}.webp`, x: cx - crest / 2, y: cy - crest / 2, width: crest, height: crest }));
    const tip = t('luck.all.tip', { season: row.season, points: row.points, usual: num(row.usual, 1), luck: signed(row.luck, 1), finish: finish(row) });
    g.setAttribute('aria-label', `${row.team} ${tip} ${luckUsualText(row)}`);
    attachTip(g, `<b>${row.team}</b> ${tip}<br>${luckUsualText(row)}`);
    svg.appendChild(g);
  }
  section.appendChild(el('p', 'explore-note', t(counted.some((c) => c.season === shown) ? 'luck.all.legendShown' : 'luck.all.legend', { season: shown })));

  const summary = luckSummary(rows);
  const { champions, luckiest, unluckiest, carried } = summary;
  const behind = champions.filter((c) => !c.mostChances).sort((a, b) => a.season - b.season);
  const average = (part) => signed(champions.reduce((sum, c) => sum + c[part], 0) / champions.length, 1);
  const facts = [
    {
      value: t('luck.all.fact.championsValue', { n: champions.filter((c) => c.luck > 0).length, of: champions.length }),
      label: t('luck.all.fact.champions'),
      text: `${t('luck.all.fact.championsText', { luck: average('luck'), above: average('above') })} ${behind.length
        ? t('luck.all.fact.behind', { clubs: list.format(behind.map((c) => `${c.team} ${c.season}`)) })
        : t('luck.all.fact.allAhead')}`,
    },
    {
      value: signed(summary.top, 1),
      label: t('luck.all.fact.top', { k: summary.quarter }),
      text: t('luck.all.fact.topText', {
        k: summary.quarter,
        middle: signed(summary.middle, 1),
        bottom: signed(summary.bottom, 1),
        form: signed(summary.topSplit.form, 1),
        trend: signed(summary.topSplit.trendPoints, 1),
        luck: signed(summary.topSplit.luck, 1),
      }),
    },
    ...[['luck.all.fact.luckiest', luckiest], ['luck.all.fact.unluckiest', unluckiest]].map(([label, row]) => ({
      value: `${row.team} ${row.season}`,
      label: t(label),
      text: t('luck.all.fact.seasonText', { points: row.points, usual: num(row.usual, 1), luck: signed(row.luck, 1), finish: finish(row) }),
    })),
  ];
  // Too few clubs to say what lasts until a handful have been that lucky.
  if (carried && carried.n >= 5) {
    facts.push({
      value: signed(carried.after, 1),
      label: t('luck.all.fact.next'),
      text: t('luck.all.fact.nextText', { min: LUCK_CARRY, n: carried.n, before: signed(carried.before, 1), after: signed(carried.after, 1) }),
    });
  }
  const box2 = exploreFacts(facts);
  box2.querySelector('.explore-facts__title').textContent = t('luck.all.facts');
  section.appendChild(box2);
}

/* The season mountain, ported from experiments/season_mountain: the finish
   grid is the floor, and every round stacks another layer of finishing-place
   chances on top until the stack narrows into the table. three.js is vendored
   under /vendor and only fetched the first time the mountain opens, so the
   rest of the site stays dependency-free. */
const MOUNTAIN_CUTOFFS = [0.001, 0.0025, 0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2];
const MOUNTAIN_LAYER = 0.3; // height of one round's layer, in grid cells
// Light left at a block corner with 0..3 of its three neighbours open:
// ambient occlusion, darkest in the folds of the stack.
const MOUNTAIN_AO = [0.55, 0.7, 0.85, 1];
const mountain = { root: null, scene: null, key: '', layers: null, teams: null, order: 'finish', cutoff: 2, cutTeam: '', cutPlace: 0, upto: 0, timer: null, raf: null };
const mountainReports = new Map();
let threeLoading = null;
let mountainToken = 0;

function loadThree() {
  threeLoading = threeLoading || ['/vendor/three/three.min.js', '/vendor/three/OrbitControls.js']
    .reduce((previous, src) => previous.then(() => new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    })), Promise.resolve())
    .catch((error) => { threeLoading = null; throw error; });
  return threeLoading;
}

/* Layer k is the first matchday with k rounds' worth of matches played, so a
   postponed match counts where it was played: "~ round k", not round k. The
   pre-season layer is the season's pre-season view (the rewind slider's first
   stop), or the season shape's first snapshot where a build predates those,
   and a season still under way ends in a "now" layer. */
async function mountainLayers(report) {
  const season = report.league.season;
  const perRound = report.table.length / 2;
  const days = report.league.matchdays || [];
  const lastDate = days.length ? days[days.length - 1].date : null;
  const probs = (r) => new Map(r.table.map((row) => [row.team_id, row.position_probabilities]));
  const reportOn = (date) => fetchedReport(reportUrl(season, date));
  const layers = [];
  const preseason = report.league.preseason;
  const history = report.history || {};
  const pre = preseason
    ? await reportOn(preseason).then((r) => ({ kind: 'pre', date: preseason, p: probs(r[report.league.slug]) }), () => null)
    : null;
  if (pre) layers.push(pre);
  else if (history.teams && history.latest_rounds && history.latest_rounds[0] == null) {
    layers.push({ kind: 'pre', date: history.dates[0], p: new Map(history.teams.map((h) => [h.team_id, h.positions[0]])) });
  }
  const rounds = [];
  for (let k = 1; k * perRound <= report.model.matches_played; k += 1) {
    const day = days.find((d) => d.matches_played >= k * perRound);
    if (day) rounds.push({ kind: 'round', k, date: day.date });
  }
  // The report already in hand stands in for its own date.
  const fetched = await Promise.all(rounds.map(({ date }) => (date === lastDate ? null : reportOn(date))));
  rounds.forEach((layer, i) => layers.push({ ...layer, p: probs(fetched[i] ? fetched[i][report.league.slug] : report) }));
  if (lastDate && (!layers.length || layers[layers.length - 1].date !== lastDate)) {
    layers.push({ kind: 'now', date: lastDate, p: probs(report) });
  }
  return layers;
}

function mountainLabel(layer) {
  if (layer.kind === 'pre') return t('mountain.preseason');
  if (layer.kind === 'now') return t('mountain.now');
  return t('mountain.round', { k: layer.k });
}

/* Rows keep one order all season: by the predicted finish now (the default,
   as on the finish grid), by the pre-season prediction, or by the table as it
   stands at the top of the stack. */
function mountainTeams(report, layers) {
  const first = layers[0].p;
  const expected = (id) => (first.get(id) || []).reduce((sum, p, i) => sum + (i + 1) * p, 0);
  const teams = report.table.map((row) => ({ id: row.team_id, name: row.team, now: row.position, expected: expectedFinish(row) }));
  [...teams].sort((a, b) => expected(a.id) - expected(b.id)).forEach((team, i) => { team.predicted = i + 1; });
  [...teams].sort((a, b) => a.expected - b.expected).forEach((team, i) => { team.finish = i + 1; });
  return teams;
}

/* The website's grid stops (HEAT_STOPS), blended smoothly: level 1..7 lands
   exactly on --seq-1..7 at each stop and moves on a log scale between them. */
function heatLevel(p) {
  if (p < HEAT_STOPS[0]) return p / HEAT_STOPS[0];
  for (let i = 1; i < HEAT_STOPS.length; i += 1) {
    if (p < HEAT_STOPS[i]) return i + Math.log(p / HEAT_STOPS[i - 1]) / Math.log(HEAT_STOPS[i] / HEAT_STOPS[i - 1]);
  }
  return HEAT_STOPS.length;
}

function mountainRoot() {
  if (mountain.root) return mountain.root;
  const root = el('div', 'mountain');
  // The stage fills the window; the division and season float along its
  // top, and everything else sits in a popup behind the settings button.
  root.innerHTML = `
    <div class="mountain__stage">
      <canvas></canvas>
      <p class="mountain__status"></p>
      <div class="mountain__top">
        <button type="button" class="mountain__chip mountain__back"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg><span data-i18n="explore.back"></span></button>
        <div class="mountain__where">
          <select class="mountain__select" id="mountain-league"></select>
          <select class="mountain__select" id="mountain-season"></select>
        </div>
        <button type="button" class="mountain__chip mountain__info"><svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.2v4" stroke-linecap="round"/><circle cx="8" cy="4.9" r="0.9" fill="currentColor" stroke="none"/></svg><span data-i18n="explore.facts"></span></button>
      </div>
      <div class="mountain__readout"><b></b><span></span></div>
      <span class="mountain__hint" data-i18n="mountain.hint"></span>
      <div class="mountain__transport">
        <button type="button" class="mountain__play" aria-pressed="false"><svg class="mountain__icon-play" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="currentColor"><path d="M4.5 2.6v10.8L13.5 8z"/></svg><svg class="mountain__icon-pause" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="currentColor"><rect x="3.5" y="2.5" width="3.2" height="11" rx="1"/><rect x="9.3" y="2.5" width="3.2" height="11" rx="1"/></svg><span class="visually-hidden" data-i18n="mountain.play"></span></button>
        <input type="range" id="mountain-upto" min="0" step="1">
      </div>
      <button type="button" class="mountain__chip mountain__gear" popovertarget="mountain-settings" aria-expanded="false"><svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 5h8M3 10h2M9 10h8M3 15h10"/><circle cx="13" cy="5" r="2"/><circle cx="7" cy="10" r="2"/><circle cx="15" cy="15" r="2"/></svg></button>
    </div>
    <div class="mountain__controls" id="mountain-settings" popover>
      <div class="mountain__ctl mountain__ctl--order">
        <span class="mountain__label" data-i18n="mountain.order"></span>
        <div class="table-controls">
          <button type="button" class="table-control-btn" data-order="finish" data-i18n="mountain.byFinish"></button>
          <button type="button" class="table-control-btn" data-order="predicted" data-i18n="mountain.byPrediction"></button>
          <button type="button" class="table-control-btn" data-order="now" data-i18n="mountain.byTable"></button>
        </div>
      </div>
      <div class="mountain__ctl mountain__ctl--cutoff">
        <label class="mountain__label" for="mountain-cutoff"><span data-i18n="mountain.cutoff"></span> <output></output></label>
        <input type="range" id="mountain-cutoff" min="0" max="${MOUNTAIN_CUTOFFS.length - 1}" step="1" value="${mountain.cutoff}">
      </div>
      <div class="mountain__ctl mountain__ctl--cut">
        <span class="mountain__label" data-i18n="mountain.cut"></span>
        <div class="mountain__row">
          <select class="mountain__select" id="mountain-cut-team"></select>
          <select class="mountain__select" id="mountain-cut-place"></select>
        </div>
      </div>
      <div class="mountain__ctl mountain__ctl--reset">
        <span class="mountain__label" data-i18n="mountain.reset"></span>
        <div class="table-controls">
          <button type="button" class="table-control-btn" data-action="reset-view" data-i18n="mountain.resetView"></button>
        </div>
      </div>
    </div>
    <span class="mountain__probe" hidden></span>`;
  const redraw = () => drawMountain();
  root.querySelector('.mountain__back').addEventListener('click', () => openExplore(null));
  root.querySelector('.mountain__info').addEventListener('click', () => {
    if (mountain.facts) openFacts(t('explore.mountain.title'), mountain.facts);
  });
  root.querySelector('#mountain-settings').addEventListener('toggle', (event) => {
    root.querySelector('.mountain__gear').setAttribute('aria-expanded', String(event.newState === 'open'));
  });
  for (const button of root.querySelectorAll('[data-order]')) {
    button.addEventListener('click', () => {
      mountain.order = button.dataset.order;
      redraw();
      if (mountain.cutTeam) frameMountain();
    });
  }
  root.querySelector('#mountain-upto').addEventListener('input', (event) => {
    mountainStop();
    mountain.upto = Number(event.target.value);
    redraw();
  });
  // Division and season go through the hero's own switches, so the rest of
  // the page follows as it would from there.
  root.querySelector('#mountain-league').addEventListener('change', (event) => {
    document.querySelector(`#hero-league-menu [data-league="${event.target.value}"]`)?.click();
  });
  root.querySelector('#mountain-season').addEventListener('change', (event) => {
    const season = Number(event.target.value);
    if (season !== state.season) loadSeason(season);
  });
  root.querySelector('#mountain-cut-team').addEventListener('change', (event) => {
    mountain.cutTeam = event.target.value;
    redraw();
    frameMountain();
  });
  root.querySelector('#mountain-cut-place').addEventListener('change', (event) => {
    mountain.cutPlace = Number(event.target.value);
    redraw();
    frameMountain();
  });
  root.querySelector('#mountain-cutoff').addEventListener('input', (event) => {
    mountain.cutoff = Number(event.target.value);
    redraw();
  });
  root.querySelector('[data-action="reset-view"]').addEventListener('click', () => {
    mountain.order = 'finish';
    mountain.cutoff = 2;
    mountain.cutTeam = '';
    mountain.cutPlace = 0;
    root.querySelector('#mountain-cutoff').value = String(mountain.cutoff);
    root.querySelector('#mountain-cut-team').value = '';
    root.querySelector('#mountain-cut-place').value = '0';
    drawMountain();
    frameMountain({ home: true });
  });
  // While a slider in the popup is held, the popup thins to that slider
  // alone, so the mountain it is changing shows through.
  const settings = root.querySelector('#mountain-settings');
  for (const range of settings.querySelectorAll('input[type="range"]')) {
    range.addEventListener('pointerdown', () => {
      range.closest('.mountain__ctl').classList.add('is-held');
      settings.classList.add('is-peeking');
    });
  }
  const release = () => {
    settings.classList.remove('is-peeking');
    for (const held of settings.querySelectorAll('.is-held')) held.classList.remove('is-held');
  };
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  root.querySelector('.mountain__play').addEventListener('click', () => {
    if (mountain.timer || !mountain.layers) { mountainStop(); return; }
    const last = mountain.layers.length - 1;
    if (mountain.upto >= last) mountain.upto = 0;
    const play = root.querySelector('.mountain__play');
    play.setAttribute('aria-pressed', 'true');
    play.lastChild.dataset.i18n = 'mountain.pause';
    play.lastChild.textContent = t('mountain.pause');
    const step = () => {
      drawMountain();
      if (mountain.upto >= last) { mountainStop(); return; }
      mountain.upto += 1;
    };
    step();
    mountain.timer = setInterval(step, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 600 : 220);
  });
  window.addEventListener('resize', fitMountain);
  mountain.root = root;
  return root;
}

function mountainStop() {
  clearInterval(mountain.timer);
  mountain.timer = null;
  const play = mountain.root && mountain.root.querySelector('.mountain__play');
  if (play) {
    play.setAttribute('aria-pressed', 'false');
    play.lastChild.dataset.i18n = 'mountain.play';
    play.lastChild.textContent = t('mountain.play');
  }
}

function mountainScene(canvas) {
  const { THREE } = window;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 600);
  const controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // Orbit around the mountain and zoom in/out only; no panning the view
  // around, on desktop or mobile alike.
  controls.enablePan = false;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f94, 0.75));
  const sun = new THREE.DirectionalLight(0xffffff, 0.65);
  sun.position.set(-12, 30, 18);
  scene.add(sun);
  // The stack's surface, rebuilt by drawMountain; vertex colours carry the shading.
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }));
  const labels = new THREE.Group();
  scene.add(mesh, labels);
  const s = { THREE, renderer, scene, camera, controls, mesh, labels, meta: [], faceBlock: [] };

  new ResizeObserver(() => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }).observe(canvas);

  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const hover = (event) => {
    const box = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1);
    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObject(mesh)[0];
    // Two triangles per face, one block per face.
    const meta = hit && s.meta[s.faceBlock[Math.floor(hit.faceIndex / 2)]];
    if (!meta) { hideTooltip(); return; }
    const [layer, team, place, p] = meta;
    showTooltip(event, `<b>${team.name}</b><br>${mountainLabel(layer)} · ${formatDate(layer.date)}<br>`
      + `${t('mountain.tip', { place, p: pct(p) })}<br>${t('mountain.tipRank', { finish: team.finish, predicted: team.predicted, now: team.now })}`, canvas);
  };
  let downAt = null;
  canvas.addEventListener('pointerdown', (event) => { downAt = [event.clientX, event.clientY]; });
  canvas.addEventListener('pointermove', (event) => { if (event.buttons) hideTooltip(); else hover(event); });
  canvas.addEventListener('pointerup', (event) => {
    if (downAt && Math.hypot(event.clientX - downAt[0], event.clientY - downAt[1]) < 5) hover(event);
  });
  canvas.addEventListener('pointerleave', (event) => { if (event.pointerType !== 'touch') hideTooltip(); });
  return s;
}

/* A label that turns to face the camera, or with `flat` one printed on the
   floor: flat labels never swing into each other as the view turns. */
function textSprite(s, text, color, size, anchorX = 0.5, flat = false) {
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  const font = "600 64px Archivo, system-ui, sans-serif";
  g.font = font;
  canvas.width = Math.ceil(g.measureText(text).width) + 8;
  canvas.height = 84;
  g.font = font;
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.fillText(text, 4, 44);
  const texture = new s.THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  if (flat) {
    const width = (size * canvas.width) / 84;
    const geometry = new s.THREE.PlaneGeometry(width, size);
    geometry.translate((0.5 - anchorX) * width, 0, 0);
    const label = new s.THREE.Mesh(geometry, new s.THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
    label.rotation.x = -Math.PI / 2; // lying down, reading from the front edge
    return label;
  }
  const sprite = new s.THREE.Sprite(new s.THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set((size * canvas.width) / 84, size, 1);
  sprite.center.set(anchorX, 0.5);
  return sprite;
}

function drawMountain() {
  const s = mountain.scene;
  const report = state.reports && state.reports[state.league];
  if (!s || !mountain.layers || !report) return;
  const { THREE, mesh, labels } = s;
  const { layers, teams } = mountain;
  const root = mountain.root;
  const n = teams.length;
  const half = (n - 1) / 2;
  const H = MOUNTAIN_LAYER;
  const last = layers.length - 1;
  mountain.upto = Math.min(mountain.upto, last);
  const cutoff = MOUNTAIN_CUTOFFS[mountain.cutoff];
  // A finished season's predicted finish is its final table, so the table
  // order would only repeat it.
  const finished = report.model.matches_remaining === 0;
  root.querySelector('[data-order="now"]').hidden = finished;
  const finishButton = root.querySelector('[data-order="finish"]');
  finishButton.dataset.i18n = finished ? 'mountain.byFinal' : 'mountain.byFinish';
  finishButton.textContent = t(finishButton.dataset.i18n);
  if (finished && mountain.order === 'now') mountain.order = 'finish';
  const order = [...teams].sort((a, b) => a[mountain.order] - b[mountain.order]);
  mountain.rowOf = new Map(order.map((team, row) => [team.id, row]));

  // The cut pickers, refilled only when the clubs or the language change:
  // refilling an open select on every play step would close it.
  const teamPick = root.querySelector('#mountain-cut-team');
  const placePick = root.querySelector('#mountain-cut-place');
  if (teamPick.dataset.key !== mountain.key + currentLang) {
    teamPick.dataset.key = mountain.key + currentLang;
    teamPick.replaceChildren(new Option(t('mountain.allTeams'), ''),
      ...[...teams].sort((a, b) => a.name.localeCompare(b.name)).map((team) => new Option(team.name, team.id)));
    placePick.replaceChildren(new Option(t('mountain.allPlaces'), '0'),
      ...teams.map((_, i) => new Option(t('mountain.place', { n: i + 1 }), String(i + 1))));
    teamPick.setAttribute('aria-label', t('mountain.cutTeam'));
    placePick.setAttribute('aria-label', t('mountain.cutPlace'));
  }
  teamPick.value = mountain.cutTeam;
  placePick.value = String(mountain.cutPlace);

  // Theme colours, resolved from the stylesheet on every draw so a theme
  // switch repaints the stack too.
  const probe = root.querySelector('.mountain__probe');
  const css = (value) => { probe.style.color = value; return getComputedStyle(probe).color; };
  const ramp = ['var(--panel-sunk)', ...Array.from({ length: SEQ_STEPS }, (_, i) => `var(--seq-${i + 1})`)]
    .map((value) => new THREE.Color(css(value)));
  const ink = css('var(--ink)');
  const muted = css('var(--ink-muted)');
  s.scene.background = new THREE.Color(css('var(--panel)'));

  // Every block is a cell of one grid (place across, round up, club row
  // deep), so the stack is meshed as a voxel surface: only faces open to the
  // air, each corner darkened by the blocks around it, as voxel games do
  // ambient occlusion. Faces buried inside the stack are never drawn.
  // The pre-season layer is ground zero: flat tiles on the floor, with no
  // height, so round 1 is the first layer to stand on it.
  const ground = layers[0].kind === 'pre' ? 1 : 0;
  const shown = mountain.upto + 1 - ground; // standing layers drawn
  const cells = new Int32Array(n * n * Math.max(shown, 0)).fill(-1);
  const blockAt = ([x, y, z]) => (x < 0 || y < 0 || z < 0 || x >= n || z >= n || y >= shown ? -1 : cells[(y * n + z) * n + x]);
  const blocks = [];
  s.meta = [];
  for (let l = 0; l <= mountain.upto; l += 1) {
    const flat = l < ground;
    order.forEach((team, row) => {
      (layers[l].p.get(team.id) || []).forEach((p, place) => {
        if (p <= 0 || p < cutoff) return;
        // A vertical cut keeps one club's row or one place's column, where
        // they stand, so the faces it exposes are drawn and shaded too.
        if ((mountain.cutTeam && team.id !== mountain.cutTeam) || (mountain.cutPlace && place + 1 !== mountain.cutPlace)) return;
        const level = heatLevel(p);
        const lo = Math.min(SEQ_STEPS - 1, Math.floor(level));
        if (!flat) cells[((l - ground) * n + row) * n + place] = blocks.length;
        blocks.push([[place, l - ground, row], new THREE.Color().copy(ramp[lo]).lerp(ramp[lo + 1], Math.min(1, level - lo)), flat]);
        s.meta.push([layers[l], team, place + 1, p]);
      });
    });
  }
  const k = blocks.length;
  // The extent of what is standing (ground tiles included), for
  // frameMountain to aim a vertical cut at the middle of its wall.
  mountain.bounds = null;
  for (const [[x, y, z], , flat] of blocks) {
    const b = mountain.bounds || (mountain.bounds = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, top: 0 });
    b.x0 = Math.min(b.x0, x - half - 0.5);
    b.x1 = Math.max(b.x1, x - half + 0.5);
    b.z0 = Math.min(b.z0, z - half - 0.5);
    b.z1 = Math.max(b.z1, z - half + 0.5);
    if (!flat) b.top = Math.max(b.top, (y + 1) * H);
  }
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  s.faceBlock = [];
  const step = (cell, axis, by) => { const next = [...cell]; next[axis] += by; return next; };
  blocks.forEach(([cell, color, flat], b) => {
    if (flat) {
      // A ground tile: one face up, just above the floor; a round-1 block on
      // it covers it, so it shows where the mountain has not grown.
      const [x, , z] = cell;
      const base = positions.length / 3;
      for (const [cx, cz] of [[0, 0], [0, 1], [1, 1], [1, 0]]) {
        positions.push(x + cx - half - 0.5, 0.004, z + cz - half - 0.5);
        normals.push(0, 1, 0);
        colors.push(color.r, color.g, color.b);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      s.faceBlock.push(b);
      return;
    }
    for (let axis = 0; axis < 3; axis += 1) {
      for (const sign of [1, -1]) {
        const out = step(cell, axis, sign);
        if (blockAt(out) >= 0) continue;
        // u x v points along the face normal, so corners in this order wind
        // counter-clockwise seen from outside a positive face.
        const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
        const base = positions.length / 3;
        const ao = [];
        for (const [cu, cv] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
          const corner = step(step(step(cell, axis, sign > 0 ? 1 : 0), u, cu), v, cv);
          positions.push(corner[0] - half - 0.5, corner[1] * H, corner[2] - half - 0.5);
          normals.push(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
          const side1 = step(out, u, cu ? 1 : -1);
          const side2 = step(out, v, cv ? 1 : -1);
          const [s1, s2, diagonal] = [blockAt(side1) >= 0, blockAt(side2) >= 0, blockAt(step(side1, v, cv ? 1 : -1)) >= 0];
          const open = s1 && s2 ? 0 : 3 - s1 - s2 - diagonal;
          ao.push(open);
          colors.push(color.r * MOUNTAIN_AO[open], color.g * MOUNTAIN_AO[open], color.b * MOUNTAIN_AO[open]);
        }
        // Split along the brighter diagonal, or the shading creases.
        let quad = ao[0] + ao[2] >= ao[1] + ao[3] ? [0, 1, 2, 0, 2, 3] : [1, 2, 3, 1, 3, 0];
        if (sign < 0) quad = quad.reverse();
        for (const i of quad) indices.push(base + i);
        s.faceBlock.push(b);
      }
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  mesh.geometry.dispose();
  mesh.geometry = geometry;

  // Scenery: band strips and place numbers along the back and front edges,
  // as on the grid, club names with their expected finish down both sides
  // and round marks up the right.
  for (const child of [...labels.children]) {
    if (child.material.map) child.material.map.dispose();
    child.material.dispose();
    if (!child.isSprite) child.geometry.dispose();
    labels.remove(child);
  }
  const bands = report.league.bands || [];
  for (let place = 1; place <= n; place += 1) {
    const band = bands.filter((b) => b.label !== 'Champions' && place >= b.first && place <= b.last).pop();
    const color = new THREE.Color(css(band ? bandColor(band, n) : 'var(--ink-muted)'));
    for (const z of [-half - 0.9, half + 0.9]) {
      const strip = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 0.5),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: band ? 0.9 : 0.25 }),
      );
      strip.rotation.x = -Math.PI / 2;
      strip.position.set(place - 1 - half, 0.01, z);
      labels.add(strip);
    }
    for (const z of [-half - 1.8, half + 1.8]) {
      const number = textSprite(s, String(place), ink, 0.6);
      number.position.set(place - 1 - half, 0, z);
      labels.add(number);
    }
  }
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(n + 0.6, n + 0.6),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(muted), transparent: true, opacity: 0.08 }),
  );
  plate.rotation.x = -Math.PI / 2;
  plate.position.y = -0.01;
  labels.add(plate);
  // The expected finish sits on the grid side of the name on both sides.
  order.forEach((team, row) => {
    for (const [text, x, anchor] of [[`${team.name}  ${team.finish}`, -half - 0.9, 1], [`${team.finish}  ${team.name}`, half + 0.9, 0]]) {
      const name = textSprite(s, text, ink, 0.65, anchor, true);
      name.position.set(x, 0.02, row - half);
      labels.add(name);
    }
  });
  const marks = [0, 5, 10, 15, 20, 25, 30].filter((l) => l <= mountain.upto);
  if (!marks.includes(mountain.upto)) marks.push(mountain.upto);
  // Round marks stand at the end of the back place numbers, above the club
  // names rather than over them, or at the front-right corner of what the
  // cut leaves, so a back row or a middle column keeps them beside its
  // blocks, not in front.
  const wall = (mountain.cutTeam || mountain.cutPlace) && mountain.bounds;
  const markX = (wall ? wall.x1 : half + 0.5) + 0.5;
  const markZ = wall ? wall.z1 : -half - 1.8;
  for (const l of marks) {
    const mark = textSprite(s, mountainLabel(layers[l]), l === mountain.upto ? ink : muted, 0.5, 0);
    mark.position.set(markX, l < ground ? 0.15 : (l - ground) * H + H / 2, markZ);
    labels.add(mark);
  }

  const top = layers[mountain.upto];
  mountain.facts = mountainFacts(layers[0], top, teams, finished && mountain.upto === last);
  root.querySelector('.mountain__readout b').textContent = mountainLabel(top);
  root.querySelector('.mountain__readout span').textContent = `${formatDate(top.date)} · ${t('mountain.blocks', { n: num(k) })}`;
  for (const button of root.querySelectorAll('[data-order]')) {
    button.setAttribute('aria-pressed', String(button.dataset.order === mountain.order));
  }
  const upto = root.querySelector('#mountain-upto');
  upto.max = last;
  upto.value = mountain.upto;
  upto.setAttribute('aria-valuetext', mountainLabel(top));
  root.querySelector('#mountain-cutoff').labels[0].querySelector('output').textContent = pct(cutoff, cutoff < 0.01 ? 2 : 1);
}

/* A chance as a figure: whole percent, a decimal under 0.5 %, and a plain
   0 % rather than the grid's dash, which reads as missing in a sentence. */
function shareText(p) {
  if (p >= 0.005) return pct(p, 0);
  if (p >= 0.0005) return pct(p, 1);
  return p > 0 ? `<${pct(0.001, 1)}` : `0${percentSign()}`;
}

/* The whole division from the bottom layer to the top one built: how far the
   field has narrowed, the pre-season favourite then and now, who has moved
   most, and the surest single outcome. When the top layer is a finished
   season's final table those would only say "certain", so the figures turn
   into a scorecard for the pre-season prediction instead. The vertical cut
   does not apply. Returns the figures for exploreFacts. */
function mountainFacts(start, top, teams, final) {
  const chances = (layer, id) => layer.p.get(id) || [];
  const plausible = (layer) => teams.reduce((sum, team) => sum + chances(layer, team.id).filter((p) => p >= 0.05).length, 0) / teams.length;
  const expected = (layer, id) => chances(layer, id).reduce((sum, p, i) => sum + (i + 1) * p, 0);
  if (start === top) {
    return [{ value: num(plausible(top), 1), label: t('mountain.fact.places'), text: t('mountain.fact.placesText') }];
  }
  const favourite = [...teams].sort((a, b) => (chances(start, b.id)[0] || 0) - (chances(start, a.id)[0] || 0))[0];
  const favouriteThen = shareText(chances(start, favourite.id)[0] || 0);
  const favouriteLabel = t('mountain.fact.favourite', { team: favourite.name });

  if (final) {
    const placeOf = (id) => { const p = chances(top, id); return p.indexOf(Math.max(...p)) + 1; };
    const rows = teams.map((team) => {
      const place = placeOf(team.id);
      return { team, place, from: expected(start, team.id), then: chances(start, team.id)[place - 1] || 0 };
    });
    const hits = rows.filter((row) => Math.abs(row.place - row.from) <= 2).length;
    const moves = [...rows].sort((a, b) => (a.place - a.from) - (b.place - b.from));
    const surprise = [...rows].sort((a, b) => a.then - b.then)[0];
    const ended = (row) => t('mountain.fact.endedText', { from: num(row.from, 1), place: row.place });
    return [
      { value: t('mountain.fact.hitsValue', { hits, n: teams.length }), label: t('mountain.fact.hits'), text: t('mountain.fact.hitsText') },
      {
        value: `${favouriteThen} → ${placeOf(favourite.id)}.`,
        label: favouriteLabel,
        text: t('mountain.fact.favouriteFinalText'),
      },
      { value: moves[0].team.name, label: t('mountain.fact.climber'), text: ended(moves[0]) },
      { value: moves[moves.length - 1].team.name, label: t('mountain.fact.faller'), text: ended(moves[moves.length - 1]) },
      {
        value: surprise.team.name,
        label: t('mountain.fact.surprise'),
        text: t('mountain.fact.surpriseText', { place: surprise.place, pct: shareText(surprise.then) }),
      },
    ];
  }

  const moves = teams
    .map((team) => ({ team, from: expected(start, team.id), to: expected(top, team.id) }))
    .sort((a, b) => (a.to - a.from) - (b.to - b.from));
  const [climber, faller] = [moves[0], moves[moves.length - 1]];
  let surest = { p: 0 };
  for (const team of teams) {
    chances(top, team.id).forEach((p, i) => { if (p > surest.p) surest = { p, team, place: i + 1 }; });
  }
  const move = (m) => t('mountain.fact.moveText', { from: num(m.from, 1), to: num(m.to, 1) });
  return [
    { value: `${num(plausible(start), 1)} → ${num(plausible(top), 1)}`, label: t('mountain.fact.places'), text: t('mountain.fact.placesText') },
    {
      value: `${favouriteThen} → ${shareText(chances(top, favourite.id)[0] || 0)}`,
      label: favouriteLabel,
      text: t('mountain.fact.favouriteText'),
    },
    { value: climber.team.name, label: t('mountain.fact.climber'), text: move(climber) },
    { value: faller.team.name, label: t('mountain.fact.faller'), text: move(faller) },
    { value: shareText(surest.p), label: t('mountain.fact.surest'), text: t('mountain.fact.surestText', { team: surest.team.name, place: surest.place }) },
  ];
}

/* The key figures in a dialog, for where they are out of sight: below the
   fold on a wide screen, and left out of a phone's full-screen mountain. */
function openFacts(title, facts) {
  let dialog = $('#facts-dialog');
  if (!dialog) {
    dialog = el('dialog', 'facts-dialog');
    dialog.id = 'facts-dialog';
    dialog.setAttribute('aria-labelledby', 'facts-dialog-title');
    // A click on the backdrop lands on the dialog itself: close.
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    document.body.appendChild(dialog);
  }
  const head = el('div', 'facts-dialog__head');
  const heading = el('h2', '', title);
  heading.id = 'facts-dialog-title';
  const close = el('button', 'facts-dialog__close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', t('explore.close'));
  close.addEventListener('click', () => dialog.close());
  head.append(heading, close);
  dialog.replaceChildren(head, exploreFacts(facts));
  dialog.showModal();
}

function mountainLoop() {
  const s = mountain.scene;
  if (!s || state.activeView !== 'explore' || state.exploreItem !== 'mountain' || !s.renderer.domElement.isConnected) {
    mountain.raf = null;
    mountainStop();
    // Left by the back button or a tab: the settings popup goes with it.
    mountain.root?.querySelector('.mountain__controls:popover-open')?.hidePopover();
    return;
  }
  const glide = mountain.glide;
  if (glide) {
    const k = Math.min(1, (performance.now() - glide.start) / 450);
    const eased = 1 - (1 - k) ** 3;
    s.controls.target.lerpVectors(glide.fromTarget, glide.toTarget, eased);
    s.camera.position.lerpVectors(glide.fromCamera, glide.toCamera, eased);
    if (k === 1) mountain.glide = null;
  }
  s.controls.update();
  s.renderer.render(s.scene, s.camera);
  mountain.raf = requestAnimationFrame(mountainLoop);
}

/* Aims the camera at what the vertical cut leaves standing: a club's row, a
   place's column, the one stack where both meet, or the whole mountain. The
   distance shrinks with the cut's size, so a lone stack fills the stage; the
   angle stays wherever the reader turned it, except on `home`, which is the
   opening view of a new league or season. */
function frameMountain({ home = false } = {}) {
  const s = mountain.scene;
  if (!s || !mountain.layers || !mountain.rowOf) return;
  const { THREE, camera, controls } = s;
  const n = mountain.teams.length;
  const half = (n - 1) / 2;
  // The pre-season layer lies flat, so it adds no height.
  const height = (mountain.layers.length - (mountain.layers[0].kind === 'pre' ? 1 : 0)) * MOUNTAIN_LAYER;
  // The opening view, framed for a wide stage; a tall, narrow one (a phone)
  // backs off so the whole stack and its labels stay in view.
  const canvas = s.renderer.domElement;
  const aspect = canvas.clientWidth / canvas.clientHeight || 1.5;
  const opening = new THREE.Vector3(n * 1.45, height * 0.37 + n * 0.9, n * 2.05).multiplyScalar(Math.max(1, 1.6 / aspect));
  // A vertical cut aims at the middle of the wall it leaves (its blocks'
  // extent, as drawn), sized to that wall; the whole mountain at the grid.
  const wall = (mountain.cutTeam || mountain.cutPlace) && mountain.bounds;
  const [across, deep, tall] = wall ? [wall.x1 - wall.x0, wall.z1 - wall.z0, wall.top] : [n, n, height];
  const size = (a, d, h) => Math.hypot(a, d, h);
  const scale = Math.max(0.45, size(across, deep, tall) / size(n, n, height));
  // The smaller the cut, the more of it is height, so the aim climbs from
  // the whole mountain's 38 % towards the middle of a lone stack.
  const target = new THREE.Vector3(
    wall ? (wall.x0 + wall.x1) / 2 : 0,
    tall * (0.5 - 0.12 * scale),
    wall ? (wall.z0 + wall.z1) / 2 : 0,
  );
  const direction = home ? opening.clone() : camera.position.clone().sub(controls.target);
  const position = target.clone().addScaledVector(direction.normalize(), opening.length() * scale);
  if (home || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    mountain.glide = null;
    controls.target.copy(target);
    camera.position.copy(position);
    controls.update();
    return;
  }
  mountain.glide = {
    fromTarget: controls.target.clone(), toTarget: target,
    fromCamera: camera.position.clone(), toCamera: position,
    start: performance.now(),
  };
}

/* The mountain takes the whole window between the masthead and, on a phone,
   the bottom bar: the stylesheet pins it there and locks the page, so no
   swipe lands on the page instead of the stack. This measures the bars. */
function fitMountain() {
  const root = mountain.root;
  if (!root || !root.isConnected || document.body.dataset.viz !== 'mountain') return;
  window.scrollTo(0, 0);
  const bar = $('#mobilebar');
  root.style.setProperty('--mountain-top', `${Math.round($('.masthead').getBoundingClientRect().bottom)}px`);
  root.style.setProperty('--mountain-bottom', `${bar ? Math.round(bar.getBoundingClientRect().height) : 0}px`);
}

/* The division and season pickers, refilled from the report each render
   (the names, the seasons on offer and the language can all change). */
function syncMountainWhere(report) {
  const root = mountain.root;
  const league = root.querySelector('#mountain-league');
  league.replaceChildren(...Object.entries(state.reports).map(([slug, r]) => new Option(r.league.name, slug)));
  league.value = state.league;
  league.setAttribute('aria-label', t('mountain.league'));
  const season = root.querySelector('#mountain-season');
  const seasons = report.league.seasons || [report.league.season];
  season.replaceChildren(...[...seasons].reverse().map((s) => new Option(
    s === report.league.current_season ? t('season.live', { season: s }) : String(s), String(s),
  )));
  season.value = String(report.league.season);
  season.setAttribute('aria-label', t('mountain.season'));
}

async function renderMountain(report, body) {
  const root = mountainRoot();
  if (body.firstChild !== root) body.replaceChildren(root);
  syncMountainWhere(report);
  fitMountain(); // before the camera is framed, which reads the stage's shape
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  root.querySelector('canvas').setAttribute('aria-label', t('mountain.aria'));
  // The floating buttons go icon-only on a phone, so they carry their names.
  root.querySelector('.mountain__back').setAttribute('aria-label', t('explore.back'));
  root.querySelector('.mountain__info').setAttribute('aria-label', t('explore.facts'));
  root.querySelector('.mountain__gear').setAttribute('aria-label', t('mountain.settings'));
  root.querySelector('#mountain-upto').setAttribute('aria-label', t('mountain.builtUp'));
  const status = root.querySelector('.mountain__status');
  const key = `${report.league.season}|${report.league.slug}|${state.asof}|${report.model.matches_played}`;
  const token = ++mountainToken;
  if (key !== mountain.key) {
    mountainStop();
    status.textContent = t('mountain.loading');
    status.hidden = false;
    try {
      const [layers] = await Promise.all([mountainLayers(report), loadThree()]);
      if (token !== mountainToken) return;
      if (!layers.length) throw new Error('no layers');
      if (!mountain.scene) mountain.scene = mountainScene(root.querySelector('canvas'));
      mountain.layers = layers;
      mountain.teams = mountainTeams(report, layers);
      // A cut through a club that is not in this league or season is dropped.
      if (!mountain.teams.some((team) => team.id === mountain.cutTeam)) mountain.cutTeam = '';
      if (mountain.cutPlace > mountain.teams.length) mountain.cutPlace = 0;
      mountain.upto = layers.length - 1;
      mountain.key = key;
      drawMountain(); // places the rows, which the framing aims at
      frameMountain({ home: true });
    } catch (error) {
      console.warn('[Mountain]', error);
      if (token === mountainToken) status.textContent = t('mountain.failed');
      return;
    }
  }
  if (token !== mountainToken) return;
  status.hidden = true;
  drawMountain();
  fitMountain();
  if (!mountain.raf) mountain.raf = requestAnimationFrame(mountainLoop);
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

/* The club header stays on top; everything else sits in three groups behind
   a segmented control -- this season, the forecast, the club's history -- so
   a phone shows one group at a time instead of eleven sections in a row.
   Only the open group is drawn: the charts size themselves to their box,
   which a hidden panel does not have. A finished season has no forecast. */
const TEAM_TABS = [['overview', 'team.tab.overview'], ['forecast', 'team.tab.forecast'], ['history', 'team.tab.history']];

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

  const safeRender = (fn, context = 'section') => {
    try { fn(); }
    catch (e) { console.error(`[TeamView] ${context} failed:`, e); }
  };

  safeRender(() => renderTeamSummary(teamId, row, career, report, content), 'summary');

  const tabs = TEAM_TABS.filter(([key]) => key !== 'forecast' || (row && report.model?.matches_remaining > 0));
  if (!tabs.some(([key]) => key === state.teamTab)) state.teamTab = 'overview';
  const bar = el('div', 'switch team-tabs');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', t('team.tabs'));
  for (const [key, label] of tabs) {
    const button = el('button', '', t(label));
    button.type = 'button';
    button.setAttribute('aria-pressed', String(key === state.teamTab));
    button.addEventListener('click', () => {
      if (state.teamTab === key) return;
      state.teamTab = key;
      track('select_team_tab', { tab: key });
      renderTeamView(report);
      $('.team-tabs [aria-pressed="true"]')?.focus();
    });
    bar.appendChild(button);
  }
  content.appendChild(bar);

  if (state.teamTab === 'overview') {
    safeRender(() => renderTeamNow(row, career, report, content), 'now');
    safeRender(() => renderTeamResults(teamId, teamName, report, content), 'results');
  } else if (state.teamTab === 'forecast') {
    safeRender(() => {
      const section = renderTeamGridRow(teamId, row, report, content);
      if (section) renderTeamOutlook(section, row, report, teamId);
    }, 'outlook');
    safeRender(() => {
      const section = el('div', 'team-section');
      renderTeamStakes(section, report, teamId);
      if (section.childNodes.length) content.appendChild(section);
    }, 'stakes');
    safeRender(() => renderTeamFixtures(teamId, teamName, report, content), 'fixtures');
  } else {
    if (career?.points?.length >= 2) safeRender(() => renderTeamRatingHistory(career, content), 'ratingHistory');
    if (career?.seasons?.length) safeRender(() => renderSeasonBySeason(career, teamId, content, report), 'seasons');
  }
}

function renderTeamRatingHistory(career, content) {
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
  // Column names once above the rows, which carry bare numbers.
  const head = el('div', 'season-row-head');
  head.setAttribute('aria-hidden', 'true');
  const headRating = el('div', 'season-row-compact__rating');
  headRating.append(
    el('div', 'season-row-compact__rating-start', t('team.ratingStartShort')),
    el('div', 'season-row-compact__change', t('team.change')),
    el('div', 'season-row-compact__rating-end', t('team.ratingEndShort')),
  );
  const headMain = el('div', 'season-row-compact__main');
  headMain.appendChild(el('div', 'season-row-compact__pos', '#'));
  head.append(el('div', 'season-row-compact__season', t('team.season')), headMain, headRating);
  section.appendChild(head);

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
  // The season still being played: its place is today's, not a final one.
  const live = String(record.season) === String(currentReport.league.current_season)
    && state.reports?.[record.league]?.league?.season === record.season
    && state.reports[record.league].model?.matches_remaining > 0;
  if (live) mainCell.appendChild(el('span', 'season-row-compact__live', t('team.now')));
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
      chart,
      shapeLegend(report)
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
  // Named for time rather than page order: on a newest-first list, page 1
  // with "Prev" live and "Next" dead read as the last page.
  return pageNav(
    t('page.of', { n: page + 1, total: totalPages }),
    valid(earlier) ? () => go(earlier) : null,
    valid(later) ? () => go(later) : null,
    reversed ? [t('page.older'), t('page.newer')] : [t('page.earlier'), t('page.later')],
  );
}

function renderTeamSummary(teamId, row, career, report, container) {
  const card = el('div', 'team-summary');

  const header = el('div', 'team-summary__header');

  // Crest
  const crest = teamLogo(teamId, row?.team || career?.team || '');
  if (crest) {
    crest.classList.add('team-logo--large');
    // 72px is past what the 96px WebP stays sharp at; the 192px original is.
    crest.src = `/logos/${teamId}.png`;
    header.appendChild(crest);
  }

  // Name (pushes right side to the end)
  const nameBlock = el('div', 'team-summary__name-block');
  nameBlock.appendChild(el('h3', 'team-summary__name', row?.team || career?.team || 'Unknown'));
  header.appendChild(nameBlock);

  // Rating block: [arrow + rating] / position
  const ratingBlock = el('div', 'team-summary__rating-block');
  const ratingLine = el('div', 'team-summary__rating-line');
  const teamName = row?.team || career?.team;
  const trend = computeRatingTrend(teamName, report);
  if (trend) {
    const trendEl = el('span', `team-summary__trend team-summary__trend--${trend.direction}`);
    trendEl.innerHTML = trend.svg;
    trendEl.setAttribute('role', 'img');
    trendEl.setAttribute('aria-label', trend.detail);
    trendEl.tabIndex = 0;
    // The site's own tooltip rather than a title: it shows at once, takes
    // the extra lines, and a tap brings it up on a phone.
    attachTip(trendEl, trend.tip);
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
  ratingBlock.appendChild(el('span', 'team-summary__rating-pos', t('team.rankOf', { rank: ordinalShort(crossRank >= 0 ? crossRank + 1 : (row?.position ?? 0)), total: totalTeams })));
  // How the club has played by its chances, labelled: an unlabelled second
  // arrow would read as a second opinion on the rating.
  const form = computeXgForm(teamName, report);
  if (form) {
    const formEl = el('span', 'team-summary__form');
    formEl.tabIndex = 0;
    formEl.setAttribute('aria-label', form.detail);
    const icon = el('span', `team-summary__form-icon team-summary__trend--${form.direction}`);
    icon.innerHTML = form.svg;
    formEl.append(el('span', 'team-summary__form-key', t('team.xgForm')), icon, el('span', '', form.label));
    attachTip(formEl, form.tip);
    ratingBlock.appendChild(formEl);
  }
  header.appendChild(ratingBlock);

  card.appendChild(header);
  container.appendChild(card);
}

/* The overview tab's tiles, big value over a small label: where the club
   stands, then how it plays. Four short numbers fit one row even on a phone. */
function renderTeamNow(row, career, report, container) {
  const section = el('div', 'team-section team-now');
  if (row) {
    const table = el('dl', 'team-stats');
    table.appendChild(summaryStat(t('team.position'), ordinalShort(row.position)));
    table.appendChild(summaryStat(t('team.points'), String(row.points)));
    table.appendChild(summaryStat(t('team.gd'), signed(row.goal_difference)));
    table.appendChild(summaryStat(t('team.played'), String(row.played)));
    section.appendChild(table);

    const xg = el('dl', 'team-stats team-stats--xg');
    xg.appendChild(xgStat(t('team.attack'), t('team.attackHint'), row.attack, report.table.map((r) => r.attack), true));
    xg.appendChild(xgStat(t('team.defence'), t('team.defenceHint'), row.defence, report.table.map((r) => r.defence), false));
    section.appendChild(xg);
  } else if (career) {
    const table = el('dl', 'team-stats');
    table.appendChild(summaryStat(t('team.matches'), String(career.points.length)));
    section.appendChild(table);
  } else return;
  container.appendChild(section);
}

/* The arrow beside a rating: how far the rating moved over the club's last
   five matches -- the five the table's form column shows, which it tracks
   best (r 0.85 against the points in them; 3 matches 0.65, 8 matches 0.73).
   A plain total reads at once ("+12 over the last 5") and swings between
   rising and falling from one match to the next only 2.5 % of the time.
   Cut-offs from every club-season since 2015: steady within ±8 (about 30 %
   of matches), fast beyond ±20 (about 30 %). */
const TREND_MATCHES = 5;
const TREND_CUTS = { mild: 8, strong: 20 };

/* xG form, the team view's second line: per match, K * (xG-implied score -
   expected score), the rating change the chances alone would have produced
   (`xg_form` in the results, from pipeline.xg_form). It is the signal that
   looks ahead -- a recent average tracks the next few matches (r ~0.17) where
   rating changes, mostly result luck, do not (~0.05). Weights 0.1..0.6 over
   the last 6 matches, so the latest three carry 71 %. */
const FORM_WEIGHTS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
const FORM_CUTS = { mild: 1, strong: 4 };

function teamMatchSeries(teamName, report) {
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
  return { xgForm, changes };
}

/* Five degrees: strong rise, rise, steady, fall, strong fall. */
function trendDegree(value, { mild, strong }) {
  const key = value > strong ? 'strongRise' : value > mild ? 'rise' : value >= -mild ? 'steady' : value >= -strong ? 'fall' : 'strongFall';
  return { key, direction: key.replace('strongR', 'strong-r').replace('strongF', 'strong-f') };
}

function computeRatingTrend(teamName, report) {
  if (!teamName) return null;
  const values = teamMatchSeries(teamName, report).changes.slice(-TREND_MATCHES);
  if (values.length < TREND_MATCHES) return null;
  const diff = values.reduce((sum, v) => sum + v, 0);
  const { key, direction } = trendDegree(diff, TREND_CUTS);
  const label = t(`trend.${key}`);
  const total = signed(diff, 0);
  // One line for the table's arrow and for screen readers; the team view
  // shows `tip`, which adds the matches behind the number.
  const detail = t('trend.detail', { label, n: total });
  const tip = `<b>${label}</b><br>${t('trend.tipTotal', { n: total })}`
    + `<br><span class="tooltip__muted">${t('trend.tipMatches', { count: values.length, list: values.map((v) => signed(v, 0)).join(' ') })}</span>`;
  return { direction, svg: trendArrowSVG(direction), detail, tip, diff };
}

function computeXgForm(teamName, report) {
  if (!teamName) return null;
  const values = teamMatchSeries(teamName, report).xgForm.slice(-FORM_WEIGHTS.length);
  if (values.length < FORM_WEIGHTS.length) return null;
  const diff = values.reduce((sum, v, i) => sum + v * FORM_WEIGHTS[i], 0)
    / FORM_WEIGHTS.reduce((a, b) => a + b, 0);
  const { key, direction } = trendDegree(diff, FORM_CUTS);
  const label = t(`form.${key}`);
  const perMatch = signed(diff, 1);
  const tip = `<b>${label}</b><br>${t('form.tipPerMatch', { n: perMatch })}`
    + `<br><span class="tooltip__muted">${t('trend.tipMatches', { count: values.length, list: values.map((v) => signed(v, 1)).join(' ') })}</span>`;
  return { direction, svg: trendArrowSVG(direction), label, detail: t('form.detail', { label, n: perMatch }), tip };
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

/* The club's own high-stakes entries: one compact line each, the band carried
   by a dot in its palette colour and the consequence in words ("Win vs Brann
   and the Champions chance is 92%. Lose and it falls to 31%."). Nothing is
   rendered when the club has no entries, so mid-table clubs get no chrome.
   Above them, the next match's stake in the same words, all season; it is
   left out when that match is already listed as decisive for the band. */
function renderTeamStakes(card, report, teamId) {
  const entries = teamStakes(report, teamId);
  let next = nextStake(report, teamId);
  if (next && entries.some((e) => String(e.match_id) === String(next.match_id) && e.band_label === next.band_label)) next = null;
  if (!entries.length && !next) return;
  const box = el('div', 'team-stakes');
  const count = (report.table || []).length || 16;
  const section = (label, items, dated = false) => {
    box.appendChild(el('div', 'label', label));
    const list = el('ul', 'team-stakes__list');
    for (const entry of items) list.appendChild(stakeRow(entry, report, count, dated));
    box.appendChild(list);
  };
  if (next) section(t('stake.next', { date: formatDate(next.date) }), [next]);
  if (entries.length) section(t('stake.title'), entries, true);
  card.appendChild(box);
}

function stakeRow(entry, report, count, dated = false) {
  const copy = stakeCopy(entry, currentLang);
  const item = el('li', 'team-stakes__row');
  const dot = el('span', 'team-stakes__dot');
  dot.style.background = bandColor({ first: entry.band_first, last: entry.band_last, tone: entry.band_tone, label: entry.band_label }, count);
  dot.setAttribute('aria-hidden', 'true');
  item.appendChild(dot);
  const text = el('span', 'team-stakes__text');
  text.appendChild(el('span', 'team-stakes__main', `${copy.main} · `));
  text.appendChild(el('span', 'team-stakes__sub', copy.sub));
  const legs = stakeLegs(entry, report.fixtures || []);
  if (legs.length >= 2) {
    text.appendChild(el('span', 'team-stakes__legs', t('stake.legs', { a: formatDate(legs[0].date), b: formatDate(legs[1].date) })));
  } else if (dated) {
    text.appendChild(el('span', 'team-stakes__legs', formatDate(entry.date)));
  }
  item.appendChild(text);
  return item;
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
  return section;
}

/* Under the finish strip: expected points and the chance of each race the
   club is in (at least 1 %, top three in table order), then the pre-season
   call. The likeliest place is left to the strip, whose tallest cell it is,
   and the rating change since the start to the season list. */
function renderTeamOutlook(card, row, report, teamId) {
  const probs = row.position_probabilities || [];
  if (!probs.length || !report.model?.matches_remaining) return;
  const box = el('div', 'team-outlook');
  const tiles = el('dl', 'team-stats team-stats--outlook');
  tiles.appendChild(summaryStat(t('team.xPts'), num(row.expected_points)));
  const slug = report.league.slug;
  const races = report.league.bands
    .map((band) => ({ band, chance: bandChance(row, band, slug) }))
    .filter(({ chance }) => chance >= 0.01)
    .slice(0, 3);
  for (const { band, chance } of races) {
    const name = bandWithPlayoff(row, band, slug) ? `${bandName(band)} (${t('team.playoffIncluded')})` : bandName(band);
    tiles.appendChild(summaryStat(bandEdgeName(band), pct(chance, 0), name));
  }
  box.appendChild(tiles);

  const historyTeam = report.history?.teams?.find((team) => String(team.team_id) === String(teamId));
  if (historyTeam?.positions?.length >= 2) {
    const pre = historyTeam.positions[0];
    box.appendChild(el('p', 'team-outlook__note', t('team.preSeason', { pos: ordinalShort(pre.indexOf(Math.max(...pre)) + 1) })));
  }
  card.appendChild(box);
}

/* Like the season shape, a narrow container gets a viewBox of its own width:
   the 940-wide desktop box read at a phone's ~0.35 scale left 4px text. The
   narrow box ticks every 100 points and labels seasons as '16, skipping one
   that would crowd the last. */
let lastTeamChart = null;

function drawTeamChart(career) {
  const chart = $('#team-chart');
  if (!chart) return;
  const points = career.points;

  const box = chart.getBoundingClientRect().width || 940;
  const narrow = box < SHAPE_NARROW;
  lastTeamChart = { career, chart, narrow };
  const width = narrow ? Math.round(box) : 940;
  const height = narrow ? 220 : 260;
  const pad = narrow ? { top: 14, right: 8, bottom: 28, left: 36 } : { top: 14, right: 16, bottom: 30, left: 46 };
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
    if (narrow && value % 100) continue;
    chart.appendChild(
      svgEl('line', { class: 'grid-line', x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value) })
    );
    const label = svgEl('text', { class: 'tick', x: pad.left - 8, y: y(value) + 3.5, 'text-anchor': 'end' });
    label.textContent = String(value);
    chart.appendChild(label);
  }

  let lastSeasonX = -Infinity;
  for (const record of career.seasons) {
    const start = Date.parse(`${record.season}-01-01T12:00:00Z`);
    if (start < first || start > times[times.length - 1]) continue;
    chart.appendChild(
      svgEl('line', { class: 'season-split', x1: x(start), x2: x(start), y1: pad.top, y2: pad.top + plotHeight })
    );
    if (x(start) - lastSeasonX < (narrow ? 24 : 30)) continue;
    lastSeasonX = x(start);
    const label = svgEl('text', { class: 'season-label', x: x(start) + 3, y: pad.top + 10 });
    label.textContent = narrow ? `’${String(record.season).slice(2)}` : String(record.season);
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

/* The team view's fixtures and results, one compact row each from the club's
   side: date, home or away, the opponent, then the three-way odds as win /
   draw / loss, or the result with its score the club's way round, the xG and
   what it did to the rating. The league-wide cards, centred on both clubs,
   repeated this club's own name and rating in every row. */
function teamMatchRow(match, teamId, report, ratingChanges) {
  const home = String(match.home_id) === String(teamId);
  const row = el('div', 'team-match');
  row.appendChild(el('span', 'team-match__date', formatDate(match.date)));
  const venue = el('span', 'team-match__venue', t(home ? 'team.homeShort' : 'team.awayShort'));
  venue.title = t(home ? 'team.home' : 'team.away');
  row.appendChild(venue);
  const opponent = sideBlock(home ? match.away : match.home, home ? match.away_id : match.home_id, true, 'team-match__name');
  opponent.classList.add('team-match__opponent');
  // The name and any stake dot share a box, so a narrow screen can stand the
  // crest beside both lines while the dot stays with the name.
  const label = el('span', 'team-match__label');
  const name = opponent.querySelector('.team-match__name');
  name.replaceWith(label);
  label.appendChild(name);
  row.appendChild(opponent);

  if (match.home_goals != null) {
    const [scored, conceded] = home ? [match.home_goals, match.away_goals] : [match.away_goals, match.home_goals];
    const letter = scored > conceded ? 'W' : scored < conceded ? 'L' : 'D';
    const result = el('span', 'team-match__result');
    result.appendChild(el('span', `form__chip form__chip--${letter.toLowerCase()}`, letter));
    result.appendChild(el('span', 'team-match__score', `${scored}–${conceded}`));
    if (match.xg) {
      const [xgFor, xgAgainst] = home ? match.xg : [match.xg[1], match.xg[0]];
      const xg = el('span', 'team-match__xg', `xG ${num(xgFor, 1)}–${num(xgAgainst, 1)}`);
      xg.title = t('played.xgHint');
      result.appendChild(xg);
    }
    const info = ratingChanges.get(`${teamId}|${match.date}`);
    if (info) {
      const delta = el('span', `team-match__delta${info.change > 0 ? ' up' : info.change < 0 ? ' down' : ''}`, signed(info.change));
      delta.title = t('team.ratingAfter', { n: info.rating });
      result.appendChild(delta);
    }
    row.appendChild(result);
  } else {
    const [win, loss] = home ? [match.home_win, match.away_win] : [match.away_win, match.home_win];
    const odds = el('div', 'odds team-match__odds');
    odds.setAttribute('role', 'img');
    odds.setAttribute('aria-label', t('aria.teamOdds', { w: pct(win), d: pct(match.draw), l: pct(loss) }));
    for (const [outcome, value, key] of [['home', win, 'team.oddsWin'], ['draw', match.draw, 'next.draw'], ['away', loss, 'team.oddsLoss']]) {
      const segment = el('div', 'odds__seg');
      segment.dataset.outcome = outcome;
      segment.style.flex = `${Math.max(value, 0.001)}`;
      segment.textContent = value >= 0.15 ? pct(value, 0) : '';
      attachTip(segment, `<b>${t(key)}</b><br>${pct(value, 1)}`);
      odds.appendChild(segment);
    }
    row.appendChild(odds);
    const stake = (report.high_stakes || []).find((entry) =>
      String(entry.match_id) === String(match.match_id) && String(entry.team_id) === String(teamId));
    if (stake) label.appendChild(stakeDot(stake, report, report.table.length));
  }
  return row;
}

/* Win, draw and loss in the odds bars' colours, said once above the rows. */
function teamOddsLegend() {
  const legend = el('div', 'legend team-match__legend');
  for (const [outcome, key] of [['home', 'team.oddsWin'], ['draw', 'next.draw'], ['away', 'team.oddsLoss']]) {
    const entry = el('span', 'legend__key');
    const swatch = el('span', 'legend__swatch');
    swatch.style.background = `var(--${outcome})`;
    entry.append(swatch, el('span', '', t(key)));
    legend.appendChild(entry);
  }
  return legend;
}

function renderTeamFixtures(teamId, teamName, report, container) {
  const allFixtures = (report.fixtures || []).filter(
    (f) => String(f.home_id) === String(teamId) || String(f.away_id) === String(teamId)
  );
  if (!allFixtures.length) return;

  const PAGE = 6;
  const totalPages = Math.ceil(allFixtures.length / PAGE);
  state.teamFixturesPage = Math.min(state.teamFixturesPage, totalPages - 1);
  const page = state.teamFixturesPage;
  const fixtures = allFixtures.slice(page * PAGE, (page + 1) * PAGE);

  const section = el('div', 'team-section');
  const header = el('div', 'team-section__header');
  header.appendChild(el('div', 'label', t('team.upcomingFixtures', { n: allFixtures.length })));
  header.appendChild(teamOddsLegend());
  section.appendChild(header);
  const list = el('div', 'team-matches');
  for (const fixture of fixtures) list.appendChild(teamMatchRow(fixture, teamId, report));
  section.appendChild(list);
  if (totalPages > 1) {
    section.appendChild(paginator(page, totalPages, (p) => { state.teamFixturesPage = p; renderTeamView(report); }));
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

  const PAGE = 8;
  const totalPages = Math.ceil(sorted.length / PAGE);
  state.teamResultsPage = Math.min(state.teamResultsPage, totalPages - 1);
  const page = state.teamResultsPage;
  const matches = sorted.slice(page * PAGE, (page + 1) * PAGE);

  const section = el('div', 'team-section');
  const header = el('div', 'team-section__header');
  header.appendChild(el('div', 'label', t('team.recentResults', { n: allResults.length })));
  section.appendChild(header);
  const list = el('div', 'team-matches');
  for (const match of matches) list.appendChild(teamMatchRow(match, teamId, report, ratingChanges));
  section.appendChild(list);
  if (totalPages > 1) {
    section.appendChild(paginator(page, totalPages, (p) => { state.teamResultsPage = p; renderTeamView(report); }, true));
  }
  container.appendChild(section);
}

/* Below this container width the chart gets a viewBox of its own width: a
   phone reads the 900-wide desktop box at ~0.4 scale, which shrinks the 10px
   ticks to 4px. `lastShape` is what a window resize redraws when the chart
   crosses that width. */
const SHAPE_NARROW = 640;
let lastShape = null;

/* Season-shape fills: each place in the colour of what it is worth -- the
   band colours of the table's markers -- so the title, Europe and the drop
   read as areas, where sixteen steps of one blue left 1st and 2nd alike.
   Places sharing a band fade away from its best place (for the bottom bands,
   towards the drop); play-offs are a paler version of the band beside them,
   and mid-table is neutral, alternating so neighbours stay apart. */
function shapeColor(position, bands, count) {
  const band = bandFor(bands, position);
  if (!band) return `color-mix(in srgb, var(--ink-faint) ${position % 2 ? 34 : 22}%, var(--panel))`;
  const bottom = band.first > count / 2;
  let step = 0;
  for (let p = bottom ? band.last : band.first; p !== position; p += bottom ? -1 : 1) {
    if (bandFor(bands, p) === band) step += 1;
  }
  const strength = band.tone === 'playoff' ? 55 : 100;
  return `color-mix(in srgb, ${bandColor(band, count)} ${Math.max(35, strength - step * 22)}%, var(--panel))`;
}

/* What the season-shape colours mean, under the chart. */
function shapeLegend(report) {
  const legend = el('div', 'legend shape-legend');
  const bands = report.league.bands;
  const count = report.table.length;
  for (const band of bands) {
    const best = band.first > count / 2 ? band.last : band.first;
    const position = [best, band.first, band.last].find((p) => bandFor(bands, p) === band);
    if (position == null) continue;
    const entry = el('span', 'legend__key');
    const swatch = el('span', 'legend__swatch');
    swatch.style.background = shapeColor(position, bands, count);
    entry.append(swatch, el('span', '', bandName(band)));
    legend.appendChild(entry);
  }
  return legend;
}

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
    });
    band.style.fill = shapeColor(position, report.league.bands, count);

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
    const centre = cumulative[bestAt][position] - best / 2;
    // A band that peaks on the first or last snapshot would otherwise centre
    // its numeral half off the plot; hold it a little inside the edge.
    const NUMERAL_EDGE = 14;
    const label = svgEl('text', {
      class: 'band-pos',
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

  const MONTH_GAP = narrow ? 26 : 30;
  let lastMonthX = -Infinity;
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
    if (xPos - lastMonthX < MONTH_GAP) continue;
    lastMonthX = xPos;

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

/* A rewound payload carries only the matchdays played by the day it
   was built for, so a range read from it shrinks as you rewind and
   the slider could no longer slide forward. The live report -- the
   one boot and the season picker load, which never carries an asof --
   spans the whole season; keep its matchdays per league (the divisions
   play on different days) and read the slider's range from those. */
let liveMatchdays = {};

function rememberLiveMatchdays(reports) {
  liveMatchdays = {};
  for (const [league, report] of Object.entries(reports)) {
    const days = matchdays(report);
    // The pre-season view goes first: the prediction before a ball was
    // kicked (dated the day before either division's first match).
    const preseason = report.league.preseason;
    liveMatchdays[league] = preseason && days.length
      ? [{ date: preseason, matches_played: 0, preseason: true }, ...days]
      : days;
  }
}

/* The pre-season stop has no matchday to name, so it reads as what it is. */
function dayLabel(day) {
  return day.preseason ? t('timeline.preseason') : whenDate(day.date);
}

function dayText(day, key) {
  return day.preseason ? t('timeline.preseason') : t(key, { when: whenDate(day.date) });
}

function dayShort(day) {
  return day.preseason ? t('mountain.preseason') : formatDate(day.date);
}

function liveMatchdaysFor(league) {
  return liveMatchdays[league] || [];
}

/* Where the slider sits in the live matchdays: at live, on the last
   one; rewound, on the last matchday on or before the date -- the
   divisions play on different days, so the date may not be one of
   this league's own. A range that has not loaded yet has no index,
   which leaves the slider hidden. */
function matchdayIndex(days, asof) {
  if (!days.length) return null;
  if (!asof) return days.length - 1;
  return Math.max(0, days.findLastIndex((day) => day.date <= asof));
}

function renderTimeline(report) {
  const panel = $('#timeline');
  const days = liveMatchdaysFor(state.league);
  const range = $('#timeline-range');

  // A season with nothing played has nothing to rewind through.
  panel.hidden = days.length < 2;
  if (panel.hidden) return;

  if (Number(range.max) !== days.length - 1) {
    range.max = String(days.length - 1);
    range.step = '1';
  }

  const index = matchdayIndex(days, state.asof);
  range.value = String(index);

  const day = days[index];
  const live = !state.asof || index === days.length - 1;
  panel.classList.toggle('is-past', !live);
  $('#timeline-now').hidden = live;

  range.setAttribute('aria-valuetext', live ? t('timeline.scrubLive') : dayLabel(day));
  const total = report.model.matches_played + report.model.matches_remaining;
  $('#timeline-when').textContent = live ? t('timeline.liveCount', { n: day.matches_played })
    : day.preseason ? t('timeline.preseason')
      : t('timeline.asOf', { when: whenDate(day.date), n: day.matches_played, total });

  $('#timeline-back').disabled = index <= 0;
  $('#timeline-forward').disabled = index >= days.length - 1;

  const scale = $('#timeline-scale');
  scale.replaceChildren();
  const first = new Date(`${days[0].date}T12:00:00Z`);
  const last = new Date(`${days[days.length - 1].date}T12:00:00Z`);
  const month = (d) => d.toLocaleDateString(localeDate(), { month: 'short', year: 'numeric' });
  scale.appendChild(el('span', '', month(first)));
  scale.appendChild(el('span', '', t('timeline.matchdays', { n: days.filter((day) => !day.preseason).length })));
  scale.appendChild(el('span', '', month(last)));
}

/* Dragging fires continuously; only the value you settle on is worth a fetch. */
function onTimelineInput(event) {
  const days = liveMatchdaysFor(state.league);
  const index = Number(event.target.value);
  const day = days[index];
  if (!day) return;

  // If animating, scrub within prefetched data instead of fetching
  if (anim.playing) {
    anim.matchdayIndex = index;
    anim.lastTick = performance.now();
    animFrame(0);
    $('#timeline-when').textContent = dayText(day, 'timeline.paused');
    $(`#${animView()}-anim-when`).textContent = dayShort(day);
    return;
  }

  const live = index === days.length - 1;
  event.target.setAttribute('aria-valuetext', live ? t('timeline.scrubLive') : dayLabel(day));
  $('#timeline-when').textContent = live ? t('timeline.scrubLive') : dayText(day, 'timeline.scrubAsOf');
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

/* Clear skeletons after render */
function clearSkeleton(view) {
  const section = document.querySelector(`[data-section="${view}"]`);
  if (!section) return;
  section.querySelectorAll('.skeleton-row, .skeleton-fixture, .skeleton-played-card, .skeleton-grid-cell, .skeleton-ladder-row').forEach(el => el.remove());
}

/* ---------- wiring -------------------------------------------------- */

function render() {
  const report = state.reports[state.league];
  // A readout raised on the old view would float over the new one: a tap on
  // a club name both raises the stake readout and opens the club.
  hideTooltip();

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
  const noRewind = new Set(['matches', 'compare', 'model', 'team']);
  const timelineSection = document.querySelector('.timeline-section');
  // In explore only the views of one rewound report follow it (EXPLORE_REWIND);
  // the mountain has its own build-up.
  if (timelineSection) {
    timelineSection.hidden = noRewind.has(state.activeView)
      || (state.activeView === 'explore' && !EXPLORE_REWIND.has(state.exploreItem));
  }
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
    case 'table':
      renderStandings(report);
      renderBandLegend(report);
      break;
    case 'grid':
      if (!anim.playing) {
        renderGrid(report);
        renderGridLegend();
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
  if (state.activeView === 'explore' && state.exploreItem) params.set('viz', state.exploreItem);
  else params.delete('viz');
  // Season and rewind date too, so a reload or a shared link lands where the
  // reader was; boot reads both back.
  if (report.league.season !== report.league.current_season) params.set('season', report.league.season);
  else params.delete('season');
  if (state.asof) params.set('asof', state.asof);
  else params.delete('asof');
  if (state.league !== 'eliteserien') params.set('league', state.league);
  else params.delete('league');
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}${window.location.hash}`);

  // One search result per division: the canonical keeps only the league, so
  // view, team, season and rewind links all fold into their division's page.
  const meta = { league: report.league.name, season: report.league.season, chances: t(`meta.chances.${state.league}`) };
  document.title = t('meta.title', meta);
  document.querySelector('meta[name=description]').content = t('meta.desc', meta);
  let canonical = document.querySelector('link[rel=canonical]');
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.rel = 'canonical';
    document.head.appendChild(canonical);
  }
  canonical.href = `https://elitetracker.no/${state.league === 'eliteserien' ? '' : `?league=${state.league}`}`;
  state._prevActiveView = state.activeView;
}

// Switch the active view: shared by top-strip/bar clicks and the bar swipe.
function switchView(view) {
  closeSheet();
  if (anim.playing && view !== state.activeView) animStop();
  // The Explore tab always opens on its gallery.
  if (view === 'explore') state.exploreItem = null;
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
      track('set_theme', { theme: localStorage.getItem('elitetracker-theme') || 'system' });
    });
  }

  for (const button of document.querySelectorAll('[data-lang]')) {
    button.addEventListener('click', () => {
      const lang = button.dataset.lang;
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
/* The masthead's tabs that do not fit go behind a "More" tab, last first, as
   the phone's More sheet holds what its bottom bar has no room for; More is
   marked when the open view is among them. Measured rather than set by a
   breakpoint, since the labels' width differs by language. A phone hides the
   whole strip for its bottom bar. */
function fitViews() {
  const holder = $('.masthead__views');
  const more = $('#views-more');
  if (!holder || !more) return;
  const tabs = [...holder.querySelectorAll('.switch [data-view]')];
  const items = new Map([...document.querySelectorAll('#views-more-menu [data-view]')].map((item) => [item.dataset.view, item]));
  for (const tab of tabs) {
    tab.hidden = false;
    items.get(tab.dataset.view).hidden = true;
  }
  more.hidden = true;
  const fits = () => holder.scrollWidth <= holder.clientWidth + 1;
  if (holder.offsetParent && !fits()) {
    more.hidden = false;
    for (const tab of [...tabs].reverse()) {
      if (fits()) break;
      tab.hidden = true;
      items.get(tab.dataset.view).hidden = false;
    }
  }
  more.setAttribute('aria-pressed', String(tabs.some((tab) => tab.hidden && tab.dataset.view === state.activeView)));
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
  const params = new URLSearchParams(window.location.search);
  const asked = params.get('view');
  // Next Up and Played Results were merged into Matches; old links still land.
  const view = asked === 'next-up' || asked === 'played' ? 'matches' : asked;
  const validViews = new Set(['table', 'grid', 'ladder', 'matches', 'compare', 'explore', 'team', 'model']);
  if (view && validViews.has(view)) {
    state.activeView = view;
    if (EXPLORE_ITEMS.includes(params.get('viz'))) state.exploreItem = params.get('viz');
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
/* Eliteserien only (report.model.surface): a home side whose visitor plays on
   the other surface gets `edge` rating points on the prediction, as
   normalize/surfaces.py does on the server. */
function surfaceEdge(model, homeId, awayId) {
  const surface = model.surface;
  if (!surface) return 0;
  const grass = new Set(surface.grass.map(String));
  return grass.has(String(homeId)) !== grass.has(String(awayId)) ? surface.edge : 0;
}

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
  const edge = surfaceEdge(report.model, homeId, awayId);
  const odds = blendOdds(report.model, matchOdds(report.model, homeRating + edge, awayRating), homeId, awayId);
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
    // The shared page control sits above the list, as on Matches;
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
  initConsent();
  
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
      track('load_error', { file: 'careers', message: error.message });
      $('#status').hidden = false;
      $('#status').textContent = t('status.couldNotLoad', { season: 'careers', error: error.message });
    }
    
    state.reports = applyShortNames(reports);
    rememberLiveMatchdays(state.reports);
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
    track('load_error', { file: 'report', message: error.message });
    $('#status').textContent =
      t('status.couldNotLoadSeason', { error: error.message });
  }
}

/* ---------- analytics ----------------------------------------------- */

/* Google Analytics (the Firebase project's GA4 stream) loads only after the
   reader says yes: Norwegian law wants consent before non-essential cookies.
   Production only, so local runs and PR previews don't count. GA4's enhanced
   measurement turns the replaceState in render() into page views. */
const GA_ID = 'G-RCMKSGYDSJ';

function loadAnalytics() {
  if (location.hostname !== 'elitetracker.no' || window.gtag) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { dataLayer.push(arguments); };
  gtag('js', new Date());
  gtag('config', GA_ID);
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.append(script);
}

/* Stored as 'yes:<ms>' or 'no:<ms>'; an answer older than a year counts as
   none, so the reader is asked again (public/personvern.html promises this). */
function initConsent() {
  const bar = $('#consent');
  const [choice, at] = (localStorage.getItem('elitetracker-analytics') || '').split(':');
  const fresh = Date.now() - Number(at) < 365 * 24 * 3600 * 1000;
  if (choice === 'yes' && fresh) loadAnalytics();
  else if (!fresh) bar.hidden = false;
  bar.addEventListener('click', (event) => {
    const answer = event.target.closest('[data-consent]')?.dataset.consent;
    if (!answer) return;
    localStorage.setItem('elitetracker-analytics', `${answer}:${Date.now()}`);
    bar.hidden = true;
    if (answer === 'yes') return loadAnalytics();
    if (!window.gtag) return;
    // Withdrawn after saying yes: drop GA's cookies and reload without it.
    for (const name of document.cookie.split('; ').map((c) => c.split('=')[0]).filter((n) => n.startsWith('_ga'))) {
      document.cookie = `${name}=; Max-Age=0; path=/; domain=.${location.hostname}`;
    }
    location.reload();
  });
  $('#consent-open').addEventListener('click', () => { bar.hidden = false; });
}

/* What a page view can't show: which in-page tools get used. A no-op until
   the reader has said yes. Params need a custom dimension in GA to report. */
function track(name, params) {
  window.gtag?.('event', name, params);
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
    // The mountain locks the page at the top, so every downward drag that
    // turns it would otherwise pull to refresh.
    if (document.body.dataset.viz === 'mountain') return;
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
    ptrIndicator.style.height = `${pullDistance}px`;
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
    ptrIndicator.style.height = '60px';
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
    ptrIndicator.classList.remove('pulling', 'loading');
    ptrIndicator.style.height = '';
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
      track('swipe_view', { view: nextView });
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
    if (lastTeamChart?.chart.isConnected) {
      const width = lastTeamChart.chart.getBoundingClientRect().width;
      if (width && (width < SHAPE_NARROW) !== lastTeamChart.narrow) drawTeamChart(lastTeamChart.career);
    }
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
