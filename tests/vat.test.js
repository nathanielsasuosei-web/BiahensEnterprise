'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pointgh-vat-'));
Object.assign(process.env, {
  NODE_ENV: 'test', DB_FILE: path.join(temporary, 'store.sqlite'), UPLOADS_DIR: path.join(temporary, 'uploads'),
  SEED_ON_BOOT: 'true', BIAHENS_QUIET: '1', RESEND_API_KEY: '', MAIL_FROM: '',
  WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', WHATSAPP_ORDER_TEMPLATE: '', WHATSAPP_OWNER_OPT_IN: 'false',
  OWNER_NOTIFICATION_EMAIL: '', OWNER_NOTIFICATION_WHATSAPP: '', NOTIFICATION_CRON_SECRET: '',
});
const form = body => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
let db, settings, cart, catalog, orders, server, base, productId;
let cartSequence = 0;
function client() {
  let cookie = '';
  return async (route, options = {}) => {
    const response = await fetch(base + route, { ...options, headers: { ...(cookie ? { Cookie: cookie } : {}), ...options.headers }, redirect: 'manual' });
    const next = response.headers.get('set-cookie');
    if (next) cookie = next.split(';')[0];
    return response;
  };
}
function bag(qty, couponCode = null, method = 'standard') {
  const req = { sessionID: `vat-bag-${++cartSequence}`, session: { couponCode, shipMethod: method, shipRegion: 'Ashanti' } };
  assert.equal(cart.addToCart(req, { productId, qty }).ok, true);
  return cart.getCart(req);
}

