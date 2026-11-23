/* Small pure helpers of the Predict page: number formatting (a decimal point in both
   languages, grouping per language), relative time, round status, the streak and
   calibration arithmetic, and the slider's typed-number search. No DOM; the node
   tests (tests/predict-ui.test.js) require this file.

   A classic script: load it after predict-core.js. */

const predictUtilCore = (typeof module !== 'undefined' && typeof require !== 'undefined')
  ? require('./predict-core.js') : { GAP, DRAW_TENTHS, pickPercentages };

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
function signed(value, digits = 2) {
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

/* future: not open yet; open: open and nothing has kicked off; live: the first match has
   kicked off, the last is not over; done: all over. `round` has opens, closes, last (Dates). */
function roundStatus(round, nowMs) {
  if (round.opens.getTime() > nowMs) return 'future';
  if (round.closes.getTime() > nowMs) return 'open';
  if (round.last && round.last.getTime() + ROUND_OVER_AFTER > nowMs) return 'live';
  return 'done';
}

/* The round a division opens on: the first not over; the last when the season is. */
function currentRoundIndex(rounds, nowMs) {
  const index = rounds.findIndex((r) => roundStatus(r, nowMs) !== 'done');
  return index === -1 ? Math.max(0, rounds.length - 1) : index;
}

const isLocked = (kickoff, nowMs) => kickoff.getTime() <= nowMs;

/* ---- progress, streaks, calibration ------------------------------------------------------ */

function ringState(done, total) {
  return { done, total, fraction: total ? done / total : 0, complete: total > 0 && done >= total };
}

/* predict/streaks.py: the run of completed rounds, a freeze banked every fifth. */
function computeStreak(flags) {
  let current = 0;
  let best = 0;
  let freezes = 0;
  for (const done of flags) {
    if (done) {
      current += 1;
      if (current % 5 === 0) freezes = 1;
      best = Math.max(best, current);
    } else if (freezes) {
      freezes = 0;
    } else {
      current = 0;
    }
  }
  return { current, best, freezes };
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

/* Badges earned, from your numbers: [{ id, earned }]. */
function badgesFor({ tips, totals, streak }) {
  return [
    { id: 'first', earned: tips >= 1 },
    { id: 'thirty', earned: tips >= 30 },
    { id: 'streak5', earned: streak >= 5 },
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

/* The slider position under a pointer on the bar (left: the away side, right: the home side). */
function gapAtFraction(fraction) {
  const { GAP } = predictUtilCore;
  const clamped = Math.min(1, Math.max(0, fraction));
  const raw = GAP.min + clamped * (GAP.max - GAP.min);
  return Math.max(GAP.min, Math.min(GAP.max, Math.round(raw / GAP.step) * GAP.step));
}

/* ---- the table game's rules text ------------------------------------------------------------------- */

/* predict/tables.py BONUSES, as the page words them. */
const TABLE_BONUS = {
  eliteserien: { champion: 6, relegation: 3 },
  obosligaen: { promotion: 4, relegation: 3 },
};

/* ---- keys ------------------------------------------------------------------------------------------- */

const draftKey = (uid, roundKey) => `predict.draft.${uid || 'new'}.${roundKey}`;
const roundKeyOf = (season, league, round) => `${season}_${league}_${round}`;

if (typeof module !== 'undefined') {
  module.exports = {
    groupThousands, fixed, percentText, signed, spanParts, ROUND_OVER_AFTER, roundStatus, currentRoundIndex, isLocked, ringState,
    computeStreak, calibrationBins, seasonTotals, badgesFor, nearestPosition, gapAtFraction, TABLE_BONUS, draftKey, roundKeyOf,
  };
}
