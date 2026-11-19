'use strict';
/* Online rooms: several people draft together, each on their own device.

   The server is the referee. It owns the wheel results (so everyone sees the same spin), turn order,
   snake order, re-spins and pick validation. Clients only send intentions and render the state they get back.

   Serverless functions keep no memory between requests, so every room lives in a store (store.js: Redis in
   production, memory for tests and local dev). A change = lock the room, load it, apply the rule, save, unlock.
   Reads (polls) take no lock unless the player's "last seen" needs refreshing.

   Rules mirror the single-device game in public/index.html:
     * every round all players draft from the SAME club/country spin, one after another
     * with the position wheel on, each player also spins for the position they must fill
     * re-spins: each player has options.respins of them (default 1); by default only on the first pick of a round,
       with options.rrAny on, on any of their picks
     * players type the name they pick (no player data); a name may be drafted only once per room
     * optional wheel preset (options.wheel = {name, clubs, nations}, null = every team): only those teams can come up
     * always on: a club or country that has been spun is off the wheel for the rest of the draft (if every team has come up, they all go back on)
     * optional ("noRepeat"): the team that was just spun is left off the next wheel
     * after the draft the players vote for the best XI; the winner gets a point on the room's scoreboard (it survives New game)
*/
const crypto = require('crypto');

const PAL = ['#d6402f', '#2f6fb5', '#7a3fa0', '#1f9aa0', '#c25a1a', '#b04f78'];
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L: easy to read out loud
const CODE_LEN = 6;
const MAX_PLAYERS = 6, MIN_PLAYERS = 2, ROUNDS = 11, WHEEL_SIZE = 14;
const AWAY_AFTER = 20;   // seconds of silence before a player counts as away
const CLOSE_AFTER = 60;  // seconds of silence from ANY player (app killed, tab closed, no signal) before the room is closed
const TOUCH_EVERY = 8;   // a polling player's "last seen" is saved at most this often (keeps store traffic low)
const TTL = { lobby: 30 * 60, playing: 3 * 3600, done: 3600 }; // idle seconds before a room expires

// Must stay identical to FORM in public/index.html (row order: attack first, GK last). A test checks it.
const FORM = {
  '4-3-3': [['LW', 'ST', 'RW'], ['CM', 'CM', 'CM'], ['LB', 'CB', 'CB', 'RB'], ['GK']],
  '4-4-2': [['ST', 'ST'], ['LM', 'CM', 'CM', 'RM'], ['LB', 'CB', 'CB', 'RB'], ['GK']],
  '4-2-3-1': [['ST'], ['LW', 'CAM', 'RW'], ['CDM', 'CDM'], ['LB', 'CB', 'CB', 'RB'], ['GK']],
  '4-1-4-1': [['ST'], ['LM', 'CM', 'CM', 'RM'], ['CDM'], ['LB', 'CB', 'CB', 'RB'], ['GK']],
  '3-5-2': [['ST', 'ST'], ['CAM'], ['LWB', 'CM', 'CM', 'RWB'], ['CB', 'CB', 'CB'], ['GK']],
  '3-4-3': [['LW', 'ST', 'RW'], ['LM', 'CM', 'CM', 'RM'], ['CB', 'CB', 'CB'], ['GK']],
  '5-3-2': [['ST', 'ST'], ['CM', 'CM', 'CM'], ['LWB', 'CB', 'CB', 'CB', 'RWB'], ['GK']],
};
const SRC = ['both', 'club', 'nat'];
const MAX_RESPINS = 5; // most re-spins a host can give each player

class RoomError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const slotsFor = (formation) => [...FORM[formation]].reverse().flat(); // GK first, attackers last (same as mk() in the frontend)

