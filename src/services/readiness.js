'use strict';
const fs = require('node:fs');
const { configurationErrors, inside } = require('../config/production');

/** Local checks only: do not charge, send a message, or claim remote approval. */
function report(db, config = require('../config')) {
  const configuration = configurationErrors(config);
  const checks = [];
  checks.push({ name: 'Live environment configuration', ok: config.storeMode === 'live' && configuration.length === 0,
    detail: config.storeMode === 'live' ? configuration.length ? configuration.join(' ') : 'Required values configured; provider accounts have not been validated by this check.' : 'Demo mode. Not a live store.' });
  checks.push({ name: 'Persistent disk paths', ok: !!config.storage.persistent && !config.ephemeralFs
      && inside(config.storage.dataDir, config.db.file) && inside(config.storage.dataDir, config.uploads.dir),
    detail: 'The host must attach a persistent disk at DATA_DIR. A writable directory alone does not prove durability.' });
  try {
    const good = db.pragma('quick_check', { simple: true }) === 'ok';
    checks.push({ name: 'SQLite integrity', ok: good, detail: good ? 'SQLite quick_check passed.' : 'SQLite integrity check did not pass.' });
    const owner = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND is_blocked = 0").get().n;
    checks.push({ name: 'Owner account', ok: owner > 0, detail: owner ? 'An active owner account exists.' : 'No active owner account. Set bootstrap credentials in hosting secrets before first startup.' });
    const verified = db.prepare("SELECT MAX(verified_at) AS at FROM payments WHERE gateway = 'paystack' AND provider_mode = 'live' AND verified_at IS NOT NULL AND status = 'success'").get();
    checks.push({ name: 'Paystack live verification', ok: !!verified.at, detail: verified.at ? `Most recent server-verified live receipt: ${verified.at}. Match against your provider settlement report.` : 'No server-verified live payment recorded. An authorized real transaction and dashboard check are still required.' });
    const review = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE needs_review = 1').get().n;
    checks.push({ name: 'Payment reconciliation', ok: review === 0, detail: review ? `${review} captured payment(s) require owner review. No automatic refund has been sent.` : 'No captured payments flagged for review. Confirm settlement against Paystack separately.' });
    const accepted = db.prepare("SELECT channel, MAX(sent_at) AS at FROM notification_outbox WHERE status = 'sent' GROUP BY channel").all();
    for (const channel of ['email', 'whatsapp']) {
      const previous = accepted.find(row => row.channel === channel);
      checks.push({ name: `${channel === 'email' ? 'Email' : 'WhatsApp'} provider acceptance`, ok: !!previous,
        detail: previous ? `Most recent provider acceptance: ${previous.at}. This is not delivery/read confirmation.` : 'No provider-accepted message recorded. Use an explicitly authorized verification send and check the recipient device.' });
    }
  } catch (_) { checks.push({ name: 'Database schema', ok: false, detail: 'Database is missing, unreadable, or has not been initialized by this version.' }); }
  const latest = (() => {
    try {
      return fs.readdirSync(config.backups.dir).filter(name => /^pointgh-.*\.sqlite$/.test(name)).sort().pop();
    } catch (_) { return null; }
  })();
  checks.push({ name: 'Local database backup', ok: !!latest, detail: latest ? `${latest}. Copy backups and uploaded files off-server; a same-disk backup is not disaster recovery.` : 'No scheduled SQLite backup found. Off-server database and upload backups are also required.' });
  return { live: config.storeMode === 'live', configured: configuration.length === 0, ready: checks.every(check => check.ok), checks };
}
module.exports = { report };
