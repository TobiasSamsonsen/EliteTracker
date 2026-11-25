/* The browser side of Predict that has no DOM: the Firestore REST builders (public/predict-api.js)
   and the small helpers (public/predict-util.js). The write bodies here are the ones the security
   rules accept (tests/test_firestore_rules.py sends the same shape; the page was also driven against
   the emulator). Run with: node --test tests/predict-ui.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../public/predict-api.js');
const util = require('../public/predict-util.js');
const core = require('../public/predict-core.js');

const local = api.predictConfig({ hostname: 'localhost', search: '?emulator=1&project=demo-x' });
const live = api.predictConfig({ hostname: 'elitetracker.no', search: '?emulator=1&project=demo-x' });

test('the emulator is used only on localhost, and only when asked for', () => {
  assert.equal(local.emulator, true);
  assert.match(local.firestoreBase, /^http:\/\/127\.0\.0\.1:8085\/v1$/);
  assert.equal(live.emulator, false);               // the query string means nothing on the real site
  assert.equal(live.project, 'elitetrackerno');
  assert.match(live.firestoreBase, /^https:\/\/firestore\.googleapis\.com\/v1$/);
  assert.equal(api.predictConfig({ hostname: 'localhost', search: '' }).emulator, false);
});

test('values round-trip through the REST encoding', () => {
  const when = new Date('2027-04-04T12:00:00Z');
  const value = { n: 3, x: 1.5, s: 'øl', b: true, none: null, t: when, list: [1, 'a'], map: { k: 7 } };
  assert.deepEqual(api.decodeValue(api.encodeValue(value)), value);
  assert.deepEqual(api.encodeValue(5), { integerValue: '5' });
  assert.deepEqual(api.encodeValue(0.5), { doubleValue: 0.5 });
});

test('field paths quote keys that are not plain identifiers', () => {
  assert.equal(api.fieldPath('p', 's1', 'g'), 'p.s1.g');
  assert.equal(api.fieldPath('rounds', '2026_eliteserien_1', 'n'), 'rounds.`2026_eliteserien_1`.n');
});

test('a pick is a commit of the changed slots only, with a server time on each', () => {
  const [write] = api.entryWrites(local, 'u1', '2026_eliteserien_28', { s1: { g: 20, k: 10, h: 45, d: 27, a: 28 } });
  assert.equal(write.update.name, 'projects/demo-x/databases/(default)/documents/entries/u1/rounds/2026_eliteserien_28');
  assert.deepEqual([...write.updateMask.fieldPaths].sort(), ['curve', 'p.s1.a', 'p.s1.d', 'p.s1.g', 'p.s1.h', 'p.s1.k', 'r']);
  assert.deepEqual(write.updateTransforms, [{ fieldPath: 'p.s1.t', setToServerValue: 'REQUEST_TIME' }]);
  assert.equal(write.update.fields.r.stringValue, '2026_eliteserien_28');
  assert.equal(write.update.fields.curve.integerValue, '1');
  // two changed slots: two transforms, nothing for a slot that did not change
  const two = api.entryWrites(local, 'u1', 'k', { s1: { g: 0, k: 10, h: 37, d: 26, a: 37 }, s3: { g: 5, k: 12, h: 38, d: 30, a: 32 } })[0];
  assert.equal(two.updateTransforms.length, 2);
  assert.ok(!two.updateMask.fieldPaths.some((p) => p.startsWith('p.s2')));
});

test('a new profile claims its nickname in the same commit, under the ASCII key the rules expect', () => {
  const writes = api.profileCreateWrites(local, 'u1', { nick: 'Øyvind_9' });
  assert.match(writes[0].update.name, /\/nicknames\/~oyvind_9$/);
  assert.equal(writes[0].update.fields.uid.stringValue, 'u1');
  assert.match(writes[1].update.name, /\/users\/u1$/);
  const fields = writes[1].update.fields;
  assert.equal(fields.nick.stringValue, 'Øyvind_9');
  assert.equal(fields.nickLower.stringValue, 'øyvind_9');
  assert.equal(fields.nickCustom.booleanValue, false);
  const stamped = writes[1].updateTransforms.map((t) => t.fieldPath).sort();
  assert.deepEqual(stamped, ['created', 'nickAt']);
});

test('a nickname change releases the old claim and makes a new one', () => {
  const writes = api.nicknameChangeWrites(local, 'u1', 'Gammel_1', 'Ny_Øl');
  const names = writes.map((w) => (w.update ? w.update.name : w.delete));
  assert.ok(names.some((n) => /nicknames\/gammel_1$/.test(n) && !n.includes('users')));
  assert.ok(names.some((n) => /nicknames\/ny_~ol$/.test(n)));
  assert.ok(names.some((n) => /users\/u1$/.test(n)));
});

test('table picks, reports, mini-leagues and deletion requests are shaped for the rules', () => {
  const table = api.tableWrites(local, 'u1', '2027_eliteserien', ['3', '1', '2'])[0];
  assert.match(table.update.name, /tables\/u1\/picks\/2027_eliteserien$/);
  assert.equal(table.update.fields.r.stringValue, '2027_eliteserien');
  assert.deepEqual(table.update.fields.order.arrayValue.values.map((v) => v.stringValue), ['3', '1', '2']);
  assert.deepEqual(table.updateTransforms, [{ fieldPath: 't', setToServerValue: 'REQUEST_TIME' }]);
  assert.match(api.deleteRequestWrites(local, 'u1')[0].update.name, /deleteRequests\/u1$/);
  const code = api.newLeagueCode(() => 0.5);
  assert.ok(api.isLeagueCode(code) && code.length === 8);
  assert.ok(!api.isLeagueCode('abcd2345') && !api.isLeagueCode('ABCD234'));
  assert.match(api.leagueCreateWrites(local, 'u1', 'ABCD2345', 'Kontoret')[0].update.name, /leagues\/ABCD2345$/);
  assert.match(api.leagueJoinWrites(local, 'u2', 'ABCD2345')[0].update.name, /leagues\/ABCD2345\/members\/u2$/);
});

test('errors map to the codes the page has words for', () => {
  assert.equal(api.mapError(403, '').code, 'denied');
  assert.equal(api.mapError(401, '').code, 'auth');
  assert.equal(api.mapError(404, '').code, 'not_found');
  assert.equal(api.mapError(429, '').code, 'quota');
  assert.equal(api.mapError(500, '').code, 'server');
  assert.equal(api.mapAuthError('FEDERATED_USER_ID_ALREADY_LINKED').code, 'already_linked');
  assert.equal(api.mapAuthError('INVALID_IDP_RESPONSE').code, 'bad_credential');
  assert.equal(api.mapAuthError('TOO_MANY_ATTEMPTS_TRY_LATER').code, 'quota');
});

test('linking a Google account sends the current ID token so the anonymous uid is kept', () => {
  const request = api.googleLinkRequest(local, 'ANON_ID_TOKEN', 'GOOGLE_ID_TOKEN', 'https://elitetracker.no');
  assert.match(request.url, /accounts:signInWithIdp\?key=/);
  assert.equal(request.body.idToken, 'ANON_ID_TOKEN');
  assert.match(request.body.postBody, /id_token=GOOGLE_ID_TOKEN/);
  assert.match(request.body.postBody, /providerId=google\.com/);
  assert.equal(request.body.requestUri, 'https://elitetracker.no');
});

test('storage that throws never breaks the page', () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const store = api.safeStorage(broken);
  assert.equal(store.get('x'), null);
  store.set('x', '1');
  store.remove('x');
  const memory = new Map();
  const working = api.safeStorage({ getItem: (k) => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) });
  working.set('a', 'b');
  assert.equal(working.get('a'), 'b');
});

test('the client signs in anonymously once, keeps the session, and refreshes an expired token', async () => {
  const calls = [];
  const memory = new Map();
  const storage = { getItem: (k) => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) };
  let clock = 1_000_000;
  const fetchImpl = async (url, init) => {
    calls.push(url);
    const ok = (body) => ({ ok: true, json: async () => body });
    if (url.includes('accounts:signUp')) return ok({ idToken: 'T1', refreshToken: 'R1', localId: 'uid-1', expiresIn: '3600' });
    if (url.includes('/v1/token')) return ok({ id_token: 'T2', refresh_token: 'R2', user_id: 'uid-1', expires_in: '3600' });
    return ok({ fields: { x: { integerValue: '1' } } });
  };
  const client = api.createClient({ config: local, fetchImpl, storage, now: () => clock });
  assert.equal(client.uid, null);
  const first = await client.signUp();
  assert.equal(first.uid, 'uid-1');
  assert.equal(client.uid, 'uid-1');
  assert.ok(memory.get(api.sessionKey(local)));
  await client.get('stats/uid-1');
  assert.equal(calls.filter((u) => u.includes('/v1/token')).length, 0);                  // still fresh
  clock += 3_700_000;                                                                      // the token has expired
  await client.get('stats/uid-1');
  assert.equal(calls.filter((u) => u.includes('/v1/token')).length, 1);
  // a fresh client in the same browser finds the session and does not need a second account
  const again = api.createClient({ config: local, fetchImpl, storage, now: () => clock });
  assert.equal(again.uid, 'uid-1');
  assert.equal(calls.filter((u) => u.includes('accounts:signUp')).length, 1);
});

test('numbers use a decimal point in both languages, with each language\'s thousands grouping', () => {
  assert.equal(util.fixed(0.5, 2), '0.50');
  assert.equal(util.signedScore(-0.1234), '-0.12');
  assert.equal(util.signedScore(0.04), '+0.04');
  assert.equal(util.groupThousands(1794, 'no'), '1794');                      // four digits: no grouping
  assert.match(util.groupThousands(50000, 'no'), /^50[\s  ]000$/);   // a space in Norwegian
  assert.equal(util.groupThousands(50000, 'en'), '50,000');
  assert.match(util.percentText(69.2, 'no'), /^69\.2[\s  ]?%$/);
});

test('rounds are open from a week before the first kick-off and lock at it', () => {
  const day = 86_400_000;
  const round = { opens: new Date(1000 * day - 7 * day), closes: new Date(1000 * day) };
  assert.equal(util.roundStatus(round, 1000 * day - 8 * day), 'future');
  assert.equal(util.roundStatus(round, 1000 * day - 3 * day), 'open');
  assert.notEqual(util.roundStatus(round, 1000 * day + 1), 'open');
});

test('relative time is coarse and never negative', () => {
  assert.deepEqual(util.spanParts(20_000), { unit: 'now', n: 0 });
  assert.deepEqual(util.spanParts(90 * 60_000), { unit: 'hour', n: 1 });
  assert.deepEqual(util.spanParts(3 * 86_400_000), { unit: 'day', n: 3 });
  assert.deepEqual(util.spanParts(-5000), { unit: 'now', n: 0 });
});

test('the ring and the badges follow the plan', () => {
  assert.deepEqual(util.ringState(5, 8), { done: 5, total: 8, fraction: 0.625, complete: false });
  assert.equal(util.ringState(8, 8).complete, true);
  const earned = (stats) => util.badgesFor(stats).filter((b) => b.earned).map((b) => b.id);
  assert.deepEqual(earned({ tips: 0, totals: { n: 0, vm: 0, ab: 0 } }), []);
  assert.deepEqual(earned({ tips: 31, totals: { n: 31, vm: 0.4, ab: 0.2 } }).sort(), ['beatField', 'beatModel', 'first', 'thirty']);
});

test('a session belongs to its project: the live site never sees an emulator session', () => {
  assert.equal(api.sessionKey(live), 'predict.session');
  assert.equal(api.sessionKey(local), 'predict.session.demo-x');
});

test('a public document still loads when the stored session is rejected', async () => {
  const memory = new Map([[api.sessionKey(local), JSON.stringify({ uid: 'u', idToken: 'BROKEN', refreshToken: 'R', expiresAt: 9e15 })]]);
  const storage = { getItem: (k) => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) };
  const fetchImpl = async (url, init) => {
    const authed = init && init.headers && init.headers.Authorization;
    if (url.includes('/v1/token')) return { ok: false, json: async () => ({ error: { message: 'INVALID_REFRESH_TOKEN' } }) };
    if (authed) return { ok: false, status: 403, json: async () => ({ error: { message: 'PERMISSION_DENIED' } }) };
    return { ok: true, json: async () => ({ fields: { season: { integerValue: '2027' } } }) };
  };
  const client = api.createClient({ config: local, fetchImpl, storage });
  assert.deepEqual(await client.get('meta/rounds'), { season: 2027 });
  await assert.rejects(client.get('stats/u'));            // a private document is not retried without a token
});

test('the season panel: the share you beat, the bell, the tiers and your form', () => {
  const pct = Array.from({ length: 101 }, (_, i) => -0.5 + i / 100);       // an even spread, -0.5 .. 0.5
  assert.equal(util.beatShare(pct, 0), 49);
  assert.equal(util.beatShare(pct, 1), 100);
  assert.equal(util.beatShare(pct, -1), 0);
  assert.equal(util.beatShare([], 0.1), null);
  const fit = util.normalFit(pct);
  assert.ok(Math.abs(fit.mean - 0) < 1e-9 && Math.abs(fit.sd - 0.34) < 1e-9);
  assert.equal(util.normalFit(Array(101).fill(0.1)).sd, 0.02);                 // everyone equal: a floor, not zero
  assert.equal(util.normalDensity(fit.mean, fit.mean, fit.sd), 1);
  assert.deepEqual(util.tierOf(95), { id: 'elite', next: null, toNext: 0 });
  assert.deepEqual(util.tierOf(80), { id: 'expert', next: 'elite', toNext: 10 });
  assert.deepEqual(util.tierOf(50), { id: 'analyst', next: 'expert', toNext: 25 });
  assert.deepEqual(util.tierOf(12), { id: 'contender', next: 'analyst', toNext: 38 });
  const stats = { rounds: { '2027_eliteserien_3': { ab: 0.1, n: 8 }, '2027_eliteserien_1': { ab: -0.2, n: 8 },
    '2027_obosligaen_2': { ab: 0.5, n: 8 }, '2026_eliteserien_30': { ab: 0.9, n: 8 } } };
  assert.deepEqual(util.roundForm(stats, 2027, 'eliteserien').map((r) => [r.round, r.ab]), [[1, -0.2], [3, 0.1]]);
  assert.equal(util.roundForm(stats, 2027, 'eliteserien', 1).length, 1);
});

test('the style analysis waits for thirty settled matches', () => {
  const row = { home: 'A', away: 'B', hid: 'a', aid: 'b', pick: [40, 30, 30], model: [0.4, 0.3, 0.3], hg: 1, ag: 0, ko: 1e12, t: 1e12 - 86400000 };
  const out = util.analysePlay([row, row, row]);
  assert.equal(out.ready, false);
  assert.equal(out.missing, 27);
});

test('the style analysis spots an overvalued favourite, a club and too few draws', () => {
  // You give the model's favourite 20 points more than the model; the favourites win only half; you never give draws much.
  const rows = [];
  for (let i = 0; i < 30; i++) {
    const brannHome = i % 2 === 0;
    rows.push({ key: `2027_eliteserien_${i}`, home: brannHome ? 'Brann' : `Club${i}`, away: brannHome ? `Club${i}` : 'Brann',
      hid: brannHome ? 'brann' : `c${i}`, aid: brannHome ? `c${i}` : 'brann',
      pick: brannHome ? [70, 15, 15] : [15, 15, 70], model: brannHome ? [0.5, 0.27, 0.23] : [0.23, 0.27, 0.5],
      hg: i < 15 ? (brannHome ? 2 : 0) : 1, ag: i < 15 ? (brannHome ? 0 : 2) : 1, ko: 1e12, t: 1e12 - 4 * 86400000 });
  }
  const out = util.analysePlay(rows);
  assert.equal(out.ready, true);
  assert.equal(out.traits.favourite, 20);
  assert.equal(out.traits.draw, -12);
  const ids = out.insights.map((x) => x.id);
  assert.ok(ids.includes('fav.over'), ids.join());
  assert.ok(ids.includes('draw.under'), ids.join());
  const club = out.insights.find((x) => x.id === 'team.over');
  assert.equal(club.params.team, 'Brann');
  assert.equal(club.params.d, 20);
  assert.ok(ids.includes('timing.early'));
  assert.equal(out.h2h.wins + out.h2h.losses + out.h2h.ties, 30);
  assert.ok(out.insights[0].strength >= out.insights[out.insights.length - 1].strength);    // strongest first
  assert.ok(out.insights.every((x) => Array.isArray(x.rows)));
});

test('a well-calibrated player gets praise, not a tip', () => {
  const rows = Array.from({ length: 32 }, (_, i) => ({ home: `H${i}`, away: `A${i}`, hid: `h${i}`, aid: `a${i}`,
    pick: [50, 26, 24], model: [0.5, 0.26, 0.24], hg: i < 16 ? 1 : 0, ag: i < 16 ? 0 : (i < 24 ? 0 : 1), ko: null, t: null }));
  const out = util.analysePlay(rows);
  assert.ok(out.insights.some((x) => x.id === 'fav.good' && x.tone === 'praise'));
  assert.ok(!out.insights.some((x) => x.id === 'fav.over' || x.id === 'fav.under'));
});


test('a case-only nickname change is just the spelling: no new claim, no new clock', () => {
  const writes = api.nicknameChangeWrites(local, 'u1', 'ola_1', 'Ola_1');
  assert.equal(writes.length, 1);
  assert.match(writes[0].update.name, /users\/u1$/);
  assert.deepEqual(writes[0].updateMask.fieldPaths, ['nick']);
  assert.equal(writes[0].updateTransforms, undefined);
  const other = api.nicknameChangeWrites(local, 'u1', 'ola_1', 'Kari_2');          // a different name still claims and stamps
  assert.ok(other.length >= 2 && other.some((w) => w.updateTransforms));
});

test('a report is one per reporter and name: the id says so', () => {
  assert.equal(api.reportId('Øyvind_9', 'u1'), '~oyvind_9_u1');
  const write = api.reportWrites(local, 'u1', 'Øyvind_9')[0];
  assert.match(write.update.name, /reports\/~oyvind_9_u1$/);
  assert.equal(write.update.fields.nickLower.stringValue, 'øyvind_9');
});

test('Google asking for a fresh sign-in is its own error', () => {
  assert.equal(api.mapAuthError('CREDENTIAL_TOO_OLD_LOGIN_AGAIN').code, 'reauth');
  assert.equal(api.mapAuthError('INVALID_ID_TOKEN').code, 'bad_credential');
});

test('listing a subcollection follows the page tokens', async () => {
  const pages = [
    { documents: [{ name: 'p/a/entries/u/rounds/r1', fields: { n: { integerValue: '1' } } }], nextPageToken: 'T1' },
    { documents: [{ name: 'p/a/entries/u/rounds/r2', fields: { n: { integerValue: '2' } } }], nextPageToken: 'T2' },
    { documents: [{ name: 'p/a/entries/u/rounds/r3', fields: { n: { integerValue: '3' } } }] },
  ];
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return { ok: true, json: async () => pages[urls.length - 1] }; };
  const client = api.createClient({ config: local, fetchImpl, storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const rows = await client.list('entries/u/rounds', 1);
  assert.deepEqual(rows.map((r) => r.id), ['r1', 'r2', 'r3']);
  assert.match(urls[1], /pageToken=T1/);
  assert.match(urls[2], /pageToken=T2/);
  assert.equal((await api.createClient({ config: local, fetchImpl: async () => ({ ok: true, json: async () => ({ documents: [], nextPageToken: 'X' }) }),
    storage: { getItem: () => null, setItem() {}, removeItem() {} } }).list('a/b', 1, 3)).length, 0);   // a page cap stops a runaway listing
});

test('a draft saves only its open slots: a locked one is dropped, not retried for ever', () => {
  const at = (ms) => new Date(ms);
  const slots = { s1: { kickoff: at(1000) }, s2: { kickoff: at(5000) }, s3: { kickoff: at(9000) } };
  const draft = { s1: { g: 0, k: 10 }, s2: { g: 50, k: 10 }, s9: { g: 1, k: 10 } };
  assert.deepEqual(util.splitDraft(draft, slots, 2000), { open: ['s2'], locked: ['s1', 's9'] });   // s9 is not in the round at all
  assert.deepEqual(util.splitDraft(draft, slots, 100), { open: ['s1', 's2'], locked: ['s9'] });
  assert.deepEqual(util.splitDraft(draft, null, 99999).open, ['s1', 's2', 's9']);                  // fixture not loaded: keep all
  assert.deepEqual(util.splitDraft(undefined, slots, 0), { open: [], locked: [] });
});

test('a reset keeps the session it was asked to keep, and only Predict\'s own keys go', () => {
  const keys = ['predict.session', 'predict.draft.u1.r', 'predict.intro', 'elitetracker-theme', 'lang', 'predict.session.demo-x'];
  assert.deepEqual(util.keysToReset(keys, 'predict.session'), ['predict.draft.u1.r', 'predict.intro', 'predict.session.demo-x']);
  assert.deepEqual(util.keysToReset(keys, null).sort(), ['predict.draft.u1.r', 'predict.intro', 'predict.session', 'predict.session.demo-x']);
  assert.deepEqual(util.draftKeysToMove(['predict.draft.new.2027_x_1', 'predict.draft.u1.2027_x_1', 'predict.intro']), ['predict.draft.new.2027_x_1']);
  assert.equal(api.sessionKey(local), 'predict.session.demo-x');
  assert.equal(util.draftKey(null, 'k'), 'predict.draft.new.k');
});

test('a round with a gap between its matches is in progress, not live', () => {
  const hour = 3_600_000;
  const day = 24 * hour;
  const T = 100 * day;
  // one match played three weeks ago, the others this coming weekend
  const round = { opens: new Date(T - 28 * day), closes: new Date(T - 21 * day), last: new Date(T + 2 * day), n: 3, kicks: [new Date(T - 21 * day), new Date(T + 1 * day), new Date(T + 2 * day)] };
  assert.equal(util.roundStatus(round, T - 10 * day), 'partial');
  assert.equal(util.roundStatus(round, T - 21 * day + hour), 'live');           // the early match is on
  assert.equal(util.roundStatus(round, T + day + hour), 'live');                // a match is on
  assert.equal(util.roundStatus(round, T + day + 5 * hour), 'partial');         // between the two days
  assert.equal(util.roundStatus(round, T + 2 * day + 4 * hour), 'done');
  assert.equal(util.roundStatus({ ...round, kicks: undefined }, T - 10 * day), 'live');   // an older index: as before
  assert.equal(util.currentRoundIndex([{ ...round, last: new Date(T - 21 * day), kicks: [new Date(T - 21 * day)] }, round], T - 10 * day), 1);
});

test('calibration reads the settled picks: three statements a match, each with what happened', () => {
  const rows = [{ pick: [60, 25, 15], hg: 2, ag: 0 }, { pick: [20, 30, 50], hg: 1, ag: 1 }];
  const points = util.calibrationPoints(rows);
  assert.equal(points.length, 6);
  assert.deepEqual(points.slice(0, 3), [{ p: 0.6, hit: 1 }, { p: 0.25, hit: 0 }, { p: 0.15, hit: 0 }]);
  assert.deepEqual(points.slice(3), [{ p: 0.2, hit: 0 }, { p: 0.3, hit: 1 }, { p: 0.5, hit: 0 }]);
  assert.deepEqual(util.calibrationPoints(undefined), []);
});

test('the share you beat is exact for a small field and read off the cut-offs for a big one', () => {
  // three players with accuracy -0.3, 0.1 and 0.4: nearest-rank cut-offs, as the job writes them
  const scores = [-0.3, 0.1, 0.4];
  const pct = Array.from({ length: 101 }, (_, p) => scores[Math.round((p / 100) * 2)]);
  assert.equal(util.beatShare(pct, 0.4, 3), 100);          // above both others
  assert.equal(util.beatShare(pct, 0.1, 3), 50);
  assert.equal(util.beatShare(pct, -0.3, 3), 0);
  assert.equal(util.beatShare(Array(101).fill(0.2), 0.2, 1), 0);
  const even = Array.from({ length: 101 }, (_, i) => -0.5 + i / 100);
  assert.equal(util.beatShare(even, 0, 5000), util.beatShare(even, 0));       // many players: the old reading
});

test('withdrawing a pick is a mask naming the slot over a document that leaves it out', () => {
  const [write] = api.entryWithdrawWrites(local, 'u1', '2027_eliteserien_3', ['s2', 's5']);
  assert.match(write.update.name, /entries\/u1\/rounds\/2027_eliteserien_3$/);
  assert.deepEqual([...write.updateMask.fieldPaths].sort(), ['curve', 'p.s2', 'p.s5', 'r']);
  assert.deepEqual(Object.keys(write.update.fields).sort(), ['curve', 'r']);          // no p: the named slots go
  assert.equal(write.updateTransforms, undefined);
});

test('the page opens on the round with something to tip soonest, not on one with a match put off for weeks', () => {
  const hour = 3_600_000;
  const day = 24 * hour;
  const T = 100 * day;
  const at = (ms) => new Date(ms);
  const round = (opens, kicks) => ({ opens: at(opens), closes: at(kicks[0]), last: at(kicks[kicks.length - 1]), kicks: kicks.map(at), n: kicks.length });
  const five = round(T - 30 * day, [T - 20 * day, T + 25 * day, T + 25 * day + 3 * hour]);   // one match played early, the rest put off to next month
  const six = round(T - 3 * day, [T + 4 * day, T + 4 * day + 3 * hour]);
  const seven = round(T + 2 * day, [T + 11 * day]);
  assert.equal(util.roundStatus(five, T), 'partial');
  assert.equal(util.currentRoundIndex([five, six, seven], T), 1);                               // round 6: its kick-off is days away
  // the remainder of round 5 is this weekend and round 6 next: round 5 still has the picks to make
  const near = round(T - 30 * day, [T - 20 * day, T + 2 * day]);
  assert.equal(util.currentRoundIndex([near, six, seven], T), 0);
  // a match on now counts first
  assert.equal(util.currentRoundIndex([near, six], T + 2 * day + hour), 0);
  assert.equal(util.currentRoundIndex([six, seven], T + 20 * day), 1);                          // round 6 is over: round 7 (open next)
  assert.equal(util.currentRoundIndex([six, seven], T + 30 * day), 1);                          // the season is over: the last round
  // tied: the lower round
  assert.equal(util.currentRoundIndex([round(T - 1 * day, [T + day]), round(T - 1 * day, [T + day])], T), 0);
  // an older index without kick-offs: the first round not over, as before
  const bare = (opens, closes, last) => ({ opens: at(opens), closes: at(closes), last: at(last) });
  assert.equal(util.currentRoundIndex([bare(0, 10 * day, 11 * day), bare(0, 20 * day, 21 * day)], 15 * day), 1);
});

test('drafts saved before an account existed move to it, value and all, including rounds the page never loaded', () => {
  const memory = new Map([['predict.draft.new.2027_x_5', '{"s1":{"g":1,"k":10}}'], ['predict.draft.new.2027_x_6', '{"s2":{"g":2,"k":10}}'],
    ['predict.draft.abc.2027_x_4', 'keep'], ['predict.intro', 'seen']]);
  const store = { keys: () => [...memory.keys()], get: (k) => (memory.has(k) ? memory.get(k) : null), set: (k, v) => memory.set(k, v), remove: (k) => memory.delete(k) };
  util.moveDrafts(store, 'uid9');
  assert.deepEqual([...memory.keys()].sort(), ['predict.draft.abc.2027_x_4', 'predict.draft.uid9.2027_x_5', 'predict.draft.uid9.2027_x_6', 'predict.intro']);
  assert.equal(memory.get('predict.draft.uid9.2027_x_5'), '{"s1":{"g":1,"k":10}}');
  assert.equal(memory.get('predict.draft.uid9.2027_x_6'), '{"s2":{"g":2,"k":10}}');
});

test('the standings document is public like the round index, so a broken session still reads it', async () => {
  const memory = new Map([[api.sessionKey(local), JSON.stringify({ uid: 'u', idToken: 'BROKEN', refreshToken: 'R', expiresAt: 9e15 })]]);
  const storage = { getItem: (k) => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) };
  const fetchImpl = async (url, init) => {
    if (init && init.headers && init.headers.Authorization) return { ok: false, status: 403, json: async () => ({ error: { message: 'PERMISSION_DENIED' } }) };
    return { ok: true, json: async () => ({ fields: { season: { integerValue: '2027' } } }) };
  };
  const client = api.createClient({ config: local, fetchImpl, storage });
  assert.deepEqual(await client.get('meta/standings'), { season: 2027 });
});

test('a long leaderboard shows the top ten, you with five either side, and the model, with gaps between', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ rank: i + 1, kind: i === 24 ? 'model' : 'player' }));
  const out = util.boardWindow(rows, 40, { top: 10, around: 5, always: (row) => row.kind === 'model' });
  const shown = out.filter((x) => x.row).map((x) => x.row.rank);
  assert.deepEqual(shown, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 25, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46]);
  assert.deepEqual(out.filter((x) => x.gap).map((x) => x.gap), [14, 10, 14]);
  // near the top the two parts meet, and a gap of a single row is no gap
  const near = util.boardWindow(rows.slice(0, 30), 15, { top: 10, around: 5 });
  assert.equal(near.filter((x) => x.row).length, 21);
  assert.deepEqual(near.filter((x) => x.gap).map((x) => x.gap), [9]);
  assert.ok(util.boardWindow(rows.slice(0, 12), 11).every((x) => x.row), 'a short board is shown whole');
  // not on the board: the top ten and the rest as one gap
  assert.deepEqual(util.boardWindow(rows, -1).map((x) => x.gap || 'row').slice(-2), ['row', 50]);
});

test('each end of the draw block moves on its own: the other end stays put while the curve allows', () => {
  const start = core.pickPercentages(0, core.DRAW_TENTHS.normal);
  const left = util.positionForEdges(start[0] - 6, start[2], 'a');
  const p = core.pickPercentages(left.gap, left.tenths);
  assert.equal(p[2], start[2], 'the away end held');
  assert.ok(Math.abs(p[0] - (start[0] - 6)) <= 1 && p[1] > start[1], 'the home end moved and the draw grew');
  const right = util.positionForEdges(start[0], start[2] - 8, 'h');
  const q = core.pickPercentages(right.gap, right.tenths);
  assert.equal(q[0], start[0]);
  assert.ok(q[1] > start[1] && q[2] < start[2]);
  // a typed draw makes room on both sides and keeps the split between them
  const typed = util.positionForTyped('d', 34, start);
  const r = core.pickPercentages(typed.gap, typed.tenths);
  assert.ok(Math.abs(r[1] - 34) <= 1 && Math.abs(r[0] - r[2]) <= 1);
  // past what the draw tendency allows, the nearest the curve can do
  const far = util.positionForEdges(5, 5, 'a');
  assert.ok(far.tenths === core.DRAW_TENTHS.max);
});

test('fine-tune on: the ends move a whole percent at a time with no curve, and the pick stays valid', () => {
  const p = [37, 26, 37];
  assert.deepEqual(util.freeEdges(p, 'left', 20.4), [20, 43, 37]);
  assert.deepEqual(util.freeEdges(p, 'right', 70), [37, 33, 30]);
  assert.deepEqual(util.freeEdges(p, 'left', 99), [62, 1, 37], 'the draw never goes under 1');
  assert.deepEqual(util.freeEdges(p, 'right', -5), [37, 1, 62]);
  assert.deepEqual(util.freeEdges(p, 'move', 30), [17, 26, 57], 'the block keeps its width');
  assert.deepEqual(util.freeEdges(p, 'move', 0), [1, 26, 73]);
  assert.deepEqual(util.freeEdges([1, 1, 98], 'left', 0), [1, 1, 98], 'the floor holds at the very end');
  for (const q of [util.freeTyped('h', 80, p), util.freeTyped('a', 0, p), util.freeTyped('d', 50, p), util.freeTyped('h', 99, p)]) {
    assert.equal(q[0] + q[1] + q[2], 100);
    assert.ok(q.every((x) => Number.isInteger(x) && x >= 1 && x <= 98), String(q));
  }
  assert.deepEqual(util.freeTyped('d', 50, p), [25, 50, 25]);
  // the position stored beside free percents is inside the rules' ranges, and a curve pick is not free
  const pos = util.freePosition([90, 8, 2]);
  assert.ok(pos.gap <= core.GAP.max && pos.gap >= core.GAP.min && pos.gap % core.GAP.step === 0);
  assert.ok(pos.tenths >= core.DRAW_TENTHS.min && pos.tenths <= core.DRAW_TENTHS.max);
  const curve = core.pickPercentages(100, 10);
  assert.equal(util.isFreePick({ g: 100, k: 10, h: curve[0], d: curve[1], a: curve[2] }), false);
  assert.equal(util.isFreePick({ g: 100, k: 10, h: 50, d: 10, a: 40 }), true);
});

test('the table game: a dragged club lands by its middle, as many places away as it is dragged', () => {
  const mids = [20, 60, 100, 140, 180, 220];            // rows 40px apart
  assert.equal(util.dropIndex(mids, 0, 20), 0, 'not moved');
  assert.equal(util.dropIndex(mids, 0, 145), 3, 'three places down in one drag');
  assert.equal(util.dropIndex(mids, 5, 15), 0, 'from the bottom to the top');
  assert.equal(util.dropIndex(mids, 2, 1000), 5, 'past the end is last');
  assert.equal(util.dropIndex(mids, 2, 95), 2, 'a nudge stays put');
  assert.equal(util.dropIndex(mids, 2, 55), 1, 'past the middle of the row above: one up');
  assert.deepEqual(util.moveItem(['a', 'b', 'c', 'd', 'e'], 0, 3), ['b', 'c', 'd', 'a', 'e']);
  assert.deepEqual(util.moveItem(['a', 'b', 'c', 'd', 'e'], 4, 0), ['e', 'a', 'b', 'c', 'd']);
  assert.deepEqual(util.moveItem(['a', 'b', 'c'], 1, 9), ['a', 'c', 'b'], 'clamped to the end');
});

test('rank among people leaves the model and the crowd out, and ties share a place', () => {
  const rows = [{ kind: 'crowd', rank: 1 }, { kind: 'model', rank: 2 }, { kind: 'player', rank: 3, u: 'a' },
    { kind: 'player', rank: 4, u: 'b' }, { kind: 'player', rank: 4, u: 'c' }, { kind: 'player', rank: 6, u: 'd' }];
  const place = util.humanRanks(rows);
  assert.equal(place.get(rows[0]), undefined);
  assert.deepEqual(rows.filter((r) => r.kind === 'player').map((r) => place.get(r)), [1, 2, 2, 4]);
  // A board's own place counts hidden players: a hidden second leaves a skipped number, here and in rivalsOf.
  const stored = [{ kind: 'player', rank: 1, place: 1, u: 'a', pts: 9 }, { kind: 'model', rank: 2, pts: 8 }, { kind: 'player', rank: 3, place: 3, u: 'b', pts: 6 }];
  assert.deepEqual(stored.filter((r) => r.kind === 'player').map((r) => util.humanRanks(stored).get(r)), [1, 3]);
  assert.equal(util.rivalsOf(stored, (r) => r.u === 'b', (r) => r.pts).place, 3);
});

test('your neighbours on a board: who is ahead, who is behind, and by how many points', () => {
  const rows = [{ kind: 'model', pts: 90 }, { kind: 'player', u: 'a', pts: 50 }, { kind: 'player', u: 'b', pts: 44 }, { kind: 'player', u: 'c', pts: 40 }];
  const rivals = util.rivalsOf(rows, (r) => r.u === 'b', (r) => r.pts);
  assert.equal(rivals.place, 2);
  assert.equal(rivals.ahead.u, 'a');
  assert.equal(rivals.behind.u, 'c');
  assert.equal(rivals.toAhead, 6);
  assert.equal(rivals.toBehind, 4);
  assert.equal(util.rivalsOf(rows, (r) => r.u === 'z', (r) => r.pts), null);
  const first = util.rivalsOf(rows, (r) => r.u === 'a', (r) => r.pts);
  assert.equal(first.ahead, null);
  assert.equal(first.toAhead, null);
});

test('the standing card: place, tier, the gap to the model and how close the next place is', () => {
  const rows = [{ kind: 'player', u: 'a', pts: 100 }, { kind: 'model', pts: 80 }, { kind: 'player', u: 'b', pts: 90 }, { kind: 'player', u: 'c', pts: 60 }, { kind: 'player', u: 'd', pts: 10 }];
  const pct = Array.from({ length: 101 }, (_, p) => p);                   // 101 players scoring 0..100
  const mine = (id) => (row) => row.u === id;
  const pts = (row) => row.pts;
  const b = util.standingOf(rows, pct, 4, mine('b'), pts);
  assert.equal(b.place, 2);
  assert.equal(b.modelGap, 10, 'ahead of the model by ten points');
  assert.equal(b.toAhead, 10);
  assert.equal(Math.round(b.reach), 90, 'ninety percent of the way to the player ahead');
  const c = util.standingOf(rows, pct, 4, mine('c'), pts);
  assert.equal(c.modelGap, -20, 'behind the model');
  const first = util.standingOf(rows, pct, 4, mine('a'), pts);
  assert.equal(first.reach, 100, 'nobody ahead: the bar is full');
  assert.equal(first.ahead, null);
  assert.equal(util.standingOf(rows, pct, 4, mine('z'), pts), null, 'not on the board: no card');
  // Tier and top share follow the share of players beaten (Elite from 90 %).
  const high = util.standingOf([{ kind: 'player', u: 'x', pts: 95 }], pct, 101, mine('x'), pts);
  assert.equal(high.tier, 'elite');
  assert.equal(high.top, 5);
  assert.equal(util.standingOf([{ kind: 'player', u: 'x', pts: 95 }], [], 101, mine('x'), pts).tier, null, 'no percentile table: no tier');
  assert.equal(util.standingOf(rows, pct, 4, mine('b'), pts).me.u, 'b');
  assert.equal(util.standingOf([{ kind: 'player', u: 'x', pts: 5 }], pct, 101, mine('x'), pts).modelGap, null, 'no model row: no comparison');
});

test('a season in rounds: running accuracy for you and for the model, divisions merged on the round', () => {
  const stats = { rounds: {
    '2025_eliteserien_30': { n: 8, b: 4, vm: 0.4 },
    '2026_eliteserien_1': { n: 8, b: 4, vm: 0.4 },
    '2026_obosligaen_1': { n: 4, b: 2, vm: -0.1 },
    '2026_eliteserien_2': { n: 8, b: 3.2, vm: -0.2 },
    '2026_eliteserien_3': { n: 0, b: 0, vm: 0 },
  } };
  assert.deepEqual(util.statsSeasons(stats), [2026, 2025]);
  const series = util.seasonSeries(stats, 2026);
  assert.deepEqual(series.map((r) => r.round), [1, 2], 'a round with nothing scored is left out');
  assert.equal(series[0].n, 12);
  near(series[0].pts, 10 * (12 - 6));
  near(series[0].vm, 3);
  near(series[0].acc, 100 * (1 - 6 / 12 / 2));
  near(series[0].model, 100 * (1 - (6 + 0.3) / 12 / 2));
  near(series[1].acc, 100 * (1 - 9.2 / 20 / 2));
  assert.deepEqual(util.seasonSeries(stats, 2026, 'obosligaen').map((r) => r.round), [1]);
  assert.deepEqual(util.seasonSeries(null, 2026), []);
  const high = util.seasonHighlights(series);
  assert.equal(high.rounds, 2);
  assert.equal(high.best.round, 1);
  assert.equal(high.beat, 1);
  assert.equal(util.seasonHighlights([]), null);
});

function near(a, b) { assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`); }

test('clubs by the site\'s short names: fixtures, the table game and the standings, nothing else touched', () => {
  const map = { Hamarkameratene: 'HamKam', 'Odds Ballklubb': 'Odd' };
  const kick = new Date('2026-11-28T15:00:00Z');
  const fixture = { round: 5, slots: { s1: { home: 'Hamarkameratene', away: 'Molde', home_id: 'h1', kickoff: kick } } };
  const out = util.shortClubNames(fixture, map);
  assert.equal(out.slots.s1.home, 'HamKam');
  assert.equal(out.slots.s1.away, 'Molde');
  assert.equal(out.slots.s1.kickoff, kick);                      // dates pass through as they are
  assert.equal(fixture.slots.s1.home, 'Hamarkameratene');        // a copy: the document is not changed
  const standings = { obosligaen: { order: ['x'], names: { x: 'Odds Ballklubb', y: 'Lyn' } } };
  assert.deepEqual(util.shortClubNames(standings, map).obosligaen.names, { x: 'Odd', y: 'Lyn' });
  assert.equal(util.shortClubNames({ nick: 'Hamarkameratene' }, map).nick, 'Hamarkameratene');  // only club fields
  assert.equal(util.shortClubNames(null, map), null);
});

/* ---- sessions: a hiccup never signs a player out, and tabs never overwrite each other ---------------- */

