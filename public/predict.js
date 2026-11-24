/* Predict: the prediction game's page (/predict/). Plain DOM, no framework.

   Reads stay tiny on purpose (the free Firestore plan counts them): the season's
   round index (one document), a round's fixture and reveal documents by key, your
   own entry, stats and profile, and a board by id. Nothing is ever listed from the
   public collections. predict-api.js is the network layer, predict-core.js the
   curve and scoring (pinned to Python by tests), predict-util.js the small helpers. */
(() => {
  'use strict';

  const config = predictConfig();
  const client = createClient({ config });
  const store = safeStorage();
  const LEAGUES = ['eliteserien', 'obosligaen'];
  const LEAGUE_NAME = { eliteserien: 'Eliteserien', obosligaen: 'OBOS-ligaen' };
  const SAVE_DELAY = 700;

  const S = {
    tab: 'tip', league: 'eliteserien', scope: 'season', index: null, indexError: null,
    roundAt: {}, data: {}, loading: {}, drafts: {}, status: {}, timers: {}, fine: false,
    profile: undefined, stats: undefined, board: {}, tables: {}, myLeagues: [], note: null, ownHash: null, calibration: null,
  };

  /* ---- small helpers ------------------------------------------------------------ */

  const lang = () => (currentLang === 'en' ? 'en' : 'no');
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

  async function flushSave(key) {
    clearTimeout(S.timers[key]);
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
    for (const slot of slots) {
      const [h1, d1, a1] = pickPercentages(draft[slot].g, draft[slot].k);
      changed[slot] = { g: draft[slot].g, k: draft[slot].k, h: h1, d: d1, a: a1 };
    }
    slots.forEach((slot) => setStatus(key, slot, 'saving'));
    try {
      await ensureAccount();
      await client.commit(entryWrites(config, client.uid, key, changed));
      const record = S.data[key] || (S.data[key] = {});
      const entry = record.entry || (record.entry = { curve: 1, r: key, p: {} });
      for (const slot of slots) {
        entry.p[slot] = { ...changed[slot], t: new Date(now()) };
        if (draft[slot] && draft[slot].g === changed[slot].g && draft[slot].k === changed[slot].k) delete draft[slot];
        setStatus(key, slot, 'saved');
      }
      saveDraft(key);
      store.set('predict.intro', 'seen');
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
    [...node.children].forEach((segment, i) => {
      segment.style.flex = String(Math.max(percents[i], 0.1));
      segment.textContent = labelled && labelFits(percents[i], width, segment) ? String(Math.round(percents[i])) : '';
    });
  }

  /* A club's crest from the site's own logos (by fotmob id); gone quietly when there is none. */
  function crest(id) {
    if (!id) return null;
    const img = h('img', { class: 'pteam__crest', src: `/logos/${id}.webp`, alt: '', width: 28, height: 28, loading: 'lazy', decoding: 'async' });
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
    let pos = draft ? { g: draft.g, k: draft.k } : saved ? { g: saved.g, k: saved.k } : { ...EVEN };
    let tipped = Boolean(draft || saved);
    let fine = S.fine || pos.k !== DRAW_TENTHS.normal;

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

    const pct = () => pickPercentages(pos.g, pos.k);
    const oddsBar = bar(pct());
    oddsBar.classList.add('pcard__bar');
    oddsBar.setAttribute('aria-hidden', 'true');
    // The real control for keyboards and screen readers; visually it is the bar above.
    const range = h('input', { type: 'range', class: 'pcard__range', min: GAP.min, max: GAP.max, step: GAP.step, value: pos.g,
      attrs: { 'aria-label': t('predict.slider.label', { home: info.home, away: info.away }) } });
    const control = h('div', { class: 'pslider' }, oddsBar, range);

    const panelId = `pp-${key}-${slot}`;
    const resetFine = h('button', { type: 'button', class: 'pbtn pbtn--small pcard__reset', on: { click: () => {
      pos.k = DRAW_TENTHS.normal; touch(); paint(); release();
    } } }, t('predict.fine.reset'));
    const fineRange = h('input', { type: 'range', class: 'pcard__fine-range', min: DRAW_TENTHS.min, max: DRAW_TENTHS.max, step: 1,
      value: pos.k, attrs: { 'aria-label': t('predict.fine.label') } });
    const fineValue = h('output', { class: 'pcard__fine-value' });
    const inputs = {};
    const readout = h('div', { class: 'pcard__readout' });
    for (const outcome of ['h', 'd', 'a']) {
      const input = h('input', { type: 'text', class: 'pcard__num', value: '', attrs: { inputmode: 'decimal', 'aria-label': t(`predict.readout.${outcome}`) } });
      inputs[outcome] = input;
      readout.append(h('label', { class: `pcard__num-wrap pcard__num-wrap--${outcome}` }, h('span', {}, outcomeLabel[outcome]()), input));
      input.addEventListener('change', () => {
        const typed = parseNumber(input.value);
        if (Number.isNaN(typed)) { paint(); return; }
        pos = nearestPosition(outcome, Math.round(typed), pos.g, pos.k, fine);
        touch(); paint(); release();
      });
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
    }
    const panel = h('div', { class: 'pcard__panel', id: panelId, hidden: !fine },
      h('label', { class: 'pcard__fine' }, h('span', {}, t('predict.fine.title')), fineRange, fineValue),
      h('p', { class: 'pcard__hint' }, t('predict.fine.hint')), readout, resetFine);
    const fineButton = h('button', { type: 'button', class: 'pcard__more', attrs: { 'aria-expanded': String(fine), 'aria-controls': panelId } }, t('predict.fine'));
    const status = h('span', { class: 'pcard__status', attrs: { 'aria-live': 'polite' } });
    const reading = h('p', { class: 'pcard__read' });
    const nums = h('p', { class: 'pcard__nums', attrs: { 'aria-hidden': 'true' } });
    const clearButton = h('button', { type: 'button', class: 'pcard__more pcard__clear', hidden: true, on: { click: () => clearPick() } }, t('predict.clear'));
    card.append(control, nums, reading, h('div', { class: 'pcard__foot' }, status, h('span', { class: 'pcard__acts' }, clearButton, fineButton)), panel);
    let favourite = favouriteOf(pct());

    function paint() {
      const p = pct();
      paintBar(oddsBar, p);
      range.value = pos.g;
      range.setAttribute('aria-valuetext', t('predict.slider.value', { h: p[0], d: p[1], a: p[2] }));
      fineRange.value = pos.k;
      fineValue.textContent = `${fixed(pos.k / 10, 1)}×`;
      resetFine.hidden = pos.k === DRAW_TENTHS.normal;
      ['h', 'd', 'a'].forEach((o, i) => { if (document.activeElement !== inputs[o]) inputs[o].value = String(p[i]); });
      card.dataset.state = tipped ? 'tipped' : 'untouched';
      reading.textContent = tipped ? pickReading(p, info) : '';
      nums.textContent = `${t('predict.h')} ${p[0]} · ${t('predict.d')} ${p[1]} · ${t('predict.a')} ${p[2]}`;   // exact numbers on every card, even where a narrow segment shows none
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
      if (st.state === 'saving') status.textContent = t('predict.saving');
      else if (st.state === 'error') {
        status.replaceChildren(`${t('predict.notsaved')} ${st.message || ''} `,
          h('button', { type: 'button', class: 'pcard__retry', on: { click: () => flushSave(key) } }, t('predict.retry')));
      }
      else if (!tipped) status.textContent = t('predict.drag');
      else if (current && !((S.drafts[key] || {})[slot])) {
        const at = current.t instanceof Date ? current.t : new Date(now());
        status.textContent = spanParts(now() - at.getTime()).unit === 'now' ? t('predict.saved.now') : t('predict.saved', { ago: agoText(at) });
        state = 'saved';
      }
      else status.textContent = t('predict.pending');
      status.dataset.state = state;
    };

    function touch() {
      tipped = true;
      loadDraft(key)[slot] = { g: pos.g, k: pos.k };
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
      pos = { ...EVEN };
      paint();
      paintRing();
    }

    range.addEventListener('input', () => { pos.g = Number(range.value); touch(); paint(); });
    range.addEventListener('change', release);
    // A keyboard user can accept the even 37 / 26 / 37 without nudging the slider away and back.
    range.addEventListener('keydown', (event) => {
      if (!tipped && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); touch(); paint(); release(); }
    });
    fineRange.addEventListener('input', () => { pos.k = Number(fineRange.value); touch(); paint(); });
    fineRange.addEventListener('change', release);
    fineButton.addEventListener('click', () => {
      fine = !fine; S.fine = fine; panel.hidden = !fine;
      fineButton.setAttribute('aria-expanded', String(fine));
      paint();
    });

    // Dragging on the bar itself; the page still scrolls up and down (touch-action: pan-y in the css).
    let dragging = false;
    let armed = null;                       // a finger down on a card nobody has tipped yet: not a pick until it drags sideways
    const move = (event) => {
      const box = oddsBar.getBoundingClientRect();
      pos.g = gapUnder((event.clientX - box.left) / box.width);
      touch(); paint();
    };
    const begin = (event) => { dragging = true; card.classList.add('is-dragging'); capture(oddsBar, event); move(event); };
    oddsBar.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' || tipped) begin(event);       // a click, or a card already tipped: at once
      else armed = { x: event.clientX, y: event.clientY };            // a scroll that starts on the bar must not leave a pick behind
    });
    oddsBar.addEventListener('pointermove', (event) => {
      if (armed) {
        const dx = Math.abs(event.clientX - armed.x);
        if (dx > 8 && dx > Math.abs(event.clientY - armed.y)) { armed = null; begin(event); }
        return;
      }
      if (dragging) move(event);
    });
    const stop = () => { armed = null; if (dragging) { dragging = false; card.classList.remove('is-dragging'); release(); } };
    oddsBar.addEventListener('pointerup', stop);
    oddsBar.addEventListener('pointercancel', stop);

    paint();
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
      const median = reveal.crowd && reveal.crowd.med ? signed(reveal.crowd.med.b - own.brier) : null;
      const item = (label, value) => [h('dt', {}, label), h('dd', {}, value)];
      parts.push(h('details', { class: 'pdetails' }, h('summary', {}, t('predict.details')),
        h('dl', {}, item(t('predict.details.vs'), signed(own.vsModel)),
          item(t('predict.details.median'), median !== null ? median : reveal.crowd ? t('predict.median.later') : t('predict.median.nocrowd')),
          item('Brier', fixed(own.brier, 2)), item('RPS', fixed(own.rps, 2))),
        h('p', {}, t('predict.details.help'))));
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
    let best = null;
    for (const [slot, info] of Object.entries(reveal)) {
      if (!entry[slot]) continue;
      tipped += 1;
      if (!info.result || !info.model) continue;
      const own = scoreOwnPick(storedPercents(entry[slot]), [info.model.h, info.model.d, info.model.a], outcomeOf(info.result.hg, info.result.ag));
      if (own.vsModel > 0) beat += 1;
      if (!best || own.vsModel > best.vs) best = { slot, vs: own.vsModel };
    }
    const total = record.fixture && record.fixture.slots ? Object.keys(record.fixture.slots).length : Object.keys(reveal).length;
    return tipped ? { tipped, beat, best, total } : null;
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
    svg.innerHTML = `<circle class="pring__track" cx="18" cy="18" r="15"/><circle class="pring__arc" cx="18" cy="18" r="15" stroke-dasharray="${(circumference * state.fraction).toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 18 18)"/>`;
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

  function statusBadge(round) {
    const status = roundStatus(round, now());
    const text = status === 'future' ? t('predict.status.future', { span: spanText(round.opens.getTime() - now()) })
      : status === 'open' ? t('predict.status.open', { span: spanText(round.closes.getTime() - now()) })
      : status === 'live' ? t('predict.status.live') : status === 'partial' ? t('predict.status.partial') : t('predict.status.done');
    const soon = status === 'open' && round.closes.getTime() - now() < 86400000;
    return h('span', { class: 'pbadge', data: { status, soon: String(soon) } }, text);
  }

  /* How it works, shown until it is dismissed or the first pick is saved. */
  function introPanel() {
    if (store.get('predict.intro') === 'seen') return null;
    const ok = h('button', { type: 'button', class: 'pbtn pbtn--small' }, t('predict.intro.ok'));
    const box = h('section', { class: 'phow', attrs: { 'aria-labelledby': 'phow-title' } },
      h('h2', { id: 'phow-title' }, t('predict.intro.title')),
      h('ol', { class: 'phow__steps' }, ['1', '2', '3'].map((n) => h('li', {}, t(`predict.intro.step${n}`)))),
      h('div', { class: 'phow__actions' }, ok, h('a', { href: '#how', class: 'plink' }, t('predict.intro.more'))));
    ok.addEventListener('click', () => { store.set('predict.intro', 'seen'); box.remove(); });
    return box;
  }

  function renderTip(root) {
    const intro = introPanel();
    if (intro) root.append(intro);
    root.append(leagueSwitch(render));
    const rounds = leagueRounds(S.league);
    if (S.indexError || !rounds.length) { root.append(emptyState(S.indexError, loadAndRender, 'predict.empty.rounds')); return; }
    const round = currentRound(S.league);
    const at = rounds.indexOf(round);
    const status = roundStatus(round, now());
    const go = (to) => { S.roundAt[S.league] = to; render(); };
    const nav = h('div', { class: 'pnav' },
      h('div', { class: 'pnav__round' },
        h('button', { type: 'button', class: 'pbtn pbtn--icon', disabled: at <= 0, attrs: { 'aria-label': t('predict.round.prev') }, on: { click: () => go(at - 1) } }, '‹'),
        h('div', { class: 'pnav__titles' },
          h('h2', { class: 'pnav__title' }, t('predict.round', { n: round.round })),
          h('span', { class: 'pnav__dates' }, roundDates(round.closes, round.last || round.closes)),
          h('select', { class: 'pnav__pick', attrs: { 'aria-label': t('predict.round.pick') }, on: { change: (e) => go(Number(e.target.value)) } },
            rounds.map((r, i) => h('option', { value: String(i), selected: i === at }, `${t('predict.round', { n: r.round })} · ${t(`predict.pstatus.${roundStatus(r, now())}`)}`)))),
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
      return days.map((d) => h('section', { class: 'pday' }, h('h3', { class: 'pday__title' }, dayTitle(d.date)),
        h('ol', { class: 'plist' }, d.keys.map(make))));
    };
    const recap = recapOf(round, record);
    if (recap) {
      const best = recap.best && recap.best.vs > 0 ? slots[recap.best.slot] : null;
      const mineRound = S.stats && S.stats.rounds && S.stats.rounds[round.key];
      const text = t('predict.recap', { tipped: recap.tipped, total: recap.total, round: round.round, beat: recap.beat })
        + (best ? ` ${t('predict.recap.best', { match: `${best.home}–${best.away}` })}` : '');
      const stat = (value, label) => h('div', { class: 'precap__stat' }, h('strong', {}, value), h('span', {}, label));
      out.append(h('section', { class: 'precap', attrs: { 'aria-label': t('predict.recap.title') } },
        h('div', { class: 'precap__stats' },
          stat(`${recap.tipped}/${recap.total}`, t('predict.recap.tipped')),
          stat(String(recap.beat), t('predict.recap.beat')),
          mineRound ? stat(signed(mineRound.ab), t('predict.recap.acc')) : null,
          best ? stat(`${best.home}–${best.away}`, t('predict.recap.bestLabel')) : null),
        h('span', { class: 'precap__share' },
          h('button', { type: 'button', class: 'pbtn pbtn--small', on: { click: () => shareText(text) } }, t('predict.share')),
          h('button', { type: 'button', class: 'pbtn pbtn--small', on: { click: () => shareCard(round, recap, mineRound ? mineRound.ab : null, best ? `${best.home}–${best.away}` : null) } }, t('predict.share.picture')))));
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
    out.append(h('p', { class: 'pfoot' }, h('a', { href: '/predict/rounds.ics' }, t('predict.calendar')),
      status === 'live' || status === 'partial' ? h('button', { type: 'button', class: 'pbtn pbtn--small', on: { click: () => ensureRound(round, true).then(render) } }, t('predict.refresh')) : null));
    return out;
  }

  /* The recap as a picture: a square card drawn on a canvas of its own, handed to the share sheet as a
     file where the browser can, and downloaded where it cannot. */
  async function shareCard(round, recap, accuracy, bestMatch) {
    const size = 1080;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const font = (weight, px) => { ctx.font = `${weight} ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`; };
    const text = (value, x, y, { px = 40, weight = 600, color = '#e8edf5', align = 'left' } = {}) => {
      font(weight, px); ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(value, x, y);
    };
    ctx.fillStyle = '#080f1c';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#1f5eff';
    ctx.fillRect(0, 0, size, 14);
    text('Predict', 80, 150, { px: 96, weight: 800 });
    text(`${LEAGUE_NAME[round.league]} · ${t('predict.round', { n: round.round })}`, 80, 215, { px: 44, color: '#98a3b7' });
    const stats = [[`${recap.tipped}/${recap.total}`, t('predict.recap.tipped')], [String(recap.beat), t('predict.recap.beat')]];
    if (accuracy !== null) stats.push([signed(accuracy), t('predict.recap.acc')]);
    const column = (size - 160) / stats.length;
    stats.forEach(([value, label], i) => {
      const x = 80 + column * i + column / 2;
      ctx.fillStyle = '#111929';
      ctx.fillRect(80 + column * i + 8, 330, column - 16, 340);
      text(value, x, 520, { px: 120, weight: 800, align: 'center', color: i === 2 && accuracy !== null ? (accuracy >= 0 ? '#588cff' : '#f4514f') : '#e8edf5' });
      text(label, x, 600, { px: 38, color: '#98a3b7', align: 'center' });
    });
    if (bestMatch) text(t('predict.recap.best', { match: bestMatch }), 80, 790, { px: 46, weight: 700 });
    text(`${location.host}/predict/`, 80, 990, { px: 44, weight: 700, color: '#588cff' });
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) { toast(t('predict.err.generic'), 'error'); return; }
    const file = new File([blob], `predict-round-${round.round}.png`, { type: 'image/png' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Predict' }); return; }
    } catch (error) { return; }                                   // the player closed the sheet
    const link = h('a', { href: URL.createObjectURL(blob), download: file.name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  }

  async function shareText(text) {
    const full = `${text} ${location.origin}/predict/`;
    try { if (navigator.share) { await navigator.share({ title: 'Predict', text: full }); return; } } catch (error) { return; }
    try { await navigator.clipboard.writeText(full); toast(t('predict.copied')); } catch (error) { toast(full); }
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
    const body = h('div', {}, h('p', { class: 'pload' }, t('predict.loading')));
    root.append(body);
    if (!season) { body.replaceChildren(emptyState(S.indexError, loadAndRender, 'predict.empty.rounds')); return; }
    const key = `${season}_${S.league}`;
    try {
      const game = await client.get(`tablegames/${key}`);
      const mine = client.uid ? await client.get(`tables/${client.uid}/picks/${key}`) : null;
      const extras = {};
      if (game && now() >= game.closes.getTime()) {
        // Once it has closed: the final result if the season is over, otherwise the table as it stands.
        // (each read on its own: if one fails the panel it feeds is left out, not the whole tab)
        try { extras.board = await client.get(`boards/tables_${key}`); } catch (error) { extras.board = null; }
        if (!extras.board) { try { extras.standings = await client.get('meta/standings'); } catch (error) { extras.standings = null; } }
        if (client.uid && S.stats === undefined) { try { S.stats = await client.get(`stats/${client.uid}`); } catch (error) { S.stats = null; } }
      }
      if (S.tab !== 'table') return;
      body.replaceChildren(tableBody(key, game, mine, extras, season));
    } catch (error) { body.replaceChildren(emptyState(error, render)); }
  }

  /* The scored result of the table game: your error and accuracy, and the board (the model stands on it too). */
  function tableResults(key, board) {
    const own = S.stats && S.stats.tables && S.stats.tables[key];
    const rows = (board.rows || []).map((row) => h('tr', { class: 'pboard__row', data: { kind: row.kind, mine: String(Boolean(S.ownHash && row.u === S.ownHash)) } },
      h('td', { class: 'pboard__rank' }, String(row.rank)), h('td', { class: 'pboard__name' }, h('span', { class: 'pboard__nick' }, row.nick || t('predict.anon'))),
      h('td', {}, String(row.error)), h('td', { class: 'pboard__ab', data: { tone: row.accuracy > 0.00005 ? 'good' : row.accuracy < -0.00005 ? 'bad' : 'even' } }, signed(row.accuracy))));
    return h('section', { class: 'ptable__results' }, h('h3', {}, t('predict.table.result.title')),
      own ? h('p', { class: 'pboard__me' }, t('predict.table.result.you', { error: own.error, acc: signed(own.accuracy) })) : h('p', { class: 'pmuted' }, t('predict.table.result.none')),
      h('div', { class: 'pboard' }, h('div', { class: 'pscroll' }, h('table', {},
        h('thead', {}, h('tr', {}, ['rank', 'name'].map((c) => h('th', { scope: 'col', class: `pboard__${c}` }, t(`predict.col.${c}`))),
          h('th', { scope: 'col' }, t('predict.table.col.error')), h('th', { scope: 'col' }, t('predict.table.col.acc')))),
        h('tbody', {}, rows))),
      h('p', { class: 'pboard__note' }, t('predict.table.result.note', { players: groupThousands(board.players || 0, lang()) }))));
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
        h('span', { class: 'ptable__pos' }, String(i + 1)), h('span', { class: 'ptable__name' }, game.names[id]),
        h('span', { class: 'ptable__now', data: { tone: diff === 0 ? 'good' : 'even' }, attrs: { 'aria-label': t('predict.table.now.aria', { club: game.names[id], place: now_ + 1 }) } },
          diff === 0 ? `= ${now_ + 1}` : `${diff > 0 ? '↓' : '↑'} ${now_ + 1}`));
    });
    return h('section', { class: 'ptable__checkpoint' }, h('h3', {}, t('predict.table.now.title')),
      h('p', { class: 'pmuted' }, t('predict.table.now.text', { n: league.played, d: dist })), h('ol', { class: 'ptable ptable--now' }, items));
  }

  function tableBody(key, game, mine, extras = {}, season) {
    const bonus = TABLE_BONUS[S.league];
    const rules = h('p', { class: 'ptable__rules' }, t(S.league === 'eliteserien' ? 'predict.table.rules.es' : 'predict.table.rules.obos', { champion: bonus.champion, promotion: bonus.promotion, relegation: bonus.relegation }));
    if (!game) return h('div', {}, h('p', { class: 'pempty' }, t('predict.table.none')), rules);
    const nowMs = now();
    const state = nowMs < game.opens.getTime() ? 'soon' : nowMs >= game.closes.getTime() ? 'closed' : 'open';
    const zoneOf = (i, n) => (S.league === 'eliteserien' ? (i === 0 ? 'champion' : i >= n - 2 ? 'relegation' : '')
      : (i < 2 ? 'promotion' : i >= n - 2 ? 'relegation' : ''));
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
          h('span', { class: 'ptable__pos' }, String(i + 1)), h('span', { class: 'ptable__name' }, game.names[id]))));
        parts.push(frozen);
        const checkpoint = !extras.board && extras.standings ? tableCheckpoint(order, game, extras.standings) : null;
        if (checkpoint) parts.push(checkpoint);
      }
      parts.push(rules);
      return h('div', {}, ...parts);
    }
    const list = h('ol', { class: 'ptable', data: { state } });
    const status = h('p', { class: 'ptable__status', attrs: { 'aria-live': 'polite' } });
    const keep = () => { if (state === 'open') { try { store.set(draftId, JSON.stringify(order)); } catch (error) { /* a convenience only */ } } };
    const paint = () => {
      list.replaceChildren(...order.map((id, i) => {
        const row = h('li', { class: 'ptable__row', data: { id, zone: zoneOf(i, order.length) } },
          h('span', { class: 'ptable__pos' }, String(i + 1)), h('span', { class: 'ptable__name' }, game.names[id]));
        if (state === 'open') {
          const handle = h('button', { type: 'button', class: 'ptable__grip', attrs: { 'aria-label': t('predict.table.drag', { club: game.names[id] }) } }, '⋮⋮');
          const up = h('button', { type: 'button', class: 'pbtn pbtn--icon', data: { move: 'up' }, attrs: { 'aria-label': t('predict.table.up', { club: game.names[id] }) }, disabled: i === 0, on: { click: () => shift(i, -1) } }, '↑');
          const down = h('button', { type: 'button', class: 'pbtn pbtn--icon', data: { move: 'down' }, attrs: { 'aria-label': t('predict.table.down', { club: game.names[id] }) }, disabled: i === order.length - 1, on: { click: () => shift(i, 1) } }, '↓');
          grip(handle, row);
          row.append(handle, up, down);
        }
        return row;
      }));
      status.textContent = state === 'soon' ? t('predict.table.soon', { span: spanText(game.opens.getTime() - now()) })
        : saved ? t('predict.table.saved') : t('predict.table.unsaved', { span: spanText(game.closes.getTime() - now()) });
    };
    const legend = h('ul', { class: 'pzones', attrs: { 'aria-label': t('predict.zones') } },
      (S.league === 'eliteserien' ? ['champion', 'relegation'] : ['promotion', 'relegation']).map((z) => h('li', { data: { zone: z } }, t(`predict.zone.${z}`))));
    // A move redraws the list; the focus goes with the club, to the same arrow (or the other at an end).
    const shift = (i, by) => {
      const [moved] = order.splice(i, 1);
      order.splice(i + by, 0, moved);
      saved = false; keep(); paint();
      const row = list.children[i + by];
      const want = row && (row.querySelector(`[data-move="${by < 0 ? 'up' : 'down'}"]:not(:disabled)`) || row.querySelector('[data-move]:not(:disabled)'));
      if (want) want.focus();
    };
    function grip(handle, row) {
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        capture(handle, event);
        row.classList.add('is-dragging');
        const move = (e) => {
          const under = document.elementFromPoint(e.clientX, e.clientY);
          const target = under && under.closest && under.closest('.ptable__row');
          if (!target || target === row || !list.contains(target)) return;
          const from = order.indexOf(row.dataset.id);
          const to = order.indexOf(target.dataset.id);
          const [moved] = order.splice(from, 1);
          order.splice(to, 0, moved);
          saved = false;
          list.insertBefore(row, from < to ? target.nextSibling : target);
          [...list.children].forEach((li, n) => { li.querySelector('.ptable__pos').textContent = String(n + 1); });
        };
        const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); keep(); paint(); };
        handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
      });
    }
    const save = h('button', { type: 'button', class: 'pbtn pbtn--primary', hidden: state !== 'open', on: { click: async () => {
      status.textContent = t('predict.saving');
      try {
        await ensureAccount();
        await client.commit(tableWrites(config, client.uid, key, order));
        saved = true;
        store.remove(draftId); store.remove(`predict.tabledraft.new.${key}`);
        paint();
      } catch (error) { status.textContent = `${t('predict.notsaved')} ${errorText(error)}`; }
    } } }, t('predict.table.save'));
    paint();
    return h('div', {}, legend, list, h('div', { class: 'ptable__bar', hidden: state !== 'open' }, status, save), state === 'open' ? null : status, rules);
  }

  /* ---- boards ---------------------------------------------------------------------------------------------- */

  async function renderBoards(root) {
    const current = S.index && S.index.season;
    const scopes = ['season', 'round', 'last10'];
    const season = S.boardSeason && current && S.boardSeason <= current ? S.boardSeason : current;
    const seasons = current ? [0, 1, 2, 3].map((back) => current - back) : [];
    const seasonPick = h('select', { class: 'pfield pfield--pick', attrs: { 'aria-label': t('predict.board.season') }, on: { change: (e) => { S.boardSeason = Number(e.target.value); S.boardRound = {}; render(); } } },
      seasons.map((s) => h('option', { value: String(s), selected: s === season }, String(s))));
    // Rounds already scored this season, newest first: any of them has a board of its own.
    const scored = season === current ? leagueRounds(S.league).filter((r) => (Number.isInteger(r.settled) ? r.settled > 0 : roundStatus(r, now()) !== 'future')).reverse() : [];
    const pickedRound = (S.boardRound || {})[S.league] || null;
    const roundPick = S.scope === 'round' && scored.length
      ? h('select', { class: 'pfield pfield--pick', attrs: { 'aria-label': t('predict.round.pick') }, on: { change: (e) => { S.boardRound = { ...(S.boardRound || {}), [S.league]: Number(e.target.value) || null }; render(); } } },
        scored.map((r, i) => h('option', { value: String(i === 0 ? 0 : r.round), selected: i === 0 ? !pickedRound : pickedRound === r.round }, t('predict.round', { n: r.round }))))
      : null;
    root.append(h('div', { class: 'ptoolbar' }, leagueSwitch(render),
      h('div', { class: 'switch', attrs: { role: 'group', 'aria-label': t('predict.scope') } },
        scopes.map((scope) => h('button', { type: 'button', attrs: { 'aria-pressed': String(S.scope === scope) }, on: { click: () => { S.scope = scope; render(); } } }, t(`predict.scope.${scope}`)))),
      seasonPick, roundPick));
    const body = h('div', {}, h('p', { class: 'pload' }, t('predict.loading')));
    root.append(body);
    if (!season) { body.replaceChildren(emptyState(S.indexError, loadAndRender, 'predict.empty.rounds')); return; }
    const id = S.scope === 'round' && pickedRound ? `round_${season}_${S.league}_${pickedRound}` : `${S.scope}_${season}_${S.league}`;
    try {
      if (client.uid && !S.ownHash) S.ownHash = await uidHash(client.uid);
      const board = await client.get(`boards/${id}`);
      if (S.tab !== 'boards') return;
      body.replaceChildren(boardTable(board));
      if (client.uid && S.stats === undefined) { try { S.stats = await client.get(`stats/${client.uid}`); } catch (error) { S.stats = null; } }
      if (S.tab === 'boards') body.append(percentileNote(board, season));
    } catch (error) { body.replaceChildren(emptyState(error, render)); }
    root.append(leaguesSection());
  }

  /* Columns that sort, and which way is better the first time they are pressed. */
  const BOARD_COLUMNS = [['rank', 'asc'], ['name', 'asc'], ['n', 'desc'], ['ab', 'desc'], ['ar', 'desc'], ['b', 'asc'], ['r', 'asc'], ['streak', 'desc']];

  function sortedRows(rows, sort) {
    if (!sort || sort.col === 'rank') return sort && sort.dir === 'desc' ? rows.slice().reverse() : rows;
    const key = sort.col === 'name' ? (r) => String(r.nick || '').toLowerCase() : (r) => r[sort.col];
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

  function boardTable(board) {
    if (!board || !board.rows || !board.rows.length) return h('p', { class: 'pempty' }, t('predict.board.empty'));
    const tone = (value) => (value > 0.00005 ? 'good' : value < -0.00005 ? 'bad' : 'even');
    const tbody = h('tbody', {});
    const headRow = h('tr', {});
    let sort = null;
    const mineRow = () => board.rows.find((r) => S.ownHash && r.u === S.ownHash);
    const paintRows = () => {
      tbody.replaceChildren(...sortedRows(board.rows, sort).map((row) => {
        const mine = Boolean(S.ownHash && row.u === S.ownHash);
        const name = h('td', { class: 'pboard__name' }, h('span', { class: 'pboard__nick' }, row.nick || t('predict.anon')));
        if (mine) name.append(h('span', { class: 'ptag ptag--you' }, t('predict.tag.you')));
        else if (row.kind === 'model' || row.kind === 'crowd') name.append(h('span', { class: `ptag ptag--${row.kind}` }, t(`predict.tag.${row.kind}`)));
        else if (row.kind === 'player' && row.nick) name.append(reportControl(row));
        return h('tr', { class: 'pboard__row', tabIndex: -1, data: { kind: row.kind, mine: String(mine) } },
          h('td', { class: 'pboard__rank' }, String(row.rank)), name, h('td', {}, String(row.n)),
          h('td', { class: 'pboard__ab', data: { tone: tone(row.ab) } }, signed(row.ab)),
          h('td', {}, signed(row.ar)),
          h('td', {}, row.b === null ? '–' : fixed(row.b, 2)), h('td', {}, row.r === null ? '–' : fixed(row.r, 2)),
          h('td', {}, row.streak === null || row.streak === undefined ? '–' : String(row.streak)));
      }));
    };
    const paintHead = () => headRow.replaceChildren(...BOARD_COLUMNS.map(([c, first]) => {
      const active = (sort || { col: 'rank' }).col === c;
      const dir = active ? (sort || { dir: 'asc' }).dir : 'none';
      return h('th', { scope: 'col', class: `pboard__${c}`, attrs: { 'aria-sort': dir === 'none' ? 'none' : dir === 'asc' ? 'ascending' : 'descending' } },
        h('button', { type: 'button', class: 'pboard__sort', on: { click: () => {
          sort = active && sort ? { col: c, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { col: c, dir: first };
          if (sort.col === 'rank' && sort.dir === 'asc') sort = null;
          paintHead(); paintRows();
        } } }, t(`predict.col.${c}`), h('span', { class: 'pboard__arrow', attrs: { 'aria-hidden': 'true' } }, dir === 'asc' ? ' ▲' : dir === 'desc' ? ' ▼' : '')));
    }));
    paintHead();
    paintRows();
    const jump = mineRow() ? h('button', { type: 'button', class: 'pbtn pbtn--small pboard__jump', on: { click: () => {
      const row = tbody.querySelector('[data-mine="true"]');
      if (row) { row.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); row.focus({ preventScroll: true }); }
    } } }, t('predict.board.jump')) : null;
    return h('div', { class: 'pboard' }, h('p', { class: 'pboard__key' }, t('predict.board.key')), jump,
      h('div', { class: 'pscroll' }, h('table', {}, h('thead', {}, headRow), tbody)),
      h('p', { class: 'pboard__note' }, t('predict.board.note', { players: groupThousands(board.players || 0, lang()) })));
  }

  function percentileNote(board, season) {
    if (S.scope !== 'season' || !board || !board.pct || !board.pct.length || !S.stats) return h('span');
    const mine = seasonTotals(S.stats, season, S.league);
    if (!mine.n) return h('p', { class: 'pboard__me' }, t('predict.board.nonescored'));
    const beat = beatShare(board.pct, mine.ab, board.players);
    const own = S.ownHash && board.rows.find((r) => r.u === S.ownHash);
    return h('p', { class: 'pboard__me' }, own ? t('predict.board.you.listed', { rank: own.rank, beat })
      : t('predict.board.you', { beat, ab: signed(mine.ab), n: mine.n }));
  }

  /* The codes of the leagues a player is in: on the profile (so they follow a Google sign-in to another
     device) and, with the names, in this browser. */
  const profileLeagues = () => ((S.profile && Array.isArray(S.profile.leagues)) ? S.profile.leagues : []);

  function leaguesSection() {
    S.myLeagues = json(store.get('predict.leagues'), []);
    const box = h('section', { class: 'pleagues' }, h('h2', {}, t('predict.leagues.title')), h('p', { class: 'pintro' }, t('predict.leagues.intro')));
    const shown = h('div', { class: 'pleagues__board' });
    const list = h('ul', { class: 'pleagues__list' });
    const nameInput = h('input', { type: 'text', class: 'pfield', maxLength: 30, attrs: { 'aria-label': t('predict.leagues.name'), placeholder: t('predict.leagues.name') } });
    const codeInput = h('input', { type: 'text', class: 'pfield', maxLength: 8, value: S.pendingJoin || '', attrs: { 'aria-label': t('predict.leagues.code'), placeholder: t('predict.leagues.code'), autocapitalize: 'characters' } });
    const message = h('p', { class: 'pleagues__msg', attrs: { 'aria-live': 'polite' } });
    message.textContent = S.leagueNote || (S.pendingJoin ? t('predict.leagues.invited') : '');
    const saveLocal = () => store.set('predict.leagues', JSON.stringify(S.myLeagues));
    const inviteLink = (code) => `${location.origin}/predict/?join=${code}#boards`;
    const copy = async (text) => { try { await navigator.clipboard.writeText(text); toast(t('predict.copied')); } catch (error) { toast(text); } };

    function paintList() {
      list.replaceChildren(...S.myLeagues.map((entry) => h('li', { class: 'pleagues__item' },
        h('button', { type: 'button', class: 'pchip', on: { click: () => showLeague(entry.code, shown) } }, h('span', {}, entry.name), h('code', {}, entry.code)),
        h('button', { type: 'button', class: 'pbtn pbtn--small', attrs: { 'aria-label': t('predict.leagues.copyFor', { name: entry.name }) }, on: { click: () => copy(inviteLink(entry.code)) } }, t('predict.leagues.copy')),
        confirmable(t('predict.leagues.leave'), t('predict.leagues.leave.q', { name: entry.name }), () => leave(entry), 'pbtn pbtn--small'))));
    }

    /* Join and the profile's list of codes go in one commit: the job purges memberships from that list. */
    const joinWrites = (code) => [...leagueJoinWrites(config, client.uid, code),
      ...profileUpdateWrites(config, client.uid, { leagues: [...new Set([...profileLeagues(), code])] })];
    const remember = (code, name) => {
      if (!S.myLeagues.some((e) => e.code === code)) S.myLeagues.push({ code, name });
      saveLocal();
      S.profile = { ...S.profile, leagues: [...new Set([...profileLeagues(), code])] };
    };
    async function leave(entry) {
      try {
        const rest = profileLeagues().filter((c) => c !== entry.code);
        await client.commit([writeDelete(config, `leagues/${entry.code}/members/${client.uid}`), ...profileUpdateWrites(config, client.uid, { leagues: rest })]);
        S.myLeagues = S.myLeagues.filter((e) => e.code !== entry.code);
        saveLocal();
        S.profile = { ...S.profile, leagues: rest };
        shown.replaceChildren();
        paintList();
        message.textContent = t('predict.leagues.left', { name: entry.name });
      } catch (error) { message.textContent = errorText(error); }
    }

    const create = h('button', { type: 'button', class: 'pbtn', on: { click: async () => {
      const name = nameInput.value.trim();
      if (name.length < 2) { message.textContent = t('predict.leagues.shortname'); return; }
      try {
        await ensureAccount();
        const code = newLeagueCode();
        await client.commit(leagueCreateWrites(config, client.uid, code, name));
        await client.commit(joinWrites(code));
        remember(code, name);
        S.leagueNote = t('predict.leagues.created', { code });       // kept across the redraw, with a link to copy
        S.leagueCode = code;
        render();
      } catch (error) { message.textContent = errorText(error); }
    } } }, t('predict.leagues.create'));
    const join = h('button', { type: 'button', class: 'pbtn', on: { click: async () => {
      const code = codeInput.value.trim().toUpperCase();
      if (!isLeagueCode(code)) { message.textContent = t('predict.leagues.badcode'); return; }
      try {
        await ensureAccount();
        const found = await client.get(`leagues/${code}`);
        if (!found) { message.textContent = t('predict.leagues.nolatest'); return; }
        await client.commit(joinWrites(code));
        remember(code, found.name);
        S.pendingJoin = null;
        S.leagueNote = t('predict.leagues.joined', { name: found.name });
        S.leagueCode = null;
        render();
      } catch (error) { message.textContent = errorText(error); }
    } } }, t('predict.leagues.join'));
    box.append(list,
      h('div', { class: 'pleagues__forms' },
        h('label', { class: 'pfieldset' }, h('span', {}, t('predict.leagues.create')), h('span', { class: 'pinline' }, nameInput, create)),
        h('label', { class: 'pfieldset' }, h('span', {}, t('predict.leagues.join')), h('span', { class: 'pinline' }, codeInput, join))),
      message,
      S.leagueCode ? h('button', { type: 'button', class: 'pbtn pbtn--small', on: { click: () => copy(inviteLink(S.leagueCode)) } }, t('predict.leagues.copy')) : null,
      shown);
    paintList();

    // Leagues joined on another device: the profile has their codes, the names are one read each.
    const missing = profileLeagues().filter((code) => !S.myLeagues.some((e) => e.code === code));
    if (missing.length && client.uid) {
      Promise.all(missing.map(async (code) => { try { const found = await client.get(`leagues/${code}`); return found ? { code, name: found.name } : null; } catch (error) { return null; } }))
        .then((found) => {
          found.filter(Boolean).forEach((entry) => { if (!S.myLeagues.some((e) => e.code === entry.code)) S.myLeagues.push(entry); });
          saveLocal();
          if (found.some(Boolean)) paintList();
        });
    }
    return box;
  }

  async function showLeague(code, target) {
    target.replaceChildren(h('p', { class: 'pload' }, t('predict.loading')));
    try {
      const board = await client.get(`boards/league_${code}`);
      target.replaceChildren(boardTable(board));
    } catch (error) { target.replaceChildren(emptyState(error, () => showLeague(code, target))); }
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
      h('p', { class: 'ph2h__follow' }, followGain > 0 ? t('predict.style.follow.worse', { d: fixed(followGain, 2) })
        : t('predict.style.follow.better', { d: fixed(-followGain, 2) })));

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
      return h('li', {}, h('strong', {}, `${r.home}–${r.away} ${r.hg}–${r.ag}`),
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

  const SIDE_TABS = ['tip', 'table', 'boards'];
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}) => { const node = document.createElementNS(SVG_NS, tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v); return node; };

  async function renderSide() {
    const side = document.getElementById('predict-side');
    const layout = document.querySelector('.playout');
    if (!side) return;
    const show = SIDE_TABS.includes(S.tab);
    side.hidden = !show;
    if (layout) layout.dataset.side = String(show);
    if (!show) return;
    const league = S.league;
    const season = S.index && S.index.season;
    if (!side.firstChild) side.append(h('div', { class: 'pside__card pskeleton', attrs: { 'aria-hidden': 'true' } }, h('span'), h('span'), h('span')));
    try {
      if (client.uid && S.stats === undefined) S.stats = await client.get(`stats/${client.uid}`);
      if (client.uid && !S.ownHash) S.ownHash = await uidHash(client.uid);
      S.sideBoards = S.sideBoards || {};
      const key = `${season}_${league}`;
      if (season && !(key in S.sideBoards)) S.sideBoards[key] = await client.get(`boards/season_${key}`);
    } catch (error) { /* the panel shows what it has */ }
    if (S.league !== league || !SIDE_TABS.includes(S.tab)) return;
    side.replaceChildren(sidePanel(season, league));
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

  function sidePanel(season, league) {
    const board = (S.sideBoards || {})[`${season}_${league}`] || null;
    const mine = season && S.stats ? seasonTotals(S.stats, season, league) : { n: 0 };
    const nick = (S.profile && S.profile.nick) || t('predict.you');
    const head = h('div', { class: 'pside__head' },
      h('span', { class: 'pside__avatar', attrs: { 'aria-hidden': 'true' } }, nick.charAt(0).toUpperCase()),
      h('span', { class: 'pside__who' }, h('strong', {}, nick), h('small', {}, `${t('predict.side.label')} · ${LEAGUE_NAME[league]}`)));
    const card = h('section', { class: 'pside__card', attrs: { 'aria-label': t('predict.side.label') } }, head);

    if (!mine.n) {
      const quiet = h('details', { class: 'pside__details', open: matchMedia('(min-width: 960px)').matches }, h('summary', {}, t('predict.side.moreSummary')));
      quiet.append(h('p', { class: 'pside__empty' }, t('predict.side.empty')), bellChart(board, null));
      card.append(quiet);
      return card;
    }

    const beat = board ? beatShare(board.pct, mine.ab, board.players) : null;
    // Rank among people: the board's own ranks also count the model and the crowd rows.
    const own = board && S.ownHash ? board.rows.find((r) => r.u === S.ownHash) : null;
    const tone = mine.ab > 0.00005 ? 'good' : mine.ab < -0.00005 ? 'bad' : 'even';
    const big = h('strong', { class: 'pside__score', data: { tone } }, signed(mine.ab));
    countUp(big, mine.ab, `${season}_${league}`);
    card.append(h('div', { class: 'pside__hero' }, big, h('span', { class: 'pside__label' }, t('predict.side.acc'))));

    if (beat !== null) {
      const tier = tierOf(beat);
      card.append(h('div', { class: 'pside__tier', data: { tier: tier.id } },
        h('span', { class: 'pside__medal', attrs: { 'aria-hidden': 'true' } }),
        h('span', {}, h('strong', {}, t(`predict.tier.${tier.id}`)), h('small', {},
          own ? t('predict.side.rank', { rank: board.rows.filter((r) => r.kind === 'player' && r.rank <= own.rank).length, total: groupThousands(board.players || 0, lang()) }) : t('predict.side.beat', { beat })))));
      // Progress through the tiers: 50, 75 and 90 % are the steps.
      const track = h('div', { class: 'pside__track', attrs: { role: 'img', 'aria-label': t('predict.side.beat', { beat }) } },
        h('span', { class: 'pside__fill', style: `width: 0%` }),
        ...[50, 75, 90].map((at) => h('span', { class: 'pside__step', style: `left: ${at}%` })));
      requestAnimationFrame(() => requestAnimationFrame(() => { track.firstChild.style.width = `${beat}%`; }));
      card.append(track, h('p', { class: 'pside__next' }, tier.next
        ? t('predict.side.next', { n: tier.toNext, tier: t(`predict.tier.${tier.next}`) }) : t('predict.side.top')));
    }

    // The spread, the form, the numbers and the badges: open beside the matches on a wide screen, a tap away on a phone.
    const more = h('details', { class: 'pside__details', open: matchMedia('(min-width: 960px)').matches }, h('summary', {}, t('predict.side.moreSummary')));
    more.append(h('h3', { class: 'pside__h' }, t('predict.side.dist')), bellChart(board, mine.ab, beat));

    const form = roundForm(S.stats, season, league, 8);
    if (form.length) {
      const top = Math.max(0.05, ...form.map((f) => Math.abs(f.ab)));
      more.append(h('h3', { class: 'pside__h' }, t('predict.side.form')),
        h('div', { class: 'pside__form', attrs: { role: 'img', 'aria-label': t('predict.side.formAria', { n: form.length }) } },
          form.map((f) => h('span', { class: 'pside__bar', data: { tone: f.ab > 0 ? 'good' : f.ab < 0 ? 'bad' : 'even' },
            title: `${t('predict.round', { n: f.round })}: ${signed(f.ab)}` },
            h('i', { style: `height: ${Math.max(4, (Math.abs(f.ab) / top) * 48)}%` }), h('small', {}, String(f.round))))));
    }

    const streak = streakNow(league);
    const cell = (value, label, toneOf) => h('div', { class: 'pside__cell', data: { tone: toneOf || 'even' } }, h('strong', {}, value), h('small', {}, label));
    more.append(h('div', { class: 'pside__grid' },
      cell(String(mine.n), t('predict.col.n')),
      cell(signed(mine.vm), t('predict.stats.vm'), mine.vm > 0 ? 'good' : mine.vm < 0 ? 'bad' : 'even'),
      cell(String(streak.current), t('predict.stats.streak')),
      cell(fixed(mine.b / mine.n, 2), t('predict.col.b'))));
    const badges = badgesFor({ tips: mine.n, totals: mine, streak: streak.best }).filter((b) => b.earned);
    if (badges.length) more.append(h('ul', { class: 'pbadges pside__badges' }, badges.map((b) => h('li', { class: 'pbadge pbadge--b', data: { earned: 'true' } },
      h('span', { attrs: { 'aria-hidden': 'true' } }, '✓'), t(`predict.badge.${b.id}`)))));
    card.append(more);
    const tip = json(store.get(`predict.tip.${client.uid}`), null);
    if (tip && tip.id && tip.stamp !== statsTotalN()) refreshTip();          // new rounds have settled since it was worked out
    if (tip && tip.id) {
      card.append(h('button', { type: 'button', class: 'pside__tip', data: { tone: tip.tone || 'tip' }, on: { click: () => openTab('me') } },
        h('small', {}, t('predict.side.tip')), h('span', {}, t(`predict.insight.${tip.id}.title`, tip.params || {}))));
    }
    card.append(h('button', { type: 'button', class: 'plink pside__more', on: { click: () => openTab('me') } }, t('predict.side.more')));
    return card;
  }

  /* The field as a bell curve: the part of it you beat is filled, your marker slides in. */
  function bellChart(board, value, beat) {
    const fit = board ? normalFit(board.pct) : null;
    const W = 280;
    const H = 110;
    const base = H - 18;
    if (!fit || (board.players || 0) < 3) {
      return h('p', { class: 'pside__note' }, t('predict.side.distLater'));
    }
    const model = (board.rows || []).find((r) => r.kind === 'model');
    const points = [fit.mean - 3 * fit.sd, fit.mean + 3 * fit.sd, value, model && model.ab].filter((x) => x !== null && x !== undefined && Number.isFinite(x));
    const lo = Math.min(...points) - fit.sd * 0.3;
    const hi = Math.max(...points) + fit.sd * 0.3;
    const x = (v) => ((v - lo) / (hi - lo)) * W;
    const y = (v) => base - normalDensity(v, fit.mean, fit.sd) * (base - 14);
    let path = `M0 ${base}`;
    for (let i = 0; i <= 80; i++) { const v = lo + ((hi - lo) * i) / 80; path += ` L${x(v).toFixed(1)} ${y(v).toFixed(1)}`; }
    path += ` L${W} ${base} Z`;
    const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'pbell', role: 'img',
      'aria-label': value === null ? t('predict.side.dist') : t('predict.side.distAria', { beat, league: LEAGUE_NAME[S.league] }) });
    const clipId = `pbell-${Math.random().toString(36).slice(2, 8)}`;
    const defs = svg('defs');
    const clip = svg('clipPath', { id: clipId });
    const clipRect = svg('rect', { x: 0, y: 0, width: 0, height: H, class: 'pbell__clip' });
    clip.append(clipRect);
    defs.append(clip);
    chart.append(defs, svg('path', { d: path, class: 'pbell__curve' }));
    if (value !== null) chart.append(svg('path', { d: path, class: 'pbell__beat', 'clip-path': `url(#${clipId})` }));
    chart.append(svg('line', { x1: 0, x2: W, y1: base, y2: base, class: 'pbell__axis' }));
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
      const nearMedian = Math.abs(x(model.ab) - x(fit.mean)) < 48;
      const nearYou = value !== null && Math.abs(x(model.ab) - x(value)) < 40;
      const mark = tick(model.ab, nearMedian && nearYou ? '' : t('predict.model'), 'pbell__mark--model', nearMedian);
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
    return h('figure', { class: 'pside__chart' }, chart,
      h('figcaption', {}, value === null ? t('predict.side.distEmpty') : beat < 5 ? t('predict.side.beatLow') : t('predict.side.beat', { beat })));
  }

  /* The headline number counts up once per visit, not on every redraw. */
  function countUp(node, target, key) {
    S.counted = S.counted || new Set();
    if (S.counted.has(key) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    S.counted.add(key);
    const start = performance.now();
    const step = (time) => {
      const k = Math.min(1, (time - start) / 900);
      node.textContent = signed(target * (1 - (1 - k) ** 3));
      if (k < 1) requestAnimationFrame(step);
    };
    node.textContent = signed(0);
    requestAnimationFrame(step);
  }

  /* ---- how to play: a guide with a bar to try and a result to pick -------------------------------- */

  function renderHow(root) {
    const info = { home: t('predict.how.home'), away: t('predict.how.away') };
    const even = pickPercentages(0, DRAW_TENTHS.normal);
    let pos = { g: 60, k: DRAW_TENTHS.normal };
    let picked = null;

    const demoBar = bar(pickPercentages(pos.g, pos.k));
    demoBar.classList.add('pcard__bar');
    demoBar.setAttribute('aria-hidden', 'true');
    const demoRange = h('input', { type: 'range', class: 'pcard__range', min: GAP.min, max: GAP.max, step: GAP.step, value: pos.g,
      attrs: { 'aria-label': t('predict.slider.label', info) } });
    const reading = h('p', { class: 'pcard__read' });
    const fine = h('input', { type: 'range', class: 'pcard__fine-range', min: DRAW_TENTHS.min, max: DRAW_TENTHS.max, step: 1, value: pos.k,
      attrs: { 'aria-label': t('predict.fine.label') } });
    const fineValue = h('output', { class: 'pcard__fine-value' });
    const score = h('div', { class: 'pguide__score', attrs: { 'aria-live': 'polite' } }, h('p', { class: 'pmuted' }, t('predict.how.pick')));
    const results = ['home_win', 'draw', 'away_win'].map((o) => h('button', { type: 'button', class: 'pbtn pbtn--small', data: { outcome: o },
      attrs: { 'aria-pressed': 'false' }, on: { click: () => { picked = o; results.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.outcome === o))); paint(); } } },
      t(`predict.how.r.${o}`)));

    function paint() {
      const p = pickPercentages(pos.g, pos.k);
      paintBar(demoBar, p);
      demoRange.value = pos.g;
      demoRange.setAttribute('aria-valuetext', t('predict.slider.value', { h: p[0], d: p[1], a: p[2] }));
      fine.value = pos.k;
      fineValue.textContent = `${fixed(pos.k / 10, 1)}×`;
      reading.textContent = pickReading(p, info);
      if (!picked) return;
      const you = scoreOwnPick(p, even.map((x) => x / 100), picked);
      const evenBrier = you.brier + you.vsModel;
      const kind = you.vsModel > 0.0005 ? 'good' : you.vsModel < -0.0005 ? 'bad' : 'even';
      const mini = bar(p);
      mini.dataset.hit = OUTCOME_SIDE[picked];
      mini.classList.add('pguide__mini');
      score.replaceChildren(mini,
        h('p', { class: 'pguide__big' }, t('predict.how.score.you', { b: fixed(you.brier, 2) })),
        h('p', {}, t('predict.how.score.even', { m: fixed(evenBrier, 2) })),
        h('div', { class: 'pverdict', data: { kind } }, h('strong', { class: 'pverdict__chip' }, t(`predict.how.score.${kind === 'even' ? 'even2' : kind}`))));
    }
    const move = (event) => {
      const box = demoBar.getBoundingClientRect();
      pos.g = gapUnder((event.clientX - box.left) / box.width);
      paint();
    };
    let dragging = false;
    demoBar.addEventListener('pointerdown', (event) => { dragging = true; capture(demoBar, event); move(event); });
    demoBar.addEventListener('pointermove', (event) => { if (dragging) move(event); });
    demoBar.addEventListener('pointerup', () => { dragging = false; });
    demoBar.addEventListener('pointercancel', () => { dragging = false; });
    demoRange.addEventListener('input', () => { pos.g = Number(demoRange.value); paint(); });
    fine.addEventListener('input', () => { pos.k = Number(fine.value); paint(); });

    const demo = h('div', { class: 'pcard pguide__demo', data: { state: 'tipped' } },
      matchHead(info, t('predict.how.try')), h('div', { class: 'pslider' }, demoBar, demoRange), reading);
    const step = (n, title, ...kids) => h('section', { class: 'pguide__step' },
      h('h2', {}, h('span', { class: 'pguide__n', attrs: { 'aria-hidden': 'true' } }, String(n)), title), ...kids);
    const faq = ['1', '2', '3', '4'].map((n) => h('details', { class: 'pdetails pguide__q' },
      h('summary', {}, t(`predict.how.q${n}`)), h('p', {}, t(`predict.how.a${n}`))));

    root.append(h('article', { class: 'pguide' },
      h('h2', { class: 'pguide__title' }, t('predict.how.title')),
      h('p', { class: 'pguide__lead' }, t('predict.how.lead')),
      step(1, t('predict.how.s1.title'), h('p', {}, t('predict.how.s1.text')), demo),
      step(2, t('predict.how.s2.title'), h('p', {}, t('predict.how.s2.text')),
        h('label', { class: 'pcard__fine pguide__fine' }, h('span', {}, t('predict.fine.title')), fine, fineValue)),
      step(3, t('predict.how.s3.title'), h('p', {}, t('predict.how.s3.text'))),
      step(4, t('predict.how.s4.title'), h('p', {}, t('predict.how.s4.text')),
        h('div', { class: 'pguide__results', attrs: { role: 'group', 'aria-label': t('predict.how.pick') } }, results), score,
        h('p', {}, t('predict.how.s4.bold'))),
      step(5, t('predict.how.s5.title'), h('p', {}, t('predict.how.s5.text'))),
      step(6, t('predict.how.s6.title'), h('p', {}, t('predict.how.s6.text'))),
      h('section', { class: 'pguide__faq' }, h('h2', {}, t('predict.how.faq')), faq,
        h('p', { class: 'pmuted' }, h('a', { href: '/personvern.html' }, t('predict.foot.privacy')))),
      h('button', { type: 'button', class: 'pbtn pbtn--primary pguide__cta', on: { click: () => { store.set('predict.intro', 'seen'); openTab('tip'); window.scrollTo(0, 0); } } },
        t('predict.how.cta'))));
    paint();
  }

  /* ---- you: profile, stats, Google, deletion --------------------------------------------------------------------- */

  async function renderMe(root) {
    const body = h('div', {}, h('p', { class: 'pload' }, t('predict.loading')));
    root.append(body);
    if (!client.uid) { body.replaceChildren(h('div', { class: 'pempty' }, h('p', {}, t('predict.me.none')), dataSection(false))); return; }
    try {
      if (S.profile === undefined || S.profile === null) await loadProfile();
      if (S.stats === undefined) S.stats = await client.get(`stats/${client.uid}`);
    } catch (error) { body.replaceChildren(emptyState(error, render)); return; }
    if (S.tab !== 'me') return;
    body.replaceChildren(profileSection(), statsSection(), analysisSection(), dataSection(true));
  }

  function profileSection() {
    const profile = S.profile || {};
    const nick = h('input', { type: 'text', class: 'pfield', value: profile.nick || '', maxLength: 20, id: 'pnick', attrs: { autocomplete: 'off', spellcheck: 'false' } });
    const message = h('p', { class: 'pme__msg', attrs: { 'aria-live': 'polite' } });
    const change = h('button', { type: 'button', class: 'pbtn', on: { click: async () => {
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
    const hidden = h('input', { type: 'checkbox', class: 'pswitch', checked: Boolean(profile.hidden), attrs: { role: 'switch' }, on: { change: async (e) => {
      try { await client.commit(profileUpdateWrites(config, client.uid, { hidden: e.target.checked })); S.profile = { ...S.profile, hidden: e.target.checked }; }
      catch (error) { e.target.checked = !e.target.checked; toast(errorText(error), 'error'); }
    } } });
    // The clubs of the rounds already loaded, as suggestions.
    const names = new Set();
    Object.values(S.data).forEach((record) => Object.values((record.fixture && record.fixture.slots) || {}).forEach((m) => { names.add(m.home); names.add(m.away); }));
    const list = h('datalist', { id: 'pclubs' }, [...names].sort((a, b) => a.localeCompare(b, 'nb')).map((n) => h('option', { value: n })));
    const club = h('input', { type: 'text', class: 'pfield', value: profile.club || '', maxLength: 40, id: 'pclub', attrs: { list: 'pclubs', autocomplete: 'off' },
      on: { change: async (e) => {
        const value = e.target.value.trim();
        try { await client.commit(profileUpdateWrites(config, client.uid, { club: value })); S.profile = { ...S.profile, club: value }; toast(t('predict.me.clubSaved')); }
        catch (error) { toast(errorText(error), 'error'); }
      } } });
    return h('section', { class: 'ppanel pme' }, h('h2', {}, t('predict.me.title')),
      h('div', { class: 'pfieldset' }, h('label', { attrs: { for: 'pnick' } }, t('predict.me.nick')), h('div', { class: 'pinline' }, nick, change)), message,
      h('label', { class: 'pswitch-row' }, h('span', {}, h('strong', {}, t('predict.me.hidden')), h('small', {}, t('predict.me.hiddenHelp'))), hidden),
      h('div', { class: 'pfieldset' }, h('label', { attrs: { for: 'pclub' } }, t('predict.me.club')), club, list));
  }

  function statsSection() {
    const season = S.index && S.index.season;
    const totals = season ? seasonTotals(S.stats, season) : { n: 0, ab: 0, ar: 0, b: 0, r: 0, vm: 0, rounds: 0 };
    const streak = streakNow();
    const box = h('section', { class: 'ppanel pstats' }, h('h2', {}, t('predict.stats.title')));
    if (!totals.n) { box.append(h('p', { class: 'pempty' }, t('predict.stats.none'))); return box; }
    const tone = (value) => (value > 0.00005 ? 'good' : value < -0.00005 ? 'bad' : 'even');
    const big = (label, value, toneOf) => h('div', { class: 'pstat', data: { tone: toneOf || 'even' } }, h('dd', {}, value), h('dt', {}, label));
    box.append(h('dl', { class: 'pstats__hero' },
      big(t('predict.col.n'), String(totals.n)),
      big(t('predict.stats.acc'), signed(totals.ab), tone(totals.ab)),
      big(t('predict.stats.vm'), signed(totals.vm), tone(totals.vm)),
      big(t('predict.stats.streak'), String(streak.current))));
    const small = (label, value) => [h('dt', {}, label), h('dd', {}, value)];
    box.append(h('dl', { class: 'pstats__more' },
      small(t('predict.col.ar'), signed(totals.ar)), small(t('predict.col.b'), fixed(totals.b / totals.n, 2)),
      small(t('predict.col.r'), fixed(totals.r / totals.n, 2)), small(t('predict.stats.bestStreak'), String(streak.best))));
    const badges = badgesFor({ tips: totals.n, totals, streak: streak.best });
    box.append(h('h3', {}, t('predict.badges')), h('ul', { class: 'pbadges' }, badges.map((b) => h('li', { class: 'pbadge pbadge--b', data: { earned: String(b.earned) } },
      h('span', { attrs: { 'aria-hidden': 'true' } }, b.earned ? '✓' : '○'), t(`predict.badge.${b.id}`)))));
    const chart = h('div', { class: 'pcal' });
    box.append(totals.n >= 30 ? h('button', { type: 'button', class: 'pbtn', on: { click: (e) => { e.currentTarget.remove(); calibration(chart); } } }, t('predict.cal.show'))
      : h('p', { class: 'pmuted' }, t('predict.cal.later', { n: 30 - totals.n })), chart);
    return box;
  }

  /* The streak in one division: its rounds the job has scored, completed when you tipped every match.
     (A round the job has not scored yet is not counted as missed: the clock alone says it is over,
     but the scores arrive with the next hourly run.) */
  function streakFor(league) {
    const rows = (S.stats && S.stats.rounds) || {};
    let started = false;
    const flags = [];
    for (const round of leagueRounds(league).filter((r) => roundScored(r, now()))) {
      const mine = rows[round.key];
      if (mine) started = true;
      if (started) flags.push(Boolean(mine) && mine.n >= round.n);
    }
    return computeStreak(flags);
  }

  /* One division's streak, or (no division) the better of the two for the "Me" tab. */
  function streakNow(league) {
    if (!(S.index && S.index.season)) return { current: 0, best: 0, freezes: 0 };
    if (league) return streakFor(league);
    return LEAGUES.map(streakFor).reduce((best, one) => (one.best > best.best || one.current > best.current ? one : best));
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
            // is in: the job erases the data within the hour, so this device is signed out and says so.
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
    Object.assign(S, { data: {}, drafts: {}, status: {}, timers: {}, loading: {}, roundAt: {}, ownHash: null, stats: undefined,
      profile: undefined, history: undefined, historyAt: 0, historyLoad: null, sideBoards: {}, tables: {}, board: {}, myLeagues: [],
      counted: new Set(), revealSeen: new Set(), ringWas: {}, leagueNote: null, calibration: null });
  }

  /* ---- the shell --------------------------------------------------------------------------------------------- */

  const TABS = ['tip', 'table', 'boards', 'me'];

  function renderTabs() {
    const holder = document.getElementById('predict-tabs');
    holder.replaceChildren(h('div', { class: 'switch', attrs: { role: 'group', 'aria-label': t('predict.tabs') } },
      TABS.map((tab) => h('button', { type: 'button', data: { tab }, attrs: { 'aria-pressed': String(S.tab === tab) }, on: { click: () => openTab(tab) } }, t(`predict.tab.${tab}`)))));
  }

  function render() {
    renderTabs();
    document.title = S.tab === 'tip' ? `${t('predict.title')} — EliteTracker` : `${t(`predict.tab.${S.tab}`)} · ${t('predict.title')} — EliteTracker`;
    const root = document.getElementById('predict-view');
    root.replaceChildren();
    root.dataset.tab = S.tab;
    if (S.tab === 'tip') renderTip(root);
    else if (S.tab === 'table') renderTable(root);
    else if (S.tab === 'boards') renderBoards(root);
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

  /* Each section has an address (#table, #boards, #me), so a link can open it and Back works. */
  function openTab(tab) {
    if (tab !== S.tab) { S.leagueNote = null; S.leagueCode = null; }
    S.tab = tab;
    const hash = tab === 'tip' ? '' : `#${tab}`;
    if (location.hash !== hash) history.pushState(null, '', hash || location.pathname + location.search);
    render();
  }
  const ROUTES = [...TABS, 'how'];
  const tabFromHash = () => (ROUTES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'tip');
  window.addEventListener('popstate', () => { S.tab = tabFromHash(); render(); });
  window.addEventListener('hashchange', () => {
    const next = tabFromHash();
    if (next !== S.tab) { S.tab = next; render(); window.scrollTo(0, 0); }
  });

  /* The clock: the countdown keeps moving, and a match that kicks off while the page is open locks. */
  S.lastTick = now();
  setInterval(() => {
    if (document.hidden || S.tab !== 'tip') { S.lastTick = now(); return; }
    const round = currentRound(S.league);
    const badge = document.getElementById('predict-badge');
    if (!round || !badge) return;
    const record = S.data[round.key] || {};
    const kicked = Object.values((record.fixture && record.fixture.slots) || {}).some((m) => m.kickoff.getTime() > S.lastTick && m.kickoff.getTime() <= now());
    S.lastTick = now();
    if (kicked || badge.dataset.status !== roundStatus(round, now())) { ensureRound(round, true).then(render); return; }
    badge.replaceWith(Object.assign(statusBadge(round), { id: 'predict-badge' }));
  }, 30000);

  /* An invite link (/predict/?join=CODE) opens the boards with the code filled in; joining is still a tap. */
  function readInvite() {
    try {
      const code = (new URLSearchParams(location.search).get('join') || '').trim().toUpperCase();
      if (!isLeagueCode(code)) return;
      S.pendingJoin = code;
      history.replaceState(null, '', location.pathname + '#boards');
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

  /* Light or dark, kept in the key the rest of the site reads (elitetracker-theme). */
  function paintTheme() {
    const button = document.getElementById('predict-theme');
    if (!button) return;
    const dark = document.documentElement.dataset.resolvedTheme === 'dark';
    button.setAttribute('aria-label', t(dark ? 'predict.theme.toLight' : 'predict.theme.toDark'));
    button.title = button.getAttribute('aria-label');
  }
  const themeButton = document.getElementById('predict-theme');
  if (themeButton) {
    themeButton.addEventListener('click', () => {
      const next = document.documentElement.dataset.resolvedTheme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('elitetracker-theme', next); } catch (error) { /* this visit only */ }
      document.documentElement.dataset.resolvedTheme = next;
      paintTheme();
    });
  }

  function setLanguage(next) {
    setLang(next);
    // A signed-in player's language follows them: it is on the profile too.
    if (client.uid && S.profile) {
      const locale = next === 'no' ? 'nb' : 'en';
      client.commit(profileUpdateWrites(config, client.uid, { locale })).then(() => { S.profile = { ...S.profile, locale }; }).catch(() => { /* a convenience only */ });
    }
    paintTheme();
    document.documentElement.dataset.lang = next;
    document.querySelectorAll('.doc__top [data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === next)));
    translateStatic();
    render();
  }

  function translateStatic() {
    document.querySelectorAll('[data-t]').forEach((node) => { node.textContent = t(node.dataset.t); });
  }

  document.querySelectorAll('.doc__top [data-lang]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.lang === lang()));
    button.addEventListener('click', () => setLanguage(button.dataset.lang));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.tab === 'tip') { const round = currentRound(S.league); if (round && ['live', 'partial'].includes(roundStatus(round, now()))) ensureRound(round, true).then(render); }
  });
  translateStatic();
  paintTheme();
  boot();
})();
