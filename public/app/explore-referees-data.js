/* Pure referee & club-discipline aggregation helpers (loaded before /app/explore-referees.js). */

function refereeMinFilter(rows, minMatches) {
  return minMatches > 0 ? (rows || []).filter((r) => r.matches >= minMatches) : (rows || []);
}

/* How far a side's performance drifts from zero by luck alone: its spread
   over every team-match in the selection.
   Walk-forward, no referee-club pairing beats this (PROJECT_STATUS.md,
   "Referee tracker"), so the charts shade the 95 % range it allows. */
function refereeChanceSd(rows) {
  let n = 0, sum = 0, sq = 0;
  for (const r of rows || []) {
    for (const d of [r.home_perf, r.away_perf]) { n += 1; sum += d; sq += d * d; }
  }
  return n > 1 ? Math.sqrt(Math.max(0, (sq - (sum * sum) / n) / (n - 1))) : 0;
}

/* Half-width of that 95 % range over `matches` matches, per match or summed. */
function refereeChanceBand(sd, matches, metric) {
  if (!sd || !matches) return 0;
  return 1.96 * sd * (metric === 'perMatch' ? 1 / Math.sqrt(matches) : Math.sqrt(matches));
}

/* A club's performance per match with every referee: the
   level its referee bars are read against (clubs beat or trail the model
   for reasons of their own, and that carries over between seasons). */
function refereeClubBaseline(rows, teamId) {
  let matches = 0, diff = 0;
  for (const row of teamRefereeRows(rows, teamId)) { matches += row.matches; diff += row.diff; }
  return matches ? diff / matches : null;
}

function expandReferees(data) {
  const leagues = data?.leagues || ['eliteserien', 'obosligaen'];
  const refs = data?.referees || [];
  const teams = data?.teams || {};
  const label = (id) => {
    const raw = teams[id] || String(id);
    return typeof shortName === 'function' ? shortName(raw) : raw;
  };
  return (data?.matches || []).map((row) => ({
    match_id: row[0],
    date: row[1],
    season: row[2],
    league: leagues[row[3]] || 'eliteserien',
    referee: refs[row[4]] || 'Unknown',
    home_id: row[5],
    away_id: row[6],
    home: label(row[5]),
    away: label(row[6]),
    home_goals: row[7],
    away_goals: row[8],
    home_xpts: row[9],
    away_xpts: row[10],
    home_yellow: row[11] || 0,
    away_yellow: row[12] || 0,
    home_red: row[13] || 0,
    away_red: row[14] || 0,
    home_fouls: row[15] ?? null,
    away_fouls: row[16] ?? null,
    // Rating change against what the model expected before kickoff (home
    // side; the away side's is the negative): the referee view's measure.
    home_change: row[17] ?? 0,
    home_expected: row[18] ?? 0,
    home_perf: (row[17] ?? 0) - (row[18] ?? 0),
    away_perf: (row[18] ?? 0) - (row[17] ?? 0),
    home_xg: row[19] ?? null,
    away_xg: row[20] ?? null,
  }));
}

function refereeFilter(rows, { league, season, asof } = {}) {
  return (rows || []).filter((r) => {
    if (league && r.league !== league) return false;
    if (season && season !== 'all' && r.season !== Number(season)) return false;
    if (asof && r.date > asof) return false;
    return true;
  });
}

