'use strict';
/* Glue between Vercel's (req, res) and lib/api.js. */
const { handle, handleAccount } = require('./api');
const { AccountManager } = require('./accounts');
const { RoomManager } = require('./rooms');
const { getStore } = require('./store');
const { getAll } = require('./teams');

let mgr = null, acct = null;
function manager() {
  const store = getStore();
  if (!store) return null;
  if (!mgr) mgr = new RoomManager(getAll, store);
  return mgr;
}

const header = (req) => Object.fromEntries(Object.entries(req.headers || {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));

/** parts(req) -> array of path segments after /api/rooms */
function roomsRoute(parts) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const m = manager();
    if (!m) {
      return res.status(503).json({ error: 'Online rooms are not set up yet: connect an Upstash Redis database to this Vercel project (see DEPLOY.md).' });
    }
    if (Number(req.headers['content-length'] || 0) > 20000) return res.status(413).json({ error: 'Request too large' });
    const query = { ...(req.query || {}) };
    const segs = parts(query);
    const [status, payload] = await handle(m, req.method, segs, query, req.method === 'POST' ? req.body : null, header(req));
    return res.status(status).json(payload);
  };
}

function accounts() {
  const m = manager();
  if (!m) return null;
  if (!acct) acct = new AccountManager(getStore(), m);
  return acct;
}

/** /api/account/:action */
function accountRoute(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const a = accounts();
  if (!a) return res.status(503).json({ error: 'Accounts are not set up yet: connect an Upstash Redis database (see DEPLOY.md).' });
  if (Number(req.headers['content-length'] || 0) > 20000) return res.status(413).json({ error: 'Request too large' });
  return handleAccount(a, req.method, [(req.query || {}).action], req.method === 'POST' ? req.body : null, header(req))
    .then(([status, payload]) => res.status(status).json(payload));
}

module.exports = { roomsRoute, accountRoute };