const memoryStorage = (seed = {}) => {
  const memory = new Map(Object.entries(seed));
  return { memory, storage: { getItem: (k) => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) } };
};
const sessionJson = (extra = {}) => JSON.stringify({ uid: 'u1', idToken: 'T1', refreshToken: 'R1', expiresAt: 0, ...extra });

test('a failed token refresh ends the session only when the server no longer accepts the token', () => {
  assert.equal(api.refreshFailure(400, 'INVALID_REFRESH_TOKEN').fatal, true);
  assert.equal(api.refreshFailure(400, 'USER_DISABLED').fatal, true);
  assert.equal(api.refreshFailure(400, 'USER_NOT_FOUND').fatal, true);
  assert.equal(api.refreshFailure(400, 'TOKEN_EXPIRED').fatal, true);
  for (const [status, message, code] of [[503, '', 'server'], [429, 'TOO_MANY_ATTEMPTS_TRY_LATER', 'quota'], [500, 'Internal error', 'server']]) {
    const failure = api.refreshFailure(status, message);
    assert.equal(failure.fatal, false);
    assert.equal(failure.error.code, code);
  }
});

test('a refresh that fails on a busy server keeps the session; a refused token clears it', async () => {
  for (const [reply, kept] of [[{ status: 503, error: { message: 'Service Unavailable' } }, true], [{ status: 400, error: { message: 'INVALID_REFRESH_TOKEN' } }, false]]) {
    const { memory, storage } = memoryStorage({ [api.sessionKey(local)]: sessionJson() });
    const fetchImpl = async () => ({ ok: false, status: reply.status, json: async () => ({ error: reply.error }) });
    const client = api.createClient({ config: local, fetchImpl, storage, now: () => 10_000_000, listen: () => {} });
    await assert.rejects(client.get('stats/u1'));
    assert.equal(Boolean(memory.get(api.sessionKey(local))), kept);
    assert.equal(client.uid, kept ? 'u1' : null);
  }
});

