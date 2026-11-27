/* ---------- explore: referees (viz=referees) -------------------------- */

let refereesPromise = null;
function fetchReferees() {
  if (state.referees) return Promise.resolve(state.referees);
  if (!refereesPromise) {
    refereesPromise = fetch('/data/referees.json')
      .then((response) => {
        if (!response.ok) throw new Error(`/data/referees.json ${response.status}`);
        return response.json();
      })
      .then((data) => {
        state.referees = { ...data, rows: expandReferees(data) };
        return state.referees;
      })
      .catch((error) => {
        console.warn('[Referees] referees.json unavailable', error);
        return { leagues: ['eliteserien', 'obosligaen'], referees: [], teams: {}, seasons: [], rows: [] };
      });
  }
  return refereesPromise;
}

/* Performance is in rating points: about ±10 a match, a few points a match
   on average over a pairing, tens in total. */
const refPerfDigits = (metric) => (metric === 'perMatch' ? 1 : 0);

/* Expected (hollow) to actual (filled) rating change on a shared ±scale: one
   match at a glance. The bar between them is the performance. */
function refPerfDumbbell(expected, actual, scale, width = 92) {
  const height = 14;
  const svg = svgEl('svg', { class: 'ref-dumbbell', width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' });
  const x = (v) => 5 + ((Math.max(-scale, Math.min(scale, v)) + scale) / (2 * scale)) * (width - 10);
  const up = actual >= expected;
  svg.appendChild(svgEl('line', { class: 'ref-dumbbell__axis', x1: x(0), x2: x(0), y1: 1, y2: height - 1 }));
  svg.appendChild(svgEl('line', {
    class: `ref-dumbbell__bar ${up ? 'ref-dumbbell__bar--up' : 'ref-dumbbell__bar--down'}`,
    x1: x(expected), x2: x(actual), y1: height / 2, y2: height / 2,
  }));
  svg.appendChild(svgEl('circle', { class: 'ref-dumbbell__exp', cx: x(expected), cy: height / 2, r: 3.6 }));
  svg.appendChild(svgEl('circle', { class: `ref-dumbbell__act ${up ? 'ref-dumbbell__act--up' : 'ref-dumbbell__act--down'}`, cx: x(actual), cy: height / 2, r: 3.6 }));
  return svg;
}

/* The measure, explained by two real matches from the selection: a win that
   still scored below zero and a loss that scored above it. */
function refPerfExplainer(rows, teamId = null) {
  const sides = [];
  for (const r of rows || []) {
    for (const home of [true, false]) {
      const id = home ? r.home_id : r.away_id;
      if (teamId != null && String(id) !== String(teamId)) continue;
      const sign = home ? 1 : -1;
      const [gf, ga] = home ? [r.home_goals, r.away_goals] : [r.away_goals, r.home_goals];
      sides.push({
        r, gf, ga, team_id: id,
        change: sign * r.home_change, expected: sign * r.home_expected, perf: home ? r.home_perf : r.away_perf,
        xgf: home ? r.home_xg : r.away_xg, xga: home ? r.away_xg : r.home_xg,
      });
    }
  }
  // Only matches that make the point: a win below zero, a loss above it.
  const lowWin = sides.filter((x) => x.gf > x.ga && x.perf < 0).sort((a, b) => a.perf - b.perf)[0];
  const highLoss = sides.filter((x) => x.gf < x.ga && x.perf > 0 && x.r !== lowWin?.r).sort((a, b) => b.perf - a.perf)[0];

  const box = el('details', 'ref-explain');
  box.open = state.refereeExplainOpen;
  box.addEventListener('toggle', () => { state.refereeExplainOpen = box.open; });
  box.appendChild(el('summary', 'ref-explain__title', t('referees.explain.title')));
  const eq = el('div', 'ref-explain__eq');
  const chip = (cls, label) => {
    const c = el('span', `ref-explain__chip ${cls}`);
    c.append(el('i', 'ref-explain__dot'), label);
    return c;
  };
  eq.append(
    chip('ref-explain__chip--act', t('referees.explain.actual')),
    el('span', 'ref-explain__op', '−'),
    chip('ref-explain__chip--exp', t('referees.explain.expected')),
    el('span', 'ref-explain__op', '='),
    chip('ref-explain__chip--perf', t('referees.explain.perf')),
  );
  box.appendChild(eq);
  box.appendChild(el('p', 'ref-explain__line', t('referees.explain.line')));
  const examples = [[lowWin, 'referees.explain.win'], [highLoss, 'referees.explain.loss']].filter(([x]) => x);
  if (examples.length) {
    const scale = Math.max(5, ...examples.flatMap(([x]) => [Math.abs(x.change), Math.abs(x.expected)]));
    const list = el('div', 'ref-explain__examples');
    for (const [x, key] of examples) {
      const row = el('div', 'ref-explain__example');
      const logo = el('img', 'ref-explain__logo', '');
      logo.src = `/logos/${x.team_id}.webp`;
      logo.alt = '';
      logo.width = 20;
      logo.height = 20;
      const text = el('span', 'ref-explain__text');
      const r = x.r;
      text.append(
        el('strong', '', `${r.home} ${r.home_goals}–${r.away_goals} ${r.away}`),
        el('small', '', [t(key), x.xgf != null ? `xG ${num(x.xgf, 1)}–${num(x.xga, 1)}` : '', r.referee].filter(Boolean).join(' · ')),
      );
      const value = el('span', `ref-explain__value ${x.perf >= 0 ? 'ref-pos' : 'ref-neg'}`, signed(x.perf, 1));
      row.append(logo, text, refPerfDumbbell(x.expected, x.change, scale, 120), value);
      row.title = t('referees.explain.example', { actual: signed(x.change, 1), expected: signed(x.expected, 1) });
      list.appendChild(row);
    }
    box.appendChild(list);
  }
  return box;
}

function drawRefBarChart(wrap, rows, opts) {
  const {
    metric = 'total', kind = 'club', ariaLabel = '', onClickRow, emptyText = '',
    activeKey = null, onRelaxMin = null, chanceSd = 0, baseline = null,
  } = opts;
  if (!rows.length) {
    wrap.appendChild(refereeEmptyWithRelax(emptyText, onRelaxMin));
    return;
  }
  const centreOf = (row) => (baseline == null ? 0 : (metric === 'perMatch' ? baseline : baseline * row.matches));
  const valueOf = (row) => (metric === 'perMatch' ? row.perMatch : row.diff);
  const digits = refPerfDigits(metric);
  const sorted = [...rows].sort((a, b) => valueOf(b) - valueOf(a)
    || (kind === 'club' ? a.team.localeCompare(b.team) : a.referee.localeCompare(b.referee)));

  const svg = svgEl('svg', { class: 'chart', role: 'group', 'aria-label': ariaLabel });
  wrap.appendChild(svg);
  const box = wrap.getBoundingClientRect().width || 940;
  const narrow = box < SHAPE_NARROW;
  const width = narrow ? Math.round(box) : 940;
  const rowHeight = 26;
  const pad = { top: 26, bottom: 36, left: narrow ? 142 : 210, right: 48 };
  const height = pad.top + sorted.length * rowHeight + pad.bottom;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const maxAbs = Math.max(...sorted.map((r) => Math.abs(valueOf(r))), baseline == null ? 0 : Math.abs(baseline), 1);
  const baseStep = refNiceStep(maxAbs / 2);
  const reach = Math.ceil(maxAbs / baseStep) * baseStep;
  const x = (value) => pad.left + ((value + reach) / (2 * reach)) * (width - pad.left - pad.right);
  const text = (className, content, attrs) => {
    const node = svgEl('text', { class: className, ...attrs });
    node.textContent = content;
    svg.appendChild(node);
    return node;
  };
  const step = narrow ? reach : baseStep;
  const tickDigits = step % 1 !== 0 ? 1 : 0;
  for (let v = -reach; v <= reach + 1e-9; v += step) {
    const rounded = Math.abs(v) < 1e-9 ? 0 : v;
    svg.appendChild(svgEl('line', { class: rounded ? 'grid-line' : 'axis-line', x1: x(rounded), x2: x(rounded), y1: pad.top - 6, y2: height - pad.bottom }));
    text('tick', rounded === 0 ? '0' : signed(rounded, tickDigits), { x: x(rounded), y: height - pad.bottom + 14, 'text-anchor': 'middle' });
  }
  text('axis-title', t(metric === 'perMatch' ? 'referees.xPerMatch' : (narrow ? 'referees.xShort' : 'referees.x')), { x: width - pad.right, y: height - 3, 'text-anchor': 'end' });
  text('luck__side', t(narrow ? 'referees.drawbackShort' : 'referees.drawback'), { x: x(-reach), y: pad.top - 10 });
  text('luck__side', t(narrow ? 'referees.benefitShort' : 'referees.benefit'), { x: x(reach), y: pad.top - 10, 'text-anchor': 'end' });
  text('luck__side', t('referees.col.matches'), { x: 18, y: pad.top - 10, 'text-anchor': 'end' });
  if (baseline != null && metric === 'perMatch') {
    const bx = x(Math.max(-reach, Math.min(reach, baseline)));
    svg.appendChild(svgEl('line', { class: 'attack-map__band', x1: bx, x2: bx, y1: pad.top - 4, y2: height - pad.bottom }));
    if (!narrow) {
      const lblX = Math.max(x(-reach) + 95, Math.min(x(reach) - 95, bx));
      text('ref-baseline-label', t('referees.baselineLabel', { v: signed(baseline, 1) }), { x: lblX, y: pad.top - 10, 'text-anchor': 'middle' });
    }
  }
  const clampX = (v) => x(Math.max(-reach, Math.min(reach, v)));

  sorted.forEach((row, i) => {
    const val = valueOf(row);
    const top = pad.top + i * rowHeight;
    const rowKey = kind === 'club' ? String(row.team_id) : row.referee;
    const isActive = activeKey != null && String(activeKey) === rowKey;
    const g = svgEl('g', { class: `luck__row${isActive ? ' ref-bar--active' : ''}`, tabindex: 0, role: 'button' });
    const [a, b] = [x(0), x(val)];
    const centre = centreOf(row);
    const band = refereeChanceBand(chanceSd, row.matches, metric);
    const withinChance = band > 0 && Math.abs(val - centre) <= band;
    g.appendChild(svgEl('rect', {
      class: isActive ? 'ref-bar__highlight' : 'ref-bar__hit',
      x: 0, y: top + 1, width: width - 2, height: rowHeight - 2, rx: 4,
    }));
    if (band > 0) {
      const [lo, hi] = [clampX(centre - band), clampX(centre + band)];
      g.appendChild(svgEl('rect', { class: 'ref-chance', x: lo, y: top + 3, width: Math.max(1, hi - lo), height: rowHeight - 6, rx: 3 }));
    }
    g.appendChild(svgEl('rect', {
      class: `luck__bar ${val >= 0 ? 'luck__bar--up' : 'luck__bar--down'}${withinChance ? ' ref-bar--chance' : ''}`,
      x: Math.min(a, b), y: top + 5, width: Math.max(1, Math.abs(b - a)), height: rowHeight - 10, rx: 3,
    }));
    const countNode = svgEl('text', { class: 'luck__place', x: 18, y: top + 17, 'text-anchor': 'end' });
    countNode.textContent = String(row.matches);
    g.appendChild(countNode);
    const label = kind === 'club' ? row.team : row.referee;
    const displayLabel = narrow && label.length > 13 ? `${label.slice(0, 12)}…` : label;
    if (kind === 'club') {
      g.appendChild(svgEl('image', { href: `/logos/${row.team_id}.webp`, x: 24, y: top + 3, width: 20, height: 20 }));
    }
    const name = svgEl('text', { class: 'luck__name', x: kind === 'club' ? 50 : 26, y: top + 17 });
    name.textContent = displayLabel;
    g.appendChild(name);
    const valueNode = svgEl('text', {
      class: 'luck__value', y: top + 17,
      x: val >= 0 ? b + 5 : b - 5, 'text-anchor': val >= 0 ? 'start' : 'end',
    });
    valueNode.textContent = signed(val, digits);
    g.appendChild(valueNode);

    const cardLine = t('referees.tipCards', {
      yf: row.yellowsFor, rf: row.redsFor, ya: row.yellowsAgainst, ra: row.redsAgainst,
    });
    const foulLine = row.foulsMatches
      ? `<br><span class="tooltip__muted">${t('referees.tipFouls', {
        ff: num(row.foulsFor / row.foulsMatches, 1), fa: num(row.foulsAgainst / row.foulsMatches, 1),
      })}</span>`
      : '';
    const mainLine = t('referees.tip', {
      diff: signed(row.diff, 0), per: signed(row.perMatch, 1), n: row.matches, w: row.wins, d: row.draws, l: row.losses,
    });
    const chanceLine = band > 0
      ? t(withinChance ? 'referees.tipInside' : 'referees.tipOutside', {
        n: row.matches, lo: signed(centre - band, digits), hi: signed(centre + band, digits),
      })
      : '';
    g.setAttribute('aria-label', `${label}: ${mainLine}${chanceLine ? `. ${chanceLine}` : ''}`);
    attachTip(g, `<b>${esc(label)}</b><br>${mainLine}${chanceLine ? `<br>${chanceLine}` : ''}<br><span class="tooltip__muted">${cardLine}</span>${foulLine}`);
    if (onClickRow) {
      g.addEventListener('click', () => { hideTooltip(); onClickRow(row); });
      g.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        hideTooltip();
        onClickRow(row);
      });
    }
    svg.appendChild(g);
  });
  return sorted;
}

