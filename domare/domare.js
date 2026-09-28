/**
 * Domarvyn. En telefon per bana: välj bana, för in varje omgång
 * (vilket lag tog poäng och hur många), avsluta matchen.
 *
 * Nät på en boulebana är opålitligt. Varje ändring sparas därför först
 * i en kö i telefonen och skickas sedan. Kön håller bara senaste läget
 * per match — det är hela ställningen som skickas, inte ett tillägg —
 * så ingenting dubbelräknas när den skickas om.
 */
import * as E from '../app/engine.js';
import { db, liveEvent } from '../app/db.js';
import { SITE_EVENT } from '../app/config.js';
import { esc, $, $$, on, toast, dialog, confirmDlg, params, store, demoBar, nameMap, resolvedMatches, sideName, timerLeft, rollNumbers } from '../app/ui.js';

const app = $('#app');
$('#demo').innerHTML = demoBar();
const slug = params().get('e') || SITE_EVENT;

let live, pin, court;
const QKEY = 'bk-queue-' + slug;
let queue = store(QKEY) || {};          // matchId → { patch, base }
let inFlight = false;
let syncState = 'ok';                    // ok | pending | offline

const st = () => live.state;
const cfg = () => E.withDefaults(st().event.config);

async function boot() {
  app.innerHTML = '<div class="center"><p class="muted" style="text-align:center">Laddar …</p></div>';
  try {
    live = await liveEvent(slug, onData);
  } catch (e) {
    app.innerHTML = `<div class="center"><div class="empty"><strong>Kommer inte åt servern</strong>Kolla nätet och ladda om sidan.</div></div>`;
    return;
  }
  if (!st().event) { app.innerHTML = `<div class="center"><div class="empty"><strong>Hittar inte evenemanget</strong>Kolla länken du fått av arrangören.</div></div>`; return; }
  pin = store('bk-pin-' + st().event.id);
  if (pin && !(await safeCheck(pin))) pin = null;
  court = store('bk-court-' + st().event.id);
  render();
  flush();
}

async function safeCheck(p) {
  try { return await db.checkPin(st().event.id, p); }
  catch (e) { return true; } // offline: lita på sparad PIN, servern kontrollerar ändå vid sparning
}

/* Inkommande ändringar från andra enheter */
function onData(state, change) {
  if (change.table === 'matches' && queue[change.row?.id]) {
    // Vi har en egen osparad ändring — den vinner lokalt tills servern svarat
    const mine = state.matches.find(m => m.id === change.row.id);
    if (mine) Object.assign(mine, queue[change.row.id].patch);
  }
  if (sheetOpen) return;
  render();
}

/* ── Rendering ─────────────────────────────────────────────────────── */

function render() {
  if (!st().event) return;
  if (!pin) return renderPin();
  if (st().event.status === 'avslutad') {
    app.innerHTML = `${bar()}<div class="center"><div class="done-box"><h1>Tack!</h1><p class="muted" style="margin-top:12px">Evenemanget är avslutat. Poäng kan inte längre föras in.</p></div></div>`;
    return;
  }
  if (court == null) return renderCourts();
  renderCourt();
}

function bar(title = '') {
  const t = timerLeft(cfg());
  return `<div class="bar">
    <i class="logo" aria-hidden="true"></i>
    <div class="court">${title}</div>
    <div style="text-align:right">
      ${t ? `<div class="timer ${t.done ? 'out' : ''}" data-timer>${t.done ? 'Tiden ute' : t.text}</div>` : ''}
      <div class="sync ${syncState === 'ok' ? 'faint' : ''}" aria-live="polite">${syncState === 'ok' ? 'Synkat' : syncState === 'offline' ? '<span class="pill hi">Inte skickat — försöker igen</span>' : 'Skickar …'}</div>
    </div>
  </div>`;
}

