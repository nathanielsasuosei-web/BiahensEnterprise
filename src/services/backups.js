'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const config = require('../config');
const db = require('../db');
let running;
const backupName = /^pointgh-\d{8}T\d{9}Z-[a-f0-9]{8}\.sqlite$/;

function list() {
  try {
    return fs.readdirSync(config.backups.dir).filter(name => backupName.test(name)).sort().reverse()
      .map(name => ({ name, file: path.join(config.backups.dir, name), size: fs.statSync(path.join(config.backups.dir, name)).size }));
  } catch (_) { return []; }
}
async function create() {
  if (running) return running;
  running = (async () => {
    fs.mkdirSync(config.backups.dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:.]/g, '');
    const name = `pointgh-${stamp}-${crypto.randomBytes(4).toString('hex')}.sqlite`;
    const file = path.join(config.backups.dir, name);
    const partial = `${file}.partial`;
    try {
      // SQLite's online backup API includes committed WAL contents and does not
      // freeze checkout with a VACUUM or copy a live, inconsistent DB file.
      await db.backup(partial);
      fs.chmodSync(partial, 0o600);
      const check = new Database(partial, { readonly: true, fileMustExist: true });
      try {
        if (check.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Database backup integrity check failed.');
      } finally { check.close(); }
      fs.renameSync(partial, file);
      for (const stale of list().slice(config.backups.keep)) fs.unlinkSync(stale.file);
      return { name, file, size: fs.statSync(file).size };
    } catch (error) {
      try { fs.unlinkSync(partial); } catch (_) { /* no partial backup */ }
      throw error;
    }
  })();
  try { return await running; } finally { running = null; }
}
async function scheduled() {
  if (config.storeMode !== 'live') return null;
  const latest = list()[0];
  if (latest && Date.now() - fs.statSync(latest.file).mtimeMs < config.backups.intervalHours * 3600000) return null;
  return create();
}
module.exports = { create, list, scheduled };
