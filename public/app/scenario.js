/* ---------- how a finish happens ----------------------------------- */

/* A click (or Enter) on a grid cell opens how that finish happens. The
   evidence is the browser's own simulation, the one the What if page runs
   (`season-sim.js`, in its worker): the season is played 50,000 times with
   every score kept, and `scenarioAnalysis` reads them. It shows the likeliest
   of the seasons that end this way, table and all: the club's own matches, the
   other clubs' results in it that are clearly more common here than usually,
   and every result behind a fold. The key matches can be locked into What if in
   one click.
   Pointing at any cell starts the worker's season (`scenarioWarm`), so the
   click finds it played; with no run-in stakes and no play-offs, as What if
   states, its figures sit a little off the grid's. */
const scenarioState = { token: 0, root: null, trigger: null, untrap: null, onKey: null };
// Whether the season shown avoids a finish decided on goal difference (the default; see `scenarioAnalysis`).
let scenarioAvoidTie = false;           // allowing goal difference is the default: the single likeliest run of results
const scenarioResults = new Map();
const scenarioWarmed = new WeakSet();
let scenarioLocal = null;

/* The what-if page's own condition: the report carries the goals model, and
   there is a season left to play. */
function scenarioAvailable(report) {
  return !!report.model?.attack_defence?.teams && (report.fixtures || []).length > 0
    && report.fixtures.every((game) => game.home_rating != null);
}

/* The analysis for one club and place; no club only plays the season, so a click
   later finds it done. A worker that cannot start falls back to this thread. */
async function scenarioRequest(report, club, place, avoidTie = false) {
  const prepared = whatIfPrepare(report);
  const key = `${prepared.id}:${club}:${place}:${avoidTie ? 1 : 0}`;
  if (club != null && scenarioResults.has(key)) return scenarioResults.get(key);
  const { base } = whatIfSpecs(report, prepared, new Map(), null);
  let analysis;
  try {
    analysis = (await workerCall({ type: 'scenario', key: prepared.id, base, club, place, avoidTie })).analysis;
  } catch (error) {
    if (!scenarioLocal || scenarioLocal.key !== prepared.id) scenarioLocal = { key: prepared.id, runs: simulateSeason({ ...base, record: true }).runs };
    analysis = club == null ? null : scenarioAnalysis(base, club, place, scenarioLocal.runs, { tiePenalty: avoidTie ? Math.LN2 : 0 });
  }
  if (club != null) scenarioResults.set(key, analysis);
  return analysis;
}

function scenarioWarm(report) {
  if (scenarioWarmed.has(report) || !scenarioAvailable(report)) return;
  scenarioWarmed.add(report);
  scenarioRequest(report, null, null).catch(() => {});
}

function scenarioUrl(value) {
  const params = new URLSearchParams(window.location.search);
  if (value) params.set('scenario', value);
  else params.delete('scenario');
  window.history.replaceState(entryState(), '', `${window.location.pathname}?${params.toString()}${window.location.hash}`);
}

function closeScenario({ restore = true } = {}) {
  const { root, trigger, untrap, onKey } = scenarioState;
  if (!root) return;
  scenarioState.token += 1;
  root.remove();
  document.body.classList.remove('has-scenario');
  document.removeEventListener('keydown', onKey);
  untrap?.();
  Object.assign(scenarioState, { root: null, trigger: null, untrap: null, onKey: null });
  scenarioUrl(null);
  if (restore && trigger?.isConnected) trigger.focus({ preventScroll: true });
}

