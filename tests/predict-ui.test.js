/* The browser side of Predict that has no DOM: the Firestore REST builders (public/predict-api.js)
   and the small helpers (public/predict-util.js). The write bodies here are the ones the security
   rules accept (tests/test_firestore_rules.py sends the same shape; the page was also driven against
   the emulator). Run with: node --test tests/predict-ui.test.js */

const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../public/predict-api.js');
const util = require('../public/predict-util.js');

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
  assert.ok(memory.get(api.SESSION_KEY));
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
  assert.equal(util.signed(-0.1234), '-0.12');
  assert.equal(util.signed(0.04), '+0.04');
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

test('the ring, the streak and the badges follow the plan', () => {
  assert.deepEqual(util.ringState(5, 8), { done: 5, total: 8, fraction: 0.625, complete: false });
  assert.equal(util.ringState(8, 8).complete, true);
  assert.deepEqual(util.computeStreak([true, true, true, true, true, false, true]), { current: 6, best: 6, freezes: 0 });
  const earned = (stats) => util.badgesFor(stats).filter((b) => b.earned).map((b) => b.id);
  assert.deepEqual(earned({ tips: 0, totals: { n: 0, vm: 0, ab: 0 }, streak: 0 }), []);
  assert.deepEqual(earned({ tips: 31, totals: { n: 31, vm: 0.4, ab: 0.2 }, streak: 5 }).sort(), ['beatField', 'beatModel', 'first', 'streak5', 'thirty']);
});
