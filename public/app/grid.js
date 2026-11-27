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
  // A cell with a chance opens how it happens, wherever a season is left to play.
  table.classList.toggle('grid--live', scenarioAvailable(report));

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
    // The phone's full grid names the club in three letters (clubCode).
    const code = el('span', 'grid__code', clubCode(row.team));
    code.setAttribute('aria-hidden', 'true');
    label.appendChild(code);
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
        return `<b>${esc(row.team)}</b> ${ordinal(position)}<br>${pct(prob, 2)}` + (band ? `<br>${bandName(band)}` : '');
      };
      // Roving tabindex: one stop for the whole grid, arrows move within it.
      cell.setAttribute('tabindex', rowIndex === 0 && index === 0 ? '0' : '-1');
      cell.setAttribute('role', 'gridcell');
      // A tap on a square that opens what it takes goes straight to the
      // popup, whose head shows the chance; a readout first would only flash
      // under it. Squares that open nothing still show their decimals.
      const opens = () => !anim.gridTableData && probability >= 0.005 && probability <= 0.9995 && scenarioAvailable(report);
      cell.addEventListener('pointerenter', (event) => {
        scenarioWarm(report);
        if (event.pointerType === 'touch' && opens()) return;
        showTooltip(event, cell.tip(), cell);
      });
      cell.addEventListener('pointermove', moveTooltip);
      cell.addEventListener('click', () => {
        // Not while the season replays (the cells then show another day), and not on a cell that is nothing or certain.
        if (!opens()) return;
        openScenario(report, row.team_id, position, cell);
      });
      cell.addEventListener('pointerleave', (event) => { if (event.pointerType !== 'touch') hideTooltip(); });
      cell.addEventListener('focus', () => {
        scenarioWarm(report);
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
    case 'Enter':
    case ' ':
      event.preventDefault();
      cell.click();
      break;
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

/* The finish grid on a phone, "Zones": a column per thing a club can win or
   lose (Eliteserien: the title, Europe, the relegation play-off, relegation;
   OBOS-ligaen: promotion, the promotion play-off, relegation), each its
   chance as the grid paints it, wide enough to read and tap. Europe is every
   European place at once (the Champions League and Conference League bands
   together); promotion and relegation count the play-offs where the report
   has them, as the table does (bandChance). A tap on a club opens its chance
   of every place (openFinishSheet). "All places" is the full grid, scrolling
   sideways. The choice is kept per browser. */
const GRID_MODE_KEY = 'elitetracker-grid-mode';
function gridMode() {
  try { return localStorage.getItem(GRID_MODE_KEY) === 'all' ? 'all' : 'zones'; } catch { return 'zones'; }
}

function gridZoneColumns(report) {
  const bands = report.league.bands || [];
  const slug = report.league.slug;
  const count = report.table.length;
  const good = (band) => band.first < (count + 1) / 2;
  const cols = [];
  if (slug === 'obosligaen') {
    const top = bands.find((b) => b.tone === 'top');
    if (top) cols.push({ key: 'promotion', label: t('grid.zone.promotion'), band: top, p: (row) => bandChance(row, top, slug) });
  } else {
    const champion = bands.find((b) => b.tone === 'champion');
    if (champion) cols.push({ key: 'title', label: t('grid.zone.title'), band: champion, p: (row) => bandChance(row, champion, slug) });
    const europe = bands.filter((b) => b.tone === 'top' || b.tone === 'europe');
    if (europe.length) {
      const first = Math.min(...europe.map((b) => b.first));
      const last = Math.max(...europe.map((b) => b.last));
      cols.push({
        key: 'europe', label: t('grid.zone.europe'), band: europe[europe.length - 1],
        p: (row) => row.position_probabilities.slice(first - 1, last).reduce((a, b) => a + b, 0),
      });
    }
  }
  const playoffs = bands.filter((b) => b.tone === 'playoff');
  const playoff = playoffs.find(good) || playoffs[0];
  if (playoff) cols.push({ key: 'playoff', label: t('grid.zone.playoff'), band: playoff, p: (row) => bandChance(row, playoff, slug) });
  const relegation = bands.find((b) => b.tone === 'relegation');
  if (relegation) cols.push({ key: 'relegation', label: t('grid.zone.relegation'), band: relegation, p: (row) => bandChance(row, relegation, slug) });
  return cols;
}

/* A club's code for the full grid's narrow first column on a phone: the
   initials Norwegian football writes them in (S08, RBK, LSK, AaFK, ...), by
   the name the site shows (shortName); a club not listed gets its first
   three letters. */
const CLUB_CODES = {
  'Aalesund': 'AaFK', 'Alta': 'ALTA', 'Arendal': 'ARE', 'Blink': 'BLI', 'Bodø/Glimt': 'B/G',
  'Brann': 'BRA', 'Bryne': 'BRY', 'Bærum': 'BSK', 'Egersund': 'EIK', 'Follo': 'FOL',
  'Fredrikstad': 'FFK', 'HamKam': 'HAM', 'Haugesund': 'FKH', 'Hødd': 'HØD', 'Hønefoss': 'HBK',
  'Jerv': 'JERV', 'KFUM': 'KFUM', 'Kongsvinger': 'KIL', 'Kristiansund': 'KBK', 'Levanger': 'LFK',
  'Lillestrøm': 'LSK', 'Lyn': 'LYN', 'Mjøndalen': 'MIF', 'Molde': 'MOL', 'Moss': 'MOS',
  'Odd': 'ODD', 'Ranheim': 'RAN', 'Raufoss': 'RAU', 'Rosenborg': 'RBK', 'Sandefjord': 'SAN',
  'Sandnes Ulf': 'ULF', 'Sarpsborg 08': 'S08', 'Skeid': 'SKE', 'Sogndal': 'SOG', 'Stabæk': 'STB',
  'Start': 'STA', 'Strømmen': 'STR', 'Strømsgodset': 'SIF', 'Tromsdalen': 'TUIL', 'Tromsø': 'TIL',
  'Ull/Kisa': 'U/K', 'Viking': 'VIK', 'Vålerenga': 'VIF', 'Øygarden': 'ØYG', 'Åsane': 'ÅSA',
};
function clubCode(name) {
  return CLUB_CODES[name] || (String(name).match(/\p{L}/gu) || []).slice(0, 3).join('').toUpperCase();
}

function renderGridZones(report) {
  const holder = $('#grid-zones');
  if (!holder) return;
  const mode = gridMode();
  holder.closest('[data-section]').dataset.gridMode = mode;
  for (const btn of document.querySelectorAll('[data-grid-mode]')) btn.setAttribute('aria-pressed', String(btn.dataset.gridMode === mode));
  const cols = gridZoneColumns(report);
  const rows = [...report.table].sort((a, b) => expectedFinish(a) - expectedFinish(b) || a.position - b.position);
  const table = el('table', 'grid-zones');
  table.appendChild(el('caption', 'visually-hidden', t('grid.zone.caption')));
  const head = el('thead');
  const headRow = el('tr');
  const corner = el('th', 'grid-zones__corner', t('table.col.club'));
  corner.scope = 'col';
  headRow.appendChild(corner);
  for (const col of cols) {
    const th = el('th', '', col.label);
    th.scope = 'col';
    th.style.setProperty('--band-color', bandColor(col.band, rows.length));
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    const th = el('th', 'grid-zones__club');
    th.scope = 'row';
    const open = el('button', 'grid-zones__open');
    open.type = 'button';
    const crest = teamLogo(row.team_id, row.team, true);
    if (crest) { crest.alt = ''; crest.setAttribute('aria-hidden', 'true'); }
    open.append(el('span', 'grid-zones__pos', String(row.position)));
    if (crest) open.appendChild(crest);
    open.append(el('span', 'grid-zones__name', row.team));
    open.setAttribute('aria-label', t('grid.zone.open', { team: row.team }));
    open.addEventListener('click', () => openFinishSheet(report, row, open));
    th.appendChild(open);
    tr.appendChild(th);
    for (const col of cols) {
      const p = col.p(row);
      const td = paintCell(el('td'), p);
      if (p >= 0.995) td.textContent = '100';
      td.setAttribute('aria-label', `${col.label}: ${pct(p, 1)}`);
      tr.appendChild(td);
    }
    // The whole row is the target; the club's button is its keyboard stop.
    tr.addEventListener('click', (event) => { if (!event.target.closest('button')) open.click(); });
    body.appendChild(tr);
  }
  table.appendChild(body);
  holder.replaceChildren(table);
}

/* A club's chance of every place, as a bottom sheet on a phone (the popup's
   shape): a bar per place in its band's colour and, on every place with a
   chance where a season is left, the way into what it takes. */
function openFinishSheet(report, row, trigger = null) {
  closeScenario({ restore: false });
  const root = el('div', 'scenario finish-sheet');
  const scrim = el('div', 'scenario__scrim');
  const panel = el('div', 'scenario__panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'finish-sheet-title');
  const close = el('button', 'scenario__close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', t('scenario.close'));
  const heading = el('div', 'scenario__heading');
  heading.appendChild(el('p', 'scenario__eyebrow', t('grid.zone.sheetEyebrow')));
  const title = el('h2', 'scenario__title');
  title.id = 'finish-sheet-title';
  const crest = teamLogo(row.team_id, row.team, true);
  if (crest) title.appendChild(crest);
  title.appendChild(document.createTextNode(row.team));
  heading.appendChild(title);
  const head = el('header', 'scenario__head');
  head.append(heading, close);
  const grip = el('div', 'scenario__grip');
  grip.setAttribute('aria-hidden', 'true');
  const top = el('div', 'scenario__top');
  top.append(grip, head);
  const list = el('ol', 'finish-sheet__places');
  const count = report.table.length;
  const live = scenarioAvailable(report);
  const most = Math.max(...row.position_probabilities);
  row.position_probabilities.forEach((p, index) => {
    const position = index + 1;
    const item = el('li', 'finish-sheet__place');
    const band = bandFor(report.league.bands, position);
    if (band) item.style.setProperty('--band-color', bandColor(band, count));
    const bar = el('span', 'finish-sheet__bar');
    bar.style.setProperty('--p', `${most ? (p / most) * 100 : 0}%`);
    item.append(el('span', 'finish-sheet__pos', rankText(position)), bar, el('span', 'finish-sheet__pct', pct(p, 1)));
    if (live && p >= 0.005 && p <= 0.9995) {
      const go = el('button', 'finish-sheet__go', t('grid.zone.whatItTakes'));
      go.type = 'button';
      go.setAttribute('aria-label', t('grid.zone.whatItTakesFor', { team: row.team, place: ordinal(position) }));
      go.addEventListener('click', () => openScenario(report, row.team_id, position, trigger));
      item.appendChild(go);
    } else item.classList.add('is-quiet');
    list.appendChild(item);
  });
  const team = el('button', 'team-mini__full finish-sheet__team', t('grid.zone.toClub', { team: row.team }));
  team.type = 'button';
  team.addEventListener('click', () => { closeScenario({ restore: false }); openTeamView(row.team_id, row.team); });
  panel.append(top, list, team);
  root.append(scrim, panel);
  document.body.appendChild(root);
  document.body.classList.add('has-scenario');
  const onKey = (event) => { if (event.key === 'Escape') dismissScenario(); };
  document.addEventListener('keydown', onKey);
  // It shares the popup's state, so opening "what it takes" from it, or
  // closing it, goes through closeScenario like the popup.
  Object.assign(scenarioState, { root, trigger, onKey, untrap: trapFocus(panel) });
  scrim.addEventListener('click', dismissScenario);
  close.addEventListener('click', dismissScenario);
  pushOverlay('scenario');
  attachSheetDrag(panel, { scrim, dismiss: dismissScenario, handle: '.scenario__top' });
  close.focus();
}

if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-grid-mode]');
  if (!btn) return;
  try { localStorage.setItem(GRID_MODE_KEY, btn.dataset.gridMode); } catch { /* private window */ }
  const report = state.reports[state.league];
  if (report) renderGridZones(report);
  track('grid_mode', { mode: btn.dataset.gridMode });
});

