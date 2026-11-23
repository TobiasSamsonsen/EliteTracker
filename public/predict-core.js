/* The pure logic of Predict (the prediction game), with no DOM and no network:
   the frozen price curve, the whole-percent rounding, scoring, the table game's
   error and the nickname rules. Each function has a Python twin in
   src/elitetracker/predict/ and tests/predict.test.js pins them to the shared
   vectors in tests/fixtures/predict_vectors.json (made by tools/predict_vectors.py).

   A classic script: load it after elo-curve.js; the node tests require it. */

const predictCurve = (typeof module !== 'undefined' && typeof require !== 'undefined')
  ? require('./elo-curve.js') : { eloOdds, expectedScore };

/* ---- the frozen curve (predict/curve.py): never changes under a refit ------ */

const FROZEN_CURVE = { version: 1, draw_base: 0.26, draw_scale: 375 };
const GAP = { min: -400, max: 400, step: 5 };
const DRAW_TENTHS = { min: 5, max: 18, normal: 10 };   // 0.5x to 1.8x the model's draw mass
const PCT = { min: 2, max: 96 };

function gameOdds(gap, tenths = DRAW_TENTHS.normal) {
  return predictCurve.eloOdds(gap, FROZEN_CURVE, tenths / 10);
}

/* Whole percents that sum to 100, each within the clip: clip, spread the
   surplus over the outcomes that can still move, round by largest remainder
   (ties to the lower index). */
function percentages(home, draw, away) {
  const total = home + draw + away;
  const values = [home, draw, away].map((x) => Math.min(PCT.max, Math.max(PCT.min, 100 * x / total)));
  for (let pass = 0; pass < 4; pass++) {
    const excess = 100 - values.reduce((a, b) => a + b, 0);
    if (Math.abs(excess) < 1e-9) break;
    const free = [0, 1, 2].filter((i) => (excess > 0 && values[i] < PCT.max) || (excess < 0 && values[i] > PCT.min));
    if (!free.length) break;
    const weight = free.reduce((a, i) => a + values[i], 0);
    for (const i of free) values[i] = Math.min(PCT.max, Math.max(PCT.min, values[i] + excess * values[i] / weight));
  }
  const floors = values.map(Math.floor);
  const remainder = 100 - floors.reduce((a, b) => a + b, 0);
  const order = [0, 1, 2].sort((a, b) => (values[b] - floors[b]) - (values[a] - floors[a]) || a - b);
  for (const i of order.slice(0, remainder)) floors[i] += 1;
  return floors;
}

/* What a card stores for a slider position: [home, draw, away] whole percents. */
function pickPercentages(gap, tenths = DRAW_TENTHS.normal) {
  return percentages(...gameOdds(gap, tenths));
}

/* The slider position whose home percent is nearest a typed number; ties go to
   the position nearer the middle. A typed number re-derives the slider. */
function gapForHome(homePercent, tenths = DRAW_TENTHS.normal) {
  let best = 0;
  let bestMiss = Infinity;
  for (let gap = GAP.min; gap <= GAP.max; gap += GAP.step) {
    const miss = Math.abs(pickPercentages(gap, tenths)[0] - homePercent);
    if (miss < bestMiss || (miss === bestMiss && Math.abs(gap) < Math.abs(best))) {
      best = gap;
      bestMiss = miss;
    }
  }
  return best;
}

/* The gap whose expected score is home + draw / 2: a model price on the slider's axis. */
function equivalentGap(home, draw) {
  const expected = Math.min(1 - 1e-9, Math.max(1e-9, home + draw / 2));
  return 400 * Math.log10(expected / (1 - expected));
}

/* A typed number: a decimal comma is read as a point (AGENTS.md); NaN when it is not a number. */
function parseNumber(text) {
  const cleaned = String(text).trim().replace(',', '.').replace(/\s/g, '').replace('%', '');
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : NaN;
}

/* ---- scoring (predict/scoring.py, model/scores.py) ----------------------- */

function brierScore(home, draw, away, result) {
  const hit = { home_win: [1, 0, 0], draw: [0, 1, 0], away_win: [0, 0, 1] }[result];
  return (home - hit[0]) ** 2 + (draw - hit[1]) ** 2 + (away - hit[2]) ** 2;
}

