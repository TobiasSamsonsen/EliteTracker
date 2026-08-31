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
  // Active view tab: 'grid', 'table', 'ladder', 'next-up', 'played', 'shape', 'compare', 'model'
  activeView: 'grid',
  // Pagination for played results.
  playedWeek: 0,
};

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

function moveTooltip(event) {
  const pad = 14;
  const box = tooltip.getBoundingClientRect();
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

function renderGrid(report) {
  const table = $('#grid');
  const rows = [...report.table].sort(
    (a, b) => expectedFinish(a) - expectedFinish(b) || a.position - b.position,
  );
  const count = rows.length;

  table.replaceChildren(table.querySelector('caption'));

  const head = el('thead');

  // The band strip lives inside the table so it inherits the column geometry
  // exactly; positioning it separately drifts as soon as the table is centred.
  const bandRow = el('tr', 'grid__bands');
  bandRow.appendChild(el('td', '', ''));
  for (let position = 1; position <= count; position += 1) {
    const band = bandFor(report.league.bands, position);
    const cell = el('td');
    const bar = el('span', 'band-strip__seg');
    if (band) {
      bar.style.background = bandColor(band, count);
      bar.title = band.label;
    }
    cell.appendChild(bar);
    bandRow.appendChild(cell);
  }
  head.appendChild(bandRow);

  const headRow = el('tr');
  headRow.appendChild(el('th', '', ''));
  for (let position = 1; position <= count; position += 1) {
    const cell = el('th', '', String(position));
    cell.scope = 'col';
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);
  table.appendChild(head);

  const body = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    const label = el('th', 'grid__team');
    label.scope = 'row';
    label.appendChild(el('span', 'pos', String(row.position)));
    const crest = teamLogo(row.team_id, row.team);
    if (crest) label.appendChild(crest);
    label.appendChild(document.createTextNode(row.team));
    tr.appendChild(label);

    row.position_probabilities.forEach((probability, index) => {
      const step = heatStep(probability);
      const cell = el('td', `cell ${heatTextClass(step)}`.trim());
      cell.style.background = seqStepColor(step);
      cell.style.setProperty('--col', String(index));
      cell.textContent = pctShort(probability);
      if (!cell.textContent) cell.classList.add('cell--empty');

      const position = index + 1;
      const band = bandFor(report.league.bands, position);
      cell.addEventListener('pointerenter', (event) =>
        showTooltip(
          event,
          `<b>${row.team}</b> finishes ${ordinal(position)}<br>${pct(probability, 2)}` +
            (band ? `<br>${band.label}` : '')
        )
      );
      cell.addEventListener('pointermove', moveTooltip);
      cell.addEventListener('pointerleave', hideTooltip);
      tr.appendChild(cell);
    });
    body.appendChild(tr);
  }
  table.appendChild(body);

  // Restart the load animation whenever the grid is rebuilt.
  const wrap = table.parentElement;
  wrap.classList.remove('grid-animate');
  void wrap.offsetWidth;
  wrap.classList.add('grid-animate');

  $('#grid-count').textContent = `${count} clubs × ${count} places`;
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
  const suffix = ['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th';
  return `${n}${suffix}`;
}

/* ---------- legends ----------------------------------------------- */

function renderGridLegend() {
  const legend = $('#grid-legend');
  legend.replaceChildren();

  legend.appendChild(el('span', 'label', 'Chance of finishing there'));
  const key = el('span', 'legend__key');
  key.appendChild(el('span', '', 'never'));
  const ramp = el('span', 'legend__ramp');
  for (let step = 1; step <= SEQ_STEPS; step += 1) {
    const swatch = el('i');
    swatch.style.background = seqStepColor(step);
    ramp.appendChild(swatch);
  }
  key.appendChild(ramp);
  key.appendChild(el('span', '', 'certain'));
  legend.appendChild(key);

  legend.appendChild(el('span', '', 'Cells show whole percent; hover for the exact figure.'));
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
  legend.appendChild(el('span', 'label', 'Result'));
  for (const [outcome, name] of [['home', 'Home win'], ['draw', 'Draw'], ['away', 'Away win']]) {
    const key = el('span', 'legend__key');
    const swatch = el('span', 'legend__swatch');
    swatch.style.background = `var(--${outcome})`;
    key.appendChild(swatch);
    key.appendChild(el('span', '', name));
    legend.appendChild(key);
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
  $('#head-first').textContent = promotion ? 'Promotion' : 'Champion';
  $('#head-first-short').textContent = promotion ? 'Up' : 'Title';
  $('#head-first-desc').textContent = promotion
    ? ', chance of promotion'
    : ', chance of winning the title';
  $('#head-last').textContent = 'Relegation';
  renderSortHeaders();

  const formByTeamName = formByTeam(report.results);
  const rows = standingsRows(report).map((row) => ({
    ...row,
    form: formPoints(formByTeamName[row.team]),
  }));

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
      openCareer(row.team_id, row.team);
    });
    club.appendChild(clubButton);
    tr.appendChild(club);
    // 'extra' marks the tallies a phone drops -- see .col--extra in the CSS.
    for (const [key, extra] of [
      ['played', false], ['wins', true], ['draws', true],
      ['losses', true], ['goals_for', true], ['goals_against', true],
    ]) {
      tr.appendChild(el('td', `num muted${extra ? ' col--extra' : ''}`, String(row[key])));
    }
    tr.appendChild(el('td', 'num', row.goal_difference > 0 ? `+${row.goal_difference}` : String(row.goal_difference)));
    const points = el('td', 'num', String(row.points));
    points.style.fontWeight = '700';
    tr.appendChild(points);

    tr.appendChild(el('td', 'num sep', row.rating.toFixed(0)));
    tr.appendChild(el('td', 'num muted col--extra', row.expected_points.toFixed(1)));
    const formTd = el('td', 'num form col--extra');
    formTd.appendChild(formChipsEl(formByTeamName[row.team]));
    tr.appendChild(formTd);

    tr.appendChild(meterCell(row.up, 'up'));
    tr.appendChild(meterCell(row.down, 'down'));

    // Clicking anywhere on the row is a mouse convenience on top of that
    // button; it adds no keyboard or ARIA semantics of its own.
    tr.addEventListener('click', () => openCareer(row.team_id, row.team));
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

function renderShape(report) {
  const history = report.history;
  const select = $('#shape-team');
  const teams = history.teams;

  // Keep the chosen club when switching leagues if it plays in both (it will
  // not), otherwise fall back to the league leader.
  const previous = select.value;
  select.replaceChildren();
  for (const team of [...teams].sort((a, b) => a.team.localeCompare(b.team, 'nb'))) {
    const option = el('option', '', team.team);
    option.value = team.team_id;
    select.appendChild(option);
  }
  const fallback = report.table[0].team_id;
  select.value = teams.some((t) => t.team_id === previous) ? previous : fallback;

  $('#shape-rounds').textContent = `${history.dates.length} snapshots`;
  $('#ramp-last').textContent = `${ordinal(report.table.length)}`;

  drawShape(report, select.value);
}

function drawShape(report, teamId) {
  const history = report.history;
  const team = history.teams.find((t) => t.team_id === teamId);
  const chart = $('#shape-chart');
  if (!team) return;

  const count = report.table.length;
  const snapshots = history.dates.length;

  const width = 900;
  const height = 340;
  const pad = { top: 12, right: 16, bottom: 34, left: 44 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
  chart.replaceChildren();

  /* A real time axis. Rounds are not played in chronological order and the
     calendar has gaps (breaks, rescheduled rounds), so spacing snapshots
     evenly would distort how fast the picture actually changed. */
  const times = history.dates.map((iso) => Date.parse(`${iso}T12:00:00Z`));
  const firstTime = times[0];
  const lastTime = times[times.length - 1];
  const span = lastTime - firstTime || 1;
  const x = (index) => pad.left + ((times[index] - firstTime) / span) * plotWidth;
  const y = (cumulative) => pad.top + cumulative * plotHeight;

  // Cumulative sums per snapshot, so band p spans [cum(p-1), cum(p)].
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
    const label = svgEl('text', { class: 'tick', x: pad.left - 8, y: y(value) + 3.5, 'text-anchor': 'end' });
    label.textContent = `${100 - gridline * 100 / 4}%`;
    chart.appendChild(label);
  }

  // Position 1 sits at the top of the stack so the chart reads like a table.
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
          `now ${pct(latest, 1)}`
      );
    });
    band.addEventListener('pointermove', moveTooltip);
    band.addEventListener('pointerleave', hideTooltip);
    chart.appendChild(band);
  }

  chart.appendChild(
    svgEl('line', { class: 'axis-line', x1: pad.left, x2: width - pad.right, y1: y(1), y2: y(1) })
  );

  // Tick the first of each month, so the axis reads as a calendar rather than
  // as a list of snapshots.
  let lastMonth = null;
  history.dates.forEach((iso, index) => {
    const month = iso.slice(0, 7);
    if (month === lastMonth) return;
    lastMonth = month;
    const label = svgEl('text', { class: 'tick', x: x(index), y: height - pad.bottom + 15, 'text-anchor': 'middle' });
    label.textContent = new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short' });
    chart.appendChild(label);
    chart.appendChild(
      svgEl('line', { class: 'grid-line', x1: x(index), x2: x(index), y1: pad.top, y2: y(1) })
    );
  });

  const axisTitle = svgEl('text', { class: 'axis-title', x: pad.left, y: height - 6 });
  axisTitle.textContent = `${history.dates[0].slice(0, 4)} season`;
  chart.appendChild(axisTitle);

  const yTitle = svgEl('text', {
    class: 'axis-title',
    x: -(pad.top + plotHeight / 2),
    y: 12,
    transform: 'rotate(-90)',
    'text-anchor': 'middle',
  });
  yTitle.textContent = 'Share of simulated seasons';
  chart.appendChild(yTitle);

  attachShapeCrosshair(chart, report, team, { x, pad, plotWidth, plotHeight, width, height, snapshots, count });
  renderShapeSummary(report, team);

  chart.setAttribute(
    'aria-label',
    `Stacked area chart: ${team.team}'s probability of each finishing position, ` +
      `${snapshots} snapshots from ${history.dates[0]} to ${history.dates[snapshots - 1]}`
  );
  $('#shape-desc').textContent =
    `${team.team}: as of ${history.dates[snapshots - 1]}, most likely finish ` +
    `${ordinal(mostLikely(team.positions[snapshots - 1]) + 1)}.`;
}

