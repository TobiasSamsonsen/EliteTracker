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
};

const $ = (selector) => document.querySelector(selector);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const pct = (value, digits = 1) =>
  value >= 0.9995 ? '100%' : value < 0.0005 ? '—' : `${(value * 100).toFixed(digits)}%`;

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
    const label = el('th');
    label.scope = 'row';
    label.appendChild(el('span', 'pos', String(row.position)));
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
  $('#head-first').textContent = promotion ? 'Go up' : 'Win it';
  $('#head-first-desc').textContent = promotion
    ? ', chance of promotion'
    : ', chance of finishing top';
  $('#head-last').textContent = 'Go down';
  renderSortHeaders();

  for (const row of sortedStandings(standingsRows(report))) {
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
    const clubButton = el('button', 'club-btn', row.team);
    clubButton.type = 'button';
    clubButton.addEventListener('click', (event) => {
      event.stopPropagation();
      openCareer(row.team_id, row.team);
    });
    club.appendChild(clubButton);
    tr.appendChild(club);
    for (const key of ['played', 'wins', 'draws', 'losses', 'goals_for', 'goals_against']) {
      tr.appendChild(el('td', 'num muted', String(row[key])));
    }
    tr.appendChild(el('td', 'num', row.goal_difference > 0 ? `+${row.goal_difference}` : String(row.goal_difference)));
    const points = el('td', 'num', String(row.points));
    points.style.fontWeight = '700';
    tr.appendChild(points);

    tr.appendChild(el('td', 'num sep', row.rating.toFixed(0)));
    tr.appendChild(el('td', 'num muted', row.expected_points.toFixed(1)));

    tr.appendChild(meterCell(row.up, 'up'));
    tr.appendChild(meterCell(row.down, 'down'));

    // Clicking anywhere on the row is a mouse convenience on top of that
    // button; it adds no keyboard or ARIA semantics of its own.
    tr.addEventListener('click', () => openCareer(row.team_id, row.team));
    body.appendChild(tr);
  }
}

/* `kind` is 'up' or 'down' -- the good column and the bad one. Colour is a
   second channel here, not the only one: the columns are labelled, fixed in
   place, and the percentage is printed beside the bar. */
