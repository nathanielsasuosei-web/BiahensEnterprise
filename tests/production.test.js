'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
// Within the ignored workspace, not /tmp: live startup deliberately forbids /tmp.
const temporary = fs.mkdtempSync(path.join(root, '.cache', 'persistent-test-'));
Object.assign(process.env, { NODE_ENV: 'test', STORE_MODE: 'demo', PAYMENT_PROVIDER: 'simulator', GATEWAY_MODE: 'test',
  DB_FILE: path.join(temporary, 'unit.sqlite'), UPLOADS_DIR: path.join(temporary, 'unit-uploads'), PAYSTACK_SECRET_KEY: '',
  NOTIFICATIONS_ENABLED: 'false', RESEND_API_KEY: '', WHATSAPP_ACCESS_TOKEN: '', SEED_ON_BOOT: 'false' });
const base = require('../src/config');
const { configurationErrors } = require('../src/config/production');
const { ensureOwner, assertNoDemoAccounts } = require('../src/db/owner');
// External requests are forbidden; generate this synthetic fixture only at runtime.
const TEST_PAYSTACK_KEY = 'sk_live_' + crypto.randomBytes(24).toString('hex');

function validConfig() {
  const cfg = structuredClone(base);
  Object.assign(cfg, { env: 'production', isProd: true, storeMode: 'live', isServerless: false, ephemeralFs: false, publicUrl: 'https://pointgh.store' });
  cfg.storage = { dataDir: '/var/data', persistent: true };
  cfg.db = { file: '/var/data/pointgh.sqlite', autoSeed: false };
  cfg.uploads.dir = '/var/data/uploads'; cfg.backups.dir = '/var/data/backups';
  cfg.session.secret = crypto.randomBytes(32).toString('hex');
  Object.assign(cfg.owner, { name: 'Real Owner', email: 'owner@pointgh.test', phone: '+233241234567', password: 'UniqueOwnerSecret-2026!' });
  Object.assign(cfg.payments, { provider: 'paystack', mode: 'live', modeLocked: true, secretKey: TEST_PAYSTACK_KEY, publicKey: '', webhookSecret: 'whsec_UNITTESTONLY01234567890123456789', previousWebhookSecret: '' });
  cfg.notifications.enabled = true;
  Object.assign(cfg.notifications.email, { apiKey: 're_UNITTESTONLY01234567890123456789', from: 'POINTGH <orders@pointgh.test>', owner: 'owner@pointgh.test' });
  Object.assign(cfg.notifications.whatsapp, { accessToken: 'UNITTESTONLY01234567890123456789', phoneNumberId: '1234567890', template: 'pointgh_order_alert', language: 'en', apiVersion: 'v23.0', owner: '+233241234567', optedIn: true });
  return cfg;
}
function memory() {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8'));
  require('../src/db/upgrades').applyUpgrades(db);
  require('../src/db/pointgh').applyPointghUpdate(db);
  require('../src/db/commerce').applyCommerceUpgrade(db);
  return db;
}
function childEnv(dataDir, extra = {}) {
  return { ...process.env, NODE_ENV: 'production', STORE_MODE: 'live', HOST: '0.0.0.0', DATA_DIR: dataDir, PERSISTENT_STORAGE: 'true',
    DB_FILE: path.join(dataDir, 'pointgh.sqlite'), UPLOADS_DIR: path.join(dataDir, 'uploads'), BACKUP_DIR: path.join(dataDir, 'backups'),
    SEED_ON_BOOT: 'false', PUBLIC_URL: 'https://pointgh.store', SESSION_SECRET: 'UNITTESTSESSION012345678901234567890123456789',
    OWNER_NAME: 'Production Test Owner', OWNER_EMAIL: 'owner@pointgh.test', OWNER_PHONE: '+233241234567', OWNER_PASSWORD: 'UniqueOwnerSecret-2026!',
    PAYMENT_PROVIDER: 'paystack', GATEWAY_MODE: 'live', PAYSTACK_PUBLIC_KEY: '', PAYSTACK_SECRET_KEY: TEST_PAYSTACK_KEY,
    PAYSTACK_WEBHOOK_SECRET: 'whsec_UNITTESTONLY01234567890123456789', PAYSTACK_PREVIOUS_WEBHOOK_SECRET: '',
    NOTIFICATIONS_ENABLED: 'true', RESEND_API_KEY: 're_UNITTESTONLY01234567890123456789', MAIL_FROM: 'POINTGH <orders@pointgh.test>', OWNER_NOTIFICATION_EMAIL: 'owner@pointgh.test',
    OWNER_NOTIFICATION_WHATSAPP: '+233241234567', WHATSAPP_ACCESS_TOKEN: 'UNITTESTONLY01234567890123456789', WHATSAPP_PHONE_NUMBER_ID: '1234567890',
    WHATSAPP_ORDER_TEMPLATE: 'pointgh_order_alert', WHATSAPP_TEMPLATE_LANGUAGE: 'en', WHATSAPP_API_VERSION: 'v23.0', WHATSAPP_OWNER_OPT_IN: 'true',
    VERCEL: '', AWS_LAMBDA_FUNCTION_NAME: '', NETLIFY: '', BIAHENS_BUILD: '', ...extra };
}
function run(script, env) {
  return spawnSync(process.execPath, ['-e', `globalThis.fetch=async()=>{throw new Error('External provider requests forbidden in test')};${script}`],
    { cwd: root, env, encoding: 'utf8', timeout: 30000 });
}
function jsonOutput(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test('complete live configuration passes without exposing credentials or requiring an optional public key', () => {
  const cfg = validConfig(); assert.deepEqual(configurationErrors(cfg), []);
  cfg.payments.webhookSecret = ''; // Existing legacy integrations use the API key for HMAC.
  assert.deepEqual(configurationErrors(cfg), []);
});

test('live configuration rejects ephemeral storage, weak sessions, test keys, missing alerts and unsafe origins', () => {
  const cases = [
    [cfg => { cfg.isServerless = true; cfg.ephemeralFs = true; }, /ephemeral/],
    [cfg => { cfg.storage.persistent = false; }, /PERSISTENT_STORAGE/],
    [cfg => { cfg.storage.dataDir = '/tmp/store'; }, /temporary/],
    [cfg => { cfg.db.file = '/tmp/store.sqlite'; }, /DB_FILE/],
    [cfg => { cfg.uploads.dir = '/app/public/uploads'; }, /UPLOADS_DIR/],
    [cfg => { cfg.backups.dir = '/app/backups'; }, /BACKUP_DIR/],
    [cfg => { cfg.session.secret = 'change-me-biahens-enterprise-session-secret'; }, /SESSION_SECRET/],
    [cfg => { cfg.publicUrl = 'http://localhost:3000'; }, /PUBLIC_URL/],
    [cfg => { cfg.publicUrl = 'https://pointgh.store/path'; }, /PUBLIC_URL/],
    [cfg => { cfg.publicUrl = 'https://user:password@pointgh.store'; }, /PUBLIC_URL/],
    [cfg => { cfg.payments.secretKey = 'sk_test_UNITTESTONLY01234567890123456789'; }, /PAYSTACK_SECRET_KEY/],
    [cfg => { cfg.payments.provider = 'simulator'; }, /PAYMENT_PROVIDER/],
    [cfg => { cfg.notifications.enabled = false; }, /NOTIFICATIONS_ENABLED/],
    [cfg => { cfg.notifications.email.apiKey = ''; }, /RESEND_API_KEY/],
    [cfg => { cfg.notifications.email.owner = ''; }, /OWNER_NOTIFICATION_EMAIL/],
    [cfg => { cfg.notifications.whatsapp.optedIn = false; }, /OPT_IN/],
    [cfg => { cfg.db.autoSeed = true; }, /seeding/],
  ];
  for (const [change, expected] of cases) {
    const cfg = validConfig(); change(cfg);
    const output = configurationErrors(cfg).join('\n');
    assert.match(output, expected);
    for (const secret of [cfg.payments.secretKey, cfg.notifications.whatsapp.accessToken, cfg.notifications.email.apiKey].filter(Boolean)) assert.ok(!output.includes(secret));
  }
  const demo = validConfig(); demo.storeMode = 'demo'; assert.match(configurationErrors(demo).join(' '), /forbidden in a demo/);
});

test('live owner bootstrap is one-time, uses private credentials, and never overwrites or promotes an existing account', () => {
  const db = memory(), cfg = validConfig();
  try {
    assert.equal(ensureOwner(db, cfg).created, true);
    let owner = db.prepare('SELECT * FROM users').get();
    assert.equal(owner.email, cfg.owner.email); assert.equal(owner.role, 'owner');
    const hash = owner.password_hash;
    cfg.owner.password = 'AChangedEnvironmentDoesNotResetAccounts@2026';
    cfg.owner.email = 'different@pointgh.test';
    assert.equal(ensureOwner(db, cfg).created, false);
    owner = db.prepare('SELECT * FROM users').get(); assert.equal(owner.password_hash, hash); assert.equal(owner.email, 'owner@pointgh.test');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    db.prepare("UPDATE users SET role = 'customer'").run(); cfg.owner.email = owner.email;
    assert.throws(() => ensureOwner(db, cfg), /will not be promoted/);
    assert.equal(db.prepare('SELECT role FROM users').get().role, 'customer');
  } finally { db.close(); }
});

test('live owner setup rejects default/short credentials and marked or legacy demo data', () => {
  const db = memory(), cfg = validConfig();
  try {
    cfg.owner.password = 'Biahens@2026'; assert.throws(() => ensureOwner(db, cfg), /First live startup/);
    cfg.owner.password = 'UniqueOwnerSecret-2026!'; cfg.owner.phone = ''; assert.throws(() => ensureOwner(db, cfg), /First live startup/);
    db.prepare("INSERT INTO app_migrations (name) VALUES ('dataset.demo.v1')").run();
    assert.throws(() => assertNoDemoAccounts(db, cfg), /demo dataset/);
    db.prepare("DELETE FROM app_migrations WHERE name='dataset.demo.v1'").run();
    db.prepare("INSERT INTO audit_log (action,meta) VALUES ('old.seed','{\"seeded\":true}')").run();
    assert.throws(() => assertNoDemoAccounts(db, cfg), /demo dataset/);
    db.prepare('DELETE FROM audit_log').run();
    const order = db.prepare("INSERT INTO orders(order_number,ship_name,ship_phone,ship_region,ship_city,ship_line) VALUES ('DEMO-PAYMENT','Demo','0241234567','Greater Accra','Accra','Test Address')").run().lastInsertRowid;
    db.prepare("INSERT INTO payments(order_id,reference,gateway,amount) VALUES (?,'SIMULATED-PAYMENT','simulator',10)").run(order);
    assert.throws(() => assertNoDemoAccounts(db, cfg), /demo dataset/);
  } finally { db.close(); }
});

test('fresh live startup refuses unsafe config before creating a runtime database', () => {
  const data = path.join(temporary, 'rejected');
  const result = run("require('./src/db/bootstrap').bootstrap()", childEnv(data, { VERCEL: '1' }));
  assert.notEqual(result.status, 0); assert.match(result.stderr, /ephemeral\/serverless/);
  assert.equal(fs.existsSync(path.join(data, 'pointgh.sqlite')), false);
  for (const value of [TEST_PAYSTACK_KEY, 'UniqueOwnerSecret-2026!']) assert.ok(!result.stderr.includes(value));
});

test('live demo seed and reset commands fail without deleting existing merchant data', () => {
  const data = path.join(temporary, 'protected'); const env = childEnv(data);
  jsonOutput(run("const db=require('./src/db/bootstrap').bootstrap();db.prepare(\"INSERT INTO products (name,slug,price,stock) VALUES ('Merchant Product','merchant-product',10,5)\").run(); console.log(JSON.stringify({products:1}));db.close();", env));
  const seeded = run("require('./src/db/seed').main({fresh:true})", env);
  assert.notEqual(seeded.status, 0); assert.match(seeded.stderr, /seeding\/reset is forbidden/);
  const result = jsonOutput(run("const db=require('./src/db/bootstrap').bootstrap();console.log(JSON.stringify({products:db.prepare('SELECT COUNT(*) AS n FROM products').get().n,orders:db.prepare('SELECT COUNT(*) AS n FROM orders').get().n}));db.close();", env));
  assert.deepEqual(result, { products: 1, orders: 0 });
});

test('accounts, sessions, orders, uploads and both alert jobs survive a fresh live process', () => {
  const data = path.join(temporary, 'durable'); const env = childEnv(data);
  const first = jsonOutput(run(`
    const fs=require('fs'),path=require('path'),cfg=require('./src/config'),db=require('./src/db/bootstrap').bootstrap();
    const owner=db.prepare("SELECT * FROM users WHERE role='owner'").get();
    db.prepare("UPDATE users SET name='Persisted Owner Edit' WHERE id=?").run(owner.id);
    db.prepare("INSERT INTO sessions (sid,sess,expire) VALUES ('durable-session',?,?)").run(JSON.stringify({userId:owner.id,cookie:{maxAge:3600000}}),Date.now()+3600000);
    const info=db.prepare("INSERT INTO orders (order_number,user_id,payment_method,status,ship_name,ship_phone,ship_email,ship_region,ship_city,ship_line,total) VALUES ('PERSIST-001',?,'cod','processing',?,?,?,?,?,?,10)").run(owner.id,owner.name,owner.phone,owner.email,'Greater Accra','Accra','12 Test Street');
    db.prepare("INSERT INTO order_items (order_id,name,price,qty,total) VALUES (?,'Persistent Item',10,1,10)").run(info.lastInsertRowid);
    require('./src/services/notifications').queueOwnerOrder(info.lastInsertRowid);
    fs.writeFileSync(path.join(cfg.uploads.dir,'persistence-test.txt'),'persistent upload');
    console.log(JSON.stringify({users:db.prepare('SELECT COUNT(*) AS n FROM users').get().n,products:db.prepare('SELECT COUNT(*) AS n FROM products').get().n,orders:db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,alerts:db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n}));
    db.pragma('wal_checkpoint(TRUNCATE)');db.close();`, env));
  assert.deepEqual(first, { users: 1, products: 0, orders: 1, alerts: 2 });
  const second = jsonOutput(run(`
    const fs=require('fs'),path=require('path'),cfg=require('./src/config'),db=require('./src/db/bootstrap').bootstrap();
    console.log(JSON.stringify({owner:db.prepare("SELECT name FROM users WHERE role='owner'").get().name,
      session:JSON.parse(db.prepare("SELECT sess FROM sessions WHERE sid='durable-session'").get().sess).userId,
      orders:db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,alerts:db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n,
      queued:db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE status='queued'").get().n,
      upload:fs.readFileSync(path.join(cfg.uploads.dir,'persistence-test.txt'),'utf8'),
      journal:db.pragma('journal_mode',{simple:true})}));db.close();`, { ...env, OWNER_PASSWORD: 'ChangedButIgnoredOwnerPassword2026!' }));
  assert.equal(second.owner, 'Persisted Owner Edit'); assert.equal(second.session, 1);
  assert.equal(second.orders, 1); assert.equal(second.alerts, 2); assert.equal(second.queued, 2);
  assert.equal(second.upload, 'persistent upload'); assert.equal(second.journal, 'wal');
});

test('online backups include committed WAL, pass integrity checks, remain private and never contain a copied demo DB', () => {
  const data = path.join(temporary, 'durable'); const env = childEnv(data);
  const saved = jsonOutput(run(`
    const db=require('./src/db/bootstrap').bootstrap();
    db.prepare("UPDATE orders SET admin_notes='Committed WAL backup marker' WHERE order_number='PERSIST-001'").run();
    require('./src/services/backups').create().then(result=>{console.log(JSON.stringify(result));db.close();}).catch(()=>process.exit(1));`, env));
  assert.ok(saved.file.startsWith(path.join(data, 'backups') + path.sep));
  assert.match(saved.name, /^pointgh-\d{8}T\d{9}Z-[a-f0-9]{8}\.sqlite$/);
  assert.equal(fs.statSync(saved.file).mode & 0o777, 0o600);
  const backup = new Database(saved.file, { readonly: true });
  try {
    assert.equal(backup.pragma('quick_check', { simple: true }), 'ok');
    assert.equal(backup.prepare("SELECT admin_notes FROM orders WHERE order_number='PERSIST-001'").get().admin_notes, 'Committed WAL backup marker');
    assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n, 2);
    assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM products').get().n, 0);
  } finally { backup.close(); }
});