function mostLikely(probabilities) {
  let best = 0;
  probabilities.forEach((value, index) => {
    if (value > probabilities[best]) best = index;
  });
  return best;
}

/* A crosshair reading out the round under the pointer. Sixteen bands is too
   many to list, so the tooltip reports the most likely place plus the blocks
   that actually matter. */
function attachShapeCrosshair(chart, report, team, geometry) {
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
    // Snapshots are unevenly spaced in time, so pick the nearest one by pixel
    // distance rather than by interpolating an index.
    let index = 0;
    for (let candidate = 1; candidate < snapshots; candidate += 1) {
      if (Math.abs(x(candidate) - localX) < Math.abs(x(index) - localX)) index = candidate;
    }

    line.setAttribute('x1', x(index));
    line.setAttribute('x2', x(index));
    line.style.opacity = '1';

    const probabilities = team.positions[index];
    const best = mostLikely(probabilities);
    const sum = (band) => (band ? probabilities.slice(band.first - 1, band.last).reduce((a, b) => a + b, 0) : 0);
    const when = new Date(`${history.dates[index]}T12:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
    const played = history.matches_played[index];

    showTooltip(
      event,
      `<b>${team.team}</b> · ${played === 0 ? 'pre-season' : when}<br>` +
        `${played} of ${totalMatches} matches played<br>` +
        `Rating ${team.ratings[index]}<br>` +
        `Most likely ${ordinal(best + 1)} (${pct(probabilities[best])})<br>` +
        `${top ? `Top ${top.last}: ${pct(sum(top))} · ` : ''}Bottom ${count - (relegation ? relegation.first - 1 : count)}: ${pct(sum(relegation))}`
    );
  });
  surface.addEventListener('pointerleave', () => {
    line.style.opacity = '0';
    hideTooltip();
  });
  chart.appendChild(surface);
}

function renderShapeSummary(report, team) {
  const summary = $('#shape-summary');
  summary.replaceChildren();

  const latest = team.positions[team.positions.length - 1];
  const first = team.positions[0];
  const best = mostLikely(latest);

  const parts = [
    ['Most likely finish', ordinal(best + 1)],
    ['Chance of that finish', pct(latest[best])],
    ['Rating now', String(team.ratings[team.ratings.length - 1])],
    ['Pre-season pick', ordinal(mostLikely(first) + 1)],
  ];
  for (const [name, value] of parts) {
    const item = el('div');
    item.appendChild(el('span', '', `${name} `));
    item.appendChild(el('b', '', value));
    summary.appendChild(item);
  }
}

/* ---------- rating ladder ----------------------------------------- */

/* Both divisions on one axis, which is the only place the model compares
   them directly. Domain is padded to the nearest 50 so ticks stay round. */
function renderLadder(reports) {
  const teams = [];
  for (const [slug, report] of Object.entries(reports)) {
    for (const row of report.table) {
      teams.push({
        team: row.team,
        teamId: row.team_id,
        rating: row.rating,
        tier: slug === 'eliteserien' ? 1 : 2,
      });
    }
  }

  const ratings = teams.map((t) => t.rating);
  const low = Math.min(...ratings);
  const high = Math.max(...ratings);

  function xPos(rating) {
    if (high === low) return 50;
    return 2 + ((rating - low) / (high - low)) * 96; // 2%–98% keeps logos inside clip
  }

  // Stack overlapping teams into rows (top-down)
  const OVERLAP_PCT = 3; // % of track width that counts as overlapping
  teams.sort((a, b) => a.rating - b.rating || a.team.localeCompare(b.team));

  // Rank: highest rating = 1
  teams.forEach((t, i) => { t._rank = teams.length - i; });

  const rows = [];
  for (const team of teams) {
    let placed = false;
    for (let r = 0; r < rows.length; r++) {
      const last = rows[r][rows[r].length - 1];
      if (Math.abs(xPos(last.rating) - xPos(team.rating)) > OVERLAP_PCT) {
        rows[r].push(team);
        team._row = r;
        placed = true;
        break;
      }
    }
    if (!placed) {
      team._row = rows.length;
      rows.push([team]);
    }
  }

  const track = $('#ladder-lanes');
  track.replaceChildren();

  // Axis
  const axis = el('div', 'ladder__axis');
  const tickStep = 50;
  const firstTick = Math.ceil(low / tickStep) * tickStep;
  for (let r = firstTick; r <= high; r += tickStep) {
    const tick = el('div', 'ladder__tick');
    tick.style.left = `${xPos(r)}%`;
    tick.appendChild(el('span', '', String(Math.round(r))));
    axis.appendChild(tick);
  }
  track.appendChild(axis);

  // Teams
  const rowHeight = rows.length === 1 ? 0 : 2.2; // rem spacing between rows
  for (const team of teams) {
    const wrap = el('div', 'ladder__team');
    wrap.dataset.tier = String(team.tier);
    wrap.dataset.tip = `#${team._rank}  ${team.team}  ${Math.round(team.rating)}`;
    wrap.style.left = `${xPos(team.rating)}%`;
    wrap.style.top = `${0.5 + team._row * rowHeight}rem`;

    const img = el('img');
    img.src = `logos/${team.teamId}.png`;
    img.alt = team.team;
    wrap.appendChild(img);

    track.appendChild(wrap);
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
  legend.appendChild(el('span', '', 'Every club in the top two divisions on one scale. Where the two overlap, a second-tier club is rated above a top-flight one.'));
}

/* ---------- fixtures ---------------------------------------------- */

function renderFixtures(report) {
  const holder = $('#fixtures');
  holder.replaceChildren();

  const next = report.fixtures.slice(0, 12);
  $('#fixture-count').textContent = `next ${next.length} of ${report.fixtures.length}`;

  for (const fixture of next) {
    const row = el('div', 'fixture');

    const when = el('div', 'fixture__when');
    when.textContent = formatDate(fixture.date) + (fixture.time ? ` · ${fixture.time}` : '');
    row.appendChild(when);

    // The rating is what drives the odds beside it, so show the working.
    const teams = el('div', 'fixture__teams');
    const side = (name, teamId, rating) => {
      const holder = el('span', 'fixture__side');
      const crest = teamLogo(teamId, name);
      if (crest) holder.appendChild(crest);
      holder.appendChild(el('span', '', name));
      holder.appendChild(el('span', 'fixture__rating', rating.toFixed(0)));
      return holder;
    };
    teams.appendChild(side(fixture.home, fixture.home_id, fixture.home_rating));
    teams.appendChild(el('em', '', 'v'));
    teams.appendChild(side(fixture.away, fixture.away_id, fixture.away_rating));
    row.appendChild(teams);

    const oddsCol = el('div', 'fixture__odds-col');
    const odds = el('div', 'odds');
    odds.setAttribute('role', 'img');
    odds.setAttribute(
      'aria-label',
      `${fixture.home} win ${pct(fixture.home_win)}, draw ${pct(fixture.draw)}, ${fixture.away} win ${pct(fixture.away_win)}`
    );
    for (const [outcome, value, who] of [
      ['home', fixture.home_win, fixture.home],
      ['draw', fixture.draw, 'Draw'],
      ['away', fixture.away_win, fixture.away],
    ]) {
      const segment = el('div', 'odds__seg');
      segment.dataset.outcome = outcome;
      segment.style.flex = `${Math.max(value, 0.001)}`;
      segment.textContent = value >= 0.12 ? `${Math.round(value * 100)}%` : '';
      segment.addEventListener('pointerenter', (event) =>
        showTooltip(event, `<b>${who}</b><br>${pct(value, 1)}`)
      );
      segment.addEventListener('pointermove', moveTooltip);
      segment.addEventListener('pointerleave', hideTooltip);
      odds.appendChild(segment);
    }
    oddsCol.appendChild(odds);

    // The most likely scorelines read straight off the three-way odds above.
    if (fixture.scorelines && fixture.scorelines.length) {
      const lines = el('div', 'fixture__lines');
      for (const line of fixture.scorelines.slice(0, 4)) {
        const chip = el('span', 'fixture__line');
        chip.textContent = `${line.home_goals}-${line.away_goals} ${pct(line.probability, 0)}`;
        chip.setAttribute(
          'aria-label',
          `${line.home_goals}-${line.away_goals} about ${pct(line.probability, 1)}`
        );
        lines.appendChild(chip);
      }
      oddsCol.appendChild(lines);
    }
    row.appendChild(oddsCol);
    holder.appendChild(row);
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
    holder.appendChild(el('p', 'muted', 'No played matches yet.'));
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
  const prev = el('button', 'played-nav__btn', '\u2190 Prev');
  prev.disabled = state.playedWeek >= weeks.length - 1;
  prev.addEventListener('click', () => { state.playedWeek++; renderPlayedResults(report); });

  const label = el('span', 'played-nav__label', `Week ${currentWeek}`);

  const next = el('button', 'played-nav__btn', 'Next \u2192');
  next.disabled = state.playedWeek === 0;
  next.addEventListener('click', () => { state.playedWeek--; renderPlayedResults(report); });

  nav.appendChild(prev);
  nav.appendChild(label);
  nav.appendChild(next);
  holder.appendChild(nav);

  // Cards
  for (const match of weekMatches) {
    const card = el('div', 'played-card');

    const homeWin = match.home_goals > match.away_goals;
    const awayWin = match.away_goals > match.home_goals;

    if (homeWin) card.classList.add('played-card--home-win');
    else if (awayWin) card.classList.add('played-card--away-win');

    const homeInfo = ratingChanges.get(`${match.home_id}|${match.date}`) ?? { change: 0, rating: 0 };
    const awayInfo = ratingChanges.get(`${match.away_id}|${match.date}`) ?? { change: 0, rating: 0 };

    // Rating block: large rating + delta + arrow
    const ratingBlock = (info) => {
      const node = el('div', 'played-card__rating');
      const rating = el('span', 'played-card__rating-value', String(info.rating));
      node.appendChild(rating);
      if (info.change !== 0) {
        const arrow = info.change > 0 ? '\u25B2' : '\u25BC';
        const delta = el('span', `played-card__delta played-card__delta--${info.change > 0 ? 'up' : 'down'}`);
        delta.textContent = `${info.change > 0 ? '+' : ''}${info.change} ${arrow}`;
        node.appendChild(delta);
      }
      return node;
    };

    // Matchup row: [rating] [crest] Name   Score   Name [crest] [rating]
    const matchup = el('div', 'played-card__matchup');

    // Home: rating on outside (left), then name + crest toward center
    const homeSide = el('div', 'played-card__side played-card__side--home');
    homeSide.appendChild(ratingBlock(homeInfo));
    const homeTeam = el('span', 'played-card__team');
    homeTeam.appendChild(el('span', '', match.home));
    const homeCrest = teamLogo(match.home_id, match.home);
    if (homeCrest) homeTeam.appendChild(homeCrest);
    homeSide.appendChild(homeTeam);

    const score = el('div', 'played-card__score');
    score.textContent = `${match.home_goals}\u2013${match.away_goals}`;

    // Away: crest + name toward center, then rating on outside (right)
    const awaySide = el('div', 'played-card__side played-card__side--away');
    const awayTeam = el('span', 'played-card__team');
    const awayCrest = teamLogo(match.away_id, match.away);
    if (awayCrest) awayTeam.appendChild(awayCrest);
    awayTeam.appendChild(el('span', '', match.away));
    awaySide.appendChild(awayTeam);
    awaySide.appendChild(ratingBlock(awayInfo));

    matchup.appendChild(homeSide);
    matchup.appendChild(score);
    matchup.appendChild(awaySide);
    card.appendChild(matchup);

    // Date centered below
    const date = el('div', 'played-card__date');
    date.textContent = formatDate(match.date) + (match.round ? ` \u00b7 R${match.round}` : '');
    card.appendChild(date);

    holder.appendChild(card);
  }
}

function formatDate(iso) {
  const date = new Date(`${iso}T12:00:00Z`);
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
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
  for (const name in map) map[name] = map[name].slice(-15);
  return map;
}

function formBlocks(form) {
  const blocks = [];
  for (let i = (form || []).length; i > 0; i -= 3) {
    blocks.unshift(formPoints(form.slice(Math.max(0, i - 3), i)));
  }
  return blocks;
}

function formPoints(form) {
  if (!form || !form.length) return 0;
  return form.reduce((total, letter) => total + (letter === 'W' ? 3 : letter === 'D' ? 1 : 0), 0);
}

function formChipsEl(form) {
  const holder = el('span', 'form__chips');
  const blocks = formBlocks(form);
  if (!blocks.length) return holder;
  for (const pts of blocks) {
    const chip = el('span', 'form__chip', String(pts));
    const t = pts / 9;
    chip.style.background = `color-mix(in oklch, var(--outcome-good) ${Math.round(t * 100)}%, var(--outcome-bad))`;
    chip.title = `${pts} pts`;
    holder.appendChild(chip);
  }
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
      `${leader.team} finished top on ${leader.points} points. ` +
      `All ${model.matches_played} matches played; ratings shown are where each club ended the season.`;
  } else {
    const lede =
      favourite.team === leader.team
        ? `${leader.team} lead on ${leader.points} points and the model agrees: ` +
          `${pct(favourite.position_probabilities[0])} to finish top.`
        : `${leader.team} lead on ${leader.points} points, but the model makes ${favourite.team} ` +
          `favourite at ${pct(favourite.position_probabilities[0])}.`;
    $('#hero-lede').textContent =
      `${lede} ${model.matches_remaining} matches left, each one played ${model.simulations.toLocaleString()} times over.`;
  }

  const meta = $('#hero-meta');
  meta.replaceChildren();
  for (const [name, value] of [
    ['Played', `${model.matches_played}`],
    ['Remaining', `${model.matches_remaining}`],
    ['Seasons simulated', model.simulations.toLocaleString()],
    ['Model', model.version],
    ['Ratings from', `${model.seed_season} onward`],
  ]) {
    const cell = el('div');
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
    ['Version', model.version],
    ['K-factor', model.k_factor],
    ['Home advantage', `${model.home_advantage} pts`],
    ['Cross-season regression', `${Math.round((1 - model.season_regression) * 100)}% toward mean`],
    ['Peak draw rate', pct(model.draw_base, 0)],
    ['Simulations', model.simulations.toLocaleString()],
    ['Random seed', model.seed],
  ]) {
    const cell = el('div');
    cell.appendChild(el('dt', '', name));
    cell.appendChild(el('dd', '', String(value)));
    grid.appendChild(cell);
  }
}


