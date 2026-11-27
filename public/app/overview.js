/* ---------- overview: both divisions on one page --------------------- */

/* Built from what the other views already draw, so it adds composition and no
   figure of its own. Each division opens on its title race (one bar split
   between the contenders), then a card per other open race (a bar per club),
   then the match of the week as Kamper picks it beside the climber and the
   faller, then two tiles on to its table and its matches. Every chance carries
   its move since the last round, in the table's arrows. A finished division
   opens on its champion, the next places under it, then its promotion and
   relegation cards. Every block opens the page it summarises (its name is a
   button stretched over it), and a club in it opens the club. One button into
   the Explore tools closes the page. */
const OVERVIEW_DIVISIONS = ['eliteserien', 'obosligaen'];
const OVERVIEW_RACE_CLUBS = 4;
const OVERVIEW_DONE_CLUBS = 6;
const OVERVIEW_TOP_ROWS = 4;
const OVERVIEW_TITLE_CLUBS = 5;
/* A chance's move, in percentage points, for the table's arrow: past `strong`
   the arrow stands upright, any other move leans (`trendDegree`). */
const CHANCE_CUTS = { mild: 0, strong: 10 };

/* The races still open (RACE_OPEN to RACE_SETTLED, as the hero reads them), in
   the order the league lists its bands, with the clubs that have a chance of
   one from RACE_SHOWN up. The title has a row of its own, and a play-off is
   not a race of its own: relegation and promotion already count it
   (`bandChance`), so each division has one card for the bottom and one for the
   top. */
function overviewRaces(report) {
  if (report.model.matches_remaining === 0) return [];
  const slug = report.league.slug;
  return report.league.bands
    .filter((band) => band.tone !== 'playoff' && band.tone !== 'champion')
    .map((band) => {
      const ranked = report.table
        .map((row) => ({ row, chance: bandChance(row, band, slug) }))
        .filter(({ chance }) => chance > RACE_SHOWN)
        .sort((a, b) => b.chance - a.chance);
      return ranked.some(({ chance }) => chance > RACE_OPEN && chance < RACE_SETTLED) ? { band, ranked } : null;
    })
    .filter(Boolean);
}

/* The round the division has reached, of the rounds a season has (every club
   meets every other twice). Null before the first. */
function overviewRound(report) {
  const played = Math.max(0, ...(report.results || []).map((match) => Number(match.round) || 0));
  return played ? { n: played, total: (report.table.length - 1) * 2 } : null;
}

/* The match of the round most worth watching by the live report alone: the
   fallback while the match of the week's eve loads (`weekMatch`). */
function overviewKeyMatch(report) {
  const upcoming = [...(report.fixtures || [])]
    .sort((a, b) => `${a.date} ${a.time || ''}`.localeCompare(`${b.date} ${b.time || ''}`));
  if (!upcoming.length) return null;
  const week = isoWeek(upcoming[0].date);
  const round = upcoming.filter((fixture) => isoWeek(fixture.date) === week);
  return scoreFixtures(report, round).reduce((a, b) => (b.score > a.score ? b : a)).fixture;
}

/* The division as it stood before the round now being played (the latest
   round with a result): the report of the last matchday before that round's
   first match, or the pre-season one. Undefined while it loads, null with no
   round played or no report. */
function overviewBefore(report) {
  const results = report.results || [];
  const round = Math.max(0, ...results.map((match) => Number(match.round) || 0));
  if (!round) return null;
  const first = results
    .filter((match) => Number(match.round) === round)
    .reduce((min, match) => (match.date < min ? match.date : min), '9999-12-31');
  const day = (report.league.matchdays || []).findLast((matchday) => matchday.date < first)?.date || report.league.preseason;
  return divisionOnDay(report, day);
}

/* A club's row in an earlier report of its division, or null. */
function rowIn(before, row) {
  return before?.table?.find((other) => String(other.team_id) === String(row.team_id)) || null;
}

/* A chance's move since the last round, drawn as the table draws a rating's
   (`trendArrowSVG`: upright past CHANCE_CUTS.strong, leaning below it) with
   its size in percentage points. In the good tone when the move is good for
   the club, so a relegation chance that falls is good. Null when it rounds to
   nothing or there is nothing to compare with. */
function chanceChange(now, before, { bad = false, digits = 0 } = {}) {
  if (before == null || now == null) return null;
  const points = (now - before) * 100;
  const shown = Math.round(points * 10 ** digits) / 10 ** digits;
  if (!shown) return null;
  const { direction } = trendDegree(points, CHANCE_CUTS);
  const change = el('span', `overview-change ${(points > 0) !== bad ? 'is-good' : 'is-bad'}`);
  const arrow = el('span', 'overview-change__arrow');
  arrow.innerHTML = trendArrowSVG(direction);
  change.append(arrow, `${num(Math.abs(shown), digits)}${percentSign()}`);
  const text = t('overview.change', { n: signed(shown, digits) });
  change.title = text;
  change.setAttribute('role', 'img');
  change.setAttribute('aria-label', text);
  return change;
}

/* Show a view of the division a link or card sits under. */
function showDivision(slug) {
  if (state.league === slug) return;
  state.league = slug;
  for (const button of document.querySelectorAll('[data-league]')) {
    button.setAttribute('aria-pressed', String(button.dataset.league === slug));
  }
}

function openDivisionView(slug, view, tableView) {
  showDivision(slug);
  if (tableView) toggleTableView(tableView);
  switchView(view);
}

/* A race card opens the race lines of its division, on that race. */
function openRaceLines(slug, band) {
  showDivision(slug);
  state.raceBand = band.label;
  openTool('races');
}

/* A club as a button: its crest and name, opening its page. */
function clubButton(row, className) {
  const button = el('button', className);
  button.type = 'button';
  const crest = teamLogo(row.team_id, row.team, true);
  if (crest) {
    crest.alt = '';
    crest.setAttribute('aria-hidden', 'true');
    button.appendChild(crest);
  }
  button.appendChild(document.createTextNode(row.team));
  button.addEventListener('click', () => openTeamView(row.team_id, row.team));
  return button;
}

/* The head of a block that opens a page: its name as the button (stretched
   over the whole block in CSS, so a click anywhere on it that is not a club
   opens the page) and a caption saying what the figures are, as one line of
   text that may wrap. No arrow: the whole card lifts on hover. */
function overviewCardHead(title, caption, go) {
  const head = el('div', 'overview-card__head');
  const button = el('button', 'overview-card__open', title);
  button.type = 'button';
  button.addEventListener('click', go);
  const label = el('span', 'overview-card__label');
  label.append(button);
  if (caption) label.append(el('span', 'overview-card__caption', caption));
  head.append(label);
  return head;
}

/* A place in a final table, marked in its band's colour as the table marks it. */
function placeBadge(report, position) {
  const place = el('span', 'overview-top__place', String(position));
  const band = bandFor(report.league.bands, position);
  if (band) {
    place.style.setProperty('--strip', bandColor(band, report.table.length));
    place.title = bandName(band);
  }
  return place;
}

/* A finished division's champion, in the title race's row: the club and its
   points in display type, the next places smaller under it. Opens the final
   table. */
