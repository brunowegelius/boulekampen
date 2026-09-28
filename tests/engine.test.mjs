// Kör: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../app/engine.js';

const teams = n => Array.from({ length: n }, (_, i) => ({ id: 't' + i, name: 'Lag ' + i, seed: 0 }));
const ev = cfg => ({ id: 'ev', config: E.withDefaults(cfg) });

function play(matches, pick = (m) => [13, 5]) {
  for (const m of matches) if (m.status !== 'done') { [m.score_a, m.score_b] = pick(m); m.status = 'done'; }
}

test('lottning ger jämna grupper och respekterar seedning', () => {
  const ts = teams(16); ts[3].seed = 1; ts[9].seed = 2;
  const { assign, draw } = E.drawGroups(ts, 4, E.rng(1));
  const counts = {};
  Object.values(assign).forEach(g => counts[g] = (counts[g] || 0) + 1);
  assert.deepEqual(Object.values(counts).sort(), [4, 4, 4, 4]);
  assert.notEqual(assign.t3, assign.t9);
  assert.equal(draw.length, 16);
  const odd = E.drawGroups(teams(10), 4, E.rng(2));
  const c2 = {}; Object.values(odd.assign).forEach(g => c2[g] = (c2[g] || 0) + 1);
  assert.deepEqual(Object.values(c2).sort(), [2, 2, 3, 3]);
});

test('alla-mot-alla: alla möts exakt en gång', () => {
  for (const n of [3, 4, 5, 6]) {
    const ids = [...Array(n).keys()].map(String);
    const seen = new Set();
    for (const r of E.roundRobin(ids)) {
      const inRound = new Set();
      for (const [a, b] of r) {
        assert.ok(!inRound.has(a) && !inRound.has(b));
        inRound.add(a); inRound.add(b);
        const k = [a, b].sort().join();
        assert.ok(!seen.has(k)); seen.add(k);
      }
    }
    assert.equal(seen.size, n * (n - 1) / 2);
  }
});

test('Boulekampen-formatet: 16 lag, 4 grupper, A- och B-slutspel', () => {
  const e = ev({ courts: 8 });
  const ts = teams(16);
  const { assign } = E.drawGroups(ts, 4, E.rng(3));
  ts.forEach(t => t.group_label = assign[t.id]);
  assert.equal(E.validateGroups(e.config, 16), null);
  const ms = E.buildGroupsProgram(e, ts);
  const group = ms.filter(m => m.stage === 'group');
  assert.equal(group.length, 24);
  assert.equal(ms.filter(m => m.stage === 'A').length, 8); // 4 KF + 2 SF + brons + final
  assert.equal(ms.filter(m => m.stage === 'B').length, 7);
  // ingen bana dubbelbokad i samma pass, inget lag spelar två matcher samtidigt
  const bySlot = {};
  for (const m of ms) (bySlot[m.slot] ||= []).push(m);
  for (const list of Object.values(bySlot)) {
    const courts = list.map(m => m.court);
    assert.equal(new Set(courts).size, courts.length);
    assert.ok(courts.every(c => c >= 1 && c <= 8));
  }
  // finalen spelas ensam, sist
  const final = ms.find(m => m.label === 'Final');
  assert.equal(bySlot[final.slot].length, 1);
  assert.equal(final.slot, Math.max(...ms.map(m => m.slot)));

  // innan gruppen är klar: platshållare
  let r = E.resolve(e, ts, ms);
  const qf1 = r.find(m => m.label === 'Kvartsfinal 1');
  assert.equal(qf1.a, null);
  assert.equal(qf1.la, 'Etta grupp A');

  // spela gruppen: lägst id vinner alltid
  play(group, m => (m.team_a < m.team_b ? [13, 4] : [6, 13]));
  r = E.resolve(e, ts, ms);
  const qf = r.filter(m => m.stage === 'A' && m.round === 1);
  assert.ok(qf.every(m => m.a && m.b));
  // lag från samma grupp i olika halvor
  const gOf = id => ts.find(t => t.id === id).group_label;
  const top = [qf[0], qf[1]].flatMap(m => [m.a, m.b]).map(gOf);
  const bottom = [qf[2], qf[3]].flatMap(m => [m.a, m.b]).map(gOf);
  for (const g of ['A', 'B', 'C', 'D']) {
    assert.equal(top.filter(x => x === g).length, 1);
    assert.equal(bottom.filter(x => x === g).length, 1);
  }
  // spela vidare hela slutspelet och kolla att finalen fylls i
  for (let round = 0; round < 4; round++) {
    const rr = E.resolve(e, ts, ms);
    for (const m of ms) {
      const x = rr.find(y => y.id === m.id);
      if (m.stage !== 'group' && m.status !== 'done' && x.a && x.b) { m.score_a = 13; m.score_b = 11; m.status = 'done'; }
    }
  }
  const end = E.resolve(e, ts, ms);
  const f = end.find(m => m.label === 'Final');
  assert.ok(f.a && f.b && f.status === 'done');
  const bronze = end.find(m => m.label === 'Bronsmatch');
  assert.ok(bronze.a && bronze.b);
  assert.ok(![f.a, f.b].includes(bronze.a));
});

