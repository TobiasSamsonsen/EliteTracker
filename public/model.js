/* The model page (model.html): the language switch and the figures. The
   figures repeat the model's own arithmetic (src/elitetracker/model) on the
   published report; tests/frontend.test.js pins it to the Python model's
   numbers. */

// The version the page's text describes; a newer one in the report raises a note.
const PAGE_VERSION = 'elo-v16.0';
// Not in the report: the xG margin and its smoothing (model/elo.py) and the
// grid's goal cap (model/attack_defence.py).
const XG_MARGIN = 0.12;
const XG_SMOOTHING = 0.25;
const GOAL_CAP = 8;
// elo-v16.0's settings, for the figures until the report is in (or if it
// never comes).
const DEFAULTS = {
  k_factor: 30, home_advantage: 60, xg_alpha: 0.3, draw_base: 0.26, draw_scale: 375,
  stakes: { elo: 30, goals: 0.05, tau: 0.8, from: 24 },
  attack_defence: { base: 0.37, home: 0.22, rho: -0.05, spread: 1.1, outcome_blend: 0.25 },
};

/* ---------- the model's arithmetic ---------------------------------- */

function expectedScore(gap) {
  return 1 / (1 + 10 ** (-gap / 400));
}

/* model/probabilities.py: home win, draw, away win at an effective gap
   (home advantage included). */
function eloOdds(gap, model) {
  const expected = expectedScore(gap);
  const draw = Math.min(model.draw_base * Math.exp(-((gap / model.draw_scale) ** 2)),
    2 * Math.min(expected, 1 - expected));
  return [expected - draw / 2, draw, 1 - expected - draw / 2];
}

/* model/elo.py xg_implied_score: P(home win) + P(draw) / 2 at the two xG
   rates, to 12 goals a side and normalised. */
function xgScore(homeXg, awayXg) {
  let pHome = Math.exp(-homeXg);
  let pAway = Math.exp(-awayXg);
  let awayBelow = 0;
  let home = 0;
  let draw = 0;
  let homeMass = 0;
  for (let k = 0; k <= 12; k += 1) {
    if (k) {
      pHome *= homeXg / k;
      pAway *= awayXg / k;
    }
    home += pHome * awayBelow;
    draw += pHome * pAway;
    awayBelow += pAway;
    homeMass += pHome;
  }
  return (home + 0.5 * draw) / (homeMass * awayBelow);
}

/* model/elo.py updated_pair, taken apart: the home side's change from the
   result, from the xG-implied score and from the xG margin. Without xG the
   result is all of it. */
function ratingChange(homeRating, awayRating, homeGoals, awayGoals, homeXg, awayXg, model) {
  const k = model.k_factor;
  const expected = expectedScore(homeRating + model.home_advantage - awayRating);
  const result = homeGoals > awayGoals ? 1 : homeGoals < awayGoals ? 0 : 0.5;
  if (homeXg == null || awayXg == null) {
    const change = k * (result - expected);
    return { expected, result, parts: [change, 0, 0], total: change };
  }
  const alpha = model.xg_alpha;
  const xg = xgScore(homeXg, awayXg);
  const ratio = Math.log((homeXg + XG_SMOOTHING) / (awayXg + XG_SMOOTHING));
  const margin = Math.sign(ratio) * XG_MARGIN * Math.log(1 + Math.abs(ratio));
  const parts = [k * (1 - alpha) * (result - expected), k * alpha * (xg - expected), k * margin];
  return { expected, result, xg, ratio, margin, parts, total: parts[0] + parts[1] + parts[2] };
}

/* model/attack_defence.py rates: each side's [attack, defence, finishing,
   keeping] as the report carries them. */
function goalRates(home, away, ad) {
  const lam = Math.exp(ad.base + ad.home + ad.spread * (home[0] - away[1] + home[2] - away[3]));
  const mu = Math.exp(ad.base + ad.spread * (away[0] - home[1] + away[2] - home[3]));
  return [lam, mu];
}

function poisson(mean, cap) {
  const out = [Math.exp(-mean)];
  for (let k = 1; k <= cap; k += 1) out.push((out[k - 1] * mean) / k);
  return out;
}

/* Dixon and Coles' correction on the four low scores. */
function lowScore(i, j, lam, mu, rho) {
  if (i === 0 && j === 0) return 1 - lam * mu * rho;
  if (i === 0 && j === 1) return 1 + lam * rho;
  if (i === 1 && j === 0) return 1 + mu * rho;
  if (i === 1 && j === 1) return 1 - rho;
  return 1;
}

/* score_grid: P(home scores i, away scores j) for i, j up to GOAL_CAP. */
function scoreGrid(lam, mu, rho) {
  const home = poisson(lam, GOAL_CAP);
  const away = poisson(mu, GOAL_CAP);
  const grid = home.map((p, i) => away.map((q, j) => p * q * Math.max(lowScore(i, j, lam, mu, rho), 0)));
  const total = grid.flat().reduce((sum, value) => sum + value, 0);
  return grid.map((row) => row.map((value) => value / total));
}

function outcomeOf(i, j) {
  return i > j ? 0 : i === j ? 1 : 2;
}

function gridOdds(grid) {
  const odds = [0, 0, 0];
  grid.forEach((row, i) => row.forEach((value, j) => { odds[outcomeOf(i, j)] += value; }));
  return odds;
}

