'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const R = require('../lib/rooms');
const { handle } = require('../lib/api');
const { MemoryStore, RedisStore } = require('../lib/store');
const ALL = require('../lib/teams').all;

// seeded rng (mulberry32) with the same interface the manager expects
function seeded(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { int: (k) => Math.floor(next() * k), shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; } };
}

function setup() {
  const clock = { t: 1000 }, now = () => clock.t;
  const store = new MemoryStore(now);
  const m = new R.RoomManager(() => ALL, store, { rng: seeded(7), clock: now });
  const ctx = { clock, store, m };
  ctx.room = async (n = 2, opts = null) => {
    const c = await m.create('Ann'), rid = c.room, toks = [c.token];
    for (let i = 1; i < n; i++) toks.push((await m.join(rid, `P${i + 1}`)).token);
    if (opts) await m.settings(rid, toks[0], { options: opts });
    return [rid, toks];
  };
  let typed = 0; // players type their picks: any unique name will do
  ctx.playOne = async (rid, toks, name = null, slot = null) => {
    let st = await m.get(rid, toks[0]);
    const tok = toks[st.turn];
    st = await m.get(rid, tok);
    const rdy = (s) => s.cur && (!s.options.posOn || 'pos' in s.cur);
    while (!rdy(st)) st = await m.spin(rid, tok);
    const me = st.players[st.me];
    if (slot === null) {
      const want = st.cur.pos;
      slot = me.squad.findIndex((v, i) => !v && (want === undefined || me.slots[i] === want));
    }
    if (name === null) name = `Typed Player ${++typed}`;
    return m.pick(rid, tok, slot, name);
  };
  return ctx;
}

const rejects = (p, status, text) => assert.rejects(p, (e) => {
  assert.ok(e instanceof R.RoomError, String(e));
  if (status) assert.equal(e.status, status);
  if (text) assert.match(e.message, text);
  return true;
});

// ---------------------------------------------------------------- lobby
test('codes are unique, readable and case-insensitive', async () => {
  const { m } = setup();
  const ids = new Set();
  for (let i = 0; i < 200; i++) ids.add((await m.create('x')).room);
  assert.equal(ids.size, 200);
  for (const i of ids) { assert.equal(i.length, 6); assert.ok([...i].every((c) => R.ALPHABET.includes(c))); }
  const rid = [...ids][0];
  assert.equal((await m.join(rid.toLowerCase() + ' ', 'y')).room, rid);
});

test('join unknown room', async () => { await rejects(setup().m.join('ZZZZZZ', 'x'), 404); });

test('full room and started room reject newcomers', async () => {
  const c = setup();
  const [rid] = await c.room(6);
  await rejects(c.m.join(rid, 'seventh'), 409);
  const [rid2, toks2] = await c.room(2);
  await c.m.start(rid2, toks2[0]);
  await rejects(c.m.join(rid2, 'late'), 409, /already started/);
});

test('rejoin with token keeps seat even after start', async () => {
  const c = setup(); const [rid, toks] = await c.room(3); await c.m.start(rid, toks[0]);
  const j = await c.m.join(rid, 'whatever', toks[2]);
  assert.equal(j.state.me, 2); assert.equal(j.token, toks[2]);
});

test('state needs a valid token', async () => {
  const c = setup(); const [rid] = await c.room(2);
  for (const bad of [null, undefined, '', 'nope']) await rejects(c.m.get(rid, bad), 403);
});

test('only host changes options and starts', async () => {
  const c = setup(); const [rid, toks] = await c.room(2);
  await rejects(c.m.settings(rid, toks[1], { options: { snake: false } }), 403);
  await rejects(c.m.start(rid, toks[1]), 403);
  const st = await c.m.settings(rid, toks[0], { options: { snake: false, src: 'club', now: false, leg: false, bogus: 1 } });
  assert.equal(st.options.snake, false); assert.equal(st.options.src, 'club');
  assert.ok(!('now' in st.options) && !('leg' in st.options) && !('bogus' in st.options)); // no eras any more: there is no player data
});

test('each player sets own name and formation', async () => {
  const c = setup(); const [rid, toks] = await c.room(2);
  const st = await c.m.settings(rid, toks[1], { name: '  Bo   <b>b</b> ', formation: '3-5-2' });
  assert.equal(st.players[1].name, 'Bo bb/b'); assert.deepEqual(st.players[1].slots, R.slotsFor('3-5-2'));
  await rejects(c.m.settings(rid, toks[1], { formation: '9-9-9' }));
  await rejects(c.m.settings(rid, toks[1], { formation: 'constructor' }));
});

test('need two players to start', async () => {
  const { m } = setup(); const c = await m.create('solo');
  await rejects(m.start(c.room, c.token), 409);
});

test('room closes only when every player has left (lobby)', async () => {
  const c = setup(); const [rid, toks] = await c.room(3);
  await c.m.leave(rid, toks[0]);
  const st = await c.m.get(rid, toks[1]);
  assert.equal(st.players.length, 2); assert.equal(st.host, 0);
  await c.m.leave(rid, toks[1]);
  assert.equal((await c.m.get(rid, toks[2])).players.length, 1);
  await c.m.leave(rid, toks[2]);
  await rejects(c.m.get(rid, toks[2]), 404);
});

