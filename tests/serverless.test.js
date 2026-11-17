'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
const temporary = fs.mkdtempSync(path.join(root, '.cache', 'serverless-test-'));
const bundle = path.join(temporary, 'bundle');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const baked = path.join(bundle, 'data', 'biahens.sqlite');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let bakedDigest;
function environment(name, extra = {}) {
  const runtime = path.join(temporary, name);
  return {
    ...process.env, NODE_ENV: 'production', VERCEL: '1', VERCEL_URL: 'pointgh-preview.vercel.app',
    AWS_LAMBDA_FUNCTION_NAME: '', NETLIFY: '', BIAHENS_BUILD: 'false', BIAHENS_QUIET: '1',
    PUBLIC_URL: 'https://pointgh-preview.vercel.app', SESSION_SECRET: 'ServerlessTestSession01234567890123456789012345',
    DATA_DIR: '', PERSISTENT_STORAGE: 'false', DB_FILE: path.join(runtime, 'store.sqlite'),
    UPLOADS_DIR: path.join(runtime, 'uploads'), BACKUP_DIR: path.join(runtime, 'backups'), SEED_ON_BOOT: 'false',
    OWNER_NAME: 'Preview Owner', OWNER_EMAIL: 'owner@biahensenterprise.com', OWNER_PASSWORD: 'Biahens@2026', OWNER_PHONE: '+233241234567',
    PAYSTACK_SECRET_KEY: '', PAYSTACK_PUBLIC_KEY: '', PAYSTACK_WEBHOOK_SECRET: '', PAYSTACK_PREVIOUS_WEBHOOK_SECRET: '',
    RESEND_API_KEY: '', MAIL_FROM: '', OWNER_NOTIFICATION_EMAIL: '', OWNER_NOTIFICATION_WHATSAPP: '',
    WHATSAPP_ACCESS_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', WHATSAPP_ORDER_TEMPLATE: '', WHATSAPP_OWNER_OPT_IN: 'false',
    NOTIFICATION_CRON_SECRET: '', ...manifest.env, ...extra,
  };
}
function run(script, env, cwd = bundle) {
  return spawnSync(process.execPath, ['-e', `globalThis.fetch=async()=>{throw new Error('External provider HTTP forbidden in serverless tests')};${script}`],
    { cwd, env, encoding: 'utf8', timeout: 30000 });
}
function resultOf(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').pop());
}
const localServer = `
  const http=require('node:http'),handler=require('./api');
  const server=await new Promise(resolve=>{const listener=http.createServer(handler).listen(0,'127.0.0.1',()=>resolve(listener));});
  function request(route,{method='GET',body='',headers={}}={}) {
    return new Promise((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:route,method,agent:false,
        headers:{'X-Forwarded-Proto':'https',Origin:'https://pointgh-preview.vercel.app',...headers}},res=>{
        let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);
        res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));
      });req.on('error',reject);req.end(body);
    });
  }
`;

