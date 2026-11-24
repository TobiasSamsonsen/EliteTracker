/* Predict's network layer: Firebase Auth and Firestore over REST, with no SDK.
   Everything here is pure or takes its fetch, clock and storage as arguments, so
   tests/predict-ui.test.js runs it in node. The write builders mirror what
   src/elitetracker/sources/firestore.py sends and what firestore.rules checks
   (tests/test_firestore_rules.py is the contract).

   A classic script: load it after predict-core.js; the node tests require it. */

/* predict-core.js's names: globals in the page, a require in node. */
const predictCoreRef = (typeof module !== 'undefined' && typeof require !== 'undefined')
  ? require('./predict-core.js') : { FROZEN_CURVE, nickKey, nickLower };

const PREDICT_KEY = 'AIzaSyAZcmb5tUZFXQoLSNajHJpvIugmQJzKab8';   // the public web key, limited to the site's referrers
const GOOGLE_CLIENT_ID = '914037628709-in1bfopj4gpc1q53etu1qi79vtphhb9a.apps.googleusercontent.com';

/* The live endpoints, or the local emulators: only on localhost and only when
   the address says ?emulator=1 (and &project=demo-... for the emulator's project). */
function predictConfig(where = (typeof location !== 'undefined' ? location : { hostname: '', search: '' })) {
  const params = new URLSearchParams(where.search || '');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(where.hostname);
  if (local && params.get('emulator') === '1') {
    return {
      emulator: true, project: params.get('project') || 'demo-predict-ui', apiKey: 'fake-api-key',
      authBase: 'http://127.0.0.1:9099/identitytoolkit.googleapis.com', tokenBase: 'http://127.0.0.1:9099/securetoken.googleapis.com',
      firestoreBase: 'http://127.0.0.1:8085/v1', googleClientId: GOOGLE_CLIENT_ID,
    };
  }
  return {
    emulator: false, project: 'elitetrackerno', apiKey: PREDICT_KEY, authBase: 'https://identitytoolkit.googleapis.com',
    tokenBase: 'https://securetoken.googleapis.com', firestoreBase: 'https://firestore.googleapis.com/v1',
    googleClientId: GOOGLE_CLIENT_ID,
  };
}

/* ---- Firestore values ------------------------------------------------------ */

const SERVER_TIME = { serverTime: true };

function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === 'string') return { stringValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeValue(v)])) } };
}

function decodeValue(value) {
  const [kind, payload] = Object.entries(value)[0];
  if (kind === 'nullValue') return null;
  if (kind === 'integerValue') return Number(payload);
  if (kind === 'timestampValue') return new Date(payload);
  if (kind === 'arrayValue') return (payload.values || []).map(decodeValue);
  if (kind === 'mapValue') return Object.fromEntries(Object.entries(payload.fields || {}).map(([k, v]) => [k, decodeValue(v)]));
  return payload;
}

function decodeDocument(document) {
  return Object.fromEntries(Object.entries(document.fields || {}).map(([k, v]) => [k, decodeValue(v)]));
}

