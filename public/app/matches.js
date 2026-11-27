/* ---------- fixtures ---------------------------------------------- */

/* One half of a matchup: name button and crest, both opening the club's focus
   view. The crest sits toward the centre of the card, so away flips the order. */
function sideBlock(name, id, away, nameClass = 'played-card__team-name') {
  const team = el('span', 'played-card__team');
  const nameBtn = el('button', nameClass, name);
  nameBtn.addEventListener('click', () => openTeamView(id, name));
  const crest = teamLogo(id, name);
  if (crest) {
    crest.addEventListener('click', () => openTeamView(id, name));
    crest.style.cursor = 'pointer';
    // The name button beside it is the control; the crest is a mouse extra.
    crest.alt = '';
    crest.setAttribute('aria-hidden', 'true');
  }
  for (const node of away ? [crest, nameBtn] : [nameBtn, crest]) if (node) team.appendChild(node);
  return team;
}

/* ---------- high stakes ------------------------------------------- */

/* The report's `high_stakes` array names, per contender, the one remaining
   fixture that swings its band chance most. All DOM-free, so the node suite
   can pin them: keep every body indented (pick() slices to the first
   column-zero `}`). */

/* One decimal, always: a 0.04 swing reads "4.0%", never rounded up into
   something bigger and never hidden as "—" the way pct() hides dust. */