test('mid-draft: one leaves, room stays; both leave, room closes', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false }); await c.m.start(rid, toks[0]);
  await c.m.leave(rid, toks[1]);
  const st = await c.m.get(rid, toks[0]);
  assert.equal(st.players[1].left, true); assert.equal(st.players[1].connected, false);
  await rejects(c.m.get(rid, toks[1]), 403);
  assert.equal((await c.playOne(rid, toks)).t, 1); // host picks
  assert.equal((await c.m.skip(rid, toks[0])).t, 2); // host skips the turn of the one who left
  await c.m.leave(rid, toks[0]);
  await rejects(c.m.get(rid, toks[0]), 404);
});

test('mid-draft: host leaving passes host to the remaining player', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false }); await c.m.start(rid, toks[0]);
  await c.m.leave(rid, toks[0]);
  const st = await c.m.get(rid, toks[1]); assert.equal(st.host, 1);
});

test('a player silent for 60s counts as left; room closes when all are gone', async () => {
  const c = setup(); const [rid, toks] = await c.room(2); await c.m.start(rid, toks[0]);
  c.clock.t += R.CLOSE_AFTER + 1; // P2 killed the app, host keeps polling
  const st = await c.m.get(rid, toks[0]);
  assert.equal(st.players[1].left, true);
  await rejects(c.m.get(rid, toks[1]), 403);
  await c.m.leave(rid, toks[0]);
  await rejects(c.m.get(rid, toks[0]), 404);
});

test('kick', async () => {
  const c = setup(); const [rid, toks] = await c.room(3);
  await rejects(c.m.kick(rid, toks[1], 2), 403);
  const st = await c.m.kick(rid, toks[0], 1);
  assert.deepEqual(st.players.map((p) => p.name), ['Ann', 'P3']);
  await rejects(c.m.get(rid, toks[1]), 403);
});

test('idle rooms expire', async () => {
  const c = setup(); const [rid, toks] = await c.room(2);
  c.clock.t += 31 * 60;
  await rejects(c.m.get(rid, toks[0]), 404);
});

test('poll unchanged and presence flip', async () => {
  const c = setup(); const [rid, toks] = await c.room(2);
  const v = (await c.m.get(rid, toks[0])).version;
  assert.deepEqual(await c.m.get(rid, toks[0], v), { unchanged: true, version: v });
  c.clock.t += 30; // P2 silent for 30s, host polls
  await c.m.get(rid, toks[0]);
  const st = await c.m.get(rid, toks[0], v);
  assert.equal(st.players[1].connected, false);
  await c.m.get(rid, toks[1]); // P2 comes back
  assert.equal((await c.m.get(rid, toks[0])).players[1].connected, true);
});

test('a poll only writes to the store when something needs saving', async () => {
  const c = setup(); const [rid, toks] = await c.room(2);
  let saves = 0; const save = c.store.save.bind(c.store);
  c.store.save = (...a) => { saves++; return save(...a); };
  for (let i = 0; i < 5; i++) { c.clock.t += 1; await c.m.get(rid, toks[0]); await c.m.get(rid, toks[1]); }
  assert.ok(saves <= 2, `expected few writes, got ${saves}`); // last_seen is refreshed at most every ~8s
});

// ---------------------------------------------------------------- draft
test('start sets toss, order and wheel', async () => {
  const c = setup(); const [rid, toks] = await c.room(3);
  const st = await c.m.start(rid, toks[0]);
  assert.equal(st.phase, 'playing'); assert.deepEqual([...st.order].sort(), [0, 1, 2]);
  assert.equal(st.order[0], st.first); assert.equal(st.turn, st.first); assert.equal(st.labs.length, 14);
});

test('no toss: host first', async () => {
  const c = setup(); const [rid, toks] = await c.room(3, { toss: false });
  const st = await c.m.start(rid, toks[0]);
  assert.deepEqual(st.order, [0, 1, 2]); assert.equal(st.turn, 0);
});

test('source filter', async () => {
  const c = setup();
  for (const [src, g] of [['club', 'clubs'], ['nat', 'nations']]) {
    const [rid, toks] = await c.room(2, { src }); const st = await c.m.start(rid, toks[0]);
    assert.ok(st.labs.every((l) => ALL[g].includes(l)));
  }
});

test('only the player on the clock can act', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false }); await c.m.start(rid, toks[0]);
  await rejects(c.m.spin(rid, toks[1]), 409, /turn/);
  await rejects(c.m.pick(rid, toks[1], 0, 'x'));
});

test('spin is recorded for animation and matches cur', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false }); await c.m.start(rid, toks[0]);
  const st = await c.m.spin(rid, toks[0]); const sp = st.spin;
  assert.equal(sp.kind, 'club'); assert.equal(sp.labels[sp.index], st.cur.n); assert.ok(!('list' in st.cur)); // no player lists
  await rejects(c.m.spin(rid, toks[0])); // already spun: pick instead
});

test('pick rules', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false }); const m = c.m; await m.start(rid, toks[0]);
  await rejects(m.pick(rid, toks[0], 0, 'Messi'), 409, /Spin first/);
  await m.spin(rid, toks[0]);
  for (const bad of [-1, 11, '3', null, true]) await rejects(m.pick(rid, toks[0], bad, 'Messi'));
  await rejects(m.pick(rid, toks[0], 0, '   '));
  let st = await m.pick(rid, toks[0], 0, '  Lionel   Messi ');
  assert.equal(st.players[0].squad[0], 'Lionel Messi'); assert.equal(st.t, 1); assert.equal(st.turn, 1);
  assert.ok(!('pos' in st.cur)); // same club for the next player
  await rejects(m.pick(rid, toks[1], 0, 'lionel messi'), 409, /already drafted/);
  st = await m.pick(rid, toks[1], 0, 'Someone Else');
  assert.equal(st.cur, null); assert.equal(st.turn, 1); // new round, new spin; snake: P2 goes again
  await rejects(m.pick(rid, toks[1], 1, 'Again'), 409, /Spin first/);
  await m.spin(rid, toks[1]);
  await rejects(m.pick(rid, toks[1], 0, 'Again'), 409, /already filled/);
});

