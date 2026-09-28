/**
 * Storbilden. Roterar mellan vyerna som har något att visa, eller låser
 * på den vy arrangören valt. Två stora ögonblick tar över hela skärmen:
 * en fanny (13–0) och när finalen är avgjord.
 */
import * as E from '../app/engine.js';
import { db, liveEvent } from '../app/db.js';
import { SITE_EVENT } from '../app/config.js';
import {
  esc, $, params, qr, demoBar, fmtDate, nameMap, resolvedMatches, groupTables, overallTable, sideName,
  bracket, timerLeft, rollNumbers, pageUrl, reduced,
} from '../app/ui.js';

const slug = params().get('e') || SITE_EVENT;
const ROTATE_MS = 15000;
$('#demo').innerHTML = demoBar();

let live, current = null, paused = false, rotateAt = 0, votes = [];
const seen = new Map();   // match-id → status, för att upptäcka nya resultat
const st = () => live.state;
const cfg = () => E.withDefaults(st().event.config);

async function boot() {
  try { live = await liveEvent(slug, onData); }
  catch (e) { $('#stage').innerHTML = '<div class="ptitle">Ingen kontakt med servern</div>'; setTimeout(boot, 5000); return; }
  if (!st().event) { $('#stage').innerHTML = `<div class="ptitle">Hittar inte evenemanget<small>${esc(slug)}</small></div>`; return; }
  document.title = st().event.name + ' · Storbild';
  st().matches.forEach(m => seen.set(m.id, m.status));
  if (cfg().voting.reveal) votes = await db.voteResults(st().event.id).catch(() => []);
  renderTop();
  renderTicker();
  show(pickPanel(true));
  setInterval(tick, 1000);
  keepAwake();
}

/* ── Vilka vyer finns ──────────────────────────────────────────────── */

function panels() {
  const s = st(), c = cfg();
  const res = resolvedMatches(s);
  const list = [];
  const hasTables = c.format === 'melee' ? s.matches.some(m => m.status === 'done') : s.teams.length > 0 && (c.format !== 'groups' || s.teams.some(t => t.group_label));
  if (res.some(m => m.status !== 'done' && !m.bye)) list.push('matcher');
  if (hasTables) list.push('tabell');
  if (res.some(m => (m.stage === 'A' || m.stage === 'B') && (m.a || m.b || m.status !== 'planned')) || res.some(m => m.stage === 'A') && res.filter(m => m.stage === 'group').every(m => m.status === 'done')) list.push('slutspel');
  if (res.some(m => m.status === 'done' && !m.bye)) list.push('resultat');
  if (s.challenges.length && s.scores.length) list.push('utmaningar');
  if (c.voting.open) list.push('rostning');
  list.push('valkommen');
  return list;
}

function pickPanel(first) {
  const c = cfg();
  if (c.screen.pin) return c.screen.pin;
  const list = panels();
  if (first || !list.includes(current)) return list[0];
  return list[(list.indexOf(current) + 1) % list.length];
}

/* ── Rendering ─────────────────────────────────────────────────────── */

function renderTop() {
  const ev = st().event, c = cfg();
  $('#top').innerHTML = `
    <i class="logo" aria-hidden="true"></i>
    <div class="name">${esc(ev.name)}<small>${esc([fmtDate(ev.date, { weekday: 'long', day: 'numeric', month: 'long' }), ev.venue].filter(Boolean).join(' · '))}</small>
      ${c.company.logo ? `<img class="co" src="${esc(c.company.logo)}" alt="${esc(c.company.name)}">` : ''}</div>
    <div class="sb-clock" id="clock"></div>`;
  renderClock();
}

function renderClock() {
  const t = timerLeft(cfg());
  const now = new Date().toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
  $('#clock').innerHTML = t
    ? `<div class="count ${t.done ? 'out' : ''}">${t.done ? 'Tiden ute' : t.text}</div><div class="tm">${t.done ? 'Spela klart omgången + en till' : 'kvar av omgången · klockan ' + now}</div>`
    : `<div class="now">${now}</div>`;
}