function refereeOverview(rows) {
  const byRef = new Map();
  for (const r of rows || []) {
    const cur = byRef.get(r.referee) || {
      referee: r.referee,
      matches: 0,
      seasonMin: r.season,
      seasonMax: r.season,
      homeWins: 0,
      draws: 0,
      awayWins: 0,
      homePts: 0,
      homeXpts: 0,
      goals: 0,
      yellows: 0,
      reds: 0,
      homeCards: 0,
      awayCards: 0,
      fouls: 0,
      homeFouls: 0,
      awayFouls: 0,
      foulsMatches: 0,
      cardsWithFouls: 0,
    };
    cur.matches += 1;
    if (r.season < cur.seasonMin) cur.seasonMin = r.season;
    if (r.season > cur.seasonMax) cur.seasonMax = r.season;
    cur.goals += (r.home_goals || 0) + (r.away_goals || 0);
    if (r.home_goals > r.away_goals) { cur.homeWins += 1; cur.homePts += 3; }
    else if (r.home_goals === r.away_goals) { cur.draws += 1; cur.homePts += 1; }
    else { cur.awayWins += 1; }
    cur.homeXpts += r.home_xpts;
    const matchYellows = r.home_yellow + r.away_yellow;
    const matchReds = r.home_red + r.away_red;
    cur.yellows += matchYellows;
    cur.reds += matchReds;
    cur.homeCards += r.home_yellow + r.home_red;
    cur.awayCards += r.away_yellow + r.away_red;
    if (r.home_fouls != null && r.away_fouls != null) {
      cur.fouls += r.home_fouls + r.away_fouls;
      cur.homeFouls += r.home_fouls;
      cur.awayFouls += r.away_fouls;
      cur.foulsMatches += 1;
      cur.cardsWithFouls += matchYellows + matchReds;
    }
    byRef.set(r.referee, cur);
  }
  return [...byRef.values()]
    .map((row) => {
      const cards = row.yellows + row.reds;
      const homeBias = row.homePts - row.homeXpts;
      return {
        ...row,
        cards,
        homeBias,
        homeBiasPerMatch: row.matches ? homeBias / row.matches : 0,
        goalsPerMatch: row.matches ? row.goals / row.matches : 0,
        homeCardsPerMatch: row.matches ? row.homeCards / row.matches : 0,
        awayCardsPerMatch: row.matches ? row.awayCards / row.matches : 0,
        awayHomeCardGap: row.matches ? (row.awayCards - row.homeCards) / row.matches : 0,
        redsPerMatch: row.matches ? row.reds / row.matches : 0,
        cardsPerMatch: row.matches ? cards / row.matches : 0,
        foulsPerMatch: row.foulsMatches ? row.fouls / row.foulsMatches : null,
        homeFoulsPerMatch: row.foulsMatches ? row.homeFouls / row.foulsMatches : null,
        awayFoulsPerMatch: row.foulsMatches ? row.awayFouls / row.foulsMatches : null,
        foulsPerCard: row.foulsMatches && row.cardsWithFouls > 0 ? row.fouls / row.cardsWithFouls : null,
      };
    })
    .sort((a, b) => b.matches - a.matches || a.referee.localeCompare(b.referee));
}

function refereePairings(rows, minMatches = 10) {
  const byPair = new Map();
  for (const r of rows || []) {
    const sides = [
      [r.home_id, r.home, r.home_goals, r.away_goals, r.home_perf],
      [r.away_id, r.away, r.away_goals, r.home_goals, r.away_perf],
    ];
    for (const [id, team, gf, ga, perf] of sides) {
      const key = `${r.referee}\t${id}`;
      const cur = byPair.get(key) || {
        referee: r.referee,
        team_id: id,
        team,
        matches: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        points: 0,
        perf: 0,
      };
      cur.matches += 1;
      if (gf > ga) { cur.wins += 1; cur.points += 3; }
      else if (gf === ga) { cur.draws += 1; cur.points += 1; }
      else { cur.losses += 1; }
      cur.perf += perf;
      byPair.set(key, cur);
    }
  }
  return [...byPair.values()]
    .filter((row) => row.matches >= minMatches)
    .map((row) => {
      return { ...row, diff: row.perf, perMatch: row.matches ? row.perf / row.matches : 0 };
    })
    .sort((a, b) => b.perMatch - a.perMatch || b.diff - a.diff);
}

