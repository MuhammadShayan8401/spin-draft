/* Service worker: lets Spin Draft XI open and play with no connection.
   - the game page and icons are cached on first visit and refreshed whenever you are online
   - /api/rooms is never cached: online rooms need a connection and the page says so
   Bump VERSION when you change this file's caching rules or the PRECACHE list. */
const VERSION = 'v6';
const SHELL = `spin-shell-${VERSION}`, FONTS = `spin-fonts-${VERSION}`;
const PRECACHE = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png'];
const NETWORK_TIMEOUT_MS = 3500;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL, FONTS]);
    for (const k of await caches.keys()) if (k.startsWith('spin-') && !keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function put(name, req, res) {
  if (res && (res.ok || res.type === 'opaque')) { const c = await caches.open(name); await c.put(req, res.clone()); }
  return res;
}

/* answer from cache at once, refresh it in the background */
async function staleWhileRevalidate(e, name) {
  const cache = await caches.open(name), cached = await cache.match(e.request);
  const fresh = fetch(e.request).then((res) => put(name, e.request, res)).catch(() => null);
  if (cached) { e.waitUntil(fresh); return cached; }
  return (await fresh) || Response.error();
}

/* try the network first (so updates show up), fall back to the cached page when offline or slow */
async function networkFirst(e) {
  const cache = await caches.open(SHELL);
  const fallback = () => cache.match('/', { ignoreSearch: true });
  try {
    const res = await Promise.race([
      fetch(e.request),
      new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), NETWORK_TIMEOUT_MS)),
    ]);
    if (res.ok) e.waitUntil(cache.put('/', res.clone()));
    return res;
  } catch (err) {
    return (await fallback()) || Response.error();
  }
}

async function cacheFirst(e) {
  const cache = await caches.open(SHELL), hit = await cache.match(e.request);
  return hit || put(SHELL, e.request, await fetch(e.request));
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/rooms')) return;                 // live game state: network only
    if (url.pathname.startsWith('/api/')) return;
    if (req.mode === 'navigate') return e.respondWith(networkFirst(e));
    if (url.pathname === '/sw.js') return;                             // always fetched fresh
    return e.respondWith(cacheFirst(e));
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return e.respondWith(staleWhileRevalidate(e, FONTS));
});
