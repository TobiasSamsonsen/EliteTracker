/* Small pure helpers of the Predict page: number formatting (a decimal point in both
   languages, grouping per language), relative time, round status, and
   calibration arithmetic, and the slider's typed-number search. No DOM; the node
   tests (tests/predict-ui.test.js) require this file.

   A classic script: load it after predict-core.js. */

const predictUtilCore = (typeof module !== 'undefined' && typeof require !== 'undefined')
  ? require('./predict-core.js') : { GAP, DRAW_TENTHS, pickPercentages, equivalentGap };

/* ---- numbers ------------------------------------------------------------------------ */

/* 50 000 in Norwegian (none at four digits: 1794), 50,000 in English (and 1,794). */
function groupThousands(value, lang) {
  const digits = String(Math.round(Math.abs(value)));
  const sign = value < 0 ? '-' : '';
  if (lang === 'no') return sign + (digits.length > 4 ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : digits);
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* A decimal point in both languages, never a comma. */
function fixed(value, digits = 1) {
  return Number(value).toFixed(digits);
}

/* "69.2 %" in Norwegian, "69.2%" in English. */
function percentText(value, lang, digits = 1) {
  return `${fixed(value, digits)}${lang === 'no' ? ' %' : '%'}`;
}

/* A signed score: "+0.07", "-0.12". */
function signedScore(value, digits = 2) {
  const text = fixed(value, digits);
  return Number(text) > 0 ? `+${text}` : text;
}

/* ---- time -------------------------------------------------------------------------- */

/* The largest whole unit in a span: { unit, n } with unit minute, hour, day or week. */
function spanParts(ms) {
  const minutes = Math.floor(Math.abs(ms) / 60000);
  if (minutes < 1) return { unit: 'now', n: 0 };
  if (minutes < 60) return { unit: 'minute', n: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: 'hour', n: hours };
  const days = Math.floor(hours / 24);
  if (days < 14) return { unit: 'day', n: days };
  return { unit: 'week', n: Math.floor(days / 7) };
}

const ROUND_OVER_AFTER = 3 * 3600 * 1000;   // a round is over three hours after its last kick-off

/* future: not open yet; open: open and nothing has kicked off; live: a match is on (a kick-off in
   the last three hours); partial: some matches are played and others are still ahead, none on now
   (a match played early or put off); done: all over. `round` has opens, closes, last (Dates) and,
   from the job, kicks (every distinct kick-off; without it a started round is simply live). */
function roundStatus(round, nowMs) {
  if (round.opens.getTime() > nowMs) return 'future';
  if (round.closes.getTime() > nowMs) return 'open';
  if (round.last && round.last.getTime() + ROUND_OVER_AFTER > nowMs) {
    const kicks = Array.isArray(round.kicks) ? round.kicks : [];
    const on = kicks.some((k) => k.getTime() <= nowMs && k.getTime() > nowMs - ROUND_OVER_AFTER);
    return kicks.length && !on ? 'partial' : 'live';
  }
  return 'done';
}

/* The round a division opens on: the one with something to tip or watch soonest (a match on now, else the
   earliest kick-off still ahead), the lower round on a tie; the last round when the season is over. A round
   with one match put off for weeks is not it while the next round is days away. Without the kick-offs
   (an older index) it is the first round not over. */
function currentRoundIndex(rounds, nowMs) {
  const open = rounds.map((round, index) => ({ round, index })).filter(({ round }) => roundStatus(round, nowMs) !== 'done');
  if (!open.length) return Math.max(0, rounds.length - 1);
  if (open.some(({ round }) => !Array.isArray(round.kicks) || !round.kicks.length)) return open[0].index;
  const soonest = ({ round }) => {
    if (roundStatus(round, nowMs) === 'live') return -Infinity;
    const ahead = round.kicks.map((k) => k.getTime()).filter((k) => k > nowMs);
    return ahead.length ? Math.min(...ahead) : Infinity;
  };
  return open.reduce((best, one) => (soonest(one) < soonest(best) ? one : best)).index;
}

const isLocked = (kickoff, nowMs) => kickoff.getTime() <= nowMs;

/* A draft is saved in one commit, and the rules refuse the whole commit if one slot has kicked off.
   Split a draft into the slots still open and the ones that have locked (or are not in the round
   at all); `slots` is the round's fixture slots, or null when they are not loaded (keep all). */
function splitDraft(draft, slots, nowMs) {
  const open = [];
  const locked = [];
  for (const slot of Object.keys(draft || {})) {
    if (!slots) open.push(slot);
    else if (slots[slot] && !isLocked(slots[slot].kickoff, nowMs)) open.push(slot);
    else locked.push(slot);
  }
  return { open, locked };
}

/* Run `task` after whatever is in flight under `key`, so two saves of one round never overlap or land out
   of order: the second one reads the draft when its turn comes, so the newer pick is the one that stays. */
function inSequence(flights, key, task) {
  const run = (flights[key] || Promise.resolve()).catch(() => {}).then(task);
  flights[key] = run;
  const clear = () => { if (flights[key] === run) delete flights[key]; };
  run.then(clear, clear);
  return run;
}

/* The game's first season: no board exists for an earlier one. The picker offers the current season and
   the three before it, no further back than the launch. */
const LAUNCH_SEASON = 2026;
function boardSeasons(current, launch = LAUNCH_SEASON) {
  if (!current) return [];
  const seasons = [0, 1, 2, 3].map((back) => current - back).filter((season) => season >= launch);
  return seasons.length ? seasons : [current];
}

/* Drafts saved while signed out belong to no account yet: the keys to move to `uid` once it exists. */
const draftKeysToMove = (keys) => keys.filter((k) => k.startsWith('predict.draft.new.'));

/* Move every draft saved before there was an account to the account's key, value and all: a draft for a
   round the page has not loaded is in storage only, so it has to be carried over, not re-saved from memory. */
function moveDrafts(storage, uid) {
  for (const key of draftKeysToMove(storage.keys())) {
    const value = storage.get(key);
    storage.remove(key);
    if (value !== null && value !== undefined) storage.set(key.replace('predict.draft.new.', `predict.draft.${uid}.`), value);
  }
}

/* localStorage keys a reset clears: all of Predict's, except the one to keep (the session). */
const keysToReset = (keys, keep) => keys.filter((k) => k.startsWith('predict.') && k !== keep);

/* ---- club names ----------------------------------------------------------------------- */

/* A Firestore document with its clubs by the site's short names (map: registered name -> short): every
   `home` and `away` string and every value of a `names` map, at any depth. Dates and other values pass
   through; the document is copied, not changed. */
function shortClubNames(doc, map) {
  const walk = (value, key) => {
    if (typeof value === 'string') return (key === 'home' || key === 'away') && map[value] ? map[value] : value;
    if (Array.isArray(value)) return value.map((item) => walk(item, null));
    if (!value || typeof value !== 'object' || value instanceof Date) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = key === 'names' && typeof v === 'string' ? map[v] || v : walk(v, k);
    }
    return out;
  };
  return walk(doc, null);
}