function cleanName(s, limit) {
  const t = String(s == null ? '' : s).replace(/[\x00-\x1f\x7f<>]/g, '').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, limit).join('');
}
const TEAM_NAME_MAX = 24, TEAMS_MAX = 80; // a team typed in by the host: longest name, most teams per list
const defaultOptions = () => ({ src: 'both', posOn: false, snake: true, toss: true, noRepeat: false, respins: 1, rrAny: false, wheel: null });
const newPlayer = (seat, name, token, now) => ({
  token, name: name || `Player ${seat + 1}`, formation: '4-3-3', slots: slotsFor('4-3-3'),
  squad: Array(11).fill(null), rr: 1, last_seen: now, conn: true, wins: 0, vote: null,
});
const newRoom = (id, now) => ({
  id, created: now, last_active: now, phase: 'lobby', options: defaultOptions(), players: [], host: 0,
  order: [], t: 0, cur: null, labs: [], used: [], last: null, result: null, spin_n: 0, spin: null, first: null, version: 1,
});

// ---- small helpers on a room object
const n = (r) => r.players.length;
const bump = (r) => { r.version += 1; };
function who(r) {
  const k = n(r), round = Math.floor(r.t / k), i = r.t % k;
  return r.options.snake && round % 2 ? r.order[k - 1 - i] : r.order[i];
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function seatOf(r, token) {
  if (!token) return null;
  const i = r.players.findIndex((p) => safeEqual(p.token, token));
  return i < 0 ? null : i;
}
function openTypes(r, seat) {
  const p = r.players[seat], seen = [];
  p.squad.forEach((v, i) => { if (!v && !seen.includes(p.slots[i])) seen.push(p.slots[i]); });
  return seen;
}
const SKIPPED = 'Skipped'; // what an away player's pick becomes when the host skips their turn; not a real name, so it can repeat
const drafted = (r) => new Set(r.players.flatMap((p) => p.squad).filter((v) => v && v !== SKIPPED).map((v) => v.toLowerCase()));
const respinsOf = (r) => (Number.isInteger(r.options.respins) ? r.options.respins : 1); // rooms saved before this option existed get 1
const ready = (r) => !!r.cur && (!r.options.posOn || 'pos' in r.cur);
const ttlFor = (r) => TTL[r.phase] || TTL.lobby;
const normId = (rid) => String(rid == null ? '' : rid).replace(/[^A-Za-z0-9]/g, '').toUpperCase();

function cryptoRng() {
  return {
    int: (k) => crypto.randomInt(k),
    shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; },
  };
}

class RoomManager {
  /** teamsFn() -> {clubs: [names], nations: [names]}; store: see store.js */
  constructor(teamsFn, store, { rng, clock } = {}) {
    this.teamsFn = teamsFn; this.store = store;
    this.rng = rng || cryptoRng();
    this.clock = clock || (() => Date.now() / 1000);
  }

  // ---------- plumbing
  async _newId(room) {
    for (let k = 0; k < 50; k++) {
      let rid = '';
      for (let i = 0; i < CODE_LEN; i++) rid += ALPHABET[this.rng.int(ALPHABET.length)];
      room.id = rid;
      if (await this.store.create(rid, room, ttlFor(room))) return rid;
    }
    throw new RoomError('Could not make a room code, try again', 503);
  }

  /** Lock the room, load it, run fn(room), save (unless fn asks to delete it), unlock. */
  async _with(rid, fn) {
    const id = normId(rid);
    if (!id) throw new RoomError('Room not found. Check the code.', 404);
    const lock = await this.store.lock(id);
    if (!lock) throw new RoomError('The room is busy, try again.', 503);
    try {
      const r = await this.store.load(id);
      if (!r) throw new RoomError('Room not found. Check the code.', 404);
      const out = await fn(r);
      if (r._delete) await this.store.del(id); else await this.store.save(id, r, ttlFor(r));
      return out;
    } finally {
      await this.store.unlock(id, lock);
    }
  }

  _auth(r, token) {
    const seat = seatOf(r, token);
    if (seat === null || r.players[seat].left) throw new RoomError('You are not in this room.', 403);
    const now = this.clock(), p = r.players[seat];
    r.last_active = now; p.last_seen = now;
    if (!p.conn) { p.conn = true; bump(r); }
    return seat;
  }

