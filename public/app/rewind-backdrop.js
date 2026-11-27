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
  // Folded away on the current season, where the live page is what most
  // come for; open on a past one, which is mostly visited to look back
  // through. Decided when the season changes, then left to the reader.
  const season = report.league.season;
  if (state.timelineSeason !== season) {
    state.timelineSeason = season;
    setTimelineOpen(season !== report.league.current_season);
  }
  // A rewound page always shows its slider, so the way back stays in reach.
  if (!live) setTimelineOpen(true);
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

/* The rewind panel shows only when its button in the card's heading has
   opened it (or the season, or a rewound page, has: renderTimeline). */
function setTimelineOpen(open) {
  $('#timeline').classList.toggle('is-open', open);
  $('#timeline-toggle').setAttribute('aria-expanded', String(open));
}

/* The rewind lives in the open view's card: the panel under its heading,
   its button among the heading's tools. Hidden, both, on a view that does
   not follow it or a season with nothing to rewind through. */
function placeTimeline(shown) {
  const timeline = $('#timeline');
  const toggle = $('#timeline-toggle');
  const head = document.querySelector(`[data-section="${state.activeView}"] .panel > .panel__head`);
  const tools = head?.querySelector('.panel__tools');
  if (shown && tools) {
    // Before the heading's share button, which stays last.
    if (toggle.parentElement !== tools) tools.insertBefore(toggle, tools.querySelector(':scope > .share-btn'));
    if (timeline.previousElementSibling !== head) head.after(timeline);
  }
  timeline.hidden = !(shown && tools);
  toggle.hidden = timeline.hidden;
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
  // The reader's own rewinds; boot replaying a shared ?asof= link is not one.
  if (booted) track('rewind', { asof: asof || 'live' });
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

/* ---------- backdrop ----------------------------------------------- */

/* The season mountain's contour map, behind the whole page. The mountain
   (Explore) stacks a block for every snapshot in which a club still had a
   chance of a place, places across and clubs deep in finishing order, so its
   height field is square: per club and place, how many snapshots kept that
   place open. Drawn from the season in view, so every year has its own;
   tools/brand/contours.py draws the same for the share image. */
const BACKDROP = { samples: 140, levels: 12, sigma: 3.5, cut: 0.005, pad: 2 };
let backdropKey = '';

function backdropField(history) {
  const teams = history.teams;
  const last = teams[0].positions.length - 1;
  const expected = (team) => team.positions[last].reduce((sum, p, place) => sum + p * (place + 1), 0);
  const rows = [...teams].sort((a, b) => expected(a) - expected(b))
    .map((team) => team.positions[0].map((_, place) =>
      team.positions.reduce((count, snapshot) => count + (snapshot[place] >= BACKDROP.cut ? 1 : 0), 0)));
  // Open ground around it, so every line closes around the mountain.
  const n = rows.length + 2 * BACKDROP.pad;
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
    rows[i - BACKDROP.pad]?.[j - BACKDROP.pad] ?? 0));
}

/* Bilinear resampling onto size x size, then a Gaussian blur. */
function backdropSmooth(grid, size, sigma) {
  const n = grid.length;
  const out = Array.from({ length: size }, (_, i) => {
    const y = (i * (n - 1)) / (size - 1);
    const y0 = Math.min(n - 2, Math.floor(y));
    const fy = y - y0;
    return Float64Array.from({ length: size }, (_, j) => {
      const x = (j * (n - 1)) / (size - 1);
      const x0 = Math.min(n - 2, Math.floor(x));
      const fx = x - x0;
      return grid[y0][x0] * (1 - fy) * (1 - fx) + grid[y0][x0 + 1] * (1 - fy) * fx
        + grid[y0 + 1][x0] * fy * (1 - fx) + grid[y0 + 1][x0 + 1] * fy * fx;
    });
  });
  const radius = Math.ceil(3 * sigma);
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, k) => Math.exp(-0.5 * ((k - radius) / sigma) ** 2));
  const total = kernel.reduce((a, b) => a + b, 0);
  const at = (i) => (i < 0 ? -i - 1 : i >= size ? 2 * size - i - 1 : i); // reflect at the edges
  const pass = (get) => Array.from({ length: size }, (_, i) => Float64Array.from({ length: size }, (_, j) =>
    kernel.reduce((sum, w, k) => sum + w * get(i, j + k - radius), 0) / total));
  const across = pass((i, j) => out[i][at(j)]);
  const down = pass((i, j) => across[at(j)][i]);
  return down.map((_, i) => Float64Array.from({ length: size }, (_, j) => down[j][i]));
}

