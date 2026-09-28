/**
 * Datalager. Samma API oavsett om data ligger i Supabase ("cloud") eller
 * i webbläsarens localStorage ("local", demoläge). Vyerna vet inte vilket.
 *
 * Realtid: subscribe(eventId, cb) anropar cb(table, type, row) när något
 * ändras — i cloud via Supabase Realtime, i local via BroadcastChannel
 * mellan flikar. cb('*', 'resync') betyder "hämta om allt" (t.ex. efter
 * att nätet varit borta).
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { uid } from './engine.js';

export const mode = SUPABASE_URL && SUPABASE_ANON_KEY ? 'cloud' : 'local';

/* ══════════════════════════════════════════════════════════════════════
   Local — demoläge
   ══════════════════════════════════════════════════════════════════════ */

const KEY = 'bk-local-v1';
const TABLES = ['events', 'event_secrets', 'teams', 'team_private', 'players', 'player_private',
  'matches', 'challenges', 'challenge_scores', 'votes', 'bookings', 'settings'];
const PK = { event_secrets: 'event_id', team_private: 'team_id', player_private: 'player_id', settings: 'key', votes: 'vkey' };
const PUBLIC = new Set(['events', 'teams', 'players', 'matches', 'challenges', 'challenge_scores']);

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('bk-local') : null;
const localListeners = new Set();

function readLocal() {
  let d;
  try { d = JSON.parse(localStorage.getItem(KEY)); } catch (e) { d = null; }
  d = d || {};
  for (const t of TABLES) d[t] = d[t] || [];
  return d;
}
function writeLocal(d, changes) {
  try { localStorage.setItem(KEY, JSON.stringify(d)); }
  catch (e) { throw new Error('Webbläsarens lagring är full eller avstängd.'); }
  const msg = changes.filter(c => PUBLIC.has(c.table) || c.table === 'votes' || c.table === 'bookings');
  if (!msg.length) return;
  if (channel) channel.postMessage(msg);
  localListeners.forEach(fn => fn(msg));
}
if (channel) channel.onmessage = e => localListeners.forEach(fn => fn(e.data));

const clone = x => JSON.parse(JSON.stringify(x));
const now = () => new Date().toISOString();

function lSelect(table, where = {}) {
  const d = readLocal();
  return clone(d[table].filter(r => Object.entries(where).every(([k, v]) => r[k] === v)));
}
function lUpsert(table, rows) {
  const d = readLocal();
  const pk = PK[table] || 'id';
  const out = [];
  const changes = [];
  for (const raw of [].concat(rows)) {
    const r = { ...raw };
    if (pk === 'id' && !r.id) r.id = uid();
    if (table === 'matches' || table === 'events' || table === 'bookings') r.updated_at = now();
    if (!r.created_at && table !== 'settings') r.created_at = now();
    const i = d[table].findIndex(x => x[pk] === r[pk]);
    if (i > -1) d[table][i] = { ...d[table][i], ...r }; else d[table].push(r);
    const saved = i > -1 ? d[table][i] : d[table][d[table].length - 1];
    out.push(clone(saved));
    changes.push({ table, type: 'upsert', row: clone(saved) });
  }
  writeLocal(d, changes);
  return out;
}
function lDelete(table, ids, key) {
  const d = readLocal();
  const pk = key || PK[table] || 'id';
  const set = new Set([].concat(ids));
  const gone = d[table].filter(r => set.has(r[pk]));
  d[table] = d[table].filter(r => !set.has(r[pk]));
  // Kaskader som databasen annars sköter
  const cascade = [];
  if (table === 'events') {
    for (const t of TABLES) if (t !== 'events') {
      const before = d[t].length;
      d[t] = d[t].filter(r => !set.has(r.event_id));
      if (before !== d[t].length) cascade.push(t);
    }
  }
  if (table === 'teams') {
    d.team_private = d.team_private.filter(r => !set.has(r.team_id));
    d.players.forEach(p => { if (set.has(p.team_id)) p.team_id = null; });
    d.matches.forEach(m => { if (set.has(m.team_a)) m.team_a = null; if (set.has(m.team_b)) m.team_b = null; });
  }
  if (table === 'players') d.player_private = d.player_private.filter(r => !set.has(r.player_id));
  if (table === 'challenges') d.challenge_scores = d.challenge_scores.filter(r => !set.has(r.challenge_id));
  writeLocal(d, gone.map(row => ({ table, type: 'delete', row })).concat(cascade.map(t => ({ table: t, type: 'resync' }))));
}

