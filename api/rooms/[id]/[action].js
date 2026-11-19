// POST /api/rooms/:id/:action  -> join | settings | start | rematch | spin | reroll | pick | skip | rename | vote | endvote | leave | kick
module.exports = require('../../../lib/http').roomsRoute((q) => [q.id, q.action]);