function overviewChampionCard(report) {
  const rows = [...report.table].sort((a, b) => a.position - b.position);
  const [first] = rows;
  if (!first) return null;
  const band = report.league.bands.find((b) => b.tone === 'champion') || { label: 'Champions', first: 1, last: 1, tone: 'champion' };
  const card = el('div', 'overview-card overview-title overview-champion');
  card.style.setProperty('--band-color', bandColor(band, report.table.length));
  card.appendChild(overviewCardHead(t('band.Champions'), t('overview.tableFinal'), () => openDivisionView(report.league.slug, 'table', 'current')));
  const lead = el('div', 'overview-champion__lead');
  lead.append(clubButton(first, 'overview-champion__club'), el('b', 'overview-champion__points', t('overview.pointsShort', { n: num(first.points) })));
  card.appendChild(lead);
  const rest = el('ol', 'overview-champion__rest');
  for (const row of rows.slice(1, OVERVIEW_TOP_ROWS)) {
    const item = el('li', 'overview-top__row');
    item.append(placeBadge(report, row.position), clubButton(row, 'overview-race__name'),
      el('b', 'overview-top__points', t('overview.pointsShort', { n: num(row.points) })));
    rest.appendChild(item);
  }
  if (rest.children.length) card.appendChild(rest);
  return card;
}

/* A finished division's outcomes, as races: promotion (OBOS-ligaen) and
   relegation, with the clubs already through and those still in a play-off
   with their chance of it. */
function overviewOutcomes(report) {
  const slug = report.league.slug;
  return report.league.bands
    .filter((band) => band.tone === 'relegation' || (band.tone === 'top' && slug === 'obosligaen'))
    .map((band) => {
      const ranked = report.table
        .map((row) => ({ row, chance: bandChance(row, band, slug) }))
        .filter(({ chance }) => chance > 0.001)
        .sort((a, b) => b.chance - a.chance);
      return ranked.length ? { band, ranked } : null;
    })
    .filter(Boolean);
}

/* A race at a glance: a card in the band's own colour, a row per club with
   its chance large (and its move since the last round) and a bar under it. A
   club already through is told in words once the season is over, and greyed
   while it is still on. */
function overviewRaceCard(report, { band, ranked }, finished) {
  const slug = report.league.slug;
  const before = finished ? null : overviewBefore(report);
  const card = el('div', finished ? 'overview-card overview-race is-finished' : 'overview-card overview-race');
  card.style.setProperty('--band-color', bandColor(band, report.table.length));
  const withPlayoff = ranked.some(({ row }) => bandWithPlayoff(row, band, slug));
  const pending = finished && ranked.some(({ chance }) => chance < 0.999);
  const caption = pending ? t('overview.inPlayoff') : !finished && withPlayoff ? t('overview.playoffIncluded') : '';
  const head = overviewCardHead(bandName(band), caption, () => openRaceLines(slug, band));
  // The race as a picture (share.js), as the title race has it.
  head.append(shareButton({
    title: () => `${bandName(band)} · ${report.league.name} ${report.league.season}`,
    image: () => shareRace(report, { band, ranked }, finished),
    className: 'overview-card__share',
  }));
  card.appendChild(head);
  const list = el('ol', 'overview-race__list');
  for (const { row, chance } of ranked.slice(0, finished ? OVERVIEW_DONE_CLUBS : OVERVIEW_RACE_CLUBS)) {
    const done = finished && chance >= 0.999;
    const item = el('li', done || chance >= RACE_SETTLED ? 'overview-race__club is-through' : 'overview-race__club');
    const value = el('span', 'overview-race__value');
    const old = rowIn(before, row);
    const change = old && chanceChange(chance, bandChance(old, band, slug), { bad: band.tone === 'relegation' });
    if (change) value.append(change);
    value.append(el('b', done ? 'overview-race__figure is-done' : 'overview-race__figure',
      done ? t(band.tone === 'relegation' ? 'overview.relegated' : 'overview.promoted') : pct(chance, chance < 0.1 ? 1 : 0)));
    item.append(clubButton(row, 'overview-race__name'), value);
    // A club already up or down needs no bar: the words say it.
    if (!done) {
      const bar = el('span', 'overview-race__bar');
      bar.style.setProperty('--p', `${Math.round(chance * 100)}%`);
      bar.setAttribute('aria-hidden', 'true');
      item.append(bar);
    }
    list.appendChild(item);
  }
  card.dataset.count = String(list.children.length);
  card.appendChild(list);
  return card;
}

/* The title race: the clubs with a chance worth showing, two at least. */
function overviewTitleRace(report) {
  const band = report.league.bands.find((b) => b.tone === 'champion') || { label: 'Champions', first: 1, last: 1, tone: 'champion' };
  const ranked = report.table
    .map((row) => ({ row, chance: row.position_probabilities[0] }))
    .sort((a, b) => b.chance - a.chance)
    .filter(({ chance }, i) => i < 2 || chance > RACE_SHOWN);
  return { band, ranked };
}

/* The title race, the row the division leads with: each contender's chance in
   display type, with its move since the last round, over one bar split between
   them, as long as its chance. The favourite's share is the title gold and the
   rest of the field one dim slate (CSS): no medal colour, since silver would
   name a second place and a second gold dulls the favourite's share. The
   field's segments are told apart by the gaps and their order, the clubs' own
   from left to right. Whatever the clubs shown leave over is the bar's bare
   track at the end. */
function overviewTitleCard(report, { band, ranked }) {
  const slug = report.league.slug;
  const before = overviewBefore(report);
  const card = el('div', 'overview-card overview-title');
  card.style.setProperty('--band-color', bandColor(band, report.table.length));
  const head = overviewCardHead(t('hero.race.title'), '', () => openRaceLines(slug, band));
  // The title race as a picture (share.js), or the overview's link, at the
  // head's right.
  head.append(shareButton({
    title: () => `${t('hero.race.title')} · ${report.league.name} ${report.league.season}`,
    image: () => shareTitleRace(report),
    className: 'overview-card__share',
  }));
  card.appendChild(head);
  const shown = ranked.slice(0, OVERVIEW_TITLE_CLUBS);
  const clubs = el('ol', 'overview-title__clubs');
  clubs.dataset.count = String(shown.length);
  const bar = el('div', 'overview-title__bar');
  bar.setAttribute('aria-hidden', 'true');
  shown.forEach(({ row, chance }) => {
    const item = el('li', 'overview-title__club');
    const value = el('span', 'overview-title__value');
    value.append(el('b', 'overview-title__figure', pct(chance, 1)));
    const old = rowIn(before, row);
    const change = old && chanceChange(chance, old.position_probabilities[0], { digits: 1 });
    if (change) value.append(change);
    item.append(value, clubButton(row, 'overview-race__name'));
    clubs.appendChild(item);
    const segment = el('span', 'overview-title__seg');
    segment.style.flex = String(Math.max(chance, 0.002));
    bar.appendChild(segment);
  });
  const rest = 1 - shown.reduce((sum, { chance }) => sum + chance, 0);
  if (rest > 0.005) {
    const segment = el('span', 'overview-title__seg is-rest');
    segment.style.flex = String(rest);
    bar.appendChild(segment);
  }
  card.append(clubs, bar);
  return card;
}

/* What a fixture decides, one line per club with a stake in it: its biggest
   band (for the line's colour mark), and the sentence, its chance with a win
   and with a defeat; the home side first. */