function refereeEmptyWithRelax(message, onRelaxMin) {
  const box = el('div', 'ref-empty-wrap');
  box.appendChild(el('p', 'explore-empty', message));
  if (onRelaxMin) {
    const btn = el('button', 'ref-inline-btn', t('referees.showAllBtn'));
    btn.type = 'button';
    btn.addEventListener('click', onRelaxMin);
    box.appendChild(btn);
  }
  return box;
}

function refereeCardPills(yellows, reds) {
  const span = el('span', 'ref-card-pills');
  if (yellows > 0) {
    const y = el('span', 'ref-card-pill ref-card-pill--y', `${yellows}`);
    y.title = t('referees.drawer.yellows');
    span.appendChild(y);
  }
  if (reds > 0) {
    const r = el('span', 'ref-card-pill ref-card-pill--r', `${reds}`);
    r.title = t('referees.drawer.reds');
    span.appendChild(r);
  }
  if (yellows === 0 && reds === 0) span.appendChild(el('span', 'ref-card-pill--none', '0'));
  return span;
}

function renderPairingDrawer(rows, referee, teamId, opts) {
  const { context = 'explore', onClose, onNavigate } = opts;
  const matches = refereePairingMatches(rows, referee, teamId);
  if (!matches.length) return null;

  const teamName = matches[0].team;
  let w = 0, d = 0, l = 0, perf = 0, yf = 0, rf = 0, ya = 0, ra = 0;
  for (const m of matches) {
    if (m.gf > m.ga) w += 1;
    else if (m.gf === m.ga) d += 1;
    else l += 1;
    perf += m.diff;
    yf += m.yf; rf += m.rf; ya += m.ya; ra += m.ra;
  }
  const perM = perf / matches.length;
  const scale = Math.max(5, ...matches.flatMap((m) => [Math.abs(m.change), Math.abs(m.expected)]));

  const drawer = el('div', 'ref-drawer');
  const head = el('div', 'ref-drawer__head');
  const titleWrap = el('div', 'ref-drawer__title');
  const logo = el('img', 'ref-drawer__logo', '');
  logo.src = `/logos/${teamId}.webp`;
  logo.alt = '';
  logo.width = 22;
  logo.height = 22;
  titleWrap.append(logo, el('h4', '', `${teamName} + ${referee}`));
  head.appendChild(titleWrap);

  const actions = el('div', 'ref-drawer__actions');
  if (onNavigate) {
    const navBtn = el('button', 'ref-inline-btn', t(context === 'team' ? 'referees.drawer.openRef' : 'referees.drawer.openClub'));
    navBtn.type = 'button';
    navBtn.addEventListener('click', onNavigate);
    actions.appendChild(navBtn);
  }
  const closeBtn = el('button', 'ref-drawer__close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', t('referees.drawer.close'));
  closeBtn.addEventListener('click', onClose);
  actions.appendChild(closeBtn);
  head.appendChild(actions);
  drawer.appendChild(head);

  const summary = el('div', 'ref-badges ref-drawer__summary');
  summary.appendChild(el('span', 'ref-badge', `${matches.length} ${t('referees.pairings.matches')} · ${w}-${d}-${l}`));
  const diffBadge = el('span', `ref-badge ${perf >= 0 ? 'ref-pos' : 'ref-neg'}`,
    t('referees.drawer.summaryPts', { sum: signed(perf, 0), per: signed(perM, 1) }));
  summary.appendChild(diffBadge);
  summary.appendChild(el('span', 'ref-badge', t('referees.tipCards', { yf, rf, ya, ra })));
  drawer.appendChild(summary);

  const tableWrap = el('div', 'ref-table-wrap ref-drawer__table-wrap');
  const table = el('table', 'ref-table ref-drawer__table');
  const thead = el('thead');
  const hr = el('tr');
  for (const [labelText, isNum] of [
    [t('referees.drawer.colDate'), false],
    [t('referees.drawer.colMatch'), false],
    [t('referees.drawer.colScore'), true],
    [t('referees.drawer.colXg'), true],
    [t('referees.drawer.colDiff'), false],
    [t('referees.drawer.colCardsPair', { team: teamName }), false],
    [t('referees.drawer.colFouls'), true],
  ]) {
    hr.appendChild(el('th', isNum ? 'num' : '', labelText));
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const m of matches) {
    const tr = el('tr');
    tr.appendChild(el('td', 'ref-drawer__date', m.date));
    const matchTd = el('td', 'ref-drawer__match');
    const matchWrap = el('span', 'ref-drawer__match-wrap');
    const oppLogo = el('img', 'ref-drawer__opp-logo', '');
    oppLogo.src = `/logos/${m.opponent_id}.webp`;
    oppLogo.alt = '';
    oppLogo.width = 18;
    oppLogo.height = 18;
    matchWrap.append(
      venueIcon(m.isHome, { className: 'ref-drawer__venue' }),
      el('span', 'ref-drawer__vs-word', t('referees.drawer.vsTag')),
      oppLogo,
      el('span', 'ref-drawer__opp-name', m.opponent),
    );
    matchTd.appendChild(matchWrap);
    tr.appendChild(matchTd);
    tr.appendChild(el('td', 'num', `${m.gf}–${m.ga}`));
    tr.appendChild(el('td', 'num ref-drawer__pts', m.xgf != null ? `${num(m.xgf, 1)}–${num(m.xga, 1)}` : '–'));
    const perfTd = el('td', 'ref-drawer__perf');
    perfTd.title = t('referees.explain.example', { actual: signed(m.change, 1), expected: signed(m.expected, 1) });
    const perfWrap = el('span', 'ref-drawer__perf-wrap');
    perfWrap.append(refPerfDumbbell(m.expected, m.change, scale), el('span', `ref-drawer__perf-val ${m.diff >= 0 ? 'ref-pos' : 'ref-neg'}`, signed(m.diff, 1)));
    perfTd.appendChild(perfWrap);
    tr.appendChild(perfTd);
    // The flex row sits inside the cell: a flex <td> leaves the table and
    // breaks the row's border.
    const cardsTd = el('td');
    const pills = el('span', 'ref-drawer__cards');
    pills.append(refereeCardPills(m.yf, m.rf), el('span', 'ref-drawer__vs', '/'), refereeCardPills(m.ya, m.ra));
    cardsTd.appendChild(pills);
    tr.appendChild(cardsTd);
    tr.appendChild(el('td', 'num', m.ff != null && m.fa != null ? `${m.ff}–${m.fa}` : '–'));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  drawer.appendChild(tableWrap);
  return drawer;
}

function refereeHowBox(defaultOpen) {
  const box = el('details', 'luck-how');
  box.open = defaultOpen;
  box.appendChild(el('summary', 'luck-how__title', t('referees.how.title')));
  const steps = el('ol', 'luck-how__steps');
  for (const key of ['referees.how.expected', 'referees.how.diff', 'referees.how.chance', 'referees.how.discipline', 'referees.how.sample']) {
    const [lead, ...rest] = t(key).split('. ');
    const item = el('li');
    item.append(el('b', null, `${lead}.`), ` ${rest.join('. ')}`);
    steps.appendChild(item);
  }
  box.appendChild(steps);
  return box;
}

function refereeSwitchGroup(label, options, current, onChange) {
  const group = el('div', 'switch ref-switch');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  for (const [value, textLabel] of options) {
    const btn = el('button', '', textLabel);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(current === value));
    btn.addEventListener('click', () => {
      if (current === value) return;
      onChange(value);
    });
    group.appendChild(btn);
  }
  return group;
}

