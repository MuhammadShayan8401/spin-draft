'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RoomManager } = require('../lib/rooms');
const { AccountManager } = require('../lib/accounts');
const { handleAccount } = require('../lib/api');
const { MemoryStore } = require('../lib/store');
const ALL = require('../lib/teams').all;

function setup() {
  const store = new MemoryStore(), rooms = new RoomManager(() => ALL, store);
  const acc = new AccountManager(store, rooms);
  const call = async (method, act, body, tok) => handleAccount(acc, method, [act], body, tok ? { authorization: 'Bearer ' + tok } : {});
  return { rooms, acc, call };
}
async function two(call) {
  const a = (await call('POST', 'register', { username: 'Alice', password: 'password1' }))[1];
  const b = (await call('POST', 'register', { username: 'bob_2', password: 'password2' }))[1];
  return [a, b];
}

test('register, login, me, logout', async () => {
  const { call } = setup();
  const [st, a] = await call('POST', 'register', { username: ' Alice ', password: 'password1' });
  assert.equal(st, 201); assert.equal(a.me.username, 'alice');
  assert.equal((await call('POST', 'register', { username: 'ALICE', password: 'otherpass1' }))[0], 409);
  assert.equal((await call('POST', 'register', { username: 'a', password: 'password1' }))[0], 400);
  assert.equal((await call('POST', 'register', { username: 'okname', password: 'short' }))[0], 400);
  assert.equal((await call('POST', 'login', { username: 'alice', password: 'nope-nope' }))[0], 401);
  const [ls, l] = await call('POST', 'login', { username: 'alice', password: 'password1' });
  assert.equal(ls, 200);
  assert.equal((await call('GET', 'me', null, l.token))[1].me.username, 'alice');
  assert.equal((await call('GET', 'me'))[0], 401);
  await call('POST', 'logout', {}, l.token);
  assert.equal((await call('GET', 'me', null, l.token))[0], 401);
  assert.equal((await call('GET', 'me', null, a.token))[0], 200); // other sessions stay valid
});

test('too many wrong passwords locks the login for a while', async () => {
  const { call } = setup();
  await call('POST', 'register', { username: 'carol', password: 'password1' });
  for (let i = 0; i < 8; i++) assert.equal((await call('POST', 'login', { username: 'carol', password: 'wrong-pass' }))[0], 401);
  assert.equal((await call('POST', 'login', { username: 'carol', password: 'password1' }))[0], 429);
});

test('friend request, accept, decline, cancel, remove', async () => {
  const { call } = setup();
  const [a, b] = await two(call);
  assert.equal((await call('POST', 'friend-request', { username: 'alice' }, a.token))[0], 400); // yourself
  assert.equal((await call('POST', 'friend-request', { username: 'nobody' }, a.token))[0], 404);
  let r = (await call('POST', 'friend-request', { username: 'bob_2' }, a.token))[1];
  assert.equal(r.status, 'sent'); assert.deepEqual(r.me.outgoing, ['bob_2']);
  assert.equal((await call('POST', 'friend-request', { username: 'bob_2' }, a.token))[0], 409);
  assert.deepEqual((await call('GET', 'me', null, b.token))[1].me.incoming, ['alice']);
  r = (await call('POST', 'friend-accept', { username: 'alice' }, b.token))[1];
  assert.deepEqual(r.me.friends, ['alice']); assert.deepEqual(r.me.incoming, []);
  assert.deepEqual((await call('GET', 'me', null, a.token))[1].me.friends, ['bob_2']);
  assert.equal((await call('POST', 'friend-request', { username: 'alice' }, b.token))[0], 409);
  assert.equal((await call('POST', 'friend-accept', { username: 'alice' }, b.token))[0], 404);
  await call('POST', 'friend-remove', { username: 'alice' }, b.token);
  assert.deepEqual((await call('GET', 'me', null, a.token))[1].me.friends, []);
  // decline and cancel
  await call('POST', 'friend-request', { username: 'bob_2' }, a.token);
  await call('POST', 'friend-decline', { username: 'alice' }, b.token);
  assert.deepEqual((await call('GET', 'me', null, a.token))[1].me.outgoing, []);
  await call('POST', 'friend-request', { username: 'bob_2' }, a.token);
  await call('POST', 'friend-decline', { username: 'bob_2' }, a.token);
  assert.deepEqual((await call('GET', 'me', null, b.token))[1].me.incoming, []);
});

test('both sides asking at once makes them friends', async () => {
  const { call } = setup();
  const [a, b] = await two(call);
  await call('POST', 'friend-request', { username: 'bob_2' }, a.token);
  const r = (await call('POST', 'friend-request', { username: 'alice' }, b.token))[1];
  assert.equal(r.status, 'friends'); assert.deepEqual(r.me.friends, ['alice']);
});

test('room invites: friends only, must sit in the room, dismissable', async () => {
  const { call, rooms } = setup();
  const [a, b] = await two(call);
  const room = await rooms.create('Alice');
  const body = { username: 'bob_2', room: room.room, roomToken: room.token };
  assert.equal((await call('POST', 'invite-send', body, a.token))[0], 403); // not friends yet
  await call('POST', 'friend-request', { username: 'bob_2' }, a.token);
  await call('POST', 'friend-accept', { username: 'alice' }, b.token);
  assert.equal((await call('POST', 'invite-send', { ...body, roomToken: 'wrong' }, a.token))[0] >= 400, true);
  assert.equal((await call('POST', 'invite-send', body, a.token))[0], 200);
  await call('POST', 'invite-send', body, a.token); // same room again: still one invite
  const inv = (await call('GET', 'me', null, b.token))[1].me.invites;
  assert.equal(inv.length, 1); assert.equal(inv[0].from, 'alice'); assert.equal(inv[0].room, room.room);
  const j = await rooms.join(inv[0].room, 'bob_2');
  assert.equal(j.room, room.room);
  const after = (await call('POST', 'invite-dismiss', { id: inv[0].id }, b.token))[1];
  assert.deepEqual(after.me.invites, []);
});

test('invites expire after 30 minutes', async () => {
  const store = new MemoryStore(), rooms = new RoomManager(() => ALL, store);
  let now = 1000; const acc = new AccountManager(store, rooms, () => now);
  const call = (m, act, body, tok) => handleAccount(acc, m, [act], body, tok ? { authorization: 'Bearer ' + tok } : {});
  const [a, b] = await two(call);
  await call('POST', 'friend-request', { username: 'bob_2' }, a.token);
  await call('POST', 'friend-accept', { username: 'alice' }, b.token);
  const room = await rooms.create('Alice');
  await call('POST', 'invite-send', { username: 'bob_2', room: room.room, roomToken: room.token }, a.token);
  assert.equal((await call('GET', 'me', null, b.token))[1].me.invites.length, 1);
  now += 31 * 60;
  assert.equal((await call('GET', 'me', null, b.token))[1].me.invites.length, 0);
});