test('a network failure during a refresh keeps the session too', async () => {
  const { memory, storage } = memoryStorage({ [api.sessionKey(local)]: sessionJson() });
  const client = api.createClient({ config: local, fetchImpl: async () => { throw new Error('offline'); }, storage, now: () => 10_000_000, listen: () => {} });
  await assert.rejects(client.get('stats/u1'), (error) => error.code === 'offline');
  assert.ok(memory.get(api.sessionKey(local)));
});

test('concurrent calls with an expired token share one refresh', async () => {
  const { storage } = memoryStorage({ [api.sessionKey(local)]: sessionJson() });
  let refreshes = 0;
  const fetchImpl = async (url) => {
    if (url.includes('/v1/token')) { refreshes += 1; await new Promise((r) => setTimeout(r, 5)); return { ok: true, json: async () => ({ id_token: 'T2', refresh_token: 'R2', user_id: 'u1', expires_in: '3600' }) }; }
    return { ok: true, json: async () => ({ fields: {} }) };
  };
  const client = api.createClient({ config: local, fetchImpl, storage, now: () => 10_000_000, listen: () => {} });
  await Promise.all([client.get('stats/u1'), client.get('users/u1'), client.get('entries/u1/rounds/x')]);
  assert.equal(refreshes, 1);
});

