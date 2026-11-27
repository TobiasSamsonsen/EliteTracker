/* ---------- model card: how accurate the model is ---------------------- */

/* First season with xG per division (Eliteserien 2020 FotMob, OBOS-ligaen 2023 Sofascore). */
const XG_FIRST_SEASON = { eliteserien: 2020, obosligaen: 2023 };

/* The division the pre-season scorecard shows. The model card's hero offers
   only the season, so the scorecard carries a division switch of its own. */
function accuracyLeague() {
  return state.accuracyLeague || state.league;
}

/* How accurate the model is, under the model card, in three parts: how every
   model version's odds compare on the xG seasons; match by match, its odds
   against what happened (both divisions, xG seasons); and before the season,
   the table it called against the one that came (one division, xG seasons). */
async function renderAccuracy(report, body) {
  body.replaceChildren();
  const part = (key, numTag, id) => {
    const section = el('section', 'accuracy__part');
    section.id = id;
    const head = el('div', 'accuracy__head');
    const titleWrap = el('div');
    titleWrap.appendChild(el('div', 'accuracy__eyebrow', numTag));
    titleWrap.appendChild(el('h3', 'accuracy__title', t(`accuracy.${key}`)));
    titleWrap.appendChild(el('p', 'accuracy__lead', t(`accuracy.${key}Lead`)));
    head.appendChild(titleWrap);
    section.appendChild(head);
    const content = el('div');
    section.appendChild(content);
    body.appendChild(section);
    return { section, head, content };
  };
  // Newest view of the model first: the versions, then match by match, then the table.
  const versionsSec = part('versions', '01', 'accuracy-versions');
  const matchesSec = part('matches', '02', 'accuracy-matches');
  const tableSec = part('table', '03', 'accuracy-table');
  const divisions = el('div', 'accuracy__divisions');
  divisions.setAttribute('role', 'group');
  divisions.setAttribute('aria-label', t('accuracy.division'));
  const drawTable = () => {
    const slug = accuracyLeague();
    for (const button of divisions.children) button.setAttribute('aria-pressed', String(button.dataset.league === slug));
    return renderScorecard(state.reports[slug] || report, tableSec.content);
  };
  for (const [slug, other] of Object.entries(state.reports || {})) {
    const button = el('button', 'accuracy__division', other.league.name);
    button.type = 'button';
    button.dataset.league = slug;
    button.addEventListener('click', () => {
      state.accuracyLeague = slug;
      drawTable();
    });
    divisions.appendChild(button);
  }
  tableSec.head.appendChild(divisions);
  versionsSec.content.appendChild(el('p', 'explore-empty', t('calib.loading')));
  const versions = loadCalibration().then(
    (data) => { if (state.activeView === 'model') renderVersionHistory(report, versionsSec.content, data); },
    () => renderVersionHistory(report, versionsSec.content, null),
  );
  await Promise.all([drawTable(), renderCalibration(report, matchesSec.content), versions]);
}

/* Before the season: the prediction scorecard. */
/* One season's call before a ball was kicked against how it ended: each
   club's expected finish in the pre-season view, the place that puts it in
   (the model's order) and its final place. The call is the order: an
   average bunches towards the middle, so no club is ever expected first or
   last, and the clubs at the ends would miss by more than the model did. */
function scorecardRows(season, pre, final) {
  const placed = new Map(final.map((row) => [row.team_id, row]));
  const rows = pre
    .filter((row) => placed.has(row.team_id))
    .map((row) => {
      const end = placed.get(row.team_id);
      return { season, team_id: row.team_id, team: end.team, expected: expectedFinish(row), finished: end.position };
    });
  [...rows].sort((a, b) => a.expected - b.expected).forEach((row, index) => {
    row.called = index + 1;
    row.miss = row.finished - row.called;
  });
  return rows;
}

/* The naive call to measure the model against: last season's table, the
   clubs from Eliteserien first and OBOS-ligaen's after them, so a relegated
   club tops OBOS-ligaen and a promoted one ends Eliteserien. Clubs from
   neither (up from the 2. divisjon) share the places left at the bottom. */
function scorecardLastSeason(rows, previous) {
  const key = new Map();
  ['eliteserien', 'obosligaen'].forEach((slug, tier) => {
    for (const row of (previous[slug] || {}).table || []) {
      if (!key.has(row.team_id)) key.set(row.team_id, tier * 100 + row.position);
    }
  });
  const keys = rows.map((row) => key.get(row.team_id) ?? 1000);
  return rows.map((row, i) => {
    const above = keys.filter((k) => k < keys[i]).length;
    const level = keys.filter((k) => k === keys[i]).length;
    return { ...row, lastMiss: row.finished - (above + (level + 1) / 2) };
  });
}

/* Clubs that finished within two places of the call, as the mountain counts it. */
function scorecardHits(rows, field = 'miss') {
  return rows.filter((row) => Math.abs(row[field]) <= 2).length;
}

/* A finished season's rows: the pre-season view where the build has one,
   else the season shape's first snapshot when it predates the first match
   (archives built before the pre-season view), else nothing. With them,
   last season's call where the build has the season before. */