  _presence(r) {
    const now = this.clock();
    for (const p of r.players) {
      if (p.left) continue;
      if (now - p.last_seen > CLOSE_AFTER) { this._gone(r, p); continue; } // vanished (app killed, no signal)
      const c = now - p.last_seen < AWAY_AFTER;
      if (c !== p.conn) { p.conn = c; bump(r); }
    }
  }

  /** Mid-draft a player who leaves keeps their seat (so turn order and their squad survive) but is out of the game. */
  _gone(r, p) {
    p.left = true; p.conn = false; bump(r);
    const hostP = r.players[r.host];
    if (hostP.left) { const h = r.players.findIndex((x) => !x.left); if (h >= 0) r.host = h; }
    if (r.players.every((x) => x.left)) r._delete = true; else this._tally(r); // the votes that are still missing may now be complete
  }

  _view(r, seat) {
    const cur = r.cur ? { ...r.cur } : null;
    return {
      id: r.id, version: r.version, phase: r.phase, me: seat, host: r.host, options: { ...r.options, wheel: r.options.wheel ? { ...r.options.wheel } : null },
      players: r.players.map((p, i) => ({ seat: i, name: p.name, color: PAL[i], formation: p.formation, slots: p.slots,
        squad: p.squad, rr: p.rr, connected: p.conn && !p.left, left: !!p.left, wins: p.wins || 0, voted: p.vote != null })),
      order: r.order, t: r.t, turn: r.phase === 'playing' ? who(r) : null, first: r.first,
      cur, labs: r.labs.map((x) => x.n), spin: r.spin, forms: Object.keys(FORM), vote: this._voteView(r, seat),
    };
  }

  /** Voting for the best XI: only once the draft is done. Your own vote, how many have voted, and the result when it is in. */
  _voteView(r, seat) {
    if (r.phase !== 'done') return null;
    const active = r.players.filter((p) => !p.left);
    return { mine: seat !== null && r.players[seat].vote != null ? r.players[seat].vote : null,
      cast: active.filter((p) => p.vote != null).length, of: active.length, result: r.result || null };
  }

  // ---------- lobby
  async create(name) {
    const now = this.clock(), room = newRoom('', now), token = crypto.randomBytes(18).toString('base64url');
    room.players.push(newPlayer(0, cleanName(name, 24), token, now));
    await this._newId(room); // saves the room under a free code
    return { room: room.id, token, state: this._view(room, 0) };
  }

  join(rid, name, token = null) {
    return this._with(rid, (r) => {
      if (token) {
        const seat = seatOf(r, token);
        if (seat !== null) { this._auth(r, token); return { room: r.id, token, state: this._view(r, seat) }; }
      }
      if (r.phase !== 'lobby') throw new RoomError('That game has already started.', 409);
      if (n(r) >= MAX_PLAYERS) throw new RoomError(`The room is full (${MAX_PLAYERS} players).`, 409);
      const now = this.clock(), tok = crypto.randomBytes(18).toString('base64url');
      r.players.push(newPlayer(n(r), cleanName(name, 24), tok, now));
      r.last_active = now; bump(r);
      return { room: r.id, token: tok, state: this._view(r, n(r) - 1) };
    });
  }

  /** Poll. Lock-free unless this player's "last seen" is stale or someone's presence flipped. */
  async get(rid, token, since = null) {
    const id = normId(rid);
    const r0 = id && await this.store.load(id);
    if (!r0) throw new RoomError('Room not found. Check the code.', 404);
    const seat0 = seatOf(r0, token);
    if (seat0 === null) throw new RoomError('You are not in this room.', 403);
    const now = this.clock(), me = r0.players[seat0];
    const dirty = r0.players.some((p) => !p.left && now - p.last_seen > CLOSE_AFTER) || !me.conn || now - me.last_seen > TOUCH_EVERY || r0.players.some((p) => (now - p.last_seen < AWAY_AFTER) !== p.conn);
    const reply = (r, seat) => (since !== null && since !== undefined && String(since) === String(r.version)
      ? { unchanged: true, version: r.version } : this._view(r, seat));
    if (r0.players[seat0].left) throw new RoomError('You are not in this room.', 403);
    if (!dirty) return reply(r0, seat0);
    return this._with(id, (r) => { const seat = this._auth(r, token); this._presence(r); return reply(r, seat); });
  }

