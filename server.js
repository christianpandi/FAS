require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const MATCH_CACHE_TTL = 5 * 60 * 1000;
const BIG_LEAGUES_IDS = [39, 140, 61, 78, 135, 2, 3];
const cache = global.cacheFixtures || (global.cacheFixtures = {});
let externalRequest = null;
const dateRequests = new Map();
const oddsCache = {};
const ODDS_CACHE_TTL = 60 * 60 * 1000;
const standingsCache = {};
const statisticsCache = {};
const apiFootballKey = process.env.API_FOOTBALL_KEY || process.env.API_KEY;

app.use(express.static(path.join(__dirname, 'public')));

function getUtcDate(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().split('T')[0];
}

async function fetchFixtures(date, live = false) {
  console.log(`Recherche API pour la date UTC ${date}`);
  console.log("VRAI APPEL API EXTERNE");

  if (!apiFootballKey) {
    return { error: 'Clé manquante', missingKey: true };
  }

  try {
    const apiUrl = live
      ? 'https://v3.football.api-sports.io/fixtures?live=all'
      : `https://v3.football.api-sports.io/fixtures?date=${date}`;
    const response = await fetch(apiUrl, {
      headers: { "x-apisports-key": apiFootballKey }
    });
    const data = await response.json();
    const errorText = JSON.stringify(data.errors || '').toLowerCase();

    console.error('Réponse API-Football:', {
      status: response.status,
      ok: response.ok,
      response: data.response,
      errors: data.errors
    });

    if (response.status === 429 || !response.ok || data.errors && Object.keys(data.errors).length > 0 || !Array.isArray(data.response) || data.response.length === 0) {
      return { data: { response: createFallbackFixtures(date) }, fallback: true };
    }

    return {
      data: { response: data.response },
      quotaReached: errorText.includes('limit reached') || errorText.includes('quota')
    };
  } catch (error) {
    console.error('Erreur API-Football:', error);
    return { data: { response: createFallbackFixtures(date) }, fallback: true };
  }
}

function createFallbackFixtures(date) {
  return [
    createFallbackMatch(1, 'France SRL', 'Germany SRL', 1, 0, '1H', date, 21, 34),
    createFallbackMatch(2, 'Spain SRL', 'Italy SRL', 2, 1, '2H', date, 21, 67),
    createFallbackMatch(3, 'England SRL', 'Brazil SRL', 0, 0, '1H', date, 20, 22),
    createFallbackMatch(4, 'Portugal SRL', 'Netherlands SRL', 1, 1, 'HT', date, 19, null)
  ];
}

function createFallbackMatch(id, home, away, homeGoals, awayGoals, status, date, hour, elapsed) {
  return {
    fixture: {
      id: `fallback-${id}`,
      date: `${date}T${String(hour).padStart(2, '0')}:00:00Z`,
      status: { short: status, elapsed }
    },
    league: { id: `fallback-srl-${id}`, name: 'SRL', country: 'International', flag: '' },
    teams: {
      home: { name: home, logo: null },
      away: { name: away, logo: null }
    },
    goals: { home: homeGoals, away: awayGoals },
    score: { halftime: { home: null, away: null } }
  };
}

function getLeagueOrder(league) {
  const name = (league.name || '').toLowerCase();
  if (name.includes('srl') || name.includes('simulated')) return 0;
  if (BIG_LEAGUES_IDS.includes(league.id)) return 1;
  return 2;
}

