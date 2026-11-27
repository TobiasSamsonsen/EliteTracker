/* ---------- compare clubs ----------------------------------------- */

function allTeams() {
  const seen = new Set();
  const teams = [];
  for (const report of Object.values(state.reports || {})) {
    for (const row of report.table || []) {
      const id = String(row.team_id);
      if (seen.has(id)) continue;
      seen.add(id);
      teams.push(row);
    }
  }
  teams.sort((a, b) => a.team.localeCompare(b.team, 'nb'));
  return teams;
}

function teamNameById(id) {
  return allTeams().find((team) => String(team.team_id) === String(id))?.team || careerById(id)?.team || id;
}

function careerById(id) {
  return (state.careers?.teams || []).find((team) => String(team.team_id) === String(id));
}

function ratingById(id) {
  return allTeams().find((team) => String(team.team_id) === String(id))?.rating ?? 0;
}

/* Three-way odds for a fictional match, ported from model/probabilities.py.
   Both divisions share one rating scale, so any two clubs can meet. Working it
   out here costs a few lines and saves shipping a 32x31 matrix of every
   possible pairing in every report file. */
/* Eliteserien only (report.model.surface): a home side whose visitor plays on
   the other surface gets `edge` rating points on the prediction, as
   normalize/surfaces.py does on the server. */
function surfaceEdge(model, homeId, awayId) {
  const surface = model.surface;
  if (!surface) return 0;
  const grass = new Set(surface.grass.map(String));
  return grass.has(String(homeId)) !== grass.has(String(awayId)) ? surface.edge : 0;
}

function matchOdds(model, homeRating, awayRating) {
  const gap = (homeRating - awayRating) / 400;
  const beta = model.home_advantage_beta || 0;
  const effective_ha = model.home_advantage * (1 + beta * gap);
  const effectiveGap = homeRating + effective_ha - awayRating;
  // The ELO expectation of that gap against an even 1500 baseline. Half the
  // draw mass comes off each side, so home_win + 0.5*draw reproduces it exactly.
  const expected = 1 / (1 + 10 ** (-effectiveGap / 400));
  const draw = Math.min(
    model.draw_base * Math.exp(-((effectiveGap / model.draw_scale) ** 2)),
    2 * Math.min(expected, 1 - expected)
  );
  return { gap: effectiveGap, home_win: expected - draw / 2, draw, away_win: 1 - expected - draw / 2 };
}

/* Most likely scorelines, ported from display/fixtures.py: each outcome's
   empirical frequencies for the gap's bin, weighted by that outcome's odds. */
/* Scoreline grid ported from model/attack_defence.py: Poisson goals at each
   side's expected rate with the Dixon-Coles low-score correction, 0-8 goals
   each way, renormalised. */
function scoreGrid(model, homeId, awayId, eloGap) {
  const ad = model.attack_defence;
  // [attack, defence, finishing, keeping]; reports before elo-v14.0 carry no keeping.
  const [homeAttack, homeDefence, homeFinishing, homeKeeping] = ad.teams[homeId] || [0, 0, 0, 0];
  const [awayAttack, awayDefence, awayFinishing, awayKeeping] = ad.teams[awayId] || [0, 0, 0, 0];
  const gap = eloGap || 0;
  const effective_home = ad.home * (1 + (ad.home_beta || 0) * gap);
  const spread = ad.spread ?? 1;
  const lam = Math.exp(ad.base + effective_home + spread * (homeAttack - awayDefence + (homeFinishing || 0) - (awayKeeping || 0)));
  const mu = Math.exp(ad.base + spread * (awayAttack - homeDefence + (awayFinishing || 0) - (homeKeeping || 0)));
  const fact = [1, 1, 2, 6, 24, 120, 720, 5040, 40320];
  const pois = (k, rate) => Math.exp(-rate) * rate ** k / fact[k];
  const tau = (i, j) => (i === 0 && j === 0 ? 1 - lam * mu * ad.rho
    : i === 0 && j === 1 ? 1 + lam * ad.rho
    : i === 1 && j === 0 ? 1 + mu * ad.rho
    : i === 1 && j === 1 ? 1 - ad.rho : 1);
  const grid = fact.map((_, i) => fact.map((__, j) => pois(i, lam) * pois(j, mu) * Math.max(tau(i, j), 0)));
  const total = grid.reduce((sum, row) => sum + row.reduce((s, v) => s + v, 0), 0);
  return grid.map((row) => row.map((v) => v / total));
}

