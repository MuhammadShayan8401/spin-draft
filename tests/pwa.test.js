'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUB = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

test('manifest is installable and its icons exist', () => {
  const m = JSON.parse(fs.readFileSync(path.join(PUB, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone'); assert.ok(m.name && m.short_name && m.start_url && m.theme_color);
  const sizes = m.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512')); assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(PUB, i.src)), i.src);
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/); assert.match(html, /apple-touch-icon/);
});

test('every precached file exists', () => {
  const sw = fs.readFileSync(path.join(PUB, 'sw.js'), 'utf8');
  const list = JSON.parse(sw.match(/const PRECACHE = (\[.*?\]);/s)[1].replace(/'/g, '"'));
  for (const f of list) assert.ok(f === '/' || fs.existsSync(path.join(PUB, f)), f);
});

// run the real sw.js against fake browser globals
function loadSW() {
  const handlers = {}, cacheStore = new Map(), fetched = [];
  const mkCache = (name) => { if (!cacheStore.has(name)) cacheStore.set(name, new Map()); const m = cacheStore.get(name);
    return { async match(req) { return m.get(typeof req === 'string' ? req : new URL(req.url).pathname) || undefined; },
      async put(req, res) { m.set(typeof req === 'string' ? req : new URL(req.url).pathname, res); }, async addAll() {} }; };
  const net = { online: true };
  class Res { constructor(body, o = {}) { this.body = body; this.ok = o.ok !== false; this.type = o.type || 'basic'; } clone() { return this; } }
  Res.error = () => new Res('error', { ok: false });
  const ctx = {
    self: { location: { origin: 'https://app.example' }, addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting() {}, clients: { claim() {} } },
    caches: { open: async (n) => mkCache(n), keys: async () => [...cacheStore.keys()], delete: async (n) => cacheStore.delete(n) },
    fetch: async (req) => { fetched.push(new URL(req.url).pathname); if (!net.online) throw new Error('offline'); return new Res('net:' + new URL(req.url).pathname); },
    Response: Res, URL, Promise, setTimeout, console,
  };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(PUB, 'sw.js'), 'utf8'), ctx);
  const call = async (url, { method = 'GET', mode = 'cors' } = {}) => {
    let out; const waits = [];
    const e = { request: { url, method, mode }, respondWith: (p) => { out = p; }, waitUntil: (p) => waits.push(p) };
    handlers.fetch(e); const res = out ? await out : undefined; await Promise.all(waits); return res;
  };
  return { call, net, fetched, cacheStore };
}

test('service worker: game page opens offline after one online visit', async () => {
  const sw = loadSW();
  assert.equal((await sw.call('https://app.example/', { mode: 'navigate' })).body, 'net:/');
  sw.net.online = false;
  assert.equal((await sw.call('https://app.example/?room=ABC123', { mode: 'navigate' })).body, 'net:/'); // served from cache
});

test('service worker: no player data is requested or cached any more', async () => {
  const sw = loadSW();
  assert.equal(await sw.call('https://app.example/api/players'), undefined);
  assert.equal(await sw.call('https://app.example/api/meta'), undefined);
  assert.ok(![...sw.cacheStore.keys()].some((k) => k.includes('data')));
});

test('service worker: room API is never intercepted or cached', async () => {
  const sw = loadSW();
  for (const u of ['https://app.example/api/rooms', 'https://app.example/api/rooms/ABC123/spin']) assert.equal(await sw.call(u), undefined);
  assert.equal(await sw.call('https://app.example/api/rooms/ABC123', { method: 'POST' }), undefined);
  assert.ok(![...sw.cacheStore.keys()].some((k) => k.includes('rooms')));
});

test('service worker: offline with nothing cached fails cleanly', async () => {
  const sw = loadSW(); sw.net.online = false;
  const res = await sw.call('https://app.example/', { mode: 'navigate' }); assert.equal(res.ok, false);
});

test('page: rooms are disabled offline, install + service worker wired up', () => {
  assert.match(html, /navigator\.serviceWorker\.register\('\/sw\.js'\)/);
  assert.match(html, /addEventListener\('offline',netState\)/);
  assert.match(html, /\$\('#onCreate'\)\.disabled=\$\('#onJoin'\)\.disabled=off/);
  assert.match(html, /You are offline\. Online rooms need an internet connection/);
  assert.match(html, /beforeinstallprompt/);
});
