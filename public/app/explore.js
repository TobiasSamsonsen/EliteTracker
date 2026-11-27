/* ---------- explore: other ways to look at the numbers -------------- */

/* A gallery of cards, each opening one visualisation in the same panel. */
const EXPLORE_ITEMS = ['mountain', 'attack', 'luck', 'referees', 'races', 'whatif', 'runin', 'playoff'];
/* The visualisations that follow the rewind slider: they read one day's
   report. The rest take a whole season or every season, or carry time along
   an axis of their own, which the slider would only cut short. */
const EXPLORE_REWIND = new Set(['attack', 'luck', 'referees', 'whatif', 'playoff']);

function exploreThumb(id) {
  const svg = svgEl('svg', { class: 'explore-card__thumb', viewBox: '0 0 160 90', 'aria-hidden': 'true' });
  if (id === 'mountain') {
    // A stepped peak, darker towards the top, like the stack it opens.
    [1, 2, 3, 5, 7, 9, 8, 6, 5, 3, 2, 1].forEach((height, column) => {
      for (let level = 0; level < height; level += 1) {
        svg.appendChild(svgEl('rect', {
          x: 20 + column * 10, y: 80 - (level + 1) * 7.5, width: 9, height: 6.5, rx: 1,
          style: `fill: var(--seq-${Math.min(SEQ_STEPS, level + 1)})`,
        }));
      }
    });
  } else if (id === 'races') {
    // A few lines crossing on their way up and down.
    [[70, 62, 40, 22, 14], [20, 30, 48, 60, 72], [50, 44, 50, 66, 80], [80, 76, 72, 74, 78]].forEach((ys, i) => {
      svg.appendChild(svgEl('polyline', { points: ys.map((v, k) => `${20 + k * 30},${v}`).join(' '), style: `fill: none; stroke: ${raceColour(i)}; stroke-width: 3; stroke-linejoin: round` }));
    });
  } else if (id === 'whatif') {
    // A scoreline, and the bars it moves.
    svg.appendChild(svgEl('rect', { x: 52, y: 12, width: 56, height: 30, rx: 6, style: 'fill: none; stroke: var(--ink); stroke-width: 3' }));
    svg.appendChild(svgEl('text', { x: 80, y: 34, 'text-anchor': 'middle', style: 'font: 700 22px var(--display); fill: var(--ink)' })).textContent = '2–1';
    [[20, 34, 'good'], [36, 26, 'good'], [52, 40, 'bad'], [68, 22, 'good'], [84, 30, 'bad'], [100, 24, 'good'], [116, 36, 'bad'], [132, 28, 'good']].forEach(([x, h, tone]) => {
      svg.appendChild(svgEl('rect', { x, y: 82 - h, width: 12, height: h, rx: 2, style: `fill: var(--outcome-${tone}); opacity: ${tone === 'good' ? 1 : 0.85}` }));
    });
  } else if (id === 'luck') {
    // Bars either side of zero, longest at the ends.
    svg.appendChild(svgEl('line', { class: 'explore-thumb__avg', x1: 80, x2: 80, y1: 6, y2: 84 }));
    [34, 24, 15, 8, -6, -12, -22, -31].forEach((v, i) => {
      svg.appendChild(svgEl('rect', {
        x: v >= 0 ? 80 : 80 + v, y: 9 + i * 9.5, width: Math.abs(v), height: 6.5, rx: 1.5,
        style: `fill: var(${v >= 0 ? '--outcome-good' : '--outcome-bad'})`,
      }));
    });
  } else if (id === 'referees') {
    // Yellow/red card pair, and a referee's plain black shirt beside them, a
    // badge on the chest where the FIFA badge sits. The
    // ink outline keeps the shirt visible on the dark theme's panel.
    svg.appendChild(svgEl('rect', { x: 40, y: 30, width: 18, height: 26, rx: 3, style: 'fill: #eab308' }));
    svg.appendChild(svgEl('rect', { x: 49, y: 38, width: 18, height: 26, rx: 3, style: 'fill: var(--outcome-bad); stroke: var(--panel); stroke-width: 1.5' }));
    svg.appendChild(svgEl('path', {
      d: 'M95 26 L88 28 L77 38 L82 45 L88 41 V68 H112 V41 L118 45 L123 38 L112 28 L105 26 Q100 32 95 26 Z',
      style: 'fill: #16181d; stroke: var(--ink); stroke-width: 1.2; stroke-linejoin: round',
    }));
    svg.appendChild(svgEl('rect', { x: 103, y: 33.5, width: 5.5, height: 6, rx: 1, style: 'fill: #fff; opacity: 0.8' }));
  } else if (id === 'runin') {
    // Rows of cells, darker where a win is likelier.
    for (let r = 0; r < 5; r += 1) {
      for (let c = 0; c < 9; c += 1) {
        svg.appendChild(svgEl('rect', {
          x: 20 + c * 13.5, y: 10 + r * 14.5, width: 12, height: 12.5, rx: 2,
          style: `fill: ${seqColor(((r * 7 + c * 5) % 9) / 9 * 0.8 + 0.1)}`,
        }));
      }
    }
  } else if (id === 'playoff') {
    // The bracket as the page draws it: three OBOS-ligaen matches climbing the
    // ladder, then the tie with Eliteserien's 14th. A club's slot is filled in its
    // division's colour; a slot still to be won is an outline, fed by the line
    // from the match before.
    const width = 28;
    const top = (i) => 58 - i * 13;
    for (let i = 0; i < 4; i += 1) {
      const x = 10 + i * 37;
      const slots = i === 0 ? ['--tier-2', '--tier-2'] : i === 3 ? [null, '--tier-1'] : ['--tier-2', null];
      slots.forEach((fill, s) => {
        svg.appendChild(svgEl('rect', {
          x, y: top(i) + s * 10, width, height: 8, rx: 2,
          style: fill ? `fill: var(${fill})` : 'fill: none; stroke: var(--ink-faint); stroke-width: 1.4; stroke-dasharray: 3 2',
        }));
      });
      if (i === 3) {
        svg.appendChild(svgEl('rect', { x: x - 3, y: top(i) - 3, width: width + 6, height: 24, rx: 4, style: 'fill: none; stroke: var(--tier-1); stroke-width: 1.6' }));
      }
      if (i < 3) {
        // From the middle of this match to the open slot of the next.
        const to = i === 2 ? top(i + 1) + 4 : top(i + 1) + 14;
        const mid = x + width + 4.5;
        svg.appendChild(svgEl('path', {
          d: `M${x + width} ${top(i) + 9} H${mid} V${to} H${x + 37}`,
          style: 'fill: none; stroke: var(--ink-faint); stroke-width: 1.4',
        }));
      }
    }
  } else if (id === 'ladder') {
    // Clubs of both divisions stacked on one rating axis, low to high.
    svg.appendChild(svgEl('line', { class: 'explore-thumb__avg', x1: 14, x2: 146, y1: 72, y2: 72 }));
    [[24, 0, 2], [36, 0, 2], [36, 1, 2], [50, 0, 2], [62, 0, 2], [62, 1, 2], [62, 2, 1], [76, 0, 2], [76, 1, 1],
      [90, 0, 1], [90, 1, 2], [104, 0, 1], [104, 1, 1], [118, 0, 1], [118, 1, 1], [134, 0, 1]].forEach(([x, level, tier]) => {
      svg.appendChild(svgEl('circle', { cx: x, cy: 62 - level * 13, r: 5.5, style: `fill: var(--tier-${tier})` }));
    });
  } else {
    svg.appendChild(svgEl('line', { class: 'explore-thumb__avg', x1: 82, x2: 82, y1: 10, y2: 80 }));
    svg.appendChild(svgEl('line', { class: 'explore-thumb__avg', x1: 16, x2: 144, y1: 46, y2: 46 }));
    for (const [x, y] of [[128, 20], [112, 30], [98, 18], [90, 54], [72, 36], [62, 60], [54, 28], [40, 68], [118, 62], [34, 44], [76, 72], [104, 40]]) {
      svg.appendChild(svgEl('circle', { cx: x, cy: y, r: 5.5, style: `fill: ${seqColor((x - y + 40) / 140)}` }));
    }
  }
  return svg;
}

