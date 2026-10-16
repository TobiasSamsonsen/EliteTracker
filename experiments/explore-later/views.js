/* Stored for later (October 2026): three Explore views taken out of public/app.js.
   Not runnable on their own; see README.md for how to put them back. */

/* EXPLORE_ITEMS ids: 'lift', 'river', 'scorelines' */

/* renderExplore routes:
  if (item === 'lift') return renderLift(report, body);
  if (item === 'river') return renderRiver(report, body);
  if (item === 'scorelines') return renderScorelines(report, body);
*/

/* exploreThumb branches (go before `} else if (id === 'h2h') {` and `} else if (id === 'stakes') {`):
  } else if (id === 'lift') {
    // Two lanes, lines moving between them.
    svg.appendChild(svgEl('rect', { class: 'lift__lane lift__lane--elite', x: 12, y: 8, width: 136, height: 36, rx: 4 }));
    svg.appendChild(svgEl('rect', { class: 'lift__lane', x: 12, y: 46, width: 136, height: 36, rx: 4 }));
    [[[20, 20], [60, 30], [100, 60], [140, 26]], [[20, 70], [60, 56], [100, 22], [140, 18]], [[20, 38], [60, 64], [100, 74], [140, 66]]].forEach((pts, i) => {
      svg.appendChild(svgEl('polyline', { points: pts.map(([px, py]) => `${px},${py}`).join(' '), style: `fill: none; stroke: ${lineColour(i)}; stroke-width: 2.5` }));
    });
  } else if (id === 'river') {
    // Many faint lines, three in colour.
    for (let i = 0; i < 9; i += 1) {
      const pts = Array.from({ length: 9 }, (_, k) => `${16 + k * 16},${45 + 25 * Math.sin((k + i * 1.7) / 2.2) * (i % 3 ? 0.6 : 1)}`);
      svg.appendChild(svgEl('polyline', { points: pts.join(' '), style: `fill: none; stroke: ${i < 3 ? lineColour(i) : 'var(--rule-strong)'}; stroke-width: ${i < 3 ? 2.5 : 1.2}` }));
    }
  } else if (id === 'scorelines') {
    // A 4x4 score grid, the common results darker.
    for (let r = 0; r < 4; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        svg.appendChild(svgEl('rect', { x: 48 + c * 17, y: 9 + r * 17, width: 15, height: 15, rx: 2, style: `fill: ${seqColor(Math.max(0.05, 0.9 - (r + c) * 0.17 - Math.abs(r - c) * 0.05))}` }));
      }
    }
*/

/* ---------- explore: the lift between the divisions (viz=lift) --------- */

/* Every club's season-by-season place across both divisions (careers.json):
   Eliteserien places 1-16 and OBOS-ligaen's below them as 17-32, so a
   promotion or a relegation is a line crossing between the lanes. */
function liftRows(careers) {
  return (careers?.teams || [])
    .map((team) => ({
      team_id: team.team_id,
      team: team.team,
      stops: (team.seasons || [])
        .map((s) => ({ season: s.season, league: s.league, position: s.position, rank: s.position + (s.league === 'obosligaen' ? 16 : 0) }))
        .sort((a, b) => a.season - b.season),
    }))
    .filter((row) => row.stops.length);
}

/* Promotions and relegations between consecutive seasons, and the longest
   unbroken run in Eliteserien. */
function liftMoves(row) {
  let [up, down, run, best] = [0, 0, 0, 0];
  row.stops.forEach((stop, i) => {
    const prev = row.stops[i - 1];
    if (prev && prev.season === stop.season - 1 && prev.league !== stop.league) {
      if (stop.league === 'eliteserien') up += 1;
      else down += 1;
    }
    run = stop.league === 'eliteserien' && (!prev || (prev.season === stop.season - 1 && prev.league === 'eliteserien')) ? run + 1
      : stop.league === 'eliteserien' ? 1 : 0;
    best = Math.max(best, run);
  });
  return { up, down, moves: up + down, best };
}