async function scorecardSeason(season, slug, seasons) {
  // The summary holds this season's call and final table already.
  const stored = (await fetchSummary())?.seasons?.[season]?.[slug];
  if (stored) {
    if (stored.model.matches_remaining || !stored.pre) return [];
    const rows = scorecardRows(season, stored.pre, stored.table);
    const before = seasons.includes(season - 1) ? (await fetchSummary()).seasons[season - 1] : null;
    return before ? scorecardLastSeason(rows, before) : rows;
  }
  // The live view, fetched here rather than through loadSeasonReports, which
  // hands back the rewound copy when the reader has rewound this season.
  const live = (await fetchedReport(reportUrl(season)))[slug];
  if (!live || live.model.matches_remaining) return [];
  const preseason = live.league.preseason;
  let pre = null;
  if (preseason) {
    pre = await fetchedReport(reportUrl(season, preseason)).then((r) => r[slug].table, () => null);
  }
  const history = live.history || {};
  if (!pre && history.teams && history.latest_rounds && history.latest_rounds[0] == null) {
    pre = history.teams.map((team) => ({ team_id: team.team_id, position_probabilities: team.positions[0] }));
  }
  if (!pre) return [];
  const rows = scorecardRows(season, pre, live.table).map((row) => ({ ...row, team: shortName(row.team) }));
  const previous = seasons.includes(season - 1) ? await fetchedReport(reportUrl(season - 1)).catch(() => null) : null;
  return previous ? scorecardLastSeason(rows, previous) : rows;
}