/* ---------- career: one club's rating across every season ---------- */

function openCareer(teamId, fallbackName) {
  const modal = $('#career-modal');
  const career = (state.careers?.teams || []).find((team) => team.team_id === teamId);

  $('#career-title').textContent = career ? career.team : fallbackName;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  $('.modal__close').focus();

  if (!career || career.points.length < 2) {
    $('#career-sub').textContent = 'No rating history for this club yet.';
    $('#career-chart').replaceChildren();
    $('#career-stats').replaceChildren();
    $('#career-seasons tbody').replaceChildren();
    return;
  }

  const first = career.seasons[0];
  const last = career.seasons[career.seasons.length - 1];
  $('#career-sub').textContent =
    `${career.seasons.length} seasons tracked, ${first.season} to ${last.season}. ` +
    `Rating ${career.points[0][1]} then, ${career.current_rating} now.`;

  drawCareer(career);
  renderCareerStats(career);
  renderCareerSeasons(career);
}

function closeCareer() {
  $('#career-modal').hidden = true;
  document.body.style.overflow = '';
  hideTooltip();
}

function drawCareer(career) {
  const chart = $('#career-chart');
  const points = career.points;

  const width = 940;
  const height = 300;
  const pad = { top: 14, right: 16, bottom: 30, left: 46 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;

  chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
  chart.replaceChildren();

  const times = points.map(pointTime);
  const first = times[0];
  const span = (times[times.length - 1] - first) || 1;
  const ratings = points.map(([, rating]) => rating);

  // Round the domain outward so the axis lands on tidy rating numbers.
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

  // A tick where each season starts, so the line can be read against seasons.
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
  axis.textContent = 'Rating after every match played';
  chart.appendChild(axis);

  // Nearest-point readout.
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
    const when = new Date(times[index]).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
    showTooltip(event, `<b>${career.team}</b><br>${when}<br>Rating ${points[index][1]}`);
  });
  surface.addEventListener('pointerleave', () => {
    crosshair.style.opacity = '0';
    hideTooltip();
  });
  chart.appendChild(surface);

  chart.setAttribute('aria-label', `${career.team} rating from ${points[0][0]} to ${points[points.length - 1][0]}`);
  $('#career-desc').textContent =
    `${career.team}: rating moved from ${points[0][1]} to ${career.current_rating} across ${career.seasons.length} seasons.`;
}

