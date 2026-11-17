'use strict';

/** Additive upgrade only: never reprice historical orders or move their stock. */
function applyCommerceUpgrade(db) {
  const name = 'commerce.verified-payments.v1';
  db.transaction(() => {
    if (db.prepare('SELECT name FROM app_migrations WHERE name = ?').get(name)) return;
    const add = (table, column, definition) => {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    };
    add('orders', 'stock_state', "TEXT NOT NULL DEFAULT 'none' CHECK (stock_state IN ('none','allocated','released'))");
    add('orders', 'sold_recorded', 'INTEGER NOT NULL DEFAULT 0 CHECK (sold_recorded IN (0,1))');
    add('orders', 'stock_held_until', 'TEXT');
    add('payments', 'provider_mode', 'TEXT');
    add('payments', 'authorization_url', 'TEXT');
    add('payments', 'initialized_at', 'TEXT');
    add('payments', 'verified_at', 'TEXT');
    add('payments', 'needs_review', 'INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0,1))');
    // Older code allocated paid orders and COD orders at different stages.
    // Record that fact without decrementing/releasing any historical inventory.
    db.exec(`UPDATE orders SET stock_state = CASE
      WHEN status IN ('cancelled','refunded') THEN 'released'
      WHEN payment_status IN ('paid','partially_refunded') OR payment_method = 'cod' THEN 'allocated'
      ELSE 'none' END,
      sold_recorded = CASE WHEN payment_status IN ('paid','partially_refunded','refunded') THEN 1 ELSE 0 END;`);
    db.prepare('INSERT INTO app_migrations (name) VALUES (?)').run(name);
  })();
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_receipt
    ON payments(gateway, provider_mode, gateway_ref)
    WHERE gateway = 'paystack' AND gateway_ref IS NOT NULL`);
}

module.exports = { applyCommerceUpgrade };
