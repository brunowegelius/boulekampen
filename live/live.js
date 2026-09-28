/**
 * Livesidan — för deltagare och publik. Följ ditt lag, se tabeller,
 * matcher och slutspel uppdateras i realtid, rösta på bästa utklädnad.
 */
import * as E from '../app/engine.js';
import { db, liveEvent } from '../app/db.js';
import { SITE_EVENT } from '../app/config.js';
import {
  esc, $, $$, on, toast, dialog, params, store, reveal, segment, flip, rollNumbers, deviceId, demoBar, fmtDate,
  nameMap, resolvedMatches, groupTables, overallTable, standingsTable, playerTable, matchRow, bracket, nextFor, timerLeft, pageUrl,
} from '../app/ui.js';

const app = $('#app');
$('#demo').innerHTML = demoBar();
const slug = params().get('e') || SITE_EVENT;

let live;
let tab = store('bk-live-tab') || 'tabell';
let votes = [];
const st = () => live.state;
const cfg = () => E.withDefaults(st().event.config);
const mineKey = () => 'bk-mine-' + st().event.id;
const myVoteKey = () => 'bk-vote-' + st().event.id;

async function boot() {
  try { live = await liveEvent(slug, onData); }
  catch (e) { app.innerHTML = `<div class="empty" style="margin-top:40px"><strong>Kommer inte åt resultaten</strong>Kolla nätet och ladda om sidan.</div>`; return; }
  if (!st().event) return renderList();
  document.title = st().event.name + ' · Live';
  if (cfg().voting.reveal) votes = await db.voteResults(st().event.id).catch(() => []);
  renderAll();
}

async function renderList() {
  const list = (await db.events.list().catch(() => [])).filter(e => e.listed);
  app.innerHTML = `<header class="head"><i class="logo" aria-hidden="true"></i><div><h1>Live</h1><p class="sub">${list.length ? 'Välj evenemang.' : 'Inget evenemang är igång just nu.'}</p></div></header>
    <nav class="events-list">${list.map(e => `<a href="?e=${encodeURIComponent(e.slug)}"><span>${esc(e.name)}</span><span class="muted">${esc(fmtDate(e.date))}</span></a>`).join('')}</nav>`;
}

let lastReveal = false;
async function onData(state, change) {
  if (change.table === 'events') {
    const rev = !!cfg().voting.reveal;
    if (rev && !lastReveal) votes = await db.voteResults(st().event.id).catch(() => []);
    lastReveal = rev;
  }
  renderAll(true);
}

/* ── Rendering ─────────────────────────────────────────────────────── */

function renderAll(update = false) {
  const s = st(), ev = s.event, c = cfg();
  const res = resolvedMatches(s);
  const anyLive = res.some(m => m.status === 'live');
  const tabs = availableTabs(res);
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];

  if (!update || !$('#content')) {
    app.innerHTML = `
    <header class="head rv">
      <i class="logo" aria-hidden="true"></i>
      <div>
        <h1>${esc(ev.name)}</h1>
        <p class="sub">
          <span id="live-pill"></span>
          <span>${esc(fmtDate(ev.date, { weekday: 'long', day: 'numeric', month: 'long' }))}</span>
          ${ev.venue ? `<span>${esc(ev.venue)}</span>` : ''}
          ${c.company.logo ? `<img class="co-logo" src="${esc(c.company.logo)}" alt="${esc(c.company.name)}">` : c.company.name ? `<span>${esc(c.company.name)}</span>` : ''}
        </p>
      </div>
    </header>
    <div id="announce"></div>
    <div id="winner"></div>
    <div id="mine"></div>
    <div class="tabs"><div class="seg" role="tablist" aria-label="Visa" id="tabs"></div></div>
    <div id="content"></div>
    <footer class="foot"><span>Poängen förs in av banvärdarna och uppdateras direkt.</span></footer>`;
  }

  $('#live-pill').innerHTML = ev.status === 'avslutad' ? '<span class="pill line">Avslutat</span>'
    : anyLive ? '<span class="pill hi"><span class="live-dot"></span>Pågår</span>' : '';
  const t = timerLeft(c);
  $('#announce').innerHTML = (c.announcement ? `<div class="announce" role="status"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM16 8a5 5 0 0 1 0 8"/></svg><span>${esc(c.announcement)}</span></div>` : '')
    + (t && !t.done ? `<div class="announce" style="background:var(--raise);color:var(--ink)"><span>${esc(t.label ? 'Omgången' : 'Klockan')}:</span><span class="num" data-timer style="color:var(--hi)">${t.text}</span><span class="muted small">kvar</span></div>` : '');
  $('#winner').innerHTML = winnerBlock(res);
  $('#mine').innerHTML = mineBlock(res);
  $('#tabs').innerHTML = tabs.map(([k, l]) => `<button role="tab" aria-selected="${k === tab}" data-tab="${k}">${l}</button>`).join('');
  segment($('#tabs'));
  const content = $('#content');
  flip(content, () => { content.innerHTML = tabBody(res); });
  rollNumbers(app);
  reveal(app);
}

