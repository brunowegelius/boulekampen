/**
 * Boulekampen — turneringsmotor
 * ─────────────────────────────
 * Ren logik utan DOM och utan databas: lottning, spelschema, tabeller,
 * slutspel, schweizer-parning, mêlée och laggenerator. Allt som visas
 * i admin, domarvy, livesida och storbild räknas fram härifrån, så att
 * alla skärmar alltid är överens.
 *
 * Matcher sparas som rader. En slutspelsmatch vet inte vilka lag som
 * spelar förrän källorna är klara — den har i stället src_a/src_b som
 * pekar på "etta i grupp A" eller "vinnare av match X". resolve() fyller
 * i lagen när det går. Då behöver ingen "flytta fram" vinnare för hand,
 * och en rättad poäng i gruppspelet slår igenom i slutspelet direkt.
 */

export const uid = () =>
  (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

export const DEFAULT_CONFIG = {
  format: 'groups',                 // groups | swiss | melee
  groups: { count: 4, toA: 2, bCup: true, bronze: true, finalAlone: true },
  swiss:  { rounds: 4, playoff: 4, bronze: true },
  melee:  { rounds: 4, size: 2 },
  courts: 8,
  target: 13,                       // spelas till
  win: 2, draw: 1,                  // tabellpoäng
  start: '10:00',
  matchMin: 45,
  breakMin: 10,
  delay: 0,                         // förskjutning i minuter, sätts under dagen
  announcement: '',
  timer: null,                      // { endsAt: ISO, label }
  voting: { open: false, reveal: false },
  screen: { pin: null, draw: null },
  company: { name: '', logo: '' },
  registration: { open: false, code: '' },
};

/** Djup sammanslagning av config så att gamla evenemang får nya fält. */
export function withDefaults(cfg) {
  const out = structuredClone(DEFAULT_CONFIG);
  (function merge(t, s) {
    if (!s || typeof s !== 'object') return;
    for (const k of Object.keys(s)) {
      const v = s[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object') merge(t[k], v);
      else t[k] = v;
    }
  })(out, cfg || {});
  return out;
}

/* ── Slump ─────────────────────────────────────────────────────────── */

/** Seedbar slump — samma frö ger samma lottning, bra för tester. */
export function rng(seed) {
  if (seed == null) return Math.random;
  let a = typeof seed === 'number' ? seed : [...String(seed)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(list, rand = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const groupLabel = i => String.fromCharCode(65 + i);

/* ── Tider ─────────────────────────────────────────────────────────── */

export function toMin(hhmm) {
  const [h, m] = String(hhmm || '10:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
export function fmtMin(total) {
  const t = ((Math.round(total) % 1440) + 1440) % 1440;
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}
/** Starttid för ett pass. Passen ligger back-to-back med paus emellan. */
export function slotTime(cfg, slot) {
  const c = withDefaults(cfg);
  return fmtMin(toMin(c.start) + (c.delay || 0) + slot * (c.matchMin + c.breakMin));
}

/* ── Lottning och gruppspel ────────────────────────────────────────── */

/**
 * Lottar lag till grupper. Seedade lag (seed > 0, lägst först) placeras
 * först, ett per grupp, så att t.ex. fjolårets vinnare och tvåa inte
 * hamnar i samma grupp. Returnerar också ordningen lagen drogs i — den
 * används av storbildens lottningsceremoni.
 */
export function drawGroups(teams, count, rand = Math.random) {
  const n = Math.max(1, Math.min(count, teams.length || 1));
  const seeded = teams.filter(t => t.seed > 0).sort((a, b) => a.seed - b.seed);
  const rest = shuffle(teams.filter(t => !(t.seed > 0)), rand);
  const order = [...seeded, ...rest];
  const sizes = Array(n).fill(0);
  const assign = {};
  const draw = [];
  // Fyll grupperna varvvis så att storlekarna skiljer högst ett lag.
  // Inom varje varv slumpas gruppordningen, annars får grupp A alltid
  // det extra laget när antalet inte går jämnt ut.
  let i = 0;
  while (i < order.length) {
    const lap = shuffle([...Array(n).keys()], rand);
    const target = Math.min(...sizes);
    for (const g of lap) {
      if (i >= order.length) break;
      if (sizes[g] !== target) continue;
      const t = order[i++];
      assign[t.id] = groupLabel(g);
      sizes[g]++;
      draw.push({ team: t.id, group: groupLabel(g) });
    }
  }
  return { assign, draw };
}

/** Alla-mot-alla med cirkelmetoden. Udda antal → ett lag står över per omgång. */
export function roundRobin(ids) {
  const list = ids.slice();
  if (list.length < 2) return [];
  if (list.length % 2) list.push(null);
  const n = list.length;
  const rounds = [];
  let arr = list.slice();
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i], b = arr[n - 1 - i];
      if (a != null && b != null) pairs.push(r % 2 ? [b, a] : [a, b]);
    }
    rounds.push(pairs);
    arr = [arr[0], arr[n - 1], ...arr.slice(1, n - 1)];
  }
  return rounds;
}

function blankMatch(eventId, extra) {
  return {
    id: uid(), event_id: eventId,
    stage: 'group', round: 1, group_label: null, label: null,
    slot: 0, court: null,
    team_a: null, team_b: null, src_a: null, src_b: null,
    players_a: null, players_b: null,
    score_a: 0, score_b: 0, ends: [],
    status: 'planned', bye: false, version: 0,
    ...extra,
  };
}

/**
 * Lägger ut omgångar på banor och pass. En omgång med fler matcher än
 * banor delas i flera pass. Bana-startpunkten roteras per omgång så att
 * samma lag inte står på samma bana hela dagen.
 */
export function scheduleWaves(rounds, courts, startSlot = 0) {
  let slot = startSlot;
  rounds.forEach((matches, r) => {
    const c = Math.max(1, courts);
    for (let w = 0; w * c < matches.length; w++) {
      const wave = matches.slice(w * c, (w + 1) * c);
      const offset = (r * 3) % c;
      wave.forEach((m, k) => {
        m.slot = slot;
        m.court = ((k + offset) % c) + 1;
      });
      slot++;
    }
  });
  return slot;
}

/* ── Slutspel ──────────────────────────────────────────────────────── */

const isPow2 = n => n >= 2 && (n & (n - 1)) === 0;

function koRoundName(pairs) {
  return pairs === 1 ? 'Final'
    : pairs === 2 ? 'Semifinal'
    : pairs === 4 ? 'Kvartsfinal'
    : pairs === 8 ? 'Åttondelsfinal'
    : 'Omgång';
}

/**
 * Bygger ett utslagsträd ur första omgångens par. Varje senare match
 * pekar på vinnarna av två matcher före. Returnerar matcherna grupperade
 * per omgång så att schemaläggaren kan lägga dem i pass.
 */
export function buildBracket(eventId, stage, firstPairs, { bronze = false, prefix = '' } = {}) {
  const rounds = [];
  let prev = firstPairs.map(([a, b], i) => blankMatch(eventId, {
    stage, round: 1, src_a: a, src_b: b,
    label: prefix + koRoundName(firstPairs.length) + (firstPairs.length > 1 ? ' ' + (i + 1) : ''),
  }));
  rounds.push(prev);
  let r = 1;
  while (prev.length > 1) {
    r++;
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(blankMatch(eventId, {
        stage, round: r,
        src_a: { type: 'winner', match: prev[i].id },
        src_b: { type: 'winner', match: prev[i + 1].id },
        label: prefix + koRoundName(prev.length / 2) + (prev.length / 2 > 1 ? ' ' + (i / 2 + 1) : ''),
      }));
    }
    rounds.push(next);
    prev = next;
  }
  if (bronze && rounds.length >= 2) {
    const semis = rounds[rounds.length - 2];
    rounds[rounds.length - 1].push(blankMatch(eventId, {
      stage, round: r, bronze: true,
      src_a: { type: 'loser', match: semis[0].id },
      src_b: { type: 'loser', match: semis[1].id },
      label: prefix + 'Bronsmatch',
    }));
  }
  return rounds;
}

/**
 * Första omgångens par ur gruppspelet. Med två vidare per grupp korsas
 * grupperna (1A–2B, 1B–2A …) och ordnas så att lag från samma grupp
 * hamnar i olika halvor av trädet — de kan först mötas i finalen.
 * from = placeringen som räknas som "etta" (1 för A, 3 för B med två vidare).
 */
export function groupKoPairs(groupLabels, perGroup, from = 1) {
  const G = groupLabels.length;
  const s = (g, pos) => ({ type: 'group', group: g, pos });
  if (perGroup === 2 && G === 1) return [[s(groupLabels[0], from), s(groupLabels[0], from + 1)]];
  if (perGroup === 2 && G % 2 === 0) {
    const top = [], bottom = [];
    for (let i = 0; i < G; i += 2) {
      const x = groupLabels[i], y = groupLabels[i + 1];
      top.push([s(x, from), s(y, from + 1)]);
      bottom.push([s(y, from), s(x, from + 1)]);
    }
    return [...top, ...bottom];
  }
  if (perGroup === 1 && isPow2(G)) {
    return seededPairs(groupLabels.map(g => s(g, from)));
  }
  return null;
}

/** Standardseedning 1–N, 2–(N-1) … ordnat så att 1 och 2 bara kan mötas i finalen. */
export function seededPairs(slots) {
  const n = slots.length;
  let order = [1];
  while (order.length < n) {
    const size = order.length * 2;
    order = order.flatMap(x => [x, size + 1 - x]);
  }
  const pairs = [];
  for (let i = 0; i < order.length; i += 2) pairs.push([slots[order[i] - 1], slots[order[i + 1] - 1]]);
  return pairs;
}

/** Säger om slutspelsinställningen går ihop med antalet lag och grupper. */
export function validateGroups(cfg, teamCount) {
  const c = withDefaults(cfg);
  const G = c.groups.count;
  const q = c.groups.toA;
  const minSize = Math.floor(teamCount / G);
  if (teamCount < 2) return 'Lägg till minst två lag.';
  if (G < 1) return 'Minst en grupp.';
  if (minSize < 2) return `${teamCount} lag räcker inte till ${G} grupper.`;
  if (q > 0) {
    if (q > minSize) return `Grupperna är för små för att ${q} lag ska gå vidare.`;
    if (!groupKoPairs(Array.from({ length: G }, (_, i) => groupLabel(i)), q)) {
      return `${G} grupper med ${q} vidare ger ${G * q} lag i slutspelet — det måste bli 2, 4, 8 eller 16, med ett jämnt antal grupper när två går vidare.`;
    }
    if (c.groups.bCup && minSize < q * 2) return `B-slutspelet behöver minst ${q * 2} lag i varje grupp.`;
  }
  return null;
}

/**
 * Hela programmet för formatet grupper + slutspel. Slutspelet skapas
 * direkt med platshållare, så spelschemat med tider finns från start.
 */
export function buildGroupsProgram(event, teams) {
  const cfg = withDefaults(event.config);
  const labels = [...new Set(teams.map(t => t.group_label).filter(Boolean))].sort();
  const groupRounds = [];
  const perGroup = labels.map(g => roundRobin(teams.filter(t => t.group_label === g).map(t => t.id)));
  const maxR = Math.max(0, ...perGroup.map(r => r.length));
  for (let r = 0; r < maxR; r++) {
    const round = [];
    perGroup.forEach((rounds, gi) => {
      (rounds[r] || []).forEach(([a, b]) => round.push(blankMatch(event.id, {
        stage: 'group', round: r + 1, group_label: labels[gi], team_a: a, team_b: b,
      })));
    });
    groupRounds.push(round);
  }
  let slot = scheduleWaves(groupRounds, cfg.courts, 0);
  const all = groupRounds.flat();

  const q = cfg.groups.toA;
  if (q > 0) {
    const aPairs = groupKoPairs(labels, q, 1);
    if (!aPairs) throw new Error('Slutspelet går inte ihop med antalet grupper.');
    const A = buildBracket(event.id, 'A', aPairs, { bronze: cfg.groups.bronze });
    let B = [];
    if (cfg.groups.bCup) {
      const bPairs = groupKoPairs(labels, q, q + 1);
      if (bPairs) B = buildBracket(event.id, 'B', bPairs, { prefix: 'B-' });
    }
    const len = Math.max(A.length, B.length);
    const koRounds = [];
    let finalMatch = null;
    for (let r = 0; r < len; r++) {
      let ms = [...(A[r] || []), ...(B[r] || [])];
      if (cfg.groups.finalAlone && r === A.length - 1) {
        finalMatch = ms.find(m => m.stage === 'A' && !m.bronze);
        ms = ms.filter(m => m !== finalMatch);
      }
      if (ms.length) koRounds.push(ms);
    }
    slot = scheduleWaves(koRounds, cfg.courts, slot);
    if (finalMatch) { finalMatch.slot = slot; finalMatch.court = 1; slot++; }
    all.push(...koRounds.flat());
    if (finalMatch) all.push(finalMatch);
  }
  return all;
}

/* ── Upplösning av slutspelsplatser ────────────────────────────────── */

/** Vinnande sida, 'a' eller 'b'. null om matchen inte är klar eller slutade lika. */
export function winnerOf(m) {
  if (m.status !== 'done') return null;
  if (m.bye) return 'a';
  if (m.score_a === m.score_b) return null;
  return m.score_a > m.score_b ? 'a' : 'b';
}

const POS_WORDS = ['', 'Etta', 'Tvåa', 'Trea', 'Fyra', 'Femma', 'Sexa', 'Sjua', 'Åtta'];

/**
 * Fyller i vilka lag som faktiskt spelar varje match. Returnerar nya
 * matchobjekt med a/b (lag-id eller null) och la/lb (text att visa när
 * laget inte är klart än, t.ex. "Etta grupp A").
 */
export function resolve(event, teams, matches) {
  const cfg = withDefaults(event.config);
  const byId = new Map(matches.map(m => [m.id, m]));
  const groupCache = new Map();
  let swissCache;

  function groupTable(g) {
    if (groupCache.has(g)) return groupCache.get(g);
    const gm = matches.filter(m => m.stage === 'group' && m.group_label === g);
    const complete = gm.length > 0 && gm.every(m => m.status === 'done');
    const ids = teams.filter(t => t.group_label === g).map(t => t.id);
    const res = complete ? standings(ids, gm.map(m => ({ ...m, a: m.team_a, b: m.team_b })), cfg) : null;
    groupCache.set(g, res);
    return res;
  }
  function swissTable() {
    if (swissCache !== undefined) return swissCache;
    const sm = matches.filter(m => m.stage === 'swiss');
    const rounds = new Set(sm.map(m => m.round));
    const complete = sm.length > 0 && rounds.size >= cfg.swiss.rounds && sm.every(m => m.status === 'done');
    swissCache = complete
      ? standings(teams.map(t => t.id), sm.map(m => ({ ...m, a: m.team_a, b: m.team_b })), cfg, { tiebreak: 'buchholz' })
      : null;
    return swissCache;
  }

  const memo = new Map();
  function side(m, s, depth = 0) {
    const key = m.id + s;
    if (memo.has(key)) return memo.get(key);
    const fixed = s === 'a' ? m.team_a : m.team_b;
    const src = s === 'a' ? m.src_a : m.src_b;
    let out = { id: fixed || null, label: null };
    if (!fixed && src && depth < 12) {
      if (src.type === 'group') {
        const t = groupTable(src.group);
        out = { id: t ? t[src.pos - 1]?.team ?? null : null, label: `${POS_WORDS[src.pos] || src.pos + ':a'} grupp ${src.group}` };
      } else if (src.type === 'seed') {
        const t = swissTable();
        out = { id: t ? t[src.pos - 1]?.team ?? null : null, label: `Placering ${src.pos}` };
      } else if (src.type === 'winner' || src.type === 'loser') {
        const sm = byId.get(src.match);
        if (sm) {
          const a = side(sm, 'a', depth + 1), b = side(sm, 'b', depth + 1);
          const w = sm.status === 'done' && sm.score_a !== sm.score_b ? (sm.score_a > sm.score_b ? 'a' : 'b') : null;
          const pick = !w ? null : src.type === 'winner' ? w : (w === 'a' ? 'b' : 'a');
          out = {
            id: pick ? (pick === 'a' ? a.id : b.id) : null,
            label: (src.type === 'winner' ? 'Vinnare ' : 'Förlorare ') + (sm.label || 'match').toLowerCase(),
          };
        }
      }
    }
    memo.set(key, out);
    return out;
  }

  return matches.map(m => {
    const a = side(m, 'a'), b = side(m, 'b');
    return { ...m, a: a.id, b: b.id, la: a.label, lb: b.label };
  });
}

/* ── Tabeller ──────────────────────────────────────────────────────── */

/**
 * Tabell för en uppsättning lag. Matcherna ska vara resolve():ade (a/b).
 * Ordning: tabellpoäng → inbördes möten (bara när exakt samma poäng) →
 * poängskillnad → gjorda poäng → namn. Schweizer: Buchholz före skillnad.
 */
export function standings(teamIds, matches, cfg, { tiebreak = 'h2h', names = {} } = {}) {
  const c = withDefaults(cfg);
  const set = new Set(teamIds);
  const rows = new Map(teamIds.map(id => [id, { team: id, played: 0, won: 0, drawn: 0, lost: 0, pf: 0, pa: 0, diff: 0, pts: 0, bh: 0, opp: [] }]));
  const done = matches.filter(m => m.status === 'done');

  for (const m of done) {
    if (m.bye) {
      const r = rows.get(m.a);
      if (!r) continue;
      r.played++; r.won++; r.pts += c.win; r.pf += m.score_a; r.pa += m.score_b;
      continue;
    }
    if (!set.has(m.a) || !set.has(m.b)) continue;
    const ra = rows.get(m.a), rb = rows.get(m.b);
    ra.played++; rb.played++;
    ra.pf += m.score_a; ra.pa += m.score_b;
    rb.pf += m.score_b; rb.pa += m.score_a;
    ra.opp.push(m.b); rb.opp.push(m.a);
    if (m.score_a > m.score_b) { ra.won++; rb.lost++; ra.pts += c.win; }
    else if (m.score_b > m.score_a) { rb.won++; ra.lost++; rb.pts += c.win; }
    else { ra.drawn++; rb.drawn++; ra.pts += c.draw; rb.pts += c.draw; }
  }
  for (const r of rows.values()) {
    r.diff = r.pf - r.pa;
    r.bh = r.opp.reduce((s, o) => s + (rows.get(o)?.pts || 0), 0);
  }

  const byName = (a, b) => String(names[a.team] || a.team).localeCompare(String(names[b.team] || b.team), 'sv');
  const base = (a, b) =>
    (tiebreak === 'buchholz' ? b.bh - a.bh : 0) || b.diff - a.diff || b.pf - a.pf || byName(a, b);

  const list = [...rows.values()].sort((a, b) => b.pts - a.pts);
  const out = [];
  for (let i = 0; i < list.length;) {
    let j = i;
    while (j < list.length && list[j].pts === list[i].pts) j++;
    const cluster = list.slice(i, j);
    if (cluster.length > 1 && tiebreak === 'h2h') {
      const ids = new Set(cluster.map(r => r.team));
      const mini = new Map(cluster.map(r => [r.team, 0]));
      for (const m of done) {
        if (m.bye || !ids.has(m.a) || !ids.has(m.b)) continue;
        if (m.score_a > m.score_b) mini.set(m.a, mini.get(m.a) + c.win);
        else if (m.score_b > m.score_a) mini.set(m.b, mini.get(m.b) + c.win);
        else { mini.set(m.a, mini.get(m.a) + c.draw); mini.set(m.b, mini.get(m.b) + c.draw); }
      }
      cluster.sort((a, b) => mini.get(b.team) - mini.get(a.team) || base(a, b));
    } else {
      cluster.sort(base);
    }
    out.push(...cluster);
    i = j;
  }
  out.forEach((r, i) => { r.rank = i + 1; delete r.opp; });
  return out;
}

/* ── Schweizer system ──────────────────────────────────────────────── */

/**
 * Parar nästa omgång: lag med lika resultat möts, ingen möter samma lag
 * två gånger så länge det går. Udda antal → lägst rankade lag som inte
 * redan stått över får en walkover (13–7, som i vanliga pétanquetävlingar).
 */
export function pairSwiss(event, teams, matches, rand = Math.random) {
  const cfg = withDefaults(event.config);
  const sm = matches.filter(m => m.stage === 'swiss');
  const round = Math.max(0, ...sm.map(m => m.round)) + 1;
  const ids = teams.map(t => t.id);
  const played = new Set();
  const hadBye = new Set();
  for (const m of sm) {
    if (m.bye) hadBye.add(m.team_a);
    else { played.add(m.team_a + '|' + m.team_b); played.add(m.team_b + '|' + m.team_a); }
  }
  let order;
  if (round === 1) order = shuffle(ids, rand);
  else {
    const table = standings(ids, sm.map(m => ({ ...m, a: m.team_a, b: m.team_b })), cfg, { tiebreak: 'buchholz' });
    order = table.map(r => r.team);
  }
  const out = [];
  if (order.length % 2) {
    const byeTeam = [...order].reverse().find(id => !hadBye.has(id)) ?? order[order.length - 1];
    order = order.filter(id => id !== byeTeam);
    out.push(blankMatch(event.id, {
      stage: 'swiss', round, team_a: byeTeam, bye: true,
      score_a: cfg.target, score_b: 7, status: 'done', label: 'Står över',
    }));
  }
  function pair(list, strict) {
    if (!list.length) return [];
    const [first, ...rest] = list;
    for (let k = 0; k < rest.length; k++) {
      if (strict && played.has(first + '|' + rest[k])) continue;
      const sub = pair(rest.filter((_, i) => i !== k), strict);
      if (sub) return [[first, rest[k]], ...sub];
    }
    return null;
  }
  const pairs = pair(order, true) || pair(order, false);
  const games = pairs.map(([a, b]) => blankMatch(event.id, { stage: 'swiss', round, team_a: a, team_b: b }));
  const lastSlot = Math.max(-1, ...matches.map(m => m.slot ?? -1));
  scheduleWaves([games], cfg.courts, lastSlot + 1);
  return [...games, ...out.map(m => ({ ...m, slot: lastSlot + 1, court: null }))];
}

/** Slutspel efter schweizer: topp N efter sista omgången. */
export function buildSwissPlayoff(event, matches) {
  const cfg = withDefaults(event.config);
  const n = cfg.swiss.playoff;
  if (!isPow2(n)) return [];
  const slots = Array.from({ length: n }, (_, i) => ({ type: 'seed', pos: i + 1 }));
  const rounds = buildBracket(event.id, 'A', seededPairs(slots), { bronze: cfg.swiss.bronze });
  const lastSlot = Math.max(-1, ...matches.map(m => m.slot ?? -1));
  scheduleWaves(rounds, cfg.courts, lastSlot + 1);
  return rounds.flat();
}

/* ── Mêlée ─────────────────────────────────────────────────────────── */

/**
 * Delar n spelare i matcher. Mål: size mot size. När det inte går jämnt
 * blandas in 3–3, 2–2 och i sista hand en 3–2 (tremannalaget spelar då
 * med två klot var, som i en vanlig mêlée).
 */
export function meleeShape(n, size = 2) {
  const main = size * 2;
  const alt = size === 2 ? 6 : 4;
  let best = null;
  for (let odd = 0; odd <= 1; odd++) {
    for (let c = 0; c * alt + odd * 5 <= n; c++) {
      const rest = n - c * alt - odd * 5;
      if (rest % main) continue;
      const cand = { main: rest / main, alt: c, odd };
      const cost = cand.odd * 100 + cand.alt;
      if (!best || cost < best.cost) best = { ...cand, cost };
    }
  }
  if (!best) return null;
  const shape = [];
  for (let i = 0; i < best.main; i++) shape.push([size, size]);
  for (let i = 0; i < best.alt; i++) shape.push(size === 2 ? [3, 3] : [2, 2]);
  if (best.odd) shape.push([3, 2]);
  return shape;
}

/**
 * Ny omgång mêlée: nya lagkamrater varje omgång. Provar ett par hundra
 * blandningar och väljer den där minst antal par spelat ihop förut.
 */
export function meleeRound(event, players, matches, rand = Math.random) {
  const cfg = withDefaults(event.config);
  const active = players.filter(p => !p.inactive);
  const shape = meleeShape(active.length, cfg.melee.size);
  if (!shape) throw new Error('Minst fyra spelare behövs för en omgång.');
  const mm = matches.filter(m => m.stage === 'melee');
  const round = Math.max(0, ...mm.map(m => m.round)) + 1;
  const mates = new Map();
  const foes = new Map();
  const bump = (map, a, b) => { const k = a < b ? a + b : b + a; map.set(k, (map.get(k) || 0) + 1); };
  for (const m of mm) {
    for (const side of [m.players_a || [], m.players_b || []])
      for (let i = 0; i < side.length; i++) for (let j = i + 1; j < side.length; j++) bump(mates, side[i], side[j]);
    for (const a of m.players_a || []) for (const b of m.players_b || []) bump(foes, a, b);
  }
  const key = (a, b) => (a < b ? a + b : b + a);
  let best = null;
  for (let t = 0; t < 300; t++) {
    const order = shuffle(active.map(p => p.id), rand);
    let k = 0, cost = 0;
    const games = shape.map(([x, y]) => {
      const A = order.slice(k, k + x); k += x;
      const B = order.slice(k, k + y); k += y;
      for (const side of [A, B])
        for (let i = 0; i < side.length; i++) for (let j = i + 1; j < side.length; j++) cost += 10 * (mates.get(key(side[i], side[j])) || 0);
      for (const a of A) for (const b of B) cost += foes.get(key(a, b)) || 0;
      return [A, B];
    });
    if (!best || cost < best.cost) best = { cost, games };
    if (cost === 0) break;
  }
  const games = best.games.map(([A, B]) => blankMatch(event.id, { stage: 'melee', round, players_a: A, players_b: B }));
  const lastSlot = Math.max(-1, ...matches.map(m => m.slot ?? -1));
  scheduleWaves([games], cfg.courts, lastSlot + 1);
  return games;
}

/** Individuell tabell för mêlée. */
export function playerStandings(players, matches) {
  const rows = new Map(players.map(p => [p.id, { player: p.id, played: 0, won: 0, lost: 0, pf: 0, pa: 0, diff: 0 }]));
  for (const m of matches) {
    if (m.stage !== 'melee' || m.status !== 'done') continue;
    const sides = [[m.players_a || [], m.score_a, m.score_b], [m.players_b || [], m.score_b, m.score_a]];
    for (const [ids, f, a] of sides) for (const id of ids) {
      const r = rows.get(id);
      if (!r) continue;
      r.played++; r.pf += f; r.pa += a;
      if (f > a) r.won++; else if (f < a) r.lost++;
    }
  }
  const out = [...rows.values()];
  out.forEach(r => { r.diff = r.pf - r.pa; });
  out.sort((a, b) => b.won - a.won || b.diff - a.diff || b.pf - a.pf);
  out.forEach((r, i) => { r.rank = i + 1; });
  return out;
}

/* ── Laggenerator för företag ──────────────────────────────────────── */

export const TEAM_NAMES = [
  'Lillens vänner', 'Carreau-kollektivet', 'Sista klotet', 'Tretton blankt', 'Grisjägarna',
  'Järnkloten', 'Pointeurerna', 'Skyttarna', 'Fanny-flykten', 'Måttbandet', 'Klotrullarna',
  'Mäta med tumme', 'Rulla hem', 'Bak i banan', 'Knappt en decimeter', 'Tolv och en halv',
  'Grusgänget', 'Kulturklotet', 'Kaffe & carreau', 'Petit Pétanque', 'Kast i blindo', 'Lågt och långt',
  'Hela vägen fram', 'Omgång sju', 'Klotfabriken', 'Tjuvkastarna', 'Sidledes', 'Kulstötarna',
];

/**
 * Delar in deltagare i lag. Kollegor från samma avdelning sprids ut så
 * mycket det går — poängen med dagen är att folk som sällan ses spelar ihop.
 */
export function makeTeams(players, size = 4, rand = Math.random) {
  const n = players.length;
  if (!n) return [];
  const T = Math.max(1, Math.round(n / size));
  const byDept = new Map();
  for (const p of shuffle(players, rand)) {
    const d = (p.department || '').trim().toLowerCase() || '—';
    if (!byDept.has(d)) byDept.set(d, []);
    byDept.get(d).push(p);
  }
  const flat = [...byDept.values()].sort((a, b) => b.length - a.length).flat();
  const teams = Array.from({ length: T }, () => []);
  flat.forEach((p, i) => teams[i % T].push(p));
  const names = shuffle(TEAM_NAMES, rand);
  return teams.map((members, i) => ({ name: names[i % names.length] + (i >= names.length ? ' ' + (Math.floor(i / names.length) + 1) : ''), members }));
}

/* ── Tidsuppskattning ──────────────────────────────────────────────── */

/**
 * Hur lång blir dagen? Används både i admin ("beräknat slut") och i
 * bokningsplaneringen innan något lag finns.
 */
export function estimate(cfg, count) {
  const c = withDefaults(cfg);
  const courts = Math.max(1, c.courts);
  const waves = n => Math.ceil(n / courts);
  let slots = 0, matches = 0;
  if (c.format === 'groups') {
    const G = Math.max(1, Math.min(c.groups.count, Math.floor(count / 2) || 1));
    const big = Math.ceil(count / G);
    const rounds = big % 2 ? big : big - 1;
    const perRound = Array.from({ length: G }, (_, g) => Math.floor((Math.floor(count / G) + (g < count % G ? 1 : 0)) / 2)).reduce((a, b) => a + b, 0);
    slots += rounds * waves(perRound);
    matches += Array.from({ length: G }, (_, g) => { const s = Math.floor(count / G) + (g < count % G ? 1 : 0); return s * (s - 1) / 2; }).reduce((a, b) => a + b, 0);
    const ko = G * c.groups.toA;
    if (c.groups.toA > 0 && isPow2(ko)) {
      let n = ko / 2;
      const bOn = c.groups.bCup;
      while (n >= 1) {
        const inRound = n + (bOn ? n : 0) + (n === 1 && c.groups.bronze ? 1 : 0) - (n === 1 && c.groups.finalAlone ? 1 : 0);
        if (inRound > 0) slots += waves(inRound);
        matches += inRound;
        n /= 2;
      }
      if (c.groups.finalAlone) { slots += 1; matches += 1; }
    }
  } else if (c.format === 'swiss') {
    slots += c.swiss.rounds * waves(Math.floor(count / 2));
    matches += c.swiss.rounds * Math.floor(count / 2);
    if (isPow2(c.swiss.playoff)) {
      let n = c.swiss.playoff / 2;
      while (n >= 1) { const k = n + (n === 1 && c.swiss.bronze ? 1 : 0); slots += waves(k); matches += k; n /= 2; }
    }
  } else {
    const shape = meleeShape(count, c.melee.size);
    const per = shape ? shape.length : 0;
    slots += c.melee.rounds * waves(per);
    matches += c.melee.rounds * per;
  }
  const minutes = slots * (c.matchMin + c.breakMin) - c.breakMin;
  return { slots, matches, minutes: Math.max(0, minutes), end: fmtMin(toMin(c.start) + Math.max(0, minutes)) };
}

/* ── Hjälpare för vyerna ───────────────────────────────────────────── */

export const STAGE_NAMES = { group: 'Gruppspel', A: 'A-slutspel', B: 'B-slutspel', swiss: 'Schweizer', melee: 'Mêlée' };

export function matchTitle(m) {
  if (m.label) return m.label;
  if (m.stage === 'group') return `Grupp ${m.group_label} · omgång ${m.round}`;
  return `${STAGE_NAMES[m.stage] || ''} omgång ${m.round}`;
}

/** 13–0 kallas fanny i pétanque. Förloraren ska enligt traditionen kyssa Fanny. */
export const isFanny = (m, cfg) => m.status === 'done' && !m.bye &&
  ((m.score_a >= withDefaults(cfg).target && m.score_b === 0) || (m.score_b >= withDefaults(cfg).target && m.score_a === 0));

/** Poängställning av omgångar (ends) → summor. */
export function sumEnds(ends) {
  let a = 0, b = 0;
  for (const e of ends || []) { if (e.s === 'a') a += e.p; else b += e.p; }
  return { a, b };
}