function stakeSentences(report, fixture) {
  const best = new Map();
  for (const stake of stakesForFixture([...(report.next_stakes || []), ...(report.high_stakes || [])], fixture.match_id)) {
    const id = String(stake.team_id);
    if (!best.has(id) || stake.swing > best.get(id).swing) best.set(id, stake);
  }
  return [fixture.home_id, fixture.away_id].map((id) => best.get(String(id))).filter(Boolean).map((stake) => {
    const band = { label: stake.band_label, first: stake.band_first, last: stake.band_last, tone: stake.band_tone };
    return {
      band,
      text: t('overview.stake', { band: bandEdgeName(band), team: stake.team, win: pct(stake.p_favourable, 0), loss: pct(stake.p_unfavourable, 0) }),
    };
  });
}

/* One side of the match of the week's board: the club's crest large over its
   name (one button, opening the club), and a line under it. */
function matchSide(row, sub, className) {
  const side = el('div', `overview-match__side ${className}`);
  const button = el('button', 'overview-match__club');
  button.type = 'button';
  const crest = teamLogo(row.team_id, row.team, true);
  if (crest) button.appendChild(crest);
  button.appendChild(el('span', 'overview-match__name', row.team));
  button.addEventListener('click', () => openTeamView(row.team_id, row.team));
  side.appendChild(button);
  if (sub) side.appendChild(el('span', 'overview-match__sub', sub));
  return side;
}

/* The match of the week, the one Kamper's hero shows (`weekMatch`, the week
   the matches view opens on), as a scoreboard: each club's crest large over
   its name, the kick-off time between them before the match and the score
   after (the loser then steps back), the odds bar under the board before it
   and each side's chance as it stood before the match under it after; then what the match decides or did, a line per club marked in
   its band's colour. While the week's eve loads, the live report's pick. */
function overviewMatch(report) {
  const pick = weekMatch(report, null);
  const fixture = pick?.fixture || (pick === undefined ? overviewKeyMatch(report) : null);
  const result = pick?.result || null;
  const match = fixture || result?.match;
  if (!match) return null;
  const block = el('div', `overview-card overview-match${result ? ' is-played' : ''}`);
  block.appendChild(overviewCardHead(t('hero.match.title'), formatDate(match.date), () => openDivisionView(report.league.slug, 'matches')));
  const home = { team_id: match.home_id, team: match.home };
  const away = { team_id: match.away_id, team: match.away };
  const body = el('div', 'overview-match__body');
  const board = el('div', 'overview-match__board');
  const notes = [];
  if (fixture) {
    board.append(
      matchSide(home, null, 'is-home'),
      el('b', 'overview-match__time', fixture.time || '–'),
      matchSide(away, null, 'is-away'));
    body.append(board, oddsBar(fixture.home, fixture.away, fixture));
    notes.push(...stakeSentences(report, fixture));
  } else {
    const hero = resultHero(report, result);
    const diff = match.home_goals - match.away_goals;
    // The dash in a span of its own: the figure type's tight tracking pressed it against the goals.
    const score = el('b', 'overview-match__score', String(match.home_goals));
    score.append(el('span', 'overview-match__dash', '–'), String(match.away_goals));
    board.append(
      matchSide(home, hero.items[0].sub, `is-home${diff < 0 ? ' is-lost' : ''}`),
      score,
      matchSide(away, hero.items[2].sub, `is-away${diff > 0 ? ' is-lost' : ''}`));
    body.append(board);
    if (hero.note) notes.push({ band: result.shift?.move >= 0.02 ? result.shift.band : null, text: hero.note });
  }
  block.appendChild(body);
  if (notes.length) {
    const list = el('ul', 'overview-match__notes');
    for (const { band, text } of notes) {
      const item = el('li', 'overview-match__note', text);
      if (band) item.style.setProperty('--mark', bandColor(band, report.table.length));
      list.appendChild(item);
    }
    block.appendChild(list);
  }
  return block;
}

/* The climber and the faller over the last five matches, each under its own
   label, its rating change in the table's arrow (`trendArrowSVG`, the table's
   cuts and colours) and its rating before and after. It opens the ladder. */
function overviewMovers(report) {
  const movers = heroMovers(report);
  if (!movers) return null;
  const card = el('div', 'overview-card overview-race overview-movers');
  card.appendChild(overviewCardHead(t('overview.moversTitle'), t('overview.moversCaption'), () => openDivisionView(report.league.slug, 'ladder')));
  const list = el('ol', 'overview-race__list');
  for (const item of movers.items) {
    const li = el('li', 'overview-race__club overview-movers__club');
    const { direction } = trendDegree(item.change, TREND_CUTS);
    const value = el('span', `overview-race__value overview-movers__value rating-trend--${direction}`);
    const arrow = el('span', 'overview-change__arrow');
    arrow.innerHTML = trendArrowSVG(direction);
    arrow.setAttribute('aria-hidden', 'true');
    value.append(arrow, el('b', 'overview-race__figure', num(Math.abs(Math.round(item.change)))));
    value.setAttribute('aria-label', signed(item.change));
    li.append(
      el('span', 'overview-movers__label', t(item.tone === 'up' ? 'overview.climber' : 'overview.faller')),
      clubButton(item.row, 'overview-race__name'), value,
      el('span', 'overview-race__sub', t('overview.ratingFrom', { range: item.sub })));
    list.appendChild(li);
  }
  card.appendChild(list);
  return card;
}

function overviewDivision(report) {
  const slug = report.league.slug;
  const live = report.model.matches_remaining > 0;
  const group = el('div', 'overview__division');
  const head = el('div', 'overview__division-head');
  const name = el('h2', 'overview__division-name', report.league.name);
  name.dataset.tier = slug === 'eliteserien' ? '1' : '2';
  const round = overviewRound(report);
  head.appendChild(name);
  if (round) head.appendChild(el('span', 'overview__round', t('overview.round', round)));
  group.appendChild(head);

  // The title race (or the champion) leads, a row of its own; the other races
  // under it.
  const lead = live ? overviewTitleCard(report, overviewTitleRace(report)) : overviewChampionCard(report);
  if (lead) group.appendChild(lead);
  const races = live ? overviewRaces(report) : overviewOutcomes(report);
  if (races.length) {
    const cards = el('div', 'overview__races');
    for (const entry of races) cards.appendChild(overviewRaceCard(report, entry, !live));
    cards.dataset.count = String(cards.children.length);
    group.appendChild(cards);
  }
  if (live) {
    const match = overviewMatch(report);
    const movers = overviewMovers(report);
    if (match || movers) {
      const pair = el('div', 'overview__pair');
      if (match) pair.appendChild(match);
      if (movers) pair.appendChild(movers);
      group.appendChild(pair);
    }
  }
  group.appendChild(overviewDivisionLinks(report, round));
  return group;
}

/* A tile that leads on: its name in the accent colour, a fact from behind it
   and an arrow. */
function overviewTile(title, fact, go, className = '') {
  const button = el('button', `overview-link ${className}`.trim());
  button.type = 'button';
  const text = el('span', 'overview-link__text');
  text.append(el('span', 'overview-link__title', title));
  if (fact) text.append(el('span', 'overview-link__fact', fact));
  const arrow = el('span', 'overview-link__arrow', '→');
  arrow.setAttribute('aria-hidden', 'true');
  button.append(text, arrow);
  button.addEventListener('click', go);
  return button;
}

/* The way on from a division: its table (who tops it) and its matches (when
   the next round starts and how many it has), two tiles across the width. */
