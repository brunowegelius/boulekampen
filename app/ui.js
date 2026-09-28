/**
 * Gemensamma hjälpare och byggstenar för vyerna: escaping, toast,
 * reveal-animationer, rullande siffror, tabell-, match- och trädrendering.
 * Allt renderas som HTML-strängar — enkelt att läsa och snabbt nog för
 * några hundra rader.
 */
import * as E from './engine.js';
import { mode } from './db.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Delegerade händelser: on(root, 'click', '[data-act]', (e, el) => …) */
export function on(root, type, sel, fn) {
  root.addEventListener(type, e => {
    const el = e.target.closest && e.target.closest(sel);
    if (el && root.contains(el)) fn(e, el);
  });
}

export const params = () => new URLSearchParams(location.search);

/* ── Toast ─────────────────────────────────────────────────────────── */

let toastBox;
export function toast(msg, kind = '') {
  if (!toastBox) {
    toastBox = document.createElement('div');
    toastBox.className = 'toasts';
    toastBox.setAttribute('role', 'status');
    toastBox.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastBox);
  }
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  toastBox.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, kind === 'hi' ? 3600 : 2600);
}

/* ── Dialoger ──────────────────────────────────────────────────────── */

export function dialog(inner, { onOpen } = {}) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'dlg';
    d.innerHTML = inner;
    document.body.appendChild(d);
    d.addEventListener('close', () => { resolve(d.returnValue ? { value: d.returnValue, form: d.querySelector('form') } : null); d.remove(); });
    d.addEventListener('click', e => { if (e.target === d) d.close(''); });
    on(d, 'click', '[data-close]', (e, el) => { e.preventDefault(); d.close(el.dataset.close || ''); });
    d.showModal();
    onOpen && onOpen(d);
  });
}

export async function confirmDlg(title, text, ok = 'OK', { danger = false } = {}) {
  const r = await dialog(`
    <form method="dialog">
      <h2>${esc(title)}</h2>
      ${text ? `<p class="muted">${esc(text)}</p>` : ''}
      <div class="actions">
        <button class="btn ghost" value="" data-close="">Avbryt</button>
        <button class="btn ${danger ? 'danger' : ''}" value="ok">${esc(ok)}</button>
      </div>
    </form>`);
  return !!r;
}

/* ── Reveal vid scroll ─────────────────────────────────────────────── */

let io;
export function reveal(root = document) {
  const els = $$('.rv:not(.in)', root);
  if (!els.length) return;
  if (!('IntersectionObserver' in window) || reduced()) { els.forEach(el => el.classList.add('in')); return; }
  io = io || new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      en.target.classList.add('in');
      io.unobserve(en.target);
    });
  }, { rootMargin: '0px 0px -6% 0px' });
  els.forEach((el, i) => {
    if (!el.style.getPropertyValue('--d')) el.style.setProperty('--d', Math.min(i, 8) * 0.05 + 's');
    io.observe(el);
  });
  // Skyddsnät: inget ska bli hängande osynligt
  setTimeout(() => els.forEach(el => el.classList.add('in')), 1600);
}

/* ── Segmenterade flikar ───────────────────────────────────────────── */

export function segment(seg) {
  if (!seg) return;
  let ind = seg.querySelector('.seg-ind');
  if (!ind) { ind = document.createElement('span'); ind.className = 'seg-ind'; seg.prepend(ind); }
  const cur = seg.querySelector('[aria-selected="true"]');
  if (!cur) { ind.style.width = '0'; return; }
  ind.style.width = cur.offsetWidth + 'px';
  ind.style.transform = `translateX(${cur.offsetLeft}px)`;
}

/* ── FLIP: rader glider till sin nya plats ─────────────────────────── */

export function flip(container, mutate) {
  if (!container || reduced()) { mutate(); return; }
  const before = new Map($$('[data-flip]', container).map(el => [el.dataset.flip, el.getBoundingClientRect().top]));
  mutate();
  $$('[data-flip]', container).forEach(el => {
    const was = before.get(el.dataset.flip);
    if (was == null) return;
    const dy = was - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) return;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 650, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
  });
}

