'use strict';
/** Additive schema/settings/owner initialization. Never seeds or resets data. */
const config = require('../config');
require('../config/production').assertRuntime(config);
const db = require('./index');
const settings = require('../services/settings');
const { ensureOwner, assertNoDemoAccounts } = require('./owner');
assertNoDemoAccounts(db, config);
settings.ensureDefaults();
require('./departments').ensureDepartments(db);
const owner = ensureOwner(db, config);
console.log(owner.created ? '✔  Owner account created from the private environment.' : '✔  Schema up to date, owner account present.');
const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
console.log(`✔  ${tables} tables ready in ${config.db.file}`);
if (require.main === module) {
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}
module.exports = {};