function clubDisciplineRows(rows) {
  const byClub = new Map();
  for (const r of rows || []) {
    const sides = [
      [r.home_id, r.home, true, r.home_yellow, r.away_yellow, r.home_red, r.away_red, r.home_fouls, r.away_fouls],
      [r.away_id, r.away, false, r.away_yellow, r.home_yellow, r.away_red, r.home_red, r.away_fouls, r.home_fouls],
    ];
    for (const [id, team, isHome, yf, ya, rf, ra, ff, fa] of sides) {
      const cur = byClub.get(id) || {
        team_id: id,
        team,
        matches: 0,
        homeMatches: 0,
        awayMatches: 0,
        homeCardsFor: 0,
        awayCardsFor: 0,
        yellowsFor: 0,
        yellowsAgainst: 0,
        redsFor: 0,
        redsAgainst: 0,
        cardsForWithFouls: 0,
        foulsFor: 0,
        foulsAgainst: 0,
        foulsMatches: 0,
      };
      cur.matches += 1;
      if (isHome) { cur.homeMatches += 1; cur.homeCardsFor += yf + rf; }
      else { cur.awayMatches += 1; cur.awayCardsFor += yf + rf; }
      cur.yellowsFor += yf;
      cur.yellowsAgainst += ya;
      cur.redsFor += rf;
      cur.redsAgainst += ra;
      if (ff != null && fa != null) {
        cur.foulsFor += ff;
        cur.foulsAgainst += fa;
        cur.foulsMatches += 1;
        cur.cardsForWithFouls += yf + rf;
      }
      byClub.set(id, cur);
    }
  }
  return [...byClub.values()]
    .map((row) => {
      const cardsFor = row.yellowsFor + row.redsFor;
      const cardsAgainst = row.yellowsAgainst + row.redsAgainst;
      const cardsForPerMatch = row.matches ? cardsFor / row.matches : 0;
      const cardsAgainstPerMatch = row.matches ? cardsAgainst / row.matches : 0;
      const foulsForPerMatch = row.foulsMatches ? row.foulsFor / row.foulsMatches : null;
      const foulsAgainstPerMatch = row.foulsMatches ? row.foulsAgainst / row.foulsMatches : null;
      return {
        ...row,
        cardsFor,
        cardsAgainst,
        cardsForPerMatch,
        cardsAgainstPerMatch,
        homeCardsPerMatch: row.homeMatches ? row.homeCardsFor / row.homeMatches : null,
        awayCardsPerMatch: row.awayMatches ? row.awayCardsFor / row.awayMatches : null,
        netCardsPerMatch: cardsAgainstPerMatch - cardsForPerMatch,
        netReds: row.redsAgainst - row.redsFor,
        totalCardsPerMatch: cardsForPerMatch + cardsAgainstPerMatch,
        foulsForPerMatch,
        foulsAgainstPerMatch,
        netFoulsPerMatch: row.foulsMatches ? (row.foulsAgainst - row.foulsFor) / row.foulsMatches : null,
        foulsPerCard: row.foulsMatches && row.cardsForWithFouls > 0 ? row.foulsFor / row.cardsForWithFouls : null,
      };
    })
    .sort((a, b) => b.netCardsPerMatch - a.netCardsPerMatch || a.team.localeCompare(b.team));
}

function seasonDisciplineRows(rows) {
  const bySeason = new Map();
  for (const r of rows || []) {
    const cur = bySeason.get(r.season) || {
      season: r.season,
      matches: 0,
      matchesWithRed: 0,
      yellows: 0,
      reds: 0,
      homeCards: 0,
      awayCards: 0,
      fouls: 0,
      foulsMatches: 0,
      cardsWithFouls: 0,
    };
    cur.matches += 1;
    const my = r.home_yellow + r.away_yellow;
    const mr = r.home_red + r.away_red;
    if (mr > 0) cur.matchesWithRed += 1;
    cur.yellows += my;
    cur.reds += mr;
    cur.homeCards += r.home_yellow + r.home_red;
    cur.awayCards += r.away_yellow + r.away_red;
    if (r.home_fouls != null && r.away_fouls != null) {
      cur.fouls += r.home_fouls + r.away_fouls;
      cur.foulsMatches += 1;
      cur.cardsWithFouls += my + mr;
    }
    bySeason.set(r.season, cur);
  }
  return [...bySeason.values()]
    .sort((a, b) => a.season - b.season)
    .map((row) => ({
      season: row.season,
      matches: row.matches,
      yellowsPerMatch: row.matches ? row.yellows / row.matches : 0,
      redsPerMatch: row.matches ? row.reds / row.matches : 0,
      redMatchPct: row.matches ? (100 * row.matchesWithRed) / row.matches : 0,
      cardsPerMatch: row.matches ? (row.yellows + row.reds) / row.matches : 0,
      foulsPerMatch: row.foulsMatches ? row.fouls / row.foulsMatches : null,
      foulsPerCard: row.foulsMatches && row.cardsWithFouls > 0 ? row.fouls / row.cardsWithFouls : null,
      awayHomeCardGap: row.matches ? (row.awayCards - row.homeCards) / row.matches : 0,
    }));
}

