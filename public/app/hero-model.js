/* ---------- hero & model card ------------------------------------- */

/* The reader's own club, remembered on this device only. */
const OWN_CLUB_KEY = 'elitetracker-own-club';
function ownClub() {
  try { return localStorage.getItem(OWN_CLUB_KEY); } catch { return null; }
}
function setOwnClub(teamId) {
  try {
    if (teamId) localStorage.setItem(OWN_CLUB_KEY, teamId);
    else localStorage.removeItem(OWN_CLUB_KEY);
  } catch { /* private window: the choice lasts this page only */ }
}

/* The hero's race: the clubs still contending for one band, side by side. A
   band is open while some club's chance of it lies between 10 % and 95 %. A
   club from 95 % up is through (the site's one threshold for "as good as
   certain"): shown first and muted, so a band of several places shows how
   many are left. One from 5 % up is shown as a contender, so an open race
   has its outsiders too. The reader's own club's first open band comes
   first, and the race is then that club and its RACE_RIVALS nearest in
   chance; else the first open band down the table, so a settled title hands
   over to the places below it, and a club in no open band is left out of
   it. Null once every band is settled or the season is over. */
const RACE_OPEN = 0.1;
const RACE_SHOWN = 0.05;
const RACE_SETTLED = 0.95;
const RACE_RIVALS = 2;

function heroRace(report, ownId) {
  // A finished season is told by its champion, even while a relegation
  // play-off against the division below is still simulated.
  if (report.model.matches_remaining === 0) return null;
  const slug = report.league.slug;
  const open = (row, band) => {
    const chance = bandChance(row, band, slug);
    return chance > RACE_OPEN && chance < RACE_SETTLED;
  };
  const ownRow = ownId ? report.table.find((row) => String(row.team_id) === ownId) : null;
  const bands = report.league.bands;
  const ownBand = ownRow && bands.find((b) => open(ownRow, b));
  const band = ownBand || bands.find((b) => report.table.some((row) => open(row, b)));
  if (!band) return null;
  // A club in no open band has no place in another band's race.
  const own = ownBand ? ownRow : null;
  const ranked = report.table
    .map((row) => ({ row, chance: bandChance(row, band, slug) }))
    .filter(({ chance }) => chance > RACE_SHOWN)
    .sort((a, b) => b.chance - a.chance);
  // The reader's own club is the race: it and its closest rivals, the club
  // next above it in chance and the club next below, or the nearest two on
  // the one side when it leads or trails the band.
  if (own) {
    const ownChance = bandChance(own, band, slug);
    const others = ranked.filter(({ row, chance }) => row !== own && chance < RACE_SETTLED);
    const above = others.filter(({ chance }) => chance >= ownChance).reverse();
    const below = others.filter(({ chance }) => chance < ownChance);
    const rivals = (above.length && below.length ? [above[0], below[0]] : above.length ? above : below)
      .slice(0, RACE_RIVALS);
    const field = [{ row: own, chance: ownChance }, ...rivals].sort((a, b) => b.chance - a.chance);
    return { band, through: [], contenders: field, own };
  }
  // Clubs through first: in a band of several places they show how many are
  // still to play for. Then the contenders, fewer the more are through.
  const through = ranked.filter(({ chance }) => chance >= RACE_SETTLED);
  const room = Math.max(2, 6 - through.length);
  const contenders = ranked.filter(({ chance }) => chance < RACE_SETTLED).slice(0, room);
  return { band, through, contenders, own };
}

/* The movers, for the table: the clubs whose rating rose and fell most over
   their last five matches, the rating trend's own window
   (computeRatingTrend), so the hero and the table's arrows agree; in a young
   season, over the matches a club has. Each is shown while its move is at
   least a point, the climber in the good tone and the faller in the bad.
   Null until the history has loaded, or when no one has moved. */
function heroMovers(report) {
  if (!state.careers?.teams) return null;
  const moves = report.table.map((row) => {
    const entries = teamMatchSeries(row.team, report).changes.slice(-TREND_MATCHES);
    if (!entries.length) return null;
    const change = entries.reduce((sum, entry) => sum + entry.value, 0);
    // From the rating as shown, so the sum adds up.
    const now = Math.round(row.rating);
    return { row, before: now - change, now, change };
  }).filter(Boolean).sort((a, b) => b.change - a.change);
  const up = moves[0];
  const down = moves[moves.length - 1];
  const item = (move, tone) => ({
    row: move.row,
    tone,
    figure: signed(move.change),
    change: move.change,
    unit: t('hero.movers.unit'),
    sub: t('hero.movers.from', { from: num(move.before), to: num(move.now) }),
  });
  const items = [];
  if (up && Math.round(up.change) > 0) items.push(item(up, 'up'));
  if (down && Math.round(down.change) < 0) items.push(item(down, 'down'));
  return items.length ? { label: t('hero.movers.title'), items } : null;
}