let refereesToken = 0;
async function renderReferees(report, body, opts = {}) {
  const token = ++refereesToken;
  if (!state.referees && !body.querySelector('.referees')) body.replaceChildren(el('p', 'explore-empty', t('referees.loading')));
  const payload = state.referees || await fetchReferees();
  if (token !== refereesToken || state.activeView !== 'explore' || state.exploreItem !== 'referees') return;

  const prevHeight = body.offsetHeight;
  const prevScroll = window.scrollY;
  if (prevHeight > 0) body.style.minHeight = `${prevHeight}px`;

  const wrap = el('div', 'referees');
  body.replaceChildren(wrap);
  hideTooltip();

  try {
    const topbar = el('div', 'ref-topbar');
    const sections = refereeSwitchGroup(
      t('referees.section.label'),
      [
        ['overview', t('referees.section.overview')],
        ['clubs', t('referees.section.clubs')],
        ['pairings', t('referees.section.pairings')],
      ],
      state.refereeSection,
      (val) => { state.refereeSection = val; renderReferees(report, body); },
    );
    sections.classList.add('ref-sections');
    topbar.appendChild(sections);

    const seasons = payload.seasons || [];
    const allSpan = seasons.length >= 2 ? `${seasons[0]}–${seasons[seasons.length - 1]}` : t('referees.scope.all');
    const seasonNow = Number(report.league.season);
    const rightBar = el('div', 'ref-topbar__right');
    if (state.refereeSection === 'overview' && state.refereeScope === 'all') {
      rightBar.appendChild(refereeSwitchGroup(
        t('referees.active.label'),
        [['all', t('referees.active.all')], ['active', t('referees.active.only', { season: seasonNow })]],
        state.refereeActiveOnly ? 'active' : 'all',
        (val) => { state.refereeActiveOnly = (val === 'active'); renderReferees(report, body); },
      ));
    }
    rightBar.appendChild(refereeSwitchGroup(
      t('referees.scope.label'),
      [['all', allSpan], ['season', String(report.league.season)]],
      state.refereeScope,
      (val) => {
        state.refereeScope = val;
        state.refereeMinMatches = val === 'all' ? 5 : 0;
        state.refereePairingTeam = null;
        renderReferees(report, body);
      },
    ));
    topbar.appendChild(rightBar);
    wrap.appendChild(topbar);

    const filtered = refereeFilter(payload.rows, {
      league: report.league.slug,
      season: state.refereeScope === 'season' ? report.league.season : 'all',
      asof: report.league.asof || null,
    });
    if (!filtered.length) {
      if (report.league.slug !== 'eliteserien' && payload.rows.some((r) => r.league === 'eliteserien')) {
        const box = el('div', 'ref-obos-notice');
        box.appendChild(el('p', 'explore-empty', t('referees.obosNotice')));
        const switchBtn = el('button', 'ref-inline-btn', t('referees.switchEliteserien'));
        switchBtn.type = 'button';
        switchBtn.addEventListener('click', () => {
          showDivision('eliteserien');
          render();
        });
        box.appendChild(switchBtn);
        wrap.appendChild(box);
        return;
      }
      wrap.appendChild(el('p', 'explore-empty', t('referees.empty')));
      return;
    }

    const rerender = (subOpts) => renderReferees(report, body, subOpts);
    if (state.refereeSection === 'clubs') {
      renderClubDisciplineSection(report, wrap, filtered, rerender);
      return;
    }
    if (state.refereeSection === 'pairings') {
      renderRefPairingsSection(report, wrap, filtered, rerender);
      return;
    }
    renderRefOverviewSection(report, wrap, filtered, rerender);
  } finally {
    body.style.minHeight = '';
    if (opts.scrollToDrawer) {
      const drawer = wrap.querySelector('.ref-drawer');
      if (drawer) drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (opts.scrollTop) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (Math.abs(window.scrollY - prevScroll) > 2) {
      window.scrollTo({ top: prevScroll, behavior: 'instant' });
    }
  }
}

function refHeroCard(label, value, detail, opts = {}) {
  const { tone = '', onClick = null, club = null } = opts;
  const card = el(onClick ? 'button' : 'div', `ref-hero-card${onClick ? ' ref-hero-card--interactive' : ''}`);
  if (onClick) {
    card.type = 'button';
    card.addEventListener('click', onClick);
  }
  card.appendChild(el('span', 'ref-hero-card__label', label));
  card.appendChild(el('strong', `ref-hero-card__value${tone ? ` ${tone}` : ''}`, value));
  if (club) {
    const clubRow = el('span', 'ref-hero-card__club');
    const logo = el('img', '', '');
    logo.src = `/logos/${club.id}.webp`;
    logo.alt = '';
    logo.width = 20;
    logo.height = 20;
    clubRow.append(logo, el('span', '', club.name));
    card.appendChild(clubRow);
  }
  card.appendChild(el('span', 'ref-hero-card__detail', detail));
  return card;
}

function renderRefOverviewSection(report, wrap, filtered, rerender) {
  const seasonNow = Number(report.league.season);
  const allRefs = refereeOverview(filtered);
  const minFloor = state.refereeScope === 'all' ? 10 : 0;
  const baseRefs = minFloor ? refereeMinFilter(allRefs, minFloor) : allRefs;
  const displayRefs = state.refereeActiveOnly
    ? baseRefs.filter((r) => r.seasonMax >= seasonNow)
    : baseRefs;

  const openRefDossier = (referee) => {
    state.refereeSelected = referee;
    state.refereePairingMode = 'referee';
    state.refereePairingTeam = null;
    state.refereeSection = 'pairings';
    rerender({ scrollTop: true });
  };

  // 1. 3-Card Editorial Hero Strip
  const totalMatches = filtered.length;
  const totalCards = filtered.reduce((s, r) => s + r.home_yellow + r.away_yellow + r.home_red + r.away_red, 0);
  const foulsRows = filtered.filter((r) => r.home_fouls != null && r.away_fouls != null);
  const totalFouls = foulsRows.reduce((s, r) => s + r.home_fouls + r.away_fouls, 0);
  const cardsWithFouls = foulsRows.reduce((s, r) => s + r.home_yellow + r.away_yellow + r.home_red + r.away_red, 0);
  const avgCards = totalMatches ? totalCards / totalMatches : 0;
  const avgFouls = foulsRows.length ? totalFouls / foulsRows.length : null;
  const avgFpc = cardsWithFouls > 0 ? totalFouls / cardsWithFouls : null;
  const awayGapAll = totalMatches
    ? filtered.reduce((s, r) => s + (r.away_yellow + r.away_red) - (r.home_yellow + r.home_red), 0) / totalMatches
    : 0;
  const redStats = redCardImpact(filtered);
  const varStats = state.refereeScope === 'all' ? varEraComparison(filtered) : null;

  const hero = el('div', 'ref-hero-grid');
  hero.appendChild(refHeroCard(
    t('referees.hero.cardsLabel'),
    num(avgCards, 2),
    t('referees.hero.cardsDetail', {
      f: avgFouls != null ? num(avgFouls, 1) : '–',
      fpc: avgFpc != null ? num(avgFpc, 1) : '–',
      n: totalMatches,
    }),
  ));
  if (redStats.received.n > 0) {
    hero.appendChild(refHeroCard(
      t('referees.hero.redSwingLabel'),
      signed(redStats.received.diffPerMatch, 1),
      t('referees.hero.redSwingDetail', {
        pts: num(redStats.received.ptsPerMatch, 2),
        drw: signed(redStats.drawn.diffPerMatch, 1),
        n: redStats.received.n,
      }),
      { tone: redStats.received.diffPerMatch >= 0 ? 'ref-pos' : 'ref-neg' },
    ));
  }
  if (varStats) {
    hero.appendChild(refHeroCard(
      t('referees.hero.varLabel'),
      `${num(varStats.preVar.redMatchPct, 1)} % → ${num(varStats.varEra.redMatchPct, 1)} %`,
      t('referees.hero.varDetail', {
        preR: num(varStats.preVar.redsPerMatch, 2),
        varR: num(varStats.varEra.redsPerMatch, 2),
      }),
    ));
  } else {
    hero.appendChild(refHeroCard(
      t('referees.hero.awayTiltLabel'),
      signed(awayGapAll, 2),
      t('referees.hero.awayTiltDetail', { n: totalMatches }),
    ));
  }
  wrap.appendChild(hero);

  // 2. Style Map (Active vs Earlier seasons)
  const styleSec = el('section', 'ref-subsection');
  const styleHead = el('div', 'ref-section-head');
  const styleTitles = el('div', 'ref-section-head__text');
  styleTitles.appendChild(el('h3', 'ref-section-title', t('referees.style.title')));
  styleTitles.appendChild(el('p', 'explore-note explore-note--lead', t('referees.style.lead')));
  styleHead.appendChild(styleTitles);
  styleSec.appendChild(styleHead);
  wrap.appendChild(styleSec);

  const legend = el('div', 'ref-legend');
  if (state.refereeScope === 'all' && !state.refereeActiveOnly) {
    legend.innerHTML = `<span class="ref-legend__item"><i class="ref-legend__dot ref-legend__dot--active"></i>${esc(t('referees.style.legendActive', { season: seasonNow }))}</span>`
      + `<span class="ref-legend__item"><i class="ref-legend__dot ref-legend__dot--past"></i>${esc(t('referees.style.legendPast'))}</span>`;
  }
  legend.innerHTML += `<span class="ref-legend__item">${esc(t('referees.style.legendSize'))}</span>`;
  styleSec.appendChild(legend);
  drawRefStyleScatter(styleSec, displayRefs, openRefDossier, seasonNow);

  // 3. Visual Referee Ranking Table (replaces separate Away-Home bar chart + plain table)
  const tableSec = el('section', 'ref-subsection');
  tableSec.appendChild(el('h3', 'ref-section-title', t('referees.table.title')));
  tableSec.appendChild(el('p', 'explore-note explore-note--lead', t('referees.table.lead')));
  renderVisualRefTable(tableSec, displayRefs, openRefDossier, seasonNow);
  wrap.appendChild(tableSec);

  // 4. Bottom Editorial Row: Season Trends + Card-Heaviest Matches
  const seasons = state.refereeScope === 'all' ? seasonDisciplineRows(filtered) : [];
  const feisty = feistiestMatches(filtered, 5);
  if (seasons.length >= 2 || feisty.length) {
    const split = el('div', `ref-split-row${seasons.length >= 2 ? '' : ' ref-split-row--single'}`);
    // In the page before drawing: the chart sizes itself to its column.
    wrap.appendChild(split);
    if (seasons.length >= 2) {
      const seasonSec = el('section', 'ref-subsection');
      split.appendChild(seasonSec);
      seasonSec.appendChild(el('h3', 'ref-section-title', t('referees.seasons.title')));
      seasonSec.appendChild(el('p', 'explore-note explore-note--lead', t('referees.seasons.lead')));
      drawSeasonDisciplineChart(seasonSec, seasons);
    }
    if (feisty.length) {
      const feistySec = el('section', 'ref-subsection');
      feistySec.appendChild(el('h3', 'ref-section-title', t('referees.feisty.title')));
      feistySec.appendChild(el('p', 'explore-note explore-note--lead', t('referees.feisty.lead')));
      const list = el('div', 'ref-feisty-list');
      for (const m of feisty) {
        const rowBtn = el('button', 'ref-feisty-row');
        rowBtn.type = 'button';
        rowBtn.addEventListener('click', () => openRefDossier(m.referee));
        const fixture = el('span', 'ref-feisty-row__match');
        const hLogo = el('img', '', '');
        hLogo.src = `/logos/${m.home_id}.webp`; hLogo.alt = ''; hLogo.width = 18; hLogo.height = 18;
        const aLogo = el('img', '', '');
        aLogo.src = `/logos/${m.away_id}.webp`; aLogo.alt = ''; aLogo.width = 18; aLogo.height = 18;
        fixture.append(hLogo, el('strong', '', `${m.home} ${m.home_goals}–${m.away_goals} ${m.away}`), aLogo);
        rowBtn.appendChild(fixture);
        rowBtn.appendChild(el('span', 'ref-feisty-row__date', `${m.date} · ${m.referee}`));
        const meta = el('span', 'ref-feisty-row__meta');
        meta.appendChild(refereeCardPills(m.yellows, m.reds));
        if (m.totalFouls != null) meta.appendChild(el('span', 'ref-feisty-row__fouls', `${m.totalFouls} ${t('referees.feisty.fouls')}`));
        rowBtn.appendChild(meta);
        list.appendChild(rowBtn);
      }
      feistySec.appendChild(list);
      split.appendChild(feistySec);
    }
  }
}

function renderVisualRefTable(wrap, rows, onPickRef, seasonNow) {
  const maxAbsGap = Math.max(...rows.map((r) => Math.abs(r.awayHomeCardGap)), 0.5);

  const tableWrap = el('div', 'ref-table-wrap');
  const table = el('table', 'ref-table ref-table--visual');
  const thead = el('thead');
  const headRow = el('tr');
  const cols = [
    ['referee', 'referee', false],
    ['matches', 'matches', true],
    ['cards', 'cardsPerMatch', true],
    ['reds', 'redsPerMatch', true],
    ['fouls', 'foulsPerMatch', true],
    ['fpc', 'foulsPerCard', true],
    ['awayGap', 'awayHomeCardGap', true],
  ];
  const tbody = el('tbody');

  function sortRows() {
    const { key, dir } = state.refereeSort;
    const validKey = cols.some(([, sk]) => sk === key) ? key : 'matches';
    return [...rows].sort((a, b) => {
      const av = a[validKey];
      const bv = b[validKey];
      if (av == null && bv == null) return a.referee.localeCompare(b.referee);
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return dir * av.localeCompare(bv);
      return dir * (av - bv) || a.referee.localeCompare(b.referee);
    });
  }

  function renderBody() {
    tbody.replaceChildren();
    const sortedKey = state.refereeSort.key;
    for (const row of sortRows()) {
      const isActive = row.seasonMax >= seasonNow;
      const tr = el('tr', isActive ? '' : 'ref-row--inactive');
      tr.tabIndex = 0;
      tr.addEventListener('click', () => onPickRef(row.referee));
      tr.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onPickRef(row.referee);
      });

      const nameTd = el('td', `ref-name${sortedKey === 'referee' ? ' ref-col--sorted' : ''}`);
      nameTd.appendChild(el('span', '', row.referee));
      if (!isActive) {
        const spanTxt = row.seasonMin === row.seasonMax ? String(row.seasonMin) : `${row.seasonMin}–${String(row.seasonMax).slice(2)}`;
        nameTd.appendChild(el('span', 'ref-inactive-tag', spanTxt));
      }
      tr.appendChild(nameTd);
      tr.appendChild(el('td', `num${sortedKey === 'matches' ? ' ref-col--sorted' : ''}`, String(row.matches)));
      tr.appendChild(el('td', `num${sortedKey === 'cardsPerMatch' ? ' ref-col--sorted' : ''}`, num(row.cardsPerMatch, 2)));
      tr.appendChild(el('td', `num${row.redsPerMatch >= 0.17 ? ' ref-neg' : ''}${sortedKey === 'redsPerMatch' ? ' ref-col--sorted' : ''}`, num(row.redsPerMatch, 2)));
      tr.appendChild(el('td', `num${sortedKey === 'foulsPerMatch' ? ' ref-col--sorted' : ''}`, row.foulsPerMatch != null ? num(row.foulsPerMatch, 1) : '–'));
      tr.appendChild(el('td', `num${sortedKey === 'foulsPerCard' ? ' ref-col--sorted' : ''}`, row.foulsPerCard != null ? num(row.foulsPerCard, 1) : '–'));

      // Away-Home diverging micro-bar (amber for away-more, slate for home-more)
      const gapTd = el('td', `num ref-bar-cell${sortedKey === 'awayHomeCardGap' ? ' ref-col--sorted' : ''}`);
      const gapWrap = el('div', 'ref-divbar');
      const gapTrack = el('span', 'ref-divbar__track');
      gapTrack.appendChild(el('span', 'ref-divbar__zero'));
      const gapFill = el('span', `ref-divbar__fill ${row.awayHomeCardGap >= 0 ? 'ref-divbar__fill--away' : 'ref-divbar__fill--home'}`);
      const pct = Math.min(50, Math.round((Math.abs(row.awayHomeCardGap) / maxAbsGap) * 50));
      gapFill.style.width = `${pct}%`;
      if (row.awayHomeCardGap >= 0) gapFill.style.left = '50%';
      else gapFill.style.right = '50%';
      gapTrack.appendChild(gapFill);
      gapWrap.append(gapTrack, el('span', 'ref-vbar__num', signed(row.awayHomeCardGap, 2)));
      gapTd.appendChild(gapWrap);
      tr.appendChild(gapTd);

      tbody.appendChild(tr);
    }
  }

  for (const [labelKey, sortKey, isNum] of cols) {
    const th = el('th', isNum ? 'num' : '', t(`referees.col.${labelKey}`));
    th.dataset.sort = sortKey;
    th.tabIndex = 0;
    if (labelKey !== 'referee') th.title = t(`referees.colTip.${labelKey}`);
    if (state.refereeSort.key === sortKey) {
      th.setAttribute('aria-sort', state.refereeSort.dir === 1 ? 'ascending' : 'descending');
    }
    const toggle = () => {
      const same = state.refereeSort.key === sortKey;
      state.refereeSort = { key: sortKey, dir: same ? -state.refereeSort.dir : (sortKey === 'referee' ? 1 : -1) };
      for (const other of headRow.querySelectorAll('th')) other.removeAttribute('aria-sort');
      th.setAttribute('aria-sort', state.refereeSort.dir === 1 ? 'ascending' : 'descending');
      renderBody();
    };
    th.addEventListener('click', toggle);
    th.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle();
    });
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  renderBody();
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);
}