/* blend_outcomes: a geometric blend, `weight` on the Elo odds. */
function blendOdds(elo, own, weight) {
  const raw = elo.map((value, o) => value ** weight * own[o] ** (1 - weight));
  const total = raw[0] + raw[1] + raw[2];
  return raw.map((value) => value / total);
}

/* conditional_scorelines: who wins from `odds`, how many goals from the grid. */
function scorelines(grid, odds) {
  const own = gridOdds(grid);
  return grid.map((row, i) => row.map((value, j) => {
    const o = outcomeOf(i, j);
    return own[o] > 0 ? (value * odds[o]) / own[o] : 0;
  }));
}

/* model/stakes.py pressure. */
function pressure(distance, left, tau) {
  return Math.exp(-Math.max(0, distance - 1) / (tau * Math.max(left, 1)));
}

/* ---------- words ---------------------------------------------------- */

const TEXT = {
  no: {
    title: 'Slik fungerer modellen — EliteTracker',
    description: 'Hvordan EliteTracker regner ut ratinger, kampodds og tabellsjanser for Eliteserien og OBOS-ligaen: kort forklart, og med alle formlene.',
    home: 'Hjemmeseier', draw: 'Uavgjort', away: 'Borteseier',
    gapAria: 'Linjediagram: sjansen for hjemmeseier, uavgjort og borteseier ut fra ratingforskjellen mellom lagene, med hjemmefordel',
    gapReadout: 'Ratingforskjell {diff}, så Δ = {diff} + {h} = {gap}: hjemmeseier {home}, uavgjort {d}, borteseier {a}. Forventet poengandel E = {e}.',
    even: 'Jevnt ved {x}',
    partResult: 'Resultatet', partXg: 'xG-poengene', partMargin: 'xG-marginen', partTotal: 'Endring',
    updateAria: 'Søylediagram: hjemmelagets ratingendring, delt i resultat, xG-poeng og xG-margin',
    updateValues: 'E = {e}, W = {w}, X = {x}, r = {r}, S = {s}. Hjemmelaget {change} poeng, bortelaget {opposite}.',
    updateNoXg: 'E = {e}, W = {w}; uten xG er S = W. Hjemmelaget {change} poeng, bortelaget {opposite}.',
    updateBad: 'Fyll inn ratinger og mål.',
    ratingHome: 'Hjemmelagets rating', ratingAway: 'Bortelagets rating', goalsHome: 'Hjemmelagets mål',
    goalsAway: 'Bortelagets mål', xgHome: 'Hjemmelagets xG', xgAway: 'Bortelagets xG',
    rowElo: 'Elo', rowPois: 'Målmodellen', rowBlend: 'Blandet',
    barsAria: 'Stablede søyler: oddsene fra Elo, fra målmodellen og blandet',
    heatAria: 'Rutenett: sjansen for hvert resultat, hjemmelagets mål nedover og bortelagets bortover',
    homeGoals: 'Hjemmelagets mål', awayGoals: 'Bortelagets mål',
    eloLine: 'Elo: Δ = {home} + {h}{surface} − {away} = {gap}.',
    surface: ' + {s} (underlag)',
    goalsLine: 'Målmodellen: {home} {lam} – {mu} {away} i forventede mål.',
    published: 'Publisert for kampen {date}, med tabellinnsats: hjemmeseier {h}, uavgjort {d}, borteseier {a}.',
    top: 'Mest sannsynlige resultater: {list}.',
    sameClub: 'Velg to forskjellige klubber.',
    noReport: 'Dagens tall kunne ikke lastes, så figurene med klubber står tomme.',
    loading: 'Laster dagens tall …',
    left: '{n} kamper igjen',
    stakesAria: 'Linjediagram: presset Π ut fra avstanden til nærmeste strek, for 2, 5 og 10 kamper igjen',
    distanceAxis: 'Poeng fra nærmeste strek',
    stakesTip: '{m} poeng fra streken',
    seasonAria: 'Søylediagram: sjansen for hver sluttplassering',
    place: '{n}. plass',
    seasonSummary: '{club}: forventet {pts} poeng. Mest sannsynlig {place} ({p}).',
    tablePlace: 'Plass', tableChance: 'Sjanse', tableView: 'Vis som tabell',
    versionNote: 'Modellen er oppdatert til {live} siden denne siden ble skrevet for {page}. Prinsippene står seg, men enkelte tall kan ha endret seg; de gjeldende innstillingene står i modellkortet.',
  },
  en: {
    title: 'How the model works — EliteTracker',
    description: 'How EliteTracker works out ratings, match odds and table chances for Eliteserien and OBOS-ligaen: in plain words, and with every formula.',
    home: 'Home win', draw: 'Draw', away: 'Away win',
    gapAria: 'Line chart: the chance of a home win, a draw and an away win by the difference between the two ratings, home advantage included',
    gapReadout: 'Rating difference {diff}, so Δ = {diff} + {h} = {gap}: home win {home}, draw {d}, away win {a}. Expected score E = {e}.',
    even: 'Even at {x}',
    partResult: 'The result', partXg: 'The xG score', partMargin: 'The xG margin', partTotal: 'Change',
    updateAria: 'Bar chart: the home side’s rating change, split into the result, the xG score and the xG margin',
    updateValues: 'E = {e}, W = {w}, X = {x}, r = {r}, S = {s}. Home side {change} points, away side {opposite}.',
    updateNoXg: 'E = {e}, W = {w}; without xG, S = W. Home side {change} points, away side {opposite}.',
    updateBad: 'Fill in the ratings and goals.',
    ratingHome: 'Home rating', ratingAway: 'Away rating', goalsHome: 'Home goals',
    goalsAway: 'Away goals', xgHome: 'Home xG', xgAway: 'Away xG',
    rowElo: 'Elo', rowPois: 'Goals model', rowBlend: 'Blended',
    barsAria: 'Stacked bars: the odds from Elo, from the goals model and blended',
    heatAria: 'Grid: the chance of each scoreline, home goals down and away goals across',
    homeGoals: 'Home goals', awayGoals: 'Away goals',
    eloLine: 'Elo: Δ = {home} + {h}{surface} − {away} = {gap}.',
    surface: ' + {s} (surface)',
    goalsLine: 'Goals model: {home} {lam} – {mu} {away} in expected goals.',
    published: 'Published for the match on {date}, with table stakes: home win {h}, draw {d}, away win {a}.',
    top: 'Likeliest scorelines: {list}.',
    sameClub: 'Pick two different clubs.',
    noReport: 'Today’s numbers could not be loaded, so the figures with clubs are empty.',
    loading: 'Loading today’s numbers …',
    left: '{n} matches left',
    stakesAria: 'Line chart: the pressure Π by distance to the nearest line, for 2, 5 and 10 matches left',
    distanceAxis: 'Points from the nearest line',
    stakesTip: '{m} points from the line',
    seasonAria: 'Bar chart: the chance of each finishing place',
    place: '{n}{suffix} place',
    seasonSummary: '{club}: {pts} points expected. Most likely {place} ({p}).',
    tablePlace: 'Place', tableChance: 'Chance', tableView: 'Show as a table',
    versionNote: 'The model has moved on to {live} since this page was written for {page}. The ideas stand, but some numbers may have changed; the settings in force are in the model card.',
  },
};

