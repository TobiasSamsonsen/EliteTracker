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
   `typical` is the likeliest season that ends this way. The finish is only a
   filter, so among the seasons that end this way the likeliest is the one with
   the highest odds as a whole: the product of its results' shares among all the
   runs (the fewest and least surprising results). It starts from the best of
   the recorded runs that end this way and is improved result by result: a
   result swapped for a likelier one (with its commonest score among the runs
   that end this way) whenever the club still finishes there, one swap or two at
   a time. A finish decided on goal difference (level on points with the club
   beside it) is a toss-up, so it counts as half as likely. The season is built
   from simulated results, but is not one recorded run. `typical.table[place]`
   is its final table; its scores are `typical.scores`.

   `tiePenalty` is what that costs in log odds (ln 2 by default; 0 takes the single
   likeliest run of results even when it ends level on points).

   Fewer than `minHits` runs (or all of them) is `enough: false`: nothing to say. */
function scenarioAnalysis(spec, club, place, run, { minHits = 25, tiePenalty = Math.LN2 } = {}) {
  const { scores, places, sims, count, F } = run;
  const fixtures = spec.fixtures;
  const own = [];
  for (let f = 0; f < F; f += 1) if (fixtures[f].home === club || fixtures[f].away === club) own.push(f);
  const all = new Int32Array(F * 3);
  const hitN = new Int32Array(F * 3);
  const exact = new Int32Array(F * 256);
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
  // The score shown for each result: the commonest among the runs that end this way.
  const modalScore = new Uint8Array(F * 3);
  const modalCount = new Int32Array(F * 3).fill(-1);
  for (let f = 0; f < F; f += 1) {
    for (let sc = 0; sc < 256; sc += 1) {
      const k = f * 3 + SCORE_OUTCOME[sc];
      if (exact[f * 256 + sc] > modalCount[k]) { modalCount[k] = exact[f * 256 + sc]; modalScore[k] = sc; }
    }
  }
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
  // How good a season is for this finish: its log odds, less a toss-up's cost; null if the club is elsewhere.
  const judge = (sc) => {
    const order = standing(sc);
    if (order[place] !== club) return null;
    const level = [order[place - 1], order[place + 1]].some((c) => c != null && pts[c] === pts[club]);
    let odds = 0;
    for (let f = 0; f < F; f += 1) odds += logOdds(f, SCORE_OUTCOME[sc[f]]);
    return odds - (level ? tiePenalty : 0);
  };
  const improve = (start) => {
    const sc = start.slice();
    let now = judge(sc);
    for (let round = 0; round < 80; round += 1) {
      let move = null;
      const consider = (next, change) => {
        const value = judge(next);
        if (value != null && value > (move ? move.value : now) + 1e-9) move = { ...change, value };
      };
      for (let f = 0; f < F; f += 1) {
        const o = SCORE_OUTCOME[sc[f]];
        for (let to = 0; to < 3; to += 1) {
          if (to === o || logOdds(f, to) - logOdds(f, o) + tiePenalty <= 1e-9) continue;
          const next = sc.slice(); next[f] = modalScore[f * 3 + to];
          consider(next, { f, to: modalScore[f * 3 + to] });
        }
      }
      // No single swap helps: a swap that costs, repaired by one that gains.
      for (let f = 0; f < F && !move; f += 1) {
        const o = SCORE_OUTCOME[sc[f]];
        for (let to = 0; to < 3; to += 1) {
          if (to === o) continue;
          const first = sc.slice(); first[f] = modalScore[f * 3 + to];
          const cost = logOdds(f, to) - logOdds(f, o);
          for (let g = 0; g < F; g += 1) {
            if (g === f) continue;
            const og = SCORE_OUTCOME[first[g]];
            for (let back = 0; back < 3; back += 1) {
              if (back === og || cost + logOdds(g, back) - logOdds(g, og) + tiePenalty <= 1e-9) continue;
              const next = first.slice(); next[g] = modalScore[g * 3 + back];
              consider(next, { f, to: modalScore[f * 3 + to], g, back: modalScore[g * 3 + back] });
            }
          }
        }
      }
      if (!move) break;
      sc[move.f] = move.to;
      if (move.g != null) sc[move.g] = move.back;
      now = move.value;
    }
    return { sc, value: now };
  };
  // The best few recorded runs that end this way, by the odds of their results.
  const starts = [];
  for (let r = 0; r < sims; r += 1) {
    if (!hit[r]) continue;
    let odds = 0;
    for (let f = 0; f < F; f += 1) odds += logOdds(f, SCORE_OUTCOME[scores[r * F + f]]);
    if (starts.length < 4 || odds > starts[starts.length - 1].odds) {
      starts.push({ r, odds });
      starts.sort((x, y) => y.odds - x.odds);
      if (starts.length > 4) starts.pop();
    }
  }
  let chosen = null;
  for (const { r } of starts) {
    const found = improve(Array.from({ length: F }, (_, f) => scores[r * F + f]));
    if (found.value != null && (!chosen || found.value > chosen.value)) chosen = found;
  }
  // Scores the recorded run left (a 5–0 where 1–0 would do) go back to the commonest score of
  // their result wherever the finish holds, so the season reads like a normal one; goal
  // difference only stays as the run had it where the finish hangs on it.
  let valueNow = chosen.value;
  for (let f = 0; f < F; f += 1) {
    const common = modalScore[f * 3 + SCORE_OUTCOME[chosen.sc[f]]];
    if (common === chosen.sc[f]) continue;
    const next = chosen.sc.slice();
    next[f] = common;
    const value = judge(next);
    if (value != null && value >= valueNow - 1e-9) { chosen.sc = next; valueNow = value; }
  }
  const typical = { scores: [], table: [] };
  const order = standing(chosen.sc);
  for (let f = 0; f < F; f += 1) typical.scores.push([chosen.sc[f] >> 4, chosen.sc[f] & 15]);
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