function renderLift(report, body) {
  const rows = liftRows(state.careers);
  if (!rows.length) {
    body.replaceChildren(el('p', 'explore-empty', t('lift.empty')));
    return;
  }
  const seasons = [...new Set(rows.flatMap((row) => row.stops.map((s) => s.season)))].sort((a, b) => a - b);
  const wrap = el('div', 'lift');
  const svg = svgEl('svg', { class: 'chart', role: 'group', 'aria-label': t('lift.aria') });
  wrap.appendChild(svg);
  body.replaceChildren(wrap);
  const box = wrap.getBoundingClientRect().width || 940;
  const narrow = box < SHAPE_NARROW;
  const width = narrow ? Math.round(box) : 940;
  const height = narrow ? 460 : 560;
  const pad = { top: 12, right: 12, bottom: 26, left: narrow ? 30 : 40 };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const x = (season) => pad.left + ((season - seasons[0]) / Math.max(1, seasons.length - 1)) * (width - pad.left - pad.right);
  const y = (rank) => pad.top + ((rank - 0.5) / 32) * (height - pad.top - pad.bottom);
  const text = (className, content, attrs) => {
    const node = svgEl('text', { class: className, ...attrs });
    node.textContent = content;
    svg.appendChild(node);
  };
  svg.appendChild(svgEl('rect', { class: 'lift__lane lift__lane--elite', x: pad.left - 8, y: y(0.5), width: width - pad.left - pad.right + 16, height: y(16.5) - y(0.5) }));
  svg.appendChild(svgEl('rect', { class: 'lift__lane', x: pad.left - 8, y: y(16.5), width: width - pad.left - pad.right + 16, height: y(32.5) - y(16.5) }));
  for (const [name, mid] of [['Eliteserien', y(8.5)], ['OBOS-ligaen', y(24.5)]]) {
    text('lift__lane-name', name, { x: 10, y: mid, 'text-anchor': 'middle', transform: `rotate(-90 10 ${mid})` });
  }
  for (const season of seasons) {
    if (narrow && season % 2 && season !== seasons[seasons.length - 1]) continue;
    text('tick', narrow ? `'${String(season).slice(2)}` : String(season), { x: x(season), y: height - 8, 'text-anchor': 'middle' });
  }
  const focus = new Set((report.table || []).map((row) => String(row.team_id)));
  for (const row of rows) {
    const g = svgEl('g', { class: `lift__club${focus.has(String(row.team_id)) ? ' lift__club--now' : ''}`, tabindex: 0 });
    row.stops.forEach((stop, i) => {
      const prev = row.stops[i - 1];
      if (!prev || prev.season !== stop.season - 1) return;
      const kind = prev.league === stop.league ? 'stay' : stop.league === 'eliteserien' ? 'up' : 'down';
      g.appendChild(svgEl('line', { class: `lift__step lift__step--${kind}`, x1: x(prev.season), y1: y(prev.rank), x2: x(stop.season), y2: y(stop.rank) }));
    });
    for (const stop of row.stops) g.appendChild(svgEl('circle', { class: 'lift__dot', cx: x(stop.season), cy: y(stop.rank), r: 2.4 }));
    const moves = liftMoves(row);
    const tip = t('lift.tip', { team: row.team, up: moves.up, down: moves.down, seasons: row.stops.length });
    g.setAttribute('aria-label', tip);
    attachTip(g, `<b>${row.team}</b><br>${tip}<br>${row.stops.map((s) => `${s.season}: ${s.position}. ${s.league === 'eliteserien' ? 'ES' : 'OBOS'}`).join(' · ')}`);
    g.addEventListener('click', () => openTeamView(row.team_id, row.team));
    svg.appendChild(g);
  }
  const stats = rows.map((row) => ({ row, ...liftMoves(row) }));
  const most = (key) => [...stats].sort((a, b) => b[key] - a[key] || a.row.team.localeCompare(b.row.team))[0];
  const [ups, yoyo, longest] = [most('up'), most('moves'), most('best')];
  const both = stats.filter((s) => new Set(s.row.stops.map((stop) => stop.league)).size === 2).length;
  wrap.appendChild(exploreFacts([
    { value: ups.row.team, label: t('lift.fact.ups'), text: t('lift.fact.upsText', { n: ups.up }) },
    { value: yoyo.row.team, label: t('lift.fact.yoyo'), text: t('lift.fact.yoyoText', { n: yoyo.moves }) },
    { value: longest.row.team, label: t('lift.fact.longest'), text: t('lift.fact.longestText', { n: longest.best }) },
    { value: String(both), label: t('lift.fact.both'), text: t('lift.fact.bothText', { n: rows.length }) },
  ]));
}


/* ---------- explore: rating river (viz=river) -------------------------- */

/* A club's rating over time, one point a month (the month's last match):
   enough to draw, a fraction of careers.json's per-match points. */
function monthlyRatings(points) {
  const months = new Map();
  for (const [date, rating] of points || []) months.set(date.slice(0, 7), [date, rating]);
  return [...months.values()];
}

/* The monthly points split where a club went more than 200 days without a
   match (a season or more outside the top two divisions), so the line does
   not bridge seasons it never played. */
function riverSegments(points) {
  const segments = [];
  for (const point of points) {
    const last = segments[segments.length - 1];
    if (last && Date.parse(point[0]) - Date.parse(last[last.length - 1][0]) <= 200 * 864e5) last.push(point);
    else segments.push([point]);
  }
  return segments;
}

