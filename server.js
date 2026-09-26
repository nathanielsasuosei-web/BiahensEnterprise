'use strict';
const app = require('./src/app');
const config = require('./src/config');
const settings = require('./src/services/settings');
const db = require('./src/db');

const server = app.listen(config.port, config.host, () => {
  const products = db.prepare(`SELECT COUNT(*) AS n FROM products WHERE is_active = 1 AND status = 'active'`).get().n;
  const owner = db.prepare(`SELECT email FROM users WHERE role = 'owner' LIMIT 1`).get();

  console.log('\n┌──────────────────────────────────────────────────────────────┐');
  console.log(`│  ${settings.get('store_name').padEnd(58)} │`);
  console.log('│  Biahens Enterprise — e-commerce platform (Express + EJS)    │');
  console.log('└──────────────────────────────────────────────────────────────┘');
  console.log(`   ▸ Listening   http://${config.host}:${config.port}   (${config.env})`);
  console.log(`   ▸ Database    ${config.db.file}`);
  console.log(`   ▸ Catalogue   ${products} live products`);
  console.log(`   ▸ Storefront  ${config.publicUrl}`);
  console.log(`   ▸ Admin       ${config.publicUrl}/admin/login`);
  console.log(`   ▸ Owner       ${owner ? owner.email : config.owner.email}  (products can only be uploaded by the owner)`);
  console.log(`   ▸ Gateway     ${settings.get('gateway_brand')} — mode: ${settings.get('gateway_mode')}`);
  console.log(`   ▸ Webhook     POST ${config.publicUrl}/webhooks/paystack  (HMAC SHA-512 verified)\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n✖  Port ${config.port} is already in use. Set PORT=something-else and retry.\n`);
    process.exit(1);
  }
  throw err;
});

process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

module.exports = server;
