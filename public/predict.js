/* Predict: the prediction game's page (/predict/). Plain DOM, no framework.

   Reads stay tiny on purpose (the free Firestore plan counts them): the season's
   round index (one document), a round's fixture and reveal documents by key, your
   own entry, stats and profile, and a board by id. Nothing is ever listed from the
   public collections. predict-api.js is the network layer, predict-core.js the
   curve and scoring (pinned to Python by tests), predict-util.js the small helpers. */
(() => {
  'use strict';

  const config = predictConfig();
  // Another tab signed in, linked Google or signed out: this one starts over as that player (drafts stay in storage).
  const client = createClient({ config, onSessionChange: () => { resetLocal({ keepSession: true }); if (active) boot(); } });
  // Clubs by the names the rest of the site uses (app.js's SHORT_NAMES: HamKam, not Hamarkameratene),
  // applied to every document as it arrives, so the cards, the recap, the table game and the pictures agree.
  const rawGet = client.get.bind(client);
  client.get = async (path) => shortClubNames(await rawGet(path), typeof SHORT_NAMES !== 'undefined' ? SHORT_NAMES : {});
  const store = safeStorage();
  const LEAGUES = ['eliteserien', 'obosligaen'];
  const LEAGUE_NAME = { eliteserien: 'Eliteserien', obosligaen: 'OBOS-ligaen' };
  const SAVE_DELAY = 700;

  const S = {
    tab: 'tip', league: 'eliteserien', scope: 'season', index: null, indexError: null,
    alwaysFine: store.get('predict.fine.always') === 'on',
    roundAt: {}, data: {}, loading: {}, drafts: {}, status: {}, timers: {}, flights: {},
    profile: undefined, stats: undefined, boards: {}, tables: {}, myLeagues: [], note: null, ownHash: null, calibration: null,
  };

  /* ---- small helpers ------------------------------------------------------------ */

  const lang = () => (currentLang === 'en' ? 'en' : 'no');
  // Two numbers, kept apart: the score is *points* (10 x (1 - Brier) a match, summed: predict-core's
  // totalPoints), shown to one decimal with the language's grouping; *accuracy* is the average Brier as a
  // percent (accuracyPercent), to two decimals. Brier itself, and Brier against the model, to three.
  const accText = (value) => signedScore(value, 3);
  const avgText = (value) => fixed(value, 3);
  function ptsText(value, sign = false) {
    const text = fixed(Math.abs(value), 1);
    const [whole, decimals] = text.split('.');
    const lead = Number(text) === 0 ? '' : value < 0 ? '-' : sign ? '+' : '';
    return `${lead}${groupThousands(Number(whole), lang())}.${decimals}`;
  }
  const pctText = (value) => (value === null || value === undefined || !Number.isFinite(value) ? '–' : percentText(value, lang(), 2));
  // A board row's points and accuracy; boards built before points existed have only n and the average Brier.
  const rowPts = (row) => (Number.isFinite(row.pts) ? row.pts : totalPoints(row.n || 0, (row.b || 0) * (row.n || 0)));
  // The model's and the crowd's rows are named here, in the reader's language (the job stores one name).
  const rowName = (row) => (row.kind === 'model' ? t('predict.name.model') : row.kind === 'crowd' ? t('predict.name.crowd') : row.nick || t('predict.anon'));
  const rowAcc = (row) => (Number.isFinite(row.acc) ? row.acc : row.b === null || row.b === undefined ? null : accuracyPercent(1, row.b));
  const now = () => client.serverNow();
  const json = (text, fallback) => { try { const value = JSON.parse(text); return value === null || value === undefined ? fallback : value; } catch (error) { return fallback; } };

  function h(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'on') for (const [name, fn] of Object.entries(value)) node.addEventListener(name, fn);
      else if (key === 'data') for (const [name, v] of Object.entries(value)) node.dataset[name] = v;
      else if (key === 'attrs') for (const [name, v] of Object.entries(value)) node.setAttribute(name, v);
      else node[key] = value;
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) node.append(kid);
    return node;
  }

  const when = (date) => new Intl.DateTimeFormat(lang() === 'no' ? 'nb-NO' : 'en-GB',
    { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);

  const locale = () => (lang() === 'no' ? 'nb-NO' : 'en-GB');
  const clock = (date) => new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(date);
  const dayKey = (date) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Europe/Oslo' }).format(date);
  function dayTitle(date) {
    const text = new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Oslo' }).format(date);
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  function roundDates(first, last) {
    const format = new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', timeZone: 'Europe/Oslo' });
    try { return dayKey(first) === dayKey(last) ? format.format(first) : format.formatRange(first, last); }
    catch (error) { return format.format(first); }
  }

  function spanText(ms) {
    const { unit, n } = spanParts(ms);
    return unit === 'now' ? t('predict.time.now') : t(`predict.time.${unit}`, { n });
  }
  const agoText = (date) => t('predict.ago', { span: spanText(now() - date.getTime()) });
  const inText = (date) => t('predict.in', { span: spanText(date.getTime() - now()) });

  function errorText(error) {
    const key = `predict.err.${error && error.code}`;
    const text = t(key);
    return text === key ? t('predict.err.generic') : text;
  }

  function leagueRounds(league) {
    return ((S.index && S.index.rounds) || []).filter((r) => r.league === league).sort((a, b) => a.round - b.round);
  }

  function currentRound(league) {
    const rounds = leagueRounds(league);
    if (!rounds.length) return null;
    if (S.roundAt[league] === undefined) S.roundAt[league] = currentRoundIndex(rounds, now());
    return rounds[Math.min(S.roundAt[league], rounds.length - 1)];
  }

  const slotKeys = (n) => Array.from({ length: n }, (_, i) => `s${i + 1}`);
  const outcomeLabel = { h: () => t('predict.h'), d: () => t('predict.d'), a: () => t('predict.a') };

  function toast(text, kind = 'info') {
    S.note = { text, kind };
    const box = document.getElementById('predict-note');
    if (box) { box.textContent = text; box.dataset.kind = kind; box.hidden = !text; }
    clearTimeout(S.toastTimer);
    if (kind !== 'error') S.toastTimer = setTimeout(() => { S.note = null; if (box) box.hidden = true; }, 4000);
  }

  /* An inline "are you sure": the button turns into the question with two answers (no window.confirm). */
  function confirmable(label, question, onYes, className = 'pbtn pbtn--danger', aria = null) {
    const wrap = h('span', { class: 'pconfirm' });
    const reset = () => { wrap.replaceChildren(h('button', { type: 'button', class: className, title: aria, attrs: aria ? { 'aria-label': aria } : {}, on: { click: ask } }, label)); };
    const ask = () => {
      wrap.replaceChildren(h('span', { class: 'pconfirm__q', attrs: { role: 'alert' } }, question),
        h('button', { type: 'button', class: className, on: { click: () => { reset(); onYes(); } } }, t('predict.yes')),
        h('button', { type: 'button', class: 'pbtn', on: { click: reset } }, t('predict.cancel')));
    };
    reset();
    return wrap;
  }

  /* ---- loading ------------------------------------------------------------------- */

  async function loadIndex() {
    S.indexError = null;
    try {
      S.index = await client.get('meta/rounds');
      if (!S.index) S.indexError = { code: 'empty' };
      else (S.index.rounds || []).forEach((r) => { r.kicks = r.ks; });          // the page's name for every kick-off of the round
    } catch (error) { S.indexError = error; }
  }

  async function loadProfile() {
    if (!client.uid) { S.profile = null; return; }
    try { S.profile = await client.get(`users/${client.uid}`); } catch (error) { S.profile = null; }
  }

  function loadDraft(key) {
    if (!S.drafts[key]) S.drafts[key] = json(store.get(draftKey(client.uid, key)), {});
    return S.drafts[key];
  }

  function saveDraft(key) {
    const draft = S.drafts[key] || {};
    if (Object.keys(draft).length) store.set(draftKey(client.uid, key), JSON.stringify(draft)); else store.remove(draftKey(client.uid, key));
  }

  /* A round's documents: fixture, your entry, and (once something has kicked off) the reveal. */
  function ensureRound(round, force = false) {
    const key = round.key;
    if (S.loading[key] && !force) return S.loading[key];
    const started = (async () => {
      const entry = { error: null };
      const record = S.data[key] || (S.data[key] = {});
      try {
        const reads = [client.get(`fixtures/${key}`)];
        reads.push(client.uid ? client.get(`entries/${client.uid}/rounds/${key}`) : Promise.resolve(null));
        const wantReveal = roundStatus(round, now()) !== 'open' && roundStatus(round, now()) !== 'future';
        reads.push(wantReveal ? client.get(`reveal/${key}`) : Promise.resolve(null));
        const [fixture, mine, reveal] = await Promise.all(reads);
        Object.assign(record, { fixture, entry: mine, reveal, error: null });
      } catch (error) { entry.error = error; record.error = error; }
      return record;
    })();
    S.loading[key] = started;
    started.finally(() => { delete S.loading[key]; });
    return started;
  }

  /* ---- saving a pick ---------------------------------------------------------------------- */

  /* Drafts made before there was an account sit under the "new" key: they move to the account's. */
  function adoptDrafts() {
    moveDrafts(store, client.uid);
    Object.keys(S.drafts).forEach(saveDraft);
  }

  /* One account at a time: two taps while signed out share the sign-up instead of making two. */
  let accountStart = null;
  function ensureAccount() {
    if (!accountStart) accountStart = makeAccount().finally(() => { accountStart = null; });
    return accountStart;
  }

  async function makeAccount() {
    if (!client.uid) { await client.signUp(); adoptDrafts(); }
    if (S.profile) return;
    await loadProfile();
    if (S.profile) return;
    for (let attempt = 0; attempt < 6; attempt += 1) {                      // a taken name: try another
      const nick = generateNick();
      try {
        await client.commit(profileCreateWrites(config, client.uid, { nick, locale: lang() === 'no' ? 'nb' : 'en' }));
        S.profile = { nick, nickLower: nickLower(nick), nickCustom: false, hidden: false };
        return;
      } catch (error) { if (error.code !== 'denied' || attempt === 5) throw error; }
    }
  }

  function scheduleSave(key) {
    clearTimeout(S.timers[key]);
    S.timers[key] = setTimeout(() => flushSave(key), SAVE_DELAY);
  }

  /* Saves of one round go one after the other: a second tap while the first commit is on its way waits for it
     and then sends whatever the draft holds by then, so an older pick never lands over a newer one. */
  function flushSave(key) {
    clearTimeout(S.timers[key]);
    return inSequence(S.flights, key, () => saveRound(key));
  }

  /* Every draft still waiting (a lost connection, a tab that was in the background) goes now. */
  function flushAll() {
    Object.keys(S.drafts).forEach((key) => { if (Object.keys(S.drafts[key] || {}).length) flushSave(key); });
  }
  window.addEventListener('online', flushAll);

  async function saveRound(key) {
    const draft = S.drafts[key] || {};
    // One commit carries every drafted slot and the rules refuse all of it if one has kicked off, so a
    // slot that locked while it sat in the draft (offline, a tab left open) is dropped, not retried for ever.
    const fixture = (S.data[key] || {}).fixture;
    const { open: slots, locked } = splitDraft(draft, fixture ? fixture.slots : null, now());
    if (locked.length) {
      locked.forEach((slot) => { delete draft[slot]; delete S.status[`${key}/${slot}`]; });
      saveDraft(key);
      toast(t('predict.draft.locked', { n: locked.length }), 'error');
    }
    if (!slots.length) return;
    const changed = {};
    const sent = {};
    for (const slot of slots) {
      const [h1, d1, a1] = percentsOf(draft[slot]);
      changed[slot] = { g: draft[slot].g, k: draft[slot].k, h: h1, d: d1, a: a1 };
      sent[slot] = JSON.stringify(draft[slot]);
    }
    slots.forEach((slot) => setStatus(key, slot, 'saving'));
    try {
      await ensureAccount();
      await client.commit(entryWrites(config, client.uid, key, changed));
      const record = S.data[key] || (S.data[key] = {});
      const entry = record.entry || (record.entry = { curve: 1, r: key, p: {} });
      for (const slot of slots) {
        entry.p[slot] = { ...changed[slot], t: new Date(now()) };
        if (draft[slot] && JSON.stringify(draft[slot]) === sent[slot]) delete draft[slot];      // not moved again while it saved
        setStatus(key, slot, 'saved');
      }
      saveDraft(key);
      store.set('predict.intro', 'seen');
      try { sessionStorage.removeItem('predict.card'); } catch (error) { /* the Overview's card asks again */ }
      if (S.tab === 'tip') paintRing();
    } catch (error) {
      slots.forEach((slot) => setStatus(key, slot, 'error', errorText(error)));
    }
  }

  function setStatus(key, slot, state, message) {
    S.status[`${key}/${slot}`] = { state, message };
    const card = document.querySelector(`.pcard[data-slot="${slot}"][data-round="${key}"]`);
    if (card && card.paintStatus) card.paintStatus();
  }

  /* ---- the slider card ------------------------------------------------------------------------- */

  const EVEN = { g: 0, k: DRAW_TENTHS.normal };
  const storedPercents = (pick) => (Number.isInteger(pick.h) ? [pick.h, pick.d, pick.a] : pickPercentages(pick.g, pick.k));

  function savedPick(record, slot) {
    const saved = record && record.entry && record.entry.p && record.entry.p[slot];
    return saved ? { g: saved.g, k: saved.k, h: saved.h, d: saved.d, a: saved.a, t: saved.t } : null;
  }

  /* A segment keeps its number as long as the number fits: measured against the bar's real
     width, so a 5 % segment on a wide card still shows "5". Before the bar is on the page (no
     width yet) the fallback is the matches view's rule of thumb. */
  function labelFits(percent, width, segment) {
    const text = String(Math.round(percent));
    if (!width) return percent >= 6;
    const digit = parseFloat(getComputedStyle(segment).fontSize) * 0.62 || 9;
    return (percent / 100) * width >= text.length * digit + 8;
  }

  function bar(percents, labelled = true) {
    const node = h('div', { class: 'odds' });
    ['home', 'draw', 'away'].forEach((outcome, i) => {
      const segment = h('div', { class: 'odds__seg', data: { outcome } });
      segment.style.flex = String(Math.max(percents[i], 0.1));
      node.append(segment);
    });
    node.dataset.labelled = String(labelled);
    paintBar(node, percents);
    // Once laid out, the real width decides which numbers fit.
    requestAnimationFrame(() => { if (node.isConnected) paintBar(node, node._percents || percents); });
    return node;
  }

  function paintBar(node, percents) {
    node._percents = percents;
    const labelled = node.dataset.labelled !== 'false' || node._grown;
    const width = node.clientWidth;
    let all = true;
    [...node.children].forEach((segment, i) => {
      segment.style.flex = String(Math.max(percents[i], 0.1));
      const fits = labelled && labelFits(percents[i], width, segment);
      segment.textContent = fits ? String(Math.round(percents[i])) : '';
      if (!fits) all = false;
    });
    return all;                       // every segment shows its number
  }

  /* A club's crest from the site's own logos (by fotmob id); gone quietly when there is none. */
  function crest(id, size = 24) {
    if (!id) return null;
    const img = h('img', { class: 'pcrest', src: `/logos/${id}.webp`, alt: '', width: size, height: size, loading: 'lazy', decoding: 'async' });
    img.style.setProperty('--crest', `${size}px`);
    img.addEventListener('error', () => img.remove());
    return img;
  }

  /* Home on the left, away on the right: the same sides as the blue and red ends of the bar. */
  function matchHead(info, centre, centreClass = 'pmatch__time') {
    return h('div', { class: 'pmatch' },
      h('span', { class: 'pteam pteam--home' }, crest(info.home_id), h('span', { class: 'pteam__name' }, info.home)),
      h('span', { class: centreClass }, centre),
      h('span', { class: 'pteam pteam--away' }, h('span', { class: 'pteam__name' }, info.away), crest(info.away_id)));
  }

  /* Pointer capture keeps a drag going outside the bar; if a browser refuses it, the drag still works. */
  const capture = (node, event) => { try { node.setPointerCapture(event.pointerId); } catch (error) { /* no capture */ } };

  const OUTCOME_SIDE = { home_win: 'home', draw: 'draw', away_win: 'away' };
  const OUTCOME_INDEX = { home_win: 0, draw: 1, away_win: 2 };

  /* The bar is the slider. The middle of the draw block is always at the expected score
     (home + draw / 2), so the gap under a finger is the logit of where the finger is: the draw
     block follows the finger, whatever the draw tendency. */
  function gapUnder(fraction) {
    const e = Math.min(0.995, Math.max(0.005, fraction));   // the far ends of the bar reach the clip
    const gap = Math.round((400 * Math.log10(e / (1 - e))) / GAP.step) * GAP.step;
    return Math.max(GAP.min, Math.min(GAP.max, gap));
  }

  /* A position is { g, k } on the curve, or with fine-tune on { g, k, p }: p the pick's own three
     whole percents (g and k then the nearest curve position, which the rules want and the crowd's
     signal reads: freePosition). */
  const percentsOf = (pos) => (pos.p ? pos.p.slice() : pickPercentages(pos.g, pos.k));
  const freePos = (p) => { const at = freePosition(p); return { g: at.gap, k: at.tenths, p }; };
  const curvePos = (pos) => { if (!pos.p) return pos; const at = positionForEdges(pos.p[0], pos.p[2]); return { g: at.gap, k: at.tenths }; };

  /* The bar as a slider. A finger in the middle of the draw block moves the whole block; a finger on
     either end of it moves that end alone, the other end staying put. On the curve the block's middle
     is the gap (gapUnder) and an end sets the draw tendency (positionForEdges); with fine-tune on
     every part moves a whole percent at a time with no curve to follow (freeEdges). A grab keeps its
     distance from what it took hold of, so nothing jumps when a drag starts. A finger (unlike a mouse)
     waits for a sideways move before it counts, so a scroll or a tap that lands on the bar never moves
     a pick. While `grabOnly()` holds (the match has a pick), a finger also has to start on the draw
     block, or just beside it: a press anywhere else on the bar does nothing, so the block never jumps
     to where a finger came down. */
  function dragBar(oddsBar, { state, onMove, onStart = () => {}, onEnd = () => {}, grabOnly = () => false }) {
    let mode = null;
    let armed = null;
    let offset = 0;
    const drawBox = () => oddsBar.querySelector('[data-outcome="draw"]').getBoundingClientRect();
    const edgeAt = (x, pointerType) => {
      if (!state().p) return 'move';          // the size of the draw block is only set with fine-tune on
      const box = drawBox();
      const zone = Math.min(pointerType === 'mouse' ? 9 : 16, box.width / 3);
      if (Math.abs(x - box.left) <= zone) return 'left';
      if (Math.abs(x - box.right) <= zone) return 'right';
      return 'move';
    };
    const fraction = (x) => { const box = oddsBar.getBoundingClientRect(); return (x - box.left) / box.width; };
    const move = (event) => {
      const pos = state();
      const at = fraction(event.clientX) + offset;
      if (pos.p) { onMove(freePos(freeEdges(pos.p, mode, at * 100))); return; }
      if (mode === 'move') { onMove({ g: gapUnder(at), k: pos.k }); return; }
      const p = pickPercentages(pos.g, pos.k);
      const edge = Math.min(100, Math.max(0, at * 100));
      const next = mode === 'left' ? positionForEdges(edge, p[2], 'a') : positionForEdges(p[0], 100 - edge, 'h');
      onMove({ g: next.gap, k: next.tenths });
    };
    const GRAB_SLACK = 20;                    // px a finger may miss the block by and still hold it
    const begin = (event, x) => {
      mode = edgeAt(x, event.pointerType);
      const box = drawBox();
      const width = oddsBar.getBoundingClientRect().width || 1;
      // A grab within the slack still holds the block where it is (no jump to the finger).
      const slack = grabOnly() && event.pointerType !== 'mouse' ? GRAB_SLACK : 0;
      const inside = x >= box.left - slack && x <= box.right + slack;
      offset = mode === 'left' ? (box.left - x) / width : mode === 'right' ? (box.right - x) / width
        : inside ? ((box.left + box.right) / 2 - x) / width : 0;            // a press beside the block brings it there
      oddsBar.dataset.drag = mode;
      capture(oddsBar, event);
      onStart();
      move(event);
    };
    oddsBar.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') { begin(event, event.clientX); return; }
      if (grabOnly()) {
        const box = drawBox();
        if (event.clientX < box.left - GRAB_SLACK || event.clientX > box.right + GRAB_SLACK) return;
      }
      armed = { x: event.clientX, y: event.clientY };
    });
    oddsBar.addEventListener('pointermove', (event) => {
      if (armed) {
        const dx = Math.abs(event.clientX - armed.x);
        if (dx > 8 && dx > Math.abs(event.clientY - armed.y)) { const x = armed.x; armed = null; begin(event, x); }
        return;
      }
      if (mode) move(event);
      else if (event.pointerType === 'mouse') oddsBar.dataset.hover = edgeAt(event.clientX, 'mouse');
    });
    oddsBar.addEventListener('pointerleave', () => { delete oddsBar.dataset.hover; });
    const stop = () => { armed = null; if (mode) { mode = null; delete oddsBar.dataset.drag; onEnd(); } };
    oddsBar.addEventListener('pointerup', stop);
    oddsBar.addEventListener('pointercancel', stop);
  }

  /* The bar and the two invisible inputs under it, for keyboards and screen readers: where the block
     is and how wide it is. On the curve those are the gap and the draw tendency; with fine-tune on,
     the home percent and the draw percent, a step of 1 each. `onInput` runs on every change,
     `onCommit` when a drag or a key lets go. */
  function pickSlider(info, start, { onInput, onCommit = () => {}, onStart, onEnd, grabOnly } = {}) {
    let pos = start;
    const oddsBar = bar(percentsOf(pos));
    oddsBar.classList.add('pcard__bar');
    oddsBar.setAttribute('aria-hidden', 'true');
    const range = h('input', { type: 'range', class: 'pcard__range', attrs: { 'aria-label': t('predict.slider.label', { home: info.home, away: info.away }) } });
    const drawRange = h('input', { type: 'range', class: 'pcard__range pcard__range--draw' });
    const set = (attrs) => Object.entries(attrs).forEach(([k, v]) => { range[k] = v; });
    const api = {
      control: h('div', { class: 'pslider' }, oddsBar, range, drawRange),
      oddsBar,
      range,
      get pos() { return pos; },
      set pos(next) { pos = next; },
      percents: () => percentsOf(pos),
      setFree(on) { pos = on ? { ...pos, p: percentsOf(pos) } : curvePos(pos); },
      /* Draws the bar and sets the inputs; true when every segment shows its own number. */
      paint() {
        const p = percentsOf(pos);
        const all = paintBar(oddsBar, p);
        const valueText = t('predict.slider.value', { h: p[0], d: p[1], a: p[2] });
        if (pos.p) {
          set({ min: FREE_MIN, max: 100 - FREE_MIN - p[1], step: 1 });
          range.value = p[0];
          Object.assign(drawRange, { min: FREE_MIN, max: FREE_MAX, step: 1 });
          drawRange.value = p[1];
          drawRange.setAttribute('aria-label', t('predict.fine.drawPct'));
          drawRange.setAttribute('aria-valuetext', valueText);
        } else {
          set({ min: GAP.min, max: GAP.max, step: GAP.step });
          range.value = pos.g;
          Object.assign(drawRange, { min: DRAW_TENTHS.min, max: DRAW_TENTHS.max, step: 1 });
          drawRange.value = pos.k;
          drawRange.setAttribute('aria-label', t('predict.fine.label'));
          drawRange.setAttribute('aria-valuetext', `${fixed(pos.k / 10, 1)}× · ${valueText}`);
        }
        drawRange.disabled = !pos.p;            // on the curve the draw block's size is the model's; fine-tune frees it
        range.setAttribute('aria-valuetext', valueText);
        oddsBar.dataset.free = String(Boolean(pos.p));
        return all;
      },
    };
    range.addEventListener('input', () => {
      const v = Number(range.value);
      pos = pos.p ? freePos(freeEdges(pos.p, 'move', v + pos.p[1] / 2)) : { g: v, k: pos.k };
      onInput();
    });
    drawRange.addEventListener('input', () => {
      const v = Number(drawRange.value);
      pos = pos.p ? freePos(freeTyped('d', v, pos.p)) : { g: pos.g, k: v };
      onInput();
    });
    range.addEventListener('change', onCommit);
    drawRange.addEventListener('change', onCommit);
    dragBar(oddsBar, { state: () => pos, onMove: (next) => { pos = next; onInput(); }, onStart,
      onEnd: () => { if (onEnd) onEnd(); onCommit(); }, grabOnly });
    return api;
  }

  /* The fine-tune switch: a pill that is lit while it is on. */
  const fineSwitch = (on, controls, onToggle) => h('button', { type: 'button', class: 'pbtn pbtn--small pfine-toggle',
    attrs: { 'aria-pressed': String(on), ...(controls ? { 'aria-controls': controls } : {}) }, on: { click: onToggle } },
    h('span', { class: 'pfine-toggle__dot', attrs: { 'aria-hidden': 'true' } }), t('predict.fine'));

  /* Your pick in plain words: who you make favourite, and how strongly. */
  function pickReading(p, info) {
    const [home, draw, away] = p;
    if (draw >= home && draw >= away) return t('predict.read.draw', { p: draw });
    const lead = Math.abs(home - away);
    if (lead < 6) return t('predict.read.even');
    const team = home > away ? info.home : info.away;
    const pct = Math.max(home, away);
    return t(`predict.read.${pct >= 60 ? 'strong' : lead >= 15 ? 'fav' : 'slight'}`, { team, p: pct });
  }
  const favouriteOf = (p) => (p[1] >= p[0] && p[1] >= p[2] ? 1 : p[0] >= p[2] ? 0 : 2);

  function buildCard(round, record, slot, info) {
    const key = round.key;
    const kickoff = info.kickoff;
    const locked = isLocked(kickoff, now());
    const saved = savedPick(record, slot);
    const draft = (loadDraft(key)[slot]) || null;
    // A pick made with fine-tune on comes back with it on; an untouched card follows your last choice.
    const savedFree = saved && isFreePick(saved);
    let tipped = Boolean(draft || saved);
    const startPos = draft ? { g: draft.g, k: draft.k, ...(draft.p ? { p: draft.p.slice() } : {}) }
      : saved ? (savedFree ? { g: saved.g, k: saved.k, p: [saved.h, saved.d, saved.a] } : { g: saved.g, k: saved.k })
        : { ...EVEN };
    if (S.alwaysFine && !startPos.p) startPos.p = percentsOf(startPos);          // the setting: every card opens with fine-tune on

    const card = h('li', { class: 'pcard', data: { slot, round: key, state: locked ? 'locked' : tipped ? 'tipped' : 'untouched' } });
    if (locked) {
      const reveal = record && record.reveal && record.reveal.matches && record.reveal.matches[slot];
      const result = reveal && reveal.result;
      card.append(result ? matchHead(info, `${result.hg}–${result.ag}`, 'pmatch__score')
        : matchHead(info, t('predict.live'), 'pmatch__time pmatch__time--live'));
      card.append(...lockedBody(round, record, slot, info, saved));
      return card;
    }
    card.append(matchHead(info, clock(kickoff)));

    // The bar is the control (pickSlider); the inputs under it serve keyboards and screen readers.
    const slider = pickSlider(info, startPos, {
      onInput: () => { touch(); paint(); },
      onCommit: () => release(),
      onStart: () => { card.classList.add('is-dragging'); beginDrag(); },
      onEnd: () => { card.classList.remove('is-dragging'); endDrag(); },
      grabOnly: () => tipped,
    });
    const pct = () => slider.percents();
    let fine = Boolean(slider.pos.p);

    const panelId = `pp-${key}-${slot}`;
    // Back to the model's draw: only on the curve, once an end has been dragged.
    const resetFine = h('button', { type: 'button', class: 'pbtn pbtn--small pcard__reset', on: { click: () => {
      slider.pos = { g: slider.pos.g, k: DRAW_TENTHS.normal };
      fine = false; fineButton.setAttribute('aria-pressed', 'false'); panel.hidden = true; hint.hidden = true;
      touch(); release();
    } } }, t('predict.fine.reset'));
    const inputs = {};
    const readout = h('div', { class: 'pcard__readout' });
    for (const outcome of ['h', 'd', 'a']) {
      const input = h('input', { type: 'text', class: 'pcard__num', value: '', attrs: { inputmode: 'decimal', 'aria-label': t(`predict.readout.${outcome}`) } });
      inputs[outcome] = input;
      readout.append(h('label', { class: `pcard__num-wrap pcard__num-wrap--${outcome}` }, h('span', {}, outcomeLabel[outcome]()), input));
      input.addEventListener('change', () => {
        const typed = parseNumber(input.value);
        if (Number.isNaN(typed)) { paint(); return; }
        if (slider.pos.p) slider.pos = freePos(freeTyped(outcome, typed, slider.pos.p));
        else { const next = positionForTyped(outcome, Math.round(typed), pct()); slider.pos = { g: next.gap, k: next.tenths }; }
        touch(); release();
      });
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
    }
    // The explanation shows on the card where Fine-tune was just switched on, not on all eight: the
    // other cards open with just the three numbers.
    const hint = h('p', { class: 'pcard__hint', hidden: true }, t('predict.fine.hint'));
    const panel = h('div', { class: 'pcard__panel', id: panelId, hidden: !fine }, hint, readout);
    // Fine-tune on: the ends move freely, a percent at a time, and the numbers can be typed. Off: back
    // to the curve's nearest position (a saved pick is saved again, since its numbers move).
    const fineButton = fineSwitch(fine, panelId, () => {
      // Closing and opening the drawer on a free pick only hides and shows it: the pick is not snapped back to
      // the curve (that would quietly save different numbers). "Model's draw" is the way back to the curve.
      if (fine && (panel.hidden || (tipped && slider.pos.p))) {
        panel.hidden = !panel.hidden;
        hint.hidden = panel.hidden;
        fineButton.setAttribute('aria-pressed', String(!panel.hidden));
        return;
      }
      fine = !fine;
      const before = String(pct());
      slider.setFree(fine);
      fineButton.setAttribute('aria-pressed', String(fine));
      panel.hidden = !fine;
      hint.hidden = !fine;
      if (tipped && String(pct()) !== before) { touch(); release(); } else if (tipped) touch();
      paint();
    });
    fineButton.hidden = S.alwaysFine;
    // One line under the bar: your pick in words (with the three numbers when a segment is too narrow
    // to show its own), and the save state as a dot and a word.
    const reading = h('span', { class: 'pcard__read' });
    const saveWord = h('span', { class: 'pcard__save', attrs: { 'aria-live': 'polite' } });
    const status = h('span', { class: 'pcard__status' }, reading, saveWord);
    const clearButton = h('button', { type: 'button', class: 'pbtn pbtn--small pcard__clear', hidden: true, on: { click: () => clearPick() } }, t('predict.clear'));
    // A drag that moved a pick that was already there can be taken back for a few seconds.
    let undoPos = null;
    let undoTimer = 0;
    const undoButton = h('button', { type: 'button', class: 'pbtn pbtn--small pcard__undo', hidden: true, on: { click: () => {
      if (!undoPos) return;
      slider.pos = undoPos;
      hideUndo();
      touch(); release();
    } } }, t('predict.undo'));
    function hideUndo() { clearTimeout(undoTimer); undoPos = null; undoButton.hidden = true; }
    let heldPos = null;
    function beginDrag() { hideUndo(); heldPos = tipped ? { ...slider.pos, ...(slider.pos.p ? { p: slider.pos.p.slice() } : {}) } : null; }
    function endDrag() {
      const was = heldPos;
      heldPos = null;
      if (!was || JSON.stringify(was) === JSON.stringify(slider.pos)) return;
      undoPos = was;
      undoButton.hidden = false;
      undoTimer = setTimeout(hideUndo, 8000);
    }
    card.append(slider.control, h('div', { class: 'pcard__foot' }, status, h('span', { class: 'pcard__acts' }, undoButton, resetFine, clearButton, fineButton)), panel);
    let favourite = favouriteOf(pct());

    function paint() {
      const p = pct();
      const allShown = slider.paint();
      resetFine.hidden = !tipped || (!slider.pos.p && slider.pos.k === DRAW_TENTHS.normal);
      ['h', 'd', 'a'].forEach((o, i) => { if (document.activeElement !== inputs[o]) inputs[o].value = String(p[i]); });
      card.dataset.state = tipped ? 'tipped' : 'untouched';
      const numbers = `${t('predict.h')} ${p[0]} · ${t('predict.d')} ${p[1]} · ${t('predict.a')} ${p[2]}`;
      reading.textContent = !tipped ? t('predict.untipped') : allShown ? pickReading(p, info) : `${pickReading(p, info)} · ${numbers}`;
      clearButton.hidden = !tipped;
      // A tiny tap on a phone when the pick swings to the other side.
      const now_ = favouriteOf(p);
      if (now_ !== favourite) { favourite = now_; if (tipped && navigator.vibrate) navigator.vibrate(8); }
      card.paintStatus();
    }

    card.paintStatus = () => {
      const st = S.status[`${key}/${slot}`] || {};
      const current = savedPick(S.data[key], slot);
      let state = st.state || (tipped ? 'pending' : 'untouched');
      status.title = '';
      if (st.state === 'saving') saveWord.textContent = t('predict.saving');
      else if (st.state === 'error') {
        saveWord.replaceChildren(`${t('predict.notsaved')} ${st.message || ''} `,
          h('button', { type: 'button', class: 'pcard__retry', on: { click: () => flushSave(key) } }, t('predict.retry')));
      }
      else if (!tipped) saveWord.textContent = '';
      else if (current && !((S.drafts[key] || {})[slot])) {
        const at = current.t instanceof Date ? current.t : new Date(now());
        saveWord.textContent = t('predict.saved.now');
        status.title = spanParts(now() - at.getTime()).unit === 'now' ? t('predict.saved.now') : t('predict.saved', { ago: agoText(at) });
        state = 'saved';
      }
      else saveWord.textContent = t('predict.pending');
      status.dataset.state = state;
    };

    function touch() {
      hideUndo();
      tipped = true;
      const pos = slider.pos;
      loadDraft(key)[slot] = { g: pos.g, k: pos.k, ...(pos.p ? { p: pos.p.slice() } : {}) };
      saveDraft(key);
      S.status[`${key}/${slot}`] = { state: 'pending' };
      paintRing();
    }
    function release() { scheduleSave(key); paint(); }

    /* Withdraw the pick: a saved one is removed on the server (the rules allow it until kick-off), a
       draft just goes. The match then counts as skipped, like any match left untouched. */
    async function clearPick() {
      try {
        if (savedPick(S.data[key], slot)) {
          await ensureAccount();
          await client.commit(entryWithdrawWrites(config, client.uid, key, [slot]));
          delete S.data[key].entry.p[slot];
        }
      } catch (error) { toast(errorText(error), 'error'); return; }
      clearTimeout(S.timers[key]);
      delete loadDraft(key)[slot];
      saveDraft(key);
      delete S.status[`${key}/${slot}`];
      if (Object.keys(loadDraft(key)).length) scheduleSave(key);
      tipped = false;
      hideUndo();
      slider.pos = fine ? { ...EVEN, p: pickPercentages(EVEN.g, EVEN.k) } : { ...EVEN };
      paint();
      paintRing();
    }

    // A keyboard user can accept the even 37 / 26 / 37 without nudging the slider away and back.
    slider.range.addEventListener('keydown', (event) => {
      if (!tipped && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); touch(); release(); }
    });

    paint();
    // Once laid out, the bar's real width decides whether the reading needs the numbers too.
    requestAnimationFrame(() => { if (card.isConnected) paint(); });
    return card;
  }

  /* After kick-off: a verdict first, then your odds, the model's and the crowd's with the outcome
     that happened picked out, and the numbers behind it on request. */
  function lockedBody(round, record, slot, info, saved) {
    const parts = [];
    const reveal = record && record.reveal && record.reveal.matches && record.reveal.matches[slot];
    // Scores use the stored whole percents, never the slider position (the curve could change).
    const mine = saved ? storedPercents(saved) : null;
    const result = reveal && reveal.result;
    const hit = result ? outcomeOf(result.hg, result.ag) : null;
    const modelFractions = reveal && reveal.model ? [reveal.model.h, reveal.model.d, reveal.model.a] : null;
    const own = hit && mine && modelFractions ? scoreOwnPick(mine, modelFractions, hit) : null;

    if (own) {
      const kind = own.vsModel > 0.0005 ? 'good' : own.vsModel < -0.0005 ? 'bad' : 'even';
      parts.push(h('div', { class: 'pverdict', data: { kind } },
        h('strong', { class: 'pverdict__chip' }, t(`predict.verdict.${kind}`)),
        h('span', { class: 'pverdict__line' }, t('predict.reveal.gave', { pct: mine[OUTCOME_INDEX[hit]], outcome: t(`predict.outcome.${hit}`) }))));
    } else if (!mine) {
      parts.push(h('p', { class: 'pcard__note' }, t('predict.notip')));
    }

    const rows = [];
    S.revealSeen = S.revealSeen || new Set();
    const seenKey = `${round.key}/${slot}`;
    const grow = Boolean(hit) && !S.revealSeen.has(seenKey) && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const strips = [];
    const row = (label, percents, cls) => {
      const strip = bar(grow ? [33.4, 33.3, 33.3] : percents, !grow);
      if (hit) strip.dataset.hit = OUTCOME_SIDE[hit];
      strips.push([strip, percents]);
      return h('div', { class: `preveal__row ${cls || ''}` }, h('span', { class: 'preveal__who' }, label), strip);
    };
    if (mine) rows.push(row(t('predict.you'), mine, 'preveal__row--you'));
    if (modelFractions) rows.push(row(t('predict.model'), modelFractions.map((x) => x * 100)));
    if (reveal && reveal.crowd) rows.push(row(t('predict.crowd', { n: reveal.crowd.n }), [reveal.crowd.h, reveal.crowd.d, reveal.crowd.a]));
    if (rows.length) {
      const box = h('div', { class: 'preveal' }, rows);
      parts.push(box);
      if (grow) {
        // One reveal moment: the bars open up, one after another, when the card comes into view.
        const observer = new IntersectionObserver((seen) => {
          if (!seen.some((e) => e.isIntersecting)) return;
          observer.disconnect();
          S.revealSeen.add(seenKey);
          strips.forEach(([strip, percents], i) => setTimeout(() => { strip._grown = true; paintBar(strip, percents); }, 120 + i * 160));
        }, { threshold: 0.4 });
        requestAnimationFrame(() => observer.observe(box));
      }
    }
    if (!reveal) parts.push(h('p', { class: 'pcard__note' }, t('predict.wait.update')));
    else if (!reveal.crowd) parts.push(h('p', { class: 'pcard__note' }, t('predict.wait.crowd')));

    if (own) {
      const item = (label, value) => [h('dt', {}, label), h('dd', {}, value)];
      parts.push(h('details', { class: 'pdetails' }, h('summary', {}, t('predict.details')),
        h('dl', {}, item(t('predict.details.pts'), ptsText(matchPoints(own.brier), true)),
          item(t('predict.stats.acc'), pctText(accuracyPercent(1, own.brier))),
          item('Brier', avgText(own.brier)), item(t('predict.details.vs'), ptsText(10 * own.vsModel, true)))));
    }
    return parts;
  }

  /* What you did in a round, once results are in. */
  function recapOf(round, record) {
    const reveal = record && record.reveal && record.reveal.matches;
    const entry = record && record.entry && record.entry.p;
    if (!reveal || !entry) return null;
    let tipped = 0;
    let beat = 0;
    let scored = 0;
    const list = [];
    let brierSum = 0;
    let vmSum = 0;
    let best = null;
    let worst = null;
    for (const [slot, info] of Object.entries(reveal)) {
      if (!entry[slot]) continue;
      tipped += 1;
      if (!info.result || !info.model) continue;
      const own = scoreOwnPick(storedPercents(entry[slot]), [info.model.h, info.model.d, info.model.a], outcomeOf(info.result.hg, info.result.ag));
      scored += 1;
      list.push({ vs: 10 * own.vsModel, kick: record.fixture && record.fixture.slots && record.fixture.slots[slot] ? record.fixture.slots[slot].kickoff.getTime() : 0, slot });
      brierSum += own.brier;
      vmSum += own.vsModel;
      if (own.vsModel > 0) beat += 1;
      if (!best || own.vsModel > best.vs) best = { slot, vs: own.vsModel };
      if (!worst || own.vsModel < worst.vs) worst = { slot, vs: own.vsModel };
    }
    // What the round was worth, worked out here from the same scoring as the job's (scored matches only).
    const total = record.fixture && record.fixture.slots ? Object.keys(record.fixture.slots).length : Object.keys(reveal).length;
    return tipped ? { tipped, scored, beat, best, worst, total, list: list.sort((x, y) => x.kick - y.kick || x.slot.localeCompare(y.slot)),
      points: scored ? totalPoints(scored, brierSum) : null, acc: scored ? accuracyPercent(scored, brierSum) : null, vm: 10 * vmSum } : null;
  }

  /* ---- the tip view ------------------------------------------------------------------------------- */

  function leagueSwitch(onPick) {
    return h('div', { class: 'switch', attrs: { role: 'group', 'aria-label': t('predict.division') } },
      LEAGUES.map((league) => h('button', { type: 'button', data: { league }, attrs: { 'aria-pressed': String(S.league === league) },
        on: { click: () => { S.league = league; store.set('predict.league', league); onPick(); } } }, LEAGUE_NAME[league])));
  }

  function ringNode(done, total) {
    const state = ringState(done, total);
    const circumference = 2 * Math.PI * 15;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('class', 'pring__svg');
    // No arc at all before the first pick: a round cap on an empty arc is a stray dot.
    svg.innerHTML = `<circle class="pring__track" cx="18" cy="18" r="15"/>${state.fraction > 0 ? `<circle class="pring__arc" cx="18" cy="18" r="15" stroke-dasharray="${(circumference * state.fraction).toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 18 18)"/>` : ''}`;
    return h('div', { class: 'pring', data: { complete: String(state.complete) }, attrs: { role: 'img', 'aria-label': t('predict.ring', { done, total }) } },
      svg, h('span', { class: 'pring__text' }, `${done}/${total}`));
  }

  function tippedCount(round) {
    const record = S.data[round.key] || {};
    const slots = Object.keys((record.fixture && record.fixture.slots) || {});
    const draft = S.drafts[round.key] || {};
    return slots.filter((s) => draft[s] || savedPick(record, s)).length;
  }

  function paintRing() {
    const holder = document.getElementById('predict-ring');
    const round = currentRound(S.league);
    if (!holder || !round) return;
    const record = S.data[round.key] || {};
    const done = tippedCount(round);
    const total = Object.keys((record.fixture && record.fixture.slots) || {}).length;
    const ring = ringNode(done, total);
    S.ringWas = S.ringWas || {};
    const complete = total > 0 && done >= total;
    if (complete && S.ringWas[round.key] === false) { ring.classList.add('is-pop'); toast(t('predict.complete', { n: round.round })); }
    S.ringWas[round.key] = complete;
    holder.replaceChildren(ring);
  }

  /* A line in the list of rounds: the round, where it stands, and (once something of yours is scored in it)
     how many of its matches you tipped and what that earned. */
  function roundOptionText(round) {
    const base = `${t('predict.round', { n: round.round })} · ${t(`predict.pstatus.${roundStatus(round, now())}`)}`;
    const mine = S.stats && S.stats.rounds && S.stats.rounds[round.key];
    return mine && mine.n > 0 ? `${base} · ${mine.n}/${round.n} · ${ptsText(totalPoints(mine.n, mine.b), true)} ${t('predict.recap.pts')}` : base;
  }

  /* Your stats arrive after the list is drawn: the lines are filled in when they have. */
  function refreshRoundPick() {
    const pick = document.querySelector('.pnav__pick');
    if (!pick) return;
    const rounds = leagueRounds(S.league);
    [...pick.options].forEach((option, i) => { if (rounds[i]) option.textContent = roundOptionText(rounds[i]); });
  }

  function roundState(round) {
    const status = roundStatus(round, now());
    const text = status === 'future' ? t('predict.status.future', { span: spanText(round.opens.getTime() - now()) })
      : status === 'open' ? t('predict.status.open', { span: spanText(round.closes.getTime() - now()) })
      : status === 'live' ? t('predict.status.live') : status === 'partial' ? t('predict.status.partial') : t('predict.status.done');
    const soon = status === 'open' && round.closes.getTime() - now() < 86400000;
    return { status, text, soon };
  }

  function statusBadge(round) {
    const { status, text, soon } = roundState(round);
    return h('span', { class: 'pbadge', data: { status, soon: String(soon) } }, text);
  }

  /* The same, as a plain line under the round's dates: a phone's bar shows this instead of the badge. */
  function statusLine(round) {
    const { status, text, soon } = roundState(round);
    return h('span', { class: 'pnav__status', data: { status, soon: String(soon) } }, text);
  }

  function renderTip(root) {
    const rounds = leagueRounds(S.league);
    if (S.indexError || !rounds.length) { root.append(leagueSwitch(render), emptyState(S.indexError, loadAndRender, 'predict.empty.rounds')); return; }
    const round = currentRound(S.league);
    const at = rounds.indexOf(round);
    const status = roundStatus(round, now());
    const go = (to) => { S.roundAt[S.league] = to; render(); };
    // One bar that stays in view: the division on the left, the round in the middle (its name opens the
    // list of rounds), and how long it stays open and how much of it you have tipped on the right.
    const nav = h('div', { class: 'pnav' },
      h('div', { class: 'pnav__league' }, leagueSwitch(render)),
      h('div', { class: 'pnav__round' },
        h('button', { type: 'button', class: 'pbtn pbtn--icon', disabled: at <= 0, attrs: { 'aria-label': t('predict.round.prev') }, on: { click: () => go(at - 1) } }, '‹'),
        h('div', { class: 'pnav__titles' },
          h('h3', { class: 'pnav__title' }, t('predict.round', { n: round.round }), h('span', { class: 'pnav__caret', attrs: { 'aria-hidden': 'true' } })),
          h('span', { class: 'pnav__dates' }, roundDates(round.closes, round.last || round.closes)),
          statusLine(round),
          h('select', { class: 'pnav__pick', attrs: { 'aria-label': t('predict.round.pick') }, on: { change: (e) => go(Number(e.target.value)) } },
            rounds.map((r, i) => h('option', { value: String(i), selected: i === at }, roundOptionText(r))))),
        h('button', { type: 'button', class: 'pbtn pbtn--icon', disabled: at >= rounds.length - 1, attrs: { 'aria-label': t('predict.round.next') }, on: { click: () => go(at + 1) } }, '›')),
      h('div', { class: 'pnav__side' }, Object.assign(statusBadge(round), { id: 'predict-badge' }),
        status === 'open' || status === 'live' || status === 'partial' ? h('div', { id: 'predict-ring', class: 'pnav__ring' }) : null));
    root.append(nav);
    // Placeholder cards with the real cards' shape, so nothing jumps when they arrive.
    const skeleton = h('div', { class: 'pround', attrs: { 'aria-busy': 'true', 'aria-label': t('predict.loading') } },
      [0, 1, 2].map(() => h('div', { class: 'pcard pskeleton', attrs: { 'aria-hidden': 'true' } }, h('span'), h('span'), h('span'))));
    root.append(skeleton);
    ensureRound(round).then((record) => {
      if (S.tab !== 'tip' || currentRound(S.league) !== round) return;
      skeleton.replaceWith(roundBody(round, record));
      paintRing();
    });
  }

  function roundBody(round, record) {
    if (record.error && !record.fixture) return emptyState(record.error, () => { ensureRound(round, true).then(render); }, null);
    if (!record.fixture) return h('p', { class: 'pempty' }, t('predict.empty.fixture'));
    const slots = record.fixture.slots;
    const keys = Object.keys(slots).sort((a, b) => slots[a].kickoff - slots[b].kickoff || Number(a.slice(1)) - Number(b.slice(1)));
    const status = roundStatus(round, now());
    const out = h('div', { class: 'pround' });
    // One heading per matchday, the cards under it.
    const byDay = (make) => {
      const days = [];
      for (const k of keys) {
        const day = dayKey(slots[k].kickoff);
        if (!days.length || days[days.length - 1].day !== day) days.push({ day, date: slots[k].kickoff, keys: [] });
        days[days.length - 1].keys.push(k);
      }
      return days.map((d) => h('section', { class: 'pday' }, h('h4', { class: 'pday__title' }, dayTitle(d.date)),
        h('ol', { class: 'plist' }, d.keys.map(make))));
    };
    const recap = recapOf(round, record);
    if (recap) {
      const best = recap.best && recap.best.vs > 0 ? { info: slots[recap.best.slot], vs: recap.best.vs } : null;
      const worst = recap.worst && recap.worst.vs < 0 ? { info: slots[recap.worst.slot], vs: recap.worst.vs } : null;
      const tone = (value) => (value > 0.05 ? 'good' : value < -0.05 ? 'bad' : 'even');
      // The two figures that say how the round went, big; the counts and the calls under them.
      const figure = (value, label, toneOf) => h('div', { class: 'precap__fig', data: { tone: toneOf || 'even' } }, h('strong', {}, value), h('span', {}, label));
      const count = (value, label, toneOf) => h('div', { class: 'precap__count', data: { tone: toneOf || 'even' } }, h('strong', {}, value), h('span', {}, label));
      // A scoreline: home name and crest | – | crest and away name. The dash stands in a column of its own,
      // so it is in the same place on both lines whatever the names.
      const call = (pick, label, kind) => h('div', { class: 'precap__call', data: { kind } },
        h('span', { class: 'precap__calllabel' }, label),
        h('span', { class: 'precap__side precap__side--home' }, h('span', { class: 'precap__name' }, pick.info.home), crest(pick.info.home_id, 20)),
        h('span', { class: 'precap__dash', attrs: { 'aria-hidden': 'true' } }, '–'),
        h('span', { class: 'precap__side precap__side--away' }, crest(pick.info.away_id, 20), h('span', { class: 'precap__name' }, pick.info.away)),
        h('span', { class: 'precap__callvs' }, ptsText(10 * pick.vs, true)));
      out.append(h('section', { class: 'precap', attrs: { 'aria-label': t('predict.recap.title') } },
        h('div', { class: 'precap__head' }, h('h3', {}, t('predict.recap.title')),
          shareButton({ title: () => `${t('predict.title')} · ${t('predict.round', { n: round.round })}`, className: 'precap__share',
            image: () => sharePredictRound(round, recap, best, worst) })),
        recap.scored ? h('div', { class: 'precap__hero' },
          figure(ptsText(recap.points, true), t('predict.recap.pts'), tone(recap.points)),
          figure(pctText(recap.acc), t('predict.recap.acc'))) : null,
        h('div', { class: 'precap__counts' },
          count(`${recap.tipped}/${recap.total}`, t('predict.recap.tipped')),
          recap.scored ? count(`${recap.beat}/${recap.scored}`, t('predict.recap.beat'), recap.beat * 2 > recap.scored ? 'good' : 'even') : null,
          recap.scored ? count(ptsText(recap.vm, true), t('predict.details.vs'), tone(recap.vm)) : null),
        best || worst ? h('div', { class: 'precap__calls' }, best ? call(best, t('predict.recap.bestLabel'), 'good') : null,
          worst ? call(worst, t('predict.recap.worstLabel'), 'bad') : null) : null));
    }
    if (status === 'future') {
      out.append(h('p', { class: 'popens' }, t('predict.opens', { when: when(round.opens) })));
      out.append(h('div', { class: 'pdays' }, ...byDay((k) => h('li', { class: 'pcard pcard--preview' }, matchHead(slots[k], clock(slots[k].kickoff)),
        h('div', { class: 'pghost', attrs: { 'aria-hidden': 'true' } }, h('span'), h('span'), h('span'))))));
    } else {
      out.append(h('div', { class: 'pdays' }, ...byDay((k) => buildCard(round, record, k, slots[k]))));
      // A draft left from an earlier visit (closed tab, lost connection) is saved now, not forgotten.
      if (['open', 'live', 'partial'].includes(status) && Object.keys(loadDraft(round.key)).length) scheduleSave(round.key);
    }
    if (status === 'live' || status === 'partial') {
      out.append(h('p', { class: 'pfoot' }, h('button', { type: 'button', class: 'pbtn pbtn--small', on: { click: () => ensureRound(round, true).then(render) } }, t('predict.refresh'))));
    }
    return out;
  }

  /* The recap as a picture, drawn the way every picture of the site is (share.js: its frame, its type,
     its palette, in the format and theme picked in the share sheet). Two figures lead, big: what the
     round earned and its accuracy. Under them, on one panel: the counts, the round at a glance (one bar
     a match, up when you beat the model, down when you did not, as tall as the difference) and the best
     and the worst call with their crests. A wide picture sets the figures beside the panel, a tall one
     puts the panel under them; every size scales to the room the format leaves. Resolves to a PNG blob. */
  async function sharePredictRound(round, recap, best, worst) {
    const { ctx, canvas } = await shareCanvas();
    const room = shareFrame(ctx, `${t('predict.title')} · ${LEAGUE_NAME[round.league]} · ${t('predict.round', { n: round.round })}`);
    const tall = shareTall();
    const scored = Boolean(recap.scored);
    const tone = (value) => (value < 0 ? SC.badInk : SC.accentInk);
    const picks = [best && { ...best, label: t('predict.recap.bestLabel'), color: SC.accentInk }, worst && { ...worst, label: t('predict.recap.worstLabel'), color: SC.badInk }].filter(Boolean);
    const counts = [[`${recap.tipped}/${recap.total}`, t('predict.recap.tipped'), SC.ink]];
    if (scored) counts.push([`${recap.beat}/${recap.scored}`, t('predict.recap.beat'), recap.beat * 2 > recap.scored ? SC.accentInk : SC.ink], [ptsText(recap.vm, true), t('predict.details.vs'), tone(recap.vm)]);
    const glance = recap.list || [];

    // Sizes at scale 1: a tall picture's are larger. `k` scales them all to the room.
    const m = tall
      ? { pad: 36, countV: 64, countL: 24, gap: 36, cap: 22, bars: 190, row: 104, name: 34, tag: 17, heroV: 170, heroL: 34, accV: 88, label: 22 }
      : { pad: 24, countV: 40, countL: 17, gap: 20, cap: 15, bars: 104, row: 60, name: 24, tag: 13, heroV: 150, heroL: 26, accV: 64, label: 16 };
    let barsExtra = 0;                      // a tall picture with room to spare gives it to the bars
    const panelH = (k) => k * (m.pad * 2 + m.countV + m.countL + 8 + (glance.length ? m.gap + m.cap + 12 + m.bars + barsExtra : 0) + (picks.length ? m.gap + picks.length * m.row : 0));
    const heroH = (k) => k * (m.heroV + m.heroL + 14);
    const labelH = (k) => k * (m.label + 26);
    let k;
    let heroX; let heroW; let panelX; let panelW; let top;
    if (tall) {
      const need = labelH(1) + heroH(1) + 40 + panelH(1);
      k = Math.min(1.3, room.h / need);
      if (glance.length && room.h > need * k) barsExtra = Math.min(300, (room.h - need * k) * 0.55 / k);
      heroX = room.x; heroW = room.w; panelX = room.x; panelW = room.w;
      top = room.y + Math.max(0, (room.h - (labelH(k) + heroH(k) + 40 * k + panelH(k))) / 2);
    } else {
      k = Math.min(1.15, room.h / Math.max(panelH(1), labelH(1) + heroH(1) + m.accV + 60));
      heroW = room.w * 0.42; heroX = room.x; panelW = room.w - heroW - 48; panelX = room.x + heroW + 48;
      top = room.y + Math.max(0, (room.h - panelH(k)) / 2);
    }

    // The figures.
    const caption = (text, x, y, size, align = 'left') => paintText(ctx, text, x, y, { size, weight: 700, color: SC.muted, label: true, align });
    let y = top;
    caption(t('predict.recap.title'), heroX, y + m.label * k, m.label * k);
    y += labelH(k) - 4 * k;
    const bigPoints = scored ? ptsText(recap.points, true) : `${recap.tipped}/${recap.total}`;
    const bigLabel = scored ? t('predict.recap.pts') : t('predict.recap.tipped');
    const heroColor = scored ? tone(recap.points) : SC.ink;
    if (tall) {
      const pointsW = scored ? heroW * 0.56 : heroW;
      paintText(ctx, bigPoints, heroX, y + m.heroV * k * 0.82, { size: m.heroV * k, weight: 800, wide: true, color: heroColor, maxWidth: pointsW, fit: true });
      paintText(ctx, bigLabel, heroX, y + (m.heroV * 0.82 + m.heroL + 10) * k, { size: m.heroL * k, weight: 600, color: SC.muted });
      if (scored) {
        const accX = heroX + heroW;
        paintText(ctx, pctText(recap.acc), accX, y + m.heroV * k * 0.82, { size: m.accV * k, weight: 800, wide: true, align: 'right', maxWidth: heroW * 0.4, fit: true });
        paintText(ctx, t('predict.recap.acc'), accX, y + (m.heroV * 0.82 + m.heroL + 10) * k, { size: m.heroL * k, weight: 600, color: SC.muted, align: 'right' });
      }
      y += heroH(k) + 40 * k;
    } else {
      paintText(ctx, bigPoints, heroX, y + m.heroV * k * 0.8, { size: m.heroV * k, weight: 800, wide: true, color: heroColor, maxWidth: heroW, fit: true });
      let ay = y + m.heroV * k * 0.8 + m.heroL * k + 12 * k;
      paintText(ctx, bigLabel, heroX, ay, { size: m.heroL * k, weight: 600, color: SC.muted });
      if (scored) {
        ay += m.accV * k + 26 * k;
        paintText(ctx, pctText(recap.acc), heroX, ay, { size: m.accV * k, weight: 800, wide: true, maxWidth: heroW, fit: true });
        paintText(ctx, t('predict.recap.acc'), heroX, ay + m.heroL * k + 8 * k, { size: m.heroL * k, weight: 600, color: SC.muted });
      }
      y = top;
    }

    // The panel.
    const ph = panelH(k);
    const pad = m.pad * k;
    const inner = panelW - pad * 2;
    shareRect(ctx, panelX, y, panelW, ph, 20 * k, SC.panel);
    let py = y + pad;
    const colW = inner / counts.length;
    counts.forEach(([value, label, color], i) => {
      paintText(ctx, value, panelX + pad + i * colW, py + m.countV * k * 0.82, { size: m.countV * k, weight: 800, wide: true, color, maxWidth: colW - 12 * k, fit: true });
      paintText(ctx, label, panelX + pad + i * colW, py + (m.countV + m.countL) * k + 4 * k, { size: m.countL * k, weight: 600, color: SC.muted, maxWidth: colW - 12 * k, fit: true });
    });
    py += (m.countV + m.countL + 8) * k;

    if (glance.length) {
      py += m.gap * k;
      caption(t('predict.recap.perMatch'), panelX + pad, py + m.cap * k * 0.8, m.cap * k);
      py += (m.cap + 12) * k;
      const area = (m.bars + barsExtra) * k;
      const mid = py + area / 2;
      const scale = Math.max(3, ...glance.map((g) => Math.abs(g.vs)));
      const count = glance.length;
      const bw = Math.min(58 * k, inner / (count * 1.4 - 0.4));
      const step = bw * 1.4;
      const x0 = panelX + pad + (inner - (count * step - bw * 0.4)) / 2;
      ctx.fillStyle = SC.rule;
      ctx.fillRect(panelX + pad, mid - 1 * k, inner, 2 * k);
      glance.forEach((g, i) => {
        const height = Math.max(5 * k, (Math.abs(g.vs) / scale) * (area / 2 - 3 * k));
        shareRect(ctx, x0 + i * step, g.vs >= 0 ? mid - height : mid + 1 * k, bw, height, Math.min(6 * k, bw / 3), g.vs >= 0 ? SC.accent : SC.bad);
      });
      py += area;
    }

    if (picks.length) {
      py += m.gap * k;
      for (const pick of picks) {
        // The label above, the match under it with its crests, the points against the model at the end.
        const rowTop = py;
        const size = m.name * k;
        const crest = size * 1.25;
        paintText(ctx, pick.label, panelX + pad, rowTop + m.tag * k * 0.9, { size: m.tag * k, weight: 700, color: SC.muted, label: true });
        const lineMid = rowTop + (m.tag + 10) * k + crest / 2;
        const valueW = paintText(ctx, ptsText(10 * pick.vs, true), panelX + pad + inner, lineMid + size * 0.35, { size, weight: 800, color: pick.color, align: 'right' });
        let x = panelX + pad;
        await shareDrawCrest(ctx, pick.info.home_id, pick.info.home, x, lineMid - crest / 2, crest);
        x += crest + size * 0.3;
        const free = inner - valueW - crest * 2 - size * 1.2;
        x += paintText(ctx, `${pick.info.home} – ${pick.info.away}`, x, lineMid + size * 0.35, { size, weight: 700, maxWidth: Math.max(60, free) }) + size * 0.3;
        await shareDrawCrest(ctx, pick.info.away_id, pick.info.away, x, lineMid - crest / 2, crest);
        py += m.row * k;
      }
    }
    return shareBlob(canvas);
  }

  function emptyState(error, retry, emptyKey) {
    const box = h('div', { class: 'pempty', attrs: { role: 'status' } });
    const code = error && error.code;
    // Nothing there is an invitation; a failed read says so and offers a retry. Only the network,
    // the quota and the server have their own words; anything else on a read is "could not load".
    const text = !code || code === 'empty' ? t(emptyKey || 'predict.empty.generic')
      : ['offline', 'quota', 'server'].includes(code) ? errorText(error) : t('predict.err.load');
    box.append(h('p', {}, text));
    if (retry) box.append(h('button', { type: 'button', class: 'pbtn', on: { click: retry } }, t('predict.retry')));
    return box;
  }

  /* ---- the table game --------------------------------------------------------------------------------- */

  async function renderTable(root) {
    root.append(h('p', { class: 'pintro' }, t('predict.table.intro')));
    root.append(leagueSwitch(render));
    const season = S.index && S.index.season;
    const key = `${season}_${S.league}`;
    // The game and your pick, once read, stay for the visit (your pick is kept up to date when you
    // save): a switch of tab or division draws at once instead of emptying to "loading".
    const known = S.tables[key];
    const body = h('div', {}, known ? tableBody(key, known.game, known.mine, known.extras, season) : h('p', { class: 'pload' }, t('predict.loading')));
    root.append(body);
    if (!season) { body.replaceChildren(emptyState(S.indexError, loadAndRender, 'predict.empty.rounds')); return; }
    if (known) return;
    try {
      const game = await client.get(`tablegames/${key}`);
      const mine = client.uid ? await client.get(`tables/${client.uid}/picks/${key}`) : null;
      const extras = {};
      if (!game) { try { extras.standings = await client.get('meta/standings'); } catch (error) { extras.standings = null; } }
      if (game && now() >= game.closes.getTime()) {
        // Once it has closed: the final result if the season is over, otherwise the table as it stands.
        // (each read on its own: if one fails the panel it feeds is left out, not the whole tab)
        try { extras.board = await client.get(`boards/tables_${key}`); } catch (error) { extras.board = null; }
        if (!extras.board) { try { extras.standings = await client.get('meta/standings'); } catch (error) { extras.standings = null; } }
        if (client.uid && S.stats === undefined) { try { S.stats = await client.get(`stats/${client.uid}`); } catch (error) { S.stats = null; } }
      }
      S.tables[key] = { game, mine, extras };
      if (S.tab !== 'table' || !body.isConnected) return;
      body.replaceChildren(tableBody(key, game, mine, extras, season));
    } catch (error) { body.replaceChildren(emptyState(error, render)); }
  }

  /* The scored result of the table game: your error and accuracy, and the board (the model stands on it too). */
  function tableResults(key, board) {
    const own = S.stats && S.stats.tables && S.stats.tables[key];
    const rows = (board.rows || []).map((row) => h('tr', { class: 'pboard__row', data: { kind: row.kind, mine: String(Boolean(S.ownHash && row.u === S.ownHash)) } },
      h('td', { class: 'pboard__rank' }, String(row.rank)), h('td', { class: 'pboard__name' }, h('span', { class: 'pboard__nick' }, rowName(row))),
      h('td', {}, String(row.error)), h('td', { class: 'pboard__ab', data: { tone: row.accuracy > 0.00005 ? 'good' : row.accuracy < -0.00005 ? 'bad' : 'even' } }, accText(row.accuracy))));
    return h('section', { class: 'ptable__results' }, h('h3', {}, t('predict.table.result.title')),
      own ? h('p', { class: 'pboard__me' }, t('predict.table.result.you', { error: own.error, acc: accText(own.accuracy) })) : h('p', { class: 'pmuted' }, t('predict.table.result.none')),
      h('div', { class: 'pboard' }, h('div', { class: 'pscroll' }, h('table', {},
        h('thead', {}, h('tr', {}, ['rank', 'name'].map((c) => h('th', { scope: 'col', class: `pboard__${c}` }, t(`predict.col.${c}`))),
          h('th', { scope: 'col' }, t('predict.table.col.error')), h('th', { scope: 'col' }, t('predict.table.col.acc')))),
        h('tbody', {}, rows))),
      h('p', { class: 'pboard__note' }, t('predict.table.result.note', { players: groupThousands(board.players || 0, lang()) }))));
  }

  /* Club names the page already knows (from the rounds it has read), for a table that carries only ids. */
  function knownClubNames() {
    const names = new Map();
    Object.values(S.data).forEach((record) => Object.values((record.fixture && record.fixture.slots) || {}).forEach((m) => { names.set(m.home_id, m.home); names.set(m.away_id, m.away); }));
    return names;
  }

  /* The table game is not open (the season is under way, or the next one is not set yet): when it opens,
     and the table as it stands with the places that count for the bonuses marked, so the game is no mystery. */
  function tableClosedBody(standings, rules, zoneOf) {
    const parts = [h('p', { class: 'pempty' }, t('predict.table.none.text'))];
    const league = standings && standings.leagues && standings.leagues[S.league];
    if (league && league.order && league.order.length) {
      const names = league.names || {};
      const known = knownClubNames();
      parts.push(h('section', { class: 'ptable__checkpoint' }, h('h3', {}, t('predict.table.preview.title')),
        h('p', { class: 'pmuted' }, t('predict.table.preview.played', { n: league.played })),
        h('ol', { class: 'ptable ptable--now' }, league.order.map((id, i) => h('li', { class: 'ptable__row', data: { id, zone: zoneOf(i, league.order.length) } },
          h('span', { class: 'ptable__pos' }, String(i + 1)), h('span', { class: 'ptable__name' }, crest(id, 22), h('span', {}, names[id] || known.get(id) || ''))))),
        ));
    }
    parts.push(rules);
    return h('div', {}, ...parts);
  }

  /* Mid-season: your order against the table as it stands, place by place. */
  function tableCheckpoint(order, game, standings) {
    const league = standings && standings.leagues && standings.leagues[S.league];
    if (!league || league.order.length !== order.length || !league.order.every((id) => order.includes(id))) return null;
    const dist = footrule(order, league.order);
    const items = order.map((id, i) => {
      const now_ = league.order.indexOf(id);
      const diff = now_ - i;
      return h('li', { class: 'ptable__row', data: { id } },
        h('span', { class: 'ptable__pos' }, String(i + 1)), h('span', { class: 'ptable__name' }, crest(id, 22), h('span', {}, game.names[id])),
        h('span', { class: 'ptable__now', data: { tone: diff === 0 ? 'good' : 'even' }, attrs: { 'aria-label': t('predict.table.now.aria', { club: game.names[id], place: now_ + 1 }) } },
          diff === 0 ? `= ${now_ + 1}` : `${diff > 0 ? '↓' : '↑'} ${now_ + 1}`));
    });
    return h('section', { class: 'ptable__checkpoint' }, h('h3', {}, t('predict.table.now.title')),
      h('p', { class: 'pmuted' }, t('predict.table.now.text', { n: league.played, d: dist })), h('ol', { class: 'ptable ptable--now' }, items));
  }

  function tableBody(key, game, mine, extras = {}, season) {
    const bonus = TABLE_BONUS[S.league];
    const rules = h('p', { class: 'ptable__rules' }, t(S.league === 'eliteserien' ? 'predict.table.rules.es' : 'predict.table.rules.obos', { champion: bonus.champion, promotion: bonus.promotion, relegation: bonus.relegation }));
    const zoneOf = (i, n) => (S.league === 'eliteserien' ? (i === 0 ? 'champion' : i >= n - 2 ? 'relegation' : '')
      : (i < 2 ? 'promotion' : i >= n - 2 ? 'relegation' : ''));
    if (!game) return tableClosedBody(extras.standings, rules, zoneOf);
    const nowMs = now();
    const state = nowMs < game.opens.getTime() ? 'soon' : nowMs >= game.closes.getTime() ? 'closed' : 'open';
    const validOrder = (list) => Array.isArray(list) && list.length === game.clubs.length && game.clubs.every((id) => list.includes(id));
    const draftId = `predict.tabledraft.${client.uid || 'new'}.${key}`;
    const alphabetical = () => game.clubs.slice().sort((a, b) => game.names[a].localeCompare(game.names[b], 'nb'));
    const draft = state === 'open' ? json(store.get(draftId), null) : null;
    let order = mine && validOrder(mine.order) ? mine.order.slice() : validOrder(draft) ? draft : alphabetical();
    let saved = Boolean(mine) && !(validOrder(draft) && draft.join() !== (mine && mine.order ? mine.order.join() : ''));
    if (state === 'closed') {
      const parts = [];
      if (extras.board) parts.push(tableResults(key, extras.board));
      if (!mine || !validOrder(mine.order)) parts.push(h('p', { class: 'pempty' }, t('predict.table.notentered')));
      else {
        parts.push(h('p', { class: 'ptable__status' }, t('predict.table.yoursaved')));
        const frozen = h('ol', { class: 'ptable', data: { state } }, order.map((id, i) => h('li', { class: 'ptable__row', data: { id, zone: zoneOf(i, order.length) } },
          h('span', { class: 'ptable__pos' }, String(i + 1)), h('span', { class: 'ptable__name' }, crest(id, 22), h('span', {}, game.names[id])))));
        parts.push(frozen);
        const checkpoint = !extras.board && extras.standings ? tableCheckpoint(order, game, extras.standings) : null;
        if (checkpoint) parts.push(checkpoint);
      }
      parts.push(rules);
      return h('div', {}, ...parts);
    }
    const list = h('ol', { class: 'ptable', data: { state } });
    const status = h('p', { class: 'ptable__status', attrs: { 'aria-live': 'polite' } });
    const announce = h('p', { class: 'visually-hidden', attrs: { 'aria-live': 'assertive' } });
    const open = state === 'open';
    const keep = () => { if (open) { try { store.set(draftId, JSON.stringify(order)); } catch (error) { /* a convenience only */ } } };
    let saveState = saved ? 'saved' : validOrder(draft) ? 'pending' : 'idle';
    let saveError = '';
    const paintStatus = () => {
      const left = spanText(game.closes.getTime() - now());
      status.dataset.state = state === 'soon' ? 'idle' : saveState;
      if (state === 'soon') status.textContent = t('predict.table.soon', { span: spanText(game.opens.getTime() - now()) });
      else if (saveState === 'saving' || saveState === 'pending') status.textContent = t('predict.saving');
      else if (saveState === 'error') {
        status.replaceChildren(`${t('predict.notsaved')} ${saveError} `,
          h('button', { type: 'button', class: 'pcard__retry', on: { click: () => saveOrder() } }, t('predict.retry')));
      } else status.textContent = saveState === 'saved' ? t('predict.table.savedLeft', { span: left }) : t('predict.table.start', { span: left });
    };
    const label = (id, i) => t('predict.table.drag', { club: game.names[id], place: i + 1, n: order.length });
    const paint = () => {
      list.replaceChildren(...order.map((id, i) => {
        const row = h('li', { class: 'ptable__row', data: { id, zone: zoneOf(i, order.length) } },
          h('span', { class: 'ptable__pos' }, String(i + 1)), h('span', { class: 'ptable__name' }, crest(id, 22), h('span', {}, game.names[id])));
        if (open) {
          const handle = h('button', { type: 'button', class: 'ptable__grip', attrs: { 'aria-label': label(id, i) } },
            h('span', { attrs: { 'aria-hidden': 'true' } }));
          handle.addEventListener('keydown', (event) => keyMove(event, id));
          row.append(handle);
          sortable(row);
        }
        return row;
      }));
      paintStatus();
    };

    /* Saving: like a match tip, the order saves itself a moment after a move; the draft in the
       browser holds it until the save is in. */
    let saveTimer = null;
    const scheduleOrderSave = () => { clearTimeout(saveTimer); saveState = 'pending'; paintStatus(); saveTimer = setTimeout(saveOrder, SAVE_DELAY); };
    async function saveOrder() {
      clearTimeout(saveTimer);
      if (!open || now() >= game.closes.getTime()) return;
      const sent = order.slice();
      saveState = 'saving'; paintStatus();
      try {
        await ensureAccount();
        await client.commit(tableWrites(config, client.uid, key, sent));
        if (S.tables[key]) S.tables[key].mine = { ...(S.tables[key].mine || {}), order: sent };
        if (sent.join() === order.join()) {
          saveState = 'saved';
          store.remove(draftId); store.remove(`predict.tabledraft.new.${key}`);
        }
      } catch (error) { saveState = 'error'; saveError = errorText(error); }
      if (list.isConnected) paintStatus();
    }
    const moved = (from, to) => {
      if (from === to) return;
      order = moveItem(order, from, to);
      keep();
      scheduleOrderSave();
    };

    /* The keyboard: on a club's handle the arrow keys move it a place, Page Up and Down five, Home and
       End to the top or the bottom; the focus stays with the club and its new place is read out. */
    function keyMove(event, id) {
      const from = order.indexOf(id);
      const to = { ArrowUp: from - 1, ArrowDown: from + 1, PageUp: from - 5, PageDown: from + 5, Home: 0, End: order.length - 1 }[event.key];
      if (to === undefined) return;
      event.preventDefault();
      const at = Math.max(0, Math.min(order.length - 1, to));
      moved(from, at);
      paint();
      const grip = list.children[at] && list.children[at].querySelector('.ptable__grip');
      if (grip) grip.focus();
      announce.textContent = t('predict.table.moved', { club: game.names[id], place: at + 1 });
    }

    /* Dragging: a club moves in its own lane, up or down only, as far as it is taken; the others slide
       aside, and the numbers and zones show where everything lands. A mouse drags a row from anywhere
       on it; a finger from the handle at once, or from the rest of the row after a short hold (so a
       swipe there still scrolls the page). Near the top or the bottom of the screen the page scrolls
       along. */
    let drag = null;
    list.addEventListener('touchmove', (event) => { if (drag) event.preventDefault(); }, { passive: false });
    list.addEventListener('contextmenu', (event) => { if (drag || event.target.closest('.ptable__row')) event.preventDefault(); });
    function sortable(row) {
      let press = null;
      row.addEventListener('pointerdown', (event) => {
        if (drag || (event.pointerType === 'mouse' && event.button !== 0)) return;
        const onGrip = Boolean(event.target.closest('.ptable__grip'));
        press = { x: event.clientX, y: event.clientY, id: event.pointerId, timer: null };
        if (event.pointerType !== 'mouse' && !onGrip) {
          press.timer = setTimeout(() => { if (press) { const p = press; press = null; begin(row, event, p.y); } }, 280);
        } else {
          press.direct = true;
          capture(row, event);          // the moves come here even when the first one is already over another row
        }
      });
      row.addEventListener('pointermove', (event) => {
        if (!press || event.pointerId !== press.id) return;
        const dx = event.clientX - press.x;
        const dy = event.clientY - press.y;
        if (press.direct && Math.hypot(dx, dy) > 3) { const p = press; press = null; begin(row, event, p.y); }
        else if (!press.direct && Math.hypot(dx, dy) > 8) { clearTimeout(press.timer); press = null; }   // a scroll, not a hold
      });
      const cancel = () => { if (press) { clearTimeout(press.timer); press = null; } };
      row.addEventListener('pointerup', cancel);
      row.addEventListener('pointercancel', cancel);
    }
    function begin(row, event, startY) {
      const rows = [...list.children];
      const from = rows.indexOf(row);
      const rects = rows.map((r) => r.getBoundingClientRect());
      const scroll0 = window.scrollY;
      const mids = rects.map((r) => r.top + scroll0 + r.height / 2);
      const gap = rows.length > 1 ? rects[1].top - rects[0].bottom : 0;
      const step = rects[from].height + gap;
      drag = { row, rows, from, to: from, mids, step, startPage: startY + scroll0, y: event.clientY, frame: 0 };
      capture(row, event);
      list.classList.add('is-sorting');
      row.classList.add('is-dragging');
      if (navigator.vibrate && event.pointerType !== 'mouse') navigator.vibrate(10);
      const onMove = (e) => { drag.y = e.clientY; place(); };
      const onEnd = () => {
        row.removeEventListener('pointermove', onMove);
        row.removeEventListener('pointerup', onEnd);
        row.removeEventListener('pointercancel', onEnd);
        cancelAnimationFrame(drag.frame);
        finish();
      };
      row.addEventListener('pointermove', onMove);
      row.addEventListener('pointerup', onEnd);
      row.addEventListener('pointercancel', onEnd);
      const tick = () => { if (!drag) return; autoscroll(); drag.frame = requestAnimationFrame(tick); };
      drag.frame = requestAnimationFrame(tick);
      place();
    }
    function place() {
      const { row, rows, from, mids, step, startPage } = drag;
      const dy = drag.y + window.scrollY - startPage;
      row.style.transform = `translateY(${dy.toFixed(1)}px)`;
      const to = dropIndex(mids, from, mids[from] + dy);
      if (to === drag.to && rows[0].dataset.placed) return;
      drag.to = to;
      const next = moveItem(order, from, to);
      rows.forEach((r, i) => {
        r.dataset.placed = '1';
        if (i !== from) {
          const shift = from < to && i > from && i <= to ? -step : to < from && i >= to && i < from ? step : 0;
          r.style.transform = shift ? `translateY(${shift}px)` : '';
        }
        const at = next.indexOf(r.dataset.id);
        r.querySelector('.ptable__pos').textContent = String(at + 1);
        r.dataset.zone = zoneOf(at, next.length);
      });
    }
    /* Near an edge of the screen (under the masthead, above the phone's bars) the page scrolls, the
       faster the closer. */
    function autoscroll() {
      const top = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--predict-top')) || 0) + 56;
      const bottom = window.innerHeight - (matchMedia('(max-width: 760px)').matches ? 52 : 0) - 56;
      const speed = drag.y < top ? -(top - drag.y) : drag.y > bottom ? drag.y - bottom : 0;
      if (!speed) return;
      window.scrollBy(0, Math.max(-18, Math.min(18, speed / 3)));
      place();
    }
    function finish() {
      const { row, from, to } = drag;
      const before = row.getBoundingClientRect().top;
      drag = null;
      list.classList.remove('is-sorting');
      moved(from, to);
      paint();
      // The club settles into its place from where it was let go.
      const landed = list.children[to];
      if (landed && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        landed.style.transform = `translateY(${(before - landed.getBoundingClientRect().top).toFixed(1)}px)`;
        landed.classList.add('is-landing');
        requestAnimationFrame(() => requestAnimationFrame(() => { landed.style.transform = ''; }));
        setTimeout(() => landed.classList.remove('is-landing'), 260);
      }
      if (from !== to) announce.textContent = t('predict.table.moved', { club: game.names[order[to]], place: to + 1 });
    }

    const bonusOf = { champion: bonus.champion, promotion: bonus.promotion, relegation: bonus.relegation };
    const legend = h('ul', { class: 'pzones', attrs: { 'aria-label': t('predict.zones') } },
      (S.league === 'eliteserien' ? ['champion', 'relegation'] : ['promotion', 'relegation']).map((z) => h('li', { data: { zone: z } },
        t(`predict.zone.${z}`), h('span', { class: 'pzones__bonus' }, t('predict.zone.bonus', { n: bonusOf[z] })))));
    paint();
    // An order left in the browser (a closed tab, no connection) is saved now, not forgotten.
    if (open && saveState === 'pending') scheduleOrderSave();
    return h('div', { class: 'ptable-game' }, h('div', { class: 'ptable__head' }, legend, status), list, announce,
      open ? h('p', { class: 'ptable__hint' }, t('predict.table.hint')) : null, rules);
  }

  /* ---- boards ---------------------------------------------------------------------------------------------- */

  /* Boards change once an hour at most: one read serves for a few minutes, so a switch between
     divisions or periods (and the season panel's board, the same document) draws at once. */
  const BOARD_FRESH = 5 * 60 * 1000;
  function cachedBoard(id) {
    const hit = (S.boards || {})[id];
    return hit && now() - hit.at < BOARD_FRESH ? hit : null;
  }
  async function loadBoard(id) {
    const hit = cachedBoard(id);
    if (hit) return hit.board;
    const board = await client.get(`boards/${id}`);
    S.boards = S.boards || {};
    S.boards[id] = { board, at: now() };
    return board;
  }

  async function renderBoards(root) {
    const current = S.index && S.index.season;
    const scopes = ['season', 'round', 'last10'];
    const season = S.boardSeason && current && S.boardSeason <= current ? S.boardSeason : current;
    const seasons = boardSeasons(current);
    const seasonPick = h('select', { class: 'pfield pfield--pick', attrs: { 'aria-label': t('predict.board.season') }, on: { change: (e) => { S.boardSeason = Number(e.target.value); S.boardRound = {}; render(); } } },
      seasons.map((s) => h('option', { value: String(s), selected: s === season }, String(s))));
    // Rounds already scored this season, newest first: any of them has a board of its own.
    const scored = season === current ? leagueRounds(S.league).filter((r) => (Number.isInteger(r.settled) ? r.settled > 0 : roundStatus(r, now()) !== 'future')).reverse() : [];
    const pickedRound = (S.boardRound || {})[S.league] || null;
    // Both divisions together is a season board only (their rounds are not the same rounds).
    const all = Boolean(S.boardAll);
    const scope = all ? 'season' : S.scope;
    const roundPick = scope === 'round' && scored.length
      ? h('select', { class: 'pfield pfield--pick', attrs: { 'aria-label': t('predict.round.pick') }, on: { change: (e) => { S.boardRound = { ...(S.boardRound || {}), [S.league]: Number(e.target.value) || null }; render(); } } },
        scored.map((r, i) => h('option', { value: String(i === 0 ? 0 : r.round), selected: i === 0 ? !pickedRound : pickedRound === r.round }, t('predict.round', { n: r.round }))))
      : null;
    const divisions = h('div', { class: 'switch', attrs: { role: 'group', 'aria-label': t('predict.division') } },
      ['all', ...LEAGUES].map((id) => h('button', { type: 'button', data: { league: id }, attrs: { 'aria-pressed': String(id === 'all' ? all : !all && S.league === id) },
        on: { click: () => {
          S.boardAll = id === 'all';
          if (id !== 'all') { S.league = id; store.set('predict.league', id); }
          render();
        } } }, id === 'all' ? t('predict.board.both') : LEAGUE_NAME[id])));
    // The pickers come last, the round's after the season's, so the round's appearing (Runden) moves
    // nothing that stands before it; on a phone they share a row of their own.
    root.append(h('div', { class: 'ptoolbar ptoolbar--boards' }, divisions,
      h('div', { class: 'switch', attrs: { role: 'group', 'aria-label': t('predict.scope') } },
        scopes.map((one) => h('button', { type: 'button', disabled: all && one !== 'season', title: all && one !== 'season' ? t('predict.board.bothSeason') : null,
          attrs: { 'aria-pressed': String(scope === one) }, on: { click: () => { S.scope = one; render(); } } }, t(`predict.scope.${one}`)))),
      h('div', { class: 'ptoolbar__picks' }, seasonPick, roundPick)));
    const body = h('div', { class: 'pboards' });
    root.append(body);
    if (!season) { body.replaceChildren(emptyState(S.indexError, loadAndRender, 'predict.empty.rounds')); return; }
    const id = all ? `season_${season}_all` : scope === 'round' && pickedRound ? `round_${season}_${S.league}_${pickedRound}` : `${scope}_${season}_${S.league}`;
    const show = (board) => {
      const table = boardTable(board);
      body.replaceChildren(table, table.dataset.hero ? h('span') : percentileNote(board, season));
      S.boardShown = body.firstChild;
    };
    // A board read in the last few minutes is drawn at once; otherwise the one on show stays, dimmed,
    // until the new one is in (the first time, a placeholder of rows), so the page never empties.
    const ready = cachedBoard(id);
    if (ready && (!client.uid || (S.ownHash && S.stats !== undefined))) { show(ready.board); return; }
    body.append(S.boardShown ? Object.assign(S.boardShown, { className: `${S.boardShown.className.replace(/ is-stale/g, '')} is-stale` })
      : h('div', { class: 'pboard pskeleton pboard--skeleton', attrs: { 'aria-busy': 'true', 'aria-label': t('predict.loading') } },
        Array.from({ length: 8 }, () => h('span'))));
    const mine = body;
    try {
      if (client.uid && !S.ownHash) S.ownHash = await uidHash(client.uid);
      const board = await loadBoard(id);
      if (client.uid && S.stats === undefined) { try { S.stats = await client.get(`stats/${client.uid}`); } catch (error) { S.stats = null; } }
      if (S.tab !== 'boards' || !mine.isConnected) return;          // a newer draw has taken over
      show(board);
    } catch (error) { if (mine.isConnected) body.replaceChildren(emptyState(error, render)); }
  }

  /* Columns that sort, and which way is better the first time they are pressed. */
  const BOARD_COLUMNS = [['rank', 'asc'], ['name', 'asc'], ['n', 'desc'], ['pts', 'desc'], ['acc', 'desc']];

  function sortedRows(rows, sort) {
    if (!sort || sort.col === 'rank') return sort && sort.dir === 'desc' ? rows.slice().reverse() : rows;
    const key = sort.col === 'name' ? (r) => String(r.nick || '').toLowerCase()
      : sort.col === 'pts' ? rowPts : sort.col === 'acc' ? rowAcc : (r) => r[sort.col];
    const sign = sort.dir === 'desc' ? -1 : 1;
    return rows.slice().sort((a, b) => {
      const x = key(a);
      const y = key(b);
      if ((x === null || x === undefined) && (y === null || y === undefined)) return 0;
      if (x === null || x === undefined) return 1;                       // no value: last, whichever way
      if (y === null || y === undefined) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sign || a.rank - b.rank;
    });
  }

  /* One report per reporter and name; the flag asks before it sends, and a second report is "already". */
  function reportControl(row) {
    const holder = h('span', { class: 'preport-wrap' });
    const done = () => holder.replaceChildren(h('span', { class: 'preport preport--done', title: t('predict.reported'), attrs: { 'aria-label': t('predict.reported'), role: 'img' } }, '✓'));
    holder.append(confirmable('⚑', t('predict.report.q', { name: row.nick }), async () => {
      try {
        await ensureAccount();
        await client.commit(reportWrites(config, client.uid, row.nick));
        done();
      } catch (error) {
        if (error.code === 'denied') { done(); toast(t('predict.report.already')); }     // the rules allow one report per reporter and name
        else toast(errorText(error), 'error');
      }
    }, 'preport', t('predict.report.label', { name: row.nick })));
    return holder;
  }

  /* Where you stand: your medal and place, your points and accuracy; the climb to the next tier (the
     side panel's steps at 50, 75 and 90 %); then who you chase, who chases you, and the model. */
  function standingCard(board, st) {
    const { me, pts, tier, top, modelGap, beat } = st;
    const name = (row) => rowName(row);
    const stat = (label, value) => h('div', { class: 'pstanding__stat' }, h('dt', {}, label), h('dd', {}, value));
    const arrow = (dir) => h('span', { class: 'pstanding__arrow', attrs: { 'aria-hidden': 'true' } }, dir === 'up' ? '▲' : '▼');
    const lines = [
      st.ahead ? h('span', { class: 'pstanding__chase' }, arrow('up'), t('predict.board.gap.ahead', { pts: ptsText(st.toAhead), name: name(st.ahead) }))
        : h('span', { class: 'pstanding__lead' }, t('predict.board.hero.lead')),
      st.behind ? h('span', {}, arrow('down'), t('predict.board.hero.behind', { pts: ptsText(st.toBehind), name: name(st.behind) })) : null,
      modelGap === null ? null : h('span', { class: 'pstanding__model', data: { beat: String(modelGap > 0) } },
        modelGap > 0 ? t('predict.board.hero.model.beat', { pts: ptsText(modelGap) }) : t('predict.board.hero.model.behind', { pts: ptsText(-modelGap) })),
    ].filter(Boolean);
    let climb = null;
    if (beat !== null) {
      const next = tierOf(beat);
      const fill = h('span', { class: 'pside__fill', style: 'width: 0%' });
      // The line under the bar opens the tiers: what each one takes, and which is yours.
      climb = h('div', { class: 'pstanding__climb' },
        h('div', { class: 'pside__track', attrs: { role: 'img', 'aria-label': t('predict.side.beat', { beat }) } },
          fill, ...[50, 75, 90].map((at) => h('span', { class: 'pside__step', style: `left: ${at}%` }))),
        h('details', { class: 'ptiersbox' },
          h('summary', {}, h('span', {}, next.next ? t('predict.side.next', { n: next.toNext, tier: t(`predict.tier.${next.next}`) }) : t('predict.side.top')),
            h('span', { class: 'ptiersbox__open' }, t('predict.tiers.title'))),
          tierGuide(tier)));
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${beat}%`; }));
    }
    // Your name is the card's title; the place stands with the numbers.
    const nick = (S.profile && S.profile.nick) || me.nick || t('predict.anon');
    return h('section', { class: 'pstanding', data: { tier: tier || 'none' }, attrs: { 'aria-label': t('predict.board.gap.place', { place: st.place }) } },
      h('div', { class: 'pstanding__top' },
        h('div', { class: 'pstanding__who' },
          tier ? h('span', { class: 'plevel plevel--big', data: { tier }, attrs: { 'aria-hidden': 'true' } }) : null,
          h('div', { class: 'pstanding__name' },
            h('strong', {}, nick),
            h('small', {}, [tier ? t(`predict.tier.${tier}`) : null, top !== null ? t('predict.board.hero.top', { pct: top }) : null,
              Number.isFinite(board.players) && board.players > 0 ? t('predict.board.hero.of', { n: groupThousands(board.players, lang()) }) : null].filter(Boolean).join(' · ')))),
        h('dl', { class: 'pstanding__stats' }, stat(t('predict.col.place'), `#${st.place}`), stat(t('predict.col.pts'), ptsText(pts)), stat(t('predict.col.acc'), pctText(rowAcc(me))))),
      climb,
      h('p', { class: 'pstanding__lines' }, lines));
  }

  /* The four tiers, best first: each one's mark, name, what it takes and a line on it; yours marked. Shared
     by the standing card, the side panel and the guide. */
  function tierGuide(current) {
    return h('div', { class: 'ptiers' }, h('p', { class: 'ptiers__intro' }, t('predict.tiers.intro')),
      h('ol', { class: 'ptiers__list' }, TIERS.map((tier) => h('li', { class: 'ptiers__item', data: { tier: tier.id, current: String(tier.id === current) } },
        h('span', { class: 'plevel', data: { tier: tier.id }, attrs: { 'aria-hidden': 'true' } }),
        h('span', { class: 'ptiers__text' },
          h('strong', {}, t(`predict.tier.${tier.id}`), tier.id === current ? h('span', { class: 'ptag ptag--you' }, t('predict.tag.you')) : null),
          h('small', {}, t(`predict.tiers.${tier.id}`))),
        h('span', { class: 'ptiers__at' }, tier.at ? t('predict.tiers.at', { pct: tier.at }) : t('predict.tiers.start'))))));
  }

  /* The top three on steps, the winner in the middle; in place order for a screen reader. */
  function podiumOf(top, place, isMine) {
    return h('ol', { class: 'ppodium', attrs: { 'aria-label': t('predict.board.podium') } }, top.map((row, i) => {
      const at = place.get(row);
      const mine = isMine(row);
      return h('li', { class: 'ppodium__step', data: { pos: String(i + 1), place: String(at), mine: String(mine) } },
        h('span', { class: 'ppodium__medal', attrs: { 'aria-hidden': 'true' } }, String(at)),
        h('span', { class: 'ppodium__name' }, h('span', { class: 'ppodium__nick' }, rowName(row)),
          mine ? h('span', { class: 'ptag ptag--you' }, t('predict.tag.you')) : null),
        h('span', { class: 'ppodium__pts' }, ptsText(rowPts(row)), h('small', {}, ` ${t('predict.col.pts').toLowerCase()}`)),
        h('span', { class: 'ppodium__acc' }, pctText(rowAcc(row))),
        h('span', { class: 'ppodium__plinth', attrs: { 'aria-hidden': 'true' } }));
    }));
  }

  function boardTable(board, { league = false } = {}) {
    if (!board || !board.rows || !board.rows.length) return h('p', { class: 'pempty' }, t('predict.board.empty'));
    const tone = (value) => (value > 0.00005 ? 'good' : value < -0.00005 ? 'bad' : 'even');
    const tbody = h('tbody', {});
    const headRow = h('tr', {});
    let sort = null;
    let all = false;                       // a long board shows the top, you and your neighbours until asked for all
    const isMine = (row) => Boolean(S.ownHash && row.u === S.ownHash);
    const mineRow = () => board.rows.find(isMine);
    const place = humanRanks(board.rows);          // the model and the crowd stand on the board but take no place
    const rankCell = (row) => {
      const at = place.get(row);
      return h('td', { class: 'pboard__rank' }, at && at <= 3 ? h('span', { class: 'pmedal', data: { place: String(at) } }, String(at)) : at ? String(at) : '–');
    };
    const rowNode = (row) => {
      const mine = isMine(row);
      const name = h('td', { class: 'pboard__name' }, h('span', { class: 'pboard__nick' }, rowName(row)));
      if (mine) name.append(h('span', { class: 'ptag ptag--you' }, t('predict.tag.you')));
      else if (row.kind === 'model' || row.kind === 'crowd') name.append(h('span', { class: `ptag ptag--${row.kind}` }, t(`predict.tag.${row.kind}`)));
      else if (row.kind === 'player' && row.nick) name.append(reportControl(row));
      return h('tr', { class: 'pboard__row', tabIndex: -1, data: { kind: row.kind, mine: String(mine) } },
        rankCell(row), name, h('td', { class: 'pboard__n' }, String(row.n)),
        h('td', { class: 'pboard__pts' }, ptsText(rowPts(row))),
        h('td', { class: 'pboard__acc' }, pctText(rowAcc(row))));
    };
    const gapNode = (n) => h('tr', { class: 'pboard__gap' }, h('td', { colSpan: BOARD_COLUMNS.length },
      h('button', { type: 'button', class: 'pboard__more', on: { click: () => { all = true; paintRows(); } } },
        h('span', { class: 'pboard__dots', attrs: { 'aria-hidden': 'true' } }, '⋯'), t('predict.board.more', { n: groupThousands(n, lang()) }))));
    const toggle = h('button', { type: 'button', class: 'pbtn pbtn--small pboard__toggle', on: { click: () => { all = !all; paintRows(); } } });
    // Three players or more: the top three stand on the podium, and the table (in board order) goes on
    // from fourth place; sorted by another column it lists everyone again.
    const podiumRows = board.rows.filter((row) => row.kind === 'player').slice(0, 3);
    const onPodium = podiumRows.length === 3 ? new Set(podiumRows) : null;
    const paintRows = () => {
      const sorted = sortedRows(board.rows, sort);
      const rows = onPodium && !sort ? sorted.filter((row) => !onPodium.has(row)) : sorted;
      const shape = { top: onPodium && !sort ? 7 : 10, around: 5, always: (row) => row.kind === 'model' || row.kind === 'crowd' };
      const items = all ? rows.map((row) => ({ row })) : boardWindow(rows, rows.findIndex(isMine), shape);
      tbody.replaceChildren(...items.map((item) => (item.row ? rowNode(item.row) : gapNode(item.gap))));
      const shortened = boardWindow(rows, rows.findIndex(isMine), shape).some((item) => item.gap);
      toggle.hidden = !shortened;
      toggle.textContent = all ? t(mineRow() ? 'predict.board.fewer' : 'predict.board.top') : t('predict.board.all', { n: groupThousands(rows.length, lang()) });
    };
    const paintHead = () => headRow.replaceChildren(...BOARD_COLUMNS.map(([c, first]) => {
      const active = (sort || { col: 'rank' }).col === c;
      const dir = active ? (sort || { dir: 'asc' }).dir : 'none';
      return h('th', { scope: 'col', class: `pboard__${c}`, attrs: { 'aria-sort': dir === 'none' ? 'none' : dir === 'asc' ? 'ascending' : 'descending' } },
        h('button', { type: 'button', class: 'pboard__sort', on: { click: () => {
          sort = active && sort ? { col: c, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { col: c, dir: first };
          if (sort.col === 'rank' && sort.dir === 'asc') sort = null;
          paintHead(); paintRows();
        } } }, t(`predict.col.${c}`), h('span', { class: 'pboard__arrow', attrs: { 'aria-hidden': 'true' } }, !sort ? '' : dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '')));
    }));
    // Where you stand and how far the next places are, and a button that takes you to your row (it shows
    // the whole list first when your row is not in the short one).
    const rivals = rivalsOf(board.rows, isMine, rowPts);
    const standing = standingOf(board.rows, board.pct, board.players, isMine, rowPts);
    const close = standing && !league ? standingCard(board, standing) : null;        // a league's header says your place
    const jump = rivals && board.rows.length > 12 && !(onPodium && podiumRows.some(isMine)) ? h('button', { type: 'button', class: 'pbtn pbtn--small pboard__jump', on: { click: () => {
      let row = tbody.querySelector('[data-mine="true"]');
      if (!row) { all = true; paintRows(); row = tbody.querySelector('[data-mine="true"]'); }
      if (row) { row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); row.focus({ preventScroll: true }); }
    } } }, t('predict.board.jump')) : null;
    // On a phone the table keeps rank, name, points and accuracy; this brings the rest back (scrolling sideways).
    const wrap = h('div', { class: 'pboard' });
    const cols = h('button', { type: 'button', class: 'pbtn pbtn--small pboard__cols', on: { click: () => {
      const wide = wrap.classList.toggle('pboard--wide');
      cols.textContent = t(wide ? 'predict.board.cols.fewer' : 'predict.board.cols.more');
    } } }, t('predict.board.cols.more'));
    paintHead();
    paintRows();
    if (close) wrap.dataset.hero = 'true';
    wrap.append(...[close, onPodium ? podiumOf(podiumRows, place, isMine) : null].filter(Boolean), h('div', { class: 'pboard__tools' }, jump, cols),
      h('div', { class: 'pscroll', hidden: Boolean(onPodium) && board.rows.filter((row) => !onPodium.has(row)).length === 0 }, h('table', {}, h('thead', {}, headRow), tbody)),
      h('div', { class: 'pboard__foot' }, toggle,
        h('p', { class: 'pboard__note' }, t(league ? 'predict.leagues.note' : 'predict.board.note', { players: groupThousands(board.players || 0, lang()) })),
        h('details', { class: 'pboard__how' }, h('summary', {}, t('predict.board.how')), h('p', {}, t('predict.board.key')))));
    return wrap;
  }

  function percentileNote(board, season) {
    if (!board || !board.pct || !board.pct.length || !S.stats) return h('span');
    // the season board adds up the season, the round and last-10 boards their own rounds: the share beaten is on that board's points
    const mine = (S.scope === 'season' || S.boardAll) ? seasonTotals(S.stats, season, S.boardAll ? undefined : S.league)
      : keysTotals(S.stats, scopeKeys(S.index, { season: board.season || season, league: board.league || S.league, scope: S.scope, round: board.round }));
    if (!mine.n) return h('p', { class: 'pboard__me' }, t('predict.board.nonescored'));
    const beat = beatShare(board.pct, totalPoints(mine.n, mine.b), board.players);
    // Your place is on the line above the table; this says only the share you beat, and the points behind it.
    return h('p', { class: 'pboard__me' }, t('predict.board.you', { beat, pts: ptsText(totalPoints(mine.n, mine.b)), n: mine.n }));
  }

  /* ---- leagues: private boards among friends, a page of their own -------------------------------- */

  /* The codes of the leagues a player is in: on the profile (so they follow a Google sign-in to another
     device) and, with the names, in this browser. */
  const MAX_LEAGUES = 20;                       // the rules' limit on a profile's list of codes
  const profileLeagues = () => ((S.profile && Array.isArray(S.profile.leagues)) ? S.profile.leagues : []);
  const inviteLink = (code) => `${location.origin}/predict/?join=${code}#leagues`;

  /* The leaderboard's order on another plan: your leagues in a row of chips on top (the boards have a
     switch), the one picked under a header of its own (its name, your place, the code to share), then its
     board. Making or joining one sits behind a button once you are in a league; with none it is the page. */
  function renderLeagues(root) {
    S.myLeagues = json(store.get('predict.leagues'), []);
    const saveLocal = () => store.set('predict.leagues', JSON.stringify(S.myLeagues));
    if (!S.myLeagues.some((e) => e.code === S.leagueShown)) S.leagueShown = S.myLeagues.length ? S.myLeagues[0].code : null;
    const has = S.myLeagues.length > 0;
    const open = !has || Boolean(S.pendingJoin) || Boolean(S.leaguesFormOpen);
    const message = h('p', { class: 'pleagues__msg', attrs: { 'aria-live': 'polite' } }, S.leagueNote || (S.pendingJoin ? t('predict.leagues.invited') : ''));
    const say = (text) => { message.textContent = text; };

    /* Join and the profile's list of codes go in one commit: the job purges memberships from that list. */
    const joinWrites = (code) => [...leagueJoinWrites(config, client.uid, code),
      ...profileUpdateWrites(config, client.uid, { leagues: [...new Set([...profileLeagues(), code])] })];
    const remember = (code, name) => {
      if (!S.myLeagues.some((e) => e.code === code)) S.myLeagues.push({ code, name });
      saveLocal();
      S.profile = { ...S.profile, leagues: [...new Set([...profileLeagues(), code])] };
      S.leagueShown = code;
      S.leaguesFormOpen = false;
    };
    async function leave(entry) {
      try {
        const rest = profileLeagues().filter((c) => c !== entry.code);
        await client.commit([writeDelete(config, `leagues/${entry.code}/members/${client.uid}`), ...profileUpdateWrites(config, client.uid, { leagues: rest })]);
        S.myLeagues = S.myLeagues.filter((e) => e.code !== entry.code);
        saveLocal();
        S.profile = { ...S.profile, leagues: rest };
        S.leagueShown = null;
        S.leagueNote = t('predict.leagues.left', { name: entry.name });
        render();
      } catch (error) { say(errorText(error)); }
    }

    const nameInput = h('input', { type: 'text', class: 'pfield', maxLength: 30, attrs: { 'aria-label': t('predict.leagues.name'), placeholder: t('predict.leagues.name') } });
    const codeInput = h('input', { type: 'text', class: 'pfield pleagues__code', maxLength: 8, value: S.pendingJoin || '', attrs: { 'aria-label': t('predict.leagues.code'), placeholder: 'ABCD2345', autocapitalize: 'characters', spellcheck: 'false' } });
    const create = h('button', { type: 'button', class: 'pbtn pbtn--primary', on: { click: async () => {
      const name = nameInput.value.trim();
      if (name.length < 2) { say(t('predict.leagues.shortname')); return; }
      if (profileLeagues().length >= MAX_LEAGUES) { say(t('predict.leagues.full')); return; }
      try {
        await ensureAccount();
        const code = newLeagueCode();
        // One commit: the rules check that the league exists after it, so a failed join leaves no empty league.
        await client.commit([...leagueCreateWrites(config, client.uid, code, name), ...joinWrites(code)]);
        remember(code, name);
        S.leagueNote = t('predict.leagues.created', { code });       // kept across the redraw; the header has the link to share
        render();
      } catch (error) { say(errorText(error)); }
    } } }, t('predict.leagues.create'));
    const join = h('button', { type: 'button', class: 'pbtn pbtn--primary', on: { click: async () => {
      const code = codeInput.value.trim().toUpperCase();
      if (!isLeagueCode(code)) { say(t('predict.leagues.badcode')); return; }
      if (profileLeagues().includes(code)) { say(t('predict.leagues.already')); return; }
      if (profileLeagues().length >= MAX_LEAGUES) { say(t('predict.leagues.full')); return; }
      try {
        await ensureAccount();
        const found = await client.get(`leagues/${code}`);
        if (!found) { say(t('predict.leagues.nolatest')); return; }
        await client.commit(joinWrites(code));
        remember(code, found.name);
        S.pendingJoin = null;
        S.leagueNote = t('predict.leagues.joined', { name: found.name });
        render();
      } catch (error) { say(errorText(error)); }
    } } }, t('predict.leagues.join'));
    const card = (title, hint, field, button) => h('div', { class: 'pleagues__card' }, h('h3', {}, title), h('p', { class: 'pmuted' }, hint),
      h('span', { class: 'pinline' }, field, button));
    const forms = h('div', { class: 'pleagues__forms', hidden: !open },
      card(t('predict.leagues.create'), t('predict.leagues.create.hint'), nameInput, create),
      card(t('predict.leagues.join'), t('predict.leagues.join.hint'), codeInput, join));

    if (!has) {
      root.append(h('section', { class: 'pleagues pleagues--none' },
        h('h2', {}, t('predict.leagues.title')), h('p', { class: 'pintro' }, t('predict.leagues.intro')), forms, message));
    } else {
      const entry = S.myLeagues.find((e) => e.code === S.leagueShown);
      const add = h('button', { type: 'button', class: 'pbtn pbtn--small pleagues__add', title: t('predict.leagues.add'), attrs: { 'aria-expanded': String(open), 'aria-label': t('predict.leagues.add') }, on: { click: () => {
        S.leaguesFormOpen = forms.hidden;
        forms.hidden = !forms.hidden;
        add.setAttribute('aria-expanded', String(!forms.hidden));
        if (!forms.hidden) nameInput.focus();
      } } }, h('span', { class: 'pleagues__addtext' }, t('predict.leagues.add')));
      const chips = h('div', { class: 'pleagues__tabs', attrs: { role: 'group', 'aria-label': t('predict.leagues.yours') } },
        S.myLeagues.map((one) => h('button', { type: 'button', class: 'pchip', attrs: { 'aria-pressed': String(one.code === entry.code) },
          on: { click: () => { if (one.code === S.leagueShown) return; Object.assign(S, { leagueShown: one.code, leagueNote: null, leaguesFormOpen: false }); render(); } } }, one.name)));
      const standing = h('p', { class: 'pleague__standing' });
      const head = h('header', { class: 'pleague__head' },
        h('div', { class: 'pleague__title' }, h('h2', {}, entry.name), standing),
        h('div', { class: 'pleague__actions' },
          h('span', { class: 'pleague__code' }, h('span', { class: 'pleague__codelabel' }, t('predict.leagues.code')), h('code', {}, entry.code)),
          shareButton({ title: entry.name, url: inviteLink(entry.code), label: t('predict.leagues.copyFor', { name: entry.name }) }),
          confirmable(t('predict.leagues.leave'), t('predict.leagues.leave.q', { name: entry.name }), () => leave(entry), 'pbtn pbtn--small pbtn--danger')));
      const shown = h('div', { class: 'pleagues__board' });
      root.append(h('div', { class: 'ptoolbar ptoolbar--leagues' }, chips, add), forms, message,
        h('section', { class: 'pleague' }, head, shown));
      showLeague(entry.code, shown, standing);
    }

    // Leagues joined on another device: the profile has their codes, the names are one read each.
    const missing = profileLeagues().filter((code) => !S.myLeagues.some((e) => e.code === code));
    if (missing.length && client.uid && !S.leaguesFetched) {
      S.leaguesFetched = true;
      Promise.all(missing.map(async (code) => { try { const found = await client.get(`leagues/${code}`); return found ? { code, name: found.name } : null; } catch (error) { return null; } }))
        .then((found) => {
          found.filter(Boolean).forEach((one) => { if (!S.myLeagues.some((e) => e.code === one.code)) S.myLeagues.push(one); });
          saveLocal();
          if (found.some(Boolean) && S.tab === 'leagues') render();
        });
    }
  }

  /* One league's board, and your place in it on the header's line. A league just made has no board until
     the job's next run (hours, not minutes: see docs/predict.md, "When the job runs"). */
  async function showLeague(code, target, standing) {
    const id = `league_${code}`;
    const paint = (board) => {
      if (!board) { target.replaceChildren(h('p', { class: 'pempty pleague__wait' }, t('predict.leagues.pending'))); return; }
      target.replaceChildren(boardTable(board, { league: true }));
      const players = board.players || 0;
      const isMine = (row) => Boolean(S.ownHash && row.u === S.ownHash);
      const near = rivalsOf(board.rows, isMine, rowPts);
      standing.textContent = [t(players === 1 ? 'predict.leagues.players.one' : 'predict.leagues.players', { n: groupThousands(players, lang()) }),
        near ? t('predict.leagues.place', { place: near.place }) : null,
        near && near.ahead ? t('predict.leagues.chase', { pts: ptsText(near.toAhead), name: near.ahead.nick || t('predict.anon') }) : null].filter(Boolean).join(' · ');
    };
    const hit = cachedBoard(id);
    if (hit && (!client.uid || S.ownHash)) { paint(hit.board); return; }
    target.replaceChildren(h('div', { class: 'pboard pskeleton pboard--skeleton', attrs: { 'aria-busy': 'true', 'aria-label': t('predict.loading') } },
      Array.from({ length: 6 }, () => h('span'))));
    try {
      if (client.uid && !S.ownHash) S.ownHash = await uidHash(client.uid);
      const board = await loadBoard(id);
      if (target.isConnected) paint(board);
    } catch (error) { if (target.isConnected) target.replaceChildren(emptyState(error, () => showLeague(code, target, standing))); }
  }

  /* ---- your playing style: an analysis of your settled picks, with tips -------------------------- */

  /* Your settled picks with the model's locked odds, the result and the clubs. A finished round is
     cached in the browser, so the analysis costs reads only once per round. */
  const HISTORY_FRESH = 5 * 60 * 1000;

  /* One load at a time, shared by the analysis, the calibration chart and the side panel's tip. */
  function ensureHistory(force = false) {
    if (S.history && !force && now() - S.historyAt < HISTORY_FRESH) return Promise.resolve(S.history);
    if (!S.historyLoad) {
      S.historyLoad = loadHistory().then((rows) => { S.history = rows; S.historyAt = now(); return rows; })
        .finally(() => { S.historyLoad = null; });
    }
    return S.historyLoad;
  }

  async function loadHistory() {
    const cacheKey = `predict.hist.${client.uid}`;
    const cache = json(store.get(cacheKey), {});
    const entries = await client.list(`entries/${client.uid}/rounds`, 100);
    const rows = [];
    for (const { id, data } of entries) {
      let slice = cache[id];
      if (!slice) {
        const [reveal, fixture] = await Promise.all([client.get(`reveal/${id}`), client.get(`fixtures/${id}`)]);
        slice = {};
        for (const [slot, m] of Object.entries((reveal && reveal.matches) || {})) {
          const f = fixture && fixture.slots && fixture.slots[slot];
          if (!m.result || !m.model || !f) continue;
          slice[slot] = { home: f.home, away: f.away, hid: f.home_id, aid: f.away_id, ko: f.kickoff.getTime(),
            model: [m.model.h, m.model.d, m.model.a], hg: m.result.hg, ag: m.result.ag };
        }
        if (fixture && Object.keys(fixture.slots).every((k) => slice[k])) cache[id] = slice;
      }
      for (const [slot, m] of Object.entries(slice)) {
        const pick = data.p && data.p[slot];
        if (pick) rows.push({ key: id, slot, ...m, pick: storedPercents(pick), t: pick.t instanceof Date ? pick.t.getTime() : null });
      }
    }
    store.set(cacheKey, JSON.stringify(cache));
    return rows;
  }

  function analysisSection() {
    const box = h('section', { class: 'ppanel panalyse' }, h('h2', {}, t('predict.style.title')),
      h('p', { class: 'pmuted panalyse__intro' }, t('predict.style.intro')));
    const body = h('div', { class: 'panalyse__body' });
    box.append(body);
    const go = async () => {
      body.replaceChildren(h('p', { class: 'pload' }, t('predict.style.loading')));
      try { await ensureHistory(); paintAnalysis(body); }
      catch (error) { body.replaceChildren(emptyState(error, go)); }
    };
    if (S.history && now() - S.historyAt < HISTORY_FRESH) paintAnalysis(body);
    else if (store.get(`predict.hist.${client.uid}`)) go();          // analysed before: the cache makes it cheap
    else body.append(h('button', { type: 'button', class: 'pbtn pbtn--primary', on: { click: go } }, t('predict.style.run')));
    return box;
  }

  function paintAnalysis(body) {
    const scope = S.styleScope || 'all';
    const seasons = [...new Set((S.history || []).map((r) => r.key.split('_')[0]))].sort().reverse();
    const seasonScope = seasons.includes(S.styleSeason) ? S.styleSeason : 'all';
    const rows = (S.history || []).filter((r) => (scope === 'all' || r.key.includes(`_${scope}_`)) && (seasonScope === 'all' || r.key.startsWith(`${seasonScope}_`)));
    const divisions = h('div', { class: 'switch', attrs: { role: 'group', 'aria-label': t('predict.division') } },
      ['all', ...LEAGUES].map((id) => h('button', { type: 'button', attrs: { 'aria-pressed': String(scope === id) },
        on: { click: () => { S.styleScope = id; paintAnalysis(body); } } }, id === 'all' ? t('predict.style.all') : LEAGUE_NAME[id])));
    const seasonPick = seasons.length > 1
      ? h('select', { class: 'pfield pfield--pick', attrs: { 'aria-label': t('predict.board.season') }, on: { change: (e) => { S.styleSeason = e.target.value; paintAnalysis(body); } } },
        [h('option', { value: 'all', selected: seasonScope === 'all' }, t('predict.style.allSeasons')), ...seasons.map((s) => h('option', { value: s, selected: seasonScope === s }, s))])
      : null;
    const chips = h('div', { class: 'ptoolbar' }, divisions, seasonPick);
    const out = analysePlay(rows);
    if (!out.ready) {
      body.replaceChildren(chips, h('p', { class: 'pempty' }, t('predict.style.wait', { n: out.missing })));
      return;
    }
    if (scope === 'all' && seasonScope === 'all' && out.insights[0]) {
      store.set(`predict.tip.${client.uid}`, JSON.stringify({ id: out.insights[0].id, params: out.insights[0].params, tone: out.insights[0].tone, stamp: statsTotalN() }));
    }

    // You against the model: wins, draws, losses, and what following it would have done.
    const { wins, losses, ties, followGain } = out.h2h;
    const share = (x) => `${(x / out.n) * 100}%`;
    const h2h = h('div', { class: 'ph2h' },
      h('h3', {}, t('predict.style.h2h')),
      h('p', { class: 'ph2h__score' }, h('strong', { data: { tone: 'good' } }, String(wins)), h('span', {}, '–'),
        h('strong', { data: { tone: 'bad' } }, String(losses))),
      h('div', { class: 'ph2h__bar', attrs: { role: 'img', 'aria-label': t('predict.style.h2hAria', { w: wins, t: ties, l: losses }) } },
        h('span', { class: 'ph2h__w', style: `flex-basis: ${share(wins)}` }), h('span', { class: 'ph2h__t', style: `flex-basis: ${share(ties)}` }),
        h('span', { class: 'ph2h__l', style: `flex-basis: ${share(losses)}` })),
      h('p', { class: 'ph2h__legend' }, t('predict.style.h2hText', { w: wins, t: ties, l: losses })),
      h('p', { class: 'ph2h__follow' }, followGain > 0 ? t('predict.style.follow.worse', { d: ptsText(10 * followGain) })
        : t('predict.style.follow.better', { d: ptsText(-10 * followGain) })));

    // Your style against the model, trait by trait: the model is the centre line.
    const track = (id) => {
      const v = out.traits[id];
      const at = 50 + Math.max(-20, Math.min(20, v)) * 2.5;
      return h('div', { class: 'ptrait' },
        h('div', { class: 'ptrait__head' }, h('strong', {}, t(`predict.style.trait.${id}`)),
          h('span', { data: { tone: Math.abs(v) < 4 ? 'even' : 'off' } }, Math.abs(v) < 4 ? t('predict.style.like') : t(v > 0 ? 'predict.style.more' : 'predict.style.less', { v: Math.abs(v) }))),
        h('div', { class: 'ptrait__track', attrs: { role: 'img', 'aria-label': `${t(`predict.style.trait.${id}`)}: ${v > 0 ? '+' : ''}${v}` } },
          h('span', { class: 'ptrait__mid' }), h('span', { class: 'ptrait__dot', style: `left: ${at}%` })));
    };
    const traits = h('div', { class: 'ptraits' }, h('h3', {}, t('predict.style.traits')),
      ['favourite', 'draw', 'home', 'bold'].map(track),
      h('p', { class: 'ptraits__legend' }, h('span', {}, t('predict.style.lessEnd')), h('span', {}, t('predict.model')), h('span', {}, t('predict.style.moreEnd'))));

    // The tips, strongest first; each opens to the matches behind it.
    const fmt = (v) => v.map((x) => Math.round(x)).join(' / ');
    const evidence = (indices) => (indices.length ? h('ul', { class: 'pinsight__rows' }, indices.map((i) => {
      const r = rows[i];
      return h('li', {}, h('strong', { class: 'pinsight__match' }, crest(r.hid, 18), `${r.home} ${r.hg}–${r.ag} ${r.away}`, crest(r.aid, 18)),
        h('span', {}, `${t('predict.you')} ${fmt(r.pick)} · ${t('predict.model')} ${fmt(r.model.map((x) => x * 100))}`));
    })) : null);
    const insights = out.insights.length
      ? out.insights.slice(0, 6).map((x, i) => h('details', { class: 'pinsight', data: { tone: x.tone }, open: i === 0 },
        h('summary', {}, h('span', { class: 'pinsight__icon', attrs: { 'aria-hidden': 'true' } }), t(`predict.insight.${x.id}.title`, x.params)),
        h('p', {}, t(`predict.insight.${x.id}.text`, x.params)), evidence(x.rows)))
      : [h('p', { class: 'pmuted' }, t('predict.style.none'))];

    body.replaceChildren(chips, h('p', { class: 'panalyse__n' }, t('predict.style.based', { n: out.n })), h2h, traits,
      h('div', { class: 'pinsights' }, h('h3', {}, t('predict.style.tips')), insights));
  }

  /* ---- your season, beside the matches ---------------------------------------------------------- */

  const SIDE_TABS = ['tip', 'table'];         // the boards take the whole width: they are a wide table
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}) => { const node = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); return node; };

  async function renderSide() {
    const side = document.getElementById('predict-side');
    const layout = document.querySelector('.playout');
    if (!side) return;
    const show = SIDE_TABS.includes(S.tab) && !tutorialOn();
    side.hidden = !show;
    if (layout) layout.dataset.side = String(show);
    if (!show) return;
    const wanted = S.league;
    const season = S.index && S.index.season;
    if (!side.firstChild) side.append(h('div', { class: 'pside__card pskeleton', attrs: { 'aria-hidden': 'true' } }, h('span'), h('span'), h('span')));
    let league = wanted;
    try {
      if (client.uid && S.stats === undefined) S.stats = await client.get(`stats/${client.uid}`);
      if (client.uid && !S.ownHash) S.ownHash = await uidHash(client.uid);
      // Nothing of yours in this division yet: your season stays on screen, from the division you play.
      const played = (one) => Boolean(season && S.stats && seasonTotals(S.stats, season, one).n);
      if (!played(wanted)) league = LEAGUES.find(played) || wanted;
      if (season) await loadBoard(`season_${season}_${league}`);
    } catch (error) { /* the panel shows what it has */ }
    if (S.league !== wanted || !SIDE_TABS.includes(S.tab)) return;
    side.replaceChildren(sidePanel(season, league, league !== wanted));
    if (S.tab === 'tip') refreshRoundPick();
  }

  /* How many settled matches the stats hold, all seasons: the tip from the analysis is stamped with it. */
  const statsTotalN = () => Object.values((S.stats && S.stats.rounds) || {}).reduce((sum, r) => sum + (r.n || 0), 0);

  /* The side panel's tip was worked out earlier: when more matches have settled, work it out again (one
     history load, cached rounds are free), once per change. */
  async function refreshTip() {
    const stamp = statsTotalN();
    if (S.tipRefreshing || S.tipTried === stamp || !client.uid) return;
    S.tipRefreshing = true;
    S.tipTried = stamp;
    try {
      const out = analysePlay(await ensureHistory(true));
      const key = `predict.tip.${client.uid}`;
      if (out.ready && out.insights[0]) store.set(key, JSON.stringify({ id: out.insights[0].id, params: out.insights[0].params, tone: out.insights[0].tone, stamp }));
      else store.remove(key);
    } catch (error) { /* the old tip stays */ }
    S.tipRefreshing = false;
    renderSide();
  }

  function sidePanel(season, league, elsewhere = false) {
    const board = ((S.boards || {})[`season_${season}_${league}`] || {}).board || null;
    const mine = season && S.stats ? seasonTotals(S.stats, season, league) : { n: 0 };
    const nick = (S.profile && S.profile.nick) || t('predict.you');
    const head = h('div', { class: 'pside__head' },
      h('span', { class: 'pside__avatar', attrs: { 'aria-hidden': 'true' } }, nick.charAt(0).toUpperCase()),
      h('span', { class: 'pside__who' }, h('strong', {}, nick), h('small', {}, `${t('predict.side.label')} · ${LEAGUE_NAME[league]}`)));
    const card = h('section', { class: 'pside__card', attrs: { 'aria-label': t('predict.side.label') } }, head);

    if (!mine.n) {
      card.classList.add('pside__card--empty');               // nothing of yours yet: on a narrow screen the matches come first
      const quiet = h('details', { class: 'pside__details', open: matchMedia('(min-width: 1000px)').matches }, h('summary', {}, t('predict.side.moreSummary')));
      quiet.append(h('p', { class: 'pside__empty' }, t('predict.side.empty')));
      card.append(quiet);
      return card;
    }

    const points = totalPoints(mine.n, mine.b);
    const beat = board ? beatShare(board.pct, points, board.players) : null;
    // Rank among people: the board's own ranks also count the model and the crowd rows.
    const own = board && S.ownHash ? board.rows.find((r) => r.u === S.ownHash) : null;
    const big = h('strong', { class: 'pside__score', data: { tone: points < 0 ? 'bad' : 'even' } }, ptsText(points));
    countUp(big, points, `${season}_${league}`);
    card.append(h('div', { class: 'pside__hero' }, big, h('span', { class: 'pside__label' },
      elsewhere ? t('predict.side.ptsIn', { league: LEAGUE_NAME[league] }) : t('predict.side.pts'))));

    // Your tier in one line; what the tiers are is the bell's coloured bands (and the leaderboard's guide).
    if (beat !== null) {
      const tier = tierOf(beat);
      card.append(h('div', { class: 'pside__tier', data: { tier: tier.id } },
        h('span', { class: 'plevel', data: { tier: tier.id }, attrs: { 'aria-hidden': 'true' } }),
        h('span', {}, h('strong', {}, t(`predict.tier.${tier.id}`)), h('small', {},
          own ? t('predict.side.rankBeat', { rank: humanRanks(board.rows).get(own) || own.rank, total: groupThousands(board.players || 0, lang()), beat })
            : t('predict.side.beat', { beat })))));
    }

    // The spread, the form and three numbers: open beside the matches on a wide screen, a tap away on a phone.
    const more = h('details', { class: 'pside__details', open: matchMedia('(min-width: 1000px)').matches }, h('summary', {}, t('predict.side.moreSummary')));
    const tier = beat !== null ? tierOf(beat) : null;
    more.append(bellChart(board, points, beat, league, tier && (tier.next ? t('predict.side.next', { n: tier.toNext, tier: t(`predict.tier.${tier.next}`) }) : t('predict.side.top'))));

    const cell = (value, label, toneOf) => h('div', { class: 'pside__cell', data: { tone: toneOf || 'even' } }, h('strong', {}, value), h('small', {}, label));
    more.append(h('div', { class: 'pside__grid' },
      cell(percentText(accuracyPercent(mine.n, mine.b), lang(), 1), t('predict.side.acc')),
      cell(String(mine.n), t('predict.col.n')),
      cell(ptsText(10 * mine.vm, true), t('predict.side.vm'), mine.vm > 0 ? 'good' : mine.vm < 0 ? 'bad' : 'even')));

    // Form: a bar a round. All good rounds stand on the floor; a bad one hangs below a middle line.
    const form = roundForm(S.stats, season, league, 8);
    if (form.length) {
      const top = Math.max(0.1, ...form.map((f) => Math.abs(f.pts)));
      const split = form.some((f) => f.pts < 0);
      more.append(h('div', { class: 'pside__formbox' }, h('h3', { class: 'pside__h' }, t('predict.side.form')),
        h('div', { class: 'pside__form', data: { split: String(split) }, attrs: { role: 'img', 'aria-label': t('predict.side.formAria', { n: form.length }) } },
          form.map((f) => h('span', { class: 'pside__bar', data: { tone: f.pts > 0 ? 'good' : f.pts < 0 ? 'bad' : 'even' },
            title: `${t('predict.round', { n: f.round })}: ${ptsText(f.pts, true)}` },
            h('i', { style: `height: ${Math.max(6, (Math.abs(f.pts) / top) * (split ? 50 : 100))}%` }), h('small', {}, String(f.round)))))));
    }
    card.append(more);
    const tip = json(store.get(`predict.tip.${client.uid}`), null);
    if (tip && tip.id && tip.stamp !== statsTotalN()) refreshTip();          // new rounds have settled since it was worked out
    if (tip && tip.id) {
      card.append(h('button', { type: 'button', class: 'pside__tip', data: { tone: tip.tone || 'tip' }, on: { click: () => openTab('me') } },
        h('small', {}, t('predict.side.tip')), h('span', {}, t(`predict.insight.${tip.id}.title`, tip.params || {}))));
    }
    card.append(h('button', { type: 'button', class: 'pbtn pbtn--small pside__more', on: { click: () => openTab('me') } }, t('predict.side.more')));
    return card;
  }

  /* The field as a bell curve, in the tiers' colours (the board's own 50th, 75th and 90th percentiles cut
     it): the part you beat is filled strong, the rest faint, and your marker slides in. `caption`: a short
     line under it (how far the next tier is). */
  function bellChart(board, value, beat, league, caption = null) {
    const fit = board ? normalFit(board.pct) : null;
    const W = 280;
    const H = 110;
    const base = H - 18;
    if (!fit || (board.players || 0) < 3) {
      return h('p', { class: 'pside__note' }, t('predict.side.distLater'));
    }
    const model = (board.rows || []).find((r) => r.kind === 'model');
    const modelPts = model ? rowPts(model) : null;
    const points = [fit.mean - 3 * fit.sd, fit.mean + 3 * fit.sd, value, modelPts].filter((x) => x !== null && x !== undefined && Number.isFinite(x));
    const lo = Math.min(...points) - fit.sd * 0.3;
    const hi = Math.max(...points) + fit.sd * 0.3;
    const x = (v) => ((v - lo) / (hi - lo)) * W;
    const y = (v) => base - normalDensity(v, fit.mean, fit.sd) * (base - 14);
    let path = `M0 ${base}`;
    for (let i = 0; i <= 80; i++) { const v = lo + ((hi - lo) * i) / 80; path += ` L${x(v).toFixed(1)} ${y(v).toFixed(1)}`; }
    path += ` L${W} ${base} Z`;
    const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'pbell', role: 'img',
      'aria-label': value === null ? t('predict.side.dist') : t('predict.side.distAria', { beat, league: LEAGUE_NAME[league] }) });
    const clipId = `pbell-${Math.random().toString(36).slice(2, 8)}`;
    const defs = svg('defs');
    const clip = svg('clipPath', { id: clipId });
    const clipRect = svg('rect', { x: 0, y: 0, width: 0, height: H, class: 'pbell__clip' });
    clip.append(clipRect);
    defs.append(clip);
    // The tier bands, worst first: each is the curve clipped to its stretch of points.
    const cut = (at) => (at === 0 ? 0 : Math.min(W, Math.max(0, x(board.pct[at]))));
    const bands = TIERS.slice().reverse().map((tier, i, all) => {
      const id = `${clipId}-${tier.id}`;
      const from = cut(tier.at);
      const to = i + 1 < all.length ? cut(all[i + 1].at) : W;
      const band = svg('clipPath', { id });
      band.append(svg('rect', { x: from, y: 0, width: Math.max(0, to - from), height: H }));
      defs.append(band);
      return { tier: tier.id, id };
    });
    const layer = (cls) => {
      const g = svg('g', { class: cls });
      bands.forEach((b) => g.append(svg('path', { d: path, class: 'pbell__band', 'data-tier': b.tier, 'clip-path': `url(#${b.id})` })));
      return g;
    };
    chart.append(defs, layer('pbell__bands'));
    if (value !== null) {
      const strong = layer('pbell__bands pbell__bands--beat');
      strong.setAttribute('clip-path', `url(#${clipId})`);
      chart.append(strong);
    }
    chart.append(svg('path', { d: path, class: 'pbell__curve' }), svg('line', { x1: 0, x2: W, y1: base, y2: base, class: 'pbell__axis' }));
    const tick = (v, label, cls, up) => {
      const g = svg('g', { class: `pbell__mark ${cls}` });
      g.append(svg('line', { x1: x(v), x2: x(v), y1: up ? 10 : y(v), y2: base, class: 'pbell__line' }));
      const text = svg('text', { x: Math.min(W - 4, Math.max(4, x(v))), y: up ? 9 : base + 13, 'text-anchor': x(v) < 30 ? 'start' : x(v) > W - 30 ? 'end' : 'middle' });
      text.textContent = label;
      g.append(text);
      return g;
    };
    chart.append(tick(fit.mean, t('predict.side.median'), 'pbell__mark--median', false));
    if (model) {
      // Labels must not collide: the model's goes up top when it is near the median's, and is left
      // off (the dashed line stays) when it would also sit on yours.
      const nearMedian = Math.abs(x(modelPts) - x(fit.mean)) < 48;
      const nearYou = value !== null && Math.abs(x(modelPts) - x(value)) < 40;
      const mark = tick(modelPts, nearMedian && nearYou ? '' : t('predict.model'), 'pbell__mark--model', nearMedian);
      chart.append(mark);
    }
    if (value !== null) {
      const you = tick(value, t('predict.you'), 'pbell__mark--you', true);
      chart.append(you);
      // The reveal: the filled part grows to your score, your marker slides in from the middle.
      const target = x(value);
      you.style.transform = `translateX(${(x(fit.mean) - target).toFixed(1)}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => { clipRect.style.width = `${target.toFixed(1)}px`; you.style.transform = 'translateX(0)'; }));
    }
    // Your place and the share you beat are said once, under your tier; the chart only shows the spread.
    return h('figure', { class: 'pside__chart' }, chart, value === null ? h('figcaption', {}, t('predict.side.distEmpty')) : caption ? h('figcaption', {}, caption) : null);
  }

  /* The headline number counts up once per visit, not on every redraw. */
  function countUp(node, target, key) {
    S.counted = S.counted || new Set();
    if (S.counted.has(key) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    S.counted.add(key);
    const start = performance.now();
    const step = (time) => {
      const k = Math.min(1, (time - start) / 900);
      node.textContent = ptsText(target * (1 - (1 - k) ** 3));
      if (k < 1) requestAnimationFrame(step);
    };
    node.textContent = ptsText(0);
    requestAnimationFrame(step);
  }

  /* ---- how to play: a guide with a bar to try and a result to pick -------------------------------- */

  /* The working bar and the scoring demo under it, for the guide and the tutorial; nothing here is saved.
     `flags` records what the player has tried (moved the bar, fine-tuned it, picked a result) and `onFlag`
     hears each the first time. */
  function guideDemo(onFlag = () => {}) {
    const info = { home: t('predict.how.home'), away: t('predict.how.away') };
    const even = pickPercentages(0, DRAW_TENTHS.normal);
    const flags = { moved: false, fine: false, picked: false };
    const raise = (name) => { if (!flags[name]) { flags[name] = true; onFlag(name); } };
    let picked = null;
    const demoSlider = pickSlider(info, { g: 60, k: DRAW_TENTHS.normal }, { onInput: () => paint(),
      onStart: () => demo.classList.add('is-dragging'), onEnd: () => demo.classList.remove('is-dragging') });
    const first = demoSlider.percents();
    const reading = h('p', { class: 'pcard__read' });
    const score = h('div', { class: 'pguide__score', attrs: { 'aria-live': 'polite' } }, h('p', { class: 'pmuted' }, t('predict.how.pick')));
    const results = ['home_win', 'draw', 'away_win'].map((o) => h('button', { type: 'button', class: 'pbtn pbtn--small', data: { outcome: o },
      attrs: { 'aria-pressed': 'false' }, on: { click: () => { picked = o; raise('picked'); results.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.outcome === o))); paint(); } } },
      t(`predict.how.r.${o}`)));

    function paint() {
      const p = demoSlider.percents();
      demoSlider.paint();
      reading.textContent = pickReading(p, info);
      reset.hidden = Boolean(demoSlider.pos.p) || demoSlider.pos.k === DRAW_TENTHS.normal;
      if (p.some((x, i) => Math.abs(x - first[i]) >= 5)) raise('moved');
      if (!picked) return;
      const you = scoreOwnPick(p, even.map((x) => x / 100), picked);
      const evenBrier = you.brier + you.vsModel;
      const kind = you.vsModel > 0.0005 ? 'good' : you.vsModel < -0.0005 ? 'bad' : 'even';
      const mini = bar(p);
      mini.dataset.hit = OUTCOME_SIDE[picked];
      mini.classList.add('pguide__mini');
      score.replaceChildren(mini,
        h('p', { class: 'pguide__big' }, t('predict.how.score.you', { b: avgText(you.brier), p: ptsText(matchPoints(you.brier), true) })),
        h('p', {}, t('predict.how.score.even', { m: avgText(evenBrier), p: ptsText(matchPoints(evenBrier), true) })),
        h('div', { class: 'pverdict', data: { kind } }, h('strong', { class: 'pverdict__chip' }, t(`predict.how.score.${kind === 'even' ? 'even2' : kind}`))));
    }
    const reset = h('button', { type: 'button', class: 'pbtn pbtn--small', hidden: true,
      on: { click: () => { demoSlider.pos = { g: demoSlider.pos.g, k: DRAW_TENTHS.normal }; paint(); } } }, t('predict.fine.reset'));
    const demoFine = fineSwitch(false, null, () => {
      const on = !demoSlider.pos.p;
      demoSlider.setFree(on);
      demoFine.setAttribute('aria-pressed', String(on));
      if (on) raise('fine');
      paint();
    });
    const demo = h('div', { class: 'pcard pguide__demo', data: { state: 'tipped' } },
      matchHead(info, t('predict.how.try')), demoSlider.control,
      h('div', { class: 'pguide__demofoot' }, reading, h('span', { class: 'pcard__acts' }, reset, demoFine)));
    const pickRow = h('div', { class: 'pguide__results', attrs: { role: 'group', 'aria-label': t('predict.how.pick') } }, results);
    paint();
    return { demo, pickRow, score, flags };
  }

  function renderHow(root) {
    const { demo, pickRow, score } = guideDemo();
    const step = (n, title, ...kids) => h('section', { class: 'pguide__step' },
      h('h2', {}, h('span', { class: 'pguide__n', attrs: { 'aria-hidden': 'true' } }, String(n)), title), ...kids);
    const faq = ['1', '2', '3', '4'].map((n) => h('details', { class: 'pdetails pguide__q' },
      h('summary', {}, t(`predict.how.q${n}`)), h('p', {}, t(`predict.how.a${n}`))));
    faq.push(h('details', { class: 'pdetails pguide__q' }, h('summary', {}, t('predict.how.qTiers')), tierGuide(null)));

    root.append(h('article', { class: 'pguide' },
      h('h2', { class: 'pguide__title' }, t('predict.how.title')),
      h('p', { class: 'pguide__lead' }, t('predict.how.lead')),
      h('button', { type: 'button', class: 'pbtn pbtn--small pguide__again', on: { click: () => { S.replay = true; S.tut = null; render(); window.scrollTo(0, 0); } } },
        t('predict.tut.again')),
      step(1, t('predict.how.s1.title'), h('p', {}, t('predict.how.s1.text')), demo),
      step(2, t('predict.how.s2.title'), h('p', {}, t('predict.how.s2.text'))),
      step(3, t('predict.how.s3.title'), h('p', {}, t('predict.how.s3.text'))),
      step(4, t('predict.how.s4.title'), h('p', {}, t('predict.how.s4.text')), pickRow, score,
        h('p', {}, t('predict.how.s4.bold'))),
      step(5, t('predict.how.s5.title'), h('p', {}, t('predict.how.s5.text'))),
      step(6, t('predict.how.s6.title'), h('p', {}, t('predict.how.s6.text'))),
      h('section', { class: 'pguide__faq' }, h('h2', {}, t('predict.how.faq')), faq,
        h('p', { class: 'pmuted' }, h('a', { href: '/personvern.html' }, t('predict.foot.privacy')))),
      h('button', { type: 'button', class: 'pbtn pbtn--primary pguide__cta', on: { click: () => { store.set('predict.intro', 'seen'); openTab('tip'); window.scrollTo(0, 0); } } },
        t('predict.how.cta'))));
  }

  /* ---- the tutorial: the first visit, one step at a time, each with something to do ------------------- */

  /* Shown in place of the tip, table and guide views until it has been finished once (a player with an
     account has played before, so is never asked). `need` is what a step waits for: a guideDemo flag. The last step offers Google sign-in (or playing anonymously) to
     a player with no account yet. */
  const TUTORIAL = [
    { id: 'welcome' },
    { id: 'drag', demo: true, need: 'moved' },
    { id: 'fine', demo: true, need: 'fine' },
    { id: 'score', demo: true, results: true, need: 'picked' },
    { id: 'lock' },
    { id: 'points' },
    { id: 'table' },
    { id: 'account', account: true },
  ];
  const tutorialDue = () => store.get('predict.intro') !== 'seen' && !client.uid;
  function tutorialOn() {
    if (S.replay && S.tab !== 'how') S.replay = false;
    return Boolean(S.replay) || (tutorialDue() && ['tip', 'table', 'how'].includes(S.tab));
  }

  function renderTutorial(root) {
    const T = S.tut || (S.tut = { step: 0, passed: new Set() });
    const steps = TUTORIAL.filter((s) => !s.account || !client.uid);
    const demo = guideDemo((flag) => { T.passed.add(flag); if (gate) gate(); });
    const google = googleFlow(t('predict.google.signin'), switchToGoogle);
    const body = h('div', { class: 'ptut__body' });
    const hint = h('p', { class: 'ptut__hint', attrs: { 'aria-live': 'polite' } });
    const back = h('button', { type: 'button', class: 'pbtn', on: { click: () => { T.step -= 1; show(true); } } }, t('predict.tut.back'));
    const next = h('button', { type: 'button', class: 'pbtn pbtn--primary', on: { click: () => {
      if (T.step < steps.length - 1) { T.step += 1; show(true); return; }
      store.set('predict.intro', 'seen');
      S.replay = false; S.tut = null;
      openTab('tip');
      window.scrollTo(0, 0);
    } } });
    const leave = S.replay ? h('button', { type: 'button', class: 'pbtn pbtn--small ptut__leave', on: { click: () => { S.replay = false; S.tut = null; render(); } } }, t('predict.tut.close')) : null;
    // A first visit can be skipped: the game opens, and the introduction stays in the guide (Slik spiller du).
    const skip = S.replay ? null : h('button', { type: 'button', class: 'pbtn pbtn--small ptut__skip', on: { click: () => {
      store.set('predict.intro', 'seen');
      S.tut = null;
      openTab('tip');
      window.scrollTo(0, 0);
    } } }, t('predict.tut.skip'));

    // What the step waits for: the Next button and the line above it. Only these change while the bar is dragged.
    function gate() {
      const s = steps[T.step];
      const waiting = Boolean(s.need) && !T.passed.has(s.need);
      next.disabled = waiting;
      hint.dataset.ok = String(!waiting && Boolean(s.need));
      hint.textContent = !s.need ? '' : waiting ? t(`predict.tut.need.${s.need}`) : t('predict.tut.ok');
    }
    function show(moved) {
      const s = steps[T.step];
      const title = h('h2', { class: 'ptut__title', attrs: { tabindex: '-1' } }, t(`predict.tut.${s.id}.title`));
      body.replaceChildren(...[
        h('ol', { class: 'ptut__dots', attrs: { 'aria-hidden': 'true' } },
          steps.map((_, i) => h('li', { data: { state: i < T.step ? 'done' : i === T.step ? 'now' : 'todo' } }))),
        h('p', { class: 'ptut__count' }, t('predict.tut.step', { n: T.step + 1, m: steps.length })),
        title,
        h('p', { class: 'ptut__text' }, t(`predict.tut.${s.id}.text`)),
        s.demo ? demo.demo : null,
        s.results ? demo.pickRow : null,
        s.results ? demo.score : null,
        s.results ? h('p', { class: 'ptut__text' }, t('predict.how.s4.bold')) : null,
        s.account ? h('div', { class: 'pgoogle ptut__google' }, google.start, google.holder, google.message) : null].filter(Boolean));
      back.hidden = T.step === 0;
      const last = T.step === steps.length - 1;
      next.textContent = t(s.account ? 'predict.tut.anon' : last ? 'predict.tut.finish' : 'predict.tut.next');
      next.classList.toggle('pbtn--primary', !s.account);
      google.start.classList.toggle('pbtn--primary', Boolean(s.account));
      gate();
      if (moved) title.focus({ preventScroll: true });
    }
    root.append(h('article', { class: 'ptut', attrs: { 'aria-label': t('predict.tut.label') } }, body, hint,
      h('div', { class: 'ptut__nav' }, leave, back, next), skip));
    show(false);
  }

  /* ---- you: profile, stats, Google, deletion --------------------------------------------------------------------- */

  async function renderMe(root) {
    const body = h('div', {}, h('p', { class: 'pload' }, t('predict.loading')));
    root.append(body);
    if (!client.uid) { body.replaceChildren(h('p', { class: 'pempty' }, t('predict.me.none')), dataSection(false)); return; }
    try {
      if (S.profile === undefined || S.profile === null) await loadProfile();
      if (!S.profile) await ensureAccount();          // signed in (Google, say) but never tipped: the profile is made now
      if (S.stats === undefined) S.stats = await client.get(`stats/${client.uid}`);
    } catch (error) { body.replaceChildren(emptyState(error, render)); return; }
    if (S.tab !== 'me') return;
    // Who you are, then your numbers; the settings and your data at the bottom.
    body.replaceChildren(profileSection(), statsSection(), analysisSection(), settingsSection(), dataSection(true));
  }

  function profileSection() {
    const profile = S.profile || {};
    const nick = h('input', { type: 'text', class: 'pfield', value: profile.nick || '', maxLength: 20, id: 'pnick', attrs: { autocomplete: 'off', spellcheck: 'false' } });
    const message = h('p', { class: 'pme__msg', attrs: { 'aria-live': 'polite' } });
    const change = h('button', { type: 'button', class: 'pbtn', on: { click: async () => {
      try { await ensureAccount(); } catch (error) { message.textContent = errorText(error); return; }
      const profile = S.profile || {};
      const next = nick.value.trim();
      const problems = nickProblems(next);
      if (problems.includes('format')) { message.textContent = t('predict.nick.format'); return; }
      if (problems.includes('reserved') || nickBlocked(next)) { message.textContent = t('predict.nick.reserved'); return; }
      if (next === profile.nick) return;
      const caseOnly = nickLower(next) === nickLower(profile.nick || '');      // the claim and the 30-day clock stay
      if (!caseOnly && profile.nickCustom && profile.nickAt && now() - profile.nickAt.getTime() < 30 * 86400000) {
        message.textContent = t('predict.nick.wait', { span: spanText(profile.nickAt.getTime() + 30 * 86400000 - now()) });
        return;
      }
      try {
        await client.commit(nicknameChangeWrites(config, client.uid, profile.nick, next));
        S.profile = caseOnly ? { ...profile, nick: next }
          : { ...profile, nick: next, nickLower: nickLower(next), nickCustom: true, nickAt: new Date(now()) };
        message.textContent = t('predict.nick.saved');
      } catch (error) { message.textContent = error.code === 'denied' ? t('predict.nick.taken') : errorText(error); }
    } } }, t('predict.nick.change'));
    return h('section', { class: 'ppanel pme' }, h('h2', {}, t('predict.me.title')),
      h('div', { class: 'pfieldset' }, h('label', { attrs: { for: 'pnick' } }, t('predict.me.nick')), h('div', { class: 'pinline' }, nick, change)), message);
  }

  function settingsSection() {
    const profile = S.profile || {};
    const hidden = h('input', { type: 'checkbox', class: 'pswitch', checked: Boolean(profile.hidden), attrs: { role: 'switch' }, on: { change: async (e) => {
      try { await ensureAccount(); await client.commit(profileUpdateWrites(config, client.uid, { hidden: e.target.checked })); S.profile = { ...S.profile, hidden: e.target.checked }; }
      catch (error) { e.target.checked = !e.target.checked; toast(errorText(error), 'error'); }
    } } });
    const always = h('input', { type: 'checkbox', class: 'pswitch', checked: S.alwaysFine, attrs: { role: 'switch' }, on: { change: (e) => {
      S.alwaysFine = e.target.checked;
      store.set('predict.fine.always', S.alwaysFine ? 'on' : 'off');
    } } });
    // The clubs of the rounds already loaded, as suggestions.
    const ids = new Map();
    Object.values(S.data).forEach((record) => Object.values((record.fixture && record.fixture.slots) || {}).forEach((m) => { ids.set(m.home, m.home_id); ids.set(m.away, m.away_id); }));
    const list = h('datalist', { id: 'pclubs' }, [...ids.keys()].sort((a, b) => a.localeCompare(b, 'nb')).map((n) => h('option', { value: n })));
    // The club's crest beside its name, once the name is one the page knows.
    const clubCrest = h('span', { class: 'pclub__crest', attrs: { 'aria-hidden': 'true' } });
    const paintCrest = (name) => { const img = crest(ids.get(name.trim()), 28); clubCrest.replaceChildren(...(img ? [img] : [])); clubCrest.hidden = !img; };
    const club = h('input', { type: 'text', class: 'pfield', value: profile.club || '', maxLength: 40, id: 'pclub', attrs: { list: 'pclubs', autocomplete: 'off' },
      on: { change: async (e) => {
        const value = e.target.value.trim();
        paintCrest(value);
        try { await ensureAccount(); await client.commit(profileUpdateWrites(config, client.uid, { club: value })); S.profile = { ...S.profile, club: value }; toast(t('predict.me.clubSaved')); }
        catch (error) { toast(errorText(error), 'error'); }
      } } });
    paintCrest(profile.club || '');
    return h('section', { class: 'ppanel psettings' }, h('h2', {}, t('predict.me.settings')),
      h('label', { class: 'pswitch-row' }, h('span', {}, h('strong', {}, t('predict.me.hidden')), h('small', {}, t('predict.me.hiddenHelp'))), hidden),
      h('label', { class: 'pswitch-row' }, h('span', {}, h('strong', {}, t('predict.me.fineAlways')), h('small', {}, t('predict.me.fineAlwaysHelp'))), always),
      h('div', { class: 'pfieldset' }, h('label', { attrs: { for: 'pclub' } }, t('predict.me.club')), h('div', { class: 'pinline pclub' }, clubCrest, club), list));
  }

  function statsSection() {
    const current = S.index && S.index.season;
    const withData = statsSeasons(S.stats);
    const seasons = [...new Set([current, ...withData].filter(Boolean))].sort((a, b) => b - a);
    // The season in view: the one picked, else this one, else the newest you have played.
    const season = S.meSeason && seasons.includes(S.meSeason) ? S.meSeason : current && withData.includes(current) ? current : withData[0] || current;
    const totals = season ? seasonTotals(S.stats, season) : { n: 0, ab: 0, ar: 0, b: 0, r: 0, vm: 0, rounds: 0 };
    const isCurrent = season === current;
    const seasonPick = seasons.length > 1 ? h('select', { class: 'pfield pfield--pick', attrs: { 'aria-label': t('predict.season.pick') },
      on: { change: (e) => { S.meSeason = Number(e.target.value); render(); } } },
      seasons.map((x) => h('option', { value: String(x), selected: x === season }, String(x)))) : null;
    const box = h('section', { class: 'ppanel pstats' }, h('div', { class: 'pstats__head' }, h('h2', {}, t('predict.stats.title')), seasonPick));
    if (!totals.n) { box.append(h('p', { class: 'pempty' }, t('predict.stats.none'))); return box; }
    const tone = (value) => (value > 0.00005 ? 'good' : value < -0.00005 ? 'bad' : 'even');
    const big = (label, value, toneOf) => h('div', { class: 'pstat', data: { tone: toneOf || 'even' } }, h('dd', {}, value), h('dt', {}, label));
    box.append(h('dl', { class: 'pstats__hero' },
      big(t('predict.stats.pts'), ptsText(totalPoints(totals.n, totals.b))),
      big(t('predict.stats.acc'), pctText(accuracyPercent(totals.n, totals.b))),
      big(t('predict.col.n'), String(totals.n)),
      big(t('predict.stats.vm'), ptsText(10 * totals.vm, true), tone(totals.vm))));
    const series = seasonSeries(S.stats, season);
    const high = seasonHighlights(series);
    if (series.length >= 2) {
      box.append(h('section', { class: 'pseason' }, h('div', { class: 'pseason__head' }, h('h3', {}, t('predict.season.chart')),
        shareButton({ title: () => `${t('predict.title')} · ${t('predict.season.shareTitle', { season })}`, className: 'pseason__share',
          image: () => sharePredictSeason(season, totals, series) })),
        seasonChart(series),
        h('ul', { class: 'pseason__facts' },
          h('li', {}, t('predict.season.rounds', { n: high.rounds })),
          h('li', {}, t('predict.season.best', { round: high.best.round, pts: ptsText(high.best.pts, true) })),
          h('li', {}, t('predict.season.beat', { n: high.beat, rounds: high.rounds })))));
    }
    const small = (label, value) => [h('dt', {}, label), h('dd', {}, value)];
    box.append(h('dl', { class: 'pstats__more' },
      small(t('predict.col.b'), avgText(totals.b / totals.n))));
    if (isCurrent) {
      const badges = badgesFor({ tips: totals.n, totals });
      box.append(h('h3', {}, t('predict.badges')), h('ul', { class: 'pbadges' }, badges.map((b) => h('li', { class: 'pbadge pbadge--b', data: { earned: String(b.earned) } },
        h('span', { attrs: { 'aria-hidden': 'true' } }, b.earned ? '✓' : '○'), t(`predict.badge.${b.id}`)))));
    }
    const chart = h('div', { class: 'pcal' });
    box.append(totals.n >= 30 ? h('button', { type: 'button', class: 'pbtn', on: { click: (e) => { e.currentTarget.remove(); calibration(chart); } } }, t('predict.cal.show'))
      : h('p', { class: 'pmuted' }, t('predict.cal.later', { n: 30 - totals.n })), chart);
    return box;
  }

  /* Accuracy through the season: your running accuracy against the model's over the same matches, one point
     a round. Tap or drag across it (or use the arrow keys) to read any round. */
  function seasonChart(series) {
    const W = 320;
    const H = 176;
    const left = 40;
    const right = 8;
    const top = 10;
    const bottom = 24;
    const values = series.flatMap((r) => [r.acc, r.model]);
    let lo = Math.floor(Math.min(...values) - 0.5);
    let hi = Math.ceil(Math.max(...values) + 0.5);
    if (hi - lo < 3) { hi += 1; lo -= 1; }
    const first = series[0].round;
    const last = series[series.length - 1].round;
    const x = (round) => left + (last === first ? 0.5 : (round - first) / (last - first)) * (W - left - right);
    const y = (value) => top + ((hi - value) / (hi - lo)) * (H - top - bottom);
    const svgNode = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'pseason__svg', role: 'img', tabindex: '0',
      'aria-label': t('predict.season.chartAria', { you: pctText(series[series.length - 1].acc), round: last, model: pctText(series[series.length - 1].model) }) });
    const text = (px, py, value, attrs = {}) => { const node = svg('text', { x: px, y: py, class: 'pseason__tick', ...attrs }); node.textContent = value; return node; };
    for (const value of [lo, (lo + hi) / 2, hi]) {
      svgNode.append(svg('line', { x1: left, x2: W - right, y1: y(value), y2: y(value), class: 'pseason__grid' }),
        text(left - 5, y(value) + 3, `${Math.round(value * 10) / 10}%`, { 'text-anchor': 'end' }));
    }
    const ticks = last - first >= 2 ? [first, Math.round((first + last) / 2), last] : [first, last];
    [...new Set(ticks)].forEach((round, i, all) => svgNode.append(text(x(round), H - 7, String(round), { 'text-anchor': i === 0 ? 'start' : i === all.length - 1 ? 'end' : 'middle' })));
    const line = (key) => series.map((r, i) => `${i ? 'L' : 'M'}${x(r.round).toFixed(1)} ${y(r[key]).toFixed(1)}`).join(' ');
    svgNode.append(svg('path', { d: line('model'), class: 'pseason__line pseason__line--model' }), svg('path', { d: line('acc'), class: 'pseason__line pseason__line--you' }));
    const rule = svg('line', { y1: top, y2: H - bottom, class: 'pseason__rule' });
    const dotYou = svg('circle', { r: 3.5, class: 'pseason__dot pseason__dot--you' });
    const dotModel = svg('circle', { r: 3, class: 'pseason__dot pseason__dot--model' });
    svgNode.append(rule, dotModel, dotYou);
    const caption = h('figcaption', { attrs: { 'aria-live': 'polite' } });
    const legend = h('p', { class: 'pseason__legend' }, h('span', { class: 'pseason__key pseason__key--you' }, t('predict.you')), h('span', { class: 'pseason__key pseason__key--model' }, t('predict.model')));
    let at = series.length - 1;
    const show = (i) => {
      at = Math.max(0, Math.min(series.length - 1, i));
      const r = series[at];
      rule.setAttribute('x1', x(r.round)); rule.setAttribute('x2', x(r.round));
      dotYou.setAttribute('cx', x(r.round)); dotYou.setAttribute('cy', y(r.acc));
      dotModel.setAttribute('cx', x(r.round)); dotModel.setAttribute('cy', y(r.model));
      caption.textContent = t('predict.season.chartTip', { round: r.round, you: pctText(r.acc), model: pctText(r.model) });
    };
    const nearest = (event) => {
      const box = svgNode.getBoundingClientRect();
      const px = ((event.clientX - box.left) / box.width) * W;
      let best = 0;
      series.forEach((r, i) => { if (Math.abs(x(r.round) - px) < Math.abs(x(series[best].round) - px)) best = i; });
      show(best);
    };
    svgNode.addEventListener('pointerdown', nearest);
    svgNode.addEventListener('pointermove', (event) => { if (event.pointerType === 'mouse' || event.buttons) nearest(event); });
    svgNode.addEventListener('keydown', (event) => {
      const step = { ArrowLeft: -1, ArrowRight: 1, Home: -series.length, End: series.length }[event.key];
      if (step === undefined) return;
      event.preventDefault();
      show(at + step);
    });
    show(at);
    return h('figure', { class: 'pseason__fig' }, legend, svgNode, caption);
  }

  /* The season as a picture, in the share sheet's frame: the three figures, and the accuracy line of
     you and the model through the rounds. Resolves to a PNG blob. */
  async function sharePredictSeason(season, totals, series) {
    const { ctx, canvas } = await shareCanvas();
    const room = shareFrame(ctx, `${t('predict.title')} · ${t('predict.season.shareTitle', { season })}`);
    const u = shareU();
    const tall = shareTall();
    const stats = [[ptsText(totalPoints(totals.n, totals.b)), t('predict.stats.pts'), SC.ink],
      [pctText(accuracyPercent(totals.n, totals.b)), t('predict.stats.acc'), SC.ink],
      [ptsText(10 * totals.vm, true), t('predict.stats.vm'), totals.vm < 0 ? SC.badInk : SC.accentInk]];
    const gap = 20 * u;
    const w = (room.w - gap * 2) / 3;
    const figureH = (tall ? 150 : 118) * u;
    stats.forEach(([value, label, color], i) => {
      const px = room.x + i * (w + gap);
      shareRect(ctx, px, room.y, w, figureH, 16, SC.panel);
      paintText(ctx, value, px + w / 2, room.y + figureH * 0.56, { size: 44 * u, weight: 800, wide: true, color, align: 'center', maxWidth: w - 24, fit: true });
      paintText(ctx, label, px + w / 2, room.y + figureH * 0.86, { size: 17 * u, weight: 600, color: SC.muted, align: 'center', maxWidth: w - 24, fit: true });
    });
    // The chart fills what is left of the room.
    const area = { x: room.x + 52 * u, y: room.y + figureH + gap * 2.2, w: room.w - 52 * u, h: room.h - figureH - gap * 2.2 - 30 * u };
    area.h = Math.min(area.h, area.w * (tall ? 1 : 0.55));          // not stretched to fill a tall picture
    const values = series.flatMap((r) => [r.acc, r.model]);
    let lo = Math.floor(Math.min(...values) - 0.5);
    let hi = Math.ceil(Math.max(...values) + 0.5);
    if (hi - lo < 3) { hi += 1; lo -= 1; }
    const first = series[0].round;
    const last = series[series.length - 1].round;
    const px = (round) => area.x + (last === first ? 0.5 : (round - first) / (last - first)) * area.w;
    const py = (value) => area.y + ((hi - value) / (hi - lo)) * area.h;
    ctx.lineWidth = 1;
    for (const value of [lo, (lo + hi) / 2, hi]) {
      ctx.strokeStyle = SC.faint;
      ctx.globalAlpha = 0.35;
      ctx.beginPath(); ctx.moveTo(area.x, py(value)); ctx.lineTo(area.x + area.w, py(value)); ctx.stroke();
      ctx.globalAlpha = 1;
      paintText(ctx, `${Math.round(value * 10) / 10}%`, area.x - 10 * u, py(value) + 5 * u, { size: 15 * u, weight: 600, color: SC.muted, align: 'right' });
    }
    paintText(ctx, String(first), area.x, area.y + area.h + 24 * u, { size: 15 * u, weight: 600, color: SC.muted });
    paintText(ctx, String(last), area.x + area.w, area.y + area.h + 24 * u, { size: 15 * u, weight: 600, color: SC.muted, align: 'right' });
    const stroke = (key, color, width, dash) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      series.forEach((r, i) => { if (i) ctx.lineTo(px(r.round), py(r[key])); else ctx.moveTo(px(r.round), py(r[key])); });
      ctx.stroke(); ctx.setLineDash([]);
    };
    stroke('model', SC.muted, 3 * u, [8 * u, 7 * u]);
    stroke('acc', SC.accent, 5 * u, []);
    const end = series[series.length - 1];
    ctx.fillStyle = SC.accent;
    ctx.beginPath(); ctx.arc(px(end.round), py(end.acc), 7 * u, 0, Math.PI * 2); ctx.fill();
    const keyY = area.y - 20 * u;
    const modelWidth = paintText(ctx, t('predict.model'), area.x + area.w, keyY, { size: 16 * u, weight: 700, color: SC.muted, align: 'right' });
    paintText(ctx, t('predict.you'), area.x + area.w - modelWidth - 30 * u, keyY, { size: 16 * u, weight: 700, color: SC.accentInk, align: 'right' });
    return shareBlob(canvas);
  }

  /* Calibration, once, on request: the same settled picks the playing-style analysis reads, so the
     two share one listing and one cache, and a round counts only once its matches have results. */
  async function calibration(target) {
    target.replaceChildren(h('p', { class: 'pload' }, t('predict.loading')));
    try {
      const rows = await ensureHistory();
      target.replaceChildren(calibrationChart(calibrationBins(calibrationPoints(rows))));
    } catch (error) { target.replaceChildren(emptyState(error, () => calibration(target))); }
  }

  /* Calibration: what you said against how often it happened, with a ruler on each axis and a number of
     statements behind every dot (hover or tap a dot to read it). */
  function calibrationChart(bins) {
    const W = 250;
    const H = 226;
    const left = 36;
    const top = 10;
    const size = 190;
    const svgNode = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'pcal__svg', role: 'img', 'aria-label': t('predict.cal.label') });
    const caption = h('figcaption', {}, t('predict.cal.caption'));
    svgNode.append(svg('rect', { x: left, y: top, width: size, height: size, class: 'pcal__frame' }),
      svg('line', { x1: left, y1: top + size, x2: left + size, y2: top, class: 'pcal__diag' }));
    const label = (x, y, text, attrs = {}) => { const node = svg('text', { x, y, class: 'pcal__tick', ...attrs }); node.textContent = text; return node; };
    for (const f of [0, 0.5, 1]) {
      const text = `${f * 100}%`;
      svgNode.append(label(left + f * size, top + size + 13, text, { 'text-anchor': f === 0 ? 'start' : f === 1 ? 'end' : 'middle' }),
        label(left - 5, top + size - f * size + 4, text, { 'text-anchor': 'end' }));
    }
    svgNode.append(label(left + size / 2, H - 3, t('predict.cal.said'), { 'text-anchor': 'middle', class: 'pcal__axis' }),
      label(9, top + size / 2, t('predict.cal.happened'), { 'text-anchor': 'middle', class: 'pcal__axis', transform: `rotate(-90 9 ${top + size / 2})` }));
    for (const b of bins.filter((x) => x.n >= 3)) {
      const text = t('predict.cal.tip', { said: Math.round(b.said * 100), happened: Math.round(b.happened * 100), n: b.n });
      const dot = svg('circle', { cx: (left + b.said * size).toFixed(1), cy: (top + size - b.happened * size).toFixed(1), r: Math.min(8, 2 + Math.sqrt(b.n)).toFixed(1),
        class: 'pcal__dot', tabindex: '0' });
      const title = svg('title');
      title.textContent = text;
      dot.append(title);
      const show = () => { caption.textContent = text; };
      dot.addEventListener('click', show);
      dot.addEventListener('focus', show);
      svgNode.append(dot);
    }
    return h('figure', { class: 'pcal__fig' }, svgNode, caption);
  }

  /* ---- Google, and deleting your data ---------------------------------------------------------------------- */

  function loadGoogle() {
    if (window.google && window.google.accounts && window.google.accounts.id) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = h('script', { src: 'https://accounts.google.com/gsi/client', async: true, defer: true });
      script.onload = resolve;
      script.onerror = () => reject(new PredictError('offline', 'google'));
      document.head.append(script);
    });
  }

  /* Google's own button, on request: its script loads only when the player asks. The same flow links
     a Google account to the one in use (Me) or signs in as one (a new device). */
  function googleFlow(label, onCredential) {
    const message = h('p', { class: 'pme__msg', attrs: { 'aria-live': 'polite' } });
    const holder = h('div', { class: 'pgoogle__button' });
    const start = h('button', { type: 'button', class: 'pbtn', on: { click: async () => {
      message.textContent = t('predict.loading');
      try {
        await loadGoogle();
        window.google.accounts.id.initialize({ client_id: config.googleClientId, callback: (reply) => onCredential(reply.credential, message) });
        window.google.accounts.id.renderButton(holder, { theme: 'outline', size: 'large', text: 'signin_with', locale: lang() === 'no' ? 'nb' : 'en' });
        message.textContent = t('predict.google.pick');
      } catch (error) { message.textContent = errorText(error); }
    } } }, label);
    return { start, holder, message };
  }

  /* Back on this device with a Google account that already plays: take its history. The session
     stays (it is the Google account's now); everything else held for the old account goes. */
  async function switchToGoogle(credential, message) {
    try {
      await client.signInGoogle(credential, location.origin);
      resetLocal({ keepSession: true });
      await ensureAccount();                  // a Google account that has never played has no profile yet: it gets one now
      await boot();
    } catch (error) { message.textContent = errorText(error); }
  }

  /* The signed-out Me tab: a returning player signs in here, without tipping a match first. */
  function signInBlock() {
    const { start, holder, message } = googleFlow(t('predict.google.signin'), switchToGoogle);
    return h('div', { class: 'pgoogle' }, h('p', {}, t('predict.google.signin.why')), start, holder, message);
  }

  function googleBlock() {
    const session = client.session || {};
    if (session.google) {
      return h('div', { class: 'pgoogle' }, h('p', {}, t('predict.google.linked')),
        confirmable(t('predict.signout'), t('predict.signout.q'), () => { client.signOut(); resetLocal(); toast(t('predict.signout.done')); render(); }, 'pbtn'));
    }
    const { start, holder, message } = googleFlow(t('predict.google.link'), finish);
    async function finish(credential) {
      try {
        await client.linkGoogle(credential, location.origin);
        toast(t('predict.google.done'));
        render();
      } catch (error) {
        if (error.code === 'already_linked') {
          message.replaceChildren(t('predict.google.conflict'), ' ',
            h('button', { type: 'button', class: 'pbtn', on: { click: () => { message.textContent = t('predict.google.kept'); } } }, t('predict.google.keep')), ' ',
            confirmable(t('predict.google.switch'), t('predict.google.switch.q'), () => switchToGoogle(credential, message), 'pbtn'));
        } else message.textContent = errorText(error);
      }
    }
    return h('div', { class: 'pgoogle' }, h('p', {}, t('predict.google.why')), start, holder, message);
  }

  function dataSection(signedIn) {
    const message = h('p', { class: 'pme__msg', attrs: { 'aria-live': 'polite' } });
    const del = confirmable(t('predict.delete'), t('predict.delete.q'), async () => {
      try {
        if (client.uid) {
          await client.commit(deleteRequestWrites(config, client.uid));
          try { await client.deleteAccount(); }
          catch (error) {
            // A Google-linked account needs a fresh sign-in before Auth will delete it. The request
            // is in: the job erases the data within a few days, so this device is signed out and says so.
            if (error.code !== 'reauth') throw error;
            client.signOut();
            resetLocal();
            toast(t('predict.delete.queued'));
            render();
            return;
          }
        }
        resetLocal();
        toast(t('predict.delete.done'));
        render();
      } catch (error) { message.textContent = errorText(error); }
    });
    const data = h('section', { class: 'ppanel pdata' }, h('h2', {}, t('predict.data.title')),
      signedIn ? googleBlock() : (client.uid ? null : signInBlock()), h('p', { class: 'pmuted' }, t('predict.data.text')));
    if (!client.uid) return data;
    return h('div', { class: 'pme-data' }, data, h('section', { class: 'ppanel pdanger' }, h('h2', {}, t('predict.danger.title')), h('p', {}, t('predict.danger.text')), del, message));
  }

  /* Forget this device's Predict state: every stored key but (on request) the session, and everything
     held in memory for the player who was here, so nobody inherits another's history or drafts. */
  function resetLocal({ keepSession = false } = {}) {
    for (const key of keysToReset(store.keys(), keepSession ? sessionKey(config) : null)) store.remove(key);
    Object.values(S.timers).forEach((timer) => clearTimeout(timer));
    Object.assign(S, { meSeason: undefined, alwaysFine: false, data: {}, drafts: {}, status: {}, timers: {}, flights: {}, loading: {}, roundAt: {}, ownHash: null, stats: undefined,
      profile: undefined, history: undefined, historyAt: 0, historyLoad: null, boards: {}, boardShown: null, tables: {}, myLeagues: [],
      tut: null, replay: false, counted: new Set(), revealSeen: new Set(), ringWas: {}, leagueNote: null, leagueShown: null, leaguesFormOpen: false, leaguesFetched: false, calibration: null, tipTried: undefined, tipRefreshing: false });
    try { sessionStorage.removeItem('predict.card'); } catch (error) { /* the Overview's card asks again */ }
  }

  /* ---- the shell: a view of the site (app.js mounts it; PredictGame below) ------------------------------- */

  const TABS = ['tip', 'table', 'boards', 'leagues', 'me'];
  let active = false;                 // the view is on show; the clock and the address are the game's only then

  function renderTabs() {
    const holder = document.getElementById('predict-tabs');
    holder.replaceChildren(h('div', { class: 'switch ptabs', attrs: { role: 'group', 'aria-label': t('predict.tabs') } },
      TABS.map((tab) => h('button', { type: 'button', data: { tab }, attrs: { 'aria-pressed': String(S.tab === tab) }, on: { click: () => openTab(tab) } }, t(`predict.tab.${tab}`)))));
  }

  const pageTitle = () => (S.tab === 'tip' ? `${t('predict.title')} — EliteTracker` : `${t(`predict.tab.${S.tab}`)} · ${t('predict.title')} — EliteTracker`);

  function render() {
    if (!active) return;
    renderTabs();
    document.title = pageTitle();
    const root = document.getElementById('predict-view');
    root.replaceChildren();
    const tutorial = tutorialOn();
    root.dataset.tab = tutorial ? 'how' : S.tab;
    if (tutorial) renderTutorial(root);
    else if (S.tab === 'tip') renderTip(root);
    else if (S.tab === 'table') renderTable(root);
    else if (S.tab === 'boards') renderBoards(root);
    else if (S.tab === 'leagues') renderLeagues(root);
    else if (S.tab === 'how') renderHow(root);
    else renderMe(root);
    renderSide();
    if (S.note) toast(S.note.text, S.note.kind);
  }

  async function loadAndRender() {
    document.getElementById('predict-view').replaceChildren(h('p', { class: 'pload' }, t('predict.loading')));
    await loadIndex();
    render();
  }

  /* Each section has an address (#table, #boards, #leagues, #me), so a link can open it and Back works. */
  function openTab(tab) {
    if (tab !== S.tab) { S.leagueNote = null; S.leaguesFormOpen = false; }
    S.tab = tab;
    const hash = tab === 'tip' ? '' : `#${tab}`;
    if (location.hash !== hash) history.pushState({ n: (history.state && history.state.n) || 0 }, '', hash || location.pathname + location.search);
    render();
  }
  const ROUTES = [...TABS, 'how'];
  const tabFromHash = () => (ROUTES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'tip');
  window.addEventListener('popstate', () => { if (active) { S.tab = tabFromHash(); render(); } });
  window.addEventListener('hashchange', () => {
    const next = tabFromHash();
    if (active && next !== S.tab) { S.tab = next; render(); window.scrollTo(0, 0); }
  });

  /* The clock: the countdown keeps moving, and a match that kicks off while the page is open locks. */
  S.lastTick = now();
  setInterval(() => {
    if (!active || document.hidden || S.tab !== 'tip') { S.lastTick = now(); return; }
    const round = currentRound(S.league);
    const badge = document.getElementById('predict-badge');
    if (!round || !badge) return;
    const record = S.data[round.key] || {};
    const kicked = Object.values((record.fixture && record.fixture.slots) || {}).some((m) => m.kickoff.getTime() > S.lastTick && m.kickoff.getTime() <= now());
    S.lastTick = now();
    if (kicked || badge.dataset.status !== roundStatus(round, now())) { ensureRound(round, true).then(render); return; }
    badge.replaceWith(Object.assign(statusBadge(round), { id: 'predict-badge' }));
    document.querySelector('.pnav__status')?.replaceWith(statusLine(round));
  }, 30000);

  /* An invite link (/predict/?join=CODE) opens the mini-leagues with the code filled in; joining is still a tap. */
  function readInvite() {
    try {
      const params = new URLSearchParams(location.search);
      const code = (params.get('join') || '').trim().toUpperCase();
      if (!isLeagueCode(code)) return;
      S.pendingJoin = code;
      params.delete('join');
      const rest = params.toString();
      history.replaceState(history.state, '', `${location.pathname}${rest ? `?${rest}` : ''}#leagues`);
    } catch (error) { /* no address bar to read */ }
  }

  async function boot() {
    readInvite();
    S.tab = tabFromHash();
    const remembered = store.get('predict.league');
    if (LEAGUES.includes(remembered)) S.league = remembered;
    await loadIndex();
    if (client.uid) loadProfile();
    render();
  }

  /* The language is the site's (its settings); a signed-in player's follows them, on the profile too. */
  function followLanguage(next) {
    if (!client.uid || !S.profile) return;
    const locale = next === 'no' ? 'nb' : 'en';
    if (S.profile.locale === locale) return;
    client.commit(profileUpdateWrites(config, client.uid, { locale })).then(() => { S.profile = { ...S.profile, locale }; }).catch(() => { /* a convenience only */ });
  }

  /* The sticky round bar and side panel sit under the site's masthead, whatever its height. */
  function measureMasthead() {
    const masthead = document.querySelector('.masthead');
    const height = masthead && getComputedStyle(masthead).position === 'sticky' ? masthead.offsetHeight : 0;
    document.documentElement.style.setProperty('--predict-top', `${height}px`);
  }
  window.addEventListener('resize', () => { if (active) measureMasthead(); });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flushAll();
    if (active && document.visibilityState === 'visible' && S.tab === 'tip') { const round = currentRound(S.league); if (round && ['live', 'partial'].includes(roundStatus(round, now()))) ensureRound(round, true).then(render); }
  });

  let booted = false;
  let shownLang = null;
  window.PredictGame = {
    /* app.js draws the view: the first time boots the game, later times draw it again (a language change, a
       theme change, a return from another view). */
    show() {
      active = true;
      measureMasthead();
      if (shownLang !== null && shownLang !== lang()) followLanguage(lang());
      shownLang = lang();
      if (!booted) { booted = true; boot(); return; }
      S.tab = tabFromHash();
      render();
    },
    hide() { active = false; },
    title: pageTitle,
  };
})();
