/* ---------- internationalisation --------------------------------------- */

const translations = {
  en: {
    // Tabs
    'tab.grid': 'Finish Grid',
    'tab.table': 'Table',
    'tab.ladder': 'Ladder',
    'tab.next': 'Next Up',
    'tab.played': 'Played Results',
    'tab.shape': 'Season Shape',
    'tab.compare': 'Compare Clubs',
    'tab.model': 'Model Card',

    // Mobile bar
    'mob.grid': 'Grid',
    'mob.table': 'Table',
    'mob.ladder': 'Ladder',
    'mob.next': 'Next up',
    'mob.results': 'Results',
    'mob.shape': 'Shape',
    'mob.compare': 'Compare',
    'mob.model': 'Model',
    'mob.more': 'More',

    // Hero
    'hero.title': 'Where everyone finishes',
    'hero.played': 'Played',
    'hero.remaining': 'Remaining',
    'hero.simulated': 'Seasons simulated',
    'hero.model': 'Model',
    'hero.ratingsFrom': 'Ratings from',
    'hero.onward': 'onward',

    // Timeline
    'timeline.rewind': 'Rewind the season',
    'timeline.live': 'Live — everything played so far',
    'timeline.backToLive': 'Back to live',
    'timeline.note': 'Everything below is rebuilt from only the results known on the day you pick.',
    'timeline.matchdays': '{n} matchdays',
    'timeline.animating': 'Animating — as of {when}',
    'timeline.liveCount': 'Live — {n} matches played',
    'timeline.asOf': 'As of {when} — {n} of {total} played',
    'timeline.paused': 'Paused — as of {when}',
    'timeline.scrubLive': 'Live — latest results',
    'timeline.scrubAsOf': 'As of {when}',

    // Finish grid
    'grid.title': 'The finish grid',
    'grid.desc': 'Each team\'s probability of finishing in every position, ranked by most likely outcome.',
    'grid.anim': 'Animate the season',
    'grid.legend.label': 'Probability',
    'grid.legend.unlikely': 'unlikely',
    'grid.legend.likely': 'likely',
    'grid.legend.hint': 'Hover for decimal figure.',

    // Table
    'table.title': 'Table',
    'table.desc': 'Pick any club for its focus page.',
    'table.col.position': '#',
    'table.col.club': 'Club',
    'table.col.played': 'P',
    'table.col.wins': 'W',
    'table.col.draws': 'D',
    'table.col.losses': 'L',
    'table.col.gf': 'GF',
    'table.col.ga': 'GA',
    'table.col.gd': 'GD',
    'table.col.pts': 'Pts',
    'table.col.rating': 'Rating',
    'table.col.ratingShort': 'Elo',
    'table.col.xpts': 'xPts',
    'table.col.form': 'Form',
    'table.col.champion': 'Champion',
    'table.col.championShort': 'Title',
    'table.col.relegation': 'Relegation',
    'table.col.relegationShort': 'Rel',
    'table.col.promotion': 'Promotion',
    'table.col.promotionShort': 'Up',

    // Ladder
    'ladder.title': 'The ladder',
    'ladder.desc': 'All teams in both divisions compared on one rating scale.',
    'ladder.anim': 'Animate the season',
    'ladder.legend.es': 'Eliteserien',
    'ladder.legend.obos': 'OBOS-ligaen',

    // Fixtures / Next Up
    'next.title': 'Next up',
    'next.desc': 'The model\'s three-way odds for the coming fixtures, with the most likely scorelines beneath each.',
    'next.draw': 'Draw',
    'next.result': 'Result',
    'next.homeWin': 'Home win',
    'next.awayWin': 'Away win',
    'next.count': 'next {n} of {total}',

    // Played results
    'played.title': 'Played results',
    'played.desc': 'Recently played matches with scores and rating changes.',
    'played.empty': 'No played matches yet.',
    'played.prev': '← Prev',
    'played.next': 'Next →',
    'played.week': 'Week {n}',

    // Compare clubs
    'compare.title': 'Compare clubs',
    'compare.desc': 'Predictions for a fictional match between any two clubs. Compare each team\'s rating history.',
    'compare.home': 'Home',
    'compare.away': 'Away',
    'compare.hint': 'Click to change',
    'compare.swap': 'Swap the two clubs',
    'compare.match': 'Fictional match',
    'compare.note': '{team} host this fixture · home advantage is included.',
    'compare.scorelines': 'Most likely scorelines',
    'compare.ratingHistory': 'Rating history',
    'compare.season': 'Season',
    'compare.rating': 'ELO rating',

    // Model card
    'model.title': 'Model card',
    'model.desc': 'Every number above comes from these settings and this data.',
    'model.howItWorks': 'How it works',
    'model.how1': 'Each club carries one ELO rating. After every match, the winner gains points and the loser loses them — more if the result was unexpected. The gap between two clubs\' ratings decides the win/draw/loss probabilities.',
    'model.how2': 'Cross-season regression pulls every rating 12 % toward the division average during the off-season. This prevents one strong or weak year from carrying over unchanged, while still letting form carry momentum.',
    'model.how3': 'Simulations replay the remaining fixtures thousands of times. Each simulated match first picks an outcome (win, draw, or loss) from the pre-match probabilities, then draws a scoreline from real results conditioned on that outcome and the rating gap.',
    'model.how4': 'Two OBOS-ligaen clubs were promoted from the third tier, which is outside this project\'s data. They start at the bottom of the ladder and are corrected only by results.',
    'model.version': 'Version',
    'model.kfactor': 'K-factor',
    'model.homeAdvantage': 'Home advantage',
    'model.pts': 'pts',
    'model.crossRegression': 'Cross-season regression',
    'model.towardMean': 'toward mean',
    'model.peakDraw': 'Peak draw rate',
    'model.simulations': 'Simulations',
    'model.seed': 'Random seed',

    // Team focus
    'team.unknown': 'Unknown',
    'team.position': 'Position',
    'team.points': 'Points',
    'team.gd': 'GD',
    'team.played': 'Played',
    'team.matches': 'Matches',
    'team.form': 'Form',
    'team.ratingHistory': 'Rating history',
    'team.peak': 'Peak',
    'team.worst': 'Worst',
    'team.finishProbs': 'Finish probabilities',
    'team.seasonBySeason': 'Season-by-season — {n}',
    'team.season': 'Season',
    'team.division': 'Division',
    'team.pos': 'Pos',
    'team.pl': 'Pl',
    'team.ptsShort': 'Pts',
    'team.ratingStart': 'Rating start',
    'team.ratingEnd': 'Rating end',
    'team.change': 'Change',
    'team.upcomingFixtures': 'Upcoming fixtures — {n}',
    'team.recentResults': 'Recent results — {n} played',
    'team.seasonShape': 'Season shape',
    'team.seasonShapeYear': '{year} season shape',
    'team.loadingShape': 'Loading {year} shape\u2026',
    'team.noShape': 'No shape data available.',
    'team.loadError': 'Could not load: {error}',

    // Season shape tooltip
    'shape.preseason': 'pre-season',
    'shape.matchesPlayed': '{n} of {total} matches played',
    'shape.rating': 'Rating {n}',
    'shape.mostLikely': 'Most likely {n}',
    'shape.topN': 'Top {n}: {pct}',
    'shape.bottomN': 'Bottom {n}: {pct}',

    // Rating trend
    'trend.strongRise': 'Strong rise (+{n})',
    'trend.rise': 'Rising (+{n})',
    'trend.steady': 'Steady (+/-{n})',
    'trend.fall': 'Falling ({n})',
    'trend.strongFall': 'Strong fall ({n})',

    // Band legend
    'band.champion': 'Champions League',
    'band.el': 'Europa League',
    'band.conf': 'Conference League',
    'band.relegation': 'Relegation',
  'season.shape.axis': 'Rating after every match played',

    // Footer
    'footer.text': 'EliteTracker — Eliteserien and OBOS-ligaen, seasons 2015\u20132026. Match data from FotMob. Built by <a href="mailto:tobias.samsonsen@gmail.com">Tobias Samsonsen</a>.',
  },

  no: {
    // Tabs
    'tab.grid': 'Slutttabell',
    'tab.table': 'Tabell',
    'tab.ladder': 'Stige',
    'tab.next': 'Neste runde',
    'tab.played': 'Spilte kamper',
    'tab.shape': 'Sesongform',
    'tab.compare': 'Sammenlign',
    'tab.model': 'Modellkort',

    // Mobile bar
    'mob.grid': 'Tabell',
    'mob.table': 'Tabell',
    'mob.ladder': 'Stige',
    'mob.next': 'Neste',
    'mob.results': 'Resultater',
    'mob.shape': 'Form',
    'mob.compare': 'Sammenlign',
    'mob.model': 'Modell',
    'mob.more': 'Mer',

    // Hero
    'hero.title': 'Hvem ender hvor',
    'hero.played': 'Spilt',
    'hero.remaining': 'Gjenværende',
    'hero.simulated': 'Simulerte sesonger',
    'hero.model': 'Modell',
    'hero.ratingsFrom': 'Ratinger fra',
    'hero.onward': 'og utover',

    // Timeline
    'timeline.rewind': 'Spol tilbake sesongen',
    'timeline.live': 'Direkte — alt spilt så langt',
    'timeline.backToLive': 'Tilbake til direkte',
    'timeline.note': 'Alt nedenfor bygges kun på resultatene som var kjent på den dagen du velger.',
    'timeline.matchdays': '{n} spillerunder',
    'timeline.animating': 'Animerer — per {when}',
    'timeline.liveCount': 'Direkte — {n} kamper spilt',
    'timeline.asOf': 'Per {when} — {n} av {total} spilt',
    'timeline.paused': 'Pause — per {when}',
    'timeline.scrubLive': 'Direkte — nyeste resultater',
    'timeline.scrubAsOf': 'Per {when}',

    // Finish grid
    'grid.title': 'Slutttabellen',
    'grid.desc': 'Hvert lags sannsynlighet for å ende på hver plass, rangert etter mest sannsynlig utfall.',
    'grid.anim': 'Animér sesongen',
    'grid.legend.label': 'Sannsynlighet',
    'grid.legend.unlikely': 'usannsynlig',
    'grid.legend.likely': 'sannsynlig',
    'grid.legend.hint': 'Hold over for desimaltall.',

    // Table
    'table.title': 'Tabell',
    'table.desc': 'Velg et lag for å se fokussiden.',
    'table.col.position': '#',
    'table.col.club': 'Lag',
    'table.col.played': 'K',
    'table.col.wins': 'S',
    'table.col.draws': 'U',
    'table.col.losses': 'T',
    'table.col.gf': 'SM',
    'table.col.ga': 'IM',
    'table.col.gd': 'MM',
    'table.col.pts': 'Po',
    'table.col.rating': 'Rating',
    'table.col.ratingShort': 'Elo',
    'table.col.xpts': 'xPo',
    'table.col.form': 'Form',
    'table.col.champion': 'Mester',
    'table.col.championShort': 'Titt',
    'table.col.relegation': 'Nedrykk',
    'table.col.relegationShort': 'Ned',
    'table.col.promotion': 'Opprykk',
    'table.col.promotionShort': 'Opp',

    // Ladder
    'ladder.title': 'Stigen',
    'ladder.desc': 'Alle lag i begge divisjonene sammenlignet på én ratingskala.',
    'ladder.anim': 'Animér sesongen',
    'ladder.legend.es': 'Eliteserien',
    'ladder.legend.obos': 'OBOS-ligaen',

    // Fixtures / Next Up
    'next.title': 'Neste runde',
    'next.desc': 'Modellens treveisodds for kommende kamper, med mest sannsynlige sluttresultater under hver.',
    'next.draw': 'Uavgjort',
    'next.result': 'Resultat',
    'next.homeWin': 'Hjemmeseier',
    'next.awayWin': 'Borteseier',
    'next.count': 'neste {n} av {total}',

    // Played results
    'played.title': 'Spilte kamper',
    'played.desc': 'Nylig spilte kamper med resultater og ratingendringer.',
    'played.empty': 'Ingen spilte kamper ennå.',
    'played.prev': '← Forrige',
    'played.next': 'Neste →',
    'played.week': 'Uke {n}',

    // Compare clubs
    'compare.title': 'Sammenlign klubber',
    'compare.desc': 'Spådommer for en fiktiv kamp mellom to klubber. Sammenlign hvert lags-rating over tid.',
    'compare.home': 'Hjemme',
    'compare.away': 'Borte',
    'compare.hint': 'Klikk for å endre',
    'compare.swap': 'Bytt de to klubbene',
    'compare.match': 'Fiktiv kamp',
    'compare.note': '{team} er vertskap · hjemmefordel er inkludert.',
    'compare.scorelines': 'Mest sannsynlige resultater',
    'compare.ratingHistory': 'Rating over tid',
    'compare.season': 'Sesong',
    'compare.rating': 'ELO-rating',

    // Model card
    'model.title': 'Modellkort',
    'model.desc': 'Hvert tall over kommer fra disse innstillingene og disse dataene.',
    'model.howItWorks': 'Slik fungerer det',
    'model.how1': 'Hvert lag har én ELO-rating. Etter hver kamp får vinneren poeng og taperen taper — mer hvis resultatet var overraskende. Avstanden mellom to lags ratinger avgjør sannsynligheten for seier, uavgjort og tap.',
    'model.how2': 'Kryssesongsregresjon drar hver rating 12 % mot divisjonsgjennomsnittet i pausen mellom sesonger. Dette forhindrer at ett sterkt eller svakt år videreføres uendret, samtidig som formen beholder momentum.',
    'model.how3': 'Simuleringer spiller gjennom de gjenværende kampene tusenvis av ganger. Hvert simulert kamp velger først et utfall (seier, uavgjort eller tap) fra førkampssannsynlighetene, og trekker deretter et sluttresultat fra ekte kamper betinget av utfallet og ratingforskjellen.',
    'model.how4': 'To OBOS-ligaen-klubber rykket opp fra tredje nivå, som er utenfor dette prosjekts data. De starter på bunnen av stigen og korrigeres kun av resultater.',
    'model.version': 'Versjon',
    'model.kfactor': 'K-faktor',
    'model.homeAdvantage': 'Hjemmefordel',
    'model.pts': 'po',
    'model.crossRegression': 'Kryssesongsregresjon',
    'model.towardMean': 'mot gjennomsnitt',
    'model.peakDraw': 'Topp uavgjort-rate',
    'model.simulations': 'Simuleringer',
    'model.seed': 'Tilfeldig frø',

    // Team focus
    'team.unknown': 'Ukjent',
    'team.position': 'Plassering',
    'team.points': 'Poeng',
    'team.gd': 'MM',
    'team.played': 'Spilt',
    'team.matches': 'Kamper',
    'team.form': 'Form',
    'team.ratingHistory': 'Rating over tid',
    'team.peak': 'Topp',
    'team.worst': 'Bunn',
    'team.finishProbs': 'Sluttssannsynligheter',
    'team.seasonBySeason': 'Sesong for sesong — {n}',
    'team.season': 'Sesong',
    'team.division': 'Divisjon',
    'team.pos': 'Plass',
    'team.pl': 'Sp',
    'team.ptsShort': 'Po',
    'team.ratingStart': 'Rating start',
    'team.ratingEnd': 'Rating slutt',
    'team.change': 'Endring',
    'team.upcomingFixtures': 'Kommende kamper — {n}',
    'team.recentResults': 'Nylige resultater — {n} spilt',
    'team.seasonShape': 'Sesongform',
    'team.seasonShapeYear': 'Sesongform {year}',
    'team.loadingShape': 'Laster {year}-form\u2026',
    'team.noShape': 'Ingen shapedata tilgjengelig.',
    'team.loadError': 'Kunne ikke laste: {error}',

    // Season shape tooltip
    'shape.preseason': 'før sesongen',
    'shape.matchesPlayed': '{n} av {total} kamper spilt',
    'shape.rating': 'Rating {n}',
    'shape.mostLikely': 'Mest sannsynlig {n}',
    'shape.topN': 'Topp {n}: {pct}',
    'shape.bottomN': 'Bunn {n}: {pct}',

    // Rating trend
    'trend.strongRise': 'Sterk oppgang (+{n})',
    'trend.rise': 'Stigende (+{n})',
    'trend.steady': 'Stabil (+/-{n})',
    'trend.fall': 'Fallende ({n})',
    'trend.strongFall': 'Sterk nedgang ({n})',

    // Band legend
    'band.champion': 'Champions League',
    'band.el': 'Europa League',
    'band.conf': 'Conference League',
    'band.relegation': 'Nedrykk',

    // Footer
    'footer.text': 'EliteTracker — Eliteserien og OBOS-ligaen, sesongene 2015\u20132026. Kampdata fra FotMob. Utviklet av <a href="mailto:tobias.samsonsen@gmail.com">Tobias Samsonsen</a>.',
  },
};

let currentLang = localStorage.getItem('lang') || 'no';

function t(key, params = {}) {
  const str = (translations[currentLang] && translations[currentLang][key])
    || translations.en[key]
    || key;
  return Object.keys(params).reduce((s, k) => s.replace(`{${k}}`, params[k]), str);
}

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem('lang', lang);
  document.documentElement.lang = lang;
  applyTranslations();
}

/* Walk every element with data-i18n and set its text content. */
function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    const key = node.getAttribute('data-i18n');
    node.textContent = t(key);
  });
  /* Footer contains an <a> — textContent would strip it. */
  const footer = document.getElementById('footer-text');
  if (footer) footer.innerHTML = t('footer.text');
}