/* The match of the week, for the matches view, following the week on show.
   It is chosen on the week's eve and kept while the week is played, so a
   result coming in neither drops it nor swaps it for another: chosen from
   the report as it stood the evening before the week's first match
   (`weekEve`), which the rest of the week cannot change (`pickFixture`).
   Shown as a fixture until it is played, then as its result. A week played
   in full turns to its best result (`scoreResult`). Undefined while the
   eve's report loads: the hero stays as it is until it is in. */
function heroMatch(report) {
  const pick = weekMatch(report);
  if (!pick) return pick;
  return pick.result ? resultHero(report, pick.result) : fixtureHero(report, pick.fixture);
}

/* The match of the week as data, for the matches view's hero and the
   overview: `{ fixture }` before it is played, `{ result }` (`scoreResult`)
   after. `week` is the matches view's week index; null for the week the view
   opens on. Null with no matches, undefined while the week's eve loads. */
function weekMatch(report, week = state.matchesWeek) {
  const { timeline, weeks, byWeek, index } = matchesTimeline(report, week);
  if (!timeline.length) return null;
  const items = byWeek.get(weeks[index]);
  const fixtures = items.filter((item) => !item.played).map((item) => item.match);
  const results = items.filter((item) => item.played).map((item) => item.match);
  const eve = weekEve(report, items);
  if (eve === undefined) return undefined;
  if (!fixtures.length) {
    return { result: results.map((match) => scoreResult(report, match, eve)).reduce((a, b) => (b.score > a.score ? b : a)) };
  }
  const ids = new Set(items.map((item) => item.match.match_id));
  const onEve = (eve?.fixtures || []).filter((match) => ids.has(match.match_id));
  const pick = onEve.length ? pickFixture(eve, onEve) : null;
  const played = pick && results.find((match) => match.match_id === pick.match_id);
  if (played) return { result: scoreResult(report, played, eve) };
  // The live fixture, for today's odds; without an eve, or with its pick
  // moved out of the week, the live report chooses.
  return { fixture: (pick && fixtures.find((match) => match.match_id === pick.match_id)) || pickFixture(report, fixtures) };
}

/* The report as it stood the evening before a week's first match: the
   rewind's report for the last matchday before it, else the pre-season one.
   Undefined while it loads (the hero is drawn again when it is in), null
   where there is none. */
function weekEve(report, items) {
  const first = items.reduce((min, item) => (item.match.date < min ? item.match.date : min), items[0].match.date);
  return divisionOnDay(report, (report.league.matchdays || []).findLast((matchday) => matchday.date < first)?.date || report.league.preseason);
}

/* A division's report as of an earlier day of its season, fetched once and
   kept: undefined while it loads (the matches hero and the overview are drawn
   again when it is in), null where there is none. */
const weekEves = new Map(); // url -> every division's report, or null
function divisionOnDay(report, day) {
  if (!day) return null;
  const url = reportUrl(report.league.season, day);
  if (!weekEves.has(url)) {
    weekEves.set(url, undefined);
    fetchedReport(url)
      .then((all) => { weekEves.set(url, applyShortNames(all)); })
      .catch(() => { weekEves.set(url, null); })
      .then(() => {
        if (state.activeView === 'matches') renderRace(state.reports[state.league]);
        if (state.activeView === 'overview') renderOverview();
      });
  }
  const all = weekEves.get(url);
  return all === undefined ? undefined : all?.[report.league.slug] ?? null;
}

/* The current week's eve, asked for ahead, so the matches view has it when
   it opens. */
function prefetchWeekEve(report) {
  const { timeline, weeks, byWeek, current } = matchesTimeline(report);
  if (timeline.length) weekEve(report, byWeek.get(weeks[current]));
}