const lang = () => (document.documentElement.dataset.lang === 'en' ? 'en' : 'no');
const t = (key, values = {}) => TEXT[lang()][key].replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
const locale = () => (lang() === 'en' ? 'en-GB' : 'nb-NO');

/* As on the front page: a decimal point in both languages (AGENTS.md), and
   each language's grouping, none at four digits so ratings read "1563". */
function fmt(value, digits = 0) {
  return new Intl.NumberFormat(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: 'min2' })
    .formatToParts(value).map((part) => (part.type === 'decimal' ? '.' : part.value)).join('');
}

function pct(value, digits = 0) {
  return `${fmt(value * 100, digits)}${lang() === 'en' ? '' : ' '}%`;
}

function signed(value, digits = 0) {
  const shown = fmt(Math.abs(value), digits);
  if (Number(shown) === 0) return shown;
  return `${value > 0 ? '+' : '−'}${shown}`;
}

function ordinal(n) {
  const suffix = n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd'
    : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th';
  return t('place', { n, suffix });
}

function shortDate(iso) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'long' });
}

/* ---------- drawing ------------------------------------------------- */

let report = null;
let reportFailed = false;
const model = () => report?.eliteserien?.model || DEFAULTS;

function svg(tag, attributes = {}, parent = null) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (parent) parent.appendChild(node);
  return node;
}

function text(parent, x, y, content, anchor = 'start', className = 'tick') {
  const node = svg('text', { x, y, 'text-anchor': anchor, class: className }, parent);
  node.textContent = content;
  return node;
}

function frame(chart, height, [top, right, bottom, left], label) {
  const width = Math.max(chart.clientWidth, 260);
  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': label });
  chart.replaceChildren(root);
  return { root, width, height, left, right: width - right, top, bottom: height - bottom };
}

const linear = (d0, d1, r0, r1) => (value) => r0 + ((value - d0) / (d1 - d0)) * (r1 - r0);

/* A bar from `base` to `end` along x, its data end rounded. */
function barPath(base, end, top, height, radius = 4) {
  const r = Math.min(radius, Math.abs(end - base), height / 2);
  const dir = end >= base ? 1 : 0;
  const inner = end - (dir ? r : -r);
  const bottom = top + height;
  return `M${base},${top}H${inner}A${r},${r} 0 0 ${dir} ${end},${top + r}V${bottom - r}`
    + `A${r},${r} 0 0 ${dir} ${inner},${bottom}H${base}Z`;
}

/* The same, upright: from `base` up to `end` along y. */
function columnPath(x, width, base, end, radius = 4) {
  const r = Math.min(radius, Math.abs(base - end), width / 2);
  return `M${x},${base}V${end + r}A${r},${r} 0 0 1 ${x + r},${end}H${x + width - r}`
    + `A${r},${r} 0 0 1 ${x + width},${end + r}V${base}Z`;
}

/* Ink for a label set inside a fill: dark on light fills, white on dark. */
function inkOn(cssColor) {
  const probe = document.createElement('span');
  probe.style.color = cssColor;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
  probe.remove();
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? '#0f1828' : '#ffffff';
}

const tip = document.createElement('div');
tip.className = 'tip';
tip.hidden = true;

