/* ---------- explore: luck table (viz=luck) --------------------------- */

/* Expected points from one match's xG: each side's goals Poisson at its xG,
   summed to 12 goals and normalised (as model.elo.xg_implied_score). */
function xgPoints(homeXg, awayXg) {
  let [ph, pa] = [Math.exp(-homeXg), Math.exp(-awayXg)];
  let [below, home, draw, homeMass] = [0, 0, 0, 0];
  for (let k = 0; k <= 12; k += 1) {
    if (k) {
      ph *= homeXg / k;
      pa *= awayXg / k;
    }
    home += ph * below;
    draw += ph * pa;
    below += pa;
    homeMass += ph;
  }
  const mass = homeMass * below;
  [home, draw] = [home / mass, draw / mass];
  return [3 * home + draw, 3 * (1 - home - draw) + draw];
}

/* Each match's chances are scaled by each side's finishing last season (its
   goals against its xG then, against the division's), at LUCK_FINISHING of
   its size; a club that was not in the division gets none. Fixed before the
   season, it cannot follow this season's luck, which a rolling finishing and
   keeping did: they took out luck with the skill. PROJECT_STATUS.md, "Luck:
   which signals take out the skill": -0.0049 log loss a match (t -3.0) over
   Eliteserien 2021-2026, and with the trend 80 % of the skill in a club
   season's luck; nothing either way in OBOS-ligaen. */
const LUCK_FINISHING = 0.5;

/* match id -> [home, away] xG points from the chances scaled by last
   season's finishing. `reports` are one division's seasons, each with its
   `league.season` and `results`. Matches without xG are skipped. */
function luckChances(reports) {
  const finishing = new Map();  // season -> team -> log(goals / xG) against the division's
  for (const { league, results } of reports) {
    const clubs = new Map();
    let [goals, xg] = [0, 0];
    for (const r of results) {
      if (r.home_goals == null || !r.xg) continue;
      for (const [team, scored, chances] of [[r.home_id, r.home_goals, r.xg[0]], [r.away_id, r.away_goals, r.xg[1]]]) {
        const [g, x] = clubs.get(team) || [0, 0];
        clubs.set(team, [g + scored, x + chances]);
        goals += scored;
        xg += chances;
      }
    }
    if (!(goals > 0 && xg > 0)) continue;
    const division = Math.log(goals / xg);
    finishing.set(league.season, new Map([...clubs]
      .filter(([, [g, x]]) => g > 0 && x > 0)
      .map(([team, [g, x]]) => [team, Math.log(g / x) - division])));
  }
  const out = new Map();
  for (const { league, results } of reports) {
    const last = finishing.get(league.season - 1) || new Map();
    const scale = (team) => Math.exp(LUCK_FINISHING * (last.get(team) || 0));
    for (const r of results) {
      if (r.home_goals == null || !r.xg) continue;
      out.set(r.match_id, xgPoints(r.xg[0] * scale(r.home_id), r.xg[1] * scale(r.away_id)));
    }
  }
  return out;
}

/* Per club, over the played matches that have xG: its points, the points its
   xG would have earned on average (`xpts`), the same from the chances scaled
   by last season's finishing (`chances`, from `luckChances`; the plain xG
   points where a match is missing from it) and the gap to those (`gap`). */
function luckRows(results, chances = new Map()) {
  const rows = new Map();
  for (const r of results) {
    if (r.home_goals == null || !r.xg) continue;
    const plain = xgPoints(r.xg[0], r.xg[1]);
    const scaled = chances.get(r.match_id) || plain;
    const sides = [
      [r.home_id, r.home, r.home_goals, r.away_goals, plain[0], scaled[0]],
      [r.away_id, r.away, r.away_goals, r.home_goals, plain[1], scaled[1]],
    ];
    for (const [id, team, scored, conceded, xpts, scaledPoints] of sides) {
      const row = rows.get(id) || { team_id: id, team, matches: 0, points: 0, xpts: 0, chances: 0 };
      row.matches += 1;
      row.points += scored > conceded ? 3 : scored === conceded ? 1 : 0;
      row.xpts += xpts;
      row.chances += scaledPoints;
      rows.set(id, row);
    }
  }
  return [...rows.values()]
    .map((row) => ({ ...row, form: row.chances - row.xpts, above: row.points - row.xpts, gap: row.points - row.chances }))
    .sort((a, b) => b.gap - a.gap || a.team.localeCompare(b.team));
}