/* ── Rullande siffror ──────────────────────────────────────────────── */

const lastValues = new Map();
/** <span class="roll" data-roll="nyckel">7</span> — rullar när värdet ändrats sedan förra renderingen. */
export function rollNumbers(root = document) {
  $$('.roll[data-roll]', root).forEach(el => {
    const key = el.dataset.roll;
    const val = el.textContent;
    if (!el.firstElementChild) el.innerHTML = `<i>${esc(val)}</i>`;
    const prev = lastValues.get(key);
    lastValues.set(key, val);
    if (prev !== undefined && prev !== val) {
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
    }
  });
}

/* ── QR-koder ──────────────────────────────────────────────────────── */

let qrLib;
function loadQr() {
  if (!qrLib) {
    qrLib = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
      s.onload = () => res(window.qrcode);
      s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  return qrLib;
}
/** Ritar en QR-kod som SVG i el. Mörka moduler i --ink/--bg beroende på bakgrund. */
export async function qr(el, text, { dark = '#093000', light = '#f1ffe7' } = {}) {
  try {
    const q = (await loadQr())(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
    el.innerHTML = `<svg viewBox="0 0 ${n + 4} ${n + 4}" shape-rendering="crispEdges" role="img" aria-label="QR-kod till ${esc(text)}"><rect width="100%" height="100%" fill="${light}" rx="1.5"/><path d="${d}" fill="${dark}"/></svg>`;
  } catch (e) {
    el.innerHTML = `<p class="small muted">${esc(text)}</p>`;
  }
}

/* ── Diverse ───────────────────────────────────────────────────────── */

export function deviceId() {
  try {
    let id = localStorage.getItem('bk-device');
    if (!id) { id = E.uid().replace(/-/g, ''); localStorage.setItem('bk-device', id); }
    return id;
  } catch (e) { return 'anon' + Math.random().toString(36).slice(2, 12); }
}

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key));
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch (e) { return null; }
}

export const slugify = s => String(s || '').toLowerCase()
  .replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/é/g, 'e')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

export function randCode(n = 5) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  return [...buf].map(x => abc[x % abc.length]).join('');
}

export function fmtDate(d, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  if (!d) return '';
  const x = new Date(d + (String(d).length === 10 ? 'T12:00:00' : ''));
  return isNaN(x) ? '' : x.toLocaleDateString('sv-SE', opts);
}

export const kr = n => (Math.round(Number(n) || 0)).toLocaleString('sv-SE') + ' kr';

/** Base-URL till sajtens rot, oavsett vilken undersida vi står på. */
export const siteRoot = () => new URL('../', location.href.split('?')[0].replace(/[^/]*$/, '')).href;
export const pageUrl = (page, slug) => siteRoot() + page + '/' + (slug ? '?e=' + encodeURIComponent(slug) : '');

export function demoBar() {
  if (mode !== 'local') return '';
  return `<div class="demo-bar no-print"><strong>Demoläge.</strong> Allt sparas bara i den här webbläsaren och syns i andra flikar här, men inte på andra enheter.</div>`;
}

/* ══════════════════════════════════════════════════════════════════════
   Delade vyer
   ══════════════════════════════════════════════════════════════════════ */

/** Namnuppslag för lag och spelare. */
export function nameMap(state) {
  const m = {};
  state.teams.forEach(t => { m[t.id] = t.name; });
  state.players.forEach(p => { m[p.id] = p.name; });
  return m;
}

/** Lagets eller mêlée-sidans namn. */
export function sideName(m, side, names) {
  const players = side === 'a' ? m.players_a : m.players_b;
  if (players && players.length) return players.map(id => names[id] || '?').join(' & ');
  const id = side === 'a' ? m.a : m.b;
  if (id) return names[id] || 'Okänt lag';
  const ph = side === 'a' ? m.la : m.lb;
  return ph || (m.bye && side === 'b' ? 'Står över' : '—');
}

export function resolvedMatches(state) {
  return E.resolve(state.event, state.teams, state.matches)
    .sort((a, b) => a.slot - b.slot || (a.court ?? 99) - (b.court ?? 99));
}