test('same club for the whole round, then a new spin', async () => {
  const c = setup(); const [rid, toks] = await c.room(3, { toss: false }); await c.m.start(rid, toks[0]);
  const s1 = await c.playOne(rid, toks); const club = s1.cur.n;
  const s2 = await c.playOne(rid, toks); assert.equal(s2.cur.n, club);
  const s3 = await c.playOne(rid, toks); assert.equal(s3.cur, null);
});

test('snake order', async () => {
  for (const [snake, n, want] of [[true, 9, [0, 1, 2, 2, 1, 0, 0, 1, 2]], [false, 6, [0, 1, 2, 0, 1, 2]]]) {
    const c = setup(); const [rid, toks] = await c.room(3, { toss: false, snake }); await c.m.start(rid, toks[0]);
    const seq = [];
    for (let i = 0; i < n; i++) { seq.push((await c.m.get(rid, toks[0])).turn); await c.playOne(rid, toks); }
    assert.deepEqual(seq, want);
  }
});

test('reroll rules', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false }); const m = c.m; await m.start(rid, toks[0]);
  await rejects(m.reroll(rid, toks[0])); // nothing spun yet
  await m.spin(rid, toks[0]);
  const st = await m.reroll(rid, toks[0]); assert.equal(st.cur, null); assert.equal(st.players[0].rr, 0);
  await m.spin(rid, toks[0]);
  await rejects(m.reroll(rid, toks[0]), 409, /No re-spins/);
  await m.pick(rid, toks[0], 0, 'A1');
  await rejects(m.reroll(rid, toks[1]), 409, /first pick/);
});

test('re-spins per player and re-spin on any pick', async () => {
  // the host sets how many re-spins each player gets; everyone starts the draft with that many
  let c = setup(); let [rid, toks] = await c.room(2, { toss: false, respins: 3 }); await c.m.start(rid, toks[0]);
  let st = await c.m.get(rid, toks[0]); assert.ok(st.players.every((p) => p.rr === 3)); assert.equal(st.options.respins, 3);
  await c.m.spin(rid, toks[0]);
  for (let i = 2; i >= 0; i--) { st = await c.m.reroll(rid, toks[0]); assert.equal(st.players[0].rr, i); await c.m.spin(rid, toks[0]); }
  await rejects(c.m.reroll(rid, toks[0]), 409, /No re-spins/);
  // none at all
  c = setup(); [rid, toks] = await c.room(2, { toss: false, respins: 0 }); await c.m.start(rid, toks[0]); await c.m.spin(rid, toks[0]);
  await rejects(c.m.reroll(rid, toks[0]), 409, /No re-spins/);
  // bad values are refused
  c = setup(); [rid, toks] = await c.room(2);
  for (const v of [-1, 6, 1.5, 'x']) await rejects(c.m.settings(rid, toks[0], { options: { respins: v } }), 400);
  // second pick of a round: refused by default, allowed with "re-spin on any pick"
  c = setup(); [rid, toks] = await c.room(2, { toss: false, snake: false }); await c.m.start(rid, toks[0]);
  await c.m.spin(rid, toks[0]); await c.m.pick(rid, toks[0], 0, 'A1');
  await rejects(c.m.reroll(rid, toks[1]), 409, /first pick/);
  c = setup(); [rid, toks] = await c.room(2, { toss: false, snake: false, rrAny: true }); await c.m.start(rid, toks[0]);
  await c.m.spin(rid, toks[0]); await c.m.pick(rid, toks[0], 0, 'A1');
  st = await c.m.reroll(rid, toks[1]); assert.equal(st.cur, null); assert.equal(st.players[1].rr, 0); assert.equal(st.turn, 1);
  st = await c.m.spin(rid, toks[1]); assert.ok(st.cur);
  st = await c.m.pick(rid, toks[1], 0, 'B1'); assert.equal(st.t, 2); // the round goes on as normal
  // a new game gives the re-spins back
  const x = setup(); const [r2, t2] = await x.room(2, { toss: false, respins: 2 }); await x.m.start(r2, t2[0]);
  await x.m.spin(r2, t2[0]); await x.m.reroll(r2, t2[0]);
  for (let i = 0; i < 22; i++) await x.playOne(r2, t2);
  st = await x.m.rematch(r2, t2[0]); assert.ok(st.players.every((p) => p.rr === 2));
});

test('position wheel', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false, posOn: true }); const m = c.m; await m.start(rid, toks[0]);
  let st = await m.spin(rid, toks[0]); assert.equal(st.spin.kind, 'club'); assert.ok(!('pos' in st.cur));
  await rejects(m.pick(rid, toks[0], 0, 'X')); // position not spun yet
  st = await m.spin(rid, toks[0]); assert.equal(st.spin.kind, 'pos');
  const pos = st.cur.pos, me = st.players[0];
  const wrong = me.slots.findIndex((t) => t !== pos), right = me.slots.findIndex((t) => t === pos);
  await rejects(m.pick(rid, toks[0], wrong, 'X'), 409, new RegExp(`must fill a ${pos}`));
  st = await m.pick(rid, toks[0], right, 'X');
  assert.ok(!('pos' in st.cur)); // next player spins their own position
});