  settings(rid, token, body) {
    return this._with(rid, (r) => {
      const seat = this._auth(r, token);
      if (r.phase !== 'lobby') throw new RoomError('Settings are locked once the draft starts.', 409);
      const p = r.players[seat];
      if ('name' in body) p.name = cleanName(body.name, 24) || p.name;
      if ('formation' in body) {
        if (!Object.prototype.hasOwnProperty.call(FORM, body.formation)) throw new RoomError('Unknown formation.');
        p.formation = body.formation; p.slots = slotsFor(body.formation);
      }
      if ('options' in body) {
        if (seat !== r.host) throw new RoomError('Only the host can change the game options.', 403);
        const o = r.options, nw = body.options && typeof body.options === 'object' && !Array.isArray(body.options) ? body.options : {};
        if (SRC.includes(nw.src)) o.src = nw.src;
        for (const k of ['posOn', 'snake', 'toss', 'noRepeat', 'rrAny']) if (k in nw) o[k] = !!nw[k];
        if ('respins' in nw) {
          const v = Number(nw.respins);
          if (!Number.isInteger(v) || v < 0 || v > MAX_RESPINS) throw new RoomError(`Re-spins per player: 0 to ${MAX_RESPINS}.`);
          o.respins = v;
        }
        if ('wheel' in nw) o.wheel = this._cleanWheel(nw.wheel);
        if (this._pool(r).length < 2) throw new RoomError('The wheel needs at least 2 teams. Choose a bigger preset or another wheel type.', 409);
        if (o.noRepeat && this._pool(r).length < 3) throw new RoomError('"No repeat in a row" needs at least 3 teams on the wheel.', 409);
      }
      bump(r);
      return this._view(r, seat);
    });
  }

  /** A player leaving (button, closing the tab or the app). The room closes once everyone has left. */
  leave(rid, token) {
    return this._with(rid, (r) => {
      const seat = this._auth(r, token);
      if (r.phase === 'lobby') {
        this._remove(r, seat);
        if (!r.players.length) r._delete = true;
      } else {
        this._gone(r, r.players[seat]);
      }
      return { ok: true, closed: !!r._delete };
    });
  }

  kick(rid, token, target) {
    return this._with(rid, (r) => {
      const seat = this._auth(r, token);
      if (seat !== r.host) throw new RoomError('Only the host can remove players.', 403);
      if (r.phase !== 'lobby') throw new RoomError('Players can only be removed before the draft starts.', 409);
      if (!Number.isInteger(target) || target < 0 || target >= n(r) || target === seat) throw new RoomError('Pick another player to remove.');
      this._remove(r, target);
      return this._view(r, seatOf(r, token));
    });
  }

  _remove(r, seat) {
    const hostToken = r.players[r.host].token;
    r.players.splice(seat, 1);
    // seats are list positions, so they renumber; the host stays host unless they were the one removed
    const h = r.players.findIndex((p) => p.token === hostToken);
    r.host = h < 0 ? 0 : h;
    bump(r);
  }

  // ---------- draft
  start(rid, token) {
    return this._with(rid, (r) => {
      const seat = this._auth(r, token);
      if (seat !== r.host) throw new RoomError('Only the host can start the draft.', 403);
      if (r.phase !== 'lobby') throw new RoomError('The draft already started.', 409);
      if (n(r) < MIN_PLAYERS) throw new RoomError('Wait for at least one more player to join.', 409);
      this._begin(r);
      bump(r);
      return this._view(r, seat);
    });
  }

