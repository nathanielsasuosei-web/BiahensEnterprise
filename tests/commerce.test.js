'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pointgh-commerce-'));
Object.assign(process.env, {
  NODE_ENV: 'test', STORE_MODE: 'demo', PAYMENT_PROVIDER: 'simulator', GATEWAY_MODE: '', PAYSTACK_SECRET_KEY: '', NOTIFICATIONS_ENABLED: 'true', DB_FILE: path.join(temporary, 'store.sqlite'), UPLOADS_DIR: path.join(temporary, 'uploads'),
  SEED_ON_BOOT: 'true', BIAHENS_QUIET: '1', RESEND_API_KEY: '', MAIL_FROM: '',
  WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', WHATSAPP_ORDER_TEMPLATE: '', WHATSAPP_OWNER_OPT_IN: 'false',
  OWNER_NOTIFICATION_EMAIL: '', OWNER_NOTIFICATION_WHATSAPP: '', NOTIFICATION_CRON_SECRET: '',
});
let db, catalog, orders, delivery, config, settings, server, base, alice, bob, aliceId, order;
const form = body => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
function client() {
  let cookie = '';
  return async (route, options = {}) => {
    const response = await fetch(base + route, { ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...options.headers }, redirect: 'manual' });
    const next = response.headers.get('set-cookie');
    if (next) cookie = next.split(';')[0];
    return response;
  };
}
function registration(email, extra = {}) {
  return { name: 'Commerce Test', email, phone: '+233 24 123 4567', password: 'Storefront@2026', confirm_password: 'Storefront@2026', terms: '1', ...extra };
}
async function signUp(email) {
  const request = client();
  assert.equal((await request('/register', form(registration(email)))).status, 302);
  return request;
}
async function checkout(request, method = 'cod') {
  const product = catalog.queryProducts({ q: 'Structured Tote' }).items[0];
  assert.equal((await request('/api/cart/add', json({ product_id: product.id, qty: 1 }))).status, 200);
  assert.equal((await request('/checkout')).status, 200);
  assert.equal((await request('/checkout/address', form({ name: 'Account Customer', phone: '0241234567', email: 'alice@example.test', region: 'Greater Accra', city: 'Accra', line: '12 Example Street' }))).status, 200);
  assert.equal((await request('/checkout/delivery', form({ method: 'standard' }))).status, 200);
  assert.equal((await request('/checkout/payment', form({ method }))).status, 200);
  return request('/checkout/place', form({ terms: '1', user_id: '999999', guest_name: 'Do not use this' }));
}

