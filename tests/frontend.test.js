/* Guards the pure logic in public/app.js: the form chips and the compare
   tool's odds. Run with `node --test tests/frontend.test.js`.

   app.js is a plain browser script with no exports, so the functions under
   test are sliced out of the source rather than imported. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const src = fs.readFileSync(`${__dirname}/../public/app.js`, 'utf8');
const pick = (name) => {
  const start = src.indexOf(`function ${name}(`);
  return src.slice(start, src.indexOf('\n}', start) + 2);
};
eval(pick('formByTeam') + pick('formPoints'));

const match = (date, home, away, hg, ag) =>
  ({ date, home, away, home_goals: hg, away_goals: ag });

test('the away side gets the mirror of the home result', () => {
  const form = formByTeam([
    match('2026-03-01', 'A', 'B', 2, 0),
    match('2026-03-08', 'B', 'A', 1, 1),
    match('2026-03-15', 'A', 'B', 0, 3),
  ]);
  assert.deepEqual(form.A, ['W', 'D', 'L']);
  assert.deepEqual(form.B, ['L', 'D', 'W']);
});

/* The compare tool's odds moved from Python into the browser; these pin the
   port to the model it was ported from (model/pricing.py). The numbers are the
   Python model's own, written by tests/test_pricing.py, which fails first when
   the model moves. */
eval(pick('matchOdds') + pick('scoreGrid') + pick('topScorelines') + pick('blendOdds'));

const GOLDEN = JSON.parse(fs.readFileSync(`${__dirname}/fixtures/match_odds.json`, 'utf8'));
const MODEL = GOLDEN.app.model;
const triple = (odds) => [odds.home_win, odds.draw, odds.away_win];

test('odds match model/probabilities.py exactly', () => {
  assert.deepEqual(triple(matchOdds(MODEL, ...GOLDEN.app.ratings)), GOLDEN.app.elo);
});

test('the compare tool prices a match the way model/pricing.py does', () => {
  const odds = blendOdds(MODEL, matchOdds(MODEL, ...GOLDEN.app.ratings), 'A', 'B');
  triple(odds).forEach((p, i) => assert.ok(Math.abs(p - GOLDEN.app.odds[i]) < 1e-12));
});

test('home_win + half the draw reproduces the ELO expectation', () => {
  for (const [home, away] of [[1500, 1500], [1800, 1200], [1300, 1690], [1600, 1580]]) {
    const odds = matchOdds(MODEL, home, away);
    const expected = 1 / (1 + 10 ** (-(home + 60 - away) / 400));
    assert.ok(Math.abs(odds.home_win + odds.draw / 2 - expected) < 1e-12);
    assert.ok(Math.abs(odds.home_win + odds.draw + odds.away_win - 1) < 1e-12);
  }
});

/* Golden values from model/attack_defence.py: score_grid(lam, mu, -0.05) with
   A at home (attack 0.3, defence 0.15) against B (-0.2, -0.1), then
   top_scorelines(grid, MatchProbabilities(0.6, 0.25, 0.15), 5). */
test('scoreline grid matches model/attack_defence.py', () => {
  const grid = scoreGrid(MODEL, 'A', 'B');
  assert.ok(Math.abs(grid[1][1] - GOLDEN.app.grid['1-1']) < 1e-9);
  assert.ok(Math.abs(grid[0][0] - GOLDEN.app.grid['0-0']) < 1e-9);
  assert.ok(Math.abs(grid.flat().reduce((sum, p) => sum + p, 0) - 1) < 1e-12);
});

test('scorelines take who-wins from the odds and how-many from the grid', () => {
  const [home_win, draw, away_win] = GOLDEN.app.given;
  const odds = { home_win, draw, away_win };
  const expected = GOLDEN.app.scorelines;
  const lines = topScorelines(MODEL, odds, 'A', 'B');
  assert.equal(lines.length, 5);
  lines.forEach((line, index) => {
    assert.equal(line.home_goals, expected[index][0]);
    assert.equal(line.away_goals, expected[index][1]);
    assert.ok(Math.abs(line.probability - expected[index][2]) < 1e-9);
  });
  const all = topScorelines(MODEL, odds, 'A', 'B', 81);
  const homeWins = all.filter((line) => line.home_goals > line.away_goals);
  assert.ok(Math.abs(homeWins.reduce((sum, line) => sum + line.probability, 0) - 0.6) < 1e-12);
  // An unknown club is an average one.
  assert.equal(topScorelines(MODEL, odds, 'A', 'nobody').length, 5);
});


test('blended odds sit between the Elo odds and the grid, and reduce to each at the ends', () => {
  const elo = matchOdds(MODEL, 1700, 1300);
  const grid = scoreGrid(MODEL, 'A', 'B');
  const own = { home_win: 0, draw: 0, away_win: 0 };
  grid.forEach((row, i) => row.forEach((p, j) => { own[i > j ? 'home_win' : i === j ? 'draw' : 'away_win'] += p; }));
  const mid = blendOdds(MODEL, elo, 'A', 'B');
  assert.ok(Math.abs(mid.home_win + mid.draw + mid.away_win - 1) < 1e-12);
  assert.ok(mid.home_win > Math.min(elo.home_win, own.home_win) && mid.home_win < Math.max(elo.home_win, own.home_win));
  const pure = { ...MODEL, attack_defence: { ...MODEL.attack_defence, outcome_blend: 1 } };
  assert.ok(Math.abs(blendOdds(pure, elo, 'A', 'B').draw - elo.draw) < 1e-12);
  const goals = { ...MODEL, attack_defence: { ...MODEL.attack_defence, outcome_blend: 0 } };
  assert.ok(Math.abs(blendOdds(goals, elo, 'A', 'B').home_win - own.home_win) < 1e-12);
});

/* --- Feature 1: gap-dependent home advantage --- */
test('beta=0 reproduces constant home advantage', () => {
  const odds = matchOdds(MODEL, 1500, 1500);
  const expected = 1 / (1 + 10 ** (-60 / 400));
  assert.ok(Math.abs(odds.home_win - (expected - odds.draw / 2)) < 1e-12);
});