test('a tab never writes a stale session over the newer one another tab saved', async () => {
  const key = api.sessionKey(local);
  const { memory, storage } = memoryStorage({ [key]: sessionJson() });
  const changes = [];
  let handler = null;
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => ({ id_token: 'T9', refresh_token: 'R9', user_id: 'u1', expires_in: '3600' }) }; };
  const client = api.createClient({ config: local, fetchImpl, storage, now: () => 10_000_000, onSessionChange: (s) => changes.push(s && s.uid), listen: (fn) => { handler = fn; } });
  // another tab signs in as a Google account and saves its session
  memory.set(key, JSON.stringify({ uid: 'google-1', idToken: 'TG', refreshToken: 'RG', expiresAt: 99_000_000 }));
  handler({ key });
  assert.equal(client.uid, 'google-1');
  assert.deepEqual(changes, ['google-1']);
  // this tab then needs a token: it uses the newer session, not its own stale one, and does not refresh
  await client.get('stats/google-1');
  assert.equal(calls.filter((u) => u.includes('/v1/token')).length, 0);
  assert.equal(JSON.parse(memory.get(key)).uid, 'google-1');
  // another tab signing out is followed too
  memory.delete(key);
  handler({ key });
  assert.equal(client.uid, null);
  handler({ key: 'something.else' });
  assert.equal(client.uid, null);
});

