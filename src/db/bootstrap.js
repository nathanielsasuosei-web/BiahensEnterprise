'use strict';
/**
 * Runtime data bootstrap.
 *
 * On a normal server the SQLite file lives in ./data and persists between
 * restarts, so there is nothing to do. On serverless platforms (Vercel,
 * Lambda, Netlify) the deployed bundle is READ-ONLY and only /tmp is
 * writable — and /tmp is wiped whenever the instance recycles.
 *
 * Strategy:
 *   1. `npm run vercel:build` creates a fully seeded ./data/biahens.sqlite
 *      at build time and it is bundled with the function (see vercel.json
 *      → functions.includeFiles).
 *   2. On the first request of a cold instance we copy that baked file into
 *      /tmp (~milliseconds) and open it from there.
 *   3. If no baked file is present we create the schema and seed in-process
 *      so the deployment still boots with a working store.
 *
 * Writes made at runtime survive only as long as the instance lives — see
 * README → "Deploying" for the persistence options.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

let done = false;

function log(...args) {
  if (!process.env.BIAHENS_QUIET) console.log('[biahens]', ...args);
}

function ensureWritableDb() {
  if (!config.ephemeralFs) return { restored: false, seeded: false };

  const target = config.db.file;                 // /tmp/biahens.sqlite
  fs.mkdirSync(path.dirname(target), { recursive: true });

  let restored = false;
  if (!fs.existsSync(target) && fs.existsSync(config.db.baked)) {
    try {
      fs.copyFileSync(config.db.baked, config.db.file);
      restored = true;
      log(`restored baked database → ${target}`);
    } catch (err) {
      log(`could not copy baked database (${err.message}) — will seed instead`);
    }
  }
  // copyFile preserves the baked artifact's permission bits. A deployment
  // bundle may be read-only, but the restored database must allow sessions,
  // carts and SQLite WAL writes in the writable runtime directory.
  if (fs.existsSync(target)) fs.chmodSync(target, 0o600);
  return { restored, seeded: false };
}

/** Called once from src/app.js before any route handles a request. */
function bootstrap() {
  if (done) return require('./index');
  require('../config/production').assertRuntime(config);

  ensureWritableDb();

  // Opening the database runs schema.sql (idempotent).
  const db = require('./index');

  if (config.db.autoSeed) {
    try {
      const products = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
      if (!products) {
        const t0 = Date.now();
        require('./seed').main({ quiet: false });
        log(`seeded demo catalogue in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${db.file || config.db.file}`);
      }
    } catch (err) {
      log(`auto-seed failed: ${err.message}`);
    }
  }

  if (config.storeMode === 'live') {
    require('./owner').assertNoDemoAccounts(db, config);
    require('../services/settings').ensureDefaults();
    require('./owner').ensureOwner(db, config);
  }
  require('./departments').ensureDepartments(db);

  fs.mkdirSync(config.uploads.dir, { recursive: true });
  done = true;
  return db;
}

module.exports = { bootstrap, ensureWritableDb };