/* How decisive a match is, from the stakes on its eve: per club, the swing
   of its band's chance between winning and losing, weighed by how high the
   band sits (the title whole, the bottom place half), the two clubs added.
   0 to 1: two clubs swinging 0.4 each count as all. With the entries, for
   the result's note. */
function matchStakes(eve, matchId) {
  const entries = eve ? stakesForFixture([...(eve.next_stakes || []), ...(eve.high_stakes || [])], matchId) : [];
  const places = Math.max(2, eve?.table?.length || 16);
  const perClub = new Map();
  for (const entry of entries) {
    const weighed = entry.swing * (1 - 0.5 * (entry.band_first - 1) / (places - 1));
    perClub.set(String(entry.team_id), Math.max(perClub.get(String(entry.team_id)) || 0, weighed));
  }
  const total = [...perClub.values()].reduce((a, b) => a + b, 0);
  return { decisive: Math.min(1, total / 0.8), entries };
}

/* The pre-match odds of a fixture as the report priced it, and the goals
   its scoreline grid expects. */
function fixtureGoals(report, fixture) {
  const odds = matchOdds(report.model, fixture.home_rating + surfaceEdge(report.model, fixture.home_id, fixture.away_id), fixture.away_rating);
  let goals = 0;
  scoreGrid(report.model, fixture.home_id, fixture.away_id, odds.gap / 400).forEach((row, i) => row.forEach((p, j) => { goals += (i + j) * p; }));
  return goals;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/* Of a week's fixtures, the most worth watching, each measure 0 to 1:
   how decisive it is (`matchStakes`), half the weight; how even, 1 less the
   gap between the two sides' chances of winning; and its expected goals,
   from two (none) to four (all). */
function scoreFixtures(report, fixtures) {
  return fixtures.map((fixture) => {
    const { decisive } = matchStakes(report, fixture.match_id);
    const even = 1 - Math.abs(fixture.home_win - fixture.away_win);
    const goals = fixture.home_rating != null ? clamp01((fixtureGoals(report, fixture) - 2) / 2) : 0;
    return { fixture, score: 0.5 * decisive + 0.3 * even + 0.2 * goals };
  });
}

function pickFixture(report, fixtures) {
  return scoreFixtures(report, fixtures).reduce((a, b) => (b.score > a.score ? b : a)).fixture;
}

function heroWhen(match) {
  return `${t('hero.match.title')} · ${formatDate(match.date)}${match.time ? ` ${match.time}` : ''}`;
}

/* A fixture as the hero shows it: the three chances, and what its biggest
   stake (from the live report) does for a club. */
function fixtureHero(report, fixture) {
  const bare = (chance) => pct(chance).replace(percentSign(), '');
  const stakes = [...(report.next_stakes || []), ...(report.high_stakes || [])];
  const stake = stakesForFixture(stakes, fixture.match_id).sort((a, b) => b.swing - a.swing)[0];
  let note = '';
  if (stake) {
    const band = { label: stake.band_label, first: stake.band_first, last: stake.band_last, tone: stake.band_tone };
    note = t('hero.match.stake', {
      team: stake.team,
      band: shortBandLabel(band, report),
      win: pct(stake.p_favourable),
      loss: pct(stake.p_unfavourable),
    });
  }
  return {
    label: heroWhen(fixture),
    items: [
      { row: { team_id: fixture.home_id, team: fixture.home }, figure: bare(fixture.home_win), unit: '%' },
      { name: t('hero.match.draw'), figure: bare(fixture.draw), unit: '%', draw: true },
      { row: { team_id: fixture.away_id, team: fixture.away }, figure: bare(fixture.away_win), unit: '%' },
    ],
    note,
  };
}

/* How good a result was to watch, each measure 0 to 1: how decisive the
   match was on its eve (`matchStakes`, 0.3); how tight, in goals (a draw
   whole, three goals apart none) and in xG (1.5 apart none) alike (0.2);
   the shock, the result's own chance from 40 % (none) down to 10 % (all) or
   a margin the scoreline grid gave little chance, whichever is more (0.25);
   its chances, two xG (none) to five (all) (0.1); and its goals, six or
   more all (0.15). */
function scoreResult(report, match, eve) {
  // Each club's rating going into the match, from its history: the point
  // before the match's own.
  const changes = buildRatingChanges(state.careers);
  const ratingBefore = (id, date) => {
    const entry = changes.get(`${id}|${date}`);
    return entry ? entry.rating - entry.change : null;
  };
  const hr = ratingBefore(match.home_id, match.date);
  const ar = ratingBefore(match.away_id, match.date);
  const odds = hr != null && ar != null
    ? blendOdds(report.model, matchOdds(report.model, hr + surfaceEdge(report.model, match.home_id, match.away_id), ar), match.home_id, match.away_id)
    : null;
  const outcome = match.home_goals > match.away_goals ? 'home_win' : match.home_goals < match.away_goals ? 'away_win' : 'draw';
  const diff = match.home_goals - match.away_goals;
  const margin = Math.abs(diff);
  const goalsTight = clamp01(1 - margin / 3);
  const xgTight = match.xg ? clamp01(1 - Math.abs(match.xg[0] - match.xg[1]) / 1.5) : goalsTight;
  // The chance of a margin at least this big, this way (or of a draw),
  // from the scoreline grid; a 5-0 nobody expected scores near 1.
  let tail = null;
  if (odds) {
    tail = 0;
    scoreGrid(report.model, match.home_id, match.away_id, odds.gap / 400).forEach((row, i) => row.forEach((p, j) => {
      const d = i - j;
      if (diff > 0 ? d >= diff : diff < 0 ? d <= diff : d === 0) tail += p;
    }));
  }
  const surprise = odds ? clamp01((0.4 - odds[outcome]) / 0.3) : 0;
  const thrashing = margin >= 2 && tail != null ? clamp01(-Math.log10(Math.max(tail, 1e-6)) / 2.5) : 0;
  const { decisive, entries } = matchStakes(eve, match.match_id);
  const chances = match.xg ? clamp01((match.xg[0] + match.xg[1] - 2) / 3) : 0;
  const goals = Math.min(match.home_goals + match.away_goals, 6) / 6;
  const score = 0.3 * decisive + 0.2 * (goalsTight + xgTight) / 2 + 0.25 * Math.max(surprise, thrashing)
    + 0.1 * chances + 0.15 * goals;
  // What the result did to a club's band, as the eve's report conditioned
  // it: the stake that moved furthest.
  let shift = null;
  for (const entry of entries) {
    const won = outcome === 'draw' ? null : (outcome === 'home_win') === (String(entry.team_id) === String(match.home_id));
    const is = won == null ? entry.p_draw : won ? entry.p_favourable : entry.p_unfavourable;
    if (is == null) continue;
    const move = Math.abs(is - entry.p_baseline);
    if (!shift || move > shift.move) {
      const band = { label: entry.band_label, first: entry.band_first, last: entry.band_last, tone: entry.band_tone };
      shift = { move, band, was: entry.p_baseline, is, team: entry.team };
    }
  }
  return { match, odds, shift, tail: margin >= 2 ? tail : null, score };
}

/* A result as the hero shows it: the score, each side's chance before it,
   and a shock or a band it moved. */
function resultHero(report, { match, odds, shift, tail }) {
  const notes = [];
  if (tail != null && tail < 0.02) notes.push(t('hero.match.shock', { p: pct(tail) }));
  if (shift && shift.move >= 0.02) {
    notes.push(t('hero.match.shift', { team: shift.team, band: shortBandLabel(shift.band, report), from: pct(shift.was), to: pct(shift.is) }));
  }
  const before = (chance) => (odds ? t('hero.match.before', { p: pct(chance) }) : '');
  return {
    label: heroWhen(match),
    items: [
      { row: { team_id: match.home_id, team: match.home }, figure: String(match.home_goals), unit: '', sub: before(odds?.home_win) },
      { name: '', figure: '–', unit: '', draw: true },
      { row: { team_id: match.away_id, team: match.away }, figure: String(match.away_goals), unit: '', sub: before(odds?.away_win) },
    ],
    note: notes.join(' · '),
  };
}

/* The race, as the hero draws it: its band, or the champion once every band
   is settled. */
function heroRaceModel(report) {
  const race = heroRace(report, ownClub());
  const bare = (chance) => pct(chance).replace(percentSign(), '');
  if (race) {
    return {
      label: race.band.tone === 'champion' ? t('hero.race.title') : bandName(race.band),
      items: [
        ...race.through.map(({ row, chance }) => ({ row, figure: bare(chance), unit: '%', through: true })),
        ...race.contenders.map(({ row, chance }) => ({ row, figure: bare(chance), unit: '%', own: row === race.own })),
      ],
    };
  }
  // Every band settled: the champion, on points once the season is over.
  const champion = report.table.reduce((best, row) =>
    row.position_probabilities[0] > best.position_probabilities[0] ? row : best);
  const done = report.model.matches_remaining === 0;
  return {
    label: t('band.Champions'),
    items: [{
      row: champion,
      figure: done ? num(champion.points) : bare(champion.position_probabilities[0]),
      unit: done ? t('hero.race.points') : '%',
    }],
  };
}

/* The hero follows the view: the table shows the month's movers, the
   matches the match of the week, the rest the race. Each falls back to the
   race when it has nothing to show. */
/* The figures of a hero, side by side: each club's figure large, its crest and
   name under it. The page's hero and the overview's blocks draw them alike. */
function raceList(hero) {
  const list = el('ol', 'race__clubs');
  for (const item of hero.items) {
    const li = el('li', ['race__club', item.own && 'is-own', item.through && 'is-through', item.draw && 'is-draw', item.tone && `is-${item.tone}`].filter(Boolean).join(' '));
    const value = el('b', 'race__value', item.figure);
    value.appendChild(el('small', '', item.unit));
    if (item.through) value.appendChild(el('span', 'visually-hidden', ` (${t('hero.race.through')})`));
    const name = el('span', 'race__name');
    const crest = item.row && teamLogo(item.row.team_id, item.row.team, true);
    if (crest) name.appendChild(crest);
    name.appendChild(document.createTextNode(item.row ? item.row.team : item.name));
    if (item.own) {
      const star = el('span', 'race__own', '★');
      star.title = t('hero.race.own');
      star.setAttribute('aria-label', t('hero.race.own'));
      name.appendChild(star);
    }
    li.append(value, name);
    if (item.sub) li.appendChild(el('span', 'race__sub', item.sub));
    list.appendChild(li);
  }
  return list;
}

function renderRace(report) {
  prefetchWeekEve(report);
  const match = state.activeView === 'matches' ? heroMatch(report) : null;
  // The week's eve is still loading: what the hero shows stays until it is in.
  if (match === undefined && $('#hero-race').hasChildNodes()) return;
  const hero = (state.activeView === 'table' && heroMovers(report))
    || match
    || heroRaceModel(report);
  const list = raceList(hero);
  const box = $('#hero-race');
  box.dataset.count = String(hero.items.length);
  box.replaceChildren(el('div', 'race__label label', hero.label), list);
  if (hero.note) box.appendChild(el('p', 'race__note', hero.note));
}

function renderHero(report) {
  const model = report.model;

  // The page's heading names the division and season; the two pickers that
  // change them sit in the masthead.
  $('#hero-title').textContent = `${report.league.name} ${report.league.season}`;
  const title = $('#league-picker');
  title.replaceChildren();
  // Each half of the heading is a button that opens a picker. The visible
  // text stays the accessible name -- an aria-label here would replace it, and
  // the page heading would read "Change division Change season" -- and a
  // hidden hint says what pressing it does.
  const titlePart = (text, role, menuId, hintKey) => {
    const part = el('span', 'hero-title-part', text);
    part.dataset.role = role;
    part.setAttribute('tabindex', '0');
    part.setAttribute('role', 'button');
    part.setAttribute('aria-expanded', 'false');
    part.setAttribute('aria-controls', menuId);
    part.appendChild(el('span', 'visually-hidden', `, ${t(hintKey)}`));
    return part;
  };
  const divSpan = titlePart(report.league.name, 'division', 'hero-league-menu', 'hero.changeDivision');
  const space = document.createTextNode(' ');
  const seasonSpan = titlePart(String(report.league.season), 'season', 'hero-season-menu', 'hero.changeSeason');
  title.appendChild(divSpan);
  title.appendChild(space);
  title.appendChild(seasonSpan);

  // The pickers live on freshly built title parts, so their listeners are
  // bound here, not once at boot: a rebuilt heading would be silent.
  const leagueMenu = $('#hero-league-menu');
  divSpan.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = !leagueMenu.hidden;
    closeAllMenus();
    if (open) return;
    for (const btn of leagueMenu.querySelectorAll('[data-league]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.league === state.league));
    }
    leagueMenu.hidden = false;
    divSpan.setAttribute('aria-expanded', 'true');
    const rect = divSpan.getBoundingClientRect();
    leagueMenu.style.position = 'fixed';
    leagueMenu.style.top = `${rect.bottom + 6}px`;
    leagueMenu.style.left = `${rect.left}px`;
    leagueMenu.style.width = `${rect.width}px`;
    phoneMenu(leagueMenu, closeAllMenus);
    menuFocusCleanup = trapFocus(leagueMenu);
  });
  divSpan.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); divSpan.click(); }
  });

  const seasonMenu = $('#hero-season-menu');
  seasonSpan.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = !seasonMenu.hidden;
    closeAllMenus();
    if (open) return;
    const seasons = report.league.seasons || [report.league.season];
    seasonMenu.replaceChildren();
    for (const s of [...seasons].reverse()) {
      const btn = el('button', 'popover-menu__btn', String(s));
      btn.type = 'button';
      btn.dataset.role = 'season-option';
      btn.setAttribute('aria-pressed', String(s === report.league.season));
      if (s === report.league.season) btn.setAttribute('aria-current', 'true');
      btn.addEventListener('click', () => {
        closeAllMenus();
        if (s !== state.season) loadSeason(s);
      });
      seasonMenu.appendChild(btn);
    }
    seasonMenu.hidden = false;
    seasonSpan.setAttribute('aria-expanded', 'true');
    const rect = seasonSpan.getBoundingClientRect();
    seasonMenu.style.position = 'fixed';
    seasonMenu.style.top = `${rect.bottom + 6}px`;
    seasonMenu.style.left = `${rect.left}px`;
    seasonMenu.style.width = `${rect.width}px`;
    phoneMenu(seasonMenu, closeAllMenus);
    menuFocusCleanup = trapFocus(seasonMenu);
  });
  seasonSpan.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); seasonSpan.click(); }
  });

  // Mark current league in division menu
  for (const btn of leagueMenu.querySelectorAll('[data-league]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.league === state.league));
  }

  $('#model-badge').textContent = model.version;

  renderRace(report);

  // Scrubbing the rewind slider redraws the race for every date. More clubs
  // may take more room, but fewer never give it back, so the slider below
  // does not bob up and down under the thumb. The hold starts over with the
  // league, season, view, language or width.
  const race = $('#hero-race');
  if (race.offsetHeight) {
    const hold = `${state.league}|${report.league.season}|${state.activeView}|${currentLang}|${window.innerWidth}`;
    if (race.dataset.hold !== hold) {
      race.dataset.hold = hold;
      race.style.minHeight = '';
    }
    race.style.minHeight = `${race.offsetHeight}px`;
  }

}

