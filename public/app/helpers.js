/* Pure formatting, escaping, band-label, slug and history-key helpers (loaded before /app.js). */

/* The em-dash threshold follows the precision: anything that would print as a
   bare 0% is shown as nothing instead, and the same at the top end. */
const smallestShown = (digits) => 0.5 / 10 ** digits / 100;

/* A decimal point in both languages (AGENTS.md); the rest follows the
   reader's convention. Norwegian puts a space between thousands (not at four
   digits, so ratings stay "1794") and before the percent sign: "70.3 %",
   "50 000". */
function localeNumber() { return (typeof getLang === 'function' ? getLang() : currentLang) === 'no' ? 'nb-NO' : 'en-GB'; }

const numberFormats = new Map();
const num = (value, digits = 0) => {
  const key = `${localeNumber()}|${digits}`;
  if (!numberFormats.has(key)) {
    numberFormats.set(key, new Intl.NumberFormat(localeNumber(), {
      minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: 'min2',
    }));
  }
  return numberFormats.get(key).formatToParts(value)
    .map((part) => (part.type === 'decimal' ? '.' : part.value)).join('');
};

/* Signed on the shown value, so ±0.04 at one digit reads "0.0", not "+0.0". */
const signed = (value, digits = 0) => {
  const shown = Math.round(value * 10 ** digits) / 10 ** digits || 0;
  return (shown > 0 ? '+' : '') + num(shown, digits);
};

/* A goal difference's tone: blue above zero, red below, as the rest of the
   site reads a gain and a loss. */
const gdTone = (value) => {
  const shown = Math.round(value);
  return shown > 0 ? ' gd--up' : shown < 0 ? ' gd--down' : '';
};

const percentSign = () => ((typeof getLang === 'function' ? getLang() : currentLang) === 'no' ? String.fromCharCode(160) + '%' : '%'); // no-break space

const pct = (value, digits = 1) => {
  const smallest = smallestShown(digits);
  if (value >= 1 - smallest) return `100${percentSign()}`;
  if (value < smallest) return '—';
  return `${num(value * 100, digits)}${percentSign()}`;
};

const pctShort = (value) =>
  value < 0.005 ? '' : `${Math.round(value * 100)}`;

/* Club names go into the readout as markup; escape them so a name with an
   ampersand or an angle bracket can never break it. */
function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- bands ------------------------------------------------- */

/* The most specific band wins, so "Champions" beats the broader
   "Champions League qualification" block it sits inside. */
function bandFor(bands, position) {
  const matches = bands.filter((band) => position >= band.first && position <= band.last);
  if (!matches.length) return null;
  return matches.reduce((best, band) =>
    band.last - band.first < best.last - best.first ? band : best
  );
}

/* The widest band covering `position`, or null for the mid-table stretch.
   Complement to bandFor: where bandFor names the tightest block (the title sits
   inside the CL slot), zoneFor names the whole region, so the table can draw
   one divider where a zone starts instead of one per nested band. */
function zoneFor(bands, position) {
  const matches = bands.filter((band) => position >= band.first && position <= band.last);
  if (!matches.length) return null;
  return matches.reduce((best, band) =>
    band.last - band.first > best.last - best.first ? band : best
  );
}

/* The position whose median points set a band's threshold: the cut a club must
   reach. A band worth reaching (title, qualification, promotion play-off) is
   entered at its last place; a band worth avoiding (relegation) at its first.
   Mirrors outcomeClass: good bands are reached from below, bad ones left
   above. */
function thresholdPosition(band, count) {
  const good = band.first < (count + 1) / 2;
  return good ? band.last : band.first;
}

/* A band's full name in the reader's language; the report carries English. */
function bandName(band) {
  const key = `band.${band.label}`;
  return t(key) === key ? band.label : t(key);
}

/* Short edge label for season-shape chart lines and stake badges.
   European bands map to CL/EL/ECL keys; champion maps to Title; others fall back. */
function bandEdgeName(band) {
  const label = band.label;
  let key;
  if (label === 'Champions') key = 'table.zone.good.champion'; // "Title"
  else if (label === 'Champions League qualification') key = 'band.edge.CL';
  else if (label === 'Europa League qualification') key = 'band.edge.EL';
  else if (label === 'Conference League qualification') key = 'band.edge.ECL';
  else return bandName(band);
  return t(key) === key ? bandName(band) : t(key);
}

