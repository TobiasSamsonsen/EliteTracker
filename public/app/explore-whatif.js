/* ---------- explore: what if (viz=whatif) ------------------------------- */

/* Lock a score on any match, played or to come, and see how the season's
   chances move. The clubs are re-rated for it: the season's rating updates are
   replayed with the locked scores (`rerateSeason`, from the report's `rerate`;
   a locked fixture counts as played after the rest, its xG staying as played
   where it had one), and every match still to play is priced again from the new
   ratings. Then the browser plays the rest of the season 50,000 times
   (`season-sim.js`, in a worker), twice on the same draws: as it stands and with
   the locks. The published chances move by the difference, so with nothing
   locked the page shows the Table's numbers, and a lock moves them by what the
   lock does. The odds and scorelines on the cards move the same way, by the
   ratio of the two runs' prices. The run-in's table stakes and the play-offs
   are left out of the browser's run, both runs alike. */
const WHATIF_MAX_GOALS = 15;
const whatIfPrepared = new WeakMap();
let whatIfReports = 0;
let whatIfToken = 0;
let whatIfTimer = 0;
let simWorker = null;
let simCall = 0;
const simPending = new Map();

/* ?lock= carries the scores as match_id:home-away, comma separated. */
function parseLocks(text) {
  const locks = new Map();
  for (const part of String(text || '').split(',')) {
    const found = /^(\w+):(\d{1,2})-(\d{1,2})$/.exec(part);
    if (found) locks.set(found[1], [Number(found[2]), Number(found[3])]);
  }
  return locks;
}

/* The locks that belong to this report's matches, as the ?lock= text. */
function lockParam(locks, report) {
  const present = new Set([...(report.results || []), ...(report.fixtures || [])].map((match) => String(match.match_id)));
  return [...locks].filter(([id]) => present.has(id)).map(([id, [home, away]]) => `${id}:${home}-${away}`).join(',');
}

/* A report's side of the simulation, built once: the fixtures to price by the
   clubs' places in the table, each played match's real score, and the season
   replayed as played (what the report's own ratings are). */
function whatIfPrepare(report) {
  const cached = whatIfPrepared.get(report);
  if (cached) return cached;
  const index = new Map(report.table.map((row, i) => [String(row.team_id), i]));
  const games = [];
  const fixtureAt = new Map();
  for (const game of report.fixtures || []) {
    const home = index.get(String(game.home_id));
    const away = index.get(String(game.away_id));
    if (home === undefined || away === undefined) continue;
    fixtureAt.set(String(game.match_id), games.length);
    games.push({ home, away, game });
  }
  const played = new Map();
  for (const game of report.results || []) {
    const home = index.get(String(game.home_id));
    const away = index.get(String(game.away_id));
    if (home === undefined || away === undefined || game.home_goals == null || game.away_goals == null) continue;
    played.set(String(game.match_id), { home, away, was: [game.home_goals, game.away_goals] });
  }
  // `id` names this report to the worker, which keeps the as-played run by it.
  const prepared = {
    id: (whatIfReports += 1), games, fixtureAt, played, rerate: report.rerate || null,
    asPlayed: report.rerate ? rerateSeason(report.rerate, new Map(), []) : null, baseline: null,
  };
  prepared.baseline = whatIfPrice(report, prepared, prepared.asPlayed);
  whatIfPrepared.set(report, prepared);
  return prepared;
}

/* The clubs as `rated` has them (`rerateSeason`'s Elo and attack/defence), or
   as the report has them when null. */
function whatIfModel(report, rated) {
  if (!rated) return report.model;
  const ad = report.model.attack_defence;
  return { ...report.model, attack_defence: { ...ad, teams: { ...ad.teams, ...rated.teams } } };
}

/* Every fixture (or those at `indices`) priced the way the compare tool does
   it, at the ratings of `rated` (null: the report's), with the grid its score
   is drawn from. */
function whatIfPrice(report, prepared, rated, indices = null) {
  const model = whatIfModel(report, rated);
  const games = indices ? indices.map((i) => prepared.games[i]) : prepared.games;
  return games.map(({ home, away, game }) => {
    const homeRating = rated ? rated.elo[game.home_id] : game.home_rating;
    const awayRating = rated ? rated.elo[game.away_id] : game.away_rating;
    const odds = matchOdds(model, homeRating + surfaceEdge(model, game.home_id, game.away_id), awayRating);
    const blended = blendOdds(model, odds, game.home_id, game.away_id);
    return { home, away, win: blended.home_win, draw: blended.draw, grid: scoreGrid(model, game.home_id, game.away_id, odds.gap / 400), odds, model };
  });
}

