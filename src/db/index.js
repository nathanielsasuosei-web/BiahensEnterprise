'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

fs.mkdirSync(path.dirname(config.db.file), { recursive: true });

const db = new Database(config.db.file);
if (config.storeMode === 'live') {
  for (const file of [config.db.file, `${config.db.file}-wal`, `${config.db.file}-shm`]) {
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  }
}
db.pragma('journal_mode = WAL');
// A webhook must not be acknowledged on a non-durable SQLite commit.
if (config.storeMode === 'live') db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/** Run schema.sql (idempotent). */
function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
  require('./upgrades').applyUpgrades(db);
  require('./pointgh').applyPointghUpdate(db);
  require('./commerce').applyCommerceUpgrade(db);
}

migrate();

module.exports = db;
