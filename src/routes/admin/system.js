'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../../db');
const config = require('../../config');
const settings = require('../../services/settings');
const payments = require('../../services/payments');
const { audit } = require('../../utils/log');
const { outbox } = require('../../utils/log');
const { paginate, round2, dateFmt } = require('../../utils/helpers');

const router = express.Router();

/* -------------------------------------------------------------- audit log */
router.get('/audit', (req, res) => {
  const page = Number(req.query.page) || 1;
  const q = String(req.query.q || '').trim();
  const actor = req.query.actor || 'all';
  const where = [];
  const params = {};
  if (q) { where.push(`(action LIKE @q OR COALESCE(entity,'') LIKE @q OR COALESCE(meta,'') LIKE @q)`); params.q = `%${q}%`; }
  if (actor !== 'all') { where.push('actor_role = @actor'); params.actor = actor; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${whereSql}`).get(params).n;
  params.limit = 40; params.offset = (Math.max(1, page) - 1) * 40;
  const rows = db.prepare(`SELECT * FROM audit_log ${whereSql} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`).all(params);

  res.render('admin/audit', {
    layout: false,
    pageTitle: 'Audit log | Admin',
    bodyClass: 'admin admin-audit',
    adminNav: 'audit',
    entries: rows,
    pager: paginate(total, page, 40),
    filters: { q, actor },
    actors: db.prepare('SELECT DISTINCT actor_role FROM audit_log WHERE actor_role IS NOT NULL').all().map((r) => r.actor_role),
    actions: db.prepare('SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY n DESC LIMIT 40').all(),
    dateFmt,
  });
});

router.post('/audit/clear', (req, res) => {
  if (req.user.role !== 'owner') { req.flash('danger', 'Owner only.'); return res.redirect('/admin/system/audit'); }
  const n = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
  db.prepare('DELETE FROM audit_log').run();
  audit(req, 'system.audit_clear', 'system', null, { cleared: n });
  req.flash('success', `Audit log cleared (${n} entries removed).`);
  return res.redirect('/admin/system/audit');
});

/* ---------------------------------------------------------------- payments */
router.get('/payments', (req, res) => {
  const status = req.query.status || 'all';
  res.render('admin/payments', {
    layout: false,
    pageTitle: 'Payments | Admin',
    bodyClass: 'admin admin-payments',
    adminNav: 'payments',
    payments: payments.listPayments({ limit: 200, status }),
    status,
    totals: (() => {
      const out = {};
      db.prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(amount),0) AS value FROM payments GROUP BY status')
        .all().forEach((r) => { out[r.status] = { n: r.n, value: round2(r.value) }; });
      return out;
    })(),
    gateway: {
      mode: payments.mode(),
      brand: settings.get('gateway_brand'),
      webhookUrl: `${config.publicUrl}/webhooks/paystack`,
      secretSet: !!payments.secret(),
    },
    dateFmt,
  });
});

/* ---------------------------------------------------------- mail outbox */
router.get('/mail', (req, res) => {
  res.render('admin/mail', {
    layout: false,
    pageTitle: 'Email outbox | Admin',
    bodyClass: 'admin',
    adminNav: 'mail',
    messages: outbox,
    dateFmt,
  });
});

/* ------------------------------------------------------- health & backup */
router.get('/health', (req, res) => {
  const counts = {};
  ['users', 'products', 'categories', 'brands', 'orders', 'order_items', 'payments', 'reviews',
    'coupons', 'cart_items', 'wishlists', 'sessions', 'audit_log', 'notifications', 'newsletter', 'settings']
    .forEach((t) => {
      try { counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch (_) { counts[t] = 0; }
    });
  let dbSize = 0;
  try { dbSize = round2(fs.statSync(config.db.file).size / 1024); } catch (_) {}
  const uploadSize = (() => {
    let total = 0;
    const walk = (dir) => {
      fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else total += fs.statSync(p).size;
      });
    };
    try { walk(config.uploads.dir); } catch (_) {}
    return round2(total / 1024);
  })();

  res.render('admin/health', {
    layout: false,
    pageTitle: 'System health | Admin',
    bodyClass: 'admin',
    adminNav: 'health',
    counts,
    dbSize,
    uploadSize,
    node: process.version,
    uptime: Math.round(process.uptime()),
    memory: round2(process.memoryUsage().rss / 1024 / 1024),
    env: config.env,
    publicUrl: config.publicUrl,
    dateFmt,
  });
});

router.post('/backup', (req, res) => {
  // Serverless filesystems are read-only outside /tmp.
  const dir = config.ephemeralFs ? require('os').tmpdir() : path.join(config.root, 'data');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const file = path.join(dir, `backup-${Date.now()}.sqlite`);
  try {
    db.prepare('VACUUM INTO ?').run(file);
    audit(req, 'system.backup', 'system', null, { file: path.basename(file) });
    const name = `biahens-backup-${new Date().toISOString().slice(0, 10)}.sqlite`;
    res.download(file, name, () => { try { fs.unlinkSync(file); } catch (_) {} });
    return undefined;
  } catch (err) {
    req.flash('danger', `Backup failed: ${err.message}`);
    return res.redirect('/admin/system/health');
  }
});

router.post('/vacuum', (req, res) => {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.prepare('VACUUM').run();
    audit(req, 'system.vacuum', 'system', null, {});
    req.flash('success', 'Database compacted.');
  } catch (err) {
    req.flash('danger', `Vacuum failed: ${err.message}`);
  }
  return res.redirect('/admin/system/health');
});

router.post('/cache/clear', (req, res) => {
  db.prepare(`DELETE FROM sessions WHERE expire < ?`).run(Date.now());
  db.prepare(`DELETE FROM cart_items WHERE session_id IS NOT NULL AND added_at < datetime('now','-30 days')`).run();
  require('../../middleware/context').invalidateMenu();
  audit(req, 'system.cache_clear', 'system', null, {});
  req.flash('success', 'Expired sessions and abandoned guest carts cleared.');
  return res.redirect('/admin/system/health');
});

module.exports = router;