before(() => {
  // Recreate only the function's code, views and public assets, not the working
  // repository's database, environment, customer uploads or dependencies.
  fs.mkdirSync(path.join(bundle, 'scripts'), { recursive: true });
  for (const directory of ['src', 'views', 'api']) fs.cpSync(path.join(root, directory), path.join(bundle, directory), { recursive: true });
  for (const directory of ['css', 'js', 'fonts']) fs.cpSync(path.join(root, 'public', directory), path.join(bundle, 'public', directory), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/vercel-build.js'), path.join(bundle, 'scripts/vercel-build.js'));
  const built = spawnSync(process.execPath, ['scripts/vercel-build.js'], {
    cwd: bundle, env: environment('build', { DB_FILE: baked, UPLOADS_DIR: path.join(bundle, 'public', 'uploads') }), encoding: 'utf8', timeout: 30000,
  });
  assert.equal(built.status, 0, built.stderr);
  assert.ok(fs.existsSync(baked));
  bakedDigest = digest(baked);
  fs.chmodSync(baked, 0o400); // The deployed seed artifact is read-only.
});
after(() => fs.rmSync(temporary, { recursive: true, force: true }));

test('Vercel explicitly configures the same safe demo profile at function runtime as at build time', () => {
  assert.deepEqual(manifest.env, { STORE_MODE: 'demo', PAYMENT_PROVIDER: 'simulator', GATEWAY_MODE: 'test', NOTIFICATIONS_ENABLED: 'false' });
  const config = resultOf(run(`const config=require('./src/config');console.log(JSON.stringify({
    mode:config.storeMode,provider:config.payments.provider,gateway:config.payments.mode,notifications:config.notifications.enabled,ephemeral:config.ephemeralFs}));`, environment('config')));
  assert.deepEqual(config, { mode: 'demo', provider: 'simulator', gateway: 'test', notifications: false, ephemeral: true });
});

test('a production-like function cold start serves pages/assets and restores only to its writable demo path', () => {
  const env = environment('healthy');
  const output = resultOf(run(`(async()=>{${localServer}
    const home=await request('/');
    if(home.status!==200) require('./src/app'); // Surface fixture startup failures in the isolated test only.
    const health=await request('/healthz'),login=await request('/login'),checkout=await request('/checkout');
    const css=await request('/css/fashion.css'),js=await request('/js/site.js'),placeholder=await request('/img/ph.svg');
    const config=require('./src/config'),db=require('./src/db');
    const productCount=db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
    const signup=await request('/register',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({name:'Preview Test Customer',email:'preview-customer@pointgh.test',phone:'0241234567',password:'PreviewCustomer@2026',confirm_password:'PreviewCustomer@2026',terms:'1'}).toString()});
    await require('./src/services/notifications').flush();
    const result={home:home.status,preview:home.text.includes('payments are simulated and data may reset'),
      health:health.status,healthy:JSON.parse(health.text).ok,login:login.status,checkout:checkout.status,redirect:checkout.headers.location,
      css:css.status,js:js.status,placeholder:placeholder.status,signup:signup.status,
      products:productCount,file:config.db.file,permissions:require('node:fs').statSync(config.db.file).mode&0o777,integrity:db.pragma('quick_check',{simple:true}),
      jobs:db.prepare('SELECT status,provider_id FROM notification_outbox').all()};
    await new Promise(resolve=>server.close(resolve));db.close();console.log(JSON.stringify(result));
  })().catch(error=>{console.error(error);process.exit(1)});`, env));
  for (const field of ['home', 'health', 'login', 'css', 'js', 'placeholder']) assert.equal(output[field], 200, field);
  assert.equal(output.preview, true); assert.equal(output.healthy, true);
  assert.equal(output.checkout, 302); assert.equal(output.redirect, '/login'); assert.equal(output.signup, 302);
  assert.equal(output.products, 19); assert.equal(output.file, env.DB_FILE); assert.equal(output.permissions, 0o600); assert.equal(output.integrity, 'ok');
  assert.ok(output.jobs.length > 0); assert.ok(output.jobs.every(job => job.status === 'unconfigured' && !job.provider_id));
  assert.notEqual(env.DB_FILE, baked); assert.equal(digest(baked), bakedDigest);
});

test('explicit live serverless settings fail closed with a private 503, no DB creation, and no secret exposure', () => {
  const key = 'sk_live_' + crypto.randomBytes(24).toString('hex');
  const env = environment('unsafe-live', { STORE_MODE: 'live', PAYMENT_PROVIDER: 'paystack', GATEWAY_MODE: 'live', PAYSTACK_SECRET_KEY: key });
  const result = run(`(async()=>{${localServer}
    const home=await request('/'),health=await request('/healthz'),webhook=await request('/webhooks/paystack',{method:'POST',body:'{}'}),head=await request('/',{method:'HEAD'});
    await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify({home,health,webhook,head}));
  })().catch(error=>{console.error(error);process.exit(1)});`, env);
  const output = resultOf(result);
  for (const response of Object.values(output)) {
    assert.equal(response.status, 503); assert.match(response.headers['cache-control'], /no-store/);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.ok(!response.text.includes(key)); assert.ok(!response.text.includes('UNSAFE_STORE_CONFIGURATION'));
    assert.ok(!response.text.includes(env.DB_FILE));
  }
  assert.match(output.home.text, /POINTGH/); assert.equal(JSON.parse(output.health.text).ok, false); assert.equal(output.head.text, '');
  assert.match(result.stderr, /UNSAFE_STORE_CONFIGURATION/); assert.ok(!result.stderr.includes(key));
  assert.equal(fs.existsSync(env.DB_FILE), false);
});

test('an accidental live key in a demo function is rejected rather than silently used or downgraded', () => {
  const env = environment('unsafe-key', { PAYSTACK_SECRET_KEY: 'sk_live_' + crypto.randomBytes(24).toString('hex') });
  const result = run(`(async()=>{${localServer}
    const response=await request('/healthz');await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify(response));
  })().catch(error=>{console.error(error);process.exit(1)});`, env);
  assert.equal(resultOf(result).status, 503);
  assert.match(result.stderr, /Live payments and live keys are forbidden/);
  assert.ok(!result.stderr.includes(env.PAYSTACK_SECRET_KEY)); assert.equal(fs.existsSync(env.DB_FILE), false);
});

test('unavailable dependencies return a controlled response without exposing exception text or paths', () => {
  const broken = path.join(temporary, 'missing-dependency'); fs.mkdirSync(path.join(broken, 'api'), { recursive: true });
  fs.copyFileSync(path.join(root, 'api/index.js'), path.join(broken, 'api/index.js'));
  const result = run(`(async()=>{${localServer}
    const response=await request('/');await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify(response));
  })().catch(error=>{console.error(error);process.exit(1)});`, environment('missing'), broken);
  const output = resultOf(result);
  assert.equal(output.status, 503); assert.match(output.text, /Temporarily unavailable/);
  assert.match(result.stderr, /MODULE_NOT_FOUND/);
  assert.ok(!result.stderr.includes(broken)); assert.ok(!output.text.includes(broken)); assert.ok(!output.text.includes('Cannot find module'));
});

test('a live-mode Vercel build remains rejected before any database is created', () => {
  const env = environment('rejected-build', { STORE_MODE: 'live' });
  const result = spawnSync(process.execPath, ['scripts/vercel-build.js'], { cwd: bundle, env, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Vercel builds are demo-only/);
  assert.equal(fs.existsSync(env.DB_FILE), false); assert.equal(digest(baked), bakedDigest);
});