function showTip(event, lines) {
  tip.replaceChildren(...lines.map((line, i) => {
    const row = document.createElement(i ? 'div' : 'b');
    row.textContent = line;
    return row;
  }));
  tip.hidden = false;
  const x = Math.min(event.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = event.clientY - tip.offsetHeight - 12;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${y < 8 ? event.clientY + 18 : y}px`;
}

function hideTip() {
  tip.hidden = true;
}

/* ---------- figure 1: odds from a rating difference ------------------ */

/* Along the bottom the plain difference R_H - R_A; home advantage goes on
   top of it (Δ = difference + h), so the chart shows it moving the lines. */
function setupGap(root) {
  const chart = root.querySelector('.fig__chart');
  const range = root.querySelector('input[type=range]');
  const readout = root.querySelector('.fig__readout');
  let diff = Number(range.value);
  let place = () => {};
  range.addEventListener('input', () => {
    diff = Number(range.value);
    place();
  });

  return function draw() {
    const m = model();
    const h = m.home_advantage;
    const odds = (d) => eloOdds(d + h, m);
    const f = frame(chart, 250, [18, 14, 30, 44], t('gapAria'));
    const x = linear(-500, 500, f.left, f.right);
    const y = linear(0, 1, f.bottom, f.top);
    const grid = svg('g', { class: 'grid' }, f.root);
    for (const value of [0, 0.25, 0.5, 0.75, 1]) {
      svg('line', { x1: f.left, x2: f.right, y1: y(value), y2: y(value) }, grid);
      text(f.root, f.left - 8, y(value) + 4, pct(value), 'end');
    }
    for (const value of [-400, -200, 0, 200, 400]) text(f.root, x(value), f.bottom + 20, signed(value), 'middle');

    // Where home win and away win are level: the visitors h points better.
    svg('line', { class: 'even', x1: x(-h), x2: x(-h), y1: f.top, y2: f.bottom }, f.root);
    // Left of the line where there is room; on a phone that would run into
    // the away line's name, so it goes right.
    const roomy = f.right - f.left >= 500;
    text(f.root, x(-h) + (roomy ? -6 : 6), f.top + 30, t('even', { x: signed(-h) }), roomy ? 'end' : 'start', 'direct halo');

    const steps = [];
    for (let d = -500; d <= 500; d += 5) steps.push([d, odds(d)]);
    const colours = ['var(--home)', 'var(--draw)', 'var(--away)'];
    colours.forEach((colour, o) => {
      const path = steps.map(([d, p], i) => `${i ? 'L' : 'M'}${x(d).toFixed(1)},${y(p[o]).toFixed(1)}`).join('');
      svg('path', { d: path, class: 'line', style: `stroke: ${colour}` }, f.root);
    });
    // Each line named where it stands clear: away high on the left, home
    // high on the right, the draw under its peak, where no other line runs.
    text(f.root, x(-500) + 2, y(odds(-500)[2]) - 9, t('away'), 'start', 'direct halo');
    text(f.root, x(500) - 2, y(odds(500)[0]) - 9, t('home'), 'end', 'direct halo');
    text(f.root, x(-h), y(odds(-h)[1]) + 18, t('draw'), 'middle', 'direct halo');

    const rule = svg('line', { class: 'crosshair', y1: f.top, y2: f.bottom }, f.root);
    const dots = colours.map((colour) => svg('circle', { r: 4.5, class: 'dot', style: `fill: ${colour}` }, f.root));
    place = () => {
      const p = odds(diff);
      rule.setAttribute('x1', x(diff));
      rule.setAttribute('x2', x(diff));
      dots.forEach((dot, o) => {
        dot.setAttribute('cx', x(diff));
        dot.setAttribute('cy', y(p[o]));
      });
      range.value = diff;
      readout.textContent = t('gapReadout', {
        diff: signed(diff), h: fmt(h), gap: signed(diff + h),
        home: pct(p[0]), d: pct(p[1]), a: pct(p[2]), e: fmt(expectedScore(diff + h), 3),
      });
    };
    place();

    const hit = svg('rect', { x: f.left, y: f.top, width: f.right - f.left, height: f.bottom - f.top, class: 'hit' }, f.root);
    const follow = (event) => {
      const box = hit.getBoundingClientRect();
      const share = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      diff = Math.round((-500 + share * 1000) / 5) * 5;
      place();
    };
    hit.addEventListener('pointermove', follow);
    hit.addEventListener('pointerdown', follow);
  };
}

/* ---------- figure 2: one rating change ----------------------------- */

const PRESETS = {
  lucky: [1600, 1600, 1, 0, 0.5, 1.9],
  deserved: [1600, 1600, 3, 0, 2.8, 0.4],
  upset: [1500, 1750, 2, 1, 1.6, 1.2],
  goals: [1600, 1600, 1, 0, '', ''],
};

function setupUpdate(root) {
  const chart = root.querySelector('.fig__chart');
  const readout = root.querySelector('.fig__readout');
  const names = ['ratingHome', 'ratingAway', 'goalsHome', 'goalsAway', 'xgHome', 'xgAway'];
  const inputs = ['hr', 'ar', 'hg', 'ag', 'hx', 'ax'].map((id) => root.querySelector(`#u-${id}`));
  const presets = [...root.querySelectorAll('[data-preset]')];
  const press = (key) => presets.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.preset === key)));
  // Text fields, not number fields: a number field drops a typed comma, so
  // "0,7" came through as 7. Here a comma reads as a point and spaces go.
  const read = (input) => {
    const value = input.value.replace(/\s/g, '').replace(',', '.');
    return value === '' ? null : Number(value);
  };

  for (const input of inputs) input.addEventListener('input', () => { press(null); draw(); });
  for (const button of presets) {
    button.addEventListener('click', () => {
      PRESETS[button.dataset.preset].forEach((value, i) => { inputs[i].value = value; });
      press(button.dataset.preset);
      draw();
    });
  }

  function draw() {
    inputs.forEach((input, i) => input.setAttribute('aria-label', t(names[i])));
    const [homeRating, awayRating, homeGoals, awayGoals, homeXg, awayXg] = inputs.map(read);
    if (![homeRating, awayRating, homeGoals, awayGoals].every(Number.isFinite)) {
      readout.textContent = t('updateBad');
      return;
    }
    const withXg = Number.isFinite(homeXg) && Number.isFinite(awayXg) && homeXg >= 0 && awayXg >= 0;
    const change = ratingChange(homeRating, awayRating, homeGoals, awayGoals,
      withXg ? homeXg : null, withXg ? awayXg : null, model());
    const rows = [
      [t('partResult'), change.parts[0]],
      [t('partXg'), change.parts[1]],
      [t('partMargin'), change.parts[2]],
      [t('partTotal'), change.total],
    ];
    const pitch = 34;
    const narrow = chart.clientWidth < 420;
    const f = frame(chart, rows.length * pitch + 14, [6, 46, 8, narrow ? 92 : 112], t('updateAria'));
    const span = Math.max(4, ...rows.map(([, value]) => Math.abs(value))) * 1.1;
    const x = linear(-span, span, f.left, f.right);
    svg('line', { x1: x(0), x2: x(0), y1: f.top, y2: f.bottom, class: 'zero' }, f.root);
    svg('line', { x1: 0, x2: f.right, y1: f.top + 3 * pitch + 2, y2: f.top + 3 * pitch + 2, class: 'rule' }, f.root);
    rows.forEach(([name, value], i) => {
      const top = f.top + i * pitch + (i === 3 ? 10 : 6);
      text(f.root, 0, top + 13, name, 'start', i === 3 ? 'row row--total' : 'row');
      if (Math.abs(value) >= 0.005) {
        svg('path', {
          d: barPath(x(0), x(value), top, 18),
          style: `fill: ${value > 0 ? 'var(--home)' : 'var(--away)'}`,
        }, f.root);
      }
      text(f.root, x(value) + (value >= 0 ? 6 : -6), top + 13, signed(value, 1), value >= 0 ? 'start' : 'end',
        i === 3 ? 'value value--total' : 'value');
    });
    const values = {
      e: fmt(change.expected, 3), w: fmt(change.result, 1), change: signed(change.total, 1),
      opposite: signed(-change.total, 1),
    };
    readout.textContent = withXg
      ? t('updateValues', {
        ...values, x: fmt(change.xg, 3), r: signed(change.ratio, 2), s: fmt(change.expected + change.total / model().k_factor, 3),
      })
      : t('updateNoXg', values);
  }
  return draw;
}