/* The shipped outcome odds: a geometric blend of the Elo odds and the grid's
   own win/draw/loss sums, weight on Elo from the report. Ported from
   model/attack_defence.py blend_outcomes. */
function blendOdds(model, odds, homeId, awayId) {
  const grid = scoreGrid(model, homeId, awayId, odds.gap / 400);
  const own = { home_win: 0, draw: 0, away_win: 0 };
  grid.forEach((row, i) => row.forEach((p, j) => { own[i > j ? 'home_win' : i === j ? 'draw' : 'away_win'] += p; }));
  const gamma = model.attack_defence.blend_gamma || 0;
  const gap = Math.abs(odds.gap) / 400;
  const w = gamma ? Math.max(0.05, Math.min(0.50, model.attack_defence.outcome_blend - gamma * gap)) : model.attack_defence.outcome_blend;
  const raw = ['home_win', 'draw', 'away_win'].map((o) => odds[o] ** w * own[o] ** (1 - w));
  const total = raw[0] + raw[1] + raw[2];
  return { gap: odds.gap, home_win: raw[0] / total, draw: raw[1] / total, away_win: raw[2] / total };
}

/* Most likely scorelines: who wins comes from the blended odds, how many goals
   from the grid -- each outcome's cells are rescaled to that outcome's odds. */
function topScorelines(model, odds, homeId, awayId, n = 5) {
  const grid = scoreGrid(model, homeId, awayId, odds.gap / 400);
  const outcome = (i, j) => (i > j ? 'home_win' : i === j ? 'draw' : 'away_win');
  const own = { home_win: 0, draw: 0, away_win: 0 };
  grid.forEach((row, i) => row.forEach((p, j) => { own[outcome(i, j)] += p; }));
  const cells = [];
  grid.forEach((row, i) => row.forEach((p, j) => {
    const o = outcome(i, j);
    cells.push({ home_goals: i, away_goals: j, probability: own[o] > 0 ? p * (odds[o] / own[o]) : 0 });
  }));
  return cells.sort((a, b) => b.probability - a.probability).slice(0, n);
}

function compareTeamBlock(id, name, rating, crest, side, isHome = null) {
  const block = el('div', 'compare__team');
  const main = el('div', 'compare__card-main');
  if (crest) main.appendChild(crest);
  const text = el('div', 'compare__team-text');
  const sideEl = el('div', 'compare__team-side');
  if (isHome != null) sideEl.append(venueIcon(isHome, { badge: false }), el('span', '', side));
  else sideEl.textContent = side;
  text.appendChild(sideEl);
  text.appendChild(el('div', 'compare__team-name', name));
  text.appendChild(el('div', 'compare__team-rating', String(Math.round(rating))));
  main.appendChild(text);
  block.appendChild(main);
  return block;
}

function oddsBar(homeName, awayName, entry) {
  const odds = el('div', 'odds');
  odds.setAttribute('role', 'img');
  odds.setAttribute(
    'aria-label',
    t('aria.odds', { home: homeName, hw: pct(entry.home_win), d: pct(entry.draw), away: awayName, aw: pct(entry.away_win) })
  );
  for (const [outcome, value, who] of [
    ['home', entry.home_win, homeName],
    ['draw', entry.draw, t('next.draw')],
    ['away', entry.away_win, awayName],
  ]) {
    const segment = el('div', 'odds__seg');
    segment.dataset.outcome = outcome;
    segment.style.flex = `${Math.max(value, 0.001)}`;
    segment.textContent = value >= 0.12 ? pct(value, 0) : '';
    segment.addEventListener('pointerenter', (event) => showTooltip(event, `<b>${esc(who)}</b><br>${pct(value, 1)}`));
    segment.addEventListener('pointermove', moveTooltip);
    segment.addEventListener('pointerleave', hideTooltip);
    odds.appendChild(segment);
  }
  return odds;
}

