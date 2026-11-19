'use strict';
/* Accounts, friends and room invites. Stored in the same store as the rooms (Upstash Redis in production).

   user:{name}  -> {salt, hash, friends[], incoming[], outgoing[], invites[{id, from, room, at}], created}
   sess:{sha256(token)} -> {u: name}      (30 days; the raw token only lives in the browser)

   Usernames are lowercase letters, digits and _ (3 to 20), so the name is also the display name.
   Passwords are hashed with scrypt and a random salt per user. */
const crypto = require('crypto');
const { promisify } = require('util');
const { RoomError } = require('./rooms');

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL = 30 * 24 * 3600, INVITE_TTL = 30 * 60;
const LIM = { friends: 100, incoming: 50, outgoing: 50, invites: 20 };
const FAIL_MAX = 8, FAIL_WINDOW = 600; // wrong passwords per username per 10 min (per server instance)

const bad = (m, s = 400) => new RoomError(m, s);
const norm = (u) => String(u || '').trim().toLowerCase();
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const without = (a, x) => a.filter((y) => y !== x);

class AccountManager {
  /** rooms: the RoomManager, used to check that an inviter really sits in the room they invite to. */
  constructor(store, rooms, clock = () => Date.now() / 1000) {
    this.store = store; this.rooms = rooms; this.clock = clock; this.fails = new Map();
  }

  _load(name) { return this.store.kget(`user:${name}`); }
  _save(name, u) { return this.store.kset(`user:${name}`, u); }

  async _locked(names, fn) {
    const held = [];
    try {
      for (const n of [...new Set(names)].sort()) { // fixed order, so two requests can never wait on each other
        const l = await this.store.lock('u:' + n);
        if (!l) throw bad('Busy, please try again.', 503);
        held.push([n, l]);
      }
      return await fn();
    } finally {
      for (const [n, l] of held.reverse()) await this.store.unlock('u:' + n, l);
    }
  }

  _view(name, u) {
    const now = this.clock();
    return {
      username: name, friends: [...u.friends].sort(), incoming: u.incoming, outgoing: u.outgoing,
      invites: u.invites.filter((i) => now - i.at < INVITE_TTL),
    };
  }

  async _session(name, u) {
    const token = crypto.randomBytes(24).toString('base64url');
    await this.store.kset(`sess:${sha(token)}`, { u: name }, SESSION_TTL);
    return { token, me: this._view(name, u) };
  }