test('position wheel: a single open type is automatic', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false, posOn: true }); await c.m.start(rid, toks[0]);
  const r = await c.store.load(rid); r.players[0].squad = Array.from({ length: 11 }, (_, i) => (i === 0 ? null : `x${i}`));
  await c.store.save(rid, r, 3600);
  const st = await c.m.spin(rid, toks[0]); assert.equal(st.cur.pos, 'GK');
});

test('full draft finishes and all names are unique', async () => {
  for (const n of [2, 4]) {
    const c = setup(); const [rid, toks] = await c.room(n); await c.m.start(rid, toks[0]);
    let st;
    for (let i = 0; i < 11 * n; i++) st = await c.playOne(rid, toks);
    assert.equal(st.phase, 'done'); assert.equal(st.turn, null);
    const names = st.players.flatMap((p) => p.squad);
    assert.equal(names.length, 11 * n); assert.equal(new Set(names.map((x) => x.toLowerCase())).size, 11 * n); assert.ok(names.every(Boolean));
    await rejects(c.m.spin(rid, toks[0]));
  }
});

test('full draft with the position wheel', async () => {
  const c = setup(); const [rid, toks] = await c.room(3, { posOn: true, snake: false }); await c.m.start(rid, toks[0]);
  let st; for (let i = 0; i < 33; i++) st = await c.playOne(rid, toks);
  assert.equal(st.phase, 'done'); for (const p of st.players) assert.ok(p.squad.every(Boolean));
});

test('skip: only the host, only for an away player, fills a blank that can repeat', async () => {
  const c = setup(); const [rid, toks] = await c.room(3, { toss: false, snake: false }); const m = c.m; await m.start(rid, toks[0]);
  await rejects(m.skip(rid, toks[0]), 409, /only skip a player who is away/); // the host is on the clock: nothing to skip
  await c.playOne(rid, toks); // host picks, now P2 is on the clock and present
  await rejects(m.skip(rid, toks[0]), 409); // P2 is present
  c.clock.t += 25; await m.get(rid, toks[0]); await m.get(rid, toks[2]); // P2 silent for 25s: counted as away
  await rejects(m.skip(rid, toks[2]), 409); // only the host can skip
  let st = await m.skip(rid, toks[0]); assert.equal(st.t, 2); assert.equal(st.me, 0);
  assert.equal(st.players[1].squad.filter((v) => v === R.SKIPPED).length, 1);
  assert.equal(st.players[1].squad.filter(Boolean).length, 1);
  // a skipped pick is not a name: it does not block anyone from typing it, and it can repeat
  st = await c.playOne(rid, toks, R.SKIPPED); // P3 types the same word: allowed
  assert.equal(st.t, 3);
});

test('skip respects the position wheel', async () => {
  const c = setup(); const [rid, toks] = await c.room(3, { toss: false, posOn: true, snake: false }); await c.m.start(rid, toks[0]);
  await c.playOne(rid, toks); // host
  c.clock.t += 25; await c.m.get(rid, toks[0]); await c.m.get(rid, toks[2]);
  const st = await c.m.skip(rid, toks[0]);
  const i = st.players[1].squad.findIndex(Boolean);
  assert.equal(st.players[1].squad.filter(Boolean).length, 1);
  assert.equal(st.spin.kind, 'pos');
  assert.equal(st.players[1].slots[i], st.spin.labels[st.spin.index]); // the blank went into the position the wheel gave
});

test('settings are locked after start', async () => {
  const c = setup(); const [rid, toks] = await c.room(2); await c.m.start(rid, toks[0]);
  await rejects(c.m.settings(rid, toks[0], { formation: '4-4-2' }));
});

test('simultaneous requests cannot overwrite each other (room lock)', async () => {
  const c = setup(); const c1 = await c.m.create('Ann'); const rid = c1.room;
  const joined = await Promise.all([1, 2, 3, 4].map((i) => c.m.join(rid, `P${i}`)));
  assert.equal(new Set(joined.map((j) => j.state.me)).size >= 1, true);
  const st = await c.m.get(rid, c1.token);
  assert.equal(st.players.length, 5); // nobody was lost
});

test('formations match the frontend', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const grab = (name) => new Function('return ' + html.match(new RegExp(`const ${name}=(\\{.*?\\});`, 's'))[1])();
  assert.deepEqual(grab('FORM'), R.FORM);
});

// ---------------------------------------------------------------- HTTP routes
test('routes round trip', async () => {
  const c = setup(); const call = (method, parts, body, query) => handle(c.m, method, parts, query || {}, body);
  let [s, j] = await call('POST', [], { name: 'Ann' }); assert.equal(s, 201);
  const rid = j.room, tok = j.token;
  [s, j] = await call('POST', [rid, 'join'], { name: 'Bo' }); assert.equal(s, 200); const tok2 = j.token;
  [s, j] = await call('GET', [rid], null, { token: tok }); assert.equal(j.players[1].name, 'Bo');
  [s] = await call('POST', [rid, 'start'], { token: tok2 }); assert.equal(s, 403);
  [s] = await call('POST', [rid, 'settings'], { token: tok, options: { toss: false } }); assert.equal(s, 200);
  [s, j] = await call('POST', [rid, 'start'], { token: tok }); assert.equal(j.phase, 'playing');
  [s, j] = await call('POST', [rid, 'spin'], { token: tok }); assert.notEqual(j.cur, null);
  [s, j] = await call('POST', [rid, 'pick'], { token: tok, slot: 0, name: 'Neuer' }); assert.equal(j.t, 1);
  [s, j] = await call('POST', [rid, 'pick'], { token: tok, slot: 1, name: 'Neuer2' }); assert.equal(s, 409); assert.ok('error' in j);
});