function populateCompare(report) {
  // The picker spans both divisions, so the team list is the same every season
  // regardless of which division the page is showing; key on the season alone.
  const key = String(report.league.season);
  if (state.compareKey === key && $('#compare-a').options.length) return;
  state.compareKey = key;
  const a = $('#compare-a');
  const b = $('#compare-b');
  a.replaceChildren();
  b.replaceChildren();
  for (const team of allTeams()) {
    a.appendChild(el('option', '', team.team)).value = team.team_id;
    b.appendChild(el('option', '', team.team)).value = team.team_id;
  }
  // Sensible defaults: the two highest-rated clubs overall.
  const byRating = [...allTeams()].sort((x, y) => y.rating - x.rating);
  a.value = byRating[0].team_id;
  b.value = byRating[1]?.team_id || byRating[0].team_id;
  // A shared link names the pair (?compare=<home id>:<away id>).
  const [homeId, awayId] = (new URLSearchParams(window.location.search).get('compare') || '').split(':');
  const has = (select, id) => [...select.options].some((option) => option.value === id);
  if (homeId !== awayId && has(a, homeId) && has(b, awayId)) {
    a.value = homeId;
    b.value = awayId;
  }
}

let compareMenuEl = null;
let compareMenuFocusCleanup = null;
let compareMenuActiveIndex = -1;

function closeCompareMenu() {
  if (compareMenuEl) {
    compareMenuEl.remove();
    compareMenuEl = null;
    hideMenuScrim();
  }
  if (compareMenuFocusCleanup) {
    compareMenuFocusCleanup();
    compareMenuFocusCleanup = null;
  }
  compareMenuActiveIndex = -1;
  document.removeEventListener('pointerdown', compareMenuOutside, true);
  document.removeEventListener('keydown', compareMenuKey);
  window.removeEventListener('scroll', compareMenuScroll, true);
}

function compareMenuOutside(event) {
  if (compareMenuEl && !compareMenuEl.contains(event.target)) closeCompareMenu();
}

function compareMenuKey(event) {
  if (event.key === 'Escape') {
    closeCompareMenu();
    return;
  }
  if (!compareMenuEl) return;
  const options = [...compareMenuEl.querySelectorAll('[role="option"]:not([disabled])')];
  if (!options.length) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    compareMenuActiveIndex = Math.min(compareMenuActiveIndex + 1, options.length - 1);
    options[compareMenuActiveIndex].focus();
    compareMenuEl.setAttribute('aria-activedescendant', options[compareMenuActiveIndex].id);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    compareMenuActiveIndex = Math.max(compareMenuActiveIndex - 1, 0);
    options[compareMenuActiveIndex].focus();
    compareMenuEl.setAttribute('aria-activedescendant', options[compareMenuActiveIndex].id);
  } else if (event.key === 'Home') {
    event.preventDefault();
    compareMenuActiveIndex = 0;
    options[0].focus();
    compareMenuEl.setAttribute('aria-activedescendant', options[0].id);
  } else if (event.key === 'End') {
    event.preventDefault();
    compareMenuActiveIndex = options.length - 1;
    options[compareMenuActiveIndex].focus();
    compareMenuEl.setAttribute('aria-activedescendant', options[compareMenuActiveIndex].id);
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    if (compareMenuActiveIndex >= 0) options[compareMenuActiveIndex].click();
  }
}

function compareMenuScroll(event) {
  if (compareMenuEl && compareMenuEl.contains(event.target)) return;
  closeCompareMenu();
}