test('readiness is read-only local evidence and never reports unverified providers as delivered or paid', () => {
  const data = path.join(temporary, 'durable'); const env = childEnv(data);
  const result = run("require('./scripts/production-check')", env);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /NOT VERIFIED: Paystack live verification/);
  assert.match(result.stdout, /NOT VERIFIED: Email provider acceptance/);
  assert.match(result.stdout, /NOT VERIFIED: WhatsApp provider acceptance/);
  assert.match(result.stdout, /no provider requests/);
  assert.ok(!result.stdout.includes(env.PAYSTACK_SECRET_KEY));
  const db = new Database(path.join(data, 'pointgh.sqlite'), { readonly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE status='queued'").get().n, 2); }
  finally { db.close(); }
});

test('legacy commerce upgrade is additive, idempotent and does not move historic inventory or rewrite financial totals', () => {
  const db = new Database(':memory:');
  try {
    let schema = fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8');
    db.exec(schema);
    db.prepare("INSERT INTO products(name,slug,price,stock) VALUES ('Historic','historic',10,50)").run();
    const insert = db.prepare("INSERT INTO orders(order_number,status,payment_status,payment_method,ship_name,ship_phone,ship_region,ship_city,ship_line,total,tax) VALUES (?,?,?,?,'Historic','0241234567','Greater Accra','Accra','Old Address',10,0)");
    insert.run('OLD-PAID','paid','paid','card'); insert.run('OLD-COD','processing','unpaid','cod'); insert.run('OLD-PENDING','pending_payment','unpaid','momo'); insert.run('OLD-CANCELLED','cancelled','unpaid','cod');
    const before = db.prepare('SELECT order_number,total,tax FROM orders ORDER BY id').all();
    const upgrade = require('../src/db/commerce').applyCommerceUpgrade; upgrade(db); upgrade(db);
    assert.deepEqual(db.prepare('SELECT stock,price FROM products').get(), { stock: 50, price: 10 });
    assert.deepEqual(db.prepare('SELECT order_number,total,tax FROM orders ORDER BY id').all(), before);
    assert.deepEqual(db.prepare('SELECT stock_state,sold_recorded FROM orders ORDER BY id').all(), [
      { stock_state: 'allocated', sold_recorded: 1 }, { stock_state: 'allocated', sold_recorded: 0 },
      { stock_state: 'none', sold_recorded: 0 }, { stock_state: 'released', sold_recorded: 0 },
    ]);
  } finally { db.close(); }
});

// Real local HTTP requests exercise cookie signing and proxy-aware secure flags;
// the run() helper still rejects every external fetch in these child processes.
const localHttpApp = `
  const http=require('node:http'),app=require('./src/app'),db=require('./src/db'),config=require('./src/config');
  const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
  function request(route,{method='GET',cookie='',form}={}) {
    return new Promise((resolve,reject)=>{
      const body=form?new URLSearchParams(form).toString():'';
      const headers={'X-Forwarded-Proto':'https',Origin:config.publicUrl,...(cookie?{Cookie:cookie}:{})};
      if(form){headers['Content-Type']='application/x-www-form-urlencoded';headers['Content-Length']=Buffer.byteLength(body);}
      const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,headers,agent:false},res=>{
        let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);
        res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));
      });req.on('error',reject);req.end(body);
    });
  }
`;

test('an actually authenticated secure cookie survives a new live process with the same disk and session secret', () => {
  const data = path.join(temporary, 'http-cookie'), env = childEnv(data);
  const first = jsonOutput(run(`(async()=>{${localHttpApp}
    const signedIn=await request('/admin/login',{method:'POST',form:{email:config.owner.email,password:config.owner.password}});
    const setCookie=signedIn.headers['set-cookie'][0],cookie=setCookie.split(';')[0];
    const account=await request('/account',{cookie});
    const fs=require('node:fs');
    const files=[config.db.file,config.db.file+'-wal',config.db.file+'-shm'].filter(file=>fs.existsSync(file));
    const result={cookie,login:signedIn.status,account:account.status,owner:account.text.includes(config.owner.email),
      secure:/; Secure(?:;|$)/.test(setCookie),httpOnly:/; HttpOnly(?:;|$)/.test(setCookie),
      synchronous:db.pragma('synchronous',{simple:true}),permissions:files.map(file=>fs.statSync(file).mode&0o777)};
    await new Promise(resolve=>server.close(resolve));db.close();console.log(JSON.stringify(result));
  })().catch(error=>{console.error(error);process.exit(1)});`, env));
  assert.equal(first.login, 302); assert.equal(first.account, 200); assert.equal(first.owner, true);
  assert.equal(first.secure, true); assert.equal(first.httpOnly, true);
  assert.equal(first.synchronous, 2); assert.ok(first.permissions.length >= 2);
  assert.ok(first.permissions.every(mode => mode === 0o600));
  const second = jsonOutput(run(`(async()=>{${localHttpApp}
    const account=await request('/account',{cookie:process.env.PERSISTED_TEST_COOKIE});
    const result={status:account.status,owner:account.text.includes(config.owner.email)};
    await new Promise(resolve=>server.close(resolve));db.close();console.log(JSON.stringify(result));
  })().catch(error=>{console.error(error);process.exit(1)});`, { ...env, PERSISTED_TEST_COOKIE: first.cookie, OWNER_PASSWORD: '' }));
  assert.deepEqual(second, { status: 200, owner: true });
  const rotated = jsonOutput(run(`(async()=>{${localHttpApp}
    const account=await request('/account',{cookie:process.env.PERSISTED_TEST_COOKIE});
    const result={status:account.status,redirect:account.headers.location};
    await new Promise(resolve=>server.close(resolve));db.close();console.log(JSON.stringify(result));
  })().catch(error=>{console.error(error);process.exit(1)});`, { ...env, PERSISTED_TEST_COOKIE: first.cookie, SESSION_SECRET: 'UNITTESTROTATEDSESSION01234567890123456789012345' }));
  assert.deepEqual(rotated, { status: 302, redirect: '/login' });
});

test('an offline backup and matching uploads restore to a separate live data directory without changing the source', () => {
  const source = path.join(temporary, 'durable'), restored = path.join(temporary, 'restored');
  const backup = path.join(source, 'backups', fs.readdirSync(path.join(source, 'backups')).filter(name => name.endsWith('.sqlite')).sort().pop());
  const tables = ['users', 'orders', 'order_items', 'sessions', 'notification_outbox'];
  const original = new Database(backup, { readonly: true });
  let expected;
  try { expected = Object.fromEntries(tables.map(table => [table, original.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
  finally { original.close(); }
  fs.mkdirSync(restored, { mode: 0o700 });
  fs.copyFileSync(backup, path.join(restored, 'pointgh.sqlite'));
  fs.cpSync(path.join(source, 'uploads'), path.join(restored, 'uploads'), { recursive: true });
  const result = jsonOutput(run(`
    const fs=require('node:fs'),path=require('node:path'),config=require('./src/config'),db=require('./src/db/bootstrap').bootstrap();
    console.log(JSON.stringify({integrity:db.pragma('integrity_check',{simple:true}),
      note:db.prepare("SELECT admin_notes FROM orders WHERE order_number='PERSIST-001'").get().admin_notes,
      upload:fs.readFileSync(path.join(config.uploads.dir,'persistence-test.txt'),'utf8')}));db.close();`, childEnv(restored, { OWNER_PASSWORD: '' })));
  assert.deepEqual(result, { integrity: 'ok', note: 'Committed WAL backup marker', upload: 'persistent upload' });
  for (const file of [path.join(restored, 'pointgh.sqlite'), path.join(source, 'pointgh.sqlite')]) {
    const checked = new Database(file, { readonly: true });
    try { for (const table of tables) assert.deepEqual(checked.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), expected[table], `${table}: ${path.basename(path.dirname(file))}`); }
    finally { checked.close(); }
  }
});
