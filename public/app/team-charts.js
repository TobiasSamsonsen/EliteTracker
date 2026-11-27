/* Club view charts: rating history, performance vs expectation, season-by-season & season shape. */

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

/* ---------- team history: performance against expectation ------------- */

/* performance.json: every scored match's rating change and the change the
   model expected before kickoff (pipeline.performance_payload), fetched the
   first time a club's history is opened. */
let performancePromise = null;
function fetchPerformance() {
  if (!performancePromise) {
    performancePromise = fetch('/data/performance.json')
      .then((response) => {
        if (!response.ok) throw new Error(`/data/performance.json ${response.status}`);
        return response.json();
      })
      .catch((error) => {
        console.warn('[Performance] performance.json unavailable', error);
        performancePromise = null;
        return { leagues: [], teams: {}, matches: [] };
      });
  }
  return performancePromise;
}

const PERF_WINDOW = 5;
const PERF_SEASONS = 3;

/* One club's matches, oldest first, from its side: performance = rating
   change - expected change, and the trailing PERF_WINDOW-match average
   (over its whole history, so the first match shown already has one). */
function teamPerformanceRows(data, teamId, { asof = null } = {}) {
  const id = String(teamId);
  const name = (tid) => {
    const raw = data?.teams?.[tid] || String(tid);
    return typeof shortName === 'function' ? shortName(raw) : raw;
  };
  const rows = [];
  for (const m of data?.matches || []) {
    const [date, season, league, homeId, awayId, hg, ag, change, expected] = m;
    if (asof && date > asof) continue;
    const isHome = String(homeId) === id;
    if (!isHome && String(awayId) !== id) continue;
    const sign = isHome ? 1 : -1;
    rows.push({
      date, season, league: data.leagues?.[league] || 'eliteserien', isHome,
      opponent: name(isHome ? awayId : homeId),
      gf: isHome ? hg : ag, ga: isHome ? ag : hg,
      change: sign * change, expected: sign * expected, perf: sign * (change - expected),
    });
  }
  let sum = 0;
  rows.forEach((row, i) => {
    sum += row.perf;
    if (i >= PERF_WINDOW) sum -= rows[i - PERF_WINDOW].perf;
    row.avg = i >= PERF_WINDOW - 1 ? sum / PERF_WINDOW : null;
  });
  return rows;
}

let teamPerfToken = 0;
async function renderTeamPerformanceHistory(teamId, content, report) {
  const token = ++teamPerfToken;
  const section = el('div', 'team-section team-perf');
  section.appendChild(el('div', 'label', t('team.perf.title')));
  const body = el('div', 'team-perf__body');
  body.appendChild(el('p', 'team-section__hint', t('team.perf.loading')));
  section.appendChild(body);
  content.appendChild(section);

  const data = await fetchPerformance();
  if (token !== teamPerfToken || state.activeView !== 'team' || state.teamTab !== 'history' || String(state.teamFocusId) !== String(teamId)) return;
  const all = teamPerformanceRows(data, teamId, { asof: report.league.asof || null });
  const seasonNow = Number(report.league.season);
  const seasons = [...new Set(all.map((r) => r.season))].filter((s) => s <= seasonNow).slice(-PERF_SEASONS);
  const rows = all.filter((r) => seasons.includes(r.season));
  if (rows.length < 2) {
    section.remove();
    return;
  }
  body.replaceChildren();
  body.appendChild(el('p', 'team-section__hint', t('team.perf.hint')));

  // Three numbers first: the recent run, this season, the one before.
  const stats = el('div', 'team-perf__stats');
  const stat = (label, values) => {
    if (!values.length) return;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const item = el('div', 'team-perf__stat');
    item.appendChild(el('span', 'label', label));
    item.appendChild(el('strong', `team-perf__value ${mean >= 0 ? 'ref-pos' : 'ref-neg'}`, signed(mean, 1)));
    item.appendChild(el('span', 'team-perf__sub', t('team.perf.perMatch', { n: values.length })));
    stats.appendChild(item);
  };
  stat(t('team.perf.last', { n: PERF_WINDOW }), rows.slice(-PERF_WINDOW).map((r) => r.perf));
  const last = seasons[seasons.length - 1];
  stat(t('team.perf.season', { season: last }), rows.filter((r) => r.season === last).map((r) => r.perf));
  if (seasons.length >= 2) {
    const prev = seasons[seasons.length - 2];
    stat(t('team.perf.season', { season: prev }), rows.filter((r) => r.season === prev).map((r) => r.perf));
  }
  body.appendChild(stats);

  const legend = el('div', 'ref-legend');
  legend.innerHTML = `<span class="ref-legend__item"><i class="team-perf__swatch team-perf__swatch--bar"></i>${esc(t('team.perf.legendMatch'))}</span>`
    + `<span class="ref-legend__item"><i class="team-perf__swatch team-perf__swatch--line"></i>${esc(t('team.perf.legendAvg', { n: PERF_WINDOW }))}</span>`;
  body.appendChild(legend);
  drawTeamPerformance(body, rows);
}