/* ---- progress, calibration ------------------------------------------------------ */

function ringState(done, total) {
  return { done, total, fraction: total ? done / total : 0, complete: total > 0 && done >= total };
}


/* Ten bins of what you said against what happened: points are { p: fraction, hit: 0 or 1 }. */
function calibrationBins(points, bins = 10) {
  const out = Array.from({ length: bins }, (_, i) => ({ low: i / bins, high: (i + 1) / bins, n: 0, said: 0, happened: 0 }));
  for (const { p, hit } of points) {
    const bin = out[Math.min(bins - 1, Math.floor(p * bins))];
    bin.n += 1;
    bin.said += p;
    bin.happened += hit;
  }
  return out.map((b) => ({ ...b, said: b.n ? b.said / b.n : null, happened: b.n ? b.happened / b.n : null }));
}

/* The calibration chart's points from the settled picks (the history rows): for each match three
   statements, home, draw and away, each with what you said and whether it happened. */
function calibrationPoints(rows) {
  const points = [];
  for (const row of rows || []) {
    const hit = row.hg > row.ag ? 0 : row.hg < row.ag ? 2 : 1;
    row.pick.forEach((percent, side) => points.push({ p: percent / 100, hit: side === hit ? 1 : 0 }));
  }
  return points;
}

/* Your round totals added up for a season (stats/{uid}.rounds keys are `${season}_${league}_${round}`). */
function seasonTotals(stats, season, league) {
  const total = { n: 0, b: 0, r: 0, ab: 0, ar: 0, vm: 0, rounds: 0 };
  for (const [key, row] of Object.entries((stats && stats.rounds) || {})) {
    if (!key.startsWith(`${season}_${league ? `${league}_` : ''}`)) continue;
    for (const field of ['n', 'b', 'r', 'ab', 'ar', 'vm']) total[field] += row[field] || 0;
    total.rounds += 1;
  }
  return total;
}