function availableTabs(res) {
  const s = st(), c = cfg();
  const t = [['tabell', 'Tabell'], ['matcher', 'Matcher']];
  if (res.some(m => m.stage === 'A' || m.stage === 'B')) t.push(['slutspel', 'Slutspel']);
  if (s.challenges.length) t.push(['utmaningar', 'Utmaningar']);
  if ((c.voting.open || c.voting.reveal) && s.teams.length) t.push(['rosta', c.voting.reveal ? 'Utklädnad' : 'Rösta']);
  return t;
}

function winnerBlock(res) {
  const names = nameMap(st());
  const finals = res.filter(m => m.stage === 'A' && !m.bronze);
  const final = finals.find(m => m.round === Math.max(...finals.map(x => x.round)));
  if (!final || final.status !== 'done') return '';
  const w = E.winnerOf(final);
  const id = w === 'a' ? final.a : final.b;
  return `<section class="winner" aria-live="polite"><p>Vinnare av ${esc(st().event.name)}</p><h2 style="font-size:min(72px, ${(78 / Math.max(5, (names[id] || '').length)).toFixed(2)}vw)">${esc(names[id] || '')}</h2><p style="margin-top:10px">${final.score_a}–${final.score_b} i finalen</p></section>`;
}

function mineBlock(res) {
  const s = st(), c = cfg();
  const melee = c.format === 'melee';
  const pool = melee ? s.players : s.teams;
  if (!pool.length) return '';
  const mine = store(mineKey());
  const who = pool.find(x => x.id === mine);
  if (!who) {
    return `<button class="mine pick rv" data-act="pick"><span class="who">Följ ${melee ? 'dig själv' : 'ditt lag'}</span><span class="muted">Se nästa match, bana och tid direkt här.</span></button>`;
  }
  const names = nameMap(s);
  const m = nextFor(res, who.id);
  let body;
  if (!m) {
    body = `<p class="muted">Inga fler matcher inplanerade${res.some(x => x.status !== 'done') ? ' just nu' : ''}.</p>`;
  } else {
    const side = m.a === who.id || (m.players_a || []).includes(who.id) ? 'a' : 'b';
    const oppSide = side === 'a' ? 'b' : 'a';
    const oppIds = oppSide === 'a' ? (m.players_a || []) : (m.players_b || []);
    const opp = oppIds.length ? oppIds.map(id => names[id]).join(' & ') : (oppSide === 'a' ? m.a : m.b) ? names[oppSide === 'a' ? m.a : m.b] : (oppSide === 'a' ? m.la : m.lb) || 'Okänt';
    const mates = melee ? (side === 'a' ? m.players_a : m.players_b).filter(id => id !== who.id).map(id => names[id]) : [];
    const my = side === 'a' ? m.score_a : m.score_b, their = side === 'a' ? m.score_b : m.score_a;
    body = m.status === 'live'
      ? `<div class="next"><div><span class="num" style="color:var(--hi)"><span class="roll" data-roll="mine-my">${my}</span>–<span class="roll" data-roll="mine-their">${their}</span></span><span>pågår nu</span></div><div><span class="num">${m.court || '–'}</span><span>bana</span></div></div>
         <p class="vs">Mot <b>${esc(opp)}</b>${mates.length ? `, med ${esc(mates.join(' & '))}` : ''}</p>`
      : `<div class="next"><div><span class="num">${E.slotTime(c, m.slot)}</span><span>nästa match</span></div><div><span class="num">${m.court || '–'}</span><span>bana</span></div></div>
         <p class="vs">Mot <b>${esc(opp)}</b>${mates.length ? `, med ${esc(mates.join(' & '))}` : ''} <span class="muted small">· ${esc(E.matchTitle(m))}</span></p>`;
  }
  return `<section class="mine rv ${m && m.status === 'live' ? 'is-live' : ''}">
    <div class="top"><span class="who">${esc(who.name)}</span><button class="change" data-act="pick">Byt</button></div>
    ${body}
  </section>`;
}

