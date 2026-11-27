/* ---------- standings --------------------------------------------- */

/* One club's chance of a band. Promotion (OBOS-ligaen's top band) and
   relegation count the play-offs where the report has them: the places that
   go straight up or down, plus the runs in which the club goes through the
   final or out through the survival tie (pipeline._table_payload). Older
   reports fall back to the places alone. */
function bandChance(row, band, slug) {
  if (band.tone === 'relegation' && row.relegation_probability != null) return row.relegation_probability;
  if (band.tone === 'top' && slug === 'obosligaen' && row.promotion_probability != null) return row.promotion_probability;
  return row.position_probabilities.slice(band.first - 1, band.last).reduce((a, b) => a + b, 0);
}

/* Whether bandChance counted the play-offs for this band. */
function bandWithPlayoff(row, band, slug) {
  return (band.tone === 'relegation' && row.relegation_probability != null)
    || (band.tone === 'top' && slug === 'obosligaen' && row.promotion_probability != null);
}

/* How one club's season can end, as consecutive segments from the top of the
   table to the bottom that sum to 1: each place's chance goes to the tightest
   band holding it (so the title, then the rest of the Champions League
   places), places in no band are mid-table, and a play-off band is split by
   what the table's own columns say. Where the report has the play-offs'
   outcomes (`bandChance`), the part of the play-off place that ends in
   promotion or relegation becomes its own segment and the rest joins
   mid-table, so the bar's ends are the figures in the Title / Promotion and
   Relegation columns of the same row. Each segment is {key, band, p, hatch}:
   `band` is null for mid-table, `hatch` marks a result won or lost through a
   play-off. */
function seasonOutcomes(row, bands, slug) {
  const probs = row.position_probabilities;
  const count = probs.length;
  const segments = [];
  for (let place = 1; place <= count; place += 1) {
    const band = bandFor(bands, place);
    const key = band ? band.label : 'mid';
    const prev = segments[segments.length - 1];
    if (prev && prev.key === key) prev.p += probs[place - 1];
    else segments.push({ key, band, p: probs[place - 1], hatch: false });
  }
  const places = (band) => probs.slice(band.first - 1, band.last).reduce((a, b) => a + b, 0);
  const out = [];
  for (const segment of segments) {
    const { band } = segment;
    const top = band && band.first < (count + 1) / 2;
    const promotionKnown = band && band.tone === 'playoff' && top && slug === 'obosligaen' && row.promotion_probability != null;
    const relegationKnown = band && band.tone === 'playoff' && !top && row.relegation_probability != null;
    if (!promotionKnown && !relegationKnown) {
      out.push(segment);
      continue;
    }
    // The chance the play-off place's runs end in promotion (or relegation):
    // the report's total less the places that go straight there.
    const direct = bands.filter((b) => (promotionKnown ? b.tone === 'top' : b.tone === 'relegation'))
      .reduce((sum, b) => sum + places(b), 0);
    const total = promotionKnown ? row.promotion_probability : row.relegation_probability;
    const through = Math.max(0, Math.min(total - direct, segment.p));
    const stay = { key: 'mid', band: null, p: segment.p - through, hatch: false };
    const won = { key: `${segment.key}:through`, band, p: through, hatch: true };
    out.push(...(promotionKnown ? [won, stay] : [stay, won]));
  }
  // Mid-table runs that now touch are one stretch.
  return out.reduce((merged, segment) => {
    const prev = merged[merged.length - 1];
    if (prev && prev.key === 'mid' && segment.key === 'mid') prev.p += segment.p;
    else merged.push({ ...segment });
    return merged;
  }, []).filter((segment) => segment.p > 0);
}

/* Rows with the two derived probability columns folded in, so sorting can see
   the same values the table shows. */