function overviewDivisionLinks(report, round) {
  const slug = report.league.slug;
  const leader = [...report.table].sort((a, b) => a.position - b.position)[0];
  const remaining = report.model.matches_remaining;
  const upcoming = [...(report.fixtures || [])]
    .sort((a, b) => `${a.date} ${a.time || ''}`.localeCompare(`${b.date} ${b.time || ''}`));
  let matchesFact = t('overview.matchesDone');
  if (remaining > 0 && upcoming.length) {
    const week = isoWeek(upcoming[0].date);
    const count = upcoming.filter((fixture) => isoWeek(fixture.date) === week).length;
    matchesFact = t(count === 1 ? 'overview.nextOne' : 'overview.next', { date: formatDate(upcoming[0].date), n: num(count) });
  }
  const links = el('nav', 'overview__links');
  links.setAttribute('aria-label', report.league.name);
  links.append(
    overviewTile(t('tab.table'),
      remaining === 0 ? t('overview.tableFinal')
        : round && leader ? t('overview.tableFact', { team: leader.team, points: num(leader.points) }) : t('overview.tableFresh'),
      () => openDivisionView(slug, 'table')),
    overviewTile(t('tab.matches'), matchesFact, () => openDivisionView(slug, 'matches')));
  return links;
}

/* The races open to one club (excluding the play-off band, which promotion and
   relegation already count via `bandChance`), plus a fallback to its likeliest
   finishing place when a live club sits outside every race. */
function overviewOwnRaces(report, row) {
  const live = report.model.matches_remaining > 0;
  const slug = report.league.slug;
  const races = (report.league.bands || [])
    .filter((band) => band.tone !== 'playoff')
    .map((band) => {
      const chance = bandChance(row, band, slug);
      return { band, chance, settled: !live && chance >= 0.999 };
    })
    .filter(({ chance }) => chance >= 0.005);
  let likeliest = null;
  if (!races.length && live && row.position_probabilities?.length) {
    const probs = row.position_probabilities;
    const best = probs.reduce((idx, p, i) => (p > probs[idx] ? i : idx), 0);
    likeliest = { place: best + 1, chance: probs[best] };
  }
  return { races, likeliest };
}

/* The reader's own club (ownClub, set with the star on its page), first on
   the overview where one is set: crest, recent form and key figures (place,
   points, expected points or GD, rating with trend), its next match (or last
   result once finished) with odds bar and stakes/scorelines, and its open race
   chances with round-to-round movement. The whole card opens the club. */
