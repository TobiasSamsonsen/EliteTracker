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
  draw_base: 0.26,
  draw_scale: 375,
  attack_defence: { outcome_blend: 0.5, home: 0.22, base: 0.37, rho: -0.05, k: 0.015, teams: { A: [0.3, 0.15], B: [-0.2, -0.1] } },
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