function renderRiver(report, body) {
  const teams = (state.careers?.teams || []).filter((team) => (team.points || []).length);
  if (!teams.length) {
    body.replaceChildren(el('p', 'explore-empty', t('river.empty')));
    return;
  }
  const wrap = el('div', 'river');
  const svg = svgEl('svg', { class: 'chart', role: 'group', 'aria-label': t('river.aria') });
  wrap.appendChild(svg);
  body.replaceChildren(wrap);
  const box = wrap.getBoundingClientRect().width || 940;
  const narrow = box < SHAPE_NARROW;
  const width = narrow ? Math.round(box) : 940;
  const height = narrow ? 360 : 460;
  const pad = { top: 14, right: narrow ? 70 : 110, bottom: 26, left: 42 };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const lines = teams.map((team) => ({ team, points: monthlyRatings(team.points) }));
  const all = lines.flatMap((line) => line.points);
  const [t0, t1] = [Math.min(...all.map((p) => Date.parse(p[0]))), Math.max(...all.map((p) => Date.parse(p[0])))];
  const [r0, r1] = [Math.floor(Math.min(...all.map((p) => p[1])) / 100) * 100, Math.ceil(Math.max(...all.map((p) => p[1])) / 100) * 100];
  const x = (date) => pad.left + ((Date.parse(date) - t0) / (t1 - t0 || 1)) * (width - pad.left - pad.right);
  const y = (rating) => pad.top + (1 - (rating - r0) / (r1 - r0 || 1)) * (height - pad.top - pad.bottom);
  const text = (className, content, attrs) => {
    const node = svgEl('text', { class: className, ...attrs });
    node.textContent = content;
    svg.appendChild(node);
  };
  for (let r = r0; r <= r1; r += 100) {
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: pad.left, x2: width - pad.right, y1: y(r), y2: y(r) }));
    text('tick', String(r), { x: pad.left - 6, y: y(r) + 3.5, 'text-anchor': 'end' });
  }
  const first = new Date(t0).getFullYear();
  for (let year = first + 1; year <= new Date(t1).getFullYear(); year += narrow ? 2 : 1) {
    text('tick', narrow ? `'${String(year).slice(2)}` : String(year), { x: x(`${year}-01-01`), y: height - 8, 'text-anchor': 'middle' });
  }
  // Clubs in the division shown in colour, the rest faint behind them.
  const focus = new Map((report.table || []).map((row, i) => [String(row.team_id), i]));
  const ordered = [...lines].sort((a, b) => focus.has(String(a.team.team_id)) - focus.has(String(b.team.team_id)));
  const labels = [];
  for (const { team, points } of ordered) {
    const index = focus.get(String(team.team_id));
    const lit = index !== undefined;
    const g = svgEl('g', { class: `river__club${lit ? ' river__club--now' : ''}`, tabindex: lit ? 0 : -1 });
    for (const segment of riverSegments(points)) {
      g.appendChild(svgEl('polyline', {
        class: 'river__line', style: lit ? `stroke: ${lineColour(index)}` : '',
        points: segment.map(([date, rating]) => `${x(date)},${y(rating)}`).join(' '),
      }));
    }
    const [lastDate, lastRating] = points[points.length - 1];
    const tip = t('river.tip', { team: team.team, now: num(team.current_rating), peak: num(team.peak?.[1] || 0), peakDate: team.peak?.[0] || '' });
    g.setAttribute('aria-label', tip);
    attachTip(g, tip);
    g.addEventListener('click', () => openTeamView(team.team_id, team.team));
    svg.appendChild(g);
    if (lit && lastDate.slice(0, 4) === String(new Date(t1).getFullYear())) labels.push({ y: y(lastRating), text: team.team, colour: lineColour(index) });
  }
  for (const label of spreadLabels(labels, 12, pad.top + 4, height - pad.bottom)) {
    text('river__label', label.text, { x: width - pad.right + 5, y: label.y + 4, style: `fill: ${label.colour}` });
  }
  const peak = [...teams].sort((a, b) => (b.peak?.[1] || 0) - (a.peak?.[1] || 0))[0];
  const trough = [...teams].sort((a, b) => (a.trough?.[1] || 0) - (b.trough?.[1] || 0))[0];
  const seasons = teams.flatMap((team) => (team.seasons || []).map((s) => ({ team: team.team, ...s })));
  const climb = [...seasons].sort((a, b) => b.rating_change - a.rating_change)[0];
  const top = [...teams].sort((a, b) => b.current_rating - a.current_rating)[0];
  wrap.appendChild(exploreFacts([
    { value: peak.team, label: t('river.fact.peak'), text: t('river.fact.peakText', { rating: num(peak.peak[1]), date: peak.peak[0] }) },
    { value: climb ? climb.team : '–', label: t('river.fact.climb'), text: climb ? t('river.fact.climbText', { season: climb.season, change: signed(climb.rating_change, 0) }) : '' },
    { value: top.team, label: t('river.fact.top'), text: t('river.fact.topText', { rating: num(top.current_rating) }) },
    { value: trough.team, label: t('river.fact.trough'), text: t('river.fact.troughText', { rating: num(trough.trough[1]), date: trough.trough[0] }) },
  ]));
}


