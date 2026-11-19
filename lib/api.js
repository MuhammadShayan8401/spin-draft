'use strict';
/* The room routes as one pure function, so the Vercel functions and the tests share the exact same code.

     POST /api/rooms                     {name}                    create a room   -> {room, token, state}
     POST /api/rooms/{id}/join           {name, token?}            join (or rejoin with your token)
     GET  /api/rooms/{id}?token=&since=  poll: full state, or {unchanged:true} if `since` is current
     POST /api/rooms/{id}/settings       {token, name?, formation?, options?}   (options: host only, lobby only; options.wheel = {name, clubs, nations} limits the wheel (names not in the data are teams typed in by the host), null = every team)
     POST /api/rooms/{id}/start | rematch | spin | reroll | skip | rename | vote | endvote | leave    {token}   (the room closes when every player has left)
     POST /api/rooms/{id}/pick           {token, slot, name}
     POST /api/rooms/{id}/kick           {token, seat}
   Errors: {"error": "..."} with 4xx/5xx.
*/
const { RoomError } = require('./rooms');

/** parts = the path after /api/rooms split on "/" (e.g. [], ['ABC123'], ['ABC123','spin']).
    headers: lower-cased request headers; GET polls send the secret as X-Room-Token so it stays out of URLs and logs.
    Returns [status, json]. */
async function handle(mgr, method, parts, query = {}, body = null, headers = {}) {
  body = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const tok = body.token;
  try {
    if (method === 'POST' && !parts.length) return [201, await mgr.create(body.name)];
    if (!parts.length || parts.length > 2) return [404, { error: 'Not found' }];
    const rid = parts[0];
    if (method === 'GET' && parts.length === 1) {
      return [200, await mgr.get(rid, headers['x-room-token'] || query.token, query.since === undefined ? null : query.since)];
    }
    if (method === 'POST' && parts.length === 2) {
      switch (parts[1]) {
        case 'join': return [200, await mgr.join(rid, body.name, tok)];
        case 'settings': return [200, await mgr.settings(rid, tok, body)];
        case 'start': return [200, await mgr.start(rid, tok)];
        case 'rematch': return [200, await mgr.rematch(rid, tok)];
        case 'spin': return [200, await mgr.spin(rid, tok)];
        case 'reroll': return [200, await mgr.reroll(rid, tok)];
        case 'skip': return [200, await mgr.skip(rid, tok)];
        case 'rename': return [200, await mgr.rename(rid, tok, body.slot, body.name)];
        case 'vote': return [200, await mgr.vote(rid, tok, body.seat)];
        case 'endvote': return [200, await mgr.endvote(rid, tok)];
        case 'pick': return [200, await mgr.pick(rid, tok, body.slot, body.name)];
        case 'leave': return [200, await mgr.leave(rid, tok)];
        case 'kick': return [200, await mgr.kick(rid, tok, body.seat)];
      }
    }
    return [404, { error: 'Not found' }];
  } catch (e) {
    if (e instanceof RoomError) return [e.status, { error: e.message }];
    console.error(e);
    return [503, { error: 'The game server could not reach its storage. Try again.' }];
  }
}

/** Account routes, one function like `handle` (so tests and servers share it):
     POST /api/account/register | login   {username, password}   -> {token, me}
     POST /api/account/logout
     GET  /api/account/me                                        -> {me: {username, friends, incoming, outgoing, invites}}
     POST /api/account/friend-request | friend-accept | friend-decline | friend-remove   {username}
     POST /api/account/invite-send       {username, room, roomToken}   (invite a friend to the room you sit in)
     POST /api/account/invite-dismiss    {id}
   The session token goes in the Authorization header: "Bearer <token>". */
async function handleAccount(acc, method, parts, body = null, headers = {}) {
  body = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const m = /^Bearer (.+)$/.exec(headers.authorization || ''), tok = m ? m[1] : null;
  try {
    if (parts.length !== 1) return [404, { error: 'Not found' }];
    const act = parts[0];
    if (method === 'GET' && act === 'me') return [200, await acc.me(tok)];
    if (method !== 'POST') return [404, { error: 'Not found' }];
    switch (act) {
      case 'register': return [201, await acc.register(body.username, body.password)];
      case 'login': return [200, await acc.login(body.username, body.password)];
      case 'logout': return [200, await acc.logout(tok)];
      case 'friend-request': return [200, await acc.friendRequest(tok, body.username)];
      case 'friend-accept': return [200, await acc.friendAccept(tok, body.username)];
      case 'friend-decline': return [200, await acc.friendDecline(tok, body.username)];
      case 'friend-remove': return [200, await acc.friendRemove(tok, body.username)];
      case 'invite-send': return [200, await acc.inviteSend(tok, body.username, body.room, body.roomToken)];
      case 'invite-dismiss': return [200, await acc.inviteDismiss(tok, body.id)];
    }
    return [404, { error: 'Not found' }];
  } catch (e) {
    if (e instanceof RoomError) return [e.status, { error: e.message }];
    console.error(e);
    return [503, { error: 'The game server could not reach its storage. Try again.' }];
  }
}

module.exports = { handle, handleAccount };
