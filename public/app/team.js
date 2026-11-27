/* ---------- team: one club's focus view ----------------------------- */

/* Show the division the club plays in this season. Clubs move between the
   two, so this runs on opening a club and again whenever a season loads. */
function followTeamLeague(teamId) {
  const currentReport = state.reports?.[state.league];
  if (!currentReport || currentReport.table.some((t) => String(t.team_id) === String(teamId))) return;
  for (const [league, report] of Object.entries(state.reports)) {
    if (report.table.some((t) => String(t.team_id) === String(teamId))) {
      state.league = league;
      for (const button of document.querySelectorAll('[data-league]')) {
        button.setAttribute('aria-pressed', String(button.dataset.league === league));
      }
      return;
    }
  }
}

function openTeamView(teamId, fallbackName) {
  if (anim.playing) animStop();
  followTeamLeague(teamId);
  state.teamFocusId = teamId;
  state.teamFixturesPage = 0;
  state.teamResultsPage = 0;
  state.teamResultsOpen = false;
  state.teamSeasonsPage = 0;
  state.activeView = 'team';
  markActiveView();
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

/* The club header stays on top; everything else sits in three groups behind
   a segmented control -- this season, the forecast, the club's history -- so
   a phone shows one group at a time instead of eleven sections in a row.
   Only the open group is drawn: the charts size themselves to their box,
   which a hidden panel does not have. A finished season has no forecast. */
const TEAM_TABS = [['overview', 'team.tab.overview'], ['forecast', 'team.tab.forecast'], ['history', 'team.tab.history'], ['referees', 'team.tab.referees']];

function renderTeamView(report) {
  const teamId = state.teamFocusId;
  const content = $('#team-content');
  if (!content) { console.error('[TeamView] team-content not found in DOM'); return; }
  content.replaceChildren();
  if (!teamId) { console.warn('[TeamView] no teamId'); return; }

  const back = el('button', 'team-back');
  back.type = 'button';
  back.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
  back.appendChild(el('span', '', t('team.back')));
  back.setAttribute('aria-label', t('team.back'));
  back.addEventListener('click', () => goBackOr(() => switchView('table')));

  const row = report.table.find((t) => String(t.team_id) === String(teamId));
  const career = careerById(teamId);
  const teamName = row?.team || career?.team || fallbackNameById(teamId) || 'Unknown';

  const safeRender = (fn, context = 'section') => {
    try { fn(); }
    catch (e) { console.error(`[TeamView] ${context} failed:`, e); }
  };

  safeRender(() => renderTeamSummary(teamId, row, career, report, content), 'summary');
  // Back is an icon at the head of the summary, not a row of its own.
  const summaryHead = content.querySelector('.team-summary__header');
  if (summaryHead) summaryHead.prepend(back);
  else content.prepend(back);
  // Shared as the club's card (share.js) while it plays in the season shown,
  // else as the link; beside "Make this your club", the club's other action.
  const clubActions = content.querySelector('.team-summary__actions');
  if (clubActions) clubActions.appendChild(shareButton({ title: teamName, image: row ? () => shareClub(report, teamId) : null }));

  const tabs = TEAM_TABS.filter(([key]) => key !== 'forecast' || (row && report.model?.matches_remaining > 0));
  if (!tabs.some(([key]) => key === state.teamTab)) state.teamTab = 'overview';
  const bar = el('div', 'switch team-tabs');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', t('team.tabs'));
  const drawTab = () => {
    if (state.teamTab === 'overview') {
      // One column on a phone, in this order, the tiles first; on a wide screen
      // the tiles run across the top, then the glance and the results stand
      // left and the standing (table, seasons) right.
      const overview = el('div', 'team-overview');
      content.appendChild(overview);
      safeRender(() => renderTeamNow(row, career, report, overview), 'now');
      safeRender(() => renderTeamGlance(teamId, report, overview), 'glance');
      const side = el('div', 'team-side');
      overview.appendChild(side);
      safeRender(() => renderTeamMiniTable(row, report, side), 'miniTable');
      safeRender(() => renderTeamPositions(career, side), 'positions');
      safeRender(() => renderTeamSplit(teamId, report, side), 'split');
      safeRender(() => renderTeamResults(teamId, teamName, report, overview), 'results');
    } else if (state.teamTab === 'forecast') {
      const forecast = el('div', 'team-forecast');
      content.appendChild(forecast);
      safeRender(() => {
        const section = renderTeamGridRow(teamId, row, report, forecast);
        if (section) renderTeamOutlook(section, row, report, teamId);
      }, 'outlook');
      safeRender(() => {
        const section = el('div', 'team-section');
        renderTeamStakes(section, report, teamId);
        renderRivalWatch(section, report, teamId);
        if (section.childNodes.length) forecast.appendChild(section);
      }, 'stakes');
      safeRender(() => renderTeamFixtures(teamId, teamName, report, forecast), 'fixtures');
    } else if (state.teamTab === 'referees') {
      safeRender(() => renderTeamReferees(teamId, teamName, report, content), 'referees');
    } else {
      if (career?.points?.length >= 2) safeRender(() => renderTeamRatingHistory(career, content), 'ratingHistory');
      safeRender(() => renderTeamPerformanceHistory(teamId, content, report), 'performance');
      if (career?.seasons?.length) safeRender(() => renderSeasonBySeason(career, teamId, content, report), 'seasons');
    }
  };
  for (const [key, label] of tabs) {
    const button = el('button', '', t(label));
    button.type = 'button';
    button.setAttribute('aria-pressed', String(key === state.teamTab));
    button.addEventListener('click', () => {
      if (state.teamTab === key) return;
      state.teamTab = key;
      track('select_team_tab', { tab: key });
      // Only the group below the tabs is drawn again: the header and the
      // tabs stay, so the pill slides within its own bar. The view keeps its
      // height while the group is redrawn, or a chart measuring its box
      // would lay the page out short and the browser pull the scroll up.
      for (const other of bar.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
      content.style.minHeight = `${content.offsetHeight}px`;
      while (bar.nextSibling) bar.nextSibling.remove();
      drawTab();
      content.style.minHeight = '';
    });
    bar.appendChild(button);
  }
  content.appendChild(bar);
  drawTab();
}

function fallbackNameById(teamId) {
  return allTeams().find((t) => String(t.team_id) === String(teamId))?.team;
}

/* Numbered pages in the shared control. `reversed` lists run newest first,
   so going back in time (Prev) is the next page up. */
function paginator(page, totalPages, go, reversed = false) {
  const earlier = reversed ? page + 1 : page - 1;
  const later = reversed ? page - 1 : page + 1;
  const valid = (p) => p >= 0 && p < totalPages;
  // Named for time rather than page order: on a newest-first list, page 1
  // with "Prev" live and "Next" dead read as the last page.
  return pageNav(
    t('page.of', { n: page + 1, total: totalPages }),
    valid(earlier) ? () => go(earlier) : null,
    valid(later) ? () => go(later) : null,
    reversed ? [t('page.older'), t('page.newer')] : [t('page.earlier'), t('page.later')],
  );
}

function renderTeamSummary(teamId, row, career, report, container) {
  const card = el('div', 'team-summary');

  const header = el('div', 'team-summary__header');

  // Crest
  const crest = teamLogo(teamId, row?.team || career?.team || '');
  if (crest) {
    crest.classList.add('team-logo--large');
    // 72px is past what the 96px WebP stays sharp at; the 192px original is.
    crest.src = `/logos/${teamId}.png`;
    header.appendChild(crest);
  }

  // Name (pushes right side to the end)
  const nameBlock = el('div', 'team-summary__name-block');
  nameBlock.appendChild(el('h3', 'team-summary__name', row?.team || career?.team || 'Unknown'));
  // Your club: the hero follows its races first.
  const ownBtn = el('button', 'team-summary__own');
  ownBtn.type = 'button';
  // The star alone on a phone; the words stay for a screen reader.
  const paintOwn = () => {
    const mine = ownClub() === String(teamId);
    const words = mine ? t('team.own.is') : t('team.own.make');
    ownBtn.setAttribute('aria-pressed', String(mine));
    ownBtn.title = words;
    ownBtn.replaceChildren(el('span', 'team-summary__own-star', mine ? '★' : '☆'), el('span', 'team-summary__own-words', words));
  };
  ownBtn.addEventListener('click', () => {
    setOwnClub(ownClub() === String(teamId) ? null : String(teamId));
    paintOwn();
  });
  paintOwn();
  // The club's actions in one row: your club, then the share button (renderTeamView).
  const actions = el('div', 'team-summary__actions');
  actions.appendChild(ownBtn);
  nameBlock.appendChild(actions);
  header.appendChild(nameBlock);

  // Rating block: [arrow + rating] / position
  const ratingBlock = el('div', 'team-summary__rating-block');
  const ratingLine = el('div', 'team-summary__rating-line');
  const teamName = row?.team || career?.team;
  const trend = computeRatingTrend(teamName, report);
  if (trend) {
    const trendEl = el('span', `team-summary__trend team-summary__trend--${trend.direction}`);
    trendEl.innerHTML = trend.svg;
    trendEl.setAttribute('role', 'img');
    trendEl.setAttribute('aria-label', trend.detail);
    trendEl.tabIndex = 0;
    // The site's own tooltip rather than a title: it shows at once, takes
    // the extra lines, and a tap brings it up on a phone.
    attachTip(trendEl, trend.tip);
    ratingLine.appendChild(trendEl);
  }
  const rating = Math.round(row?.rating || career?.current_rating || 0);
  ratingLine.appendChild(el('span', 'team-summary__rating', String(rating)));
  ratingBlock.appendChild(ratingLine);
  // Rank by rating across both divisions, like the ladder
  const allTeams = state.reports
    ? Object.values(state.reports).flatMap((r) => r.table.map((t) => ({ team_id: t.team_id, rating: t.rating })))
    : [];
  allTeams.sort((a, b) => b.rating - a.rating);
  const crossRank = allTeams.findIndex((t) => String(t.team_id) === String(teamId));
  const totalTeams = allTeams.length || report.table.length;
  ratingBlock.appendChild(el('span', 'team-summary__rating-pos', t('team.rankOf', { rank: rankText(crossRank >= 0 ? crossRank + 1 : (row?.position ?? 0)), total: totalTeams })));
  // How the club has played by its chances, labelled: an unlabelled second
  // arrow would read as a second opinion on the rating.
  const form = computeXgForm(teamName, report);
  if (form) {
    const formEl = el('span', 'team-summary__form');
    formEl.tabIndex = 0;
    formEl.setAttribute('aria-label', form.detail);
    const icon = el('span', `team-summary__form-icon team-summary__trend--${form.direction}`);
    icon.innerHTML = form.svg;
    formEl.append(el('span', 'team-summary__form-key', t('team.xgForm')), icon, el('span', '', form.label));
    attachTip(formEl, form.tip);
    ratingBlock.appendChild(formEl);
  }
  header.appendChild(ratingBlock);

  card.appendChild(header);
  container.appendChild(card);
}

/* The overview's first screen, after the club app's: what is next and how the
   club has played -- the next match in a card, then the last five as score
   chips (green win, grey draw, red loss) with the opponent's crest under each. */
function renderTeamGlance(teamId, report, container) {
  const mine = (m) => String(m.home_id) === String(teamId) || String(m.away_id) === String(teamId);
  const upcoming = [...(report.fixtures || [])].filter(mine).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 3);
  const next = upcoming[0];
  const last = [...(report.results || [])].filter((m) => mine(m) && m.home_goals != null)
    .sort((a, b) => a.date.localeCompare(b.date)).slice(-5);
  if (!next && !last.length) return;
  const section = el('div', 'team-section team-glance');
  if (next) {
    const card = el('div', 'team-card');
    card.appendChild(el('div', 'label', t('team.nextMatch')));
    const list = el('div', 'team-matches');
    const changes = buildRatingChanges(state.careers);
    upcoming.forEach((fixture, i) => {
      const line = teamMatchRow(fixture, teamId, report, changes);
      if (i) line.classList.add('team-match--later');
      list.appendChild(line);
    });
    card.appendChild(list);
    section.appendChild(card);
  }
  if (last.length) {
    const card = el('div', 'team-card');
    card.appendChild(el('div', 'label', t('team.lastFive', { n: last.length })));
    const chips = el('div', 'team-last');
    for (const match of last) {
      const home = String(match.home_id) === String(teamId);
      const [scored, conceded] = home ? [match.home_goals, match.away_goals] : [match.away_goals, match.home_goals];
      const letter = scored > conceded ? 'W' : scored < conceded ? 'L' : 'D';
      const opponent = home ? match.away : match.home;
      const opponentId = home ? match.away_id : match.home_id;
      const item = el('button', 'team-last__item');
      item.type = 'button';
      item.title = `${opponent} (${t(home ? 'team.homeShort' : 'team.awayShort')}) ${scored}–${conceded} · ${formatDate(match.date)}`;
      item.setAttribute('aria-label', item.title);
      item.appendChild(el('span', `team-last__score form__chip--${letter.toLowerCase()}`, `${scored}–${conceded}`));
      const crest = teamLogo(opponentId, opponent);
      if (crest) item.appendChild(crest);
      item.addEventListener('click', () => openTeamView(opponentId, opponent));
      chips.appendChild(item);
    }
    card.appendChild(chips);
    section.appendChild(card);
  }
  container.appendChild(section);
}

/* The division's table in three rows: the club's, with the club above and the
   one below (or the three leading places for the leader), and a link to the
   whole. Short columns -- played, goal difference, points -- so it fits. */
function renderTeamMiniTable(row, report, container) {
  if (!row) return;
  const table = [...report.table].sort((a, b) => a.position - b.position);
  const at = table.findIndex((r) => r.team_id === row.team_id);
  if (at < 0 || table.length < 3) return;
  // Five rows with the club in the middle, of which a phone keeps three.
  const wide = Math.min(5, table.length);
  const from = Math.max(0, Math.min(at - Math.floor(wide / 2), table.length - wide));
  const near = Math.max(0, Math.min(at - 1, table.length - 3));
  const section = el('div', 'team-section');
  const head = el('div', 'team-section__header');
  head.appendChild(el('div', 'label', report.league.name));
  const full = el('button', 'team-mini__full', t('team.fullTable'));
  full.type = 'button';
  full.addEventListener('click', () => switchView('table'));
  head.appendChild(full);
  section.appendChild(head);
  const grid = el('div', 'team-mini');
  const line = (cls, cells) => {
    const r = el(cls.includes('head') ? 'div' : 'button', `team-mini__row ${cls}`);
    if (r.tagName === 'BUTTON') r.type = 'button';
    cells.forEach((cell, i) => r.appendChild(typeof cell === 'string' ? el('span', i === 1 ? 'team-mini__club' : 'team-mini__num', cell) : cell));
    return r;
  };
  // Wins, draws and losses are for a wide screen: the phone keeps P, GD, Pts.
  const record = (cells) => [
    cells[0], cells[1], cells[2],
    ...cells.slice(3, 6).map((v) => el('span', 'team-mini__num team-mini__extra', v)),
    cells[6], cells[7],
  ];
  grid.appendChild(line('team-mini__head', record(['#', t('table.col.club'), t('team.mini.played'), t('form.W'), t('form.D'), t('form.L'), t('team.gd'), t('team.mini.pts')])));
  table.slice(from, from + wide).forEach((r, k) => {
    const club = el('span', 'team-mini__club');
    const crest = teamLogo(r.team_id, r.team, true);
    if (crest) club.appendChild(crest);
    club.appendChild(el('span', '', r.team));
    const far = from + k < near || from + k >= near + 3;
    const entry = line(`${r.team_id === row.team_id ? 'is-own' : ''}${far ? ' team-mini__row--far' : ''}`,
      record([String(r.position), club, String(r.played), String(r.wins ?? ''), String(r.draws ?? ''), String(r.losses ?? ''),
        signed(r.goal_difference), String(r.points)]));
    if (r.team_id !== row.team_id) entry.addEventListener('click', () => openTeamView(r.team_id, r.team));
    else entry.disabled = true;
    grid.appendChild(entry);
  });
  section.appendChild(grid);
  container.appendChild(section);
}

/* Where the club finished in its last ten seasons, as a line: the best place at
   the top, a circle on each year with its place, the line green where the club
   rose, red where it fell. The divisions share one scale, Eliteserien above
   OBOS-ligaen under a dashed rule, so a relegation is a drop through it; the
   division is the circle's colour, a title the gold, the season in play lit.
   After the club app's "historical table positions". */
function renderTeamPositions(career, container) {
  const seasons = (career?.seasons || []).slice(-10);
  if (seasons.length < 2) return;
  const LEAGUE_SIZE = 16;
  const tierOf = (record) => (record.league === 'eliteserien' ? 1 : 2);
  const rankOf = (record) => record.position + (tierOf(record) === 2 ? LEAGUE_SIZE : 0);
  const ranks = seasons.map(rankOf);
  const low = Math.min(...ranks);
  const high = Math.max(...ranks);
  const span = Math.max(high - low, 3);
  const W = 340;
  const gutter = 44; // the left, where the divisions are named
  const edge = 20;
  const top = 16;
  const bottom = 26;
  const H = Math.round(Math.min(180, Math.max(104, 48 + span * 7)));
  const x = (index) => gutter + (index / (seasons.length - 1)) * (W - gutter - edge);
  const y = (rank) => top + ((rank - low) / span) * (H - top - bottom);

  const section = el('div', 'team-section');
  section.appendChild(el('div', 'label', t('team.positions')));
  const svg = svgEl('svg', { class: 'team-positions', viewBox: `0 0 ${W} ${H}`, role: 'img' });
  svg.setAttribute('aria-label', seasons.map((r) => `${r.season} #${r.position}`).join(', '));

  // The rule between the divisions, when the line crosses it.
  if (low <= LEAGUE_SIZE && high > LEAGUE_SIZE) {
    const rule = y(LEAGUE_SIZE + 0.5);
    svg.appendChild(svgEl('line', { class: 'team-positions__rule', x1: 0, x2: W, y1: rule, y2: rule }));
    const up = svgEl('text', { class: 'team-positions__tier', x: 2, y: rule - 4 });
    up.textContent = 'ELITE';
    const down = svgEl('text', { class: 'team-positions__tier', x: 2, y: rule + 11 });
    down.textContent = 'OBOS';
    svg.append(up, down);
  }
  for (let i = 1; i < seasons.length; i += 1) {
    const change = ranks[i - 1] - ranks[i];
    svg.appendChild(svgEl('line', {
      class: `team-positions__seg team-positions__seg--${change > 0 ? 'up' : change < 0 ? 'down' : 'flat'}`,
      x1: x(i - 1), y1: y(ranks[i - 1]), x2: x(i), y2: y(ranks[i]),
    }));
  }
  seasons.forEach((record, i) => {
    const group = svgEl('g', { class: `team-positions__item${i === seasons.length - 1 ? ' is-now' : ''}` });
    const title = svgEl('title');
    title.textContent = `${record.season} \u00b7 ${record.league_name} \u00b7 #${record.position}`;
    const crowned = tierOf(record) === 1 && record.position === 1;
    group.append(
      title,
      svgEl('circle', { class: `team-positions__dot team-positions__dot--${crowned ? 'champion' : `tier${tierOf(record)}`}`, cx: x(i), cy: y(ranks[i]), r: 11 }),
    );
    const number = svgEl('text', { class: 'team-positions__num', x: x(i), y: y(ranks[i]) });
    number.textContent = String(record.position);
    const year = svgEl('text', { class: 'team-positions__year', x: x(i), y: H - 8 });
    year.textContent = String(record.season);
    group.append(number, year);
    svg.appendChild(group);
  });
  section.appendChild(svg);
  container.appendChild(section);
}

/* Home and away side by side: the season's record and goals from each, for a
   wide screen (a phone has the results list and the table for this). */
function renderTeamSplit(teamId, report, container) {
  const split = { home: { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 }, away: { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0 } };
  for (const m of report.results || []) {
    if (m.home_goals == null) continue;
    const home = String(m.home_id) === String(teamId);
    if (!home && String(m.away_id) !== String(teamId)) continue;
    const side = split[home ? 'home' : 'away'];
    const [gf, ga] = home ? [m.home_goals, m.away_goals] : [m.away_goals, m.home_goals];
    side.p += 1;
    side.gf += gf;
    side.ga += ga;
    side[gf > ga ? 'w' : gf < ga ? 'l' : 'd'] += 1;
  }
  if (!split.home.p && !split.away.p) return;
  const section = el('div', 'team-section team-split');
  section.appendChild(el('div', 'label', t('team.homeAway')));
  const grid = el('div', 'team-split__grid');
  const cells = (cls, values) => values.forEach((v, i) => grid.appendChild(el('span', `team-split__cell${i ? ' num' : ''} ${cls}`, v)));
  cells('team-split__head', ['', t('team.mini.played'), t('form.W'), t('form.D'), t('form.L'), t('team.gf'), t('team.ga'), t('team.mini.pts')]);
  for (const key of ['home', 'away']) {
    const x = split[key];
    const labelCell = el('span', 'team-split__cell team-split__label');
    labelCell.append(venueIcon(key === 'home', { badge: false }), el('span', '', t(`team.${key}`)));
    grid.appendChild(labelCell);
    [x.p, x.w, x.d, x.l, x.gf, x.ga, x.w * 3 + x.d].forEach((v) => {
      grid.appendChild(el('span', 'team-split__cell num', String(v)));
    });
  }
  section.appendChild(grid);
  container.appendChild(section);
}

/* The overview tab's tiles, big value over a small label: where the club
   stands, then how it plays. Four short numbers fit one row even on a phone. */
function renderTeamNow(row, career, report, container) {
  const section = el('div', 'team-section team-now');
  if (row) {
    const table = el('dl', 'team-stats');
    table.appendChild(summaryStat(t('team.position'), rankText(row.position)));
    table.appendChild(summaryStat(t('team.points'), String(row.points)));
    table.appendChild(summaryStat(t('team.gd'), signed(row.goal_difference)));
    table.appendChild(summaryStat(t('team.played'), String(row.played)));
    section.appendChild(table);

    const xg = el('dl', 'team-stats team-stats--xg');
    xg.appendChild(xgStat(t('team.attack'), t('team.attackHint'), row.attack, report.table.map((r) => r.attack), true));
    xg.appendChild(xgStat(t('team.defence'), t('team.defenceHint'), row.defence, report.table.map((r) => r.defence), false));
    section.appendChild(xg);
  } else if (career) {
    const table = el('dl', 'team-stats');
    table.appendChild(summaryStat(t('team.matches'), String(career.points.length)));
    section.appendChild(table);
  } else return;
  container.appendChild(section);
}

/* The arrow beside a rating: how far the rating moved over the club's last
   five matches -- the five the table's form column shows, which it tracks
   best (r 0.85 against the points in them; 3 matches 0.65, 8 matches 0.73).
   A plain total reads at once ("+12 over the last 5") and swings between
   rising and falling from one match to the next only 2.5 % of the time.
   Cut-offs from every club-season since 2015: steady within ±8 (about 30 %
   of matches), fast beyond ±20 (about 30 %). */
const TREND_MATCHES = 5;
const TREND_CUTS = { mild: 8, strong: 20 };

/* xG form, the team view's second line: per match, K * (xG-implied score -
   expected score), the rating change the chances alone would have produced
   (`xg_form` in the results, from pipeline.xg_form). It is the signal that
   looks ahead -- a recent average tracks the next few matches (r ~0.17) where
   rating changes, mostly result luck, do not (~0.05; both measured over six
   matches). Weights 0.2..0.6 over the last 5 matches, the window of the
   rating trend and the form column, so the latest three carry 75 %. */
const FORM_WEIGHTS = [0.2, 0.3, 0.4, 0.5, 0.6];
const FORM_CUTS = { mild: 1, strong: 4 };

function teamMatchSeries(teamName, report) {
  const results = [...(report.results || [])].sort((a, b) => a.date.localeCompare(b.date));
  const ratingChanges = buildRatingChanges(state.careers);
  const xgForm = [];
  const changes = [];
  for (const r of results) {
    if (r.home_goals == null) continue;
    const isHome = r.home === teamName;
    if (!isHome && r.away !== teamName) continue;
    // Each value with its match, so a tooltip can say which match it was.
    const match = {
      date: r.date,
      opponent: isHome ? r.away : r.home,
      home: isHome,
      goals: isHome ? [r.home_goals, r.away_goals] : [r.away_goals, r.home_goals],
    };
    if (r.xg_form) xgForm.push({ ...match, value: r.xg_form[isHome ? 0 : 1] });
    const info = ratingChanges.get(`${isHome ? r.home_id : r.away_id}|${r.date}`);
    if (info) changes.push({ ...match, value: info.change });
  }
  return { xgForm, changes };
}

/* The matches behind a trend or form figure, newest first: date, opponent,
   home or away, and the score from the club's side. */
function matchesTip(entries, digits) {
  const day = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(localeDate(), { day: 'numeric', month: 'short' });
  const rows = [...entries].reverse().map((entry) => `<tr><td>${day(entry.date)}</td>`
    + `<td>${entry.opponent} (${t(entry.home ? 'trend.home' : 'trend.away')})</td>`
    + `<td>${entry.goals[0]}–${entry.goals[1]}</td><td>${signed(entry.value, digits)}</td></tr>`).join('');
  return `<br><span class="tooltip__muted">${t('trend.tipLast', { count: entries.length })}</span>`
    + `<table class="tooltip__matches">${rows}</table>`;
}

/* Five degrees: strong rise, rise, steady, fall, strong fall. */
function trendDegree(value, { mild, strong }) {
  const key = value > strong ? 'strongRise' : value > mild ? 'rise' : value >= -mild ? 'steady' : value >= -strong ? 'fall' : 'strongFall';
  return { key, direction: key.replace('strongR', 'strong-r').replace('strongF', 'strong-f') };
}

function computeRatingTrend(teamName, report) {
  if (!teamName) return null;
  const entries = teamMatchSeries(teamName, report).changes.slice(-TREND_MATCHES);
  if (entries.length < TREND_MATCHES) return null;
  const diff = entries.reduce((sum, entry) => sum + entry.value, 0);
  const { key, direction } = trendDegree(diff, TREND_CUTS);
  const label = t(`trend.${key}`);
  const total = signed(diff, 0);
  // One line for the table's arrow and for screen readers; the team view
  // shows `tip`, which adds the matches behind the number.
  const detail = t('trend.detail', { label, n: total });
  const tip = `<b>${label}</b> ${total}${matchesTip(entries, 0)}`;
  return { direction, svg: trendArrowSVG(direction), detail, tip, diff };
}

function computeXgForm(teamName, report) {
  if (!teamName) return null;
  const entries = teamMatchSeries(teamName, report).xgForm.slice(-FORM_WEIGHTS.length);
  if (entries.length < FORM_WEIGHTS.length) return null;
  const diff = entries.reduce((sum, entry, i) => sum + entry.value * FORM_WEIGHTS[i], 0)
    / FORM_WEIGHTS.reduce((a, b) => a + b, 0);
  const { key, direction } = trendDegree(diff, FORM_CUTS);
  const label = t(`form.${key}`);
  const perMatch = signed(diff, 1);
  const tip = `<b>${label}</b> ${t('form.tipPerMatch', { n: perMatch })}${matchesTip(entries, 1)}`;
  return { direction, svg: trendArrowSVG(direction), label, detail: t('form.detail', { label, n: perMatch }), tip };
}

function trendArrowSVG(direction) {
  const rotation = {
    'strong-rise': '0',
    'rise': '45',
    'steady': '90',
    'fall': '135',
    'strong-fall': '180',
  }[direction];

  return `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(${rotation}deg)"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg>`;
}

/* The club's own high-stakes entries: one compact line each, the band carried
   by a dot in its palette colour and the consequence in words ("Win vs Brann
   and the Champions chance is 92%. Lose and it falls to 31%."). Nothing is
   rendered when the club has no entries, so mid-table clubs get no chrome.
   Above them, the next match's stake in the same words, all season; it is
   left out when that match is already listed as decisive for the band. */
function renderTeamStakes(card, report, teamId) {
  const entries = teamStakes(report, teamId);
  let next = nextStake(report, teamId);
  if (next && entries.some((e) => String(e.match_id) === String(next.match_id) && e.band_label === next.band_label)) next = null;
  if (!entries.length && !next) return;
  const box = el('div', 'team-stakes');
  const count = (report.table || []).length || 16;
  const section = (label, items) => {
    box.appendChild(el('div', 'label', label));
    if (!box.querySelector('.legend')) box.appendChild(stakeLegend());
    const list = el('ul', 'team-stakes__list');
    for (const entry of items) list.appendChild(stakeRow(entry, report, count));
    box.appendChild(list);
  };
  // The fixture list below marks every decisive match with its dot, so this
  // list keeps the few that swing a race most, in date order.
  const swing = (entry) => Math.abs((entry.p_favourable ?? 0) - (entry.p_unfavourable ?? 0));
  // A wide screen has the room: all of them, beside the fixture list.
  const limit = window.matchMedia('(min-width: 961px)').matches ? Infinity : STAKES_SHOWN;
  const byDate = (a, b) => String(a.date).localeCompare(String(b.date));
  const shown = entries.length > limit
    ? [...entries].sort((a, b) => swing(b) - swing(a)).slice(0, limit).sort(byDate)
    : [...entries].sort(byDate);
  if (next) section(t('stake.next', { date: formatDate(next.date) }), [next]);
  if (shown.length) section(t('stake.title'), shown);
  if (shown.length < entries.length) box.appendChild(el('p', 'team-stakes__more', t('stake.more', { n: entries.length - shown.length })));
  card.appendChild(box);
}
const STAKES_SHOWN = 3;

/* A rival match's entry in words: where the club's chance of the race goes with
   the result that helps it and with the one that hurts it. */
function rivalCopy(entry) {
  const result = (key) => t(`rival.${key}`);
  return {
    main: `${entry.home} – ${entry.away}`,
    sub: t('rival.line', {
      base: pct(entry.p_baseline, 0),
      best: pct(entry.p_helps, 0), bestResult: result(entry.helps),
      worst: pct(entry.p_hurts, 0), worstResult: result(entry.hurts),
    }),
  };
}

/* The three results of a rival match as a decisive match's track draws them: the
   match's home win, draw and away win (blue, grey, red, as the odds bars have
   them), each at the club's chance of the race after it. */
function rivalResults(entry) {
  return [
    { key: 'win', value: entry.p_home_win },
    { key: 'draw', value: entry.p_draw },
    { key: 'loss', value: entry.p_away_win },
  ].filter((result) => result.value != null);
}

/* One rival match, in the decisive matches' form: the race and the match with its
   date on one line, the race's track under it. */
function rivalRow(entry, count) {
  const copy = rivalCopy(entry);
  const band = { first: entry.band_first, last: entry.band_last, tone: entry.band_tone, label: entry.band_label };
  const color = bandColor(band, count);
  const item = el('li', 'stake');
  item.title = `${copy.main} · ${copy.sub}`;
  const head = el('div', 'stake__head');
  const race = el('span', 'stake__race');
  const dot = el('span', 'stake__dot');
  dot.style.background = color;
  race.append(dot, el('span', '', bandEdgeName(band)));
  head.append(race, el('span', 'stake__match', copy.main), el('span', 'stake__when', formatDate(entry.date)));
  item.appendChild(head);
  item.appendChild(stakeTrack(rivalResults(entry), entry.p_baseline, color, entry.band_tone === 'relegation', `${copy.main} · ${copy.sub}`));
  return item;
}

/* The legend of a rival match's track: the match's results, and where the club stands now. */
function rivalLegend() {
  const legend = el('div', 'legend team-match__legend');
  for (const [outcome, key] of [['home', 'next.homeWin'], ['draw', 'next.draw'], ['away', 'next.awayWin']]) {
    const entry = el('span', 'legend__key');
    const swatch = el('span', 'legend__swatch');
    swatch.style.background = `var(--${outcome})`;
    entry.append(swatch, el('span', '', t(key)));
    legend.appendChild(entry);
  }
  const now = el('span', 'legend__key');
  now.append(el('span', 'stake__now-key'), el('span', '', t('stake.now')));
  legend.appendChild(now);
  return legend;
}

/* Other clubs' matches that move a race the club has a chance in, drawn as the
   decisive matches are: the club's chance of the race after each result of the
   match. Nothing is drawn for a club with none (and reports from before
   `rival_watch` have none). */
function renderRivalWatch(card, report, teamId) {
  const entries = ((report && report.rival_watch) || []).filter((entry) => String(entry.team_id) === String(teamId));
  if (!entries.length) return;
  const count = (report.table || []).length || 16;
  const box = el('div', 'team-stakes team-rivals');
  box.appendChild(el('div', 'label', t('rival.title')));
  box.appendChild(rivalLegend());
  const list = el('ul', 'team-stakes__list');
  for (const entry of entries) list.appendChild(rivalRow(entry, count));
  box.appendChild(list);
  card.appendChild(box);
}

/* What a decisive match does to a race, drawn: a track for the club's chance of
   it, 0 to 100 %, a pin where each result would leave it -- win, draw, loss --
   the stretch between them in the race's colour, and a tick where the chance
   stands now. The words stay as the tooltip and the screen reader's. */
function stakeLegend() {
  const legend = teamOddsLegend();
  const now = el('span', 'legend__key');
  now.append(el('span', 'stake__now-key'), el('span', '', t('stake.now')));
  legend.appendChild(now);
  return legend;
}

/* The track of a stake: the chance of the race, 0 to 100 %, a pin where each
   result would leave it (`results`: win, draw, loss, each with the chance it
   leaves), the stretch between them in the race's colour and a tick where the
   chance stands now. The drop's track is mirrored, so that on every race a win
   lands to the right and a loss to the left, the figures printed staying the
   chance of the race itself. `words` is the tooltip and the screen reader's. */
function stakeTrack(results, baseline, color, drop, words) {
  const at = (value) => (drop ? 1 - value : value);
  const track = el('div', 'stake__track');
  track.setAttribute('role', 'img');
  track.setAttribute('aria-label', words);
  const values = results.map((result) => at(result.value));
  const low = Math.min(...values, at(baseline));
  const high = Math.max(...values, at(baseline));
  const span = el('span', 'stake__span');
  span.style.left = `${low * 100}%`;
  span.style.width = `${(high - low) * 100}%`;
  span.style.background = color;
  track.appendChild(span);
  const now = el('span', 'stake__now');
  now.style.left = `${at(baseline) * 100}%`;
  track.appendChild(now);
  for (const result of results) {
    const pin = el('span', `stake__pin stake__pin--${result.key}`);
    pin.style.left = `${at(result.value) * 100}%`;
    track.appendChild(pin);
  }
  // The figures: the two ends of the swing, the lower one's right edge at its
  // pin and the higher one's left edge at its pin, so they never meet; the
  // draw's and the baseline's are in the tooltip, not on the chart.
  const ends = results.filter((result) => result.key !== 'draw').sort((a, b) => at(a.value) - at(b.value));
  ends.forEach((result, index) => {
    const figure = el('span', `stake__figure stake__figure--${result.key}`, pct(result.value, 0));
    const lower = index === 0;
    const near = lower ? at(result.value) < 0.1 : at(result.value) > 0.9;
    figure.style.left = `${at(result.value) * 100}%`;
    figure.style.transform = `translateX(${(lower ? !near : near) ? '-100%' : '0'})`;
    track.appendChild(figure);
  });
  return track;
}

function stakeRow(entry, report, count) {
  const copy = stakeCopy(entry, currentLang);
  const band = { first: entry.band_first, last: entry.band_last, tone: entry.band_tone, label: entry.band_label };
  const color = bandColor(band, count);
  const item = el('li', 'stake');
  item.title = `${copy.main} \u00b7 ${copy.sub}`;

  // Who, where and when, on one line under the race's name.
  const head = el('div', 'stake__head');
  const race = el('span', 'stake__race');
  const dot = el('span', 'stake__dot');
  dot.style.background = color;
  race.append(dot, el('span', '', bandEdgeName(band)));
  const who = el('button', 'stake__who');
  who.type = 'button';
  who.addEventListener('click', () => openTeamView(entry.opponent_id, entry.opponent));
  const crest = teamLogo(entry.opponent_id, entry.opponent, true);
  if (crest) who.appendChild(crest);
  who.appendChild(el('span', '', entry.opponent));
  const legs = stakeLegs(entry, report.fixtures || []);
  const whenEl = el('span', 'stake__when');
  if (legs.length >= 2) {
    whenEl.textContent = legs.map((leg) => formatDate(leg.date)).join(' \u00b7 ');
  } else {
    const isHome = String(entry.home_id) === String(entry.team_id);
    whenEl.append(venueIcon(isHome, { badge: false }), document.createTextNode(` \u00b7 ${formatDate(entry.date)}`));
  }
  head.append(race, who, whenEl);
  item.appendChild(head);

  const drop = entry.band_tone === 'relegation';
  const results = [
    { key: 'win', value: drop ? entry.p_unfavourable : entry.p_favourable },
    { key: 'draw', value: entry.p_draw },
    { key: 'loss', value: drop ? entry.p_favourable : entry.p_unfavourable },
  ].filter((result) => result.value != null);
  const track = stakeTrack(results, entry.p_baseline, color, drop, `${copy.main} · ${copy.sub}`);
  item.appendChild(track);
  return item;
}

/* One tile: the label comes first for screen readers (dt before dd) and the
   CSS lifts the value above it. */
function summaryStat(label, value, title) {
  const item = el('div', 'team-stats__tile');
  if (title) item.title = title;
  item.appendChild(el('dt', 'team-stats__label', label));
  item.appendChild(el('dd', 'team-stats__value', value));
  return item;
}

/* An xG rate as a percentage above or below the division average, the one
   number that says what the rate means. Defence is turned round (conceding
   fewer is the good direction) so + is better on both tiles. The bar
   diverges from a centre line at the average, scaled to the division's
   widest gap; the raw rate stays underneath. */
function xgStat(label, hint, value, division, higherIsBetter) {
  const average = division.reduce((sum, v) => sum + v, 0) / (division.length || 1);
  const relative = (v) => (higherIsBetter ? v / average - 1 : 1 - v / average);
  const share = relative(value);
  const widest = Math.max(...division.map((v) => Math.abs(relative(v))), Math.abs(share)) || 1;
  // The raw rate and the division average sit in the tooltip, not under the bar.
  const raw = t('team.xgRaw', { value: num(value, 2), avg: num(average, 2) });
  const item = summaryStat(label, `${signed(share * 100)}${percentSign()}`, `${hint} · ${raw}`);
  const half = (Math.abs(share) / widest) * 50;
  const bar = el('dd', `team-stats__bar team-stats__bar--${share >= 0 ? 'good' : 'bad'}`);
  bar.setAttribute('aria-hidden', 'true');
  bar.style.setProperty('--from', `${share >= 0 ? 50 : 50 - half}%`);
  bar.style.setProperty('--width', `${half}%`);
  item.appendChild(bar);
  return item;
}

function renderTeamGridRow(teamId, row, report, container) {
  if (!row) return;
  const section = el('div', 'team-section');
  section.appendChild(el('div', 'label', t('team.finishProbs')));

  const wrap = el('div', 'team-grid-row');
  const bands = report.league.bands;
  const count = row.position_probabilities.length;
  // A wide screen shows every place. A phone starts at the first place the club
  // can finish in and ends at the last, and when that is few the cells keep a
  // roomy fixed size, the width beyond them filled with blank cells of the same
  // size rather than left empty (see below, once the row is in the page).
  const phone = window.matchMedia('(max-width: 760px)').matches;
  const open = row.position_probabilities.map((prob, i) => (pctShort(prob) ? i : -1)).filter((i) => i >= 0);
  const [from, to] = phone && open.length ? [open[0], open[open.length - 1]] : [0, count - 1];
  const roomy = to - from < 8;
  wrap.classList.toggle('team-grid-row--roomy', roomy);
  // Never fewer than five cells on a phone: a club whose places lie at the
  // bottom starts earlier, so there are five places to hold them.
  const MIN_CELLS = 5;
  const start = phone && roomy ? Math.max(0, Math.min(from, count - MIN_CELLS)) : from;
  const last = phone && roomy ? count - 1 : to;
  for (let i = start; i <= last; i++) {
    const prob = row.position_probabilities[i];
    const position = i + 1;
    const step = heatStep(prob);
    const cell = el('div', `team-grid-row__cell ${heatTextClass(step)}`.trim());
    cell.style.background = seqStepColor(step);
    cell.textContent = pctShort(prob);
    if (!cell.textContent) cell.classList.add('team-grid-row__cell--empty');

    const band = bandFor(bands, position);
    cell.addEventListener('pointerenter', (event) =>
      showTooltip(event, `<b>${esc(row.team)}</b> ${ordinal(position)}<br>${pct(prob, 2)}` + (band ? `<br>${bandName(band)}` : ''))
    );
    cell.addEventListener('pointermove', moveTooltip);
    cell.addEventListener('pointerleave', hideTooltip);

    const posLabel = el('span', 'team-grid-row__pos', String(position));
    const cellWrap = el('div', 'team-grid-row__cell-wrap');
    cellWrap.appendChild(posLabel);
    cellWrap.appendChild(cell);
    wrap.appendChild(cellWrap);
  }
  section.appendChild(wrap);
  container.appendChild(section);
  // As many blank cells as the row holds whole, never a clipped one.
  if (phone && roomy && wrap.firstElementChild) {
    const gap = 3;
    const size = wrap.firstElementChild.getBoundingClientRect().width;
    const fit = size ? Math.floor((wrap.clientWidth + gap) / (size + gap)) : 0;
    while (wrap.children.length > Math.max(fit, to - start + 1, MIN_CELLS)) wrap.lastElementChild.remove();
  }
  return section;
}

let teamRefereesToken = 0;
async function renderTeamReferees(teamId, teamName, report, content) {
  const token = ++teamRefereesToken;
  const section = el('div', 'team-section team-referees');
  section.appendChild(el('p', 'explore-empty', t('referees.loading')));
  content.appendChild(section);

  if (typeof fetchReferees !== 'function') {
    try {
      await loadScriptsInOrder(['/app/explore-referees-data.js', '/app/explore-referees.js']);
    } catch (error) {
      if (token !== teamRefereesToken) return;
      console.warn('[Team] referees module could not load', error);
      track('load_error', { file: 'explore-referees', message: error.message });
      section.replaceChildren(el('p', 'explore-empty', t('status.retry')));
      return;
    }
    if (token !== teamRefereesToken || state.activeView !== 'team' || state.teamTab !== 'referees' || String(state.teamFocusId) !== String(teamId)) return;
  }

  const payload = await fetchReferees();
  if (token !== teamRefereesToken || state.activeView !== 'team' || state.teamTab !== 'referees' || String(state.teamFocusId) !== String(teamId)) return;

  function drawSection() {
    const prevHeight = section.offsetHeight;
    const prevScroll = window.scrollY;
    if (prevHeight > 0) section.style.minHeight = `${prevHeight}px`;
    section.replaceChildren();
    hideTooltip();
    try {
      const seasons = payload.seasons || [];
    const allSpan = seasons.length >= 2 ? `${seasons[0]}–${seasons[seasons.length - 1]}` : t('referees.scope.all');
    const topBar = el('div', 'ref-team-top');
    topBar.appendChild(el('h3', 'ref-section-title', t('referees.teamCard.title')));
    topBar.appendChild(refereeSwitchGroup(
      t('referees.scope.label'),
      [['all', allSpan], ['season', String(report.league.season)]],
      state.refereeScope,
      (val) => {
        state.refereeScope = val;
        state.refereeMinMatches = val === 'all' ? 5 : 0;
        state.teamRefereeSelected = null;
        drawSection();
      },
    ));
    section.appendChild(topBar);

    let filtered = refereeFilter(payload.rows, {
      league: report.league.slug,
      season: state.refereeScope === 'season' ? report.league.season : 'all',
      asof: report.league.asof || null,
    });
    let usedEliteserienFallback = false;
    const hasClubInLeague = filtered.some((r) => String(r.home_id) === String(teamId) || String(r.away_id) === String(teamId));
    if (!hasClubInLeague && report.league.slug !== 'eliteserien') {
      const esFiltered = refereeFilter(payload.rows, {
        league: 'eliteserien',
        season: state.refereeScope === 'season' ? report.league.season : 'all',
        asof: report.league.asof || null,
      });
      const esHas = esFiltered.some((r) => String(r.home_id) === String(teamId) || String(r.away_id) === String(teamId));
      const esAny = esHas ? esFiltered : refereeFilter(payload.rows, { league: 'eliteserien', season: 'all', asof: report.league.asof || null });
      if (esAny.some((r) => String(r.home_id) === String(teamId) || String(r.away_id) === String(teamId))) {
        filtered = esAny;
        usedEliteserienFallback = true;
      }
    }

    if (usedEliteserienFallback) {
      section.appendChild(el('p', 'explore-note explore-note--lead', t('referees.teamEliteserienFallback')));
    }

    const clubRows = clubDisciplineRows(filtered);
    const club = clubRows.find((c) => String(c.team_id) === String(teamId));
    if (club) {
      const cleanRank = [...clubRows].sort((a, b) => a.cardsForPerMatch - b.cardsForPerMatch).findIndex((c) => c.team_id === club.team_id) + 1;
      const avgFpc = clubRows.filter((c) => c.foulsPerCard != null).reduce((s, c) => s + c.foulsFor, 0)
        / (clubRows.filter((c) => c.foulsPerCard != null).reduce((s, c) => s + c.cardsForWithFouls, 0) || 1);
      const hero = el('div', 'ref-hero-grid ref-hero-grid--four');
      const haNote = club.homeCardsPerMatch != null && club.awayCardsPerMatch != null
        ? ` · ${t('referees.teamCard.homeAwaySub', { h: num(club.homeCardsPerMatch, 2), a: num(club.awayCardsPerMatch, 2) })}`
        : '';
      hero.appendChild(refHeroCard(
        t('referees.teamCard.cards'),
        num(club.cardsForPerMatch, 2),
        t('referees.teamCard.cardsText', { rank: cleanRank, of: clubRows.length, opp: num(club.cardsAgainstPerMatch, 2) }) + haNote,
      ));
      hero.appendChild(refHeroCard(
        t('referees.teamCard.netCards'),
        signed(club.netCardsPerMatch, 2),
        t('referees.teamCard.netCardsText', { rf: club.redsFor, ra: club.redsAgainst, n: club.matches }),
        { tone: club.netCardsPerMatch >= 0 ? 'ref-pos' : 'ref-neg' },
      ));
      if (club.foulsForPerMatch != null) {
        hero.appendChild(refHeroCard(
          t('referees.teamCard.fouls'),
          `${num(club.foulsForPerMatch, 1)} / ${num(club.foulsAgainstPerMatch, 1)}`,
          t('referees.teamCard.foulsText', { net: signed(club.netFoulsPerMatch, 1) }),
        ));
      }
      if (club.foulsPerCard != null) {
        hero.appendChild(refHeroCard(
          t('referees.teamCard.fpc'),
          num(club.foulsPerCard, 1),
          t('referees.teamCard.fpcText', { avg: num(avgFpc, 1) }),
        ));
      }
      section.appendChild(hero);
    }

    const refSub = el('section', 'ref-subsection');
    const refHead = el('div', 'ref-section-head');
    const refTitles = el('div', 'ref-section-head__text');
    refTitles.appendChild(el('h3', 'ref-section-title', t('referees.teamRecord.title')));
    refTitles.appendChild(el('p', 'explore-note explore-note--lead', t('referees.teamRecord.lead')));
    refHead.appendChild(refTitles);
    const refControls = el('div', 'ref-section-head__controls');
    refControls.appendChild(refereeSwitchGroup(
      t('referees.metric.label'),
      [['perMatch', t('referees.metric.perMatch')], ['total', t('referees.metric.total')]],
      state.refereeMetric,
      (val) => { state.refereeMetric = val; drawSection(); },
    ));
    refControls.appendChild(refereeSwitchGroup(
      t('referees.min.label'),
      [['5', t('referees.min.five')], ['10', t('referees.min.ten')], ['0', t('referees.min.all')]],
      String(state.refereeMinMatches),
      (val) => { state.refereeMinMatches = Number(val); drawSection(); },
    ));
    refHead.appendChild(refControls);
    refSub.appendChild(refHead);
    refSub.appendChild(refPerfExplainer(filtered, teamId));
    section.appendChild(refSub);

    const minMatches = state.refereeMinMatches;
    const rows = refereeMinFilter(teamRefereeRows(filtered, teamId), minMatches);
    if (state.teamRefereeSelected && !rows.some((r) => r.referee === state.teamRefereeSelected)) {
      state.teamRefereeSelected = null;
    }
    const relaxMin = minMatches > 0 ? () => { state.refereeMinMatches = 0; drawSection(); } : null;
    const baseline = refereeClubBaseline(filtered, teamId);
    const sorted = drawRefBarChart(refSub, rows, {
      metric: state.refereeMetric,
      kind: 'referee',
      ariaLabel: t('referees.teamAria', { team: teamName }),
      emptyText: minMatches ? t('referees.emptyMin', { min: minMatches }) : t('referees.empty'),
      activeKey: state.teamRefereeSelected,
      onRelaxMin: relaxMin,
      chanceSd: refereeChanceSd(filtered),
      baseline,
      onClickRow: (row) => {
        state.teamRefereeSelected = state.teamRefereeSelected === row.referee ? null : row.referee;
        drawSection();
      },
    });
    if (rows.length) {
      refSub.appendChild(el('p', 'explore-note ref-chance-note', t('referees.chanceNoteClub', { v: signed(baseline ?? 0, 1) })));
    }

    if (state.teamRefereeSelected) {
      const drawer = renderPairingDrawer(filtered, state.teamRefereeSelected, teamId, {
        context: 'team',
        onClose: () => { state.teamRefereeSelected = null; drawSection(); },
        onNavigate: () => {
          state.refereePairingMode = 'referee';
          state.refereeSelected = state.teamRefereeSelected;
          state.refereePairingTeam = teamId;
          state.refereeSection = 'pairings';
          state.activeView = 'explore';
          state.exploreItem = 'referees';
          markActiveView();
          render();
          window.scrollTo({ top: 0, behavior: 'instant' });
        },
      });
      if (drawer) refSub.appendChild(drawer);
    }

    if (sorted?.length >= 2) {
      const best = sorted[0];
      const worst = sorted[sorted.length - 1];
      const digits = refPerfDigits(state.refereeMetric);
      const val = (r) => signed(state.refereeMetric === 'perMatch' ? r.perMatch : r.diff, digits);
      refSub.appendChild(exploreFacts([
        {
          value: best.referee,
          label: t('referees.fact.teamBest'),
          text: t('referees.fact.rowText', { diff: val(best), n: best.matches, w: best.wins, d: best.draws, l: best.losses }),
        },
        {
          value: worst.referee,
          label: t('referees.fact.teamWorst'),
          text: t('referees.fact.rowText', { diff: val(worst), n: worst.matches, w: worst.wins, d: worst.draws, l: worst.losses }),
        },
      ]));
    }
    section.appendChild(refereeHowBox(false));
    } finally {
      section.style.minHeight = '';
      if (Math.abs(window.scrollY - prevScroll) > 2) {
        window.scrollTo({ top: prevScroll, behavior: 'instant' });
      }
    }
  }

  drawSection();
}

/* Under the finish strip: expected points and the chance of each race the
   club is in (at least 1 %, top three in table order), then the pre-season
   call. The likeliest place is left to the strip, whose tallest cell it is,
   and the rating change since the start to the season list. */
function renderTeamOutlook(card, row, report, teamId) {
  const probs = row.position_probabilities || [];
  if (!probs.length || !report.model?.matches_remaining) return;
  const box = el('div', 'team-outlook');
  const tiles = el('dl', 'team-stats team-stats--outlook');
  tiles.appendChild(summaryStat(t('team.xPts'), num(row.expected_points)));
  const slug = report.league.slug;
  const races = report.league.bands
    .map((band) => ({ band, chance: bandChance(row, band, slug) }))
    .filter(({ chance }) => chance >= 0.01)
    .slice(0, 3);
  for (const { band, chance } of races) {
    const name = bandWithPlayoff(row, band, slug) ? `${bandName(band)} (${t('team.playoffIncluded')})` : bandName(band);
    tiles.appendChild(summaryStat(bandEdgeName(band), pct(chance, 0), name));
  }
  // A club in none of the races (mid-table, nothing to win or lose) is told
  // where it is expected to end: the median place, the one the club finishes
  // at or above in half the runs.
  if (!races.length) {
    let running = 0;
    const median = probs.findIndex((p) => (running += p) >= 0.5) + 1;
    tiles.appendChild(summaryStat(t('team.expectedPlace'), rankText(median)));
  }
  box.appendChild(tiles);

  const historyTeam = report.history?.teams?.find((team) => String(team.team_id) === String(teamId));
  if (historyTeam?.positions?.length >= 2) {
    const pre = historyTeam.positions[0];
    box.appendChild(el('p', 'team-outlook__note', t('team.preSeason', { pos: ordinalShort(pre.indexOf(Math.max(...pre)) + 1) })));
  }
  card.appendChild(box);
}

/* Like the season shape, a narrow container gets a viewBox of its own width:
   the 940-wide desktop box read at a phone's ~0.35 scale left 4px text. The
   narrow box ticks every 100 points and labels seasons as '16, skipping one
   that would crowd the last. */
/* The team view's fixtures and results, one compact row each from the club's
   side: date, home or away, the opponent, then the three-way odds as win /
   draw / loss, or the result with its score the club's way round, the xG and
   what it did to the rating. The league-wide cards, centred on both clubs,
   repeated this club's own name and rating in every row. With scorelines (the
   forecast tab's fixture list), a fixture also shows its likeliest scores,
   the club's way round as its results are. */
function teamMatchRow(match, teamId, report, ratingChanges, { scorelines = false } = {}) {
  const home = String(match.home_id) === String(teamId);
  const row = el('div', 'team-match');
  row.appendChild(el('span', 'team-match__date', formatDate(match.date)));
  row.appendChild(venueIcon(home, { className: 'team-match__venue' }));
  const opponent = sideBlock(home ? match.away : match.home, home ? match.away_id : match.home_id, true, 'team-match__name');
  opponent.classList.add('team-match__opponent');
  // The name and any stake dot share a box, so a narrow screen can stand the
  // crest beside both lines while the dot stays with the name.
  const label = el('span', 'team-match__label');
  const name = opponent.querySelector('.team-match__name');
  name.replaceWith(label);
  label.appendChild(name);
  row.appendChild(opponent);

  if (match.home_goals != null) {
    const [scored, conceded] = home ? [match.home_goals, match.away_goals] : [match.away_goals, match.home_goals];
    const letter = scored > conceded ? 'W' : scored < conceded ? 'L' : 'D';
    const result = el('span', 'team-match__result');
    result.appendChild(el('span', `form__chip form__chip--${letter.toLowerCase()}`, t(`form.${letter}`)));
    result.appendChild(el('span', 'team-match__score', `${scored}–${conceded}`));
    if (match.xg) {
      const [xgFor, xgAgainst] = home ? match.xg : [match.xg[1], match.xg[0]];
      const xg = el('span', 'team-match__xg', `xG ${num(xgFor, 1)}–${num(xgAgainst, 1)}`);
      xg.title = t('played.xgHint');
      result.appendChild(xg);
    }
    const info = ratingChanges.get(`${teamId}|${match.date}`);
    if (info) {
      const delta = el('span', `team-match__delta${info.change > 0 ? ' up' : info.change < 0 ? ' down' : ''}`, info.change ? changeText(info.change) : '0');
      delta.title = t('team.ratingAfter', { n: info.rating });
      result.appendChild(delta);
    }
    row.appendChild(result);
  } else {
    const [win, loss] = home ? [match.home_win, match.away_win] : [match.away_win, match.home_win];
    // The three chances in figures above a slim bar of the same, each figure in
    // its outcome's colour, so no segment has to be wide enough to hold one.
    const odds = el('div', 'team-match__odds');
    odds.setAttribute('role', 'img');
    odds.setAttribute('aria-label', t('aria.teamOdds', { w: pct(win), d: pct(match.draw), l: pct(loss) }));
    const figures = el('div', 'team-match__pcts');
    // Columns in the bar's own proportions, so each figure stands over its
    // segment; a narrow one keeps room for its text rather than overlapping.
    // Percent, not fractions: fr factors that sum below 1 leave part of the
    // row unused once a column holds at its minimum, and the last figure
    // would stop short of the bar's end.
    figures.style.gridTemplateColumns = [win, match.draw, loss]
      .map((value) => `minmax(min-content, ${Math.max(value, 0.001) * 100}fr)`).join(' ');
    const bar = el('div', 'odds');
    for (const [outcome, value, key, tone] of [['home', win, 'team.oddsWin', 'win'], ['draw', match.draw, 'next.draw', 'draw'], ['away', loss, 'team.oddsLoss', 'loss']]) {
      figures.appendChild(el('span', `team-match__pct team-match__pct--${tone}`, pct(value, 0)));
      const segment = el('div', 'odds__seg');
      segment.dataset.outcome = outcome;
      segment.style.flex = `${Math.max(value, 0.001)}`;
      attachTip(segment, `<b>${t(key)}</b><br>${pct(value, 1)}`);
      bar.appendChild(segment);
    }
    odds.append(figures, bar);
    if (scorelines && match.scorelines?.length) {
      row.classList.add('team-match--lines');
      row.appendChild(teamMatchLines(match.scorelines, home));
    }
    row.appendChild(odds);
    const stake = (report.high_stakes || []).find((entry) =>
      String(entry.match_id) === String(match.match_id) && String(entry.team_id) === String(teamId));
    if (stake) label.appendChild(stakeDot(stake, report.table.length));
  }
  return row;
}

/* A fixture's three likeliest scores as the fixture cards' pills, turned to
   the club's side: scored first, conceded second. */
function teamMatchLines(scorelines, home) {
  const lines = el('div', 'team-match__lines');
  for (const line of scorelines.slice(0, 3)) {
    const [scored, conceded] = home ? [line.home_goals, line.away_goals] : [line.away_goals, line.home_goals];
    const chip = el('span', 'fixture__line');
    chip.append(el('span', 'fixture__score', `${scored}–${conceded}`), ` ${pct(line.probability, 0)}`);
    chip.setAttribute('aria-label', t('aria.scoreline', { score: `${scored}-${conceded}`, pct: pct(line.probability, 1) }));
    lines.appendChild(chip);
  }
  return lines;
}

/* Win, draw and loss in the odds bars' colours, said once above the rows. */
function teamOddsLegend() {
  const legend = el('div', 'legend team-match__legend');
  for (const [outcome, key] of [['home', 'team.oddsWin'], ['draw', 'next.draw'], ['away', 'team.oddsLoss']]) {
    const entry = el('span', 'legend__key');
    const swatch = el('span', 'legend__swatch');
    swatch.style.background = `var(--${outcome})`;
    entry.append(swatch, el('span', '', t(key)));
    legend.appendChild(entry);
  }
  return legend;
}

function renderTeamFixtures(teamId, teamName, report, container) {
  const allFixtures = (report.fixtures || []).filter(
    (f) => String(f.home_id) === String(teamId) || String(f.away_id) === String(teamId)
  );
  if (!allFixtures.length) return;

  const PAGE = 6;
  const totalPages = Math.ceil(allFixtures.length / PAGE);
  state.teamFixturesPage = Math.min(state.teamFixturesPage, totalPages - 1);
  const page = state.teamFixturesPage;
  const fixtures = allFixtures.slice(page * PAGE, (page + 1) * PAGE);

  const section = el('div', 'team-section team-fc-fixtures');
  const header = el('div', 'team-section__header');
  header.appendChild(el('div', 'label', t('team.upcomingFixtures', { n: allFixtures.length })));
  header.appendChild(teamOddsLegend());
  section.appendChild(header);
  const list = el('div', 'team-matches');
  for (const fixture of fixtures) list.appendChild(teamMatchRow(fixture, teamId, report, undefined, { scorelines: true }));
  section.appendChild(list);
  if (totalPages > 1) {
    section.appendChild(paginator(page, totalPages, (p) => { state.teamFixturesPage = p; renderTeamView(report); }));
  }
  container.appendChild(section);
}

function renderTeamResults(teamId, teamName, report, container) {
  const allResults = (report.results || []).filter(
    (r) => String(r.home_id) === String(teamId) || String(r.away_id) === String(teamId)
  );
  if (!allResults.length) return;

  const ratingChanges = buildRatingChanges(state.careers);
  const sorted = [...allResults].sort((a, b) => b.date.localeCompare(a.date));

  const PAGE = 8;
  const totalPages = Math.ceil(sorted.length / PAGE);
  state.teamResultsPage = Math.min(state.teamResultsPage, totalPages - 1);
  const page = state.teamResultsPage;
  const matches = sorted.slice(page * PAGE, (page + 1) * PAGE);

  const section = el('div', 'team-section');
  const header = el('div', 'team-section__header');
  header.appendChild(el('div', 'label', t('team.recentResults', { n: allResults.length })));
  section.appendChild(header);
  const body = el('div', 'team-results');
  const list = el('div', 'team-matches');
  for (const match of matches) list.appendChild(teamMatchRow(match, teamId, report, ratingChanges));
  body.appendChild(list);
  if (totalPages > 1) {
    body.appendChild(paginator(page, totalPages, (p) => { state.teamResultsPage = p; state.teamResultsOpen = true; renderTeamView(report); }, true));
  }
  section.appendChild(body);
  // The last five are already above as chips: on a phone the full list waits
  // behind a button, unless it was open (or paged) a moment ago.
  if (window.matchMedia('(max-width: 760px)').matches) {
    const open = !!state.teamResultsOpen;
    body.hidden = !open;
    const toggle = el('button', 'team-mini__full', t(open ? 'team.hideResults' : 'team.allResults'));
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.addEventListener('click', () => {
      const show = body.hidden;
      body.hidden = !show;
      state.teamResultsOpen = show;
      toggle.setAttribute('aria-expanded', String(show));
      toggle.textContent = t(show ? 'team.hideResults' : 'team.allResults');
    });
    header.appendChild(toggle);
  }
  container.appendChild(section);
}

/* Below this container width the chart gets a viewBox of its own width: a
   phone reads the 900-wide desktop box at ~0.4 scale, which shrinks the 10px
   ticks to 4px. `lastShape` is what a window resize redraws when the chart
   crosses that width. */
if (typeof module !== 'undefined') {
  module.exports = { trendDegree, rivalCopy, rivalResults };
}
