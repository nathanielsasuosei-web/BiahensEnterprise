'use strict';

/** One-time store rename and VAT setup; never reprice existing orders. */
function applyPointghUpdate(db) {
  const migration = 'store.pointgh-vat.v1';
  db.transaction(() => {
    if (db.prepare('SELECT name FROM app_migrations WHERE name = ?').get(migration)) return;

    const columns = db.prepare('PRAGMA table_info(orders)').all();
    if (!columns.some(column => column.name === 'tax_rate')) {
      // NULL means the historical rate was not recorded. Do not guess it from
      // today's settings or apply the new charge to an existing order.
      db.exec('ALTER TABLE orders ADD COLUMN tax_rate REAL CHECK (tax_rate IS NULL OR (tax_rate >= 0 AND tax_rate <= 100))');
    }

    const upsert = db.prepare(`INSERT INTO settings (key, value, grp, type, label, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    upsert.run('store_name', 'POINTGH', 'identity', 'text', 'store_name');
    upsert.run('store_short', 'POINTGH', 'identity', 'text', 'store_short');
    upsert.run('tax_rate', '1', 'commerce', 'number', 'VAT (%)');

    // Update just the old brand spelling, keeping owner-written copy, URLs,
    // contact addresses, product prices, stock and all order history intact.
    const rebrand = value => typeof value === 'string' ? value.replace(/\bpointgh\b/gi, 'POINTGH') : value;
    const updateSetting = db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?");
    for (const row of db.prepare("SELECT key, value FROM settings WHERE key IN ('meta_title','meta_description','meta_keywords','gateway_brand')").all()) {
      const value = rebrand(row.value);
      if (value !== row.value) updateSetting.run(value, row.key);
    }
    for (const [table, fields] of [
      ['brands', ['name', 'tagline']],
      ['categories', ['description']],
      ['products', ['short_description', 'description', 'meta_title', 'meta_description']],
    ]) {
      for (const field of fields) {
        const update = db.prepare(`UPDATE ${table} SET ${field} = ? WHERE id = ?`);
        for (const row of db.prepare(`SELECT id, ${field} AS value FROM ${table} WHERE ${field} LIKE '%pointgh%'`).all()) {
          const value = rebrand(row.value);
          if (value !== row.value) update.run(value, row.id);
        }
      }
    }
    db.prepare('INSERT INTO app_migrations (name) VALUES (?)').run(migration);
  })();
}

module.exports = { applyPointghUpdate };