test('tabell: inbördes möte avgör vid lika poäng', () => {
  const cfg = E.withDefaults({});
  const m = (a, b, sa, sb) => ({ a, b, score_a: sa, score_b: sb, status: 'done' });
  // x, y, z vinner en var mot varandra; w förlorar allt. x har bäst skillnad men förlorade mot y
  const ms = [m('x', 'y', 12, 13), m('y', 'z', 2, 13), m('z', 'x', 10, 13), m('x', 'w', 13, 0), m('y', 'w', 13, 12), m('z', 'w', 13, 12)];
  const t = E.standings(['x', 'y', 'z', 'w'], ms, cfg);
  assert.equal(t[3].team, 'w');
  assert.equal(t[0].pts, 4);
  // alla tre har 2 poäng i miniligan → skillnad avgör: x +15, z +12, y -10
  assert.deepEqual(t.slice(0, 3).map(r => r.team), ['x', 'z', 'y']);
  // två lag lika → inbördes möte vinner över bättre skillnad
  const ms2 = [m('p', 'q', 12, 13), m('p', 'r', 13, 0), m('q', 'r', 12, 13), m('p', 's', 13, 0), m('q', 's', 13, 12), m('r', 's', 0, 13)];
  const t2 = E.standings(['p', 'q', 'r', 's'], ms2, cfg);
  const pq = t2.filter(r => r.team === 'p' || r.team === 'q');
  assert.equal(pq[0].pts, pq[1].pts);
  assert.equal(pq[0].team, 'q');
});

test('schweizer: inga returmöten, walkover vid udda antal', () => {
  const e = ev({ format: 'swiss', swiss: { rounds: 4, playoff: 4 }, courts: 4 });
  const ts = teams(9);
  const ms = [];
  const r = E.rng(9);
  for (let round = 0; round < 4; round++) {
    const next = E.pairSwiss(e, ts, ms, r);
    assert.equal(next.filter(m => m.bye).length, 1);
    ms.push(...next);
    play(next.filter(m => !m.bye), () => (r() > 0.5 ? [13, 7] : [9, 13]));
  }
  const pairs = ms.filter(m => !m.bye).map(m => [m.team_a, m.team_b].sort().join());
  assert.equal(new Set(pairs).size, pairs.length);
  const byes = ms.filter(m => m.bye).map(m => m.team_a);
  assert.equal(new Set(byes).size, byes.length);
  const po = E.buildSwissPlayoff(e, ms);
  ms.push(...po);
  const res = E.resolve(e, ts, ms);
  const sf = res.filter(m => m.stage === 'A' && m.round === 1);
  assert.equal(sf.length, 2);
  assert.ok(sf.every(m => m.a && m.b));
});

test('mêlée: rätt lagstorlekar och alla spelar', () => {
  for (const n of [8, 9, 10, 11, 12, 13, 22, 37]) {
    const shape = E.meleeShape(n, 2);
    assert.ok(shape, 'form för ' + n);
    assert.equal(shape.flat().reduce((a, b) => a + b, 0), n);
  }
  const e = ev({ format: 'melee', melee: { size: 2, rounds: 3 }, courts: 10 });
  const ps = Array.from({ length: 16 }, (_, i) => ({ id: 'p' + i }));
  const ms = [];
  for (let k = 0; k < 3; k++) {
    const next = E.meleeRound(e, ps, ms, E.rng(k));
    const everyone = next.flatMap(m => [...m.players_a, ...m.players_b]);
    assert.equal(new Set(everyone).size, 16);
    ms.push(...next); play(next);
  }
  // samma lagkamrat två gånger ska inte behövas med 16 spelare och 3 omgångar
  const mates = new Set();
  for (const m of ms) for (const s of [m.players_a, m.players_b]) {
    const k = s.slice().sort().join();
    assert.ok(!mates.has(k)); mates.add(k);
  }
  const t = E.playerStandings(ps, ms);
  assert.equal(t.reduce((s, r) => s + r.played, 0), 16 * 3);
});

test('laggenerator sprider avdelningar', () => {
  const ps = [];
  ['Ekonomi', 'Sälj', 'IT', 'HR'].forEach(d => { for (let i = 0; i < 4; i++) ps.push({ id: d + i, department: d }); });
  const t = E.makeTeams(ps, 4, E.rng(4));
  assert.equal(t.length, 4);
  for (const team of t) assert.equal(new Set(team.members.map(p => p.department)).size, 4);
});

test('tidsuppskattning för Boulekampen', () => {
  const est = E.estimate({ courts: 8, start: '10:00', matchMin: 45, breakMin: 10 }, 16);
  // 3 gruppomgångar + KF(A+B) + SF(A+B) + brons/B-final + final ensam = 7 pass
  assert.equal(est.slots, 7);
  assert.equal(est.matches, 24 + 8 + 7);
  assert.equal(est.end, E.fmtMin(E.toMin('10:00') + 7 * 55 - 10));
});

test('fanny', () => {
  assert.ok(E.isFanny({ status: 'done', score_a: 13, score_b: 0 }, {}));
  assert.ok(!E.isFanny({ status: 'done', score_a: 13, score_b: 1 }, {}));
});