function openScenario(report, teamId, position, trigger = null) {
  const club = report.table.findIndex((row) => String(row.team_id) === String(teamId));
  if (club < 0 || position < 1 || position > report.table.length || !scenarioAvailable(report)) return;
  const row = report.table[club];
  const place = position - 1;
  closeScenario({ restore: false });
  hideTooltip();
  const token = (scenarioState.token += 1);
  const sims = report.model.simulations;

  const root = el('div', 'scenario');
  const scrim = el('div', 'scenario__scrim');
  scrim.addEventListener('click', dismissScenario);
  const panel = el('div', 'scenario__panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'scenario-title');

  const head = el('header', 'scenario__head');
  const heading = el('div', 'scenario__heading');
  heading.appendChild(el('p', 'scenario__eyebrow', t('scenario.eyebrow')));
  const title = el('h2', 'scenario__title');
  title.id = 'scenario-title';
  const crest = teamLogo(row.team_id, row.team, true);
  if (crest) title.appendChild(crest);
  title.appendChild(document.createTextNode(t('scenario.title', { team: row.team, place: ordinal(position) })));
  heading.appendChild(title);
  const close = el('button', 'scenario__close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', t('scenario.close'));
  close.addEventListener('click', dismissScenario);
  // Shared as the club's chance of this place (share.js), or as the link.
  head.append(heading, shareButton({
    title: () => t('scenario.title', { team: row.team, place: ordinal(position) }),
    image: () => shareFinish(report, row.team_id, position),
  }), close);

  // The chance as the site's display figure, with what it is counted on in one quiet line.
  const chance = pct(row.position_probabilities[place], 1);
  const hero = el('div', 'scenario__hero');
  const figure = el('p', 'scenario__figure', chance.replace(/\s?%$/, ''));
  figure.appendChild(el('small', '', '%'));
  const heroText = el('div', 'scenario__hero-text');
  const heroSub = el('p', 'scenario__sub', t('scenario.heroSub', { n: '…', total: num(sims), left: num(report.fixtures.length) }));
  heroText.append(el('p', 'scenario__label', t('scenario.statChance')), heroSub);
  hero.append(figure, heroText);

  const body = el('div', 'scenario__body');
  body.setAttribute('aria-live', 'polite');
  body.appendChild(el('p', 'scenario__wait', t('scenario.wait', { n: num(sims) })));
  let latest = 0;
  const load = () => {
    const mine = (latest += 1);
    scenarioRequest(report, club, place, scenarioAvoidTie).then((analysis) => {
      if (token !== scenarioState.token || mine !== latest) return;
      heroSub.textContent = t('scenario.heroSub', { n: num(analysis.hits), total: num(sims), left: num(report.fixtures.length) });
      about.note.textContent = t('scenario.note', { n: num(analysis.sims) });
      scenarioFill(body, report, club, analysis);
      // The buttons the body now holds belong in the focus loop; focus stays
      // where the reader had it (trapFocus moves it to the first button).
      const active = document.activeElement;
      scenarioState.untrap?.();
      scenarioState.untrap = trapFocus(panel);
      (panel.contains(active) && active !== document.body ? active : close).focus();
    }).catch(() => {
      if (token !== scenarioState.token || mine !== latest) return;
      body.replaceChildren(el('p', 'scenario__wait', t('scenario.failed')));
    });
  };
  // On a phone the popup is a bottom sheet: a grip over a head that stays
  // put while the matches and the table scroll under it, and a swipe down
  // closes it, as the More sheet does.
  const grip = el('div', 'scenario__grip');
  grip.setAttribute('aria-hidden', 'true');
  const top = el('div', 'scenario__top');
  top.append(grip, head);
  // The reading notes and the goal-difference switch sit folded under the body, outside it, so a
  // switch press keeps the fold open and the focus where it was while the body is redrawn.
  const about = scenarioAbout(load, sims);
  panel.append(top, hero, body, about.fold);
  root.append(scrim, panel);
  document.body.appendChild(root);
  document.body.classList.add('has-scenario');
  attachSheetDrag(panel, { scrim, dismiss: dismissScenario, handle: '.scenario__top' });

  // Escape with the share sheet open over the popup closes only the sheet (share.js).
  const onKey = (event) => { if (event.key === 'Escape' && !shareOpen()) dismissScenario(); };
  document.addEventListener('keydown', onKey);
  Object.assign(scenarioState, { root, trigger, onKey, untrap: trapFocus(panel) });
  // The popup opens on its close button, as before it had a share button
  // ahead of it.
  close.focus();
  pushOverlay('scenario');
  scenarioUrl(`${row.team_id}:${position}`);

  load();
}

/* Whether a season decided on goal difference is avoided or allowed (the
   default); it lives in the reading notes, beside what the two modes mean. */
function scenarioModeSwitch(onChange) {
  const wrap = el('div', 'scenario__mode');
  const bar = el('div', 'switch');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', t('scenario.mode'));
  for (const [avoid, key] of [[true, 'scenario.modeAvoid'], [false, 'scenario.modeAllow']]) {
    const button = el('button', '', t(key));
    button.type = 'button';
    button.setAttribute('aria-pressed', String(scenarioAvoidTie === avoid));
    button.addEventListener('click', () => {
      if (scenarioAvoidTie === avoid) return;
      scenarioAvoidTie = avoid;
      for (const other of bar.children) other.setAttribute('aria-pressed', String(other === button));
      onChange();
    });
    bar.appendChild(button);
  }
  wrap.append(bar);
  return wrap;
}

function scenarioSection(title, lead) {
  const section = el('section', 'scenario-section');
  section.appendChild(el('h3', 'scenario-section__title', title));
  if (lead) section.appendChild(el('p', 'scenario-section__lead', lead));
  return section;
}

function scenarioSide(row) {
  const side = el('span', 'scenario-side');
  const crest = teamLogo(row.team_id, row.team, true);
  if (crest) side.appendChild(crest);
  side.appendChild(el('span', '', row.team));
  return side;
}

/* The fixtures in the order they are played. */
function scenarioByDate(prepared, indices) {
  return [...indices].sort((a, b) => {
    const x = prepared.games[a].game;
    const y = prepared.games[b].game;
    return `${x.date} ${x.time || ''}`.localeCompare(`${y.date} ${y.time || ''}`) || a - b;
  });
}

function scenarioWhen(game) {
  return `${game.round ? `${t('played.round', { n: game.round })} · ` : ''}${formatDate(game.date)}`;
}

/* Which way a score went: 0 a home win, 1 a draw, 2 an away win. */
const scenarioOutcome = ([h, a]) => (h > a ? 0 : h === a ? 1 : 2);

/* A match as the scenario plays it: the winner in bold, the other side dim. */
function scenarioScoreLine(report, prepared, f, typical) {
  const { home, away } = prepared.games[f];
  const [h, a] = typical.scores[f];
  const homeSide = scenarioSide(report.table[home]);
  const awaySide = scenarioSide(report.table[away]);
  if (h !== a) (h > a ? awaySide : homeSide).classList.add('is-loser');
  const line = el('div', 'scenario-match__teams');
  line.append(homeSide, el('span', 'scenario-match__score', `${h}–${a}`), awaySide);
  return line;
}

/* One match of the scenario as a sentence about one club's result in it, the
   result the season shown plays: the club's own match from its side ("Beat
   Brann", "Lose to Sandefjord"), another match from the side that matters
   (`subject`: "Bodø/Glimt lose to Molde"). A chip carries the same result in
   colour; beside it the Matches page's odds bar, drawn from all the simulations,
   with that result lit and the rest muted, and that result's chance. */
function scenarioMatchRow(report, prepared, analysis, f, subject, own = false) {
  const { home, away, game } = prepared.games[f];
  const score = analysis.typical.scores[f];
  const atHome = home === subject;
  const mine = atHome ? score : [score[1], score[0]];
  const letter = mine[0] > mine[1] ? 'W' : mine[0] === mine[1] ? 'D' : 'L';
  const item = el('div', 'scenario-match');
  item.appendChild(el('span', `form__chip form__chip--${letter.toLowerCase()}`, t(`form.${letter}`)));
  const sentence = t(`scenario.${own ? 'own' : 'they'}${letter}`, { team: report.table[subject].team, other: report.table[atHome ? away : home].team });
  const text = el('div', 'scenario-match__body');
  const meta = el('p', 'scenario-match__meta');
  meta.append(venueIcon(atHome, { badge: false }), document.createTextNode(` ${t(atHome ? 'scenario.home' : 'scenario.away')} · ${scenarioWhen(game)}`));
  text.append(el('p', 'scenario-match__main', sentence), meta);
  const bar = oddsBar(report.table[home].team, report.table[away].team, { home_win: analysis.prior[f * 3], draw: analysis.prior[f * 3 + 1], away_win: analysis.prior[f * 3 + 2] });
  const shown = scenarioOutcome(score);
  [...bar.children].forEach((segment, o) => segment.classList.toggle('is-scenario', o === shown));
  // The lit result's chance as a figure beside the bar, as its segment is often too narrow to hold one.
  const odds = el('div', 'scenario-match__odds');
  odds.append(bar, el('span', 'scenario-match__pct', pct(analysis.prior[f * 3 + shown], 0)));
  item.append(text, odds);
  return item;
}

/* The side of a key match that matters to the club: the one that must not win
   where the analysis says so, else the one nearer the club in today's table. */
function scenarioSubject(report, prepared, club, decider) {
  if (decider.team != null) return decider.team;
  const { home, away } = prepared.games[decider.f];
  const gap = (c) => Math.abs(report.table[c].position - report.table[club].position);
  return gap(home) <= gap(away) ? home : away;
}

/* The key matches the scenario shows: those the analysis found where the
   scenario's result is on the side that raises the share. A draw counts as one
   side not winning (Tromsø – Glimt 2–2 is a draw in 22 % of simulations, but
   Glimt not winning is 42 % of them and 58 % of these), and says which. */
function scenarioDeciders(prepared, analysis) {
  return analysis.key.filter((entry) => entry.outcomes.includes(scenarioOutcome(analysis.typical.scores[entry.f]))).map((entry) => {
    const { home, away } = prepared.games[entry.f];
    const pair = entry.outcomes.length > 1;
    return { f: entry.f, outcomes: entry.outcomes, team: pair ? (entry.outcomes.includes(0) ? away : home) : null };
  });
}

/* A club's name as an owner: Norwegian adds an s ("Vikings"), only an apostrophe after s, x or z. */
const scenarioOwner = (name) => t(/[sxz]$/i.test(name) ? 'scenario.ownerAlt' : 'scenario.owner', { team: name });

function scenarioKey(report, prepared, club, analysis, deciders) {
  // Nothing outside the club's hands: one quiet line, not a section with a heading over a box.
  if (!deciders.length) return el('p', 'scenario__alone', t('scenario.stepsNone', { team: report.table[club].team }));
  const section = scenarioSection(t('scenario.stepsTitle', { owner: scenarioOwner(report.table[club].team) }), null);
  const byF = new Map(deciders.map((decider) => [decider.f, decider]));
  const list = el('div', 'scenario-matches');
  for (const f of scenarioByDate(prepared, byF.keys())) list.appendChild(scenarioMatchRow(report, prepared, analysis, f, scenarioSubject(report, prepared, club, byF.get(f))));
  section.appendChild(list);
  return section;
}

/* The club's own matches in the scenario, and what they add up to. */
function scenarioOwn(report, prepared, club, analysis) {
  const team = report.table[club].team;
  const results = [0, 0, 0];
  for (const f of analysis.own) {
    const score = analysis.typical.scores[f];
    const mine = prepared.games[f].home === club ? score : [score[1], score[0]];
    results[mine[0] > mine[1] ? 0 : mine[0] === mine[1] ? 1 : 2] += 1;
  }
  const total = analysis.typical.table.find((entry) => entry.club === club).points;
  const lead = t('scenario.ownSum', { pts: results[0] * 3 + results[1], max: analysis.own.length * 3, total });
  const section = scenarioSection(t('scenario.ownTitle', { owner: scenarioOwner(team) }), lead);
  const list = el('div', 'scenario-matches');
  for (const f of scenarioByDate(prepared, analysis.own)) list.appendChild(scenarioMatchRow(report, prepared, analysis, f, club, true));
  section.appendChild(list);
  return section;
}

/* The final table of the scenario, read against the real one: the places a club
   gains or loses on today's table, its goals for and against, and the points it
   takes from the matches left. Clubs that play one of the key matches carry a dot. */
function scenarioTable(report, club, typical, keyClubs) {
  const section = scenarioSection(t('scenario.tableTitle'), null);
  const table = el('table', 'scenario-table');
  table.setAttribute('aria-label', t('scenario.tableTitle'));
  const headRow = el('tr');
  headRow.append(el('th', '', '#'), el('th', '', t('table.col.club')), el('th', '', t('scenario.tableGoals')), el('th', '', t('scenario.tableGd')), el('th', '', t('scenario.tableGain')), el('th', '', t('scenario.tablePts')));
  table.appendChild(el('thead')).appendChild(headRow);
  const tbody = el('tbody');
  const count = typical.table.length;
  typical.table.forEach((entry, i) => {
    const now = report.table[entry.club];
    const tr = el('tr', entry.club === club ? 'is-self' : '');
    const band = bandFor(report.league.bands, i + 1);
    const place = el('td', 'scenario-table__pos');
    place.appendChild(el('span', '', String(i + 1)));
    const moved = now.position - (i + 1);
    if (moved) place.appendChild(el('small', `scenario-table__move ${moved > 0 ? 'is-up' : 'is-down'}`, changeText(moved)));
    if (band) place.style.boxShadow = `inset 3px 0 0 ${bandColor(band, count)}`;
    const team = el('td', 'scenario-table__club');
    team.appendChild(scenarioSide(now));
    if (keyClubs.has(entry.club)) {
      const dot = el('span', 'scenario-table__key', '●');
      dot.title = t('scenario.tableKey');
      team.appendChild(dot);
    }
    const goals = `${entry.goalsFor}–${entry.goalsFor - entry.goalDifference}`;
    tr.append(place, team, el('td', 'scenario-table__goals', goals), el('td', 'scenario-table__gd', signed(entry.goalDifference)), el('td', 'scenario-table__gain', `+${entry.points - now.points}`), el('td', 'scenario-table__pts', String(entry.points)));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  const scroller = el('div', 'scenario-table__wrap');
  scroller.appendChild(table);
  section.appendChild(scroller);
  if (keyClubs.size) section.appendChild(el('p', 'explore-note', `● ${t('scenario.tableKey')}`));
  const at = typical.table.findIndex((entry) => entry.club === club);
  const mine = typical.table[at];
  const level = [typical.table[at - 1], typical.table[at + 1]].filter((next) => next && next.points === mine.points);
  if (level.length) {
    // Level on points: goal difference decides; if that is level too, goals scored; then the table's order.
    const team = report.table[club].team;
    const sameGd = level.find((next) => next.goalDifference === mine.goalDifference);
    const sameGoals = sameGd && level.find((next) => next.goalDifference === mine.goalDifference && next.goalsFor === mine.goalsFor);
    let note = t('scenario.tableLevel', { team });
    if (sameGoals) note = t('scenario.tableLevelIndex', { team, other: report.table[sameGoals.club].team });
    else if (sameGd) note = t('scenario.tableLevelGoals', { team, other: report.table[sameGd.club].team, gd: signed(mine.goalDifference), gf: mine.goalsFor, gfOther: sameGd.goalsFor });
    section.appendChild(el('p', 'explore-note', note));
  }
  return section;
}

/* Every result of the scenario behind a fold, round by round. The club's own
   matches are lifted out, and the results the odds had against are marked. */
function scenarioAll(report, prepared, club, analysis) {
  const { typical, own } = analysis;
  const ownSet = new Set(own);
  const more = el('details', 'scenario-all');
  more.appendChild(el('summary', '', t('scenario.all', { n: prepared.games.length })));
  const rounds = new Map();
  for (const f of scenarioByDate(prepared, prepared.games.keys())) {
    const round = prepared.games[f].game.round ?? prepared.games[f].game.date;
    if (!rounds.has(round)) rounds.set(round, []);
    rounds.get(round).push(f);
  }
  for (const [round, fixtures] of rounds) {
    const group = el('div', 'scenario-all__round');
    group.appendChild(el('h4', 'scenario-all__heading', typeof round === 'number' ? t('played.round', { n: round }) : formatDate(round)));
    const grid = el('div', 'scenario-all__grid');
    for (const f of fixtures) {
      const outcome = scenarioOutcome(typical.scores[f]);
      const favourite = [0, 1, 2].reduce((best, o) => (analysis.prior[f * 3 + o] > analysis.prior[f * 3 + best] ? o : best), 0);
      const row = el('div', `scenario-all__row${ownSet.has(f) ? ' is-own' : ''}${outcome !== favourite ? ' is-odds' : ''}`);
      row.appendChild(scenarioScoreLine(report, prepared, f, typical));
      grid.appendChild(row);
    }
    group.appendChild(grid);
    more.appendChild(group);
  }
  const legend = el('p', 'scenario-all__legend');
  legend.append(el('span', 'is-own', t('scenario.ownTitle', { owner: scenarioOwner(report.table[club].team) })), el('span', 'is-odds', t('scenario.legendOdds')));
  more.appendChild(legend);
  return more;
}

/* The reading notes, folded away: the goal-difference switch and what its two
   modes mean, what the figures beside a match are, what they are counted on.
   `note` is the last line, which the analysis fills in with its own count. */
function scenarioAbout(onChange, sims) {
  const fold = el('details', 'scenario__about');
  fold.appendChild(el('summary', '', t('scenario.about')));
  const note = el('p', 'scenario__howto', t('scenario.note', { n: num(sims) }));
  fold.append(scenarioModeSwitch(onChange), el('p', 'scenario__howto', t('scenario.modeNote')), el('p', 'scenario__howto', t('scenario.chanceNote')), note);
  return { fold, note };
}

/* The club's own run-in first, then what it needs from the others, the table
   it ends in, the way into What if, and every result behind a fold. */
function scenarioFill(body, report, club, analysis) {
  if (!analysis.enough) {
    body.replaceChildren(el('p', 'scenario__wait', analysis.hits >= analysis.sims ? t('scenario.sure')
      : t('scenario.rare', { n: num(analysis.hits), total: num(analysis.sims) })));
    return;
  }
  const prepared = whatIfPrepare(report);
  const deciders = scenarioDeciders(prepared, analysis);
  const lock = el('button', 'scenario__lock', `${t('scenario.lock')} →`);
  lock.type = 'button';
  lock.addEventListener('click', () => lockScenario(prepared, [...analysis.own, ...deciders.map((d) => d.f)], analysis.typical));
  body.replaceChildren(
    scenarioOwn(report, prepared, club, analysis),
    scenarioKey(report, prepared, club, analysis, deciders),
    scenarioTable(report, club, analysis.typical, new Set(deciders.flatMap((d) => [prepared.games[d.f].home, prepared.games[d.f].away]).filter((c) => c !== club))),
    lock,
    scenarioAll(report, prepared, club, analysis),
  );
}

/* The key matches, as the scores of the simulated season shown, in What if.
   What if locks scores, not results, and re-rates the clubs for them, so its
   figures come out near the popup's, not equal to them. */
function lockScenario(prepared, fixtures, typical) {
  for (const f of fixtures) state.whatIfLocks.set(String(prepared.games[f].game.match_id), typical.scores[f]);
  closeScenario({ restore: false });
  state.activeView = 'explore';
  state.exploreItem = 'whatif';
  state.whatIfWeek = null;
  state.whatIfView = 'changes';
  markActiveView();
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

/* ?scenario=<team id>:<place> reopens a popup from a link. */
function applyScenarioParameter() {
  const found = /^(\w+):(\d{1,2})$/.exec(new URLSearchParams(window.location.search).get('scenario') || '');
  if (found && state.activeView === 'grid') openScenario(state.reports[state.league], found[1], Number(found[2]));
}