function standingsRows(report) {
  const bands = report.league.bands;
  const relegation = bands.find((band) => band.tone === 'relegation');
  const top = bands.find((band) => band.tone === 'top');
  const promotion = report.league.slug === 'obosligaen';

  const attackVals = report.table.map((r) => r.attack);
  const defenceVals = report.table.map((r) => r.defence);
  const attackAvg = attackVals.reduce((s, v) => s + v, 0) / (attackVals.length || 1);
  const defenceAvg = defenceVals.reduce((s, v) => s + v, 0) / (defenceVals.length || 1);

  const attackPcts = report.table.map((r) => (r.attack / attackAvg - 1) * 100);
  const defencePcts = report.table.map((r) => (1 - r.defence / defenceAvg) * 100);
  const attackPctMin = Math.min(...attackPcts);
  const attackPctMax = Math.max(...attackPcts);
  const defencePctMin = Math.min(...defencePcts);
  const defencePctMax = Math.max(...defencePcts);

  return report.table.map((row) => {
    const attack_pct = (row.attack / attackAvg - 1) * 100;
    const defence_pct = (1 - row.defence / defenceAvg) * 100;
    // Normalised position in diverging ramp: -1 = league worst, 0 = avg, 1 = league best
    const attack_k = attack_pct <= 0 && attackPctMin < 0 ? attack_pct / Math.abs(attackPctMin)
      : attack_pct >= 0 && attackPctMax > 0 ? attack_pct / attackPctMax : 0;
    const defence_k = defence_pct <= 0 && defencePctMin < 0 ? defence_pct / Math.abs(defencePctMin)
      : defence_pct >= 0 && defencePctMax > 0 ? defence_pct / defencePctMax : 0;
    return {
      ...row,
      up: promotion && top ? bandChance(row, top, report.league.slug) : row.position_probabilities[0],
      down: relegation ? bandChance(row, relegation, report.league.slug) : 0,
      attack_pct,
      defence_pct,
      attack_k,
      defence_k,
    };
  });
}

/* Position and club read naturally smallest-first; every other column is a
   "more is notable" number, so it opens on the largest. */
const SORT_ASCENDING_FIRST = new Set(['position', 'team']);

/* The goals columns carry two figures, so a tie on the first falls to the second. */
const SORT_THEN = { goals_for: 'goals_against', expected_goals_for: 'expected_goals_against' };

function sortedStandings(rows, sort = state.sort) {
  const { key, dir } = sort;
  const compare = (a, b) => {
    if (key === 'team') return a.team.localeCompare(b.team, 'nb') * dir;
    const difference = (a[key] - b[key]) * dir;
    if (difference) return difference;
    // The goals column holds goals for and goals against: sorted by the first,
    // equal clubs fall to the second, the other way round (so best first is
    // most scored, then fewest conceded, and worst first is the reverse).
    const second = SORT_THEN[key];
    if (second && a[second] !== b[second]) return (a[second] - b[second]) * -dir;
    // League position is the last tiebreak, so equal values keep table order
    // and the sort stays stable and predictable.
    return a.position - b.position;
  };
  return [...rows].sort(compare);
}

function toggleSort(key) {
  if (!state.reports) return; // headers are bound at boot, before the first fetch lands
  const opening = SORT_ASCENDING_FIRST.has(key) ? 1 : -1;
  state.sort =
    state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: opening };
  renderStandings(state.reports[state.league]);
}

/* Each view opens on its natural order: the table as it stands, or the
   projection by expected points. A sort picked within a view is kept for it. */
const DEFAULT_SORT = {
  current: { key: 'position', dir: 1 },
  prediction: { key: 'expected_points', dir: -1 },
  strength: { key: 'rating', dir: -1 },
};

/* The phone has a third view, Strength (rating, attack, defence), which a
   wider screen shows within Current; a Strength kept from a phone opens as
   Current there. */
function effectiveTableView() {
  return state.tableView === 'strength' && !PHONE_SHEETS.matches ? 'current' : state.tableView;
}

function toggleTableView(view) {
  state.sortByView[state.tableView] = state.sort;
  state.tableView = view;
  state.activeView = 'table';
  state.sort = state.sortByView[view] || DEFAULT_SORT[view];
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('elitetracker-table-view', view);
  }
  if (state.reports) renderStandings(state.reports[state.league]);
  else applyTableView();
}

/* Crossing 760px changes which views the table has (Strength is a phone's):
   the table is drawn again for the width it now has, so a Strength picked on a
   phone shows as Current on a wider window and comes back when it narrows. */
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(max-width: 760px)').addEventListener('change', () => {
    if (state.reports?.[state.league]) renderStandings(state.reports[state.league]);
  });
}