const byCode = code => lSelect('events').find(e => String(e.config?.registration?.code || '').toUpperCase() === String(code || '').trim().toUpperCase());

async function sha(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('bk:' + text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const local = {
  async session() { return { email: 'demo@lokalt', local: true }; },
  async signIn() { return { ok: true }; },
  async signOut() {},
  onAuth() { return () => {}; },

  table(t) {
    return {
      list: async (eventId) => lSelect(t, eventId ? { event_id: eventId } : {}),
      save: async rows => lUpsert(t, rows),
      remove: async ids => lDelete(t, ids),
    };
  },
  async eventBySlug(slug) { return lSelect('events', { slug })[0] || null; },
  async eventList() { return lSelect('events').sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))); },
  async setting(key) { return lSelect('settings', { key })[0]?.value ?? null; },
  async setSetting(key, value) { lUpsert('settings', { key, value }); },

  async hasPin(eventId) {
    return !!lSelect('event_secrets', { event_id: eventId })[0]?.pin_hash;
  },
  async setPin(eventId, pin) {
    lUpsert('event_secrets', { event_id: eventId, pin_hash: pin ? await sha(eventId + pin) : null });
  },
  async checkPin(eventId, pin) {
    const s = lSelect('event_secrets', { event_id: eventId })[0];
    return !!(s && s.pin_hash && s.pin_hash === await sha(eventId + pin));
  },
  async scoreMatch(eventId, pin, matchId, patch, version) {
    if (!(await local.checkPin(eventId, pin))) return { ok: false, error: 'pin' };
    const m = lSelect('matches', { id: matchId })[0];
    if (!m || m.event_id !== eventId) return { ok: false, error: 'missing' };
    if (version != null && m.version !== version) return { ok: false, error: 'conflict', row: m };
    const [row] = lUpsert('matches', { ...m, ...patch, version: m.version + 1 });
    return { ok: true, row };
  },
  async eventByCode(code) {
    const e = byCode(code);
    return e && { slug: e.slug, name: e.name, date: e.date, venue: e.venue, open: !!e.config?.registration?.open, company: e.config?.company?.name || '' };
  },
  async joinEvent(code, { name, department, diet, email }) {
    const e = byCode(code);
    if (!e) return { ok: false, error: 'code' };
    if (!e.config?.registration?.open) return { ok: false, error: 'closed' };
    if (!name || !name.trim()) return { ok: false, error: 'name' };
    const [p] = lUpsert('players', { event_id: e.id, name: name.trim().slice(0, 60), department: (department || '').trim().slice(0, 60), team_id: null, inactive: false });
    if ((diet || '').trim() || (email || '').trim()) lUpsert('player_private', { player_id: p.id, event_id: e.id, diet: (diet || '').trim(), email: (email || '').trim() });
    return { ok: true, slug: e.slug, player_id: p.id, event: e.name };
  },
  async vote(eventId, teamId, device) {
    const e = lSelect('events', { id: eventId })[0];
    if (!e?.config?.voting?.open) return { ok: false, error: 'closed' };
    lUpsert('votes', { vkey: eventId + '|' + device, event_id: eventId, device, team_id: teamId });
    return { ok: true };
  },
  async voteResults(eventId, asAdmin) {
    const e = lSelect('events', { id: eventId })[0];
    if (!asAdmin && !e?.config?.voting?.reveal) return [];
    const counts = {};
    lSelect('votes', { event_id: eventId }).forEach(v => { counts[v.team_id] = (counts[v.team_id] || 0) + 1; });
    return Object.entries(counts).map(([team_id, votes]) => ({ team_id, votes }));
  },
  async scoreChallenge(eventId, pin, row) {
    if (!(await local.checkPin(eventId, pin))) return { ok: false, error: 'pin' };
    const [r] = lUpsert('challenge_scores', { ...row, event_id: eventId });
    return { ok: true, row: r };
  },
  async purge(eventId) {
    const d = readLocal();
    d.player_private = d.player_private.filter(r => r.event_id !== eventId);
    d.team_private.forEach(r => { if (r.event_id === eventId) { r.phone = ''; r.email = ''; r.contact_name = ''; } });
    d.votes = d.votes.filter(r => r.event_id !== eventId);
    writeLocal(d, [{ table: 'votes', type: 'resync' }]);
  },

  subscribe(eventId, cb) {
    const fn = changes => {
      for (const c of changes) {
        if (c.type === 'resync') { cb('*', 'resync'); continue; }
        const r = c.row;
        if (c.table === 'events' ? r.id === eventId : r.event_id === eventId || !eventId) cb(c.table, c.type, r);
      }
    };
    localListeners.add(fn);
    const onStorage = e => { if (e.key === KEY) cb('*', 'resync'); };
    // BroadcastChannel täcker flikar; storage-eventet täcker webbläsare utan den
    if (!channel) addEventListener('storage', onStorage);
    return () => { localListeners.delete(fn); removeEventListener('storage', onStorage); };
  },
};