function renderCareerStats(career) {
  const stats = $('#career-stats');
  stats.replaceChildren();
  const promotions = career.seasons.filter(
    (record, index) => index > 0 && record.league !== career.seasons[index - 1].league
  ).length;

  const entries = [
    ['Now', String(career.current_rating)],
    ['Peak', career.peak ? `${career.peak[1]} (${career.peak[0].slice(0, 4)})` : '—'],
    ['Low', career.trough ? `${career.trough[1]} (${career.trough[0].slice(0, 4)})` : '—'],
    ['Matches', String(career.points.length)],
    ['Division changes', String(promotions)],
  ];
  for (const [name, value] of entries) {
    const key = el('span', 'legend__key');
    key.appendChild(el('span', 'label', name));
    key.appendChild(el('span', '', value));
    stats.appendChild(key);
  }
}

function renderCareerSeasons(career) {
  const body = $('#career-seasons tbody');
  body.replaceChildren();
  for (const record of [...career.seasons].reverse()) {
    const tr = el('tr');
    tr.appendChild(el('td', 'pos', String(record.season)));
    tr.appendChild(el('td', 'club', record.league_name));
    tr.appendChild(el('td', 'num', String(record.position)));
    tr.appendChild(el('td', 'num muted', String(record.played)));
    tr.appendChild(el('td', 'num', String(record.points)));
    tr.appendChild(
      el('td', 'num muted', record.goal_difference > 0 ? `+${record.goal_difference}` : String(record.goal_difference))
    );
    tr.appendChild(el('td', 'num sep muted', String(record.rating_start)));
    tr.appendChild(el('td', 'num', String(record.rating_end)));
    const change = el('td', `num ${record.rating_change >= 0 ? 'up' : 'down'}`);
    change.textContent = record.rating_change >= 0 ? `+${record.rating_change}` : String(record.rating_change);
    tr.appendChild(change);
    body.appendChild(tr);
  }
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

  const when = new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
  });
  $('#timeline-when').textContent = live
    ? `Live — ${day.matches_played} matches played`
    : `As of ${when} — ${day.matches_played} of ${report.model.matches_played + report.model.matches_remaining} played`;

  const scale = $('#timeline-scale');
  scale.replaceChildren();
  const first = new Date(`${days[0].date}T12:00:00Z`);
  const last = new Date(`${days[days.length - 1].date}T12:00:00Z`);
  const month = (d) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  scale.appendChild(el('span', '', month(first)));
  scale.appendChild(el('span', '', `${days.length} matchdays`));
  scale.appendChild(el('span', '', month(last)));
}