function renderTicker() {
  const c = cfg(), s = st();
  const tk = $('#ticker');
  if (c.announcement) {
    tk.className = 'ticker hi';
    tk.innerHTML = `<span class="lbl">Utrop</span><div style="overflow:hidden;flex:1"><span class="run static">${esc(c.announcement)}</span></div>`;
    return;
  }
  const names = nameMap(s);
  const done = resolvedMatches(s).filter(m => m.status === 'done' && !m.bye).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).slice(0, 10);
  tk.className = 'ticker';
  if (!done.length) {
    tk.innerHTML = `<span class="lbl">Följ live</span><div style="overflow:hidden;flex:1"><span class="run static">${esc(pageUrl('live', st().event.slug).replace(/^https?:\/\//, ''))}</span></div>`;
    return;
  }
  const items = done.map(m => {
    const w = E.winnerOf(m);
    return `${esc(sideName(m, 'a', names))} <b>${m.score_a}–${m.score_b}</b> ${esc(sideName(m, 'b', names))}${E.isFanny(m, c) ? ' <b>FANNY</b>' : ''}${w ? '' : ''}`;
  }).join('<span class="dot">●</span>');
  tk.innerHTML = `<span class="lbl">Senaste</span><div style="overflow:hidden;flex:1"><span class="run" style="--dur:${Math.max(30, done.length * 7)}s">${items}</span></div>`;
}

function renderDots() {
  const c = cfg();
  const list = c.screen.pin ? [] : panels();
  $('#dots').innerHTML = list.length > 1 ? list.map(p => `<i class="${p === current ? 'on' : ''}"></i>`).join('') : '';
}

function show(name) {
  const stage = $('#stage');
  const old = stage.querySelector('.panel-sb');
  const el = document.createElement('div');
  el.className = 'panel-sb enter';
  el.innerHTML = body(name);
  if (old && current !== name && !reduced()) {
    old.classList.remove('enter');
    old.classList.add('leave');
    setTimeout(() => old.remove(), 480);
  } else if (old) old.remove();
  stage.appendChild(el);
  current = name;
  rotateAt = Date.now() + ROTATE_MS;
  after(el);
  renderDots();
}

/** Ritar om vyn som visas utan övergång (nya poäng, nya lag …). */
function refresh() {
  const el = $('#stage .panel-sb:not(.leave)');
  if (!el) return show(pickPanel(true));
  const want = cfg().screen.pin;
  if (want && want !== current) return show(want);
  if (!want && !panels().includes(current)) return show(pickPanel(true));
  el.classList.remove('enter');
  el.innerHTML = body(current);
  after(el);
  renderDots();
}

function after(el) {
  rollNumbers(el);
  el.querySelectorAll('[data-qr]').forEach(q => qr(q, q.dataset.qr, { dark: '#093000', light: '#f1ffe7' }));
  el.querySelectorAll('.vr .bar i[data-w]').forEach((i, k) => setTimeout(() => { i.style.width = i.dataset.w; }, 400 + k * 120));
}

