/* The what-if page's season simulation, in the browser. Loaded as a Web Worker
   (`new Worker('season-sim.js')`) so 50,000 runs never block the page; `node`
   requires the same file for the tests (`tests/frontend.test.js`).

   It is the Python simulation (`simulation/season.py`) in plain JS, without the
   parts the report does not carry: the run-in's table stakes and the play-offs.
   The page therefore never shows its numbers raw. It runs the season twice on
   the same random draws, as played and with the locked scores, and moves the
   published chances by the difference (`shiftedChances`): what the two runs
   share, the missing terms included, cancels out.

   Every fixture draws the same number of uniforms in every run, locked or not,
   and a locked fixture only overwrites its result afterwards. The two runs thus
   differ in the locked fixtures and what follows from them, and in nothing
   else: a club the lock does not touch moves by exactly 0. */

function mulberry32(seed) {
  let state = seed | 0;
  return function next() {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* One fixture's scoreline draw, from its score grid (grid[home goals][away
   goals], summing to 1): per outcome (0 home win, 1 draw, 2 away win) the cells
   that make it, flat as home, away, home, away..., and their cumulative
   chances, which end on 1. Who wins comes from the odds; this is how many
   goals, given who wins (`topScorelines` does the same sum for display). */
function outcomeTables(grid) {
  const cells = [[], [], []];
  const weight = [[], [], []];
  grid.forEach((row, home) => row.forEach((p, away) => {
    const outcome = home > away ? 0 : home === away ? 1 : 2;
    cells[outcome].push(home, away);
    weight[outcome].push(p);
  }));
  const cum = weight.map((ps) => {
    const total = ps.reduce((a, b) => a + b, 0) || 1;
    let run = 0;
    return ps.map((p) => { run += p / total; return run; });
  });
  for (const row of cum) row[row.length - 1] = 1;
  return { cells, cum };
}

/* The base table with results swapped: each replacement takes a played
   match's real score off its two clubs and puts the locked one on. `table` and
   the result hold points, goals for and against per club, by index. */
function replaceResults(table, replacements) {
  const points = Array.from(table.points);
  const gf = Array.from(table.gf);
  const ga = Array.from(table.ga);
  const book = (home, away, h, a, sign) => {
    points[home] += sign * (h > a ? 3 : h === a ? 1 : 0);
    points[away] += sign * (a > h ? 3 : h === a ? 1 : 0);
    gf[home] += sign * h; ga[home] += sign * a;
    gf[away] += sign * a; ga[away] += sign * h;
  };
  for (const { home, away, was, now } of replacements) {
    book(home, away, was[0], was[1], -1);
    book(home, away, now[0], now[1], 1);
  }
  return { points, gf, ga };
}

/* P(home win) + half of P(draw) for two independent Poisson sides, as
   `elo.xg_implied_score`: one pass over 0..12 goals with the Poisson
   recurrence, divided by the mass the cap keeps. */
function xgImplied(homeXg, awayXg) {
  let pHome = Math.exp(-homeXg);
  let pAway = Math.exp(-awayXg);
  let awayBelow = 0;
  let home = 0;
  let draw = 0;
  let homeMass = 0;
  for (let k = 0; k <= 12; k += 1) {
    if (k) {
      pHome *= homeXg / k;
      pAway *= awayXg / k;
    }
    home += pHome * awayBelow;
    draw += pHome * pAway;
    awayBelow += pAway;
    homeMass += pHome;
  }
  return (home + 0.5 * draw) / (homeMass * awayBelow);
}

/* Both ratings after one match: `elo.updated_pair`. */
function eloPair(homeRating, awayRating, homeGoals, awayGoals, cfg, homeXg, awayXg) {
  const advantage = cfg.home_advantage_beta === 0
    ? cfg.home_advantage
    : cfg.home_advantage * (1 + (cfg.home_advantage_beta * (homeRating - awayRating)) / 400);
  const expected = 1 / (1 + 10 ** ((awayRating - (homeRating + advantage)) / 400));
  let scored = homeGoals > awayGoals ? 1 : homeGoals < awayGoals ? 0 : 0.5;
  if (homeXg != null && awayXg != null && cfg.xg_alpha > 0) {
    scored = (1 - cfg.xg_alpha) * scored + cfg.xg_alpha * xgImplied(homeXg, awayXg);
    if (cfg.xg_margin) {
      const c = cfg.xg_margin_smoothing;
      const ratio = Math.log((homeXg + c) / (awayXg + c));
      scored += (ratio < 0 ? -1 : 1) * cfg.xg_margin * Math.log(1 + Math.abs(ratio));
    }
  }
  const change = cfg.k_factor * (scored - expected);
  return [homeRating + change, awayRating - change];
}