function overviewOwnClub() {
  const id = ownClub();
  if (!id) return null;
  const report = OVERVIEW_DIVISIONS.map((slug) => state.reports[slug])
    .find((r) => r?.table?.some((row) => String(row.team_id) === id));
  if (!report) return null;
  const row = report.table.find((r) => String(r.team_id) === id);
  const slug = report.league.slug;
  const count = report.table.length;
  const live = report.model.matches_remaining > 0;

  const card = el('div', 'overview-card overview-race overview-own');
  const head = overviewCardHead(t('overview.ownTitle'), report.league.name, () => openTeamView(row.team_id, row.team));
  head.append(shareButton({
    title: () => `${row.team} · ${report.league.name} ${report.league.season}`,
    image: () => shareClub(report, row.team_id),
    className: 'overview-card__share',
  }));
  card.appendChild(head);

  const summary = el('div', 'overview-own__summary');
  const identity = el('div', 'overview-own__identity');
  const crest = teamLogo(row.team_id, row.team, true);
  if (crest) {
    crest.classList.add('overview-own__crest');
    identity.appendChild(crest);
  }
  const titleBlock = el('div', 'overview-own__title-block');
  titleBlock.appendChild(el('h3', 'overview-own__name', row.team));

  const clubMatches = [...(report.results || [])]
    .filter((m) => m.home_goals != null && (String(m.home_id) === id || String(m.away_id) === id))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.match_id).localeCompare(String(b.match_id)));
  const lastFive = clubMatches.slice(-5);
  if (lastFive.length) {
    const formRow = el('div', 'overview-own__form');
    let w = 0; let d = 0; let l = 0;
    for (const m of lastFive) {
      const isHome = String(m.home_id) === id;
      const [gf, ga] = isHome ? [m.home_goals, m.away_goals] : [m.away_goals, m.home_goals];
      const letter = gf > ga ? 'W' : gf === ga ? 'D' : 'L';
      if (letter === 'W') w += 1;
      else if (letter === 'D') d += 1;
      else l += 1;
      const chip = el('span', `form__chip form__chip--${letter.toLowerCase()}`, t(`form.${letter}`));
      const opp = shortName(isHome ? m.away : m.home);
      chip.title = `${opp} (${t(isHome ? 'team.homeShort' : 'team.awayShort')}) ${gf}–${ga} · ${formatDate(m.date)}`;
      formRow.appendChild(chip);
    }
    formRow.setAttribute('aria-label', t('form.tooltip', { w, d, l }));
    titleBlock.appendChild(formRow);
  }
  identity.appendChild(titleBlock);
  summary.appendChild(identity);

  const stats = el('ul', 'overview-own__stats');
  const addStat = (valNode, label, { ariaLabel, title } = {}) => {
    const item = el('li', 'overview-own__stat');
    if (ariaLabel) item.setAttribute('aria-label', ariaLabel);
    if (title) item.title = title;
    item.append(valNode, el('span', 'overview-own__stat-label', label));
    stats.appendChild(item);
  };

  const placeVal = el('strong', 'overview-own__place-val', rankText(row.position));
  const currentBand = bandFor(report.league.bands || [], row.position);
  if (currentBand) placeVal.style.setProperty('--strip', bandColor(currentBand, count));
  addStat(placeVal, t(live ? 'overview.ownStatPlace' : 'overview.ownStatFinished'), { ariaLabel: t('overview.ownPlace', { n: row.position }) });

  addStat(el('strong', '', num(row.points)), t('team.points'));

  if (live && row.expected_points != null) {
    addStat(el('strong', '', num(row.expected_points, 0)), t('overview.ownStatExpected'));
  } else {
    addStat(el('strong', gdTone(row.goal_difference).trim(), signed(row.goal_difference)), t('team.gd'));
  }

  const ratingVal = el('strong', 'overview-own__rating-val');
  const trend = computeRatingTrend(row.team, report);
  ratingVal.appendChild(document.createTextNode(num(Math.round(row.rating))));
  if (trend) {
    const arrow = el('span', `overview-own__trend rating-trend--${trend.direction}`);
    arrow.innerHTML = trend.svg;
    arrow.setAttribute('aria-hidden', 'true');
    ratingVal.appendChild(arrow);
  }
  addStat(ratingVal, t('share.rating'), trend ? { ariaLabel: `${num(Math.round(row.rating))} · ${trend.detail}`, title: trend.detail } : {});

  summary.appendChild(stats);
  card.appendChild(summary);

  const buildPair = (homeId, homeName, awayId, awayName, centreNode) => {
    const pair = el('div', 'overview-own__pair');
    const makeSide = (teamId, name, side) => {
      const box = el('span', `overview-own__side overview-own__side--${side}${String(teamId) === id ? ' is-own' : ''}`);
      const sideCrest = teamLogo(teamId, name, true);
      if (sideCrest) box.appendChild(sideCrest);
      box.appendChild(el('span', '', shortName(name)));
      return box;
    };
    pair.append(makeSide(homeId, homeName, 'home'), centreNode, makeSide(awayId, awayName, 'away'));
    return pair;
  };

  const next = live ? [...(report.fixtures || [])]
    .filter((f) => String(f.home_id) === id || String(f.away_id) === id)
    .sort((a, b) => `${a.date} ${a.time || ''}`.localeCompare(`${b.date} ${b.time || ''}`))[0] : null;
  const lastMatch = !live ? clubMatches[clubMatches.length - 1] : null;

  if (next) {
    const matchBox = el('div', 'overview-own__match');
    const when = `${formatDate(next.date)}${next.time ? ` · ${next.time}` : ''}`;
    matchBox.appendChild(el('p', 'overview-own__match-head', `${t('team.nextMatch')} · ${when}`));
    matchBox.appendChild(buildPair(next.home_id, next.home, next.away_id, next.away, el('span', 'overview-own__vs', '–')));
    matchBox.appendChild(oddsBar(shortName(next.home), shortName(next.away), next));
    const stakes = stakesForFixture([...(report.next_stakes || []), ...(report.high_stakes || [])], next.match_id)
      .filter((s) => String(s.team_id) === id)
      .sort((a, b) => b.swing - a.swing);
    const bestStake = stakes[0];
    if (bestStake) {
      const band = { label: bestStake.band_label, first: bestStake.band_first, last: bestStake.band_last, tone: bestStake.band_tone };
      const stakeEl = el('p', 'overview-own__stake', t('overview.ownStake', {
        band: bandEdgeName(band),
        win: pct(bestStake.p_favourable, 0),
        loss: pct(bestStake.p_unfavourable, 0),
      }));
      stakeEl.style.setProperty('--mark', bandColor(band, count));
      matchBox.appendChild(stakeEl);
    } else if (next.scorelines?.length) {
      const scores = el('div', 'overview-own__scores');
      scores.appendChild(el('span', 'overview-own__scores-label', t('overview.ownScorelines')));
      for (const s of next.scorelines.slice(0, 3)) {
        const pill = el('span', 'overview-own__score-pill', `${s.home_goals}–${s.away_goals}`);
        pill.title = pct(s.probability, 1);
        scores.appendChild(pill);
      }
      matchBox.appendChild(scores);
    }
    card.appendChild(matchBox);
  } else if (lastMatch) {
    const matchBox = el('div', 'overview-own__match');
    matchBox.appendChild(el('p', 'overview-own__match-head', `${t('overview.ownLastMatch')} · ${formatDate(lastMatch.date)}`));
    const isHome = String(lastMatch.home_id) === id;
    const [gf, ga] = isHome ? [lastMatch.home_goals, lastMatch.away_goals] : [lastMatch.away_goals, lastMatch.home_goals];
    const letter = gf > ga ? 'W' : gf === ga ? 'D' : 'L';
    const scorePill = el('span', `overview-own__result form__chip--${letter.toLowerCase()}`, `${lastMatch.home_goals}–${lastMatch.away_goals}`);
    matchBox.appendChild(buildPair(lastMatch.home_id, lastMatch.home, lastMatch.away_id, lastMatch.away, scorePill));
    if (row.wins != null) {
      matchBox.appendChild(el('p', 'overview-own__record', t('overview.ownRecord', {
        w: num(row.wins), d: num(row.draws), l: num(row.losses),
      })));
    }
    card.appendChild(matchBox);
  }

  const { races, likeliest } = overviewOwnRaces(report, row);
  if (races.length || likeliest) {
    const before = live ? overviewBefore(report) : null;
    const old = rowIn(before, row);
    const list = el('ul', 'overview-own__races');
    for (const { band, chance, settled } of races) {
      const item = el('li', `overview-own__race${settled ? ' is-settled' : ''}`);
      item.style.setProperty('--band-color', bandColor(band, count));
      if (settled) {
        const label = band.tone === 'relegation' ? t('overview.relegated')
          : band.tone === 'top' && slug === 'obosligaen' ? t('overview.promoted')
            : bandName(band);
        item.append(el('span', 'overview-own__settled-dot'), el('span', 'overview-own__settled-label', label));
      } else {
        const top = el('div', 'overview-own__race-head');
        const labelWrap = el('span', 'overview-own__race-label', shortBandLabel(band, report));
        if (!live) labelWrap.appendChild(el('span', 'overview-own__race-tag', ` · ${t('overview.inPlayoff')}`));
        const val = el('span', 'overview-own__race-val');
        const change = live && old && chanceChange(chance, bandChance(old, band, slug), { bad: band.tone === 'relegation' });
        if (change) val.appendChild(change);
        val.appendChild(el('b', 'overview-own__race-pct', pct(chance, chance < 0.1 ? 1 : 0)));
        top.append(labelWrap, val);
        const bar = el('span', 'overview-race__bar');
        bar.style.setProperty('--p', `${Math.round(chance * 100)}%`);
        bar.setAttribute('aria-hidden', 'true');
        item.append(top, bar);
      }
      list.appendChild(item);
    }
    if (!races.length && likeliest) {
      const item = el('li', 'overview-own__race is-likeliest');
      item.style.setProperty('--band-color', 'var(--accent)');
      const top = el('div', 'overview-own__race-head');
      top.append(
        el('span', 'overview-own__race-label', t('overview.ownLikeliest', { place: rankText(likeliest.place) })),
        el('b', 'overview-own__race-pct', pct(likeliest.chance, 0)),
      );
      const bar = el('span', 'overview-race__bar');
      bar.style.setProperty('--p', `${Math.round(likeliest.chance * 100)}%`);
      bar.setAttribute('aria-hidden', 'true');
      item.append(top, bar);
      list.appendChild(item);
    }
    card.appendChild(list);
  }
  return card;
}

/* Predict on the Overview, for people who already play: the round last scored and the next one, with
   how much of it is tipped. Nothing is fetched (not even the game's scripts) unless this browser holds a
   Predict session, and the answer is kept for ten minutes: three small reads, no more. */
const PREDICT_CARD_FILES = ['/elo-curve.js', '/predict-core.js', '/predict-util.js', '/predict-api.js'];
const PREDICT_CARD_KEY = 'predict.card';
/* The answer, kept for ten minutes in this tab's session storage (a reload or a second visit to the Overview costs no
   reads), under the player's id so another player in the same tab never sees it. */
function predictCardKept() {
  try {
    const kept = JSON.parse(sessionStorage.getItem(PREDICT_CARD_KEY) || 'null');
    return kept && Date.now() - kept.at < 600000 ? kept : null;
  } catch { return null; }
}
function predictCardKeep(uid, data) {
  try { sessionStorage.setItem(PREDICT_CARD_KEY, JSON.stringify({ at: Date.now(), uid, data })); } catch { /* storage blocked: it is asked again */ }
}

function hasPredictSession() {
  try {
    for (let i = 0; i < localStorage.length; i += 1) if (localStorage.key(i).startsWith('predict.session')) return true;
  } catch { /* storage blocked: no card */ }
  return false;
}