function renderGrid(report) {
  const table = buildGrid(report, report.table);
  renderGridZones(report);
  // Restart the load animation whenever the grid is rebuilt.
  const wrap = table.parentElement;
  wrap.classList.remove('grid-animate');
  void wrap.offsetWidth;
  wrap.classList.add('grid-animate');
}

/* ---------- finish-grid animation ---------------------------------- */

/* One file per season holds every matchday's club rows (bundles.py), in place
   of a full report per day. A season published before that file existed has
   none; its callers then fall back to the per-day reports. */
const timelines = new Map();
function fetchTimeline(season) {
  if (!timelines.has(season)) {
    timelines.set(season, fetch(`/data/timeline-${season}.json`)
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null));
  }
  return timelines.get(season);
}

/* One timeline date as report-shaped tables: just the fields the animation and
   the mountain read. Names come from `names` (team id to name, as the loaded
   report spells them), since the file holds ids only. Null for a date it lacks. */
function timelineReports(timeline, date, names) {
  const day = timeline?.dates?.[date];
  if (!day) return null;
  const reports = {};
  for (const [slug, rows] of Object.entries(day)) {
    reports[slug] = {
      table: rows.map(([teamId, position, rating, probabilities]) => ({
        team_id: teamId, team: names.get(String(teamId)), position, rating, position_probabilities: probabilities,
      })),
    };
  }
  return reports;
}