test('positive beta increases home advantage when home is favoured', () => {
  const modelBeta = { ...MODEL, home_advantage_beta: 0.5 };
  const oddsBase = matchOdds(MODEL, 1600, 1400);
  const oddsBeta = matchOdds(modelBeta, 1600, 1400);
  // Home is favoured (gap=200/400=0.5), so beta should increase home_win.
  assert.ok(oddsBeta.home_win > oddsBase.home_win);
});

test('positive beta decreases home advantage when away is favoured', () => {
  const modelBeta = { ...MODEL, home_advantage_beta: 0.5 };
  const oddsBase = matchOdds(MODEL, 1400, 1600);
  const oddsBeta = matchOdds(modelBeta, 1400, 1600);
  // Away is favoured (gap=-200/400=-0.5), so beta should decrease home_win.
  assert.ok(oddsBeta.home_win < oddsBase.home_win);
});

test('beta affects scoreGrid via eloGap parameter', () => {
  const modelBeta = { ...MODEL, attack_defence: { ...MODEL.attack_defence, home_beta: 0.5 } };
  const gridBase = scoreGrid(MODEL, 'A', 'B', 0);
  const gridGap = scoreGrid(modelBeta, 'A', 'B', 0.5);
  // Positive gap + positive home_beta should shift lam up, changing the grid.
  assert.ok(gridBase[1][1] !== gridGap[1][1]);
});

/* --- Feature 2: gap-dependent blend weight --- */
test('blendOdds with gamma=0 reproduces constant blend weight', () => {
  const elo = matchOdds(MODEL, 1700, 1300);
  const mid = blendOdds(MODEL, elo, 'A', 'B');
  const gammaZero = { ...MODEL, attack_defence: { ...MODEL.attack_defence, blend_gamma: 0 } };
  const midGamma = blendOdds(gammaZero, elo, 'A', 'B');
  assert.ok(Math.abs(mid.home_win - midGamma.home_win) < 1e-12);
});

test('blendOdds with gamma shifts weight toward grid for large gaps', () => {
  const elo = matchOdds(MODEL, 1800, 1200);
  const midBase = blendOdds(MODEL, elo, 'A', 'B');
  const modelGamma = { ...MODEL, attack_defence: { ...MODEL.attack_defence, blend_gamma: 1.0 } };
  const midGamma = blendOdds(modelGamma, elo, 'A', 'B');
  // Large gap + gamma should shift odds toward the grid's odds.
  const grid = scoreGrid(MODEL, 'A', 'B');
  const own = { home_win: 0, draw: 0, away_win: 0 };
  grid.forEach((row, i) => row.forEach((p, j) => { own[i > j ? 'home_win' : i === j ? 'draw' : 'away_win'] += p; }));
  // midGamma should be closer to own than midBase is.
  const distBase = Math.abs(midBase.home_win - own.home_win);
  const distGamma = Math.abs(midGamma.home_win - own.home_win);
  assert.ok(distGamma < distBase);
});

test('spread stretches attack - defence the way model/attack_defence.py does', () => {
  const wide = { ...MODEL, attack_defence: { ...MODEL.attack_defence, spread: 1.1 } };
  const home = grid => grid.reduce((sum, row, i) => sum + row.slice(0, i).reduce((a, b) => a + b, 0), 0);
  assert.ok(home(scoreGrid(wide, 'A', 'B')) > home(scoreGrid(MODEL, 'A', 'B')));
  // No spread in the payload (older reports) is the unstretched grid.
  assert.deepEqual(scoreGrid({ ...MODEL, attack_defence: { ...MODEL.attack_defence, spread: 1 } }, 'A', 'B'), scoreGrid(MODEL, 'A', 'B'));
});

test("the other side's keeping lowers a side's expected goals, as model/attack_defence.py does", () => {
  const home = (grid) => grid.reduce((sum, row, i) => sum + row.slice(0, i).reduce((a, b) => a + b, 0), 0);
  const teams = { ...MODEL.attack_defence.teams, B: [...MODEL.attack_defence.teams.B, 0, 0.2] };
  const kept = { ...MODEL, attack_defence: { ...MODEL.attack_defence, teams } };
  assert.ok(home(scoreGrid(kept, 'A', 'B')) < home(scoreGrid(MODEL, 'A', 'B')));
  // A keeping of 0 (or none: reports before elo-v14.0) is the grid without it.
  const zero = { ...MODEL, attack_defence: { ...MODEL.attack_defence, teams: { ...teams, B: [...MODEL.attack_defence.teams.B, 0, 0] } } };
  assert.deepEqual(scoreGrid(zero, 'A', 'B'), scoreGrid(MODEL, 'A', 'B'));
});

/* --- season rewind: where the slider sits in the live matchdays.
    The range comes from the live report, which spans the whole
    season even when the displayed view is rewound. */
eval(pick('matchdayIndex'));

const DAYS = [
  { date: '2026-03-01', matches_played: 2 },
  { date: '2026-03-08', matches_played: 4 },
  { date: '2026-03-15', matches_played: 6 },
];

test('at live the slider sits on the last matchday', () => {
  assert.equal(matchdayIndex(DAYS, null), DAYS.length - 1);
});

test('a rewound date that is a matchday picks that one', () => {
  assert.equal(matchdayIndex(DAYS, '2026-03-08'), 1);
});

test('a rewound date between matchdays picks the last one on or before it', () => {
  // The divisions play on different days, so the rewound date can
  // fall between this league's matchdays.
  assert.equal(matchdayIndex(DAYS, '2026-03-10'), 1);
});

test('a date before the first matchday clamps to the first', () => {
  assert.equal(matchdayIndex(DAYS, '2025-11-01'), 0);
});

test('an empty range has no index, so the slider stays hidden', () => {
  assert.equal(matchdayIndex([], null), null);
  assert.equal(matchdayIndex([], '2026-03-08'), null);
});

/* --- high stakes: the decisive-match feature.
     Pure helpers are sliced out like the rest; the sentence copy needs the
     real i18n table, so that file is eval'd too (its top level only touches
     localStorage, stubbed here). */