  /** Fresh draft for the players in the room: empty squads, re-spins back, wheel reset (spun teams back on it),
      new toss and order. Options and formations are left as they are. */
  _begin(r) {
    const k = n(r);
    for (const p of r.players) { p.squad = Array(11).fill(null); p.rr = respinsOf(r); }
    const first = r.options.toss ? this.rng.int(k) : 0;
    r.first = first; r.order = Array.from({ length: k }, (_, i) => (first + i) % k);
    r.phase = 'playing'; r.t = 0; r.cur = null; r.spin = null; r.used = []; r.last = null; r.result = null;
    for (const p of r.players) p.vote = null; // the scoreboard (p.wins) is kept
    this._newLabels(r);
  }

  /** New game after a finished draft, same room and same settings. Any player can start it. Players who left are
      dropped; if fewer than two are left the room goes back to the lobby instead. */
  rematch(rid, token) {
    return this._with(rid, (r) => {
      const seat = this._auth(r, token);
      if (r.phase === 'playing') return this._view(r, seat); // someone else already started the new game
      if (r.phase !== 'done') throw new RoomError('The draft is not finished yet.', 409);
      const hostToken = r.players[r.host].token;
      r.players = r.players.filter((p) => !p.left);
      const h = r.players.findIndex((p) => p.token === hostToken);
      r.host = h < 0 ? 0 : h;
      if (n(r) >= MIN_PLAYERS) this._begin(r);
      else {
        for (const p of r.players) { p.squad = Array(11).fill(null); p.rr = respinsOf(r); }
        r.phase = 'lobby'; r.t = 0; r.cur = null; r.spin = null; r.used = []; r.last = null; r.result = null; r.order = []; r.first = null; r.labs = [];
        for (const p of r.players) p.vote = null;
      }
      bump(r);
      return this._view(r, seatOf(r, token));
    });
  }

  _pool(r) {
    const t = this.teamsFn(), src = r.options.src, w = r.options.wheel, out = [];
    const clubs = w ? w.clubs : t.clubs, nations = w ? w.nations : t.nations;
    if (src !== 'nat') for (const k of clubs) out.push({ n: k, k: 'club' });
    if (src !== 'club') for (const k of nations) out.push({ n: k, k: 'nat' });
    return out;
  }

  /** A wheel preset from the host. The built-in teams keep their spelling; any other name is a team the host typed in.
      Cleaned, no repeats. null = every built-in team. */
  _cleanWheel(w) {
    if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
    const d = this.teamsFn();
    const pick = (arr, known) => {
      const canon = new Map(known.map((k) => [k.toLowerCase(), k])), out = [], seen = new Set();
      if (Array.isArray(arr)) for (const x of arr) {
        const s = cleanName(x, TEAM_NAME_MAX); if (!s) continue;
        const name = canon.get(s.toLowerCase()) || s, key = name.toLowerCase();
        if (!seen.has(key)) { seen.add(key); out.push(name); }
        if (out.length >= TEAMS_MAX) break;
      }
      return out;
    };
    const clubs = pick(w.clubs, d.clubs), nations = pick(w.nations, d.nations);
    const same = (list, known) => list.length === known.length && list.every((k) => known.includes(k));
    if (same(clubs, d.clubs) && same(nations, d.nations)) return null;
    return { name: cleanName(w.name, 30) || 'Custom wheel', clubs, nations };
  }

  _newLabels(r) {
    let pool = this._pool(r);
    // a club or country that has been spun once is gone from the wheel for the rest of the draft
    const gone = new Set((r.used || []).map((u) => u.k + ':' + u.n));
    const fresh = pool.filter((x) => !gone.has(x.k + ':' + x.n));
    if (fresh.length) pool = fresh; else r.used = []; // everything has come up once: put them all back
    if (r.options.noRepeat && r.last) { // the team that was just spun does not come up again straight away
      const left = pool.filter((x) => !(x.k === r.last.k && x.n === r.last.n));
      if (left.length >= 2) pool = left;
    }
    r.labs = this.rng.shuffle([...pool]).slice(0, Math.min(WHEEL_SIZE, pool.length));
  }