/* Visibility only: renderStandings calls this after building the rows. */
function applyTableView() {
  const view = effectiveTableView();
  // Lets the phone layout drop columns per view (see the CSS).
  $('#standings').dataset.view = view;
  // Update toggle button states.
  for (const button of document.querySelectorAll('.table-control-btn')) {
    button.setAttribute('aria-pressed', button.dataset.tableMode === view ? 'true' : 'false');
    button.classList.toggle('is-active', button.dataset.tableMode === view);
  }
  // Update column visibility based on table view mode.
  // Show fixture difficulty column only in prediction mode.
  for (const header of document.querySelectorAll('#standings th[data-table-view]')) {
    const views = header.dataset.tableView.split(' ');
    header.hidden = !views.includes(view);
  }
  for (const cell of document.querySelectorAll('#standings td[data-table-view]')) {
    const views = cell.dataset.tableView.split(' ');
    cell.hidden = !views.includes(view);
  }
  // Update section visibility to ensure table is shown.
  for (const section of document.querySelectorAll('[data-section]')) {
    const views = section.dataset.section.split(' ');
    section.hidden = !views.includes(state.activeView);
  }
  renderSortHeaders();
}

function renderSortHeaders() {
  for (const header of document.querySelectorAll('#standings th[data-sort-col]')) {
    const active = header.dataset.sortCol === state.sort.key;
    header.setAttribute('aria-sort', active ? (state.sort.dir === 1 ? 'ascending' : 'descending') : 'none');
    header.classList.toggle('is-sorted', active);
    const caret = header.querySelector('.sort-btn__caret');
    if (caret) caret.textContent = active ? (state.sort.dir === 1 ? '\u25b2' : '\u25bc') : '';
  }
}