/* The trend luck is measured against: better sides take more points than
   even their scaled chances, so the gap a match is fitted, least squares, on
   xG points a match over the counted club seasons (`a + b * xpts /
   matches`). Null with too few to fit. */
function luckTrend(rows) {
  if (rows.length < 3) return null;
  const [xs, ys] = [rows.map((row) => row.xpts / row.matches), rows.map((row) => row.gap / row.matches)];
  const mean = (list) => list.reduce((sum, v) => sum + v, 0) / list.length;
  const [mx, my] = [mean(xs), mean(ys)];
  const sxx = xs.reduce((sum, v) => sum + (v - mx) ** 2, 0);
  const b = sxx ? xs.reduce((sum, v, i) => sum + (v - mx) * (ys[i] - my), 0) / sxx : 0;
  return { a: my - b * mx, b };
}

/* A club's luck: points against what such chances usually earn (`usual`:
   the scaled chances plus the trend over its matches, `trendPoints`).
   Without a trend, against the scaled chances alone. */
function withTrend(row, trend) {
  const trendPoints = trend ? row.matches * trend.a + trend.b * row.xpts : 0;
  const usual = row.chances + trendPoints;
  return { ...row, trendPoints, usual, luck: row.points - usual };
}

/* One line under a club's luck: what its usual points are made of. */
const luckUsualText = (row) => t('luck.tipUsual', {
  xpts: num(row.xpts, 1), form: signed(row.form, 1), trend: signed(row.trendPoints, 1),
});

/* The season's table needs the form before each match (from the seasons
   before too) and the trend (every counted season of the division): all are
   drawn from one fetch of the seasons' reports, kept for the page's life, so
   a rewind redraws at once. */
let luckToken = 0;

async function renderLuck(report, body) {
  const token = ++luckToken;
  const { slug, seasons = [] } = report.league;
  if (!body.querySelector('.luck')) body.replaceChildren(el('p', 'explore-empty', t('luck.all.loading')));
  const summary = await fetchSummary();
  const reports = await Promise.all(seasons.map((season) => summary?.seasons?.[season]?.[slug]
    || fetchedReport(reportUrl(season)).then((all) => applyShortNames(all)[slug]).catch(() => null)));
  if (token !== luckToken || state.activeView !== 'explore' || state.exploreItem !== 'luck') return;
  const loaded = reports.filter((r) => r && r.results);
  const chances = luckChances(loaded);
  const history = luckSeasons(loaded, chances);
  const trend = luckTrend(history.rows);
  history.rows = history.rows.map((row) => withTrend(row, trend));
  const rows = luckRows(report.results || [], chances).map((row) => withTrend(row, trend))
    .sort((a, b) => b.luck - a.luck || a.team.localeCompare(b.team));
  const wrap = el('div', 'luck');
  body.replaceChildren(wrap);
  wrap.appendChild(luckHow(trend, history));
  if (rows.length) drawLuckSeason(report, wrap, rows);
  else wrap.appendChild(el('p', 'explore-empty', t('luck.empty')));
  const across = el('section', 'luck-all');
  wrap.appendChild(across);
  drawLuckSeasons(report, across, history, trend);
}

/* What the luck is measured against, step by step, above the table: open on
   a wider screen, closed on a phone, where open it pushed the table below the
   first screen. */
function luckHow(trend, history) {
  const box = el('details', 'luck-how');
  box.open = !window.matchMedia('(max-width: 760px)').matches;
  box.appendChild(el('summary', 'luck-how__title', t('luck.how.title')));
  const steps = el('ol', 'luck-how__steps');
  const list = seasonSpan(history.counted.map((c) => c.season));
  for (const text of [
    t('luck.how.chances'),
    t('luck.how.form'),
    trend ? t('luck.how.trend', { list }) : t('luck.how.noTrend'),
    t('luck.how.luck'),
  ]) {
    // Each step leads with its name ("The chances."), set in bold.
    const [lead, ...rest] = text.split('. ');
    const item = el('li');
    item.append(el('b', null, `${lead}.`), ` ${rest.join('. ')}`);
    steps.appendChild(item);
  }
  box.appendChild(steps);
  return box;
}