/* The Luck table and the scorecard read the same few fields from every
   season's report; seasons-summary.json (bundles.py) holds just those, shaped
   like the reports, so one fetch replaces one per season. Null where the file
   is missing, and each season then falls back to its own report. */
let seasonsSummary = null;
function fetchSummary() {
  seasonsSummary = seasonsSummary || fetch('/data/seasons-summary.json')
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      for (const season of Object.values(data?.seasons || {})) applyShortNames(season);
      return data;
    })
    .catch(() => null);
  return seasonsSummary;
}

/* Run `task` over `items` with at most `limit` in flight, reporting each one
   done (`onDone(count, total)`); results keep the items' order. A failed
   task gives null. */
async function inBatches(items, task, limit = 6, onDone = () => {}) {
  const results = new Array(items.length).fill(null);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await task(items[i], i); } catch { results[i] = null; }
      onDone(++done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/* The season's matchday reports for a replay: from the one timeline file
   where it has them, else a report per matchday, six at a time (sixty-odd at
   once stalled a phone on a mobile connection) with a count on screen. */
async function prefetchAnimReports(onProgress = () => {}) {
  const days = liveMatchdaysFor(state.league);
  if (days.length < 2) return null;
  const timeline = await fetchTimeline(state.season);
  const names = new Map(Object.values(state.reports).flatMap((r) => r.table.map((row) => [String(row.team_id), row.team])));
  const quick = new Map();
  days.forEach((d, i) => { const day = timelineReports(timeline, d.date, names); if (day) quick.set(i, day); });
  if (quick.size === days.length) return quick;
  const fetched = await inBatches(days,
    (d) => fetch(reportUrl(state.season, d.date)).then((r) => (r.ok ? r.json().then(applyShortNames) : null)),
    6, onProgress);
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
  anim.reports = await prefetchAnimReports((n, total) => {
    holder.dataset.loadingText = t('anim.loadingCount', { n: num(n), total: num(total) });
  });
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

if (typeof module !== 'undefined') {
  module.exports = { expectedFinish, timelineReports };
}