/* ══════════════════════════════════════════════════════════════════════
   Cloud — Supabase
   ══════════════════════════════════════════════════════════════════════ */

let sbPromise;
function sb() {
  if (!sbPromise) {
    sbPromise = import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm')
      .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        realtime: { params: { eventsPerSecond: 20 } },
      }));
  }
  return sbPromise;
}
const must = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

const cloud = {
  async session() {
    const c = await sb();
    const { data } = await c.auth.getSession();
    return data.session ? { email: data.session.user.email } : null;
  },
  async isAdmin() {
    const c = await sb();
    const { data, error } = await c.rpc('is_admin');
    return !error && data === true;
  },
  async signIn(email) {
    const c = await sb();
    const redirect = location.origin + location.pathname;
    must(await c.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect, shouldCreateUser: true } }));
    return { ok: true };
  },
  async signOut() { const c = await sb(); await c.auth.signOut(); },
  onAuth(cb) {
    let off = () => {};
    sb().then(c => { const { data } = c.auth.onAuthStateChange(() => cb()); off = () => data.subscription.unsubscribe(); });
    return () => off();
  },

  table(t) {
    const pk = PK[t] || 'id';
    return {
      list: async (eventId) => {
        const c = await sb();
        let q = c.from(t).select('*');
        if (eventId) q = q.eq('event_id', eventId);
        return must(await q.limit(5000));
      },
      save: async rows => {
        const c = await sb();
        const list = [].concat(rows).map(r => {
          const x = { ...r };
          // Fält som bara finns i vyerna (resolve()) ska inte till databasen
          delete x.a; delete x.b; delete x.la; delete x.lb; delete x.updated_at; delete x.created_at;
          return x;
        });
        if (!list.length) return [];
        return must(await c.from(t).upsert(list, { onConflict: pk }).select());
      },
      remove: async ids => {
        const c = await sb();
        const list = [].concat(ids);
        if (!list.length) return;
        must(await c.from(t).delete().in(pk, list));
      },
    };
  },
  async eventBySlug(slug) {
    const c = await sb();
    return must(await c.from('events').select('*').eq('slug', slug).maybeSingle());
  },
  async eventList() {
    const c = await sb();
    return must(await c.from('events').select('*').order('date', { ascending: false, nullsFirst: true }));
  },
  async setting(key) {
    const c = await sb();
    const r = must(await c.from('settings').select('value').eq('key', key).maybeSingle());
    return r ? r.value : null;
  },
  async setSetting(key, value) {
    const c = await sb();
    must(await c.from('settings').upsert({ key, value }));
  },
  async hasPin(eventId) {
    const c = await sb();
    return must(await c.rpc('has_scorer_pin', { p_event: eventId })) === true;
  },
  async setPin(eventId, pin) {
    const c = await sb();
    must(await c.rpc('set_scorer_pin', { p_event: eventId, p_pin: pin || '' }));
  },
  async checkPin(eventId, pin) {
    const c = await sb();
    return must(await c.rpc('check_pin', { p_event: eventId, p_pin: pin })) === true;
  },
  async scoreMatch(eventId, pin, matchId, patch, version) {
    const c = await sb();
    return must(await c.rpc('score_match', {
      p_event: eventId, p_pin: pin, p_match: matchId,
      p_score_a: patch.score_a, p_score_b: patch.score_b, p_ends: patch.ends || [],
      p_status: patch.status, p_version: version ?? null,
    }));
  },
  async eventByCode(code) {
    const c = await sb();
    return must(await c.rpc('event_by_code', { p_code: code }));
  },
  async joinEvent(code, { name, department, diet, email }) {
    const c = await sb();
    return must(await c.rpc('join_event', { p_code: code, p_name: name, p_department: department || '', p_diet: diet || '', p_email: email || '' }));
  },
  async vote(eventId, teamId, device) {
    const c = await sb();
    return must(await c.rpc('cast_vote', { p_event: eventId, p_team: teamId, p_device: device }));
  },
  async voteResults(eventId) {
    const c = await sb();
    return must(await c.rpc('vote_results', { p_event: eventId })) || [];
  },
  async scoreChallenge(eventId, pin, row) {
    const c = await sb();
    return must(await c.rpc('score_challenge', {
      p_event: eventId, p_pin: pin, p_challenge: row.challenge_id,
      p_player: row.player_id || null, p_team: row.team_id || null, p_value: row.value,
    }));
  },
  async purge(eventId) {
    const c = await sb();
    must(await c.rpc('purge_personal_data', { p_event: eventId }));
  },

  subscribe(eventId, cb) {
    let ch, dead = false, wasUp = false;
    sb().then(c => {
      if (dead) return;
      ch = c.channel('ev-' + eventId + '-' + Math.random().toString(36).slice(2, 7));
      for (const t of ['teams', 'players', 'matches', 'challenges', 'challenge_scores']) {
        ch.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: 'event_id=eq.' + eventId },
          p => cb(t, p.eventType === 'DELETE' ? 'delete' : 'upsert', p.eventType === 'DELETE' ? p.old : p.new));
      }
      ch.on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter: 'id=eq.' + eventId },
        p => cb('events', p.eventType === 'DELETE' ? 'delete' : 'upsert', p.eventType === 'DELETE' ? p.old : p.new));
      ch.subscribe(status => {
        // Efter ett avbrott kan ändringar ha missats — be vyn hämta om
        if (status === 'SUBSCRIBED') { if (wasUp) cb('*', 'resync'); wasUp = true; }
      });
    });
    const onOnline = () => cb('*', 'resync');
    addEventListener('online', onOnline);
    const onVisible = () => { if (document.visibilityState === 'visible') cb('*', 'resync'); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      dead = true;
      removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      sb().then(c => ch && c.removeChannel(ch));
    };
  },
};