function tabBody(res) {
  const s = st(), c = cfg();
  const names = nameMap(s);
  const mine = store(mineKey());
  if (tab === 'tabell') {
    if (c.format === 'melee') return `<section class="block"><h2>Spelare</h2>${playerTable(E.playerStandings(s.players, s.matches), names, { mine })}</section>`;
    if (c.format === 'swiss') return `<section class="block"><h2>Tabell</h2>${standingsTable(overallTable(s, res), names, { mine, buchholz: true })}</section>`;
    const tables = groupTables(s, res);
    if (!tables.length) return `<div class="empty"><strong>Grupperna är inte lottade än</strong>Tabellerna dyker upp här när lottningen är klar.</div>`;
    const q = c.groups.toA;
    return `<div class="cols">${tables.map(g => `<section class="block rv"><h2>Grupp ${g.group}<small>${g.played} av ${g.total} spelade</small></h2>${standingsTable(g.rows, names, { toA: q, toB: c.groups.bCup ? q * 2 : 0, mine, keyPrefix: g.group, compact: true })}</section>`).join('')}</div>
      ${q ? `<p class="small faint" style="margin-top:14px">De ${q} bästa i varje grupp går till A-slutspelet${c.groups.bCup ? ', nästa ' + q + ' till B-slutspelet' : ''}. Lika poäng avgörs av inbördes möte, sedan poängskillnad.</p>` : ''}`;
  }
  if (tab === 'matcher') {
    if (!res.length) return `<div class="empty"><strong>Inget spelschema än</strong>Matcherna dyker upp här när de är lottade.</div>`;
    const slots = [...new Set(res.map(m => m.slot))].sort((a, b) => a - b);
    return slots.map(sl => {
      const list = res.filter(m => m.slot === sl && !m.bye);
      if (!list.length) return '';
      const allDone = list.every(m => m.status === 'done');
      return `<div class="rv"><div class="slot-t">${E.slotTime(c, sl)}<small>${allDone ? 'Klart' : list.some(m => m.status === 'live') ? 'Pågår' : ''}</small></div>
        ${list.map(m => matchRow(m, names, c, { mine, time: false })).join('')}</div>`;
    }).join('');
  }
  if (tab === 'slutspel') {
    return ['A', 'B'].map(stg => {
      const b = bracket(res, names, c, stg);
      return b ? `<section class="block rv" style="margin-bottom:30px"><h2>${stg === 'A' ? 'A-slutspel' : 'B-slutspel'}</h2>${b}</section>` : '';
    }).join('');
  }
  if (tab === 'utmaningar') {
    return `<div class="cols">${s.challenges.slice().sort((a, b) => a.sort - b.sort).map(ch => {
      const best = new Map();
      for (const sc of s.scores.filter(x => x.challenge_id === ch.id)) {
        const w = sc.player_id || sc.team_id, v = Number(sc.value);
        const cur = best.get(w);
        if (cur == null || (ch.higher_better ? v > cur : v < cur)) best.set(w, v);
      }
      const rows = [...best.entries()].sort((a, b) => ch.higher_better ? b[1] - a[1] : a[1] - b[1]);
      return `<section class="block rv"><h2>${esc(ch.name)}<small>${ch.higher_better ? 'högst' : 'lägst'} vinner</small></h2>
        ${rows.length ? `<table class="table"><tbody>${rows.map(([w, v], i) => `<tr class="${i === 0 ? 'lead' : ''} ${w === mine ? 'mine' : ''}"><td class="rank">${i + 1}</td><td class="team">${esc(names[w] || '?')}</td><td class="pts">${v} <span class="small muted">${esc(ch.unit)}</span></td></tr>`).join('')}</tbody></table>` : '<p class="muted">Inga resultat än.</p>'}</section>`;
    }).join('')}</div>`;
  }
  if (tab === 'rosta') return voteBody();
  return '';
}

