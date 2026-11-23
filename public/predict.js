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
  }

  /* An inline "are you sure": the button turns into the question with two answers (no window.confirm). */
  function confirmable(label, question, onYes, className = 'pbtn pbtn--danger') {
    const wrap = h('span', { class: 'pconfirm' });
    const reset = () => { wrap.replaceChildren(h('button', { type: 'button', class: className, on: { click: ask } }, label)); };
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
    } catch (error) { S.indexError = error; }
  }

  async function loadProfile() {
    if (!client.uid) { S.profile = null; return; }
    try { S.profile = await client.get(`users/${client.uid}`); } catch (error) { S.profile = null; }
  }

  function loadDraft(key) {
    if (!S.drafts[key]) S.drafts[key] = json(store.get(draftKey(null, key)), {});
    return S.drafts[key];
  }

  function saveDraft(key) {
    const draft = S.drafts[key] || {};
    if (Object.keys(draft).length) store.set(draftKey(null, key), JSON.stringify(draft)); else store.remove(draftKey(null, key));
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

  async function ensureAccount() {
    if (!client.uid) await client.signUp();
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
    const slots = Object.keys(draft);
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

  function savedPick(record, slot) {
    const saved = record && record.entry && record.entry.p && record.entry.p[slot];
    return saved ? { g: saved.g, k: saved.k, t: saved.t } : null;
  }

  function bar(percents, labelled = true) {
    const node = h('div', { class: 'odds' });
    ['home', 'draw', 'away'].forEach((outcome, i) => {
      const segment = h('div', { class: 'odds__seg', data: { outcome } });
      segment.style.flex = String(Math.max(percents[i], 0.1));
      segment.textContent = labelled && percents[i] >= 12 ? String(Math.round(percents[i])) : '';
      node.append(segment);
    });
    return node;
  }

  function paintBar(node, percents) {
    [...node.children].forEach((segment, i) => {
      segment.style.flex = String(Math.max(percents[i], 0.1));
      segment.textContent = percents[i] >= 12 ? String(Math.round(percents[i])) : '';
    });
  }

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
    const teams = h('div', { class: 'pcard__teams' }, h('span', { class: 'pcard__home' }, info.home), h('span', { class: 'pcard__vs' }, '–'), h('span', { class: 'pcard__away' }, info.away));
    card.append(h('div', { class: 'pcard__head' }, teams, h('span', { class: 'pcard__time' }, when(kickoff))));

    if (locked) {
      card.append(...lockedBody(round, record, slot, info, saved));
      return card;
    }

    const pct = () => pickPercentages(pos.g, pos.k);
    const oddsBar = bar(pct());
    oddsBar.classList.add('pcard__bar');
    oddsBar.setAttribute('aria-hidden', 'true');
    const range = h('input', { type: 'range', class: 'pcard__range', min: GAP.min, max: GAP.max, step: GAP.step, value: pos.g,
      attrs: { 'aria-label': t('predict.slider.label', { home: info.home, away: info.away }) } });
    const fineRange = h('input', { type: 'range', class: 'pcard__range pcard__range--fine', min: DRAW_TENTHS.min, max: DRAW_TENTHS.max, step: 1,
      value: pos.k, attrs: { 'aria-label': t('predict.fine.label') } });
    const fineValue = h('span', { class: 'pcard__fine-value' });
    const fineRow = h('div', { class: 'pcard__fine', hidden: !fine }, h('span', {}, t('predict.fine.title')), fineRange, fineValue);
    const fineButton = h('button', { type: 'button', class: 'pbtn pbtn--small', attrs: { 'aria-pressed': String(fine) } }, t('predict.fine'));
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
    const status = h('span', { class: 'pcard__status', attrs: { 'aria-live': 'polite' } });
    card.append(oddsBar, range, fineRow, h('div', { class: 'pcard__foot' }, fineButton, readout, status));

    function paint() {
      const p = pct();
      paintBar(oddsBar, p);
      range.value = pos.g;
      fineRange.value = pos.k;
      fineValue.textContent = `${fixed(pos.k / 10, 1)}×`;
      ['h', 'd', 'a'].forEach((o, i) => { if (document.activeElement !== inputs[o]) inputs[o].value = String(p[i]); });
      card.dataset.state = tipped ? 'tipped' : 'untouched';
      card.paintStatus();
    }

    card.paintStatus = () => {
      const st = S.status[`${key}/${slot}`] || {};
      const current = savedPick(S.data[key], slot);
      if (st.state === 'saving') status.textContent = t('predict.saving');
      else if (st.state === 'error') status.textContent = `${t('predict.notsaved')} ${st.message || ''}`;
      else if (!tipped) status.textContent = t('predict.drag');
      else if (current && !((S.drafts[key] || {})[slot])) status.textContent = t('predict.saved', { ago: agoText(current.t instanceof Date ? current.t : new Date(now())) });
      else status.textContent = t('predict.pending');
      status.dataset.state = st.state || (tipped ? 'tipped' : 'untouched');
    };

    function touch() {
      tipped = true;
      loadDraft(key)[slot] = { g: pos.g, k: pos.k };
      saveDraft(key);
      S.status[`${key}/${slot}`] = { state: 'pending' };
      paintRing();
    }
    function release() { scheduleSave(key); paint(); }

    range.addEventListener('input', () => { pos.g = Number(range.value); touch(); paint(); });
    range.addEventListener('change', release);
    fineRange.addEventListener('input', () => { pos.k = Number(fineRange.value); touch(); paint(); });
    fineRange.addEventListener('change', release);
    fineButton.addEventListener('click', () => {
      fine = !fine; S.fine = fine; fineRow.hidden = !fine;
      fineButton.setAttribute('aria-pressed', String(fine));
      if (!fine && pos.k !== DRAW_TENTHS.normal) { pos.k = DRAW_TENTHS.normal; if (tipped) { touch(); release(); } }
      paint();
    });

    // Dragging across the bar itself; the page still scrolls up and down (touch-action: pan-y in the css).
    let dragging = false;
    const move = (event) => {
      const box = oddsBar.getBoundingClientRect();
      pos.g = gapAtFraction((event.clientX - box.left) / box.width);
      touch(); paint();
    };
    oddsBar.addEventListener('pointerdown', (event) => { dragging = true; oddsBar.setPointerCapture(event.pointerId); move(event); });
    oddsBar.addEventListener('pointermove', (event) => { if (dragging) move(event); });
    const stop = () => { if (dragging) { dragging = false; release(); } };
    oddsBar.addEventListener('pointerup', stop);
    oddsBar.addEventListener('pointercancel', stop);
    oddsBar.removeAttribute('aria-hidden');
    oddsBar.setAttribute('role', 'presentation');

    paint();
    return card;
  }

  /* After kick-off: your pick, the model's and the crowd's, the result and the scores. */
  function lockedBody(round, record, slot, info, saved) {
    const parts = [];
    const reveal = record && record.reveal && record.reveal.matches && record.reveal.matches[slot];
    const mine = saved ? pickPercentages(saved.g, saved.k) : null;
    const rows = [];
    const row = (label, percents, cls) => h('div', { class: `preveal__row ${cls || ''}` }, h('span', { class: 'preveal__who' }, label), bar(percents));
    if (mine) rows.push(row(t('predict.you'), mine, 'preveal__row--you'));
    else parts.push(h('p', { class: 'pcard__none' }, t('predict.notip')));
    if (reveal && reveal.model) rows.push(row(t('predict.model'), [reveal.model.h * 100, reveal.model.d * 100, reveal.model.a * 100]));
    if (reveal && reveal.crowd) rows.push(row(t('predict.crowd', { n: reveal.crowd.n }), [reveal.crowd.h, reveal.crowd.d, reveal.crowd.a]));
    if (rows.length) parts.push(h('div', { class: 'preveal' }, rows));
    if (!reveal) parts.push(h('p', { class: 'pcard__locked' }, t('predict.locked')));
    if (reveal && reveal.result) {
      const { hg, ag } = reveal.result;
      parts.push(h('p', { class: 'preveal__result' }, `${info.home} ${hg}–${ag} ${info.away}`));
      if (mine && reveal.model) {
        const result = outcomeOf(hg, ag);
        const own = scoreOwnPick(mine, [reveal.model.h, reveal.model.d, reveal.model.a], result);
        const lines = [t('predict.score', { brier: fixed(own.brier, 2), rps: fixed(own.rps, 2), vs: signed(own.vsModel) })];
        if (reveal.crowd && reveal.crowd.med) lines.push(t('predict.median', { acc: signed(reveal.crowd.med.b - own.brier) }));
        else lines.push(t('predict.median.later'));
        parts.push(h('p', { class: 'preveal__score' }, lines.join(' · ')));
      }
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
      const own = scoreOwnPick(pickPercentages(entry[slot].g, entry[slot].k), [info.model.h, info.model.d, info.model.a], outcomeOf(info.result.hg, info.result.ag));
      if (own.vsModel > 0) beat += 1;
      if (!best || own.vsModel > best.vs) best = { slot, vs: own.vsModel };
    }
    return tipped ? { tipped, beat, best } : null;
  }

  /* ---- the tip view ------------------------------------------------------------------------------- */

  function leagueSwitch(onPick) {
    return h('div', { class: 'switch', attrs: { role: 'group', 'aria-label': t('predict.division') } },
      LEAGUES.map((league) => h('button', { type: 'button', data: { league }, attrs: { 'aria-pressed': String(S.league === league) },
        on: { click: () => { S.league = league; onPick(); } } }, LEAGUE_NAME[league])));
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
    holder.replaceChildren(ringNode(tippedCount(round), Object.keys((record.fixture && record.fixture.slots) || {}).length));
  }

  function statusBadge(round) {
    const status = roundStatus(round, now());
    const text = status === 'future' ? t('predict.status.future', { span: spanText(round.opens.getTime() - now()) })
      : status === 'open' ? t('predict.status.open', { span: spanText(round.closes.getTime() - now()) })
      : status === 'live' ? t('predict.status.live') : t('predict.status.done');
    return h('span', { class: 'pbadge', data: { status } }, text);
  }

  function renderTip(root) {
    root.append(h('p', { class: 'pintro' }, t('predict.intro')));
    root.append(leagueSwitch(render));
    const rounds = leagueRounds(S.league);
    if (S.indexError || !rounds.length) { root.append(emptyState(S.indexError, loadAndRender, 'predict.empty.rounds')); return; }
    const round = currentRound(S.league);
    const at = rounds.indexOf(round);
    const nav = h('div', { class: 'pnav' },
      h('button', { type: 'button', class: 'pbtn pbtn--icon', hidden: at <= 0, attrs: { 'aria-label': t('predict.round.prev') },
        on: { click: () => { S.roundAt[S.league] = at - 1; render(); } } }, '‹'),
      h('div', { class: 'pnav__mid' }, h('h2', { class: 'pnav__title' }, t('predict.round', { n: round.round })), statusBadge(round)),
      h('button', { type: 'button', class: 'pbtn pbtn--icon', hidden: at >= rounds.length - 1, attrs: { 'aria-label': t('predict.round.next') },
        on: { click: () => { S.roundAt[S.league] = at + 1; render(); } } }, '›'),
      h('div', { id: 'predict-ring', class: 'pnav__ring' }));
    root.append(nav);
    const body = h('div', { class: 'pround' }, h('p', { class: 'pload' }, t('predict.loading')));
    root.append(body);
    const key = round.key;
    ensureRound(round).then((record) => {
      if (S.tab !== 'tip' || currentRound(S.league) !== round) return;
      body.replaceChildren(roundBody(round, record));
      paintRing();
    });
  }

  function roundBody(round, record) {
    if (record.error && !record.fixture) return emptyState(record.error, () => { ensureRound(round, true).then(render); }, null);
    if (!record.fixture) return h('p', { class: 'pempty' }, t('predict.empty.fixture'));
    const slots = record.fixture.slots;
    const keys = Object.keys(slots).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const status = roundStatus(round, now());
    const out = h('div', {});
    const recap = recapOf(round, record);
    if (recap) {
      const best = recap.best ? slots[recap.best.slot] : null;
      const text = t('predict.recap', { tipped: recap.tipped, beat: recap.beat }) + (best ? ' ' + t('predict.recap.best', { match: `${best.home}–${best.away}` }) : '');
      out.append(h('div', { class: 'precap' }, h('p', {}, text), h('button', { type: 'button', class: 'pbtn pbtn--small', on: { click: () => shareText(text) } }, t('predict.share'))));
    }
    if (status === 'future') {
      out.append(h('p', { class: 'pempty' }, t('predict.status.future', { span: spanText(round.opens.getTime() - now()) })));
      out.append(h('ol', { class: 'plist plist--preview' }, keys.map((k) => h('li', { class: 'pcard pcard--preview' },
        h('div', { class: 'pcard__head' }, h('div', { class: 'pcard__teams' }, `${slots[k].home} – ${slots[k].away}`), h('span', { class: 'pcard__time' }, when(slots[k].kickoff)))))));
    } else {
      out.append(h('ol', { class: 'plist' }, keys.map((k) => buildCard(round, record, k, slots[k]))));
    }
    out.append(h('p', { class: 'pfoot' }, h('a', { href: '/predict/rounds.ics' }, t('predict.calendar')),
      status === 'live' ? h('button', { type: 'button', class: 'pbtn pbtn--small', on: { click: () => ensureRound(round, true).then(render) } }, t('predict.refresh')) : null));
    return out;
  }

  async function shareText(text) {
    const full = `${text} ${location.origin}/predict/`;
    try { if (navigator.share) { await navigator.share({ title: 'Predict', text: full }); return; } } catch (error) { return; }
    try { await navigator.clipboard.writeText(full); toast(t('predict.copied')); } catch (error) { toast(full); }
  }

  function emptyState(error, retry, emptyKey) {
    const box = h('div', { class: 'pempty', attrs: { role: 'status' } });
    box.append(h('p', {}, error && error.code && error.code !== 'empty' ? errorText(error) : t(emptyKey || 'predict.empty.generic')));
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
      if (S.tab !== 'table') return;
      body.replaceChildren(tableBody(key, game, mine));
    } catch (error) { body.replaceChildren(emptyState(error, render)); }
  }

  function tableBody(key, game, mine) {
    const bonus = TABLE_BONUS[S.league];
    const rules = h('p', { class: 'ptable__rules' }, t(S.league === 'eliteserien' ? 'predict.table.rules.es' : 'predict.table.rules.obos', { champion: bonus.champion, promotion: bonus.promotion, relegation: bonus.relegation }));
    if (!game) return h('div', {}, h('p', { class: 'pempty' }, t('predict.table.none')), rules);
    const nowMs = now();
    const state = nowMs < game.opens.getTime() ? 'soon' : nowMs >= game.closes.getTime() ? 'closed' : 'open';
    let order = mine && Array.isArray(mine.order) && mine.order.length === game.clubs.length ? mine.order.slice()
      : game.clubs.slice().sort((a, b) => game.names[a].localeCompare(game.names[b], 'nb'));
    let saved = Boolean(mine);
    const list = h('ol', { class: 'ptable', data: { state } });
    const status = h('p', { class: 'ptable__status', attrs: { 'aria-live': 'polite' } });
    const paint = () => {
      list.replaceChildren(...order.map((id, i) => {
        const row = h('li', { class: 'ptable__row', data: { id } },
          h('span', { class: 'ptable__pos' }, String(i + 1)), h('span', { class: 'ptable__name' }, game.names[id]));
        if (state === 'open') {
          const handle = h('button', { type: 'button', class: 'ptable__grip', attrs: { 'aria-label': t('predict.table.drag', { club: game.names[id] }) } }, '⋮⋮');
          const up = h('button', { type: 'button', class: 'pbtn pbtn--icon', attrs: { 'aria-label': t('predict.table.up', { club: game.names[id] }) }, disabled: i === 0, on: { click: () => shift(i, -1) } }, '↑');
          const down = h('button', { type: 'button', class: 'pbtn pbtn--icon', attrs: { 'aria-label': t('predict.table.down', { club: game.names[id] }) }, disabled: i === order.length - 1, on: { click: () => shift(i, 1) } }, '↓');
          grip(handle, row);
          row.append(handle, up, down);
        }
        return row;
      }));
      status.textContent = state === 'closed' ? t('predict.table.closed') : state === 'soon' ? t('predict.table.soon', { span: spanText(game.opens.getTime() - now()) })
        : saved ? t('predict.table.saved') : t('predict.table.unsaved', { span: spanText(game.closes.getTime() - now()) });
    };
    const shift = (i, by) => { const [moved] = order.splice(i, 1); order.splice(i + by, 0, moved); saved = false; paint(); };
    function grip(handle, row) {
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
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
        const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); paint(); };
        handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
      });
    }
    const save = h('button', { type: 'button', class: 'pbtn pbtn--primary', hidden: state !== 'open', on: { click: async () => {
      status.textContent = t('predict.saving');
      try { await ensureAccount(); await client.commit(tableWrites(config, client.uid, key, order)); saved = true; paint(); }
      catch (error) { status.textContent = `${t('predict.notsaved')} ${errorText(error)}`; }
    } } }, t('predict.table.save'));
    paint();
    return h('div', {}, list, status, save, rules);
  }

  /* ---- boards ---------------------------------------------------------------------------------------------- */

  async function renderBoards(root) {
    root.append(leagueSwitch(render));
    const scopes = ['season', 'round', 'last10'];
    root.append(h('div', { class: 'switch', attrs: { role: 'group', 'aria-label': t('predict.scope') } },
      scopes.map((scope) => h('button', { type: 'button', attrs: { 'aria-pressed': String(S.scope === scope) }, on: { click: () => { S.scope = scope; render(); } } }, t(`predict.scope.${scope}`)))));
    const body = h('div', {}, h('p', { class: 'pload' }, t('predict.loading')));
    root.append(body);
    const season = S.index && S.index.season;
    if (!season) { body.replaceChildren(emptyState(S.indexError, loadAndRender, 'predict.empty.rounds')); return; }
    try {
      if (client.uid && !S.ownHash) S.ownHash = await uidHash(client.uid);
      const board = await client.get(`boards/${S.scope}_${season}_${S.league}`);
      if (S.tab !== 'boards') return;
      body.replaceChildren(boardTable(board));
      if (client.uid && S.stats === undefined) { try { S.stats = await client.get(`stats/${client.uid}`); } catch (error) { S.stats = null; } }
      if (S.tab === 'boards') body.append(percentileNote(board, season));
    } catch (error) { body.replaceChildren(emptyState(error, render)); }
    root.append(leaguesSection());
  }

  function boardTable(board) {
    if (!board || !board.rows || !board.rows.length) return h('p', { class: 'pempty' }, t('predict.board.empty'));
    const head = ['rank', 'name', 'n', 'ab', 'ar', 'b', 'r', 'streak'].map((c) => h('th', { scope: 'col', class: `pboard__${c}` }, t(`predict.col.${c}`)));
    const rows = board.rows.map((row) => {
      const mine = S.ownHash && row.u === S.ownHash;
      const name = h('td', { class: 'pboard__name' }, row.nick || t('predict.anon'));
      if (row.kind === 'player' && row.nick && !mine) {
        name.append(h('button', { type: 'button', class: 'plink', attrs: { 'aria-label': t('predict.report.label', { name: row.nick }) }, on: { click: (e) => report(row, e.currentTarget) } }, t('predict.report')));
      }
      return h('tr', { class: 'pboard__row', data: { kind: row.kind, mine: String(Boolean(mine)) } },
        h('td', { class: 'pboard__rank' }, String(row.rank)), name, h('td', {}, String(row.n)), h('td', {}, signed(row.ab)), h('td', {}, signed(row.ar)),
        h('td', {}, row.b === null ? '–' : fixed(row.b, 2)), h('td', {}, row.r === null ? '–' : fixed(row.r, 2)), h('td', {}, row.streak === null || row.streak === undefined ? '–' : String(row.streak)));
    });
    return h('div', { class: 'pboard' }, h('table', {}, h('thead', {}, h('tr', {}, head)), h('tbody', {}, rows)),
      h('p', { class: 'pboard__note' }, t('predict.board.note', { players: groupThousands(board.players || 0, lang()) })));
  }

  function percentileNote(board, season) {
    if (S.scope !== 'season' || !board || !board.pct || !board.pct.length || !S.stats) return h('span');
    const mine = seasonTotals(S.stats, season, S.league);
    if (!mine.n) return h('p', { class: 'pboard__me' }, t('predict.board.notyet'));
    const below = board.pct.filter((v) => v < mine.ab).length;
    const top = Math.max(1, 100 - Math.round(below));
    const listed = S.ownHash && board.rows.some((r) => r.u === S.ownHash);
    return h('p', { class: 'pboard__me' }, t(listed ? 'predict.board.you.listed' : 'predict.board.you', { top, ab: signed(mine.ab), n: mine.n }));
  }

  async function report(row, button) {
    button.disabled = true;
    try {
      await ensureAccount();
      await client.commit(reportWrites(config, client.uid, row.nick, randomId()));
      button.textContent = t('predict.reported');
    } catch (error) { button.disabled = false; toast(errorText(error), 'error'); }
  }

  /* ---- mini-leagues ----------------------------------------------------------------------------------------- */

  function leaguesSection() {
    S.myLeagues = json(store.get('predict.leagues'), []);
    const box = h('section', { class: 'pleagues' }, h('h2', {}, t('predict.leagues.title')), h('p', { class: 'pintro' }, t('predict.leagues.intro')));
    const shown = h('div', { class: 'pleagues__board' });
    const list = h('ul', { class: 'pleagues__list' }, S.myLeagues.map((entry) => h('li', {},
      h('button', { type: 'button', class: 'plink', on: { click: () => showLeague(entry.code, shown) } }, `${entry.name} · ${entry.code}`))));
    const nameInput = h('input', { type: 'text', class: 'pfield', maxLength: 30, attrs: { 'aria-label': t('predict.leagues.name'), placeholder: t('predict.leagues.name') } });
    const codeInput = h('input', { type: 'text', class: 'pfield', maxLength: 8, attrs: { 'aria-label': t('predict.leagues.code'), placeholder: t('predict.leagues.code'), autocapitalize: 'characters' } });
    const message = h('p', { class: 'pleagues__msg', attrs: { 'aria-live': 'polite' } });
    const remember = (code, name) => {
      if (!S.myLeagues.some((e) => e.code === code)) S.myLeagues.push({ code, name });
      store.set('predict.leagues', JSON.stringify(S.myLeagues));
    };
    const create = h('button', { type: 'button', class: 'pbtn', on: { click: async () => {
      const name = nameInput.value.trim();
      if (name.length < 2) { message.textContent = t('predict.leagues.shortname'); return; }
      try {
        await ensureAccount();
        const code = newLeagueCode();
        await client.commit(leagueCreateWrites(config, client.uid, code, name));
        await client.commit(leagueJoinWrites(config, client.uid, code));
        remember(code, name);
        message.textContent = t('predict.leagues.created', { code });
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
        await client.commit(leagueJoinWrites(config, client.uid, code));
        remember(code, found.name);
        message.textContent = t('predict.leagues.joined', { name: found.name });
        render();
      } catch (error) { message.textContent = errorText(error); }
    } } }, t('predict.leagues.join'));
    box.append(list, h('div', { class: 'pleagues__form' }, nameInput, create), h('div', { class: 'pleagues__form' }, codeInput, join), message, shown);
    return box;
  }

  async function showLeague(code, target) {
    target.replaceChildren(h('p', { class: 'pload' }, t('predict.loading')));
    try {
      const board = await client.get(`boards/league_${code}`);
      target.replaceChildren(boardTable(board));
    } catch (error) { target.replaceChildren(emptyState(error, () => showLeague(code, target))); }
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
    body.replaceChildren(profileSection(), statsSection(), dataSection(true));
  }

  function profileSection() {
    const profile = S.profile || {};
    const nick = h('input', { type: 'text', class: 'pfield', value: profile.nick || '', maxLength: 20, attrs: { 'aria-label': t('predict.me.nick') } });
    const message = h('p', { class: 'pme__msg', attrs: { 'aria-live': 'polite' } });
    const change = h('button', { type: 'button', class: 'pbtn', on: { click: async () => {
      const next = nick.value;
      const problems = nickProblems(next);
      if (problems.includes('format')) { message.textContent = t('predict.nick.format'); return; }
      if (problems.includes('reserved') || nickBlocked(next)) { message.textContent = t('predict.nick.reserved'); return; }
      if (next === profile.nick) return;
      if (profile.nickCustom && profile.nickAt && now() - profile.nickAt.getTime() < 30 * 86400000) {
        message.textContent = t('predict.nick.wait', { span: spanText(profile.nickAt.getTime() + 30 * 86400000 - now()) });
        return;
      }
      try {
        await client.commit(nicknameChangeWrites(config, client.uid, profile.nick, next));
        S.profile = { ...profile, nick: next, nickLower: nickLower(next), nickCustom: true, nickAt: new Date(now()) };
        message.textContent = t('predict.nick.saved');
      } catch (error) { message.textContent = error.code === 'denied' ? t('predict.nick.taken') : errorText(error); }
    } } }, t('predict.nick.change'));
    const hidden = h('input', { type: 'checkbox', checked: Boolean(profile.hidden), on: { change: async (e) => {
      try { await client.commit(profileUpdateWrites(config, client.uid, { hidden: e.target.checked })); S.profile = { ...profile, hidden: e.target.checked }; }
      catch (error) { e.target.checked = !e.target.checked; toast(errorText(error), 'error'); }
    } } });
    const clubs = ['', ...new Set(((S.index && S.index.clubs) || []))];
    const club = h('input', { type: 'text', class: 'pfield', value: profile.club || '', maxLength: 40, attrs: { 'aria-label': t('predict.me.club') },
      on: { change: async (e) => { try { await client.commit(profileUpdateWrites(config, client.uid, { club: e.target.value.trim() })); } catch (error) { toast(errorText(error), 'error'); } } } });
    void clubs;
    return h('section', { class: 'pme' }, h('h2', {}, t('predict.me.title')),
      h('label', { class: 'pme__row' }, h('span', {}, t('predict.me.nick')), nick, change), message,
      h('label', { class: 'pme__row pme__row--check' }, hidden, h('span', {}, t('predict.me.hidden'))),
      h('label', { class: 'pme__row' }, h('span', {}, t('predict.me.club')), club));
  }

  function statsSection() {
    const season = S.index && S.index.season;
    const totals = season ? seasonTotals(S.stats, season) : { n: 0, ab: 0, ar: 0, b: 0, r: 0, vm: 0, rounds: 0 };
    const streak = streakNow();
    const box = h('section', { class: 'pstats' }, h('h2', {}, t('predict.stats.title')));
    if (!totals.n) { box.append(h('p', { class: 'pempty' }, t('predict.stats.none'))); return box; }
    const cell = (label, value) => h('div', { class: 'pstats__cell' }, h('dt', {}, label), h('dd', {}, value));
    box.append(h('dl', { class: 'pstats__grid' },
      cell(t('predict.col.n'), String(totals.n)), cell(t('predict.col.ab'), signed(totals.ab)), cell(t('predict.col.ar'), signed(totals.ar)),
      cell(t('predict.col.b'), fixed(totals.b / totals.n, 2)), cell(t('predict.col.r'), fixed(totals.r / totals.n, 2)),
      cell(t('predict.stats.vm'), signed(totals.vm)), cell(t('predict.stats.streak'), `${streak.current} (${t('predict.stats.best', { n: streak.best })})`)));
    const badges = badgesFor({ tips: totals.n, totals, streak: streak.best });
    box.append(h('ul', { class: 'pbadges' }, badges.map((b) => h('li', { class: 'pbadge pbadge--b', data: { earned: String(b.earned) } }, t(`predict.badge.${b.id}`)))));
    const chart = h('div', { class: 'pcal' });
    box.append(totals.n >= 30 ? h('button', { type: 'button', class: 'pbtn', on: { click: (e) => { e.currentTarget.remove(); calibration(chart); } } }, t('predict.cal.show'))
      : h('p', { class: 'pintro' }, t('predict.cal.later', { n: 30 - totals.n })), chart);
    return box;
  }

  /* The streak over the division you play most: finished rounds, completed when you tipped every match. */
  function streakNow() {
    const rows = (S.stats && S.stats.rounds) || {};
    const season = S.index && S.index.season;
    if (!season) return { current: 0, best: 0, freezes: 0 };
    let best = { current: 0, best: 0, freezes: 0 };
    for (const league of LEAGUES) {
      const finished = leagueRounds(league).filter((r) => roundStatus(r, now()) === 'done');
      let started = false;
      const flags = [];
      for (const round of finished) {
        const mine = rows[round.key];
        if (mine) started = true;
        if (started) flags.push(Boolean(mine) && mine.n >= round.n);
      }
      const result = computeStreak(flags);
      if (result.best > best.best || result.current > best.current) best = result;
    }
    return best;
  }

  /* Calibration, once, on request: your entries and the reveal documents of the rounds you played. */
  async function calibration(target) {
    target.replaceChildren(h('p', { class: 'pload' }, t('predict.loading')));
    try {
      const cached = json(store.get(`predict.cal.${client.uid}`), {});
      const entries = await client.list(`entries/${client.uid}/rounds`, 100);
      const points = [];
      for (const { id, data } of entries) {
        let rows = cached[id];
        if (!rows) {
          const reveal = await client.get(`reveal/${id}`);
          rows = [];
          for (const [slot, pick] of Object.entries(data.p || {})) {
            const result = reveal && reveal.matches && reveal.matches[slot] && reveal.matches[slot].result;
            if (!result) continue;
            const outcome = outcomeOf(result.hg, result.ag);
            const [hh, dd, aa] = [pick.h, pick.d, pick.a];
            rows.push([[hh / 100, outcome === 'home_win' ? 1 : 0], [dd / 100, outcome === 'draw' ? 1 : 0], [aa / 100, outcome === 'away_win' ? 1 : 0]]);
          }
          if (reveal && reveal.matches && Object.values(reveal.matches).length === Object.keys(data.p || {}).length) cached[id] = rows;
        }
        rows.forEach((row) => row.forEach(([p, hit]) => points.push({ p, hit })));
      }
      store.set(`predict.cal.${client.uid}`, JSON.stringify(cached));
      target.replaceChildren(calibrationChart(calibrationBins(points)));
    } catch (error) { target.replaceChildren(emptyState(error, () => calibration(target))); }
  }

  function calibrationChart(bins) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 220 200');
    svg.setAttribute('class', 'pcal__svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', t('predict.cal.label'));
    const dots = bins.filter((b) => b.n >= 3).map((b) => `<circle cx="${(10 + b.said * 200).toFixed(1)}" cy="${(190 - b.happened * 180).toFixed(1)}" r="${Math.min(8, 2 + Math.sqrt(b.n)).toFixed(1)}" class="pcal__dot"/>`).join('');
    svg.innerHTML = `<line x1="10" y1="190" x2="210" y2="10" class="pcal__diag"/><rect x="10" y="10" width="200" height="180" class="pcal__frame"/>${dots}`;
    return h('figure', { class: 'pcal__fig' }, svg, h('figcaption', {}, t('predict.cal.caption')));
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

  function googleBlock() {
    const session = client.session || {};
    const box = h('div', { class: 'pgoogle' });
    if (session.google) { box.append(h('p', {}, t('predict.google.linked'))); return box; }
    const message = h('p', { class: 'pme__msg', attrs: { 'aria-live': 'polite' } });
    const holder = h('div', { class: 'pgoogle__button' });
    const start = h('button', { type: 'button', class: 'pbtn', on: { click: async () => {
      message.textContent = t('predict.loading');
      try {
        await loadGoogle();
        window.google.accounts.id.initialize({ client_id: config.googleClientId, callback: (reply) => finish(reply.credential) });
        window.google.accounts.id.renderButton(holder, { theme: 'outline', size: 'large', text: 'signin_with', locale: lang() === 'no' ? 'nb' : 'en' });
        message.textContent = t('predict.google.pick');
      } catch (error) { message.textContent = errorText(error); }
    } } }, t('predict.google.link'));
    async function finish(credential) {
      try {
        await client.linkGoogle(credential, location.origin);
        toast(t('predict.google.done'));
        render();
      } catch (error) {
        if (error.code === 'already_linked') {
          message.replaceChildren(t('predict.google.conflict'), ' ',
            h('button', { type: 'button', class: 'pbtn', on: { click: () => { message.textContent = t('predict.google.kept'); } } }, t('predict.google.keep')), ' ',
            confirmable(t('predict.google.switch'), t('predict.google.switch.q'), async () => {
              try { await client.signInGoogle(credential, location.origin); resetLocal(); await boot(); } catch (e) { message.textContent = errorText(e); }
            }, 'pbtn'));
        } else message.textContent = errorText(error);
      }
    }
    box.append(h('p', {}, t('predict.google.why')), start, holder, message);
    return box;
  }

  function dataSection(signedIn) {
    const message = h('p', { class: 'pme__msg', attrs: { 'aria-live': 'polite' } });
    const del = confirmable(t('predict.delete'), t('predict.delete.q'), async () => {
      try {
        if (client.uid) {
          await client.commit(deleteRequestWrites(config, client.uid));
          await client.deleteAccount();
        }
        resetLocal();
        message.textContent = t('predict.delete.done');
        S.profile = null; S.stats = null;
      } catch (error) { message.textContent = errorText(error); }
    });
    return h('section', { class: 'pdata' }, h('h2', {}, t('predict.data.title')), signedIn ? googleBlock() : null,
      h('p', {}, t('predict.data.text')), client.uid ? del : null, message);
  }

  function resetLocal() {
    for (const key of store.keys()) if (key.startsWith('predict.')) store.remove(key);
    S.data = {}; S.drafts = {}; S.status = {}; S.ownHash = null; S.stats = undefined; S.profile = undefined;
  }

  /* ---- the shell --------------------------------------------------------------------------------------------- */

  const TABS = ['tip', 'table', 'boards', 'me'];

  function renderTabs() {
    const holder = document.getElementById('predict-tabs');
    holder.replaceChildren(h('div', { class: 'switch', attrs: { role: 'group', 'aria-label': t('predict.tabs') } },
      TABS.map((tab) => h('button', { type: 'button', data: { tab }, attrs: { 'aria-pressed': String(S.tab === tab) }, on: { click: () => { S.tab = tab; render(); } } }, t(`predict.tab.${tab}`)))));
  }

  function render() {
    renderTabs();
    const root = document.getElementById('predict-view');
    root.replaceChildren();
    root.dataset.tab = S.tab;
    if (S.tab === 'tip') renderTip(root);
    else if (S.tab === 'table') renderTable(root);
    else if (S.tab === 'boards') renderBoards(root);
    else renderMe(root);
    if (S.note) toast(S.note.text, S.note.kind);
  }

  async function loadAndRender() {
    document.getElementById('predict-view').replaceChildren(h('p', { class: 'pload' }, t('predict.loading')));
    await loadIndex();
    render();
  }

  async function boot() {
    await loadIndex();
    if (client.uid) loadProfile();
    render();
  }

  function setLanguage(next) {
    setLang(next);
    document.documentElement.dataset.lang = next;
    document.querySelectorAll('.doc__top [data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === next)));
    translateStatic();
    render();
  }

  function translateStatic() {
    document.querySelectorAll('[data-t]').forEach((node) => { node.textContent = t(node.dataset.t); });
    document.title = t('predict.title');
  }

  document.querySelectorAll('.doc__top [data-lang]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.lang === lang()));
    button.addEventListener('click', () => setLanguage(button.dataset.lang));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.tab === 'tip') { const round = currentRound(S.league); if (round && roundStatus(round, now()) === 'live') ensureRound(round, true).then(render); }
  });
  translateStatic();
  boot();
})();