/* ---------- figure 3: a match, through both models ------------------ */

function clubs(league) {
  return [...report[league].table].sort((a, b) => a.team.localeCompare(b.team, 'nb'));
}

function leagueSwitch(root, onChange) {
  const buttons = [...root.querySelectorAll('[data-league]')];
  for (const button of buttons) {
    button.addEventListener('click', () => {
      buttons.forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
      onChange(button.dataset.league);
    });
  }
}

function fillSelect(select, rows, chosen) {
  select.replaceChildren(...rows.map((row) => {
    const option = document.createElement('option');
    option.value = row.team_id;
    option.textContent = row.team;
    return option;
  }));
  select.value = chosen;
}

function setupMatch(root) {
  const chart = root.querySelector('.fig__chart');
  const readout = root.querySelector('.fig__readout');
  const homeSelect = root.querySelector('#m-home');
  const awaySelect = root.querySelector('#m-away');
  let league = 'eliteserien';
  let filled = null;

  const populate = () => {
    const next = report[league].fixtures[0];
    const rows = clubs(league);
    fillSelect(homeSelect, rows, next ? next.home_id : rows[0].team_id);
    fillSelect(awaySelect, rows, next ? next.away_id : rows[1].team_id);
    filled = league;
  };
  leagueSwitch(root, (next) => { league = next; populate(); draw(); });
  homeSelect.addEventListener('change', () => draw());
  awaySelect.addEventListener('change', () => draw());

  function draw() {
    if (!report) {
      chart.replaceChildren();
      readout.textContent = reportFailed ? t('noReport') : t('loading');
      return;
    }
    if (filled !== league) populate();
    const homeId = homeSelect.value;
    const awayId = awaySelect.value;
    if (homeId === awayId) {
      chart.replaceChildren();
      readout.textContent = t('sameClub');
      return;
    }
    const data = report[league];
    const m = data.model;
    const ad = m.attack_defence;
    const row = (id) => data.table.find((club) => club.team_id === id);
    const home = row(homeId);
    const away = row(awayId);
    const grass = m.surface ? m.surface.grass : null;
    const edge = grass && grass.includes(homeId) !== grass.includes(awayId) ? m.surface.edge : 0;
    const gap = home.rating + edge + m.home_advantage - away.rating;
    const elo = eloOdds(gap, m);
    const [lam, mu] = goalRates(ad.teams[homeId], ad.teams[awayId], ad);
    const grid = scoreGrid(lam, mu, ad.rho);
    const own = gridOdds(grid);
    const blended = blendOdds(elo, own, ad.outcome_blend);
    const cells = scorelines(grid, blended);

    chart.replaceChildren();
    const bars = document.createElement('div');
    const heat = document.createElement('div');
    heat.className = 'heat';
    chart.append(bars, heat);
    drawOddsBars(bars, [[t('rowElo'), elo], [t('rowPois'), own], [t('rowBlend'), blended]]);
    drawHeat(heat, cells);

    const top = cells.flatMap((cellRow, i) => cellRow.map((value, j) => [i, j, value]))
      .sort((a, b) => b[2] - a[2]).slice(0, 5)
      .map(([i, j, value]) => `${i}–${j} ${pct(value)}`).join(', ');
    const fixture = data.fixtures.find((match) => match.home_id === homeId && match.away_id === awayId);
    const lines = [
      t('eloLine', {
        home: fmt(home.rating), h: fmt(m.home_advantage), away: fmt(away.rating), gap: signed(gap),
        surface: edge ? t('surface', { s: fmt(edge) }) : '',
      }),
      t('goalsLine', { home: home.team, away: away.team, lam: fmt(lam, 2), mu: fmt(mu, 2) }),
      t('top', { list: top }),
    ];
    if (fixture) {
      lines.push(t('published', {
        date: shortDate(fixture.date), h: pct(fixture.home_win), d: pct(fixture.draw), a: pct(fixture.away_win),
      }));
    }
    readout.replaceChildren(...lines.map((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      return p;
    }));
  }
  return draw;
}