function renderStandings(report) {
   const body = $('#standings tbody');
   body.replaceChildren();

   const bands = report.league.bands;
  const count = report.table.length;

   const formByTeamName = formByTeam(report.results);
  const rows = standingsRows(report).map((row) => ({
    ...row,
    form: formPoints(formByTeamName[row.team]),
    expected_goal_difference: row.expected_goals_for - row.expected_goals_against,
  }));

// Fixture difficulty is read against the league's own mean run-in: with
   // draws, even an average side's run-in is worth well under 1.5 points a
   // match. Clubs with no fixtures left (0) are left out.
   const runIns = rows.map((row) => row.fixture_difficulty).filter((value) => value > 0);
   const neutralRunIn = runIns.reduce((sum, value) => sum + value, 0) / (runIns.length || 1);
   // Max absolute gap from mean across the league (for normalising fixture difficulty ramp)
   const maxFixtureGap = runIns.length
     ? Math.max(...runIns.map((v) => Math.abs(v - neutralRunIn)))
     : 0;

  // Find the team with the highest rating rise for the champion-yellow arrow
  const trends = new Map();
  for (const row of rows) {
    const t = computeRatingTrend(row.team, report);
    if (t) trends.set(row.team, t);
  }
  let topRiser = null;
  for (const [team, t] of trends) {
    if (!topRiser || t.diff > topRiser.diff) topRiser = { team, diff: t.diff };
  }

  const positionPoints = report.model.position_points || [];

  // Threshold dividers only for position and xPTS sorts.
  // They attach to visual position (1st, 6th, etc.) in the sorted output,
  // not to the team's live table position.
  const showDividers = state.sort.key === 'position' || state.sort.key === 'expected_points';

  // Pre-calculate divider boundaries: after each band's threshold position.
  // User wants thresholds one team further down:
  // Good bands: divider after (thresholdPos + 1)
  // Bad bands: divider after thresholdPos (since threshold was at band.first - 1, now band.first)
  const dividerBoundaries = new Map(); // visual position (1-based) -> {zone, cut, label}
  if (showDividers) {
    for (const band of bands) {
      const thresholdPos = thresholdPosition(band, count);
      const cut = positionPoints[thresholdPos - 1];
      if (cut !== undefined) {
        const good = band.first < (count + 1) / 2;
        const afterPos = good ? thresholdPos + 1 : thresholdPos;
        if (afterPos >= 1 && afterPos < count) {
          dividerBoundaries.set(afterPos, { band, cut, label: shortBandLabel(band, report) });
        }
      }
    }
  }

// Build a divider row for a boundary
function dividerRow(boundary) {
      const tr = el('tr', 'zone-divider');
      tr.style.setProperty('--band-color', bandColor(boundary.band, count));
      const td = el('td');
      td.colSpan = $('#standings thead tr').children.length;  // the full table width
     // Format: "======== Expected CL Threshold: 67p ========"
     const label = el('span', 'zone-divider__wrap');
     label.appendChild(el('span', 'zone-divider__label',
       t('table.threshold', { band: boundary.label, points: boundary.cut })));
     td.appendChild(label);
     tr.appendChild(td);
     return tr;
   }

  const sorted = sortedStandings(rows);
  for (let visualIndex = 0; visualIndex < sorted.length; visualIndex++) {
    const row = sorted[visualIndex];
    const zone = zoneFor(bands, row.position);
    const tr = el('tr');
    const band = bandFor(bands, row.position);

    const position = el('td', 'pos');
    position.dataset.tableView = 'current prediction strength';
    const mark = el('span', 'band-mark');
    if (band) {
      mark.style.background = bandColor(band, count);
      mark.title = bandName(band);
    }
    position.appendChild(mark);
    position.appendChild(document.createTextNode(String(row.position)));
    tr.appendChild(position);

    // The club name is the control. Marking the whole <tr> role="button" made
    // every cell presentational, which hid the scores from screen readers and
    // stopped the new aria-sort from ever being announced.
    const club = el('td', 'club');
    club.dataset.tableView = 'current prediction strength';
    const clubButton = el('button', 'club-btn');
    clubButton.type = 'button';
    clubButton.classList.add('club-btn--crest');
    const crest = teamLogo(row.team_id, row.team, true);
    if (crest) clubButton.appendChild(crest);
    clubButton.appendChild(el('span', 'club-btn__name', row.team));
    clubButton.addEventListener('click', (event) => {
      event.stopPropagation();
      openTeamView(row.team_id, row.team);
    });
    club.appendChild(clubButton);
    tr.appendChild(club);
    // 'extra' marks the columns a phone drops -- see .col--extra in the CSS.
    for (const [key, extra] of [
      ['played', ''], ['wins', ' col--wdl'], ['draws', ' col--wdl'],
      ['losses', ' col--wdl'], ['goals', ' col--goals'],
    ]) {
      const td = el('td', `num muted${extra}`, key === 'goals' ? `${row.goals_for}-${row.goals_against}` : String(row[key]));
      td.dataset.tableView = 'current';
      tr.appendChild(td);
    }
    const gdTd = el('td', `num${gdTone(row.goal_difference)}`, row.goal_difference > 0 ? `+${row.goal_difference}` : String(row.goal_difference));
    gdTd.dataset.tableView = 'current';
    tr.appendChild(gdTd);
    const points = el('td', 'num pts', String(row.points));
    points.style.fontWeight = '700';
    points.dataset.tableView = 'current';
    tr.appendChild(points);

    // Form sits beside the points it explains; the rating opens the model
    // columns, marked by its separator.
    const formTd = el('td', 'num form col--extra');
    formTd.dataset.tableView = 'current';
    formTd.appendChild(formChipsEl(formByTeamName[row.team]));
    tr.appendChild(formTd);
    const ratingCell = el('td', 'num sep col--rating');
    ratingCell.dataset.tableView = 'current prediction strength';
    ratingCell.appendChild(document.createTextNode(num(row.rating)));
    const trend = trends.get(row.team);
    if (trend) {
      const isTop = topRiser && topRiser.team === row.team && topRiser.diff > 0;
      const arrow = el('span', `rating-trend rating-trend--${trend.direction}${isTop ? ' rating-trend--top' : ''}`);
      arrow.innerHTML = trend.svg;
      arrow.setAttribute('role', 'img');
      arrow.setAttribute('aria-label', trend.detail);
      arrow.title = trend.detail;
      ratingCell.appendChild(arrow);
    } else if (!state.careers) {
      // The arrow reads careers.json, which lands after the first draw: its
      // room is kept, so the column does not widen under the reader then.
      const hold = el('span', 'rating-trend');
      hold.innerHTML = trendArrowSVG('steady');
      hold.style.visibility = 'hidden';
      hold.setAttribute('aria-hidden', 'true');
      ratingCell.appendChild(hold);
    }
    tr.appendChild(ratingCell);
    // Attack and Defence — model-derived stats like Elo, Current view only
    // Percent vs division average; defence inverted so higher = better on both
    const attackPct = row.attack_pct;
    const defencePct = row.defence_pct;

    const attackCell = el('td', 'num col--extra');
    attackCell.dataset.tableView = 'current strength';
    attackCell.appendChild(makePctPill(attackPct, row.attack_k));
    tr.appendChild(attackCell);

    const defenceCell = el('td', 'num col--extra col--defence');
    defenceCell.dataset.tableView = 'current strength';
    defenceCell.appendChild(makePctPill(defencePct, row.defence_k));
    tr.appendChild(defenceCell);
    const xpTd = el('td', 'num muted', num(row.expected_points));
    if (row.mean_points != null) xpTd.title = t('table.xpMean', { mean: num(row.mean_points, 1) });
    xpTd.dataset.tableView = 'prediction';
    tr.appendChild(xpTd);

    // Season totals, averaged over the simulations: goals so far plus the
    // simulated rest. Whole goals: a tenth of a goal over a season is noise.
    // Reports built before these totals existed show a dash, not a crash.
    const known = row.expected_goals_for != null;
    for (const [text, muted, cls] of [
      [known ? `${num(row.expected_goals_for)}-${num(row.expected_goals_against)}` : '—', true, 'col--xg'],
      [known ? signed(row.expected_goal_difference) : '—', false, `col--xgd ${known ? gdTone(row.expected_goal_difference).trim() : ''}`.trim()],
    ]) {
      const td = el('td', `num${muted ? ' muted' : ''} ${cls}`, text);
      td.dataset.tableView = 'prediction';
      tr.appendChild(td);
    }

    // Fixture difficulty: expected points per remaining match for an average
    // side. Red below the league mean (a harder run-in), gray at mean, green above.
    const fixtureCell = el('td', 'num col--fd', '');
    fixtureCell.dataset.tableView = 'prediction';
    if (row.fixture_difficulty > 0) {
      const value = row.fixture_difficulty;
      const gap = value - neutralRunIn;
      const pill = el('span', 'fixture-difficulty-pill', num(value, 2));
      // Normalised k: -1 = hardest in league, 0 = mean, 1 = easiest in league
      const k = maxFixtureGap > 0 ? gap / maxFixtureGap : 0;
      makeFixturePill(pill, k);
      fixtureCell.appendChild(pill);
    } else {
      // A finished season (or a club done early) has no run-in to rate.
      fixtureCell.textContent = '—';
      fixtureCell.classList.add('muted');
      fixtureCell.title = t('table.noFixturesLeft');
    }
    tr.appendChild(fixtureCell);


    tr.appendChild(seasonBarCell(row, report));

    // Clicking anywhere on the row is a mouse convenience on top of that
    // button; it adds no keyboard or ARIA semantics of its own.
    tr.addEventListener('click', () => openTeamView(row.team_id, row.team));

    // A boundary keyed N sits above the row shown N-th (the key is already
    // shifted one place down, see dividerBoundaries), so the divider goes in
    // before that row.
    if (dividerBoundaries.has(visualIndex + 1)) {
      body.appendChild(dividerRow(dividerBoundaries.get(visualIndex + 1)));
    }

body.appendChild(tr);
   }

   // Apply the current view mode to the rendered cells.
   applyTableView();
   fitSeasonBars($('#standings'));
}