async function renderScorecard(report, body) {
  const slug = report.league.slug;
  body.replaceChildren(el('p', 'explore-empty', t('scorecard.loading')));
  const allSeasons = report.league.seasons || [];
  const firstXg = XG_FIRST_SEASON[slug] || 2020;
  const seasons = allSeasons.filter((season) => season >= firstXg);
  const settled = await Promise.all(seasons.map((season) => scorecardSeason(season, slug, allSeasons).catch(() => [])));
  if (state.activeView !== 'model' || accuracyLeague() !== slug) return;
  const rows = settled.flat();
  if (!rows.length) {
    body.replaceChildren(el('p', 'explore-empty', t('scorecard.empty')));
    return;
  }
  const wrap = el('div', 'scorecard');
  const layout = el('div', 'scorecard__layout');
  const plotWrap = el('div', 'scorecard__plot');
  const svg = svgEl('svg', { class: 'chart', role: 'group', 'aria-label': t('scorecard.aria') });
  plotWrap.appendChild(svg);
  const side = el('div', 'scorecard__side');
  layout.append(plotWrap, side);
  wrap.appendChild(layout);
  body.replaceChildren(wrap);
  const places = Math.max(...rows.map((row) => row.finished), 16);
  const box = wrap.getBoundingClientRect().width || 600;
  const size = Math.min(600, Math.round(box));
  const pad = { top: 18, right: 14, bottom: 40, left: 40 };
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  const cellW = (size - pad.left - pad.right) / places;
  const cellH = (size - pad.top - pad.bottom) / places;
  const x = (place) => pad.left + (place - 0.5) * cellW;
  const y = (place) => pad.top + (place - 0.5) * cellH;
  const text = (className, content, attrs, parent = svg) => {
    const node = svgEl('text', { class: className, ...attrs });
    node.textContent = content;
    parent.appendChild(node);
  };
  // Within two places of the call: the band the hit rate counts, cell by cell.
  let band = '';
  for (let called = 1; called <= places; called += 1) {
    for (let finished = Math.max(1, called - 2); finished <= Math.min(places, called + 2); finished += 1) {
      band += `M${x(called) - cellW / 2 - 0.3},${y(finished) - cellH / 2 - 0.3}h${cellW + 0.6}v${cellH + 0.6}h${-cellW - 0.6}Z`;
    }
  }
  svg.appendChild(svgEl('path', { class: 'scorecard__band', d: band }));
  for (let place = 1; place <= places; place += 1) {
    if (place !== 1 && place % (places > 12 ? 3 : 2) !== 1 && place !== places) continue;
    text('tick', `${place}.`, { x: x(place), y: size - pad.bottom + 14, 'text-anchor': 'middle' });
    text('tick', `${place}.`, { x: pad.left - 6, y: y(place) + 3.5, 'text-anchor': 'end' });
  }
  svg.appendChild(svgEl('line', { class: 'scorecard__diagonal', x1: x(0.5), y1: y(0.5), x2: x(places + 0.5), y2: y(places + 0.5) }));
  text('axis-title', t('scorecard.x'), { x: size - pad.right, y: size - 6, 'text-anchor': 'end' });
  text('axis-title', t('scorecard.y'), { x: pad.left, y: pad.top - 6 });

  // Every club-season, one circle a cell, sized by how many land there.
  const cells = new Map();
  for (const row of rows) {
    const id = `${row.called}:${row.finished}`;
    cells.set(id, [...(cells.get(id) || []), row]);
  }
  const most = Math.max(...[...cells.values()].map((list) => list.length));
  const reach = 0.46 * Math.min(cellW, cellH);
  for (const list of cells.values()) {
    const [{ called, finished, miss }] = list;
    const dot = svgEl('circle', {
      class: `scorecard__dot${Math.abs(miss) <= 2 ? '' : ' scorecard__dot--miss'}`,
      cx: x(called), cy: y(finished), r: Math.max(3.5, reach * Math.sqrt(list.length / most)), tabindex: 0,
    });
    const head = t('scorecard.cellTip', { called: ordinalShort(called), finished: ordinalShort(finished) });
    const clubs = [...list].sort((a, b) => b.season - a.season).map((row) => `${row.team} ${row.season}`).join(', ');
    dot.setAttribute('aria-label', `${head}: ${clubs}`);
    attachTip(dot, `<b>${head}</b><br>${esc(clubs)}`);
    svg.appendChild(dot);
  }

  const bySeason = new Map();
  for (const row of rows) bySeason.set(row.season, [...(bySeason.get(row.season) || []), row]);
  const rates = [...bySeason].sort(([a], [b]) => a - b).map(([season, list]) => ({
    season, list, hits: scorecardHits(list), n: list.length,
    last: list.every((row) => row.lastMiss != null) ? scorecardHits(list, 'lastMiss') : null,
  }));

  // One season picked out: its clubs by name, the rest faded.
  const focus = svgEl('g', { class: 'scorecard__focus' });
  svg.appendChild(focus);
  const strip = el('div', 'scorecard__seasons');
  const note = el('p', 'explore-note scorecard__note');
  let picked = null;
  const pick = (rate) => {
    picked = picked === rate ? null : rate;
    svg.classList.toggle('scorecard--focus', !!picked);
    focus.replaceChildren();
    for (const button of strip.children) button.setAttribute('aria-pressed', String(button.dataset.season === String(picked && picked.season)));
    if (!picked) {
      note.textContent = t('scorecard.pick');
      return;
    }
    for (const row of picked.list) {
      const dot = svgEl('circle', {
        class: `scorecard__pick${Math.abs(row.miss) <= 2 ? '' : ' scorecard__pick--miss'}`,
        cx: x(row.called), cy: y(row.finished), r: 5,
      });
      attachTip(dot, t('scorecard.tip', {
        team: row.team, season: row.season, called: ordinalShort(row.called), expected: num(row.expected, 1), finished: ordinalShort(row.finished),
      }));
      focus.appendChild(dot);
      const left = row.called > places - 4;
      text('scorecard__label', row.team, { x: x(row.called) + (left ? -9 : 9), y: y(row.finished) + 3.5, 'text-anchor': left ? 'end' : 'start' }, focus);
    }
    note.textContent = picked.last == null
      ? t('scorecard.seasonFirst', { season: picked.season, hits: picked.hits, n: picked.n })
      : t('scorecard.season', { season: picked.season, hits: picked.hits, n: picked.n, last: picked.last });
  };
  for (const rate of rates) {
    const button = el('button', 'scorecard__season');
    button.type = 'button';
    button.dataset.season = rate.season;
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', rate.last == null
      ? t('scorecard.seasonFirst', { season: rate.season, hits: rate.hits, n: rate.n })
      : t('scorecard.season', { season: rate.season, hits: rate.hits, n: rate.n, last: rate.last }));
    button.appendChild(el('b', null, String(rate.season)));
    const bar = el('span', 'scorecard__season-bar');
    const fill = el('i');
    fill.style.width = `${(100 * rate.hits) / rate.n}%`;
    bar.appendChild(fill);
    if (rate.last != null) {
      const tick = el('i', 'scorecard__season-last');
      tick.style.left = `${(100 * rate.last) / rate.n}%`;
      bar.appendChild(tick);
    }
    button.appendChild(bar);
    button.appendChild(el('span', null, `${rate.hits}/${rate.n}`));
    button.addEventListener('click', () => pick(rate));
    strip.appendChild(button);
  }
  const legend = el('div', 'scorecard__legend');
  const addKey = (cls, labelKey) => {
    const item = el('span', 'scorecard__legend-item');
    item.append(el('i', `scorecard__swatch ${cls}`), t(labelKey));
    legend.appendChild(item);
  };
  addKey('scorecard__swatch--band', 'scorecard.legend.band');
  addKey('scorecard__swatch--diag', 'scorecard.legend.exact');
  addKey('scorecard__swatch--last', 'scorecard.legend.last');
  side.appendChild(strip);
  side.appendChild(legend);
  side.appendChild(note);
  pick(null);

  const best = [...rates].sort((a, b) => b.hits / b.n - a.hits / a.n || b.season - a.season)[0];
  const worst = [...rates].sort((a, b) => a.hits / a.n - b.hits / b.n || b.season - a.season)[0];
  const ranked = [...rows].sort((a, b) => a.miss - b.miss || (a.finished - a.expected) - (b.finished - b.expected));
  const [over, under] = [ranked[0], ranked[ranked.length - 1]];
  const hits = scorecardHits(rows);
  const meanMiss = (list, field) => list.reduce((sum, row) => sum + Math.abs(row[field]), 0) / list.length;
  // Last season's table against the model in the same seasons: every one but the first in the build.
  const compared = rates.filter((rate) => rate.last != null);
  const both = compared.flatMap((rate) => rate.list);
  const moved = (row) => t('scorecard.fact.movedText', {
    season: row.season, called: ordinalShort(row.called), expected: num(row.expected, 1), finished: ordinalShort(row.finished),
  });
  const facts = [
    { value: pct(hits / rows.length, 0), label: t('scorecard.fact.hits'), text: t('scorecard.fact.hitsText', { hits, n: rows.length, seasons: rates.length }) },
  ];
  if (both.length) {
    facts.push({
      value: pct(scorecardHits(both, 'lastMiss') / both.length, 0),
      label: t('scorecard.fact.last'),
      text: t('scorecard.fact.lastText', {
        hits: scorecardHits(both, 'lastMiss'), n: both.length, from: compared[0].season, to: compared[compared.length - 1].season,
        model: pct(scorecardHits(both) / both.length, 0),
      }),
    });
  }
  facts.push(
    {
      value: num(meanMiss(rows, 'miss'), 1),
      label: t('scorecard.fact.miss'),
      text: both.length
        ? `${t('scorecard.fact.missText')} ${t('scorecard.fact.missLast', { model: num(meanMiss(both, 'miss'), 1), last: num(meanMiss(both, 'lastMiss'), 1) })}`
        : t('scorecard.fact.missText'),
    },
    { value: `${best.season}: ${best.hits}/${best.n}`, label: t('scorecard.fact.best'), text: t('scorecard.fact.bestText', { season: worst.season, hits: worst.hits, n: worst.n }) },
    { value: over.team, label: t('scorecard.fact.over'), text: moved(over) },
    { value: under.team, label: t('scorecard.fact.under'), text: moved(under) },
  );
  wrap.appendChild(exploreFacts(facts));
}