function drawOddsBars(container, rows) {
  const width = Math.max(container.parentElement.clientWidth, 260);
  const labelWidth = width < 420 ? 96 : 116;
  const pitch = 34;
  const root = svg('svg', { width, height: rows.length * pitch + 4, viewBox: `0 0 ${width} ${rows.length * pitch + 4}`, role: 'img', 'aria-label': t('barsAria') });
  container.replaceChildren(root);
  const x = linear(0, 1, labelWidth, width - 2);
  const colours = ['var(--home)', 'var(--draw)', 'var(--away)'];
  const keys = ['home', 'draw', 'away'];
  rows.forEach(([name, odds], r) => {
    const top = r * pitch + 4;
    text(root, 0, top + 15, name, 'start', r === 2 ? 'row row--total' : 'row');
    const clip = svg('clipPath', { id: `odds-clip-${r}` }, root);
    svg('rect', { x: x(0), y: top, width: x(1) - x(0), height: 22, rx: 4 }, clip);
    const group = svg('g', { 'clip-path': `url(#odds-clip-${r})` }, root);
    let start = 0;
    odds.forEach((value, o) => {
      // A 2px surface gap between segments: each gives up 1px either side.
      const x0 = x(start) + (o ? 1 : 0);
      const x1 = x(start + value) - (o < 2 ? 1 : 0);
      const segment = svg('rect', { x: x0, y: top, width: Math.max(0, x1 - x0), height: 22, style: `fill: ${colours[o]}` }, group);
      segment.addEventListener('pointermove', (event) => showTip(event, [name, `${t(keys[o])}: ${pct(value, 1)}`]));
      segment.addEventListener('pointerleave', hideTip);
      if (x1 - x0 >= 40) {
        const label = text(root, (x0 + x1) / 2, top + 15, pct(value), 'middle', 'inside');
        label.style.fill = inkOn(colours[o]);
      }
      start += value;
    });
  });
}

function drawHeat(container, cells) {
  const shown = 7; // 0 to 6 goals; the rare 7+ stay in the sums
  const space = Math.min(container.parentElement.clientWidth, 420);
  const axis = 34;
  const size = Math.floor((space - axis - 4) / shown);
  const width = axis + size * shown + 4;
  const height = axis + size * shown + 4;
  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': t('heatAria') });
  container.replaceChildren(root);
  const peak = Math.max(...cells.flat());
  const ranked = cells.flat().sort((a, b) => b - a);
  const labelFrom = ranked[Math.min(5, ranked.length - 1)];
  text(root, axis + (size * shown) / 2, 11, t('awayGoals'), 'middle', 'axis-title');
  const side = text(root, 0, 0, t('homeGoals'), 'middle', 'axis-title');
  side.setAttribute('transform', `translate(11 ${axis + (size * shown) / 2}) rotate(-90)`);
  for (let k = 0; k < shown; k += 1) {
    text(root, axis + k * size + size / 2, axis - 6, String(k), 'middle');
    text(root, axis - 8, axis + k * size + size / 2 + 4, String(k), 'end');
  }
  for (let i = 0; i < shown; i += 1) {
    for (let j = 0; j < shown; j += 1) {
      const value = cells[i][j];
      const step = Math.min(7, 1 + Math.floor((value / peak) * 7));
      const colour = value < 0.002 ? 'var(--panel-sunk)' : `var(--seq-${step})`;
      const cell = svg('rect', {
        x: axis + j * size + 1, y: axis + i * size + 1, width: size - 2, height: size - 2, rx: 3, style: `fill: ${colour}`,
      }, root);
      cell.addEventListener('pointermove', (event) => showTip(event, [`${i}–${j}`, pct(value, 1)]));
      cell.addEventListener('pointerleave', hideTip);
      if (value >= labelFrom && size >= 30) {
        const label = text(root, axis + j * size + size / 2, axis + i * size + size / 2 + 4, pct(value), 'middle', 'inside');
        label.style.fill = inkOn(colour);
      }
    }
  }
}