/* A fixture's odds and scorelines for the card: the published ones, moved by
   how much the re-rating moved the price (the ratio of the two runs' prices,
   so the stakes the browser's pricing lacks stay as published). `scenario` is
   `whatIfPrice` at the new ratings, null for none. `likeliest` is the most
   likely score of the most likely result, for auto-fill. */
function whatIfShown(game, base, scenario) {
  const now = scenario || base;
  const weight = [
    game.home_win * now.win / base.win,
    game.draw * now.draw / base.draw,
    game.away_win * (1 - now.win - now.draw) / (1 - base.win - base.draw),
  ];
  const total = weight[0] + weight[1] + weight[2];
  const odds = { gap: now.odds.gap, home_win: weight[0] / total, draw: weight[1] / total, away_win: weight[2] / total };
  const lines = topScorelines(now.model, odds, game.home_id, game.away_id, 81);
  const best = odds.home_win >= odds.draw && odds.home_win >= odds.away_win ? 'home' : odds.draw >= odds.away_win ? 'draw' : 'away';
  const result = (line) => (line.home_goals > line.away_goals ? 'home' : line.home_goals === line.away_goals ? 'draw' : 'away');
  const likeliest = lines.find((line) => result(line) === best);
  return { ...odds, scorelines: lines.slice(0, 4), likeliest: likeliest ? [likeliest.home_goals, likeliest.away_goals] : [1, 1] };
}

/* The two runs' specs: the season as it stands, and with `locks` applied (a
   locked fixture is fixed to its score, a locked result swaps the played
   score for the new one, and `priced` is the fixtures at the re-rated clubs).
   No locks, no second run. */
function whatIfSpecs(report, prepared, locks, priced) {
  const rows = report.table;
  const base = {
    count: rows.length,
    sims: report.model.simulations,
    seed: report.model.seed,
    sd: report.model.strength_sd ?? 0.2,
    points: rows.map((row) => row.points),
    gf: rows.map((row) => row.goals_for),
    ga: rows.map((row) => row.goals_against),
    fixtures: prepared.baseline.map(({ home, away, win, draw, grid }) => ({ home, away, win, draw, grid })),
    fixed: prepared.baseline.map(() => null),
  };
  const fixed = base.fixed.slice();
  const replacements = [];
  for (const [id, now] of locks) {
    if (prepared.fixtureAt.has(id)) fixed[prepared.fixtureAt.get(id)] = now;
    else if (prepared.played.has(id)) replacements.push({ ...prepared.played.get(id), now });
  }
  const fixtures = (priced || prepared.baseline).map(({ home, away, win, draw, grid }) => ({ home, away, win, draw, grid }));
  return { base, scenario: locks.size ? { ...base, fixtures, fixed, replacements } : null };
}

/* Per club, its projected points and its chance of each band, as published and
   with the scenario's runs (null: nothing locked) applied. */
function whatIfRows(report, runs) {
  const count = report.table.length;
  const sims = report.model.simulations;
  const published = report.table.map((row) => row.position_probabilities);
  const after = runs ? shiftedChances(published, runs.baseline, runs.scenario, sims, count) : published;
  const share = (chances, band) => chances.slice(band.first - 1, band.last).reduce((a, b) => a + b, 0);
  return report.table.map((row, i) => {
    // The scenario's delta is a difference of means, so it goes on the mean
    // (reports from before the field was added fall back to the median).
    const mean = row.mean_points ?? row.expected_points;
    return {
      row,
      pointsBefore: mean,
      pointsAfter: mean + (runs ? (runs.scenario.totals[i] - runs.baseline.totals[i]) / sims : 0),
      shownDigits: row.mean_points == null ? 0 : 1,
      bands: report.league.bands.map((band) => ({ band, before: share(published[i], band), after: share(after[i], band) })),
    };
  });
}

/* The one club-and-band chance the scenario moved furthest, or null. */
function whatIfSwing(rows) {
  let best = null;
  for (const { row, bands } of rows) {
    for (const { band, before, after } of bands) {
      if (Math.abs(after - before) >= 0.0005 && (!best || Math.abs(after - before) > Math.abs(best.after - best.before))) best = { row, band, before, after };
    }
  }
  return best;
}

/* Ask the season worker (one message in, one reply out; it rejects when the
   worker cannot start or dies). */
function workerCall(message) {
  if (!simWorker) {
    simWorker = new Worker('/season-sim.js');
    simWorker.onmessage = ({ data }) => {
      simPending.get(data.id)?.resolve(data);
      simPending.delete(data.id);
    };
    simWorker.onerror = () => {
      for (const { reject } of simPending.values()) reject(new Error('worker'));
      simPending.clear();
      simWorker.terminate();
      simWorker = null;
    };
  }
  const id = (simCall += 1);
  return new Promise((resolve, reject) => {
    simPending.set(id, { resolve, reject });
    simWorker.postMessage({ id, ...message });
  });
}