/* Open a visualisation (or, with null, go back to the gallery). The card's
   thumbnail grows into the view it opens, and the view shrinks back into its
   card on the way back: one shared view-transition name, on the thumbnail
   before and the view after (or the other way round). The mountain fills the
   window, so the thumbnail grows to the window. The others run long down the
   page, so it grows only to the panel's width, in its own 16:9 shape, at the
   top of the view: a box laid there for the move (.explore-morph) and taken
   away after it. */
function openExplore(id) {
  const from = state.exploreItem;
  const update = () => {
    state.exploreItem = id;
    if (id === 'whatif') { state.whatIfWeek = null; state.whatIfView = 'week'; }
    render();
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  const thumb = (item) => document.querySelector(`.explore-card[data-item="${item}"] .explore-card__thumb`);
  const view = (item) => {
    if (item === 'mountain') return $('.mountain');
    const box = el('div', 'explore-morph');
    $('#explore-body').prepend(box);
    return box;
  };
  const before = id ? thumb(id) : from && view(from);
  if (!before || !document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return;
  }
  const root = document.documentElement;
  root.style.setProperty('--view-scroll', `${window.scrollY}px`);
  root.dataset.transition = 'explore';
  before.style.viewTransitionName = 'explore-open';
  let after = null;
  document.startViewTransition(() => {
    before.style.viewTransitionName = '';
    update();
    after = id ? view(id) : thumb(from);
    if (after) after.style.viewTransitionName = 'explore-open';
  }).finished.finally(() => {
    if (after) after.style.viewTransitionName = '';
    if (after?.classList.contains('explore-morph')) after.remove();
    delete root.dataset.transition;
  });
}

const EXPLORE_SCRIPTS = {
  mountain: ['/app/explore-mountain.js'],
  luck: ['/app/explore-luck.js'],
  referees: ['/app/explore-referees-data.js', '/app/explore-referees.js'],
  races: ['/app/explore-mountain.js', '/app/explore-races.js'],
  runin: ['/app/explore-runin.js'],
  playoff: ['/app/explore-playoff.js'],
};
let exploreLoadToken = 0;

function renderExplore(report) {
  const item = EXPLORE_ITEMS.includes(state.exploreItem) ? state.exploreItem : null;
  $('#explore-title').textContent = t(item ? `explore.${item}.title` : 'explore.title');
  $('#explore-desc').textContent = t(item ? `explore.${item}.desc` : 'explore.desc');
  const back = $('#explore-back');
  back.hidden = !item;
  back.onclick = () => goBackOr(() => openExplore(null));
  const body = $('#explore-body');
  if (item !== 'mountain' && typeof mountainStop === 'function') mountainStop();
  if (item !== 'whatif') whatIfLeave();

  const drawItem = (which) => {
    if (which === 'mountain') return renderMountain(report, body);
    if (which === 'luck') return renderLuck(report, body);
    if (which === 'referees') return renderReferees(report, body);
    if (which === 'races') return renderTimeAxis(which, report, body, renderRaces, false);
    if (which === 'runin') return renderTimeAxis(which, report, body, renderRunIn, true);
    if (which === 'playoff') return renderPlayoff(report, body);
  };
  const ready = {
    mountain: () => typeof renderMountain === 'function',
    luck: () => typeof renderLuck === 'function',
    referees: () => typeof renderReferees === 'function',
    races: () => typeof renderRaces === 'function',
    runin: () => typeof renderRunIn === 'function',
    playoff: () => typeof renderPlayoff === 'function',
  };

  if (item === 'attack') return renderAttackMap(report, body);
  if (item === 'whatif') return renderWhatIf(report, body);
  if (item && EXPLORE_SCRIPTS[item]) {
    if (ready[item]()) return drawItem(item);
    const token = ++exploreLoadToken;
    body.replaceChildren(el('p', 'explore-empty', t('status.loading')));
    loadScriptsInOrder(EXPLORE_SCRIPTS[item]).then(() => {
      if (token === exploreLoadToken && state.activeView === 'explore' && state.exploreItem === item) drawItem(item);
    }).catch((error) => {
      if (token !== exploreLoadToken) return;
      console.warn(`[Explore] ${item} could not load`, error);
      track('load_error', { file: `explore-${item}`, message: error.message });
      const retry = el('button', 'pbtn', t('status.retry'));
      retry.type = 'button';
      retry.addEventListener('click', () => renderExplore(report));
      body.replaceChildren(el('p', 'explore-empty', t('status.couldNotLoadSeason')), retry);
    });
    return;
  }
  const gallery = el('div', 'explore-gallery');
  for (const id of EXPLORE_ITEMS) {
    const card = el('button', 'explore-card');
    card.type = 'button';
    card.dataset.item = id;
    card.appendChild(exploreThumb(id));
    card.appendChild(el('span', 'explore-card__title', t(`explore.${id}.title`)));
    card.appendChild(el('span', 'explore-card__desc', t(`explore.${id}.desc`)));
    card.addEventListener('click', () => openExplore(id));
    gallery.appendChild(card);
  }
  body.replaceChildren(gallery);
}

/* Key figures under a visualisation: each a number, what it is, and one
   sentence on how to read it. */
function exploreFacts(facts) {
  const box = el('div', 'explore-facts');
  box.appendChild(el('h3', 'explore-facts__title', t('explore.facts')));
  const grid = el('div', 'explore-facts__grid');
  for (const { value, label, text } of facts) {
    const fact = el('div', 'explore-fact');
    fact.appendChild(el('b', 'explore-fact__value', value));
    fact.appendChild(el('span', 'explore-fact__label', label));
    fact.appendChild(el('p', 'explore-fact__text', text));
    grid.appendChild(fact);
  }
  box.appendChild(grid);
  return box;
}

/* Each club where its expected goals put it: chances made across, chances
   given up down with the fewest at the top, crossed at the division average. */
function renderAttackMap(report, body) {
  const rows = report.table.filter((row) => row.attack != null && row.defence != null);
  if (!rows.length) {
    body.replaceChildren(el('p', 'explore-empty', t('attack.empty')));
    return;
  }
  const wrap = el('div', 'attack-map');
  const svg = svgEl('svg', { class: 'chart', role: 'group', 'aria-label': t('attack.aria') });
  wrap.appendChild(svg);
  body.replaceChildren(wrap);

  const box = wrap.getBoundingClientRect().width || 940;
  const narrow = box < SHAPE_NARROW;
  const width = narrow ? Math.round(box) : 940;
  const height = narrow ? width : 540;
  const pad = narrow ? { top: 30, right: 14, bottom: 34, left: 38 } : { top: 34, right: 24, bottom: 40, left: 48 };
  const crest = narrow ? 24 : 32;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const step = narrow ? 0.5 : 0.25;
  const domain = (values) => [
    Math.floor((Math.min(...values) - 0.1) / step) * step,
    Math.ceil((Math.max(...values) + 0.1) / step) * step,
  ];
  const [a0, a1] = domain(rows.map((row) => row.attack));
  const [d0, d1] = domain(rows.map((row) => row.defence));
  const right = width - pad.right;
  const bottom = height - pad.bottom;
  const x = (value) => pad.left + ((value - a0) / (a1 - a0)) * (right - pad.left);
  const y = (value) => pad.top + ((value - d0) / (d1 - d0)) * (bottom - pad.top);
  const text = (className, content, attrs) => {
    const node = svgEl('text', { class: className, ...attrs });
    node.textContent = content;
    svg.appendChild(node);
  };

  for (let i = 0; a0 + i * step <= a1 + 1e-9; i += 1) {
    const value = a0 + i * step;
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: x(value), x2: x(value), y1: pad.top, y2: bottom }));
    text('tick', num(value, 2), { x: x(value), y: bottom + 14, 'text-anchor': 'middle' });
  }
  for (let i = 0; d0 + i * step <= d1 + 1e-9; i += 1) {
    const value = d0 + i * step;
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: pad.left, x2: right, y1: y(value), y2: y(value) }));
    text('tick', num(value, 2), { x: pad.left - 6, y: y(value) + 3.5, 'text-anchor': 'end' });
  }

  const mean = (key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
  // The division's trend, by orthogonal regression since neither axis is the
  // outcome of the other. Along it, how good a club is overall; above it, a
  // club defends better than its attack would suggest, below it, the other way
  // round. Sixteen clubs leave one season's slope to chance, so these clubs
  // are pooled with the division's earlier seasons (`attack_trend`, each
  // season centred on its own mean); the line runs through this season's
  // average club.
  const [ma, md] = [mean('attack'), mean('defence')];
  let [sxx, syy, sxy] = [0, 0, 0];
  for (const row of rows) {
    const [da, dd] = [row.attack - ma, row.defence - md];
    sxx += da * da;
    syy += dd * dd;
    sxy += da * dd;
  }
  const pooled = report.attack_trend;
  const [pxx, pyy, pxy] = pooled ? [sxx + pooled.sxx, syy + pooled.syy, sxy + pooled.sxy] : [sxx, syy, sxy];
  const fit = pxy ? (pyy - pxx + Math.hypot(pyy - pxx, 2 * pxy)) / (2 * pxy) : 0;

  // Reference lines, defence = slope * attack + offset. Each label runs along
  // its line, at the stretch furthest from the crests and the corner labels.
  const diagonals = fit ? [[fit, md - fit * ma, 'attack-map__even', t('attack.trend')]] : [];
  const obstacles = rows.map((row) => [x(row.attack), y(row.defence)]);
  for (const [cx, cy, dir] of [[pad.left, pad.top + 10, 1], [right, bottom - 12, -1]]) {
    for (let s = 0; s <= 240; s += 30) obstacles.push([cx + dir * s, cy]);
  }
  for (const [slope, offset, className, content] of diagonals) {
    const defenceAt = (attack) => slope * attack + offset;
    const [e0, e1] = [(d0 - offset) / slope, (d1 - offset) / slope]; // where it leaves the defence range
    const lo = Math.max(a0, Math.min(e0, e1));
    const hi = Math.min(a1, Math.max(e0, e1));
    if (lo >= hi) continue;
    const [x1, y1, x2, y2] = [x(lo), y(defenceAt(lo)), x(hi), y(defenceAt(hi))];
    svg.appendChild(svgEl('line', { class: className, x1, y1, x2, y2 }));
    const label = svgEl('text', { class: 'attack-map__diag' });
    label.textContent = content;
    svg.appendChild(label);
    const length = label.getComputedTextLength();
    const span = Math.hypot(x2 - x1, y2 - y1);
    const [ux, uy] = [(x2 - x1) / span, (y2 - y1) / span];
    let best = null;
    for (let f = 0.03; f * span + length <= 0.97 * span; f += 0.02) {
      const [sx, sy] = [x1 + ux * f * span, y1 + uy * f * span];
      let clearance = Infinity;
      for (let s = 0; s <= length; s += length / 4 || 1) {
        for (const [ox, oy] of obstacles) clearance = Math.min(clearance, Math.hypot(sx + ux * s - ox, sy + uy * s - oy));
      }
      if (!best || clearance > best.clearance) best = { clearance, sx, sy };
    }
    if (!best) { label.remove(); continue; }
    const angle = (Math.atan2(uy, ux) * 180) / Math.PI;
    label.setAttribute('x', best.sx);
    label.setAttribute('y', best.sy - 5);
    label.setAttribute('transform', `rotate(${angle.toFixed(2)} ${best.sx} ${best.sy})`);
  }
  // The two sides of the trend, in the corners each one points to.
  text('attack-map__quad', t('attack.side.defence'), { x: pad.left + 6, y: pad.top + 14 });
  text('attack-map__quad', t('attack.side.attack'), { x: right - 6, y: bottom - 8, 'text-anchor': 'end' });
  // Which way is better, next to what each axis measures.
  const guide = (attrs, parts) => {
    const node = svgEl('text', attrs);
    parts.forEach(([className, content], i) => {
      const span = svgEl('tspan', { class: className, dx: i ? 8 : 0 });
      span.textContent = content;
      node.appendChild(span);
    });
    svg.appendChild(node);
  };
  guide({ x: right, y: height - 6, 'text-anchor': 'end' }, [['axis-title', t('attack.x')], ['attack-map__guide', t('attack.betterAttack')]]);
  guide({ x: pad.left, y: pad.top - 12 }, [['attack-map__guide', t('attack.betterDefence')], ['axis-title', t('attack.y')]]);

  // Which side of the trend a club is on, read along the axis that side is
  // better on: above it, how much less it concedes than the trend gives its
  // attack; below it, how much more it creates than the trend gives its
  // defence. `distance`, square to the line, ranks both sides alike.
  const balanceOf = (row) => {
    const conceded = md + fit * (row.attack - ma) - row.defence;
    const distance = conceded / Math.hypot(1, fit);
    return conceded > 0
      ? { side: 'defence', distance, v: conceded }
      : { side: 'attack', distance, v: row.attack - ma - (row.defence - md) / fit };
  };
  const balanceText = (b) => t(b.side === 'defence' ? 'attack.balanceDefence' : 'attack.balanceAttack', { v: num(b.v, 2) });

  for (const row of rows) {
    const cx = x(row.attack);
    const cy = y(row.defence);
    const tip = t('attack.tip', { for: num(row.attack, 2), against: num(row.defence, 2) });
    let balance = '';
    if (fit) {
      const b = balanceOf(row);
      balance = Math.abs(b.distance) < 0.05 ? t('attack.balanced') : balanceText(b);
    }
    const lines = [tip, balance].filter(Boolean);
    const club = svgEl('g', { class: 'attack-map__club', tabindex: 0, role: 'button', 'aria-label': `${row.team}: ${lines.join('. ')}` });
    club.appendChild(svgEl('circle', { cx, cy, r: crest / 2 + 2 }));
    club.appendChild(svgEl('image', { href: `/logos/${row.team_id}.webp`, x: cx - crest / 2, y: cy - crest / 2, width: crest, height: crest }));
    attachTip(club, `<b>${esc(row.team)}</b><br>${lines.join('<br>')}`);
    club.addEventListener('click', () => openTeamView(row.team_id, row.team));
    club.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openTeamView(row.team_id, row.team);
    });
    svg.appendChild(club);
  }

  if (!fit) return;
  const ranked = [...rows].sort((a, b) => balanceOf(b).distance - balanceOf(a).distance);
  const [defenceLed, attackLed] = [ranked[0], ranked[ranked.length - 1]];
  wrap.appendChild(exploreFacts([
    { value: num(Math.abs(fit), 2), label: t('attack.fact.slope'), text: pooled
      ? t('attack.fact.slopePooledText', { v: num(Math.abs(fit), 2), from: pooled.first, to: report.league.season })
      : t('attack.fact.slopeText', { v: num(Math.abs(fit), 2) }) },
    { value: num(sxy / Math.sqrt(sxx * syy), 2), label: t('attack.fact.r'), text: t('attack.fact.rText') },
    { value: attackLed.team, label: t('attack.fact.attack'), text: `${balanceText(balanceOf(attackLed))}.` },
    { value: defenceLed.team, label: t('attack.fact.defence'), text: `${balanceText(balanceOf(defenceLed))}.` },
  ]));
}