test('saves of one round run in turn, and the later one sees the newer draft', async () => {
  const flights = {};
  const log = [];
  const draft = { v: 1 };
  const slow = (label, ms) => () => new Promise((resolve) => { log.push(`start ${label}:${draft.v}`); setTimeout(() => { log.push(`end ${label}`); resolve(); }, ms); });
  const first = util.inSequence(flights, 'r1', slow('a', 20));
  draft.v = 2;                                                          // moved again while the first commit is on its way
  const second = util.inSequence(flights, 'r1', slow('b', 1));
  const other = util.inSequence(flights, 'r2', slow('c', 1));          // another round is not held up
  await Promise.all([first, second, other]);
  assert.deepEqual(log.filter((l) => l.startsWith('start a') || l.startsWith('start b') || l.startsWith('end a')), ['start a:2', 'end a', 'start b:2']);
  assert.ok(log.indexOf('end a') < log.indexOf('start b:2'));
  assert.deepEqual(flights, {});
  // a failed save does not block the next one
  await assert.rejects(util.inSequence(flights, 'r3', async () => { throw new Error('x'); }));
  assert.equal(await util.inSequence(flights, 'r3', async () => 'ok'), 'ok');
});

test('the season picker offers the launch season and later, never one with no boards', () => {
  assert.deepEqual(util.boardSeasons(2026), [2026]);
  assert.deepEqual(util.boardSeasons(2027), [2027, 2026]);
  assert.deepEqual(util.boardSeasons(2030), [2030, 2029, 2028, 2027]);
  assert.deepEqual(util.boardSeasons(2025), [2025]);       // before the launch there is still the current one
  assert.deepEqual(util.boardSeasons(null), []);
});

