'use strict';
/**
 * Express-session store backed by Neon / PostgreSQL.
 * Allows sessions to persist across stateless Vercel Serverless Function instances.
 */
const session = require('express-session');

class PostgresSessionStore extends session.Store {
  constructor(db, options = {}) {
    super();
    if (!db || typeof db.query !== 'function') {
      throw new TypeError('A Neon/PostgreSQL database instance is required.');
    }
    this.db = db;
    this.ttl = options.ttl || 1000 * 60 * 60 * 24 * 30; // 30 days default
  }

  get(sid, cb) {
    this.db.get('SELECT sess, expire FROM sessions WHERE sid = $1', [sid])
      .then(row => {
        if (!row) return cb(null, null);
        if (Number(row.expire) < Date.now()) {
          this.destroy(sid, () => cb(null, null));
          return;
        }
        const sessionData = typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess;
        cb(null, sessionData);
      })
      .catch(err => cb(err));
  }

  set(sid, sess, cb) {
    const maxAge = sess && sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : this.ttl;
    const expire = Date.now() + maxAge;
    const sessJson = JSON.stringify(sess);

    this.db.query(
      `INSERT INTO sessions (sid, sess, expire)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
      [sid, sessJson, expire]
    )
      .then(() => cb && cb(null))
      .catch(err => cb && cb(err));
  }

  touch(sid, sess, cb) {
    const maxAge = sess && sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : this.ttl;
    const expire = Date.now() + maxAge;

    this.db.query('UPDATE sessions SET expire = $1 WHERE sid = $2', [expire, sid])
      .then(() => cb && cb(null))
      .catch(err => cb && cb(err));
  }

  destroy(sid, cb) {
    this.db.query('DELETE FROM sessions WHERE sid = $1', [sid])
      .then(() => cb && cb(null))
      .catch(err => cb && cb(err));
  }

  all(cb) {
    const now = Date.now();
    this.db.all('SELECT sid, sess, expire FROM sessions WHERE expire >= $1', [now])
      .then(rows => {
        const out = rows.map(r => [
          r.sid,
          typeof r.sess === 'string' ? JSON.parse(r.sess) : r.sess,
        ]);
        cb(null, out);
      })
      .catch(err => cb(err));
  }

  length(cb) {
    const now = Date.now();
    this.db.get('SELECT COUNT(*)::int AS n FROM sessions WHERE expire >= $1', [now])
      .then(row => cb(null, row ? Number(row.n) : 0))
      .catch(err => cb(err));
  }

  clear(cb) {
    this.db.query('DELETE FROM sessions')
      .then(() => cb && cb(null))
      .catch(err => cb && cb(err));
  }

  pruneExpired() {
    return this.db.query('DELETE FROM sessions WHERE expire < $1', [Date.now()]);
  }
}

module.exports = PostgresSessionStore;