/* ---------- explore: shared by the further views ---------------------- */

/* One fetch per report file, kept for the page's life: the season mountain's
   layers, the scorecard's seasons and the time-axis views' other days. */
const mountainReports = new Map();
const fetchedReport = (url) => {
  if (!mountainReports.has(url)) {
    mountainReports.set(url, fetch(url)
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
      .catch((error) => { mountainReports.delete(url); throw error; }));
    // A phone scrubbing through seasons would otherwise keep every parsed report.
    if (mountainReports.size > 30) mountainReports.delete(mountainReports.keys().next().value);
  }
  return mountainReports.get(url);
};

/* The views with a time axis of their own carry time across the chart, so
   they take no rewind: they read the season's latest report, not a rewound
   one. A finished season has nothing left to run in, so the ones that look
   ahead (`runIn`) stand where its last RUN_IN_ROUNDS rounds began, the point
   from which pipeline.py marks the decisive matches. */
const RUN_IN_ROUNDS = 10;
let timeAxisToken = 0;

/* The first matchday with at most RUN_IN_ROUNDS rounds' worth of matches
   left, or null. */
function runInStart(report) {
  const total = report.model.matches_played + report.model.matches_remaining;
  const left = RUN_IN_ROUNDS * Math.floor(report.table.length / 2);
  const day = (report.league.matchdays || []).find((d) => !d.preseason && total - d.matches_played <= left);
  return day ? day.date : null;
}

async function renderTimeAxis(item, report, body, draw, runIn) {
  const token = ++timeAxisToken;
  const { season, slug } = report.league;
  let shown = report;
  let from = null;
  try {
    if (state.asof) shown = applyShortNames(await fetchedReport(reportUrl(season)))[slug];
    from = runIn && !shown.model.matches_remaining ? runInStart(shown) : null;
    if (from) shown = applyShortNames(await fetchedReport(reportUrl(season, from)))[slug];
  } catch (error) {
    if (token === timeAxisToken) body.replaceChildren(el('p', 'explore-empty', t('status.couldNotLoad', { season, error: error.message })));
    return;
  }
  if (token !== timeAxisToken || state.activeView !== 'explore' || state.exploreItem !== item) return;
  draw(shown, body);
  if (from && !body.firstChild.matches('.explore-empty')) {
    body.firstChild.prepend(el('p', 'explore-note explore-note--lead', t('explore.runInFrom', { date: whenDate(from) })));
  }
}

if (typeof module !== 'undefined') {
  module.exports = { RUN_IN_ROUNDS, runInStart };
}