let entered = '';
function renderPin() {
  app.innerHTML = `${bar()}
  <div class="center pin-box">
    <h1>Domare</h1>
    <p class="muted" style="margin-top:8px">${esc(st().event.name)}. Skriv in PIN-koden från arrangören.</p>
    <div class="pin-dots" id="dots">${Array.from({ length: Math.max(4, entered.length) }, (_, i) => `<i class="${i < entered.length ? 'on' : ''}"></i>`).join('')}</div>
    <div class="keypad" role="group" aria-label="Sifferknappar">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-key="${n}">${n}</button>`).join('')}
      <button data-key="del" aria-label="Radera">⌫</button><button data-key="0">0</button><button data-key="ok" aria-label="Logga in" style="background:var(--hi);color:var(--bg)">OK</button>
    </div>
  </div>`;
}
on(app, 'click', '[data-key]', async (e, el) => {
  const k = el.dataset.key;
  if (k === 'del') entered = entered.slice(0, -1);
  else if (k === 'ok') return tryPin();
  else if (entered.length < 8) entered += k;
  renderPin();
  quickPin();
});
addEventListener('keydown', e => {
  if (pin || !st()?.event) return;
  if (/^\d$/.test(e.key)) { if (entered.length < 8) entered += e.key; renderPin(); quickPin(); }
  else if (e.key === 'Backspace') { entered = entered.slice(0, -1); renderPin(); }
  else if (e.key === 'Enter') tryPin();
});
async function quickPin() {
  // Fyrsiffriga PIN-koder släpper in direkt, längre kräver OK
  if (entered.length !== 4) return false;
  if (await db.checkPin(st().event.id, entered).catch(() => false)) { accept(); return true; }
  return false;
}
async function tryPin() {
  if (await db.checkPin(st().event.id, entered).catch(() => false)) return accept();
  const dots = $('#dots');
  dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake');
  entered = '';
  setTimeout(renderPin, 420);
  toast('Fel PIN-kod');
}
function accept() {
  pin = entered; entered = '';
  store('bk-pin-' + st().event.id, pin);
  render();
}

function courtMatches(c) {
  return resolvedMatches(st()).filter(m => !m.bye && (c === 0 || m.court === c));
}

function renderCourts() {
  const c = cfg();
  const res = resolvedMatches(st());
  const used = [...new Set(res.map(m => m.court).filter(Boolean))];
  const courts = Array.from({ length: Math.max(c.courts, ...used, 0) }, (_, i) => i + 1);
  app.innerHTML = `${bar('Välj bana')}
  <p class="muted">Vilken bana dömer du? Du ser då bara matcherna där, i tur och ordning.</p>
  <div class="courts">
    ${courts.map(n => {
      const ms = res.filter(m => m.court === n);
      const livem = ms.find(m => m.status === 'live');
      const left = ms.filter(m => m.status !== 'done').length;
      return `<button data-court="${n}" class="${livem ? 'live' : ''}"><b>${n}</b><span>${livem ? 'Pågår' : left ? left + ' kvar' : ms.length ? 'Klar' : 'Inga matcher'}</span></button>`;
    }).join('')}
    <button data-court="0"><b style="font-size:18px">Alla</b><span>Alla banor</span></button>
  </div>
  <button class="btn ghost sm" style="margin-top:28px;align-self:center" data-act="logout">Logga ut</button>`;
}
on(app, 'click', '[data-court]', (e, el) => {
  court = Number(el.dataset.court);
  store('bk-court-' + st().event.id, court);
  current = null;
  render();
});

let current = null;   // id på vald match i vyn "Alla"

function renderCourt() {
  const c = cfg();
  const names = nameMap(st());
  const ms = courtMatches(court);
  let m = current && ms.find(x => x.id === current);
  if (!m) m = ms.find(x => x.status === 'live') || ms.find(x => x.status === 'planned');
  const title = court ? `Bana ${court} <button data-act="change-court">byt</button>` : `Alla banor <button data-act="change-court">byt</button>`;

  if (!m) {
    app.innerHTML = `${bar(title)}<div class="center"><div class="done-box"><h2>Inga fler matcher här</h2><p class="muted" style="margin-top:10px">${ms.length ? 'Alla matcher på banan är klara. Bra jobbat!' : 'Banan har inga matcher i schemat.'}</p></div></div>`;
    return;
  }

  const upcoming = ms.filter(x => x.status !== 'done' && x.id !== m.id).slice(0, court ? 3 : 20);
  const ready = (m.a || m.players_a?.length) && (m.b || m.players_b?.length);
  const w = m.status === 'done' ? E.winnerOf(m) : null;
  const lead = m.score_a === m.score_b ? null : m.score_a > m.score_b ? 'a' : 'b';
  const ends = m.ends || [];

  app.innerHTML = `${bar(title)}
  <div class="title"><span>${esc(E.matchTitle(m))}${!court && m.court ? ' · bana ' + m.court : ''}</span><span>${E.slotTime(c, m.slot)} · till ${c.target}</span></div>
  ${!ready ? `<div class="empty" style="margin-bottom:12px"><strong>Väntar på lag</strong>${esc(sideName(m, 'a', names))} mot ${esc(sideName(m, 'b', names))}. Lagen fylls i när matcherna före är klara.</div>` : ''}
  <div class="board">
    ${['a', 'b'].map(s => `<button class="half ${lead === s && m.status !== 'done' ? 'lead' : ''} ${w === s ? 'win' : ''}" data-side="${s}" ${!ready || m.status === 'done' ? 'disabled' : ''} aria-label="Poäng till ${esc(sideName(m, s, names))}">
      <span class="tn">${esc(sideName(m, s, names))}</span>
      <span class="big"><span class="roll" data-roll="d-${m.id}-${s}">${s === 'a' ? m.score_a : m.score_b}</span></span>
      <span class="hint">${m.status === 'done' ? (w === s ? 'Vinnare' : '') : 'Tryck när laget tar poäng'}</span>
    </button>`).join('')}
  </div>
  <div class="ends" aria-label="Omgångar">${ends.map((e, i) => `<span class="end-chip">${i + 1}: <b>${e.p}</b> ${esc(shortName(sideName(m, e.s, names)))}</span>`).join('') || '<span class="small faint" style="padding:6px 0">Omgångarna visas här.</span>'}</div>
  <div class="tools">
    ${m.status === 'done'
      ? `<button class="btn ghost" data-act="reopen" data-id="${m.id}">Ändra resultatet</button>`
      : `<button class="btn quiet" data-act="undo" data-id="${m.id}" ${ends.length ? '' : 'disabled'}>Ångra senaste</button>
         <button class="btn quiet" data-act="manual" data-id="${m.id}" ${ready ? '' : 'disabled'}>Skriv in slutresultat</button>
         <button class="btn" data-act="finish" data-id="${m.id}" ${ready && m.score_a !== m.score_b ? '' : 'disabled'}>Avsluta match</button>`}
  </div>
  ${upcoming.length ? `<div class="next-list"><h3>${court ? 'Sedan på banan' : 'Välj match'}</h3>
    ${upcoming.map(x => `<button class="match" style="width:100%;text-align:inherit" data-pick="${x.id}">
      <div class="t ta">${esc(sideName(x, 'a', names))}</div>
      <div class="score"><span class="faint small">${x.status === 'live' ? x.score_a + '–' + x.score_b : E.slotTime(c, x.slot)}</span></div>
      <div class="t tb">${esc(sideName(x, 'b', names))}</div>
    </button>`).join('')}</div>` : ''}`;
  rollNumbers(app);
}

const shortName = n => n.length > 14 ? n.slice(0, 13) + '…' : n;

on(app, 'click', '[data-pick]', (e, el) => { current = el.dataset.pick; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

/* ── Poängväljaren ─────────────────────────────────────────────────── */

let sheetOpen = null;   // { matchId, side }
const sheet = $('#sheet'), sheetBg = $('#sheet-bg');

function openSheet(matchId, side) {
  const m = resolvedMatches(st()).find(x => x.id === matchId);
  sheetOpen = { matchId, side };
  $('#sheet-title').textContent = sideName(m, side, nameMap(st()));
  sheet.hidden = false; sheetBg.hidden = false;
  requestAnimationFrame(() => { sheet.classList.add('open'); sheetBg.classList.add('open'); });
  sheet.querySelector('[data-p="1"]').focus();
}
function closeSheet() {
  sheet.classList.remove('open'); sheetBg.classList.remove('open');
  setTimeout(() => { sheet.hidden = true; sheetBg.hidden = true; }, 380);
  sheetOpen = null;
  render();
}
on(app, 'click', '[data-side]', (e, el) => {
  const id = currentShown();
  if (id) openSheet(id, el.dataset.side);
});
sheetBg.addEventListener('click', closeSheet);
on(sheet, 'click', '[data-sheet-close]', closeSheet);
addEventListener('keydown', e => {
  if (!sheetOpen) return;
  if (e.key === 'Escape') closeSheet();
  if (/^[1-6]$/.test(e.key)) addEnd(Number(e.key));
});
on(sheet, 'click', '[data-p]', (e, el) => addEnd(Number(el.dataset.p)));

function currentShown() {
  const ms = courtMatches(court);
  let m = current && ms.find(x => x.id === current);
  if (!m) m = ms.find(x => x.status === 'live') || ms.find(x => x.status === 'planned');
  return m && m.id;
}

async function addEnd(p) {
  if (!sheetOpen) return;
  const { matchId, side } = sheetOpen;
  const m = st().matches.find(x => x.id === matchId);
  const ends = [...(m.ends || []), { s: side, p }];
  const sum = E.sumEnds(ends);
  sheetOpen = null;
  sheet.classList.remove('open'); sheetBg.classList.remove('open');
  setTimeout(() => { sheet.hidden = true; sheetBg.hidden = true; }, 380);
  if (navigator.vibrate) navigator.vibrate(18);
  update(matchId, { ends, score_a: sum.a, score_b: sum.b, status: 'live' });
  current = matchId;
  render();
  const half = $(`[data-side="${side}"]`);
  if (half) { half.classList.remove('flash'); void half.offsetWidth; half.classList.add('flash'); }
  const target = cfg().target;
  if (sum.a >= target || sum.b >= target) {
    const names = nameMap(st());
    const res = resolvedMatches(st()).find(x => x.id === matchId);
    const winSide = sum.a > sum.b ? 'a' : 'b';
    const fanny = Math.min(sum.a, sum.b) === 0;
    if (await confirmDlg(`${sideName(res, winSide, names)} vinner ${Math.max(sum.a, sum.b)}–${Math.min(sum.a, sum.b)}${fanny ? ' — fanny!' : ''}`, 'Avsluta matchen och skicka resultatet?', 'Avsluta match')) finish(matchId);
  }
}

/* ── Åtgärder ──────────────────────────────────────────────────────── */

const A = {
  'change-court'() { court = null; store('bk-court-' + st().event.id, null); render(); },
  logout() { pin = null; store('bk-pin-' + st().event.id, null); render(); },
  undo(el) {
    const m = st().matches.find(x => x.id === el.dataset.id);
    const ends = (m.ends || []).slice(0, -1);
    const s = E.sumEnds(ends);
    update(m.id, { ends, score_a: s.a, score_b: s.b, status: ends.length ? 'live' : 'planned' });
    render();
  },
  async finish(el) {
    const m = st().matches.find(x => x.id === el.dataset.id);
    const t = cfg().target;
    if (Math.max(m.score_a, m.score_b) < t && !(await confirmDlg(`Avsluta på ${m.score_a}–${m.score_b}?`, `Ingen har nått ${t} än. Gör det bara om tiden är ute.`, 'Avsluta match'))) return;
    finish(m.id);
  },
  async reopen(el) {
    if (!(await confirmDlg('Ändra resultatet?', 'Matchen öppnas igen. Tabellen och slutspelet räknas om när du avslutar på nytt.', 'Öppna matchen'))) return;
    const m = st().matches.find(x => x.id === el.dataset.id);
    update(m.id, { ...pick(m), status: 'live' });
    current = m.id;
    render();
  },
  async manual(el) {
    const m = resolvedMatches(st()).find(x => x.id === el.dataset.id);
    const names = nameMap(st());
    const r = await dialog(`<form method="dialog" class="stack">
      <h2>Slutresultat</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <label class="field"><span>${esc(sideName(m, 'a', names))}</span><input name="a" type="number" min="0" max="99" inputmode="numeric" value="${m.score_a}" required></label>
        <label class="field"><span>${esc(sideName(m, 'b', names))}</span><input name="b" type="number" min="0" max="99" inputmode="numeric" value="${m.score_b}" required></label>
      </div>
      <div class="actions"><button class="btn ghost" data-close="">Avbryt</button><button class="btn" value="ok">Spara och avsluta</button></div>
    </form>`);
    if (!r) return;
    const a = Number(r.form.a.value) || 0, b = Number(r.form.b.value) || 0;
    if (a === b && !['group', 'swiss', 'melee'].includes(m.stage)) { toast('Slutspelsmatcher kan inte sluta lika'); return; }
    update(m.id, { ends: [], score_a: a, score_b: b, status: 'done' });
    current = null;
    toast('Resultatet är sparat', 'hi');
    render();
  },
};
on(app, 'click', '[data-act]', (e, el) => { const f = A[el.dataset.act]; if (f) { e.preventDefault(); f(el); } });

function pick(m) { return { ends: m.ends || [], score_a: m.score_a, score_b: m.score_b }; }

function finish(id) {
  const m = st().matches.find(x => x.id === id);
  if (m.score_a === m.score_b && !['group', 'swiss', 'melee'].includes(m.stage)) { toast('Slutspelsmatcher kan inte sluta lika'); return; }
  update(id, { ...pick(m), status: 'done' });
  current = null;
  toast('Matchen är klar — resultatet är skickat', 'hi');
  render();
}

/* ── Kö och synk ───────────────────────────────────────────────────── */

function update(id, patch) {
  const m = st().matches.find(x => x.id === id);
  const base = queue[id] ? queue[id].base : m.version;
  Object.assign(m, patch);
  queue[id] = { patch: { ...pick(m), status: m.status }, base };
  store(QKEY, queue);
  syncState = 'pending';
  flush();
}

async function flush() {
  if (inFlight) return;
  const ids = Object.keys(queue);
  if (!ids.length) { setSync('ok'); return; }
  inFlight = true;
  const id = ids[0];
  const job = queue[id];
  try {
    const r = await db.scoreMatch(st().event.id, pin, id, job.patch, job.base);
    if (r.ok) {
      // Kom en ny ändring under tiden bygger den vidare på den nya versionen
      if (queue[id] === job) delete queue[id];
      else queue[id].base = r.row.version;
      const m = st().matches.find(x => x.id === id);
      if (m) m.version = r.row.version;
    } else if (r.error === 'conflict') {
      inFlight = false;
      await conflict(id, r.row);
      return flush();
    } else if (r.error === 'pin') {
      delete queue[id];
      pin = null; store('bk-pin-' + st().event.id, null);
      toast('PIN-koden har ändrats. Logga in igen.');
    } else {
      delete queue[id];
      toast('Servern tog inte emot ändringen');
    }
    store(QKEY, queue);
    inFlight = false;
    setSync(Object.keys(queue).length ? 'pending' : 'ok');
    if (Object.keys(queue).length) flush();
    else render();
  } catch (e) {
    inFlight = false;
    setSync('offline');
    setTimeout(flush, 4000);
  }
}

async function conflict(id, row) {
  const names = nameMap(st());
  const job = queue[id];
  const m = resolvedMatches(st()).find(x => x.id === id);
  const keepMine = await confirmDlg(
    'Matchen ändrades på en annan telefon',
    `Där: ${row.score_a}–${row.score_b}. Här: ${job.patch.score_a}–${job.patch.score_b} (${sideName(m, 'a', names)} mot ${sideName(m, 'b', names)}). Vilket stämmer?`,
    `Behåll ${job.patch.score_a}–${job.patch.score_b}`,
  );
  const local = st().matches.find(x => x.id === id);
  if (keepMine) queue[id].base = row.version;
  else { delete queue[id]; Object.assign(local, row); }
  store(QKEY, queue);
}

function setSync(s) {
  syncState = s;
  const el = $('.sync');
  if (el) el.outerHTML = `<div class="sync ${s === 'ok' ? 'faint' : ''}" aria-live="polite">${s === 'ok' ? 'Synkat' : s === 'offline' ? '<span class="pill hi">Inte skickat — försöker igen</span>' : 'Skickar …'}</div>`;
}
addEventListener('online', flush);

setInterval(() => {
  const el = $('[data-timer]');
  if (!el || !live?.state?.event) return;
  const t = timerLeft(cfg());
  if (!t) { el.remove(); return; }
  el.textContent = t.done ? 'Tiden ute' : t.text;
  el.classList.toggle('out', t.done);
  if (t.done && !el.dataset.told) { el.dataset.told = '1'; toast('Tiden är ute — spela klart omgången plus en till', 'hi'); }
}, 1000);

boot();