before(async () => {
  require('../src/db/migrate');
  const app = require('../src/app');
  db = require('../src/db'); catalog = require('../src/services/catalog'); orders = require('../src/services/orders');
  delivery = require('../src/services/notifications'); config = require('../src/config'); settings = require('../src/services/settings');
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}`;
  alice = await signUp('alice@example.test');
  bob = await signUp('bob@example.test');
  aliceId = db.prepare('SELECT id FROM users WHERE email = ?').get('alice@example.test').id;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (db) db.close();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('all checkout routes reject guests, including crafted direct POST requests', async () => {
  const request = client();
  const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  for (const route of ['/checkout', '/checkout?step=4', '/checkout/back/4']) {
    const response = await request(route);
    assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/login');
  }
  for (const route of ['/checkout/address', '/checkout/delivery', '/checkout/payment', '/checkout/place']) {
    const response = await request(route, form({ terms: '1', name: 'Guest', phone: '0241234567' }));
    assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/login');
  }
  const api = await request('/checkout/place', json({ terms: '1' }));
  assert.equal(api.status, 401);
  assert.equal((await api.json()).loginUrl, '/login');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, beforeCount);
  assert.match(await (await request('/login')).text(), /returned to <b>\/checkout/);
  assert.equal(orders.createFromCart({ user: null }, { shipping: {}, payment: {}, delivery: {} }).code, 'AUTH_REQUIRED');
});

test('phone number is compulsory in registration HTML and server validation, and cannot be removed later', async () => {
  const request = client();
  const html = await (await request('/register')).text();
  assert.match(html, /id="phone"[^>]*required/);
  for (const phone of ['', '123', '+233000000000', 'not-a-phone']) {
    const response = await request('/register', form(registration('invalid-phone@example.test', { phone })));
    assert.equal(response.status, 400);
    assert.match(await response.text(), /valid phone number is required/);
  }
  assert.equal(db.prepare('SELECT id FROM users WHERE email = ?').get('invalid-phone@example.test'), undefined);
  assert.equal(db.prepare('SELECT phone FROM users WHERE id = ?').get(aliceId).phone, '+233241234567');
  const response = await alice('/account/profile', form({ name: 'Commerce Test', email: 'alice@example.test', phone: '' }));
  assert.equal(response.status, 400);
  assert.equal(db.prepare('SELECT phone FROM users WHERE id = ?').get(aliceId).phone, '+233241234567');
});

test('guest bag survives signup and returns the new customer to checkout', async () => {
  const request = client();
  const product = catalog.queryProducts({ q: 'Structured Tote' }).items[0];
  await request('/api/cart/add', json({ product_id: product.id }));
  assert.equal((await request('/checkout')).headers.get('location'), '/login');
  const response = await request('/register', form(registration('bag-customer@example.test', { phone: '0501234567' })));
  assert.equal(response.headers.get('location'), '/checkout');
  const account = db.prepare('SELECT * FROM users WHERE email = ?').get('bag-customer@example.test');
  assert.equal(account.role, 'customer');
  assert.equal(db.prepare('SELECT qty FROM cart_items WHERE user_id = ?').get(account.id).qty, 1);
  assert.equal((await request('/checkout')).status, 200);
  const page = await (await request('/checkout')).text();
  assert.ok(!page.includes('Guest checkout'));
  assert.ok(page.includes('automatically in your account'));
});

test('legacy accounts without a phone must complete their profile before checkout', async () => {
  const request = await signUp('legacy-phone@example.test');
  const id = db.prepare('SELECT id FROM users WHERE email = ?').get('legacy-phone@example.test').id;
  db.prepare('UPDATE users SET phone = NULL WHERE id = ?').run(id);
  assert.equal((await request('/checkout')).headers.get('location'), '/account/profile');
  assert.equal((await request('/checkout/place', json({ terms: '1' }))).status, 403);
  assert.equal(orders.createFromCart({ user: { id, phone: null } }, { shipping: {}, payment: {}, delivery: {} }).code, 'PHONE_REQUIRED');
  const response = await request('/account/profile', form({ name: 'Legacy Customer', email: 'legacy-phone@example.test', phone: '0241234567' }));
  assert.equal(response.headers.get('location'), '/checkout');
});

test('a signed-in order belongs to the account and atomically queues both owner alerts', async () => {
  const response = await checkout(alice);
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^\/order\/.+\?placed=1$/);
  order = orders.getOrderByNumber(response.headers.get('location').split('/')[2].split('?')[0]);
  assert.equal(order.user_id, aliceId);
  assert.equal(order.guest_name, null);
  assert.equal(order.guest_email, null);
  assert.equal(order.status, 'processing');
  const alerts = db.prepare('SELECT * FROM notification_outbox WHERE order_id = ? ORDER BY channel').all(order.id);
  assert.deepEqual(alerts.map(row => row.channel), ['email', 'whatsapp']);
  assert.ok(alerts.every(row => row.status === 'unconfigured' && row.attempts === 0));
  assert.ok(alerts.every(row => row.text.includes(order.order_number) && row.text.includes('not paid yet')));
  delivery.queueOwnerOrder(order.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_outbox WHERE order_id = ?').get(order.id).n, 2);
  assert.ok(db.prepare('SELECT id FROM notifications WHERE title = ?').get(`New order ${order.order_number}`));
});

test('tracking is automatic for the account and never leaks another customer’s orders, receipts or updates', async () => {
  const number = order.order_number;
  const guest = client();
  for (const route of ['/track-order', `/order/${number}`, `/order/${number}/receipt`, `/account/orders/${number}/receipt`]) {
    const response = await guest(route);
    assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/login');
  }
  assert.equal((await guest(`/api/orders/${number}/tracking`)).status, 401);
  const html = await (await alice('/track-order')).text();
  assert.ok(html.includes(`data-order-tracker="${number}"`));
  assert.ok(!html.includes('name="contact"'));
  assert.ok(html.includes('automatically every 20 seconds'));
  assert.equal((await alice(`/order/${number}/receipt`)).status, 200);
  for (const route of [`/track-order?order=${number}`, `/order/${number}`, `/order/${number}/receipt`, `/account/orders/${number}`, `/api/orders/${number}/tracking`]) assert.equal((await bob(route)).status, 404, route);
  const response = await alice(`/api/orders/${number}/tracking`);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const snapshot = (await response.json()).order;
  assert.equal(snapshot.order_number, number);
  for (const privateField of ['ship_line', 'ship_phone', 'ship_email', 'admin_notes', 'payments', 'guest_email']) assert.ok(!(privateField in snapshot), privateField);
  orders.updateOrder(order.id, { admin_notes: 'Private fulfilment instructions.' });
  orders.addEvent(order.id, order.status, 'Internal customer risk assessment.', 'Test Owner (admin)');
  for (const route of [`/track-order?order=${number}`, `/order/${number}`, `/account/orders/${number}`, `/api/orders/${number}/tracking`]) {
    const text = await (await alice(route)).text();
    assert.ok(!text.includes('Private fulfilment instructions.'), route);
    assert.ok(!text.includes('Internal customer risk assessment.'), route);
  }
  orders.updateOrder(order.id, { carrier: 'Test Carrier', tracking_number: 'TEST-TRACK-123' });
  orders.setStatus(order.id, 'shipped', { note: 'Handed to the rider.' });
  const updated = (await (await alice(`/api/orders/${number}/tracking`)).json()).order;
  assert.equal(updated.status, 'shipped');
  assert.equal(updated.tracking_number, 'TEST-TRACK-123');
  assert.ok(updated.events.some(event => event.note === 'Handed to the rider.'));
});

test('hosted payments require login and order ownership while signed gateway webhooks stay independent', async () => {
  const response = await checkout(alice, 'momo');
  const route = response.headers.get('location');
  assert.match(route, /^\/pay\//);
  const guest = client();
  assert.equal((await guest(route)).headers.get('location'), '/login');
  assert.equal((await guest(route, json({ simulate: 'success' }))).status, 401);
  assert.equal((await bob(route)).status, 404);
  assert.equal((await bob(`${route}/cancel`, form({}))).status, 404);
  assert.equal((await alice(route)).status, 200);
  const badWebhook = await guest('/webhooks/paystack', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': 'bad' }, body: '{}' });
  assert.equal(badWebhook.status, 401);
  assert.equal((await guest('/admin/api/webhooks/test', json({ reference: 'not-real' }))).status, 401);
});

test('existing customers can sign in to continue checkout without losing a guest bag', async () => {
  const request = client();
  const product = catalog.queryProducts({ q: 'Structured Tote' }).items[0];
  await request('/api/cart/add', json({ product_id: product.id }));
  await request('/checkout');
  const response = await request('/login', form({ email: 'bob@example.test', password: 'Storefront@2026' }));
  assert.equal(response.headers.get('location'), '/checkout');
  assert.equal((await request('/checkout')).status, 200);
  assert.match(await (await request('/cart')).text(), /Structured Tote/);
});

test('live mode disables local authorization and every signed-webhook test helper', async () => {
  const original = settings.get('gateway_mode');
  settings.set('gateway_mode', 'live');
  try {
    const payment = db.prepare("SELECT p.reference FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.user_id = ? LIMIT 1").get(aliceId);
    assert.equal((await alice(`/pay/${payment.reference}/simulate-webhook`, form({}))).status, 403);
    assert.equal(require('../src/services/payments').authorize(payment.reference, { channel: 'bank', bank: {} }).ok, false);
    const owner = client();
    await owner('/admin/login', form({ email: 'owner@biahensenterprise.com', password: 'Biahens@2026' }));
    assert.equal((await owner('/admin/api/webhooks/test', json({ reference: payment.reference }))).status, 403);
  } finally { settings.set('gateway_mode', original); }
});

test('properly signed payment webhooks work without a customer session and remain idempotent', async () => {
  const payments = require('../src/services/payments');
  const payment = db.prepare('SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.user_id = ? LIMIT 1').get(aliceId);
  const target = orders.getOrder(payment.order_id);
  const productId = target.items[0].product_id;
  const stock = db.prepare('SELECT stock FROM products WHERE id = ?').get(productId).stock;
  const payload = payments.buildWebhookPayload(payment);
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': payments.signPayload(payload) }, body: JSON.stringify(payload) };
  const guest = client();
  assert.equal((await guest('/webhooks/paystack', options)).status, 200);
  assert.equal(orders.getOrder(target.id).payment_status, 'paid');
  const paidStock = db.prepare('SELECT stock FROM products WHERE id = ?').get(productId).stock;
  assert.equal(paidStock, stock, 'Stock was already allocated at order placement; a payment must not deduct it again.');
  assert.equal((await guest('/webhooks/paystack', options)).status, 200);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id = ?').get(productId).stock, paidStock);
});

test('all 16 departments and 70 subcategories exist without deleting existing stock or owner edits', async () => {
  const tree = catalog.categoryTree({ withCounts: true });
  assert.equal(tree.length, 16);
  assert.equal(tree.reduce((n, category) => n + category.children.length, 0), 70);
  const count = catalog.countActive();
  const phone = catalog.getCategoryBySlug('phones-tablets');
  db.prepare('UPDATE categories SET description = ? WHERE id = ?').run('Owner’s custom description', phone.id);
  require('../src/db/departments').ensureDepartments(db);
  assert.equal(catalog.getCategory(phone.id).description, 'Owner’s custom description');
  assert.equal(catalog.countActive(), count);
  for (const slug of ['electronics', 'smartphones', 'home-kitchen', 'groceries', 'baby-essentials', 'pet-supplies', 'toys-games', 'garden-patio']) assert.equal((await client()(`/c/${slug}`)).status, 200, slug);
  const home = await (await client()('/')).text();
  assert.equal((home.match(/class="department-card"/g) || []).length, 16);
});

test('non-fashion products work in listing, search, product, quick look, bag and wishlist; disabled departments hide them', async () => {
  const category = catalog.getCategoryBySlug('smartphones');
  const parent = catalog.getCategoryBySlug('phones-tablets');
  const id = catalog.saveProduct({ name: 'Commerce Test Phone', slug: 'commerce-test-phone', category_id: category.id, price: 250, stock: 10, is_active: true, status: 'active' });
  try {
    assert.equal(catalog.getProductById(id).name, 'Commerce Test Phone');
    for (const route of ['/c/phones-tablets', '/search?q=Commerce+Test+Phone', '/p/commerce-test-phone', '/api/products/commerce-test-phone/quickview']) {
      const response = await client()(route); assert.equal(response.status, 200, route); assert.ok((await response.text()).includes('Commerce Test Phone'));
    }
    assert.equal((await alice('/api/cart/add', json({ product_id: id }))).status, 200);
    const save = await alice('/api/wishlist/toggle', json({ product_id: id }));
    assert.equal(save.status, 200); assert.equal((await save.json()).added, true);
    assert.ok((await (await alice('/api/wishlist/ids')).json()).ids.includes(id));
    db.prepare('UPDATE categories SET is_active = 0 WHERE id = ?').run(parent.id);
    assert.equal(catalog.getProductById(id), null);
    assert.equal((await client()('/p/commerce-test-phone')).status, 404);
    assert.ok(!(await (await alice('/api/wishlist/ids')).json()).ids.includes(id));
  } finally {
    db.prepare('UPDATE categories SET is_active = 1 WHERE id = ?').run(parent.id);
    catalog.deleteProduct(id);
  }
});

test('owner delivery uses real provider request formats, opt-in and deduplication with mocked network only', async () => {
  const savedEmail = { ...config.notifications.email }, savedWhatsapp = { ...config.notifications.whatsapp };
  const calls = [];
  try {
    Object.assign(config.notifications.email, { apiKey: 'test-resend-secret', from: 'pointGh <orders@example.test>', owner: 'owner-alerts@example.test' });
    Object.assign(config.notifications.whatsapp, { accessToken: 'test-whatsapp-secret', phoneNumberId: '123456789', template: 'pointgh_new_order', owner: '+233241234567', optedIn: false });
    assert.equal(delivery.configuration().whatsapp.ready, false);
    config.notifications.whatsapp.optedIn = true;
    const fetchImpl = async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      await new Promise(resolve => setImmediate(resolve));
      return { ok: true, status: 200, json: async () => url.includes('resend') ? { id: 'email-test-id' } : { messages: [{ id: 'whatsapp-test-id' }] } };
    };
    delivery.retryPending();
    await Promise.all([delivery.flush({ orderId: order.id, fetchImpl }), delivery.flush({ orderId: order.id, fetchImpl })]);
    assert.equal(calls.length, 2);
    const email = calls.find(call => call.url.includes('resend'));
    assert.equal(email.url, 'https://api.resend.com/emails');
    assert.deepEqual(email.body.to, ['owner-alerts@example.test']);
    assert.equal(email.options.headers['Idempotency-Key'], `order:${order.id}:owner:email`);
    const whatsapp = calls.find(call => call.url.includes('graph.facebook.com'));
    assert.equal(whatsapp.body.to, '233241234567');
    assert.equal(whatsapp.body.type, 'template');
    assert.equal(whatsapp.body.template.components[0].parameters.length, 6);
    assert.equal(whatsapp.body.template.components[0].parameters[0].text, order.order_number);
    assert.ok(db.prepare('SELECT status FROM notification_outbox WHERE order_id = ?').all(order.id).every(row => row.status === 'sent'));
    await delivery.flush({ orderId: order.id, fetchImpl });
    assert.equal(calls.length, 2);
  } finally { Object.assign(config.notifications.email, savedEmail); Object.assign(config.notifications.whatsapp, savedWhatsapp); }
});

test('delivery failures are saved for retry and never reported as successful sends', async () => {
  const saved = { ...config.notifications.email };
  try {
    Object.assign(config.notifications.email, { apiKey: 'test-secret', from: 'orders@example.test' });
    const row = delivery.queueEmail({ to: 'recipient@example.test', subject: 'Retry test', text: 'Hello' });
    await delivery.flush({ ids: [row.id], fetchImpl: async () => ({ ok: false, status: 503 }) });
    const failed = db.prepare('SELECT * FROM notification_outbox WHERE id = ?').get(row.id);
    assert.equal(failed.status, 'failed'); assert.equal(failed.attempts, 1); assert.ok(failed.next_attempt_at);
    assert.ok(!failed.last_error.includes('test-secret'));
    let attempts = 0;
    await delivery.flush({ ids: [row.id], fetchImpl: async () => { attempts++; } });
    assert.equal(attempts, 0, 'Respect retry backoff');
    db.prepare("UPDATE notification_outbox SET next_attempt_at = datetime('now','-1 minute') WHERE id = ?").run(row.id);
    await delivery.flush({ ids: [row.id], fetchImpl: async () => ({ ok: true, json: async () => ({ id: 'retried-email' }) }) });
    assert.equal(db.prepare('SELECT status FROM notification_outbox WHERE id = ?').get(row.id).status, 'sent');
    delivery.retryPending();
    assert.equal(db.prepare('SELECT status FROM notification_outbox WHERE id = ?').get(row.id).status, 'sent');
  } finally { Object.assign(config.notifications.email, saved); }
});

test('WhatsApp never sends without owner opt-in, and unconfigured messages cannot starve new email', async () => {
  const savedEmail = { ...config.notifications.email }, savedWa = { ...config.notifications.whatsapp };
  try {
    Object.assign(config.notifications.email, { apiKey: 'test-only', from: 'orders@example.test' });
    Object.assign(config.notifications.whatsapp, { accessToken: 'test-only', phoneNumberId: '12345', template: 'order_alert', optedIn: false });
    const wa = delivery.enqueue({ channel: 'whatsapp', to: '233241234567', subject: 'No consent', text: 'No send', payload: { parameters: [] } });
    let attempts = 0;
    await delivery.flush({ ids: [wa.id], fetchImpl: async () => { attempts++; throw new Error('No network expected'); } });
    assert.equal(attempts, 0);
    assert.equal(db.prepare('SELECT status FROM notification_outbox WHERE id = ?').get(wa.id).status, 'unconfigured');
    const email = delivery.queueEmail({ to: 'recipient@example.test', subject: 'Not starved', text: 'Hello' });
    await delivery.flush({ ids: [wa.id, email.id], limit: 1, fetchImpl: async () => { attempts++; return { ok: true, json: async () => ({ id: 'prioritized' }) }; } });
    assert.equal(attempts, 1);
    assert.equal(db.prepare('SELECT status FROM notification_outbox WHERE id = ?').get(email.id).status, 'sent');
  } finally { Object.assign(config.notifications.email, savedEmail); Object.assign(config.notifications.whatsapp, savedWa); }
});

test('event visibility upgrades legacy databases additively and preserves internal notes for the owner', () => {
  const Database = require('better-sqlite3');
  const legacy = new Database(':memory:');
  try {
    legacy.exec(`CREATE TABLE app_migrations (name TEXT PRIMARY KEY);
      CREATE TABLE order_events (id INTEGER PRIMARY KEY, status TEXT, actor TEXT, note TEXT);
      INSERT INTO order_events VALUES (1,'processing','Test Owner (admin)','Private supplier cost');
      INSERT INTO order_events VALUES (2,'paid','gateway','Payment received');
      INSERT INTO order_events VALUES (3,'shipped','admin',NULL);`);
    const upgrade = require('../src/db/upgrades').applyUpgrades;
    upgrade(legacy); upgrade(legacy);
    const rows = legacy.prepare('SELECT * FROM order_events ORDER BY id').all();
    assert.equal(rows.length, 3);
    assert.equal(rows[0].note, 'Private supplier cost');
    assert.deepEqual(rows.map(row => row.is_public), [0, 1, 1]);
  } finally { legacy.close(); }
});

test('alert configuration/log is owner-only and scheduled retries require a strong server secret', async () => {
  assert.equal((await alice('/admin/system/mail')).status, 302);
  assert.equal((await client()('/api/internal/notifications/drain')).status, 401);
  const owner = client();
  assert.equal((await owner('/admin/login', form({ email: 'owner@biahensenterprise.com', password: 'Biahens@2026' }))).status, 302);
  const page = await owner('/admin/system/mail');
  assert.equal(page.status, 200); assert.match(await page.text(), /Setup required/);
  assert.equal((await owner('/admin/products/new')).status, 200);
  const productForm = await (await owner('/admin/products/new')).text();
  assert.ok(!productForm.includes('product-slug'));
  assert.ok(!productForm.includes('Your meta description preview appears here.'));
  const staff = client();
  await staff('/admin/login', form({ email: 'staff@biahensenterprise.com', password: 'Staff@2026' }));
  assert.equal((await staff('/admin/system/mail')).status, 302);
  const saved = config.notifications.cronSecret;
  config.notifications.cronSecret = 'a-long-random-test-worker-secret-only';
  try {
    assert.equal(delivery.authorizeWorker('Bearer wrong'), false);
    const response = await client()('/api/internal/notifications/drain', { headers: { Authorization: `Bearer ${config.notifications.cronSecret}` } });
    assert.equal(response.status, 200);
    assert.ok(!JSON.stringify(await response.json()).includes('recipient'));
  } finally { config.notifications.cronSecret = saved; }
});

test('upgrading a legacy fashion-only catalogue preserves accounts, order history, category IDs and owner edits', async () => {
  const Database = require('better-sqlite3');
  const copy = path.join(temporary, 'legacy.sqlite');
  await db.backup(copy);
  const legacy = new Database(copy);
  try {
    legacy.pragma('foreign_keys = ON');
    legacy.prepare("DELETE FROM app_migrations WHERE name = 'catalog.all-departments.v1'").run();
    legacy.prepare("DELETE FROM categories WHERE parent_id IS NULL AND slug NOT IN ('fashion','shoes-bags')").run();
    const fashion = legacy.prepare("SELECT id FROM categories WHERE slug = 'fashion'").get();
    legacy.prepare('UPDATE categories SET description = ?, is_active = 0 WHERE id = ?').run('Owner’s historical category description', fashion.id);
    const snapshot = table => legacy.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    const preserved = Object.fromEntries(['users','products','orders','order_items'].map(table => [table, snapshot(table)]));
    require('../src/db/departments').ensureDepartments(legacy);
    assert.equal(legacy.prepare('SELECT COUNT(*) AS n FROM categories WHERE parent_id IS NULL').get().n, 16);
    assert.deepEqual(legacy.prepare("SELECT id, description, is_active FROM categories WHERE slug = 'fashion'").get(), {
      id: fashion.id, description: 'Owner’s historical category description', is_active: 0,
    });
    for (const [table, rows] of Object.entries(preserved)) assert.deepEqual(snapshot(table), rows, table);
  } finally { legacy.close(); }
});

test('orders and their owner alerts roll back together if durable queuing fails', () => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(aliceId);
  const product = catalog.queryProducts({ q: 'Structured Tote' }).items[0];
  require('../src/services/cart').addToCart({ user, session: {}, sessionID: 'rollback-test' }, { productId: product.id, qty: 1 });
  const beforeOrders = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const beforeAlerts = db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n;
  const beforeStock = db.prepare('SELECT id, stock FROM products ORDER BY id').all();
  const original = delivery.queueOwnerOrder;
  delivery.queueOwnerOrder = () => { throw new Error('Test-only outbox failure'); };
  try {
    assert.throws(() => orders.createFromCart({ user, session: {}, sessionID: 'rollback-test' }, {
      shipping: { name: user.name, email: user.email, phone: user.phone, region: 'Greater Accra', city: 'Accra', line: '12 Test Road' },
      payment: { method: 'cod' }, delivery: { method: 'standard' },
    }), /Test-only outbox failure/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, beforeOrders);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n, beforeAlerts);
    assert.deepEqual(db.prepare('SELECT id, stock FROM products ORDER BY id').all(), beforeStock);
  } finally { delivery.queueOwnerOrder = original; }
});

test('owner can publish and import any department; staff cannot create products or categories', async () => {
  const owner = client(), staff = client();
  await owner('/admin/login', form({ email: 'owner@biahensenterprise.com', password: 'Biahens@2026' }));
  await staff('/admin/login', form({ email: 'staff@biahensenterprise.com', password: 'Staff@2026' }));
  const category = { name: 'Office & Business', slug: 'office-business', is_active: '1', show_in_menu: '1' };
  const count = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  assert.equal((await staff('/admin/categories', form(category))).status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM categories').get().n, count);
  assert.equal((await owner('/admin/categories', form(category))).status, 302);
  const created = catalog.getCategoryBySlug(category.slug);
  assert.ok(created);
  const product = { name: 'Owner Business Chair', category_id: created.id, price: '200', stock: '5', status: 'active', is_active: '1' };
  try {
    await staff('/admin/products', form(product));
    assert.equal(catalog.getProductBySlug('owner-business-chair'), null);
    assert.equal((await owner('/admin/products', form(product))).status, 302);
    assert.equal(catalog.getProductBySlug('owner-business-chair').category_id, created.id);
    assert.equal((await owner('/admin/products/import', form({ csv: 'name,price,category,stock,status\nOwner Electronics Import,100,smartphones,3,active', dry_run: '0' }))).status, 200);
    assert.ok(catalog.getProductBySlug('owner-electronics-import'));
    assert.equal((await client()('/c/office-business')).status, 200);
  } finally {
    for (const slug of ['owner-business-chair','owner-electronics-import']) {
      const row = catalog.getProductBySlug(slug, { admin: true });
      if (row) catalog.deleteProduct(row.id);
    }
    db.prepare('DELETE FROM categories WHERE id = ?').run(created.id);
    require('../src/middleware/context').invalidateMenu();
  }
});

test('owner alert preferences validate recipients and other settings pages preserve WhatsApp consent', async () => {
  const owner = client();
  await owner('/admin/login', form({ email: 'owner@biahensenterprise.com', password: 'Biahens@2026' }));
  const original = { ...settings.all() };
  try {
    await owner('/admin/system/mail/settings', form({ email: 'alerts@example.test', whatsapp: '+233 24 123 4567', opt_in: '1' }));
    assert.equal(delivery.configuration().email.recipient, 'alerts@example.test');
    assert.equal(delivery.configuration().whatsapp.recipient, '233241234567');
    assert.equal(settings.get('owner_whatsapp_opt_in'), true);
    await owner('/admin/system/mail/settings', form({ email: 'bad', whatsapp: 'bad' }));
    assert.equal(delivery.configuration().email.recipient, 'alerts@example.test');
    await owner('/admin/settings/general', form({ store_name: 'Test Store', tab: 'general' }));
    assert.equal(settings.get('owner_whatsapp_opt_in'), true);
    await owner('/admin/system/mail/settings', form({ email: 'alerts@example.test', whatsapp: '+233241234567' }));
    assert.equal(settings.get('owner_whatsapp_opt_in'), false);
  } finally { settings.setMany(original); }
});

test('decorative card text and dummy SEO/fashion footer blocks are no longer rendered', async () => {
  const guest = client();
  for (const route of ['/', '/categories', '/login', '/p/women-s-ankara-print-midi-dress']) {
    const html = await (await guest(route)).text();
    for (const unwanted of ['payment-marks', 'pay-badge', 'Product name | pointGh', 'product-slug', 'Your meta description preview appears here.', 'Need a hand?']) assert.ok(!html.includes(unwanted), `${route}: ${unwanted}`);
    assert.doesNotMatch(html, />\s*(Shop fashion|New in|The edit|Most loved)\s*</i);
  }
  const auth = require('../src/middleware/auth');
  assert.equal(auth.safeReturnTo('//evil.example'), '/account');
  assert.equal(auth.safeReturnTo('/\\evil.example'), '/account');
  assert.equal(auth.safeReturnTo('/checkout'), '/checkout');
});

test('notification sending must be explicitly enabled even if demo provider keys exist', async () => {
  const savedEmail = { ...config.notifications.email }, savedWa = { ...config.notifications.whatsapp }, enabled = config.notifications.enabled;
  try {
    config.notifications.enabled = false;
    Object.assign(config.notifications.email, { apiKey: 'test-only-key', from: 'orders@pointgh.test', owner: 'owner@pointgh.test' });
    Object.assign(config.notifications.whatsapp, { accessToken: 'test-only-key', phoneNumberId: '123456789', template: 'pointgh_order_alert', owner: '+233241234567', optedIn: true });
    assert.equal(delivery.configuration().email.ready, false);
    assert.equal(delivery.configuration().whatsapp.ready, false);
    const message = delivery.queueEmail({ to: 'owner@pointgh.test', subject: 'Explicit sending gate', text: 'No network expected.' });
    let calls = 0;
    await delivery.flush({ ids: [message.id], fetchImpl: async () => { calls++; throw new Error('No send authorized.'); } });
    assert.equal(calls, 0);
    assert.equal(db.prepare('SELECT status FROM notification_outbox WHERE id = ?').get(message.id).status, 'unconfigured');
  } finally { config.notifications.enabled = enabled; Object.assign(config.notifications.email, savedEmail); Object.assign(config.notifications.whatsapp, savedWa); }
});

test('owner verification send requires explicit consent, uses only configured recipients, and creates no payment or order', async () => {
  const savedEmail = { ...config.notifications.email }, savedWa = { ...config.notifications.whatsapp };
  const previousFetch = globalThis.fetch, calls = [];
  const owner = client(); await owner('/admin/login', form({ email: 'owner@biahensenterprise.com', password: 'Biahens@2026' }));
  const before = { orders: db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, payments: db.prepare('SELECT COUNT(*) AS n FROM payments').get().n };
  try {
    Object.assign(config.notifications.email, { apiKey: 'test-only-key', from: 'orders@pointgh.test', owner: 'owner@pointgh.test' });
    Object.assign(config.notifications.whatsapp, { accessToken: 'test-only-key', phoneNumberId: '123456789', template: 'pointgh_order_alert', owner: '+233241234567', optedIn: true });
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith(base + '/')) return previousFetch(url, options);
      if (String(url).startsWith('https://api.resend.com/') || String(url).startsWith('https://graph.facebook.com/')) {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return { ok: true, status: 200, json: async () => String(url).includes('resend') ? { id: 'verification-test-email' } : { messages: [{ id: 'verification-test-whatsapp' }] } };
      }
      throw new Error('Unexpected external request in a verification test.');
    };
    assert.equal((await owner('/admin/system/mail/verify', form({}))).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await alice('/admin/system/mail/verify', form({ confirm: 'SEND' }))).status, 302);
    assert.equal(calls.length, 0);
    assert.equal((await owner('/admin/system/mail/verify', form({ confirm: 'SEND', email: 'attacker@pointgh.test' }))).status, 302);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.find(call => String(call.url).includes('resend')).body.to, ['owner@pointgh.test']);
    assert.equal(calls.find(call => String(call.url).includes('facebook')).body.to, '233241234567');
    assert.deepEqual({ orders: db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, payments: db.prepare('SELECT COUNT(*) AS n FROM payments').get().n }, before);
    const accepted = db.prepare("SELECT status,provider_id FROM notification_outbox WHERE subject='POINTGH owner alert verification'").all();
    assert.equal(accepted.length, 2); assert.ok(accepted.every(row => row.status === 'sent' && row.provider_id));
    const page = await (await owner('/admin/system/health')).text();
    assert.ok(page.includes('Production readiness')); assert.ok(page.includes('not delivery/read confirmation'));
  } finally { globalThis.fetch = previousFetch; Object.assign(config.notifications.email, savedEmail); Object.assign(config.notifications.whatsapp, savedWa); }
});