function sortLeagueGroups(matches) {
  const groups = {};

  matches.forEach(match => {
    const leagueId = match.league.id;
    if (!groups[leagueId]) {
      groups[leagueId] = { league: match.league, matches: [] };
    }
    groups[leagueId].matches.push(match);
  });

  return Object.values(groups).sort((a, b) => {
    const orderA = getLeagueOrder(a.league);
    const orderB = getLeagueOrder(b.league);

    if (orderA !== orderB) return orderA - orderB;

    if (orderA === 2) {
      return a.league.country.localeCompare(b.league.country) ||
        a.league.name.localeCompare(b.league.name);
    }

    if (orderA === 0) return a.league.name.localeCompare(b.league.name);
    if (orderA === 1) {
      return BIG_LEAGUES_IDS.indexOf(a.league.id) - BIG_LEAGUES_IDS.indexOf(b.league.id);
    }

    return 0;
  });
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchFixtureOdds(fixtureId) {
  if (!fixtureId) return null;

  const cachedOdds = oddsCache[fixtureId];
  if (cachedOdds && Date.now() - cachedOdds.fetchedAt < ODDS_CACHE_TTL) {
    return cachedOdds.odds;
  }

  try {
    const response = await fetch(`https://v3.football.api-sports.io/odds?fixture=${fixtureId}&bookmaker=8`, {
      headers: { "x-apisports-key": process.env.API_KEY }
    });
    const data = await response.json();
    const oddsResponse = Array.isArray(data.response) ? data.response[0] : data.response;
    const bookmaker = oddsResponse?.bookmakers?.find(item => item.id === 8) || oddsResponse?.bookmakers?.[0];
    const matchWinner = bookmaker?.bets?.find(bet => bet.name === 'Match Winner');
    const values = matchWinner?.values || [];
    const getOdd = value => values.find(item => item.value === value)?.odd || null;
    const odds = {
      home: getOdd('Home'),
      draw: getOdd('Draw'),
      away: getOdd('Away')
    };

    if (!odds.home && !odds.draw && !odds.away) {
      oddsCache[fixtureId] = { odds: null, fetchedAt: Date.now() };
      return null;
    }

    oddsCache[fixtureId] = { odds, fetchedAt: Date.now() };
    return odds;
  } catch (error) {
    console.log(`Erreur cotes fixture ${fixtureId}:`, error.message);
    oddsCache[fixtureId] = { odds: null, fetchedAt: Date.now() };
    return null;
  }
}

async function addTodayOdds(sortedGroups, today) {
  const todayMatches = sortedGroups
    .flatMap(group => group.matches)
    .filter(match => match.fixture?.date?.startsWith(today));

  for (let index = 0; index < todayMatches.length; index += 10) {
    const batch = todayMatches.slice(index, index + 10);
    await Promise.all(batch.map(async match => {
      match.odds = await fetchFixtureOdds(match.fixture?.id);
    }));

    if (index + 10 < todayMatches.length) {
      await delay(300);
    }
  }

  return sortedGroups;
}

async function loadMatches(requestedDate = null, live = false) {
  const today = getUtcDate();
  const datesToSearch = live ? [today] : requestedDate
    ? [requestedDate]
    : [today, getUtcDate(-1), getUtcDate(1)];
  let mergedMatches = [];
  let firstResponse = null;
  let usedFallback = false;

  console.log(`Date UTC du jour: ${today}`);

  for (const date of datesToSearch) {
    const result = await fetchFixtures(date, live);
    if (result.missingKey) return result;
    const data = result.data;
    usedFallback = usedFallback || Boolean(result.fallback);

    if (!firstResponse) {
      firstResponse = data;
    }

    const matches = Array.isArray(data.response) ? data.response : [];
    console.log(`${matches.length} match(s) trouvé(s) pour ${date}`);
    mergedMatches = mergedMatches.concat(matches);

    if ((live || date === today) && matches.length > 0) {
      break;
    }
  }

  const sortedGroups = sortLeagueGroups(mergedMatches);
  if ((!requestedDate || requestedDate === today) && !live && !usedFallback) {
    await addTodayOdds(sortedGroups, today);
  }

  return {
    quotaReached: false,
    data: sortedGroups
  };
}

app.get(['/api/matches', '/api/live', '/api/fixtures'], async (req, res) => {
  const now = Date.now();
  const live = req.query.live === 'all';
  const requestedDate = req.query.date || getUtcDate();
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;

  if (requestedDate && !datePattern.test(requestedDate)) {
    return res.json([]);
  }

  const cacheKey = live ? 'live' : requestedDate;
  const cachedDate = cache[cacheKey];

  if (cachedDate && now - cachedDate.time < MATCH_CACHE_TTL) {
    return res.json(cachedDate.data);
  }

  try {
    if (!apiFootballKey) {
      return res.json({ error: 'Clé manquante' });
    }

    if (!dateRequests.has(cacheKey)) {
      dateRequests.set(cacheKey, loadMatches(requestedDate, live));
    }

    const result = await dateRequests.get(cacheKey);
    dateRequests.delete(cacheKey);

    if (result.missingKey) return res.json({ error: 'Clé manquante' });

    const data = Array.isArray(result.data) ? result.data : [];
    cache[cacheKey] = { data, time: Date.now() };
    console.log(`${data.reduce((total, group) => total + group.matches.length, 0)} match(s) au total après recherche`);
    res.json(data);
  } catch (e) {
    externalRequest = null;
    dateRequests.delete(cacheKey);
    console.log(e);
    res.json(cachedDate?.data || []);
  }
});

async function fetchFootballApi(endpoint) {
  if (!apiFootballKey) return { error: 'Clé manquante' };

  const response = await fetch(`https://v3.football.api-sports.io/${endpoint}`, {
    headers: { 'x-apisports-key': apiFootballKey }
  });
  const data = await response.json();
  console.log('Réponse API-Football:', {
    endpoint,
    status: response.status,
    ok: response.ok,
    response: data.response,
    errors: data.errors
  });

  if (!response.ok || data.errors && Object.keys(data.errors).length > 0) {
    return { error: 'Erreur API-Football', details: data.errors };
  }

  return data;
}

app.get('/api/standings', async (req, res) => {
  const league = Number(req.query.league);
  const season = Number(req.query.season);

  if (!Number.isInteger(league) || !Number.isInteger(season)) {
    return res.status(400).json({ error: 'Paramètres league et season invalides' });
  }

  const cacheKey = `${league}-${season}`;
  if (standingsCache[cacheKey]) return res.json(standingsCache[cacheKey]);

  try {
    const data = await fetchFootballApi(`standings?league=${league}&season=${season}`);
    if (data.error) return res.status(502).json(data);
    const result = Array.isArray(data.response) ? data.response : [];
    standingsCache[cacheKey] = result;
    return res.json(result);
  } catch (error) {
    console.error('Erreur standings:', error);
    return res.status(502).json({ error: 'Impossible de récupérer les classements' });
  }
});

app.get('/api/statistics/:fixture', async (req, res) => {
  const fixture = Number(req.params.fixture);
  if (!Number.isInteger(fixture) || fixture <= 0) {
    return res.status(400).json({ error: 'Identifiant fixture invalide' });
  }

  if (statisticsCache[fixture]) return res.json(statisticsCache[fixture]);

  try {
    const data = await fetchFootballApi(`fixtures/statistics?fixture=${fixture}`);
    if (data.error) return res.status(502).json(data);
    const result = Array.isArray(data.response) ? data.response : [];
    statisticsCache[fixture] = result;
    return res.json(result);
  } catch (error) {
    console.error('Erreur statistiques fixture:', error);
    return res.status(502).json({ error: 'Impossible de récupérer les statistiques' });
  }
});

app.get('/api/fixture/:fixture', async (req, res) => {
  const fixture = Number(req.params.fixture);
  if (!Number.isInteger(fixture) || fixture <= 0) {
    return res.status(400).json({ error: 'Identifiant fixture invalide' });
  }

  try {
    const data = await fetchFootballApi(`fixtures?id=${fixture}`);
    if (data.error) return res.status(502).json(data);
    return res.json(Array.isArray(data.response) ? data.response[0] || null : null);
  } catch (error) {
    console.error('Erreur détail fixture:', error);
    return res.status(502).json({ error: 'Impossible de récupérer le match' });
  }
});

app.get('/api/events/:fixture', async (req, res) => {
  const fixture = Number(req.params.fixture);
  if (!Number.isInteger(fixture) || fixture <= 0) {
    return res.status(400).json({ error: 'Identifiant fixture invalide' });
  }

  try {
    const data = await fetchFootballApi(`fixtures/events?fixture=${fixture}`);
    if (data.error) return res.status(502).json(data);
    return res.json(Array.isArray(data.response) ? data.response : []);
  } catch (error) {
    console.error('Erreur événements fixture:', error);
    return res.status(502).json({ error: 'Impossible de récupérer les événements' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Lancé sur http://localhost:${PORT}`));