globalThis.localStorage = globalThis.localStorage || { getItem: () => 'en', setItem: () => {} };
globalThis.document = globalThis.document || { querySelectorAll: () => [], getElementById: () => null, documentElement: {} };
const i18nSrc = fs.readFileSync(`${__dirname}/../public/i18n.js`, 'utf8');
eval(i18nSrc + pick('bandName') + pick('bandEdgeName') + pick('stakePct') + pick('teamStakes') + pick('nextStake') + pick('stakesForFixture') + pick('stakeLegs') + pick('stakeCopy') + pick('stakeTip'));

const NBSP = String.fromCharCode(160);
const titleStake = {
  team_id: '1', team: 'Bodø/Glimt',
  band_label: 'Champions', band_tone: 'champion', band_first: 1, band_last: 1,
  match_id: 'm1', leg_match_ids: ['m1', 'm2'], date: '2026-10-19',
  opponent_id: '2', opponent: 'Brann', home_id: '2', away_id: '1',
  p_favourable: 0.92, p_unfavourable: 0.31, p_baseline: 0.6, swing: 0.61,
};
const relegationStake = {
  team_id: '3', team: 'Haugesund',
  band_label: 'Relegation', band_tone: 'relegation', band_first: 15, band_last: 16,
  match_id: 'm3', leg_match_ids: ['m3', 'm4'], date: '2026-10-19',
  opponent_id: '4', opponent: 'Bryne', home_id: '3', away_id: '4',
  p_favourable: 0.78, p_unfavourable: 0.22, p_baseline: 0.5, swing: 0.56,
};
const smallSwingStake = { ...titleStake, p_favourable: 0.34, p_unfavourable: 0.3, swing: 0.04 };

test('stake chances print honestly in both languages, small and large', () => {
  assert.equal(stakePct(0.92, 'en'), '92.0%');
  assert.equal(stakePct(0.04, 'en'), '4.0%');
  // A decimal point in Norwegian too (AGENTS.md); the space before % stays.
  assert.equal(stakePct(0.92, 'no'), '92.0' + NBSP + '%');
  assert.equal(stakePct(0.04, 'no'), '4.0' + NBSP + '%');
  // A 0.04 swing stays visibly small and never collapses to a dash.
  assert.ok(stakePct(smallSwingStake.swing, 'en').startsWith('4.'));
  assert.equal(stakePct(NaN, 'en'), '—');
});

test('title copy is win-oriented: the race, its chance now, then each result', () => {
  setLang('en');
  const copy = stakeCopy(titleStake, 'en');
  assert.equal(copy.main, 'Title 60.0% → 92.0% with a win vs Brann');
  assert.equal(copy.sub, '31.0% with a loss');
});

test('relegation copy is loss-oriented, never win-oriented', () => {
  setLang('en');
  const copy = stakeCopy(relegationStake, 'en');
  assert.equal(copy.main, 'Relegation 50.0% → 78.0% with a loss vs Bryne');
  assert.equal(copy.sub, '22.0% with a win');
  setLang('no');
  const no = stakeCopy(relegationStake, 'no');
  assert.ok(no.main.startsWith('Nedrykk'));
  assert.ok(no.main.endsWith('med tap mot Bryne'));
  assert.ok(no.sub.endsWith('med seier'));
  const noTitle = stakeCopy(titleStake, 'no');
  assert.ok(noTitle.main.startsWith('Tittel'));
  assert.ok(noTitle.main.endsWith('med seier mot Brann'));
  setLang('en');
});

test('the decisive-match tooltip is the race and the club W/D/L, relegation included', () => {
  setLang('en');
  assert.equal(stakeTip({ ...titleStake, p_draw: 0.6 }, 'en'), '<b>Title</b> W 92% · D 60% · L 31%');
  // Relegation's favourable side is the loss: turned back to the club's results.
  assert.equal(stakeTip({ ...relegationStake, p_draw: 0.5 }, 'en'), '<b>Relegation</b> W 22% · D 50% · L 78%');
  // Reports built before the draw was kept show the win and the loss.
  assert.equal(stakeTip(titleStake, 'en'), '<b>Title</b> W 92% · L 31%');
  setLang('no');
  assert.equal(stakeTip({ ...titleStake, p_draw: 0.6 }, 'no'), `<b>Tittel</b> S 92${NBSP}% · U 60${NBSP}% · T 31${NBSP}%`);
  setLang('en');
});

test('two clubs stakes on one fixture merge instead of dropping or doubling', () => {
  const other = { ...titleStake, team_id: '2', team: 'Brann', band_label: 'Conference League qualification', band_tone: 'europe' };
  const entries = [titleStake, other, relegationStake];
  const merged = stakesForFixture(entries, 'm1');
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((e) => e.team).sort(), ['Bodø/Glimt', 'Brann']);
  assert.equal(stakesForFixture(entries, 'm3').length, 1);
  assert.deepEqual(stakesForFixture([], 'm1'), []);
});

test('team stakes follow high_stakes_match_ids and degrade without the keys', () => {
  assert.deepEqual(teamStakes({ table: [] }, '1'), []);
  assert.deepEqual(teamStakes({ table: [{ team_id: '1' }], high_stakes: [] }, '1'), []);
  assert.deepEqual(teamStakes({}, '1'), []);
  // Without high_stakes_match_ids (older reports) fall back to the club's own entries.
  const legacy = { table: [{ team_id: '1' }], high_stakes: [titleStake, relegationStake] };
  assert.deepEqual(teamStakes(legacy, '1').map((e) => e.match_id), ['m1']);
  // With the key, only the club's own listed entries count — another club's
  // entry on the same fixture must not leak into this club's view.
  const otherClub = { ...titleStake, team_id: '2', team: 'Brann' };
  const modern = {
    table: [{ team_id: '1', high_stakes_match_ids: ['m1'] }],
    high_stakes: [titleStake, otherClub, relegationStake],
  };
  assert.deepEqual(teamStakes(modern, '1').map((e) => e.team), ['Bodø/Glimt']);
  assert.deepEqual(teamStakes(modern, '2').map((e) => e.team), ['Brann']);
});