test('a round board adds up that round, the last-10 board the last ten scored rounds of the division', () => {
  const index = { rounds: [] };
  for (let n = 1; n <= 14; n += 1) index.rounds.push({ key: `2026_eliteserien_${n}`, league: 'eliteserien', round: n, settled: n <= 12 ? 8 : 0 });
  index.rounds.push({ key: '2026_obosligaen_3', league: 'obosligaen', round: 3, settled: 8 });
  assert.deepEqual(util.scopeKeys(index, { season: 2026, league: 'eliteserien', scope: 'round', round: 5 }), ['2026_eliteserien_5']);
  assert.deepEqual(util.scopeKeys(index, { season: 2026, league: 'eliteserien', scope: 'round' }), []);
  const last = util.scopeKeys(index, { season: 2026, league: 'eliteserien', scope: 'last10' });
  assert.equal(last.length, 10);
  assert.equal(last[0], '2026_eliteserien_3');
  assert.equal(last[9], '2026_eliteserien_12');
  const stats = { rounds: { '2026_eliteserien_12': { n: 2, b: 0.5 }, '2026_eliteserien_11': { n: 1, b: 0.25 }, '2026_eliteserien_1': { n: 9, b: 9 } } };
  assert.deepEqual(util.keysTotals(stats, last), { n: 3, b: 0.75, r: 0, ab: 0, ar: 0, vm: 0, rounds: 2 });
  assert.equal(util.keysTotals(null, last).n, 0);
});