test('poll token can travel in a header', async () => {
  const c = setup(); let [, j] = await handle(c.m, 'POST', [], {}, { name: 'Ann' }); const rid = j.room, tok = j.token;
  let [s, k] = await handle(c.m, 'GET', [rid], {}, null, { 'x-room-token': tok }); assert.equal(s, 200); assert.equal(k.me, 0);
  [s] = await handle(c.m, 'GET', [rid], {}, null, { 'x-room-token': 'wrong' }); assert.equal(s, 403);
});

test('bad requests never throw', async () => {
  const c = setup();
  const cases = [['GET', [], null], ['DELETE', ['X'], null], ['POST', ['NOPE', 'spin'], { token: 't' }], ['POST', ['a', 'b', 'c'], {}],
    ['POST', [], 'not an object'], ['GET', ['NOPE'], null], ['POST', ['NOPE', 'pick'], { slot: {}, name: [] }]];
  for (const [m, p, b] of cases) {
    const [s, j] = await handle(c.m, m, p, {}, b);
    assert.ok([201, 400, 403, 404, 409].includes(s), `${m} ${p} -> ${s}`); assert.equal(typeof j, 'object');
  }
});

test('storage failures become a friendly 503', async () => {
  const c = setup(); c.store.load = async () => { throw new Error('redis down'); };
  const orig = console.error; console.error = () => {};
  try { const [s, j] = await handle(c.m, 'GET', ['ABCDEF'], { token: 'x' }); assert.equal(s, 503); assert.ok(j.error); } finally { console.error = orig; }
});

// ---------------------------------------------------------------- Redis store + data
test('RedisStore speaks the Upstash REST protocol', async () => {
  const calls = []; const db = new Map();
  const fake = async (url, opt) => {
    const a = JSON.parse(opt.body); calls.push({ url, auth: opt.headers.Authorization, a });
    const [c, k, v, ...rest] = a; let result = null;
    if (c === 'GET') result = db.get(k) ?? null;
    else if (c === 'SET') { if (rest.includes('NX') && db.has(k)) result = null; else { db.set(k, v); result = 'OK'; } }
    else if (c === 'DEL') { db.delete(k); result = 1; }
    else if (c === 'EVAL') { result = 1; }
    return { ok: true, json: async () => ({ result }) };
  };
  const s = new RedisStore('https://x.upstash.io/', 'TOKEN', fake);
  assert.equal(await s.create('ABC', { a: 1 }, 60), true);
  assert.equal(await s.create('ABC', { a: 2 }, 60), false); // code already taken
  assert.deepEqual(await s.load('ABC'), { a: 1 });
  const lock = await s.lock('ABC'); assert.ok(lock); await s.unlock('ABC', lock);
  assert.equal(calls[0].url, 'https://x.upstash.io'); assert.equal(calls[0].auth, 'Bearer TOKEN');
  assert.deepEqual(calls[0].a.slice(0, 1), ['SET']); assert.ok(calls[0].a.includes('EX'));
});

test('built-in teams are plain names; there is no player data', () => {
  for (const g of ['clubs', 'nations']) {
    assert.ok(Array.isArray(ALL[g]) && ALL[g].length >= 10);
    assert.ok(ALL[g].every((n) => typeof n === 'string' && n.trim() && n.length <= 24));
    assert.equal(new Set(ALL[g].map((n) => n.toLowerCase())).size, ALL[g].length);
  }
  const root = path.join(__dirname, '..');
  for (const f of ['data', 'tools', 'lib/data.js', 'api/players.js', 'api/meta.js']) assert.ok(!fs.existsSync(path.join(root, f)), f + ' should be gone');
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  assert.ok(!/api\/players|datalist|Allow all-time legends/.test(html));
});

// ---------------------------------------------------------------- new game after a finished draft
async function finish(c, rid, toks) {
  for (let guard = 0; guard < 200; guard++) {
    const st = await c.m.get(rid, toks[0]);
    if (st.phase === 'done') return st;
    await c.playOne(rid, toks);
  }
  throw new Error('draft did not finish');
}

test('rematch: same room and settings, squads and wheel reset', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false, noRepeat: true, posOn: false, snake: false, src: 'club' });
  await c.m.settings(rid, toks[1], { formation: '4-4-2', name: 'Bea' });
  await c.m.start(rid, toks[0]);
  const done = await finish(c, rid, toks);
  assert.equal(done.phase, 'done');
  await rejects(c.m.rematch(rid, 'wrong-token'), 403);
  const st = await c.m.rematch(rid, toks[1]); // any player can start it
  assert.equal(st.phase, 'playing'); assert.equal(st.t, 0); assert.equal(st.cur, null);
  assert.ok(st.players.every((p) => p.squad.every((v) => v === null) && p.rr === 1));
  assert.equal(st.options.noRepeat, true); assert.equal(st.options.src, 'club'); assert.equal(st.options.snake, false);
  assert.equal(st.players[1].formation, '4-4-2'); assert.equal(st.players[1].name, 'Bea');
  assert.equal(st.labs.length, 14); // every club is back on the wheel
  const again = await c.m.rematch(rid, toks[0]); // a second click does nothing
  assert.equal(again.phase, 'playing'); assert.equal(again.version, st.version);
});