/* Match by match: the calibration of the odds. */

/* Written by build_site from a walk-forward backtest (research.calibration_payload):
   the shipped odds for every match since 2016 against what happened, and
   against the bookmakers' closing line on the matches it prices. */
let calibrationData = null;
function loadCalibration() {
  calibrationData = calibrationData || fetch('/data/calibration.json')
    .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
    .catch((error) => { calibrationData = null; throw error; });
  return calibrationData;
}

/* The bins at or above `from` pooled into one: how many predictions, their
   mean chance and how often they came true. */
function calibrationPool(bins, from) {
  const top = bins.filter((bin) => bin.lo >= from - 1e-9);
  const n = top.reduce((sum, bin) => sum + bin.n, 0);
  if (!n) return null;
  return {
    n,
    predicted: top.reduce((sum, bin) => sum + bin.predicted * bin.n, 0) / n,
    observed: top.reduce((sum, bin) => sum + bin.observed * bin.n, 0) / n,
  };
}

/* The 95 % Wilson interval of a rate seen in n trials: the bin's error bar,
   which stays inside 0-1 and is honest at the thin ends where a plain
   normal interval is not. */
function calibrationInterval(rate, n, z = 1.96) {
  const z2 = (z * z) / n;
  const centre = (rate + z2 / 2) / (1 + z2);
  const half = (z / (1 + z2)) * Math.sqrt(rate * (1 - rate) / n + z2 / (4 * n));
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const CALIBRATION_SERIES = [
  ['home_win', 'next.homeWin', 'var(--home)'],
  ['draw', 'next.draw', 'var(--draw)'],
  ['away_win', 'next.awayWin', 'var(--away)'],
];
// A bin with fewer predictions than this is left out: its rate says nothing.
const CALIBRATION_MIN_N = 50;

/* One panel's axis range, the same on both axes so the diagonal stays the
   line of perfect calibration: every kept bin's chance, rate and interval
   (the band), out to the next 10 %. */
function calibrationRange(bins) {
  const values = bins.flatMap((bin) => [bin.predicted, ...calibrationInterval(bin.observed, bin.n)]);
  return [Math.max(0, Math.floor(Math.min(...values) * 10 + 1e-9) / 10),
    Math.min(1, Math.ceil(Math.max(...values) * 10 - 1e-9) / 10)];
}

/* One outcome's reliability diagram, zoomed to its own range: the bins as
   dots sized by count, joined in order, over a band through their 95 %
   intervals. */
function calibrationPanel(bins, labelKey, colour, biggest) {
  const panel = el('figure', 'calibration__panel');
  const title = el('figcaption', 'calibration__panel-title');
  const swatch = el('i', 'calibration__swatch');
  swatch.style.background = colour;
  title.append(swatch, t(labelKey));
  panel.appendChild(title);
  const svg = svgEl('svg', { class: 'chart', role: 'group', 'aria-label': `${t(labelKey)}: ${t('calib.aria')}` });
  panel.appendChild(svg);
  const size = 300;
  const pad = { top: 18, right: 10, bottom: 36, left: 38 };
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  const [lo, hi] = calibrationRange(bins);
  const x = (p) => pad.left + ((p - lo) / (hi - lo)) * (size - pad.left - pad.right);
  const y = (p) => size - pad.bottom - ((p - lo) / (hi - lo)) * (size - pad.top - pad.bottom);
  const text = (className, content, attrs) => {
    const node = svgEl('text', { class: className, ...attrs });
    node.textContent = content;
    svg.appendChild(node);
  };
  const step = hi - lo > 0.5 ? 2 : 1;
  for (let tenth = Math.round(lo * 10); tenth <= Math.round(hi * 10); tenth += step) {
    const p = tenth / 10;
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: x(p), x2: x(p), y1: y(lo), y2: y(hi) }));
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: x(lo), x2: x(hi), y1: y(p), y2: y(p) }));
    const label = `${num(p * 100)}${percentSign()}`; // pct() would print 0 as a dash
    text('tick', label, { x: x(p), y: y(lo) + 14, 'text-anchor': 'middle' });
    text('tick', label, { x: x(lo) - 5, y: y(p) + 3.5, 'text-anchor': 'end' });
  }
  svg.appendChild(svgEl('line', { class: 'calibration__diagonal', x1: x(lo), y1: y(lo), x2: x(hi), y2: y(hi) }));
  text('axis-title', t('calib.x'), { x: x(hi), y: size - 4, 'text-anchor': 'end' });
  text('axis-title', t('calib.y'), { x: x(lo), y: pad.top - 6 });
  if (bins.length > 1) {
    // The band: the intervals' lows left to right, their highs back.
    const intervals = bins.map((bin) => calibrationInterval(bin.observed, bin.n));
    const lows = bins.map((bin, i) => `${x(bin.predicted)},${y(intervals[i][0])}`);
    const highs = bins.map((bin, i) => `${x(bin.predicted)},${y(intervals[i][1])}`).reverse();
    svg.appendChild(svgEl('polygon', {
      class: 'calibration__band', points: [...lows, ...highs].join(' '), style: `fill: ${colour}`,
    }));
    svg.appendChild(svgEl('polyline', {
      class: 'calibration__line',
      points: bins.map((bin) => `${x(bin.predicted)},${y(bin.observed)}`).join(' '),
      style: `stroke: ${colour}`,
    }));
  }
  bins.forEach((bin) => {
    const [low, high] = calibrationInterval(bin.observed, bin.n);
    const dot = svgEl('circle', {
      class: 'calibration__dot', cx: x(bin.predicted), cy: y(bin.observed),
      r: 2.5 + 4 * Math.sqrt(bin.n / biggest), style: `fill: ${colour}`, tabindex: 0,
    });
    const tip = t('calib.tip', {
      outcome: t(labelKey), lo: pct(bin.lo, 0), hi: pct(bin.hi, 0), n: num(bin.n),
      predicted: pct(bin.predicted, 1), observed: pct(bin.observed, 1), low: pct(low, 0), high: pct(high, 0),
    });
    dot.setAttribute('aria-label', tip);
    attachTip(dot, tip);
    svg.appendChild(dot);
  });
  return panel;
}