/* The rounds a board of this scope adds up, as stats keys: a round board is one round; the last-10 board is the last ten
   rounds of the division with a scored match (the job's own rule, boards.py LAST_ROUNDS), oldest first. */
const LAST_ROUNDS = 10;
function scopeKeys(index, { season, league, scope, round }) {
  if (scope === 'round') return round ? [`${season}_${league}_${round}`] : [];
  const scored = ((index && index.rounds) || []).filter((r) => r.league === league && r.settled > 0).sort((a, b) => a.round - b.round);
  return scored.slice(-LAST_ROUNDS).map((r) => r.key);
}

/* Your totals over some rounds (stats keys), shaped like seasonTotals. */
function keysTotals(stats, keys) {
  const total = { n: 0, b: 0, r: 0, ab: 0, ar: 0, vm: 0, rounds: 0 };
  for (const key of keys) {
    const row = stats && stats.rounds && stats.rounds[key];
    if (!row) continue;
    for (const field of ['n', 'b', 'r', 'ab', 'ar', 'vm']) total[field] += row[field] || 0;
    total.rounds += 1;
  }
  return total;
}

/* Badges earned, from your numbers: [{ id, earned }]. */
function badgesFor({ tips, totals }) {
  return [
    { id: 'first', earned: tips >= 1 },
    { id: 'thirty', earned: tips >= 30 },
    { id: 'beatModel', earned: totals.n >= 10 && totals.vm > 0 },
    { id: 'beatField', earned: totals.n >= 10 && totals.ab > 0 },
  ];
}

/* ---- the slider, from typed numbers ----------------------------------------------------------- */

/* The slider position nearest a typed percent for one outcome ('h', 'd' or 'a'). The draw is
   moved by the draw tendency when `fineTune` is on (the gap stays), otherwise by the gap. */
function nearestPosition(outcome, typed, gap, tenths, fineTune) {
  const { GAP, DRAW_TENTHS, pickPercentages } = predictUtilCore;
  const column = { h: 0, d: 1, a: 2 }[outcome];
  const miss = (g, k) => Math.abs(pickPercentages(g, k)[column] - typed);
  let best = { gap, tenths };
  let bestMiss = Infinity;
  if (outcome === 'd' && fineTune) {
    for (let k = DRAW_TENTHS.min; k <= DRAW_TENTHS.max; k += 1) {
      if (miss(gap, k) < bestMiss) { bestMiss = miss(gap, k); best = { gap, tenths: k }; }
    }
    return best;
  }
  for (let g = GAP.min; g <= GAP.max; g += GAP.step) {
    const m = miss(g, tenths);
    if (m < bestMiss || (m === bestMiss && Math.abs(g) < Math.abs(best.gap))) { bestMiss = m; best = { gap: g, tenths }; }
  }
  return best;
}

/* Every slider position (gap and draw tendency) with its whole percents, worked out once: the draw
   block's ends and the typed numbers search it. */
let positionCells = null;
function positionGrid() {
  if (!positionCells) {
    const { GAP, DRAW_TENTHS, pickPercentages } = predictUtilCore;
    positionCells = [];
    for (let k = DRAW_TENTHS.min; k <= DRAW_TENTHS.max; k += 1) {
      for (let g = GAP.min; g <= GAP.max; g += GAP.step) positionCells.push({ g, k, p: pickPercentages(g, k) });
    }
  }
  return positionCells;
}

/* The slider position nearest a home and an away percent: the draw block's two ends, each dragged
   on its own (the draw is what is left between them). `hold` ('h' or 'a') is the end that should
   stay put: a miss there weighs four times as much, so dragging one end leaves the other where it
   is while the curve allows. Ties go to the gap nearer the middle, then the draw tendency nearer
   normal. Returns { gap, tenths }. */