/* Run the two seasons off the page's thread. A worker that cannot start (or
   dies) falls back to running them here, a second's wait instead of none. */
async function runSeasonSim(key, base, scenario) {
  try {
    return await workerCall({ key, base, scenario });
  } catch (error) {
    const baseline = simulateSeason(base);
    return { baseline, scenario: scenario ? simulateSeason(scenario) : baseline };
  }
}

/* Stop what the page is waiting on: a view change, or a redraw. */
function whatIfLeave() {
  whatIfToken += 1;
  clearTimeout(whatIfTimer);
}

function whatIfStepper(side, name, value, onStep) {
  const box = el('span', 'whatif-step');
  const arrow = (dir) => {
    const button = el('button', 'whatif-step__btn');
    button.type = 'button';
    button.dataset.step = `${side}${dir > 0 ? '+' : '-'}`;
    button.disabled = dir > 0 ? value >= WHATIF_MAX_GOALS : !value;
    button.setAttribute('aria-label', t(dir > 0 ? 'whatif.more' : 'whatif.fewer', { team: name }));
    const icon = svgEl('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false', fill: 'none', stroke: 'currentColor', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    icon.appendChild(svgEl('path', { d: dir > 0 ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6' }));
    button.appendChild(icon);
    button.addEventListener('click', () => onStep(side, dir));
    return button;
  };
  // No score yet: an empty slot, waiting to be filled.
  box.append(arrow(1), el('span', `whatif-step__value${value == null ? ' is-empty' : ''}`, value == null ? '' : String(value)), arrow(-1));
  return box;
}

/* The likeliest score for an outcome ('home', 'draw', 'away') among a
   fixture's scorelines, or the plainest one (1-0, 1-1, 0-1) where none of
   the listed scorelines has that outcome. */
function whatIfOutcomeScore(scorelines, outcome) {
  const of = (h, a) => (h > a ? 'home' : h < a ? 'away' : 'draw');
  const best = [...(scorelines || [])].sort((x, y) => y.probability - x.probability)
    .find((line) => of(line.home_goals, line.away_goals) === outcome);
  if (best) return [best.home_goals, best.away_goals];
  return { home: [1, 0], draw: [1, 1], away: [0, 1] }[outcome];
}

/* A match as the Matches view draws it, with its score made editable: the two
   goal counts step up and down. Under it a fixture keeps its odds, across the
   card, and its likeliest scorelines (a tap on one locks it), both as the
   locked results leave them (`shown`); a result keeps its xG, which stays as
   played. Back to the real score unlocks. */
function whatIfCard(item, step, set, shown, auto) {
  const { match, played } = item;
  const id = String(match.match_id);
  const actual = played ? [match.home_goals, match.away_goals] : null;
  const lock = state.whatIfLocks.get(id) || null;
  const score = lock || actual;
  const card = el('div', `played-card whatif-card${lock ? ' is-locked' : ''}`);
  card.dataset.matchId = id;
  if (score && score[0] > score[1]) card.classList.add('played-card--home-win');
  else if (score && score[1] > score[0]) card.classList.add('played-card--away-win');
  const date = el('div', 'played-card__date', formatDate(match.date)
    + (match.round ? ` · ${t('played.round', { n: match.round })}` : '')
    + (!played && match.time ? ` · ${match.time}` : ''));
  // A set score is flagged in the date line, and the flag is its undo: back
  // to the real score of a result, or no score on a fixture.
  if (lock) {
    const label = played ? t('whatif.was', { score: `${actual[0]}–${actual[1]}` }) : t(auto ? 'whatif.filled' : 'whatif.locked');
    const undo = played ? t('whatif.backTo', { score: `${actual[0]}–${actual[1]}` }) : t('whatif.clear');
    const flag = el('button', 'whatif-flag', label);
    flag.type = 'button';
    flag.title = undo;
    flag.setAttribute('aria-label', `${label}: ${undo}`);
    const icon = svgEl('svg', { viewBox: '0 0 24 24', width: 10, height: 10, 'aria-hidden': 'true', focusable: 'false', fill: 'none', stroke: 'currentColor', 'stroke-width': 3, 'stroke-linecap': 'round' });
    icon.appendChild(svgEl('path', { d: 'M6 6l12 12M18 6L6 18' }));
    flag.appendChild(icon);
    flag.addEventListener('click', () => set(item, null));
    date.appendChild(flag);
  }
  card.appendChild(date);

  const matchup = el('div', 'played-card__matchup');
  const homeSide = el('div', 'played-card__side played-card__side--home');
  homeSide.appendChild(sideBlock(match.home, match.home_id, false));
  const editor = el('div', 'whatif-score');
  editor.append(
    whatIfStepper('h', match.home, score ? score[0] : null, step),
    el('span', 'whatif-score__dash', '–'),
    whatIfStepper('a', match.away, score ? score[1] : null, step),
  );
  const awaySide = el('div', 'played-card__side played-card__side--away');
  awaySide.appendChild(sideBlock(match.away, match.away_id, true));
  matchup.append(homeSide, editor, awaySide);
  card.appendChild(matchup);

  const foot = el('div', 'whatif-card__foot');
  if (played) {
    if (match.xg) foot.appendChild(el('span', 'played-card__xg', `xG ${num(match.xg[0], 1)}–${num(match.xg[1], 1)}`));
  } else {
    const odds = shown || match;
    // One tap per match on a phone: home win, draw or away win, each as its
    // likeliest score; the steppers and scorelines refine it. A tap on the
    // outcome already set clears it.
    const outcomes = el('div', 'whatif-outcomes');
    outcomes.setAttribute('role', 'group');
    outcomes.setAttribute('aria-label', t('whatif.outcome.label'));
    const setOutcome = lock ? (lock[0] > lock[1] ? 'home' : lock[0] < lock[1] ? 'away' : 'draw') : null;
    for (const outcome of ['home', 'draw', 'away']) {
      const pill = el('button', 'whatif-outcome', t(`whatif.outcome.${outcome}`));
      pill.type = 'button';
      pill.dataset.outcome = outcome;
      const on = setOutcome === outcome;
      pill.setAttribute('aria-pressed', String(on));
      pill.setAttribute('aria-label', t(`whatif.outcome.${outcome}Long`, { home: match.home, away: match.away }));
      pill.addEventListener('click', () => set(item, on ? null : whatIfOutcomeScore(odds.scorelines, outcome)));
      outcomes.appendChild(pill);
    }
    foot.appendChild(outcomes);
    foot.appendChild(oddsBar(match.home, match.away, odds));
    const chips = el('div', 'whatif-chips');
    for (const line of (odds.scorelines || []).slice(0, 4)) {
      const chip = el('button', 'whatif-chip', `${line.home_goals}–${line.away_goals} ${pct(line.probability, 0)}`);
      chip.type = 'button';
      const on = !!lock && lock[0] === line.home_goals && lock[1] === line.away_goals;
      chip.setAttribute('aria-pressed', String(on));
      chip.setAttribute('aria-label', t('aria.scoreline', { score: `${line.home_goals}-${line.away_goals}`, pct: pct(line.probability, 1) }));
      chip.addEventListener('click', () => set(item, on ? null : [line.home_goals, line.away_goals]));
      chips.appendChild(chip);
    }
    foot.appendChild(chips);
  }
  card.appendChild(foot);
  return card;
}

function renderWhatIf(report, body) {
  whatIfLeave();
  if (!report.model.attack_defence?.teams || !(report.fixtures || []).every((game) => game.home_rating != null)) {
    body.replaceChildren(el('p', 'explore-empty', t('whatif.unavailable')));
    return;
  }
  if (!(report.results || []).length && !(report.fixtures || []).length) {
    body.replaceChildren(el('p', 'explore-empty', t('played.empty')));
    return;
  }
  const prepared = whatIfPrepare(report);
  const key = prepared.id;
  const known = (id) => prepared.fixtureAt.has(id) || prepared.played.has(id);
  const activeLocks = () => new Map([...state.whatIfLocks].filter(([id]) => known(id)));
  const games = new Map([...(report.results || []), ...(report.fixtures || [])].map((game) => [String(game.match_id), game]));
  const cards = new Map();
  let runs = null;
  let failure = null;
  // The fixtures priced at the clubs as the locks before them leave them.
  let priced = null;

  const wrap = el('div', 'whatif');
  const list = el('div', 'fixtures whatif__list');
  list.id = 'whatif-list';
  const bar = el('button', 'whatif__bar');
  bar.type = 'button';
  // The bar's text says what the changes did; its end says where a tap goes.
  const barText = el('span', 'whatif__bar-text');
  const barGo = el('span', 'whatif__bar-go', t('whatif.barGo'));
  barGo.setAttribute('aria-hidden', 'true');
  bar.append(barText, barGo);
  const impact = el('section', 'whatif__impact');
  impact.setAttribute('aria-label', t('whatif.impact.title'));
  const left = el('div', 'whatif__matches');
  left.append(list, bar);
  // How it works sits under the chances, closed; only a report that cannot
  // re-rate says so up front, since it changes what the numbers mean.
  if (!prepared.rerate) wrap.appendChild(el('p', 'explore-note whatif__note', t('whatif.noRerate')));
  wrap.append(left, impact);
  let howOpen = false;
  body.replaceChildren(wrap);
  // A tap on the bar goes to the table of chances, remembering where the
  // reader was in the matches; the table's "back" button returns there.
  let backTo = null;
  bar.addEventListener('click', () => {
    backTo = window.scrollY;
    impact.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const goBack = () => {
    if (backTo != null) window.scrollTo({ top: backTo, behavior: 'smooth' });
    else list.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // The summary bar sits above the phone's tab bar, whatever height that has.
  const tabs = $('#mobilebar');
  wrap.style.setProperty('--whatif-bar-bottom', `${tabs && getComputedStyle(tabs).display !== 'none' ? tabs.offsetHeight : 0}px`);

  // Re-rate the clubs for the locks, a few milliseconds a replay of the
  // season's 240 matches. A changed result counts for every fixture; a locked
  // fixture counts as played, in the order the fixtures come, only for the
  // fixtures of later weeks: this week's odds stay as they were whatever is
  // set this week or after. One replay per week with locks before it.
  const rerate = () => {
    const locks = activeLocks();
    priced = null;
    if (!locks.size || !prepared.rerate) return;
    const changed = new Map();
    for (const [id, score] of locks) if (prepared.played.has(id)) changed.set(id, score);
    const kickoff = (i) => `${prepared.games[i].game.date} ${prepared.games[i].game.time || ''}`;
    const locked = prepared.games.map((_, i) => i)
      .filter((i) => locks.has(String(prepared.games[i].game.match_id)))
      .sort((a, b) => kickoff(a).localeCompare(kickoff(b)) || a - b);
    const rows = locked.map((i) => {
      const { game } = prepared.games[i];
      const score = locks.get(String(game.match_id));
      return [String(game.match_id), String(game.home_id), String(game.away_id), score[0], score[1], null, null, null, null];
    });
    const stages = whatIfStages(prepared.games, locked);
    const byStage = new Map();
    stages.forEach((stage, i) => (byStage.get(stage) || byStage.set(stage, []).get(stage)).push(i));
    priced = new Array(prepared.games.length);
    for (const [stage, indices] of byStage) {
      const prices = !stage && !changed.size
        ? indices.map((i) => prepared.baseline[i])
        : whatIfPrice(report, prepared, rerateSeason(prepared.rerate, changed, rows.slice(0, stage)), indices);
      indices.forEach((at, k) => { priced[at] = prices[k]; });
    }
  };

  const shownFor = (match) => {
    const at = prepared.fixtureAt.get(String(match.match_id));
    return at === undefined ? null : whatIfShown(prepared.games[at].game, prepared.baseline[at], priced && priced[at]);
  };

  const paintImpact = (updating) => {
    const locks = activeLocks();
    const rows = whatIfRows(report, locks.size ? runs : null);
    const swing = whatIfSwing(rows);
    const count = report.table.length;
    impact.classList.toggle('is-updating', updating);
    impact.replaceChildren();

    const head = el('div', 'whatif-impact__head');
    head.appendChild(el('h3', 'whatif-impact__title', t('whatif.impact.title')));
    if (locks.size) {
      const reset = el('button', 'whatif-reset', t('whatif.resetAll'));
      reset.type = 'button';
      reset.addEventListener('click', resetAll);
      // The changed results live in the address (?lock=): shared as the
      // link, from the panel that shows what they do, in either tab.
      const actions = el('div', 'whatif-impact__actions');
      actions.append(reset, shareButton({ title: () => t('share.whatif') }));
      head.appendChild(actions);
    }
    impact.appendChild(head);
    // On a phone, where the table is below the matches: the way back up.
    const back = el('button', 'whatif-back', t('whatif.backToMatches'));
    back.type = 'button';
    back.addEventListener('click', goBack);
    impact.appendChild(back);

    if (locks.size) {
      const filled = [...locks.keys()].filter((id) => state.whatIfAuto.has(id)).length;
      const own = locks.size - filled;
      const parts = [];
      if (own) parts.push(t(own === 1 ? 'whatif.changeOne' : 'whatif.changeMany', { n: own }));
      if (filled) parts.push(t('whatif.autoCount', { n: filled }));
      const meta = el('button', 'whatif-impact__meta', `${parts.join(' \u00b7 ')} \u2192`);
      meta.type = 'button';
      meta.title = t('whatif.show');
      meta.addEventListener('click', () => {
        state.whatIfView = 'changes';
        paintMatches();
        list.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      impact.appendChild(meta);
    }

    let line = t('whatif.impact.none');
    if (locks.size) {
      line = swing
        ? t('whatif.swing', { team: swing.row.team, band: shortBandLabel(swing.band, report), from: stakePct(swing.before, currentLang), to: stakePct(swing.after, currentLang) })
        : t(updating ? 'whatif.updating' : 'whatif.noSwing');
    }
    if (failure) line = t('whatif.failed', { error: failure });
    impact.appendChild(el('p', `whatif-impact__line${failure ? ' whatif-impact__line--error' : ''}`, line));
    barText.textContent = line;
    bar.setAttribute('aria-label', `${line} ${t('whatif.barGo')}`);
    bar.classList.toggle('is-quiet', !locks.size);

    const table = el('table', 'whatif-table');
    const headRow = el('tr');
    headRow.appendChild(el('th', 'whatif-table__club', t('table.col.club')));
    headRow.appendChild(el('th', '', t('whatif.col.pts')));
    for (const band of report.league.bands) {
      const th = el('th', '', shortBandLabel(band, report));
      th.title = bandName(band);
      headRow.appendChild(th);
    }
    table.appendChild(el('thead')).appendChild(headRow);
    const involved = new Set();
    for (const id of locks.keys()) {
      involved.add(String(games.get(id).home_id));
      involved.add(String(games.get(id).away_id));
    }
    const tbody = el('tbody');
    // A change as a small signed figure; a blank line holds its place when it rounds to nothing.
    const delta = (value, digits, better) => {
      const shown = Math.round(value * 10 ** digits) / 10 ** digits;
      return shown ? el('span', `whatif-delta whatif-delta--${better ? 'good' : 'bad'}`, signed(value, digits)) : el('span', 'whatif-delta', ' ');
    };
    const order = [...rows].sort((a, b) => b.pointsAfter - a.pointsAfter || a.row.team.localeCompare(b.row.team));
    for (const entry of order) {
      const tr = el('tr', involved.has(String(entry.row.team_id)) ? 'is-involved' : '');
      const club = el('th', 'whatif-table__club');
      club.scope = 'row';
      const crest = teamLogo(entry.row.team_id, entry.row.team, true);
      if (crest) club.appendChild(crest);
      club.appendChild(el('span', '', entry.row.team));
      tr.appendChild(club);
      const points = el('td', 'whatif-table__pts');
      points.appendChild(el('span', 'whatif-chance', num(entry.pointsAfter, entry.shownDigits)));
      points.appendChild(delta(entry.pointsAfter - entry.pointsBefore, 1, entry.pointsAfter > entry.pointsBefore));
      tr.appendChild(points);
      for (const { band, before, after } of entry.bands) {
        const cell = el('td');
        // A chance that rounds to nothing recedes, so the live ones stand out.
        const text = pct(after, 1);
        cell.appendChild(el('span', `whatif-chance${text === '—' ? ' is-nil' : ''}`, text));
        // More of a good band is good news, more of a bad one is not.
        const good = band.first < (count + 1) / 2;
        cell.appendChild(delta((after - before) * 100, 1, good ? after > before : after < before));
        tr.appendChild(cell);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    const scroller = el('div', 'whatif-table__wrap');
    scroller.appendChild(table);
    impact.appendChild(scroller);
    // The method and how to read the table, closed until asked for; it stays
    // as the reader left it while the panel is redrawn.
    const how = el('details', 'luck-how whatif-how');
    how.open = howOpen;
    how.addEventListener('toggle', () => { howOpen = how.open; });
    how.appendChild(el('summary', 'luck-how__title', t('whatif.how')));
    how.append(el('p', '', t('whatif.note')), el('p', '', t('whatif.tableNote')));
    impact.appendChild(how);
  };

  // The locks in the address, so a reload or a shared link brings them back.
  const syncUrl = () => {
    const params = new URLSearchParams(window.location.search);
    const text = lockParam(state.whatIfLocks, report);
    if (text) params.set('lock', text);
    else params.delete('lock');
    window.history.replaceState(entryState(), '', `${window.location.pathname}?${params.toString()}${window.location.hash}`);
  };

  const schedule = () => {
    clearTimeout(whatIfTimer);
    const token = (whatIfToken += 1);
    const locks = activeLocks();
    syncUrl();
    if (!locks.size) {
      runs = null;
      failure = null;
      paintImpact(false);
      return;
    }
    paintImpact(true);
    whatIfTimer = setTimeout(async () => {
      try {
        const { base, scenario } = whatIfSpecs(report, prepared, locks, priced);
        const result = await runSeasonSim(key, base, scenario);
        if (token !== whatIfToken) return;
        runs = result;
        failure = null;
      } catch (error) {
        if (token !== whatIfToken) return;
        failure = error.message;
      }
      paintImpact(false);
    }, 150);
  };

  // Something about the locks changed: re-rate, redraw the cards (the odds on
  // every fixture move with the ratings) and queue the runs.
  const update = () => {
    rerate();
    paintMatches();
    schedule();
  };

  const makeCard = (item) => whatIfCard(item, (side, dir) => step(side, dir, item), set,
    item.played ? null : shownFor(item.match), state.whatIfAuto.has(String(item.match.match_id)));

  // Lock a score (null clears it; the real score of a result clears it too).
  const set = (item, score) => {
    const { match, played } = item;
    const id = String(match.match_id);
    const actual = played ? [match.home_goals, match.away_goals] : null;
    state.whatIfAuto.delete(id);
    if (!score || (actual && score[0] === actual[0] && score[1] === actual[1])) state.whatIfLocks.delete(id);
    else state.whatIfLocks.set(id, score);
    update();
  };

  const step = (side, dir, item) => {
    const { match, played } = item;
    const current = state.whatIfLocks.get(String(match.match_id)) || (played ? [match.home_goals, match.away_goals] : null);
    const move = (goals) => Math.max(0, Math.min(WHATIF_MAX_GOALS, goals + dir));
    // The first press on a fixture starts a score: 1-0 or 0-1 up, 0-0 down.
    const next = !current ? (dir > 0 ? (side === 'h' ? [1, 0] : [0, 1]) : [0, 0])
      : side === 'h' ? [move(current[0]), current[1]] : [current[0], move(current[1])];
    set(item, next);
  };

  // Every fixture not yet locked, in `scope` (the week on show, or all), takes
  // its likeliest result at the odds the locks so far leave it.
  const fill = (scope) => {
    const week = scope === 'week' ? matchesTimeline(report, state.whatIfWeek) : null;
    const wanted = week
      ? (week.byWeek.get(week.weeks[week.index]) || []).filter((item) => !item.played).map((item) => item.match)
      : prepared.games.map(({ game }) => game);
    for (const match of wanted) {
      const id = String(match.match_id);
      if (state.whatIfLocks.has(id) || !prepared.fixtureAt.has(id)) continue;
      state.whatIfLocks.set(id, shownFor(match).likeliest);
      state.whatIfAuto.add(id);
    }
    update();
  };

  const clearFill = () => {
    for (const id of state.whatIfAuto) state.whatIfLocks.delete(id);
    state.whatIfAuto.clear();
    update();
  };

  const resetAll = () => {
    for (const id of activeLocks().keys()) state.whatIfLocks.delete(id);
    state.whatIfAuto.clear();
    update();
  };

  // The buttons under the switch: auto-fill, in the week on show or everywhere,
  // and taking the fills away again.
  const tools = (names, hasWeekFixtures) => {
    const row = el('div', 'whatif-tools');
    const button = (name, label, handler, disabled, title) => {
      const node = el('button', 'whatif-tool', label);
      node.type = 'button';
      node.dataset.fill = name;
      node.disabled = disabled;
      if (title) node.title = title;
      node.addEventListener('click', handler);
      row.appendChild(node);
    };
    const open = [...prepared.fixtureAt.keys()].some((id) => !state.whatIfLocks.has(id));
    if (names.includes('week')) button('week', t('whatif.fillWeek'), () => fill('week'), !hasWeekFixtures, t('whatif.fillHint'));
    if (names.includes('all')) button('all', t('whatif.fillAll'), () => fill('all'), !open, t('whatif.fillHint'));
    if (names.includes('clear') && [...state.whatIfAuto].some((id) => state.whatIfLocks.has(id))) button('clear', t('whatif.clearFill'), clearFill, false);
    if (names.includes('reset')) button('reset', t('whatif.resetAll'), resetAll, false);
    return row;
  };

  // By week, or only the matches the reader has changed.
  const views = () => {
    const row = el('div', 'whatif-views-row');
    const bar = el('div', 'switch whatif-views');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', t('whatif.view'));
    for (const [mode, label] of [['week', t('whatif.byWeek')], ['changes', t('whatif.yourChanges')]]) {
      const button = el('button', '', label);
      button.type = 'button';
      button.dataset.view = mode;
      button.addEventListener('click', () => {
        state.whatIfView = mode;
        paintMatches();
      });
      bar.appendChild(button);
    }
    row.appendChild(bar);
    return row;
  };
  const viewsRow = views();
  // Built once, so the pill slides; only its marks follow the state.
  // Always shown, Your changes disabled until there is one: a switch that came
  // in with the first change pushed every card down under the pointer.
  const showViews = (count) => {
    for (const button of viewsRow.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(state.whatIfView === button.dataset.view));
      if (button.dataset.view !== 'changes') continue;
      button.disabled = !count;
      button.querySelector('.whatif-views__count')?.remove();
      if (count) button.appendChild(el('span', 'whatif-views__count', String(count)));
    }
  };

  // The card, arrow or button the reader had focus on, found again after the
  // list is drawn anew.
  const focusOf = () => {
    const active = document.activeElement;
    if (!active || !list.contains(active)) return null;
    return {
      id: active.closest('.whatif-card')?.dataset.matchId,
      step: active.dataset.step,
      fill: active.dataset.fill,
      view: active.dataset.view,
      chip: active.classList.contains('whatif-chip') ? [...active.parentNode.children].indexOf(active) : -1,
      reset: active.classList.contains('whatif-flag'),
    };
  };

  const refocus = (was) => {
    if (!was) return;
    const card = was.id ? cards.get(was.id) : null;
    const opposite = was.step && `${was.step[0]}${was.step[1] === '+' ? '-' : '+'}`;
    const target = was.view ? list.querySelector(`[data-view="${was.view}"]:not(:disabled)`)
      : was.fill ? list.querySelector(`[data-fill="${was.fill}"]:not(:disabled)`) || list.querySelector('[data-view="week"]')
        : !card ? null
          : was.step ? card.querySelector(`[data-step="${was.step}"]:not(:disabled)`) || card.querySelector(`[data-step="${opposite}"]:not(:disabled)`)
            : was.chip >= 0 ? card.querySelectorAll('.whatif-chip')[was.chip]
              : was.reset ? card.querySelector('[data-step="h+"]') : null;
    target?.focus();
  };

  const addCards = (parent, items) => {
    for (const item of items) {
      const card = makeCard(item);
      cards.set(String(item.match.match_id), card);
      parent.appendChild(card);
    }
  };

  // One week of results and fixtures, a page at a time.
  const paintWeek = () => {
    const { weeks, byWeek, firstUpcoming, current, index } = matchesTimeline(report, state.whatIfWeek);
    state.whatIfWeek = index;
    const go = (week) => () => { state.whatIfWeek = week; paintMatches(); };
    list.appendChild(pageNav(
      t('played.week', { n: weeks[index] }) + (index === current && firstUpcoming ? ` · ${t('matches.thisWeek')}` : ''),
      index > 0 ? go(index - 1) : null,
      index < weeks.length - 1 ? go(index + 1) : null,
    ));
    const items = byWeek.get(weeks[index]) || [];
    list.appendChild(tools(['week', 'all', 'clear'], items.some((item) => !item.played && prepared.fixtureAt.has(String(item.match.match_id)))));
    const both = items.some((item) => item.played) && items.some((item) => !item.played);
    for (const played of [true, false]) {
      const group = items.filter((item) => item.played === played);
      if (!group.length) continue;
      if (both) list.appendChild(el('div', 'label matches__group', t(played ? 'matches.results' : 'matches.upcoming')));
      addCards(list, group);
    }
  };

  // Every match the reader has changed, in date order, as the same cards, so a
  // change is edited where it is listed. The auto-filled ones sit in a group
  // of their own, closed: forty cards would bury the few that were chosen.
  const paintChanges = (locks) => {
    const items = [...locks.keys()].map((id) => ({ match: games.get(id), played: prepared.played.has(id) }))
      .sort((a, b) => `${a.match.date} ${a.match.time || ''} ${a.match.match_id}`.localeCompare(`${b.match.date} ${b.match.time || ''} ${b.match.match_id}`));
    const filled = items.filter((item) => state.whatIfAuto.has(String(item.match.match_id)));
    const own = items.filter((item) => !state.whatIfAuto.has(String(item.match.match_id)));
    list.appendChild(tools(filled.length ? ['clear', 'reset'] : ['reset']));
    addCards(list, own);
    if (!filled.length) return;
    const group = el('details', 'whatif-auto');
    group.open = state.whatIfAutoOpen || !own.length;
    group.addEventListener('toggle', () => { state.whatIfAutoOpen = group.open; });
    group.appendChild(el('summary', 'whatif-auto__summary', t('whatif.autoCount', { n: filled.length })));
    addCards(group, filled);
    list.appendChild(group);
  };

  const paintMatches = () => {
    const was = focusOf();
    const locks = activeLocks();
    if (!locks.size) state.whatIfView = 'week';
    for (const child of [...list.children]) if (child !== viewsRow) child.remove();
    cards.clear();
    showViews(locks.size);
    if (viewsRow.parentNode !== list) list.prepend(viewsRow);
    if (state.whatIfView === 'changes') paintChanges(locks);
    else paintWeek();
    refocus(was);
  };

  rerate();
  paintMatches();
  schedule();
}

if (typeof module !== 'undefined') {
  module.exports = { parseLocks, lockParam, whatIfShown, whatIfRows, whatIfSwing };
}