  _turn(r, token, hostOk = false) {
    const seat = this._auth(r, token);
    if (r.phase !== 'playing') throw new RoomError('The draft is not running.', 409);
    const curSeat = who(r);
    if (seat !== curSeat) {
      const ok = hostOk && seat === r.host && !r.players[curSeat].conn; // conn flips off after ~20s of silence
      if (!ok) throw new RoomError(`It is ${r.players[curSeat].name}'s turn.`, 409);
    }
    return curSeat;
  }

  /** One wheel spin for the player on the clock. Records it so every client can animate the same result. */
  _doSpin(r, seat) {
    if (r.cur === null) {
      const idx = this.rng.int(r.labs.length), item = r.labs[idx];
      r.spin_n += 1;
      r.spin = { id: r.spin_n, kind: 'club', labels: r.labs.map((x) => x.n), index: idx };
      r.cur = { n: item.n, k: item.k }; r.last = { n: item.n, k: item.k };
      r.used = r.used || []; r.used.push({ n: item.n, k: item.k });
      const o = openTypes(r, seat);
      if (r.options.posOn && o.length === 1) r.cur.pos = o[0];
    } else if (r.options.posOn && !('pos' in r.cur)) {
      const o = openTypes(r, seat), labels = o.length > 1 ? o : [...o, ...o], idx = this.rng.int(labels.length);
      r.spin_n += 1;
      r.spin = { id: r.spin_n, kind: 'pos', labels, index: idx };
      r.cur.pos = labels[idx];
    } else {
      throw new RoomError('Nothing to spin: choose a player.', 409);
    }
  }

  spin(rid, token) {
    return this._with(rid, (r) => {
      const seat = this._turn(r, token);
      this._doSpin(r, seat); bump(r);
      return this._view(r, seatOf(r, token));
    });
  }

  _place(r, seat, slot, name) {
    const p = r.players[seat];
    name = cleanName(name, 40);
    if (!name) throw new RoomError('Choose a player or type a name.');
    if (!ready(r)) throw new RoomError('Spin first.', 409);
    if (!Number.isInteger(slot) || slot < 0 || slot >= 11) throw new RoomError('Tap an empty position on your pitch first.');
    if (p.squad[slot]) throw new RoomError('That position is already filled.', 409);
    if (r.options.posOn && p.slots[slot] !== r.cur.pos) throw new RoomError(`You must fill a ${r.cur.pos} position.`, 409);
    if (drafted(r).has(name.toLowerCase())) throw new RoomError(`${name} is already drafted. Pick someone else.`, 409);
    p.squad[slot] = name;
    r.t += 1;
    const k = n(r);
    r.cur = r.t % k ? { n: r.cur.n, k: r.cur.k } : null;
    if (r.cur === null) this._newLabels(r);
    if (r.t >= ROUNDS * k) { r.phase = 'done'; r.cur = null; }
  }

  pick(rid, token, slot, name) {
    return this._with(rid, (r) => {
      const seat = this._turn(r, token);
      this._place(r, seat, slot, name); bump(r);
      return this._view(r, seatOf(r, token));
    });
  }

  reroll(rid, token) {
    return this._with(rid, (r) => {
      const seat = this._turn(r, token), p = r.players[seat];
      if (!ready(r)) throw new RoomError('Spin first.', 409);
      if (p.rr < 1) throw new RoomError('No re-spins left.', 409);
      if (r.t % n(r) && !r.options.rrAny) throw new RoomError('You can only re-spin on the first pick of a round.', 409);
      p.rr -= 1; r.cur = null; this._newLabels(r); bump(r);
      return this._view(r, seatOf(r, token));
    });
  }

