'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pointgh-payments-'));
Object.assign(process.env, { NODE_ENV: 'test', STORE_MODE: 'demo', PAYMENT_PROVIDER: 'simulator', GATEWAY_MODE: '',
  DB_FILE: path.join(temporary, 'store.sqlite'), UPLOADS_DIR: path.join(temporary, 'uploads'), SEED_ON_BOOT: 'false',
  PUBLIC_URL: 'https://pointgh.store.test', NOTIFICATIONS_ENABLED: 'true', PAYSTACK_SECRET_KEY: '', PAYSTACK_WEBHOOK_SECRET: '',
  RESEND_API_KEY: '', MAIL_FROM: '', OWNER_NOTIFICATION_EMAIL: '', OWNER_NOTIFICATION_WHATSAPP: '',
  WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', WHATSAPP_ORDER_TEMPLATE: '', WHATSAPP_OWNER_OPT_IN: 'false' });
// Generate a throwaway fixture at runtime, never a committed provider credential.
const API_KEY = 'sk_live_' + crypto.randomBytes(24).toString('hex');
const SIGNING = 'whsec_UNITTESTSIGNING01234567890123456789';
const PREVIOUS = 'whsec_PREVIOUSUNITTEST01234567890123456789';
const realFetch = globalThis.fetch;
let app, db, config, settings, orders, payments, cart, catalog, notifications, server, base, productId, alice, bob, owner, user;
let network = [], behavior;
const form = body => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
function client() {
  let cookie = '';
  return async (route, options = {}) => {
    const response = await fetch(base + route, { ...options, redirect: 'manual', headers: {
      Origin: config.publicUrl, ...(cookie ? { Cookie: cookie } : {}), ...options.headers,
    } });
    const next = response.headers.get('set-cookie');
    if (next) cookie = next.split(';')[0];
    return response;
  };
}
function response(data, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => ({ status: status === 200, data }) }; }
function success(payment, extra = {}) {
  return { id: 987000 + payment.id, reference: payment.reference, domain: payment.provider_mode, status: 'success',
    amount: Math.round(payment.amount * 100), currency: payment.currency, channel: 'card',
    paid_at: new Date().toISOString(), authorization: { last4: '4081', authorization_code: 'SECRET_AUTHORIZATION_MUST_NOT_BE_STORED' }, ...extra };
}
function modern(raw, { timestamp = Math.floor(Date.now() / 1000), key = SIGNING } = {}) {
  const hash = crypto.createHmac('sha512', key).update(`${timestamp}.`).update(raw).digest('hex');
  return `t=${timestamp},v1=whk_unittest:${hash}`;
}
function legacy(raw, key = API_KEY) { return crypto.createHmac('sha512', key).update(raw).digest('hex'); }
async function webhook(payment, extra = {}, options = {}) {
  const raw = Buffer.from(JSON.stringify({ event: options.event || 'charge.success', data: success(payment, extra) }, null, 2));
  return fetch(base + '/webhooks/paystack', { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', 'Paystack-Signature': modern(raw), ...options.headers }, body: raw });
}
function makeOrder({ method = 'card', qty = 1, id = productId, account = user } = {}) {
  const req = { user: account, session: {}, sessionID: `service-${crypto.randomUUID()}` };
  const added = cart.addToCart(req, { productId: id, qty });
  assert.equal(added.ok, true);
  const result = orders.createFromCart(req, {
    shipping: { name: account.name, email: account.email, phone: account.phone, region: 'Greater Accra', city: 'Accra', line: '12 Private Test Street' },
    payment: { method }, delivery: { method: 'standard' },
  });
  cart.clear(req);
  assert.equal(result.ok, true, result.message);
  return orders.getOrder(result.orderId);
}
async function initialize(order, options) {
  await payments.initialize(order, options);
  return orders.getOrder(order.id).payments[0];
}
function resetProvider() {
  network = [];
  behavior = (url, options) => {
    if (url.endsWith('/transaction/initialize')) {
      const payload = JSON.parse(options.body);
      return response({ reference: payload.reference, authorization_url: `https://checkout.paystack.com/${payload.reference}`, access_code: 'NOT_RETAINED_ACCESS_CODE' });
    }
    const ref = decodeURIComponent(url.split('/').pop());
    const payment = payments.findByReference(ref);
    return response(success(payment));
  };
}

before(async () => {
  require('../src/db/migrate');
  app = require('../src/app'); db = require('../src/db'); config = require('../src/config'); settings = require('../src/services/settings');
  orders = require('../src/services/orders'); payments = require('../src/services/payments'); cart = require('../src/services/cart');
  catalog = require('../src/services/catalog'); notifications = require('../src/services/notifications');
  // Live code paths, dummy credentials, and strictly intercepted provider HTTP.
  // Runtime boot guards have separate fresh-process tests; no real account is used.
  config.storeMode = 'live';
  Object.assign(config.payments, { provider: 'paystack', mode: 'live', modeLocked: true, secretKey: API_KEY, webhookSecret: SIGNING, previousWebhookSecret: PREVIOUS });
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).startsWith('https://api.paystack.co/')) {
      network.push({ url: String(url), options });
      return behavior(String(url), options);
    }
    if (String(url).startsWith(base + '/')) return realFetch(url, options);
    throw new Error('Unmocked external HTTP is forbidden by this test.');
  };
  resetProvider();
  const registration = email => form({ name: 'Payment Customer', email, phone: '0241234567', password: 'UniqueCustomer@2026', confirm_password: 'UniqueCustomer@2026', terms: '1' });
  alice = client(); bob = client(); owner = client();
  assert.equal((await alice('/register', registration('pay-alice@pointgh.test'))).status, 302);
  assert.equal((await bob('/register', registration('pay-bob@pointgh.test'))).status, 302);
  assert.equal((await owner('/admin/login', form({ email: 'owner@biahensenterprise.com', password: 'Biahens@2026' }))).status, 302);
  user = db.prepare('SELECT * FROM users WHERE email = ?').get('pay-alice@pointgh.test');
  productId = catalog.saveProduct({ name: 'Provider Test Product', slug: 'provider-test-product', price: 100, stock: 150, category_id: catalog.getCategoryBySlug('smartphones').id, is_active: true, status: 'active' });
});
after(async () => {
  globalThis.fetch = realFetch;
  if (server) await new Promise(resolve => server.close(resolve));
  if (db) db.close();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('environment payment mode and API signing key override old database defaults', async () => {
  settings.setMany({ gateway_mode: 'test', gateway_webhook_secret: 'whsec_DEPRECATED_DATABASE_VALUE' });
  assert.equal(payments.mode(), 'live');
  assert.equal(payments.secret(), API_KEY);
  assert.equal(payments.isSimulator(), false);
  assert.equal((await (await client()('/api/health')).json()).gateway, 'live');
  const html = await (await owner('/admin/settings?tab=payments')).text();
  for (const value of [API_KEY, SIGNING, PREVIOUS, 'whsec_DEPRECATED_DATABASE_VALUE']) assert.ok(!html.includes(value));
  assert.match(html, /no simulator fallback/i);
});

test('initialization uses exact VAT-inclusive subunits, backend callback and Paystack-only redirect', async () => {
  resetProvider();
  const order = makeOrder({ method: 'momo', qty: 2 });
  const payment = await initialize(order);
  assert.equal(network.length, 1);
  const request = network[0], payload = JSON.parse(request.options.body);
  assert.equal(request.url, 'https://api.paystack.co/transaction/initialize');
  assert.equal(request.options.headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(request.options.redirect, 'error');
  assert.equal(payload.amount, Math.round(order.total * 100));
  assert.equal(order.tax, 2);
  assert.equal(payload.currency, 'GHS');
  assert.match(payload.reference, /^[A-Za-z0-9.=-]+$/);
  assert.equal(payload.callback_url, `${config.publicUrl}/pay/${payment.reference}/callback`);
  assert.deepEqual(payload.channels, ['mobile_money']);
  assert.equal(payload.metadata.user_id, user.id);
  assert.ok(!payment.raw.includes('NOT_RETAINED_ACCESS_CODE'));
  assert.equal(payment.gateway, 'paystack'); assert.equal(payment.provider_mode, 'live');
  const result = await payments.initialize(order);
  assert.equal(network.length, 1); assert.equal(result.authorization_url, `https://checkout.paystack.com/${payment.reference}`);
});

test('concurrent initialization creates one reference and one provider request', async () => {
  resetProvider();
  const initial = behavior;
  behavior = async (...args) => { await new Promise(resolve => setTimeout(resolve, 15)); return initial(...args); };
  const order = makeOrder();
  const results = await Promise.all([payments.initialize(order), payments.initialize(order), payments.initialize(order)]);
  assert.equal(network.length, 1);
  assert.equal(new Set(results.map(result => result.reference)).size, 1);
  assert.equal(orders.getOrder(order.id).payments.length, 1);
});

test('real owned payment routes redirect externally and refuse PAN/CVV, local authorization and all test helpers', async () => {
  resetProvider();
  const order = makeOrder(); const payment = await initialize(order);
  const route = `/pay/${payment.reference}`;
  const redirect = await alice(route);
  assert.equal(redirect.status, 303); assert.match(redirect.headers.get('location'), /^https:\/\/checkout\.paystack\.com\//);
  assert.ok(!(await redirect.text()).includes('name="card_number"'));
  assert.equal((await client()(route)).headers.get('location'), '/login');
  assert.equal((await bob(route)).status, 404);
  assert.equal((await alice(route, form({ card_number: 'REAL_PAN_MUST_NOT_BE_PROCESSED', card_cvv: '999', simulate: 'success' }))).status, 403);
  assert.equal(payments.authorize(payment.reference, { channel: 'bank', simulate: 'success' }).ok, false);
  assert.equal((await alice(`${route}/simulate-webhook`, form({}))).status, 403);
  for (const path of ['/admin/api/webhooks/test', '/admin/settings/gateway/test', '/admin/settings/danger/reset-demo']) {
    assert.equal((await owner(path, json({ reference: payment.reference, confirm: 'RESET' }))).status, 403, path);
  }
  assert.throws(() => payments.signPayload({}), /disabled/);
  assert.ok(!JSON.stringify(payments.findByReference(payment.reference)).includes('REAL_PAN'));
  assert.equal(orders.getOrder(order.id).payment_status, 'unpaid');
  const accountPage = await (await alice(`/account/orders/${order.order_number}`)).text();
  assert.ok(accountPage.includes(`action="${route}/check"`));
  assert.ok(accountPage.includes(`action="/order/${order.order_number}/pay"`));
  assert.ok(accountPage.includes('Check payment'));
});

test('forged paid query does not confirm payment or clear a newly filled bag', async () => {
  resetProvider();
  const order = makeOrder(); await initialize(order);
  await alice('/api/cart/add', json({ product_id: productId, qty: 1 }));
  const page = await (await alice(`/order/${order.order_number}?paid=1`)).text();
  assert.ok(!page.includes('Payment received — thank you!'));
  assert.equal(orders.getOrder(order.id).payment_status, 'unpaid');
  assert.ok(db.prepare('SELECT SUM(qty) AS n FROM cart_items WHERE user_id = ?').get(user.id).n > 0);
  cart.clear({ user, session: {} });
});

test('callbacks are account-owned and mismatched callback references cannot trigger verification', async () => {
  resetProvider();
  const order = makeOrder(); const payment = await initialize(order); network = [];
  const route = `/pay/${payment.reference}/callback`;
  assert.equal((await client()(route)).headers.get('location'), '/login');
  assert.equal((await bob(route)).status, 404);
  assert.equal((await alice(`${route}?reference=ANOTHER-REFERENCE`)).status, 400);
  assert.equal((await alice(`${route}?reference=${payment.reference}&trxref=ANOTHER-REFERENCE`)).status, 400);
  assert.equal(network.length, 0);
  assert.equal(orders.getOrder(order.id).payment_status, 'unpaid');
});

test('pending verification never credits an order and exact amount/currency/domain/reference/status are mandatory', async () => {
  resetProvider(); const order = makeOrder(); const payment = await initialize(order);
  behavior = () => response(success(payment, { status: 'pending' }));
  const pending = await payments.verify(payment.reference);
  assert.equal(pending.ok, false); assert.equal(pending.pending, true);
  for (const extra of [{ amount: Math.round(payment.amount * 100) - 1 }, { amount: String(Math.round(payment.amount * 100)) }, { currency: 'USD' }, { domain: 'test' }, { reference: 'DIFFERENT-REF' }, { id: null }]) {
    behavior = () => response(success(payment, extra));
    const result = await payments.verify(payment.reference);
    assert.equal(result.ok, false, JSON.stringify(extra));
    assert.equal(orders.getOrder(order.id).payment_status, 'unpaid');
    assert.equal(payments.findByReference(payment.reference).status, 'initiated');
  }
  const maliciousStatus = await webhook(payment, { status: 'failed' }); assert.equal(maliciousStatus.status, 200);
  assert.equal(orders.getOrder(order.id).payment_status, 'unpaid');
});

test('modern raw-byte signed webhook settles exactly once, redacts authorizations, and legacy failure cannot downgrade it', async () => {
  resetProvider(); const order = makeOrder({ qty: 2 }); const payment = await initialize(order);
  const stock = db.prepare('SELECT stock,sold_count FROM products WHERE id = ?').get(productId);
  const events = db.prepare('SELECT COUNT(*) AS n FROM order_events WHERE order_id = ?').get(order.id).n;
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: success(payment) }, null, 4));
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Paystack-Signature': modern(raw) }, body: raw };
  for (let i = 0; i < 3; i++) assert.equal((await fetch(base + '/webhooks/paystack', options)).status, 200);
  const paid = orders.getOrder(order.id);
  assert.equal(paid.payment_status, 'paid'); assert.equal(paid.status, 'paid');
  assert.equal(paid.events.length, events + 1);
  assert.equal(paid.payments[0].last4, '4081');
  assert.ok(!paid.payments[0].raw.includes('SECRET_AUTHORIZATION'));
  assert.equal(db.prepare('SELECT stock FROM products WHERE id = ?').get(productId).stock, stock.stock);
  assert.equal(db.prepare('SELECT sold_count FROM products WHERE id = ?').get(productId).sold_count, stock.sold_count + 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_webhook_receipts WHERE reference = ?').get(payment.reference).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_outbox WHERE dedupe_key = ?').get(`payment:${payment.id}:customer:email`).n, 1);
  assert.equal((await webhook(payment, { status: 'failed' }, { event: 'charge.failed' })).status, 200);
  assert.equal(payments.findByReference(payment.reference).status, 'success');
  assert.equal(orders.getOrder(order.id).payment_status, 'paid');
});