function meterCell(value, kind) {
  const clamped = Math.max(0, Math.min(1, value));
  const cell = el('td', 'num');
  const meter = el('span', `meter meter--${kind}${clamped < 0.0005 ? ' meter--empty' : ''}`);

  const track = el('span', 'meter__track');
  const fill = el('span', 'meter__fill');
  fill.style.width = `${clamped * 100}%`;
  track.appendChild(fill);

  meter.appendChild(track);
  meter.appendChild(el('span', 'meter__value', pct(value)));
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
    ['Chance of that', pct(latest[best])],
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
      teams.push({ team: row.team, rating: row.rating, tier: slug === 'eliteserien' ? 1 : 2, league: report.league.name });
    }
  }

  const ratings = teams.map((t) => t.rating);
  const low = Math.floor(Math.min(...ratings) / 50) * 50;
  const high = Math.ceil(Math.max(...ratings) / 50) * 50;
  const position = (rating) => ((rating - low) / (high - low)) * 100;

  const axis = $('#ladder-axis');
  axis.replaceChildren();
  for (let value = low; value <= high; value += 50) {
    const tick = el('span', 'ladder__tick');
    tick.style.left = `${position(value)}%`;
    tick.appendChild(el('span', '', String(value)));
    axis.appendChild(tick);
  }

  const holder = $('#ladder-lanes');
  holder.replaceChildren();

  // One shared line: the whole point is that the two divisions overlap, and
  // splitting them into rows hid exactly that. Division stays legible through
  // colour and marker shape rather than through position.
  const track = el('div', 'ladder__track');
  // One entry per stacked row, holding the right-most x placed on it.
  const rows = [];
  for (const team of [...teams].sort((a, b) => a.rating - b.rating)) {
    const x = position(team.rating);
    // Stack only where clubs would otherwise sit on top of each other.
    let row = rows.findIndex((lastX) => x - lastX > 2.4);
    if (row === -1) { rows.push(x); row = rows.length - 1; } else { rows[row] = x; }

    const dot = el('span', 'ladder__team');
    dot.dataset.tier = String(team.tier);
    dot.style.left = `${x}%`;
    // The row offset and the track height are both derived from --ladder-*
    // in the stylesheet, so a dot cannot be placed outside its box.
    dot.style.setProperty('--ladder-row', String(row));
    dot.addEventListener('pointerenter', (event) =>
      showTooltip(event, `<b>${team.team}</b><br>Rating ${team.rating.toFixed(0)} · ${team.league}`)
    );
    dot.addEventListener('pointermove', moveTooltip);
    dot.addEventListener('pointerleave', hideTooltip);
    track.appendChild(dot);
  }
  // Tell the stylesheet how tall the track has to be. Wrapping the row index
  // instead would silently stack two clubs on top of each other the first time
  // a season needs a fourth row.
  $('.ladder').style.setProperty('--ladder-rows', String(Math.max(1, rows.length)));
  holder.appendChild(track);

  const legend = $('#ladder-legend');
  legend.replaceChildren();
  for (const [tier, name] of [[1, 'Eliteserien'], [2, 'OBOS-ligaen']]) {
    const key = el('span', 'legend__key');
    const swatch = el('span', 'legend__swatch');
    swatch.style.borderRadius = '50%';
    if (tier === 1) {
      swatch.style.background = 'var(--tier-1)';
    } else {
      swatch.style.background = 'var(--panel)';
      swatch.style.border = '2.5px solid var(--tier-2)';
    }
    key.appendChild(swatch);
    key.appendChild(el('span', '', name));
    legend.appendChild(key);
  }
  legend.appendChild(el('span', '', 'Every club in the top two divisions on one scale. Where the two overlap, a second-tier side is rated above a top-flight one.'));
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
    const side = (name, rating) => {
      const holder = el('span', 'fixture__side');
      holder.appendChild(el('span', '', name));
      holder.appendChild(el('span', 'fixture__rating', rating.toFixed(0)));
      return holder;
    };
    teams.appendChild(side(fixture.home, fixture.home_rating));
    teams.appendChild(el('em', '', 'v'));
    teams.appendChild(side(fixture.away, fixture.away_rating));
    row.appendChild(teams);

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
    row.appendChild(odds);
    holder.appendChild(row);
  }
}

function formatDate(iso) {
  const date = new Date(`${iso}T12:00:00Z`);
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
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

  const times = points.map(([date]) => Date.parse(`${date}T12:00:00Z`));
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
    const query = new URLSearchParams({ season: String(state.season) });
    if (asof) query.set('asof', asof);
    const response = await fetch(`/api/report?${query}`);
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
  renderSeasonOptions(report);
  renderTimeline(report);
  renderHero(report);
  renderGrid(report);
  renderGridLegend();
  renderStandings(report);
  renderBandLegend(report);
  renderShape(report);
  renderLadder(state.reports);
  renderFixtures(report);
  renderOddsLegend();
  renderModelCard(report);
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

/* Older seasons are built on the server the first time they are asked for,
   so this can take a moment. Say so rather than appearing to hang. */
async function loadSeason(season) {
  const select = $('#season-select');
  select.disabled = true;
  const previous = state.season;
  try {
    const response = await fetch(`/api/report?season=${season}`);
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

async function boot() {
  resolveTheme();
  wire();
  try {
    const [reports, careers] = await Promise.all([
      fetch('/api/report').then((r) => {
        if (!r.ok) throw new Error(`server returned ${r.status}`);
        return r.json();
      }),
      fetch('/api/careers').then((r) => (r.ok ? r.json() : null)),
    ]);
    state.reports = reports;
    state.careers = careers;
    state.season = reports[state.league].league.season;
    $('#status').hidden = true;
    $('#content').hidden = false;
    applyLeagueParameter();
    applySortParameter();
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
    $('#status').textContent = `Could not load the season: ${error.message}. Is the server running?`;
  }
}

boot();
