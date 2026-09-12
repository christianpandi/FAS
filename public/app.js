let matches = [];
const matchesContainer = document.getElementById("matchesContainer");
const statusDiv = document.getElementById("status");







function renderScore(f) {
  const s = f.fixture.status.short;
  const elapsed = f.fixture.status.elapsed;
  const score = f.goals.home + '-' + f.goals.away;
  const ht = f.score.halftime;
  const htTxt = (ht && ht.home !== null) ? ` (${ht.home}-${ht.away})` : '';

  if (['1H', '2H', 'ET'].includes(s)) {
    const minute = elapsed ? `${elapsed}'` : s;
    if (s === '1H') {
      return `<span style='color:#cc0000;font-weight:bold;'>${minute}</span> <span style='font-weight:bold;'>${score}</span>`;
    } else {
      return `<span style='color:#cc0000;font-weight:bold;'>${minute}</span> <span style='font-weight:bold;'>${score}</span><span style='color:#666;font-size:10px;'>${htTxt}</span>`;
    }
  }
  if (s === 'HT') return `<span style='color:#cc0000;font-weight:bold;'>MT</span> <b>${score}</b><span style='color:#666;font-size:10px;'>${htTxt}</span>`;
  if (['FT', 'AET', 'PEN'].includes(s)) {
    return `<b>${score}</b> <small style='color:#666;'>FT</small><span style='color:#888;font-size:10px;'>${htTxt}</span>`;
  }
  return new Date(f.fixture.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

async function loadMatches() {
  try {
    const res = await fetch('/api/matches');
    const data = await res.json();

    if (!res.ok || data.error) {
      throw new Error(data.error || 'Erreur API');
    }

    const sortedGroups = Array.isArray(data) ? data : [];
    matches = sortedGroups.flatMap(group => group.matches || []);

    let html = '';
    sortedGroups.forEach(group => {
      const league = group.league;
      const flag = league.flag || league.country;
      const flagMarkup = flag && /^https?:\/\//i.test(flag)
        ? `<img class="league-flag" src="${flag}" alt="">`
        : `<span class="league-country">${flag || ''}</span>`;
      const logoMarkup = league.logo
        ? `<img class="league-logo" src="${league.logo}" alt="">`
        : '';

      html += `<section class="league-group">
        <h2 class="league">${logoMarkup}${flagMarkup}<span>${league.country || ''} - ${league.name || ''}</span></h2>`;
      group.matches.forEach(match => {
        html += `<div class="match"><span class="team-names">${match.teams.home.name} vs ${match.teams.away.name}</span><span class="match-right"><span class="match-time">${renderScore(match)}</span><div class="odds"><span>${match.odds?.home || '-'}</span><span>${match.odds?.draw || '-'}</span><span>${match.odds?.away || '-'}</span></div></span></div>`;
      });
      html += '</section>';
    });

    matchesContainer.innerHTML = html;
    statusDiv.innerText = `Flash All Scores - ${matches.length} matchs live - ${new Date().toLocaleTimeString()}`;

  } catch (e) {
    statusDiv.innerText = e.message || "Erreur Flash All Scores - vérifie ta clé dans .env";
  }
}

loadMatches();
