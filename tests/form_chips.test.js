/* Guards public/app.js form chips: run with `node --test tests/`.
   app.js is a plain browser script with no exports, so the three pure
   functions are sliced out of the source rather than imported. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const src = fs.readFileSync(`${__dirname}/../public/app.js`, 'utf8');
const pick = (name) => {
  const start = src.indexOf(`function ${name}(`);
  return src.slice(start, src.indexOf('\n}', start) + 2);
};
eval(pick('formByTeam') + pick('formBlocks') + pick('formPoints'));

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

test('a short run puts the partial block on the oldest chip', () => {
  // [W] [WWW] [DLW] -- the leftover single match lands on the oldest chip
  assert.deepEqual(formBlocks(['W', 'W', 'W', 'W', 'D', 'L', 'W']), [3, 9, 4]);
  assert.deepEqual(formBlocks([]), []);
  assert.deepEqual(formBlocks(undefined), []);
});
