/**
 * Startsidans Tabell- och Resultat-kort. Så länge inga lag finns i
 * systemet (eller databasen inte är kopplad) står korten kvar som de är,
 * med TBD. När lagen är lottade fylls de i och uppdateras live.
 */
import { mode, liveEvent } from './db.js';
import { SITE_EVENT } from './config.js';
import { esc, nameMap, resolvedMatches, overallTable, sideName, flip, rollNumbers } from './ui.js';
import * as E from './engine.js';

// Rullande siffror — startsidan laddar inte ui.css
const css = document.createElement('style');
css.textContent = '.roll{display:inline-block;overflow:hidden;vertical-align:bottom}.roll>i{display:inline-block;font-style:normal}.roll.bump>i{animation:bk-roll .55s cubic-bezier(.22,1,.36,1)}@keyframes bk-roll{from{transform:translateY(90%);opacity:0}}@media (prefers-reduced-motion:reduce){.roll.bump>i{animation:none}}';
document.head.appendChild(css);

if (mode === 'cloud') {
  liveEvent(SITE_EVENT, update).then(h => update(h.state)).catch(() => {});
}

function update(state) {
  if (!state.event || !state.teams.length) return;
  const names = nameMap(state);
  const res = resolvedMatches(state);
  const tbody = document.querySelector('.card-tabell .standings-table tbody');
  const list = document.querySelector('.result-list');

  const title = document.querySelector('.card-tabell .card-title');
  if (title && !title.querySelector('a')) {
    title.innerHTML = `<a href="live/" style="color:inherit;text-decoration:none;display:flex;justify-content:space-between">Tabell <span style="font-size:.7em;opacity:.6">Live</span></a>`;
  }

  if (tbody) {
    const rows = overallTable(state, res).slice(0, 6);
    flip(tbody, () => {
      tbody.innerHTML = rows.map(r => `<tr data-flip="${esc(r.team)}">
        <td class="td-rank">${r.rank}</td>
        <td>${esc(names[r.team])}</td>
        <td>${r.played}</td><td>${r.won}</td>
        <td class="td-pts"><span class="roll" data-roll="site-${esc(r.team)}">${r.pts}</span></td>
      </tr>`).join('');
    });
    rollNumbers(tbody);
  }

  if (list) {
    const done = res.filter(m => m.status !== 'planned' && !m.bye)
      .sort((a, b) => (b.status === 'live') - (a.status === 'live') || String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
      .slice(0, 5);
    if (!done.length) return;
    list.innerHTML = done.map(m => `<div class="result-item">
      <span class="result-home">${esc(sideName(m, 'a', names))}</span>
      <span class="result-score">${m.status === 'live' ? '● ' : ''}${m.score_a} – ${m.score_b}</span>
      <span class="result-away">${esc(sideName(m, 'b', names))}</span>
    </div>`).join('');
  }
}
