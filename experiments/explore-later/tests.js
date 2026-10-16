/* Stored tests for views.js: they go back into tests/frontend.test.js with
   eval(pick('liftRows') + pick('liftMoves') + pick('monthlyRatings') + pick('riverSegments') + pick('scorelineCells')); */

test('the lift counts promotions, relegations and the longest Eliteserien run', () => {
  const careers = { teams: [{ team_id: 'A', team: 'A', seasons: [
    { season: 2017, league: 'eliteserien', position: 3 }, { season: 2015, league: 'obosligaen', position: 2 },
    { season: 2016, league: 'eliteserien', position: 14 }, { season: 2018, league: 'obosligaen', position: 5 },
    { season: 2020, league: 'eliteserien', position: 9 }]}] };
  const [row] = liftRows(careers);
  assert.deepEqual(row.stops.map((s) => s.rank), [18, 14, 3, 21, 9]);
  // 2019 missing: the 2020 return is not counted as a promotion between consecutive seasons.
  assert.deepEqual(liftMoves(row), { up: 1, down: 1, moves: 2, best: 2 });
});

test('the rating river keeps one point a month, the last', () => {
  const points = [['2026-04-01', 1500], ['2026-04-20', 1510], ['2026-05-02', 1490]];
  assert.deepEqual(monthlyRatings(points), [['2026-04-20', 1510], ['2026-05-02', 1490]]);
});


eval(pick('riverSegments'));

test('the rating river breaks a line across seasons a club did not play', () => {
  const points = [['2016-10-01', 1500], ['2016-11-01', 1510], ['2018-04-01', 1480], ['2018-05-01', 1490]];
  assert.deepEqual(riverSegments(points).map((segment) => segment.length), [2, 2]);
});

test('scorelines index their cells', () => {
  assert.equal(scorelineCells([{ home: 1, away: 0, predicted: 0.08, observed: 0.09 }]).get('1-0').observed, 0.09);
});