/* ---------- explore: scorelines, predicted and actual (viz=scorelines) - */

/* calibration.json's scorelines as a lookup, home goals x away goals, 4 = 4+. */
function scorelineCells(rows) {
  const cells = new Map();
  for (const row of rows || []) cells.set(`${row.home}-${row.away}`, row);
  return cells;
}

async function renderScorelines(report, body) {
  body.replaceChildren(el('p', 'explore-empty', t('calib.loading')));
  let data;
  try {
    data = await loadCalibration();
  } catch {
    data = null;
  }
  if (state.exploreItem !== 'scorelines') return;
  if (!data || !(data.scorelines || []).length) {
    body.replaceChildren(el('p', 'explore-empty', t('calib.empty')));
    return;
  }
  const cells = scorelineCells(data.scorelines);
  const wrap = el('div', 'scorelines');
  const table = el('table', 'scorelines__table');
  table.setAttribute('aria-label', t('scorelines.aria'));
  const head = el('tr');
  head.appendChild(el('th', 'scorelines__corner', t('scorelines.corner')));
  for (let away = 0; away <= 4; away += 1) head.appendChild(el('th', '', away === 4 ? '4+' : String(away)));
  table.appendChild(head);
  for (let home = 0; home <= 4; home += 1) {
    const tr = el('tr');
    tr.appendChild(el('th', '', home === 4 ? '4+' : String(home)));
    for (let away = 0; away <= 4; away += 1) {
      const cell = cells.get(`${home}-${away}`) || { predicted: 0, observed: 0 };
      const td = el('td', 'scorelines__cell');
      const lean = cell.predicted ? Math.max(-1, Math.min(1, (cell.observed - cell.predicted) / cell.predicted / 0.3)) : 0;
      td.style.background = `color-mix(in oklab, var(${lean >= 0 ? '--outcome-good' : '--outcome-bad'}) ${Math.round(Math.abs(lean) * 55)}%, var(--panel))`;
      td.appendChild(el('b', '', pct(cell.observed, 1)));
      td.appendChild(el('span', 'scorelines__predicted', pct(cell.predicted, 1)));
      const score = `${home === 4 ? '4+' : home}–${away === 4 ? '4+' : away}`;
      const tip = t('scorelines.tip', { score, observed: pct(cell.observed, 1), predicted: pct(cell.predicted, 1) });
      td.tabIndex = 0;
      td.setAttribute('aria-label', tip);
      attachTip(td, tip);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  const scroller = el('div', 'h2h__scroll');
  scroller.appendChild(table);
  wrap.appendChild(scroller);
  wrap.appendChild(el('p', 'explore-note', t('scorelines.legend', { n: num(data.scores.all.n), from: data.first_season, to: data.last_season })));
  body.replaceChildren(wrap);

  const rows = data.scorelines;
  const draws = rows.filter((r) => r.home === r.away);
  const sum = (list, key) => list.reduce((total, r) => total + r[key], 0);
  const label = (r) => `${r.home === 4 ? '4+' : r.home}–${r.away === 4 ? '4+' : r.away}`;
  const gap = (r) => r.observed - r.predicted;
  const over = [...rows].sort((a, b) => gap(a) - gap(b))[0];
  const under = [...rows].sort((a, b) => gap(b) - gap(a))[0];
  const common = [...rows].sort((a, b) => b.observed - a.observed)[0];
  wrap.appendChild(exploreFacts([
    { value: `${pct(sum(draws, 'predicted'), 1)} → ${pct(sum(draws, 'observed'), 1)}`, label: t('scorelines.fact.draws'), text: t('scorelines.fact.drawsText') },
    { value: label(common), label: t('scorelines.fact.common'), text: t('scorelines.fact.commonText', { observed: pct(common.observed, 1), predicted: pct(common.predicted, 1) }) },
    { value: label(under), label: t('scorelines.fact.under'), text: t('scorelines.fact.gapText', { observed: pct(under.observed, 1), predicted: pct(under.predicted, 1) }) },
    { value: label(over), label: t('scorelines.fact.over'), text: t('scorelines.fact.gapText', { observed: pct(over.observed, 1), predicted: pct(over.predicted, 1) }) },
  ]));
}


