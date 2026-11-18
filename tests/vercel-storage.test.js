'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNeonDatabase, createFromEnvironment } = require('../src/db/neon');
const { createBlobStorage } = require('../src/services/blob-storage');

function poolFixture() {
  const log = [];
  const client = {
    async query(text, values) { log.push(['client', text, values]); return { rows: [{ value: 7 }], rowCount: 1 }; },
    release() { log.push(['release']); },
  };
  const pool = {
    async query(text, values) { log.push(['pool', text, values]); return { rows: [{ value: 3 }], rowCount: 1 }; },
    async connect() { log.push(['connect']); return client; },
    async end() { log.push(['end']); },
  };
  return { pool, log };
}

test('Neon database wrapper routes reads and writes through the pool', async () => {
  const { pool, log } = poolFixture();
  const db = createNeonDatabase({ pool });
  assert.deepEqual(await db.get('SELECT $1::int AS value', [1]), { value: 3 });
  assert.deepEqual(await db.all('SELECT $1::int AS value', [2]), [{ value: 3 }]);
  assert.deepEqual(await db.run('UPDATE items SET x = $1', [4]), { changes: 1, rows: [{ value: 3 }] });
  assert.equal(log.filter(entry => entry[0] === 'pool').length, 3);
  await db.close();
  assert.ok(log.some(entry => entry[0] === 'end'));
});

test('Neon transaction pins every query to one client and commits only after awaited work', async () => {
  const { pool, log } = poolFixture();
  const db = createNeonDatabase({ pool });
  const result = await db.transaction(async input => {
    const row = await db.get('SELECT $1::int AS value', [input]);
    return row.value;
  })(19);
  assert.equal(result, 7);
  assert.deepEqual(log.map(entry => entry[1]).filter(Boolean), ['BEGIN', 'SELECT $1::int AS value', 'COMMIT']);
  assert.equal(log.filter(entry => entry[0] === 'pool').length, 0);
  assert.deepEqual(log.at(-1), ['release']);
});

test('Neon transaction rolls back and releases its client after an error', async () => {
  const { pool, log } = poolFixture();
  const db = createNeonDatabase({ pool });
  const expected = new Error('write failed');
  await assert.rejects(db.transaction(async () => { throw expected; })(), error => error === expected);
  assert.ok(log.some(entry => entry[1] === 'ROLLBACK'));
  assert.deepEqual(log.at(-1), ['release']);
});

test('Neon environment factory fails closed when no database URL is configured', () => {
  assert.throws(() => createFromEnvironment({}), { code: 'NEON_DATABASE_URL_REQUIRED' });
});

test('Neon environment factory accepts NEON_DATABASE_URL, POSTGRES_URL, or DATABASE_URL', async () => {
  const dummy = 'postgres://user:pass@ep-test.neon.tech/neondb';
  const db1 = createFromEnvironment({ NEON_DATABASE_URL: dummy });
  assert.equal(typeof db1.query, 'function');
  const db2 = createFromEnvironment({ POSTGRES_URL: dummy });
  assert.equal(typeof db2.query, 'function');
  const db3 = createFromEnvironment({ DATABASE_URL: dummy });
  assert.equal(typeof db3.query, 'function');
  await db1.close();
  await db2.close();
  await db3.close();
});

test('Blob adapter uploads public assets with explicit content metadata and returns provider URLs', async () => {
  const calls = [];
  const blob = createBlobStorage({
    token: 'secret-test-token',
    async put(path, body, options) { calls.push(['put', path, body, options]); return { url: 'https://blob.example/image.jpg', pathname: path }; },
    async del(urls, options) { calls.push(['del', urls, options]); },
  });
  const body = Buffer.from('image bytes');
  assert.deepEqual(await blob.put('products/item.jpg', body, { contentType: 'image/jpeg' }), {
    url: 'https://blob.example/image.jpg', pathname: 'products/item.jpg',
  });
  assert.deepEqual(calls[0], ['put', 'products/item.jpg', body, {
    access: 'public', addRandomSuffix: false, cacheControlMaxAge: 31536000,
    contentType: 'image/jpeg', token: 'secret-test-token',
  }]);
  await blob.delete('https://blob.example/image.jpg');
  assert.deepEqual(calls[1], ['del', ['https://blob.example/image.jpg'], { token: 'secret-test-token' }]);
});

test('Blob adapter rejects missing secrets, unsafe names and non-HTTPS provider responses', async () => {
  assert.throws(() => createBlobStorage({ put() {}, del() {}, token: '' }), { code: 'BLOB_READ_WRITE_TOKEN_REQUIRED' });
  const blob = createBlobStorage({ token: 'secret', async put() { return { url: 'http://not-secure.test/a' }; }, async del() {} });
  await assert.rejects(blob.put('../outside', Buffer.from('x')));
  await assert.rejects(blob.put('a/b', Buffer.from('x')));
  await assert.rejects(blob.delete('file:///tmp/a'));
});