test('legs resolve to the pairing oldest-first, or nothing when unknown', () => {
  const fixtures = [
    { match_id: 'm2', date: '2026-11-08' },
    { match_id: 'm1', date: '2026-09-13' },
    { match_id: 'zz', date: '2026-09-01' },
  ];
  assert.deepEqual(stakeLegs(titleStake, fixtures).map((f) => f.match_id), ['m1', 'm2']);
  assert.deepEqual(stakeLegs({ ...titleStake, leg_match_ids: undefined }, fixtures), []);
});

test('the next-match stake is found per club and degrades without the key', () => {
  const report = { next_stakes: [titleStake, relegationStake] };
  assert.equal(nextStake(report, '3'), relegationStake);
  assert.equal(nextStake(report, '9'), null);
  // Reports built before next_stakes existed have none to show.
  assert.equal(nextStake({ high_stakes: [titleStake] }, '1'), null);
  assert.equal(nextStake(null, '1'), null);
});

/* --- rating trend: total over the last five matches, five degrees. */
eval(pick('trendDegree'));

test('rating trend: steady within ±8 over five matches, fast beyond ±20', () => {
  const cuts = { mild: 8, strong: 20 };
  const key = (v) => trendDegree(v, cuts).key;
  assert.equal(key(8), 'steady');
  assert.equal(key(-8), 'steady');
  assert.equal(key(9), 'rise');
  assert.equal(key(20), 'rise');
  assert.equal(key(21), 'strongRise');
  assert.equal(key(-21), 'strongFall');
  assert.equal(trendDegree(-12, cuts).direction, 'fall');
  assert.equal(trendDegree(30, cuts).direction, 'strong-rise');
});

test('every stake string exists in both languages', () => {
  const keys = ['stake.title', 'stake.win.main', 'stake.win.sub', 'stake.lose.main', 'stake.lose.sub', 'stake.legs', 'stake.badge', 'stake.next', 'next.decisive', 'team.outlook', 'team.likeliest', 'team.xPts', 'team.preSeason', 'team.sinceStart', 'team.xgForm', 'team.now', 'trend.tipMatches', 'page.older', 'page.newer', 'page.earlier', 'page.later', 'model.step1.text', 'model.step2.title', 'model.step2.text', 'model.step3.title', 'model.step3.text', 'model.howLink', 'tab.explore', 'explore.desc', 'explore.back', 'explore.mountain.title', 'explore.mountain.desc', 'explore.attack.title', 'explore.attack.desc', 'attack.x', 'attack.y', 'attack.betterAttack', 'attack.betterDefence', 'attack.even', 'attack.band', 'attack.trend', 'attack.side.defence', 'attack.side.attack', 'attack.balanceDefence', 'attack.balanceAttack', 'attack.balanced', 'attack.tip', 'mountain.preseason', 'timeline.preseason', 'hero.lede.preseason', 'mountain.round', 'mountain.order', 'mountain.byFinish', 'mountain.byFinal', 'mountain.byPrediction', 'mountain.builtUp', 'mountain.play', 'mountain.cutoff', 'explore.facts', 'attack.fact.slope', 'attack.fact.slopeText', 'attack.fact.slopePooledText', 'attack.fact.r', 'attack.fact.rText', 'attack.fact.attack', 'attack.fact.defence', 'mountain.fact.places', 'mountain.fact.placesText', 'mountain.fact.favourite', 'mountain.fact.favouriteText', 'mountain.fact.climber', 'mountain.fact.faller', 'mountain.fact.moveText', 'mountain.fact.surest', 'mountain.fact.surestText', 'mountain.fact.hits', 'mountain.fact.hitsValue', 'mountain.fact.hitsText', 'mountain.fact.favouriteFinalText', 'mountain.fact.endedText', 'mountain.fact.surprise', 'mountain.fact.surpriseText', 'explore.close', 'mountain.cut', 'mountain.where', 'mountain.league', 'mountain.season', 'mountain.allTeams', 'mountain.allPlaces', 'mountain.place', 'mountain.cutTeam', 'mountain.cutPlace', 'mountain.hint', 'mountain.settings', 'mountain.loading', 'mountain.failed'];
  for (const key of keys) {
    setLang('en');
    const en = t(key);
    setLang('no');
    const no = t(key);
    assert.notEqual(en, key);
    assert.notEqual(no, key);
    assert.notEqual(en, no);
  }
  setLang('en');
});

/* Every key has a text of its own in both languages. */
function assertBothLanguages(keys) {
  for (const key of keys) {
    setLang('en');
    const en = t(key);
    setLang('no');
    const no = t(key);
    assert.notEqual(en, key);
    assert.notEqual(no, key);
    assert.notEqual(en, no, key);
  }
  setLang('en');
}

eval(pick('bandChance') + pick('bandWithPlayoff'));

test('promotion and relegation count the play-offs where the report has them', () => {
  const top = { tone: 'top', first: 1, last: 2 };
  const down = { tone: 'relegation', first: 15, last: 16 };
  const playoff = { tone: 'playoff', first: 3, last: 6 };
  const probs = Array.from({ length: 16 }, () => 1 / 16);
  const row = { position_probabilities: probs, promotion_probability: 0.3, relegation_probability: 0.2 };
  assert.equal(bandChance(row, top, 'obosligaen'), 0.3);
  assert.equal(bandChance(row, down, 'eliteserien'), 0.2);
  assert.ok(Math.abs(bandChance(row, playoff, 'obosligaen') - 4 / 16) < 1e-12);
  // Eliteserien's top band is a European place, not promotion; an old report has no play-off fields.
  assert.ok(Math.abs(bandChance(row, top, 'eliteserien') - 2 / 16) < 1e-12);
  assert.ok(Math.abs(bandChance({ position_probabilities: probs }, down, 'eliteserien') - 2 / 16) < 1e-12);
  assert.ok(bandWithPlayoff(row, down, 'eliteserien') && !bandWithPlayoff(row, playoff, 'obosligaen'));
});