function drawTeamPerformance(wrap, rows) {
  const svg = svgEl('svg', { class: 'chart team-perf__chart', role: 'group', 'aria-label': t('team.perf.aria', { n: PERF_WINDOW }) });
  wrap.appendChild(svg);
  const box = wrap.getBoundingClientRect().width || 940;
  const narrow = box < SHAPE_NARROW;
  const width = narrow ? Math.round(box) : 940;
  const height = narrow ? 210 : 240;
  const pad = { top: 22, right: 10, bottom: 14, left: narrow ? 30 : 36 };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  // The scale follows the average, so the line reads; a single match beyond
  // it is cut at the edge (its tooltip has the number).
  const avgs = rows.map((r) => r.avg).filter((v) => v != null);
  const bars = rows.map((r) => Math.abs(r.perf)).sort((a, b) => a - b);
  const p80 = bars[Math.floor(bars.length * 0.8)] || 1;
  const want = Math.max(p80, ...avgs.map((v) => Math.abs(v) * 1.4), 2);
  const step = refNiceStep(want / 2);
  const reach = Math.ceil(want / step) * step;
  const bottom = height - pad.bottom;
  const right = width - pad.right;
  const y = (v) => pad.top + ((reach - Math.max(-reach, Math.min(reach, v))) / (2 * reach)) * (bottom - pad.top);
  const slot = (right - pad.left) / rows.length;
  const xAt = (i) => pad.left + (i + 0.5) * slot;

  for (let v = -reach; v <= reach + 1e-9; v += step) {
    const r = Math.abs(v) < 1e-9 ? 0 : v;
    svg.appendChild(svgEl('line', { class: r ? 'grid-line' : 'axis-line', x1: pad.left, x2: right, y1: y(r), y2: y(r) }));
    svg.appendChild(svgEl('text', { class: 'tick', x: pad.left - 5, y: y(r) + 3.5, 'text-anchor': 'end' })).textContent = r === 0 ? '0' : signed(r, step % 1 ? 1 : 0);
  }

  // Season dividers, each season named over its first match.
  rows.forEach((row, i) => {
    if (i && row.season === rows[i - 1].season) return;
    const x = pad.left + i * slot;
    if (i) svg.appendChild(svgEl('line', { class: 'team-perf__season', x1: x, x2: x, y1: pad.top - 14, y2: bottom }));
    const label = row.league === 'obosligaen' ? `${row.season} · OBOS` : String(row.season);
    svg.appendChild(svgEl('text', { class: 'tick team-perf__season-label', x: x + 4, y: pad.top - 8 })).textContent = label;
  });

  const barWidth = Math.max(1.5, Math.min(7, slot * 0.6));
  rows.forEach((row, i) => {
    const [a, b] = [y(0), y(row.perf)];
    svg.appendChild(svgEl('rect', {
      class: `team-perf__bar ${row.perf >= 0 ? 'team-perf__bar--up' : 'team-perf__bar--down'}`,
      x: xAt(i) - barWidth / 2, y: Math.min(a, b), width: barWidth, height: Math.max(1, Math.abs(b - a)), rx: Math.min(1.5, barWidth / 2),
    }));
  });

  // The average, broken where it has no value yet.
  let path = '';
  rows.forEach((row, i) => {
    if (row.avg == null) return;
    path += `${path && rows[i - 1]?.avg != null ? 'L' : 'M'}${xAt(i).toFixed(1)},${y(row.avg).toFixed(1)}`;
  });
  if (path) svg.appendChild(svgEl('path', { class: 'team-perf__line', d: path }));

  // One hit strip per match.
  rows.forEach((row, i) => {
    const hit = svgEl('rect', { class: 'team-perf__hit', x: pad.left + i * slot, y: pad.top, width: slot, height: bottom - pad.top, tabindex: i === rows.length - 1 ? 0 : -1 });
    const where = `${row.isHome ? t('referees.drawer.homeTag') : t('referees.drawer.awayTag')} ${row.opponent} ${row.gf}–${row.ga}`;
    const main = t('team.perf.tip', { change: signed(row.change, 1), expected: signed(row.expected, 1), perf: signed(row.perf, 1) });
    const avg = row.avg != null ? t('team.perf.tipAvg', { n: PERF_WINDOW, v: signed(row.avg, 1) }) : '';
    hit.setAttribute('aria-label', `${row.date} ${where}: ${main}${avg ? `. ${avg}` : ''}`);
    attachTip(hit, `<b>${esc(row.date)}</b> ${esc(where)}<br>${main}${avg ? `<br><span class="tooltip__muted">${avg}</span>` : ''}`);
    svg.appendChild(hit);
  });
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
  // A club that has only played in one division needs no tag on every row.
  list.classList.toggle('is-one-division', new Set(seasonsDesc.map((record) => record.league)).size === 1);
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
  mainCell.appendChild(el('div', 'season-row-compact__pos', rankText(record.position)));
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
    // Along the foot of the plot, where an axis reads, and clear of the line
    // when it climbs into the top corner.
    const label = svgEl('text', { class: 'season-label', x: x(start) + 3, y: pad.top + plotHeight + 12 });
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

  const axis = svgEl('text', { class: 'axis-title', x: pad.left, y: height - 3 });
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
    showTooltip(event, `<b>${esc(career.team)}</b><br>${when}<br>${t('chart.rating', { n: points[index][1] })}`);
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

const SHAPE_NARROW = 640;
/* Below this the chart is a phone's: a shorter plot and larger position numbers. */
const SHAPE_COMPACT = 460;
let lastShape = null;

/* Season-shape fills: a gradient down the places, the best the brightest, the
   same ramp as the finish grid and the season mountain. */
function positionColor(position, count) {
  const step = seqColor(count > 1 ? (count - position) / (count - 1) : 1);
  // Sixteen places on a seven-stop ramp differ by a few percent each; every
  // other one a little lighter keeps 1st and 2nd, 2nd and 3rd, apart.
  return position % 2 === 0 ? `color-mix(in oklab, ${step}, white 9%)` : step;
}

function drawTeamShape(report, team, chart, boxWidth) {
  const history = report.history;
  const count = report.table.length;
  const snapshots = history.dates.length;

  const cumulative = history.dates.map((_, index) => {
    const running = [0];
    for (let position = 0; position < count; position += 1) {
      running.push(running[position] + team.positions[index][position]);
    }
    return running;
  });

  const box = boxWidth || 900;
  const narrow = box < SHAPE_NARROW;
  const compact = box < SHAPE_COMPACT;
  const width = narrow ? Math.round(box) : 900;
  // A phone's plot has the box's whole width now, so it needs less height to read.
  const height = compact ? 270 : 310;
  // The desktop gutter (40/12 of 900) is a sixth of a phone's 340px box. The
  // narrow box trims it so the bands start where the rating chart's line does
  // above it; the "100%" tick hangs left into the section's own padding.
  const pad = narrow
    ? { top: 10, right: 6, bottom: 30, left: 20 }
    : { top: 10, right: 12, bottom: 30, left: 40 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  lastShape = { report, team, chart, narrow, compact };

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

  for (let gridline = 0; gridline <= 4; gridline += 1) {
    const value = gridline / 4;
    chart.appendChild(
      svgEl('line', { class: 'grid-line', x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value) })
    );
    const label = svgEl('text', { class: 'tick', x: pad.left - 6, y: y(value) + 3, 'text-anchor': 'end' });
    label.textContent = `${100 - gridline * 100 / 4}${percentSign()}`;
    chart.appendChild(label);
  }

  // A place the club never has 2 % of the season is not one it can realistically
  // finish in. Those at the top and at the bottom are not drawn one sliver at a
  // time: each end is one neutral band, so the colours and numbers belong to
  // the places the club is actually in play for.
  const REACHABLE = 0.02;
  const reachable = [];
  for (let position = 1; position <= count; position += 1) {
    if (Math.max(...team.positions.map((snapshot) => snapshot[position - 1])) >= REACHABLE) reachable.push(position);
  }
  const firstReach = reachable.length ? reachable[0] : 1;
  const lastReach = reachable.length ? reachable[reachable.length - 1] : count;
  const groups = [];
  if (firstReach > 1) groups.push({ from: 1, to: firstReach - 1, rest: true });
  for (let position = firstReach; position <= lastReach; position += 1) groups.push({ from: position, to: position });
  if (lastReach < count) groups.push({ from: lastReach + 1, to: count, rest: true });
  const groupText = (group) => (group.from === group.to
    ? ordinalShort(group.from)
    : `${ordinalShort(group.from)}\u2013${ordinalShort(group.to)}`);

  for (const group of groups) {
    const upper = [];
    const lower = [];
    for (let index = 0; index < snapshots; index += 1) {
      upper.push(`${x(index)},${y(cumulative[index][group.from - 1])}`);
      lower.push(`${x(index)},${y(cumulative[index][group.to])}`);
    }
    const band = svgEl('polygon', {
      class: `band${group.rest ? ' band--rest' : ''}`,
      points: [...upper, ...lower.reverse()].join(' '),
    });
    band.style.fill = group.rest ? 'color-mix(in srgb, var(--ink-faint) 20%, var(--panel))' : positionColor(group.from, count);

    const single = group.from === group.to;
    const bandLabel = single ? bandFor(report.league.bands, group.from) : null;
    const name = single ? ordinal(group.from) : groupText(group);
    const now = () => {
      let sum = 0;
      for (let position = group.from; position <= group.to; position += 1) sum += team.positions[snapshots - 1][position - 1];
      return sum;
    };
    const tip = () => `<b>${esc(name)}</b>${bandLabel ? ` \u00b7 ${bandName(bandLabel)}` : ''}<br>` + t('shape.now', { pct: pct(now(), 1) });
    band.setAttribute('role', 'img');
    band.setAttribute('aria-label', `${name}${bandLabel ? `, ${bandName(bandLabel)}` : ''}`);
    band.addEventListener('pointerenter', (event) => showTooltip(event, tip()));
    band.addEventListener('pointermove', moveTooltip);
    band.addEventListener('pointerleave', hideTooltip);
    band.addEventListener('focus', () => {
      const rect = band.getBoundingClientRect();
      showTooltip({ clientX: rect.left + rect.width / 2, clientY: rect.top }, tip(), band);
    });
    band.addEventListener('blur', hideTooltip);
    band.setAttribute('tabindex', '0');
    chart.appendChild(band);
  }

  chart.appendChild(
    svgEl('line', { class: 'axis-line', x1: pad.left, x2: width - pad.right, y1: y(1), y2: y(1) })
  );

  // Position numbers inside the bands, so the reader can name a band. Each goes where its whole text box lies
  // inside its own band: every spot along the plot is tried, the band's upper
  // and lower edge read across the text's width (the edges are straight
  // between snapshots), and the spot with the most room left over wins, the
  // numeral centred in that room. A band that nowhere holds the box is left to
  // the tooltip. Ink flips with the ramp step as heatTextClass does for the
  // grid's cells.
  const fontSize = compact ? 8.5 : 8;
  const boxHeight = fontSize + 3;
  const spacing = plotWidth / (snapshots - 1 || 1);
  const edgeAt = (series, px) => {
    const at = Math.min(Math.max((px - pad.left) / spacing, 0), snapshots - 1);
    const low = Math.floor(at);
    const high = Math.min(snapshots - 1, low + 1);
    return series[low] + (series[high] - series[low]) * (at - low);
  };
  for (const group of groups) {
    const upper = cumulative.map((run) => y(run[group.from - 1]));
    const lower = cumulative.map((run) => y(run[group.to]));
    const text = groupText(group);
    const boxWidth = text.length * fontSize * 0.62 + 3;
    let best = null;
    // Centres every half snapshot, with the box kept inside the plot.
    for (let px = pad.left + boxWidth / 2; px <= pad.left + plotWidth - boxWidth / 2; px += spacing / 2) {
      const left = px - boxWidth / 2;
      const right = px + boxWidth / 2;
      let top = Math.max(edgeAt(upper, left), edgeAt(upper, right));
      let bottom = Math.min(edgeAt(lower, left), edgeAt(lower, right));
      for (let index = Math.ceil((left - pad.left) / spacing); index <= Math.floor((right - pad.left) / spacing); index += 1) {
        top = Math.max(top, upper[index]);
        bottom = Math.min(bottom, lower[index]);
      }
      const room = bottom - top;
      if (!best || room > best.room) best = { px, room, middle: (top + bottom) / 2 };
    }
    if (!best || best.room < boxHeight) continue;
    const step = group.rest ? 0 : Math.round(((count - group.from) / (count - 1)) * (SEQ_STEPS - 1)) + 1;
    const label = svgEl('text', {
      class: `band-pos${step >= 5 ? ' band-pos--invert' : ''}`,
      x: best.px,
      y: best.middle,
      'text-anchor': 'middle',
    });
    label.style.fontSize = `${fontSize}px`;
    label.textContent = text;
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
      `<b>${esc(team.team)}</b> · ${played === 0 ? t('shape.preseason') : when}<br>` +
        `${t('shape.rating', { n: team.ratings[index] })} · ${t('shape.mostLikely', { n: ordinal(best + 1) })} (${pct(probabilities[best])})<br>` +
        `${top ? `${t('shape.topN', { n: top.last, pct: pct(sum(top)) })} · ` : ''}${t('shape.bottomN', { n: count - (relegation ? relegation.first - 1 : count), pct: pct(sum(relegation)) })}`
    );
  });
  surface.addEventListener('pointerleave', () => {
    line.style.opacity = '0';
    hideTooltip();
  });
  chart.appendChild(surface);
}

if (typeof module !== 'undefined') {
  module.exports = { PERF_WINDOW, teamPerformanceRows };
}