/* Dragging fires continuously; only the value you settle on is worth a fetch. */
function onTimelineInput(event) {
  const report = state.reports[state.league];
  const days = matchdays(report);
  const index = Number(event.target.value);
  const day = days[index];
  if (!day) return;

  const live = index === days.length - 1;
  const when = new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
  });
  $('#timeline-when').textContent = live ? 'Live — latest results' : `As of ${when}`;
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
    state.reports = await response.json();
    state.asof = asof;
    render();
  } catch (error) {
    $('#timeline-when').textContent = `Could not rewind: ${error.message}`;
  } finally {
    content.classList.remove('is-rewinding');
  }
}

/* ---------- theme -------------------------------------------------- */

function resolveTheme() {
  const chosen = localStorage.getItem('elitetracker-theme');
  const root = document.documentElement;
  if (chosen === 'light' || chosen === 'dark') {
    root.dataset.theme = chosen;
    root.dataset.resolvedTheme = chosen;
  } else {
    root.dataset.theme = '';
    root.dataset.resolvedTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
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
  const noRewind = new Set(['shape', 'next-up', 'compare', 'played', 'model']);
  const timelineSection = document.querySelector('.timeline-section');
  if (timelineSection) timelineSection.hidden = noRewind.has(state.activeView);

  // View-specific renders
  switch (state.activeView) {
    case 'table':
      renderStandings(report);
      renderBandLegend(report);
      break;
    case 'grid':
      renderGrid(report);
      renderGridLegend();
      break;
    case 'shape':
      renderShape(report);
      break;
    case 'ladder':
      renderLadder(state.reports);
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
      state.playedWeek = 0;
      renderPlayedResults(report);
      break;
    case 'model':
      renderModelCard(report);
      break;
  }

  // Persist active view to URL for linkability
  const params = new URLSearchParams(window.location.search);
  params.set('view', state.activeView);
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}${window.location.hash}`);

  document.title = `${report.league.name} ${report.league.season} — EliteTracker`;
}

function wire() {
  for (const button of document.querySelectorAll('[data-league]')) {
    button.addEventListener('click', () => {
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

  for (const button of document.querySelectorAll('[data-view]')) {
    button.addEventListener('click', () => {
      state.activeView = button.dataset.view;
      markActiveView();
      render();
      hideTooltip();
    });
  }

  $('#shape-team').addEventListener('change', (event) => {
    drawShape(state.reports[state.league], event.target.value);
  });

  for (const button of document.querySelectorAll('#standings .sort-btn')) {
    button.addEventListener('click', () => toggleSort(button.dataset.sortKey));
  }

  $('#season-select').addEventListener('change', async (event) => {
    state.asof = null; // a different season has a different timeline
    await loadSeason(Number(event.target.value));
  });

  $('#timeline-range').addEventListener('input', onTimelineInput);
  $('#timeline-now').addEventListener('click', () => rewindTo(null));

  $('#compare-a').addEventListener('change', () => renderCompare(state.reports[state.league]));
  $('#compare-b').addEventListener('change', () => renderCompare(state.reports[state.league]));

  for (const closer of document.querySelectorAll('[data-close-modal]')) {
    closer.addEventListener('click', closeCareer);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#career-modal').hidden) closeCareer();
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    resolveTheme();
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
  const params = new URLSearchParams(window.location.search);

  const career = params.get('career');
  if (career) {
    const club = (state.careers?.teams || []).find(
      (team) => team.team.toLowerCase() === career.toLowerCase()
    );
    if (club) openCareer(club.team_id, club.team);
  }

  const wanted = params.get('team');
  if (!wanted) return;
  const match = state.reports[state.league].history.teams.find(
    (team) => team.team.toLowerCase() === wanted.toLowerCase()
  );
  if (match) {
    $('#shape-team').value = match.team_id;
    drawShape(state.reports[state.league], match.team_id);
  }
}

/* The view strip scrolls sideways once it outgrows the screen, so the active
   tab is pulled back into sight rather than left off the edge. */
function markActiveView() {
  for (const button of document.querySelectorAll('[data-view]')) {
    const active = button.dataset.view === state.activeView;
    button.setAttribute('aria-pressed', String(active));
    if (active) button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

/* ?view=grid makes any view linkable. Applied early so the first render
   shows the requested view instead of the default table. */
function applyViewParameter() {
  const view = new URLSearchParams(window.location.search).get('view');
  const validViews = new Set(['table', 'grid', 'shape', 'ladder', 'next-up', 'compare', 'played', 'model']);
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
    state.reports = await response.json();
    state.season = season;
    render();
  } catch (error) {
    select.value = String(previous);
    $('#status').hidden = false;
    $('#status').textContent = `Could not load ${season}: ${error.message}`;
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
      const option = el('option', '', season === report.league.current_season ? `${season} (live)` : String(season));
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

function teamNameById(report, id) {
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
  if (model.probability_model === 'ordered_logit') {
    const logistic = (z) => 1 / (1 + Math.exp(-z));
    const upper = logistic(model.logit_cutpoint - model.logit_slope * gap);
    const lower = logistic(-model.logit_cutpoint - model.logit_slope * gap);
    return { gap, home_win: 1 - upper, draw: upper - lower, away_win: lower };
  }
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
function topScorelines(model, odds, n = 5) {
  const table = model.scorelines;
  let bin = 0;
  for (const edge of table.bin_edges) {
    if (odds.gap > edge) bin += 1;
    else break;
  }
  bin = Math.min(bin, table.bins - 1);

  const combined = new Map();
  for (const outcome of ['home_win', 'draw', 'away_win']) {
    const probability = odds[outcome];
    if (probability <= 0) continue;
    // An empty bin cell falls back to the outcome's global distribution.
    const cell = table.bins_data[outcome][bin]?.length ? table.bins_data[outcome][bin] : table.global[outcome];
    const total = cell.reduce((sum, entry) => sum + entry[2], 0);
    for (const [homeGoals, awayGoals, weight] of cell) {
      const key = `${homeGoals}-${awayGoals}`;
      combined.set(key, (combined.get(key) || 0) + probability * (weight / total));
    }
  }
  return [...combined]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, probability]) => {
      const [homeGoals, awayGoals] = key.split('-').map(Number);
      return { home_goals: homeGoals, away_goals: awayGoals, probability };
    });
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
  block.appendChild(el('div', 'compare__pick-hint', 'Click to change'));
  return block;
}

function oddsBar(homeName, awayName, entry) {
  const odds = el('div', 'odds');
  odds.setAttribute('role', 'img');
  odds.setAttribute(
    'aria-label',
    `${homeName} win ${pct(entry.home_win)}, draw ${pct(entry.draw)}, ${awayName} win ${pct(entry.away_win)}`
  );
  for (const [outcome, value, who] of [
    ['home', entry.home_win, homeName],
    ['draw', entry.draw, 'Draw'],
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
let compareMenuEl = null;

function closeCompareMenu() {
  if (compareMenuEl) {
    compareMenuEl.remove();
    compareMenuEl = null;
  }
  document.removeEventListener('pointerdown', compareMenuOutside, true);
  document.removeEventListener('keydown', compareMenuKey);
  window.removeEventListener('scroll', compareMenuScroll, true);
}

function compareMenuOutside(event) {
  if (compareMenuEl && !compareMenuEl.contains(event.target)) closeCompareMenu();
}

function compareMenuKey(event) {
  if (event.key === 'Escape') closeCompareMenu();
}

function compareMenuScroll(event) {
  // Scrolling inside the menu (its own scrollbar) must not dismiss it.
  if (compareMenuEl && compareMenuEl.contains(event.target)) return;
  closeCompareMenu();
}

/* A custom picker: the native <select> can't show crests or be positioned, so
   the cards open this popover under themselves, listing every club with its
   logo. Selecting one sets the hidden select's value and fires its change. */
function openCompareMenu(box, side, report) {
  closeCompareMenu();
  const menu = el('div', 'compare__menu');
  menu.setAttribute('role', 'listbox');
  menu.dataset.side = side;
  const select = side === 'home' ? $('#compare-a') : $('#compare-b');
  const otherId = side === 'home' ? $('#compare-b').value : $('#compare-a').value;
  for (const team of allTeams()) {
    const option = el('button', 'compare__option');
    option.type = 'button';
    option.setAttribute('role', 'option');
    if (team.team_id === otherId) option.disabled = true;
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
  document.body.appendChild(menu);
  compareMenuEl = menu;
  // Defer so the click that opened the menu doesn't immediately close it.
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
  const homeId = aId;
  const awayId = bId;
  const homeName = teamNameById(report, homeId);
  const awayName = teamNameById(report, awayId);

  const homeRating = ratingById(homeId);
  const awayRating = ratingById(awayId);
  const odds = matchOdds(report.model, homeRating, awayRating);
  const entry = { ...odds, scorelines: topScorelines(report.model, odds) };

  // Fictional match: the two clubs, who hosts, and the model's odds + scorelines.
  const matchBlock = el('div', 'compare__block');
  matchBlock.appendChild(el('h3', 'compare__subhead', 'Fictional match'));

  const teamsRow = el('div', 'compare__teams');
  const homeBlock = compareTeamBlock(homeId, homeName, homeRating, teamLogo(homeId, homeName), 'Home');
  const awayBlock = compareTeamBlock(awayId, awayName, awayRating, teamLogo(awayId, awayName), 'Away');
  const swapBtn = el('button', 'compare__swap-center', '⇄');
  swapBtn.type = 'button';
  swapBtn.setAttribute('aria-label', 'Swap the two clubs');
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

  // Clicking a card opens the custom team picker for that side.
  const makePicker = (box, side) => {
    box.setAttribute('role', 'button');
    box.setAttribute('tabindex', '0');
    box.setAttribute('aria-label', 'Choose a club');
    box.setAttribute('aria-haspopup', 'listbox');
    box.title = 'Choose a club';
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
  matchBlock.appendChild(el('p', 'compare__note', `${homeName} host this fixture · home advantage is included.`));

  matchBlock.appendChild(oddsBar(homeName, awayName, entry));
  const linesWrap = el('div', 'compare__scorelines');
  linesWrap.appendChild(el('div', 'compare__scorelines-label', 'Most likely scorelines'));
  const lines = el('div', 'compare__scorelines-chips');
  for (const line of entry.scorelines.slice(0, 4)) {
    const chip = el('span', 'compare__scoreline');
    chip.textContent = `${line.home_goals}–${line.away_goals}`;
    chip.appendChild(el('span', 'compare__scoreline-prob', pct(line.probability, 0)));
    chip.setAttribute('aria-label', `${line.home_goals}-${line.away_goals} about ${pct(line.probability, 1)}`);
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
    histBlock.appendChild(el('h3', 'compare__subhead', 'Rating history'));
    const svg = svgEl('svg', { class: 'chart', role: 'img' });
    svg.setAttribute('aria-label', `Rating history for ${homeName} and ${awayName}`);
    drawCompareHistory(svg, careerA, careerB, teamNameById(report, aId), teamNameById(report, bId));
    histBlock.appendChild(svg);
    const legend = el('div', 'legend');
    legend.appendChild(el('span', 'compare-legend__a', teamNameById(report, aId)));
    legend.appendChild(el('span', 'compare-legend__b', teamNameById(report, bId)));
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
  xTitle.textContent = 'Season';
  svg.appendChild(xTitle);
  const yTitle = svgEl('text', { class: 'axis-title', x: -(pad.top + plotH / 2), y: 12, transform: 'rotate(-90)', 'text-anchor': 'middle' });
  yTitle.textContent = 'ELO rating';
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
    const when = new Date(pointTime(pa)).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
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
  wire();
  try {
    const [reports, careers] = await Promise.all([
      fetch(reportUrl(null)).then((r) => {
        if (!r.ok) throw new Error(`server returned ${r.status}`);
        return r.json();
      }),
      fetch('/data/careers.json').then((r) => (r.ok ? r.json() : null)),
    ]);
    state.reports = reports;
    state.careers = careers;
    state.season = reports[state.league].league.season;
    $('#status').hidden = true;
    $('#content').hidden = false;
    applyLeagueParameter();
    applySortParameter();
    applyViewParameter();
    render();

    const params = new URLSearchParams(window.location.search);
    const wantedSeason = Number(params.get('season'));
    if (wantedSeason && wantedSeason !== state.season) await loadSeason(wantedSeason);

    const wantedAsof = params.get('asof');
    if (wantedAsof) await rewindTo(wantedAsof);

    applyTeamParameter();
    // The browser resolved any #fragment while the content was still hidden,
    // so re-run it now that the sections exist.
    if (window.location.hash) {
      document.querySelector(window.location.hash)?.scrollIntoView();
    }
  } catch (error) {
    $('#status').textContent =
      `Could not load the season: ${error.message}. Are the data files deployed?`;
  }
}

boot();