function stakePct(value, lang, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  const clamped = Math.max(0, Math.min(1, value));
  // A decimal point in both languages (AGENTS.md); at most 100.0, so no grouping.
  const figure = (clamped * 100).toLocaleString('en-GB', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
  return lang === 'no' ? `${figure} %` : `${figure}%`;
}

/* This club's entries, driven by its table row's high_stakes_match_ids.
   Older reports without that key fall back to matching team_id; a report
   without high_stakes at all yields nothing rather than throwing. */
function teamStakes(report, teamId) {
  const rows = (report && report.table) || [];
  const row = rows.find((r) => String(r.team_id) === String(teamId));
  const ids = row && Array.isArray(row.high_stakes_match_ids)
    ? new Set(row.high_stakes_match_ids.map(String))
    : null;
  const all = (report && report.high_stakes) || [];
  if (ids) {
    // Match on the club too: two clubs can hold stakes on the same fixture
    // (once per club, or one club twice for two bands), and the ids alone
    // cannot tell their entries apart.
    return all.filter((entry) => ids.has(String(entry.match_id)) && String(entry.team_id) === String(teamId));
  }
  return all.filter((entry) => String(entry.team_id) === String(teamId));
}

/* The stake of the club's next match, or null. Unlike the decisive entries
   this is there all season (reports without next_stakes simply have none). */
function nextStake(report, teamId) {
  return ((report && report.next_stakes) || []).find((entry) => String(entry.team_id) === String(teamId)) || null;
}

/* Every stake riding on one fixture: one club, or two, or one club twice
   (two bands). Returns all of them so the card merges the reasons into a
   single badge instead of dropping one or stacking two. */
function stakesForFixture(entries, matchId) {
  return (entries || []).filter((entry) => String(entry.match_id) === String(matchId));
}

/* Both legs of the pairing, oldest first, from the fixture list. Empty when
   the legs are unknown, so the team view names the pairing only when it can
   show both halves of it. */
function stakeLegs(entry, fixtures) {
  const legs = (entry && entry.leg_match_ids) || [];
  if (!legs.length) return [];
  const wanted = new Set(legs.map(String));
  return (fixtures || [])
    .filter((f) => wanted.has(String(f.match_id)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/* Plain-language consequence of an entry: the race, its chance now, and where
   the result takes it ("Title 31% → 35% with a win vs Fredrikstad" / "17% with
   a loss"). The tone decides the verb: every band but relegation is something
   to win toward, while relegation is what a loss brings closer -- never "a win
   seals relegation". */
function stakeCopy(entry, lang) {
  const loss = entry.band_tone === 'relegation';
  const args = {
    band: bandEdgeName({ label: entry.band_label }),
    opponent: entry.opponent,
    base: stakePct(entry.p_baseline, lang),
    fav: stakePct(entry.p_favourable, lang),
    unfav: stakePct(entry.p_unfavourable, lang),
  };
  const kind = loss ? 'lose' : 'win';
  return { main: t(`stake.${kind}.main`, args), sub: t(`stake.${kind}.sub`, args) };
}

/* The decisive-match tooltip: the race and its chance after each of the
   club's own results ("Title W 92% · D 61% · L 31%"). Relegation's
   favourable side is the loss, so it is turned back to the club's results.
   Reports built before the draw was kept show the win and the loss. */
function stakeTip(entry, lang) {
  const relegation = entry.band_tone === 'relegation';
  const results = [
    ['W', relegation ? entry.p_unfavourable : entry.p_favourable],
    ['D', entry.p_draw],
    ['L', relegation ? entry.p_favourable : entry.p_unfavourable],
  ].filter(([, value]) => value != null);
  const line = results.map(([key, value]) => `${t(`form.${key}`)} ${stakePct(value, lang, 0)}`).join(' · ');
  return `<b>${bandEdgeName({ label: entry.band_label })}</b> ${line}`;
}

/* The coloured dot that marks a decisive match, in its band's colour, with the
   stake as its readout. On touch the club name beside it opens the club, so
   the dot is its own tap target and explains itself without navigating. */
function stakeDot(entry, count) {
  const band = { first: entry.band_first, last: entry.band_last, tone: entry.band_tone, label: entry.band_label };
  const dot = el('span', 'stake-dot');
  dot.style.background = bandColor(band, count);
  dot.setAttribute('aria-hidden', 'true');
  dot.tip = () => stakeTip(entry, currentLang);
  attachTip(dot, dot.tip);
  dot.addEventListener('click', (event) => event.stopPropagation());
  return dot;
}

/* One merged badge for a fixture card, or null when nothing rides on it. The
   text always names whose stake it is ("Decisive for Bodø/Glimt (Title)"),
   never a bare "important match". The dots reuse the band palette, so the
   flag reads as informative rather than alarming. */
function stakeFlag(stakes, report) {
  if (!stakes || !stakes.length) return null;
  const count = (report.table || []).length || 16;
  const flag = el('div', 'stake-flag');
  const dots = el('span', 'stake-flag__dots');
  dots.setAttribute('aria-hidden', 'true');
  const items = [];
  for (const entry of stakes) {
    const band = { first: entry.band_first, last: entry.band_last, tone: entry.band_tone, label: entry.band_label };
    const dot = el('span', 'stake-flag__dot');
    dot.style.background = bandColor(band, count);
    dots.appendChild(dot);
    items.push(`${entry.team} (${bandEdgeName(band)})`);
  }
  flag.appendChild(dots);
  flag.appendChild(el('span', 'stake-flag__text', t('stake.badge', { list: items.join(' · ') })));
  return flag;
}

/* What moved a fixture's odds beyond the ratings, as short tags: the surface
   edge and the run-in's table pressure, in Elo points for the side they favour.
   The report leaves a term out when it moved nothing (and older ones lack both). */
function fixtureModifiers(fixture) {
  const tag = (key, elo) => (elo
    ? t(key, { team: elo > 0 ? fixture.home : fixture.away, elo: num(Math.abs(elo)) })
    : null);
  return [tag('fixture.surfaceTag', fixture.surface_elo), tag('fixture.stakesTag', fixture.stakes_elo)].filter(Boolean);
}

function buildFixtureCard(fixture, stakes, report) {
  const card = el('div', 'played-card');
  card.appendChild(el('div', 'played-card__date', formatDate(fixture.date) + (fixture.time ? ` \u00b7 ${fixture.time}` : '')));

  const matchup = el('div', 'played-card__matchup');
  const homeSide = el('div', 'played-card__side played-card__side--home');
  homeSide.appendChild(el('span', 'played-card__rating-value', num(fixture.home_rating)));
  const homeName = sideBlock(fixture.home, fixture.home_id, false);
  homeSide.appendChild(homeName);
  matchup.appendChild(homeSide);

  const oddsCol = el('div', 'fixture__odds-col');
  oddsCol.appendChild(oddsBar(fixture.home, fixture.away, fixture));
  matchup.appendChild(oddsCol);

  const awaySide = el('div', 'played-card__side played-card__side--away');
  const awayName = sideBlock(fixture.away, fixture.away_id, true);
  awaySide.appendChild(awayName);
  awaySide.appendChild(el('span', 'played-card__rating-value', num(fixture.away_rating)));
  matchup.appendChild(awaySide);
  card.appendChild(matchup);

  // Decisive-match dots: one per band a team has a stake in on this fixture,
  // stacked when there are several. The team name shares the first dot's
  // tooltip on hover.
  if (stakes && stakes.length && report) {
    const count = report.table.length;
    const stacks = new Map();
    for (const entry of stakes) {
      const isHome = entry.team_id === fixture.home_id;
      const nameEl = isHome ? homeName : awayName;
      if (!nameEl) continue;
      const dot = stakeDot(entry, count);
      if (!stacks.has(isHome)) {
        const stack = el('span', 'stake-dots');
        // On the outside of the rating: left of the home one, right of the away one.
        if (isHome) homeSide.prepend(stack); else awaySide.append(stack);
        stacks.set(isHome, stack);
        attachTip(nameEl, dot.tip);
      }
      stacks.get(isHome).appendChild(dot);
    }
  }
  if (fixture.scorelines && fixture.scorelines.length) {
    const lines = el('div', 'fixture__lines');
    for (const line of fixture.scorelines.slice(0, 4)) {
      const chip = el('span', 'fixture__line');
      // The score reads first, its chance after it in a quieter tone: run
      // together, "1-2 10 %" read as one string of digits.
      const score = el('span', 'fixture__score');
      score.textContent = `${line.home_goals}–${line.away_goals}`;
      chip.append(score, ` ${pct(line.probability, 0)}`);
      chip.setAttribute(
        'aria-label',
        t('aria.scoreline', { score: `${line.home_goals}-${line.away_goals}`, pct: pct(line.probability, 1) })
      );
      lines.appendChild(chip);
    }
    card.appendChild(lines);
  }
  // What moved the odds beyond the ratings, under the scorelines.
  const modifiers = fixtureModifiers(fixture);
  if (modifiers.length) card.appendChild(el('div', 'fixture__mods', modifiers.join(' · ')));

  return card;
}

/* A completed match: score in the middle, each side's rating after the match
   with the delta the result produced on the outside. */
function playedCard(match, ratingChanges) {
  const card = el('div', 'played-card');
  if (match.home_goals > match.away_goals) card.classList.add('played-card--home-win');
  else if (match.away_goals > match.home_goals) card.classList.add('played-card--away-win');
  card.appendChild(el('div', 'played-card__date', formatDate(match.date) + (match.round ? ` \u00b7 ${t('played.round', { n: match.round })}` : '')));

  const ratingBlock = (id) => {
    const info = ratingChanges.get(`${id}|${match.date}`);
    const node = el('div', 'played-card__rating');
    if (!info) return node;
    node.appendChild(el('span', 'played-card__rating-value', String(info.rating)));
    if (info.change !== 0) {
      const up = info.change > 0;
      node.appendChild(el('span', `played-card__delta played-card__delta--${up ? 'up' : 'down'}`,
        changeText(info.change)));
    }
    return node;
  };

  const matchup = el('div', 'played-card__matchup');
  const homeSide = el('div', 'played-card__side played-card__side--home');
  homeSide.appendChild(ratingBlock(match.home_id));
  homeSide.appendChild(sideBlock(match.home, match.home_id, false));
  const awaySide = el('div', 'played-card__side played-card__side--away');
  awaySide.appendChild(sideBlock(match.away, match.away_id, true));
  awaySide.appendChild(ratingBlock(match.away_id));
  matchup.appendChild(homeSide);
  const score = el('div', 'played-card__score', `${match.home_goals}\u2013${match.away_goals}`);
  // xG under the score: the rating moves on both, so a "lucky" win shows why
  // it earned less than the scoreline suggests.
  if (match.xg) {
    const xg = el('span', 'played-card__xg', `xG ${num(match.xg[0], 1)}\u2013${num(match.xg[1], 1)}`);
    xg.title = t('played.xgHint');
    score.appendChild(xg);
  }
  matchup.appendChild(score);
  matchup.appendChild(awaySide);
  card.appendChild(matchup);
  return card;
}

/* Results and fixtures on one timeline, a week a page: Prev goes back in time
   and Next forward, as on FotMob. It opens on the week of the next fixture --
   which in mid-round also holds the results already in -- or, once the season
   is over, on its last week. */
/* Results and fixtures on one timeline, bucketed by ISO week, with the week
   the view opens on: the next fixture's, or the last once the season is
   over. The matches view and its hero share it. */
function matchesTimeline(report, week = state.matchesWeek) {
  const played = (report.results || []).map((match) => ({ match, played: true }));
  const upcoming = (report.fixtures || []).map((match) => ({ match, played: false }));
  const timeline = [...played, ...upcoming].sort((a, b) =>
    `${a.match.date} ${a.match.time || ''}`.localeCompare(`${b.match.date} ${b.match.time || ''}`));
  const { weeks, byWeek } = groupByWeek(timeline.map((item) => ({ ...item, date: item.match.date })));
  const firstUpcoming = timeline.find((item) => !item.played);
  const current = firstUpcoming ? weeks.indexOf(isoWeek(firstUpcoming.match.date)) : weeks.length - 1;
  const index = Math.max(0, Math.min(week ?? current, weeks.length - 1));
  return { timeline, weeks, byWeek, firstUpcoming, current, index };
}

function renderMatches(report) {
  const holder = $('#fixtures');
  holder.replaceChildren();
  const { timeline, weeks, byWeek, firstUpcoming, current, index } = matchesTimeline(report);
  if (!timeline.length) {
    $('#fixture-count').textContent = '';
    holder.appendChild(el('p', 'muted', t('played.empty')));
    return;
  }
  state.matchesWeek = index;
  const items = byWeek.get(weeks[state.matchesWeek]);
  const results = items.filter((item) => item.played).map((item) => item.match);
  const fixtures = items.filter((item) => !item.played).map((item) => item.match);
  $('#fixture-count').textContent = t('matches.count', { played: results.length, upcoming: fixtures.length });

  // Paging the weeks moves the hero's match of the week along with them.
  const go = (week) => () => { state.matchesWeek = week; renderMatches(report); renderRace(report); };
  holder.appendChild(pageNav(
    t('played.week', { n: weeks[state.matchesWeek] }) + (state.matchesWeek === current && firstUpcoming ? ` · ${t('matches.thisWeek')}` : ''),
    state.matchesWeek > 0 ? go(state.matchesWeek - 1) : null,
    state.matchesWeek < weeks.length - 1 ? go(state.matchesWeek + 1) : null,
  ));
  // A week that is part played gets a heading over each half.
  const both = results.length && fixtures.length;
  if (results.length) {
    if (both) holder.appendChild(el('div', 'label matches__group', t('matches.results')));
    const ratingChanges = buildRatingChanges(state.careers);
    for (const match of results) holder.appendChild(playedCard(match, ratingChanges));
  }
  if (fixtures.length) {
    if (both) holder.appendChild(el('div', 'label matches__group', t('matches.upcoming')));
    for (const fixture of fixtures) holder.appendChild(buildFixtureCard(fixture, stakesForFixture(report.high_stakes, fixture.match_id), report));
  }
  $('#odds-legend').hidden = !fixtures.length;
}

/* Matches bucketed by ISO week, weeks in the order the list first meets them. */
function groupByWeek(matches) {
  const weeks = [];
  const byWeek = new Map();
  for (const match of matches) {
    const week = isoWeek(match.date);
    if (!byWeek.has(week)) {
      byWeek.set(week, []);
      weeks.push(week);
    }
    byWeek.get(week).push(match);
  }
  return { weeks, byWeek };
}

/* The one pagination control on the site, modelled on Matches: Prev,
   what is on show, Next. Prev always goes back in time and Next forward; a
   missing handler disables that side. */
function pageNav(label, onPrev, onNext, [prevText, nextText] = [t('played.prev'), t('played.next')]) {
  const nav = el('div', 'played-nav');
  const prev = el('button', 'played-nav__btn', prevText);
  const next = el('button', 'played-nav__btn', nextText);
  for (const [button, handler] of [[prev, onPrev], [next, onNext]]) {
    button.type = 'button';
    button.disabled = !handler;
    if (handler) button.addEventListener('click', handler);
  }
  nav.appendChild(prev);
  nav.appendChild(el('span', 'played-nav__label', label));
  nav.appendChild(next);
  return nav;
}

/* ---------- played results ------------------------------------------ */

/* Build a map of rating changes per team per match date from careers data.
   career.points is an array of [date, rating] after each match.
   Returns a Map keyed "teamId|date" -> { change, rating } where rating is
   the rating after the match and change is the delta from the previous match.
   Built once per careers payload: the table asks for it on every row. */
const ratingChangesCache = new WeakMap();

function buildRatingChanges(careers) {
  const changes = new Map();
  if (!careers?.teams) return changes;
  if (ratingChangesCache.has(careers)) return ratingChangesCache.get(careers);
  ratingChangesCache.set(careers, changes);

  for (const career of careers.teams) {
    const points = career.points;
    if (!points || points.length < 2) continue;

    for (let i = 1; i < points.length; i++) {
      const [date, ratingAfter] = points[i];
      const [, ratingBefore] = points[i - 1];
      changes.set(`${career.team_id}|${date}`, {
        change: Math.round(ratingAfter - ratingBefore),
        rating: Math.round(ratingAfter),
      });
    }
  }
  return changes;
}

/* ISO week number from an ISO date string. */
/* The Monday that starts a date's ISO week, as YYYY-MM-DD: weeks in order,
   the same weeks `isoWeek` numbers. */
function weekStart(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1 - (d.getUTCDay() || 7));
  return d.toISOString().slice(0, 10);
}

/* Which locked fixtures each fixture is priced after: those in earlier weeks
   only, so a score set this week, or later, leaves this week's odds as they
   were. `games` are the fixtures in order ({ game }), `locked` the indices of
   the locked ones. Returns, per fixture, how many of `locked` (taken in order)
   come in weeks before its own. */
function whatIfStages(games, locked) {
  const weeks = games.map(({ game }) => weekStart(game.date));
  const lockedWeeks = locked.map((i) => weeks[i]);
  return weeks.map((week) => lockedWeeks.filter((other) => other < week).length);
}

function isoWeek(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function formatDate(iso) {
  const date = new Date(`${iso}T12:00:00Z`);
  return date.toLocaleDateString(localeDate(), { weekday: 'short', day: 'numeric', month: 'short' });
}

/* The rewind status's date: in full on a wide screen; on a phone without the
   year (the hero names the season), so the line keeps to its reserved room. */
function whenDate(iso) {
  return window.matchMedia('(max-width: 760px)').matches ? formatDate(iso) : longDate(iso);
}

function longDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(localeDate(), {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
  });
}

/* Recent results per club, newest last. Built from the played-results list so
   it follows the rewind slider (that list is per-asof). */
function formByTeam(results) {
  const map = {};
  const sorted = [...(results || [])].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
  for (const r of sorted) {
    if (r.home_goals == null || r.away_goals == null) continue;
    const draw = r.home_goals === r.away_goals;
    (map[r.home] ||= []).push(draw ? 'D' : r.home_goals > r.away_goals ? 'W' : 'L');
    (map[r.away] ||= []).push(draw ? 'D' : r.home_goals > r.away_goals ? 'L' : 'W');
  }
  for (const name in map) map[name] = map[name].slice(-5);
  return map;
}

function formPoints(form) {
  if (!form || !form.length) return 0;
  return form.reduce((total, letter) => total + (letter === 'W' ? 3 : letter === 'D' ? 1 : 0), 0);
}

function formChipsEl(form) {
  const holder = el('span', 'form__chips');
  const last5 = (form || []).slice(-5);
  if (!last5.length) return holder;
  // W/D/L stay the data; the chip shows the reader's letter (S/U/T in Norwegian).
  for (const letter of last5) {
    const chip = el('span', `form__chip form__chip--${letter.toLowerCase()}`, t(`form.${letter}`));
    holder.appendChild(chip);
  }
  // Whole-form tooltip from i18n (e.g. "2W 1D 2L" / "2S 1U 2T")
  const w = last5.filter((r) => r === 'W').length;
  const d = last5.filter((r) => r === 'D').length;
  const l = last5.filter((r) => r === 'L').length;
  holder.title = t('form.tooltip', { w, d, l });
  return holder;
}

if (typeof module !== 'undefined') {
  module.exports = {
    stakePct, teamStakes, nextStake, stakesForFixture, stakeLegs, stakeCopy, stakeTip, fixtureModifiers,
    formByTeam, formPoints, weekStart, whatIfStages,
  };
}
