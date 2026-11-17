'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pointgh-auth-'));
Object.assign(process.env, {
  NODE_ENV: 'test', STORE_MODE: 'demo', PAYMENT_PROVIDER: 'simulator', GATEWAY_MODE: 'test',
  DB_FILE: path.join(temporary, 'auth.sqlite'), UPLOADS_DIR: path.join(temporary, 'uploads'),
  SEED_ON_BOOT: 'false', SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  OWNER_NAME: 'Test Owner', OWNER_EMAIL: 'owner@biahensenterprise.com', OWNER_PHONE: '+233241234567', OWNER_PASSWORD: 'Biahens@2026',
  NOTIFICATIONS_ENABLED: 'false', PAYSTACK_SECRET_KEY: '', RESEND_API_KEY: '', WHATSAPP_ACCESS_TOKEN: '',
});
const realFetch = globalThis.fetch;
let server, base, db, productId;
const form = body => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
const sid = cookie => decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1)).slice(2).split('.')[0];
function client() {
  let cookie = '';
  const request = async (route, options = {}) => {
    const response = await fetch(base + route, { ...options, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...options.headers } });
    const next = response.headers.get('set-cookie');
    if (next) cookie = next.split(';')[0];
    return response;
  };
  request.cookie = () => cookie;
  return request;
}
async function register(email) {
  const request = client();
  assert.equal((await request('/register', form({ name: 'Session Test Customer', email, phone: '0241234567', password: 'SessionCustomer@2026', confirm_password: 'SessionCustomer@2026', terms: '1' }))).status, 302);
  return request;
}
before(async () => {
  require('../src/db/migrate');
  const app = require('../src/app'); db = require('../src/db');
  const category = db.prepare("SELECT id FROM categories WHERE slug = 'smartphones'").get();
  productId = Number(db.prepare("INSERT INTO products(name,slug,category_id,price,stock,status,is_active) VALUES ('Session Product','session-product',?,100,10,'active',1)").run(category.id).lastInsertRowid);
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = (url, options) => {
    if (String(url).startsWith(base + '/')) return realFetch(url, options);
    throw new Error('External HTTP is forbidden in authentication tests.');
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  if (server) await new Promise(resolve => server.close(resolve));
  if (db) db.close();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('customer and admin sign-in screens omit promotional copy, security footnotes and decorative icons', async () => {
  const forbidden = [
    'Sign in to track your orders', 'Free delivery in Greater Accra above', 'Pay with MTN MoMo',
    'Carefully checked products', 'Everything stocked by us', 'Protected by rate limiting',
    'By signing in you agree', 'Owner control panel', 'Full control of the store.',
    'Products, pricing, inventory, orders', 'Upload and price products', 'Move orders through payment',
    'Revenue, margin, category', 'Role-based access:', 'Payment ledger, webhook tester',
    'Signed-in sessions expire after inactivity', 'Products can only be uploaded by the store owner',
  ];
  const assertClean = html => {
    for (const copy of forbidden) assert.ok(!html.includes(copy), copy);
    assert.doesNotMatch(html, /<svg\b|&#(?:10003|9888|8505);|\p{Extended_Pictographic}/u);
    assert.match(html, /id="email"[^>]*required/);
    assert.match(html, /id="password"[^>]*required/);
    assert.ok(html.includes('/css/signin.css?v=1.0'));
  };
  for (const route of ['/login', '/admin/login']) {
    const request = client(), page = await request(route);
    assert.equal(page.status, 200); const html = await page.text(); assertClean(html);
    assert.ok(html.includes(`action="${route}"`));
    assert.ok(!html.includes('class="auth-side"')); assert.ok(!html.includes('class="login-left"'));
    const failed = await request(route, form({ email: 'not-registered@pointgh.test', password: 'NotARealPassword@2026' }));
    assert.equal(failed.status, 401); const errorPage = await failed.text(); assertClean(errorPage);
    assert.ok(errorPage.includes('No account found'));
  }
  const checkout = client(); await checkout('/checkout');
  const redirected = await (await checkout('/login')).text(); assertClean(redirected);
  assert.ok(redirected.includes('after signing in'));
  const registration = await (await client()('/register')).text();
  assert.ok(registration.includes('href="/terms"')); assert.ok(registration.includes('href="/privacy"'));
  assert.ok(registration.includes('name="terms"'));
  assert.equal((await client()('/css/signin.css?v=1.0')).status, 200);
});

test('customer login rotates the guest session, preserves the bag and checkout return, and rejects the old cookie', async () => {
  await register('login-session@pointgh.test');
  const request = client();
  const added = await request('/api/cart/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product_id: productId, qty: 2 }) });
  assert.equal(added.status, 200);
  await request('/login?next=/checkout');
  const oldCookie = request.cookie(), oldSid = sid(oldCookie);
  assert.ok(db.prepare('SELECT sid FROM sessions WHERE sid = ?').get(oldSid));
  const response = await request('/login', form({ email: 'login-session@pointgh.test', password: 'SessionCustomer@2026' }));
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/checkout');
  assert.notEqual(sid(request.cookie()), oldSid);
  assert.equal(db.prepare('SELECT sid FROM sessions WHERE sid = ?').get(oldSid), undefined);
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get('login-session@pointgh.test');
  assert.equal(JSON.parse(db.prepare('SELECT sess FROM sessions WHERE sid = ?').get(sid(request.cookie())).sess).userId, user.id);
  assert.equal(db.prepare('SELECT qty FROM cart_items WHERE user_id = ? AND product_id = ?').get(user.id, productId).qty, 2);
  assert.equal((await request('/checkout')).status, 200);
  const replay = await fetch(base + '/account', { headers: { Cookie: oldCookie }, redirect: 'manual' });
  assert.equal(replay.status, 302); assert.equal(replay.headers.get('location'), '/login');
});

test('administrator login also rotates the session and never grants access to the old guest cookie', async () => {
  const request = client(); await request('/admin/login');
  const oldCookie = request.cookie(), oldSid = sid(oldCookie);
  const response = await request('/admin/login', form({ email: 'owner@biahensenterprise.com', password: 'Biahens@2026' }));
  assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/admin');
  assert.notEqual(sid(request.cookie()), oldSid);
  assert.equal(db.prepare('SELECT sid FROM sessions WHERE sid = ?').get(oldSid), undefined);
  assert.equal((await request('/admin')).status, 200);
  const replay = await fetch(base + '/admin', { headers: { Cookie: oldCookie }, redirect: 'manual' });
  assert.equal(replay.status, 302); assert.equal(replay.headers.get('location'), '/admin/login');
});

test('password reset is single-use, invalidates every account session, and leaves other accounts signed in', async () => {
  const email = 'reset-session@pointgh.test';
  const first = await register(email), second = client(), control = await register('unaffected-session@pointgh.test');
  assert.equal((await second('/login', form({ email, password: 'SessionCustomer@2026' }))).status, 302);
  const cookies = [first.cookie(), second.cookie()], user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE json_extract(sess, '$.userId') = ?").get(user.id).n, 2);
  const recovery = client();
  assert.equal((await recovery('/forgot-password', form({ email }))).status, 200);
  const mail = db.prepare("SELECT text FROM notification_outbox WHERE recipient = ? AND subject LIKE 'Reset your %' ORDER BY id DESC").get(email);
  const token = mail.text.match(/\/reset-password\/([a-f0-9]{48})/)[1];
  assert.ok(db.prepare('SELECT id FROM password_resets WHERE token_hash = ?').get(crypto.createHash('sha256').update(token).digest('hex')));
  const reset = await recovery(`/reset-password/${token}`, form({ password: 'ReplacedSession@2026', confirm_password: 'ReplacedSession@2026' }));
  assert.equal(reset.status, 302); assert.equal(reset.headers.get('location'), '/login');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE json_extract(sess, '$.userId') = ?").get(user.id).n, 0);
  for (const cookie of cookies) {
    const response = await fetch(base + '/account', { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(response.status, 302); assert.equal(response.headers.get('location'), '/login');
  }
  assert.equal((await control('/account')).status, 200);
  const replay = await recovery(`/reset-password/${token}`, form({ password: 'ReplayedSession@2026', confirm_password: 'ReplayedSession@2026' }));
  assert.equal(replay.headers.get('location'), '/forgot-password');
  assert.equal((await client()('/login', form({ email, password: 'SessionCustomer@2026' }))).status, 401);
  assert.equal((await client()('/login', form({ email, password: 'ReplacedSession@2026' }))).status, 302);
  const before = db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n;
  assert.equal((await client()('/forgot-password', form({ email: 'not-registered@pointgh.test' }))).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n, before);
});

test('GET logout does not mutate authentication; POST logout destroys the session and replay access', async () => {
  const request = await register('logout-session@pointgh.test');
  const oldCookie = request.cookie(), oldSid = sid(oldCookie);
  assert.equal((await request('/logout')).status, 302);
  assert.equal((await request('/account')).status, 200);
  const response = await request('/logout', form({}));
  assert.equal(response.status, 302);
  assert.equal(db.prepare('SELECT sid FROM sessions WHERE sid = ?').get(oldSid), undefined);
  const replay = await fetch(base + '/account', { headers: { Cookie: oldCookie }, redirect: 'manual' });
  assert.equal(replay.status, 302); assert.equal(replay.headers.get('location'), '/login');
});