test('rematch: only after the draft is done; leavers are dropped; too few players -> lobby', async () => {
  const c = setup(); const [rid, toks] = await c.room(3, { toss: false });
  await rejects(c.m.rematch(rid, toks[0]), 409, /not finished/); // still in the lobby
  const s0 = await c.m.start(rid, toks[0]);
  assert.equal((await c.m.rematch(rid, toks[0])).version, s0.version); // mid-draft: nothing changes
  await finish(c, rid, toks).catch(() => {});
  let st = await c.m.get(rid, toks[0]);
  if (st.phase !== 'done') {
    // someone must be able to finish alone: let everybody pick until done
    for (let g = 0; g < 300 && st.phase !== 'done'; g++) { await c.playOne(rid, toks); st = await c.m.get(rid, toks[0]); }
  }
  await c.m.leave(rid, toks[2]);
  st = await c.m.rematch(rid, toks[0]);
  assert.equal(st.phase, 'playing'); assert.equal(st.players.length, 2);
  // finish again, then the second player leaves: only one left -> back to the lobby
  for (let g = 0; g < 300; g++) { st = await c.m.get(rid, toks[0]); if (st.phase === 'done') break; await c.playOne(rid, toks); }
  await c.m.leave(rid, toks[1]);
  st = await c.m.rematch(rid, toks[0]);
  assert.equal(st.phase, 'lobby'); assert.equal(st.players.length, 1);
});

// ---------------------------------------------------------------- wheel presets
const names = (a) => [...a];

test('wheel preset: only the chosen teams get on the wheel, and the host picks it', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false });
  const clubs = names(ALL.clubs).slice(0, 4), nations = names(ALL.nations).slice(0, 3);
  await rejects(c.m.settings(rid, toks[1], { options: { wheel: { name: 'x', clubs, nations } } }), 403);
  let st = await c.m.settings(rid, toks[0], { options: { wheel: { name: '  Top   picks ', clubs: [...clubs, clubs[0].toUpperCase(), clubs[0]], nations, bogus: 1 } } });
  assert.deepEqual(st.options.wheel, { name: 'Top picks', clubs, nations }); // repeats dropped (any case), name cleaned
  st = await c.m.start(rid, toks[0]);
  assert.equal(st.labs.length, 7);
  assert.ok(st.labs.every((l) => clubs.includes(l) || nations.includes(l)));
  for (let round = 0; round < 6; round++) { // later wheels keep the same teams
    await c.playOne(rid, toks); await c.playOne(rid, toks);
    const s2 = await c.m.get(rid, toks[0]);
    assert.ok(s2.labs.every((l) => clubs.includes(l) || nations.includes(l)));
  }
});

test('wheel preset: any club or country can be added; players just type the name', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false, src: 'club' });
  const mine = ['Al Hilal', 'Lahore Qalandars', '  Karachi   Kings ', 'real madrid', '<b>Evil</b>', ''];
  let st = await c.m.settings(rid, toks[0], { options: { wheel: { name: 'Mine', clubs: mine, nations: ['Pakistan'] } } });
  assert.deepEqual(st.options.wheel.clubs, ['Al Hilal', 'Lahore Qalandars', 'Karachi Kings', 'Real Madrid', 'bEvil/b']);
  assert.deepEqual(st.options.wheel.nations, ['Pakistan']);
  st = await c.m.start(rid, toks[0]);
  assert.deepEqual([...st.labs].sort(), [...st.options.wheel.clubs].sort()); // src club: only the clubs
  assert.equal(st.labs.length, 5);
  // keep spinning until a team without player data comes up, then pick by typing
  for (let g = 0; g < 40; g++) {
    st = await c.m.get(rid, toks[0]);
    st = await c.m.spin(rid, toks[st.turn]);
    if (st.cur.n !== 'Real Madrid') break;
    await c.playOne(rid, toks); await c.playOne(rid, toks);
  }
  assert.notEqual(st.cur.n, 'Real Madrid');
  const seat = st.turn; const slot = st.players[seat].squad.findIndex((v) => !v);
  const after = await c.m.pick(rid, toks[seat], slot, 'Babar Azam');
  assert.equal(after.players[seat].squad[slot], 'Babar Azam');
});

test('wheel preset: works with the wheel type, and null means every team', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false });
  const clubs = names(ALL.clubs).slice(0, 5);
  let st = await c.m.settings(rid, toks[0], { options: { src: 'club', wheel: { name: 'Five', clubs, nations: names(ALL.nations) } } });
  st = await c.m.start(rid, toks[0]);
  assert.deepEqual([...st.labs].sort(), [...clubs].sort());
  const d = setup(); const [rid2, toks2] = await d.room(2, { toss: false });
  assert.equal((await d.m.get(rid2, toks2[0])).options.wheel, null);
  let s2 = await d.m.settings(rid2, toks2[0], { options: { wheel: { name: 'x', clubs, nations: [] } } });
  assert.ok(s2.options.wheel);
  s2 = await d.m.settings(rid2, toks2[0], { options: { wheel: null } });
  assert.equal(s2.options.wheel, null);
  // every team listed = no restriction
  s2 = await d.m.settings(rid2, toks2[0], { options: { wheel: { name: 'all', clubs: names(ALL.clubs), nations: names(ALL.nations) } } });
  assert.equal(s2.options.wheel, null);
});