/* The division's season replayed from kickoff with some results changed: both
   rating updates, a port of `career.replay` (Elo) and `AttackDefence.observe`
   (attack, defence and the keeping windows), run over `rerate`
   (`pipeline.rerate_payload`). `changed` maps a played match_id to its new
   [home, away] score (its xG stays as played); `appended` are matches taken as
   played after the others, in the payload's row shape, with no xG. Returns each
   club's Elo and its [attack, defence, finishing, keeping], the last as the
   report's `attack_defence.teams` has them. */
function rerateSeason(rerate, changed, appended) {
  const { elo: eloCfg, ad: cfg, start, league } = rerate;
  const elo = {};
  const attack = {};
  const defence = {};
  const finishing = {};
  const keeping = {};
  const reference = {};
  const played = {};
  const windows = {};
  for (const [slug, rows] of Object.entries(rerate.windows)) windows[slug] = rows.map((row) => row.slice());
  for (const [team, state] of Object.entries(start)) {
    elo[team] = state.elo;
    attack[team] = state.attack;
    defence[team] = state.defence;
    finishing[team] = state.finishing;
    keeping[team] = state.keeping.map((row) => row.slice());
    if (state.reference) reference[team] = state.reference;
    played[team] = 0;
  }
  // The club's keeping: its window of goals let in against xG on target
  // faced, against its division's, once the window is half full.
  const keepingOf = (team) => {
    const rows = keeping[team];
    const against = windows[reference[team]];
    if (!cfg.keeping_weight || !rows || !rows.length || rows.length < Math.floor(cfg.keeping_window / 2) || !against || !against.length) return 0;
    let letIn = 0;
    let faced = 0;
    for (const row of rows) { letIn += row[0]; faced += row[1]; }
    let leagueLetIn = 0;
    let leagueFaced = 0;
    for (const row of against) { leagueLetIn += row[0]; leagueFaced += row[1]; }
    if (Math.min(letIn, faced, leagueLetIn, leagueFaced) <= 0) return 0;
    return cfg.keeping_weight * (Math.log(faced / letIn) - Math.log(leagueFaced / leagueLetIn));
  };
  const keep = (list, row, size) => {
    list.push(row);
    if (list.length > size) list.shift();
  };
  for (const row of rerate.matches.concat(appended || [])) {
    const [id, home, away, , , homeXg, awayXg, homeXgot, awayXgot] = row;
    const [homeGoals, awayGoals] = (changed && changed.get(id)) || [row[3], row[4]];
    [elo[home], elo[away]] = eloPair(elo[home], elo[away], homeGoals, awayGoals, eloCfg, homeXg, awayXg);

    const lam = Math.exp(cfg.base + cfg.home + attack[home] - defence[away] + finishing[home] - keepingOf(away));
    const mu = Math.exp(cfg.base + attack[away] - defence[home] + finishing[away] - keepingOf(home));
    const shots = homeXg != null && awayXg != null;
    let observedHome = homeGoals;
    let observedAway = awayGoals;
    let step = cfg.k;
    if (shots && cfg.alpha !== 0) {
      const useTarget = cfg.signal === 'xgot' && homeXgot != null;
      observedHome = (1 - cfg.alpha) * homeGoals + cfg.alpha * (useTarget ? homeXgot : homeXg);
      observedAway = (1 - cfg.alpha) * awayGoals + cfg.alpha * (useTarget ? awayXgot : awayXg);
      step = cfg.k_shots || cfg.k;
    }
    const homeSurprise = Math.max(-cfg.cap, Math.min(cfg.cap, observedHome - lam));
    const awaySurprise = Math.max(-cfg.cap, Math.min(cfg.cap, observedAway - mu));
    const early = (team) => (cfg.early_boost ? 1 + cfg.early_boost * Math.exp(-played[team] / cfg.early_tau) : 1);
    const stepHome = step * early(home);
    const stepAway = step * early(away);
    attack[home] += stepHome * homeSurprise;
    defence[away] -= stepAway * homeSurprise;
    attack[away] += stepAway * awaySurprise;
    defence[home] -= stepHome * awaySurprise;
    played[home] += 1;
    played[away] += 1;
    // After a match with xG, each side's reference division and, with xG on
    // target, what it let in against what it faced.
    if (shots) {
      for (const [team, letIn, faced] of [[home, awayGoals, homeXgot == null ? null : awayXgot], [away, homeGoals, homeXgot == null ? null : homeXgot]]) {
        reference[team] = league;
        if (faced == null) continue;
        keep(keeping[team] || (keeping[team] = []), [letIn, faced], cfg.keeping_window);
        keep(windows[league] || (windows[league] = []), [letIn, faced], cfg.league_rows);
      }
    }
  }
  const teams = {};
  for (const team of Object.keys(start)) teams[team] = [attack[team], defence[team], finishing[team], keepingOf(team)];
  return { elo, teams };
}