function openCompareMenu(box, side, report) {
  closeCompareMenu();
  const menu = el('div', 'compare__menu');
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', t('compare.chooseClub'));
  menu.dataset.side = side;
  const select = side === 'home' ? $('#compare-a') : $('#compare-b');
  const otherId = side === 'home' ? $('#compare-b').value : $('#compare-a').value;
  let selectedIndex = -1;
  const teams = allTeams();
  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    const option = el('button', 'compare__option');
    option.type = 'button';
    option.setAttribute('role', 'option');
    option.id = `compare-option-${side}-${team.team_id}`;
    if (team.team_id === otherId) option.disabled = true;
    if (team.team_id === select.value) {
      option.setAttribute('aria-selected', 'true');
      selectedIndex = i;
    }
    const crest = teamLogo(team.team_id, team.team, true);
    if (crest) option.appendChild(crest);
    option.appendChild(el('span', 'compare__option-name', team.team));
    option.addEventListener('click', () => {
      select.value = team.team_id;
      select.dispatchEvent(new Event('change'));
      closeCompareMenu();
    });
    menu.appendChild(option);
  }
  const rect = box.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${rect.left}px`;
  menu.style.width = `${rect.width}px`;
  menu.style.setProperty('--menu-left', `${rect.left}px`);
  menu.style.setProperty('--menu-width', `${rect.width}px`);
  document.body.appendChild(menu);
  phoneMenu(menu, closeCompareMenu);
  compareMenuEl = menu;
  compareMenuActiveIndex = selectedIndex;
  if (selectedIndex >= 0) {
    const selectedOption = menu.querySelector('[aria-selected="true"]');
    if (selectedOption) menu.setAttribute('aria-activedescendant', selectedOption.id);
  }
  compareMenuFocusCleanup = trapFocus(menu);
  setTimeout(() => {
    document.addEventListener('pointerdown', compareMenuOutside, true);
    document.addEventListener('keydown', compareMenuKey);
    window.addEventListener('scroll', compareMenuScroll, true);
  }, 0);
}

function renderCompare(report) {
  const holder = $('#compare-output');
  holder.replaceChildren();

  const aId = $('#compare-a').value;
  const bId = $('#compare-b').value;
  // A club cannot play itself.
  for (const option of $('#compare-a').options) option.disabled = option.value === bId;
  for (const option of $('#compare-b').options) option.disabled = option.value === aId;
  const homeId = aId;
  const awayId = bId;
  // The pair in the address, so the page can be shared.
  const pair = new URLSearchParams(window.location.search);
  pair.set('compare', `${aId}:${bId}`);
  window.history.replaceState(entryState(), '', `${window.location.pathname}?${pair.toString()}${window.location.hash}`);
  const homeName = teamNameById(homeId);
  const awayName = teamNameById(awayId);

  const homeRating = ratingById(homeId);
  const awayRating = ratingById(awayId);
  const edge = surfaceEdge(report.model, homeId, awayId);
  const odds = blendOdds(report.model, matchOdds(report.model, homeRating + edge, awayRating), homeId, awayId);
  const entry = { ...odds, scorelines: topScorelines(report.model, odds, homeId, awayId) };

  // Fictional match: the two clubs, who hosts, and the model's odds + scorelines.
  const matchBlock = el('div', 'compare__block');
  // The heading and its share button on one line. The pair is in the address
  // (?compare=): shared as the match's picture or the link.
  const matchHead = el('div', 'compare__head');
  matchHead.appendChild(el('h3', 'compare__subhead', t('compare.match')));
  matchBlock.appendChild(matchHead);
  matchHead.appendChild(shareButton({
    title: `${homeName} – ${awayName}`,
    image: () => shareMatch({
      label: `${t('compare.match')} · ${t('share.season', { season: report.league.season })}`,
      home: { id: homeId, name: homeName, rating: homeRating },
      away: { id: awayId, name: awayName, rating: awayRating },
      odds,
      cells: topScorelines(report.model, odds, homeId, awayId, 49),
    }),
  }));

  const teamsRow = el('div', 'compare__teams');
  const homeBlock = compareTeamBlock(homeId, homeName, homeRating, teamLogo(homeId, homeName), t('compare.home'), true);
  const awayBlock = compareTeamBlock(awayId, awayName, awayRating, teamLogo(awayId, awayName), t('compare.away'), false);
  const swapBtn = el('button', 'compare__swap-center', '⇄');
  swapBtn.type = 'button';
  swapBtn.setAttribute('aria-label', t('compare.swap'));
  swapBtn.addEventListener('click', () => {
    const a = $('#compare-a');
    const b = $('#compare-b');
    const swap = a.value;
    a.value = b.value;
    b.value = swap;
    renderCompare(report);
  });
  teamsRow.appendChild(homeBlock);
  teamsRow.appendChild(swapBtn);
  teamsRow.appendChild(awayBlock);

  const makePicker = (box, side) => {
    box.setAttribute('role', 'button');
    box.setAttribute('tabindex', '0');
    box.setAttribute('aria-label', t('compare.chooseClub'));
    box.setAttribute('aria-haspopup', 'listbox');
    box.title = t('compare.chooseClub');
    const toggle = () => {
      if (compareMenuEl && compareMenuEl.dataset.side === side) closeCompareMenu();
      else openCompareMenu(box, side, report);
    };
    box.addEventListener('click', toggle);
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
  };
  makePicker(homeBlock, 'home');
  makePicker(awayBlock, 'away');
  matchBlock.appendChild(teamsRow);
  matchBlock.appendChild(el('p', 'compare__note', t('compare.note', { team: homeName })));

  matchBlock.appendChild(oddsBar(homeName, awayName, entry));
  const linesWrap = el('div', 'compare__scorelines');
  linesWrap.appendChild(el('div', 'compare__scorelines-label', t('compare.scorelines')));
  const lines = el('div', 'compare__scorelines-chips');
  for (const line of entry.scorelines.slice(0, 4)) {
    const chip = el('span', 'compare__scoreline');
    chip.textContent = `${line.home_goals}–${line.away_goals}`;
    chip.appendChild(el('span', 'compare__scoreline-prob', pct(line.probability, 0)));
    chip.setAttribute('aria-label', t('aria.scoreline', { score: `${line.home_goals}-${line.away_goals}`, pct: pct(line.probability, 1) }));
    lines.appendChild(chip);
  }
  linesWrap.appendChild(lines);
  matchBlock.appendChild(linesWrap);
  holder.appendChild(matchBlock);

  // Rating history: both clubs overlaid on one time axis.
  const careerA = careerById(aId);
  const careerB = careerById(bId);
  if (careerA && careerB) {
    const histBlock = el('div', 'compare__block');
    histBlock.appendChild(el('h3', 'compare__subhead', t('compare.ratingHistory')));
    const svg = svgEl('svg', { class: 'chart', role: 'img' });
    svg.setAttribute('aria-label', t('chart.ratingHistoryFor', { home: homeName, away: awayName }));
    histBlock.appendChild(svg);
    const legend = el('div', 'legend');
    legend.appendChild(el('span', 'compare-legend__a', teamNameById(aId)));
    legend.appendChild(el('span', 'compare-legend__b', teamNameById(bId)));
    histBlock.appendChild(legend);
    holder.appendChild(histBlock);
    // Drawn once on the page, so the chart can take its own width.
    drawCompareHistory(svg, careerA, careerB, teamNameById(aId), teamNameById(bId));
  }

  // Head-to-head: all-time results between the two clubs (h2h.json, fetched on first use).
  const h2hKey = [aId, bId].sort().join('\t');
  requestH2h();
  const h2hAll = (state.h2h || {})[h2hKey] || [];
  const h2h = h2hAll.filter(
    (r) => (r.home_id === aId && r.away_id === bId) || (r.home_id === bId && r.away_id === aId),
  );
  if (h2h.length) {
    h2h.sort((a, b) => b.date.localeCompare(a.date));
    const h2hBlock = el('div', 'compare__block');
    h2hBlock.appendChild(el('h3', 'compare__subhead', t('compare.h2h')));
    let aWins = 0; let bWins = 0; let draws = 0; let aGoals = 0; let bGoals = 0;
    for (const m of h2h) {
      const aIsHome = m.home_id === aId;
      const aG = aIsHome ? m.home_goals : m.away_goals;
      const bG = aIsHome ? m.away_goals : m.home_goals;
      aGoals += aG;
      bGoals += bG;
      if (aG > bG) aWins++;
      else if (bG > aG) bWins++;
      else draws++;
    }
    // Each number carries its own label: with the club names at the far edges
    // and "9 - 2 - 8" in the middle, it was not plain whose wins were whose.
    const record = el('div', 'compare__h2h-record');
    for (const [count, label] of [
      [aWins, t('compare.h2h.won', { team: homeName })],
      [draws, t('compare.h2h.drawn')],
      [bWins, t('compare.h2h.won', { team: awayName })],
    ]) {
      const cell = el('div', 'compare__h2h-cell');
      cell.appendChild(el('span', 'compare__h2h-stat', String(count)));
      cell.appendChild(el('span', 'compare__h2h-label', label));
      record.appendChild(cell);
    }
    const goalsBlock = el('div', 'compare__h2h-goals');
    goalsBlock.appendChild(el('span', 'compare__h2h-goals-label', t('compare.h2h.goalsLabel')));
    goalsBlock.appendChild(el('span', 'compare__h2h-goals-stat', `${aGoals} – ${bGoals}`));
    h2hBlock.appendChild(record);
    h2hBlock.appendChild(goalsBlock);
    const PAGE_SIZE = 5;
    const totalPages = Math.ceil(h2h.length / PAGE_SIZE);
    // The shared page control sits above the list, as on Matches;
    // meetings run newest first, so Prev goes back in time.
    const navSlot = el('div');
    const list = el('div', 'compare__h2h-list');
    h2hBlock.appendChild(navSlot);
    h2hBlock.appendChild(list);
    const renderH2hPage = (h2hPage) => {
      navSlot.replaceChildren();
      if (totalPages > 1) navSlot.appendChild(paginator(h2hPage, totalPages, renderH2hPage, true));
      list.replaceChildren();
      const start = h2hPage * PAGE_SIZE;
      for (const m of h2h.slice(start, start + PAGE_SIZE)) {
        const card = el('div', 'played-card');
        if (m.home_goals > m.away_goals) card.classList.add('played-card--home-win');
        else if (m.away_goals > m.home_goals) card.classList.add('played-card--away-win');
        card.appendChild(el('div', 'played-card__date', `${formatDate(m.date)} \u00b7 ${m.season}`));
        const matchup = el('div', 'played-card__matchup');
        const homeSide = el('div', 'played-card__side played-card__side--home');
        homeSide.appendChild(sideBlock(m.home, m.home_id, false));
        matchup.appendChild(homeSide);
        matchup.appendChild(el('div', 'played-card__score', `${m.home_goals}\u2013${m.away_goals}`));
        const awaySide = el('div', 'played-card__side played-card__side--away');
        awaySide.appendChild(sideBlock(m.away, m.away_id, true));
        matchup.appendChild(awaySide);
        card.appendChild(matchup);
        list.appendChild(card);
      }
    };
    renderH2hPage(0);
    holder.appendChild(h2hBlock);
  }
}

/* Like the club chart, a narrow container gets a viewBox of its own width:
   the 900-wide box read at a phone's ~0.36 scale left 4px text. The narrow
   box labels seasons as '16 and skips those that would crowd. */
let lastCompareChart = null;

function drawCompareHistory(svg, careerA, careerB, labelA, labelB) {
  const box = svg.getBoundingClientRect().width || 900;
  const narrow = box < SHAPE_NARROW;
  lastCompareChart = { svg, careerA, careerB, labelA, labelB, narrow };
  const width = narrow ? Math.round(box) : 900;
  const height = narrow ? 240 : 320;
  const pad = narrow ? { top: 14, right: 10, bottom: 34, left: 40 } : { top: 14, right: 18, bottom: 34, left: 46 };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.replaceChildren();

  // SVG accessibility: title doubles as the accessible name
  const title = svgEl('title');
  title.textContent = t('chart.ratingHistoryFor', { home: labelA, away: labelB });
  svg.appendChild(title);

  const series = [careerA.points || [], careerB.points || []];
  const all = series.flat();
  if (!all.length) return;
  const times = all.map(pointTime);
  const ratings = all.map((point) => point[1]);
  const tMin = Math.min(...times);
  const tMax = Math.max(...times);
  let rMin = Math.min(...ratings);
  let rMax = Math.max(...ratings);
  const rPad = (rMax - rMin) * 0.08 || 20;
  rMin -= rPad;
  rMax += rPad;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const x = (t) => pad.left + ((t - tMin) / (tMax - tMin || 1)) * plotW;
  const y = (r) => pad.top + (1 - (r - rMin) / (rMax - rMin || 1)) * plotH;

  // Ticks on round ratings (1, 2 or 5 x 10^n apart, four to six of them), not
  // the range cut into equal quarters, which gave 1456, 1559, 1662...
  const rough = (rMax - rMin) / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const tickStep = [1, 2, 5, 10].map((m) => m * magnitude).find((v) => v >= rough);
  for (let value = Math.ceil(rMin / tickStep) * tickStep; value <= rMax; value += tickStep) {
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value) }));
    const tick = svgEl('text', { class: 'tick', x: pad.left - 8, y: y(value) + 3.5, 'text-anchor': 'end' });
    tick.textContent = String(Math.round(value));
    svg.appendChild(tick);
  }

  svg.appendChild(svgEl('line', { class: 'axis-line', x1: pad.left, x2: width - pad.right, y1: height - pad.bottom, y2: height - pad.bottom }));
  svg.appendChild(svgEl('line', { class: 'axis-line', x1: pad.left, x2: pad.left, y1: pad.top, y2: height - pad.bottom }));

  // One vertical tick per season present, so the axis reads as years.
  const seen = new Set();
  let lastLabelX = -Infinity;
  for (const point of all) {
    const year = point[0].slice(0, 4);
    if (seen.has(year)) continue;
    seen.add(year);
    const px = x(Math.max(tMin, Math.min(tMax, Date.parse(`${year}-01-01T12:00:00Z`))));
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: px, x2: px, y1: pad.top, y2: height - pad.bottom }));
    if (px - lastLabelX < (narrow ? 26 : 30)) continue;
    lastLabelX = px;
    const label = svgEl('text', { class: 'tick', x: px, y: height - pad.bottom + 15, 'text-anchor': 'middle' });
    label.textContent = narrow ? `’${year.slice(2)}` : year;
    svg.appendChild(label);
  }

  const colors = ['var(--home)', 'var(--away)'];
  series.forEach((points, index) => {
    if (!points.length) return;
    const line = points.map((point) => `${x(pointTime(point))},${y(point[1])}`).join(' ');
    svg.appendChild(svgEl('polyline', { class: `compare-line compare-line--${index === 0 ? 'a' : 'b'}`, points: line, style: `stroke: ${colors[index]}` }));
    const last = points[points.length - 1];
    svg.appendChild(svgEl('circle', { cx: x(pointTime(last)), cy: y(last[1]), r: 3, style: `fill: ${colors[index]}` }));
  });

  const xTitle = svgEl('text', { class: 'axis-title', x: pad.left + plotW / 2, y: height - 4, 'text-anchor': 'middle' });
  xTitle.textContent = t('compare.season');
  svg.appendChild(xTitle);
  // A narrow box has no room beside the tick labels; the heading above the
  // chart already names the rating.
  if (!narrow) {
    const yTitle = svgEl('text', { class: 'axis-title', x: -(pad.top + plotH / 2), y: 12, transform: 'rotate(-90)', 'text-anchor': 'middle' });
    yTitle.textContent = t('compare.rating');
    svg.appendChild(yTitle);
  }

  // Crosshair + tooltip reading out both clubs' rating at the hovered date.
  const line = svgEl('line', { class: 'crosshair', y1: pad.top, y2: height - pad.bottom, x1: -10, x2: -10 });
  line.style.opacity = '0';
  svg.appendChild(line);
  // Parsed once per series: this runs on every pointermove.
  const seriesTimes = series.map((points) => points.map(pointTime));
  const nearest = (index, localX) => {
    const times = seriesTimes[index];
    let best = 0;
    for (let i = 1; i < times.length; i += 1) {
      if (Math.abs(x(times[i]) - localX) < Math.abs(x(times[best]) - localX)) best = i;
    }
    return best;
  };
  const surface = svgEl('rect', { x: pad.left, y: pad.top, width: plotW, height: plotH, fill: 'transparent' });
  surface.addEventListener('pointermove', (event) => {
    const box = svg.getBoundingClientRect();
    const localX = (event.clientX - box.left) * (width / box.width);
    const ia = nearest(0, localX);
    const ib = nearest(1, localX);
    const pa = series[0][ia];
    const pb = series[1][ib];
    const px = (x(seriesTimes[0][ia]) + x(seriesTimes[1][ib])) / 2;
    line.setAttribute('x1', px);
    line.setAttribute('x2', px);
    line.style.opacity = '1';
    const when = new Date(pointTime(pa)).toLocaleDateString(localeDate(), { month: 'short', year: 'numeric' });
    showTooltip(event, `<b>${esc(labelA)}</b> ${Math.round(pa[1])} · <b>${esc(labelB)}</b> ${Math.round(pb[1])}<br>${when}`);
  });
  surface.addEventListener('pointerleave', () => {
    line.style.opacity = '0';
    hideTooltip();
  });
  svg.appendChild(surface);
}

/* The all-time meetings between clubs (/data/h2h.json): the Compare page's
   alone, and most of what careers.json used to hold, so they are fetched when
   Compare first asks and it is drawn again when they land. Compact on the wire
   ([date, season, home_id, away_id, goals, goals, home_name, away_name], the
   names as indexes), expanded here to what the page reads. */
function expandH2h(data, shortener = shortName) {
  const names = (data.names || []).map(shortener);
  const meetings = {};
  for (const [key, rows] of Object.entries(data.matches || {})) {
    meetings[key] = rows.map(([date, season, homeId, awayId, homeGoals, awayGoals, home, away]) => ({
      date, season, home_id: homeId, away_id: awayId, home_goals: homeGoals, away_goals: awayGoals,
      home: names[home], away: names[away],
    }));
  }
  return meetings;
}

let h2hRequested = false;
function requestH2h() {
  if (state.h2h || h2hRequested) return;
  h2hRequested = true;
  fetch('/data/h2h.json')
    .then((response) => {
      if (!response.ok) throw new Error(`/data/h2h.json ${response.status}`);
      return response.json();
    })
    .then((data) => {
      state.h2h = expandH2h(data);
      if (state.activeView === 'compare') render();
    })
    .catch((error) => {
      console.warn('[Boot] h2h.json unavailable', error);
      track('load_error', { file: 'h2h', message: error.message });
    });
}

if (typeof module !== 'undefined') {
  module.exports = { surfaceEdge, matchOdds, scoreGrid, blendOdds, topScorelines, expandH2h };
}