async function renderCalibration(report, body) {
  body.replaceChildren(el('p', 'explore-empty', t('calib.loading')));
  let data;
  try {
    data = await loadCalibration();
  } catch {
    body.replaceChildren(el('p', 'explore-empty', t('calib.empty')));
    return;
  }
  if (state.activeView !== 'model') return;
  const wrap = el('div', 'calibration');
  body.replaceChildren(wrap);

  // One panel per outcome; the bins too thin to say anything are left out.
  const kept = CALIBRATION_SERIES.map(([key]) => data.reliability[key].filter((bin) => bin.n >= CALIBRATION_MIN_N));
  const dropped = CALIBRATION_SERIES.reduce((sum, [key]) => sum + data.reliability[key]
    .filter((bin) => bin.n < CALIBRATION_MIN_N).reduce((total, bin) => total + bin.n, 0), 0);
  const biggest = Math.max(...kept.flat().map((bin) => bin.n));
  const panels = el('div', 'calibration__panels');
  CALIBRATION_SERIES.forEach(([, labelKey, colour], i) => {
    if (kept[i].length) panels.appendChild(calibrationPanel(kept[i], labelKey, colour, biggest));
  });
  wrap.appendChild(el('p', 'explore-note calibration__guide', t('calib.guide')));
  wrap.appendChild(panels);
  wrap.appendChild(el('p', 'explore-note calibration__note', t('calib.note', { n: CALIBRATION_MIN_N, dropped: num(dropped) })));

  if (data.market) {
    const tableWrap = el('div', 'calibration__table-wrap');
    const table = el('table', 'calibration__table');
    const hasBase = data.market.base_rate_log_loss != null;
    const head = el('tr');
    const cols = ['', ...(hasBase ? [t('calib.skill')] : []), t('calib.ll'), t('calib.brier'), t('calib.rps')];
    for (const label of cols) head.appendChild(el('th', '', label));
    table.appendChild(head);
    for (const [key, labelKey] of [['model', 'calib.model'], ['elo', 'calib.elo'], ['proportional', 'calib.proportional'], ['power', 'calib.power'], ['shin', 'calib.shin']]) {
      const row = data.market[key];
      if (!row) continue;
      const cls = [
        key === 'model' ? 'calibration__ours' : '',
        key === 'proportional' ? 'calibration__market-start' : '',
      ].filter(Boolean).join(' ');
      const tr = el('tr', cls);
      tr.appendChild(el('th', '', t(labelKey)));
      if (hasBase) {
        tr.appendChild(el('td', '', `${num(versionSkill(row.log_loss, data.market.base_rate_log_loss), 1)}${percentSign()}`));
      }
      for (const metric of ['log_loss', 'brier', 'rps']) tr.appendChild(el('td', '', num(row[metric], 4)));
      table.appendChild(tr);
    }
    const caption = el('caption', '', t('calib.tableCaption', { n: num(data.market.model.n), from: data.market.first_season }));
    table.prepend(caption);
    tableWrap.appendChild(table);
    tableWrap.appendChild(el('p', 'explore-note calibration__glossary', t('calib.glossary')));
    wrap.appendChild(tableWrap);
  }
  wrap.appendChild(exploreFacts(calibrationFacts(data)));
  const staking = calibrationStakingFacts(data);
  if (staking.length) {
    const box = exploreFacts(staking);
    box.classList.add('calibration__staking');
    box.querySelector('.explore-facts__title').textContent = t('calib.stakingTitle');
    wrap.appendChild(box);
  }
}