/* Pill for attack/defence % — diverging red–gray–blue ramp.
   k in [-1, 1]: -1 = league worst (red), 0 = avg (gray), 1 = league best (blue).
   Hue fixed per side (0° red, 223° blue: the electric accent's), S interpolated with sqrt curve for more mid-range chroma,
   L/alpha linear. Flat background, alpha 0.1..0.45. Text hue-derived per fixture-pill pattern. */
function makePctPill(pct, k) {
  const pill = el('span', 'attack-defence-pill', `${signed(pct)}${percentSign()}`);
  // Clamp k
  const kk = Math.max(-1, Math.min(1, k));
  // Red side (k < 0): hue 0, S 0→85% (sqrt), L 55→45%
  // Blue side (k > 0): hue 223, S 0→92% (sqrt), L 55→42%
  // Gray at k=0: S=0%, L=55%
  if (kk < 0) {
    const t = -kk; // 0..1
    const s = Math.round(85 * Math.sqrt(t));   // 0% → 85% (sqrt curve for mid-range chroma)
    const l = Math.round(55 - 10 * t);         // 55% → 45%
    pill.style.setProperty('--ad-hue', '0');
    pill.style.setProperty('--ad-sat', `${s}%`);
    pill.style.setProperty('--ad-light', `${l}%`);
  } else {
    const t = kk; // 0..1
    const s = Math.round(92 * Math.sqrt(t));   // 0% → 92% (sqrt curve for mid-range chroma)
    const l = Math.round(55 - 13 * t);         // 55% → 42%
    pill.style.setProperty('--ad-hue', '223');
    pill.style.setProperty('--ad-sat', `${s}%`);
    pill.style.setProperty('--ad-light', `${l}%`);
  }
  // Alpha: 0.1 at k=0, 0.45 at |k|=1
  const alpha = 0.1 + 0.35 * Math.abs(kk);
  pill.style.setProperty('--ad-alpha', alpha.toFixed(3));
  return pill;
}