test('the play-off and surface strings exist in both languages', () => {
  assertBothLanguages([
    'team.playoffIncluded', 'model.surfaceEdge', 'model.stakes', 'model.stakesValue',
  ]);
});

eval(pick('runInStart'));
const RUN_IN_ROUNDS = 10;

test('a finished season runs in from the first day with ten rounds left', () => {
  // 16 clubs, 240 matches: ten rounds are 80, so the run-in starts at 160 played.
  const report = {
    model: { matches_played: 240, matches_remaining: 0 },
    table: Array.from({ length: 16 }, () => ({})),
    league: { matchdays: [
      { date: '2019-03-30', matches_played: 0, preseason: true },
      { date: '2019-08-31', matches_played: 152 },
      { date: '2019-09-14', matches_played: 160 },
      { date: '2019-09-15', matches_played: 161 },
    ] },
  };
  assert.equal(runInStart(report), '2019-09-14');
  report.league.matchdays = report.league.matchdays.slice(0, 2);
  assert.equal(runInStart(report), null);
});

test('the time-axis note exists in both languages', () => {
  assertBothLanguages([
    'explore.runInFrom',
  ]);
});

/* The luck table's xG points are model.elo.xg_implied_score's Poisson sum
   (12 goals, normalised), as points; golden values from Python. */
eval(pick('xgPoints') + pick('luckChances') + pick('luckRows') + pick('luckSeasons') + pick('luckSummary')
  + pick('seasonSpan') + pick('luckTrend') + pick('withTrend'));
const LUCK_XG_SHARE = 0.9;
const LUCK_CARRY = 3;  // the app has 5; these seasons are three matches a club
const LUCK_FINISHING = 0.5;

test('xG points match the Python recurrence', () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);
  const [home, away] = xgPoints(1.8, 0.9);
  close(home, 1.9871806765821036);
  close(away, 0.7838523908999595);
  close(xgPoints(0.4, 2.6)[1], 2.650998624587426);
  const [even1, even2] = xgPoints(1.2, 1.2);
  close(even1, even2);
});

/* A division's seasons: A has the chances and beats them, B is level, C and
   D fall short. Each season is one double round, with fixed xG per pairing. */
const luckSeason = (season, results, { remaining = 0, table } = {}) => ({
  league: { season },
  model: { matches_remaining: remaining },
  table: (table || ['A', 'B', 'C', 'D']).map((id, i) => ({ team_id: id, position: i + 1 })),
  results: results.map(([home_id, away_id, hg, ag, xg], i) => ({
    match_id: `${season}-${i}`, home_id, away_id, home: home_id, away: away_id, home_goals: hg, away_goals: ag, xg,
  })),
});
const strongSeason = (season, extra = []) => luckSeason(season, [
  ['A', 'B', 2, 0, [1.4, 1.2]], ['A', 'C', 2, 0, [1.5, 1.0]], ['A', 'D', 1, 0, [1.6, 0.9]],
  ['B', 'C', 1, 1, [1.2, 1.2]], ['B', 'D', 1, 0, [1.3, 1.1]], ['C', 'D', 0, 1, [1.2, 1.0]],
  ...extra,
]);
const closePair = (a, b) => assert.ok(Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12, `${a} vs ${b}`);

test('the chances take each side\'s finishing last season, against the division, at half strength', () => {
  // 2024: A scores 2 from 1.0 xG, the rest score their xG; the division 5 from 4.0.
  const last = luckSeason(2024, [['A', 'B', 2, 1, [1.0, 1.0]], ['C', 'D', 1, 1, [1.0, 1.0]]]);
  const chances = luckChances([last, luckSeason(2025, [['A', 'B', 0, 0, [1.0, 1.0]], ['E', 'C', 0, 0, [1.0, 1.0]]])]);
  // A finished at 2 / 1.25 of the division, B and C at 1 / 1.25; each counts at half (a square root).
  closePair(chances.get('2025-0'), xgPoints(Math.sqrt(2 / 1.25), Math.sqrt(1 / 1.25)));
  // E was not in the division, and 2024 has no season before it: nothing to scale.
  closePair(chances.get('2025-1'), xgPoints(1.0, Math.sqrt(1 / 1.25)));
  closePair(chances.get('2024-0'), xgPoints(1.0, 1.0));
});

test('a season\'s own goals do not move its chances', () => {
  const last = luckSeason(2024, [['A', 'B', 2, 1, [1.0, 1.0]], ['C', 'D', 1, 1, [1.0, 1.0]]]);
  const [lucky, unlucky] = [5, 0].map((goals) => luckChances([last, luckSeason(2025, [
    ['A', 'B', goals, 0, [1.2, 0.8]], ['B', 'A', 0, goals, [0.9, 1.1]],
  ])]));
  assert.deepEqual([...lucky], [...unlucky]);
});

test('finishing at the division\'s own rate scales nothing, and matches without xG are skipped', () => {
  // A and B each score 3 from 3.0 xG in 2024; the 5-0 without xG does not count.
  const last = luckSeason(2024, [['A', 'B', 2, 1, [2.0, 1.0]], ['B', 'A', 2, 1, [2.0, 1.0]], ['A', 'B', 5, 0, null]]);
  const chances = luckChances([last, luckSeason(2025, [['A', 'B', 1, 1, [1.5, 0.7]], ['A', 'B', 1, 1, null]])]);
  closePair(chances.get('2025-0'), xgPoints(1.5, 0.7));
  assert.ok(!chances.has('2025-1') && !chances.has('2024-2'));
});