/* ---------- figure 4: table stakes ---------------------------------- */

function setupStakes(root) {
  const chart = root.querySelector('.fig__chart');
  return function draw() {
    const tau = model().stakes.tau;
    const f = frame(chart, 240, [16, 16, 40, 44], t('stakesAria'));
    const x = linear(0, 15, f.left, f.right);
    const y = linear(0, 1, f.bottom, f.top);
    const grid = svg('g', { class: 'grid' }, f.root);
    for (const value of [0, 0.25, 0.5, 0.75, 1]) {
      svg('line', { x1: f.left, x2: f.right, y1: y(value), y2: y(value) }, grid);
      text(f.root, f.left - 8, y(value) + 4, fmt(value, 2), 'end');
    }
    for (let m = 0; m <= 15; m += 3) text(f.root, x(m), f.bottom + 18, String(m), 'middle');
    text(f.root, (f.left + f.right) / 2, f.bottom + 36, t('distanceAxis'), 'middle', 'axis-title');
    const series = [[2, 'var(--seq-4)'], [5, 'var(--seq-5)'], [10, 'var(--seq-7)']];
    for (const [left, colour] of series) {
      const d = [];
      for (let m = 0; m <= 15; m += 0.25) d.push(`${d.length ? 'L' : 'M'}${x(m).toFixed(1)},${y(pressure(m, left, tau)).toFixed(1)}`);
      svg('path', { d: d.join(''), class: 'line', style: `stroke: ${colour}` }, f.root);
      // Named at 8 points out, where the three stand furthest apart; a phone
      // has no room for them there, so the legend alone names them.
      if (f.right - f.left >= 420) {
        text(f.root, x(8) + 4, y(pressure(8, left, tau)) - 7, t('left', { n: left }), 'start', 'direct');
      }
    }
    // The crosshair shows only while the pointer is over the plot.
    const hover = svg('g', { visibility: 'hidden' }, f.root);
    const rule = svg('line', { class: 'crosshair', y1: f.top, y2: f.bottom }, hover);
    const dots = series.map(([, colour]) => svg('circle', { r: 4.5, class: 'dot', style: `fill: ${colour}` }, hover));
    const hit = svg('rect', { x: f.left, y: f.top, width: f.right - f.left, height: f.bottom - f.top, class: 'hit' }, f.root);
    hit.addEventListener('pointermove', (event) => {
      const box = hit.getBoundingClientRect();
      const m = Math.round(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * 15);
      rule.setAttribute('x1', x(m));
      rule.setAttribute('x2', x(m));
      const values = series.map(([left]) => pressure(m, left, tau));
      dots.forEach((dot, i) => { dot.setAttribute('cx', x(m)); dot.setAttribute('cy', y(values[i])); });
      hover.setAttribute('visibility', 'visible');
      showTip(event, [t('stakesTip', { m }), ...series.map(([left], i) => `${t('left', { n: left })}: Π = ${fmt(values[i], 2)}`)]);
    });
    hit.addEventListener('pointerleave', () => {
      hideTip();
      hover.setAttribute('visibility', 'hidden');
    });
  };
}

/* ---------- figure 5: where a club finishes ------------------------- */

function setupSeason(root) {
  const chart = root.querySelector('.fig__chart');
  const readout = root.querySelector('.fig__readout');
  const select = root.querySelector('#s-club');
  const table = root.querySelector('.fig__table');
  let league = 'eliteserien';
  let filled = null;
  leagueSwitch(root, (next) => { league = next; filled = null; draw(); });
  select.addEventListener('change', () => draw());

  function draw() {
    if (!report) {
      chart.replaceChildren();
      readout.textContent = reportFailed ? t('noReport') : t('loading');
      return;
    }
    if (filled !== league) {
      fillSelect(select, clubs(league), report[league].table[0].team_id);
      filled = league;
    }
    const club = report[league].table.find((row) => row.team_id === select.value);
    const chances = club.position_probabilities;
    const f = frame(chart, 230, [22, 6, 28, 44], t('seasonAria'));
    const top = Math.max(...chances);
    const step = [0.05, 0.1, 0.2, 0.25].find((s) => top / s <= 5) || 0.25;
    const ceiling = Math.ceil(top / step) * step;
    const y = linear(0, ceiling, f.bottom, f.top);
    const grid = svg('g', { class: 'grid' }, f.root);
    for (let v = 0; v <= ceiling + 1e-9; v += step) {
      svg('line', { x1: f.left, x2: f.right, y1: y(v), y2: y(v) }, grid);
      text(f.root, f.left - 8, y(v) + 4, pct(v), 'end');
    }
    const band = (f.right - f.left) / chances.length;
    const barWidth = Math.min(24, band * 0.7);
    const labelled = new Set([...chances.keys()].sort((a, b) => chances[b] - chances[a]).slice(0, 3)
      .filter((i) => chances[i] >= 0.01));
    chances.forEach((value, i) => {
      const cx = f.left + band * i + band / 2;
      if (value > 0) {
        svg('path', { d: columnPath(cx - barWidth / 2, barWidth, y(0), Math.min(y(value), y(0) - 1)), style: 'fill: var(--seq-5)' }, f.root);
      }
      if (labelled.has(i)) text(f.root, cx, y(value) - 6, pct(value), 'middle', 'value');
      if (chances.length <= 16 || i % 2 === 0) text(f.root, cx, f.bottom + 18, String(i + 1), 'middle');
      const hit = svg('rect', { x: cx - band / 2, y: f.top, width: band, height: f.bottom - f.top, class: 'hit' }, f.root);
      hit.addEventListener('pointermove', (event) => showTip(event, [ordinal(i + 1), pct(value, 1)]));
      hit.addEventListener('pointerleave', hideTip);
    });
    const likeliest = chances.indexOf(top);
    readout.textContent = t('seasonSummary', {
      club: club.team, pts: fmt(club.expected_points, 0), place: ordinal(likeliest + 1), p: pct(top),
    });

    const caption = document.createElement('summary');
    caption.textContent = t('tableView');
    const rows = chances.map((value, i) => `<tr><td>${i + 1}</td><td>${pct(value, 1)}</td></tr>`).join('');
    table.innerHTML = `<table><thead><tr><th>${t('tablePlace')}</th><th>${t('tableChance')}</th></tr></thead><tbody>${rows}</tbody></table>`;
    table.prepend(caption);
  }
  return draw;
}