function renderRefPairingsSection(report, wrap, filtered, rerender) {
  wrap.appendChild(el('p', 'explore-note ref-pairings-intro', t('referees.pairings.intro')));
  wrap.appendChild(refPerfExplainer(filtered));

  const allRefs = refereeOverview(filtered);
  const allClubs = clubDisciplineRows(filtered).sort((a, b) => a.team.localeCompare(b.team));
  const minMatches = state.refereeMinMatches;
  const relaxMin = minMatches > 0 ? () => { state.refereeMinMatches = 0; rerender(); } : null;

  if (!allRefs.some((r) => r.referee === state.refereeSelected)) {
    state.refereeSelected = allRefs[0]?.referee || null;
  }
  if (!allClubs.some((c) => String(c.team_id) === String(state.refereeClubSelected))) {
    state.refereeClubSelected = allClubs[0]?.team_id || null;
  }

  const explorer = el('section', 'ref-explorer-card');
  const head = el('div', 'ref-explorer-card__head');
  const leftControls = el('div', 'ref-explorer-card__left');
  leftControls.appendChild(refereeSwitchGroup(
    t('referees.mode.label'),
    [['referee', t('referees.mode.byRef')], ['club', t('referees.mode.byClub')]],
    state.refereePairingMode,
    (val) => { state.refereePairingMode = val; state.refereePairingTeam = null; rerender(); },
  ));

  const pickerWrap = el('label', 'ref-picker');
  const select = el('select', 'ref-picker__select');
  if (state.refereePairingMode === 'club') {
    for (const c of allClubs) {
      const opt = el('option', '', `${c.team} (${c.matches})`);
      opt.value = String(c.team_id);
      if (String(c.team_id) === String(state.refereeClubSelected)) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      state.refereeClubSelected = select.value;
      state.refereePairingTeam = null;
      rerender();
    });
  } else {
    for (const r of allRefs) {
      const opt = el('option', '', `${r.referee} (${r.matches})`);
      opt.value = r.referee;
      if (r.referee === state.refereeSelected) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      state.refereeSelected = select.value;
      state.refereePairingTeam = null;
      rerender();
    });
  }
  pickerWrap.appendChild(select);
  leftControls.appendChild(pickerWrap);
  head.appendChild(leftControls);

  const rightControls = el('div', 'ref-explorer-card__right');
  rightControls.appendChild(refereeSwitchGroup(
    t('referees.metric.label'),
    [['perMatch', t('referees.metric.perMatch')], ['total', t('referees.metric.total')]],
    state.refereeMetric,
    (val) => { state.refereeMetric = val; rerender(); },
  ));
  rightControls.appendChild(refereeSwitchGroup(
    t('referees.min.label'),
    [['5', t('referees.min.five')], ['10', t('referees.min.ten')], ['0', t('referees.min.all')]],
    String(state.refereeMinMatches),
    (val) => { state.refereeMinMatches = Number(val); rerender(); },
  ));
  head.appendChild(rightControls);
  explorer.appendChild(head);

  const metaLine = el('div', 'ref-meta-line');
  const addMeta = (text) => metaLine.appendChild(el('span', 'ref-meta-line__item', text));
  let chartRows = [];
  let chartKind = 'club';
  let activeKey = null;
  let ariaLabel = '';

  if (state.refereePairingMode === 'club') {
    const activeClub = allClubs.find((c) => String(c.team_id) === String(state.refereeClubSelected)) || allClubs[0];
    if (activeClub) {
      addMeta(t('referees.badge.matches', { n: activeClub.matches }));
      addMeta(t('referees.badge.cards', { v: num(activeClub.cardsForPerMatch, 2) }));
      addMeta(t('referees.badge.netCards', { v: signed(activeClub.netCardsPerMatch, 2) }));
      if (activeClub.homeCardsPerMatch != null && activeClub.awayCardsPerMatch != null) {
        addMeta(t('referees.clubs.tipHomeAway', {
          h: num(activeClub.homeCardsPerMatch, 2), a: num(activeClub.awayCardsPerMatch, 2),
        }));
      }
      chartRows = refereeMinFilter(teamRefereeRows(filtered, activeClub.team_id), minMatches);
      chartKind = 'referee';
      activeKey = state.refereePairingTeam;
      ariaLabel = t('referees.teamAria', { team: activeClub.team });
    }
  } else {
    const activeRef = allRefs.find((r) => r.referee === state.refereeSelected) || allRefs[0];
    if (activeRef) {
      const spanStr = activeRef.seasonMin === activeRef.seasonMax ? String(activeRef.seasonMin) : `${activeRef.seasonMin}–${activeRef.seasonMax}`;
      addMeta(`${t('referees.badge.matches', { n: activeRef.matches })} (${spanStr})`);
      addMeta(t('referees.badge.cards', { v: num(activeRef.cardsPerMatch, 2) }));
      addMeta(t('referees.badge.reds', { v: num(activeRef.redsPerMatch, 2) }));
      if (activeRef.foulsPerMatch != null) addMeta(t('referees.badge.fouls', { v: num(activeRef.foulsPerMatch, 1) }));
      chartRows = refereeMinFilter(refereeTeamRows(filtered, activeRef.referee), minMatches);
      chartKind = 'club';
      activeKey = state.refereePairingTeam;
      ariaLabel = t('referees.aria', { ref: activeRef.referee });
    }
  }
  explorer.appendChild(metaLine);
  wrap.appendChild(explorer);

  const baseline = state.refereePairingMode === 'club' && state.refereeClubSelected != null
    ? refereeClubBaseline(filtered, state.refereeClubSelected)
    : null;
  drawRefBarChart(explorer, chartRows, {
    metric: state.refereeMetric,
    kind: chartKind,
    ariaLabel,
    emptyText: minMatches ? t('referees.emptyMin', { min: minMatches }) : t('referees.empty'),
    activeKey,
    onRelaxMin: relaxMin,
    chanceSd: refereeChanceSd(filtered),
    baseline,
    onClickRow: (row) => {
      const clickedKey = chartKind === 'club' ? String(row.team_id) : row.referee;
      const closing = String(state.refereePairingTeam) === clickedKey;
      state.refereePairingTeam = closing ? null : clickedKey;
      rerender(closing ? {} : { scrollToDrawer: true });
    },
  });
  if (chartRows.length) {
    const foot = el('div', 'ref-chart-foot');
    const key = el('span', 'ref-chance-key');
    key.append(
      el('i', 'ref-chance-swatch'),
      el('span', '', baseline != null ? t('referees.chanceNoteClub', { v: signed(baseline, 1) }) : t('referees.chanceNote')),
    );
    foot.append(key, el('span', 'ref-chart-foot__hint', t('referees.pairings.clickHint')));
    explorer.appendChild(foot);
  }

  if (state.refereePairingTeam != null) {
    const drawerRef = state.refereePairingMode === 'club' ? state.refereePairingTeam : state.refereeSelected;
    const drawerTeam = state.refereePairingMode === 'club' ? state.refereeClubSelected : state.refereePairingTeam;
    const drawer = renderPairingDrawer(filtered, drawerRef, drawerTeam, {
      context: 'explore',
      onClose: () => { state.refereePairingTeam = null; rerender(); },
      onNavigate: () => {
        const clubObj = allClubs.find((c) => String(c.team_id) === String(drawerTeam));
        state.teamTab = 'referees';
        state.teamRefereeSelected = drawerRef;
        openTeamView(drawerTeam, clubObj?.team || '');
      },
    });
    if (drawer) explorer.appendChild(drawer);
  }

  // Notable pairings (10+ matches on All seasons so iconic samples lead)
  const notableMin = state.refereeScope === 'all' ? Math.max(minMatches, 10) : minMatches;
  const pairings = refereePairings(filtered, notableMin);
  if (pairings.length >= 2) {
    const pairingsWrap = el('section', 'ref-subsection');
    pairingsWrap.appendChild(el('h3', 'ref-section-title', t('referees.pairings.title')));
    pairingsWrap.appendChild(el('p', 'explore-note explore-note--lead', t('referees.pairings.leadMin', { min: notableMin || 1 })));
    const byMetric = [...pairings].sort((a, b) => (state.refereeMetric === 'perMatch' ? b.perMatch - a.perMatch : b.diff - a.diff) || b.matches - a.matches);
    const digits = refPerfDigits(state.refereeMetric);
    const fmt = (row) => (state.refereeMetric === 'perMatch'
      ? t('referees.unit.perMatch', { v: signed(row.perMatch, digits) })
      : signed(row.diff, digits));
    const grid = el('div', 'ref-pairings');
    for (const [titleKey, tone, slice] of [
      ['referees.pairings.best', 'ref-pos', byMetric.slice(0, 5)],
      ['referees.pairings.worst', 'ref-neg', byMetric.slice(-5).reverse()],
    ]) {
      const card = el('div', 'ref-pairing-card');
      card.appendChild(el('h4', 'ref-pairing-card__title', t(titleKey)));
      const list = el('div', 'ref-pairing-list');
      for (const row of slice) {
        const btn = el('button', 'ref-pairing-row');
        btn.type = 'button';
        btn.appendChild(el('img', 'ref-pairing-row__logo', ''));
        btn.lastChild.src = `/logos/${row.team_id}.webp`;
        btn.lastChild.alt = '';
        btn.lastChild.width = 20;
        btn.lastChild.height = 20;
        const textWrap = el('span', 'ref-pairing-row__text');
        textWrap.appendChild(el('strong', '', `${row.team} + ${row.referee}`));
        const altTotal = state.refereeMetric === 'perMatch'
          ? t('referees.unit.pts', { v: signed(row.diff, 0) })
          : t('referees.unit.perMatch', { v: signed(row.perMatch, 1) });
        textWrap.appendChild(el('small', '', `${row.matches} ${t('referees.pairings.matches')} · ${row.wins}-${row.draws}-${row.losses} · ${altTotal}`));
        btn.appendChild(textWrap);
        btn.appendChild(el('span', `ref-pairing-row__val ${tone}`, fmt(row)));
        btn.addEventListener('click', () => {
          state.refereePairingMode = 'referee';
          state.refereeSelected = row.referee;
          state.refereePairingTeam = row.team_id;
          rerender({ scrollToDrawer: true });
        });
        list.appendChild(btn);
      }
      card.appendChild(list);
      grid.appendChild(card);
    }
    pairingsWrap.appendChild(grid);
    wrap.appendChild(pairingsWrap);
  }

  wrap.appendChild(refereeHowBox(false));
}