  /** Fix a typo (or change your mind) in one of your own picks. Your position and the turn order do not change. */
  rename(rid, token, slot, name) {
    return this._with(rid, (r) => {
      const seat = this._auth(r, token);
      if (r.phase !== 'playing' && r.phase !== 'done') throw new RoomError('You can fix a name once the draft has started.', 409);
      if (!Number.isInteger(slot) || slot < 0 || slot >= 11) throw new RoomError('Pick one of your players to fix.');
      const p = r.players[seat], old = p.squad[slot];
      if (!old || old === SKIPPED) throw new RoomError('There is no pick in that position.', 409);
      name = cleanName(name, 40);
      if (!name) throw new RoomError('Type the name first.');
      if (name.toLowerCase() !== old.toLowerCase() && drafted(r).has(name.toLowerCase())) throw new RoomError(`${name} is already drafted. Pick someone else.`, 409);
      if (name === old) return this._view(r, seat);
      p.squad[slot] = name; bump(r);
      return this._view(r, seat);
    });
  }

  /** Vote for the best XI (any player, yourself included). You can change your vote until the result is in. */
  vote(rid, token, target) {
    return this._with(rid, (r) => {
      const seat = this._auth(r, token);
      if (r.phase !== 'done') throw new RoomError('Voting opens when the draft is finished.', 409);
      if (r.result) throw new RoomError('Voting is closed.', 409);
      if (!Number.isInteger(target) || target < 0 || target >= n(r)) throw new RoomError('Pick a player to vote for.');
      r.players[seat].vote = target; bump(r);
      this._tally(r);
      return this._view(r, seat);
    });
  }

  /** The host closes voting early (someone is slow or away). Needs at least one vote. */
  endvote(rid, token) {
    return this._with(rid, (r) => {
      const seat = this._auth(r, token);
      if (seat !== r.host) throw new RoomError('Only the host can close the voting.', 403);
      if (r.phase !== 'done') throw new RoomError('Voting opens when the draft is finished.', 409);
      if (r.result) return this._view(r, seat);
      if (!r.players.some((p) => p.vote != null)) throw new RoomError('Nobody has voted yet.', 409);
      this._tally(r, true);
      return this._view(r, seat);
    });
  }

  /** Count the votes once everybody still in the room has voted (or when forced). Most votes wins; a tie shares the win.
      Each winner gets a point on the scoreboard, which is kept for New game. */
  _tally(r, force = false) {
    if (r.phase !== 'done' || r.result) return;
    const active = r.players.filter((p) => !p.left), voted = r.players.filter((p) => p.vote != null);
    if (!voted.length || (!force && !active.every((p) => p.vote != null))) return;
    const counts = r.players.map(() => 0);
    for (const p of voted) counts[p.vote] += 1;
    const top = Math.max(...counts), winners = counts.map((c, i) => (c === top ? i : -1)).filter((i) => i >= 0);
    for (const i of winners) r.players[i].wins = (r.players[i].wins || 0) + 1;
    r.result = { winners, counts }; bump(r);
  }

  /** The host skips the turn of a player who has dropped off (no contact for ~20 seconds, or left): spins if needed
      and fills one of their open positions with a blank, so the draft can go on. Nobody else's pick is made for them. */
  skip(rid, token) {
    return this._with(rid, (r) => {
      const seat = this._turn(r, token, true);
      if (seatOf(r, token) === seat) throw new RoomError('You can only skip a player who is away.', 409);
      while (!ready(r)) this._doSpin(r, seat);
      const p = r.players[seat];
      const slot = p.squad.findIndex((v, i) => !v && (!r.options.posOn || p.slots[i] === r.cur.pos));
      if (slot < 0) throw new RoomError('No free position to fill.', 409);
      this._place(r, seat, slot, SKIPPED); bump(r);
      return this._view(r, seatOf(r, token));
    });
  }
}

module.exports = { RoomManager, RoomError, FORM, ALPHABET, SKIPPED, slotsFor, cleanName, TTL, CLOSE_AFTER };
