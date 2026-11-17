'use strict';
const fs = require('node:fs');
const Database = require('better-sqlite3');
const config = require('../src/config');
const { configurationErrors } = require('../src/config/production');
const errors = configurationErrors(config);
for (const error of errors) console.error(`NOT READY: ${error}`);
let db;
try {
  if (!fs.existsSync(config.db.file)) throw new Error();
  // A readiness check must not initialize, seed or modify the database.
  db = new Database(config.db.file, { readonly: true, fileMustExist: true });
  const result = require('../src/services/readiness').report(db, config);
  for (const check of result.checks) console.log(`${check.ok ? 'OK' : 'NOT VERIFIED'}: ${check.name} — ${check.detail}`);
  process.exitCode = errors.length || !result.ready ? 1 : 0;
} catch (_) {
  console.error('NOT READY: Database is unavailable or not initialized. Start the persistent server with valid private configuration first.');
  process.exitCode = 1;
} finally { if (db) db.close(); }
console.log('This check makes no provider requests and never proves final message delivery, settlement, disk attachment, or off-server backup.');