test('wheel preset: needs at least 2 teams for the chosen wheel type, and survives a new game', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false });
  const one = names(ALL.clubs).slice(0, 1);
  await rejects(c.m.settings(rid, toks[0], { options: { wheel: { name: 'one', clubs: one, nations: [] } } }), 409, /at least 2/);
  await rejects(c.m.settings(rid, toks[0], { options: { src: 'nat', wheel: { name: 'clubs only', clubs: names(ALL.clubs), nations: [] } } }), 409, /at least 2/);
  assert.equal((await c.m.get(rid, toks[0])).options.wheel, null); // a refused change leaves the room as it was
  const clubs = names(ALL.clubs).slice(0, 3);
  await c.m.settings(rid, toks[0], { options: { wheel: { name: 'Three', clubs, nations: [] } } });
  await c.m.start(rid, toks[0]);
  for (let g = 0; g < 400; g++) { const s = await c.m.get(rid, toks[0]); if (s.phase === 'done') break; await c.playOne(rid, toks); }
  const again = await c.m.rematch(rid, toks[0]);
  assert.equal(again.options.wheel.name, 'Three'); assert.deepEqual([...again.labs].sort(), [...clubs].sort());
});

test('wheel preset page is wired into the app', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  for (const id of ['presets', 'preset', 'presetEdit', 'lobPreset', 'lobPresetEdit', 'pList', 'pNew', 'pUse', 'pClubs', 'pNats']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /S\.wheel=wheelOf\(\$\('#preset'\)\.value\)/);
});

// ---------------------------------------------------------------- fix a typo
test('rename: fix your own pick; not others, not blanks, not duplicates', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false, snake: false });
  await rejects(c.m.rename(rid, toks[0], 0, 'x'), 409, /started/);
  await c.m.start(rid, toks[0]);
  let st = await c.playOne(rid, toks, 'Mbape', 0); // host types it wrong (GK slot)
  const mine = st.players[0].squad.findIndex(Boolean);
  st = await c.m.rename(rid, toks[0], mine, '  Mbappé ');
  assert.equal(st.players[0].squad[mine], 'Mbappé'); assert.equal(st.t, 1); assert.equal(st.turn, 1); // nothing else changed
  st = await c.m.rename(rid, toks[0], mine, 'MBAPPÉ'); assert.equal(st.players[0].squad[mine], 'MBAPPÉ'); // capitals only: allowed
  await rejects(c.m.rename(rid, toks[1], mine, 'Hacked'), 409, /no pick/); // that position is empty on P2's pitch: you only edit your own
  const p2 = await c.playOne(rid, toks, 'Neymar', 0);
  await rejects(c.m.rename(rid, toks[1], p2.players[1].squad.findIndex(Boolean), 'mbappé'), 409, /already drafted/);
  await rejects(c.m.rename(rid, toks[0], mine, '   '), 400);
  await rejects(c.m.rename(rid, toks[0], 99, 'Zed'), 400);
  assert.equal((await c.m.get(rid, toks[1])).players[0].squad[mine], 'MBAPPÉ'); // everyone sees the fix
});

test('rename: a skipped blank is not a pick; renaming still works after the draft ends', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false, snake: false });
  await c.m.start(rid, toks[0]); await c.playOne(rid, toks);
  c.clock.t += 25; await c.m.get(rid, toks[0]); // P2 silent: away
  let st = await c.m.skip(rid, toks[0]);
  const blank = st.players[1].squad.indexOf(R.SKIPPED);
  await c.m.get(rid, toks[1]); // P2 is back
  await rejects(c.m.rename(rid, toks[1], blank, 'Someone'), 409, /no pick/);
  st = await finish(c, rid, toks);
  const slot = st.players[0].squad.findIndex(Boolean);
  st = await c.m.rename(rid, toks[0], slot, 'Fixed Name');
  assert.equal(st.players[0].squad[slot], 'Fixed Name'); assert.equal(st.phase, 'done');
});

// ---------------------------------------------------------------- no repeat in a row
test('noRepeat: the team that was just spun is not on the next wheel (rounds and re-spins)', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false, noRepeat: true, snake: false });
  assert.equal((await c.m.get(rid, toks[0])).options.noRepeat, true);
  await c.m.start(rid, toks[0]);
  let st = await c.m.spin(rid, toks[0]);
  const rerolled = st.cur.n;
  st = await c.m.reroll(rid, toks[0]);
  assert.ok(!st.labs.includes(rerolled), 'a re-spin must not offer the team just thrown away');
  for (let round = 0; round < 9; round++) {
    st = await c.m.get(rid, toks[0]);
    st = await c.m.spin(rid, toks[st.turn]);
    const spun = st.cur.n;
    await c.playOne(rid, toks); st = await c.playOne(rid, toks); // both pick: round over
    assert.ok(!st.labs.includes(spun), `${spun} came straight back`);
  }
});

test('noRepeat: needs 3 teams, is off by default, and also holds when a small wheel refills', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false, snake: false });
  assert.equal((await c.m.get(rid, toks[0])).options.noRepeat, false);
  const three = names(ALL.clubs).slice(0, 3);
  await rejects(c.m.settings(rid, toks[0], { options: { noRepeat: true, wheel: { name: 'Two', clubs: three.slice(0, 2), nations: [] } } }), 409, /at least 3/);
  await c.m.settings(rid, toks[0], { options: { noRepeat: true, wheel: { name: 'Three', clubs: three, nations: [] } } });
  await c.m.start(rid, toks[0]);
  const seq = [];
  for (let round = 0; round < 9; round++) {
    let st = await c.m.get(rid, toks[0]);
    st = await c.m.spin(rid, toks[st.turn]);
    seq.push(st.cur.n);
    await c.playOne(rid, toks); await c.playOne(rid, toks);
  }
  for (let i = 0; i < 9; i += 3) assert.equal(new Set(seq.slice(i, i + 3)).size, 3, `each club once per cycle: ${seq}`); // every team once, then the wheel refills
  for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1], `repeat in a row: ${seq}`); // also across the refill
});

