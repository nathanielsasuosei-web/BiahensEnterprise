'use strict';
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { isGhanaPhone, normalizePhone } = require('../utils/phone');
const { createFromEnvironment } = require('./neon');

/**
 * Executes the PostgreSQL schema and bootstrap on Neon.
 * Safe and idempotent: can be run on boot or during CI/CD.
 */
async function migrateNeon(db, config) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('A Neon database instance is required.');
  }

  // 1. Run schema DDL
  const sql = fs.readFileSync(path.join(__dirname, 'schema.pg.sql'), 'utf8');
  await db.query(sql);

  // 2. Mark foundational migrations
  const baselineMigrations = [
    'schema.pg.v1',
    'orders.public-events.v1',
    'store.pointgh-vat.v1',
    'commerce.verified-payments.v1',
  ];
  for (const name of baselineMigrations) {
    await db.query(
      `INSERT INTO app_migrations (name, applied_at)
       VALUES ($1, NOW())
       ON CONFLICT (name) DO NOTHING`,
      [name]
    );
  }

  // 3. Ensure baseline store settings
  const defaultSettings = [
    ['store_name', 'POINTGH', 'identity', 'text', 'store_name'],
    ['store_short', 'POINTGH', 'identity', 'text', 'store_short'],
    ['tax_rate', '1', 'commerce', 'number', 'VAT (%)'],
    ['currency', 'GHS', 'commerce', 'text', 'Currency'],
  ];
  for (const [key, value, grp, type, label] of defaultSettings) {
    await db.query(
      `INSERT INTO settings (key, value, grp, type, label, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value, grp, type, label]
    );
  }

  // 4. Ensure owner account if configured
  if (config && config.owner) {
    const existingOwner = await db.get("SELECT id FROM users WHERE role = 'owner' AND is_blocked = 0 ORDER BY id LIMIT 1");
    if (!existingOwner) {
      const { name, email, phone, password } = config.owner;
      if (email && password) {
        const existingEmail = await db.get('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (!existingEmail) {
          const normPhone = phone ? normalizePhone(phone) : null;
          const hash = bcrypt.hashSync(password, 12);
          await db.query(
            `INSERT INTO users (name, email, phone, password_hash, role, email_verified, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'owner', 1, NOW(), NOW())`,
            [name || 'Owner', email, normPhone, hash]
          );
        }
      }
    }
  }

  return { ok: true };
}

async function main() {
  const config = require('../config');
  const db = createFromEnvironment(process.env);
  try {
    console.log('Running Neon PostgreSQL migrations...');
    await migrateNeon(db, config);
    console.log('✔ Neon database schema and baseline configuration ready.');
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Neon migration failed:', err);
    process.exit(1);
  });
}

module.exports = { migrateNeon };