async function loadOverviewPredict() {
  await predictScriptsInOrder(PREDICT_CARD_FILES);
  const client = createClient({ config: predictConfig() });
  if (!client.uid) return null;
  const kept = predictCardKept();
  if (kept && kept.uid === client.uid) return kept.data;
  let league = 'eliteserien';
  try { if (['eliteserien', 'obosligaen'].includes(localStorage.getItem('predict.league'))) league = localStorage.getItem('predict.league'); } catch { /* the default */ }
  const [index, stats] = await Promise.all([client.get('meta/rounds'), client.get(`stats/${client.uid}`)]);
  if (!index) return null;
  const nowMs = client.serverNow();
  const rounds = (index.rounds || []).filter((r) => r.league === league).sort((a, b) => a.round - b.round);
  rounds.forEach((r) => { r.kicks = r.ks; });
  // The round the game itself opens on (a round with one match put off for weeks is not it).
  const current = rounds.length ? rounds[currentRoundIndex(rounds, nowMs)] : null;
  // A round with some matches played and others still ahead ('partial') still has matches to tip.
  const currentStatus = current ? roundStatus(current, nowMs) : null;
  const upcoming = current && ['open', 'future', 'partial'].includes(currentStatus) ? current : null;
  const data = { next: null, last: null, season: null, place: null };
  // This season in the game's division, from the stats already read: totals, best round, rounds ahead of the model.
  const series = seasonSeries(stats, index.season, league);
  const high = seasonHighlights(series);
  if (high) {
    data.season = { season: index.season, league, name: state.reports?.[league]?.league?.name, pts: series.reduce((sum, r) => sum + r.pts, 0), acc: series[series.length - 1].acc,
      rounds: high.rounds, best: { round: high.best.round, pts: high.best.pts }, beat: high.beat };
  }
  const open = Boolean(upcoming) && upcoming.opens.getTime() <= nowMs;
  // The open round's entry and, for a player with a season, the season board (your place): side by side.
  const [entry, board, own] = await Promise.all([
    open ? client.get(`entries/${client.uid}/rounds/${upcoming.key}`).catch(() => null) : null,
    data.season ? client.get(`boards/season_${index.season}_${league}`).catch(() => null) : null,
    data.season ? uidHash(client.uid) : null,
  ]);
  if (upcoming) {
    const done = Object.keys((entry && entry.p) || {}).length;
    const nextKick = currentStatus === 'partial' ? Math.min(...(upcoming.kicks || []).map((k) => k.getTime()).filter((k) => k > nowMs)) : null;
    data.next = { round: upcoming.round, open, done, total: upcoming.n, when: Number.isFinite(nextKick) ? nextKick : (open ? upcoming.closes : upcoming.opens).getTime() };
  }
  if (board && data.season) {
    // Your place among people (the model and the crowd take none); past the board's rows, or with a
    // hidden name, the share of players ahead of you from its percentile table.
    const row = (board.rows || []).find((r) => r.kind === 'player' && r.u === own);
    const players = Number(board.players) || 0;
    if (row) data.place = { place: humanRanks(board.rows).get(row), players };
    else {
      const beat = beatShare(board.pct, data.season.pts, board.players);
      if (beat !== null) data.place = { top: Math.max(1, 100 - beat), players };
    }
  }
  let latest = null;
  for (const [key, row] of Object.entries((stats && stats.rounds) || {})) {
    const [season, slug, round] = key.split('_');
    if (slug !== league || !(row.n > 0) || Number(season) !== index.season) continue;
    if (!latest || Number(round) > latest.round) latest = { round: Number(round), pts: 10 * (row.n - row.b), acc: 100 * (1 - row.b / row.n / 2) };
  }
  data.last = latest;
  // Scored in any round, any season: a player, not a newcomer with a session from one visit.
  data.played = Object.keys((stats && stats.rounds) || {}).length > 0;
  const answer = data.next || data.last || data.season ? data : null;
  predictCardKeep(client.uid, answer);
  return answer;
}

/* The invite: Predict on the Overview for a browser with no session, so nobody signed in is ever asked to
   play (a session exists from the first pick, or the first Google sign-in). Built from the season report alone, so it fetches nothing: the next round of
   the division the game opens on, and that round's hardest match to call with the model's odds, as a
   question. Its × rests it for two weeks in this browser. */
const PREDICT_INVITE_REST_KEY = 'predict.invite.rest';
const PREDICT_INVITE_REST_MS = 14 * 86400000;

/* The round a newcomer would tip next, from a division's unplayed fixtures: the earliest round with a
   kick-off still ahead (a lone match or two put off from an earlier round gives way to a full round
   after it), how many of its matches are ahead, when the first is and the round opens (a week before),
   and the closest call among them (the smallest top chance). Kick-offs are Norwegian time, read as
   CET: an hour out in summer, which no line here shows. */
function predictInviteRound(fixtures, nowMs) {
  const kick = (f) => Date.parse(`${f.date}T${f.time || '12:00'}:00+01:00`);
  const ahead = (fixtures || []).filter((f) => Number.isFinite(f.round) && kick(f) > nowMs);
  if (!ahead.length) return null;
  const rounds = new Map();
  for (const f of ahead) rounds.set(f.round, [...(rounds.get(f.round) || []), f]);
  const first = (list) => Math.min(...list.map(kick));
  const ordered = [...rounds.values()].sort((a, b) => first(a) - first(b));
  const matches = ordered.find((list) => list.length >= 3) || ordered[0];
  const top = (f) => Math.max(f.home_win, f.draw, f.away_win);
  const pick = [...matches].sort((a, b) => top(a) - top(b) || kick(a) - kick(b))[0];
  const start = first(matches);
  const date = matches.map((f) => f.date).sort()[0];
  return { round: matches[0].round, n: matches.length, date, start, opens: start - 7 * 86400000, pick };
}

/* A span in full words, never "2 d": "2 dager og 4 timer" under three days, else one unit. */
function predictSpanLong(ms) {
  const { unit, n } = spanParts(ms);
  if (unit === 'now') return t('overview.predict.span.now');
  const words = (u, k) => t(`overview.predict.span.${u}${k === 1 ? '1' : ''}`, { n: k });
  const hours = Math.floor(Math.abs(ms) / 3600000) - n * 24;
  return unit === 'day' && n < 3 && hours > 0 ? t('overview.predict.span.and', { a: words('day', n), b: words('hour', hours) }) : words(unit, n);
}

/* A date written out: "lørdag 28. november". */
function predictLongDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(localeDate(), { weekday: 'long', day: 'numeric', month: 'long' });
}