before(async () => {
  require('../src/db/migrate');
  const app = require('../src/app');
  db = require('../src/db'); settings = require('../src/services/settings'); cart = require('../src/services/cart');
  catalog = require('../src/services/catalog'); orders = require('../src/services/orders');
  productId = catalog.saveProduct({ name: 'VAT Test Item', slug: 'vat-test-item', category_id: catalog.getCategoryBySlug('smartphones').id,
    price: 100, stock: 50, is_active: true, status: 'active' });
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (db) db.close();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('POINTGH is the default identity in branding, metadata, public pages and service information', async () => {
  assert.equal(settings.get('store_name'), 'POINTGH');
  assert.equal(settings.get('store_short'), 'POINTGH');
  assert.equal(settings.get('tax_rate'), 1);
  const request = client();
  for (const route of ['/', '/categories', '/about', '/contact', '/sell-with-us', '/login', '/register', '/p/vat-test-item']) {
    const response = await request(route);
    assert.equal(response.status, 200, route);
    const html = await response.text();
    assert.match(html, ['/login', '/register'].includes(route) ? /<b[^>]*>POINTGH<\/b>/ : /class="brand-name">POINTGH/, route);
    assert.match(html, /property="og:site_name" content="POINTGH"/, route);
    assert.ok(!html.includes('pointGh'), route);
  }
  assert.equal((await (await request('/api/health')).json()).service, 'POINTGH');
  const terms = await (await request('/terms')).text();
  assert.match(terms, /VAT \(1%\)/);
  assert.match(terms, /excluding delivery/);
  assert.ok(!terms.includes('include VAT and any applicable levies'));
});

test('the 1% VAT charge is based on merchandise, after coupons and before adding delivery', () => {
  const standard = bag(3);
  assert.equal(standard.subtotal, 300);
  assert.ok(standard.shipping > 0);
  assert.equal(standard.taxRate, 1);
  assert.equal(standard.tax, 3);
  assert.equal(standard.total, 300 + standard.shipping + 3);

  const percent = bag(3, 'WELCOME10');
  assert.equal(percent.discount, 30);
  assert.equal(percent.tax, 2.7);
  assert.equal(percent.total, 270 + percent.shipping + 2.7);
  const fixed = bag(3, 'AKWAABA');
  assert.equal(fixed.discount, 50);
  assert.equal(fixed.tax, 2.5);
  assert.equal(fixed.total, 250 + fixed.shipping + 2.5);

  const pickup = bag(3, null, 'pickup');
  assert.equal(pickup.shipping, 0);
  assert.equal(pickup.tax, 3);
  assert.equal(pickup.total, 303);
  const freeShipping = bag(10, 'FREESHIP');
  assert.equal(freeShipping.shipping, 0);
  assert.equal(freeShipping.tax, 10);
  assert.equal(freeShipping.total, 1010);
});

test('full discounts, empty bags and pesewa rounding never create phantom VAT', () => {
  db.prepare("INSERT INTO coupons (code, type, value) VALUES ('VATFULL','percent',100)").run();
  const full = bag(3, 'VATFULL');
  assert.equal(full.discount, 300);
  assert.equal(full.tax, 0);
  assert.equal(full.total, full.shipping);
  const empty = cart.getCart({ sessionID: 'empty-vat', session: {} });
  assert.equal(empty.tax, 0);
  assert.equal(empty.shipping, 0);
  assert.equal(empty.total, 0);
  db.prepare('UPDATE products SET price = 19.99 WHERE id = ?').run(productId);
  try {
    const fractional = bag(3);
    assert.equal(fractional.subtotal, 59.97);
    assert.equal(fractional.tax, 0.6);
    assert.equal(fractional.total, Number((59.97 + fractional.shipping + 0.6).toFixed(2)));
  } finally { db.prepare('UPDATE products SET price = 100 WHERE id = ?').run(productId); }
});

test('all AJAX cart mutations return the real VAT and total, ignoring submitted pricing fields', async () => {
  const request = client();
  const added = await (await request('/api/cart/add', json({ product_id: productId, qty: 2, tax_rate: 0, tax: 0, total: 1 }))).json();
  assert.equal(added.taxRate, 1);
  assert.equal(added.tax, 2);
  assert.equal(added.total, added.subtotal - added.discount + added.shipping + added.tax);
  const updated = await (await request('/api/cart/update', json({ id: added.items[0].id, qty: 3, tax: 0 }))).json();
  assert.equal(updated.subtotal, 300);
  assert.equal(updated.tax, 3);
  const page = await (await request('/cart')).text();
  assert.match(page, /data-vat-row><span>VAT \(1%\)<\/span><b>GH₵ 3\.00/);
  assert.match(page, /data-cart-vat-label>VAT \(1%\)/);
  const removed = await (await request('/api/cart/remove', json({ id: added.items[0].id }))).json();
  assert.equal(removed.tax, 0);
  assert.equal(removed.total, 0);
});

test('variant prices and quantities participate in the VAT base', async () => {
  const product = catalog.getProductBySlug('women-s-ankara-print-midi-dress');
  const variant = product.variants.filter(item => item.stock >= 2).sort((a, b) => b.stock - a.stock)[0];
  const response = await (await client()('/api/cart/add', json({ product_id: product.id, variant_id: variant.id, qty: 2 }))).json();
  const expected = Number(((product.price + variant.price_delta) * 2).toFixed(2));
  assert.equal(response.subtotal, expected);
  assert.equal(response.tax, Number((expected / 100).toFixed(2)));
});

test('order, hosted payment, owner alerts, confirmations and invoices agree, and keep the original rate', async () => {
  const request = client();
  assert.equal((await request('/register', form({ name: 'VAT Customer', email: 'vat@example.test', phone: '0241234567',
    password: 'Storefront@2026', confirm_password: 'Storefront@2026', terms: '1' }))).status, 302);
  await request('/api/cart/add', json({ product_id: productId, qty: 1 }));
  await request('/checkout');
  await request('/checkout/address', form({ name: 'VAT Customer', phone: '0241234567', email: 'vat@example.test', region: 'Ashanti', city: 'Kumasi', line: '12 Example Street' }));
  await request('/checkout/delivery', form({ method: 'standard' }));
  const review = await request('/checkout/payment', form({ method: 'card' }));
  assert.match(await review.text(), /data-vat-row><span>VAT \(1%\)<\/span><b>GH₵ 1\.00/);
  const result = await request('/checkout/place', form({ terms: '1', tax: '0', tax_rate: '0', total: '1' }));
  assert.equal(result.status, 302);
  const paymentRoute = result.headers.get('location');
  const payment = db.prepare('SELECT * FROM payments WHERE reference = ?').get(paymentRoute.split('/')[2]);
  const order = orders.getOrder(payment.order_id);
  assert.equal(order.tax_rate, 1);
  assert.equal(order.tax, 1);
  assert.equal(order.total, 100 + order.shipping_fee + 1);
  assert.equal(payment.amount, order.total);
  assert.equal(JSON.parse(payment.raw).amount, Math.round(order.total * 100));
  const alert = db.prepare("SELECT * FROM notification_outbox WHERE order_id = ? AND channel = 'email'").get(order.id);
  assert.match(alert.subject, /POINTGH/);
  assert.match(alert.text, /VAT \(1%\): GH₵ 1\.00/);

  const owner = client();
  await owner('/admin/login', form({ email: 'owner@biahensenterprise.com', password: 'Biahens@2026' }));
  settings.set('tax_rate', 7.5);
  try {
    for (const route of [paymentRoute, `/order/${order.order_number}`, `/account/orders/${order.order_number}`, `/order/${order.order_number}/receipt`, `/account/orders/${order.order_number}/receipt`]) {
      const response = await request(route);
      assert.equal(response.status, 200, route);
      const html = await response.text();
      assert.match(html, /data-vat-row><span>VAT \(1%\)<\/span><b>GH₵ 1\.00/, route);
    }
    for (const route of [`/admin/orders/${order.id}`, `/admin/orders/${order.id}/invoice`]) {
      const response = await owner(route);
      assert.equal(response.status, 200, route);
      assert.match(await response.text(), /VAT \(1%\)/, route);
    }
    assert.equal(orders.getOrder(order.id).tax_rate, 1);
    assert.equal(orders.getOrder(order.id).total, order.total);
    assert.equal(bag(1).tax, 7.5, 'only new carts use a changed rate');
  } finally { settings.set('tax_rate', 1); }
});

test('the one-time legacy migration preserves prices, stock, URLs and historic order charges', () => {
  const Database = require('better-sqlite3');
  const legacy = new Database(':memory:');
  try {
    const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8').replace(/^  tax_rate\s+REAL[^\n]*\n/m, '');
    legacy.exec(schema);
    legacy.exec(`INSERT INTO settings (key,value,grp) VALUES
      ('store_name','Old shop','identity'),('store_short','pointGh','identity'),('tax_rate','0','commerce'),
      ('meta_title','Owner-written title | pointGh','seo'),('support_email','owner@example.test','contact');
      INSERT INTO brands (name,slug) VALUES ('pointGh Select','pointgh-select');
      INSERT INTO products (name,slug,price,stock,description) VALUES ('Owner item','owner-item',125.5,9,'Owner copy. A pointGh gift box.');
      INSERT INTO orders (order_number,subtotal,shipping_fee,tax,total,ship_name,ship_phone,ship_region,ship_city,ship_line)
        VALUES ('HISTORIC-1',100,35,0,135,'Legacy Customer','0241234567','Ashanti','Kumasi','12 Example Street');`);
    const before = legacy.prepare('SELECT * FROM orders').get();
    const upgrade = require('../src/db/pointgh').applyPointghUpdate;
    upgrade(legacy);
    const { tax_rate: rate, ...after } = legacy.prepare('SELECT * FROM orders').get();
    assert.deepEqual(after, before);
    assert.equal(rate, null, 'historical rates are not guessed');
    const setting = key => legacy.prepare('SELECT value FROM settings WHERE key = ?').get(key).value;
    assert.equal(setting('store_name'), 'POINTGH');
    assert.equal(setting('store_short'), 'POINTGH');
    assert.equal(setting('tax_rate'), '1');
    assert.equal(setting('meta_title'), 'Owner-written title | POINTGH');
    assert.equal(setting('support_email'), 'owner@example.test');
    assert.deepEqual(legacy.prepare('SELECT name,slug,price,stock,description FROM products').get(), {
      name: 'Owner item', slug: 'owner-item', price: 125.5, stock: 9, description: 'Owner copy. A POINTGH gift box.',
    });
    assert.deepEqual(legacy.prepare('SELECT name,slug FROM brands').get(), { name: 'POINTGH Select', slug: 'pointgh-select' });
    legacy.prepare("UPDATE settings SET value = '2' WHERE key = 'tax_rate'").run();
    upgrade(legacy);
    assert.equal(setting('tax_rate'), '2', 'later owner settings survive restarts');
    assert.equal(legacy.prepare("SELECT COUNT(*) AS n FROM app_migrations WHERE name = 'store.pointgh-vat.v1'").get().n, 1);
    const { vatLabel } = require('../src/utils/helpers');
    assert.equal(vatLabel(null), 'VAT');
    assert.equal(vatLabel(1), 'VAT (1%)');
  } finally { legacy.close(); }
});

test('owner VAT settings reject invalid values without changing the stored rate', async () => {
  const owner = client();
  await owner('/admin/login', form({ email: 'owner@biahensenterprise.com', password: 'Biahens@2026' }));
  const page = await (await owner('/admin/settings?tab=commerce')).text();
  assert.match(page, /for="tax_rate">VAT \(%\)/);
  assert.match(page, /id="tax_rate"[^>]*value="1"/);
  for (const route of ['/admin/settings/general', '/admin/settings/settings/save']) {
    for (const rate of ['-1', '101', 'not-a-number', 'Infinity', '']) {
      const response = await owner(route, form({ tax_rate: rate, tab: 'commerce' }));
      assert.equal(response.status, 302);
      assert.equal(settings.get('tax_rate'), 1);
    }
  }
});

test('saving VAT does not switch off unrelated storefront, payment or notification settings', async () => {
  const owner = client();
  await owner('/admin/login', form({ email: 'owner@biahensenterprise.com', password: 'Biahens@2026' }));
  const original = { ...settings.all() };
  try {
    const response = await owner('/admin/settings/general', form({ tax_rate: '1.25', tab: 'commerce' }));
    assert.equal(response.status, 302);
    assert.equal(settings.get('tax_rate'), 1.25);
    for (const key of settings.BOOLEAN_KEYS) assert.equal(settings.all()[key], original[key], key);
    assert.equal(bag(1).tax, 1.25);
    // A switch declared by the actual form can still be unchecked normally.
    await owner('/admin/settings/general', form({ tab: 'homepage', _booleans: 'announcement_on' }));
    assert.equal(settings.get('announcement_on'), false);
    assert.equal(settings.get('cod_enabled'), true);
    assert.equal(settings.get('tax_rate'), 1.25);
  } finally { settings.setMany(original); }
});