function positionForEdges(home, away, hold = null) {
  const { DRAW_TENTHS } = predictUtilCore;
  const wh = hold === 'h' ? 4 : 1;
  const wa = hold === 'a' ? 4 : 1;
  let best = null;
  let bestMiss = Infinity;
  for (const cell of positionGrid()) {
    const miss = wh * Math.abs(cell.p[0] - home) + wa * Math.abs(cell.p[2] - away);
    const tie = best && Math.abs(miss - bestMiss) < 1e-9;
    if (miss < bestMiss - 1e-9 || (tie && (Math.abs(cell.g) < Math.abs(best.g)
      || (Math.abs(cell.g) === Math.abs(best.g) && Math.abs(cell.k - DRAW_TENTHS.normal) < Math.abs(best.k - DRAW_TENTHS.normal))))) {
      best = cell;
      bestMiss = miss;
    }
  }
  return { gap: best.g, tenths: best.k };
}

/* A typed number for one outcome ('h', 'd' or 'a'), from the pick on show (`p`, whole percents):
   home or away moves its own end of the draw block and holds the other; a draw keeps the split
   between home and away and makes room for itself on both sides. */
function positionForTyped(outcome, typed, p) {
  if (outcome === 'h') return positionForEdges(typed, p[2], 'a');
  if (outcome === 'a') return positionForEdges(p[0], typed, 'h');
  const rest = 100 - typed;
  const sides = p[0] + p[2] || 1;
  return positionForEdges((rest * p[0]) / sides, (rest * p[2]) / sides);
}

/* Fine-tune on: the pick is three whole percents of its own, off the curve, each at least 1 (so at
   most 98) and summing to 100 (FREE_MIN; the curve's own picks stay within 2..96), moved one percent at a time. `mode` is the part dragged: 'left' (the home / draw edge, the
   away share held), 'right' (the draw / away edge, the home share held) or 'move' (the whole block,
   its width held; `percent` is then where its middle goes). */
const FREE_MIN = 1;
const FREE_MAX = 100 - 2 * FREE_MIN;
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
function freeEdges(p, mode, percent) {
  const [h, d, a] = p;
  const room = 100 - FREE_MIN;
  if (mode === 'left') { const nh = clampInt(percent, FREE_MIN, room - a); return [nh, 100 - nh - a, a]; }
  if (mode === 'right') { const na = clampInt(100 - percent, FREE_MIN, room - h); return [h, 100 - h - na, na]; }
  const nh = clampInt(percent - d / 2, FREE_MIN, room - d);
  return [nh, d, 100 - nh - d];
}

/* A typed number with fine-tune on: home or away takes what it is given and the draw makes way (the
   other side gives too, only when the draw is down to the floor); a draw keeps the split between the sides. */
function freeTyped(outcome, typed, p) {
  const v = clampInt(typed, FREE_MIN, FREE_MAX);
  const room = 100 - FREE_MIN;
  if (outcome === 'h') { const a = Math.min(p[2], room - v); return [v, 100 - v - a, a]; }
  if (outcome === 'a') { const h = Math.min(p[0], room - v); return [h, 100 - h - v, v]; }
  const rest = 100 - v;
  const h = clampInt((rest * p[0]) / (p[0] + p[2] || 1), FREE_MIN, rest - FREE_MIN);
  return [h, v, rest - h];
}

/* The slider position stored beside free percents (the rules want one, and the crowd's signal reads
   the gap): the gap whose expected score the percents have, and the nearest draw tendency. */
function freePosition(p) {
  const { GAP, equivalentGap } = predictUtilCore;
  const gap = clampInt(equivalentGap(p[0] / 100, p[1] / 100) / GAP.step, GAP.min / GAP.step, GAP.max / GAP.step) * GAP.step;
  return { gap, tenths: positionForEdges(p[0], p[2]).tenths };
}

/* A saved pick made with fine-tune on: its percents are not the curve's at its position. */
function isFreePick(pick) {
  const { pickPercentages } = predictUtilCore;
  return Boolean(pick) && Number.isInteger(pick.h) && String([pick.h, pick.d, pick.a]) !== String(pickPercentages(pick.g, pick.k));
}

/* The slider position under a pointer on the bar (left: the away side, right: the home side). */
function gapAtFraction(fraction) {
  const { GAP } = predictUtilCore;
  const clamped = Math.min(1, Math.max(0, fraction));
  const raw = GAP.min + clamped * (GAP.max - GAP.min);
  return Math.max(GAP.min, Math.min(GAP.max, Math.round(raw / GAP.step) * GAP.step));
}

/* ---- the table game's rules text ------------------------------------------------------------------- */