function body(name) {
  const s = st(), c = cfg();
  const res = resolvedMatches(s);
  const names = nameMap(s);

  if (name === 'tabell') {
    if (c.format === 'melee') {
      const rows = E.playerStandings(s.players, s.matches).slice(0, 16);
      return `<div class="ptitle">Tabell<small>Mest vinster</small></div>${sbTable(rows.map(r => ({ ...r, team: r.player })), names, { cols: 2 })}`;
    }
    if (c.format === 'swiss') return `<div class="ptitle">Tabell</div>${sbTable(overallTable(s, res), names, { cols: 2 })}`;
    const tables = groupTables(s, res);
    const q = c.groups.toA;
    const cols = tables.length <= 2 ? tables.length : tables.length <= 4 ? 2 : 4;
    const dense = tables.length >= 4 || tables.some(t => t.rows.length > 5);
    return `<div class="ptitle">Grupperna<small>${q ? `Topp ${q} till A-slutspel${c.groups.bCup ? ', nästa ' + q + ' till B' : ''}` : ''}</small></div>
      <div class="sb-groups" style="grid-template-columns:repeat(${cols},1fr)">${tables.map(g => `<div><h3>Grupp ${g.group}</h3>
        <table class="sb-t ${dense ? 'dense' : ''}"><tbody>${g.rows.map((r, i) => `<tr class="${i === 0 && r.played ? 'lead' : ''} ${q && i < q ? 'q' : ''} ${(q && i === q) || (c.groups.bCup && q && i === q * 2) ? 'cut' : ''}">
          <td class="r">${r.rank}</td><td class="n">${esc(names[r.team])}</td><td class="m">${r.played} m</td><td class="m">${r.diff > 0 ? '+' : ''}${r.diff}</td><td class="p"><span class="roll" data-roll="sb-${g.group}${r.team}">${r.pts}</span></td></tr>`).join('')}</tbody></table></div>`).join('')}</div>`;
  }

  if (name === 'matcher') {
    const live = res.filter(m => m.status === 'live');
    const nextSlot = res.find(m => m.status === 'planned' && !m.bye)?.slot;
    const slotNow = live.length ? Math.min(...live.map(m => m.slot)) : nextSlot;
    const list = res.filter(m => !m.bye && (m.status === 'live' || (m.slot === slotNow && m.status !== 'done') || (!live.length && m.slot === nextSlot))).sort((a, b) => (a.court || 99) - (b.court || 99)).slice(0, 12);
    const title = live.length ? 'På banorna nu' : `Nästa pass ${slotNow != null ? E.slotTime(c, slotNow) : ''}`;
    return `<div class="ptitle">${title}<small>${live.length ? `${live.length} matcher pågår` : 'Hitta er bana'}</small></div>
      <div class="courts-sb">${list.map(m => {
        const w = m.status === 'done' ? E.winnerOf(m) : m.score_a === m.score_b ? null : m.score_a > m.score_b ? 'a' : 'b';
        return `<div class="ct ${m.status === 'live' ? 'live' : ''}">
          <div class="cn"><span>${m.court ? 'Bana ' + m.court : ''}</span><span>${esc(E.matchTitle(m))}</span></div>
          <div class="tn ${m.status === 'live' && w === 'a' ? 'w' : ''} ${!m.a && !(m.players_a || []).length ? 'ph' : ''}">${esc(sideName(m, 'a', names))}</div><div class="sc">${m.status === 'planned' ? '' : `<span class="roll" data-roll="sb-${m.id}-a">${m.score_a}</span>`}</div>
          <div class="tn ${m.status === 'live' && w === 'b' ? 'w' : ''} ${!m.b && !(m.players_b || []).length ? 'ph' : ''}">${esc(sideName(m, 'b', names))}</div><div class="sc">${m.status === 'planned' ? '' : `<span class="roll" data-roll="sb-${m.id}-b">${m.score_b}</span>`}</div>
        </div>`;
      }).join('')}</div>`;
  }

  if (name === 'slutspel') {
    const hasB = res.some(m => m.stage === 'B');
    return `<div class="ptitle">Slutspel<small>${hasB ? 'A-slutspelet' : ''}</small></div>${bracket(res, names, c, 'A')}
      ${hasB ? `<div class="ptitle" style="font-size:1.8vw;margin:1.6vw 0 1vw">B-slutspelet</div><div style="zoom:.8">${bracket(res, names, c, 'B')}</div>` : ''}`;
  }

  if (name === 'resultat') {
    const done = res.filter(m => m.status === 'done' && !m.bye).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).slice(0, 12);
    return `<div class="ptitle">Senaste resultat</div><div class="res-list">${done.map(m => {
      const w = E.winnerOf(m);
      return `<div class="res"><span class="a ${w === 'a' ? 'w' : ''}">${esc(sideName(m, 'a', names))}</span><span class="s">${m.score_a}–${m.score_b}</span><span class="${w === 'b' ? 'w' : ''}">${esc(sideName(m, 'b', names))}</span></div>`;
    }).join('')}</div>`;
  }

  if (name === 'valkommen') {
    const liveUrl = pageUrl('live', s.event.slug);
    const joinCode = s.event.kind === 'foretag' && c.registration.open && c.registration.code;
    return `<div class="welcome">
      <div><h2>${s.event.kind === 'foretag' ? 'Välkomna!' : 'Följ allt live'}</h2>
        <p>${s.event.kind === 'foretag' ? 'Skanna koden och anmäl dig. Sedan ser du ditt lag, din bana och tabellen i mobilen.' : 'Tabellen, ditt lags nästa match och slutspelet — direkt i mobilen.'}</p>
        <div class="url">${esc(liveUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</div></div>
      <div class="qrs ${joinCode ? 'two' : ''}">
        ${joinCode ? `<figure><div class="q" data-qr="${esc(pageUrl('delta'))}?k=${esc(joinCodeFor())}"></div><figcaption>Anmäl dig</figcaption></figure>` : ''}
        <figure><div class="q" data-qr="${esc(liveUrl)}"></div><figcaption>Följ live</figcaption></figure>
      </div>
    </div>`;
  }

  if (name === 'lottning') return drawBody();

  if (name === 'rostning') {
    if (c.voting.reveal) {
      const counts = Object.fromEntries(votes.map(v => [v.team_id, Number(v.votes)]));
      const ranked = s.teams.slice().sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0)).slice(0, 8).reverse();
      const max = Math.max(1, ...Object.values(counts));
      return `<div class="ptitle">Bästa lagutklädnad</div><div class="vote-reveal">${ranked.map((t, i) => {
        const top = i === ranked.length - 1;
        return `<div class="vr ${top ? 'top' : ''}" style="animation-delay:${i * 0.9}s"><span>${esc(t.name)}</span><span class="bar"><i data-w="${((counts[t.id] || 0) / max) * 100}%"></i></span><span class="c">${counts[t.id] || 0}</span></div>`;
      }).join('')}</div>`;
    }
    return `<div class="welcome"><div><h2>Rösta på bästa utklädnad</h2><p>Öppna livesidan och välj fliken Rösta. En röst per telefon — inte på ditt eget lag.</p></div>
      <div class="qrs"><figure><div class="q" data-qr="${esc(pageUrl('live', s.event.slug))}"></div><figcaption>Rösta här</figcaption></figure></div></div>`;
  }

  if (name === 'utmaningar') {
    return `<div class="ptitle">Utmaningar</div><div class="ch-grid">${s.challenges.slice().sort((a, b) => a.sort - b.sort).map(ch => {
      const best = new Map();
      for (const sc of s.scores.filter(x => x.challenge_id === ch.id)) {
        const w = sc.player_id || sc.team_id, v = Number(sc.value);
        if (!best.has(w) || (ch.higher_better ? v > best.get(w) : v < best.get(w))) best.set(w, v);
      }
      const rows = [...best.entries()].sort((a, b) => ch.higher_better ? b[1] - a[1] : a[1] - b[1]).slice(0, 5);
      return `<div><h3>${esc(ch.name)}</h3><table class="sb-t"><tbody>${rows.map(([w, v], i) => `<tr class="${i === 0 ? 'lead' : ''}"><td class="r">${i + 1}</td><td class="n">${esc(names[w] || '?')}</td><td class="p">${v}<span class="m" style="font-size:1vw"> ${esc(ch.unit)}</span></td></tr>`).join('')}</tbody></table></div>`;
    }).join('')}</div>`;
  }
  return '';
}