  async register(username, password) {
    const name = norm(username);
    if (!/^[a-z0-9_]{3,20}$/.test(name)) throw bad('Username: 3 to 20 characters, lowercase letters, numbers or _.');
    if (typeof password !== 'string' || password.length < 8 || password.length > 72) throw bad('Password: 8 to 72 characters.');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scrypt(password, salt, 32)).toString('hex');
    const u = { salt, hash, friends: [], incoming: [], outgoing: [], invites: [], created: Math.floor(this.clock()) };
    if (!(await this.store.kcreate(`user:${name}`, u))) throw bad('That username is taken.', 409);
    return this._session(name, u);
  }

  async login(username, password) {
    const name = norm(username), now = this.clock(), f = this.fails.get(name);
    if (f && now - f.t < FAIL_WINDOW && f.n >= FAIL_MAX) throw bad('Too many wrong passwords. Try again in a few minutes.', 429);
    const u = await this._load(name);
    const hash = (await scrypt(String(password || ''), u ? u.salt : 'x'.repeat(32), 32)); // same work for unknown names
    const ok = u && crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'hex'));
    if (!ok) {
      this.fails.set(name, { n: f && now - f.t < FAIL_WINDOW ? f.n + 1 : 1, t: f && now - f.t < FAIL_WINDOW ? f.t : now });
      throw bad('Wrong username or password.', 401);
    }
    this.fails.delete(name);
    return this._session(name, u);
  }

  async logout(token) { if (token) await this.store.kdel(`sess:${sha(token)}`); return { ok: true }; }

  async auth(token) {
    const s = token ? await this.store.kget(`sess:${sha(token)}`) : null;
    if (!s) throw bad('Please log in again.', 401);
    return s.u;
  }

  async me(token) {
    const name = await this.auth(token), u = await this._load(name);
    if (!u) throw bad('Please log in again.', 401);
    return { me: this._view(name, u) };
  }

  /** Send a friend request. If they already asked you, you become friends straight away. */
  async friendRequest(token, target) {
    const me = await this.auth(token), t = norm(target);
    if (!t) throw bad('Type a username.');
    if (t === me) throw bad('That is you.');
    return this._locked([me, t], async () => {
      const U = await this._load(me), T = await this._load(t);
      if (!U) throw bad('Please log in again.', 401);
      if (!T) throw bad('No player with that username.', 404);
      if (U.friends.includes(t)) throw bad('You are already friends.', 409);
      if (U.outgoing.includes(t)) throw bad('Request already sent.', 409);
      if (U.incoming.includes(t)) return this._befriend(me, U, t, T);
      if (U.outgoing.length >= LIM.outgoing || T.incoming.length >= LIM.incoming) throw bad('Too many pending requests.', 409);
      U.outgoing.push(t); T.incoming.push(me);
      await this._save(me, U); await this._save(t, T);
      return { status: 'sent', me: this._view(me, U) };
    });
  }

  async _befriend(a, A, b, B) {
    for (const [X, y] of [[A, b], [B, a]]) {
      X.incoming = without(X.incoming, y); X.outgoing = without(X.outgoing, y);
      if (!X.friends.includes(y)) X.friends.push(y);
      if (X.friends.length > LIM.friends) throw bad('Friend list is full.', 409);
    }
    await this._save(a, A); await this._save(b, B);
    return { status: 'friends', me: this._view(a, A) };
  }

  async friendAccept(token, from) {
    const me = await this.auth(token), f = norm(from);
    return this._locked([me, f], async () => {
      const U = await this._load(me), F = await this._load(f);
      if (!U || !F || !U.incoming.includes(f)) throw bad('That request is gone.', 404);
      return this._befriend(me, U, f, F);
    });
  }

  /** Decline an incoming request, or cancel one you sent. */
  async friendDecline(token, other) {
    const me = await this.auth(token), o = norm(other);
    return this._locked([me, o], async () => {
      const U = await this._load(me), O = await this._load(o);
      if (!U) throw bad('Please log in again.', 401);
      U.incoming = without(U.incoming, o); U.outgoing = without(U.outgoing, o);
      await this._save(me, U);
      if (O) { O.incoming = without(O.incoming, me); O.outgoing = without(O.outgoing, me); await this._save(o, O); }
      return { me: this._view(me, U) };
    });
  }

  async friendRemove(token, other) {
    const me = await this.auth(token), o = norm(other);
    return this._locked([me, o], async () => {
      const U = await this._load(me), O = await this._load(o);
      if (!U) throw bad('Please log in again.', 401);
      U.friends = without(U.friends, o); await this._save(me, U);
      if (O) { O.friends = without(O.friends, me); await this._save(o, O); }
      return { me: this._view(me, U) };
    });
  }

  /** Invite a friend to the room you are in. They see it on their home screen and can join with one tap. */
  async inviteSend(token, to, room, roomToken) {
    const me = await this.auth(token), t = norm(to), code = String(room || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) throw bad('No room to invite to.');
    const U = await this._load(me);
    if (!U || !U.friends.includes(t)) throw bad('You can only invite friends.', 403);
    await this.rooms.get(code, roomToken, null); // throws 404/403 unless you really are in that room
    return this._locked([t], async () => {
      const T = await this._load(t);
      if (!T) throw bad('No player with that username.', 404);
      const now = this.clock();
      T.invites = T.invites.filter((i) => now - i.at < INVITE_TTL && !(i.from === me && i.room === code));
      T.invites.push({ id: crypto.randomBytes(6).toString('hex'), from: me, room: code, at: now });
      T.invites = T.invites.slice(-LIM.invites);
      await this._save(t, T);
      return { ok: true };
    });
  }

  async inviteDismiss(token, id) {
    const me = await this.auth(token);
    return this._locked([me], async () => {
      const U = await this._load(me);
      if (!U) throw bad('Please log in again.', 401);
      U.invites = U.invites.filter((i) => i.id !== id);
      await this._save(me, U);
      return { me: this._view(me, U) };
    });
  }
}

module.exports = { AccountManager };