/* predict/tables.py BONUSES, as the page words them. */
/* The table game's drag: where a dragged row lands is the number of the other rows whose middle
   lies above its own middle (`mids`: the rows' middles before the drag, `from`: its place then). */
function dropIndex(mids, from, centre) {
  let n = 0;
  mids.forEach((mid, i) => { if (i !== from && mid < centre) n += 1; });
  return n;
}

/* A copy of `list` with the item at `from` moved to `to`, the rest closing up behind it. */
function moveItem(list, from, to) {
  const out = list.slice();
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item);
  return out;
}

const TABLE_BONUS = {
  eliteserien: { champion: 6, relegation: 3 },
  obosligaen: { promotion: 4, relegation: 3 },
};

/* ---- keys ------------------------------------------------------------------------------------------- */

const draftKey = (uid, roundKey) => `predict.draft.${uid || 'new'}.${roundKey}`;
const roundKeyOf = (season, league, round) => `${season}_${league}_${round}`;

/* ---- where you stand: the season panel's numbers ------------------------------------------------ */

/* A long leaderboard, shortened: the top `top` rows, the `around` rows above and below yours, and
   every row `always` keeps (the model and the average), in the board's order, with { gap: n } where
   n rows are left out. A gap of one row is no saving, so that row stays. */
function boardWindow(rows, mine, { top = 10, around = 5, always = () => false } = {}) {
  const keep = new Set();
  for (let i = 0; i < Math.min(top, rows.length); i++) keep.add(i);
  if (mine >= 0) for (let i = Math.max(0, mine - around); i <= Math.min(rows.length - 1, mine + around); i++) keep.add(i);
  rows.forEach((row, i) => { if (always(row)) keep.add(i); });
  const out = [];
  let hidden = [];
  const flush = () => {
    if (hidden.length === 1) out.push({ row: rows[hidden[0]] });
    else if (hidden.length) out.push({ gap: hidden.length });
    hidden = [];
  };
  rows.forEach((row, i) => {
    if (keep.has(i)) { flush(); out.push({ row }); } else hidden.push(i);
  });
  flush();
  return out;
}

/* The share of players you beat (0..100), from a board's 101 percentile cut-offs. Up to 101 players
   the cut-offs are the players' own sorted scores, so the share is exact (the others below you
   over the others); with more it is read off the cut-offs. */
function beatShare(pct, value, players) {
  if (!pct || !pct.length) return null;
  if (Number.isInteger(players) && players >= 1 && players <= 101) {
    if (players === 1) return 0;
    const last = players - 1;
    let below = 0;
    for (let i = 0; i <= last; i += 1) if (pct[Math.round((i * 100) / last)] < value) below += 1;
    return Math.round((below / last) * 100);
  }
  return Math.max(0, Math.min(100, pct.filter((v) => v < value).length - 1));
}

/* A normal curve for the field, from the percentile table: the median as its middle, half the
   16th-84th spread as its standard deviation (a robust fit that ignores a few wild scores). */
function normalFit(pct) {
  if (!pct || pct.length < 101) return null;
  const mean = pct[50];
  const sd = Math.max((pct[84] - pct[16]) / 2, 0.02);
  return { mean, sd };
}

const normalDensity = (x, mean, sd) => Math.exp(-0.5 * ((x - mean) / sd) ** 2);

/* A tier by the share of players you beat, and how far the next one is. Named apart from the podium's
   gold, silver and bronze, which are places on one board. */
const TIERS = [{ id: 'elite', at: 90 }, { id: 'expert', at: 75 }, { id: 'analyst', at: 50 }, { id: 'contender', at: 0 }];
function tierOf(beat) {
  const index = TIERS.findIndex((tier) => beat >= tier.at);
  const tier = TIERS[index];
  const next = index > 0 ? TIERS[index - 1] : null;
  return { id: tier.id, next: next ? next.id : null, toNext: next ? next.at - beat : 0 };
}

/* Your accuracy in each of your last rounds in one division, oldest first. */
function roundForm(stats, season, league, count = 8) {
  const prefix = `${season}_${league}_`;
  return Object.entries((stats && stats.rounds) || {})
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, row]) => ({ round: Number(key.slice(prefix.length)), ab: row.ab || 0, n: row.n || 0,
      pts: 10 * ((row.n || 0) - (row.b || 0)) }))                      // points, as predict-core's totalPoints
    .sort((a, b) => a.round - b.round)
    .slice(-count);
}

/* ---- who you are on a board, and your season in rounds ------------------------------------------ */