// ---------------------------------------------------------------- every club or country once (always on)
test('every team once: a spun club or country leaves the wheel for the rest of the draft', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false, snake: false }); const m = c.m;
  await m.start(rid, toks[0]);
  const seen = [];
  for (let round = 0; round < 8; round++) {
    let st = await m.get(rid, toks[0]);
    st = await m.spin(rid, toks[st.turn]);
    const name = st.cur.n;
    assert.ok(!seen.includes(name), `${name} came up twice`);
    seen.push(name);
    await c.playOne(rid, toks); await c.playOne(rid, toks); // both players pick from this spin, the round ends
    st = await m.get(rid, toks[0]);
    assert.ok(!st.labs.includes(name), `${name} should be off the wheel`);
  }
});

test('every team once: a re-spun team is removed too', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false }); const m = c.m;
  await m.start(rid, toks[0]);
  const a = await m.spin(rid, toks[0]);
  const b = await m.reroll(rid, toks[0]);
  assert.ok(!b.labs.includes(a.cur.n));
  const first = await m.spin(rid, toks[0]);
  assert.notEqual(first.cur.n, a.cur.n);
});

test('every team once: when every team has been spun the wheel refills', () => {
  const { m } = setup();
  const used = ALL.clubs.map((n) => ({ n, k: 'club' }));
  const r = { options: { src: 'club' }, used, labs: [], last: null };
  m._newLabels(r);
  assert.ok(r.labs.length > 0); assert.equal(r.used.length, 0);
});

test('every team once: all teams are back on the wheel for a new game', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false, src: 'club', snake: false }); const m = c.m;
  await m.start(rid, toks[0]);
  for (let g = 0; g < 400; g++) { const s = await m.get(rid, toks[0]); if (s.phase === 'done') break; await c.playOne(rid, toks); }
  const st = await m.rematch(rid, toks[0]);
  assert.equal(st.labs.length, 14);
});

// ---------------------------------------------------------------- vote for the winner + scoreboard
test('vote: opens when the draft is done; the result comes when everyone has voted', async () => {
  const c = setup(); const [rid, toks] = await c.room(3, { toss: false });
  await c.m.start(rid, toks[0]);
  await rejects(c.m.vote(rid, toks[0], 1), 409, /finished/);
  let st = await finish(c, rid, toks);
  assert.deepEqual(st.vote, { mine: null, cast: 0, of: 3, result: null });
  await rejects(c.m.vote(rid, toks[0], 7), 400);
  await rejects(c.m.vote(rid, 'wrong', 1), 403);
  st = await c.m.vote(rid, toks[0], 2); assert.equal(st.vote.mine, 2); assert.equal(st.vote.cast, 1);
  st = await c.m.vote(rid, toks[0], 1); assert.equal(st.vote.mine, 1); assert.equal(st.vote.cast, 1); // can change the vote
  await c.m.vote(rid, toks[1], 1); // P2 votes for themselves
  st = await c.m.vote(rid, toks[2], 0);
  assert.deepEqual(st.vote.result, { winners: [1], counts: [1, 2, 0] });
  assert.deepEqual(st.players.map((p) => p.wins), [0, 1, 0]);
  await rejects(c.m.vote(rid, toks[2], 2), 409, /closed/);
  assert.deepEqual((await c.m.get(rid, toks[0])).players.map((p) => p.wins), [0, 1, 0]); // counted once
});

test('vote: a tie shares the win; the scoreboard survives New game; votes start fresh', async () => {
  const c = setup(); const [rid, toks] = await c.room(2, { toss: false });
  await c.m.start(rid, toks[0]); await finish(c, rid, toks);
  await c.m.vote(rid, toks[0], 0);
  let st = await c.m.vote(rid, toks[1], 1);
  assert.deepEqual(st.vote.result.winners, [0, 1]); assert.deepEqual(st.players.map((p) => p.wins), [1, 1]);
  st = await c.m.rematch(rid, toks[1]);
  assert.equal(st.vote, null); assert.deepEqual(st.players.map((p) => p.wins), [1, 1]); assert.ok(st.players.every((p) => !p.voted));
  await finish(c, rid, toks);
  await c.m.vote(rid, toks[0], 1); st = await c.m.vote(rid, toks[1], 1);
  assert.deepEqual(st.players.map((p) => p.wins), [1, 2]); // P2 wins the second game
});

test('vote: the host can close voting early; a leaver does not block it', async () => {
  const c = setup(); const [rid, toks] = await c.room(3, { toss: false });
  await c.m.start(rid, toks[0]); await finish(c, rid, toks);
  await rejects(c.m.endvote(rid, toks[0]), 409, /Nobody has voted/);
  await c.m.vote(rid, toks[1], 2);
  await rejects(c.m.endvote(rid, toks[1]), 403); // host only
  let st = await c.m.endvote(rid, toks[0]);
  assert.deepEqual(st.vote.result, { winners: [2], counts: [0, 0, 1] });
  // another room: the one who has not voted leaves, which completes the vote
  const d = setup(); const [rid2, toks2] = await d.room(3, { toss: false });
  await d.m.start(rid2, toks2[0]); await finish(d, rid2, toks2);
  await d.m.vote(rid2, toks2[0], 1); await d.m.vote(rid2, toks2[1], 1);
  st = await d.m.get(rid2, toks2[0]); assert.equal(st.vote.result, null);
  await d.m.leave(rid2, toks2[2]);
  st = await d.m.get(rid2, toks2[0]);
  assert.deepEqual(st.vote.result.winners, [1]);
});
