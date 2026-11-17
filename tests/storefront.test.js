'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Tests never touch the shop's database, uploads, customers or sessions.
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pointgh-storefront-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(temporary, 'store.sqlite');
process.env.UPLOADS_DIR = path.join(temporary, 'uploads');
process.env.SEED_ON_BOOT = 'true';
process.env.BIAHENS_QUIET = '1';

let server;
let base;
let db;
let catalog;
let originalOwner;

before(async () => {
  // Exercise the documented init → seed sequence, including owner reuse.
  require('../src/db/migrate');
  db = require('../src/db');
  originalOwner = db.prepare("SELECT id, password_hash FROM users WHERE role = 'owner'").get();
  const app = require('../src/app');
  catalog = require('../src/services/catalog');
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (db) db.close();
  fs.rmSync(temporary, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  return async (route, options = {}) => {
    const response = await fetch(base + route, {
      ...options,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...options.headers },
      redirect: 'manual',
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
}
const jsonOptions = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('init then seed preserves the existing owner and seeds a complete fashion catalogue', () => {
  const owner = db.prepare("SELECT id, password_hash FROM users WHERE role = 'owner'").get();
  assert.deepEqual(owner, originalOwner);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'").get().n, 1);
  assert.equal(catalog.countActive(), 19);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM slides').get().n, 3);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM shipping_rates').get().n >= 16);
  for (const [slug, photo] of [
    ['unisex-eva-slide-sandals-anti-skid', 'slide-sandals'],
    ['hard-shell-cabin-luggage-20-360-spinner', 'cabin-luggage'],
    ['gold-plated-ankh-pendant-necklace-18', 'gold-necklace'],
  ]) assert.equal(catalog.getProductBySlug(slug).image, `/img/storefront/${photo}.jpg`);
});

test('homepage renders live categories, collections, prices and progressive shopping controls', async () => {
  const response = await client()('/');
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const expected of ['Good style.', 'Great finds.', 'What are you shopping for?', 'data-product-tabs', 'data-product-tab="women"', 'role="tabpanel"', 'aria-selected="true"', 'action="/cart/add"', 'formaction="/p/', 'data-minicart-footer', 'data-newsletter-form', 'GH₵']) assert.ok(html.includes(expected), expected);
  assert.ok(!html.includes('fonts.googleapis.com'), 'Fonts must work without an external font service');
  assert.equal(response.headers.get('x-frame-options'), null, 'Development preview must support embedding');
});

test('campaign, fonts and shared stylesheet are served locally', async () => {
  const request = client();
  for (const [route, type] of [
    ['/img/storefront/new-season.jpg', 'image/jpeg'],
    ['/fonts/dm-sans-latin.woff2', 'font/woff2'],
    ['/fonts/plus-jakarta-sans-latin.woff2', 'font/woff2'],
    ['/css/fashion.css', 'text/css'],
  ]) {
    const response = await request(route);
    assert.equal(response.status, 200, route);
    assert.ok(response.headers.get('content-type').includes(type), route);
    assert.ok((await response.arrayBuffer()).byteLength > 1000, route);
  }
});

test('search, category selection, sale, price filtering and product pages render matching products', async () => {
  const request = client();
  for (const route of ['/search?q=ankara', '/search?max=500&sort=price_asc', '/c/womens-clothing', '/deals', '/new-arrivals', '/categories']) {
    const response = await request(route);
    assert.equal(response.status, 200, route);
    const html = await response.text();
    assert.ok(html.includes('id="main"'), route);
    assert.ok(!html.includes('Internal Server Error'), route);
  }
  const results = catalog.queryProducts({ q: 'ankara' }).items;
  const html = await (await request('/search?q=ankara')).text();
  for (const p of results) assert.ok(html.includes(`data-product-card="${p.id}"`));
  const product = results[0];
  assert.equal((await request(`/p/${product.slug}`)).status, 200);
  assert.equal((await request('/p/not-a-real-product')).status, 404);
});

test('quick look returns real product data, prices and selectable stock', async () => {
  const product = catalog.queryProducts({ q: 'Ankara Print Midi' }).items[0];
  const response = await client()(`/api/products/${product.slug}/quickview`);
  assert.equal(response.status, 200);
  const { product: quick } = await response.json();
  assert.equal(quick.id, product.id);
  assert.equal(quick.price, product.price);
  assert.ok(quick.images[0].startsWith('/'));
  assert.ok(quick.variants.length > 0);
  assert.ok(quick.variants.some(v => v.stock > 0));
  assert.ok(quick.variants.every(v => typeof v.price === 'number'));
});

test('bag add, quantity updates and removal all return complete consistent snapshots', async () => {
  const request = client();
  const product = catalog.queryProducts({ q: 'Structured Tote' }).items[0];
  const add = await request('/api/cart/add', jsonOptions({ product_id: product.id, qty: 1 }));
  assert.equal(add.status, 200);
  const added = await add.json();
  assert.equal(added.count, 1);
  assert.equal(added.subtotal, product.price);
  assert.equal(added.items.length, 1);
  assert.equal(added.items[0].name, product.name);
  assert.ok(added.items[0].image.startsWith('/'));
  const id = added.items[0].id;

  const update = await request('/api/cart/update', jsonOptions({ id, qty: 2 }));
  assert.equal(update.status, 200);
  const updated = await update.json();
  assert.equal(updated.count, 2);
  assert.equal(updated.items[0].qty, 2);
  assert.equal(updated.subtotal, product.price * 2);
  const checkout = await request('/checkout');
  assert.equal(checkout.status, 302);
  assert.equal(checkout.headers.get('location'), '/login');

  const remove = await request('/api/cart/remove', jsonOptions({ id }));
  assert.equal(remove.status, 200);
  const empty = await remove.json();
  assert.equal(empty.count, 0);
  assert.equal(empty.subtotal, 0);
  assert.deepEqual(empty.items, []);
  const page = await (await request('/')).text();
  assert.ok(/data-minicart-footer\s+hidden/.test(page));
  assert.equal((await request('/api/cart/remove', jsonOptions({ id }))).status, 404);
});

test('variant products require an option and can then be added with the selected option', async () => {
  const request = client();
  const product = catalog.queryProducts({ q: 'Ankara Print Midi' }).items[0];
  const missing = await request('/api/cart/add', jsonOptions({ product_id: product.id }));
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).needsVariant, true);
  const variant = catalog.getProductById(product.id).variants.find(v => v.stock > 0);
  const response = await request('/api/cart/add', jsonOptions({ product_id: product.id, variant_id: variant.id, qty: 1 }));
  assert.equal(response.status, 200);
  const cart = await response.json();
  assert.equal(cart.items[0].variant, variant.title);
  assert.equal(cart.items[0].unit_price, product.price + variant.price_delta);
});

test('newsletter validates, persists once, and returns an actual reward code', async () => {
  const request = client();
  const subscribe = email => request('/newsletter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
    body: new URLSearchParams({ email }).toString(),
  });
  assert.equal((await subscribe('not-an-email')).status, 400);
  const response = await subscribe('storefront-test@example.com');
  assert.equal(response.status, 200);
  assert.match((await response.json()).message, /SUB5/);
  assert.equal((await subscribe('storefront-test@example.com')).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM newsletter WHERE email = ?').get('storefront-test@example.com').n, 1);
  assert.ok(db.prepare("SELECT id FROM coupons WHERE code = 'SUB5'").get());
});

test('saving products still requires a signed-in shopper', async () => {
  const product = catalog.queryProducts({ perPage: 1 }).items[0];
  const response = await client()('/api/wishlist/toggle', jsonOptions({ product_id: product.id }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).loginUrl, '/login');
});