/* Rank among people only: the model and the crowd stand on a board for comparison and take no place.
   A board's own `place` counts hidden players too, and wins; a board built before it counts the listed
   players, a tie sharing the better place. Returns Map(row -> place) for the player rows. */
function humanRanks(rows) {
  const players = (rows || []).filter((r) => r.kind === 'player');
  const place = new Map();
  players.forEach((row, i) => {
    const before = players[i - 1];
    place.set(row, Number.isInteger(row.place) ? row.place : before && before.rank === row.rank ? place.get(before) : i + 1);
  });
  return place;
}

/* The players next to you: who is just ahead and just behind, and the points between you. `rows` are in
   board order (best first); `points` reads a row's points. */
function rivalsOf(rows, isMine, points) {
  const players = (rows || []).filter((r) => r.kind === 'player');
  const at = players.findIndex(isMine);
  if (at < 0) return null;
  const mine = points(players[at]);
  const ahead = at > 0 ? players[at - 1] : null;
  const behind = at < players.length - 1 ? players[at + 1] : null;
  return { place: Number.isInteger(players[at].place) ? players[at].place : at + 1, ahead, behind, toAhead: ahead ? points(ahead) - mine : null, toBehind: behind ? mine - points(behind) : null };
}

/* What the leaderboard's standing card says: your place, the share of players you beat (and the tier and
   the "top n %" it gives), how far you are ahead of or behind the model, and how close the player
   ahead is (`reach`: your points as a share of theirs, 100 when nobody is ahead). Null when you are
   not on the board. `rows` are in board order; `pct` and `players` are the board's. */
function standingOf(rows, pct, players, isMine, points) {
  const rivals = rivalsOf(rows, isMine, points);
  if (!rivals) return null;
  const mine = (rows || []).find((r) => r.kind === 'player' && isMine(r));
  const pts = points(mine);
  const beat = beatShare(pct, pts, players);
  const model = (rows || []).find((r) => r.kind === 'model');
  return {
    ...rivals, me: mine, pts, beat, tier: beat === null ? null : tierOf(beat).id, top: beat === null ? null : Math.max(1, 100 - beat),
    modelGap: model ? pts - points(model) : null,
    reach: rivals.ahead ? Math.max(0, Math.min(100, (pts / Math.max(1, points(rivals.ahead))) * 100)) : 100,
  };
}

/* The seasons your stats hold, newest first. */
function statsSeasons(stats) {
  const seen = new Set();
  for (const key of Object.keys((stats && stats.rounds) || {})) {
    const season = Number(key.split('_')[0]);
    if (Number.isInteger(season)) seen.add(season);
  }
  return [...seen].sort((a, b) => b - a);
}

/* One season round by round, both divisions (or one) merged on the round number: what the round
   was worth, and the running accuracy of you and of the model over the same matches (accuracy
   as predict-core's accuracyPercent: 100 x (1 - average Brier / 2)). */
function seasonSeries(stats, season, league) {
  const byRound = new Map();
  for (const [key, row] of Object.entries((stats && stats.rounds) || {})) {
    const parts = key.split('_');
    if (Number(parts[0]) !== season || (league && parts[1] !== league)) continue;
    const round = Number(parts[2]);
    if (!Number.isInteger(round) || !(row.n > 0)) continue;
    const sum = byRound.get(round) || { n: 0, b: 0, vm: 0 };
    sum.n += row.n; sum.b += row.b || 0; sum.vm += row.vm || 0;
    byRound.set(round, sum);
  }
  let n = 0;
  let b = 0;
  let vm = 0;
  return [...byRound.entries()].sort((x, y) => x[0] - y[0]).map(([round, r]) => {
    n += r.n; b += r.b; vm += r.vm;
    return { round, n: r.n, pts: 10 * (r.n - r.b), vm: 10 * r.vm,
      acc: 100 * (1 - b / n / 2), model: 100 * (1 - (b + vm) / n / 2) };
  });
}

/* What a season comes to: the best round, and in how many rounds you beat the model. */
function seasonHighlights(series) {
  if (!series.length) return null;
  const best = series.reduce((top, r) => (r.pts > top.pts ? r : top), series[0]);
  return { rounds: series.length, best, beat: series.filter((r) => r.vm > 0).length };
}

/* ---- your playing style: what your settled picks say about you --------------------------------- */