/* Pill for fixture difficulty — diverging red–gray–green ramp.
   k in [-1, 1]: -1 = hardest (red), 0 = mean (gray), 1 = easiest (green).
   Hue fixed per side (0° red, 135° green), S/L monotone for CVD safety.
   Red end: darker (L=35%), Green end: lighter (L=49%), Gray middle: L=45%.
   This ensures luminance separates the ends for protan/deutan viewers. */
function makeFixturePill(pill, k) {
  const kk = Math.max(-1, Math.min(1, k));
  if (kk < 0) {
    const t = -kk; // 0..1
    // Red side: S 0→70%, L 45→35% (darker at extreme)
    const s = Math.round(70 * t);
    const l = Math.round(45 - 10 * t);
    pill.style.setProperty('--fd-hue', '0');
    pill.style.setProperty('--fd-sat', `${s}%`);
    pill.style.setProperty('--fd-light', `${l}%`);
  } else {
    const t = kk; // 0..1
    // Green side: S 0→70%, L 45→49% (lighter at extreme, CVD-safe with monotone L)
    const s = Math.round(70 * t);
    const l = Math.round(45 + 4 * t);
    pill.style.setProperty('--fd-hue', '135');
    pill.style.setProperty('--fd-sat', `${s}%`);
    pill.style.setProperty('--fd-light', `${l}%`);
  }
  // Alpha: 0.1 at k=0, 0.45 at |k|=1
  const alpha = 0.1 + 0.35 * Math.abs(kk);
  pill.style.setProperty('--fd-alpha', alpha.toFixed(3));
}

/* The bar for one club, from its outcomes: a segment a part wide, coloured by
   its band (mid-table neutral), hatched where the result runs through a
   play-off. Read aloud, and on hover or tap, as the list of its parts. */
function seasonBarName(segment, report) {
  if (segment.key === 'mid') return t('seasonbar.mid');
  if (!segment.hatch) return bandName(segment.band);
  return t(segment.band.first < (report.table.length + 1) / 2 ? 'seasonbar.promotedPlayoff' : 'seasonbar.relegatedPlayoff');
}

const SEASON_BAR_MIN = 0.01;