function refereeTeamRows(rows, referee) {
  const byTeam = new Map();
  for (const r of rows || []) {
    if (r.referee !== referee) continue;
    const sides = [
      [r.home_id, r.home, r.home_goals, r.away_goals, r.home_perf, r.home_yellow, r.away_yellow, r.home_red, r.away_red, r.home_fouls, r.away_fouls],
      [r.away_id, r.away, r.away_goals, r.home_goals, r.away_perf, r.away_yellow, r.home_yellow, r.away_red, r.home_red, r.away_fouls, r.home_fouls],
    ];
    for (const [id, team, gf, ga, perf, yf, ya, rf, ra, ff, fa] of sides) {
      const cur = byTeam.get(id) || {
        team_id: id,
        team,
        matches: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        points: 0,
        perf: 0,
        yellowsFor: 0,
        yellowsAgainst: 0,
        redsFor: 0,
        redsAgainst: 0,
        foulsFor: 0,
        foulsAgainst: 0,
        foulsMatches: 0,
      };
      cur.matches += 1;
      if (gf > ga) { cur.wins += 1; cur.points += 3; }
      else if (gf === ga) { cur.draws += 1; cur.points += 1; }
      else { cur.losses += 1; }
      cur.perf += perf;
      cur.yellowsFor += yf;
      cur.yellowsAgainst += ya;
      cur.redsFor += rf;
      cur.redsAgainst += ra;
      if (ff != null && fa != null) {
        cur.foulsFor += ff;
        cur.foulsAgainst += fa;
        cur.foulsMatches += 1;
      }
      byTeam.set(id, cur);
    }
  }
  return [...byTeam.values()]
    .map((row) => ({ ...row, diff: row.perf, perMatch: row.matches ? row.perf / row.matches : 0 }))
    .sort((a, b) => b.diff - a.diff || a.team.localeCompare(b.team));
}

function teamRefereeRows(rows, teamId) {
  const target = String(teamId);
  const byRef = new Map();
  for (const r of rows || []) {
    const isHome = String(r.home_id) === target;
    const isAway = String(r.away_id) === target;
    if (!isHome && !isAway) continue;
    const [gf, ga, perf, yf, ya, rf, ra, ff, fa] = isHome
      ? [r.home_goals, r.away_goals, r.home_perf, r.home_yellow, r.away_yellow, r.home_red, r.away_red, r.home_fouls, r.away_fouls]
      : [r.away_goals, r.home_goals, r.away_perf, r.away_yellow, r.home_yellow, r.away_red, r.home_red, r.away_fouls, r.home_fouls];
    const cur = byRef.get(r.referee) || {
      referee: r.referee,
      matches: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      points: 0,
      perf: 0,
      yellowsFor: 0,
      yellowsAgainst: 0,
      redsFor: 0,
      redsAgainst: 0,
      foulsFor: 0,
      foulsAgainst: 0,
      foulsMatches: 0,
    };
    cur.matches += 1;
    if (gf > ga) { cur.wins += 1; cur.points += 3; }
    else if (gf === ga) { cur.draws += 1; cur.points += 1; }
    else { cur.losses += 1; }
    cur.perf += perf;
    cur.yellowsFor += yf;
    cur.yellowsAgainst += ya;
    cur.redsFor += rf;
    cur.redsAgainst += ra;
    if (ff != null && fa != null) {
      cur.foulsFor += ff;
      cur.foulsAgainst += fa;
      cur.foulsMatches += 1;
    }
    byRef.set(r.referee, cur);
  }
  return [...byRef.values()]
    .map((row) => ({ ...row, diff: row.perf, perMatch: row.matches ? row.perf / row.matches : 0 }))
    .sort((a, b) => b.diff - a.diff || a.referee.localeCompare(b.referee));
}