function drawLuckSeason(report, wrap, rows) {
  const svg = svgEl('svg', { class: 'chart', role: 'group', 'aria-label': t('luck.aria') });
  wrap.appendChild(svg);
  const box = wrap.getBoundingClientRect().width || 940;
  const narrow = box < SHAPE_NARROW;
  const width = narrow ? Math.round(box) : 940;
  const rowHeight = 26;
  const pad = { top: 26, bottom: 30, left: narrow ? 132 : 180, right: 46 };
  const height = pad.top + rows.length * rowHeight + pad.bottom;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const reach = Math.max(3, Math.ceil(Math.max(...rows.map((row) => Math.abs(row.luck))) / 2) * 2);
  const x = (value) => pad.left + ((value + reach) / (2 * reach)) * (width - pad.left - pad.right);
  const text = (className, content, attrs) => {
    const node = svgEl('text', { class: className, ...attrs });
    node.textContent = content;
    svg.appendChild(node);
    return node;
  };
  const step = reach > 8 ? 4 : 2;
  for (let v = -reach; v <= reach; v += step) {
    svg.appendChild(svgEl('line', { class: v ? 'grid-line' : 'axis-line', x1: x(v), x2: x(v), y1: pad.top - 6, y2: height - pad.bottom }));
    text('tick', signed(v, 0), { x: x(v), y: height - pad.bottom + 14, 'text-anchor': 'middle' });
  }
  text('axis-title', t(narrow ? 'luck.xShort' : 'luck.x'), { x: width - pad.right, y: height - 4, 'text-anchor': 'end' });
  // Both sides' labels share one line, so phones get the short ones.
  text('luck__side', t(narrow ? 'luck.unluckyShort' : 'luck.unlucky'), { x: x(-reach), y: pad.top - 10 });
  text('luck__side', t(narrow ? 'luck.luckyShort' : 'luck.lucky'), { x: x(reach), y: pad.top - 10, 'text-anchor': 'end' });
  text('luck__side', t('luck.place'), { x: 18, y: pad.top - 10, 'text-anchor': 'end' });

  // The table place beside each name, so the lucky can be seen near the top.
  const place = new Map((report.table || []).map((row) => [row.team_id, row.position]));
  rows.forEach((row, i) => {
    const top = pad.top + i * rowHeight;
    const g = svgEl('g', { class: 'luck__row', tabindex: 0, role: 'button' });
    const [a, b] = [x(0), x(row.luck)];
    g.appendChild(svgEl('rect', {
      class: `luck__bar ${row.luck >= 0 ? 'luck__bar--up' : 'luck__bar--down'}`,
      x: Math.min(a, b), y: top + 5, width: Math.max(1, Math.abs(b - a)), height: rowHeight - 10, rx: 3,
    }));
    const rank = svgEl('text', { class: 'luck__place', x: 18, y: top + 17, 'text-anchor': 'end' });
    rank.textContent = place.get(row.team_id) ?? '';
    g.appendChild(rank);
    g.appendChild(svgEl('image', { href: `/logos/${row.team_id}.webp`, x: 24, y: top + 3, width: 20, height: 20 }));
    const name = svgEl('text', { class: 'luck__name', x: 50, y: top + 17 });
    name.textContent = shortName(row.team);
    g.appendChild(name);
    const value = svgEl('text', {
      class: 'luck__value', y: top + 17,
      x: row.luck >= 0 ? b + 5 : b - 5, 'text-anchor': row.luck >= 0 ? 'start' : 'end',
    });
    value.textContent = signed(row.luck, 1);
    g.appendChild(value);
    const tip = t('luck.tip', { points: row.points, usual: num(row.usual, 1), luck: signed(row.luck, 1), n: row.matches });
    g.setAttribute('aria-label', `${row.team}: ${tip}. ${luckUsualText(row)}`);
    attachTip(g, `<b>${esc(row.team)}</b><br>${tip}<br><span class="tooltip__muted">${luckUsualText(row)}</span>`);
    g.addEventListener('click', () => openTeamView(row.team_id, row.team));
    g.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openTeamView(row.team_id, row.team);
    });
    svg.appendChild(g);
  });

  const played = (report.results || []).filter((r) => r.home_goals != null).length;
  const withXg = (report.results || []).filter((r) => r.home_goals != null && r.xg).length;
  const [lucky, unlucky] = [rows[0], rows[rows.length - 1]];
  const chances = rows.reduce((best, row) => (row.xpts > best.xpts ? row : best));
  const leader = rows.find((row) => place.get(row.team_id) === 1);
  const moved = (name, row) => t(name, { luck: signed(row.luck, 1), usual: num(row.usual, 1), points: row.points });
  wrap.appendChild(exploreFacts([
    { value: lucky.team, label: t('luck.fact.lucky'), text: moved('luck.fact.luckyText', lucky) },
    { value: unlucky.team, label: t('luck.fact.unlucky'), text: moved('luck.fact.unluckyText', unlucky) },
    {
      value: chances.team,
      label: t('luck.fact.chances'),
      text: !leader || leader === chances
        ? t('luck.fact.chancesLead', { xpts: num(chances.xpts, 1) })
        : t('luck.fact.chancesBehind', { xpts: num(chances.xpts, 1), team: leader.team, luck: signed(leader.luck, 1) }),
    },
    { value: t('luck.fact.coverageValue', { n: withXg, of: played }), label: t('luck.fact.coverage'), text: t('luck.fact.coverageText') },
  ]));
}

