/* ---------- explore: race lines (viz=races) ---------------------------- */

const RACE_MAX_FEATURED = 6;

/* Labels at the right end of a chart's lines, nudged apart so none overlap:
   `items` are {y, ...}; returns them sorted with `y` spread by `gap` and kept
   between `top` and `bottom`. */
function spreadLabels(items, gap, top, bottom) {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  if (!sorted.length) return sorted;
  sorted[0].y = Math.max(sorted[0].y, top);
  for (let i = 1; i < sorted.length; i += 1) sorted[i].y = Math.max(sorted[i].y, sorted[i - 1].y + gap);
  const overflow = sorted[sorted.length - 1].y - bottom;
  if (overflow > 0) for (const item of sorted) item.y -= overflow;
  for (let i = sorted.length - 2; i >= 0; i -= 1) sorted[i].y = Math.min(sorted[i].y, sorted[i + 1].y - gap);
  sorted[0].y = Math.max(sorted[0].y, top);
  for (let i = 1; i < sorted.length; i += 1) sorted[i].y = Math.max(sorted[i].y, sorted[i - 1].y + gap);
  return sorted;
}

/* Each club's chance of one race at every layer of the season mountain
   (`mountainLayers`: the pre-season, one layer a round, now): the band's
   places summed. The last layer is the report itself, so each line ends on
   the figure the table and hero print. Places only: promotion and relegation
   here leave out the play-offs, which the table counts. */
function raceSeries(layers, band, table) {
  const inBand = (places) => (places || []).slice(band.first - 1, band.last).reduce((a, b) => a + b, 0);
  return table.map((row) => ({
    team_id: row.team_id,
    team: row.team,
    values: layers.map((layer) => inBand(layer.p.get(row.team_id))),
  }));
}

/* The biggest move between two neighbouring layers, in any line. */
function raceSwing(series, layers) {
  let best = null;
  for (const s of series) {
    for (let i = 1; i < s.values.length; i += 1) {
      const change = s.values[i] - s.values[i - 1];
      if (!best || Math.abs(change) > Math.abs(best.change)) best = { series: s, index: i, change, from: layers[i - 1], to: layers[i] };
    }
  }
  return best;
}

/* Each line's change from the last layer at least a week before the latest
   one (or the first, in a short season) to the latest. */
function raceWeek(series, layers) {
  const last = layers.length - 1;
  if (last < 1) return null;
  const cutoff = Date.parse(layers[last].date) - 7 * 86400000;
  let since = 0;
  for (let i = 0; i < last; i += 1) if (Date.parse(layers[i].date) <= cutoff) since = i;
  return { since: layers[since].date, changes: series.map((s) => ({ series: s, change: s.values[last] - s.values[since] })) };
}

/* Where a layer sits along the round axis: the pre-season at 0, round k at k,
   and "now" at the rounds' worth of matches played, kept past the layer before. */
function raceRounds(layers, report) {
  const perRound = report.table.length / 2;
  const xs = [];
  for (const layer of layers) {
    const x = layer.kind === 'pre' ? 0 : layer.kind === 'now' ? report.model.matches_played / perRound : layer.k;
    xs.push(xs.length ? Math.max(x, xs[xs.length - 1] + 0.25) : x);
  }
  return xs;
}

/* Scale the Y axis to the data so low-probability races (e.g. relegation
   play-off) use the vertical space rather than hugging the bottom half. */