/* Marching squares at one level: polylines in sample units. */
function backdropContour(values, level) {
  const size = values.length;
  const segments = [];
  const cross = (x1, y1, v1, x2, y2, v2) => {
    const t = v2 === v1 ? 0.5 : (level - v1) / (v2 - v1);
    return [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
  };
  for (let i = 0; i < size - 1; i += 1) {
    for (let j = 0; j < size - 1; j += 1) {
      const tl = values[i][j];
      const tr = values[i][j + 1];
      const br = values[i + 1][j + 1];
      const bl = values[i + 1][j];
      const index = (tl >= level ? 8 : 0) | (tr >= level ? 4 : 0) | (br >= level ? 2 : 0) | (bl >= level ? 1 : 0);
      if (index === 0 || index === 15) continue;
      // Edges are keyed so neighbouring cells name a shared edge alike.
      const edge = {
        t: [`h${i},${j}`, cross(j, i, tl, j + 1, i, tr)],
        r: [`v${i},${j + 1}`, cross(j + 1, i, tr, j + 1, i + 1, br)],
        b: [`h${i + 1},${j}`, cross(j, i + 1, bl, j + 1, i + 1, br)],
        l: [`v${i},${j}`, cross(j, i, tl, j, i + 1, bl)],
      };
      const centre = (tl + tr + br + bl) / 4 >= level;
      const pairs = {
        1: ['lb'], 2: ['br'], 3: ['lr'], 4: ['tr'], 6: ['tb'], 7: ['tl'],
        8: ['tl'], 9: ['tb'], 11: ['tr'], 12: ['lr'], 13: ['br'], 14: ['lb'],
        5: centre ? ['tr', 'lb'] : ['tl', 'br'],
        10: centre ? ['tl', 'br'] : ['tr', 'lb'],
      }[index];
      for (const [a, b] of pairs) segments.push([edge[a], edge[b]]);
    }
  }
  // Join the segments through their shared edges.
  const byEdge = new Map();
  segments.forEach(([a, b], k) => {
    for (const [key] of [a, b]) byEdge.set(key, [...(byEdge.get(key) || []), k]);
  });
  const used = new Set();
  const lines = [];
  segments.forEach((first, k) => {
    if (used.has(k)) return;
    used.add(k);
    const line = [...first];
    for (const forward of [true, false]) {
      for (;;) {
        const end = forward ? line[line.length - 1] : line[0];
        const next = (byEdge.get(end[0]) || []).find((n) => !used.has(n));
        if (next === undefined) break;
        used.add(next);
        const [p, q] = segments[next];
        const step = p[0] === end[0] ? q : p;
        if (forward) line.push(step); else line.unshift(step);
      }
    }
    lines.push(line.map(([, point]) => point));
  });
  return lines;
}

/* A contour as a smooth curve: thin the marching-squares points (Ramer-
   Douglas-Peucker), then run a Catmull-Rom spline through what is left,
   written as cubic Beziers, so no corner of the sampling grid shows at any
   size. */
function backdropCurve(points) {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const length = Math.hypot(bx - ax, by - ay);
    let far = -1;
    let most = 0.12; // in samples
    for (let k = a + 1; k < b; k += 1) {
      const [x, y] = points[k];
      // A closed loop starts and ends on one point: measure from it.
      const off = length
        ? Math.abs((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / length
        : Math.hypot(x - ax, y - ay);
      if (off > most) { most = off; far = k; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  const pts = points.filter((_, k) => keep[k]);
  const closed = pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6;
  const at = (k) => {
    if (closed) return pts[((k % (pts.length - 1)) + (pts.length - 1)) % (pts.length - 1)];
    return pts[Math.max(0, Math.min(pts.length - 1, k))];
  };
  const f = (v) => v.toFixed(2);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let k = 0; k < pts.length - 1; k += 1) {
    const [x0, y0] = at(k - 1);
    const [x1, y1] = at(k);
    const [x2, y2] = at(k + 1);
    const [x3, y3] = at(k + 2);
    d += `C${f(x1 + (x2 - x0) / 6)} ${f(y1 + (y2 - y0) / 6)} ${f(x2 - (x3 - x1) / 6)} ${f(y2 - (y3 - y1) / 6)} ${f(x2)} ${f(y2)}`;
  }
  return closed ? `${d}Z` : d;
}

function renderBackdrop(report) {
  const svg = $('#backdrop');
  const history = report.history;
  if (!svg) return;
  if (!history?.teams?.length || !history.teams[0].positions?.length) {
    backdropKey = '';
    svg.replaceChildren();
    return;
  }
  // The rewind hands a report per date, each with its season so far.
  const key = `${report.league.slug}|${report.league.season}|${history.dates?.length}|${history.dates?.[history.dates.length - 1]}`;
  if (key === backdropKey) return;
  backdropKey = key;
  const { samples, levels, sigma } = BACKDROP;
  const values = backdropSmooth(backdropField(history), samples, sigma);
  let lo = Infinity;
  let hi = -Infinity;
  for (const row of values) for (const v of row) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const backdropLines = [];
  for (let k = 1; k <= levels; k += 1) {
    const level = lo + ((hi - lo) * k) / (levels + 1);
    for (const line of backdropContour(values, level)) {
      if (line.length < 4) continue;
      backdropLines.push(backdropCurve(line));
    }
  }
  svg.setAttribute('viewBox', `0 0 ${samples - 1} ${samples - 1}`);
  svg.replaceChildren(...backdropLines.map((d) => svgEl('path', { d })));
}

if (typeof module !== 'undefined') {
  module.exports = { matchdayIndex };
}
