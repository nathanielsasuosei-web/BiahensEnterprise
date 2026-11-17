'use strict';
/**
 * Vercel (and other serverless) build step.
 *
 * The runtime filesystem is read-only except /tmp, so we bake a fully seeded
 * SQLite database into ./data at BUILD time. vercel.json includes `data/**`
 * in the function bundle and src/db/bootstrap.js copies it into /tmp on the
 * first request of each cold instance.
 *
 *   npm run vercel:build
 */
if (process.env.STORE_MODE && process.env.STORE_MODE !== 'demo') throw new Error('Vercel builds are demo-only. Deploy the live store on a persistent server.');
process.env.STORE_MODE = 'demo';
process.env.PAYMENT_PROVIDER = process.env.PAYMENT_PROVIDER || 'simulator';
process.env.BIAHENS_BUILD = '1';           // keep ./data paths instead of /tmp
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.BIAHENS_QUIET = process.env.BIAHENS_QUIET || '';

const fs = require('fs');
const path = require('path');
const config = require('../src/config');

const t0 = Date.now();
require('../src/config/production').assertRuntime(config);
if (fs.existsSync(config.db.file)) {
  throw new Error('Refusing to overwrite an existing database during a demo build. Set DB_FILE to a new isolated build path, or remove only a disposable build database yourself.');
}

fs.mkdirSync(path.dirname(config.db.file), { recursive: true });
fs.mkdirSync(config.uploads.dir, { recursive: true });

// Fresh, deterministic demo dataset every build.
const db = require('../src/db');                       // creates the schema
require('../src/db/seed').main({ fresh: true });
// The cold-start bootstrap copies only the main database, not a WAL sidecar.
// Checkpoint and close before Vercel packages that file into the function.
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();

const size = fs.existsSync(config.db.file)
  ? (fs.statSync(config.db.file).size / 1024).toFixed(0)
  : '0';

console.log(`\n✔  vercel:build — baked database ${path.relative(config.root, config.db.file)} (${size} KB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('   It is copied into /tmp on each cold start by src/db/bootstrap.js.\n');
