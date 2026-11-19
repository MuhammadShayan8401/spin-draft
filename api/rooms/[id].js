// GET /api/rooms/:id  -> poll the room
module.exports = require('../../lib/http').roomsRoute((q) => [q.id]);