/* rows: { key, home, away, hid, aid, pick: [h, d, a] whole percents, model: [h, d, a] fractions,
   hg, ag, ko (ms), t (ms of your last change, or null) }. Everything is compared with the model's
   locked odds (what it said at kick-off) and with what happened. Percentage points are whole. */
const ANALYSE_MIN = 5;
const TEAM_MIN = 3;

function analysePlay(rows) {
  const n = rows.length;
  if (n < ANALYSE_MIN) return { n, ready: false, missing: ANALYSE_MIN - n };
  const pp = (x) => Math.round(x * 100);
  const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
  const outcomeIx = (r) => (r.hg > r.ag ? 0 : r.hg < r.ag ? 2 : 1);
  const argmax = (v) => (v[0] >= v[1] && v[0] >= v[2] ? 0 : v[2] >= v[1] ? 2 : 1);
  const brier = (v, o) => v.reduce((sum, x, i) => sum + (x - (i === o ? 1 : 0)) ** 2, 0);

  const facts = rows.map((r, index) => {
    const you = r.pick.map((x) => x / 100);
    const model = r.model;
    const o = outcomeIx(r);
    const fav = model[0] >= model[2] ? 0 : 2;                  // the model's favourite side
    return { index, r, you, model, o, fav, yourBrier: brier(you, o), modelBrier: brier(model, o) };
  });

  // Traits, in percentage points against the model (positive: more than the model).
  const traits = {
    favourite: pp(mean(facts.map((f) => f.you[f.fav] - f.model[f.fav]))),
    draw: pp(mean(facts.map((f) => f.you[1] - f.model[1]))),
    home: pp(mean(facts.map((f) => f.you[0] - f.model[0]))),
    bold: pp(mean(facts.map((f) => Math.max(...f.you) - Math.max(...f.model)))),
  };

  // You against the model, match by match.
  let wins = 0; let losses = 0; let ties = 0;
  for (const f of facts) {
    if (f.yourBrier < f.modelBrier - 1e-9) wins += 1;
    else if (f.yourBrier > f.modelBrier + 1e-9) losses += 1;
    else ties += 1;
  }
  const followGain = facts.reduce((sum, f) => sum + (f.yourBrier - f.modelBrier), 0);   // > 0: the model would have scored better

  // When you and the model had different favourites.
  const differ = facts.filter((f) => argmax(f.you) !== argmax(f.model));
  const disagree = { n: differ.length, right: differ.filter((f) => argmax(f.you) === f.o).length,
    modelRight: differ.filter((f) => argmax(f.model) === f.o).length, rows: differ.map((f) => f.index) };

  // Favourites: what you gave them, what the model gave them, how often they won.
  const favWon = facts.filter((f) => f.o === f.fav).length;
  const favourites = { n, won: favWon, rate: pp(favWon / n), yours: pp(mean(facts.map((f) => f.you[f.fav]))),
    model: pp(mean(facts.map((f) => f.model[f.fav]))) };
  const draws = { n, drawn: facts.filter((f) => f.o === 1).length, yours: pp(mean(facts.map((f) => f.you[1]))),
    model: pp(mean(facts.map((f) => f.model[1]))) };
  draws.rate = pp(draws.drawn / n);

  // Clubs: your win chance for a club against the model's, over its matches.
  const clubs = new Map();
  for (const f of facts) {
    for (const [side, id, name] of [[0, f.r.hid, f.r.home], [2, f.r.aid, f.r.away]]) {
      const key = id || name;
      const club = clubs.get(key) || { id: key, name, n: 0, diff: 0, won: 0, rows: [] };
      club.n += 1;
      club.diff += f.you[side] - f.model[side];
      if (f.o === side) club.won += 1;
      club.rows.push(f.index);
      clubs.set(key, club);
    }
  }
  const teams = [...clubs.values()].filter((c) => c.n >= TEAM_MIN).map((c) => ({ ...c, diff: pp(c.diff / c.n) }))
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  // Timing: how long before kick-off your picks were last changed.
  const leads = rows.filter((r) => r.t && r.ko).map((r) => (r.ko - r.t) / 86400000);
  const days = leads.length ? Math.round(mean(leads) * 10) / 10 : null;

  const insights = [];
  const add = (id, tone, strength, params, rowsOf) => insights.push({ id, tone, strength, params, rows: rowsOf || [] });
  const by = (pick) => facts.slice().sort((a, b) => pick(b) - pick(a)).slice(0, 5).map((f) => f.index);

  if (traits.favourite >= 6 && favourites.yours > favourites.rate + 3) {
    add('fav.over', 'tip', traits.favourite, { d: traits.favourite, won: favWon, n, rate: favourites.rate, yours: favourites.yours },
      by((f) => f.you[f.fav] - f.model[f.fav]));
  } else if (traits.favourite <= -6 && favourites.rate > favourites.yours + 3) {
    add('fav.under', 'tip', -traits.favourite, { d: -traits.favourite, won: favWon, n, rate: favourites.rate, yours: favourites.yours },
      by((f) => f.model[f.fav] - f.you[f.fav]));
  } else if (Math.abs(favourites.yours - favourites.rate) <= 5) {
    add('fav.good', 'praise', 4, { rate: favourites.rate, yours: favourites.yours });
  }
  if (traits.draw <= -5) {
    add('draw.under', draws.rate > draws.yours ? 'tip' : 'info', -traits.draw, { yours: draws.yours, model: draws.model, drawn: draws.drawn, n, rate: draws.rate },
      facts.filter((f) => f.o === 1).map((f) => f.index).slice(0, 5));
  } else if (traits.draw >= 5) {
    add('draw.over', draws.rate < draws.yours ? 'tip' : 'info', traits.draw, { yours: draws.yours, model: draws.model, drawn: draws.drawn, n, rate: draws.rate },
      by((f) => f.you[1] - f.model[1]));
  }
  if (traits.home >= 6) add('home.over', 'tip', traits.home, { d: traits.home }, by((f) => f.you[0] - f.model[0]));
  else if (traits.home <= -6) add('home.under', 'tip', -traits.home, { d: -traits.home }, by((f) => f.model[0] - f.you[0]));
  for (const club of teams.slice(0, 2)) {
    if (Math.abs(club.diff) < 8) continue;
    add(club.diff > 0 ? 'team.over' : 'team.under', 'tip', Math.abs(club.diff),
      { team: club.name, d: Math.abs(club.diff), n: club.n, won: club.won }, club.rows);
  }
  const ahead = wins - losses;
  if (traits.bold >= 7) add(followGain < 0 ? 'bold.paid' : 'bold.cost', followGain < 0 ? 'praise' : 'tip', traits.bold, { d: traits.bold, wins, n });
  else if (traits.bold <= -7) add(followGain < 0 ? 'careful.paid' : 'careful.cost', followGain < 0 ? 'praise' : 'tip', -traits.bold, { d: -traits.bold, wins, n });
  if (disagree.n >= 3) {
    add('disagree', disagree.right > disagree.modelRight ? 'praise' : disagree.right < disagree.modelRight ? 'tip' : 'info',
      3 + Math.abs(disagree.right - disagree.modelRight), { n: disagree.n, right: disagree.right, model: disagree.modelRight }, disagree.rows.slice(0, 5));
  }
  if (ahead > 0 && wins >= 3) add('h2h.ahead', 'praise', 3 + ahead, { wins, losses, n });
  if (days !== null && days >= 2) add('timing.early', 'info', 2, { days });
  insights.sort((a, b) => b.strength - a.strength);

  return { n, ready: true, traits, h2h: { wins, losses, ties, followGain: Math.round(followGain * 100) / 100 },
    disagree, favourites, draws, teams, days, insights };
}

if (typeof module !== 'undefined') {
  module.exports = {
    groupThousands, fixed, percentText, shortClubNames, signedScore, spanParts, ROUND_OVER_AFTER, roundStatus, currentRoundIndex, isLocked,
    splitDraft, inSequence, LAUNCH_SEASON, boardSeasons, draftKeysToMove, moveDrafts, keysToReset, calibrationPoints, ringState,
    calibrationBins, seasonTotals, scopeKeys, keysTotals, LAST_ROUNDS, badgesFor, nearestPosition, positionForEdges, positionForTyped, FREE_MIN, FREE_MAX, freeEdges, freeTyped, freePosition, isFreePick, gapAtFraction, dropIndex, moveItem, TABLE_BONUS, draftKey, roundKeyOf,
    beatShare, boardWindow, humanRanks, rivalsOf, standingOf, statsSeasons, seasonSeries, seasonHighlights, normalFit, normalDensity, TIERS, tierOf, roundForm, analysePlay, ANALYSE_MIN,
  };
}