function rpsScore(home, draw, away, result) {
  const homeHit = result === 'home_win' ? 1 : 0;
  const homeOrDrawHit = result === 'away_win' ? 0 : 1;
  return ((home - homeHit) ** 2 + (home + draw - homeOrDrawHit) ** 2) / 2;
}

function outcomeOf(homeGoals, awayGoals) {
  return homeGoals > awayGoals ? 'home_win' : homeGoals < awayGoals ? 'away_win' : 'draw';
}

/* Your score on one settled match against the model's locked odds (fractions).
   The accuracy against the field's median comes from the job (crowd.json `med`),
   because the browser cannot see anyone else's pick. */
function scoreOwnPick(pick, model, result) {
  const [h, d, a] = pick;
  const brier = brierScore(h / 100, d / 100, a / 100, result);
  const rps = rpsScore(h / 100, d / 100, a / 100, result);
  const modelBrier = brierScore(model[0], model[1], model[2], result);
  return { brier, rps, vsModel: modelBrier - brier };
}

/* ---- the table game (predict/tables.py) -------------------------------------- */

function footrule(order, truth) {
  const place = new Map(truth.map((club, i) => [club, i]));
  return order.reduce((sum, club, i) => sum + Math.abs(i - place.get(club)), 0);
}

function tableBonus(order, truth, plan) {
  let total = 0;
  for (const band of plan) {
    const first = band.first - 1;
    const last = band.last - 1;
    if (first === last) {
      if (order[first] === truth[first]) total += band.points;
    } else {
      const named = new Set(order.slice(first, last + 1));
      total += band.points * truth.slice(first, last + 1).filter((club) => named.has(club)).length;
    }
  }
  return total;
}

function tableError(order, truth, plan) {
  return footrule(order, truth) - tableBonus(order, truth, plan);
}

/* ---- nicknames (predict/nicknames.py; firestore.rules enforces the same) ------ */

const NICK_RESERVED = ['modellen', 'folket', 'model', 'crowd', 'predict', 'admin', 'elitetracker', 'moderator'];
const NICK_FORMAT = /^[A-Za-zÆØÅæøå0-9_-][A-Za-zÆØÅæøå0-9_ -]{1,18}[A-Za-zÆØÅæøå0-9_-]$/;
const NICK_BLOCKED = ['fuck', 'shit', 'cunt', 'nigg', 'fitte', 'hore', 'faen', 'dritt', 'pikk', 'rasist', 'nazi', 'hitler'];

function nickLower(nick) {
  return nick.toLowerCase();
}

/* The ASCII document id of a nickname claim: æ, ø, å become ~e, ~o, ~a. */
function nickKey(nick) {
  return nickLower(nick).replace(/æ/g, '~e').replace(/ø/g, '~o').replace(/å/g, '~a');
}

function nickProblems(nick) {
  const found = [];
  if (!NICK_FORMAT.test(nick)) found.push('format');
  if (NICK_RESERVED.includes(nickLower(nick))) found.push('reserved');
  return found;
}

function nickBlocked(nick) {
  const squashed = nickLower(nick).replace(/[\s_-]+/g, '').replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e');
  return NICK_BLOCKED.some((word) => squashed.includes(word));
}

/* A first nickname for a new player, so nobody has to choose to start. `random` is Math.random-like. */
function generateNick(random = Math.random) {
  const adjectives = ['Rask', 'Tapper', 'Slu', 'Sterk', 'Stille', 'Modig', 'Lur', 'Hurtig', 'Kjapp', 'Frisk'];
  const animals = ['Ulv', 'Elg', 'Rev', 'Orn', 'Bjorn', 'Hare', 'Falk', 'Oter', 'Ugle', 'Gaupe'];
  const pick = (list) => list[Math.floor(random() * list.length)];
  return `${pick(adjectives)}${pick(animals)}_${10 + Math.floor(random() * 90)}`;
}

/* The public id of a player on a board: the first ten hex digits of sha-256(uid) (predict/boards.py). */
async function uidHash(uid) {
  const subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : require('crypto').webcrypto.subtle;
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(uid));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 10);
}

if (typeof module !== 'undefined') {
  module.exports = {
    FROZEN_CURVE, GAP, DRAW_TENTHS, PCT, gameOdds, percentages, pickPercentages, gapForHome, equivalentGap,
    parseNumber, brierScore, rpsScore, outcomeOf, scoreOwnPick, footrule, tableBonus, tableError,
    nickLower, nickKey, nickProblems, nickBlocked, generateNick, uidHash,
  };
}
