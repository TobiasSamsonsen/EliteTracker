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
   then goals scored, then index. With `record` it also returns `runs`: every
   run's scores and finishing places, for `scenarioAnalysis` (the draws, and so
   the counts, are the same with or without). */
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
  const F = fixtures.length;
  const runs = spec.record ? { scores: new Uint8Array(sims * F), places: new Uint8Array(sims * count), sims, count, F } : null;
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
      // A score is kept as two nibbles (15 goals a side is more than any run draws).
      if (runs) runs.scores[run * F + f] = (Math.min(h, 15) << 4) | Math.min(a, 15);
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
    for (let place = 0; place < count; place += 1) {
      counts[order[place] * count + place] += 1;
      if (runs) runs.places[run * count + order[place]] = place;
    }
  }
  return { counts, totals, runs };
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

/* Which way a packed score (home goals << 4 | away goals) went: 0 a home win,
   1 a draw, 2 an away win. */
const SCORE_OUTCOME = Uint8Array.from({ length: 256 }, (_, s) => ((s >> 4) > (s & 15) ? 0 : (s >> 4) === (s & 15) ? 1 : 2));

/* How a club comes to finish in one place. `run0` is the season's recorded runs
   (`simulateSeason` with `record`); `club` and `place` are indices (place 0 is
   first). Per fixture result, `prior` is how often it happens in all runs and
   `cond` how often among the runs that end this way (index fixture * 3 +
   result: 0 home win, 1 draw, 2 away win). `own` lists the club's fixtures.
   `key` is up to six of the other clubs' fixtures where a result, or one side
   not winning (a draw or a loss for it), is clearly more common among the runs
   that end this way (8 points of share or more): `{ f, outcomes, prior, cond }`,
   the biggest lift first. It is read off the same shares, not used to pick the season.
   `typical` is the likeliest season that ends this way, found exactly rather than by
   hill-climbing. The finish is only a filter, so the likeliest season is the one
   maximising the chance of its results (each result's share among all the runs,
   multiplied over the matches) times the chance of the finish given them. Points are
   fixed by the results, so that second factor is 1 unless clubs are level on points with
   this one, when goal difference decides: it is then the chance, from the runs' own
   margins, that the matches left carry the club past exactly as many of them as the finish
   needs (level on goal difference counts as half). A branch-and-bound search over the
   matches that can still move the finish (the other matches take their commonest result)
   cuts any branch that cannot beat the best so far (the chance so far times the best each
   remaining match could add, with a lower bound on what it costs the other clubs to end
   where the finish needs) or cannot end with the club here on points; what it returns is the
   optimum of that product. A second search then picks the scores: each result's commonest score
   in all runs, except in the matches of clubs level on points with this one, which are
   searched for the likeliest scores that still hold the finish (goal difference, goals
   scored, index, as the simulation ranks them), so the lead is the smallest the finish
   allows, spread over the cheapest scores instead of one big win. `typical.table[place]`
   is its final table, `typical.scores` its scores, `typical.odds` the chance of its results in
   all runs and `typical.finish` the chance of the finish given them. `typical.exact` is
   false when the work `budget` ran out first, or more than two clubs were level (those are
   taken club by club), so the season is the best found, not proven the best. It is built from
   simulated results but is not one recorded run.

   `tiePenalty` above 0 (the default) counts that finish chance; 0 ignores it, taking the single
   likeliest run of results even when the finish hangs on a goal-difference toss-up.

   Fewer than `minHits` runs (or all of them) is `enough: false`: nothing to say. */