/* A season counts across the seasons once it is over and expected goals
   cover this share of its matches (OBOS-ligaen 2023 has 221 of 240). */
const LUCK_XG_SHARE = 0.9;
/* The luck that "lasts": clubs with this many points of luck. */
const LUCK_CARRY = 5;

/* Every counted season of one division as club seasons (the luck table at
   the final whistle, with the final place), and the seasons counted. */
function luckSeasons(reports, chances = new Map()) {
  const counted = [];
  const rows = [];
  for (const report of reports) {
    const played = report.results.filter((r) => r.home_goals != null);
    const withXg = played.filter((r) => r.xg).length;
    if (report.model.matches_remaining || !played.length || withXg < LUCK_XG_SHARE * played.length) continue;
    const { season } = report.league;
    const place = new Map(report.table.map((row) => [row.team_id, row.position]));
    counted.push({ season, matches: withXg, of: played.length });
    for (const row of luckRows(report.results, chances)) rows.push({ ...row, season, place: place.get(row.team_id) });
  }
  return { counted, rows };
}

/* What the club seasons say, rows carrying their luck (`withTrend`): the
   points above plain xG points by rank on xG points (the top and bottom
   quarter: good sides beat their chances) and what the top quarter's comes
   from, the champions' luck, the luckiest and unluckiest, and how much luck
   is left the season after. */
function luckSummary(rows, carry = LUCK_CARRY) {
  const bySeason = new Map();
  for (const row of rows) bySeason.set(row.season, [...(bySeason.get(row.season) || []), row]);
  const mean = (list) => list.reduce((sum, v) => sum + v, 0) / list.length;
  const [top, middle, bottom, champions] = [[], [], [], []];
  let quarter = 0;
  for (const list of bySeason.values()) {
    const ranked = [...list].sort((a, b) => b.xpts - a.xpts);
    quarter = Math.round(ranked.length / 4);
    ranked.forEach((row, i) => {
      (i < quarter ? top : i >= ranked.length - quarter ? bottom : middle).push(row);
      if (row.place === 1) champions.push({ ...row, mostChances: i === 0 });
    });
  }
  const byLuck = [...rows].sort((a, b) => b.luck - a.luck);
  const seasons = new Map(rows.map((row) => [`${row.team_id} ${row.season}`, row]));
  const carried = rows
    .filter((row) => row.luck >= carry && seasons.has(`${row.team_id} ${row.season + 1}`))
    .map((row) => [row.luck, seasons.get(`${row.team_id} ${row.season + 1}`).luck]);
  const aboveOf = (list) => mean(list.map((row) => row.above));
  return {
    champions,
    quarter,
    top: aboveOf(top),
    topSplit: Object.fromEntries(['form', 'trendPoints', 'luck'].map((part) => [part, mean(top.map((row) => row[part]))])),
    middle: aboveOf(middle),
    bottom: aboveOf(bottom),
    luckiest: byLuck[0],
    unluckiest: byLuck[byLuck.length - 1],
    carried: carried.length ? { n: carried.length, before: mean(carried.map(([a]) => a)), after: mean(carried.map(([, b]) => b)) } : null,
  };
}

