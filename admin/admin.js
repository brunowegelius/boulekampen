/**
 * Arrangörsvyn. Hanterar evenemang (turneringen och företagsevent) och
 * företagsbokningar. Rutter i hashen:
 *   #/                      hem
 *   #/e/<slug>/<flik>       ett evenemang
 *   #/b/<id>/<flik>         en bokning
 */
import * as E from '../app/engine.js';
import { db, mode, liveEvent } from '../app/db.js';
import {
  esc, $, $$, on, toast, dialog, confirmDlg, reveal, segment, rollNumbers, qr, store,
  slugify, randCode, fmtDate, kr, pageUrl, demoBar, nameMap, resolvedMatches, groupTables,
  overallTable, standingsTable, playerTable, matchRow, bracket, sideName, timerLeft,
} from '../app/ui.js';

const app = $('#app');
const S = {
  session: null,
  events: [],
  bookings: [],
  live: null,          // liveEvent-handtag för öppet evenemang
  liveSlug: null,
  hasPin: false,
  votes: [],
  pricelist: null,
  pending: false,
};

/* ══════════════════════════════════════════════════════════════════════
   Uppstart och rutter
   ══════════════════════════════════════════════════════════════════════ */

$('#demo').innerHTML = demoBar();

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (parts[0] === 'e' && parts[1]) return { view: 'event', slug: parts[1], tab: parts[2] || 'oversikt' };
  if (parts[0] === 'b' && parts[1]) return { view: 'booking', id: parts[1], tab: parts[2] || 'uppgifter' };
  return { view: 'home' };
}
const go = hash => { if (location.hash !== hash) location.hash = hash; else render(); };

async function boot() {
  S.session = await db.session();
  if (mode === 'cloud' && S.session && !(await db.isAdmin())) {
    app.innerHTML = `<div class="login"><i class="logo" aria-hidden="true"></i>
      <h2>Inget arrangörskonto</h2>
      <p class="muted" style="margin-top:12px">${esc(S.session.email)} finns inte bland arrangörerna. Be någon som redan är arrangör lägga till adressen i tabellen admins.</p>
      <button class="btn ghost" style="margin-top:24px" data-act="signout">Logga ut</button></div>`;
    return;
  }
  if (!S.session) return renderLogin();
  $('#who').innerHTML = mode === 'cloud'
    ? `<span class="small muted" style="display:none">${esc(S.session.email)}</span><button class="btn ghost sm" data-act="signout">Logga ut</button>`
    : '';
  await loadHome();
  render();
  addEventListener('hashchange', render);
}

function renderLogin() {
  app.innerHTML = `<div class="login rv">
    <i class="logo" aria-hidden="true"></i>
    <h2>Logga in som arrangör</h2>
    <p class="muted" style="margin-top:10px">Du får en inloggningslänk till din mejl.</p>
    <form id="login">
      <label class="field"><span>E-post</span><input type="email" name="email" required autocomplete="email"></label>
      <button class="btn lg">Skicka länk</button>
    </form>
  </div>`;
  reveal(app);
  $('#login').addEventListener('submit', async e => {
    e.preventDefault();
    const email = new FormData(e.target).get('email');
    try {
      await db.signIn(email);
      e.target.innerHTML = `<p style="text-align:center">Kolla mejlen — länken loggar in dig här.</p>`;
    } catch (err) { toast(err.message); }
  });
}
db.onAuth(() => { if (!S.session) boot(); });

async function loadHome() {
  const [events, bookings, pricelist] = await Promise.all([db.events.list(), db.bookings.list(), db.setting('pricelist')]);
  S.events = events;
  S.bookings = bookings.sort((a, b) => String(a.date || '9').localeCompare(String(b.date || '9')));
  S.pricelist = pricelist || DEFAULT_PRICELIST;
}

/* Rendera inte om medan någon skriver i ett fält — vänta tills fokus lämnar. */
function requestRender() {
  const a = document.activeElement;
  if (a && app.contains(a) && a.matches('input, textarea, select')) { S.pending = true; return; }
  render();
}
app.addEventListener('focusout', () => setTimeout(() => {
  const a = document.activeElement;
  if (S.pending && !(a && app.contains(a) && a.matches('input, textarea, select'))) { S.pending = false; render(); }
}, 30));

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const r = route();
  if (r.view !== 'event' && S.live) { S.live.stop(); S.live = null; S.liveSlug = null; }
  try {
    if (r.view === 'home') { crumbs([]); app.innerHTML = homeView(); }
    else if (r.view === 'event') {
      if (S.liveSlug !== r.slug) await openEvent(r.slug);
      if (seq !== renderSeq) return;
      if (!S.live || !S.live.state.event) { app.innerHTML = notFound('Evenemanget finns inte.'); return; }
      crumbs([[S.live.state.event.name]]);
      app.innerHTML = eventView(r.tab);
    } else if (r.view === 'booking') {
      const b = S.bookings.find(x => x.id === r.id);
      if (!b) { app.innerHTML = notFound('Bokningen finns inte.'); return; }
      crumbs([[b.company || 'Ny bokning']]);
      app.innerHTML = bookingView(b, r.tab);
    }
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="empty"><strong>Något gick fel</strong>${esc(err.message)}</div>`;
  }
  afterRender();
}

function afterRender() {
  reveal(app);
  $$('.seg', app).forEach(segment);
  rollNumbers(app);
  $$('[data-qr]', app).forEach(el => qr(el, el.dataset.qr));
}
addEventListener('resize', () => $$('.seg', app).forEach(segment));

function crumbs(list) {
  $('#crumbs').innerHTML = list.length ? `<a href="#/">Översikt</a><span aria-hidden="true">/</span>` + list.map(([t]) => `<b>${esc(t)}</b>`).join('') : '';
}
const notFound = msg => `<div class="empty"><strong>${esc(msg)}</strong><a class="btn ghost" style="margin-top:14px" href="#/">Till översikten</a></div>`;

async function openEvent(slug) {
  if (S.live) S.live.stop();
  S.liveSlug = slug;
  S.live = await liveEvent(slug, () => requestRender(), { withPrivate: true });
  const ev = S.live.state.event;
  if (ev) {
    [S.hasPin, S.votes] = await Promise.all([db.hasPin(ev.id), db.voteResults(ev.id, true)]);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   Hem
   ══════════════════════════════════════════════════════════════════════ */

const STATUS = { utkast: 'Planeras', pagar: 'Pågår', avslutad: 'Avslutad' };
const BSTATUS = [
  ['forfragan', 'Förfrågan'], ['offert', 'Offert skickad'], ['bekraftad', 'Bekräftad'],
  ['genomford', 'Genomförd'], ['fakturerad', 'Fakturerad'], ['tappad', 'Blev inte av'],
];

function homeView() {
  const evs = S.events;
  const eventRows = evs.length ? evs.map(e => `
    <a class="list-row rv" href="#/e/${encodeURIComponent(e.slug)}">
      <span class="name">${esc(e.name)}</span>
      <span class="meta"><span>${e.kind === 'foretag' ? 'Företag' : 'Turnering'}</span><span>${esc(fmtDate(e.date, { day: 'numeric', month: 'short', year: 'numeric' }) || 'Inget datum')}</span><span>${STATUS[e.status] || ''}</span></span>
      <svg class="go" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
    </a>`).join('') : `<div class="empty rv"><strong>Inga evenemang</strong>Skapa turneringen eller ett företagsevent.</div>`;

  const lanes = BSTATUS.filter(([k]) => k !== 'tappad' || S.bookings.some(b => b.status === 'tappad')).map(([k, label]) => {
    const list = S.bookings.filter(b => b.status === k);
    return `<div class="lane rv"><h3><span>${label}</span><span>${list.length || ''}</span></h3>
      ${list.map(b => `<a class="card" href="#/b/${b.id}"><b>${esc(b.company || 'Namnlös')}</b><span>${esc(fmtDate(b.date) || 'Datum ej satt')}${b.participants ? ' · ' + b.participants + ' pers' : ''}</span></a>`).join('') || '<div class="none">Inget här</div>'}
    </div>`;
  }).join('');

  return `
  <div class="hero rv">
    <div><h1>Poäng, lag och bokningar</h1>
    <p class="sub"><span>Allt som behövs på plats — från lottning till prisutdelning.</span></p></div>
  </div>
  <div class="home-grid">
    <section>
      <div class="panel-head"><h2>Evenemang</h2>
        <div class="row">
          ${mode === 'local' ? '<button class="btn ghost sm" data-act="demo-data">Skapa testturnering</button>' : ''}
          <button class="btn sm" data-act="new-event">Nytt evenemang</button>
        </div>
      </div>
      ${eventRows}
    </section>
    <section>
      <div class="panel-head"><h2>Företagsbokningar</h2>
        <div class="row"><button class="btn ghost sm" data-act="pricelist">Prislista</button><button class="btn sm" data-act="new-booking">Ny bokning</button></div>
      </div>
      <div class="pipeline">${lanes}</div>
    </section>
  </div>`;
}

/* ══════════════════════════════════════════════════════════════════════
   Evenemang
   ══════════════════════════════════════════════════════════════════════ */

const TABS = [
  ['oversikt', 'Översikt'], ['lag', 'Lag'], ['upplagg', 'Upplägg'], ['matcher', 'Matcher'],
  ['tabell', 'Tabell'], ['extra', 'Röstning & utmaningar'], ['efterat', 'Efteråt'], ['installningar', 'Inställningar'],
];

const st = () => S.live.state;
const cfg = () => E.withDefaults(st().event.config);

function eventView(tab) {
  const ev = st().event;
  const c = cfg();
  const tabs = TABS.map(([k, label]) => {
    if (k === 'lag' && c.format === 'melee') label = 'Deltagare';
    return `<button role="tab" aria-selected="${k === tab}" data-tab="${k}">${label}</button>`;
  }).join('');
  const body = {
    oversikt: tabOverview, lag: tabTeams, upplagg: tabFormat, matcher: tabMatches,
    tabell: tabTables, extra: tabExtra, efterat: tabAfter, installningar: tabSettings,
  }[tab] || tabOverview;
  return `
  <div class="hero rv">
    <div>
      <h1>${esc(ev.name)}</h1>
      <p class="sub">
        <span>${esc(fmtDate(ev.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) || 'Datum ej satt')}</span>
        ${ev.venue ? `<span>${esc(ev.venue)}</span>` : ''}
        ${c.company.name ? `<span>${esc(c.company.name)}</span>` : ''}
        <span class="pill ${ev.status === 'pagar' ? 'hi' : 'line'}">${ev.status === 'pagar' ? '<span class="live-dot"></span>' : ''}${STATUS[ev.status]}</span>
      </p>
    </div>
    <div class="row">
      <a class="btn ghost sm" href="${pageUrl('live', ev.slug)}" target="_blank" rel="noopener">Livesidan</a>
      <a class="btn ghost sm" href="${pageUrl('storbild', ev.slug)}" target="_blank" rel="noopener">Storbilden</a>
    </div>
  </div>
  <div class="tabs-wrap"><div class="seg" role="tablist" aria-label="Delar av evenemanget">${tabs}</div></div>
  <div id="tab">${body()}</div>`;
}

on(app, 'click', '[data-tab]', (e, el) => {
  const r = route();
  const base = r.view === 'event' ? `#/e/${encodeURIComponent(r.slug)}/` : `#/b/${encodeURIComponent(r.id)}/`;
  go(base + el.dataset.tab);
});

/* ── Översikt ──────────────────────────────────────────────────────── */

