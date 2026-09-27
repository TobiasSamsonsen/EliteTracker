/* Season-for-season smoke test: boots the real page in jsdom and drives the
   team view (chart overlays, date axis, picker, cache, state). Dev only --
   needs jsdom:  npm i jsdom  then  node tests/season-shape.dom.js */
/* Smoke test for the season-for-season view: boots the real page in jsdom
   with local-file fetch, then drives the team view end to end. */
const { JSDOM, ResourceLoader, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  if (!/Could not parse CSS|Not implemented/.test(String(e.message))) console.error('JSDOM:', e.message);
});
vc.on('error', (...a) => console.error('PAGE ERR:', ...a));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dom = await JSDOM.fromFile(path.join(ROOT, 'index.html'), {
    url: 'http://localhost:8000/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.matchMedia = (q) => ({
        matches: false, media: q, onchange: null,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {},
      });
      window.scrollTo = () => {};
      window.Element.prototype.scrollIntoView = function () {};
      window.__fetches = [];
      window.fetch = (u) => {
        window.__fetches.push(String(u));
        return new Promise((resolve) => {
          const rel = String(u).split('?')[0].replace(/^\//, '');
          fs.readFile(path.join(ROOT, rel), (err, buf) => resolve({
            ok: !err,
            status: err ? 404 : 200,
            json: async () => JSON.parse(buf.toString()),
            text: async () => buf.toString(),
          }));
        });
      };
    },
  });
  const w = dom.window;
  const ev = (code) => w.eval(code);

  // Subresources are not loaded by default; run the app's own scripts as
  // inline classic scripts so their top-level bindings are shared with eval.
  for (const file of ['i18n.js', 'app.js']) {
    const script = w.document.createElement('script');
    script.textContent = fs.readFileSync(path.join(ROOT, file), 'utf8');
    w.document.head.appendChild(script);
  }

  for (let i = 0; i < 120; i++) {
    if (ev("!!(state && state.reports && state.careers && !document.getElementById('content').hidden)")) break;
    await sleep(50);
  }
  check('boot: reports + careers loaded',
    ev("!!(state && state.reports && state.careers && state.reports[state.league])"));

  const pick = JSON.parse(ev(`(() => {
    const slug = state.reports[state.league].league.slug;
    const t = state.careers.teams
      .filter((t) => t.seasons[t.seasons.length - 1].league === slug)
      .sort((a, b) => b.seasons.length - a.seasons.length)[0];
    return JSON.stringify({ id: t.team_id, name: t.team, seasons: t.seasons.length });
  })()`));
  console.log(`team: ${pick.name} (${pick.id}), ${pick.seasons} seasons`);
  check('team has >8 seasons (paging exercisable)', pick.seasons > 8);

  ev(`openTeamView(${pick.id}, ${JSON.stringify(pick.name)}, { push: false })`);
  await sleep(300);

  check('season section rendered', ev("!!document.querySelector('#team-content .team-seasons')"));
  check('hint sits under the heading, not in the chart box', ev(`(() => {
    const hint = document.querySelector('.team-seasons > .team-section__hint');
    const box = document.getElementById('team-shape-container');
    return !!hint && !!box && !box.contains(hint);
  })()`));
  check('chart rendered', ev("!!document.querySelector('#team-shape-container svg.chart')"));

  const overlays = JSON.parse(ev(`(() => {
    const svg = document.querySelector('#team-shape-container svg.chart');
    const verticals = [...svg.querySelectorAll('line.grid-line')]
      .filter((l) => l.getAttribute('x1') === l.getAttribute('x2')).length;
    const horizontals = [...svg.querySelectorAll('line.grid-line')]
      .filter((l) => l.getAttribute('y1') === l.getAttribute('y2')).length;
    return JSON.stringify({
      viewBox: svg.getAttribute('viewBox'),
      modeLine: svg.querySelectorAll('polyline.shape-line').length,
      edges: svg.querySelectorAll('polyline.band-edge').length,
      halos: svg.querySelectorAll('polyline.band-edge-halo').length,
      firstY: Number(svg.querySelector('polyline.band-edge').getAttribute('points').split(' ')[0].split(',')[1]),
      labelYs: [...svg.querySelectorAll('text.band-edge-label')].map((t) => Number(t.getAttribute('y'))),
      goodEdges: svg.querySelectorAll('polyline.band-edge--good').length,
      badEdges: svg.querySelectorAll('polyline.band-edge--bad').length,
      edgeLabels: svg.querySelectorAll('text.band-edge-label').length,
      goodLabels: svg.querySelectorAll('text.band-edge-label--good').length,
      badLabels: svg.querySelectorAll('text.band-edge-label--bad').length,
      pos: svg.querySelectorAll('text.band-pos').length,
      posTexts: [...svg.querySelectorAll('text.band-pos')].map((t) => t.textContent),
      posYs: [...svg.querySelectorAll('text.band-pos')].map((t) => Number(t.getAttribute('y'))),
      posXs: [...svg.querySelectorAll('text.band-pos')].map((t) => Number(t.getAttribute('x'))),
      dot: svg.querySelectorAll('circle.shape-dot').length,
      end: (svg.querySelector('text.shape-end') || {}).textContent || '',
      verticals, horizontals,
    });
  })()`));
  // Aalesund's qualification edge never leaves 0.000-0.003: it must be
  // dropped, leaving the relegation edge alone. The end dot/ordinal is gone --
  // the in-band numerals name every band, including the final one.
  check('no mode line or end marker; only the in-play band edge, haloed, labelled',
    overlays.modeLine === 0 && overlays.edges === 1 && overlays.halos === 1 &&
    overlays.goodEdges === 0 && overlays.badEdges === 1 &&
    overlays.edgeLabels === 1 && overlays.goodLabels === 0 && overlays.badLabels === 1 &&
    overlays.dot === 0 && overlays.end === '', JSON.stringify(overlays));
  // pad.top = 10, plotHeight = 240, so the display inset keeps every edge
  // point in [16, 244] and every label in [20, 246] -- a zero-probability
  // line must not sit on the frame or spill below the plot.
  check('edges are haloed and inset off the frame, labels inside the plot',
    overlays.halos === overlays.edges && overlays.firstY >= 16 && overlays.firstY <= 244 &&
    overlays.labelYs.every((v) => v >= 20 && v <= 246), JSON.stringify(overlays));
  // Position numerals: named inside the bands they belong to, never outside,
  // the final band named like any other, and none sitting on a plot edge
  // (pad.left = 40, plotWidth = 848, edge inset = 14).
  check('position numerals sit inside the plot',
    overlays.pos >= 4 && overlays.posYs.every((v) => v >= 14 && v <= 246) &&
    overlays.posXs.every((v) => v >= 54 && v <= 874) &&
    overlays.posTexts.includes('14.') &&
    overlays.posTexts.every((s) => /^\d+\.$/.test(s)), JSON.stringify(overlays.posTexts));
  check('month gridlines dropped, horizontal ticks kept',
    overlays.verticals === 0 && overlays.horizontals === 5, JSON.stringify(overlays));

  const axis = JSON.parse(ev(`(() => {
    const svg = document.querySelector('#team-shape-container svg.chart');
    // The band edges are drawn from the same x() as everything else.
    const pts = svg.querySelector('polyline.band-edge').getAttribute('points')
      .trim().split(' ').map((p) => p.split(',').map(Number));
    const n = pts.length;
    let worst = 0;
    for (let i = 0; i < n; i += 1) {
      const expected = 40 + (i / (n - 1 || 1)) * 848;
      worst = Math.max(worst, Math.abs(pts[i][0] - expected));
    }
    return JSON.stringify({ n, worst });
  })()`));
  check('x axis is evenly spaced per match, not per calendar date',
    axis.n > 2 && axis.worst < 0.5, JSON.stringify(axis));

  const narrowBox = ev(`(() => {
    const svg = document.querySelector('#team-shape-container svg.chart');
    const report = state.reports[state.league];
    const team = report.history.teams.find((t) => String(t.team_id) === String(${pick.id}));
    drawTeamShape(report, team, svg, 400);
    return svg.getAttribute('viewBox');
  })()`);
  check('narrow container gets its own viewBox', narrowBox === '0 0 400 300', narrowBox);
  ev(`(() => {
    const svg = document.querySelector('#team-shape-container svg.chart');
    drawTeamShape(state.reports[state.league],
      state.reports[state.league].history.teams.find((t) => String(t.team_id) === String(${pick.id})),
      svg, 900);
  })()`);

  const list = JSON.parse(ev(`(() => {
    const section = document.querySelector('.team-seasons');
    const rows = [...section.querySelectorAll('.season-row-compact')];
    const pager = section.querySelector('.seasons-pager');
    const listEl = section.querySelector('.seasons-list-compact');
    return JSON.stringify({
      rows: rows.length,
      firstYear: rows[0].dataset.season,
      pagerLast: !!pager && !!(listEl.compareDocumentPosition(pager) & Node.DOCUMENT_POSITION_FOLLOWING),
      pagerLabel: pager ? pager.querySelector('.played-nav__label').textContent : '',
      active: rows.filter((r) => r.classList.contains('is-active')).map((r) => r.dataset.season),
      pressed: rows.filter((r) => r.getAttribute('aria-pressed') === 'true').length,
    });
  })()`));
  check('first page holds 8 rows, newest first',
    list.rows === 8 && list.firstYear === String(ev('state.season')), JSON.stringify(list));
  check('pager sits below the list', list.pagerLast, JSON.stringify(list));
  check('exactly one active row, aria-pressed agrees',
    list.active.length === 1 && list.pressed === 1 &&
    list.active[0] === String(ev('state.season')), JSON.stringify(list));

  // --- pick a past season: async path --------------------------------
  const chartBefore = ev("document.querySelector('#team-shape-container svg.chart')");
  ev("document.querySelectorAll('.season-row-compact')[1].click()");
  await sleep(400);
  const afterPick = JSON.parse(ev(`(() => {
    const box = document.getElementById('team-shape-container');
    return JSON.stringify({
      label: (box.querySelector('.label') || {}).textContent || '',
      state: state.activeSeasonShape,
      active: [...document.querySelectorAll('.season-row-compact.is-active')]
        .map((r) => r.dataset.season),
      loading: box.classList.contains('team-shape--loading'),
    });
  })()`));
  check('past-season pick loads its chart and moves the highlight',
    /2025/.test(afterPick.label) && afterPick.state && String(afterPick.state.season) === '2025' &&
    afterPick.active.length === 1 && afterPick.active[0] === '2025' && !afterPick.loading,
    JSON.stringify(afterPick));

  // --- picking the same past season again must not refetch ------------
  const fetchesBefore = ev("window.__fetches.filter((u) => u.includes('report-2025.json')).length");
  ev("document.querySelectorAll('.season-row-compact')[1].click()");
  await sleep(300);
  const fetchesAfter = ev("window.__fetches.filter((u) => u.includes('report-2025.json')).length");
  check('second pick of the same season is served from cache',
    fetchesAfter === fetchesBefore && fetchesBefore === 1, `${fetchesBefore} -> ${fetchesAfter}`);

  // --- back to the current season (sync path) then re-render ---------
  ev("document.querySelectorAll('.season-row-compact')[0].click()");
  await sleep(100);
  ev(`renderTeamView(state.reports[state.league])`);
  await sleep(300);
  const afterRerender = JSON.parse(ev(`(() => {
    const box = document.getElementById('team-shape-container');
    return JSON.stringify({
      label: (box.querySelector('.label') || {}).textContent || '',
      active: [...document.querySelectorAll('.season-row-compact.is-active')]
        .map((r) => r.dataset.season),
      state: state.activeSeasonShape,
    });
  })()`));
  check('picking the current season sticks across a re-render (state bug)',
    /2026/.test(afterRerender.label) &&
    afterRerender.active[0] === '2026' &&
    String(afterRerender.state.season) === '2026', JSON.stringify(afterRerender));

  // --- page turn: list only, chart untouched -------------------------
  const chartNode = ev("document.querySelector('#team-shape-container svg.chart')");
  w.__chartNode = chartNode;
  // The seasons pager is reversed: the first button walks back in time.
  ev("[...document.querySelectorAll('.seasons-pager .played-nav__btn')][0].click()");
  await sleep(150);
  const paged2 = JSON.parse(ev(`(() => {
    const rows = [...document.querySelectorAll('.season-row-compact')];
    return JSON.stringify({
      rows: rows.map((r) => r.dataset.season),
      label: document.querySelector('.seasons-pager .played-nav__label').textContent,
      sameChart: document.querySelector('#team-shape-container svg.chart') === window.__chartNode,
    });
  })()`));
  check('page turn re-renders the list only (chart node survives)',
    paged2.rows.length === 4 && paged2.rows[0] === '2018' && paged2.sameChart &&
    /2/.test(paged2.label), JSON.stringify(paged2));

  // --- pick a season on page 1, full re-render opens on its page -----
  ev(`[...document.querySelectorAll('.season-row-compact')].find((r) => r.dataset.season === '2016').click()`);
  await sleep(400);
  // Page away first, so opening on the active season's page is observable.
  ev('state.teamSeasonsPage = 0; renderTeamView(state.reports[state.league])');
  await sleep(300);
  const onPage = JSON.parse(ev(`(() => {
    const rows = [...document.querySelectorAll('.season-row-compact')];
    return JSON.stringify({
      label: (document.getElementById('team-shape-container').querySelector('.label') || {}).textContent || '',
      active: [...document.querySelectorAll('.season-row-compact.is-active')].map((r) => r.dataset.season),
      years: rows.map((r) => r.dataset.season),
      pager: document.querySelector('.seasons-pager .played-nav__label').textContent,
    });
  })()`));
  check('re-render opens on the page holding the season on show',
    onPage.years[0] === '2018' && onPage.years.includes('2016') && onPage.active[0] === '2016' &&
    /2016/.test(onPage.label) && /2/.test(onPage.pager), JSON.stringify(onPage));

  // --- stale season from another club falls back --------------------
  ev(`state.activeSeasonShape = { season: 1999, league: 'eliteserien' };
      openTeamView(${pick.id}, ${JSON.stringify(pick.name)}, { push: false })`);
  await sleep(400);
  const fallback = JSON.parse(ev(`(() => {
    const box = document.getElementById('team-shape-container');
    return JSON.stringify({
      text: box.textContent.trim().slice(0, 60),
      hasChart: !!box.querySelector('svg.chart'),
      state: state.activeSeasonShape,
    });
  })()`));
  check('unknown stored season falls back to the current one',
    fallback.hasChart && !/shape data/i.test(fallback.text) &&
    String(fallback.state.season) === '2026', JSON.stringify(fallback));

  // --- Eliteserien's qualification line is the Conference League threshold
  // --- (below the last qualifying place), for clubs in the race for it.
  const contender = JSON.parse(ev(`(() => {
    const report = state.reports[state.league];
    const team = report.history.teams.find((t) => t.team === 'Viking');
    const svg = document.querySelector('#team-shape-container svg.chart');
    drawTeamShape(report, team, svg, 900);
    const edge = report.league.bands.find((b) => b.tone === 'europe');
    return JSON.stringify({
      good: !!svg.querySelector('polyline.band-edge--good'),
      label: (svg.querySelector('text.band-edge-label--good') || {}).textContent || '',
      expected: edge.label,
      belowLast: edge.last,
    });
  })()`));
  check('qualification line sits under the last Conference League place',
    contender.good && contender.label === contender.expected &&
    contender.belowLast === 4, JSON.stringify(contender));

  // --- 2025 splits Europa (3rd) from Conference (4th): the line belongs to
  // --- the lowest European place, not the first europe band found.
  const y2025 = JSON.parse(await ev(`(async () => {
    const report = (await loadSeasonReports(2025)).eliteserien;
    const team = report.history.teams.find((t) => t.team === 'Rosenborg');
    const svg = document.querySelector('#team-shape-container svg.chart');
    drawTeamShape(report, team, svg, 900);
    const eu = report.league.bands.filter((b) => b.tone === 'europe');
    return JSON.stringify({
      bands: eu.map((b) => b.first + '-' + b.last + ' ' + b.label),
      label: (svg.querySelector('text.band-edge-label--good') || {}).textContent || '',
      edges: [...svg.querySelectorAll('polyline.band-edge--good')].length,
    });
  })()`));
  check('2025 shows the Conference League threshold, not Europa League',
    y2025.edges === 1 && /Conference/.test(y2025.label) &&
    !/Europa/.test(y2025.label) && y2025.bands.length === 2,
    JSON.stringify(y2025));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