function drawRefStyleScatter(wrap, rows, onPickRef, seasonNow = 0) {
  const withFouls = rows.filter((r) => r.foulsPerMatch != null);
  if (withFouls.length < 2) {
    wrap.appendChild(el('p', 'explore-empty', t('referees.empty')));
    return;
  }
  const svg = svgEl('svg', { class: 'chart', role: 'group', 'aria-label': t('referees.style.aria') });
  wrap.appendChild(svg);
  const box = wrap.getBoundingClientRect().width || 940;
  const narrow = box < SHAPE_NARROW;
  const width = narrow ? Math.round(box) : 940;
  const height = narrow ? Math.round(width * 0.92) : 420;
  const pad = narrow ? { top: 30, right: 16, bottom: 36, left: 40 } : { top: 34, right: 24, bottom: 42, left: 48 };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const fVals = withFouls.map((r) => r.foulsPerMatch);
  const cVals = withFouls.map((r) => r.cardsPerMatch);
  const [f0, f1] = [Math.floor(Math.min(...fVals) - 0.8), Math.ceil(Math.max(...fVals) + 0.8)];
  const [c0, c1] = [Math.floor((Math.min(...cVals) - 0.2) * 4) / 4, Math.ceil((Math.max(...cVals) + 0.2) * 4) / 4];
  const right = width - pad.right;
  const bottom = height - pad.bottom;
  const x = (v) => pad.left + ((v - f0) / (f1 - f0 || 1)) * (right - pad.left);
  const y = (v) => bottom - ((v - c0) / (c1 - c0 || 1)) * (bottom - pad.top);

  const fStep = (f1 - f0) > 6 ? 2 : 1;
  for (let v = Math.ceil(f0); v <= f1; v += fStep) {
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: x(v), x2: x(v), y1: pad.top, y2: bottom }));
    svg.appendChild(svgEl('text', { class: 'tick', x: x(v), y: bottom + 14, 'text-anchor': 'middle' })).textContent = num(v, 0);
  }
  const cStep = 0.5;
  for (let v = Math.ceil(c0 * 2) / 2; v <= c1 + 1e-9; v += cStep) {
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: pad.left, x2: right, y1: y(v), y2: y(v) }));
    svg.appendChild(svgEl('text', { class: 'tick', x: pad.left - 6, y: y(v) + 3.5, 'text-anchor': 'end' })).textContent = num(v, 1);
  }

  const totalM = withFouls.reduce((s, r) => s + r.matches, 0);
  const avgF = withFouls.reduce((s, r) => s + r.foulsPerMatch * r.matches, 0) / totalM;
  const avgC = withFouls.reduce((s, r) => s + r.cardsPerMatch * r.matches, 0) / totalM;
  svg.appendChild(svgEl('line', { class: 'attack-map__band', x1: x(avgF), x2: x(avgF), y1: pad.top, y2: bottom }));
  svg.appendChild(svgEl('line', { class: 'attack-map__band', x1: pad.left, x2: right, y1: y(avgC), y2: y(avgC) }));

  const quad = (key, attrs) => {
    const node = svgEl('text', { class: 'attack-map__quad', ...attrs });
    node.textContent = t(key);
    svg.appendChild(node);
  };
  quad('referees.style.qTopLeft', { x: pad.left + 6, y: pad.top + 14 });
  quad('referees.style.qTopRight', { x: right - 6, y: pad.top + 14, 'text-anchor': 'end' });
  quad('referees.style.qBotLeft', { x: pad.left + 6, y: bottom - 8 });
  quad('referees.style.qBotRight', { x: right - 6, y: bottom - 8, 'text-anchor': 'end' });

  svg.appendChild(svgEl('text', { class: 'axis-title', x: right, y: height - 6, 'text-anchor': 'end' })).textContent = t('referees.style.x');
  svg.appendChild(svgEl('text', { class: 'axis-title', x: pad.left, y: pad.top - 10 })).textContent = t('referees.style.y');

  const shortMap = refereeScatterLabels(withFouls);
  const maxM = Math.max(...withFouls.map((r) => r.matches));
  const placedBoxes = [];
  const isAct = (r) => !seasonNow || r.seasonMax >= seasonNow;
  // Place active labels first (largest first), then past seasons.
  const sortedForLabels = [...withFouls].sort((a, b) => Number(isAct(b)) - Number(isAct(a)) || b.matches - a.matches);
  const points = sortedForLabels.map((row) => ({
    row,
    active: isAct(row),
    cx: x(row.foulsPerMatch),
    cy: y(row.cardsPerMatch),
    rad: (narrow ? 4.5 : 5.5) + (narrow ? 6 : 8) * Math.sqrt(row.matches / maxM),
  }));

  const dotNodes = [];
  for (const pt of points) {
    const { row, active, cx, cy, rad } = pt;
    const g = svgEl('g', { class: `ref-scatter-dot${active ? '' : ' ref-scatter-dot--past'}`, tabindex: 0, role: 'button' });
    g.appendChild(svgEl('circle', { cx, cy, r: rad }));
    const shortRef = shortMap.get(row.referee) || row.referee;
    const lblW = Math.max(30, shortRef.length * 6.8 + 4);
    const lblH = 12;
    const d = rad * 0.78;
    const candidates = [
      [cx, cy - rad - 4, 'middle', cx - lblW / 2, cy - rad - 4 - lblH],
      [cx, cy + rad + 11, 'middle', cx - lblW / 2, cy + rad + 1],
      [cx + rad + 4, cy + 3.5, 'start', cx + rad + 4, cy - 6],
      [cx - rad - 4, cy + 3.5, 'end', cx - rad - 4 - lblW, cy - 6],
      [cx + d + 3, cy - d - 2, 'start', cx + d + 3, cy - d - 2 - lblH],
      [cx - d - 3, cy - d - 2, 'end', cx - d - 3 - lblW, cy - d - 2 - lblH],
      [cx + d + 3, cy + d + 10, 'start', cx + d + 3, cy + d],
      [cx - d - 3, cy + d + 10, 'end', cx - d - 3 - lblW, cy + d],
    ];
    const fits = (bx, by) => bx >= pad.left + 2 && bx + lblW <= right - 2 && by >= pad.top + 14 && by + lblH <= bottom - 14
      && !placedBoxes.some(([px, py, pw, ph]) => bx < px + pw + 3 && bx + lblW + 3 > px && by < py + ph + 2 && by + lblH + 2 > py)
      && !points.some((o) => o.row !== row && o.cx + o.rad + 3 > bx && o.cx - o.rad - 3 < bx + lblW && o.cy + o.rad + 3 > by && o.cy - o.rad - 3 < by + lblH);
    if (!narrow || row.matches >= 30) {
      const chosen = candidates.find(([, , , bx, by]) => fits(bx, by));
      if (chosen) {
        const [lx, ly, anchor, bx, by] = chosen;
        const lbl = svgEl('text', { class: `ref-scatter-label${active ? '' : ' ref-scatter-label--past'}`, x: lx, y: ly, 'text-anchor': anchor });
        lbl.textContent = shortRef;
        g.appendChild(lbl);
        placedBoxes.push([bx, by, lblW, lblH]);
      }
    }
    const spanTxt = row.seasonMin === row.seasonMax ? String(row.seasonMin) : `${row.seasonMin}–${row.seasonMax}`;
    const tip = `${t('referees.style.tip', {
      n: row.matches, c: num(row.cardsPerMatch, 2), f: num(row.foulsPerMatch, 1), fpc: num(row.foulsPerCard, 1),
    })}<br><span class="tooltip__muted">${t('referees.style.tipMore', {
      r: num(row.redsPerMatch, 2), gap: signed(row.awayHomeCardGap, 2),
    })} · ${spanTxt}</span>`;
    g.setAttribute('aria-label', `${row.referee}: ${t('referees.style.tip', {
      n: row.matches, c: num(row.cardsPerMatch, 2), f: num(row.foulsPerMatch, 1), fpc: num(row.foulsPerCard, 1),
    })}`);
    attachTip(g, `<b>${esc(row.referee)}</b><br>${tip}`);
    g.addEventListener('click', () => { hideTooltip(); onPickRef(row.referee); });
    g.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      hideTooltip();
      onPickRef(row.referee);
    });
    dotNodes.push({ g, active });
  }
  // Draw past-season dots first so active dots sit on top.
  for (const d of dotNodes) if (!d.active) svg.appendChild(d.g);
  for (const d of dotNodes) if (d.active) svg.appendChild(d.g);
}