export function groupTables(state, resolved) {
  const cfg = E.withDefaults(state.event.config);
  const labels = [...new Set(state.teams.map(t => t.group_label).filter(Boolean))].sort();
  const names = nameMap(state);
  return labels.map(g => {
    const ids = state.teams.filter(t => t.group_label === g).map(t => t.id);
    const ms = resolved.filter(m => m.stage === 'group' && m.group_label === g);
    return { group: g, rows: E.standings(ids, ms, cfg, { names }), done: ms.length > 0 && ms.every(m => m.status === 'done'), total: ms.length, played: ms.filter(m => m.status === 'done').length };
  });
}

/** Sammanlagd tabell — används av startsidans kort och schweizer. */
export function overallTable(state, resolved) {
  const cfg = E.withDefaults(state.event.config);
  const names = nameMap(state);
  const ms = resolved.filter(m => m.stage === 'group' || m.stage === 'swiss');
  return E.standings(state.teams.map(t => t.id), ms, cfg, { tiebreak: cfg.format === 'swiss' ? 'buchholz' : 'none', names });
}

export function standingsTable(rows, names, { toA = 0, toB = 0, mine = null, keyPrefix = '', compact = false, buchholz = false } = {}) {
  if (!rows.length) return `<div class="empty"><strong>Inga lag än</strong>Tabellen fylls i när lagen är lottade.</div>`;
  return `<table class="table${compact ? ' compact' : ''}">
    <thead><tr><th class="sr">Placering</th><th>Lag</th><th title="Spelade">S</th><th title="Vunna">V</th><th title="Förlorade">F</th>${compact ? '' : '<th title="Poängskillnad">+/−</th>'}${buchholz ? '<th title="Buchholz">BH</th>' : ''}<th title="Tabellpoäng">P</th></tr></thead>
    <tbody>${rows.map((r, i) => {
      const cls = [
        i === 0 && r.played ? 'lead' : '',
        toA && i < toA ? 'q' : '',
        (toA && i === toA) || (toB && i === toB) ? 'cut' : '',
        mine && r.team === mine ? 'mine' : '',
      ].join(' ');
      return `<tr class="${cls}" data-flip="${esc(keyPrefix + r.team)}">
        <td class="rank">${r.rank}</td>
        <td class="team"><span class="tname">${esc(names[r.team] || '?')}</span></td>
        <td>${r.played}</td><td>${r.won}</td><td>${r.lost}</td>
        ${compact ? '' : `<td class="diff">${r.diff > 0 ? '+' : ''}${r.diff}</td>`}
        ${buchholz ? `<td class="diff">${r.bh}</td>` : ''}
        <td class="pts"><span class="roll" data-roll="${esc(keyPrefix + r.team)}-p">${r.pts}</span></td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

export function playerTable(rows, names, { mine = null } = {}) {
  if (!rows.length) return `<div class="empty"><strong>Inga spelare än</strong>Tabellen fylls i när första omgången är spelad.</div>`;
  return `<table class="table">
    <thead><tr><th class="sr">Placering</th><th>Spelare</th><th title="Spelade">S</th><th title="Vunna">V</th><th title="Poängskillnad">+/−</th></tr></thead>
    <tbody>${rows.map((r, i) => `<tr class="${i === 0 && r.played ? 'lead' : ''} ${mine === r.player ? 'mine' : ''}" data-flip="${esc(r.player)}">
      <td class="rank">${r.rank}</td>
      <td class="team"><span class="tname">${esc(names[r.player] || '?')}</span></td>
      <td>${r.played}</td>
      <td class="pts"><span class="roll" data-roll="${esc(r.player)}-w">${r.won}</span></td>
      <td class="diff">${r.diff > 0 ? '+' : ''}${r.diff}</td>
    </tr>`).join('')}</tbody></table>`;
}

export function matchRow(m, names, cfg, { mine = null, meta = true, time = true } = {}) {
  const w = E.winnerOf(m);
  const isLive = m.status === 'live';
  const played = m.status !== 'planned';
  const isMine = mine && (m.a === mine || m.b === mine || (m.players_a || []).includes(mine) || (m.players_b || []).includes(mine));
  const cls = (s) => {
    const known = s === 'a' ? (m.a || (m.players_a || []).length) : (m.b || (m.players_b || []).length);
    return ['t', 't' + s, w === s ? 'win' : '', !known ? 'ph' : ''].join(' ');
  };
  const fanny = E.isFanny(m, cfg);
  return `<div class="match ${isLive ? 'live' : ''} ${isMine ? 'mine' : ''}" data-match="${esc(m.id)}">
    <div class="${cls('a')}">${esc(sideName(m, 'a', names))}</div>
    <div class="score">${m.bye ? '<span class="small muted">WO</span>' : played
      ? `<span class="roll" data-roll="${m.id}-a">${m.score_a}</span><span class="sep">–</span><span class="roll" data-roll="${m.id}-b">${m.score_b}</span>`
      : `<span class="faint small">${time ? E.slotTime(cfg, m.slot) : 'mot'}</span>`}</div>
    <div class="${cls('b')}">${esc(sideName(m, 'b', names))}</div>
    ${meta ? `<div class="meta">
      ${isLive ? '<span class="pill hi"><span class="live-dot"></span>Pågår</span>' : ''}
      ${fanny ? '<span class="pill hi">Fanny!</span>' : ''}
      ${m.court ? `<span>Bana ${m.court}</span>` : ''}
      <span>${esc(E.matchTitle(m))}</span>
      ${played && !isLive && time ? `<span>${E.slotTime(cfg, m.slot)}</span>` : ''}
    </div>` : ''}
  </div>`;
}

export function bracket(resolved, names, cfg, stage) {
  const ms = resolved.filter(m => m.stage === stage);
  if (!ms.length) return '';
  const rounds = [...new Set(ms.map(m => m.round))].sort((a, b) => a - b);
  const side = (m, s) => {
    const w = E.winnerOf(m);
    const id = s === 'a' ? m.a : m.b;
    const cls = !id ? 'ph' : w ? (w === s ? 'win' : 'lose') : '';
    const score = m.status === 'planned' ? '' : (s === 'a' ? m.score_a : m.score_b);
    return `<div class="side ${cls}"><span>${esc(sideName(m, s, names))}</span><span class="s">${score}</span></div>`;
  };
  return `<div class="bracket">${rounds.map(r => {
    const col = ms.filter(m => m.round === r).sort((a, b) => (a.bronze ? 1 : 0) - (b.bronze ? 1 : 0));
    const main = col.filter(m => !m.bronze);
    const title = (main[0]?.label || '').replace(/ \d+$/, '').replace(/^B-/, '');
    return `<div class="col">
      <div class="col-title">${esc(title)}</div>
      ${col.map(m => `<div class="bm ${m.status === 'live' ? 'live' : ''} ${!m.bronze && main.length === 1 && r === rounds[rounds.length - 1] ? 'final' : ''} ${m.status === 'done' ? 'done' : ''}">
        ${m.bronze ? '<div class="when" style="padding-top:8px">Bronsmatch</div>' : ''}
        ${side(m, 'a')}${side(m, 'b')}
        <div class="when">${m.court ? 'Bana ' + m.court + ' · ' : ''}${E.slotTime(cfg, m.slot)}</div>
      </div>`).join('')}
    </div>`;
  }).join('')}</div>`;
}

/** Nästa eller pågående match för ett lag/en spelare. */
export function nextFor(resolved, id) {
  const mine = resolved.filter(m => m.a === id || m.b === id || (m.players_a || []).includes(id) || (m.players_b || []).includes(id));
  return mine.find(m => m.status === 'live') || mine.find(m => m.status === 'planned') || null;
}

/** Timer: återstående tid som mm:ss, eller null. */
export function timerLeft(cfg) {
  const t = cfg && cfg.timer;
  if (!t || !t.endsAt) return null;
  const ms = new Date(t.endsAt).getTime() - Date.now();
  const s = Math.max(0, Math.ceil(ms / 1000));
  return { text: String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'), done: s === 0, seconds: s, label: t.label || '' };
}
