/* ---------- explore: relegation play-off (viz=playoff) ----------------- */

/* The tie between Eliteserien's 14th and OBOS-ligaen's play-off winner as a
   grid (`report.relegation_playoff.pairs`): a row per club that can finish 14th,
   a column per club that can win OBOS-ligaen's bracket, a cell per pairing the
   runs produced. Rows and columns hold their share of the runs and how often the
   Eliteserien club stays up inside them; clubs under `minShare` are left off the
   grid (their pairings are noise at this run count) but stay in the overall figure. */
const PLAYOFF_MIN_SHARE = 0.005;
function playoffGrid(tie, minShare = PLAYOFF_MIN_SHARE) {
  const rows = new Map();
  const cols = new Map();
  const cells = new Map();
  let total = 0;
  let kept = 0;
  const add = (map, id, pair) => {
    const side = map.get(id) || { id, name: tie.teams[id] || id, total: 0, kept: 0 };
    side.total += pair.p;
    side.kept += pair.p * pair.stay;
    map.set(id, side);
  };
  for (const pair of tie.pairs) {
    add(rows, pair.top, pair);
    add(cols, pair.bottom, pair);
    cells.set(`${pair.top}|${pair.bottom}`, pair);
    total += pair.p;
    kept += pair.p * pair.stay;
  }
  const shown = (map) => [...map.values()]
    .filter((side) => side.total >= minShare)
    .map((side) => ({ ...side, stay: side.kept / side.total }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return { rows: shown(rows), cols: shown(cols), cells, total, stay: total ? kept / total : 0 };
}

function renderPlayoff(report, body) {
  const tie = report.relegation_playoff;
  if (!tie || (!tie.pairs.length && !tie.survival?.length)) {
    body.replaceChildren(el('p', 'explore-empty', t('playoff.empty')));
    return;
  }
  const wrap = el('div', 'playoff');
  if (tie.pairs.length) wrap.appendChild(tie.settled ? playoffSettled(tie) : playoffMatrix(report, tie));
  if (tie.survival?.length) wrap.appendChild(playoffSurvival(tie));
  body.replaceChildren(wrap);
}

/* A club's crest and name, opening its page. */
function playoffClub(id, name, className) {
  const club = el('button', className);
  club.type = 'button';
  const crest = teamLogo(id, name, true);
  if (crest) club.appendChild(crest);
  club.appendChild(el('span', '', name));
  club.addEventListener('click', () => openTeamView(id, name));
  return club;
}

/* A played play-off: the two clubs and what came of it. */
function playoffSettled(tie) {
  const [pair] = tie.pairs;
  const top = tie.teams[pair.top];
  const bottom = tie.teams[pair.bottom];
  const box = el('section', 'playoff__settled');
  const clubs = el('div', 'playoff__versus');
  clubs.append(playoffClub(pair.top, top, 'playoff__club'), el('span', 'playoff__v', t('playoff.v')), playoffClub(pair.bottom, bottom, 'playoff__club'));
  box.append(clubs, el('p', 'explore-note', t(pair.stay ? 'playoff.settled.stayed' : 'playoff.settled.down', { top, bottom })));
  return box;
}

/* "N of 100 seasons": how often something happens, as a whole number out of a
   hundred ("<1" for what rounds to none). */
function playoffOf100(share) {
  const n = Math.round(share * 100);
  return n < 1 ? '<1' : num(n);
}

/* The ties worth a card: pairings of at least `minShare` of the runs (thinner
   ones are Monte Carlo noise, so no chance of winning is printed for them), most
   common first, at most `limit`. */
function playoffCards(tie, minShare = 0.01, limit = 6) {
  return tie.pairs.filter((pair) => pair.p >= minShare).sort((a, b) => b.p - a.p).slice(0, limit);
}

/* The ladder replaced semi-finals in this season's play-off (mirrors LADDER_FROM in
   simulation/playoffs.py). */
const PLAYOFF_LADDER_FROM = 2019;
/* The dates NFF drew for a season's play-offs (nff.no, "Slik spilles
   kvalifiseringskampene", 22 Oct 2026): the bracket's rounds, then the two legs of
   the tie with Eliteserien's 14th. A season not listed shows its bracket without dates. */
const PLAYOFF_CALENDAR = {
  2026: { rounds: ['2026-11-22', '2026-11-29', '2026-12-06'], legs: ['2026-12-17', '2026-12-21'] },
};

/* "5th" in English, "5." in Norwegian. */
function playoffPlace(n) {
  if (currentLang === 'no') return `${n}.`;
  const last = n % 100 > 10 && n % 100 < 14 ? 0 : n % 10;
  return `${n}${last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th'}`;
}

/* A copy string with its {n} drawn as a figure in display type. */
function playoffSentence(key, figure, className) {
  const line = el('p', className);
  const [before, after = ''] = t(key, { n: '\u0000' }).split('\u0000');
  line.append(before, el('b', `${className}-n`, figure), after);
  return line;
}

/* The answer first: a hundred seasons as a hundred squares, in the colours of the
   two divisions, the division the page is read from first. */
function playoffHeadline(report, grid) {
  const obos = report.league.slug === 'obosligaen';
  const stay = Math.round(grid.stay * 100);
  const own = obos ? 100 - stay : stay;
  const box = el('section', 'playoff__headline');
  box.appendChild(playoffSentence(obos ? 'playoff.headline.obos' : 'playoff.headline.es', num(own), 'playoff__answer'));
  const waffle = el('div', 'playoff__waffle');
  waffle.setAttribute('role', 'img');
  waffle.setAttribute('aria-label', t('playoff.waffle.aria', { es: num(stay), obos: num(100 - stay) }));
  const first = obos ? 'obos' : 'es';
  const second = obos ? 'es' : 'obos';
  for (let i = 0; i < 100; i += 1) waffle.appendChild(el('span', `playoff__season playoff__season--${i < own ? first : second}`));
  const key = el('div', 'playoff__key');
  for (const side of [first, second]) {
    const item = el('span', `playoff__key-item playoff__key-item--${side}`);
    item.append(el('i', ''), `${t(`playoff.side.${side}`)}: ${num(side === 'es' ? stay : 100 - stay)}`);
    key.appendChild(item);
  }
  box.append(waffle, key);
  return box;
}

/* The knockout table: OBOS-ligaen's places 3-6 as the season's format has them
   (from 2019 a ladder, drawn rising round by round; before that two semi-finals
   and a final), then the two-legged tie with Eliteserien's 14th. A seed slot names
   the clubs likely to finish there, the 14th's slot those likely to finish 14th;
   each slot is edged in its division's colour. */
function playoffBracket(report, grid, tie) {
  const season = report.league.season;
  const ladder = season >= PLAYOFF_LADDER_FROM;
  const calendar = PLAYOFF_CALENDAR[season];
  const obosTable = state.reports?.obosligaen?.table || [];
  const seed = (place) => ({ seed: place });
  // A winner's slot names the match it comes from (its index in `tie.bracket`).
  const winner = (label, from) => ({ winner: label, from });
  const rounds = ladder
    ? [
      { title: 'playoff.round.1', matches: [[seed(5), seed(6)]] },
      { title: 'playoff.round.2', matches: [[seed(4), winner('playoff.winnerOf1', 0)]] },
      { title: 'playoff.round.3', matches: [[seed(3), winner('playoff.winnerOf2', 1)]] },
    ]
    : [
      { title: 'playoff.semi', matches: [[seed(3), seed(6)], [seed(4), seed(5)]] },
      { title: 'playoff.round.final', matches: [[winner('playoff.winnerOfSemi', 0), winner('playoff.winnerOfSemi', 1)]] },
    ];
  rounds.push({ title: 'playoff.tie', legs: true, matches: [[winner('playoff.bracketWinner', 2), { fourteenth: true }]] });

  const slot = (side) => {
    const clubs = side.winner
      ? (tie.bracket?.[side.from] ? playoffWinners(tie.bracket[side.from]) : side.from === 2 ? grid.cols.map((col) => ({ id: col.id, chance: col.total })) : [])
        .map((club) => ({ ...club, name: tie.teams[club.id] || club.id }))
      : side.fourteenth
        ? grid.rows.map((row) => ({ id: row.id, name: row.name, chance: row.total }))
        : obosTable.map((row) => ({ id: row.team_id, name: row.team, chance: row.position_probabilities[side.seed - 1] || 0 }));
    if (side.winner && !clubs.length) return el('div', 'playoff__slot playoff__slot--winner', t(side.winner));
    const box = el('div', `playoff__slot playoff__slot--${side.fourteenth ? 'es' : 'obos'}`);
    box.appendChild(el('span', 'playoff__slot-label', side.winner ? t(side.winner)
      : side.fourteenth ? t('playoff.eliteserien14th') : t('playoff.obosPlace', { place: playoffPlace(side.seed) })));
    const likely = clubs.filter((club) => club.chance >= 0.05).sort((a, b) => b.chance - a.chance).slice(0, 3);
    for (const club of likely) {
      const line = el('div', 'playoff__slot-club');
      line.append(playoffClub(club.id, club.name, 'playoff__club'), el('span', 'playoff__slot-chance', club.chance >= 0.995 ? '' : pct(club.chance, 0)));
      box.appendChild(line);
    }
    return box;
  };

  // The play-off's matches fotmob lists (`tie.matches`): a bracket match takes the
  // one among its pairings, the tie its two legs (the pairing that meets twice).
  const fixtures = tie.matches || [];
  const pairing = (fixture) => `${fixture.home}|${fixture.away}`;
  const bracketFixture = (index) => fixtures.find((fixture) => (tie.bracket?.[index] || [])
    .some((pair) => pairing(pair) === pairing(fixture)));
  const sides = (fixture) => [fixture.home, fixture.away].sort().join('|');
  const legs = fixtures.filter((fixture) => fixtures.filter((other) => sides(other) === sides(fixture)).length === 2);

  let played = 0; // the bracket's matches in order, as `tie.bracket` lists them
  const wrap = el('section', 'playoff__section');
  wrap.appendChild(el('h3', 'playoff__heading', t('playoff.how.title')));
  wrap.appendChild(el('p', 'playoff__intro', t(ladder ? 'playoff.bracket.note' : 'playoff.bracket.noteOld')));
  const scroller = el('div', 'playoff__scroll');
  const columns = el('ol', `playoff__rounds${ladder ? ' playoff__rounds--ladder' : ''}`);
  rounds.forEach((round, index) => {
    const column = el('li', `playoff__round${round.legs ? ' playoff__round--tie' : ''}`);
    column.style.setProperty('--step', String(rounds.length - 1 - index));
    column.appendChild(el('span', 'playoff__round-title', t(round.title)));
    if (calendar) {
      const dates = round.legs
        ? [t('playoff.leg1', { date: formatDate(calendar.legs[0]) }), t('playoff.leg2', { date: formatDate(calendar.legs[1]) })]
        : calendar.rounds[index] ? [formatDate(calendar.rounds[index])] : [];
      for (const date of dates) column.appendChild(el('span', 'playoff__round-date', date));
    }
    for (const [a, b] of round.matches) {
      const match = el('div', 'playoff__match');
      match.append(slot(a), slot(b));
      // The tie's pairings have a section of their own below, so only the
      // bracket's matches list theirs.
      if (!round.legs) {
        const fixture = bracketFixture(played);
        if (fixture) match.appendChild(playoffFixture(tie, fixture, calendar?.rounds[index]));
        const pairings = (tie.bracket?.[played] || []).map((pair) => ({ ...pair, tip: t('playoff.pairingTip', { home: tie.teams[pair.home], away: tie.teams[pair.away], p: pct(pair.p, 1), win: pct(pair.home_win, 0) }) }));
        played += 1;
        const list = playoffPairings(tie, pairings);
        if (list) match.appendChild(list);
      } else {
        legs.forEach((leg, i) => match.appendChild(playoffFixture(tie, leg, calendar?.legs[i])));
      }
      column.appendChild(match);
    }
    columns.appendChild(column);
  });
  scroller.appendChild(columns);
  wrap.appendChild(scroller);
  return wrap;
}

/* One play-off match as fotmob lists it: the score once played, else its kickoff
   (the date only where it is not the one the round's heading already gives). */
function playoffFixture(tie, fixture, roundDate) {
  const home = tie.teams[fixture.home] || fixture.home;
  const away = tie.teams[fixture.away] || fixture.away;
  const done = fixture.home_goals != null;
  const when = [fixture.date !== roundDate ? formatDate(fixture.date) : '', fixture.time || ''].filter(Boolean).join(' ');
  return el('p', `playoff__fixture${done ? ' playoff__fixture--played' : ''}`, done
    ? `${home} ${fixture.home_goals}–${fixture.away_goals} ${away}`
    : t('playoff.fixture.kickoff', { when }));
}

/* Who wins one of the bracket's matches (its pairings from `tie.bracket`): each
   club's share of the runs, likeliest first. */
function playoffWinners(match) {
  const won = new Map();
  const add = (id, share) => won.set(id, (won.get(id) || 0) + share);
  for (const pair of match) {
    add(pair.home, pair.p * pair.home_win);
    add(pair.away, pair.p * (1 - pair.home_win));
  }
  return [...won].map(([id, chance]) => ({ id, chance })).sort((a, b) => b.chance - a.chance);
}

/* A match's likeliest pairings, home side first: the three commonest of at least
   1 % of the runs, each with how often it comes up. Null where either side is
   settled (the slots above already say it all) or nothing clears the bar. */
function playoffLikely(pairings) {
  const common = [...pairings].filter((pair) => pair.p >= 0.01).sort((a, b) => b.p - a.p);
  // With one side settled (the ladder's seed at home), the pairings only repeat
  // the other slot's clubs, so there is nothing to add.
  const oneSide = (side) => common.every((pair) => pair[side] === common[0][side]);
  return !common.length || oneSide('home') || oneSide('away') ? [] : common.slice(0, 3);
}

function playoffPairings(tie, pairings) {
  const likely = playoffLikely(pairings);
  if (!likely.length) return null;
  const box = el('div', 'playoff__pairings');
  box.appendChild(el('span', 'playoff__slot-label', t('playoff.likely')));
  for (const pair of likely) {
    const line = el('div', 'playoff__pairing');
    const names = el('span', 'playoff__pairing-names');
    for (const [index, id] of [pair.home, pair.away].entries()) {
      if (index) names.appendChild(el('span', 'playoff__pairing-v', '–'));
      const crest = teamLogo(id, tie.teams[id], true);
      if (crest) names.appendChild(crest);
      names.appendChild(el('span', '', tie.teams[id] || id));
    }
    line.append(names, el('b', 'playoff__slot-chance', pct(pair.p, 0)));
    line.tabIndex = 0;
    line.setAttribute('aria-label', pair.tip);
    attachTip(line, pair.tip);
    box.appendChild(line);
  }
  return box;
}

/* One side of the tie: the clubs that can be there, each with how often (a bar
   and "N of 100 seasons") and what follows; the five likeliest, the rest as one line. */
function playoffSide(side, title, entries) {
  const box = el('div', `playoff__side playoff__side--${side}`);
  box.appendChild(el('h4', 'playoff__side-title', title));
  const largest = Math.max(...entries.map((entry) => entry.total));
  const line = (club, total, tail) => {
    const row = el('div', 'playoff__line');
    const bar = el('div', 'playoff__bar');
    const fill = el('span', 'playoff__bar-fill');
    fill.style.width = `${(total / largest * 100).toFixed(1)}%`;
    bar.appendChild(fill);
    row.append(club, el('span', 'playoff__of100', t('playoff.of100', { n: playoffOf100(total) })), bar);
    if (tail) row.appendChild(el('span', 'playoff__tail', tail));
    box.appendChild(row);
  };
  for (const entry of entries.slice(0, 5)) line(playoffClub(entry.id, entry.name, 'playoff__club'), entry.total, entry.tail);
  const rest = entries.slice(5).reduce((sum, entry) => sum + entry.total, 0);
  if (rest >= 0.005) line(el('span', 'playoff__club playoff__club--rest', t('playoff.others')), rest, null);
  return box;
}

/* One likely tie, as a scoreboard: how often it comes up, each club with its
   chance of winning it, and the split between them in the divisions' colours. */
function playoffCard(tie, pair) {
  const top = tie.teams[pair.top];
  const bottom = tie.teams[pair.bottom];
  const card = el('div', 'playoff__card');
  card.appendChild(el('p', 'playoff__freq', t('playoff.card.freq', { n: playoffOf100(pair.p) })));
  for (const [id, name, chance, side] of [[pair.top, top, pair.stay, 'es'], [pair.bottom, bottom, 1 - pair.stay, 'obos']]) {
    const row = el('div', `playoff__card-club playoff__card-club--${side}`);
    row.append(playoffClub(id, name, 'playoff__club'), el('b', 'playoff__card-chance', pct(chance, 0)));
    card.appendChild(row);
  }
  const split = el('div', 'playoff__split');
  split.setAttribute('role', 'img');
  split.setAttribute('aria-label', t('playoff.tip', { top, bottom, p: pct(pair.p, 1), stay: pct(pair.stay, 0) }));
  const kept = el('span', 'playoff__split-es');
  kept.style.width = `${(pair.stay * 100).toFixed(2)}%`;
  split.append(kept, el('span', 'playoff__split-obos'));
  card.appendChild(split);
  return card;
}

function playoffMatrix(report, tie) {
  const grid = playoffGrid(tie);
  const box = el('div', 'playoff__view');
  box.appendChild(el('p', 'playoff__lead', t('playoff.lead')));
  box.appendChild(playoffHeadline(report, grid));
  box.appendChild(playoffBracket(report, grid, tie));

  const who = el('section', 'playoff__section');
  who.appendChild(el('h3', 'playoff__heading', t('playoff.who')));
  const sides = el('div', 'playoff__sides');
  sides.append(
    playoffSide('es', t('playoff.who.es'), grid.rows.map((row) => ({ ...row, tail: t('playoff.rowTail', { p: pct(row.stay, 0) }) }))),
    playoffSide('obos', t('playoff.who.obos'), grid.cols.map((col) => ({ ...col, tail: t('playoff.colTail', { p: pct(1 - col.stay, 0) }) }))),
  );
  who.appendChild(sides);
  box.appendChild(who);

  const ties = el('section', 'playoff__section');
  ties.append(el('h3', 'playoff__heading', t('playoff.ties')), el('p', 'playoff__intro', t('playoff.ties.note')));
  const cards = el('div', 'playoff__cards');
  for (const pair of playoffCards(tie)) cards.appendChild(playoffCard(tie, pair));
  ties.appendChild(cards);
  box.appendChild(ties);

  box.appendChild(playoffAll(grid, report));
  return box;
}

/* Every pairing in one grid, closed until asked for: each cell is the chance the
   Eliteserien club stays up in it, tinted in the favoured division's colour, and
   more strongly the more one-sided the tie. Under it, how the numbers are made. */
function playoffAll(grid, report) {
  const details = el('details', 'playoff__all');
  details.appendChild(el('summary', '', t('playoff.all')));
  details.appendChild(el('p', 'playoff__intro', t('playoff.allNote')));
  const scroller = el('div', 'playoff__scroll');
  const table = el('table', 'playoff__table');
  table.setAttribute('aria-label', t('playoff.aria'));
  const head = el('tr');
  head.appendChild(el('th', 'playoff__corner'));
  for (const col of grid.cols) {
    const th = el('th', 'playoff__col');
    th.appendChild(playoffClub(col.id, col.name, 'playoff__club playoff__club--col'));
    head.appendChild(th);
  }
  table.appendChild(head);
  for (const row of grid.rows) {
    const tr = el('tr');
    const name = el('th', 'playoff__row');
    name.appendChild(playoffClub(row.id, row.name, 'playoff__club'));
    tr.appendChild(name);
    for (const col of grid.cols) {
      const pair = grid.cells.get(`${row.id}|${col.id}`);
      if (!pair || pair.p < PLAYOFF_MIN_SHARE / 10) { tr.appendChild(el('td', 'playoff__none')); continue; }
      const cell = el('td', 'playoff__cell');
      // The favoured division's colour, stronger the more one-sided the tie.
      const lean = Math.abs(pair.stay - 0.5) * 2;
      cell.style.background = `color-mix(in oklab, var(${pair.stay >= 0.5 ? '--tier-1' : '--tier-2'}) ${(12 + 48 * lean).toFixed(0)}%, var(--panel))`;
      cell.textContent = pct(pair.stay, 0);
      const tip = t('playoff.tip', { top: row.name, bottom: col.name, p: pct(pair.p, 1), stay: pct(pair.stay, 0) });
      cell.tabIndex = 0;
      cell.setAttribute('aria-label', tip);
      attachTip(cell, tip);
      tr.appendChild(cell);
    }
    table.appendChild(tr);
  }
  scroller.appendChild(table);
  details.appendChild(scroller);
  const how = el('details', 'playoff__how');
  how.append(el('summary', '', t('playoff.how')), el('p', 'playoff__intro', t('playoff.note', { n: num(report.model.simulations) })));
  details.appendChild(how);
  return details;
}

/* OBOS-ligaen's 14th against a second-tier side, over two legs: its own report only. */
function playoffSurvival(tie) {
  const box = el('section', 'playoff__section playoff__survival');
  box.append(el('h3', 'playoff__heading', t('playoff.survival.title')), el('p', 'playoff__intro', t('playoff.survival.text')));
  for (const entry of tie.survival) {
    const name = tie.teams[entry.team_id] || entry.team_id;
    const row = el('div', 'playoff__survival-row');
    const split = el('div', 'playoff__split playoff__split--below');
    split.setAttribute('role', 'img');
    split.setAttribute('aria-label', `${t('playoff.survival.stays')}: ${pct(entry.stay, 0)}`);
    const kept = el('span', 'playoff__split-obos');
    kept.style.width = `${(entry.stay * 100).toFixed(2)}%`;
    split.append(kept, el('span', 'playoff__split-rest'));
    row.append(
      playoffClub(entry.team_id, name, 'playoff__club'),
      el('span', 'playoff__survival-p', t('playoff.survival.row', { p: pct(entry.p, 0) })),
      split,
      el('b', 'playoff__survival-stay', `${pct(entry.stay, 0)} ${t('playoff.survival.stays')}`),
    );
    box.appendChild(row);
  }
  return box;
}

if (typeof module !== 'undefined') {
  module.exports = { PLAYOFF_MIN_SHARE, playoffGrid, playoffOf100, playoffCards, playoffWinners, playoffLikely };
}
