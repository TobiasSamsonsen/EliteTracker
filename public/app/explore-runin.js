/* ---------- explore: run-in heatmap (viz=runin) ------------------------ */

/* Each club's remaining fixtures in date order, and the mean of what they are
   worth in points a match; easiest run-in first. `average` is null for the
   club's own odds, or a function (opponent rating, at home) -> { win, draw,
   loss } for how an average side of the league would fare in the same game. */
function runInRows(table, fixtures, average = null) {
  const rows = new Map(table.map((row) => [row.team_id, { team_id: row.team_id, team: row.team, games: [] }]));
  const ordered = [...fixtures].sort((a, b) => a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || '')));
  const game = (f, home) => {
    const own = home
      ? { win: f.home_win, draw: f.draw, loss: f.away_win }
      : { win: f.away_win, draw: f.draw, loss: f.home_win };
    const odds = average ? average(home ? f.away_rating : f.home_rating, home) : own;
    return {
      date: f.date, opponent_id: home ? f.away_id : f.home_id, opponent: home ? f.away : f.home, home,
      win: odds.win, draw: odds.draw, loss: odds.loss, points: 3 * odds.win + odds.draw,
    };
  };
  for (const f of ordered) {
    rows.get(f.home_id)?.games.push(game(f, true));
    rows.get(f.away_id)?.games.push(game(f, false));
  }
  return [...rows.values()]
    .filter((row) => row.games.length)
    .map((row) => ({ ...row, points: row.games.reduce((sum, g) => sum + g.points, 0) / row.games.length }))
    .sort((a, b) => b.points - a.points || a.team.localeCompare(b.team));
}

/* An average side of the league's price for a game: the mean of the table's
   ratings against the opponent's, from the ratings alone as the table's
   Fix Diff column is. */
function averageSidePrice(report) {
  const ratings = report.table.map((row) => row.rating).filter((rating) => rating != null);
  const mean = ratings.reduce((sum, rating) => sum + rating, 0) / (ratings.length || 1);
  return (opponentRating, home) => {
    const odds = home ? matchOdds(report.model, mean, opponentRating) : matchOdds(report.model, opponentRating, mean);
    return home
      ? { win: odds.home_win, draw: odds.draw, loss: odds.away_win }
      : { win: odds.away_win, draw: odds.draw, loss: odds.home_win };
  };
}

function renderRunIn(report, body) {
  const fixtures = report.fixtures || [];
  if (!runInRows(report.table, fixtures).length) {
    body.replaceChildren(el('p', 'explore-empty', t('runin.empty')));
    return;
  }
  // The switch is built once and only marked afresh, so its pill slides.
  const wrap = el('div', 'runin');
  const modes = el('div', 'runin__modes');
  const bar = el('div', 'switch');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', t('runin.mode'));
  const content = el('div', 'runin__content');
  const draw = () => {
    for (const button of bar.children) button.setAttribute('aria-pressed', String(state.runInMode === button.dataset.mode));
    drawRunIn(report, content, state.runInMode === 'average');
  };
  for (const mode of ['average', 'team']) {
    const button = el('button', '', t(`runin.mode.${mode}`));
    button.type = 'button';
    button.dataset.mode = mode;
    button.addEventListener('click', () => {
      state.runInMode = mode;
      draw();
    });
    bar.appendChild(button);
  }
  modes.appendChild(bar);
  wrap.append(modes, content);
  body.replaceChildren(wrap);
  draw();
}

/* The note, the grid and the key figures, for the club's own odds or an
   average team's. */
function drawRunIn(report, content, average) {
  const rows = runInRows(report.table, report.fixtures || [], average ? averageSidePrice(report) : null);
  const wrap = el('div', 'runin__view');
  wrap.appendChild(el('p', 'explore-note explore-note--lead', t(`runin.note.${average ? 'average' : 'team'}`)));
  const scroller = el('div', 'runin__scroll');
  const table = el('table', 'runin__table');
  table.setAttribute('aria-label', t('runin.aria'));
  const most = Math.max(...rows.map((row) => row.games.length));
  const head = el('tr');
  head.appendChild(el('th', 'runin__corner', t('runin.club')));
  head.appendChild(el('th', 'runin__avg', t('runin.avg')));
  for (let i = 1; i <= most; i += 1) head.appendChild(el('th', '', i === 1 ? t('runin.next') : String(i)));
  table.appendChild(head);
  for (const row of rows) {
    const tr = el('tr');
    const name = el('th', 'runin__club');
    const crest = teamLogo(row.team_id, row.team, true);
    if (crest) name.appendChild(crest);
    name.appendChild(el('span', '', row.team));
    name.addEventListener('click', () => openTeamView(row.team_id, row.team));
    tr.appendChild(name);
    tr.appendChild(el('td', 'runin__avg', num(row.points, 2)));
    for (const game of row.games) {
      // The ramp runs over the 0-3 points a match can give.
      const cell = el('td', `runin__cell${game.points >= 1.65 ? ' cell--invert' : ''}`);
      cell.style.background = seqColor(game.points / 3);
      const logo = teamLogo(game.opponent_id, game.opponent);
      if (logo) cell.appendChild(logo);
      cell.appendChild(venueIcon(game.home, { badge: false, className: 'runin__venue' }));
      cell.appendChild(el('b', '', num(game.points, 2)));
      const tip = t('runin.tip', {
        subject: average ? t('runin.averageSide') : row.team, opponent: game.opponent,
        venue: t(game.home ? 'runin.homeLong' : 'runin.awayLong'), date: game.date, points: num(game.points, 2),
        win: pct(game.win, 0), draw: pct(game.draw, 0), loss: pct(game.loss, 0),
      });
      cell.tabIndex = 0;
      cell.setAttribute('aria-label', tip);
      attachTip(cell, tip);
      tr.appendChild(cell);
    }
    for (let i = row.games.length; i < most; i += 1) tr.appendChild(el('td', 'runin__none'));
    table.appendChild(tr);
  }
  scroller.appendChild(table);
  wrap.appendChild(scroller);

  const games = rows.flatMap((row) => row.games.map((game) => ({ ...game, team: row.team })));
  const easiest = rows[0];
  const hardest = rows[rows.length - 1];
  const best = [...games].sort((a, b) => b.points - a.points)[0];
  wrap.appendChild(exploreFacts([
    { value: hardest.team, label: t('runin.fact.hardest'), text: t('runin.fact.runText', { points: num(hardest.points, 2), n: hardest.games.length }) },
    { value: easiest.team, label: t('runin.fact.easiest'), text: t('runin.fact.runText', { points: num(easiest.points, 2), n: easiest.games.length }) },
    { value: num(easiest.points - hardest.points, 2), label: t('runin.fact.gap'), text: t('runin.fact.gapText', { points: num((easiest.points - hardest.points) * Math.min(hardest.games.length, easiest.games.length), 1) }) },
    { value: num(best.points, 2), label: t('runin.fact.surest'), text: t('runin.fact.surestText', { team: best.team, opponent: best.opponent, date: best.date }) },
  ]));
  content.replaceChildren(wrap);
}

if (typeof module !== 'undefined') {
  module.exports = { runInRows };
}
