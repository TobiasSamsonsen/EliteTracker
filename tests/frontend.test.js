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
   port to the model it was ported from (model/probabilities.py). */
eval(pick('matchOdds') + pick('scoreGrid') + pick('topScorelines') + pick('blendOdds'));

const MODEL = {
  home_advantage: 60,
  home_advantage_beta: 0,
  draw_base: 0.26,
  draw_scale: 375,
  attack_defence: { outcome_blend: 0.5, blend_gamma: 0, home: 0.22, home_beta: 0, base: 0.37, rho: -0.05, k: 0.015, teams: { A: [0.3, 0.15], B: [-0.2, -0.1] } },
};

test('odds match model/probabilities.py exactly', () => {
  const odds = matchOdds(MODEL, 1700, 1300);
  assert.equal(odds.home_win, 0.9050153512773468);
  assert.equal(odds.draw, 0.05774117477091502);
  assert.equal(odds.away_win, 0.03724347395173815);
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
  assert.ok(Math.abs(grid[1][1] - 0.07059684298063104) < 1e-9);
  assert.ok(Math.abs(grid[0][0] - 0.027850049771817192) < 1e-9);
  assert.ok(Math.abs(grid.flat().reduce((sum, p) => sum + p, 0) - 1) < 1e-12);
});

test('scorelines take who-wins from the odds and how-many from the grid', () => {
  const odds = { home_win: 0.6, draw: 0.25, away_win: 0.15 };
  const expected = [
    [1, 1, 0.10936521754255615],
    [2, 1, 0.07507122130035435],
    [2, 0, 0.07358471152212517],
    [2, 2, 0.07149363149818763],
    [3, 1, 0.06734475288162461],
  ];
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
eval(i18nSrc + pick('bandName') + pick('stakePct') + pick('teamStakes') + pick('stakesForFixture') + pick('stakeLegs') + pick('stakeCopy'));

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
  assert.equal(stakePct(0.92, 'no'), '92,0' + NBSP + '%');
  assert.equal(stakePct(0.04, 'no'), '4,0' + NBSP + '%');
  // A 0.04 swing stays visibly small and never collapses to a dash.
  assert.ok(stakePct(smallSwingStake.swing, 'en').startsWith('4.'));
  assert.equal(stakePct(NaN, 'en'), '—');
});

test('title copy is win-oriented and names the consequence', () => {
  setLang('en');
  const copy = stakeCopy(titleStake, 'en');
  assert.ok(copy.main.includes('Win vs Brann'));
  assert.ok(copy.main.includes('92.0%'));
  assert.ok(!copy.main.includes('Lose'));
  assert.ok(copy.sub.includes('falls to 31.0%'));
});

test('relegation copy is loss-oriented, never win-oriented', () => {
  setLang('en');
  const copy = stakeCopy(relegationStake, 'en');
  assert.ok(copy.main.includes('Lose vs Bryne'));
  assert.ok(copy.main.includes('78.0%'));
  assert.ok(!copy.main.includes('Win'));
  assert.ok(copy.sub.includes('Win and it falls to 22.0%'));
  setLang('no');
  const no = stakeCopy(relegationStake, 'no');
  assert.ok(no.main.includes('Tap mot Bryne'));
  assert.ok(!no.main.includes('Seier'));
  assert.ok(no.sub.includes('Med seier faller den til'));
  const noTitle = stakeCopy(titleStake, 'no');
  assert.ok(noTitle.main.includes('Seier mot Brann'));
  assert.ok(!noTitle.main.includes('Tap'));
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

test('every stake string exists in both languages', () => {
  const keys = ['stake.title', 'stake.win.main', 'stake.win.sub', 'stake.lose.main', 'stake.lose.sub', 'stake.legs', 'stake.badge', 'model.how5'];
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