function modelSpecGroup(title, rows) {
  const group = el('section', 'model-spec__group');
  group.appendChild(el('h3', 'model-spec__title', title));
  const list = el('dl', 'model-spec__list');
  for (const [name, value] of rows) {
    const row = el('div', 'model-spec__row');
    row.appendChild(el('dt', '', name));
    row.appendChild(el('dd', '', String(value)));
    list.appendChild(row);
  }
  group.appendChild(list);
  return group;
}

function renderModelKpis(container, data) {
  if (!container) return;
  const items = [];
  const market = data?.market;
  const history = data?.versions;
  if (market?.model && market?.power && market?.base_rate_log_loss) {
    const modelSkill = versionSkill(market.model.log_loss, market.base_rate_log_loss);
    const marketSkill = versionSkill(market.power.log_loss, market.base_rate_log_loss);
    items.push({
      value: `${num(modelSkill, 1)}${percentSign()}`,
      label: t('model.kpi.skill'),
      sub: t('model.kpi.skillSub', { market: num(marketSkill, 1), n: num(market.model.n) }),
    });
    items.push({
      value: signed(market.model.log_loss - market.power.log_loss, 3),
      label: t('model.kpi.gap'),
      sub: t('model.kpi.gapSub', { t: num(market.power.paired_t, 1), from: market.first_season }),
    });
  }
  if (data?.scores?.all) {
    const all = data.scores.all;
    items.push({
      value: pct(all.calibration, 1),
      label: t('model.kpi.calib'),
      sub: t('model.kpi.calibSub', { n: num(all.n), from: data.first_season, to: data.last_season }),
    });
  }
  if (history?.versions?.length >= 2 && history.market_log_loss_eliteserien_xg != null) {
    const first = history.versions[0];
    const last = history.versions[history.versions.length - 1];
    const closed = (first.log_loss_eliteserien_xg - last.log_loss_eliteserien_xg)
      / (first.log_loss_eliteserien_xg - history.market_log_loss_eliteserien_xg);
    items.push({
      value: pct(closed, 0),
      label: t('model.kpi.closed'),
      sub: t('model.kpi.closedSub', { first: first.version, last: last.version, n: num(history.n_eliteserien_xg) }),
    });
  }
  if (!items.length) return;
  container.replaceChildren(...items.map((item) => {
    const card = el('div', 'model-kpi');
    card.appendChild(el('div', 'model-kpi__value', item.value));
    card.appendChild(el('div', 'model-kpi__label', item.label));
    card.appendChild(el('p', 'model-kpi__sub', item.sub));
    return card;
  }));
}