function drawSeasonDisciplineChart(wrap, seasons) {
  const legend = el('div', 'ref-legend');
  legend.innerHTML = `<span class="ref-legend__item"><i class="ref-legend__swatch ref-legend__swatch--cards"></i>${esc(t('referees.seasons.legendCards'))}</span>`
    + `<span class="ref-legend__item"><i class="ref-legend__swatch ref-legend__swatch--reds"></i>${esc(t('referees.seasons.legendReds'))}</span>`;
  wrap.appendChild(legend);

  const svg = svgEl('svg', { class: 'chart', role: 'group', 'aria-label': t('referees.seasons.aria') });
  wrap.appendChild(svg);
  const box = wrap.getBoundingClientRect().width || 520;
  const narrow = box < SHAPE_NARROW;
  const width = Math.max(320, Math.min(620, Math.round(box)));
  const height = 240;
  const pad = { top: 30, right: 44, bottom: 32, left: 36 };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const right = width - pad.right;
  const bottom = height - pad.bottom;
  const stepX = (right - pad.left) / seasons.length;
  const xAt = (i) => pad.left + (i + 0.5) * stepX;
  const maxC = Math.max(4, Math.ceil(Math.max(...seasons.map((s) => s.cardsPerMatch)) * 2) / 2);
  const maxR = Math.max(0.25, Math.ceil(Math.max(...seasons.map((s) => s.redsPerMatch)) * 10) / 10);
  const y = (v) => bottom - (v / maxC) * (bottom - pad.top);
  const yR = (v) => bottom - (v / maxR) * (bottom - pad.top);

  for (let v = 0; v <= maxC + 1e-9; v += 1) {
    svg.appendChild(svgEl('line', { class: v ? 'grid-line' : 'axis-line', x1: pad.left, x2: right, y1: y(v), y2: y(v) }));
    svg.appendChild(svgEl('text', { class: 'tick', x: pad.left - 6, y: y(v) + 3.5, 'text-anchor': 'end' })).textContent = num(v, 0);
  }
  const rStep = maxR > 0.3 ? 0.1 : 0.05;
  for (let rv = 0; rv <= maxR + 1e-9; rv += rStep * 2) {
    svg.appendChild(svgEl('text', { class: 'tick ref-season-rtick', x: right + 6, y: yR(rv) + 3.5 })).textContent = num(rv, 2);
  }
  svg.appendChild(svgEl('text', { class: 'axis-title', x: pad.left, y: pad.top - 10 })).textContent = t('referees.seasons.y');
  svg.appendChild(svgEl('text', { class: 'axis-title ref-season-rtick', x: right, y: pad.top - 10, 'text-anchor': 'end' })).textContent = t('referees.seasons.yRed');

  const varIdx = seasons.findIndex((s) => s.season === 2023);
  if (varIdx >= 0) {
    const vx = xAt(varIdx);
    svg.appendChild(svgEl('line', { class: 'attack-map__band', x1: vx, x2: vx, y1: pad.top, y2: bottom }));
    svg.appendChild(svgEl('text', { class: 'tick ref-var-label', x: vx, y: pad.top - 10, 'text-anchor': 'middle' })).textContent = 'VAR';
  }

  const pts = seasons.map((s, i) => `${xAt(i)},${y(s.cardsPerMatch)}`).join(' ');
  svg.appendChild(svgEl('polyline', { class: 'ref-season-line', points: pts }));

  const barW = Math.min(20, Math.max(10, Math.round(stepX * 0.34)));
  seasons.forEach((s, i) => {
    const cx = xAt(i);
    const cy = y(s.cardsPerMatch);
    const g = svgEl('g', { class: 'ref-season-pt', tabindex: 0 });
    const redH = Math.max(2, bottom - yR(s.redsPerMatch));
    g.appendChild(svgEl('rect', { class: 'ref-season-bar', x: cx - barW / 2, y: bottom - redH, width: barW, height: redH, rx: 2 }));
    g.appendChild(svgEl('circle', { class: 'ref-season-dot', cx, cy, r: 4.5 }));
    const lbl = svgEl('text', { class: 'tick', x: cx, y: cy - 8, 'text-anchor': 'middle' });
    lbl.textContent = num(s.cardsPerMatch, 2);
    g.appendChild(lbl);
    const yr = svgEl('text', { class: 'tick', x: cx, y: bottom + 16, 'text-anchor': 'middle' });
    yr.textContent = String(s.season);
    g.appendChild(yr);
    const tip = t('referees.seasons.tip', {
      s: s.season, c: num(s.cardsPerMatch, 2), y: num(s.yellowsPerMatch, 2), r: num(s.redsPerMatch, 2),
      rpct: num(s.redMatchPct, 1),
      f: s.foulsPerMatch != null ? num(s.foulsPerMatch, 1) : '–', fpc: s.foulsPerCard != null ? num(s.foulsPerCard, 1) : '–',
    });
    g.setAttribute('aria-label', tip);
    attachTip(g, `<b>${s.season}</b><br>${tip}`);
    svg.appendChild(g);
  });
}