test('luck rows sum points, xG points and the scaled chances per club', () => {
  const r = (id, home_id, away_id, hg, ag, xg) => ({ match_id: id, home_id, away_id, home: home_id, away: away_id, home_goals: hg, away_goals: ag, xg });
  const results = [
    r('1', 'A', 'B', 1, 0, [0.3, 2.4]),   // A steals it
    r('2', 'B', 'A', 0, 0, [1.9, 0.2]),
    r('3', 'A', 'B', 2, 2, null),          // no xG: left out on both sides
    r('4', 'A', 'B', null, null, null),
  ];
  const plain = luckRows(results);
  assert.deepEqual(plain.map((row) => row.team_id), ['A', 'B']);
  assert.equal(plain[0].matches, 2);
  assert.equal(plain[0].points, 4);
  // Without scaled chances they are the xG points.
  for (const row of plain) assert.ok(row.chances === row.xpts && row.form === 0 && row.gap === row.above);
  assert.ok(plain[0].gap > 3 && plain[1].gap < -2);
  // With them: form is the difference, the gap is to the scaled chances.
  const scaled = luckRows(results, new Map([['1', [1.0, 1.0]], ['2', [1.5, 0.5]]]));
  const a = scaled.find((row) => row.team_id === 'A');
  assert.ok(Math.abs(a.chances - 1.5) < 1e-12);
  assert.ok(Math.abs(a.form - (1.5 - a.xpts)) < 1e-12);
  assert.ok(Math.abs(a.gap - (4 - 1.5)) < 1e-12 && Math.abs(a.above - (4 - a.xpts)) < 1e-12);
});

test('luck seasons count finished seasons with xG for most matches', () => {
  const noXg = luckSeason(2019, [['A', 'B', 1, 0, null], ['C', 'D', 1, 0, null]]);
  const running = luckSeason(2026, [['A', 'B', 1, 0, [1, 1]]], { remaining: 5 });
  const partial = strongSeason(2023, [['A', 'B', 0, 0, null]]);           // 6 of 7 with xG: under 90 %
  const { counted, rows } = luckSeasons([noXg, partial, strongSeason(2024), running]);
  assert.deepEqual(counted, [{ season: 2024, matches: 6, of: 6 }]);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => [row.team_id, row.season, row.place]).sort(), [['A', 2024, 1], ['B', 2024, 2], ['C', 2024, 3], ['D', 2024, 4]]);
});

test('luck summary: champions, quarters by xG points, extremes and what lasts', () => {
  const { rows } = luckSeasons([strongSeason(2024), strongSeason(2025), luckSeason(2026, [
    ['A', 'B', 0, 1, [2.0, 0.5]], ['C', 'D', 2, 0, [0.6, 1.8]],
  ], { table: ['C', 'B', 'A', 'D'] })]);
  const lucky = rows.map((row) => withTrend(row, luckTrend(rows)));
  const summary = luckSummary(lucky);
  assert.equal(summary.quarter, 1);
  assert.deepEqual(summary.champions.map((c) => [c.team_id, c.season, c.mostChances]), [['A', 2024, true], ['A', 2025, true], ['C', 2026, false]]);
  assert.ok(summary.top > 0 && summary.bottom < summary.top);
  // Points above xG points = last season's finishing + the trend + luck.
  const { form, trendPoints, luck } = summary.topSplit;
  assert.ok(Math.abs(form + trendPoints + luck - summary.top) < 1e-12);
  assert.equal(summary.luckiest.luck, Math.max(...lucky.map((row) => row.luck)));
  assert.equal(summary.unluckiest.luck, Math.min(...lucky.map((row) => row.luck)));
});

test('luck is measured against the scaled chances plus the trend of the gap on xG points', () => {
  const row = (xpts, gap, matches = 10) => ({ xpts, chances: xpts, gap, matches, points: xpts + gap });
  // Gap a match = -0.5 + 0.4 * xG points a match, exactly.
  const rows = [row(10, -1), row(15, 1), row(20, 3)];
  const trend = luckTrend(rows);
  assert.ok(Math.abs(trend.a + 0.5) < 1e-12 && Math.abs(trend.b - 0.4) < 1e-12);
  for (const r of rows.map((x) => withTrend(x, trend))) assert.ok(Math.abs(r.luck) < 1e-12);
  // Over 5 matches with 10 xG points, such chances usually earn 10 - 2.5 + 4.
  const half = withTrend(row(10, 3, 5), trend);
  assert.ok(Math.abs(half.usual - 11.5) < 1e-12 && Math.abs(half.luck - 1.5) < 1e-12);
  assert.ok(Math.abs(half.trendPoints - 1.5) < 1e-12);
  // The trend sits on the scaled chances, not the plain xG points.
  const scaled = withTrend({ ...row(10, 3, 5), chances: 12, points: 13 }, trend);
  assert.ok(Math.abs(scaled.usual - 13.5) < 1e-12 && Math.abs(scaled.luck + 0.5) < 1e-12);
  // Without a trend, luck is the gap to the scaled chances.
  assert.equal(withTrend(row(10, 3), null).luck, 3);
  assert.equal(luckTrend(rows.slice(0, 2)), null);
});

test('seasons read as spans', () => {
  assert.equal(seasonSpan([2020, 2021, 2022]), '2020–2022');
  assert.equal(seasonSpan([2018, 2020, 2021]), '2018, 2020–2021');
  assert.equal(seasonSpan([2023]), '2023');
});

test('every luck-table string exists in both languages', () => {
  assertBothLanguages([
    'explore.luck.title', 'explore.luck.desc', 'luck.empty', 'luck.aria', 'luck.x', 'luck.xShort',
    'luck.lucky', 'luck.unlucky', 'luck.luckyShort', 'luck.unluckyShort', 'luck.place', 'luck.tip', 'luck.tipUsual',
    'luck.fact.lucky', 'luck.fact.unlucky', 'luck.fact.luckyText', 'luck.fact.unluckyText',
    'luck.fact.chances', 'luck.fact.chancesLead', 'luck.fact.chancesBehind',
    'luck.fact.coverage', 'luck.fact.coverageValue', 'luck.fact.coverageText',
    'luck.how.title', 'luck.how.chances', 'luck.how.form', 'luck.how.trend',
    'luck.how.noTrend', 'luck.how.luck',
    'luck.all.title', 'luck.all.loading', 'luck.all.seasons', 'luck.all.partial', 'luck.all.partialSeason', 'luck.all.why.eliteserien',
    'luck.all.why.obosligaen', 'luck.all.whyAny', 'luck.all.running', 'luck.all.empty', 'luck.all.aria',
    'luck.all.x', 'luck.all.y', 'luck.all.tip', 'luck.all.champion', 'luck.all.finished',
    'luck.all.legend', 'luck.all.legendShown', 'luck.all.facts', 'luck.all.fact.champions',
    'luck.all.fact.championsValue', 'luck.all.fact.championsText', 'luck.all.fact.behind', 'luck.all.fact.allAhead',
    'luck.all.fact.top', 'luck.all.fact.topText', 'luck.all.fact.luckiest', 'luck.all.fact.unluckiest',
    'luck.all.fact.seasonText', 'luck.all.fact.next', 'luck.all.fact.nextText',
  ]);
});