function calibrationFacts(data) {
  const all = data.scores.all;
  const esFrom = data.first_seasons?.eliteserien || data.first_season;
  const obosFrom = data.first_seasons?.obosligaen || 2023;
  const facts = [{
    value: pct(all.calibration, 1),
    label: t('calib.fact.error'),
    text: t('calib.fact.errorText', {
      n: num(all.n), esFrom, obosFrom, to: data.last_season,
    }),
  }];
  const favourites = calibrationPool(data.reliability.all, 0.7);
  if (favourites) {
    facts.push({
      value: `${pct(favourites.predicted, 0)} → ${pct(favourites.observed, 0)}`,
      label: t('calib.fact.favourites'),
      text: t('calib.fact.favouritesText', { n: num(favourites.n) }),
    });
  }
  const market = data.market;
  if (market && market.power) {
    facts.push({
      value: signed(market.model.log_loss - market.power.log_loss, 3),
      label: t('calib.fact.market'),
      text: t('calib.fact.marketText', { n: num(market.model.n), from: market.first_season, t: num(market.power.paired_t, 1) }),
    });
  }
  return facts;
}

function calibrationStakingFacts(data) {
  const facts = [];
  const signedPct = (value) => `${signed(value * 100, 1)}${percentSign()}`;
  // A bankroll can end above where it started: pct() stops at 100 %.
  const bankroll = (value) => `${num(value * 100, 0)}${percentSign()}`;
  // What one unit on each bet returned, edges of 3-15 % against the bigger ones.
  const bands = (block) => (block.bands
    ? t('calib.fact.kellyBands', { small: signedPct(block.bands.small.flat_roi), large: signedPct(block.bands.large.flat_roi) })
    : '');
  if (data.kelly && data.kelly.bets) {
    // The bankroll, not the return per stake: Kelly staking can earn on what
    // was staked and still lose the pot.
    const kelly = data.kelly;
    facts.push({
      value: `${signed((kelly.bankroll - 1) * 100, 0)}${percentSign()}`,
      label: t('calib.fact.kelly'),
      text: t('calib.fact.kellyText', {
        from: kelly.first_season, bets: num(kelly.bets), roi: signedPct(kelly.roi),
        end: bankroll(kelly.bankroll), drawdown: pct(kelly.max_drawdown, 0),
      }) + (kelly.flat_roi != null
        ? t('calib.fact.kellyFlat', { flat: signedPct(kelly.flat_roi) })
        : '') + bands(kelly) + (kelly.pinnacle_share != null
        ? t('calib.fact.kellyBooks', { pinnacle: pct(kelly.pinnacle_share, 0) })
        : ''),
    });
  }
  const nt = data.norsk_tipping;
  if (nt && nt.bets) {
    facts.push({
      value: `${signed((nt.bankroll - 1) * 100, 0)}${percentSign()}`,
      label: t('calib.fact.nt'),
      text: t('calib.fact.ntText', {
        margin: pct(nt.margin, 1), pinnacle: pct(nt.pinnacle_margin, 1), n: num(nt.n),
        bets: num(nt.bets), roi: signedPct(nt.roi), end: bankroll(nt.bankroll),
      }) + bands(nt),
    });
  }
  return facts;
}


/* Over the model versions: every release's odds on the same matches. */

/* How much better than guessing from base rates (how often home, draw and
   away happen), in %: 1 - log loss / the base rates' log loss. */
function versionSkill(logLoss, base) {
  return 100 * (1 - logLoss / base);
}

/* "elo-v12.0" -> "v12", "elo-v11.1" -> "v11.1": the axis label. */
function versionShort(version) {
  return version.replace(/^elo-/, '').replace(/\.0$/, '');
}