function renderClubDisciplineSection(report, wrap, filtered, rerender) {
  const minFloor = state.refereeScope === 'all' ? 10 : 0;
  const clubs = minFloor ? refereeMinFilter(clubDisciplineRows(filtered), minFloor) : clubDisciplineRows(filtered);
  if (!clubs.length) {
    wrap.appendChild(el('p', 'explore-empty', t('referees.empty')));
    return;
  }
  const openClub = (teamId, teamName) => {
    state.teamTab = 'referees';
    openTeamView(teamId, teamName);
  };

  // 1. 3-Card Editorial Hero Strip
  const byBooked = [...clubs].sort((a, b) => a.cardsForPerMatch - b.cardsForPerMatch);
  const byDrawn = [...clubs].sort((a, b) => b.cardsAgainstPerMatch - a.cardsAgainstPerMatch);
  const byNetReds = [...clubs].sort((a, b) => b.netReds - a.netReds || a.team.localeCompare(b.team));
  const cleanest = byBooked[0];
  const mostDrawn = byDrawn[0];
  const bestReds = byNetReds[0];

  const hero = el('div', 'ref-hero-grid');
  hero.appendChild(refHeroCard(
    t('referees.clubs.factClean'),
    num(cleanest.cardsForPerMatch, 2),
    t('referees.clubs.factCleanSub', { a: num(cleanest.cardsAgainstPerMatch, 2), n: cleanest.matches }),
    { club: { id: cleanest.team_id, name: cleanest.team }, onClick: () => openClub(cleanest.team_id, cleanest.team) },
  ));
  hero.appendChild(refHeroCard(
    t('referees.clubs.factDrawn'),
    num(mostDrawn.cardsAgainstPerMatch, 2),
    t('referees.clubs.factDrawnSub', { f: num(mostDrawn.cardsForPerMatch, 2), n: mostDrawn.matches }),
    { club: { id: mostDrawn.team_id, name: mostDrawn.team }, onClick: () => openClub(mostDrawn.team_id, mostDrawn.team) },
  ));
  hero.appendChild(refHeroCard(
    t('referees.clubs.factBestReds'),
    signed(bestReds.netReds, 0),
    t('referees.clubs.factRedsSub', { rf: bestReds.redsFor, ra: bestReds.redsAgainst, n: bestReds.matches }),
    { tone: bestReds.netReds >= 0 ? 'ref-pos' : 'ref-neg', club: { id: bestReds.team_id, name: bestReds.team }, onClick: () => openClub(bestReds.team_id, bestReds.team) },
  ));
  wrap.appendChild(hero);

  // 2. Crest Scatter Plot
  const scatterSec = el('section', 'ref-subsection');
  scatterSec.appendChild(el('h3', 'ref-section-title', t('referees.clubs.scatterTitle')));
  scatterSec.appendChild(el('p', 'explore-note explore-note--lead', t('referees.clubs.scatterLead')));
  wrap.appendChild(scatterSec);
  drawClubDisciplineScatter(scatterSec, clubs, openClub);

  // 3. Unified Club Ranking Section (Chart <-> Table Switcher)
  const rankSec = el('section', 'ref-subsection');
  wrap.appendChild(rankSec);
  const rankHead = el('div', 'ref-section-head');
  const rankTitles = el('div', 'ref-section-head__text');
  const netMeta = state.clubDisciplineMetric === 'fouls'
    ? ['referees.clubs.netFoulsTitle', 'referees.clubs.netFoulsLead']
    : state.clubDisciplineMetric === 'reds'
      ? ['referees.clubs.netRedsTitle', 'referees.clubs.netRedsLead']
      : ['referees.clubs.netCardsTitle', 'referees.clubs.netCardsLead'];
  rankTitles.appendChild(el('h3', 'ref-section-title', state.clubDisciplineView === 'table' ? t('referees.clubs.tableTitle') : t(netMeta[0])));
  rankTitles.appendChild(el('p', 'explore-note explore-note--lead', state.clubDisciplineView === 'table' ? t('referees.clubs.tableLead') : t(netMeta[1])));
  rankHead.appendChild(rankTitles);

  const rankControls = el('div', 'ref-section-head__controls');
  if (state.clubDisciplineView === 'chart') {
    rankControls.appendChild(refereeSwitchGroup(
      t('referees.clubs.metricLabel'),
      [
        ['cards', t('referees.clubs.metricCards')],
        ['fouls', t('referees.clubs.metricFouls')],
        ['reds', t('referees.clubs.metricReds')],
      ],
      state.clubDisciplineMetric,
      (val) => { state.clubDisciplineMetric = val; rerender(); },
    ));
  }
  rankControls.appendChild(refereeSwitchGroup(
    t('referees.clubs.viewLabel'),
    [['chart', t('referees.clubs.viewChart')], ['table', t('referees.clubs.viewTable')]],
    state.clubDisciplineView,
    (val) => { state.clubDisciplineView = val; rerender(); },
  ));
  rankHead.appendChild(rankControls);
  rankSec.appendChild(rankHead);

  if (state.clubDisciplineView === 'chart') {
    drawClubNetChart(rankSec, clubs, state.clubDisciplineMetric, openClub);
    return;
  }

  const tableWrap = el('div', 'ref-table-wrap');
  const table = el('table', 'ref-table');
  const thead = el('thead');
  const headRow = el('tr');
  const cols = [
    ['club', 'team', false],
    ['matches', 'matches', true],
    ['cardsFor', 'cardsForPerMatch', true],
    ['cardsAgainst', 'cardsAgainstPerMatch', true],
    ['netCards', 'netCardsPerMatch', true],
    ['netReds', 'netReds', true],
    ['foulsFor', 'foulsForPerMatch', true],
    ['foulsAgainst', 'foulsAgainstPerMatch', true],
    ['fpc', 'foulsPerCard', true],
  ];
  const tbody = el('tbody');

  function sortClubs() {
    const { key, dir } = state.clubDisciplineSort;
    return [...clubs].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av == null && bv == null) return a.team.localeCompare(b.team);
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return dir * av.localeCompare(bv);
      return dir * (av - bv) || a.team.localeCompare(b.team);
    });
  }

  function renderClubTableBody() {
    tbody.replaceChildren();
    const sortedKey = state.clubDisciplineSort.key;
    for (const row of sortClubs()) {
      const tr = el('tr');
      tr.tabIndex = 0;
      tr.addEventListener('click', () => openClub(row.team_id, row.team));
      tr.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openClub(row.team_id, row.team);
      });
      const tdName = el('td', `ref-club-cell${sortedKey === 'team' ? ' ref-col--sorted' : ''}`);
      const logo = el('img', '', '');
      logo.src = `/logos/${row.team_id}.webp`;
      logo.alt = '';
      logo.width = 18;
      logo.height = 18;
      tdName.append(logo, el('span', '', row.team));
      tr.appendChild(tdName);
      tr.appendChild(el('td', `num${sortedKey === 'matches' ? ' ref-col--sorted' : ''}`, String(row.matches)));
      tr.appendChild(el('td', `num${sortedKey === 'cardsForPerMatch' ? ' ref-col--sorted' : ''}`, num(row.cardsForPerMatch, 2)));
      tr.appendChild(el('td', `num${sortedKey === 'cardsAgainstPerMatch' ? ' ref-col--sorted' : ''}`, num(row.cardsAgainstPerMatch, 2)));
      tr.appendChild(el('td', `num ${row.netCardsPerMatch >= 0 ? 'ref-pos' : 'ref-neg'}${sortedKey === 'netCardsPerMatch' ? ' ref-col--sorted' : ''}`, signed(row.netCardsPerMatch, 2)));
      const redsTd = el('td', `num ${row.netReds > 0 ? 'ref-pos' : row.netReds < 0 ? 'ref-neg' : ''}${sortedKey === 'netReds' ? ' ref-col--sorted' : ''}`, signed(row.netReds, 0));
      redsTd.title = t('referees.clubs.tipReds', { rf: row.redsFor, ra: row.redsAgainst, net: signed(row.netReds, 0), n: row.matches });
      tr.appendChild(redsTd);
      tr.appendChild(el('td', `num${sortedKey === 'foulsForPerMatch' ? ' ref-col--sorted' : ''}`, row.foulsForPerMatch != null ? num(row.foulsForPerMatch, 1) : '–'));
      tr.appendChild(el('td', `num${sortedKey === 'foulsAgainstPerMatch' ? ' ref-col--sorted' : ''}`, row.foulsAgainstPerMatch != null ? num(row.foulsAgainstPerMatch, 1) : '–'));
      tr.appendChild(el('td', `num${sortedKey === 'foulsPerCard' ? ' ref-col--sorted' : ''}`, row.foulsPerCard != null ? num(row.foulsPerCard, 1) : '–'));
      tbody.appendChild(tr);
    }
  }

  for (const [labelKey, sortKey, isNum] of cols) {
    const th = el('th', isNum ? 'num' : '', t(`referees.clubs.col.${labelKey}`));
    th.dataset.sort = sortKey;
    th.tabIndex = 0;
    if (labelKey !== 'club') th.title = t(`referees.clubs.colTip.${labelKey}`);
    if (state.clubDisciplineSort.key === sortKey) {
      th.setAttribute('aria-sort', state.clubDisciplineSort.dir === 1 ? 'ascending' : 'descending');
    }
    const toggle = () => {
      const same = state.clubDisciplineSort.key === sortKey;
      state.clubDisciplineSort = { key: sortKey, dir: same ? -state.clubDisciplineSort.dir : (sortKey === 'team' ? 1 : -1) };
      for (const other of headRow.querySelectorAll('th')) other.removeAttribute('aria-sort');
      th.setAttribute('aria-sort', state.clubDisciplineSort.dir === 1 ? 'ascending' : 'descending');
      renderClubTableBody();
    };
    th.addEventListener('click', toggle);
    th.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle();
    });
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  renderClubTableBody();
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  rankSec.appendChild(tableWrap);
}