/* The bar's drag (dragBar in predict.js, inside the page's closure, so sliced out of the source with the
   few helpers it reads stubbed). A finger that lands on the bar scrolling or tapping must never move a
   pick, and on a card that has one the block is only held by grabbing it. */
function barHarness({ grabOnly }) {
  const fs = require('node:fs');
  const source = fs.readFileSync(`${__dirname}/../public/predict.js`, 'utf8');
  const start = source.indexOf('function dragBar(');
  const body = source.slice(start, source.indexOf('\n  }\n', start) + 4);
  const factory = new Function('capture', 'gapUnder', 'freePos', 'freeEdges', 'pickPercentages', 'positionForEdges', `${body}; return dragBar;`);
  const dragBar = factory(() => {}, (at) => at, (p) => p, (p) => p, () => [0, 0, 0], () => ({ gap: 0, tenths: 0 }));
  const handlers = {};
  const rect = (left, width) => ({ left, right: left + width, width });
  const seg = { getBoundingClientRect: () => rect(100, 60) };            // the draw block: 100..160
  const bar = { dataset: {}, addEventListener: (type, fn) => { handlers[type] = fn; }, querySelector: () => seg,
    getBoundingClientRect: () => rect(0, 400) };
  const log = { start: 0, moves: [], end: 0 };
  dragBar(bar, { state: () => ({ g: 0, k: 10 }), onMove: (pos) => log.moves.push(pos), onStart: () => { log.start += 1; },
    onEnd: () => { log.end += 1; }, grabOnly: () => grabOnly });
  const ev = (x, y, pointerType = 'touch') => ({ clientX: x, clientY: y, pointerType, pointerId: 1 });
  return { handlers, log, ev };
}