eval(pick('expectedFinish') + pick('scorecardRows') + pick('scorecardLastSeason') + pick('scorecardHits'));

test('scorecard rows put the pre-season call against the final place', () => {
  const pre = [
    { team_id: 'A', position_probabilities: [0.7, 0.3, 0] },
    { team_id: 'B', position_probabilities: [0.3, 0.6, 0.1] },
    { team_id: 'C', position_probabilities: [0, 0.1, 0.9] },
    { team_id: 'X', position_probabilities: [0, 0, 1] },   // not in the final table: dropped
  ];
  const final = [{ team_id: 'C', team: 'C', position: 1 }, { team_id: 'A', team: 'A', position: 2 }, { team_id: 'B', team: 'B', position: 3 }];
  const rows = scorecardRows(2019, pre, final);
  assert.deepEqual(rows.map((row) => [row.team_id, row.finished]), [['A', 2], ['B', 3], ['C', 1]]);
  assert.ok(Math.abs(rows[0].expected - 1.3) < 1e-12);
  // The call is the order the expected finishes put the clubs in.
  assert.deepEqual(rows.map((row) => [row.called, row.miss]), [[1, 1], [2, 1], [3, -2]]);
  assert.equal(scorecardHits(rows), 3);
  assert.equal(scorecardHits([{ miss: 2.5 }, { miss: -2 }]), 1);
  assert.equal(scorecardHits([{ lastMiss: 3 }, { lastMiss: 0 }], 'lastMiss'), 1);
});

test('last season’s table calls the clubs coming down first and those coming up last', () => {
  const previous = {
    eliteserien: { table: [{ team_id: 'TOP', position: 1 }, { team_id: 'DOWN', position: 16 }] },
    obosligaen: { table: [{ team_id: 'UP', position: 1 }, { team_id: 'MID', position: 8 }] },
  };
  // OBOS-ligaen: DOWN from above first, then UP and MID by last season's
  // places; the two clubs from neither table share the 4th and 5th place.
  const rows = ['MID', 'NEW1', 'DOWN', 'NEW2', 'UP'].map((team_id, i) => ({ team_id, finished: i + 1 }));
  assert.deepEqual(scorecardLastSeason(rows, previous).map((row) => row.lastMiss), [1 - 3, 2 - 4.5, 3 - 1, 4 - 4.5, 5 - 2]);
  // Eliteserien: the club up from OBOS-ligaen goes after every club that stayed.
  const top = scorecardLastSeason([{ team_id: 'UP', finished: 1 }, { team_id: 'TOP', finished: 2 }], previous);
  assert.deepEqual(top.map((row) => row.lastMiss), [1 - 2, 2 - 1]);
});

test('every scorecard string exists in both languages', () => {
  assertBothLanguages([
    'model.accuracy.title', 'model.accuracy.desc', 'accuracy.division', 'accuracy.table', 'accuracy.tableLead', 'accuracy.matches',
    'accuracy.matchesLead', 'scorecard.loading', 'scorecard.empty', 'scorecard.aria',
    'scorecard.x', 'scorecard.y', 'scorecard.tip', 'scorecard.fact.hits', 'scorecard.fact.hitsText',
    'scorecard.fact.miss', 'scorecard.fact.missText', 'scorecard.fact.best', 'scorecard.fact.bestText', 'scorecard.fact.over',
    'scorecard.fact.under', 'scorecard.fact.movedText', 'scorecard.cellTip', 'scorecard.pick', 'scorecard.season',
    'scorecard.seasonFirst', 'scorecard.fact.last', 'scorecard.fact.lastText', 'scorecard.fact.missLast',
  ]);
});

eval(pick('calibrationPool') + pick('calibrationInterval') + pick('calibrationRange'));

test('calibration pools the bins at the top of the range', () => {
  const bins = [
    { lo: 0.6, hi: 0.7, n: 10, predicted: 0.65, observed: 0.6 },
    { lo: 0.7, hi: 0.8, n: 30, predicted: 0.74, observed: 0.8 },
    { lo: 0.8, hi: 0.9, n: 10, predicted: 0.84, observed: 0.9 },
  ];
  const top = calibrationPool(bins, 0.7);
  assert.equal(top.n, 40);
  assert.ok(Math.abs(top.predicted - 0.765) < 1e-12 && Math.abs(top.observed - 0.825) < 1e-12);
  assert.equal(calibrationPool(bins, 0.95), null);
});

test('the calibration band is the 95 % Wilson interval, inside 0-1', () => {
  const [low, high] = calibrationInterval(0.5, 100);
  assert.ok(Math.abs(low - 0.4038) < 1e-4 && Math.abs(high - 0.5962) < 1e-4);
  const [zeroLow, zeroHigh] = calibrationInterval(0, 18);
  assert.equal(zeroLow, 0);
  assert.ok(zeroHigh > 0.15 && zeroHigh < 0.2);
  assert.equal(calibrationInterval(1, 5)[1], 1);
});

test('every calibration string exists in both languages', () => {
  assertBothLanguages([
    'calib.loading', 'calib.empty', 'calib.aria',
    'calib.x', 'calib.y', 'calib.tip', 'calib.model', 'calib.elo',
    'calib.proportional', 'calib.power', 'calib.shin', 'calib.tableCaption', 'calib.fact.error',
    'calib.fact.errorText', 'calib.fact.favourites', 'calib.fact.favouritesText', 'calib.fact.market', 'calib.fact.marketText',
    'calib.fact.kelly', 'calib.fact.kellyText', 'calib.note',
  ]);
});