function drawClubDisciplineScatter(wrap, clubs, onPickClub) {
  const svg = svgEl('svg', { class: 'chart', role: 'group', 'aria-label': t('referees.clubs.scatterAria') });
  wrap.appendChild(svg);
  const box = wrap.getBoundingClientRect().width || 940;
  const narrow = box < SHAPE_NARROW;
  const width = narrow ? Math.round(box) : 940;
  const height = narrow ? width : 520;
  const pad = narrow ? { top: 30, right: 14, bottom: 34, left: 38 } : { top: 34, right: 24, bottom: 40, left: 48 };
  const crest = narrow ? 22 : 26;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const allVals = clubs.flatMap((c) => [c.cardsForPerMatch, c.cardsAgainstPerMatch]);
  const lo = Math.max(0, Math.floor((Math.min(...allVals) - 0.06) * 10) / 10);
  const hi = Math.ceil((Math.max(...allVals) + 0.06) * 10) / 10;
  const right = width - pad.right;
  const bottom = height - pad.bottom;
  const x = (v) => pad.left + ((v - lo) / (hi - lo || 1)) * (right - pad.left);
  const y = (v) => bottom - ((v - lo) / (hi - lo || 1)) * (bottom - pad.top);

  const step = (hi - lo) > 1.0 ? 0.2 : 0.1;
  for (let v = lo; v <= hi + 1e-9; v += step) {
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: x(v), x2: x(v), y1: pad.top, y2: bottom }));
    svg.appendChild(svgEl('text', { class: 'tick', x: x(v), y: bottom + 14, 'text-anchor': 'middle' })).textContent = num(v, 1);
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: pad.left, x2: right, y1: y(v), y2: y(v) }));
    svg.appendChild(svgEl('text', { class: 'tick', x: pad.left - 6, y: y(v) + 3.5, 'text-anchor': 'end' })).textContent = num(v, 1);
  }
  svg.appendChild(svgEl('line', { class: 'attack-map__even', x1: x(lo), y1: y(lo), x2: x(hi), y2: y(hi) }));
  const totalM = clubs.reduce((s, c) => s + c.matches, 0);
  const avg = clubs.reduce((s, c) => s + c.cardsForPerMatch * c.matches, 0) / (totalM || 1);
  svg.appendChild(svgEl('line', { class: 'attack-map__band', x1: x(avg), x2: x(avg), y1: pad.top, y2: bottom }));
  svg.appendChild(svgEl('line', { class: 'attack-map__band', x1: pad.left, x2: right, y1: y(avg), y2: y(avg) }));

  const quad = (key, attrs) => {
    const node = svgEl('text', { class: 'attack-map__quad', ...attrs });
    node.textContent = t(key);
    svg.appendChild(node);
  };
  quad('referees.clubs.qTopLeft', { x: pad.left + 6, y: pad.top + 14 });
  quad('referees.clubs.qTopRight', { x: right - 6, y: pad.top + 14, 'text-anchor': 'end' });
  quad('referees.clubs.qBotLeft', { x: pad.left + 6, y: bottom - 8 });
  quad('referees.clubs.qBotRight', { x: right - 6, y: bottom - 8, 'text-anchor': 'end' });

  svg.appendChild(svgEl('text', { class: 'axis-title', x: right, y: height - 6, 'text-anchor': 'end' })).textContent = t('referees.clubs.x');
  svg.appendChild(svgEl('text', { class: 'axis-title', x: pad.left, y: pad.top - 10 })).textContent = t('referees.clubs.y');

  for (const row of clubs) {
    const cx = x(row.cardsForPerMatch);
    const cy = y(row.cardsAgainstPerMatch);
    const club = svgEl('g', { class: 'attack-map__club', tabindex: 0, role: 'button' });
    club.appendChild(svgEl('circle', { cx, cy, r: crest / 2 + 2 }));
    club.appendChild(svgEl('image', { href: `/logos/${row.team_id}.webp`, x: cx - crest / 2, y: cy - crest / 2, width: crest, height: crest }));
    const tipMain = t('referees.clubs.tip', {
      f: num(row.cardsForPerMatch, 2), a: num(row.cardsAgainstPerMatch, 2), net: signed(row.netCardsPerMatch, 2), n: row.matches,
    });
    const tipHomeAway = row.homeCardsPerMatch != null && row.awayCardsPerMatch != null
      ? `<br><span class="tooltip__muted">${t('referees.clubs.tipHomeAway', { h: num(row.homeCardsPerMatch, 2), a: num(row.awayCardsPerMatch, 2) })}</span>`
      : '';
    const tipSub = row.foulsForPerMatch != null
      ? `<br><span class="tooltip__muted">${t('referees.clubs.tipFouls', {
        ff: num(row.foulsForPerMatch, 1), fa: num(row.foulsAgainstPerMatch, 1), fpc: num(row.foulsPerCard, 1),
      })}</span>`
      : '';
    club.setAttribute('aria-label', `${row.team}: ${tipMain}`);
    attachTip(club, `<b>${esc(row.team)}</b><br>${tipMain}${tipHomeAway}${tipSub}`);
    club.addEventListener('pointerenter', () => { svg.appendChild(club); });
    club.addEventListener('focus', () => { svg.appendChild(club); });
    club.addEventListener('click', () => { hideTooltip(); onPickClub(row.team_id, row.team); });
    club.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      hideTooltip();
      onPickClub(row.team_id, row.team);
    });
    svg.appendChild(club);
  }
}

function drawClubNetChart(wrap, clubs, metric, onPickClub) {
  const isFouls = metric === 'fouls';
  const isReds = metric === 'reds';
  const rows = clubs.filter((c) => (!isFouls || c.netFoulsPerMatch != null));
  if (!rows.length) {
    wrap.appendChild(el('p', 'explore-empty', t('referees.empty')));
    return;
  }
  const valueOf = (r) => (isFouls ? r.netFoulsPerMatch : isReds ? r.netReds : r.netCardsPerMatch);
  const digits = isFouls ? 1 : isReds ? 0 : 2;
  const sorted = [...rows].sort((a, b) => valueOf(b) - valueOf(a) || a.team.localeCompare(b.team));

  const ariaKey = isFouls ? 'referees.clubs.netFoulsTitle' : isReds ? 'referees.clubs.netRedsTitle' : 'referees.clubs.netCardsTitle';
  const svg = svgEl('svg', { class: 'chart', role: 'group', 'aria-label': t(ariaKey) });
  wrap.appendChild(svg);
  const box = wrap.getBoundingClientRect().width || 940;
  const narrow = box < SHAPE_NARROW;
  const width = narrow ? Math.round(box) : 940;
  const rowHeight = 25;
  const pad = { top: 26, bottom: 30, left: narrow ? 136 : 190, right: 48 };
  const height = pad.top + sorted.length * rowHeight + pad.bottom;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const maxAbs = Math.max(...sorted.map((r) => Math.abs(valueOf(r))), isFouls ? 1.0 : isReds ? 4 : 0.4);
  const reach = isFouls
    ? Math.max(1, Math.ceil(maxAbs))
    : isReds
      ? Math.max(4, Math.ceil(maxAbs / 2) * 2)
      : Math.max(0.5, Math.ceil(maxAbs * 4) / 4);
  const x = (v) => pad.left + ((v + reach) / (2 * reach)) * (width - pad.left - pad.right);
  const step = narrow
    ? (reach / 2)
    : (isFouls ? (reach > 3 ? 1 : 0.5) : isReds ? (reach > 8 ? 4 : 2) : (reach > 0.8 ? 0.25 : 0.2));
  for (let v = -reach; v <= reach + 1e-9; v += step) {
    const r = Math.abs(v) < 1e-9 ? 0 : v;
    const tDigits = (step % 1 !== 0) ? (isFouls ? 1 : 2) : 0;
    svg.appendChild(svgEl('line', { class: r ? 'grid-line' : 'axis-line', x1: x(r), x2: x(r), y1: pad.top - 6, y2: height - pad.bottom }));
    svg.appendChild(svgEl('text', { class: 'tick', x: x(r), y: height - pad.bottom + 14, 'text-anchor': 'middle' })).textContent = r === 0 ? '0' : signed(r, tDigits);
  }
  const xTitleKey = isFouls ? 'referees.clubs.netFoulsX' : isReds ? 'referees.clubs.netRedsX' : 'referees.clubs.netCardsX';
  svg.appendChild(svgEl('text', { class: 'axis-title', x: width - pad.right, y: height - 4, 'text-anchor': 'end' })).textContent = t(xTitleKey);
  svg.appendChild(svgEl('text', { class: 'luck__side', x: x(-reach), y: pad.top - 10 })).textContent = t('referees.clubs.netNeg');
  svg.appendChild(svgEl('text', { class: 'luck__side', x: x(reach), y: pad.top - 10, 'text-anchor': 'end' })).textContent = t('referees.clubs.netPos');
  svg.appendChild(svgEl('text', { class: 'luck__side', x: 18, y: pad.top - 10, 'text-anchor': 'end' })).textContent = t('referees.clubs.col.matches');

  sorted.forEach((row, i) => {
    const val = valueOf(row);
    const top = pad.top + i * rowHeight;
    const g = svgEl('g', { class: 'luck__row', tabindex: 0, role: 'button' });
    const [a, b] = [x(0), x(val)];
    g.appendChild(svgEl('rect', { class: 'ref-bar__hit', x: 0, y: top + 1, width: width - 2, height: rowHeight - 2, rx: 4 }));
    g.appendChild(svgEl('rect', {
      class: `luck__bar ${val >= 0 ? 'luck__bar--up' : 'luck__bar--down'}`,
      x: Math.min(a, b), y: top + 5, width: Math.max(1, Math.abs(b - a)), height: rowHeight - 10, rx: 3,
    }));
    const count = svgEl('text', { class: 'luck__place', x: 18, y: top + 17, 'text-anchor': 'end' });
    count.textContent = String(row.matches);
    g.appendChild(count);
    g.appendChild(svgEl('image', { href: `/logos/${row.team_id}.webp`, x: 24, y: top + 3, width: 20, height: 20 }));
    const name = svgEl('text', { class: 'luck__name', x: 50, y: top + 17 });
    name.textContent = narrow && row.team.length > 11 ? `${row.team.slice(0, 10)}…` : row.team;
    g.appendChild(name);
    const valNode = svgEl('text', { class: 'luck__value', y: top + 17, x: val >= 0 ? b + 5 : b - 5, 'text-anchor': val >= 0 ? 'start' : 'end' });
    valNode.textContent = signed(val, digits);
    g.appendChild(valNode);
    const tip = isReds
      ? t('referees.clubs.tipReds', { rf: row.redsFor, ra: row.redsAgainst, net: signed(row.netReds, 0), n: row.matches })
      : t('referees.clubs.tip', { f: num(row.cardsForPerMatch, 2), a: num(row.cardsAgainstPerMatch, 2), net: signed(row.netCardsPerMatch, 2), n: row.matches });
    g.setAttribute('aria-label', `${row.team}: ${signed(val, digits)}`);
    attachTip(g, `<b>${esc(row.team)}</b><br>${tip}`);
    g.addEventListener('click', () => { hideTooltip(); onPickClub(row.team_id, row.team); });
    g.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      hideTooltip();
      onPickClub(row.team_id, row.team);
    });
    svg.appendChild(g);
  });
}
