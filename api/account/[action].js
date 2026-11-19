// /api/account/:action  -> register | login | logout | me | friend-request | friend-accept | friend-decline | friend-remove | invite-send | invite-dismiss
module.exports = require('../../lib/http').accountRoute;