/* `spec`: count (clubs), sims, seed, sd (the strength shock), points / gf / ga
   per club, fixtures [{ home, away, win, draw, grid }], `fixed` (a [home, away]
   or null per fixture) and, optionally, `replacements` for played matches
   (`replaceResults`). Returns counts[club * count + place] and each club's
   total points over the runs. Clubs level on points go by goal difference,
   then goals scored, then index. */
function simulateSeason(spec) {
  const { count, sims, sd, fixed } = spec;
  const fixtures = spec.fixtures.map((fixture) => (fixture.cum ? fixture : { ...fixture, ...outcomeTables(fixture.grid) }));
  const table = spec.replacements ? replaceResults(spec, spec.replacements) : spec;
  const random = mulberry32(spec.seed);
  const counts = new Int32Array(count * count);
  const totals = new Float64Array(count);
  const points = new Int32Array(count);
  const gf = new Int32Array(count);
  const ga = new Int32Array(count);
  const boost = new Float64Array(count);
  const key = new Float64Array(count);
  const order = new Int32Array(count);
  for (let run = 0; run < sims; run += 1) {
    points.set(table.points);
    gf.set(table.gf);
    ga.set(table.ga);
    // exp(shock) per club; two uniforms each, whatever the shock.
    for (let c = 0; c < count; c += 1) {
      const u = random();
      const v = random();
      boost[c] = Math.exp(sd * Math.sqrt(-2 * Math.log(1 - u)) * Math.cos(2 * Math.PI * v));
    }
    for (let f = 0; f < fixtures.length; f += 1) {
      const fixture = fixtures[f];
      const roll = random();
      const slot = random();
      let h;
      let a;
      if (fixed[f]) {
        [h, a] = fixed[f];
      } else {
        // The win odds scale by boost[home] / boost[away], the loss odds by
        // the inverse, and the three renormalise (season.py).
        const ratio = boost[fixture.home] / boost[fixture.away];
        const win = fixture.win * ratio;
        const loss = (1 - fixture.win - fixture.draw) / ratio;
        const x = roll * (win + fixture.draw + loss);
        const outcome = x < win ? 0 : x < win + fixture.draw ? 1 : 2;
        const cum = fixture.cum[outcome];
        let lo = 0;
        let hi = cum.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (slot < cum[mid]) hi = mid; else lo = mid + 1;
        }
        h = fixture.cells[outcome][2 * lo];
        a = fixture.cells[outcome][2 * lo + 1];
      }
      if (h > a) points[fixture.home] += 3;
      else if (h === a) { points[fixture.home] += 1; points[fixture.away] += 1; } else points[fixture.away] += 3;
      gf[fixture.home] += h; ga[fixture.home] += a;
      gf[fixture.away] += a; ga[fixture.away] += h;
    }
    for (let c = 0; c < count; c += 1) {
      key[c] = (points[c] * 2048 + (gf[c] - ga[c] + 1024)) * 2048 + gf[c];
      totals[c] += points[c];
      let at = c;
      while (at > 0 && key[order[at - 1]] < key[c]) { order[at] = order[at - 1]; at -= 1; }
      order[at] = c;
    }
    for (let place = 0; place < count; place += 1) counts[order[place] * count + place] += 1;
  }
  return { counts, totals };
}

/* The published finishing chances, moved by what locking changed: per club and
   place, published + (locked run - as-played run) / runs, floored at 0 and
   renormalised to a row of 1. With nothing locked the two runs are the same
   run and the published chances come back as they were. */
function shiftedChances(published, baseline, scenario, sims, count) {
  return published.map((chances, club) => {
    const moved = chances.map((p, place) => Math.max(0, p + (scenario.counts[club * count + place] - baseline.counts[club * count + place]) / sims));
    const total = moved.reduce((a, b) => a + b, 0) || 1;
    return moved.map((p) => p / total);
  });
}

if (typeof importScripts === 'function') {
  let cached = null;
  self.onmessage = (event) => {
    const { id, key, base, scenario } = event.data;
    // The as-played run depends on the report alone, so it is kept between locks.
    if (!cached || cached.key !== key) cached = { key, result: simulateSeason(base) };
    self.postMessage({ id, baseline: cached.result, scenario: scenario ? simulateSeason(scenario) : cached.result });
  };
}

if (typeof module !== 'undefined') module.exports = { mulberry32, outcomeTables, replaceResults, simulateSeason, shiftedChances, xgImplied, eloPair, rerateSeason };