function voteBody() {
  const s = st(), c = cfg();
  const teams = s.teams.slice().sort((a, b) => a.name.localeCompare(b.name, 'sv'));
  if (c.voting.reveal) {
    const counts = Object.fromEntries(votes.map(v => [v.team_id, Number(v.votes)]));
    const ranked = teams.slice().sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0));
    const max = Math.max(1, ...Object.values(counts));
    return `<section class="block"><h2>Bästa lagutklädnad</h2>
      ${ranked.map((t, i) => `<div class="rv" style="display:grid;grid-template-columns:1fr auto;gap:6px 14px;padding:12px 0;border-top:1px solid var(--line)">
        <span${i === 0 ? ' style="color:var(--hi)"' : ''}>${esc(t.name)}${t.costume ? `<span class="muted small"> · ${esc(t.costume)}</span>` : ''}</span><span class="num">${counts[t.id] || 0}</span>
        <span style="grid-column:1/-1;height:6px;border-radius:9px;background:var(--raise-2);overflow:hidden"><i style="display:block;height:100%;width:${((counts[t.id] || 0) / max) * 100}%;background:${i === 0 ? 'var(--hi)' : 'var(--ink)'};border-radius:9px"></i></span>
      </div>`).join('')}</section>`;
  }
  const my = store(myVoteKey());
  const myTeam = store(mineKey());
  return `<section class="block"><h2>Bästa lagutklädnad</h2>
    <p class="muted" style="margin-bottom:16px">En röst per telefon. Du kan ändra dig tills röstningen stänger${myTeam && s.teams.some(t => t.id === myTeam) ? ' — men inte rösta på ditt eget lag' : ''}.</p>
    <div class="vote-list">${teams.map(t => `<button class="vote" data-vote="${t.id}" aria-pressed="${my === t.id}" ${t.id === myTeam || !c.voting.open ? 'disabled' : ''}><b>${esc(t.name)}</b><span>${esc(t.costume || 'Utklädnad okänd')}</span></button>`).join('')}</div>
  </section>`;
}

/* ── Händelser ─────────────────────────────────────────────────────── */

on(app, 'click', '[data-tab]', (e, el) => {
  tab = el.dataset.tab;
  store('bk-live-tab', tab);
  $$('#tabs [data-tab]').forEach(b => b.setAttribute('aria-selected', b === el));
  segment($('#tabs'));
  const content = $('#content');
  content.innerHTML = tabBody(resolvedMatches(st()));
  rollNumbers(content);
  reveal(content);
});

on(app, 'click', '[data-act="pick"]', async () => {
  const s = st(), melee = cfg().format === 'melee';
  const pool = (melee ? s.players : s.teams).slice().sort((a, b) => a.name.localeCompare(b.name, 'sv'));
  const r = await dialog(`<form method="dialog">
    <h2>${melee ? 'Vem är du?' : 'Vilket lag?'}</h2>
    <label class="field" style="margin-bottom:12px"><span class="sr">Sök</span><input class="input" type="search" placeholder="Sök" data-filter autocomplete="off"></label>
    <div class="picker">${pool.map(x => `<button value="${x.id}" data-name="${esc(x.name.toLowerCase())}">${esc(x.name)}</button>`).join('')}</div>
    <div class="actions"><button class="btn ghost" value="">Avbryt</button>${store(mineKey()) ? '<button class="btn ghost" value="none">Sluta följa</button>' : ''}</div>
  </form>`, {
    onOpen(d) {
      const f = d.querySelector('[data-filter]');
      f.addEventListener('input', () => $$('.picker button', d).forEach(b => { b.hidden = !b.dataset.name.includes(f.value.toLowerCase()); }));
    },
  });
  if (!r) return;
  store(mineKey(), r.value === 'none' ? null : r.value);
  renderAll(true);
});

on(app, 'click', '[data-vote]', async (e, el) => {
  const id = el.dataset.vote;
  try {
    const r = await db.vote(st().event.id, id, deviceId());
    if (!r.ok) { toast(r.error === 'closed' ? 'Röstningen är stängd' : 'Rösten gick inte fram'); return; }
    store(myVoteKey(), id);
    $$('[data-vote]').forEach(b => b.setAttribute('aria-pressed', b.dataset.vote === id));
    toast('Tack för din röst!', 'hi');
  } catch (err) { toast('Rösten gick inte fram. Kolla nätet.'); }
});

setInterval(() => {
  const el = $('[data-timer]');
  if (!el || !live?.state?.event) return;
  const t = timerLeft(cfg());
  if (!t || t.done) { renderAll(true); return; }
  el.textContent = t.text;
}, 1000);

addEventListener('resize', () => segment($('#tabs')));

boot();