/* A field path, with backticks around a part that is not a plain identifier. */
function fieldPath(...parts) {
  return parts.map((p) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(p) ? p : `\`${p.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``)).join('.');
}

const documentName = (config, path) => `projects/${config.project}/databases/(default)/documents/${path}`;

/* ---- writes (the same three shapes as sources/firestore.py's Write) ------------- */

function flatten(prefix, data, fields, paths, stamps) {
  for (const [key, value] of Object.entries(data)) {
    const here = prefix.concat(key);
    if (value === SERVER_TIME) {
      stamps.push(fieldPath(...here));
    } else if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && Object.keys(value).length) {
      flatten(here, value, fields, paths, stamps);
    } else {
      paths.push(fieldPath(...here));
      let cursor = fields;
      for (const part of here.slice(0, -1)) {
        cursor[part] = cursor[part] || { mapValue: { fields: {} } };
        cursor = cursor[part].mapValue.fields;
      }
      cursor[here[here.length - 1]] = encodeValue(value);
    }
  }
}

const transforms = (stamps) => stamps.map((path) => ({ fieldPath: path, setToServerValue: 'REQUEST_TIME' }));

/* Replace the document; a top-level SERVER_TIME becomes a transform. */
function writeSet(config, path, data) {
  const stamps = Object.keys(data).filter((k) => data[k] === SERVER_TIME).map((k) => fieldPath(k));
  const plain = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== SERVER_TIME).map(([k, v]) => [k, encodeValue(v)]));
  const write = { update: { name: documentName(config, path), fields: plain } };
  if (stamps.length) write.updateTransforms = transforms(stamps);
  return write;
}

/* Set the given leaf fields, creating the document if it is absent. */
function writeMerge(config, path, data) {
  const fields = {};
  const paths = [];
  const stamps = [];
  flatten([], data, fields, paths, stamps);
  const write = { update: { name: documentName(config, path), fields }, updateMask: { fieldPaths: paths } };
  if (stamps.length) write.updateTransforms = transforms(stamps);
  return write;
}

const writeDelete = (config, path) => ({ delete: documentName(config, path) });

/* ---- what the game writes ---------------------------------------------------------- */

/* One save of a round: only the changed slots, each with a server time (the rules
   demand it). `changed`: { s1: { g, k, h, d, a } }. */
function entryWrites(config, uid, roundKey, changed) {
  const p = {};
  for (const [slot, pick] of Object.entries(changed)) {
    p[slot] = { g: pick.g, k: pick.k, h: pick.h, d: pick.d, a: pick.a, t: SERVER_TIME };
  }
  return [writeMerge(config, `entries/${uid}/rounds/${roundKey}`, { curve: predictCoreRef.FROZEN_CURVE.version, r: roundKey, p })];
}

/* Withdraw picks before kick-off: the update mask names each slot and the document leaves it out
   (the rules allow it while the slot is open, and it scores as a skipped match). */
function entryWithdrawWrites(config, uid, roundKey, slots) {
  return [{ update: { name: documentName(config, `entries/${uid}/rounds/${roundKey}`),
    fields: { r: encodeValue(roundKey), curve: encodeValue(predictCoreRef.FROZEN_CURVE.version) } },
  updateMask: { fieldPaths: ['curve', 'r', ...slots.map((s) => fieldPath('p', s))] } }];
}

/* A new player: the nickname claim and the profile, in one commit. */
function profileCreateWrites(config, uid, { nick, locale = 'nb', club }) {
  const profile = { nick, nickLower: predictCoreRef.nickLower(nick), nickCustom: false, nickAt: SERVER_TIME, locale, hidden: false, created: SERVER_TIME };
  if (club) profile.club = club;
  return [writeSet(config, `nicknames/${predictCoreRef.nickKey(nick)}`, { uid }), writeSet(config, `users/${uid}`, profile)];
}

/* A chosen nickname: claim the new one, release the old one, update the profile. A change of case
   only (ola_1 to Ola_1) keeps the claim and the 30-day clock: just the spelling is updated. */
function nicknameChangeWrites(config, uid, oldNick, newNick) {
  if (oldNick && predictCoreRef.nickLower(oldNick) === predictCoreRef.nickLower(newNick)) {
    return [writeMerge(config, `users/${uid}`, { nick: newNick })];
  }
  const writes = [writeSet(config, `nicknames/${predictCoreRef.nickKey(newNick)}`, { uid }),
    writeMerge(config, `users/${uid}`, { nick: newNick, nickLower: predictCoreRef.nickLower(newNick), nickCustom: true, nickAt: SERVER_TIME })];
  if (oldNick && predictCoreRef.nickKey(oldNick) !== predictCoreRef.nickKey(newNick)) writes.push(writeDelete(config, `nicknames/${predictCoreRef.nickKey(oldNick)}`));
  return writes;
}

/* Other profile fields change freely: { hidden, club, locale, notify }. */
function profileUpdateWrites(config, uid, fields) {
  return [writeMerge(config, `users/${uid}`, fields)];
}

function tableWrites(config, uid, key, order) {
  return [writeMerge(config, `tables/${uid}/picks/${key}`, { order, r: key, t: SERVER_TIME })];
}

/* One report per reporter per name: the id says so, and the rules check it (a second report is an
   update, which they refuse). */
const reportId = (nick, uid) => `${predictCoreRef.nickKey(nick)}_${uid}`;

function reportWrites(config, uid, nick) {
  return [writeSet(config, `reports/${reportId(nick, uid)}`, { nickLower: predictCoreRef.nickLower(nick), by: uid, at: SERVER_TIME })];
}

const LEAGUE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newLeagueCode(random = Math.random) {
  let code = '';
  for (let i = 0; i < 8; i++) code += LEAGUE_CODE_ALPHABET[Math.floor(random() * LEAGUE_CODE_ALPHABET.length)];
  return code;
}

const isLeagueCode = (code) => /^[A-Z2-9]{8}$/.test(code);

function leagueCreateWrites(config, uid, code, name) {
  return [writeSet(config, `leagues/${code}`, { name, owner: uid, created: SERVER_TIME })];
}

function leagueJoinWrites(config, uid, code) {
  return [writeSet(config, `leagues/${code}/members/${uid}`, { joined: SERVER_TIME })];
}

function deleteRequestWrites(config, uid) {
  return [writeSet(config, `deleteRequests/${uid}`, { at: SERVER_TIME })];
}

/* A random document id, as Firestore's own are (20 letters and digits). */
function randomId(random = Math.random) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 20 }, () => chars[Math.floor(random() * chars.length)]).join('');
}

/* ---- errors -------------------------------------------------------------------------- */

class PredictError extends Error {
  constructor(code, message, status = 0) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

/* A failed reply as one of a few codes the page words kindly. */
function mapError(status, body) {
  const message = (body && body.error && (body.error.message || body.error.status)) || '';
  if (status === 401) return new PredictError('auth', message, status);
  if (status === 403) return new PredictError('denied', message, status);
  if (status === 404) return new PredictError('not_found', message, status);
  if (status === 429 || /RESOURCE_EXHAUSTED|QUOTA/i.test(message)) return new PredictError('quota', message, status);
  if (status === 409 || /ALREADY_EXISTS/.test(message)) return new PredictError('conflict', message, status);
  if (status >= 500) return new PredictError('server', message, status);
  return new PredictError('invalid', message, status);
}

/* Identity Toolkit's own messages, for sign-in and linking. */
function mapAuthError(message) {
  const text = String(message || '');
  if (/CREDENTIAL_TOO_OLD_LOGIN_AGAIN|REQUIRES_RECENT_LOGIN/.test(text)) return new PredictError('reauth', text, 400);
  if (/FEDERATED_USER_ID_ALREADY_LINKED|CREDENTIAL_ALREADY_IN_USE|EMAIL_EXISTS/.test(text)) return new PredictError('already_linked', text, 400);
  if (/INVALID_IDP_RESPONSE|INVALID_ID_TOKEN|INVALID_CREDENTIAL|TOKEN_EXPIRED/.test(text)) return new PredictError('bad_credential', text, 400);
  if (/TOO_MANY_ATTEMPTS|QUOTA_EXCEEDED/.test(text)) return new PredictError('quota', text, 429);
  if (/USER_NOT_FOUND|USER_DISABLED|INVALID_REFRESH_TOKEN|TOKEN_EXPIRED/.test(text)) return new PredictError('auth', text, 400);
  return new PredictError('invalid', text, 400);
}

/* The request that links a Google ID token to the signed-in (anonymous) player;
   without `idToken` it would sign in as the Google account instead. */
function googleLinkRequest(config, currentIdToken, googleIdToken, origin) {
  const body = { postBody: `id_token=${encodeURIComponent(googleIdToken)}&providerId=google.com`, requestUri: origin,
    returnSecureToken: true, returnIdpCredential: true };
  if (currentIdToken) body.idToken = currentIdToken;
  return { url: `${config.authBase}/v1/accounts:signInWithIdp?key=${config.apiKey}`, body };
}

/* ---- storage that may not exist -------------------------------------------------------- */

/* localStorage in a try/catch, with a per-visit memory behind it. */
function safeStorage(storage) {
  const memory = new Map();
  const usable = () => { try { return storage || (typeof localStorage !== 'undefined' ? localStorage : null); } catch (error) { return null; } };
  return {
    get(key) {
      try { const store = usable(); const value = store ? store.getItem(key) : null; if (value !== null) return value; } catch (error) { /* fall through */ }
      return memory.has(key) ? memory.get(key) : null;
    },
    set(key, value) {
      memory.set(key, String(value));
      try { const store = usable(); if (store) store.setItem(key, String(value)); } catch (error) { /* kept in memory */ }
    },
    remove(key) {
      memory.delete(key);
      try { const store = usable(); if (store) store.removeItem(key); } catch (error) { /* nothing to do */ }
    },
    keys() {
      try { const store = usable(); if (store) return Object.keys(store); } catch (error) { /* fall through */ }
      return [...memory.keys()];
    },
  };
}

/* ---- the client ---------------------------------------------------------------------------- */

const SESSION_KEY = 'predict.session';
/* The live site keeps the plain key; any other project (the emulator's demo-*) gets its own, so a
   local test session is never sent to the real project, or the other way round. */
const sessionKey = (config) => (config.project === 'elitetrackerno' ? SESSION_KEY : `${SESSION_KEY}.${config.project}`);
/* Documents anyone may read: a rejected token must not hide them. */
const PUBLIC_DOCS = /^(meta\/rounds|meta\/standings|fixtures\/|reveal\/|boards\/|tablegames\/)/;

function createClient({ config, fetchImpl, storage, now = () => Date.now() }) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const store = safeStorage(storage);
  let session = null;
  const SESSION = sessionKey(config);
  try { session = JSON.parse(store.get(SESSION)); } catch (error) { session = null; }
  let offset = 0;                       // the server's clock minus ours, learned from commit times

  const saveSession = (next) => { session = next; if (next) store.set(SESSION, JSON.stringify(next)); else store.remove(SESSION); };

  async function send(method, url, body, headers = {}) {
    let reply;
    try {
      reply = await doFetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) {
      throw new PredictError('offline', String(error && error.message));
    }
    let parsed = null;
    try { parsed = await reply.json(); } catch (error) { parsed = null; }
    if (!reply.ok) throw (url.includes('/v1/accounts') || url.includes('/v1/token')) ? mapAuthError((parsed && parsed.error && parsed.error.message) || '') : mapError(reply.status, parsed);
    return parsed;
  }

  function adopt(reply, extra = {}) {
    const token = reply.idToken || reply.id_token;
    const refresh = reply.refreshToken || reply.refresh_token;
    const uid = reply.localId || reply.user_id || (session && session.uid);
    saveSession({ ...(session || {}), ...extra, uid, idToken: token, refreshToken: refresh,
      expiresAt: now() + (Number(reply.expiresIn || reply.expires_in) || 3600) * 1000 });
    return session;
  }

  async function refresh() {
    if (!session || !session.refreshToken) throw new PredictError('auth', 'no session');
    const reply = await doFetch(`${config.tokenBase}/v1/token?key=${config.apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(session.refreshToken)}`,
    }).catch((error) => { throw new PredictError('offline', String(error && error.message)); });
    const parsed = await reply.json().catch(() => null);
    if (!reply.ok) { saveSession(null); throw mapAuthError(parsed && parsed.error && parsed.error.message); }
    return adopt(parsed);
  }

  async function token() {
    if (!session) return null;
    if (session.expiresAt - now() < 60000) await refresh();
    return session.idToken;
  }

  async function authed(method, path, body) {
    const url = `${config.firestoreBase}/${path}`;
    const bearer = await token();
    const headers = bearer ? { Authorization: `Bearer ${bearer}` } : {};
    try {
      return await send(method, url, body, headers);
    } catch (error) {
      if (error.code === 'auth' && session) {          // an expired token: refresh once and try again
        await refresh();
        return send(method, url, body, { Authorization: `Bearer ${session.idToken}` });
      }
      throw error;
    }
  }

  return {
    config,
    get session() { return session; },
    get uid() { return session ? session.uid : null; },
    serverNow: () => now() + offset,

    /* An anonymous account, created on the first pick. */
    async signUp() {
      const reply = await send('POST', `${config.authBase}/v1/accounts:signUp?key=${config.apiKey}`, { returnSecureToken: true });
      return adopt(reply, { anonymous: true });
    },

    /* A document, decoded; null when it does not exist. */
    async get(path) {
      const name = `projects/${config.project}/databases/(default)/documents/${path}`;
      try {
        return decodeDocument(await authed('GET', name));
      } catch (error) {
        if (error.code === 'not_found') return null;
        // A public document read with a broken session: read it again without the token.
        if (PUBLIC_DOCS.test(path) && (error.code === 'auth' || error.code === 'denied')) {
          try { return decodeDocument(await send('GET', `${config.firestoreBase}/${name}`)); }
          catch (again) { if (again.code === 'not_found') return null; throw again; }
        }
        throw error;
      }
    },

    /* Own subcollection, every page (the rules let a player list only their own); a page cap keeps a
       runaway listing from eating the day's reads. */
    async list(path, pageSize = 100, maxPages = 20) {
      const out = [];
      let token = '';
      for (let page = 0; page < maxPages; page += 1) {
        const query = `pageSize=${pageSize}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
        const reply = await authed('GET', `projects/${config.project}/databases/(default)/documents/${path}?${query}`);
        for (const d of (reply && reply.documents) || []) out.push({ id: d.name.split('/').pop(), data: decodeDocument(d) });
        token = (reply && reply.nextPageToken) || '';
        if (!token) break;
      }
      return out;
    },

    async commit(writes) {
      const reply = await authed('POST', `projects/${config.project}/databases/(default)/documents:commit`, { writes });
      if (reply && reply.commitTime) offset = new Date(reply.commitTime).getTime() - now();
      return reply;
    },

    /* Link a Google ID token to the anonymous account (the uid and picks stay). */
    async linkGoogle(googleIdToken, origin) {
      const { url, body } = googleLinkRequest(config, await token(), googleIdToken, origin);
      const reply = await send('POST', url, body);
      return adopt(reply, { anonymous: false, google: true });
    },

    /* Sign in as the Google account instead (the choice made after a conflict). */
    async signInGoogle(googleIdToken, origin) {
      const { url, body } = googleLinkRequest(config, null, googleIdToken, origin);
      const reply = await send('POST', url, body);
      return adopt(reply, { anonymous: false, google: true });
    },

    async deleteAccount() {
      const bearer = await token();
      await send('POST', `${config.authBase}/v1/accounts:delete?key=${config.apiKey}`, { idToken: bearer });
      saveSession(null);
    },

    signOut() { saveSession(null); },
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    PREDICT_KEY, GOOGLE_CLIENT_ID, predictConfig, SERVER_TIME, encodeValue, decodeValue, decodeDocument, fieldPath, documentName,
    writeSet, writeMerge, writeDelete, entryWrites, entryWithdrawWrites, profileCreateWrites, nicknameChangeWrites, profileUpdateWrites, tableWrites,
    reportWrites, reportId, newLeagueCode, isLeagueCode, leagueCreateWrites, leagueJoinWrites, deleteRequestWrites, randomId, PredictError,
    mapError, mapAuthError, googleLinkRequest, safeStorage, createClient, SESSION_KEY, sessionKey,
  };
}