function seasonBarEl(row, report) {
  // A way a season ends with under 1 % is left out: a sliver of colour no
  // reader can see, and the others stay in proportion to one another.
  const segments = seasonOutcomes(row, report.league.bands, report.league.slug).filter((segment) => segment.p >= SEASON_BAR_MIN);
  const count = report.table.length;
  const promotion = report.league.slug === 'obosligaen';
  const bar = el('span', 'season-bar');
  const parts = [];
  const hosts = [];
  for (const segment of segments) {
    const tone = segment.band ? segment.band.tone : 'mid';
    const part = el('span', `season-bar__part${segment.hatch ? ' is-hatched' : ''}`);
    part.style.flexGrow = String(segment.p);
    part.style.background = segment.band ? bandColor(segment.band, count) : 'var(--rule-strong)';
    part.dataset.tone = tone;
    // The stretch each end's figure describes: the title (in OBOS-ligaen
    // promotion, with its play-off) at the left, relegation (with its play-off) at the right.
    const high = segment.band && segment.band.first < (count + 1) / 2;
    if (tone === 'champion' || (promotion && (tone === 'top' || (segment.hatch && high)))) part.dataset.group = 'start';
    else if (tone === 'relegation' || (segment.hatch && segment.band && !high)) part.dataset.group = 'end';
    // A Conference League segment names its own chance.
    if (tone === 'europe') {
      const label = el('span', 'season-bar__label', pct(segment.p, 0));
      label.dataset.tone = tone;
      part.appendChild(label);
    }
    bar.appendChild(part);
    hosts.push(part);
    parts.push(`${seasonBarName(segment, report)} ${shareText(segment.p)}`);
  }
  // The chance of the top outcome at the bar's far left and of relegation at its
  // far right; either is left off under 1 %. Each is placed by fitSeasonBars.
  for (const [side, value, host] of [['start', row.up, hosts.find((part) => part.dataset.group === 'start')], ['end', row.down, hosts.find((part) => part.dataset.group === 'end')]]) {
    if (!host || !(value >= SEASON_BAR_MIN)) continue;
    const label = el('span', 'season-bar__label', pct(value, 0));
    label.dataset.side = side;
    label.dataset.tone = host.dataset.tone;
    bar.appendChild(label);
  }
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', parts.join(', '));
  attachTip(bar, parts.join('<br>'));
  return bar;
}

/* Fit each bar's figures to the stretch they describe, after the bars are on
   the page and whenever the width changes. A figure that fits is printed inside
   its stretch, at the bar's end; one that does not (a 4 % relegation chance for a
   4 % sliver) is a plain tag just inside the neighbouring part of the bar. Either
   way it is laid over the bar, so no part ever looks wider than its share and no
   gap between bands is covered. */
function fitSeasonBars(root = document) {
  for (const bar of root.querySelectorAll('.season-bar')) {
    if (!bar.offsetParent) continue;
    for (const label of bar.querySelectorAll('.season-bar__label')) {
      label.classList.remove('is-off', 'is-tag');
      label.style.left = '';
      label.style.right = '';
      const { side } = label.dataset;
      if (!side) {
        // A part's own figure: shown if it fits the part, otherwise not at all.
        if (label.parentElement.clientWidth < label.offsetWidth) label.classList.add('is-off');
        continue;
      }
      const group = [...bar.querySelectorAll(`.season-bar__part[data-group="${side}"]`)];
      const first = group[0];
      const last = group[group.length - 1];
      const left = first.offsetLeft;
      const right = last.offsetLeft + last.offsetWidth;
      if (right - left >= label.offsetWidth) continue;
      label.classList.add('is-tag');
      if (side === 'start') label.style.left = `${right + 4}px`;
      else label.style.right = `${bar.clientWidth - left + 4}px`;
    }
  }
}

let seasonBarTimer = 0;
if (typeof window !== 'undefined') window.addEventListener('resize', () => {
  clearTimeout(seasonBarTimer);
  seasonBarTimer = setTimeout(() => fitSeasonBars(), 80);
});

/* The bar's column: the table's last, at every width (CSS sets how wide). */
function seasonBarCell(row, report) {
  const cell = el('td', 'season-end');
  cell.dataset.tableView = 'prediction';
  cell.appendChild(seasonBarEl(row, report));
  return cell;
}

if (typeof module !== 'undefined') {
  module.exports = { bandChance, bandWithPlayoff, seasonOutcomes, sortedStandings };
}