/* ══════════════════════════════════════════════════════════════════════ */

const impl = mode === 'cloud' ? cloud : local;

export const db = {
  mode,
  session: () => impl.session(),
  isAdmin: () => (impl.isAdmin ? impl.isAdmin() : Promise.resolve(true)),
  signIn: email => impl.signIn(email),
  signOut: () => impl.signOut(),
  onAuth: cb => impl.onAuth(cb),

  events: {
    list: () => impl.eventList(),
    bySlug: slug => impl.eventBySlug(slug),
    save: row => impl.table('events').save(row).then(r => r[0]),
    remove: id => impl.table('events').remove(id),
  },
  teams: impl.table('teams'),
  teamPrivate: impl.table('team_private'),
  players: impl.table('players'),
  playerPrivate: impl.table('player_private'),
  matches: impl.table('matches'),
  challenges: impl.table('challenges'),
  challengeScores: impl.table('challenge_scores'),
  bookings: impl.table('bookings'),
  setting: key => impl.setting(key),
  setSetting: (key, value) => impl.setSetting(key, value),

  hasPin: id => impl.hasPin(id),
  setPin: (id, pin) => impl.setPin(id, pin),
  checkPin: (e, p) => impl.checkPin(e, p),
  scoreMatch: (e, p, m, patch, v) => impl.scoreMatch(e, p, m, patch, v),
  eventByCode: code => impl.eventByCode(code),
  joinEvent: (code, data) => impl.joinEvent(code, data),
  vote: (e, t, d) => impl.vote(e, t, d),
  voteResults: (e, asAdmin) => impl.voteResults(e, asAdmin),
  scoreChallenge: (e, p, row) => impl.scoreChallenge(e, p, row),
  purge: e => impl.purge(e),
  subscribe: (e, cb) => impl.subscribe(e, cb),
};