function scenarioAnalysis(spec, club, place, run, { minHits = 25, tiePenalty = Math.LN2, budget = 8e5 } = {}) {
  const { scores, places, sims, count, F } = run;
  const fixtures = spec.fixtures;
  const own = [];
  for (let f = 0; f < F; f += 1) if (fixtures[f].home === club || fixtures[f].away === club) own.push(f);
  const all = new Int32Array(F * 3);
  const hitN = new Int32Array(F * 3);
  const exact = new Int32Array(F * 256);
  const allExact = new Int32Array(F * 256);
  const hit = new Uint8Array(sims);
  let hits = 0;
  for (let r = 0; r < sims; r += 1) {
    const won = places[r * count + club] === place ? 1 : 0;
    hit[r] = won;
    hits += won;
    for (let f = 0; f < F; f += 1) {
      const s = scores[r * F + f];
      const k = f * 3 + SCORE_OUTCOME[s];
      all[k] += 1;
      allExact[f * 256 + s] += 1;
      if (won) { hitN[k] += 1; exact[f * 256 + s] += 1; }
    }
  }
  const result = { club, place, sims, hits, chance: hits / sims, enough: hits >= minHits && hits < sims, own, prior: null, cond: null, key: [], typical: null };
  if (!result.enough) return result;
  result.prior = Array.from(all, (n) => n / sims);
  result.cond = Array.from(hitN, (n) => n / hits);

  // The key fixtures: the result (or a side not winning) whose share rises most.
  const sets = [[0], [1], [2], [1, 2], [0, 1]];
  const sum = (shares, f, set) => set.reduce((total, o) => total + shares[f * 3 + o], 0);
  const own0 = new Set(own);
  const found = [];
  for (let f = 0; f < F; f += 1) {
    if (own0.has(f)) continue;
    let best = null;
    for (const outcomes of sets) {
      const prior = sum(result.prior, f, outcomes);
      const cond = sum(result.cond, f, outcomes);
      if (cond - prior >= 0.08 && (!best || cond - prior > best.cond - best.prior)) best = { f, outcomes, prior, cond };
    }
    if (best) found.push(best);
  }
  result.key = found.sort((x, y) => (y.cond - y.prior) - (x.cond - x.prior)).slice(0, 6);

  const logOdds = (f, o) => Math.log((all[f * 3 + o] + 0.5) / sims);
  const home = Int32Array.from(fixtures, (fixture) => fixture.home);
  const away = Int32Array.from(fixtures, (fixture) => fixture.away);
  const pts = new Int32Array(count);
  const gf = new Int32Array(count);
  const ga = new Int32Array(count);
  const standing = (sc) => {
    pts.set(spec.points); gf.set(spec.gf); ga.set(spec.ga);
    for (let f = 0; f < F; f += 1) {
      const h = sc[f] >> 4;
      const a = sc[f] & 15;
      pts[home[f]] += h > a ? 3 : h === a ? 1 : 0;
      pts[away[f]] += a > h ? 3 : h === a ? 1 : 0;
      gf[home[f]] += h; ga[home[f]] += a; gf[away[f]] += a; ga[away[f]] += h;
    }
    // As the simulation ranks them: points, goal difference, goals scored, index.
    return Array.from({ length: count }, (_, c) => c).sort((x, y) => pts[y] - pts[x] || (gf[y] - ga[y]) - (gf[x] - ga[x]) || gf[y] - gf[x] || x - y);
  };

  // Every score that came up in any run, per result, the commonest first.
  const candidates = Array.from({ length: F * 3 }, () => []);
  for (let f = 0; f < F; f += 1) {
    for (let sc = 0; sc < 256; sc += 1) if (allExact[f * 256 + sc] > 0) candidates[f * 3 + SCORE_OUTCOME[sc]].push(sc);
    for (let o = 0; o < 3; o += 1) {
      const list = candidates[f * 3 + o];
      list.sort((x, y) => allExact[f * 256 + y] - allExact[f * 256 + x] || x - y);
      if (!list.length) list.push(o === 0 ? 16 : o === 1 ? 0 : 1);
    }
  }
  const scoreOdds = (f, sc) => Math.log(allExact[f * 256 + sc] + 0.5);
  // The margin of a decided result (a home win by m, an away win by m), as its share of that
  // result's runs; tiny tails are dropped. A draw has no margin.
  const margins = Array.from({ length: F * 3 }, () => ({ m: [0], p: [1] }));
  for (let f = 0; f < F; f += 1) {
    for (const o of [0, 2]) {
      const byMargin = new Map();
      let total = 0;
      for (const sc of candidates[f * 3 + o]) {
        const n = allExact[f * 256 + sc];
        total += n;
        const m = Math.abs((sc >> 4) - (sc & 15));
        byMargin.set(m, (byMargin.get(m) || 0) + n);
      }
      const keep = [...byMargin].filter(([, n]) => total > 0 && n / total >= 1e-5);
      const kept = keep.reduce((sum, [, n]) => sum + n, 0) || 1;
      margins[f * 3 + o] = { m: keep.map(([m]) => m), p: keep.map(([, n]) => n / kept) };
      if (!keep.length) margins[f * 3 + o] = { m: [1], p: [1] };
    }
  }

  // Which clubs can still change this finish: those whose final points could land beside the
  // club's. A club that ends above (or below) it whatever happens only matters through its
  // matches against the others. A match between two such clubs takes its commonest result.
  const maxPts = Int32Array.from(spec.points);
  for (let f = 0; f < F; f += 1) { maxPts[home[f]] += 3; maxPts[away[f]] += 3; }
  const relevant = Array.from({ length: count }, (_, c) => c === club || !(maxPts[c] < spec.points[club] || spec.points[c] > maxPts[club]));
  const modal = Uint8Array.from({ length: F }, (_, f) => (all[f * 3] >= all[f * 3 + 1] && all[f * 3] >= all[f * 3 + 2] ? 0 : all[f * 3 + 1] >= all[f * 3 + 2] ? 1 : 2));
  const live = [];
  for (let f = 0; f < F; f += 1) if (relevant[home[f]] || relevant[away[f]]) live.push(f);
  // The matches with the biggest cost for a deviation first: the bound bites soonest.
  const regret = (f) => { const v = [0, 1, 2].map((o) => logOdds(f, o)).sort((x, y) => y - x); return v[0] - v[1]; };
  live.sort((x, y) => (own0.has(y) - own0.has(x)) || regret(y) - regret(x));
  const L = live.length;
  const worth = (o) => (o === 0 ? [3, 0] : o === 1 ? [1, 1] : [0, 3]);

  // The chance that the club ends exactly where it is wanted, given every result: its place is
  // set by points, and among clubs level on points by goal difference, which the results leave
  // open: each match's margin adds to the clubs' goal differences, drawn from the runs' own
  // margins. The goal differences of all the clubs level with it are followed together (their
  // matches link them), then every end state says how many of them the club passes; level on
  // goal difference counts as half, taken club by club.
  let approximate = false;
  const outcome = Uint8Array.from(modal);
  const sideGoals = (x, f, o, m) => (x === home[f] ? (o === 0 ? m : o === 2 ? -m : 0) : x === away[f] ? (o === 2 ? m : o === 0 ? -m : 0) : 0);
  const jointChance = (tied, k) => {
    const T = tied.length;
    const touched = live.filter((f) => outcome[f] !== 1 && [club, ...tied].some((c) => home[f] === c || away[f] === c));
    let reach = 0;
    for (const f of touched) reach += 2 * Math.max(...margins[f * 3 + outcome[f]].m);
    const lead = tied.map((r) => (spec.gf[club] - spec.ga[club]) - (spec.gf[r] - spec.ga[r]));
    const offset = reach + Math.max(0, ...lead.map(Math.abs));
    const width = 2 * offset + 1;
    const stride = Array.from({ length: T }, (_, t) => width ** t);
    let states = new Map([[lead.reduce((key, d, t) => key + (d + offset) * stride[t], 0), 1]]);
    for (const f of touched) {
      const o = outcome[f];
      const spread = margins[f * 3 + o];
      const step = tied.map((r) => sideGoals(club, f, o, 1) - sideGoals(r, f, o, 1));
      const shifts = spread.m.map((m) => step.reduce((sum, k2, t) => sum + k2 * m * stride[t], 0));
      const next = new Map();
      for (const [key, p] of states) {
        for (let j = 0; j < shifts.length; j += 1) {
          const q = p * spread.p[j];
          if (q < 1e-13) continue;
          next.set(key + shifts[j], (next.get(key + shifts[j]) || 0) + q);
        }
      }
      states = next;
    }
    const passes = T - k;
    let chance = 0;
    const ways = new Float64Array(T + 1);
    for (const [key, p] of states) {
      ways.fill(0);
      ways[0] = 1;
      let rest = key;
      for (let t = 0; t < T; t += 1) {
        const d = (rest % width) - offset;
        rest = Math.floor(rest / width);
        const q = d > 0 ? 1 : d === 0 ? 0.5 : 0;
        for (let j = t + 1; j >= 0; j -= 1) ways[j] = ways[j] * (1 - q) + (j > 0 ? ways[j - 1] * q : 0);
      }
      chance += p * ways[passes];
    }
    return chance;
  };
  // Up to two clubs level are followed together. More are taken club by club (their ends are
  // linked, so this is an approximation, and an optimum found with it is flagged inexact).
  const finishChance = (tied, k) => {
    if (tied.length <= 2) return jointChance(tied, k);
    approximate = true;
    const passes = tied.length - k;
    const ways = new Float64Array(tied.length + 1);
    ways[0] = 1;
    tied.forEach((r, t) => {
      const q = jointChance([r], 0);
      for (let j = t + 1; j >= 0; j -= 1) ways[j] = ways[j] * (1 - q) + (j > 0 ? ways[j - 1] * q : 0);
    });
    return ways[passes];
  };

  // The likeliest way the results go: the one maximising its odds (the runs' shares) times the
  // chance of the finish given those results. A search over the live matches that cuts every
  // branch that cannot beat the best found (the odds so far plus the best each remaining match
  // could add, with the finish chance at most 1) or cannot end with the club here (points
  // alone), so what it returns is the optimum unless the node limit stops it (typical.exact).
  const countFinish = tiePenalty > 0;
  const base = Int32Array.from(spec.points);
  for (let f = 0; f < F; f += 1) {
    if (live.includes(f)) continue;
    const [h, a] = worth(modal[f]);
    base[home[f]] += h; base[away[f]] += a;
  }
  let best = -Infinity;
  let bestOutcome = null;
  let bestFinish = 1;
  let bestOdds = 0;
  let nodes = 0;
  let complete = true;
  const LIMIT = budget;
  let work = 0;
  const memo = new Map();
  const settle = (value) => {
    let above = 0;
    const tied = [];
    for (let c = 0; c < count; c += 1) {
      if (c === club) continue;
      if (pts[c] > pts[club]) above += 1;
      else if (pts[c] === pts[club]) tied.push(c);
    }
    if (place < above || place > above + tied.length) return;
    let total = value;
    let chance = 1;
    if (tied.length) {
      const keyed = tied.join() + '|' + (place - above) + '|' + live.filter((f) => [club, ...tied].some((c) => home[f] === c || away[f] === c)).map((f) => outcome[f]).join('');
      chance = memo.get(keyed);
      if (chance === undefined) { work += 25; chance = finishChance(tied, place - above); memo.set(keyed, chance); }
      if (!(chance > 1e-12)) return;
      if (countFinish) total += Math.log(chance);
    }
    if (total > best + 1e-12) { best = total; bestOutcome = outcome.slice(); bestFinish = chance; bestOdds = value; }
  };
  const suffix = new Float64Array(L + 1);
  for (let i = L - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1] + Math.max(logOdds(live[i], 0), logOdds(live[i], 1), logOdds(live[i], 2));
  const left = new Int32Array(count);
  for (const f of live) { left[home[f]] += 1; left[away[f]] += 1; }
  const choices = live.map((f) => [0, 1, 2].sort((x, y) => logOdds(f, y) - logOdds(f, x)));
  const reachable = () => {
    const top = pts[club] + 3 * left[club];
    let over = 0;
    let under = 0;
    for (let c = 0; c < count; c += 1) {
      if (c === club) continue;
      if (pts[c] > top) over += 1;
      if (pts[c] + 3 * left[c] < pts[club]) under += 1;
    }
    return over <= place && under <= count - 1 - place;
  };
  // A lower bound on what it costs, once the club's own results are in, for the other clubs to
  // end where this finish needs them: no more than "place" above it, no more than count - 1 -
  // place below it. Each club on its own takes the cheapest of its remaining results that
  // moves it across the club's points (a match shared by two clubs is charged half to each,
  // so the sum never exceeds what the one change really costs); the cheapest few clubs pay.
  const slot = new Map(live.map((f, j) => [f, j]));
  const atClub = Array.from({ length: count }, () => []);
  live.forEach((f, j) => { atClub[home[f]].push(j); atClub[away[f]].push(j); });
  const shortfall = (i) => {
    const target = pts[club];
    const cheapUp = [];
    const cheapDown = [];
    let high = 0;
    let low = 0;
    for (let c = 0; c < count; c += 1) {
      if (c === club) continue;
      let modalPts = pts[c];
      const rest = [];
      for (const j of atClub[c]) {
        if (j < i) continue;
        const f = live[j];
        const mine = home[f] === c ? 0 : 1;
        modalPts += worth(modal[f])[mine];
        rest.push({ f, mine });
      }
      if (modalPts > target) {
        high += 1;
        // The cheapest way to end on target or less.
        let table = new Map([[pts[c], 0]]);
        for (const { f, mine } of rest) {
          const next = new Map();
          for (const [at, spent] of table) {
            for (let o = 0; o < 3; o += 1) {
              const to = at + worth(o)[mine];
              const price = spent + (logOdds(f, modal[f]) - logOdds(f, o)) / 2;
              if (price < (next.get(to) ?? Infinity)) next.set(to, price);
            }
          }
          table = next;
        }
        let cheapest = Infinity;
        for (const [at, spent] of table) if (at <= target && spent < cheapest) cheapest = spent;
        cheapUp.push(cheapest);
      } else if (modalPts < target) {
        low += 1;
        let table = new Map([[pts[c], 0]]);
        for (const { f, mine } of rest) {
          const next = new Map();
          for (const [at, spent] of table) {
            for (let o = 0; o < 3; o += 1) {
              const to = at + worth(o)[mine];
              const price = spent + (logOdds(f, modal[f]) - logOdds(f, o)) / 2;
              if (price < (next.get(to) ?? Infinity)) next.set(to, price);
            }
          }
          table = next;
        }
        let cheapest = Infinity;
        for (const [at, spent] of table) if (at >= target && spent < cheapest) cheapest = spent;
        cheapDown.push(cheapest);
      }
    }
    const pay = (costs, n) => costs.sort((x, y) => x - y).slice(0, Math.max(0, n)).reduce((a, b) => a + b, 0) + (costs.length < n ? Infinity : 0);
    return pay(cheapUp, high - place) + pay(cheapDown, low - (count - 1 - place));
  };
  const descend = (i, value) => {
    if (work > LIMIT) { complete = false; return; }
    work += 1;
    nodes += 1;
    if (value + suffix[i] <= best + 1e-12) return;
    if (!reachable()) return;
    if (left[club] === 0 && i < L) {
      work += 3;
      if (value + suffix[i] - shortfall(i) <= best + 1e-12) return;
    }
    if (i === L) { settle(value); return; }
    const f = live[i];
    left[home[f]] -= 1; left[away[f]] -= 1;
    for (const o of choices[i]) {
      const [h, a] = worth(o);
      pts[home[f]] += h; pts[away[f]] += a;
      outcome[f] = o;
      descend(i + 1, value + logOdds(f, o));
      pts[home[f]] -= h; pts[away[f]] -= a;
    }
    left[home[f]] += 1; left[away[f]] += 1;
  };
  // The recorded runs that end this way give it a first answer to beat.
  const starts = [];
  for (let r = 0; r < sims; r += 1) {
    if (!hit[r]) continue;
    let odds = 0;
    for (const f of live) odds += logOdds(f, SCORE_OUTCOME[scores[r * F + f]]);
    if (starts.length < 4 || odds > starts[starts.length - 1].odds) {
      starts.push({ r, odds });
      starts.sort((x, y) => y.odds - x.odds);
      if (starts.length > 4) starts.pop();
    }
  }
  for (const { r } of starts) {
    pts.set(base);
    outcome.set(modal);
    let value = 0;
    for (const f of live) {
      const o = SCORE_OUTCOME[scores[r * F + f]];
      outcome[f] = o;
      const [h, a] = worth(o);
      pts[home[f]] += h; pts[away[f]] += a;
      value += logOdds(f, o);
    }
    settle(value);
  }
  pts.set(base);
  outcome.set(modal);
  descend(0, 0);
  if (!bestOutcome) {
    // Nothing found within the budget: the best recorded run's results, not proven the best.
    if (!starts.length) { result.enough = false; return result; }
    bestOutcome = Uint8Array.from({ length: F }, (_, f) => SCORE_OUTCOME[scores[starts[0].r * F + f]]);
    complete = false;
  }

  // The scores. With the results fixed, so are the points, so goal difference (then goals
  // scored) can only move the finish between the club and the clubs level with it on points,
  // in their matches. Every other match takes the commonest score of its result. Those matches
  // are searched for the likeliest scores that still hold the finish, with the same kind of
  // bound; the goal difference needed is spread over the cheapest scores, not one big win.
  const sc = Uint8Array.from({ length: F }, (_, f) => candidates[f * 3 + bestOutcome[f]][0]);
  standing(sc);
  const tied = [];
  for (let c = 0; c < count; c += 1) if (c !== club && pts[c] === pts[club]) tied.push(c);
  let scoresExact = true;
  if (tied.length) {
    const loose = [];
    for (let f = 0; f < F; f += 1) if ([club, ...tied].some((c) => home[f] === c || away[f] === c)) loose.push(f);
    loose.sort((x, y) => (own0.has(y) - own0.has(x)));
    const M = loose.length;
    const options = loose.map((f) => candidates[f * 3 + bestOutcome[f]]);
    const cost = loose.map((f, i) => options[i].map((s) => scoreOdds(f, s)));
    const rest = new Float64Array(M + 1);
    for (let i = M - 1; i >= 0; i -= 1) rest[i] = rest[i + 1] + Math.max(...cost[i]);
    // Each tied club's goal difference against the club's, what is left to add after match i.
    const gap = (i, j, r) => sideGoals(club, loose[i], bestOutcome[loose[i]], Math.abs((options[i][j] >> 4) - (options[i][j] & 15))) - sideGoals(r, loose[i], bestOutcome[loose[i]], Math.abs((options[i][j] >> 4) - (options[i][j] & 15)));
    const lo = tied.map((r) => { const out = new Int32Array(M + 1); for (let i = M - 1; i >= 0; i -= 1) out[i] = out[i + 1] + Math.min(...options[i].map((_, j) => gap(i, j, r))); return out; });
    const hi = tied.map((r) => { const out = new Int32Array(M + 1); for (let i = M - 1; i >= 0; i -= 1) out[i] = out[i + 1] + Math.max(...options[i].map((_, j) => gap(i, j, r))); return out; });
    const lead = tied.map((r) => (spec.gf[club] - spec.ga[club]) - (spec.gf[r] - spec.ga[r]));
    let above0 = 0;
    for (let c = 0; c < count; c += 1) if (c !== club && pts[c] > pts[club]) above0 += 1;
    const need = place - above0;
    const run = Uint8Array.from(sc);
    let bestScore = -Infinity;
    let bestScores = null;
    let steps = 0;
    const walk = (i, value) => {
      if (steps > LIMIT) { scoresExact = false; return; }
      steps += 1;
      if (value + rest[i] <= bestScore + 1e-12) return;
      let sure = 0;
      let safe = 0;
      for (let t = 0; t < tied.length; t += 1) {
        if (lead[t] + hi[t][i] < 0) sure += 1;
        else if (lead[t] + lo[t][i] > 0) safe += 1;
      }
      if (sure > need || safe > tied.length - need) return;
      if (i === M) {
        if (standing(run)[place] === club && value > bestScore + 1e-12) { bestScore = value; bestScores = run.slice(); }
        return;
      }
      const f = loose[i];
      for (let j = 0; j < options[i].length; j += 1) {
        if (value + cost[i][j] + rest[i + 1] <= bestScore + 1e-12) break;
        run[f] = options[i][j];
        const was = lead.slice();
        for (let t = 0; t < tied.length; t += 1) lead[t] += gap(i, j, tied[t]);
        walk(i + 1, value + cost[i][j]);
        for (let t = 0; t < tied.length; t += 1) lead[t] = was[t];
      }
    };
    walk(0, 0);
    if (bestScores) sc.set(bestScores);
    else scoresExact = false;
  }
  // odds: the chance of these results in all runs (the live matches'); finish: the chance of the finish given them.
  // No score line holds the finish (the level-on-goal-difference toss-up went the other way, or the
  // budget ran out): fall back to the recorded run that came closest to this, which does end this way.
  if (standing(sc)[place] !== club) {
    for (let f = 0; f < F; f += 1) sc[f] = scores[starts[0].r * F + f];
    scoresExact = false;
  }
  const typical = { scores: [], table: [], exact: complete && scoresExact && !approximate, odds: Math.exp(bestOdds), finish: bestFinish };
  const order = standing(sc);
  for (let f = 0; f < F; f += 1) typical.scores.push([sc[f] >> 4, sc[f] & 15]);
  order.forEach((c, i) => { typical.table[i] = { club: c, points: pts[c], goalDifference: gf[c] - ga[c], goalsFor: gf[c] }; });
  result.typical = typical;
  return result;
}

if (typeof importScripts === 'function') {
  let cached = null;
  // The recorded runs of the last report asked about, for the finish grid's clicks.
  let recorded = null;
  self.onmessage = (event) => {
    const { id, key, base, scenario, club, place, avoidTie } = event.data;
    if (event.data.type === 'scenario') {
      if (!recorded || recorded.key !== key) recorded = { key, runs: simulateSeason({ ...base, record: true }).runs };
      // No club: only the warm-up, so the first click finds the runs made.
      self.postMessage({ id, analysis: club == null ? null : scenarioAnalysis(base, club, place, recorded.runs, { tiePenalty: avoidTie === false ? 0 : Math.LN2 }) });
      return;
    }
    // The as-played run depends on the report alone, so it is kept between locks.
    if (!cached || cached.key !== key) cached = { key, result: simulateSeason(base) };
    self.postMessage({ id, baseline: cached.result, scenario: scenario ? simulateSeason(scenario) : cached.result });
  };
}

if (typeof module !== 'undefined') module.exports = { mulberry32, outcomeTables, replaceResults, simulateSeason, scenarioAnalysis, shiftedChances, xgImplied, eloPair, rerateSeason };
