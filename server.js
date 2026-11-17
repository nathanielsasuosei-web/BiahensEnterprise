'use strict';
const app = require('./src/app'); // validates live config before opening the DB
const config = require('./src/config');
const settings = require('./src/services/settings');
const db = require('./src/db');
const notifications = require('./src/services/notifications');
const payments = require('./src/services/payments');
const orders = require('./src/services/orders');
const backups = require('./src/services/backups');
const jobs = new Set();
let stopping = false;
function job(work, label) {
  if (stopping) return;
  const pending = Promise.resolve().then(work).catch(() => console.error(`[${label}] Failed; inspect the owner delivery log or system health.`));
  jobs.add(pending);
  pending.finally(() => jobs.delete(pending));
}
const workers = [
  setInterval(() => job(() => notifications.flush(), 'delivery'), 30000),
  setInterval(() => job(() => orders.expirePaymentHolds(), 'stock holds'), 30000),
  setInterval(() => job(() => backups.scheduled(), 'backup'), 3600000),
];
workers.forEach(worker => worker.unref());

const server = app.listen(config.port, config.host, () => {
  const products = db.prepare("SELECT COUNT(*) AS n FROM products WHERE is_active = 1 AND status = 'active'").get().n;
  console.log(`\n${settings.get('store_name')} — ${config.storeMode === 'live' ? 'LIVE STORE' : 'DEMO / NO REAL PAYMENTS'}`);
  console.log(`Listening: http://${config.host}:${config.port} (${config.env})`);
  console.log(`Storefront: ${config.publicUrl} · ${products} active products`);
  console.log(`Admin: ${config.publicUrl}/admin/login`);
  console.log(`Storage: ${config.storage.persistent ? 'configured persistent disk — verify host attachment' : 'development/demo filesystem'}`);
  console.log(`Payments: ${payments.brand()} · ${payments.mode()}`);
  console.log(`Webhook: ${config.publicUrl}/webhooks/paystack`);
  console.log('Provider configuration is not proof of payment, message delivery, settlement or off-server backup.\n');
  job(() => notifications.flush(), 'delivery');
  job(() => orders.expirePaymentHolds(), 'stock holds');
  job(() => backups.scheduled(), 'backup');
});
server.on('error', error => {
  if (error.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use.`);
  else console.error('Server could not start:', error.code || 'unknown error');
  process.exitCode = 1;
  workers.forEach(clearInterval);
});
async function shutdown() {
  if (stopping) return;
  stopping = true;
  workers.forEach(clearInterval);
  const force = setTimeout(() => process.exit(1), 25000);
  force.unref();
  await new Promise(resolve => server.close(resolve));
  await Promise.allSettled([...jobs]);
  try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch (_) { /* shutdown only */ }
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', () => console.error('Unhandled background error. Check system health; no provider success has been assumed.'));
module.exports = server;