test('both supported signature formats fail closed on wrong keys, body changes, replay windows and invalid modern fallback', async () => {
  resetProvider(); const order = makeOrder(); const payment = await initialize(order);
  const raw = Buffer.from(JSON.stringify({ event: 'charge.success', data: success(payment) }));
  const check = (body, headers) => payments.verifyWebhookSignature(body, headers);
  assert.equal(check(raw, { 'x-paystack-signature': legacy(raw) }), true);
  assert.equal(check(raw, { 'x-paystack-signature': legacy(raw, SIGNING) }), false);
  assert.equal(check(Buffer.from(raw + ' '), { 'x-paystack-signature': legacy(raw) }), false);
  assert.equal(check(raw.toString(), { 'x-paystack-signature': legacy(raw) }), false);
  assert.equal(check(raw, { 'paystack-signature': modern(raw, { timestamp: Math.floor(Date.now() / 1000) - 301 }) }), false);
  assert.equal(check(raw, { 'paystack-signature': modern(raw, { timestamp: Math.floor(Date.now() / 1000) + 301 }) }), false);
  assert.equal(check(raw, { 'paystack-signature': modern(raw, { key: PREVIOUS }) }), true);
  const rotating = modern(raw) + `,v1=whk_other:${'0'.repeat(128)}`;
  assert.equal(check(raw, { 'paystack-signature': rotating }), true);
  assert.equal(check(raw, { 'paystack-signature': modern(raw) + ',t=0' }), false);
  const invalid = { 'Content-Type': 'application/json', 'Paystack-Signature': 't=bad,v1=whk_bad:no', 'x-paystack-signature': legacy(raw) };
  assert.equal((await fetch(base + '/webhooks/paystack', { method: 'POST', headers: invalid, body: raw })).status, 401);
  const valid = await fetch(base + '/webhooks/paystack', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-paystack-signature': legacy(raw) }, body: raw });
  assert.equal(valid.status, 200); assert.equal(orders.getOrder(order.id).payment_status, 'paid');
});

test('signed mismatched webhook fields are acknowledged durably but never credit the order', async () => {
  resetProvider(); const order = makeOrder(); const payment = await initialize(order);
  for (const extra of [{ amount: Math.round(payment.amount * 100) + 1 }, { currency: 'NGN' }, { domain: 'test' }]) {
    assert.equal((await webhook(payment, extra)).status, 200);
    assert.equal(orders.getOrder(order.id).payment_status, 'unpaid');
  }
  const raw = Buffer.from('{broken json');
  assert.equal((await fetch(base + '/webhooks/paystack', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Paystack-Signature': modern(raw) }, body: raw })).status, 400);
});

test('callback and webhook race share a single transactional settlement path', async () => {
  resetProvider(); const order = makeOrder(); const payment = await initialize(order);
  const snapshot = db.prepare('SELECT stock,sold_count FROM products WHERE id = ?').get(productId);
  const results = await Promise.all([alice(`/pay/${payment.reference}/callback?reference=${payment.reference}`), webhook(payment), payments.verify(payment.reference)]);
  assert.equal(results[0].status, 302); assert.match(results[0].headers.get('location'), /\?paid=1$/);
  assert.equal(orders.getOrder(order.id).events.filter(event => event.status === 'paid').length, 1);
  assert.deepEqual(db.prepare('SELECT stock,sold_count FROM products WHERE id = ?').get(productId), { stock: snapshot.stock, sold_count: snapshot.sold_count + 1 });
});

test('durable settlement failure rolls everything back and returns 500 so a webhook retry can recover', async () => {
  resetProvider(); const order = makeOrder(); const payment = await initialize(order);
  const snapshot = db.prepare('SELECT stock,sold_count FROM products WHERE id = ?').get(productId);
  const original = notifications.queueEmail;
  notifications.queueEmail = () => { throw new Error('Test-only durable receipt failure'); };
  try {
    assert.equal((await webhook(payment)).status, 500);
    assert.equal(orders.getOrder(order.id).payment_status, 'unpaid');
    assert.equal(payments.findByReference(payment.reference).status, 'initiated');
    assert.deepEqual(db.prepare('SELECT stock,sold_count FROM products WHERE id = ?').get(productId), snapshot);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payment_webhook_receipts WHERE reference = ?').get(payment.reference).n, 0);
  } finally { notifications.queueEmail = original; }
  assert.equal((await webhook(payment)).status, 200);
  assert.equal(orders.getOrder(order.id).payment_status, 'paid');
});

test('COD collection is idempotent and online paid/refunded states cannot be fabricated manually', async () => {
  resetProvider(); const cod = makeOrder({ method: 'cod', qty: 2 });
  const allocated = db.prepare('SELECT stock,sold_count FROM products WHERE id = ?').get(productId);
  assert.equal(payments.markCollected(cod.id, { method: 'cod' }).ok, true);
  assert.equal(payments.markCollected(cod.id, { method: 'cod' }).alreadyPaid, true);
  assert.deepEqual(db.prepare('SELECT stock,sold_count FROM products WHERE id = ?').get(productId), { stock: allocated.stock, sold_count: allocated.sold_count + 2 });
  assert.equal(orders.getOrder(cod.id).payments.length, 1);
  const online = makeOrder();
  assert.equal(payments.markCollected(online.id, { method: 'momo' }).ok, false);
  assert.equal(orders.setStatus(online.id, 'paid').ok, false);
  assert.equal(orders.setStatus(online.id, 'processing').ok, false);
  assert.equal(orders.setStatus(cod.id, 'refunded').ok, false);
  const before = db.prepare('SELECT COUNT(*) AS n FROM payments').get().n;
  assert.equal(payments.refund(cod.id).ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, before);
  assert.equal(orders.getOrder(cod.id).payment_status, 'paid');
});

test('cancellation and expiration release allocation once; late real funds do not resurrect fulfilment', async () => {
  resetProvider(); const order = makeOrder(); const payment = await initialize(order);
  const allocated = db.prepare('SELECT stock,sold_count FROM products WHERE id = ?').get(productId);
  assert.equal(orders.setStatus(order.id, 'cancelled').ok, true);
  orders.setStatus(order.id, 'cancelled');
  assert.equal(db.prepare('SELECT stock FROM products WHERE id = ?').get(productId).stock, allocated.stock + 1);
  assert.equal((await webhook(payment)).status, 200);
  const late = orders.getOrder(order.id);
  assert.equal(late.status, 'cancelled'); assert.equal(late.payment_status, 'paid');
  assert.equal(late.stock_state, 'released'); assert.equal(late.payments[0].needs_review, 1);
  assert.deepEqual(db.prepare('SELECT stock,sold_count FROM products WHERE id = ?').get(productId), { stock: allocated.stock + 1, sold_count: allocated.sold_count });
  const page = await (await alice(`/order/${order.order_number}?paid=1`)).text();
  assert.match(page, /payment needs a review/); assert.ok(!page.includes('Payment received — thank you!'));
  const expiring = makeOrder(); const pending = await initialize(expiring);
  db.prepare("UPDATE orders SET stock_held_until = datetime('now','-1 minute') WHERE id = ?").run(expiring.id);
  assert.equal(orders.expirePaymentHolds(expiring.id), 1);
  assert.equal(orders.expirePaymentHolds(expiring.id), 0);
  assert.equal((await webhook(pending)).status, 200);
  assert.equal(orders.getOrder(expiring.id).status, 'cancelled');
  assert.equal(payments.findByReference(pending.reference).needs_review, 1);
});

test('cancelling a paid order does not pretend a refund occurred or restock twice', async () => {
  resetProvider(); const order = makeOrder(); const payment = await initialize(order); await webhook(payment);
  const stock = db.prepare('SELECT stock FROM products WHERE id = ?').get(productId).stock;
  assert.equal(orders.setStatus(order.id, 'cancelled').ok, true);
  orders.setStatus(order.id, 'cancelled');
  assert.equal(orders.getOrder(order.id).payment_status, 'paid');
  assert.equal(payments.findByReference(payment.reference).status, 'success');
  assert.equal(db.prepare('SELECT stock FROM products WHERE id = ?').get(productId).stock, stock + 1);
  const accountPage = await (await alice(`/account/orders/${order.order_number}`)).text();
  assert.ok(accountPage.includes('Cancelling an order does not automatically send a refund'));
  assert.ok(!accountPage.includes('has been refunded to your original payment method'));
  assert.ok(!accountPage.includes(`action="/order/${order.order_number}/pay"`));
});

test('a second captured reference for the same order is a review item, not a second sale or stock deduction', async () => {
  resetProvider(); const order = makeOrder(); const first = await initialize(order);
  await webhook(first, { status: 'failed' }, { event: 'charge.failed' });
  const second = await initialize(order);
  assert.notEqual(first.reference, second.reference);
  const stock = db.prepare('SELECT stock,sold_count FROM products WHERE id = ?').get(productId);
  assert.equal((await webhook(first)).status, 200);
  assert.equal((await webhook(second)).status, 200);
  assert.equal(payments.findByReference(second.reference).needs_review, 1);
  assert.deepEqual(db.prepare('SELECT stock,sold_count FROM products WHERE id = ?').get(productId), { stock: stock.stock, sold_count: stock.sold_count + 1 });
  assert.equal(orders.getOrder(order.id).payments.filter(payment => payment.status === 'success').length, 2);
});

test('uncertain initialization retries reconcile the same reference, never silently create a second charge', async () => {
  resetProvider(); const order = makeOrder();
  behavior = async () => { throw new Error(`Network failed with ${API_KEY} and private provider response`); };
  await assert.rejects(payments.initialize(order), error => error.code === 'PAYSTACK_UNAVAILABLE' && !error.message.includes(API_KEY));
  const pending = orders.getOrder(order.id).payments[0];
  const saved = JSON.stringify(pending);
  assert.ok(!saved.includes(API_KEY)); assert.ok(!saved.includes('private provider response'));
  assert.equal(orders.getOrder(order.id).payment_status, 'unpaid');
  network = [];
  behavior = (url, options) => {
    if (url.includes('/verify/')) return response(success(pending));
    throw new Error('A second initialization must not occur.');
  };
  const recovered = await payments.initialize(order);
  assert.match(recovered.authorization_url, /^\/order\/.+\?paid=1$/);
  assert.equal(network.length, 1); assert.match(network[0].url, /\/verify\//);
  assert.equal(orders.getOrder(order.id).payments.length, 1);
});

test('provider redirect validation rejects lookalikes, HTTP, embedded credentials and a changed reference', async () => {
  const api = require('../src/services/paystack');
  for (const url of ['http://checkout.paystack.com/a', 'https://checkout.paystack.com.evil.test/a', 'https://evil.test/a', 'https://user:pass@checkout.paystack.com/a', 'https://checkout.paystack.com:444/a']) assert.throws(() => api.checkoutUrl(url));
  resetProvider(); const order = makeOrder();
  behavior = () => response({ reference: 'ANOTHER-REF', authorization_url: 'https://checkout.paystack.com/safe' });
  await assert.rejects(payments.initialize(order), error => error.code === 'PAYSTACK_REJECTED');
  assert.equal(orders.getOrder(order.id).payment_status, 'unpaid');
  assert.equal(orders.getOrder(order.id).payments[0].authorization_url, null);
});

test('live origin protection rejects cross-site changes but signature-only webhooks remain independent', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  for (const headers of [{ Origin: 'https://attacker.test' }, { Origin: 'null' }, { Origin: config.publicUrl, 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await alice('/checkout/place', { ...form({ terms: '1' }), headers: { ...form({}).headers, ...headers } })).status, 403);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, before);
  assert.equal((await client()('/healthz')).status, 200);
});

test('a provider outage after checkout preserves one owned order, empties the bag and leaves safe retry controls', async () => {
  resetProvider(); cart.clear({ user, session: {} });
  await alice('/api/cart/add', json({ product_id: productId, qty: 1 }));
  await alice('/checkout/address', form({ name: user.name, email: user.email, phone: user.phone, region: 'Greater Accra', city: 'Accra', line: '12 Test Street' }));
  await alice('/checkout/delivery', form({ method: 'standard' }));
  await alice('/checkout/payment', form({ method: 'card' }));
  const before = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  behavior = () => { throw new Error('Unit-test provider outage'); };
  const placed = await alice('/checkout/place', form({ terms: '1' }));
  assert.equal(placed.status, 302); assert.match(placed.headers.get('location'), /^\/order\//);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, before + 1);
  const last = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();
  assert.equal(last.user_id, user.id); assert.equal(last.payment_status, 'unpaid');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cart_items WHERE user_id = ?').get(user.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_outbox WHERE order_id = ?').get(last.id).n, 2);
  const html = await (await alice(placed.headers.get('location'))).text();
  assert.ok(html.includes('Check payment')); assert.ok(html.includes('Pay GH'));
  await alice('/checkout/place', form({ terms: '1' }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, before + 1);
});

test('normal checkout uses Paystack hosted redirect with no local live payment form', async () => {
  resetProvider();
  await alice('/api/cart/add', json({ product_id: productId, qty: 1 }));
  await alice('/checkout/address', form({ name: user.name, email: user.email, phone: user.phone, region: 'Greater Accra', city: 'Accra', line: '12 Test Street' }));
  await alice('/checkout/delivery', form({ method: 'standard' }));
  const paymentPage = await (await alice('/checkout/back/3')).text();
  assert.ok(!paymentPage.includes('Demo payments only'));
  assert.ok(!paymentPage.includes('name="card_number"'));
  assert.match(paymentPage, /Paystack’s secure hosted checkout/);
  await alice('/checkout/payment', form({ method: 'momo' }));
  const result = await alice('/checkout/place', form({ terms: '1' }));
  assert.equal(result.status, 302); assert.match(result.headers.get('location'), /^https:\/\/checkout\.paystack\.com\//);
});

test('one provider transaction ID cannot credit two different references', async () => {
  resetProvider(); const firstOrder = makeOrder(), secondOrder = makeOrder();
  const first = await initialize(firstOrder), second = await initialize(secondOrder);
  await webhook(first);
  assert.equal((await webhook(second, { id: success(first).id })).status, 200);
  assert.equal(orders.getOrder(firstOrder.id).payment_status, 'paid');
  assert.equal(orders.getOrder(secondOrder.id).payment_status, 'unpaid');
});

test('two shoppers cannot sell the last unit, and cancelling its reservation restores it exactly once', () => {
  const id = catalog.saveProduct({ name: 'Last Unit Product', slug: 'last-unit-product', price: 80, stock: 1, category_id: catalog.getCategoryBySlug('smartphones').id, is_active: true, status: 'active' });
  const other = db.prepare('SELECT * FROM users WHERE email = ?').get('pay-bob@pointgh.test');
  const reqA = { user, session: {}, sessionID: 'stock-a' }, reqB = { user: other, session: {}, sessionID: 'stock-b' };
  cart.clear(reqA); cart.clear(reqB);
  assert.equal(cart.addToCart(reqA, { productId: id }).ok, true); assert.equal(cart.addToCart(reqB, { productId: id }).ok, true);
  const details = account => ({ shipping: { name: account.name, email: account.email, phone: account.phone, region: 'Greater Accra', city: 'Accra', line: '12 Test Street' }, payment: { method: 'card' }, delivery: { method: 'standard' } });
  const before = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const first = orders.createFromCart(reqA, details(user));
  assert.equal(first.ok, true); assert.equal(orders.createFromCart(reqB, details(other)).ok, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, before + 1);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id = ?').get(id).stock, 0);
  orders.setStatus(first.orderId, 'cancelled'); orders.setStatus(first.orderId, 'cancelled');
  assert.equal(db.prepare('SELECT stock FROM products WHERE id = ?').get(id).stock, 1);
  cart.clear(reqA); cart.clear(reqB);
});

test('variant allocation failures roll back every product/variant line instead of clamping inventory', () => {
  const id = catalog.saveProduct({ name: 'Atomic Variant Product', slug: 'atomic-variant-product', price: 50, stock: 5, category_id: catalog.getCategoryBySlug('smartphones').id, is_active: true, status: 'active' });
  const variant = db.prepare("INSERT INTO variants (product_id,title,stock) VALUES (?,'Only one',1)").run(id).lastInsertRowid;
  const info = db.prepare("INSERT INTO orders (order_number,user_id,ship_name,ship_phone,ship_region,ship_city,ship_line,total) VALUES ('ATOMIC-VARIANT',?,'Test','0241234567','Greater Accra','Accra','Test Address',100)").run(user.id);
  db.prepare("INSERT INTO order_items (order_id,product_id,variant_id,name,price,qty,total) VALUES (?,?,?,'Atomic Variant',50,2,100)").run(info.lastInsertRowid, id, variant);
  assert.throws(() => orders.reserveStock(info.lastInsertRowid), error => error.code === 'STOCK_UNAVAILABLE');
  assert.equal(db.prepare('SELECT stock FROM products WHERE id = ?').get(id).stock, 5);
  assert.equal(db.prepare('SELECT stock FROM variants WHERE id = ?').get(variant).stock, 1);
  assert.equal(orders.getOrder(info.lastInsertRowid).stock_state, 'none');
});

test('fractional or malformed quantities are refused before entering a payable bag', async () => {
  cart.clear({ user, session: {} });
  for (const qty of ['1.5', '-1', 'NaN', 'Infinity', '9007199254740992']) {
    const result = await alice('/api/cart/add', json({ product_id: productId, qty }));
    assert.equal(result.status, 400, qty);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cart_items WHERE user_id = ?').get(user.id).n, 0);
});

test('signup rotates the unauthenticated session while preserving its guest bag', async () => {
  const initial = await fetch(base + '/login');
  const guestCookie = initial.headers.get('set-cookie').split(';')[0];
  await fetch(base + '/api/cart/add', { ...json({ product_id: productId, qty: 1 }), headers: { ...json({}).headers, Origin: config.publicUrl, Cookie: guestCookie } });
  const signup = await fetch(base + '/register', { ...form({ name: 'Session Rotation', email: 'session-rotation@pointgh.test', phone: '0241234567', password: 'SessionRotation@2026', confirm_password: 'SessionRotation@2026', terms: '1' }), redirect: 'manual', headers: { ...form({}).headers, Origin: config.publicUrl, Cookie: guestCookie } });
  assert.equal(signup.status, 302);
  const authenticated = signup.headers.get('set-cookie').split(';')[0]; assert.notEqual(authenticated, guestCookie);
  const oldSid = decodeURIComponent(guestCookie.split('=')[1]).slice(2).split('.')[0];
  assert.equal(db.prepare('SELECT sid FROM sessions WHERE sid = ?').get(oldSid), undefined);
  const account = db.prepare('SELECT id FROM users WHERE email = ?').get('session-rotation@pointgh.test');
  assert.equal(db.prepare('SELECT qty FROM cart_items WHERE user_id = ?').get(account.id).qty, 1);
});

test('customer payment help describes provider checks and never promises unimplemented instant refunds or refund SMS', async () => {
  const guest = client();
  for (const route of ['/faq', '/terms', '/returns-refunds', '/privacy']) {
    const response = await guest(route); assert.equal(response.status, 200, route);
    const html = await response.text();
    assert.ok(!html.includes('money leaves our gateway immediately'), route);
    assert.ok(!html.includes('email and SMS the moment a refund is approved'), route);
    assert.ok(!html.includes('receipt with our TIN'), route);
    assert.ok(!html.includes('Refunds in 24 hours'), route);
    assert.ok(!html.includes('Phone orders are held for 24 hours'), route);
    if (route === '/faq') assert.ok(html.includes('Check payment'));
    if (route === '/terms') assert.ok(html.includes('30-minute payment window'));
  }
});