/**
 * Laddar allt för ett evenemang och håller det uppdaterat. onChange får
 * hela läget efter varje ändring. Returnerar { state, stop, reload }.
 */
export async function liveEvent(slug, onChange, { withPrivate = false } = {}) {
  const state = { event: null, teams: [], players: [], matches: [], challenges: [], scores: [], teamPrivate: [], playerPrivate: [] };
  async function loadAll() {
    const ev = await db.events.bySlug(slug);
    state.event = ev;
    if (!ev) return state;
    const jobs = [db.teams.list(ev.id), db.players.list(ev.id), db.matches.list(ev.id), db.challenges.list(ev.id), db.challengeScores.list(ev.id)];
    if (withPrivate) jobs.push(db.teamPrivate.list(ev.id), db.playerPrivate.list(ev.id));
    const [t, p, m, c, s, tp, pp] = await Promise.all(jobs);
    Object.assign(state, { teams: t, players: p, matches: m, challenges: c, scores: s });
    if (withPrivate) Object.assign(state, { teamPrivate: tp, playerPrivate: pp });
    return state;
  }
  await loadAll();
  let stop = () => {};
  const KEYS = { teams: 'teams', players: 'players', matches: 'matches', challenges: 'challenges', challenge_scores: 'scores' };
  let resyncTimer;
  function listen() {
    stop();
    if (!state.event) return;
    stop = db.subscribe(state.event.id, (table, type, row) => {
      if (table === '*' || type === 'resync') {
        clearTimeout(resyncTimer);
        resyncTimer = setTimeout(() => loadAll().then(() => onChange(state, { table: '*' })), 150);
        return;
      }
      if (table === 'events') {
        if (type === 'upsert') state.event = { ...state.event, ...row };
        onChange(state, { table, type, row });
        return;
      }
      const k = KEYS[table];
      if (!k) return;
      const list = state[k];
      const i = list.findIndex(x => x.id === row.id);
      if (type === 'delete') { if (i > -1) list.splice(i, 1); }
      else if (i > -1) list[i] = { ...list[i], ...row };
      else list.push(row);
      onChange(state, { table, type, row });
    });
  }
  listen();
  return {
    state,
    stop: () => stop(),
    reload: async () => { await loadAll(); listen(); onChange(state, { table: '*' }); },
  };
}