function refereePairingMatches(rows, referee, teamId) {
  const target = String(teamId);
  const out = [];
  for (const r of rows || []) {
    if (r.referee !== referee) continue;
    const isHome = String(r.home_id) === target;
    const isAway = String(r.away_id) === target;
    if (!isHome && !isAway) continue;
    const sign = isHome ? 1 : -1;
    const [gf, ga, xgf, xga, yf, rf, ya, ra, ff, fa, oppId, oppName, teamName] = isHome
      ? [r.home_goals, r.away_goals, r.home_xg, r.away_xg, r.home_yellow, r.home_red, r.away_yellow, r.away_red, r.home_fouls, r.away_fouls, r.away_id, r.away, r.home]
      : [r.away_goals, r.home_goals, r.away_xg, r.home_xg, r.away_yellow, r.away_red, r.home_yellow, r.home_red, r.away_fouls, r.home_fouls, r.home_id, r.home, r.away];
    const pts = gf > ga ? 3 : (gf === ga ? 1 : 0);
    out.push({
      match_id: r.match_id,
      date: r.date,
      season: r.season,
      isHome,
      team_id: target,
      team: teamName,
      opponent_id: oppId,
      opponent: oppName,
      gf,
      ga,
      pts,
      xgf,
      xga,
      change: sign * r.home_change,
      expected: sign * r.home_expected,
      diff: sign * (r.home_change - r.home_expected),
      yf,
      rf,
      ya,
      ra,
      ff,
      fa,
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || String(b.match_id).localeCompare(String(a.match_id)));
}

function redCardImpact(rows) {
  let recN = 0, recPts = 0, recPerf = 0;
  let drwN = 0, drwPts = 0, drwPerf = 0;
  let redMatches = 0, totalReds = 0;
  const totalMatches = (rows || []).length;
  for (const r of rows || []) {
    const matchReds = (r.home_red || 0) + (r.away_red || 0);
    if (matchReds > 0) redMatches += 1;
    totalReds += matchReds;
    const hp = r.home_goals > r.away_goals ? 3 : (r.home_goals === r.away_goals ? 1 : 0);
    const ap = r.away_goals > r.home_goals ? 3 : (r.away_goals === r.home_goals ? 1 : 0);
    for (const [pts, perf, rf, ra] of [[hp, r.home_perf, r.home_red, r.away_red], [ap, r.away_perf, r.away_red, r.home_red]]) {
      if (rf > 0 && ra === 0) { recN += 1; recPts += pts; recPerf += perf; }
      else if (ra > 0 && rf === 0) { drwN += 1; drwPts += pts; drwPerf += perf; }
    }
  }
  return {
    totalMatches,
    totalReds,
    redMatchPct: totalMatches ? (100 * redMatches) / totalMatches : 0,
    received: {
      n: recN,
      ptsPerMatch: recN ? recPts / recN : null,
      diffPerMatch: recN ? recPerf / recN : null,
    },
    drawn: {
      n: drwN,
      ptsPerMatch: drwN ? drwPts / drwN : null,
      diffPerMatch: drwN ? drwPerf / drwN : null,
    },
  };
}

function varEraComparison(rows) {
  const agg = (subset) => {
    const n = subset.length;
    let cards = 0, reds = 0, redM = 0, fouls = 0, foulsM = 0;
    for (const r of subset) {
      const mr = (r.home_red || 0) + (r.away_red || 0);
      cards += (r.home_yellow || 0) + (r.away_yellow || 0) + mr;
      reds += mr;
      if (mr > 0) redM += 1;
      if (r.home_fouls != null && r.away_fouls != null) { fouls += r.home_fouls + r.away_fouls; foulsM += 1; }
    }
    return {
      n,
      cardsPerMatch: n ? cards / n : 0,
      redsPerMatch: n ? reds / n : 0,
      redMatchPct: n ? (100 * redM) / n : 0,
      foulsPerMatch: foulsM ? fouls / foulsM : null,
    };
  };
  const pre = (rows || []).filter((r) => r.season < 2023);
  const varR = (rows || []).filter((r) => r.season >= 2023);
  if (pre.length < 10 || varR.length < 10) return null;
  const preVar = agg(pre);
  const varEra = agg(varR);
  const redLiftPct = preVar.redsPerMatch > 0 ? ((varEra.redsPerMatch - preVar.redsPerMatch) / preVar.redsPerMatch) * 100 : null;
  return { preVar, varEra, redLiftPct };
}

function feistiestMatches(rows, limit = 5) {
  return [...(rows || [])]
    .map((r) => {
      const yellows = (r.home_yellow || 0) + (r.away_yellow || 0);
      const reds = (r.home_red || 0) + (r.away_red || 0);
      const fouls = r.home_fouls != null && r.away_fouls != null ? r.home_fouls + r.away_fouls : null;
      return { ...r, yellows, reds, totalCards: yellows + reds, totalFouls: fouls };
    })
    .sort((a, b) => b.totalCards - a.totalCards
      || b.reds - a.reds
      || (b.totalFouls ?? -1) - (a.totalFouls ?? -1)
      || b.date.localeCompare(a.date))
    .slice(0, limit);
}

function refereeScatterLabels(rows) {
  const byLast = new Map();
  for (const r of rows) {
    const parts = r.referee.trim().split(/\s+/);
    const last = parts[parts.length - 1];
    byLast.set(last, (byLast.get(last) || 0) + 1);
  }
  return new Map(rows.map((r) => {
    const parts = r.referee.trim().split(/\s+/);
    const last = parts[parts.length - 1];
    if ((byLast.get(last) || 0) <= 1 || parts.length === 1) return [r.referee, last];
    const initials = parts.slice(0, -1).map((p) => `${p[0]}.`).join(' ');
    return [r.referee, `${initials} ${last}`];
  }));
}

if (typeof module !== 'undefined') {
  module.exports = {
    refereeMinFilter, refereeChanceSd, refereeChanceBand, refereeClubBaseline,
    expandReferees, refereeFilter, refereeOverview, refereePairings,
    clubDisciplineRows, seasonDisciplineRows, refereeTeamRows, teamRefereeRows,
    refereePairingMatches, redCardImpact, varEraComparison, feistiestMatches,
    refereeScatterLabels,
  };
}