function tabOverview() {
  const s = st(), ev = s.event, c = cfg();
  const res = resolvedMatches(s);
  const real = res.filter(m => !m.bye);
  const done = real.filter(m => m.status === 'done').length;
  const live = real.filter(m => m.status === 'live');
  const nextSlot = real.find(m => m.status !== 'done');
  const names = nameMap(s);
  const t = timerLeft(c);
  const lastSlot = Math.max(-1, ...res.map(m => m.slot));
  const plannedEnd = lastSlot >= 0 ? E.slotTime(c, lastSlot + 1) : null;

  const links = [
    ['Livesidan', 'För deltagare och publik. Tabell, matcher och mitt lag.', pageUrl('live', ev.slug)],
    ['Domarvyn', 'Banvärdarna för in poäng här. Kräver domar-PIN.', pageUrl('domare', ev.slug)],
    ['Storbilden', 'Öppna på tv:n eller projektorn. F = helskärm.', pageUrl('storbild', ev.slug)],
  ];
  if (ev.kind === 'foretag' && c.registration.code) {
    links.unshift(['Anmälan', 'Deltagarna skannar och skriver in sig själva.', pageUrl('delta') + '?k=' + c.registration.code]);
  }

  return `<div class="ov">
    <div class="stack">
      <section class="panel rv">
        <div class="bigstats">
          <div><span class="num">${s.teams.length || s.players.length}</span><span>${c.format === 'melee' ? 'spelare' : 'lag'}</span></div>
          <div><span class="num"><span class="roll" data-roll="ov-done">${done}</span>/${real.length}</span><span>matcher klara</span></div>
          <div><span class="num">${live.length}</span><span>pågår nu</span></div>
          <div><span class="num">${plannedEnd || '—'}</span><span>beräknat slut</span></div>
        </div>
        <div class="progress"><i style="width:${real.length ? (done / real.length) * 100 : 0}%"></i></div>
      </section>

      <section class="panel rv">
        <div class="panel-head"><h2>Just nu</h2>
          <div class="row">
            <span class="small muted">Schemat ${c.delay ? (c.delay > 0 ? 'förskjutet +' : 'tidigarelagt ') + c.delay + ' min' : 'följer planen'}</span>
            <button class="btn quiet sm" data-act="delay" data-v="-5" aria-label="Fem minuter tidigare">−5</button>
            <button class="btn quiet sm" data-act="delay" data-v="5" aria-label="Fem minuter senare">+5</button>
            <button class="btn quiet sm" data-act="delay" data-v="15" aria-label="Kvart senare">+15</button>
          </div>
        </div>
        ${live.length ? live.map(m => matchRow(m, names, c)).join('') : `<p class="muted">Ingen match pågår.</p>`}
        ${nextSlot && !live.length ? `<p class="small muted" style="margin-top:10px">Nästa pass börjar ${E.slotTime(c, nextSlot.slot)}.</p>` : ''}
        ${!res.length ? `<p class="small" style="margin-top:12px"><a href="#/e/${encodeURIComponent(ev.slug)}/upplagg">Skapa spelschemat under Upplägg.</a></p>` : ''}
      </section>

      <section class="panel rv">
        <div class="panel-head"><h2>Utrop</h2><span class="small muted">Syns på storbilden och livesidan</span></div>
        <form class="row" data-form="announce" style="flex-wrap:nowrap">
          <input class="input" name="text" maxlength="140" placeholder="Lunchen serveras vid klubbhuset!" value="${esc(c.announcement)}">
          <button class="btn">Visa</button>
          ${c.announcement ? '<button class="btn ghost" type="button" data-act="announce-clear">Ta bort</button>' : ''}
        </form>
      </section>

      <section class="panel rv">
        <div class="panel-head"><h2>Klocka</h2>${t && !t.done ? `<span class="num" style="font-size:28px;color:var(--hi)" data-timer>${t.text}</span>` : ''}</div>
        <p class="small muted" style="margin-bottom:12px">Nedräkning på storbilden och i domarvyn. När tiden är ute spelas pågående omgång klart plus en till.</p>
        <div class="row">
          ${[c.matchMin, 30, 15, 5].filter((v, i, a) => a.indexOf(v) === i).map(m => `<button class="btn quiet sm" data-act="timer" data-v="${m}">${m} min</button>`).join('')}
          ${t ? '<button class="btn ghost sm" data-act="timer-stop">Stoppa</button>' : ''}
        </div>
      </section>
    </div>

    <div class="stack">
      <section class="panel rv">
        <div class="panel-head"><h2>Läge</h2></div>
        <div class="seg" role="tablist" aria-label="Evenemangets läge">
          ${Object.entries(STATUS).map(([k, v]) => `<button role="tab" aria-selected="${ev.status === k}" data-act="status" data-v="${k}">${v}</button>`).join('')}
        </div>
      </section>

      <section class="panel rv">
        <div class="panel-head"><h2>Länkar</h2></div>
        <div class="links">${links.map(([title, desc, url]) => `
          <div class="link-card">
            <div class="qr" data-qr="${esc(url)}"></div>
            <div><b>${title}</b><div class="small muted">${desc}</div>
              <div class="row"><button class="btn quiet sm" data-act="copy" data-v="${esc(url)}">Kopiera</button><a class="btn quiet sm" href="${esc(url)}" target="_blank" rel="noopener">Öppna</a></div>
            </div>
          </div>`).join('')}</div>
      </section>

      <section class="panel rv">
        <div class="panel-head"><h2>Domar-PIN</h2><span class="pill ${S.hasPin ? 'line' : 'hi'}">${S.hasPin ? 'Satt' : 'Saknas'}</span></div>
        <p class="small muted" style="margin-bottom:12px">Alla som ska föra in poäng behöver den. Byt den efter eventet.</p>
        <form class="row" data-form="pin" style="flex-wrap:nowrap">
          <input class="input" name="pin" inputmode="numeric" pattern="[0-9]{4,8}" minlength="4" maxlength="8" placeholder="4–8 siffror" autocomplete="off" required>
          <button class="btn">Spara</button>
        </form>
      </section>

      <section class="panel rv">
        <div class="panel-head"><h2>Storbilden visar</h2></div>
        <label class="field"><span>Låt den rotera eller lås en vy</span>
          <select class="input" data-act-change="screen-pin">
            ${[['', 'Roterar automatiskt'], ['tabell', 'Tabell'], ['matcher', 'Matcher och banor'], ['slutspel', 'Slutspel'], ['resultat', 'Senaste resultat'], ['valkommen', 'Välkommen + QR'], ['lottning', 'Lottningen'], ['rostning', 'Röstning'], ['utmaningar', 'Utmaningar']]
              .map(([k, v]) => `<option value="${k}" ${String(c.screen.pin || '') === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </label>
      </section>
    </div>
  </div>`;
}

/* ── Lag och deltagare ─────────────────────────────────────────────── */

function tabTeams() {
  const s = st(), c = cfg();
  const showPlayers = c.format === 'melee' || s.event.kind === 'foretag';
  const showTeams = c.format !== 'melee';
  return `${showPlayers ? playersPanel() : ''}${showTeams ? teamsPanel() : ''}`;
}

function teamsPanel() {
  const s = st(), c = cfg();
  const priv = Object.fromEntries(s.teamPrivate.map(p => [p.team_id, p]));
  const labels = Array.from({ length: Math.max(c.groups.count, 1) }, (_, i) => E.groupLabel(i));
  const teams = s.teams.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name, 'sv'));
  const checked = teams.filter(t => t.checked_in).length;
  const paid = teams.filter(t => priv[t.id]?.paid).length;
  const kind = s.event.kind;
  return `<section class="panel rv">
    <div class="panel-head">
      <div><h2>Lag</h2><p class="small muted" style="margin-top:6px">${teams.length} lag · ${checked} incheckade${kind === 'turnering' ? ` · ${paid} betalda` : ''}</p></div>
      <div class="row">
        ${kind === 'turnering' ? '<button class="btn ghost sm" data-act="import">Importera anmälningar</button>' : ''}
        <button class="btn sm" data-act="add-team">Lägg till lag</button>
      </div>
    </div>
    ${teams.length ? `<div class="scroll-x"><table class="ed-table">
      <thead><tr><th>Lag</th><th>Spelare</th>${c.format === 'groups' ? '<th>Grupp</th>' : ''}<th title="Seedade lag hamnar i olika grupper. 1 = högst.">Seed</th><th>Utklädnad</th><th>Incheckat</th>${kind === 'turnering' ? '<th>Betalt</th><th>Lagkapten</th>' : ''}<th class="sr">Ta bort</th></tr></thead>
      <tbody>${teams.map(t => `<tr>
        <td class="w-name"><input class="input" data-team="${t.id}" data-f="name" value="${esc(t.name)}" aria-label="Lagnamn"></td>
        <td style="min-width:200px"><input class="input" data-team="${t.id}" data-f="members" value="${esc((t.members || []).join(', '))}" placeholder="Namn, namn, …" aria-label="Spelare"></td>
        ${c.format === 'groups' ? `<td><select class="input w-sm" data-team="${t.id}" data-f="group_label" aria-label="Grupp"><option value="">–</option>${labels.map(g => `<option ${t.group_label === g ? 'selected' : ''}>${g}</option>`).join('')}</select></td>` : ''}
        <td><input class="input w-sm" type="number" min="0" max="99" data-team="${t.id}" data-f="seed" value="${t.seed || ''}" aria-label="Seedning"></td>
        <td style="min-width:150px"><input class="input" data-team="${t.id}" data-f="costume" value="${esc(t.costume || '')}" placeholder="Temat" aria-label="Utklädnad"></td>
        <td><label class="check"><input type="checkbox" data-team="${t.id}" data-f="checked_in" ${t.checked_in ? 'checked' : ''}><span class="box"></span><span class="sr">Incheckat</span></label></td>
        ${kind === 'turnering' ? `
        <td><label class="check"><input type="checkbox" data-tp="${t.id}" data-f="paid" ${priv[t.id]?.paid ? 'checked' : ''}><span class="box"></span><span class="sr">Betalt</span></label></td>
        <td style="min-width:220px"><input class="input" data-tp="${t.id}" data-f="contact" value="${esc([priv[t.id]?.contact_name, priv[t.id]?.phone].filter(Boolean).join(', '))}" placeholder="Namn, telefon" aria-label="Lagkapten"></td>` : ''}
        <td><button class="icon-btn" data-act="del-team" data-id="${t.id}" aria-label="Ta bort ${esc(t.name)}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></td>
      </tr>`).join('')}</tbody></table></div>`
    : `<div class="empty"><strong>Inga lag än</strong>${kind === 'turnering' ? 'Importera anmälningarna från Google-formuläret eller lägg till lag för hand.' : 'Skapa lag av deltagarna ovan, eller lägg till lag för hand.'}</div>`}
  </section>`;
}

function playersPanel() {
  const s = st(), c = cfg();
  const priv = Object.fromEntries(s.playerPrivate.map(p => [p.player_id, p]));
  const players = s.players.slice().sort((a, b) => a.name.localeCompare(b.name, 'sv'));
  const teams = s.teams.slice().sort((a, b) => a.name.localeCompare(b.name, 'sv'));
  const diets = players.filter(p => priv[p.id]?.diet);
  const joinUrl = c.registration.code ? pageUrl('delta') + '?k=' + c.registration.code : null;
  return `<section class="panel rv">
    <div class="panel-head">
      <div><h2>Deltagare</h2><p class="small muted" style="margin-top:6px">${players.length} anmälda${diets.length ? ` · ${diets.length} med specialkost` : ''}</p></div>
      <div class="row">
        <label class="switch"><input type="checkbox" data-act-change="registration" ${c.registration.open ? 'checked' : ''}><span class="track"></span><span class="small">Anmälan öppen</span></label>
        ${diets.length ? '<button class="btn ghost sm" data-act="diets">Specialkost till köket</button>' : ''}
        <button class="btn ghost sm" data-act="add-player">Lägg till</button>
        ${c.format !== 'melee' ? '<button class="btn sm" data-act="make-teams">Skapa lag</button>' : ''}
      </div>
    </div>
    ${joinUrl ? `<div class="link-card" style="margin-bottom:16px">
        <div class="qr" data-qr="${esc(joinUrl)}"></div>
        <div><b>Kod ${esc(c.registration.code)}</b><div class="u">${esc(joinUrl)}</div>
          <div class="row"><button class="btn quiet sm" data-act="copy" data-v="${esc(joinUrl)}">Kopiera länk</button><button class="btn quiet sm" data-act="print-sign">Skriv ut skylt</button></div></div>
      </div>` : `<div class="row" style="margin-bottom:16px"><button class="btn quiet sm" data-act="make-code">Skapa anmälningskod</button><span class="small muted">Deltagarna anmäler sig själva med en QR-kod.</span></div>`}
    ${players.length ? `<div class="scroll-x"><table class="ed-table">
      <thead><tr><th>Namn</th><th>Avdelning</th>${c.format !== 'melee' ? '<th>Lag</th>' : ''}<th>Specialkost</th><th>Med i spelet</th><th class="sr">Ta bort</th></tr></thead>
      <tbody>${players.map(p => `<tr>
        <td class="w-name"><input class="input" data-player="${p.id}" data-f="name" value="${esc(p.name)}" aria-label="Namn"></td>
        <td><input class="input" data-player="${p.id}" data-f="department" value="${esc(p.department || '')}" aria-label="Avdelning"></td>
        ${c.format !== 'melee' ? `<td><select class="input" data-player="${p.id}" data-f="team_id" aria-label="Lag"><option value="">–</option>${teams.map(t => `<option value="${t.id}" ${p.team_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></td>` : ''}
        <td><span class="small">${esc(priv[p.id]?.diet || '')}</span></td>
        <td><label class="check"><input type="checkbox" data-player="${p.id}" data-f="active" ${!p.inactive ? 'checked' : ''}><span class="box"></span><span class="sr">Med i spelet</span></label></td>
        <td><button class="icon-btn" data-act="del-player" data-id="${p.id}" aria-label="Ta bort ${esc(p.name)}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></td>
      </tr>`).join('')}</tbody></table></div>`
    : `<div class="empty"><strong>Inga anmälda än</strong>Öppna anmälan och sätt upp QR-skylten, eller lägg till deltagare för hand.</div>`}
  </section>`;
}

/* ── Upplägg: format, lottning och schema ──────────────────────────── */

const FORMATS = [
  ['groups', 'Grupper + slutspel', 'Alla möter alla i gruppen, sedan A- och B-slutspel. Alla lag spelar hela dagen.'],
  ['swiss', 'Schweizer', 'Lag med samma resultat möts varje omgång. Ingen åker ut, tabellen avgör.'],
  ['melee', 'Mêlée', 'Nya lagkamrater varje omgång, individuell tabell. Bäst för mingel.'],
];

function tabFormat() {
  const s = st(), c = cfg();
  const count = c.format === 'melee' ? s.players.filter(p => !p.inactive).length : s.teams.length;
  const est = count >= 2 ? E.estimate(c, count) : null;
  const hasMatches = s.matches.length > 0;
  const err = c.format === 'groups' ? E.validateGroups(c, s.teams.length) : null;

  const num = (path, label, min, max, val, extra = '') =>
    `<label class="field"><span>${label}</span><input class="input" type="number" min="${min}" max="${max}" data-cfg="${path}" value="${val}" ${extra}></label>`;
  const tog = (path, label, val) =>
    `<label class="switch"><input type="checkbox" data-cfg="${path}" ${val ? 'checked' : ''}><span class="track"></span><span>${label}</span></label>`;

  let specific = '';
  if (c.format === 'groups') specific = `<div class="grid-2">
      ${num('groups.count', 'Antal grupper', 1, 16, c.groups.count)}
      <label class="field"><span>Vidare till A-slutspel per grupp</span><select class="input" data-cfg="groups.toA">
        ${[0, 1, 2].map(v => `<option value="${v}" ${c.groups.toA === v ? 'selected' : ''}>${v === 0 ? 'Inget slutspel' : v}</option>`).join('')}</select></label>
    </div>
    <div class="row" style="gap:22px;margin-top:16px">
      ${tog('groups.bCup', 'B-slutspel för resten', c.groups.bCup)}
      ${tog('groups.bronze', 'Bronsmatch', c.groups.bronze)}
      ${tog('groups.finalAlone', 'Finalen ensam sist', c.groups.finalAlone)}
    </div>`;
  if (c.format === 'swiss') specific = `<div class="grid-2">
      ${num('swiss.rounds', 'Omgångar', 1, 12, c.swiss.rounds)}
      <label class="field"><span>Slutspel efteråt</span><select class="input" data-cfg="swiss.playoff">
        ${[[0, 'Inget — tabellen avgör'], [2, 'Final, topp 2'], [4, 'Semifinal, topp 4'], [8, 'Kvartsfinal, topp 8']].map(([v, l]) => `<option value="${v}" ${c.swiss.playoff === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>`;
  if (c.format === 'melee') specific = `<div class="grid-2">
      ${num('melee.rounds', 'Omgångar', 1, 12, c.melee.rounds)}
      <label class="field"><span>Spelform</span><select class="input" data-cfg="melee.size">
        <option value="2" ${c.melee.size === 2 ? 'selected' : ''}>Dubbel (2 mot 2)</option>
        <option value="3" ${c.melee.size === 3 ? 'selected' : ''}>Trippel (3 mot 3)</option></select></label>
    </div>`;

  return `<section class="panel rv">
    <div class="panel-head"><h2>Format</h2>${hasMatches ? '<span class="small muted">Schemat finns redan. Nytt format gäller när du skapar om det.</span>' : ''}</div>
    <div class="fmt-options">${FORMATS.map(([k, t, d]) => `<button class="fmt" data-act="format" data-v="${k}" aria-pressed="${c.format === k}"><b>${t}</b><span>${d}</span></button>`).join('')}</div>
    ${specific}
    <hr class="rule">
    <div class="grid-2">
      ${num('courts', 'Banor', 1, 40, c.courts)}
      <label class="field"><span>Första match</span><input class="input" type="time" data-cfg="start" value="${esc(c.start)}"></label>
      ${num('matchMin', 'Minuter per match', 10, 120, c.matchMin)}
      ${num('breakMin', 'Minuter mellan passen', 0, 60, c.breakMin)}
      ${num('target', 'Spelas till', 5, 21, c.target)}
      ${num('win', 'Poäng för vinst', 1, 5, c.win)}
    </div>
    ${est ? `<div class="est">
      <div><span class="num">${est.matches}</span><span>matcher</span></div>
      <div><span class="num">${est.slots}</span><span>pass</span></div>
      <div><span class="num">${Math.floor(est.minutes / 60)} h ${est.minutes % 60} min</span><span>speltid</span></div>
      <div><span class="num">${est.end}</span><span>sista matchen klar</span></div>
    </div>` : ''}
    ${err ? `<p class="small" style="margin-top:12px;color:var(--hi)">${esc(err)}</p>` : ''}
  </section>
  ${c.format === 'groups' ? drawPanel(err) : ''}
  ${c.format === 'swiss' ? swissPanel() : ''}
  ${c.format === 'melee' ? meleePanel() : ''}`;
}

function drawPanel(err) {
  const s = st(), c = cfg();
  const tables = groupTables(s, resolvedMatches(s));
  const drawn = s.teams.length && s.teams.every(t => t.group_label);
  const names = nameMap(s);
  return `<section class="panel rv">
    <div class="panel-head"><h2>Lottning och schema</h2>
      <div class="row">
        <button class="btn ghost sm" data-act="draw" ${s.teams.length < 2 ? 'disabled' : ''}>${drawn ? 'Lotta om' : 'Lotta grupper'}</button>
        <button class="btn sm" data-act="build-groups" ${!drawn || err ? 'disabled' : ''}>${s.matches.length ? 'Skapa om schemat' : 'Skapa spelschema'}</button>
      </div>
    </div>
    <p class="small muted" style="margin-bottom:16px">Lottningen kan visas live på storbilden — lagen dras ett i taget. Grupper går också att ändra för hand under Lag.</p>
    ${drawn ? `<div class="groups-grid">${tables.map(g => `<div><h3 style="margin-bottom:8px">Grupp ${g.group}</h3>
      ${g.rows.map(r => `<div style="padding:8px 0;border-top:1px solid var(--line)">${esc(names[r.team])}</div>`).join('')}</div>`).join('')}</div>`
    : `<div class="empty"><strong>Inte lottat än</strong>${s.teams.length} lag väntar.</div>`}
  </section>`;
}

function swissPanel() {
  const s = st(), c = cfg();
  const sm = s.matches.filter(m => m.stage === 'swiss');
  const round = Math.max(0, ...sm.map(m => m.round));
  const roundDone = sm.filter(m => m.round === round).every(m => m.status === 'done');
  const hasPlayoff = s.matches.some(m => m.stage === 'A');
  const allRounds = round >= c.swiss.rounds && roundDone;
  return `<section class="panel rv">
    <div class="panel-head"><h2>Omgångar</h2>
      <div class="row">
        ${!allRounds ? `<button class="btn sm" data-act="swiss-next" ${round && !roundDone ? 'disabled' : ''}>Lotta omgång ${round + 1}</button>` : ''}
        ${allRounds && c.swiss.playoff && !hasPlayoff ? '<button class="btn sm" data-act="swiss-playoff">Skapa slutspel</button>' : ''}
        ${sm.length ? '<button class="btn ghost sm" data-act="clear-matches">Rensa alla matcher</button>' : ''}
      </div>
    </div>
    <p class="muted">${round ? `Omgång ${round} av ${c.swiss.rounds}${roundDone ? ' är klar.' : ' pågår — nästa lottas när alla matcher är klara.'}` : 'Första omgången lottas slumpmässigt. Sedan möts lag med liknande resultat.'}</p>
  </section>`;
}

function meleePanel() {
  const s = st(), c = cfg();
  const mm = s.matches.filter(m => m.stage === 'melee');
  const round = Math.max(0, ...mm.map(m => m.round));
  const roundDone = mm.filter(m => m.round === round).every(m => m.status === 'done');
  const active = s.players.filter(p => !p.inactive).length;
  const shape = E.meleeShape(active, c.melee.size);
  return `<section class="panel rv">
    <div class="panel-head"><h2>Omgångar</h2>
      <div class="row">
        ${round < c.melee.rounds ? `<button class="btn sm" data-act="melee-next" ${(round && !roundDone) || !shape ? 'disabled' : ''}>Lotta omgång ${round + 1}</button>` : ''}
        ${mm.length ? '<button class="btn ghost sm" data-act="clear-matches">Rensa alla matcher</button>' : ''}
      </div>
    </div>
    <p class="muted">${active} spelare med i spelet${shape ? ` → ${shape.length} matcher per omgång${shape.some(([a, b]) => a !== b) ? ' (en match blir 3 mot 2)' : ''}` : ' — minst fyra behövs'}. ${round ? `Omgång ${round} av ${c.melee.rounds}${roundDone ? ' är klar.' : ' pågår.'}` : ''}</p>
    <p class="small muted" style="margin-top:8px">Kommer någon sent eller går hem tidigt: bocka i eller ur "Med i spelet" under Deltagare innan nästa omgång lottas.</p>
  </section>`;
}

/* ── Matcher ───────────────────────────────────────────────────────── */

function tabMatches() {
  const s = st(), c = cfg();
  const res = resolvedMatches(s);
  if (!res.length) return `<div class="empty rv"><strong>Inga matcher än</strong>Skapa spelschemat under Upplägg.</div>`;
  const names = nameMap(s);
  const f = store('bk-admin-mfilter') || 'alla';
  const filt = { alla: () => true, kvar: m => m.status !== 'done', pagar: m => m.status === 'live', klara: m => m.status === 'done' }[f] || (() => true);
  const slots = [...new Set(res.map(m => m.slot))].sort((a, b) => a - b);
  const body = slots.map(sl => {
    const list = res.filter(m => m.slot === sl && filt(m));
    if (!list.length) return '';
    const stageNames = [...new Set(list.map(m => m.stage === 'group' ? 'Gruppspel' : m.stage === 'A' ? 'A-slutspel' : m.stage === 'B' ? 'B-slutspel' : E.STAGE_NAMES[m.stage]))].join(' + ');
    return `<div class="slot rv">
      <div class="slot-head"><span class="num">${E.slotTime(c, sl)}</span><span class="muted">${stageNames}</span></div>
      ${list.map(m => matchRow(m, names, c, { time: false }).replace('class="match', 'role="button" tabindex="0" class="match admin')).join('')}
    </div>`;
  }).join('');
  return `<div class="spread rv" style="margin-bottom:18px">
      <div class="seg" role="tablist" aria-label="Filter">${[['alla', 'Alla'], ['kvar', 'Kvar'], ['pagar', 'Pågår'], ['klara', 'Klara']].map(([k, l]) => `<button role="tab" aria-selected="${f === k}" data-act="mfilter" data-v="${k}">${l}</button>`).join('')}</div>
      <span class="small muted">Klicka på en match för att rätta resultat, bana eller tid.</span>
    </div>
    ${body || '<div class="empty"><strong>Inget här</strong>Byt filter.</div>'}`;
}

/* ── Tabell ────────────────────────────────────────────────────────── */

function tabTables() {
  const s = st(), c = cfg();
  const res = resolvedMatches(s);
  const names = nameMap(s);
  let out = '';
  if (c.format === 'groups') {
    const q = c.groups.toA;
    out += `<div class="groups-grid">${groupTables(s, res).map(g => `<section class="panel rv"><div class="panel-head"><h2>Grupp ${g.group}</h2><span class="small muted">${g.played}/${g.total}</span></div>${standingsTable(g.rows, names, { toA: q, toB: c.groups.bCup ? q * 2 : 0, keyPrefix: g.group })}</section>`).join('')}</div>`;
  } else if (c.format === 'swiss') {
    out += `<section class="panel rv"><h2 style="margin-bottom:14px">Tabell</h2>${standingsTable(overallTable(s, res), names, { buchholz: true })}</section>`;
  } else {
    out += `<section class="panel rv"><h2 style="margin-bottom:14px">Spelare</h2>${playerTable(E.playerStandings(s.players, s.matches), names)}</section>`;
  }
  for (const [stage, title] of [['A', 'A-slutspel'], ['B', 'B-slutspel']]) {
    const b = bracket(res, names, c, stage);
    if (b) out += `<section class="panel rv"><h2 style="margin-bottom:16px">${title}</h2>${b}</section>`;
  }
  return out;
}

/* ── Röstning och utmaningar ───────────────────────────────────────── */

function tabExtra() {
  const s = st(), c = cfg();
  const names = nameMap(s);
  const votes = Object.fromEntries((S.votes || []).map(v => [v.team_id, Number(v.votes)]));
  const total = Object.values(votes).reduce((a, b) => a + b, 0);
  const ranked = s.teams.slice().sort((a, b) => (votes[b.id] || 0) - (votes[a.id] || 0));
  const max = Math.max(1, ...Object.values(votes));
  const challenges = s.challenges.slice().sort((a, b) => a.sort - b.sort);
  return `<section class="panel rv">
    <div class="panel-head"><div><h2>Bästa lagutklädnad</h2><p class="small muted" style="margin-top:6px">Alla röstar från livesidan, en röst per telefon. Resultatet syns inte förrän du avslöjar det.</p></div>
      <div class="row" style="gap:22px">
        <label class="switch"><input type="checkbox" data-act-change="voting-open" ${c.voting.open ? 'checked' : ''}><span class="track"></span><span>Röstningen öppen</span></label>
        <button class="btn sm" data-act="reveal" ${!total ? 'disabled' : ''}>${c.voting.reveal ? 'Dölj resultatet' : 'Avslöja på storbilden'}</button>
        <button class="btn ghost sm" data-act="refresh-votes">Uppdatera</button>
      </div>
    </div>
    ${s.teams.length ? ranked.map(t => `<div style="display:grid;grid-template-columns:minmax(120px,1fr) 3fr 40px;gap:14px;align-items:center;padding:8px 0;border-top:1px solid var(--line)">
      <span>${esc(t.name)}${t.costume ? `<span class="small muted"> · ${esc(t.costume)}</span>` : ''}</span>
      <span style="height:8px;border-radius:9px;background:var(--raise-2);overflow:hidden"><i style="display:block;height:100%;width:${((votes[t.id] || 0) / max) * 100}%;background:var(--hi);border-radius:9px;transition:width .8s var(--ease)"></i></span>
      <span class="num" style="text-align:right">${votes[t.id] || 0}</span></div>`).join('')
    : '<p class="muted">Lägg till lag först.</p>'}
  </section>

  <section class="panel rv">
    <div class="panel-head"><div><h2>Utmaningar</h2><p class="small muted" style="margin-top:6px">Sidotävlingar mellan matcherna — skytte, närmast lillen, längsta kast. Domarna kan föra in resultat.</p></div>
      <button class="btn sm" data-act="add-challenge">Ny utmaning</button></div>
    ${challenges.length ? challenges.map(ch => {
      const rows = challengeBoard(ch);
      return `<div style="margin-top:14px">
        <div class="spread"><h3>${esc(ch.name)} <span class="small muted" style="text-transform:none;font-family:var(--body);font-weight:normal">· ${esc(ch.unit)}, ${ch.higher_better ? 'högst vinner' : 'lägst vinner'}</span></h3>
          <div class="row"><button class="btn quiet sm" data-act="add-score" data-id="${ch.id}">För in resultat</button><button class="btn ghost sm" data-act="del-challenge" data-id="${ch.id}">Ta bort</button></div></div>
        ${rows.length ? rows.slice(0, 10).map((r, i) => `<div class="spread" style="padding:7px 0;border-top:1px solid var(--line)"><span>${i + 1}. ${esc(names[r.who] || '?')}</span><span class="row"><span class="num">${r.value}</span><button class="icon-btn" data-act="del-score" data-id="${r.id}" aria-label="Ta bort resultat"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span></div>`).join('') : '<p class="small muted" style="margin-top:6px">Inga resultat än.</p>'}
      </div>`;
    }).join('') : '<p class="muted">Inga utmaningar.</p>'}
  </section>`;
}

/** Bästa resultat per deltagare, sorterat. */
export function challengeBoard(ch) {
  const best = new Map();
  for (const sc of st().scores.filter(x => x.challenge_id === ch.id)) {
    const who = sc.player_id || sc.team_id;
    const v = Number(sc.value);
    const cur = best.get(who);
    if (!cur || (ch.higher_better ? v > cur.value : v < cur.value)) best.set(who, { who, value: v, id: sc.id });
  }
  return [...best.values()].sort((a, b) => ch.higher_better ? b.value - a.value : a.value - b.value);
}

/* ── Efteråt ───────────────────────────────────────────────────────── */

function placings() {
  const s = st(), c = cfg();
  const res = resolvedMatches(s);
  if (c.format === 'melee') return E.playerStandings(s.players, s.matches).filter(r => r.played).map(r => ({ place: r.rank, id: r.player }));
  const out = [];
  const final = res.find(m => m.stage === 'A' && !m.bronze && m.round === Math.max(...res.filter(x => x.stage === 'A').map(x => x.round)));
  const bronze = res.find(m => m.stage === 'A' && m.bronze);
  if (final && final.status === 'done') {
    const w = E.winnerOf(final);
    out.push({ place: 1, id: w === 'a' ? final.a : final.b }, { place: 2, id: w === 'a' ? final.b : final.a });
    if (bronze && bronze.status === 'done') {
      const wb = E.winnerOf(bronze);
      out.push({ place: 3, id: wb === 'a' ? bronze.a : bronze.b }, { place: 4, id: wb === 'a' ? bronze.b : bronze.a });
    }
    return out;
  }
  if (!final && res.length && res.every(m => m.status === 'done')) {
    return overallTable(s, res).map(r => ({ place: r.rank, id: r.team }));
  }
  return out;
}

function tabAfter() {
  const s = st(), ev = s.event;
  const names = nameMap(s);
  const pl = placings();
  const votes = (S.votes || []).slice().sort((a, b) => b.votes - a.votes);
  const costume = votes[0] ? s.teams.find(t => t.id === votes[0].team_id) : null;
  const hasPersonal = s.playerPrivate.length || s.teamPrivate.some(t => t.phone || t.email || t.contact_name);
  return `<section class="panel rv">
    <div class="panel-head"><h2>Slutresultat</h2>
      <div class="row">
        <button class="btn ghost sm" data-act="export-csv">Ladda ner resultat</button>
        <button class="btn sm" data-act="diplomas" ${pl.length || costume ? '' : 'disabled'}>Skriv ut diplom</button>
      </div>
    </div>
    ${pl.length ? pl.slice(0, 8).map(p => `<div class="spread" style="padding:12px 0;border-top:1px solid var(--line)">
        <span class="row" style="gap:18px"><span class="num" style="font-size:${p.place === 1 ? 30 : 20}px;${p.place === 1 ? 'color:var(--hi)' : ''};width:48px">${p.place}</span><span style="font-size:${p.place === 1 ? 20 : 16}px">${esc(names[p.id] || '?')}</span></span>
      </div>`).join('')
    : '<p class="muted">Slutresultatet visas när finalen är spelad.</p>'}
    ${costume ? `<p style="margin-top:18px">Bästa utklädnad: <b style="color:var(--hi);font-weight:normal">${esc(costume.name)}</b> <span class="muted">(${votes[0].votes} röster)</span></p>` : ''}
  </section>

  <section class="panel rv">
    <div class="panel-head"><div><h2>Personuppgifter</h2><p class="small muted" style="margin-top:6px">Specialkost räknas som hälsouppgifter. Rensa kontaktuppgifter, specialkost och röster när eventet är över — senast inom 30 dagar.</p></div>
      <button class="btn ${hasPersonal ? '' : 'ghost'} sm" data-act="purge" ${hasPersonal ? '' : 'disabled'}>${hasPersonal ? 'Rensa nu' : 'Redan rensat'}</button></div>
  </section>

  <section class="panel rv">
    <div class="panel-head"><div><h2>Avsluta</h2><p class="small muted" style="margin-top:6px">Livesidan visar slutresultatet och domarvyn slutar ta emot poäng.</p></div>
      <button class="btn sm" data-act="status" data-v="avslutad" ${ev.status === 'avslutad' ? 'disabled' : ''}>Markera som avslutat</button></div>
  </section>`;
}

/* ── Inställningar ─────────────────────────────────────────────────── */

function tabSettings() {
  const ev = st().event, c = cfg();
  return `<section class="panel rv">
    <h2 style="margin-bottom:18px">Evenemanget</h2>
    <form class="stack" data-form="event-settings">
      <div class="grid-2">
        <label class="field"><span>Namn</span><input name="name" value="${esc(ev.name)}" required maxlength="80"></label>
        <label class="field"><span>Datum</span><input name="date" type="date" value="${esc(ev.date || '')}"></label>
        <label class="field"><span>Plats</span><input name="venue" value="${esc(ev.venue || '')}" placeholder="Skönsbergs Bouleklubb"></label>
        <label class="field"><span>Adress på webben</span><input name="slug" value="${esc(ev.slug)}" pattern="[a-z0-9-]{3,60}" required></label>
      </div>
      ${ev.kind === 'foretag' ? `<div class="grid-2">
        <label class="field"><span>Företagets namn</span><input name="company" value="${esc(c.company.name)}"></label>
        <label class="field"><span>Företagets logga (länk till bild)</span><input name="logo" type="url" value="${esc(c.company.logo)}" placeholder="https://…/logga.svg"></label>
      </div>` : ''}
      <label class="switch"><input type="checkbox" name="listed" ${ev.listed ? 'checked' : ''}><span class="track"></span><span>Visa i listan på livesidan</span></label>
      <div><button class="btn">Spara</button></div>
    </form>
  </section>
  <section class="panel rv">
    <div class="panel-head"><div><h2>Ta bort evenemanget</h2><p class="small muted" style="margin-top:6px">Lag, matcher, röster och deltagare försvinner. Går inte att ångra.</p></div>
    <button class="btn danger sm" data-act="del-event">Ta bort</button></div>
  </section>`;
}

/* ══════════════════════════════════════════════════════════════════════
   Bokningar
   ══════════════════════════════════════════════════════════════════════ */

const DEFAULT_PRICELIST = [
  { d: 'Boulekampen för företag — banor, material och domare', unit: 'person', price: 0, vat: 25 },
  { d: 'Lunch', unit: 'person', price: 0, vat: 12 },
  { d: 'After Boule — middagsbuffé på LOKAL', unit: 'person', price: 0, vat: 12 },
  { d: 'Dryckespaket', unit: 'person', price: 0, vat: 25 },
  { d: 'Pokal, medaljer och diplom', unit: 'paket', price: 0, vat: 25 },
];

const DEFAULT_CHECKLIST = [
  'Banor bokade hos bouleklubben', 'Klot, lillar och måttband räknade', 'Mat beställd',
  'Specialkost skickad till köket', 'Dryck ordnad', 'Pokal, medaljer och diplom utskrivna',
  'Musik och högtalare', 'Tv eller projektor för storbilden', 'QR-skylt för anmälan och livesidan',
  'Domar-PIN till banvärdarna', 'Regelgenomgång förberedd', 'Fråga om bildtillstånd',
  'Faktura skickad', 'Personuppgifter rensade',
].map(t => ({ t, done: false }));

const BTABS = [['uppgifter', 'Uppgifter'], ['offert', 'Offert'], ['planering', 'Planering'], ['checklista', 'Checklista']];

function bookingView(b, tab) {
  const body = { uppgifter: bDetails, offert: bQuote, planering: bPlan, checklista: bChecklist }[tab] || bDetails;
  const linked = b.event_id && S.events.find(e => e.id === b.event_id);
  const cl = b.checklist || [];
  return `<div class="hero rv">
    <div>
      <h1>${esc(b.company || 'Ny bokning')}</h1>
      <p class="sub"><span>${esc(fmtDate(b.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) || 'Datum ej satt')}</span>
        ${b.participants ? `<span>${b.participants} deltagare</span>` : ''}
        <span class="pill line">${BSTATUS.find(([k]) => k === b.status)?.[1] || ''}</span>
        ${cl.length ? `<span>${cl.filter(x => x.done).length}/${cl.length} klart</span>` : ''}</p>
    </div>
    <div class="row">${linked
      ? `<a class="btn sm" href="#/e/${encodeURIComponent(linked.slug)}">Öppna evenemanget</a>`
      : `<button class="btn sm" data-act="booking-event">Skapa evenemang</button>`}</div>
  </div>
  <div class="tabs-wrap"><div class="seg" role="tablist" aria-label="Delar av bokningen">${BTABS.map(([k, l]) => `<button role="tab" aria-selected="${k === tab}" data-tab="${k}">${l}</button>`).join('')}</div></div>
  <div id="tab">${body(b)}</div>`;
}

function bDetails(b) {
  return `<section class="panel rv">
    <form class="stack" data-form="booking" data-id="${b.id}">
      <div class="grid-2">
        <label class="field"><span>Företag</span><input name="company" value="${esc(b.company)}" required></label>
        <label class="field"><span>Status</span><select name="status">${BSTATUS.map(([k, l]) => `<option value="${k}" ${b.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>Kontaktperson</span><input name="contact_name" value="${esc(b.contact_name)}"></label>
        <label class="field"><span>E-post</span><input name="email" type="email" value="${esc(b.email)}"></label>
        <label class="field"><span>Telefon</span><input name="phone" type="tel" value="${esc(b.phone)}"></label>
        <label class="field"><span>Antal deltagare</span><input name="participants" type="number" min="0" max="500" value="${b.participants || ''}"></label>
        <label class="field"><span>Datum</span><input name="date" type="date" value="${esc(b.date || '')}"></label>
        <label class="field"><span>Tid</span><input name="time" value="${esc(b.time)}" placeholder="13:00–17:00"></label>
        <label class="field"><span>Plats</span><input name="venue" value="${esc(b.venue)}" placeholder="Skönsbergs Bouleklubb"></label>
      </div>
      <label class="field"><span>Anteckningar</span><textarea name="notes" placeholder="Önskemål, budget, vad de firar …">${esc(b.notes)}</textarea></label>
      <div class="spread"><button class="btn">Spara</button><button class="btn danger sm" type="button" data-act="del-booking" data-id="${b.id}">Ta bort bokningen</button></div>
    </form>
  </section>`;
}

function vatSums(items) {
  const ex = items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
  const byVat = {};
  items.forEach(i => { const v = Number(i.vat) || 0; byVat[v] = (byVat[v] || 0) + (Number(i.qty) || 0) * (Number(i.price) || 0) * v / 100; });
  const vat = Object.values(byVat).reduce((a, b) => a + b, 0);
  return { ex, byVat, vat, total: ex + vat };
}

function bQuote(b) {
  const items = b.items || [];
  const t = vatSums(items);
  return `<section class="panel rv">
    <div class="panel-head"><h2>Offert</h2>
      <div class="row"><button class="btn ghost sm" data-act="quote-fill">Lägg till från prislistan</button><button class="btn ghost sm" data-act="quote-add">Tom rad</button><button class="btn sm" data-act="quote-print" ${items.length ? '' : 'disabled'}>Skriv ut / PDF</button></div></div>
    ${items.length ? `<div class="scroll-x"><table class="ed-table items">
      <thead><tr><th>Beskrivning</th><th>Antal</th><th>À-pris ex moms</th><th>Moms</th><th style="text-align:right">Summa</th><th class="sr">Ta bort</th></tr></thead>
      <tbody>${items.map((i, k) => `<tr>
        <td style="min-width:260px"><input class="input" data-item="${k}" data-f="d" value="${esc(i.d)}" aria-label="Beskrivning"></td>
        <td><input class="input w-sm" type="number" min="0" data-item="${k}" data-f="qty" value="${i.qty}" aria-label="Antal"></td>
        <td><input class="input" type="number" min="0" step="1" data-item="${k}" data-f="price" value="${i.price}" aria-label="À-pris"></td>
        <td><select class="input w-sm" data-item="${k}" data-f="vat" aria-label="Moms">${[25, 12, 6, 0].map(v => `<option value="${v}" ${Number(i.vat) === v ? 'selected' : ''}>${v} %</option>`).join('')}</select></td>
        <td style="text-align:right;white-space:nowrap">${kr((Number(i.qty) || 0) * (Number(i.price) || 0))}</td>
        <td><button class="icon-btn" data-act="quote-del" data-v="${k}" aria-label="Ta bort raden"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></td>
      </tr>`).join('')}</tbody></table></div>
      <div class="totals">
        <div><span>Summa ex moms</span><span>${kr(t.ex)}</span></div>
        ${Object.entries(t.byVat).filter(([v]) => Number(v)).map(([v, a]) => `<div class="muted"><span>Moms ${v} %</span><span>${kr(a)}</span></div>`).join('')}
        <div class="sum"><span>Att betala</span><span>${kr(t.total)}</span></div>
      </div>` : `<div class="empty"><strong>Tom offert</strong>Hämta rader från prislistan — antal fylls i efter deltagarna.</div>`}
    ${S.pricelist.every(p => !Number(p.price)) ? '<p class="small muted" style="margin-top:14px">Prislistan saknar priser. Fyll i dem under Prislista på översikten.</p>' : ''}
  </section>`;
}

function planDefaults(b) {
  const n = b.participants || 24;
  return { format: n >= 24 ? 'groups' : 'melee', teamSize: 4, courts: 6, arrive: (b.time || '').match(/\d{1,2}[:.]\d{2}/)?.[0]?.replace('.', ':') || '13:00', intro: 20, matchMin: 30, breakMin: 5, lunchAfter: 0, lunchMin: 45, ...b.plan };
}

/** Bygger en config för motorn ur bokningens planering. */
function planConfig(p, participants) {
  const teams = p.format === 'melee' ? participants : Math.max(2, Math.round(participants / p.teamSize));
  const groups = teams <= 5 ? 1 : teams <= 11 ? 2 : teams <= 23 ? 4 : 8;
  const minSize = Math.floor(teams / groups);
  return {
    count: teams,
    config: E.withDefaults({
      format: p.format === 'melee' ? 'melee' : p.format,
      groups: { count: groups, toA: 2, bCup: minSize >= 4, bronze: groups >= 2, finalAlone: true },
      swiss: { rounds: 3, playoff: teams >= 8 ? 4 : 2 },
      melee: { rounds: 4, size: 2 },
      courts: p.courts,
      start: E.fmtMin(E.toMin(p.arrive) + Number(p.intro || 0)),
      matchMin: p.matchMin,
      breakMin: p.breakMin,
    }),
  };
}

function runSheet(p, participants) {
  const { count, config } = planConfig(p, participants);
  const est = E.estimate(config, count);
  const rows = [[p.arrive, 'Välkomna — incheckning, lagindelning och regelgenomgång']];
  let t = E.toMin(config.start);
  for (let i = 0; i < est.slots; i++) {
    if (p.lunchAfter && i === Number(p.lunchAfter)) { rows.push([E.fmtMin(t), 'Lunch']); t += Number(p.lunchMin || 0); }
    rows.push([E.fmtMin(t), `Pass ${i + 1}`]);
    t += config.matchMin + config.breakMin;
  }
  t -= config.breakMin;
  rows.push([E.fmtMin(t + 10), 'Prisutdelning — pokal, diplom och bästa lag']);
  return { rows, est, count, config, end: E.fmtMin(t + 25) };
}

function bPlan(b) {
  const p = planDefaults(b);
  const n = b.participants || 0;
  const rs = n >= 4 ? runSheet(p, n) : null;
  const sel = (name, opts, v) => `<select name="${name}">${opts.map(([k, l]) => `<option value="${k}" ${String(v) === String(k) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  return `<div class="ov">
    <section class="panel rv">
      <h2 style="margin-bottom:18px">Upplägg</h2>
      <form class="stack" data-form="plan" data-id="${b.id}">
        <div class="grid-2">
          <label class="field"><span>Format</span>${sel('format', [['groups', 'Lag i grupper + final'], ['swiss', 'Lag, schweizer'], ['melee', 'Mêlée — nya lag varje omgång']], p.format)}</label>
          <label class="field"><span>Personer per lag</span>${sel('teamSize', [[2, 'Två'], [3, 'Tre'], [4, 'Fyra'], [6, 'Sex']], p.teamSize)}</label>
          <label class="field"><span>Banor</span><input name="courts" type="number" min="1" max="40" value="${p.courts}"></label>
          <label class="field"><span>Samling</span><input name="arrive" type="time" value="${esc(p.arrive)}"></label>
          <label class="field"><span>Välkomst och regler (min)</span><input name="intro" type="number" min="0" max="90" value="${p.intro}"></label>
          <label class="field"><span>Minuter per match</span><input name="matchMin" type="number" min="10" max="90" value="${p.matchMin}"></label>
          <label class="field"><span>Minuter mellan passen</span><input name="breakMin" type="number" min="0" max="30" value="${p.breakMin}"></label>
          <label class="field"><span>Lunch efter pass</span><input name="lunchAfter" type="number" min="0" max="12" value="${p.lunchAfter}" title="0 = ingen lunch i spelschemat"></label>
          <label class="field"><span>Lunchens längd (min)</span><input name="lunchMin" type="number" min="0" max="120" value="${p.lunchMin}"></label>
        </div>
        <div><button class="btn">Räkna om</button></div>
      </form>
      <p class="small muted" style="margin-top:14px">Tidsbegränsade matcher (30 min) håller schemat för företag. Spelas till 13 tar en match ofta 40–60 minuter.</p>
    </section>
    <section class="panel rv">
      <div class="panel-head"><h2>Körschema</h2>${rs ? '<button class="btn ghost sm" data-act="copy-runsheet">Kopiera</button>' : ''}</div>
      ${rs ? `<p class="muted" style="margin-bottom:14px">${rs.count} ${p.format === 'melee' ? 'spelare' : 'lag'} · ${rs.est.matches} matcher på ${p.courts} banor · slut cirka ${rs.end}</p>
        <div class="runsheet">${rs.rows.map(([t, d]) => `<div><b>${t}</b><span>${esc(d)}</span></div>`).join('')}</div>`
      : '<p class="muted">Fyll i antal deltagare under Uppgifter.</p>'}
    </section>
  </div>`;
}

function bChecklist(b) {
  const cl = (b.checklist && b.checklist.length) ? b.checklist : DEFAULT_CHECKLIST;
  return `<section class="panel rv">
    <div class="panel-head"><h2>Checklista</h2><form class="row" data-form="check-add" data-id="${b.id}" style="flex-wrap:nowrap"><input class="input" name="t" placeholder="Egen punkt" required><button class="btn sm">Lägg till</button></form></div>
    <div class="check-list">${cl.map((x, i) => `<label class="check"><input type="checkbox" data-check="${i}" data-id="${b.id}" ${x.done ? 'checked' : ''}><span class="box"></span><span class="t">${esc(x.t)}</span></label>`).join('')}</div>
  </section>`;
}

/* ══════════════════════════════════════════════════════════════════════
   Åtgärder
   ══════════════════════════════════════════════════════════════════════ */

function mergeDeep(a, b) {
  const out = Array.isArray(a) ? a.slice() : { ...(a || {}) };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' ? mergeDeep(out[k], v) : v;
  }
  return out;
}

async function saveEvent(patch) {
  const ev = st().event;
  const row = { id: ev.id, slug: ev.slug, name: ev.name, kind: ev.kind, status: ev.status, date: ev.date, venue: ev.venue, listed: ev.listed, config: ev.config || {}, booking_id: ev.booking_id || null, ...patch };
  const saved = await db.events.save(row);
  S.live.state.event = saved;
  const i = S.events.findIndex(e => e.id === saved.id);
  if (i > -1) S.events[i] = saved;
  return saved;
}
const patchConfig = patch => saveEvent({ config: mergeDeep(st().event.config || {}, patch) });

function applyRows(key, rows) {
  const list = st()[key];
  for (const r of [].concat(rows)) {
    const i = list.findIndex(x => x.id === r.id);
    if (i > -1) list[i] = { ...list[i], ...r }; else list.push(r);
  }
}

async function saveBooking(patch) {
  const b = S.bookings.find(x => x.id === patch.id) || {};
  const [saved] = await db.bookings.save({ ...b, ...patch });
  const i = S.bookings.findIndex(x => x.id === saved.id);
  if (i > -1) S.bookings[i] = saved; else S.bookings.push(saved);
  return saved;
}

const A = {};

A['signout'] = async () => { await db.signOut(); location.hash = ''; location.reload(); };

A['copy'] = async el => {
  try { await navigator.clipboard.writeText(el.dataset.v); toast('Kopierat'); }
  catch (e) { prompt('Kopiera länken:', el.dataset.v); }
};

A['new-event'] = async () => {
  const r = await dialog(`<form method="dialog" class="stack">
    <h2>Nytt evenemang</h2>
    <div class="seg" role="radiogroup" aria-label="Typ" id="kind-seg">
      <button type="button" role="radio" aria-selected="true" data-kind="turnering">Turnering</button>
      <button type="button" role="radio" aria-selected="false" data-kind="foretag">Företagsevent</button>
    </div>
    <input type="hidden" name="kind" value="turnering">
    <label class="field"><span>Namn</span><input name="name" required maxlength="80" placeholder="Boulekampen 2026"></label>
    <div class="grid-2">
      <label class="field"><span>Datum</span><input name="date" type="date"></label>
      <label class="field"><span>Plats</span><input name="venue" value="Skönsbergs Bouleklubb"></label>
    </div>
    <label class="field" data-company hidden><span>Företag</span><input name="company"></label>
    <div class="actions"><button class="btn ghost" data-close="">Avbryt</button><button class="btn" value="ok">Skapa</button></div>
  </form>`, {
    onOpen(d) {
      const seg = $('#kind-seg', d);
      segment(seg);
      on(seg, 'click', '[data-kind]', (e, b) => {
        $$('[data-kind]', seg).forEach(x => x.setAttribute('aria-selected', x === b));
        segment(seg);
        d.querySelector('[name=kind]').value = b.dataset.kind;
        d.querySelector('[data-company]').hidden = b.dataset.kind !== 'foretag';
      });
    },
  });
  if (!r) return;
  const f = Object.fromEntries(new FormData(r.form));
  const ev = await createEvent(f);
  if (ev) go('#/e/' + encodeURIComponent(ev.slug));
};

async function createEvent({ name, kind, date, venue, company, config = {}, booking_id = null }) {
  let slug = kind === 'foretag'
    ? slugify(company || name) + '-' + randCode(4).toLowerCase()
    : slugify(name) || 'boulekampen';
  if (slug.length < 3) slug += '-' + randCode(3).toLowerCase();
  while (S.events.some(e => e.slug === slug)) slug += '-' + randCode(2).toLowerCase();
  const base = kind === 'foretag'
    ? { format: 'melee', courts: 6, matchMin: 30, breakMin: 5, company: { name: company || '' }, registration: { open: true, code: randCode(5) } }
    : {};
  try {
    const ev = await db.events.save({ slug, name, kind, date: date || null, venue: venue || '', status: 'utkast', listed: kind !== 'foretag', config: mergeDeep(base, config), booking_id });
    S.events.unshift(ev);
    toast('Evenemanget är skapat');
    return ev;
  } catch (e) { toast(e.message); return null; }
}

A['demo-data'] = async () => {
  const ev = await createEvent({ name: 'Testturnering', kind: 'turnering', date: new Date().toISOString().slice(0, 10), venue: 'Skönsbergs Bouleklubb' });
  if (!ev) return;
  const names = ['Klotfabriken', 'Fanny-flykten', 'Carreau-kollektivet', 'Grisjägarna', 'Tretton blankt', 'Järnkloten', 'Pointeurerna', 'Sista klotet',
    'Lillens vänner', 'Grusgänget', 'Rulla hem', 'Bak i banan', 'Måttbandet', 'Tolv och en halv', 'Skyttarna', 'Kaffe & carreau'];
  const costumes = ['Tennisproffs', 'Franska turister', 'Astronauter', 'Bagare', '80-talsaerobics', 'Sjömän', 'Cowboys', 'Livvakter', 'Dinosaurier', 'Skidlandslaget', 'Kockar', 'Rockband', 'Golfare', 'Brandmän', 'Superhjältar', 'Pingviner'];
  const teams = names.map((n, i) => ({ event_id: ev.id, name: n, members: ['Alex', 'Sam', 'Kim', 'Robin'].map(x => x + ' ' + String.fromCharCode(65 + i)), costume: costumes[i], seed: i === 0 ? 1 : 0, checked_in: i < 14, sort: i }));
  await db.teams.save(teams);
  await db.setPin(ev.id, '1234');
  toast('Testturnering skapad. Domar-PIN: 1234', 'hi');
  go('#/e/' + encodeURIComponent(ev.slug) + '/upplagg');
};

A['new-booking'] = async () => {
  const b = await saveBooking({ company: '', status: 'forfragan', items: [], checklist: DEFAULT_CHECKLIST, plan: {}, participants: 0, contact_name: '', email: '', phone: '', time: '', venue: 'Skönsbergs Bouleklubb', notes: '' });
  go('#/b/' + b.id);
};

A['pricelist'] = async () => {
  const pl = S.pricelist;
  const r = await dialog(`<form method="dialog" class="stack" style="min-width:min(80vw,640px)">
    <h2>Prislista</h2>
    <p class="small muted">Standardrader för offerterna. Pris ex moms.</p>
    <div id="pl-rows" class="stack">${pl.map(p => plRow(p)).join('')}</div>
    <button type="button" class="btn ghost sm" data-add style="justify-self:start">Ny rad</button>
    <div class="actions"><button class="btn ghost" data-close="">Avbryt</button><button class="btn" value="ok">Spara</button></div>
  </form>`, {
    onOpen(d) {
      on(d, 'click', '[data-add]', () => $('#pl-rows', d).insertAdjacentHTML('beforeend', plRow({ d: '', unit: 'person', price: 0, vat: 25 })));
      on(d, 'click', '[data-rm]', (e, el) => el.closest('.pl-row').remove());
    },
  });
  if (!r) return;
  const rows = $$('.pl-row', r.form).map(row => ({
    d: row.querySelector('[name=d]').value.trim(),
    unit: row.querySelector('[name=unit]').value.trim(),
    price: Number(row.querySelector('[name=price]').value) || 0,
    vat: Number(row.querySelector('[name=vat]').value) || 0,
  })).filter(x => x.d);
  await db.setSetting('pricelist', rows);
  S.pricelist = rows;
  toast('Prislistan är sparad');
};
function plRow(p) {
  return `<div class="pl-row" style="display:grid;grid-template-columns:1fr 90px 100px 80px 36px;gap:8px;align-items:center">
    <input class="input" name="d" value="${esc(p.d)}" placeholder="Beskrivning" aria-label="Beskrivning">
    <input class="input" name="unit" value="${esc(p.unit)}" placeholder="per" aria-label="Enhet">
    <input class="input" name="price" type="number" min="0" value="${p.price}" aria-label="Pris">
    <select class="input" name="vat" aria-label="Moms">${[25, 12, 6, 0].map(v => `<option value="${v}" ${Number(p.vat) === v ? 'selected' : ''}>${v} %</option>`).join('')}</select>
    <button type="button" class="icon-btn" data-rm aria-label="Ta bort raden"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
  </div>`;
}

/* Evenemang: läge, klocka, utrop */

A['status'] = async el => {
  await saveEvent({ status: el.dataset.v });
  toast(el.dataset.v === 'pagar' ? 'Nu kör vi!' : 'Läget är ändrat');
  render();
};
A['delay'] = async el => {
  const c = cfg();
  await patchConfig({ delay: (c.delay || 0) + Number(el.dataset.v) });
  render();
};
A['timer'] = async el => {
  const min = Number(el.dataset.v);
  await patchConfig({ timer: { endsAt: new Date(Date.now() + min * 60000).toISOString(), label: min + ' min' } });
  toast('Klockan går');
  render();
};
A['timer-stop'] = async () => { await saveEvent({ config: { ...st().event.config, timer: null } }); render(); };
A['announce-clear'] = async () => { await patchConfig({ announcement: '' }); render(); };
A['mfilter'] = el => { store('bk-admin-mfilter', el.dataset.v); render(); };

/* Lag */

A['add-team'] = async () => {
  const s = st();
  const [t] = await db.teams.save({ event_id: s.event.id, name: 'Nytt lag ' + (s.teams.length + 1), members: [], seed: 0, costume: '', checked_in: false, sort: s.teams.length });
  applyRows('teams', t);
  render();
  const input = $(`[data-team="${t.id}"][data-f="name"]`);
  if (input) { input.focus(); input.select(); }
};
A['del-team'] = async el => {
  const t = st().teams.find(x => x.id === el.dataset.id);
  if (st().matches.some(m => m.team_a === t.id || m.team_b === t.id) &&
      !(await confirmDlg(`Ta bort ${t.name}?`, 'Laget finns i spelschemat. Dess matcher blir utan motståndare tills du skapar om schemat.', 'Ta bort', { danger: true }))) return;
  await db.teams.remove(t.id);
  st().teams = st().teams.filter(x => x.id !== t.id);
  render();
};

A['import'] = async () => {
  const r = await dialog(`<form method="dialog" class="stack">
    <h2>Importera anmälningar</h2>
    <p class="small muted">Öppna svaren i Google Kalkylark, markera alla rader inklusive rubrikraden, kopiera och klistra in här. Lag som redan finns hoppas över.</p>
    <label class="field"><span>Rader från kalkylarket</span><textarea name="rows" rows="8" required placeholder="Tidstämpel&#9;Lagkaptenens fullständiga namn&#9;Telefonnummer …"></textarea></label>
    <p class="small" id="imp-preview" aria-live="polite"></p>
    <div class="actions"><button class="btn ghost" data-close="">Avbryt</button><button class="btn" value="ok">Importera</button></div>
  </form>`, {
    onOpen(d) {
      const ta = d.querySelector('textarea');
      ta.addEventListener('input', () => {
        const rows = parseSignups(ta.value);
        $('#imp-preview', d).textContent = rows.length ? `${rows.length} lag hittade: ${rows.slice(0, 4).map(x => x.name).join(', ')}${rows.length > 4 ? ' …' : ''}` : '';
      });
    },
  });
  if (!r) return;
  const rows = parseSignups(new FormData(r.form).get('rows'));
  const s = st();
  const existing = new Set(s.teams.map(t => t.name.trim().toLowerCase()));
  const fresh = rows.filter(x => !existing.has(x.name.toLowerCase()));
  if (!fresh.length) { toast('Inga nya lag att importera'); return; }
  const saved = await db.teams.save(fresh.map((x, i) => ({ event_id: s.event.id, name: x.name, members: [], seed: 0, costume: '', checked_in: false, sort: s.teams.length + i })));
  await db.teamPrivate.save(saved.map((t, i) => ({ team_id: t.id, event_id: s.event.id, contact_name: fresh[i].contact, phone: fresh[i].phone, email: fresh[i].email, paid: fresh[i].paid, notes: '' })));
  applyRows('teams', saved);
  st().teamPrivate = await db.teamPrivate.list(s.event.id);
  toast(`${saved.length} lag importerade`, 'hi');
  render();
};

/** Tolkar inklistrade rader från Google Formulärs svarsblad. */
export function parseSignups(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const delim = lines[0].includes('\t') ? '\t' : lines[0].split(';').length > lines[0].split(',').length ? ';' : ',';
  const split = line => {
    if (delim === '\t') return line.split('\t');
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === delim && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const head = split(lines[0]).map(h => h.toLowerCase());
  const find = (...keys) => head.findIndex(h => keys.some(k => h.includes(k)));
  let col = { name: find('lagnamn', 'lagets namn'), contact: find('fullständiga namn', 'kapten'), phone: find('telefon'), email: find('e-post', 'epost', 'mail'), paid: find('swish', 'betal') };
  let body = lines.slice(1);
  if (col.name < 0) { col = { name: 0, contact: -1, phone: -1, email: -1, paid: -1 }; body = lines; }
  const get = (cells, i) => (i >= 0 ? (cells[i] || '').trim() : '');
  const seen = new Set();
  return body.map(split).map(c => ({
    name: get(c, col.name), contact: get(c, col.contact), phone: get(c, col.phone), email: get(c, col.email),
    paid: /^(ja|jajemän|yes|betal)/i.test(get(c, col.paid)),
  })).filter(x => {
    const k = x.name.toLowerCase();
    if (!x.name || seen.has(k)) return false;
    seen.add(k); return true;
  });
}

/* Deltagare */

A['add-player'] = async () => {
  const r = await dialog(`<form method="dialog" class="stack">
    <h2>Lägg till deltagare</h2>
    <label class="field"><span>Namn</span><input name="name" required maxlength="60"></label>
    <label class="field"><span>Avdelning</span><input name="department" maxlength="60"></label>
    <label class="field"><span>Specialkost</span><input name="diet" maxlength="300"></label>
    <div class="actions"><button class="btn ghost" data-close="">Avbryt</button><button class="btn" value="ok">Lägg till</button></div>
  </form>`);
  if (!r) return;
  const f = Object.fromEntries(new FormData(r.form));
  const s = st();
  const [p] = await db.players.save({ event_id: s.event.id, name: f.name.trim(), department: f.department.trim(), team_id: null, inactive: false });
  if (f.diet.trim()) { await db.playerPrivate.save({ player_id: p.id, event_id: s.event.id, diet: f.diet.trim(), email: '' }); s.playerPrivate = await db.playerPrivate.list(s.event.id); }
  applyRows('players', p);
  render();
};
A['del-player'] = async el => {
  const p = st().players.find(x => x.id === el.dataset.id);
  if (!(await confirmDlg(`Ta bort ${p.name}?`, '', 'Ta bort', { danger: true }))) return;
  await db.players.remove(p.id);
  st().players = st().players.filter(x => x.id !== p.id);
  render();
};
A['make-code'] = async () => { await patchConfig({ registration: { code: randCode(5) } }); render(); };
A['diets'] = async () => {
  const s = st();
  const priv = Object.fromEntries(s.playerPrivate.map(p => [p.player_id, p]));
  const text = s.players.filter(p => priv[p.id]?.diet).map(p => `${p.name}: ${priv[p.id].diet}`).join('\n');
  await dialog(`<form method="dialog"><h2>Specialkost</h2><p class="small muted" style="margin-bottom:12px">${s.players.length} deltagare totalt.</p>
    <textarea class="input" rows="10" readonly style="width:100%">${esc(text)}</textarea>
    <div class="actions"><button class="btn ghost" data-close="">Stäng</button><button class="btn" type="button" data-copy>Kopiera</button></div></form>`, {
    onOpen(d) { on(d, 'click', '[data-copy]', async () => { try { await navigator.clipboard.writeText(text); toast('Kopierat'); } catch (e) { d.querySelector('textarea').select(); } }); },
  });
};
A['make-teams'] = async () => {
  const s = st();
  const active = s.players.filter(p => !p.inactive);
  if (active.length < 2) { toast('Minst två deltagare behövs'); return; }
  const r = await dialog(`<form method="dialog" class="stack">
    <h2>Skapa lag</h2>
    <p class="muted">${active.length} deltagare. Kollegor från samma avdelning sprids ut över lagen. Lagen får slumpade boulenamn som går att ändra.</p>
    <label class="field"><span>Personer per lag</span><select name="size">${[2, 3, 4, 5, 6].map(v => `<option ${v === 4 ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    ${s.teams.length ? '<p class="small">Befintliga lag och schema ersätts.</p>' : ''}
    <div class="actions"><button class="btn ghost" data-close="">Avbryt</button><button class="btn" value="ok">Skapa lag</button></div>
  </form>`);
  if (!r) return;
  const size = Number(new FormData(r.form).get('size'));
  const made = E.makeTeams(active, size);
  if (s.matches.length) await db.matches.remove(s.matches.map(m => m.id));
  if (s.teams.length) await db.teams.remove(s.teams.map(t => t.id));
  const saved = await db.teams.save(made.map((t, i) => ({ event_id: s.event.id, name: t.name, members: t.members.map(p => p.name), seed: 0, costume: '', checked_in: true, sort: i })));
  const updates = [];
  saved.forEach((t, i) => made[i].members.forEach(p => updates.push({ ...s.players.find(x => x.id === p.id), team_id: t.id })));
  await db.players.save(updates);
  await S.live.reload();
  toast(`${saved.length} lag skapade`, 'hi');
  render();
};
A['print-sign'] = async () => {
  const ev = st().event;
  const url = pageUrl('delta') + '?k=' + cfg().registration.code;
  const pr = $('#print');
  pr.innerHTML = `<div class="dip" style="border:none"><i class="logo"></i><div class="team" style="font-size:30pt">Anmäl dig här</div><div id="sign-qr" style="width:95mm;margin:10mm auto"></div><div class="who">Skanna med kameran, eller gå till<br><b>${esc(url.replace(/^https?:\/\//, ''))}</b></div><div class="ev">${esc(ev.name)}</div></div>`;
  await qr($('#sign-qr'), url, { dark: '#093000', light: '#ffffff' });
  window.print();
};

/* Upplägg */

A['format'] = async el => { await patchConfig({ format: el.dataset.v }); render(); };

A['draw'] = async () => {
  const s = st(), c = cfg();
  const hasPlayed = s.matches.some(m => m.status !== 'planned');
  const r = await dialog(`<form method="dialog" class="stack">
    <h2>Lotta ${c.groups.count} grupper</h2>
    <p class="muted">${s.teams.length} lag${s.teams.some(t => t.seed > 0) ? '. Seedade lag hamnar i olika grupper.' : '.'}</p>
    ${s.matches.length ? `<p class="small">${hasPlayed ? 'Det finns spelade matcher. ' : ''}Spelschemat tas bort — skapa ett nytt efter lottningen.</p>` : ''}
    <label class="switch"><input type="checkbox" name="show" checked><span class="track"></span><span>Visa lottningen på storbilden</span></label>
    <div class="actions"><button class="btn ghost" data-close="">Avbryt</button><button class="btn" value="ok">Lotta</button></div>
  </form>`);
  if (!r) return;
  const show = new FormData(r.form).get('show');
  if (s.matches.length) await db.matches.remove(s.matches.map(m => m.id));
  const { assign, draw } = E.drawGroups(s.teams, c.groups.count);
  await db.teams.save(s.teams.map(t => ({ ...t, group_label: assign[t.id] })));
  if (show) await patchConfig({ screen: { pin: 'lottning', draw: { at: new Date().toISOString(), order: draw } } });
  await S.live.reload();
  toast(show ? 'Lottat — följ det på storbilden' : 'Grupperna är lottade', 'hi');
  render();
};

A['build-groups'] = async () => {
  const s = st();
  if (s.matches.length && !(await confirmDlg('Skapa om spelschemat?', s.matches.some(m => m.status !== 'planned') ? 'Spelade resultat försvinner.' : 'Det nuvarande schemat ersätts.', 'Skapa om', { danger: true }))) return;
  try {
    const ms = E.buildGroupsProgram(s.event, s.teams);
    if (s.matches.length) await db.matches.remove(s.matches.map(m => m.id));
    await db.matches.save(ms);
    await S.live.reload();
    toast(`${ms.length} matcher schemalagda`, 'hi');
    go(`#/e/${encodeURIComponent(s.event.slug)}/matcher`);
  } catch (e) { toast(e.message); }
};
A['swiss-next'] = async () => {
  const s = st();
  const ms = E.pairSwiss(s.event, s.teams, s.matches);
  await db.matches.save(ms);
  await S.live.reload();
  toast(`Omgång ${ms[0].round} är lottad`, 'hi');
  render();
};
A['swiss-playoff'] = async () => {
  const s = st();
  const ms = E.buildSwissPlayoff(s.event, s.matches);
  await db.matches.save(ms);
  await S.live.reload();
  toast('Slutspelet är skapat', 'hi');
  render();
};
A['melee-next'] = async () => {
  const s = st();
  try {
    const ms = E.meleeRound(s.event, s.players, s.matches);
    await db.matches.save(ms);
    await S.live.reload();
    toast(`Omgång ${ms[0].round} är lottad`, 'hi');
    render();
  } catch (e) { toast(e.message); }
};
A['clear-matches'] = async () => {
  const s = st();
  if (!(await confirmDlg('Rensa alla matcher?', 'Alla resultat försvinner.', 'Rensa', { danger: true }))) return;
  await db.matches.remove(s.matches.map(m => m.id));
  await S.live.reload();
  render();
};

/* Matcher: rätta resultat */

async function editMatch(id) {
  const s = st(), c = cfg();
  const m = resolvedMatches(s).find(x => x.id === id);
  if (!m) return;
  const names = nameMap(s);
  const r = await dialog(`<form method="dialog" class="stack">
    <h2>${esc(E.matchTitle(m))}</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <label class="field"><span>${esc(sideName(m, 'a', names))}</span><input name="a" type="number" min="0" max="99" value="${m.score_a}" inputmode="numeric"></label>
      <label class="field"><span>${esc(sideName(m, 'b', names))}</span><input name="b" type="number" min="0" max="99" value="${m.score_b}" inputmode="numeric"></label>
    </div>
    <div class="grid-2">
      <label class="field"><span>Läge</span><select name="status">${[['planned', 'Ej startad'], ['live', 'Pågår'], ['done', 'Klar']].map(([k, l]) => `<option value="${k}" ${m.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field"><span>Bana</span><input name="court" type="number" min="1" max="99" value="${m.court || ''}"></label>
      <label class="field"><span>Pass (tid)</span><select name="slot">${Array.from({ length: Math.max(...s.matches.map(x => x.slot)) + 3 }, (_, i) => `<option value="${i}" ${m.slot === i ? 'selected' : ''}>${E.slotTime(c, i)}</option>`).join('')}</select></label>
    </div>
    ${m.ends?.length ? `<p class="small muted">${m.ends.length} omgångar registrerade av domaren. Ändrar du poängen här gäller din siffra.</p>` : ''}
    <div class="actions">
      <button class="btn ghost" data-close="">Avbryt</button>
      ${m.status !== 'planned' ? '<button class="btn danger" value="reset">Nollställ</button>' : ''}
      <button class="btn" value="ok">Spara</button>
    </div>
  </form>`);
  if (!r) return;
  const f = Object.fromEntries(new FormData(r.form));
  const orig = s.matches.find(x => x.id === id);
  let patch;
  if (r.value === 'reset') patch = { score_a: 0, score_b: 0, ends: [], status: 'planned' };
  else {
    const a = Math.max(0, Number(f.a) || 0), b = Math.max(0, Number(f.b) || 0);
    if (f.status === 'done' && a === b && orig.stage !== 'group' && orig.stage !== 'swiss' && orig.stage !== 'melee') { toast('Slutspelsmatcher kan inte sluta lika.'); return; }
    patch = { score_a: a, score_b: b, status: f.status, court: f.court ? Number(f.court) : null, slot: Number(f.slot) };
    if (a !== orig.score_a || b !== orig.score_b) patch.ends = [];
  }
  const [saved] = await db.matches.save({ ...orig, ...patch, version: (orig.version || 0) + 1 });
  applyRows('matches', saved);
  toast('Matchen är sparad');
  render();
}
on(app, 'click', '.match.admin', (e, el) => editMatch(el.dataset.match));
on(app, 'keydown', '.match.admin', (e, el) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); editMatch(el.dataset.match); } });

/* Röstning och utmaningar */

A['reveal'] = async () => {
  const c = cfg();
  await patchConfig({ voting: { reveal: !c.voting.reveal, open: c.voting.reveal ? c.voting.open : false }, screen: { pin: c.voting.reveal ? null : 'rostning' } });
  toast(c.voting.reveal ? 'Resultatet är dolt' : 'Trumvirvel på storbilden …', 'hi');
  render();
};
A['refresh-votes'] = async () => { S.votes = await db.voteResults(st().event.id, true); render(); };
A['add-challenge'] = async () => {
  const r = await dialog(`<form method="dialog" class="stack">
    <h2>Ny utmaning</h2>
    <label class="field"><span>Namn</span><input name="name" required placeholder="Närmast lillen" maxlength="60"></label>
    <div class="grid-2">
      <label class="field"><span>Enhet</span><input name="unit" value="cm" maxlength="20"></label>
      <label class="field"><span>Vem vinner</span><select name="hb"><option value="0">Lägst värde</option><option value="1">Högst värde</option></select></label>
    </div>
    <div class="actions"><button class="btn ghost" data-close="">Avbryt</button><button class="btn" value="ok">Skapa</button></div>
  </form>`);
  if (!r) return;
  const f = Object.fromEntries(new FormData(r.form));
  const [ch] = await db.challenges.save({ event_id: st().event.id, name: f.name.trim(), unit: f.unit.trim(), higher_better: f.hb === '1', sort: st().challenges.length });
  applyRows('challenges', ch);
  render();
};
A['del-challenge'] = async el => {
  if (!(await confirmDlg('Ta bort utmaningen?', 'Alla resultat i den försvinner.', 'Ta bort', { danger: true }))) return;
  await db.challenges.remove(el.dataset.id);
  st().challenges = st().challenges.filter(x => x.id !== el.dataset.id);
  st().scores = st().scores.filter(x => x.challenge_id !== el.dataset.id);
  render();
};
A['add-score'] = async el => {
  const s = st();
  const ch = s.challenges.find(x => x.id === el.dataset.id);
  const who = s.players.length ? s.players.map(p => [p.id, p.name, 'p']) : s.teams.map(t => [t.id, t.name, 't']);
  const r = await dialog(`<form method="dialog" class="stack">
    <h2>${esc(ch.name)}</h2>
    <label class="field"><span>Vem</span><select name="who" required>${who.sort((a, b) => a[1].localeCompare(b[1], 'sv')).map(([id, n, k]) => `<option value="${k}:${id}">${esc(n)}</option>`).join('')}</select></label>
    <label class="field"><span>Resultat (${esc(ch.unit)})</span><input name="value" type="number" step="any" required inputmode="decimal"></label>
    <div class="actions"><button class="btn ghost" data-close="">Avbryt</button><button class="btn" value="ok">Spara</button></div>
  </form>`);
  if (!r) return;
  const f = Object.fromEntries(new FormData(r.form));
  const [k, id] = f.who.split(':');
  const [row] = await db.challengeScores.save({ event_id: s.event.id, challenge_id: ch.id, player_id: k === 'p' ? id : null, team_id: k === 't' ? id : null, value: Number(f.value) });
  applyRows('scores', row);
  render();
};
A['del-score'] = async el => {
  await db.challengeScores.remove(el.dataset.id);
  st().scores = st().scores.filter(x => x.id !== el.dataset.id);
  render();
};

/* Efteråt */

A['purge'] = async () => {
  if (!(await confirmDlg('Rensa personuppgifter?', 'Telefonnummer, mejl, specialkost och röster tas bort. Namn och resultat finns kvar.', 'Rensa', { danger: true }))) return;
  await db.purge(st().event.id);
  await S.live.reload();
  S.votes = [];
  toast('Personuppgifterna är rensade');
  render();
};
A['export-csv'] = () => {
  const s = st(), c = cfg();
  const res = resolvedMatches(s);
  const names = nameMap(s);
  const rows = [['Tid', 'Bana', 'Match', 'Lag A', 'Lag B', 'Poäng A', 'Poäng B', 'Läge']];
  res.forEach(m => rows.push([E.slotTime(c, m.slot), m.court || '', E.matchTitle(m), sideName(m, 'a', names), sideName(m, 'b', names), m.score_a, m.score_b, { planned: 'Ej spelad', live: 'Pågår', done: 'Klar' }[m.status]]));
  const csv = '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = s.event.slug + '-resultat.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
A['diplomas'] = () => {
  const s = st();
  const names = nameMap(s);
  const pl = placings().slice(0, 3);
  const members = id => s.teams.find(t => t.id === id)?.members?.join(', ') || '';
  const votes = (S.votes || []).slice().sort((a, b) => b.votes - a.votes);
  const costume = votes[0] && s.teams.find(t => t.id === votes[0].team_id);
  const place = ['', 'Vinnare', 'Tvåa', 'Trea'];
  $('#print').innerHTML = pl.map(p => `<div class="dip"><i class="logo"></i><div class="place">${place[p.place]}</div><div class="team">${esc(names[p.id])}</div><div class="who">${esc(members(p.id))}</div><div class="ev">${esc(s.event.name)} · ${esc(fmtDate(s.event.date, { day: 'numeric', month: 'long', year: 'numeric' }))}</div></div>`).join('')
    + (costume ? `<div class="dip"><i class="logo"></i><div class="place" style="font-size:40pt">Bästa utklädnad</div><div class="team">${esc(costume.name)}</div><div class="who">${esc(costume.costume || '')}</div><div class="ev">${esc(s.event.name)}</div></div>` : '');
  window.print();
};
A['del-event'] = async () => {
  const ev = st().event;
  if (!(await confirmDlg(`Ta bort ${ev.name}?`, 'Allt som hör till evenemanget försvinner. Går inte att ångra.', 'Ta bort för gott', { danger: true }))) return;
  await db.events.remove(ev.id);
  S.events = S.events.filter(e => e.id !== ev.id);
  S.live.stop(); S.live = null; S.liveSlug = null;
  go('#/');
};

/* Bokningar */

A['del-booking'] = async el => {
  if (!(await confirmDlg('Ta bort bokningen?', 'Ett kopplat evenemang finns kvar.', 'Ta bort', { danger: true }))) return;
  await db.bookings.remove(el.dataset.id);
  S.bookings = S.bookings.filter(b => b.id !== el.dataset.id);
  go('#/');
};
const curBooking = () => S.bookings.find(b => b.id === route().id);
A['quote-add'] = async () => { const b = curBooking(); await saveBooking({ id: b.id, items: [...(b.items || []), { d: '', qty: 1, price: 0, vat: 25 }] }); render(); };
A['quote-fill'] = async () => {
  const b = curBooking();
  const r = await dialog(`<form method="dialog" class="stack">
    <h2>Från prislistan</h2>
    <div class="check-list">${S.pricelist.map((p, i) => `<label class="check"><input type="checkbox" name="p" value="${i}"><span class="box"></span><span>${esc(p.d)} <span class="muted small">${p.price ? kr(p.price) + ' / ' + esc(p.unit) : 'pris saknas'}</span></span></label>`).join('')}</div>
    <div class="actions"><button class="btn ghost" data-close="">Avbryt</button><button class="btn" value="ok">Lägg till</button></div>
  </form>`);
  if (!r) return;
  const picked = new FormData(r.form).getAll('p').map(i => S.pricelist[Number(i)]);
  const items = [...(b.items || []), ...picked.map(p => ({ d: p.d, qty: p.unit === 'person' ? (b.participants || 1) : 1, price: p.price, vat: p.vat }))];
  await saveBooking({ id: b.id, items });
  render();
};
A['quote-del'] = async el => { const b = curBooking(); const items = (b.items || []).slice(); items.splice(Number(el.dataset.v), 1); await saveBooking({ id: b.id, items }); render(); };
A['quote-print'] = () => {
  const b = curBooking();
  const t = vatSums(b.items || []);
  const valid = new Date(Date.now() + 30 * 86400000).toLocaleDateString('sv-SE', { day: 'numeric', month: 'long', year: 'numeric' });
  $('#print').innerHTML = `<div class="doc">
    <div style="display:flex;justify-content:space-between;align-items:flex-start"><i class="logo"></i><div style="text-align:right"><b>Offert</b><br>${new Date().toLocaleDateString('sv-SE')}<br>Giltig till ${valid}</div></div>
    <h1 style="margin-top:14mm">Boulekampen för ${esc(b.company)}</h1>
    <p style="margin-top:6px">${esc([b.contact_name, b.email, b.phone].filter(Boolean).join(' · '))}</p>
    <p style="margin-top:4px">${esc([fmtDate(b.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), b.time, b.venue, b.participants ? b.participants + ' deltagare' : ''].filter(Boolean).join(' · '))}</p>
    <table><thead><tr><th>Beskrivning</th><th class="r">Antal</th><th class="r">À-pris</th><th class="r">Moms</th><th class="r">Summa</th></tr></thead>
    <tbody>${(b.items || []).map(i => `<tr><td>${esc(i.d)}</td><td class="r">${i.qty}</td><td class="r">${kr(i.price)}</td><td class="r">${i.vat} %</td><td class="r">${kr(i.qty * i.price)}</td></tr>`).join('')}</tbody></table>
    <table style="width:50%;margin-left:auto"><tbody>
      <tr><td>Summa ex moms</td><td class="r">${kr(t.ex)}</td></tr>
      ${Object.entries(t.byVat).filter(([v]) => Number(v)).map(([v, a]) => `<tr><td>Moms ${v} %</td><td class="r">${kr(a)}</td></tr>`).join('')}
      <tr><td><b>Att betala</b></td><td class="r"><b>${kr(t.total)}</b></td></tr>
    </tbody></table>
    <p style="margin-top:12mm">I priset ingår live-poängräkning, storbild med er logga och digital anmälan för deltagarna.</p>
  </div>`;
  window.print();
};
A['copy-runsheet'] = async () => {
  const b = curBooking();
  const rs = runSheet(planDefaults(b), b.participants);
  const text = rs.rows.map(([t, d]) => `${t}  ${d}`).join('\n');
  try { await navigator.clipboard.writeText(text); toast('Körschemat är kopierat'); } catch (e) { prompt('Kopiera:', text); }
};
A['booking-event'] = async () => {
  const b = curBooking();
  if (!b.company) { toast('Fyll i företaget först'); return; }
  const p = planDefaults(b);
  const { config } = planConfig(p, b.participants || 16);
  const ev = await createEvent({
    name: 'Boulekampen × ' + b.company, kind: 'foretag', date: b.date, venue: b.venue, company: b.company, booking_id: b.id,
    config: { format: config.format, groups: config.groups, swiss: config.swiss, melee: config.melee, courts: config.courts, start: config.start, matchMin: config.matchMin, breakMin: config.breakMin },
  });
  if (!ev) return;
  await saveBooking({ id: b.id, event_id: ev.id, status: b.status === 'forfragan' || b.status === 'offert' ? 'bekraftad' : b.status });
  go('#/e/' + encodeURIComponent(ev.slug) + '/lag');
};

/* ══════════════════════════════════════════════════════════════════════
   Händelser
   ══════════════════════════════════════════════════════════════════════ */

on(document, 'click', '[data-act]', async (e, el) => {
  const fn = A[el.dataset.act];
  if (!fn || el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
  e.preventDefault();
  if (el.dataset.busy) return;
  el.dataset.busy = '1';
  try { await fn(el, e); }
  catch (err) { console.error(err); toast(err.message || 'Något gick fel'); }
  finally { delete el.dataset.busy; }
});

// Fältändringar sparas när fältet lämnas (change)
on(app, 'change', 'input, select, textarea', async (e, el) => {
  try {
    const s = S.live?.state;
    if (el.dataset.team) {
      const t = s.teams.find(x => x.id === el.dataset.team);
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.f === 'members') v = String(v).split(',').map(x => x.trim()).filter(Boolean);
      if (el.dataset.f === 'seed') v = Number(v) || 0;
      if (el.dataset.f === 'group_label') v = v || null;
      if (el.dataset.f === 'name' && !String(v).trim()) { el.value = t.name; return; }
      const [saved] = await db.teams.save({ ...t, [el.dataset.f]: v });
      applyRows('teams', saved);
    } else if (el.dataset.tp) {
      const cur = s.teamPrivate.find(x => x.team_id === el.dataset.tp) || { team_id: el.dataset.tp, event_id: s.event.id, contact_name: '', phone: '', email: '', paid: false, notes: '' };
      const patch = { ...cur };
      if (el.dataset.f === 'paid') patch.paid = el.checked;
      if (el.dataset.f === 'contact') {
        const parts = el.value.split(',').map(x => x.trim());
        patch.contact_name = parts[0] || '';
        patch.phone = parts.slice(1).join(', ');
      }
      const [saved] = await db.teamPrivate.save(patch);
      const i = s.teamPrivate.findIndex(x => x.team_id === saved.team_id);
      if (i > -1) s.teamPrivate[i] = saved; else s.teamPrivate.push(saved);
    } else if (el.dataset.player) {
      const p = s.players.find(x => x.id === el.dataset.player);
      const f = el.dataset.f;
      const patch = f === 'active' ? { inactive: !el.checked } : { [f]: f === 'team_id' ? (el.value || null) : el.value };
      const [saved] = await db.players.save({ ...p, ...patch });
      applyRows('players', saved);
    } else if (el.dataset.cfg) {
      let v = el.type === 'checkbox' ? el.checked : el.type === 'number' || /toA|playoff|size/.test(el.dataset.cfg) ? Number(el.value) : el.value;
      if (el.type === 'number') v = Math.max(Number(el.min) || 0, Math.min(Number(el.max) || 999, v || 0));
      const patch = el.dataset.cfg.split('.').reduceRight((acc, k) => ({ [k]: acc }), v);
      await patchConfig(patch);
      render();
    } else if (el.dataset.actChange === 'screen-pin') {
      await saveEvent({ config: { ...st().event.config, screen: { ...(st().event.config?.screen || {}), pin: el.value || null } } });
      toast('Storbilden är uppdaterad');
    } else if (el.dataset.actChange === 'registration') {
      await patchConfig({ registration: { open: el.checked } });
      toast(el.checked ? 'Anmälan är öppen' : 'Anmälan är stängd');
    } else if (el.dataset.actChange === 'voting-open') {
      await patchConfig({ voting: { open: el.checked } });
      toast(el.checked ? 'Röstningen är öppen' : 'Röstningen är stängd');
    } else if (el.dataset.item) {
      const b = curBooking();
      const items = (b.items || []).slice();
      const k = Number(el.dataset.item);
      items[k] = { ...items[k], [el.dataset.f]: el.dataset.f === 'd' ? el.value : Number(el.value) || 0 };
      await saveBooking({ id: b.id, items });
      render();
    } else if (el.dataset.check) {
      const b = curBooking();
      const cl = ((b.checklist && b.checklist.length) ? b.checklist : DEFAULT_CHECKLIST).map(x => ({ ...x }));
      cl[Number(el.dataset.check)].done = el.checked;
      await saveBooking({ id: b.id, checklist: cl });
    }
  } catch (err) { console.error(err); toast(err.message || 'Kunde inte spara'); }
});

// Formulär
on(app, 'submit', 'form[data-form]', async (e, form) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  const kind = form.dataset.form;
  try {
    if (kind === 'announce') {
      await patchConfig({ announcement: f.text.trim() });
      toast(f.text.trim() ? 'Utropet syns nu' : 'Utropet är borttaget');
      render();
    } else if (kind === 'pin') {
      await db.setPin(st().event.id, f.pin);
      S.hasPin = true;
      toast('Domar-PIN är sparad');
      render();
    } else if (kind === 'event-settings') {
      const ev = st().event;
      const slug = slugify(f.slug).slice(0, 60);
      if (slug.length < 3) { toast('Adressen behöver minst tre tecken'); return; }
      const config = ev.kind === 'foretag' ? mergeDeep(ev.config || {}, { company: { name: f.company || '', logo: f.logo || '' } }) : ev.config;
      await saveEvent({ name: f.name.trim(), date: f.date || null, venue: f.venue, slug, listed: !!f.listed, config });
      toast('Sparat');
      if (slug !== S.liveSlug) { S.liveSlug = slug; go(`#/e/${encodeURIComponent(slug)}/installningar`); await S.live.reload(); }
      else render();
    } else if (kind === 'booking') {
      await saveBooking({ id: form.dataset.id, ...f, participants: Number(f.participants) || 0, date: f.date || null });
      toast('Bokningen är sparad');
      render();
    } else if (kind === 'plan') {
      const plan = { ...f };
      for (const k of ['teamSize', 'courts', 'intro', 'matchMin', 'breakMin', 'lunchAfter', 'lunchMin']) plan[k] = Number(plan[k]) || 0;
      await saveBooking({ id: form.dataset.id, plan });
      render();
    } else if (kind === 'check-add') {
      const b = curBooking();
      const cl = ((b.checklist && b.checklist.length) ? b.checklist : DEFAULT_CHECKLIST).concat({ t: f.t.trim(), done: false });
      await saveBooking({ id: b.id, checklist: cl });
      render();
    }
  } catch (err) { console.error(err); toast(err.message || 'Kunde inte spara'); }
});

// Klockan i översikten tickar utan att hela sidan ritas om
setInterval(() => {
  const el = $('[data-timer]');
  if (!el || !S.live?.state?.event) return;
  const t = timerLeft(cfg());
  if (t) el.textContent = t.text;
}, 1000);

boot();