function renderModelCard(report) {
  const model = report.model;
  const pill = $('#model-version-pill');
  if (pill) pill.textContent = model.version;
  const s1 = $('#model-step1-spec');
  if (s1) s1.textContent = `K = ${model.k_factor} · ${pct(model.xg_alpha, 0)} xG`;
  const s2 = $('#model-step2-spec');
  if (s2) s2.textContent = t('model.step2.spec');
  const s3 = $('#model-step3-spec');
  if (s3) s3.textContent = model.strength_sd ? `${num(model.simulations)} · ±${model.strength_sd}` : num(model.simulations);

  const eloRows = [
    [t('model.version'), model.version],
    [t('model.kfactor'), model.k_factor],
    [t('model.homeAdvantage'), `${model.home_advantage} ${t('model.pts')}`],
  ];
  if (model.home_advantage_beta) eloRows.push([t('model.homeAdvantageBeta'), model.home_advantage_beta]);
  if (model.surface) eloRows.push([t('model.surfaceEdge'), `${model.surface.edge} ${t('model.pts')}`]);
  eloRows.push(
    [t('model.xgAlpha'), pct(model.xg_alpha, 0)],
    [t('model.crossRegression'), `${pct(1 - model.season_regression, 0)} ${t('model.towardMean')}`],
  );

  const goalsRows = [
    [t('model.outcomeOdds'), t('model.outcomeOddsValue')],
    [t('model.scorelines'), t('model.scorelinesValue')],
    [t('model.peakDraw'), pct(model.draw_base, 0)],
  ];
  if (model.attack_defence.keeping_window) {
    goalsRows.push([t('model.keeping'), t('model.keepingValue', { n: model.attack_defence.keeping_window })]);
  }
  if (model.attack_defence.blend_gamma) {
    goalsRows.push([t('model.blendGamma'), model.attack_defence.blend_gamma]);
  }
  if (model.stakes) {
    goalsRows.push([t('model.stakes'), t('model.stakesValue', { elo: model.stakes.elo, from: model.stakes.from })]);
    goalsRows.push([t('model.stakesScope'), t('model.stakesScopeValue')]);
  }

  const simRows = [
    [t('model.simulations'), num(model.simulations)],
  ];
  if (model.strength_sd) simRows.push([t('model.strengthSd'), `±${model.strength_sd}`]);
  simRows.push(
    [t('model.expectedPoints'), t('model.expectedPointsValue')],
    [t('model.tiebreak'), t('model.tiebreakValue')],
    [t('model.seed'), model.seed],
  );

  const grid = $('#model-grid');
  grid.replaceChildren(
    modelSpecGroup(t('model.group.elo'), eloRows),
    modelSpecGroup(t('model.group.goals'), goalsRows),
    modelSpecGroup(t('model.group.sim'), simRows),
  );

  const kpis = $('#model-kpis');
  const accuracy = $('#model-accuracy');
  const drawAccuracy = () => {
    if (state.activeView !== 'model') return;
    if (kpis) {
      loadCalibration().then(
        (data) => { if (state.activeView === 'model') renderModelKpis(kpis, data); },
        () => {},
      );
    }
    if (accuracy) renderAccuracy(report, accuracy);
  };
  if (typeof renderAccuracy === 'function') drawAccuracy();
  else {
    if (accuracy) accuracy.replaceChildren(el('p', 'explore-empty', t('status.loading')));
    loadScript('/app/model-accuracy.js').then(drawAccuracy, (error) => {
      console.warn('[Model] accuracy module could not load', error);
      track('load_error', { file: 'model-accuracy', message: error.message });
    });
  }
}