function raceYMax(series) {
  let peak = 0;
  for (const s of series) for (const v of s.values) if (v > peak) peak = v;
  if (peak <= 0.45) return { max: 0.5, ticks: [0, 0.1, 0.2, 0.3, 0.4, 0.5] };
  if (peak <= 0.72) return { max: 0.75, ticks: [0, 0.25, 0.5, 0.75] };
  return { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
}

/* Split series into featured lines (coloured, labelled, shown by default) and
   fallen lines (hidden behind the toggle). On settled/finished races where fewer
   than two clubs remain active, promote the strongest past challengers with a
   dashed line so the chart still tells the story of how the race was won. */
function raceGroups(series, finished, maxFeatured = RACE_MAX_FEATURED) {
  if (!series.length) return { featured: [], fallen: [] };
  const last = series[0].values.length - 1;
  const active = series.filter((s) => s.values[last] >= 0.01).slice(0, maxFeatured);
  const featured = active.map((s) => ({ series: s, challenger: false }));
  const seen = new Set(active);
  if (finished || active.length < 2) {
    const target = Math.min(Math.max(active.length + 2, 4), maxFeatured);
    const challengers = series
      .filter((s) => !seen.has(s) && Math.max(...s.values) >= 0.15)
      .sort((a, b) => Math.max(...b.values) - Math.max(...a.values));
    for (const s of challengers) {
      if (featured.length >= target) break;
      featured.push({ series: s, challenger: true });
      seen.add(s);
    }
  }
  const fallen = series
    .filter((s) => !seen.has(s))
    .sort((a, b) => Math.max(...b.values) - Math.max(...a.values));
  return { featured, fallen };
}

/* Played matches for a club strictly after `fromDate` and up to `toDate`. */
function raceMatchesInWindow(results, teamId, fromDate, toDate) {
  const id = String(teamId);
  return (results || [])
    .filter((m) => m.date > fromDate && m.date <= toDate && (String(m.home_id) === id || String(m.away_id) === id))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/* Monotone cubic Hermite spline (Fritsch-Carlson with mild tangent damping)
   so probability lines look slightly smoothed without ever overshooting
   0 % or 100 % or distorting flat segments. */
function raceCurvePath(points, tension = 0.7) {
  const n = points.length;
  if (!n) return '';
  if (n === 1) return `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  if (n === 2) return `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)} L${points[1][0].toFixed(1)},${points[1][1].toFixed(1)}`;
  const d = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = points[i + 1][0] - points[i][0];
    d.push(dx ? (points[i + 1][1] - points[i][1]) / dx : 0);
  }
  const m = new Array(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i += 1) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (2 * d[i - 1] * d[i]) / (d[i - 1] + d[i]);
  }
  for (let i = 0; i < n - 1; i += 1) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      const s = 3 / h;
      m[i] = s * a * d[i];
      m[i + 1] = s * b * d[i];
    }
  }
  let path = `M${points[0][0].toFixed(1)},${points[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i += 1) {
    const dx = points[i + 1][0] - points[i][0];
    const k = (dx / 3) * tension;
    const cp1x = points[i][0] + dx / 3;
    const cp1y = points[i][1] + m[i] * k;
    const cp2x = points[i + 1][0] - dx / 3;
    const cp2y = points[i + 1][1] - m[i + 1] * k;
    path += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${points[i + 1][0].toFixed(1)},${points[i + 1][1].toFixed(1)}`;
  }
  return path;
}

/* Key matches explaining a biggest swing: the swinging club's match plus up to
   two major counter-moving rivals' matches in the same round window, deduplicated
   for head-to-head clashes. */
function raceSwingMatches(series, swing, results) {
  if (!swing || !results?.length) return [];
  const { index, from, to, change, series: main } = swing;
  const minRivalMove = Math.max(0.08, 0.35 * Math.abs(change));
  const rivals = series
    .filter((s) => String(s.team_id) !== String(main.team_id))
    .map((s) => ({ s, delta: s.values[index] - s.values[index - 1] }))
    .filter(({ delta }) => delta * change < 0 && Math.abs(delta) >= minRivalMove)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 2)
    .map(({ s }) => s);
  const seen = new Set();
  const out = [];
  for (const s of [main, ...rivals]) {
    const ms = raceMatchesInWindow(results, s.team_id, from.date, to.date);
    if (!ms.length) continue;
    const m = ms[ms.length - 1];
    const key = m.match_id != null ? String(m.match_id) : `${m.date}:${m.home_id}:${m.away_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
    if (out.length >= 3) break;
  }
  return out;
}

/* Whether a race is still open, likely decided, or settled. */
function raceStatus(series, band, finished) {
  if (finished) return 'settled';
  if (!series.length) return 'open';
  const last = series[0].values.length - 1;
  const slots = Math.max(1, band.last - band.first + 1);
  if (series.filter((s) => s.values[last] >= 0.95).length >= slots) return 'settled';
  if (series.filter((s) => s.values[last] >= 0.8).length >= slots) return 'likely';
  return 'open';
}

/* Up to three story highlights for the band: biggest single-round swing (with
   match result), biggest climb (or pre-season favourite), and biggest fade from
   peak (or clubs still in contention). */
function raceHighlights(series, layers, results, band) {
  if (!series.length) return [];
  const last = layers.length - 1;
  const items = [];
  const swing = raceSwing(series, layers);
  if (swing && Math.abs(swing.change) >= 0.05) {
    items.push({
      kind: 'swing',
      team_id: swing.series.team_id,
      team: swing.series.team,
      change: swing.change,
      index: swing.index,
      from: swing.from,
      to: swing.to,
      matches: raceSwingMatches(series, swing, results),
    });
  }
  let riser = null;
  for (const s of series) {
    const move = s.values[last] - s.values[0];
    if (move >= 0.05 && (!riser || move > riser.move)) riser = { series: s, move };
  }
  if (riser) {
    items.push({ kind: 'riser', team_id: riser.series.team_id, team: riser.series.team, move: riser.move, first: riser.series.values[0], now: riser.series.values[last] });
  } else {
    const preFav = [...series].sort((a, b) => b.values[0] - a.values[0])[0];
    if (preFav) items.push({ kind: 'preFav', team_id: preFav.team_id, team: preFav.team, first: preFav.values[0], now: preFav.values[last] });
  }
  let fade = null;
  for (const s of series) {
    let peak = -1;
    let peakIndex = 0;
    s.values.forEach((v, i) => { if (v > peak) { peak = v; peakIndex = i; } });
    const drop = peak - s.values[last];
    if (drop >= 0.15 && (!fade || drop > fade.drop)) fade = { series: s, peak, peakIndex, peakLayer: layers[peakIndex], now: s.values[last], drop };
  }
  if (fade) {
    items.push({ kind: 'fade', team_id: fade.series.team_id, team: fade.series.team, peak: fade.peak, peakIndex: fade.peakIndex, peakLayer: fade.peakLayer, now: fade.now, drop: fade.drop });
  } else {
    const alive = series.filter((s) => s.values[last] >= 0.05).length;
    items.push({ kind: 'alive', team_id: series[0]?.team_id, alive });
  }
  return items.slice(0, 3);
}

let raceLastBand = null;
let raceShowFallen = false;
let raceFocus = null;
let raceToken = 0;
const raceCache = { report: null, layers: null };

async function renderRaces(report, body) {
  const token = ++raceToken;
  const bands = report.league.bands || [];
  if (raceCache.report !== report) {
    body.replaceChildren(el('p', 'explore-empty', t('mountain.loading')));
    raceCache.layers = await mountainLayers(report).catch(() => []);
    raceCache.report = report;
    raceShowFallen = false;
    raceFocus = null;
  }
  if (token !== raceToken || state.activeView !== 'explore' || state.exploreItem !== 'races') return;
  const layers = raceCache.layers;
  if (layers.length < 3 || !bands.length) {
    body.replaceChildren(el('p', 'explore-empty', t('races.empty')));
    return;
  }
  const band = bands.find((b) => b.label === state.raceBand) || bands[0];
  if (band.label !== raceLastBand) {
    raceShowFallen = false;
    raceFocus = null;
    raceLastBand = band.label;
  }

  const last = layers.length - 1;
  const finished = report.model.matches_remaining === 0;
  const isBadBand = band.tone === 'relegation';
  const rangeText = (b) => (b.first === b.last ? `${b.first}.` : `${b.first}–${b.last}`);
  const layerText = (layer) => {
    if (layer.kind === 'pre') return t('races.preFull', { date: formatDate(layer.date) });
    if (layer.kind === 'now') return finished ? `${t('races.final')} · ${formatDate(layer.date)}` : t('races.afterRound', { k: Math.round(report.model.matches_played / (report.table.length / 2)), date: formatDate(layer.date) });
    return t('races.afterRound', { k: layer.k, date: formatDate(layer.date) });
  };
  const deltaTone = (delta) => {
    if (Math.abs(delta * 100) < 0.05) return 'flat';
    const good = isBadBand ? delta < 0 : delta > 0;
    return good ? 'good' : 'bad';
  };

  const series = raceSeries(layers, band, report.table)
    .filter((s) => Math.max(...s.values) >= 0.05)
    .sort((a, b) => b.values[last] - a.values[last] || Math.max(...b.values) - Math.max(...a.values));
  const { featured, fallen } = raceGroups(series, finished);
  const colours = new Map();
  featured.forEach((f, i) => colours.set(f.series.team_id, raceColour(i)));
  fallen.forEach((s) => colours.set(s.team_id, 'var(--ink-faint)'));
  const featuredIds = new Set(featured.map((f) => String(f.series.team_id)));
  const byId = new Map(series.map((s) => [String(s.team_id), s]));
  const teamRows = new Map(report.table.map((r) => [String(r.team_id), r]));

  const wrap = el('div', 'races');
  wrap.tabIndex = -1;

  // 1. Band picker + eliminated-clubs toggle
  const bar = el('div', 'races__bar');
  const picker = el('div', 'races__picker');
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', t('races.pick'));
  for (const option of bands) {
    const button = el('button', 'races__race');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(option === band));
    const dot = el('i', 'races__band-dot');
    dot.style.setProperty('--band-dot', bandColor(option, report.table.length));
    button.append(dot, el('span', '', bandEdgeName(option)), el('span', 'races__range', rangeText(option)));
    button.addEventListener('click', () => {
      state.raceBand = option.label;
      raceShowFallen = false;
      raceFocus = null;
      renderRaces(report, body);
    });
    picker.appendChild(button);
  }
  bar.appendChild(picker);

  if (fallen.length) {
    const toggle = el('button', 'races__toggle', t(raceShowFallen ? 'races.hideFallen' : 'races.showFallen', { n: fallen.length }));
    toggle.type = 'button';
    toggle.setAttribute('aria-pressed', String(raceShowFallen));
    toggle.addEventListener('click', () => {
      raceShowFallen = !raceShowFallen;
      if (!raceShowFallen && raceFocus && !featuredIds.has(raceFocus)) raceFocus = null;
      renderRaces(report, body);
    });
    bar.appendChild(toggle);
  }
  wrap.appendChild(bar);

  // 2. Quiet band header + live round/date readout
  const head = el('div', 'races__head');
  const headMain = el('div', 'races__head-main');
  const headDot = el('i', 'races__band-dot');
  headDot.style.setProperty('--band-dot', bandColor(band, report.table.length));
  const statusKind = raceStatus(series, band, finished);
  const statusPill = el('span', `races__status${statusKind === 'settled' ? ' races__status--settled' : ''}`, t(`races.status.${statusKind}`));
  headMain.append(headDot, el('h3', 'races__head-title', bandName(band)), el('span', 'races__head-range', rangeText(band)), statusPill);
  const whenEl = el('span', 'races__when', layerText(layers[last]));
  head.append(headMain, whenEl);
  wrap.appendChild(head);

  // 3. Chart
  const chartWrap = el('div', 'races__chart-wrap');
  const svg = svgEl('svg', { class: 'chart races__svg', role: 'group', 'aria-label': t('races.aria', { race: bandName(band) }) });
  chartWrap.appendChild(svg);
  wrap.appendChild(chartWrap);
  if (series.length) wrap.appendChild(el('p', 'races__hint', t('races.focusHint')));
  body.replaceChildren(wrap);

  const box = chartWrap.getBoundingClientRect().width || 940;
  const narrow = box < 600;
  const width = narrow ? Math.max(300, Math.round(box)) : 940;
  const height = narrow ? 250 : 380;
  const pad = narrow ? { top: 14, right: 16, bottom: 26, left: 38 } : { top: 18, right: 176, bottom: 30, left: 44 };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const visibleForScale = raceShowFallen ? series : featured.map((f) => f.series);
  const yScale = raceYMax(visibleForScale.length ? visibleForScale : series);
  const rounds = raceRounds(layers, report);
  const xMax = rounds[last] || 1;
  const plotLeft = pad.left;
  const plotRight = width - pad.right;
  const x = (round) => plotLeft + (round / xMax) * (plotRight - plotLeft);
  const y = (p) => pad.top + (1 - Math.min(p, yScale.max) / yScale.max) * (height - pad.top - pad.bottom);
  const svgText = (parent, className, content, attrs) => {
    const node = svgEl('text', { class: className, ...attrs });
    node.textContent = content;
    parent.appendChild(node);
    return node;
  };

  // Gradient defs for focused club area fill
  const defs = svgEl('defs');
  featured.forEach((f, i) => {
    const grad = svgEl('linearGradient', { id: `race-grad-${i}`, x1: '0', y1: '0', x2: '0', y2: '1' });
    const c = raceColour(i);
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': c, 'stop-opacity': '0.24' }));
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': c, 'stop-opacity': '0.01' }));
    defs.appendChild(grad);
  });
  const fallenGrad = svgEl('linearGradient', { id: 'race-grad-fallen', x1: '0', y1: '0', x2: '0', y2: '1' });
  fallenGrad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': 'var(--ink-muted)', 'stop-opacity': '0.18' }));
  fallenGrad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': 'var(--ink-muted)', 'stop-opacity': '0.01' }));
  defs.appendChild(fallenGrad);
  svg.appendChild(defs);

  // Gridlines & Y ticks
  for (const p of yScale.ticks) {
    svg.appendChild(svgEl('line', { class: p ? 'grid-line' : 'axis-line', x1: plotLeft, x2: plotRight, y1: y(p), y2: y(p) }));
    svgText(svg, 'tick', `${num(p * 100)}${percentSign()}`, { x: plotLeft - 6, y: y(p) + 3.5, 'text-anchor': 'end' });
  }

  // Smart X ticks: Pre, every 5 (or 10 on phone), plus final round without overlap
  const every = narrow ? 10 : 5;
  svgText(svg, 'tick', t('races.pre'), { x: x(0), y: height - 8, 'text-anchor': 'start' });
  const endX = x(xMax);
  for (let k = every; k < xMax; k += every) {
    if (endX - x(k) < 38) continue;
    svgText(svg, 'tick', t('races.round', { k }), { x: x(k), y: height - 8, 'text-anchor': 'middle' });
  }
  const lastRoundNum = Math.round(report.model.matches_played / (report.table.length / 2));
  if (lastRoundNum > 0 && endX - x(0) > 36) {
    svgText(svg, 'tick', t('races.round', { k: lastRoundNum }), { x: endX, y: height - 8, 'text-anchor': 'end' });
  }

  if (!series.length) {
    svgText(svg, 'races__none', t('races.none'), { x: (plotLeft + plotRight) / 2, y: height / 2, 'text-anchor': 'middle' });
  }

  const clubGroups = new Map();
  const endGroups = new Map();
  const baseY = y(0);

  const drawClubLine = (s, { challenger, isFallen, featIdx }) => {
    const id = String(s.team_id);
    const colour = colours.get(s.team_id);
    const g = svgEl('g', { class: 'races__club', 'data-team-id': id });
    if (isFallen && !raceShowFallen) g.setAttribute('hidden', '');
    const pts = s.values.map((v, i) => [x(rounds[i]), y(v)]);
    const lineD = raceCurvePath(pts);
    const areaD = `M${pts[0][0].toFixed(1)},${baseY.toFixed(1)} L${lineD.slice(1)} L${pts[pts.length - 1][0].toFixed(1)},${baseY.toFixed(1)} Z`;
    const area = svgEl('path', { class: 'races__area', d: areaD, fill: `url(#${isFallen ? 'race-grad-fallen' : `race-grad-${featIdx}`})` });
    const lineClass = `races__line${challenger ? ' races__line--challenger' : ''}${isFallen ? ' races__line--fallen' : ''}`;
    const line = svgEl('path', { class: lineClass, style: `stroke: ${colour}`, d: lineD });
    const dot = svgEl('circle', { class: 'races__end', style: `fill: ${colour}`, cx: pts[last][0], cy: pts[last][1], r: isFallen ? 2.5 : 3.5 });
    g.append(area, line, dot);
    svg.appendChild(g);
    clubGroups.set(id, { g, s, isFallen, colour });
  };

  // Fallen first, then featured reversed so leader draws on top
  fallen.forEach((s) => drawClubLine(s, { challenger: false, isFallen: true, featIdx: -1 }));
  [...featured].reverse().forEach((f, revIdx) => {
    const featIdx = featured.length - 1 - revIdx;
    drawClubLine(f.series, { challenger: f.challenger, isFallen: false, featIdx });
  });

  // Desktop right-margin direct labels with elbow leader lines
  if (!narrow && featured.length) {
    const labelItems = featured.map((f) => ({
      s: f.series,
      dotY: y(f.series.values[last]),
      y: y(f.series.values[last]),
    }));
    const placed = spreadLabels(labelItems, 18, pad.top + 4, height - pad.bottom - 2);
    for (const item of placed) {
      const id = String(item.s.team_id);
      const colour = colours.get(item.s.team_id);
      const eg = svgEl('g', { class: 'races__end-item', 'data-team-id': id, tabindex: 0, role: 'button', 'aria-label': `${item.s.team} ${shareText(item.s.values[last])}` });
      if (Math.abs(item.y - item.dotY) > 2) {
        const lx1 = plotRight + 3;
        const lx2 = plotRight + 9;
        const lx3 = plotRight + 14;
        eg.appendChild(svgEl('path', { class: 'races__leader', d: `M${lx1},${item.dotY.toFixed(1)} L${lx2},${item.dotY.toFixed(1)} L${lx2},${item.y.toFixed(1)} L${lx3},${item.y.toFixed(1)}` }));
      }
      eg.appendChild(svgEl('circle', { cx: plotRight + 19, cy: item.y, r: 3.5, style: `fill: ${colour}` }));
      const txt = svgEl('text', { x: plotRight + 27, y: item.y + 4 });
      const nameSpan = svgEl('tspan', { class: 'races__label-name' });
      nameSpan.textContent = `${item.s.team} `;
      const pctSpan = svgEl('tspan', { class: 'races__label-pct' });
      pctSpan.textContent = shareText(item.s.values[last]);
      txt.append(nameSpan, pctSpan);
      eg.appendChild(txt);
      svg.appendChild(eg);
      endGroups.set(id, eg);
    }
  }

  // Biggest swing marker
  const highlights = raceHighlights(series, layers, report.results, band);
  const swingItem = highlights.find((h) => h.kind === 'swing');
  let swingHalo = null;
  let swingDot = null;
  if (swingItem) {
    const sid = String(swingItem.team_id);
    const s = byId.get(sid);
    const cx = x(rounds[swingItem.index]);
    const cy = y(s.values[swingItem.index]);
    const sc = colours.get(s.team_id);
    swingHalo = svgEl('circle', { class: 'races__swing-halo', 'data-team-id': sid, cx, cy, r: 7, style: `stroke: ${sc}` });
    swingDot = svgEl('circle', { class: 'races__swing-dot', 'data-team-id': sid, cx, cy, r: 3, style: `fill: ${sc}` });
    if (!featuredIds.has(sid) && !raceShowFallen) {
      swingHalo.setAttribute('hidden', '');
      swingDot.setAttribute('hidden', '');
    }
    svg.append(swingHalo, swingDot);
  }

  // Peak marker (shown when a single club is focused)
  const peakDot = svgEl('circle', { class: 'races__peak-dot', r: 4, hidden: '' });
  svg.appendChild(peakDot);

  // Crosshair & scrub dots
  const crosshair = svgEl('line', { class: 'races__crosshair', y1: pad.top, y2: height - pad.bottom, x1: -10, x2: -10, hidden: '' });
  const scrubLayer = svgEl('g', { class: 'races__scrub-dots' });
  svg.append(crosshair, scrubLayer);

  const scrubRect = svgEl('rect', { class: 'races__scrub', x: plotLeft, y: pad.top, width: Math.max(1, plotRight - plotLeft), height: Math.max(1, height - pad.top - pad.bottom) });
  svg.appendChild(scrubRect);

  // 4. Contenders table
  const week = raceWeek(series, layers);
  const weekMap = new Map((week?.changes || []).map((c) => [String(c.series.team_id), c.change]));
  const moveLabel = !finished && week ? t('races.week', { date: formatDate(week.since) }) : t('races.col.season');

  const rowEls = new Map();
  const cardEls = [];

  const applyFocus = (focusId) => {
    const activeId = focusId || raceFocus;
    svg.classList.toggle('is-focused', Boolean(activeId));
    for (const [id, entry] of clubGroups) {
      const match = id === activeId;
      entry.g.classList.toggle('is-focused', match);
      if (entry.isFallen) {
        if (raceShowFallen || match) entry.g.removeAttribute('hidden');
        else entry.g.setAttribute('hidden', '');
      }
    }
    for (const [id, eg] of endGroups) eg.classList.toggle('is-focused', id === activeId);
    if (swingHalo && swingDot) {
      const sid = swingHalo.getAttribute('data-team-id');
      const match = sid === activeId;
      swingHalo.classList.toggle('is-focused', match);
      swingDot.classList.toggle('is-focused', match);
      if (!featuredIds.has(sid) && !raceShowFallen && !match) {
        swingHalo.setAttribute('hidden', '');
        swingDot.setAttribute('hidden', '');
      } else {
        swingHalo.removeAttribute('hidden');
        swingDot.removeAttribute('hidden');
      }
    }
    if (activeId && byId.has(activeId)) {
      const s = byId.get(activeId);
      let pk = 0;
      s.values.forEach((v, i) => { if (v > s.values[pk]) pk = i; });
      peakDot.setAttribute('cx', x(rounds[pk]));
      peakDot.setAttribute('cy', y(s.values[pk]));
      peakDot.style.fill = colours.get(s.team_id);
      peakDot.removeAttribute('hidden');
    } else {
      peakDot.setAttribute('hidden', '');
    }
    for (const [id, tr] of rowEls) tr.classList.toggle('is-focused', id === activeId);
    for (const { el: cardEl, id } of cardEls) cardEl.classList.toggle('is-focused', id === activeId);
  };

  const toggleFocus = (id) => {
    raceFocus = raceFocus === id ? null : id;
    applyFocus(null);
  };

  for (const [id, eg] of endGroups) {
    eg.addEventListener('pointerenter', () => applyFocus(id));
    eg.addEventListener('pointerleave', () => applyFocus(null));
    eg.addEventListener('click', () => toggleFocus(id));
    eg.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggleFocus(id);
    });
  }

  // Scrubber interactions
  const showScrubAt = (event, idx) => {
    const layer = layers[idx];
    const sx = x(rounds[idx]);
    crosshair.setAttribute('x1', sx);
    crosshair.setAttribute('x2', sx);
    crosshair.removeAttribute('hidden');
    whenEl.textContent = layerText(layer);

    const visibleList = series.filter((s) => featuredIds.has(String(s.team_id)) || raceShowFallen || String(s.team_id) === raceFocus);
    scrubLayer.replaceChildren();
    for (const s of visibleList) {
      scrubLayer.appendChild(svgEl('circle', {
        class: 'races__scrub-dot',
        cx: sx,
        cy: y(s.values[idx]),
        r: String(s.team_id) === raceFocus ? 4.5 : 3.2,
        style: `fill: ${colours.get(s.team_id)}`,
      }));
    }

    const rankedAtIdx = [...visibleList].sort((a, b) => b.values[idx] - a.values[idx]);
    const tipList = rankedAtIdx.slice(0, 5);
    if (raceFocus && byId.has(raceFocus) && !tipList.some((s) => String(s.team_id) === raceFocus)) {
      tipList[tipList.length - 1] = byId.get(raceFocus);
    }
    const rowsHtml = tipList.map((s) => {
      const val = s.values[idx];
      const delta = idx > 0 ? val - s.values[idx - 1] : 0;
      const dStr = idx > 0 && Math.abs(delta * 100) >= 0.05 ? changeText(delta * 100, 1) : '';
      const tone = deltaTone(delta);
      const focused = String(s.team_id) === raceFocus;
      return `<div class="races__tip-row${focused ? ' is-focused' : ''}">` +
        `<i class="races__swatch" style="background:${colours.get(s.team_id)}"></i>` +
        `<span class="races__tip-name">${esc(s.team)}</span>` +
        `<span class="races__tip-pct">${esc(shareText(val))}</span>` +
        `<span class="races__tip-delta races__delta--${tone}">${esc(dStr)}</span>` +
        `</div>`;
    }).join('');
    const clubLabel = (name) => (typeof shortName === 'function' ? shortName(name) : name);
    let matchHtml = '';
    if (raceFocus && idx > 0) {
      const ms = raceMatchesInWindow(report.results, raceFocus, layers[idx - 1].date, layer.date);
      if (ms.length) {
        const mText = ms.map((m) => `${esc(clubLabel(m.home))} ${m.home_goals}–${m.away_goals} ${esc(clubLabel(m.away))}`).join(' · ');
        matchHtml = `<div class="races__tip-match">${mText}</div>`;
      }
    }
    showTooltip(event, `<div class="races__tip-head"><span>${esc(mountainLabel(layer))}</span><span>${esc(formatDate(layer.date))}</span></div><div class="races__tip-rows">${rowsHtml}</div>${matchHtml}`, scrubRect);
  };

  const nearestIdx = (clientX) => {
    const r = svg.getBoundingClientRect();
    const lx = (clientX - r.left) * (width / r.width);
    let best = 0;
    for (let i = 1; i < rounds.length; i += 1) {
      if (Math.abs(x(rounds[i]) - lx) < Math.abs(x(rounds[best]) - lx)) best = i;
    }
    return best;
  };

  scrubRect.addEventListener('pointermove', (event) => showScrubAt(event, nearestIdx(event.clientX)));
  scrubRect.addEventListener('pointerleave', () => {
    crosshair.setAttribute('hidden', '');
    scrubLayer.replaceChildren();
    whenEl.textContent = layerText(layers[last]);
    hideTooltip();
  });
  scrubRect.addEventListener('click', (event) => {
    const r = svg.getBoundingClientRect();
    const ly = (event.clientY - r.top) * (height / r.height);
    const idx = nearestIdx(event.clientX);
    const visibleList = series.filter((s) => featuredIds.has(String(s.team_id)) || raceShowFallen || String(s.team_id) === raceFocus);
    let best = null;
    let bestDist = 22;
    for (const s of visibleList) {
      const dist = Math.abs(y(s.values[idx]) - ly);
      if (dist < bestDist) { bestDist = dist; best = s; }
    }
    if (best) toggleFocus(String(best.team_id));
    else if (raceFocus) { raceFocus = null; applyFocus(null); }
  });

  if (series.length) {
    const tableWrap = el('div', 'races__table-wrap');
    const table = el('table', 'races__table');
    const thead = el('thead');
    const htr = el('tr');
    for (const label of [t('races.col.club'), t('races.col.pre'), t('races.col.peak'), t('races.col.now')]) {
      htr.appendChild(el('th', '', label));
    }
    const moveTh = el('th');
    moveTh.append(
      el('span', 'races__move-long', moveLabel),
      el('span', 'races__move-short', !finished && week ? t('races.col.moveShort') : t('races.col.season')),
    );
    htr.appendChild(moveTh);
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = el('tbody');
    const buildRow = (s, { challenger, isFallen }) => {
      const id = String(s.team_id);
      const tr = el('tr', `races__row${isFallen ? ' is-fallen' : ''}`);
      tr.tabIndex = 0;

      const tdClub = el('td');
      const cell = el('div', 'races__club-cell');
      const swatch = el('i', `races__swatch${challenger ? ' races__swatch--challenger' : ''}`);
      if (challenger) swatch.style.color = colours.get(s.team_id);
      else swatch.style.background = colours.get(s.team_id);
      cell.appendChild(swatch);
      const crest = teamLogo(s.team_id, s.team, true);
      if (crest) {
        crest.className = 'races__crest';
        crest.alt = '';
        crest.setAttribute('aria-hidden', 'true');
        cell.appendChild(crest);
      }
      cell.appendChild(el('span', 'races__club-name', s.team));
      if (teamRows.has(id)) {
        const openBtn = el('button', 'races__open-club', '›');
        openBtn.type = 'button';
        openBtn.setAttribute('aria-label', t('races.openClub', { team: s.team }));
        openBtn.title = t('races.openClub', { team: s.team });
        openBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openTeamView(s.team_id, s.team);
        });
        cell.appendChild(openBtn);
      }
      tdClub.appendChild(cell);

      let pkIdx = 0;
      s.values.forEach((v, i) => { if (v > s.values[pkIdx]) pkIdx = i; });
      const tdPre = el('td', '', shareText(s.values[0]));
      const tdPeak = el('td');
      tdPeak.appendChild(document.createTextNode(shareText(s.values[pkIdx])));
      const pkShort = layers[pkIdx].kind === 'pre' ? t('races.pre') : layers[pkIdx].kind === 'now' ? t('races.final') : t('races.round', { k: layers[pkIdx].k });
      tdPeak.appendChild(el('span', 'races__peak-round', `(${pkShort})`));
      const tdNow = el('td', 'races__now-val', shareText(s.values[last]));

      const delta = !finished && weekMap.has(id) ? weekMap.get(id) : s.values[last] - s.values[0];
      const dStr = Math.abs(delta * 100) >= 0.05 ? changeText(delta * 100, 1) : '–';
      const tdMove = el('td', `races__delta--${deltaTone(delta)}`, dStr);

      tr.append(tdClub, tdPre, tdPeak, tdNow, tdMove);
      tr.addEventListener('pointerenter', () => applyFocus(id));
      tr.addEventListener('pointerleave', () => applyFocus(null));
      tr.addEventListener('click', () => toggleFocus(id));
      tr.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        toggleFocus(id);
      });
      tbody.appendChild(tr);
      rowEls.set(id, tr);
    };

    for (const f of featured) buildRow(f.series, { challenger: f.challenger, isFallen: false });
    if (raceShowFallen && fallen.length) {
      const gtr = el('tr', 'races__group-row');
      const gth = el('th', '', t('races.fallenGroup'));
      gth.colSpan = 5;
      gtr.appendChild(gth);
      tbody.appendChild(gtr);
      for (const s of fallen) buildRow(s, { challenger: false, isFallen: true });
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    wrap.appendChild(tableWrap);
  }

  // 5. Story highlights strip
  if (highlights.length) {
    const grid = el('div', 'races__highlights');
    for (const item of highlights) {
      const card = el('button', 'races__card');
      card.type = 'button';
      const id = item.team_id != null ? String(item.team_id) : null;
      const swatch = id && colours.has(item.team_id) ? el('i', 'races__swatch') : null;
      if (swatch) swatch.style.background = colours.get(item.team_id);

      if (item.kind === 'swing') {
        card.appendChild(el('span', 'races__card-eyebrow', t('races.fact.swing')));
        const ch = el('div', 'races__card-head');
        const club = el('span', 'races__card-club');
        if (swatch) club.appendChild(swatch);
        club.appendChild(document.createTextNode(item.team));
        const val = el('b', `races__card-val races__delta--${deltaTone(item.change)}`, `${changeText(item.change * 100, 1)} ${t('races.pp')}`);
        ch.append(club, val);
        card.append(ch, el('p', 'races__card-text', t('races.fact.swingText', { change: `${signed(item.change * 100, 1)} ${t('races.pp')}`, from: mountainLabel(item.from), to: mountainLabel(item.to) })));
        if (item.matches.length) {
          const fmt = (m) => `${typeof shortName === 'function' ? shortName(m.home) : m.home} ${m.home_goals}–${m.away_goals} ${typeof shortName === 'function' ? shortName(m.away) : m.away}`;
          const text = item.matches.length === 1
            ? t('races.fact.swingMatch', { match: fmt(item.matches[0]) })
            : t('races.fact.swingMatches', { matches: item.matches.map(fmt).join(' · ') });
          card.appendChild(el('p', 'races__card-match', text));
        }
      } else if (item.kind === 'riser') {
        card.appendChild(el('span', 'races__card-eyebrow', t('races.fact.riser')));
        const ch = el('div', 'races__card-head');
        const club = el('span', 'races__card-club');
        if (swatch) club.appendChild(swatch);
        club.appendChild(document.createTextNode(item.team));
        const val = el('b', `races__card-val races__delta--${deltaTone(item.move)}`, `${changeText(item.move * 100, 1)} ${t('races.pp')}`);
        ch.append(club, val);
        card.append(ch, el('p', 'races__card-text', t('races.fact.riserText', { first: shareText(item.first), now: shareText(item.now) })));
      } else if (item.kind === 'preFav') {
        card.appendChild(el('span', 'races__card-eyebrow', t('races.fact.preFav')));
        const ch = el('div', 'races__card-head');
        const club = el('span', 'races__card-club');
        if (swatch) club.appendChild(swatch);
        club.appendChild(document.createTextNode(item.team));
        const val = el('b', 'races__card-val', shareText(item.first));
        ch.append(club, val);
        card.append(ch, el('p', 'races__card-text', t('races.fact.preFavText', { first: shareText(item.first), now: shareText(item.now) })));
      } else if (item.kind === 'fade') {
        card.appendChild(el('span', 'races__card-eyebrow', t('races.fact.fade')));
        const ch = el('div', 'races__card-head');
        const club = el('span', 'races__card-club');
        if (swatch) club.appendChild(swatch);
        club.appendChild(document.createTextNode(item.team));
        const val = el('b', `races__card-val races__delta--${deltaTone(-item.drop)}`, `${changeText(-item.drop * 100, 1)} ${t('races.pp')}`);
        ch.append(club, val);
        card.append(ch, el('p', 'races__card-text', t('races.fact.fadeText', { peak: shareText(item.peak), when: mountainLabel(item.peakLayer), now: shareText(item.now) })));
      } else {
        card.appendChild(el('span', 'races__card-eyebrow', t('races.fact.alive')));
        const ch = el('div', 'races__card-head');
        ch.appendChild(el('b', 'races__card-val', String(item.alive)));
        card.append(ch, el('p', 'races__card-text', t('races.fact.aliveText')));
      }

      if (id && byId.has(id)) {
        card.addEventListener('pointerenter', () => applyFocus(id));
        card.addEventListener('pointerleave', () => applyFocus(null));
        card.addEventListener('click', () => toggleFocus(id));
        cardEls.push({ el: card, id });
      }
      grid.appendChild(card);
    }
    wrap.appendChild(grid);
  }

  // 6. Footer: concise play-off caveat + collapsible method note
  const foot = el('div', 'races__foot');
  if (band.tone === 'relegation' || (band.tone === 'top' && report.league.slug === 'obosligaen')) {
    foot.appendChild(el('p', 'races__playoff-note', t('races.playoffNote')));
  }
  const details = el('details', 'races__method');
  details.appendChild(el('summary', '', t('races.methodTitle')));
  details.appendChild(el('p', '', t('races.note')));
  foot.appendChild(details);
  wrap.appendChild(foot);

  wrap.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && raceFocus) {
      raceFocus = null;
      applyFocus(null);
    }
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    RACE_MAX_FEATURED, spreadLabels, raceSeries, raceSwing, raceWeek, raceRounds,
    raceYMax, raceGroups, raceMatchesInWindow, raceCurvePath, raceSwingMatches,
    raceStatus, raceHighlights,
  };
}
