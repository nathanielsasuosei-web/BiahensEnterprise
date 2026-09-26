'use strict';
/**
 * Minimal express-session store backed by better-sqlite3.
 * Keeps sessions across restarts without needing Redis.
 */
const session = require('express-session');
const db = require('./index');

class SQLiteStore extends session.Store {
  constructor(options = {}) {
    super();
    this.ttl = options.ttl || 1000 * 60 * 60 * 24 * 30;
    this.stmt = {
      get: db.prepare('SELECT sess, expire FROM sessions WHERE sid = ?'),
      set: db.prepare(
        'INSERT INTO sessions (sid, sess, expire) VALUES (@sid, @sess, @expire) ' +
        'ON CONFLICT(sid) DO UPDATE SET sess = @sess, expire = @expire'
      ),
      del: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?'),
      all: db.prepare('SELECT sid, sess, expire FROM sessions'),
      clear: db.prepare('DELETE FROM sessions'),
      length: db.prepare('SELECT COUNT(*) AS n FROM sessions'),
      expired: db.prepare('DELETE FROM sessions WHERE expire < ?'),
    };
    this.stmt.expired.run(Date.now());
    setInterval(() => {
      try { this.stmt.expired.run(Date.now()); } catch (_) {}
    }, 1000 * 60 * 30).unref();
  }

  get(sid, cb) {
    try {
      const row = this.stmt.get.get(sid);
      if (!row) return cb(null, null);
      if (row.expire < Date.now()) {
        this.stmt.del.run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb) {
    try {
      const maxAge = sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : this.ttl;
      this.stmt.set.run({ sid, sess: JSON.stringify(sess), expire: Date.now() + maxAge });
      cb && cb(null);
    } catch (err) { cb && cb(err); }
  }

  touch(sid, sess, cb) {
    try {
      const maxAge = sess && sess.cookie && sess.cookie.maxAge ? sess.cookie.maxAge : this.ttl;
      this.stmt.touch.run(Date.now() + maxAge, sid);
      cb && cb(null);
    } catch (err) { cb && cb(err); }
  }

  destroy(sid, cb) {
    try { this.stmt.del.run(sid); cb && cb(null); } catch (err) { cb && cb(err); }
  }

  all(cb) {
    try {
      const now = Date.now();
      const out = this.stmt.all.all()
        .filter((r) => r.expire >= now)
        .map((r) => [r.sid, JSON.parse(r.sess)]);
      cb(null, out);
    } catch (err) { cb(err); }
  }

  length(cb) {
    try { cb(null, this.stmt.length.get().n); } catch (err) { cb(err); }
  }

  clear(cb) {
    try { this.stmt.clear.run(); cb && cb(null); } catch (err) { cb && cb(err); }
  }
}

module.exports = SQLiteStore;
