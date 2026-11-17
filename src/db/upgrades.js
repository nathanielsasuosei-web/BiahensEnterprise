'use strict';

/** Additive schema upgrades for databases created by older versions. */
function applyUpgrades(db) {
  const migration = 'orders.public-events.v1';
  db.transaction(() => {
    if (db.prepare('SELECT name FROM app_migrations WHERE name = ?').get(migration)) return;
    const columns = db.prepare('PRAGMA table_info(order_events)').all();
    if (!columns.some(column => column.name === 'is_public')) {
      db.exec('ALTER TABLE order_events ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0,1))');
    }
    // Older admin timeline notes had no visibility flag. Fail closed: keep them
    // for the owner, and only expose known automated/customer events or bare
    // status changes. Never guess that a free-form admin note is customer-safe.
    db.prepare(`UPDATE order_events SET is_public = 1
      WHERE actor IN ('system','customer','gateway') OR note IS NULL OR trim(note) = ''`).run();
    db.prepare('INSERT INTO app_migrations (name) VALUES (?)').run(migration);
  })();
}

module.exports = { applyUpgrades };
