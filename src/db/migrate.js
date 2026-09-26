'use strict';
/**
 * Creates (or upgrades) the database schema and makes sure the owner account
 * and default settings exist. Safe to run repeatedly — schema.sql uses
 * CREATE TABLE IF NOT EXISTS and the owner upsert is idempotent.
 *
 *   npm run db:init
 */
const db = require('./index');
const settings = require('../services/settings');
const bcrypt = require('bcryptjs');
const config = require('../config');

settings.ensureDefaults();

const owner = db.prepare(`SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1`).get();
if (!owner) {
  db.prepare(
    `INSERT INTO users (name, email, phone, password_hash, role, email_verified)
     VALUES (?,?,?,?,?,1)`
  ).run(
    config.owner.name,
    config.owner.email,
    config.owner.phone,
    bcrypt.hashSync(config.owner.password, 10),
    'owner'
  );
  console.log(`✔  Owner account created → ${config.owner.email}`);
} else {
  console.log('✔  Schema up to date, owner account present.');
}

const tables = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'`).get().n;
console.log(`✔  ${tables} tables ready in ${config.db.file}`);

if (require.main === module) process.exit(0);
module.exports = {};