/* Seasons as a short list: a run of years as a span, "2020–2025". */
function seasonSpan(seasons) {
  const runs = [];
  for (const season of seasons) {
    const last = runs[runs.length - 1];
    if (last && season === last[1] + 1) last[1] = season;
    else runs.push([season, season]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}

/* Under the season's table: every counted season of the division at once,
   whatever the hero shows: whether good sides have more luck, and the trend
   the table's luck is measured against. */
function drawLuckSeasons(report, section, { counted, rows }, trend) {
  const { slug, seasons = [] } = report.league;
  section.appendChild(el('h3', 'luck-all__title', t('luck.all.title')));
  const why = t(`luck.all.why.${slug}`);
  const list = new Intl.ListFormat(localeNumber(), { type: 'conjunction' });
  const notes = [t('luck.all.seasons', { n: counted.length, list: seasonSpan(counted.map((c) => c.season)), clubs: rows.length })];
  const partial = counted.filter((c) => c.matches < c.of);
  if (partial.length) {
    notes.push(t('luck.all.partial', { list: list.format(partial.map((c) => t('luck.all.partialSeason', { season: c.season, n: c.matches, of: c.of }))) }));
  }
  notes.push(why === `luck.all.why.${slug}` ? t('luck.all.whyAny') : why);
  const running = seasons.find((season) => season === report.league.current_season && !counted.some((c) => c.season === season));
  if (running && rows.length) notes.push(t('luck.all.running', { season: running }));
  if (!trend) {
    section.append(el('p', 'explore-note explore-note--lead', `${t('luck.all.empty')} ${notes.slice(1).join(' ')}`));
    return;
  }
  section.appendChild(el('p', 'explore-note explore-note--lead', notes.join(' ')));

  const svg = svgEl('svg', { class: 'chart', role: 'group', 'aria-label': t('luck.all.aria') });
  section.appendChild(svg);
  const box = section.getBoundingClientRect().width || 940;
  const narrow = box < SHAPE_NARROW;
  const width = narrow ? Math.round(box) : 940;
  const height = narrow ? 300 : 380;
  const pad = { top: 22, right: 16, bottom: 34, left: 34 };
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const reachY = Math.max(5, Math.ceil(Math.max(...rows.map((row) => Math.abs(row.gap))) / 5) * 5);
  const [loX, hiX] = [Math.floor(Math.min(...rows.map((row) => row.xpts)) / 10) * 10, Math.ceil(Math.max(...rows.map((row) => row.xpts)) / 10) * 10];
  const x = (value) => pad.left + ((value - loX) / (hiX - loX || 1)) * (width - pad.left - pad.right);
  const y = (value) => pad.top + ((reachY - value) / (2 * reachY)) * (height - pad.top - pad.bottom);
  const text = (className, content, attrs) => {
    const node = svgEl('text', { class: className, ...attrs });
    node.textContent = content;
    svg.appendChild(node);
  };
  for (let v = -reachY; v <= reachY; v += 5) {
    svg.appendChild(svgEl('line', { class: v ? 'grid-line' : 'axis-line', x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }));
    text('tick', signed(v, 0), { x: pad.left - 6, y: y(v) + 3.5, 'text-anchor': 'end' });
  }
  for (let v = loX; v <= hiX; v += 10) {
    svg.appendChild(svgEl('line', { class: 'grid-line', x1: x(v), x2: x(v), y1: pad.top, y2: height - pad.bottom }));
    text('tick', num(v, 0), { x: x(v), y: height - pad.bottom + 14, 'text-anchor': 'middle' });
  }
  text('axis-title', t('luck.all.x'), { x: width - pad.right, y: height - 4, 'text-anchor': 'end' });
  text('axis-title', t('luck.all.y'), { x: pad.left, y: pad.top - 8 });

  // The trend in season totals, over the club seasons' usual length.
  const matches = rows.reduce((sum, row) => sum + row.matches, 0) / rows.length;
  const line = (xpts) => matches * trend.a + trend.b * xpts;
  svg.appendChild(svgEl('line', { class: 'luck-all__trend', x1: x(loX), y1: y(line(loX)), x2: x(hiX), y2: y(line(hiX)) }));
  text('luck-all__trend-label', t('luck.all.trend'), { x: x(hiX) - 4, y: y(line(hiX)) - 6, 'text-anchor': 'end' });

  // The season the hero shows on top of the rest, the champions on top of all.
  const shown = report.league.season;
  const finish = (row) => (row.place === 1 ? t('luck.all.champion') : t('luck.all.finished', { place: row.place }));
  const order = [...rows].sort((a, b) => (a.place === 1) - (b.place === 1) || (a.season === shown) - (b.season === shown));
  for (const row of order) {
    const champion = row.place === 1;
    const g = svgEl('g', { class: `luck-all__dot${row.season === shown ? ' luck-all__dot--shown' : ''}${champion ? ' luck-all__dot--champion' : ''}`, tabindex: 0 });
    const [cx, cy] = [x(row.xpts), y(row.gap)];
    g.appendChild(svgEl('circle', { class: 'luck-all__hit', cx, cy, r: 10 }));
    const crest = narrow ? 12 : 16;
    g.appendChild(svgEl('circle', { class: 'luck-all__mark', cx, cy, r: champion ? crest / 2 + 3 : 4 }));
    if (champion) g.appendChild(svgEl('image', { href: `/logos/${row.team_id}.webp`, x: cx - crest / 2, y: cy - crest / 2, width: crest, height: crest }));
    const tip = t('luck.all.tip', { season: row.season, points: row.points, usual: num(row.usual, 1), luck: signed(row.luck, 1), finish: finish(row) });
    g.setAttribute('aria-label', `${row.team} ${tip} ${luckUsualText(row)}`);
    attachTip(g, `<b>${esc(row.team)}</b> ${tip}<br><span class="tooltip__muted">${luckUsualText(row)}</span>`);
    svg.appendChild(g);
  }
  section.appendChild(el('p', 'explore-note', t(counted.some((c) => c.season === shown) ? 'luck.all.legendShown' : 'luck.all.legend', { season: shown })));

  const summary = luckSummary(rows);
  const { champions, luckiest, unluckiest, carried } = summary;
  const behind = champions.filter((c) => !c.mostChances).sort((a, b) => a.season - b.season);
  const average = (part) => signed(champions.reduce((sum, c) => sum + c[part], 0) / champions.length, 1);
  const facts = [
    {
      value: t('luck.all.fact.championsValue', { n: champions.filter((c) => c.luck > 0).length, of: champions.length }),
      label: t('luck.all.fact.champions'),
      text: `${t('luck.all.fact.championsText', { luck: average('luck'), above: average('above') })} ${behind.length
        ? t('luck.all.fact.behind', { clubs: list.format(behind.map((c) => `${c.team} ${c.season}`)) })
        : t('luck.all.fact.allAhead')}`,
    },
    {
      value: signed(summary.top, 1),
      label: t('luck.all.fact.top', { k: summary.quarter }),
      text: t('luck.all.fact.topText', {
        k: summary.quarter,
        middle: signed(summary.middle, 1),
        bottom: signed(summary.bottom, 1),
        form: signed(summary.topSplit.form, 1),
        trend: signed(summary.topSplit.trendPoints, 1),
        luck: signed(summary.topSplit.luck, 1),
      }),
    },
    ...[['luck.all.fact.luckiest', luckiest], ['luck.all.fact.unluckiest', unluckiest]].map(([label, row]) => ({
      value: `${row.team} ${row.season}`,
      label: t(label),
      text: t('luck.all.fact.seasonText', { points: row.points, usual: num(row.usual, 1), luck: signed(row.luck, 1), finish: finish(row) }),
    })),
  ];
  // Too few clubs to say what lasts until a handful have been that lucky.
  if (carried && carried.n >= 5) {
    facts.push({
      value: signed(carried.after, 1),
      label: t('luck.all.fact.next'),
      text: t('luck.all.fact.nextText', { min: LUCK_CARRY, n: carried.n, before: signed(carried.before, 1), after: signed(carried.after, 1) }),
    });
  }
  const box2 = exploreFacts(facts);
  box2.querySelector('.explore-facts__title').textContent = t('luck.all.facts');
  section.appendChild(box2);
}

if (typeof module !== 'undefined') {
  module.exports = {
    LUCK_FINISHING, LUCK_XG_SHARE, LUCK_CARRY,
    xgPoints, luckChances, luckRows, luckTrend, withTrend, luckSeasons, luckSummary, seasonSpan,
  };
}
