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
eval(pick('matchOdds') + pick('topScorelines'));

const MODEL = {
  home_advantage: 60,
  draw_base: 0.26,
  draw_scale: 375,
  probability_model: 'draw',
  scorelines: {
    bins: 2,
    bin_edges: [0],
    global: { home_win: [[1, 0, 3]], draw: [[1, 1, 1]], away_win: [[0, 1, 1]] },
    bins_data: {
      home_win: [[[2, 1, 1]], []],
      draw: [[[0, 0, 1]], [[1, 1, 1]]],
      away_win: [[[0, 2, 1]], [[0, 1, 1]]],
    },
  },
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

test('scorelines are weighted by outcome and fall back to the global cell', () => {
  const odds = { gap: 200, home_win: 0.6, draw: 0.3, away_win: 0.1 };
  const lines = topScorelines(MODEL, odds);
  // gap > 0 selects bin 1, whose home_win cell is empty -> global [[1,0,3]].
  assert.deepEqual(lines[0], { home_goals: 1, away_goals: 0, probability: 0.6 });
  assert.ok(Math.abs(lines.reduce((sum, line) => sum + line.probability, 0) - 1) < 1e-12);
});