/* Short category label for the table's zone badges. tone alone cannot tell a
   good play-off from a bad one (OBOS promotion vs Elite relegation), so the
   top/bottom half decides like outcomeClass does, and whether the top band is
   the title race or promotion. */
function shortBandLabel(band, report) {
  const count = report.table.length;
  const good = band.first < (count + 1) / 2;
  let key = `table.zone.${good ? 'good' : 'bad'}.${band.tone}`;
  if (band.tone === 'top' && report.league.slug === 'obosligaen') key = 'table.zone.good.promotion';
  if (band.label === 'Europa League qualification') key = 'table.zone.good.EL';
  if (band.label === 'Conference League qualification') key = 'table.zone.good.ECL';
  return t(key) === key ? bandName(band) : t(key);
}

function clubSlug(name) {
  return name.toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/* Back. Every page the reader opens (a view, an Explore tool, a club) is a history entry of its own, pushed
   by render's address write when the page's key changes, so the phone's Back and swipe-back, the installed
   app's too, walk the same path as the arrows in the pages. Changes inside a page (the division, season,
   rewind, sort, locks, compared pair) only replace the entry. The key reads the address render has just
   written: view, tool and club. */
let lastPageKey = null;
function pageKeyOf(params) {
  return [params.get('view') || '', params.get('viz') || '', params.get('team') || ''].join('|');
}
// How many entries of the app lie behind this one (0 on a page opened by a link); kept in the entry's state.
function historyDepth() {
  return (window.history.state && window.history.state.n) || 0;
}
/* The pages' own back arrows: the browser's Back where the app has somewhere behind, else `fallback`. */
function goBackOr(fallback) {
  if (historyDepth() > 0) window.history.back();
  else fallback();
}

/* A round tick step (1, 2 or 5 times a power of ten) at least `raw`. */
function refNiceStep(raw) {
  const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  return [1, 2, 5, 10].map((m) => m * power).find((v) => v >= raw - 1e-9);
}

function venueIcon(isHome, { badge = true, className = '' } = {}) {
  const label = t(isHome ? 'team.home' : 'team.away');
  const cls = [
    'venue-icon',
    badge ? 'venue-icon--badge' : 'venue-icon--inline',
    isHome ? 'venue-icon--home' : 'venue-icon--away',
    className,
  ].filter(Boolean).join(' ');
  const wrap = el('span', cls);
  wrap.title = label;
  wrap.setAttribute('aria-label', label);
  const svg = svgEl('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  const d = isHome
    ? 'M8 2.2 2 7.2v1.1h1.3V13.5h3.3V10h2.8v3.5h3.3V8.3H14V7.2L8 2.2Z'
    : 'M14.2 1.8a1.1 1.1 0 0 0-1.55 0L9.1 5.35 3.2 3.3 2 4.5l4.8 3.1-2.5 2.5-1.9-.3-.9.9 2.4 1.4 1.4 2.4.9-.9-.3-1.9 2.5-2.5 3.1 4.8 1.2-1.2-2.05-5.9 3.55-3.55a1.1 1.1 0 0 0 0-1.55Z';
  svg.appendChild(svgEl('path', { d, fill: 'currentColor' }));
  wrap.appendChild(svg);
  return wrap;
}

/* A chance as a figure: whole percent, a decimal under 0.5 %, and a plain
   0 % rather than the grid's dash, which reads as missing in a sentence. */
function shareText(p) {
  if (p >= 0.005) return pct(p, 0);
  if (p >= 0.0005) return pct(p, 1);
  return p > 0 ? `<${pct(0.001, 1)}` : `0${percentSign()}`;
}

/* Eight high-contrast, colour-vision-separated hues from CSS tokens (light & dark);
   eliminated clubs beyond the featured set use a quiet muted grey. */
const raceColour = (index) => (index < 8 ? `var(--race-${index + 1})` : 'var(--ink-faint)');

if (typeof module !== 'undefined') {
  module.exports = {
    smallestShown, localeNumber, num, signed, gdTone, percentSign, pct, pctShort,
    esc, bandFor, zoneFor, thresholdPosition, bandName, bandEdgeName, shortBandLabel,
    clubSlug, pageKeyOf, historyDepth, goBackOr,
    refNiceStep, venueIcon, shareText, raceColour,
  };
}
