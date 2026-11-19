'use strict';
/* Where rooms are kept between requests.

   Production: Upstash Redis over its REST API (no driver to install, works from any serverless function).
   Add it in Vercel: Storage / Marketplace -> Upstash for Redis (free plan). Vercel then sets
   KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN). Either pair works.

   Local dev and tests: MemoryStore (one process only, so it is NOT used on Vercel).

   Both stores offer: load, save(rid, room, ttlSeconds), create (only if the code is free), del, lock, unlock.
*/
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UNLOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

class RedisStore {
  constructor(url, token, fetchFn = fetch) {
    this.url = url.replace(/\/+$/, ''); this.token = token; this.fetch = fetchFn;
  }

  async cmd(args) {
    const res = await this.fetch(this.url, {
      method: 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error) throw new Error(`Redis ${args[0]} failed: ${j.error || res.status}`);
    return j.result;
  }

  async load(rid) {
    const v = await this.cmd(['GET', `room:${rid}`]);
    return v ? JSON.parse(v) : null;
  }
  save(rid, room, ttl) { return this.cmd(['SET', `room:${rid}`, JSON.stringify(room), 'EX', String(ttl)]); }
  async create(rid, room, ttl) {
    return (await this.cmd(['SET', `room:${rid}`, JSON.stringify(room), 'NX', 'EX', String(ttl)])) === 'OK';
  }
  del(rid) { return this.cmd(['DEL', `room:${rid}`]); }

  /* generic keys (accounts, sessions). ttl 0 = no expiry */
  async kget(k) { const v = await this.cmd(['GET', `kv:${k}`]); return v ? JSON.parse(v) : null; }
  kset(k, v, ttl = 0) { return this.cmd(ttl ? ['SET', `kv:${k}`, JSON.stringify(v), 'EX', String(ttl)] : ['SET', `kv:${k}`, JSON.stringify(v)]); }
  async kcreate(k, v) { return (await this.cmd(['SET', `kv:${k}`, JSON.stringify(v), 'NX'])) === 'OK'; }
  kdel(k) { return this.cmd(['DEL', `kv:${k}`]); }

  /** Per-room mutex (so two players acting at once cannot overwrite each other). Auto-expires after 5 s. */
  async lock(rid) {
    const id = crypto.randomBytes(9).toString('hex');
    for (let i = 0; i < 40; i++) {
      if ((await this.cmd(['SET', `lock:${rid}`, id, 'NX', 'PX', '5000'])) === 'OK') return id;
      await sleep(75);
    }
    return null;
  }
  unlock(rid, id) { return this.cmd(['EVAL', UNLOCK, '1', `lock:${rid}`, id]).catch(() => {}); }
}

class MemoryStore {
  constructor(clock = () => Date.now() / 1000) { this.clock = clock; this.rooms = new Map(); this.locks = new Map(); }

  _live(rid) {
    const e = this.rooms.get(rid);
    if (e && e.exp <= this.clock()) { this.rooms.delete(rid); return null; }
    return e || null;
  }
  async load(rid) { const e = this._live(rid); return e ? JSON.parse(e.json) : null; }
  async save(rid, room, ttl) { this.rooms.set(rid, { json: JSON.stringify(room), exp: this.clock() + ttl }); }
  async create(rid, room, ttl) {
    if (this._live(rid)) return false;
    await this.save(rid, room, ttl); return true;
  }
  async del(rid) { this.rooms.delete(rid); }

  async kget(k) { const e = this._live('kv:' + k); return e ? JSON.parse(e.json) : null; }
  async kset(k, v, ttl = 0) { this.rooms.set('kv:' + k, { json: JSON.stringify(v), exp: ttl ? this.clock() + ttl : Infinity }); }
  async kcreate(k, v) { if (this._live('kv:' + k)) return false; await this.kset(k, v); return true; }
  async kdel(k) { this.rooms.delete('kv:' + k); }
  async lock(rid) {
    while (this.locks.get(rid)) await this.locks.get(rid);
    let release; this.locks.set(rid, new Promise((r) => { release = r; }));
    return () => { this.locks.delete(rid); release(); };
  }
  async unlock(rid, release) { if (typeof release === 'function') release(); }
}

let shared = null; // one store per warm function instance

/** The store for this environment, or null when production has no Redis configured. */
function getStore(env = process.env) {
  if (shared) return shared;
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) shared = new RedisStore(url, token);
  else if (!env.VERCEL) shared = new MemoryStore(); // local `vercel dev` / node: a single process, fine
  return shared;
}

module.exports = { RedisStore, MemoryStore, getStore };
