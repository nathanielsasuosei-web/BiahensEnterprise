'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const PostgresSessionStore = require('../src/db/neon-session-store');
const { migrateNeon } = require('../src/db/neon-migrate');

function createMockDb() {
  const store = {
    sessions: new Map(),
    queries: [],
  };

  const db = {
    async query(text, values = []) {
      store.queries.push({ text, values });
      if (text.includes('INSERT INTO sessions')) {
        const [sid, sessJson, expire] = values;
        store.sessions.set(sid, { sess: JSON.parse(sessJson), expire: Number(expire) });
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('UPDATE sessions SET expire = $1 WHERE sid = $2')) {
        const [expire, sid] = values;
        if (store.sessions.has(sid)) {
          store.sessions.get(sid).expire = Number(expire);
        }
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('DELETE FROM sessions WHERE sid = $1')) {
        const [sid] = values;
        store.sessions.delete(sid);
        return { rowCount: 1, rows: [] };
      }
      if (text.includes('DELETE FROM sessions WHERE expire < $1')) {
        const [now] = values;
        let count = 0;
        for (const [k, v] of store.sessions) {
          if (v.expire < Number(now)) {
            store.sessions.delete(k);
            count++;
          }
        }
        return { rowCount: count, rows: [] };
      }
      if (text.includes('DELETE FROM sessions')) {
        store.sessions.clear();
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },

    async get(text, values = []) {
      store.queries.push({ text, values });
      if (text.includes('SELECT sess, expire FROM sessions WHERE sid = $1')) {
        const [sid] = values;
        const entry = store.sessions.get(sid);
        if (!entry) return null;
        return { sess: entry.sess, expire: entry.expire };
      }
      if (text.includes('SELECT COUNT(*)::int AS n FROM sessions')) {
        const [now] = values;
        let count = 0;
        for (const [, v] of store.sessions) {
          if (v.expire >= Number(now)) count++;
        }
        return { n: count };
      }
      if (text.includes("role = 'owner'")) {
        return null;
      }
      if (text.includes('LOWER(email) = LOWER($1)')) {
        return null;
      }
      return null;
    },

    async all(text, values = []) {
      store.queries.push({ text, values });
      if (text.includes('SELECT sid, sess, expire FROM sessions')) {
        const [now] = values;
        const rows = [];
        for (const [sid, v] of store.sessions) {
          if (v.expire >= Number(now)) {
            rows.push({ sid, sess: v.sess, expire: v.expire });
          }
        }
        return rows;
      }
      return [];
    },
  };

  return { db, store };
}

test('PostgresSessionStore manages session lifecycle across set, get, touch, length and destroy', async () => {
  const { db } = createMockDb();
  const store = new PostgresSessionStore(db, { ttl: 3600000 });

  // Set
  await new Promise((resolve, reject) => {
    store.set('sess-123', { user: 'nathaniel', cart: [1, 2] }, err => err ? reject(err) : resolve());
  });

  // Get
  const retrieved = await new Promise((resolve, reject) => {
    store.get('sess-123', (err, data) => err ? reject(err) : resolve(data));
  });
  assert.deepEqual(retrieved, { user: 'nathaniel', cart: [1, 2] });

  // Length
  const len = await new Promise((resolve, reject) => {
    store.length((err, count) => err ? reject(err) : resolve(count));
  });
  assert.equal(len, 1);

  // Touch
  await new Promise((resolve, reject) => {
    store.touch('sess-123', { cookie: { maxAge: 7200000 } }, err => err ? reject(err) : resolve());
  });

  // Destroy
  await new Promise((resolve, reject) => {
    store.destroy('sess-123', err => err ? reject(err) : resolve());
  });

  const afterDestroy = await new Promise((resolve, reject) => {
    store.get('sess-123', (err, data) => err ? reject(err) : resolve(data));
  });
  assert.equal(afterDestroy, null);
});

test('PostgresSessionStore ignores expired sessions and purges them on get', async () => {
  const { db, store: rawStore } = createMockDb();
  const sessionStore = new PostgresSessionStore(db);

  // Directly insert an expired session
  rawStore.sessions.set('expired-sid', { sess: { name: 'old' }, expire: Date.now() - 5000 });

  const retrieved = await new Promise((resolve, reject) => {
    sessionStore.get('expired-sid', (err, data) => err ? reject(err) : resolve(data));
  });
  assert.equal(retrieved, null);
  assert.equal(rawStore.sessions.has('expired-sid'), false);
});

test('migrateNeon executes schema DDL, registers baseline migrations, and sets default settings', async () => {
  const { db, store } = createMockDb();
  const config = {
    owner: {
      name: 'Test Owner',
      email: 'owner@biahensenterprise.com',
      phone: '+233 24 000 0000',
      password: 'StrongOwnerPassword2026!',
    },
  };

  const result = await migrateNeon(db, config);
  assert.deepEqual(result, { ok: true });

  // Check queries executed
  const queryTexts = store.queries.map(q => q.text);
  assert.ok(queryTexts.some(t => t.includes('CREATE TABLE IF NOT EXISTS users')));
  assert.ok(queryTexts.some(t => t.includes('INSERT INTO app_migrations')));
  assert.ok(queryTexts.some(t => t.includes('INSERT INTO settings')));
  assert.ok(queryTexts.some(t => t.includes("INSERT INTO users (name, email, phone, password_hash, role")));
});
