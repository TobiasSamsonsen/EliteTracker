/* Predict's browser logic (public/predict-core.js), pinned to the Python twin by the
   shared vectors in tests/fixtures/predict_vectors.json (tools/predict_vectors.py).
   Run with: node --test tests/predict.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const core = require('../public/predict-core.js');
const { eloOdds } = require('../public/elo-curve.js');

const vectors = JSON.parse(fs.readFileSync(`${__dirname}/fixtures/predict_vectors.json`, 'utf8'));
const near = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

test('the frozen curve and the percent rounding give Python\'s whole percents at every slider position', () => {
  assert.equal(core.FROZEN_CURVE.version, vectors.curve_version);
  let positions = 0;
  for (const [tenths, expected] of Object.entries(vectors.grid)) {
    let index = 0;
    for (let gap = core.GAP.min; gap <= core.GAP.max; gap += core.GAP.step) {
      assert.deepEqual(core.pickPercentages(gap, Number(tenths)), expected[index], `gap ${gap}, tenths ${tenths}`);
      index += 1;
      positions += 1;
    }
  }
  assert.equal(positions, 161 * 14);
});

test('the rounding keeps every outcome in the clip and the total at 100', () => {
  for (const { in: raw, out } of vectors.percentages) {
    assert.deepEqual(core.percentages(...raw), out);
    assert.equal(out.reduce((a, b) => a + b, 0), 100);
  }
});

test('the game curve at the normal draw tendency is the model page\'s own eloOdds', () => {
  const model = { draw_base: 0.26, draw_scale: 375 };
  for (const gap of [-300, -60, 0, 25, 120, 400]) {
    const mine = core.gameOdds(gap);
    const theirs = eloOdds(gap, model);
    mine.forEach((value, i) => near(value, theirs[i], 1e-15));
  }
  // the draw tendency only scales the draw, and the two sides stay valid probabilities
  assert.ok(core.gameOdds(0, 18)[1] > core.gameOdds(0, 10)[1] && core.gameOdds(0, 10)[1] > core.gameOdds(0, 5)[1]);
  for (const tenths of [5, 10, 18]) for (const gap of [-400, 0, 400]) {
    const [h, d, a] = core.gameOdds(gap, tenths);
    assert.ok(h > 0 && d > 0 && a > 0);
    near(h + d + a, 1);
  }
});

test('the equivalent gap inverts the expected score like Python\'s', () => {
  for (const { home, draw, gap } of vectors.equivalent_gap) near(core.equivalentGap(home, draw), gap);
});

test('a typed home percent finds the nearest slider position', () => {
  assert.equal(core.gapForHome(core.pickPercentages(120)[0]), 120);
  assert.equal(core.gapForHome(37), 0);          // an even match is the middle
  assert.ok(core.gapForHome(80) > 150 && core.gapForHome(10) < -150);
  assert.equal(core.pickPercentages(core.gapForHome(55))[0], 55);
});

test('a typed number accepts a comma or a point and rejects anything else', () => {
  assert.equal(core.parseNumber('45'), 45);
  assert.equal(core.parseNumber('45,5'), 45.5);
  assert.equal(core.parseNumber(' 45.5 % '), 45.5);
  assert.ok(Number.isNaN(core.parseNumber('abc')));
  assert.ok(Number.isNaN(core.parseNumber('')));
});

test('Brier and RPS give Python\'s numbers, and a pick scores against the model\'s locked odds', () => {
  for (const c of vectors.scoring) {
    for (const [uid, pick] of Object.entries(c.picks)) {
      const row = c.players[uid];
      const own = core.scoreOwnPick(pick, c.model, c.result);
      near(own.brier, row.brier);
      near(own.rps, row.rps);
      near(own.vsModel, row.vs_model);
    }
    const modelRow = c.model_row;
    near(core.brierScore(...c.model, c.result), modelRow.brier);
    near(core.rpsScore(...c.model, c.result), modelRow.rps);
  }
  near(core.brierScore(0.4, 0.3, 0.3, 'home_win'), 0.54);
  assert.equal(core.outcomeOf(2, 1), 'home_win');
  assert.equal(core.outcomeOf(1, 1), 'draw');
  assert.equal(core.outcomeOf(0, 3), 'away_win');
});

test('the table error is the footrule less the bonuses, like Python', () => {
  for (const c of vectors.tables) {
    assert.equal(core.footrule(c.order, c.truth), c.footrule);
    assert.equal(core.tableBonus(c.order, c.truth, c.plan), c.bonus);
    assert.equal(core.tableError(c.order, c.truth, c.plan), c.error);
  }
});

test('nickname rules and claim keys match Python and firestore.rules', () => {
  for (const c of vectors.nicknames) {
    assert.equal(core.nickKey(c.nick), c.key, c.nick);
    assert.deepEqual(core.nickProblems(c.nick), c.problems, c.nick);
    assert.equal(core.nickBlocked(c.nick), c.blocked, c.nick);
  }
});

test('a generated first nickname is always a legal one', () => {
  let seed = 1;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 200; i++) {
    const nick = core.generateNick(random);
    assert.deepEqual(core.nickProblems(nick), [], nick);
    assert.ok(!core.nickBlocked(nick), nick);
  }
});

test('the public player id is the first ten hex digits of sha-256, like Python\'s uid_hash', async () => {
  assert.equal(await core.uidHash('abc'), 'ba7816bf8f');           // sha256("abc") = ba7816bf8f01cfea...
});