/* ---------- page ---------------------------------------------------- */

const figures = [];

function addFigure(id, setup) {
  const root = document.getElementById(id);
  if (!root) return;
  const draw = setup(root);
  figures.push(draw);
  const chart = root.querySelector('.fig__chart');
  let width = 0;
  new ResizeObserver(() => {
    if (chart.clientWidth === width) return;
    width = chart.clientWidth;
    draw();
  }).observe(chart);
}

function redraw() {
  hideTip();
  for (const draw of figures) draw();
}

function versionNote() {
  const note = document.getElementById('version-note');
  const live = report?.eliteserien?.model?.version;
  note.hidden = !live || live === PAGE_VERSION;
  if (!note.hidden) note.textContent = t('versionNote', { live, page: PAGE_VERSION });
}

function setLang(next) {
  try {
    localStorage.setItem('lang', next);
  } catch (error) {
    // Private windows can refuse storage; the page still switches.
  }
  document.documentElement.dataset.lang = next;
  document.documentElement.lang = next === 'en' ? 'en' : 'nb';
  document.title = t('title');
  document.querySelector('meta[name=description]').content = t('description');
  for (const button of document.querySelectorAll('button[data-lang]')) {
    button.setAttribute('aria-pressed', String(button.dataset.lang === next));
  }
  versionNote();
  redraw();
}

/* The contents follow the reader. On a wide screen they stay in the margin
   (the CSS pins them) with the current section marked; on a narrow one, once
   they are scrolled past, a button brings them back. */
function followContents() {
  const toc = document.getElementById('innhold');
  const jump = document.querySelector('.toc-jump');
  if (!toc || !jump) return;
  const links = [...toc.querySelectorAll('a[href^="#"]')];
  const targets = links.map((link) => document.getElementById(link.getAttribute('href').slice(1)));
  let frame = 0;
  const mark = () => {
    frame = 0;
    // The section whose heading has passed the top third is the one being read.
    const line = window.innerHeight / 3;
    let current = -1;
    targets.forEach((target, i) => { if (target && target.getBoundingClientRect().top <= line) current = i; });
    links.forEach((link, i) => {
      if (i === current) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
    jump.hidden = toc.getBoundingClientRect().bottom > 0;
  };
  window.addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(mark); }, { passive: true });
  window.addEventListener('resize', mark);
  mark();
}

/* A formula wider than a phone scrolls sideways; a faded edge says there is
   more, and the box takes keyboard focus so it can be scrolled without a
   pointer. */
function markClippedEquations() {
  const boxes = [...document.querySelectorAll('.eq')];
  const mark = (box) => {
    const more = box.scrollWidth - box.clientWidth;
    box.classList.toggle('is-clipped-end', more > 1 && box.scrollLeft < more - 1);
    box.classList.toggle('is-clipped-start', more > 1 && box.scrollLeft > 1);
    if (more > 1) box.tabIndex = 0;
    else box.removeAttribute('tabindex');
  };
  for (const box of boxes) {
    box.addEventListener('scroll', () => mark(box), { passive: true });
    new ResizeObserver(() => mark(box)).observe(box);
  }
  // The maths font can arrive after the first layout and change the widths.
  document.fonts?.ready.then(() => boxes.forEach(mark));
}

function init() {
  document.body.appendChild(tip);
  followContents();
  markClippedEquations();
  for (const button of document.querySelectorAll('button[data-lang]')) {
    button.addEventListener('click', () => setLang(button.dataset.lang));
  }
  addFigure('fig-gap', setupGap);
  addFigure('fig-update', setupUpdate);
  addFigure('fig-match', setupMatch);
  addFigure('fig-stakes', setupStakes);
  addFigure('fig-season', setupSeason);
  setLang(lang());
  fetch('/data/report.json')
    .then((response) => {
      if (!response.ok) throw new Error(`server returned ${response.status}`);
      return response.json();
    })
    .then((data) => { report = data; })
    .catch((error) => {
      console.warn('[model] report.json unavailable', error);
      reportFailed = true;
    })
    .finally(() => {
      versionNote();
      redraw();
    });
  window.addEventListener('scroll', hideTip, { passive: true });
}

if (typeof document !== 'undefined' && document.readyState !== 'loading') init();
else if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);