function renderVersionHistory(report, body, data) {
  const history = data && data.versions;
  if (!history || !history.versions || history.versions.length < 2 || history.base_rate_log_loss_xg == null) {
    body.replaceChildren(el('p', 'explore-empty', t('versions.empty')));
    return;
  }
  // 100 % xG seasons: both divisions (Eliteserien 2020–2025 + OBOS-ligaen 2023–2025)
  // and Eliteserien's xG seasons (2020–2025) against the bookmakers' closing odds.
  const baseXg = history.base_rate_log_loss_xg;
  const baseEsXg = history.base_rate_log_loss_eliteserien_xg;
  const hasEsXg = baseEsXg != null;
  const rows = history.versions.map((row, i) => {
    const prev = i > 0 ? history.versions[i - 1] : null;
    const deltaXg = row.vs_previous_xg ?? (prev ? row.log_loss_xg - prev.log_loss_xg : null);
    return {
      ...row,
      xgAll: versionSkill(row.log_loss_xg, baseXg),
      xgEs: hasEsXg ? versionSkill(row.log_loss_eliteserien_xg, baseEsXg) : null,
      deltaXg,
      tXg: row.t_vs_previous_xg ?? null,
    };
  });
  const series = [
    { key: 'xgAll', label: t('versions.xgAll'), short: t('versions.xgAllShort'), colour: 'var(--versions-all)' },
    ...(hasEsXg ? [{ key: 'xgEs', label: t('versions.xg'), short: t('versions.xgShort'), colour: 'var(--versions-xg)' }] : []),
  ];
  const marketXg = hasEsXg && history.market_log_loss_eliteserien_xg != null ? {
    value: versionSkill(history.market_log_loss_eliteserien_xg, baseEsXg),
    label: t('versions.marketXg'),
    short: t('versions.marketXgShort'),
    colour: 'var(--versions-xg)',
  } : null;

  const wrap = el('div', 'versions');
  const legend = el('div', 'versions__legend');
  for (const { label, colour } of series) {
    const item = el('span', 'versions__key');
    const swatch = el('i', 'versions__swatch');
    swatch.style.background = colour;
    item.append(swatch, label);
    legend.appendChild(item);
  }
  if (marketXg) {
    const item = el('span', 'versions__key');
    const swatch = el('i', 'versions__swatch versions__swatch--market');
    swatch.style.setProperty('--swatch', marketXg.colour);
    item.append(swatch, marketXg.label);
    legend.appendChild(item);
  }
  wrap.appendChild(legend);
  const svg = svgEl('svg', { class: 'chart', role: 'group', 'aria-label': t('versions.aria') });
  wrap.appendChild(svg);
  const readout = el('div', 'versions__readout');
  readout.setAttribute('aria-live', 'polite');
  wrap.appendChild(readout);
  body.replaceChildren(wrap);

  const box = wrap.getBoundingClientRect().width || 720;
  const width = Math.min(760, Math.round(box));
  const narrow = width < 520;
  const height = narrow ? 250 : 290;
  const pad = { top: 14, right: narrow ? 44 : 156, bottom: 40, left: 40 };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const values = rows.flatMap((row) => series.map(({ key }) => row[key])).concat(marketXg ? [marketXg.value] : []);
  const top = Math.ceil(Math.max(...values) + 0.5);
  const bottom = Math.min(0, Math.floor(Math.min(...values)));
  const step = (width - pad.left - pad.right) / (rows.length - 1);
  const x = (i) => pad.left + i * step;
  const y = (v) => pad.top + ((top - v) / (top - bottom)) * (height - pad.top - pad.bottom);
  const text = (className, content, attrs) => {
    const node = svgEl('text', { class: className, ...attrs });
    node.textContent = content;
    svg.appendChild(node);
    return node;
  };
  for (let v = bottom; v <= top; v += 1) {
    svg.appendChild(svgEl('line', { class: v ? 'grid-line' : 'axis-line', x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }));
    text('tick', `${num(v)}${percentSign()}`, { x: pad.left - 6, y: y(v) + 3.5, 'text-anchor': 'end' });
  }
  rows.forEach((row, i) => {
    if (narrow && i % 2 && i !== rows.length - 1) return;
    text('tick', versionShort(row.version), { x: x(i), y: height - pad.bottom + 15, 'text-anchor': 'middle' });
  });
  text('axis-title', t('versions.y'), { x: pad.left, y: pad.top - 3 });
  text('axis-title', t('versions.x'), { x: width - pad.right, y: height - 4, 'text-anchor': 'end' });

  if (marketXg) {
    svg.appendChild(svgEl('line', {
      class: 'versions__market', x1: pad.left, x2: width - pad.right, y1: y(marketXg.value), y2: y(marketXg.value), style: `stroke: ${marketXg.colour}`,
    }));
  }
  const guide = svgEl('line', { class: 'versions__guide', y1: pad.top, y2: height - pad.bottom, x1: 0, x2: 0 });
  svg.appendChild(guide);
  for (const { key, colour } of series) {
    svg.appendChild(svgEl('polyline', {
      class: 'versions__line', points: rows.map((row, i) => `${x(i)},${y(row[key])}`).join(' '), style: `stroke: ${colour}`,
    }));
    rows.forEach((row, i) => {
      svg.appendChild(svgEl('circle', { class: 'versions__dot', cx: x(i), cy: y(row[key]), r: 4, style: `fill: ${colour}` }));
    });
  }
  const activeDots = series.map(({ colour }) => svgEl('circle', {
    class: 'versions__active', r: 6.5, fill: 'none', stroke: colour, 'stroke-width': 2,
  }, svg));
  const ends = series.map(({ key, short }) => ({ label: short, v: rows[rows.length - 1][key] }));
  if (marketXg) ends.push({ label: marketXg.short, v: marketXg.value });
  const placed = ends.map((end) => ({ ...end, at: y(end.v) })).sort((a, b) => a.at - b.at);
  for (let i = 1; i < placed.length; i += 1) placed[i].at = Math.max(placed[i].at, placed[i - 1].at + 15);
  if (!narrow) {
    for (const end of placed) {
      text('versions__label', `${end.label} ${num(end.v, 1)}${percentSign()}`, { x: width - pad.right + 8, y: end.at + 4 });
    }
  }

  const date = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(localeDate(), { day: 'numeric', month: 'short', year: 'numeric' });
  const showReadout = (i) => {
    const row = rows[i];
    const previous = rows[i - 1];
    guide.setAttribute('x1', x(i));
    guide.setAttribute('x2', x(i));
    guide.classList.add('is-on');
    series.forEach(({ key }, sIdx) => {
      activeDots[sIdx].setAttribute('cx', x(i));
      activeDots[sIdx].setAttribute('cy', y(row[key]));
    });
    const head = el('div', 'versions__readout-head');
    head.appendChild(el('span', 'versions__readout-ver', row.version));
    if (row.released) head.appendChild(el('span', 'versions__readout-date', date(row.released)));
    if (previous && row.deltaXg != null) {
      const stepText = row.tXg != null
        ? t('versions.tipStep', { delta: signed(row.deltaXg, 4), previous: previous.version, t: num(row.tXg, 1) })
        : t('versions.tipStepNoT', { delta: signed(row.deltaXg, 4), previous: previous.version });
      head.appendChild(el('span', 'versions__readout-step', stepText));
    }
    const desc = el('p', 'versions__readout-desc', t(`versions.v.${row.version}`));
    const metrics = el('div', 'versions__readout-metrics');
    metrics.appendChild(el('span', '', t('versions.tipXgAll', { skill: num(row.xgAll, 1), ll: num(row.log_loss_xg, 4) })));
    if (hasEsXg) {
      metrics.appendChild(el('span', '', t('versions.tipXg', { skill: num(row.xgEs, 1), ll: num(row.log_loss_eliteserien_xg, 4) })));
    }
    readout.replaceChildren(head, desc, metrics);
  };

  rows.forEach((row, i) => {
    const hit = svgEl('rect', {
      class: 'versions__hit', x: x(i) - step / 2, y: pad.top, width: step, height: height - pad.top - pad.bottom, tabindex: 0,
    });
    const previous = rows[i - 1];
    const tip = () => [
      `<b>${row.version}</b>${row.released ? ` · ${date(row.released)}` : ''}`,
      t(`versions.v.${row.version}`),
      t('versions.tipXgAll', { skill: num(row.xgAll, 1), ll: num(row.log_loss_xg, 4) }),
      hasEsXg ? t('versions.tipXg', { skill: num(row.xgEs, 1), ll: num(row.log_loss_eliteserien_xg, 4) }) : '',
      previous && row.deltaXg != null
        ? (row.tXg != null
          ? t('versions.tipStep', { delta: signed(row.deltaXg, 4), previous: previous.version, t: num(row.tXg, 1) })
          : t('versions.tipStepNoT', { delta: signed(row.deltaXg, 4), previous: previous.version }))
        : '',
    ].filter(Boolean).join('<br>');
    hit.setAttribute('aria-label', `${row.version}: ${t('versions.tipXgAll', { skill: num(row.xgAll, 1), ll: num(row.log_loss_xg, 4) })}`);
    hit.addEventListener('pointerenter', () => showReadout(i));
    hit.addEventListener('focus', () => showReadout(i));
    hit.addEventListener('click', () => showReadout(i));
    attachTip(hit, tip);
    svg.appendChild(hit);
  });
  showReadout(rows.length - 1);

  wrap.appendChild(el('p', 'explore-note versions__note', t('versions.note', {
    n: num(history.n_xg), nEs: num(history.n_eliteserien_xg), from: history.first_season_eliteserien_xg || 2020,
    obosFrom: history.first_season_obos_xg || 2023, to: history.last_season,
  })));

  const first = rows[0];
  const last = rows[rows.length - 1];
  const biggest = rows.slice(1).reduce((a, b) => (b.deltaXg < a.deltaXg ? b : a));
  const facts = [{
    value: `${num(first.xgAll, 1)} → ${num(last.xgAll, 1)}${percentSign()}`,
    label: t('versions.fact.xg'),
    text: t('versions.fact.xgText', { n: num(history.n_xg), first: first.version, last: last.version }),
  }];
  if (hasEsXg && marketXg) {
    facts.push({
      value: `${num(last.xgEs, 1)}${percentSign()} vs ${num(marketXg.value, 1)}${percentSign()}`,
      label: t('versions.fact.xgMarketTitle'),
      text: t('versions.fact.xgMarket', {
        n: num(history.n_eliteserien_xg), last: last.version,
        model: num(last.xgEs, 1), market: num(marketXg.value, 1),
      }),
    });
    if (first.log_loss_eliteserien_xg > history.market_log_loss_eliteserien_xg) {
      const closed = (first.log_loss_eliteserien_xg - last.log_loss_eliteserien_xg)
        / (first.log_loss_eliteserien_xg - history.market_log_loss_eliteserien_xg);
      facts.push({
        value: pct(closed, 0),
        label: t('versions.fact.gap'),
        text: t('versions.fact.gapText', {
          n: num(history.n_eliteserien_xg), first: first.version, last: last.version,
          market: num(marketXg.value, 1), from: num(first.xgEs, 1), to: num(last.xgEs, 1),
        }),
      });
    }
  }
  facts.push({
    value: biggest.version,
    label: t('versions.fact.step'),
    text: biggest.tXg != null
      ? t('versions.fact.stepText', {
        what: t(`versions.v.${biggest.version}`), delta: signed(biggest.deltaXg, 4), t: num(biggest.tXg, 1),
      })
      : t('versions.fact.stepTextNoT', {
        what: t(`versions.v.${biggest.version}`), delta: signed(biggest.deltaXg, 4),
      }),
  });
  wrap.appendChild(exploreFacts(facts));
}

if (typeof module !== 'undefined') {
  module.exports = {
    scorecardRows, scorecardLastSeason, scorecardHits,
    calibrationPool, calibrationInterval, calibrationRange,
    versionSkill, versionShort,
  };
}