const joinCodeFor = () => cfg().registration.code || '';

function sbTable(rows, names, { cols = 1 } = {}) {
  const per = Math.ceil(rows.length / cols);
  const parts = Array.from({ length: cols }, (_, i) => rows.slice(i * per, (i + 1) * per));
  return `<div class="sb-groups" style="grid-template-columns:repeat(${cols},1fr)">${parts.map(p => `<table class="sb-t"><tbody>${p.map(r => `<tr class="${r.rank === 1 && r.played ? 'lead' : ''}"><td class="r">${r.rank}</td><td class="n">${esc(names[r.team])}</td><td class="m">${r.played} m</td><td class="m">${r.diff > 0 ? '+' : ''}${r.diff}</td><td class="p">${r.pts ?? r.won}</td></tr>`).join('')}</tbody></table>`).join('')}</div>`;
}

/* ── Lottningsceremonin ────────────────────────────────────────────── */

const DRAW_STEP = 1700;
let drawShown = -1;

function drawBody() {
  const s = st(), c = cfg();
  const d = c.screen.draw;
  const names = nameMap(s);
  const labels = [...new Set((d?.order || []).map(x => x.group))].sort();
  if (!d || !labels.length) return `<div class="ptitle">Lottningen</div><p style="font-size:2vw" class="muted">Startar strax …</p>`;
  const k = Math.max(0, Math.min(d.order.length, Math.floor((Date.now() - new Date(d.at).getTime()) / DRAW_STEP) + 1));
  drawShown = k;
  const perGroup = Math.max(...labels.map(g => d.order.filter(x => x.group === g).length));
  const revealed = d.order.slice(0, k);
  const last = revealed[revealed.length - 1];
  return `<div class="ptitle">Lottningen<small>${k < d.order.length ? `${k} av ${d.order.length} lag` : 'Klart! Lycka till.'}</small></div>
    <div class="draw" style="--g:${labels.length}">${labels.map(g => {
      const inG = revealed.filter(x => x.group === g);
      return `<div><h3>Grupp ${g}</h3>${Array.from({ length: perGroup }, (_, i) => {
        const x = inG[i];
        return `<div class="slot ${x ? 'fill' : ''} ${x && x === last && k < d.order.length + 1 ? 'just' : ''}">${x ? esc(names[x.team] || '') : ''}</div>`;
      }).join('')}</div>`;
    }).join('')}</div>`;
}

