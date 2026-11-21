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
   run and the published chances come back as they were.

   The shift alone cannot reach a certainty: the published chances and the
   as-played run are two different simulations of the same season, so what the
   published chances hold that the run does not (a few tenths of a point in a place
   the lock then rules out) stays behind and keeps a secured title at 99 %. So what
   the lock decides is taken from the locked run, whatever was published: a place
   every run of it gives the club is the club's finish for sure, and a place the
   as-played run gave it and the locked run never does is out. */
function shiftedChances(published, baseline, scenario, sims, count) {
  return published.map((chances, club) => {
    const at = (place) => club * count + place;
    const settled = chances.findIndex((_, place) => scenario.counts[at(place)] === sims && baseline.counts[at(place)] !== sims);
    if (settled >= 0) return chances.map((_, place) => (place === settled ? 1 : 0));
    const moved = chances.map((p, place) => {
      if (scenario.counts[at(place)] === 0 && baseline.counts[at(place)] > 0) return 0;
      return Math.max(0, p + (scenario.counts[at(place)] - baseline.counts[at(place)]) / sims);
    });
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
   multiplied over the matches, so the matches count as independent, as the popup's
   per-match figures do) times the chance of the finish given them. Points are fixed by the
   results, so that second factor is 1 unless clubs are level on points with this one, when
   goal difference, goals scored and then index decide, as the simulation ranks them: it is then
   the chance, from the runs' own scores, that the matches left carry the club past exactly as
   many of them as the finish needs, worked out over all the clubs level together (their matches
   link them). A branch-and-bound search over the matches that can still move the finish (the
   others take their commonest result) cuts any branch that cannot beat the best so far (the
   chance so far times the best each remaining match could add, with a lower bound on what it
   costs the other clubs to end where the finish needs, and a cheap upper bound on the finish
   chance before it is worked out in full) or cannot end with the club here on points. It
   searches with a target that comes down from the best case until a season reaches it, so that
   season is the optimum of that product, not just a good one. A second search then picks the
   scores: each result's commonest score in all runs, except in the matches of clubs level on
   points with this one, which are searched for the likeliest scores that still hold the finish,
   so the lead is the smallest the finish allows, spread over the cheapest scores instead of one
   big win. `typical.table[place]` is its final table, `typical.scores` its scores,
   `typical.odds` the chance of its results in all runs and `typical.finish` the chance of the
   finish given them. `typical.exact` is false only when the work `budget` or the wall-clock
   `deadline` (ms) ran out, or the joint chances grew past what could be followed, so the season
   is the best found, not proven the best; that is the case early in a season, with a hundred
   matches or more left. It is built from simulated results but is not one recorded run.

   `tiePenalty` above 0 (the default) counts that finish chance; 0 ignores it, taking the single
   likeliest run of results even when the finish hangs on goal difference.

   Fewer than `minHits` runs (or all of them) is `enough: false`: nothing to say. */
function scenarioAnalysis(spec, club, place, run, { minHits = 25, tiePenalty = Math.LN2, budget = 8e5, deadline = 1500 } = {}) {
  const startedAt = Date.now();
  const late = () => Date.now() - startedAt > deadline;
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
  // set by points, and among clubs level on points by goal difference, then goals scored, then
  // index, which the results leave open. Every match touching the club or a club level with it
  // adds its score's goals, drawn from the runs' own scores for that result. Per rival, goal
  // difference and goals scored against the club's are packed into one number (difference times a
  // width beyond any goals total, plus goals), so the ranking is just its sign (zero: index).
  // The numbers of all the rivals are followed together, since their matches link them, and a
  // rival whose sign can no longer change is set aside as decided.
  let capped = false;
  const outcome = Uint8Array.from(modal);
  const scorePmf = new Array(F * 3).fill(null);
  const pmfOf = (f, o) => {
    if (scorePmf[f * 3 + o]) return scorePmf[f * 3 + o];
    const list = candidates[f * 3 + o];
    let total = 0;
    for (const sc of list) total += allExact[f * 256 + sc];
    const kept = list.filter((sc) => total === 0 || allExact[f * 256 + sc] / total >= 1e-7);
    const mass = kept.reduce((sum, sc) => sum + (total === 0 ? 1 : allExact[f * 256 + sc]), 0) || 1;
    const made = kept.map((sc) => ({ h: sc >> 4, a: sc & 15, p: (total === 0 ? 1 : allExact[f * 256 + sc]) / mass }));
    scorePmf[f * 3 + o] = made;
    return made;
  };
  const sideGoals = (x, f, o, m) => (x === home[f] ? (o === 0 ? m : o === 2 ? -m : 0) : x === away[f] ? (o === 2 ? m : o === 0 ? -m : 0) : 0);
  const DONE_ABOVE = 1e9;
  const DONE_BELOW = -1e9;
  const aboveCounts = (tied) => {
    const T = tied.length;
    const who = [club, ...tied];
    const touched = live.filter((f) => who.some((c) => home[f] === c || away[f] === c));
    let goals = 0;
    for (const f of touched) goals += Math.max(...pmfOf(f, outcome[f]).map(({ h, a }) => h + a));
    const leadG = tied.map((r) => spec.gf[club] - spec.gf[r]);
    const width = 2 * (goals + Math.max(0, ...leadG.map(Math.abs))) + 1;
    const gdOf = (x, f, h, a) => (x === home[f] ? h - a : x === away[f] ? a - h : 0);
    const gfOf = (x, f, h, a) => (x === home[f] ? h : x === away[f] ? a : 0);
    const steps = touched.map((f) => pmfOf(f, outcome[f]).map(({ h, a, p }) => ({
      p, dv: tied.map((r) => (gdOf(club, f, h, a) - gdOf(r, f, h, a)) * width + gfOf(club, f, h, a) - gfOf(r, f, h, a)),
    })));
    // What each rival's number can still move by after step s.
    const swing = Array.from({ length: touched.length + 1 }, () => new Array(T).fill(0));
    for (let s = touched.length - 1; s >= 0; s -= 1) {
      for (let t = 0; t < T; t += 1) swing[s][t] = swing[s + 1][t] + Math.max(...steps[s].map(({ dv }) => Math.abs(dv[t])));
    }
    const settleDigit = (x, left) => (x >= DONE_ABOVE ? DONE_ABOVE : x <= DONE_BELOW ? DONE_BELOW : x > left ? DONE_ABOVE : x < -left ? DONE_BELOW : x);
    const start = tied.map((r, t) => settleDigit((spec.gf[club] - spec.ga[club] - spec.gf[r] + spec.ga[r]) * width + leadG[t], swing[0][t]));
    let states = new Map([[start.join(), { digits: start, p: 1 }]]);
    let floorP = 1e-13;
    let tick = 0;
    for (let s = 0; s < touched.length; s += 1) {
      const next = new Map();
      if (late()) { capped = true; floorP = Math.max(floorP, 1e-6); }
      for (const { digits, p } of states.values()) {
        for (const { p: q, dv } of steps[s]) {
          const share = p * q;
          if (share < floorP) continue;
          // The clock is read inside a step too, since one step can be the whole deadline.
          if ((tick += 1) % 8192 === 0 && late()) { capped = true; floorP = Math.max(floorP, 1e-6); }
          const moved = digits.map((x, t) => (x >= DONE_ABOVE || x <= DONE_BELOW ? x : settleDigit(x + dv[t], swing[s + 1][t])));
          const key = moved.join();
          const seen = next.get(key);
          if (seen) seen.p += share; else next.set(key, { digits: moved, p: share });
          // Too many joint states: from here the small ones are dropped, so the result is no longer exact.
          if (next.size > 300000 && floorP < 1e-8) { capped = true; floorP = 1e-8; }
          if (next.size > 1200000) { capped = true; floorP = Math.min(1, floorP * 100); }
        }
      }
      work += Math.ceil(states.size * steps[s].length / 64);
      states = next;
    }
    const dist = new Float64Array(T + 1);
    for (const { digits, p } of states.values()) {
      let above = 0;
      // A negative number is a rival ahead of the club; level on everything, the lower index ranks higher.
      digits.forEach((x, t) => { if (x <= DONE_BELOW || (x === 0 && tied[t] < club)) above += 1; });
      dist[above] += p;
    }
    return dist;
  };
  const memoCounts = new Map();
  const countsOf = (tied) => {
    const key = tied.join() + '|' + live.filter((f) => [club, ...tied].some((c) => home[f] === c || away[f] === c)).map((f) => outcome[f]).join('');
    let dist = memoCounts.get(key);
    if (!dist) { dist = aboveCounts(tied); memoCounts.set(key, dist); }
    return dist;
  };
  // A bound the cheap way: the chance that exactly k of the tied clubs end above is at most the
  // chance of any one of the events it needs, summed over which k they are.
  const finishBound = (tied, k) => {
    const T = tied.length;
    if (T > 12) return 1;
    const q = tied.map((r) => countsOf([r])[1]);
    let total = 0;
    for (let set = 0; set < (1 << T); set += 1) {
      let size = 0;
      let top = 1;
      for (let t = 0; t < T; t += 1) {
        if (set & (1 << t)) { size += 1; top = Math.min(top, q[t]); } else top = Math.min(top, 1 - q[t]);
      }
      if (size === k) total += top;
    }
    return Math.min(1, total);
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
      const k = place - above;
      // Only a leaf that could still beat the best has its finish chance worked out in full.
      const bound = tied.length === 1 ? 1 : finishBound(tied, k);
      if (!(bound > 1e-12) || (countFinish ? value + Math.log(bound) : value) <= best + 1e-12) return;
      chance = countsOf(tied)[k];
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
  const atClub = Array.from({ length: count }, () => []);
  live.forEach((f, j) => { atClub[home[f]].push(j); atClub[away[f]].push(j); });
  const modalCost = live.map((f) => [0, 1, 2].map((o) => (logOdds(f, modal[f]) - logOdds(f, o)) / 2));
  // A lower bound on what the matches still to decide (from index i) must cost for this finish.
  // The club ends on some points P; every other club then has to end where the finish needs it
  // relative to P: no more than "place" above, no more than count - 1 - place below. Each club on
  // its own takes its cheapest results to end on a given total (a match shared by two clubs is
  // charged half to each, so the sum never exceeds what the one change really costs; their
  // picks need not agree, which only loosens the bound); the bound is the cheapest P, with the
  // club's own cost to reach it, and the cheapest few clubs paying to cross it.
  // Once the club's own results are in its points are fixed, and only the clubs that would
  // end on the wrong side of them need a table.
  const fixedCost = (i) => {
    const target = pts[club];
    const up = [];
    const down = [];
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
        rest.push({ j, mine });
      }
      if (modalPts === target) continue;
      let cost = new Float64Array(3 * rest.length + 1).fill(Infinity);
      cost[0] = 0;
      for (const { j, mine } of rest) {
        const next = new Float64Array(cost.length).fill(Infinity);
        for (let t = 0; t < cost.length; t += 1) {
          if (cost[t] === Infinity) continue;
          for (let o = 0; o < 3; o += 1) {
            const at = t + worth(o)[mine];
            const price = cost[t] + modalCost[j][o];
            if (price < next[at]) next[at] = price;
          }
        }
        cost = next;
      }
      let cheapest = Infinity;
      for (let t = 0; t < cost.length; t += 1) {
        const end = pts[c] + t;
        if ((modalPts > target ? end <= target : end >= target) && cost[t] < cheapest) cheapest = cost[t];
      }
      if (modalPts > target) { high += 1; up.push(cheapest); } else { low += 1; down.push(cheapest); }
    }
    const pay = (costs, n) => {
      if (n <= 0) return 0;
      if (costs.length < n) return Infinity;
      costs.sort((x, y) => x - y);
      let sum = 0;
      for (let k = 0; k < n; k += 1) sum += costs[k];
      return sum;
    };
    return pay(up, high - place) + pay(down, low - (count - 1 - place));
  };
  const lowerCost = (i) => {
    if (left[club] === 0) return fixedCost(i);
    const tables = new Array(count);
    for (let c = 0; c < count; c += 1) {
      const rest = [];
      let modalPts = pts[c];
      for (const j of atClub[c]) {
        if (j < i) continue;
        const f = live[j];
        const mine = home[f] === c ? 0 : 1;
        modalPts += worth(modal[f])[mine];
        rest.push({ j, mine });
      }
      let cost = new Float64Array(3 * rest.length + 1).fill(Infinity);
      cost[0] = 0;
      for (const { j, mine } of rest) {
        const next = new Float64Array(cost.length).fill(Infinity);
        for (let t = 0; t < cost.length; t += 1) {
          if (cost[t] === Infinity) continue;
          for (let o = 0; o < 3; o += 1) {
            const at = t + worth(o)[mine];
            const price = cost[t] + modalCost[j][o];
            if (price < next[at]) next[at] = price;
          }
        }
        cost = next;
      }
      // Cheapest to end on this much or less (at most), or this much or more (at least).
      const atMost = Float64Array.from(cost);
      for (let t = 1; t < atMost.length; t += 1) if (atMost[t - 1] < atMost[t]) atMost[t] = atMost[t - 1];
      const atLeast = Float64Array.from(cost);
      for (let t = atLeast.length - 2; t >= 0; t -= 1) if (atLeast[t + 1] < atLeast[t]) atLeast[t] = atLeast[t + 1];
      tables[c] = { cost, atMost, atLeast, modalPts };
    }
    let cheapest = Infinity;
    const own = tables[club];
    for (let t = 0; t < own.cost.length; t += 1) {
      if (own.cost[t] === Infinity) continue;
      const target = pts[club] + t;
      const up = [];
      const down = [];
      let high = 0;
      let low = 0;
      for (let c = 0; c < count; c += 1) {
        if (c === club) continue;
        const tab = tables[c];
        const index = target - pts[c];
        if (tab.modalPts > target) {
          high += 1;
          up.push(index < 0 ? Infinity : tab.atMost[Math.min(index, tab.atMost.length - 1)]);
        } else if (tab.modalPts < target) {
          low += 1;
          down.push(index >= tab.atLeast.length ? Infinity : tab.atLeast[Math.max(0, index)]);
        }
      }
      const pay = (costs, n) => {
        if (n <= 0) return 0;
        if (costs.length < n) return Infinity;
        costs.sort((x, y) => x - y);
        let sum = 0;
        for (let k = 0; k < n; k += 1) sum += costs[k];
        return sum;
      };
      const total = own.cost[t] + pay(up, high - place) + pay(down, low - (count - 1 - place));
      if (total < cheapest) cheapest = total;
    }
    return cheapest;
  };
  const descend = (i, value) => {
    if (!complete) return;
    if (work > LIMIT || ((nodes & 127) === 0 && late())) { complete = false; return; }
    work += 1;
    nodes += 1;
    if (value + suffix[i] <= Math.max(best, floor) + 1e-12) return;
    if (!reachable()) return;
    if (i < L) {
      work += left[club] === 0 ? 3 : 3 + Math.ceil(count * (L - i) / 40);
      if (value + suffix[i] - lowerCost(i) <= Math.max(best, floor) + 1e-12) return;
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
  // A first answer worth beating, from the best of those: its results changed one match at a time
  // while the season (the chance of its results times that of the finish) improves.
  if (bestOutcome) {
    const appraise = () => {
      let above = 0;
      const level = [];
      for (let c = 0; c < count; c += 1) {
        if (c === club) continue;
        if (pts[c] > pts[club]) above += 1;
        else if (pts[c] === pts[club]) level.push(c);
      }
      if (place < above || place > above + level.length) return null;
      let value = 0;
      for (const f of live) value += logOdds(f, outcome[f]);
      // Only the odds of the results are climbed (the finish just has to be possible); the finish
      // chance is worked out once, for the season it ends on.
      return { total: value, value, level, above };
    };
    pts.set(base);
    outcome.set(modal);
    for (const f of live) {
      outcome[f] = bestOutcome[f];
      const [h, a] = worth(outcome[f]);
      pts[home[f]] += h; pts[away[f]] += a;
    }
    let now = appraise();
    for (let round = 0; round < 40 && now && !late() && complete; round += 1) {
      let moved = false;
      for (const f of live) {
        const was = outcome[f];
        for (let o = 0; o < 3 && !late(); o += 1) {
          if (o === was || o === outcome[f]) continue;
          const [h0, a0] = worth(outcome[f]);
          const [h1, a1] = worth(o);
          pts[home[f]] += h1 - h0; pts[away[f]] += a1 - a0;
          const before = outcome[f];
          outcome[f] = o;
          const next = appraise();
          if (next && next.total > now.total + 1e-9) { now = next; moved = true; } else {
            pts[home[f]] -= h1 - h0; pts[away[f]] -= a1 - a0;
            outcome[f] = before;
          }
        }
      }
      if (!moved) break;
    }
    if (now) {
      let chance = 1;
      if (now.level.length) chance = countsOf(now.level)[place - now.above];
      const total = countFinish ? now.value + Math.log(chance) : now.value;
      if (chance > 1e-12 && total > best + 1e-12) { best = total; bestOutcome = outcome.slice(); bestFinish = chance; bestOdds = now.value; }
    }
  }
  // Iterative deepening on the target: with the best case (every match its commonest result) as
  // the target nothing is explored but near-misses, and the target comes down by half a nat until
  // some season reaches it. That one is the best of all: every season above the target was
  // searched, and none beat it. It costs far less than searching without a target, where the
  // search wanders through many seasons before finding a good one.
  let bottom = 0;
  for (const f of live) bottom += Math.min(logOdds(f, 0), logOdds(f, 1), logOdds(f, 2));
  let floor = suffix[0] - 0.5;
  for (;;) {
    pts.set(base);
    outcome.set(modal);
    left.fill(0);
    for (const f of live) { left[home[f]] += 1; left[away[f]] += 1; }
    descend(0, 0);
    if (!complete || best > floor || floor < bottom) break;
    floor -= 0.5;
  }
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
      if (steps > LIMIT || (steps & 255) === 0 && late()) { scoresExact = false; steps = LIMIT + 1; return; }
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
  const typical = { scores: [], table: [], exact: complete && scoresExact && !capped, odds: Math.exp(bestOdds), finish: bestFinish };
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