test('a finger on a pick that exists moves it only when it grabbed the draw block and went sideways', () => {
  const miss = barHarness({ grabOnly: true });
  miss.handlers.pointerdown(miss.ev(300, 20));                  // far from the block
  miss.handlers.pointermove(miss.ev(340, 20));
  miss.handlers.pointerup(miss.ev(340, 20));
  assert.equal(miss.log.start, 0);
  assert.equal(miss.log.moves.length, 0, 'a press beside the block does not bring it to the finger');

  const scroll = barHarness({ grabOnly: true });
  scroll.handlers.pointerdown(scroll.ev(130, 20));              // on the block, but the finger scrolls
  scroll.handlers.pointermove(scroll.ev(132, 60));
  scroll.handlers.pointercancel(scroll.ev(132, 60));
  assert.equal(scroll.log.moves.length, 0, 'a vertical scroll over the block moves nothing');

  const tap = barHarness({ grabOnly: true });
  tap.handlers.pointerdown(tap.ev(130, 20));
  tap.handlers.pointerup(tap.ev(130, 20));
  assert.equal(tap.log.moves.length, 0, 'a tap moves nothing');

  const grab = barHarness({ grabOnly: true });
  grab.handlers.pointerdown(grab.ev(130, 20));
  grab.handlers.pointermove(grab.ev(150, 22));
  grab.handlers.pointerup(grab.ev(150, 22));
  assert.equal(grab.log.start, 1);
  assert.ok(grab.log.moves.length >= 1, 'grabbing the block and dragging sideways moves it');
  assert.equal(grab.log.end, 1);

  const slack = barHarness({ grabOnly: true });                 // 5px beside the block (100..160): still held, still no jump
  slack.handlers.pointerdown(slack.ev(165, 20));
  slack.handlers.pointermove(slack.ev(185, 22));
  assert.ok(Math.abs(slack.log.moves[0].g - 150 / 400) < 1e-9, 'the block keeps its distance from the finger');
});

test('on an untouched card a finger makes the first pick only by a sideways drag; a mouse still presses', () => {
  const tap = barHarness({ grabOnly: false });
  tap.handlers.pointerdown(tap.ev(300, 20));
  tap.handlers.pointerup(tap.ev(300, 20));
  assert.equal(tap.log.moves.length, 0);

  const scroll = barHarness({ grabOnly: false });
  scroll.handlers.pointerdown(scroll.ev(300, 20));
  scroll.handlers.pointermove(scroll.ev(302, 70));
  assert.equal(scroll.log.moves.length, 0);

  const drag = barHarness({ grabOnly: false });
  drag.handlers.pointerdown(drag.ev(300, 20));
  drag.handlers.pointermove(drag.ev(320, 22));
  assert.ok(drag.log.moves.length >= 1);

  const mouse = barHarness({ grabOnly: true });
  mouse.handlers.pointerdown(mouse.ev(300, 20, 'mouse'));
  assert.ok(mouse.log.moves.length >= 1, 'a mouse click on the bar still sets the pick');
});