test('each calibration panel takes the same range on both axes, out to the next 10 %', () => {
  // Draws: chances 17-33 %, the band a little wider; the range snaps to tenths.
  const draws = [{ predicted: 0.17, observed: 0.18, n: 400 }, { predicted: 0.33, observed: 0.31, n: 200 }];
  assert.deepEqual(calibrationRange(draws), [0.1, 0.4]);
  // An exact tenth stays put, and the range never leaves 0-1.
  assert.deepEqual(calibrationRange([{ predicted: 0.2, observed: 0.25, n: 1e9 }, { predicted: 0.95, observed: 0.99, n: 60 }]), [0.2, 1]);
});

eval(pick('versionSkill') + pick('versionShort'));

test('the version history measures each version against base rates and labels it short', () => {
  assert.ok(Math.abs(versionSkill(1.0, 1.0620) - (100 * (1 - 1 / 1.062))) < 1e-12);
  assert.equal(versionSkill(1.062, 1.062), 0);
  assert.deepEqual(['elo-v1', 'elo-v11.1', 'elo-v12.0', 'elo-v15.0'].map(versionShort), ['v1', 'v11.1', 'v12', 'v15']);
});

test('every version-history string exists in both languages', () => {
  assertBothLanguages([
    // versions.es is 'Eliteserien' in both languages, so it is left out here.
    'accuracy.versions', 'accuracy.versionsLead', 'versions.empty', 'versions.all', 'versions.market',
    'versions.marketShort', 'versions.marketXg', 'versions.marketXgShort', 'versions.aria', 'versions.y', 'versions.x', 'versions.tipAll', 'versions.tipEs',
    'versions.xg', 'versions.tipXg', 'versions.fact.xg', 'versions.fact.xgText', 'versions.fact.xgMarket', 'versions.tipStep', 'versions.note', 'versions.fact.skill', 'versions.fact.skillText', 'versions.fact.step',
    'versions.fact.stepText', 'versions.fact.gap', 'versions.fact.gapText',
    ...['elo-v1', 'elo-v2', 'elo-v3', 'elo-v5', 'elo-v6', 'elo-v7', 'elo-v8', 'elo-v9', 'elo-v10', 'elo-v11',
      'elo-v11.1', 'elo-v12.0', 'elo-v13.0', 'elo-v14.0', 'elo-v15.0', 'elo-v16.0'].map((v) => `versions.v.${v}`),
  ]);
});

/* The model page (public/model.html) repeats the model's arithmetic in
   public/model.js for its figures. These pin it to the Python model's own
   numbers (src/elitetracker/model), so the page can't drift from the code. */
const pageSrc = fs.readFileSync(`${__dirname}/../public/model.js`, 'utf8');
const pagePick = (name) => {
  const start = pageSrc.indexOf(`function ${name}(`);
  return pageSrc.slice(start, pageSrc.indexOf('\n}', start) + 2);
};
const pageMath = new Function(`
  ${pageSrc.match(/^const (XG_MARGIN|XG_SMOOTHING|GOAL_CAP) = .*;$/gm).join('\n')}
  ${['expectedScore', 'eloOdds', 'xgScore', 'ratingChange', 'poisson', 'lowScore', 'scoreGrid', 'outcomeOf',
    'gridOdds', 'blendOdds', 'scorelines', 'pressure'].map(pagePick).join('\n')}
  return { eloOdds, xgScore, ratingChange, scoreGrid, gridOdds, blendOdds, scorelines, pressure };
`)();
const MODERN = { k_factor: 30, home_advantage: 60, xg_alpha: 0.3, draw_base: 0.26, draw_scale: 375 };
const near = (actual, expected) => {
  for (const [i, value] of [expected].flat().entries()) {
    assert.ok(Math.abs([actual].flat()[i] - value) < 1e-6, `${[actual].flat()[i]} != ${value}`);
  }
};

test('the model page prices a match the way model.probabilities does', () => {
  for (const [gap, odds] of GOLDEN.page.elo) near(pageMath.eloOdds(gap, GOLDEN.page.config), odds);
});

test('the model page moves a rating the way model.elo does', () => {
  near(pageMath.xgScore(1.4, 0.9), 0.622105);
  near(pageMath.xgScore(0.5, 1.9), 0.188514);
  // updated_pair's change, with and without xG, under the modern config.
  near(pageMath.ratingChange(1600, 1600, 1, 0, 0.5, 1.9, MODERN).total, 2.541916);
  near(pageMath.ratingChange(1600, 1600, 1, 0, null, null, MODERN).total, 12.43504);
  near(pageMath.ratingChange(1700, 1550, 3, 0, 2.8, 0.4, MODERN).total, 9.513792);
  const parts = pageMath.ratingChange(1600, 1600, 1, 0, 0.5, 1.9, MODERN).parts;
  near(parts[0] + parts[1] + parts[2], 2.541916);
});

test('the model page builds the score grid and the blend the way model.attack_defence does', () => {
  const { grid: g, blend: b } = GOLDEN.page;
  const grid = pageMath.scoreGrid(...g.rates);
  near(pageMath.gridOdds(grid), g.odds);
  near([grid[0][0], grid[1][1]], [g['0-0'], g['1-1']]);
  const blended = pageMath.blendOdds(pageMath.eloOdds(b.gap, GOLDEN.page.config), pageMath.gridOdds(grid), b.weight);
  near(blended, b.odds);
  const cells = pageMath.scorelines(grid, blended);
  near([cells[1][1], cells[1][0], cells[2][1]], [b['1-1'], b['1-0'], b['2-1']]);
});

test('the model page weighs table stakes the way model.stakes does', () => {
  for (const [d, left, tau, p] of GOLDEN.page.pressure) near(pageMath.pressure(d, left, tau), p);
});
