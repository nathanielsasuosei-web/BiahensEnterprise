'use strict';
const bcrypt = require('bcryptjs');
const { isGhanaPhone, normalizePhone } = require('../utils/phone');

function ensureOwner(db, config) {
  const owner = db.prepare("SELECT id FROM users WHERE role = 'owner' AND is_blocked = 0 ORDER BY id LIMIT 1").get();
  if (owner) return { created: false };
  const values = config.owner;
  if (config.storeMode === 'live' && (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(values.email)
      || !isGhanaPhone(values.phone) || values.password.trim().length < 16
      || ['Biahens@2026', 'Staff@2026', 'Customer@2026'].includes(values.password))) {
    throw new Error('First live startup requires OWNER_EMAIL, OWNER_PHONE and a unique OWNER_PASSWORD of at least 16 characters in hosting secrets. Existing accounts are never reset automatically.');
  }
  // Never promote an existing public customer merely because an environment
  // variable names their email address.
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(values.email)) {
    throw new Error('Owner bootstrap email is already in use. Resolve the account safely before starting; it will not be promoted automatically.');
  }
  const info = db.prepare(`INSERT INTO users (name,email,phone,password_hash,role,email_verified)
    VALUES (?,?,?,?,'owner',1)`).run(values.name, values.email, normalizePhone(values.phone), bcrypt.hashSync(values.password, 12));
  return { created: true, id: Number(info.lastInsertRowid) };
}

function assertNoDemoAccounts(db, config) {
  if (config.storeMode !== 'live') return;
  const demo = db.prepare("SELECT name FROM app_migrations WHERE name = 'dataset.demo.v1'").get();
  const legacySeed = db.prepare("SELECT id FROM audit_log WHERE json_valid(meta) AND json_extract(meta, '$.seeded') = 1 LIMIT 1").get();
  const simulated = db.prepare("SELECT id FROM payments WHERE gateway IN ('biahens-stub','simulator') OR provider_mode = 'test' LIMIT 1").get();
  if (demo || legacySeed || simulated) throw new Error('This database contains the demo dataset. Use a fresh persistent database for the real store; do not import sample customers, orders or payments.');
  // Check privileged credentials, not every customer on every boot (which
  // would turn password hashing into an O(customer-count) startup outage).
  for (const user of db.prepare("SELECT password_hash FROM users WHERE is_blocked = 0 AND role IN ('owner','staff')").all()) {
    if (['Biahens@2026', 'Staff@2026', 'Customer@2026'].some(password => bcrypt.compareSync(password, user.password_hash))) {
      throw new Error('An active account still has a published demo password. Remove demo data or rotate every affected credential before live startup.');
    }
  }
}

module.exports = { ensureOwner, assertNoDemoAccounts };
