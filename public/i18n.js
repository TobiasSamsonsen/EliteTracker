/* ---------- internationalisation --------------------------------------- */

const translations = {
  en: {
    // Tabs
    'tab.grid': 'Finish Grid',
    'tab.table': 'Table',
    'tab.ladder': 'Ladder',
    'tab.next': 'Next Up',
    'tab.played': 'Played Results',
    'tab.compare': 'Compare Clubs',
    'tab.model': 'Model Card',

    // Mobile bar
    'mob.grid': 'Grid',
    'mob.table': 'Table',
    'mob.ladder': 'Ladder',
    'mob.next': 'Next up',
    'mob.results': 'Results',
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
    'hero.lede.finished': '{team} finished top on {points} points. All {matches} matches played; ratings shown are where each club ended the season.',
    'hero.lede.agrees': '{team} lead on {points} points and the model agrees: {pct} to finish top.',
    'hero.lede.disagrees': '{team} lead on {points} points, but the model makes {favourite} favourite at {pct}.',
    'hero.lede.remaining': '{lede} {remaining} matches left, each one played {simulations} times over.',

    // Theme
    'theme.light': 'Light',
    'theme.dark': 'Dark',

    // Season
    'season.label': 'Season',

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
    'grid.legend.label': 'Probability',
    'grid.legend.unlikely': 'unlikely',
    'grid.legend.likely': 'likely',
    'grid.legend.hint': 'Hover for decimal figure.',

    // Table
    'table.title': 'Table',
    'table.desc': 'Pick any club for its focus page.',
    'table.col.club': 'Club',
    'table.col.rating': 'Rating',
    'table.col.ratingShort': 'Elo',
    'table.col.form': 'Form',
    'table.col.champion': 'Champion',
    'table.col.championShort': 'Title',
    'table.col.relegation': 'Relegation',
    'table.col.relegationShort': 'Rel',

    // Ladder
    'ladder.title': 'The ladder',
    'ladder.desc': 'All teams in both divisions compared on one rating scale.',

    // Fixtures / Next Up
    'next.title': 'Next up',
    'next.desc': 'The model\'s three-way odds for the coming fixtures, with the most likely scorelines beneath each.',
    'next.draw': 'Draw',
    'next.result': 'Result',
    'next.homeWin': 'Home win',
    'next.awayWin': 'Away win',
    'next.count': 'next {n} of {total}',
    'next.showMore': 'Show {n} more',

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
    'model.how1': 'Each club carries one ELO rating. After every match, the winner gains points and the loser loses them — more if the result was unexpected, and less if xG shows the win was lucky. The gap between two clubs\' ratings gives one set of win/draw/loss odds; a second set comes from each club\'s attack and defence ratings, which move on expected goals (xG) where FotMob has them. The odds shown blend 25 % Elo with 75 % attack/defence.',
    'model.how2': 'Cross-season regression pulls every rating 12 % toward the division average during the off-season. This prevents one strong or weak year from carrying over unchanged, while still letting form carry momentum.',
    'model.how3': 'Simulations replay the remaining fixtures thousands of times. Each simulated match first picks an outcome (win, draw, or loss) from the pre-match probabilities, then draws a scoreline from the two clubs\' attack and defence ratings — the goals each side is expected to score and concede.',
    'model.how4': 'Two OBOS-ligaen clubs were promoted from the third tier, which is outside this project\'s data. They start at the bottom of the ladder and are corrected only by results.',
    'model.version': 'Version',
    'model.kfactor': 'K-factor',
    'model.homeAdvantage': 'Home advantage',
    'model.xgAlpha': 'xG weight',
    'model.pts': 'pts',
    'model.crossRegression': 'Cross-season regression',
    'model.towardMean': 'toward mean',
    'model.peakDraw': 'Peak draw rate',
    'model.outcomeOdds': 'Outcome odds',
    'model.outcomeOddsValue': 'Elo × attack/defence, 25/75',
    'model.scorelines': 'Scorelines',
    'model.scorelinesValue': 'attack/defence goals model',
    'model.simulations': 'Simulations',
    'model.seed': 'Random seed',

    // Team focus
    'team.position': 'Position',
    'team.points': 'Points',
    'team.gd': 'GD',
    'team.played': 'Played',
    'team.attack': 'Attack',
    'team.defence': 'Defence',
    'team.ratesHint': 'Expected goals for / against per match against an average side of the division',
    'team.matches': 'Matches',
    'team.form': 'Form',
    'team.prediction': 'Prediction',
    'team.predPreSeason': 'Pre-season',
    'team.predCurrent': 'Current',
    'team.ratingHistory': 'Rating history',
    'team.peak': 'Peak',
    'team.worst': 'Worst',
    'team.rankOf': '{rank} of {total}',
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
    'shape.now': 'now {pct}',
    'shape.seasonAxis': '{year} season',
    'shape.stackedArea': 'Stacked area chart: {team}\'s probability of each finishing position',

    // Chart
    'chart.rating': 'Rating {n}',
    'chart.ratingFrom': '{team} rating from {from} to {to}',
    'chart.ratingMoved': '{team}: rating moved from {from} to {to} across {seasons} seasons.',
    'chart.ratingHistoryFor': 'Rating history for {home} and {away}',

    // Form
    'form.tooltip': '{w}W {d}D {l}L',

    // Season select
    'season.live': '{season} (live)',

    // Status / errors
    'status.loading': 'Loading the season\u2026',
    'status.couldNotLoad': 'Could not load {season}: {error}',
    'status.couldNotLoadSeason': 'Could not load the season: {error}. Are the data files deployed?',
    'status.couldNotRewind': 'Could not rewind: {error}',

    // Table dynamic headers
    'table.champion': 'Champion',
    'table.championShort': 'Title',
    'table.championDesc': ', chance of winning the title',
    'table.promotion': 'Promotion',
    'table.promotionShort': 'Up',
    'table.promotionDesc': ', chance of promotion',
    'table.relegation': 'Relegation',

    // Rating trend
    'trend.strongRise': 'Strong rise (+{n})',
    'trend.rise': 'Rising (+{n})',
    'trend.steady': 'Steady (+/-{n})',
    'trend.fall': 'Falling ({n})',
    'trend.strongFall': 'Strong fall ({n})',

  'season.shape.axis': 'Rating after every match played',

    // Footer
    'footer.text': 'EliteTracker — Eliteserien and OBOS-ligaen, seasons 2015\u20132026. Match data from FotMob. Built by <a href="mailto:tobias.samsonsen@gmail.com">Tobias Samsonsen</a>.',

    // Aria / title attributes
    'aria.chooseDivision': 'Choose a division',
    'aria.colourTheme': 'Colour theme',
    'aria.language': 'Language',
    'aria.chooseView': 'Choose a view',
    'aria.moreViews': 'More views',
    'aria.matchdaySlider': 'Matchday to view the season as of',
    'aria.oneEarlier': 'One matchday earlier',
    'aria.oneLater': 'One matchday later',
    'aria.gridCaption': 'Probability that each team finishes in each position',
    'aria.odds': '{home} win {hw}, draw {d}, {away} win {aw}',
    'aria.scoreline': '{score} about {pct}',
    'title.animateSeason': 'Animate the season',
    'title.changeSpeed': 'Change speed',
  },

  no: {
    // Tabs
    'tab.grid': 'Sluttabell',
    'tab.table': 'Tabell',
    'tab.ladder': 'Stige',
    'tab.next': 'Neste runde',
    'tab.played': 'Spilte kamper',
    'tab.compare': 'Sammenlign',
    'tab.model': 'Modellkort',

    // Mobile bar
    'mob.grid': 'Prognose',
    'mob.table': 'Tabell',
    'mob.ladder': 'Stige',
    'mob.next': 'Neste',
    'mob.results': 'Resultater',
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
    'hero.lede.finished': '{team} vant med {points} poeng. Alle {matches} kamper spilt; ratingene viser hvor hvert lag endte sesongen.',
    'hero.lede.agrees': '{team} leder med {points} poeng og modellen er enig: {pct} sjanse for å ende på topp.',
    'hero.lede.disagrees': '{team} leder med {points} poeng, men modellen gjør {favourite} til favoritt med {pct}.',
    'hero.lede.remaining': '{lede} {remaining} kamper igjen, hver spilt {simulations} ganger.',

    // Theme
    'theme.light': 'Lys',
    'theme.dark': 'Mørk',

    // Season
    'season.label': 'Sesong',

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
    'grid.title': 'Sluttabellen',
    'grid.desc': 'Hvert lags sannsynlighet for å ende på hver plass, rangert etter mest sannsynlig utfall.',
    'grid.legend.label': 'Sannsynlighet',
    'grid.legend.unlikely': 'usannsynlig',
    'grid.legend.likely': 'sannsynlig',
    'grid.legend.hint': 'Hold over for desimaltall.',

    // Table
    'table.title': 'Tabell',
    'table.desc': 'Velg et lag for å se fokussiden.',
    'table.col.club': 'Lag',
    'table.col.rating': 'Rating',
    'table.col.ratingShort': 'Elo',
    'table.col.form': 'Form',
    'table.col.champion': 'Mester',
    'table.col.championShort': 'Titt',
    'table.col.relegation': 'Nedrykk',
    'table.col.relegationShort': 'Ned',

    // Ladder
    'ladder.title': 'Stigen',
    'ladder.desc': 'Alle lag i begge divisjonene sammenlignet på én ratingskala.',

    // Fixtures / Next Up
    'next.title': 'Neste runde',
    'next.desc': 'Modellens treveisodds for kommende kamper, med de mest sannsynlige sluttresultatene under hver.',
    'next.draw': 'Uavgjort',
    'next.result': 'Resultat',
    'next.homeWin': 'Hjemmeseier',
    'next.awayWin': 'Borteseier',
    'next.count': 'neste {n} av {total}',
    'next.showMore': 'Vis {n} til',

    // Played results
    'played.title': 'Spilte kamper',
    'played.desc': 'Nylig spilte kamper med resultater og ratingendringer.',
    'played.empty': 'Ingen spilte kamper ennå.',
    'played.prev': '← Forrige',
    'played.next': 'Neste →',
    'played.week': 'Uke {n}',

    // Compare clubs
    'compare.title': 'Sammenlign klubber',
    'compare.desc': 'Spådommer for en fiktiv kamp mellom to klubber. Sammenlign hvert lags rating over tid.',
    'compare.home': 'Hjemme',
    'compare.away': 'Borte',
    'compare.swap': 'Bytt de to klubbene',
    'compare.match': 'Fiktiv kamp',
    'compare.note': '{team} spiller hjemme · hjemmefordel er inkludert.',
    'compare.scorelines': 'Mest sannsynlige resultater',
    'compare.ratingHistory': 'Rating over tid',
    'compare.season': 'Sesong',
    'compare.rating': 'ELO-rating',

    // Model card
    'model.title': 'Modellkort',
    'model.desc': 'Hvert tall over kommer fra disse innstillingene og disse dataene.',
    'model.howItWorks': 'Slik fungerer det',
    'model.how1': 'Hvert lag har én ELO-rating. Etter hver kamp får vinneren poeng og taperen taper — mer hvis resultatet var overraskende, og mindre hvis xG viser at seieren var heldig. Avstanden mellom to lags ratinger gir ett sett odds for seier, uavgjort og tap; et annet sett kommer fra hvert lags angreps- og forsvarsrating, som oppdateres på forventede mål (xG) der FotMob har dem. Oddsene blander 25 % Elo med 75 % angrep/forsvar.',
    'model.how2': 'Kryssesongsregresjon drar hver rating 12 % mot divisjonsgjennomsnittet i pausen mellom sesonger. Dette forhindrer at ett sterkt eller svakt år videreføres uendret, samtidig som formen beholder momentum.',
    'model.how3': 'Simuleringer spiller gjennom de gjenværende kampene tusenvis av ganger. Hver simulert kamp velger først et utfall (seier, uavgjort eller tap) fra førkampssannsynlighetene, og trekker deretter et sluttresultat fra de to klubbenes angreps- og forsvarsratinger — målene hvert lag forventes å score og slippe inn.',
    'model.how4': 'To OBOS-ligaen-klubber rykket opp fra tredje nivå, som er utenfor dette prosjekts data. De starter på bunnen av stigen og korrigeres kun av resultater.',
    'model.version': 'Versjon',
    'model.kfactor': 'K-faktor',
    'model.homeAdvantage': 'Hjemmefordel',
    'model.xgAlpha': 'xG-vekt',
    'model.pts': 'po',
    'model.crossRegression': 'Regresjon',
    'model.towardMean': 'mot gjennomsnitt',
    'model.peakDraw': 'Høyeste uavgjortrate',
    'model.outcomeOdds': 'Utfallsodds',
    'model.outcomeOddsValue': 'Elo × angrep/forsvar, 25/75',
    'model.scorelines': 'Resultater',
    'model.scorelinesValue': 'angrep/forsvar-målmodell',
    'model.simulations': 'Simuleringer',
    'model.seed': 'Tilfeldig frø',

    // Team focus
    'team.position': 'Plassering',
    'team.points': 'Poeng',
    'team.gd': 'MM',
    'team.played': 'Spilt',
    'team.attack': 'Angrep',
    'team.defence': 'Forsvar',
    'team.ratesHint': 'Forventede mål for / imot per kamp mot et gjennomsnittslag i divisjonen',
    'team.matches': 'Kamper',
    'team.form': 'Form',
    'team.prediction': 'Prediksjon',
    'team.predPreSeason': 'Før sesong',
    'team.predCurrent': 'Nå',
    'team.ratingHistory': 'Rating over tid',
    'team.peak': 'Høyeste',
    'team.worst': 'Laveste',
    'team.rankOf': '{rank} av {total}',
    'team.finishProbs': 'Sluttsannsynligheter',
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
    'shape.now': 'nå {pct}',
    'shape.seasonAxis': '{year}-sesongen',
    'shape.stackedArea': 'Stablet arealdiagram: sannsynlighet for hver sluttplassering til {team}',

    // Chart
    'chart.rating': 'Rating {n}',
    'chart.ratingFrom': '{team} rating fra {from} til {to}',
    'chart.ratingMoved': '{team}: rating gikk fra {from} til {to} over {seasons} sesonger.',
    'chart.ratingHistoryFor': 'Rating-historikk for {home} og {away}',

    // Form
    'form.tooltip': '{w}S {d}U {l}T',

    // Season select
    'season.live': '{season} (live)',

    // Status / errors
    'status.loading': 'Laster sesongen\u2026',
    'status.couldNotLoad': 'Kunne ikke laste {season}: {error}',
    'status.couldNotLoadSeason': 'Kunne ikke laste sesongen: {error}. Er datafilene deployet?',
    'status.couldNotRewind': 'Kunne ikke spole tilbake: {error}',

    // Table dynamic headers
    'table.champion': 'Mester',
    'table.championShort': 'Titt',
    'table.championDesc': ', sjanse for å vinne tittelen',
    'table.promotion': 'Opprykk',
    'table.promotionShort': 'Opp',
    'table.promotionDesc': ', sjanse for opprykk',
    'table.relegation': 'Nedrykk',

    // Rating trend
    'trend.strongRise': 'Sterk oppgang (+{n})',
    'trend.rise': 'Stigende (+{n})',
    'trend.steady': 'Stabil (+/-{n})',
    'trend.fall': 'Fallende ({n})',
    'trend.strongFall': 'Sterk nedgang ({n})',

    'season.shape.axis': 'Rating etter hver kamp spilt',

    // Footer
    'footer.text': 'EliteTracker — Eliteserien og OBOS-ligaen, sesongene 2015\u20132026. Kampdata fra FotMob. Utviklet av <a href="mailto:tobias.samsonsen@gmail.com">Tobias Samsonsen</a>.',

    // Aria / title attributes
    'aria.chooseDivision': 'Velg divisjon',
    'aria.colourTheme': 'Fargetema',
    'aria.language': 'Språk',
    'aria.chooseView': 'Velg visning',
    'aria.moreViews': 'Flere visninger',
    'aria.matchdaySlider': 'Spillerunde å vise sesongen fra',
    'aria.oneEarlier': 'En spillerunde tidligere',
    'aria.oneLater': 'En spillerunde senere',
    'aria.gridCaption': 'Sannsynlighet for at hvert lag ender på hver plass',
    'aria.odds': '{home} seier {hw}, uavgjort {d}, {away} seier {aw}',
    'aria.scoreline': '{score} omtrent {pct}',
    'title.animateSeason': 'Animér sesongen',
    'title.changeSpeed': 'Endre hastighet',
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

/* Walk every element with data-i18n and set its text content.
   Elements with data-i18n-attr get the translation set as that attribute
   instead (skipping textContent so child nodes are preserved). */
function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    if (node.hasAttribute('data-i18n-attr')) return;
    const key = node.getAttribute('data-i18n');
    node.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-attr]').forEach((node) => {
    const key = node.getAttribute('data-i18n');
    const attr = node.getAttribute('data-i18n-attr');
    if (key && attr) node.setAttribute(attr, t(key));
  });
  /* Footer contains an <a> — textContent would strip it. */
  const footer = document.getElementById('footer-text');
  if (footer) footer.innerHTML = t('footer.text');
}