/* ── Stora ögonblick ───────────────────────────────────────────────── */

const moments = [];
let momentBusy = false;
function moment(html, ms = 7000) {
  moments.push([html, ms]);
  if (!momentBusy) nextMoment();
}
function nextMoment() {
  const m = moments.shift();
  const el = $('#moment');
  if (!m) { momentBusy = false; return; }
  momentBusy = true;
  el.innerHTML = m[0];
  requestAnimationFrame(() => el.classList.add('on'));
  setTimeout(() => { el.classList.remove('on'); setTimeout(nextMoment, 1000); }, m[1]);
}

function detectMoments() {
  const s = st(), c = cfg();
  const names = nameMap(s);
  const res = resolvedMatches(s);
  for (const m of res) {
    const was = seen.get(m.id);
    seen.set(m.id, m.status);
    if (was === 'done' || m.status !== 'done' || was === undefined) continue;
    const finals = res.filter(x => x.stage === 'A' && !x.bronze);
    const isFinal = finals.length && m.id === finals.find(x => x.round === Math.max(...finals.map(y => y.round)))?.id;
    const w = E.winnerOf(m);
    if (isFinal && w) {
      const champ = sideName(m, w, names);
      // Panchang är bred: ungefär en fontstorlek per tecken. Storleken
      // anpassas så att även långa lagnamn ryms på en rad.
      const fit = Math.min(12, 86 / Math.max(4, champ.length)).toFixed(2);
      moment(`<div style="padding:0 3vw"><div class="sub">${esc(s.event.name)}</div><div class="big" style="font-size:${fit}vw;margin-top:2vw">${esc(champ)}</div><div class="sub">Vinner finalen ${Math.max(m.score_a, m.score_b)}–${Math.min(m.score_a, m.score_b)}</div></div>`, 14000);
    } else if (E.isFanny(m, c)) {
      const loser = w === 'a' ? 'b' : 'a';
      moment(`<div><div class="big">Fanny!</div><div class="sub">${esc(sideName(m, w, names))} vinner ${Math.max(m.score_a, m.score_b)}–0</div><div class="small2">${esc(sideName(m, loser, names))} — ni vet vad som gäller.</div></div>`, 8000);
    }
  }
}

/* ── Uppdateringar ─────────────────────────────────────────────────── */

let lastCfg = '';
async function onData(state, change) {
  if (change.table === 'events') {
    const c = cfg();
    const sig = JSON.stringify([c.voting.reveal, c.screen.pin, c.screen.draw?.at]);
    if (c.voting.reveal) votes = await db.voteResults(st().event.id).catch(() => votes);
    renderTop();
    renderTicker();
    if (sig !== lastCfg) { lastCfg = sig; show(pickPanel(true)); return; }
  }
  if (change.table === 'matches' || change.table === '*') { detectMoments(); renderTicker(); }
  refresh();
}

function tick() {
  renderClock();
  if (current === 'lottning') {
    const d = cfg().screen.draw;
    if (d) {
      const k = Math.floor((Date.now() - new Date(d.at).getTime()) / DRAW_STEP) + 1;
      if (Math.min(k, d.order.length) !== drawShown) refresh();
    }
  }
  if (!paused && !cfg().screen.pin && Date.now() > rotateAt && !momentBusy) {
    const next = pickPanel(false);
    if (next !== current) show(next); else rotateAt = Date.now() + ROTATE_MS;
  }
}

/* ── Styrning ──────────────────────────────────────────────────────── */

addEventListener('keydown', e => {
  if (!live?.state?.event) return;
  const list = panels();
  if (e.key === 'ArrowRight') show(list[(list.indexOf(current) + 1) % list.length]);
  if (e.key === 'ArrowLeft') show(list[(list.indexOf(current) - 1 + list.length) % list.length]);
  if (e.key === ' ') { paused = !paused; e.preventDefault(); }
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.();
  }
});
let mouseT;
addEventListener('mousemove', () => {
  document.body.classList.add('mouse');
  clearTimeout(mouseT);
  mouseT = setTimeout(() => document.body.classList.remove('mouse'), 2500);
});

// Datorn vid tv:n ska inte somna mitt i turneringen
async function keepAwake() {
  try {
    let lock = await navigator.wakeLock?.request('screen');
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible') lock = await navigator.wakeLock?.request('screen').catch(() => null);
    });
  } catch (e) { /* stöds inte — inget att göra */ }
}

boot();