/* The card's pill: its words and an arrow drawn as an icon (a text arrow sits off the line in Archivo). */
function predictPill(text) {
  const pill = el('span', 'overview-predict__cta');
  const icon = svgEl('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  icon.append(svgEl('path', { d: 'M3 8h10M9 4l4 4-4 4' }));
  pill.append(el('span', '', text), icon);
  return pill;
}

function predictInviteResting() {
  try { return Date.now() - Number(localStorage.getItem(PREDICT_INVITE_REST_KEY) || 0) < PREDICT_INVITE_REST_MS; } catch { return false; }
}

/* Fills `card` with the invite and says whether there was a round to invite to (none between seasons). */
function fillPredictInvite(card, nowMs = Date.now()) {
  let stored = null;
  try { stored = localStorage.getItem('predict.league'); } catch { /* the default */ }
  const slugs = [...new Set([stored, ...OVERVIEW_DIVISIONS].filter((slug) => OVERVIEW_DIVISIONS.includes(slug)))];
  let next = null;
  for (const slug of slugs) {
    next = state.reports[slug] ? predictInviteRound(state.reports[slug].fixtures, nowMs) : null;
    if (next) break;
  }
  if (!next) return false;
  card.classList.add('overview-predict--invite');
  card.dataset.state = 'invite';
  const head = overviewCardHead(t('overview.predict.title'), null, () => switchView('predict'));
  head.querySelector('.overview-card__label').append(el('span', 'overview-predict__new', t('overview.predict.new')));
  const rest = el('button', 'overview-predict__rest', '×');
  rest.type = 'button';
  rest.setAttribute('aria-label', t('overview.predict.rest'));
  rest.title = t('overview.predict.rest');
  rest.addEventListener('click', () => {
    try { localStorage.setItem(PREDICT_INVITE_REST_KEY, String(Date.now())); } catch { /* storage blocked: gone until the next visit */ }
    card.remove();
  });
  head.append(rest);

  const body = el('div', 'overview-predict__body');
  body.append(el('p', 'overview-predict__headline', t('overview.predict.inviteTitle')),
    el('p', 'overview-predict__pitch', t('overview.predict.invitePitch')));

  const { pick } = next;
  const teaser = el('div', 'overview-predict__teaser');
  teaser.append(el('span', 'overview-predict__round', t('overview.predict.closest', { round: next.round })));
  const pair = el('div', 'overview-predict__pair');
  for (const [id, name, side] of [[pick.home_id, shortName(pick.home), 'home'], [pick.away_id, shortName(pick.away), 'away']]) {
    const club = el('span', `overview-predict__club overview-predict__club--${side}`);
    const crest = teamLogo(id, name, true);
    if (crest) club.append(crest);
    club.append(el('span', '', name));
    pair.append(club);
    if (side === 'home') pair.append(el('span', 'overview-predict__vs', '–'));
  }
  teaser.append(pair, oddsBar(shortName(pick.home), shortName(pick.away), pick), el('span', 'overview-predict__ask', t('overview.predict.ask')));

  const meta = el('div', 'overview-predict__meta overview-predict__go');
  const opens = next.opens > nowMs;
  const when = opens
    ? t('overview.predict.inviteOpens', { date: predictLongDate(new Date(next.opens).toISOString().slice(0, 10)) })
    : t('overview.predict.inviteRound', { n: next.n, date: predictLongDate(next.date) });
  meta.append(predictPill(t(opens ? 'overview.predict.look' : 'overview.predict.play')), el('span', 'overview-predict__sub', when));

  card.append(head, body, teaser, meta);
  return true;
}

function overviewPredict() {
  const card = el('div', 'overview-card overview-race overview-predict');
  if (!hasPredictSession()) return !predictInviteResting() && fillPredictInvite(card) ? card : null;
  card.hidden = true;
  loadOverviewPredict().then((data) => {
    // A browser that holds a session is signed in: with nothing to show (no round ahead, a read that came
    // back empty) it gets no card, never the invite. Someone who has not tipped yet sees the open round's.
    if (!data) return;
    // The card is one slim row. Left: where the open round stands (nothing tipped, some, all) with a small
    // button while there is something to tip. Right: what the last scored round came to.
    card.appendChild(overviewCardHead(t('overview.predict.title'), t('overview.predict.caption'), () => switchView('predict')));
    const next = data.next;
    const state = !next ? 'calm' : !next.open ? 'soon' : next.done === 0 ? 'empty' : next.done < next.total ? 'partial' : 'done';
    card.dataset.state = state;
    if (next) {
      const left = predictSpanLong(next.when - Date.now());
      const body = el('div', 'overview-predict__body');
      if (state === 'done') {
        // Every match tipped: a confirmation, a check in the good colour and what can still be done.
        body.classList.add('overview-predict__body--done');
        const check = el('span', 'overview-predict__check');
        const icon = svgEl('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
        icon.append(svgEl('path', { d: 'M3.5 8.5l3 3 6-7' }));
        check.append(icon);
        body.append(check, el('p', 'overview-predict__title', t('overview.predict.inTitle')),
          el('span', 'overview-predict__sub', t('overview.predict.inText', { round: next.round, total: next.total, span: left })));
      } else if (next.open) {
        const title = state === 'empty' ? t('overview.predict.emptyTitle', { round: next.round })
          : t('overview.predict.partialTitle', { round: next.round, done: next.done, total: next.total });
        body.appendChild(el('p', 'overview-predict__title', title));
        const meta = el('div', 'overview-predict__meta');
        const sub = el('span', 'overview-predict__sub', t('overview.predict.closesIn', { span: left }));
        if (next.when - Date.now() < 86400000) sub.dataset.urgent = 'true';
        // The pill first, then when the round closes: the invite's order.
        meta.append(predictPill(t(state === 'empty' ? 'overview.predict.tip' : 'overview.predict.finish')), sub);
        body.appendChild(meta);
      } else {
        body.appendChild(el('p', 'overview-predict__title', t('overview.predict.opens', { round: next.round, span: left })));
      }
      card.appendChild(body);
    }
    const signed = (value) => `${value > 0.05 ? '+' : value < -0.05 ? '-' : ''}${fixed(Math.abs(value), 1)}`;
    // "av 340 spillere"; a phone keeps "av 340".
    const placeLabel = (n) => {
      const label = el('span', '', t('overview.predict.placeOf', { n: num(n) }));
      label.append(el('span', 'overview-predict__long', ` ${t('overview.predict.players')}`));
      return label;
    };
    const place = data.place;
    const placeText = place && (place.place ? rankText(place.place) : t('overview.predict.top', { p: place.top }));
    const season = data.season;
    if (state === 'calm' && season) {
      // No round ahead: the season so far across the card's width, your place first.
      card.classList.add('overview-predict--season');
      const name = season.name || (season.league === 'obosligaen' ? 'OBOS-ligaen' : 'Eliteserien');
      const body = el('div', 'overview-predict__body');
      body.appendChild(el('p', 'overview-predict__title', t('overview.predict.seasonTitle', { league: name, season: season.season })));
      const strip = el('ul', 'overview-predict__season');
      const stat = (value, label, tone) => {
        const item = el('li', 'overview-predict__stat');
        if (tone) item.dataset.tone = tone;
        item.append(el('strong', '', value), typeof label === 'string' ? el('span', '', label) : label);
        strip.appendChild(item);
      };
      if (place) stat(placeText, placeLabel(place.players));
      stat(signed(season.pts), t('predict.recap.pts'), season.pts < -0.05 ? 'bad' : 'good');
      stat(percentText(season.acc, currentLang, 1), t('predict.recap.acc'));
      stat(num(season.rounds), t('overview.predict.roundsPlayed'));
      stat(signed(season.best.pts), t('overview.predict.bestRound', { round: season.best.round }));
      stat(t('overview.predict.beatValue', { n: season.beat, total: season.rounds }), t('overview.predict.beatModel'));
      body.appendChild(strip);
      card.appendChild(body);
      card.hidden = false;
      return;
    }
    // Right: your place on the season board, then what the last scored round came to.
    const figure = (value, label, kind) => {
      const box = el('div', 'overview-predict__fig');
      if (kind) box.dataset.kind = kind;
      box.append(el('strong', '', value), typeof label === 'string' ? el('span', '', label) : label);
      return box;
    };
    const side = el('div', 'overview-predict__side');
    if (place) {
      const group = el('div', 'overview-predict__last overview-predict__place');
      const figures = el('div', 'overview-predict__figs');
      figures.append(figure(placeText, placeLabel(place.players), 'place'));
      group.append(el('span', 'overview-predict__round', t('overview.predict.board')), figures);
      side.appendChild(group);
    }
    const last = data.last;
    if (last && Number.isFinite(last.acc)) {
      const result = el('div', 'overview-predict__last');
      result.appendChild(el('span', 'overview-predict__round', t('overview.predict.lastRound', { round: last.round })));
      const figures = el('div', 'overview-predict__figs');
      // "poeng"; a phone, whose strip has no "Runde 27" over it, says "poeng i runde 27".
      const ptsLabel = el('span', '', t('predict.recap.pts'));
      ptsLabel.append(el('span', 'overview-predict__phone', ` ${t('overview.predict.inRound', { round: last.round })}`));
      figures.append(figure(signed(last.pts), ptsLabel, 'pts'), figure(percentText(last.acc, currentLang, 1), t('predict.recap.acc'), 'acc'));
      figures.firstChild.dataset.tone = last.pts < -0.05 ? 'bad' : 'good';
      result.appendChild(figures);
      side.appendChild(result);
    }
    if (side.children.length) card.appendChild(side);
    card.hidden = false;
  }).catch(() => { /* the card is a convenience: no card */ });
  return card;
}

function renderOverview() {
  // A page built before the overview existed has no place for it.
  const body = $('#overview-body');
  if (!body) return;
  const blocks = OVERVIEW_DIVISIONS.map((slug) => state.reports[slug]).filter(Boolean).map(overviewDivision);
  const own = overviewOwnClub();
  if (own) blocks.unshift(own);
  const predict = overviewPredict();
  if (predict) blocks.splice(own ? 1 : 0, 0, predict);
  blocks.push(overviewTools(), overviewExploreButton());
  body.replaceChildren(...blocks);
}

/* The Explore tools on a desktop or a tablet: a heading with a button to
   the gallery, then every tool as its thumbnail, name and what it shows. On a
   phone (CSS) the one button below stands in for it. */
function overviewTools() {
  const tools = el('div', 'overview__division overview__explore');
  const head = el('div', 'overview__division-head');
  const all = el('button', 'team-mini__full', t('overview.allTools'));
  all.type = 'button';
  all.addEventListener('click', () => switchView('explore'));
  head.append(el('h2', 'overview__division-name', t('overview.tools')), all);
  const strip = el('div', 'overview__tools');
  for (const id of EXPLORE_ITEMS) {
    const tool = el('button', 'overview-tool');
    tool.type = 'button';
    const text = el('span', 'overview-tool__text');
    text.append(el('span', 'overview-tool__title', t(`explore.${id}.title`)), el('span', 'overview-tool__desc', t(`explore.${id}.desc`)));
    tool.append(exploreThumb(id), text);
    tool.addEventListener('click', () => openTool(id));
    strip.appendChild(tool);
  }
  tools.append(head, strip);
  return tools;
}

/* Where a view's Explore tools stand (placeToolLinks): on a desktop or a
   tablet under the panel's head, where the markup has them (What if in
   Matches' head corner); on a phone at the panel's foot, under its legend,
   so the view's own content comes first, except where the markup says
   data-place="top" (the ladder, Matches): those stay at the top on a phone,
   as small pills (.tool-links--pill) that do not draw the eye from the view.
   data-place-wide="foot" turns it round for a wider screen: the ladder's
   stand under the ladder there. A marker keeps each one's place in the
   head, and crossing 760px moves them back and forth. */
function placeToolLinks() {
  const phone = PHONE_SHEETS.matches;
  for (const nav of document.querySelectorAll('.tool-links[data-tools]')) {
    if (!nav.toolHome) {
      nav.toolHome = document.createComment(' tool links ');
      nav.toolHead = nav.classList.contains('tool-links--head');
      nav.before(nav.toolHome);
    }
    const panel = nav.toolHome.parentElement.closest('.panel');
    const pill = phone && nav.dataset.place === 'top';
    nav.classList.toggle('tool-links--pill', pill);
    const foot = phone ? !pill : nav.dataset.placeWide === 'foot';
    if (foot) {
      if (nav.parentElement !== panel || nav !== panel.lastElementChild) panel.appendChild(nav);
      nav.classList.add('tool-links--foot');
      nav.classList.remove('tool-links--head');
    } else {
      if (nav.previousSibling !== nav.toolHome) nav.toolHome.after(nav);
      nav.classList.remove('tool-links--foot');
      nav.classList.toggle('tool-links--head', nav.toolHead);
    }
  }
}
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(max-width: 760px)').addEventListener('change', placeToolLinks);
}

/* The Explore tools (and the ladder) a view leads on to (data-tools), each
   its thumbnail, name and what it shows, as on the overview; placed by
   placeToolLinks. Rebuilt only when the language changes. What if goes once
   the season is played, and a strip with nothing left in it goes with it. */
function renderToolLinks(report) {
  placeToolLinks();
  const open = report.model?.matches_remaining > 0;
  for (const foot of document.querySelectorAll('.tool-links[data-tools]')) {
    if (foot.dataset.lang !== currentLang) {
      foot.dataset.lang = currentLang;
      const list = el('div', 'tool-links__list');
      for (const id of foot.dataset.tools.split(' ')) {
        // A view of its own (the ladder) opens as that view.
        const view = !EXPLORE_ITEMS.includes(id);
        const copy = view ? id : `explore.${id}`;
        const tool = el('button', 'overview-tool');
        tool.type = 'button';
        if (view) tool.addEventListener('click', () => switchView(id));
        else tool.dataset.openTool = id;
        const text = el('span', 'overview-tool__text');
        // The phone's pills show a short line in place of the description.
        text.append(el('span', 'overview-tool__title', t(`${copy}.title`)), el('span', 'overview-tool__desc', t(`${copy}.desc`)),
          el('span', 'overview-tool__short', t(`${copy}.short`)));
        tool.append(exploreThumb(id), text);
        list.appendChild(tool);
      }
      foot.replaceChildren(el('div', 'label', t('toollink.heading')), list);
    }
    const whatIf = foot.querySelector('[data-open-tool="whatif"]');
    if (whatIf) whatIf.hidden = !open;
    foot.hidden = ![...foot.querySelectorAll('.overview-tool')].some((tool) => !tool.hidden);
  }
}

/* The Explore tools on a phone: one large button, its picture the first
   four tools' thumbnails two by two, its tools named under its title. */
const OVERVIEW_EXPLORE_THUMBS = 4;
function overviewExploreButton() {
  const button = overviewTile(t('overview.exploreTitle'), EXPLORE_ITEMS.map((id) => t(`explore.${id}.title`)).join(' · '),
    () => switchView('explore'), 'overview-explore');
  const thumbs = el('span', 'overview-explore__thumbs');
  thumbs.setAttribute('aria-hidden', 'true');
  for (const id of EXPLORE_ITEMS.slice(0, OVERVIEW_EXPLORE_THUMBS)) thumbs.appendChild(exploreThumb(id));
  button.prepend(thumbs);
  return button;
}

if (typeof module !== 'undefined') {
  module.exports = { predictInviteRound, overviewOwnRaces };
}
