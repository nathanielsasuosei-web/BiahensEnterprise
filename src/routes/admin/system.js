'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../../db');
const config = require('../../config');
const settings = require('../../services/settings');
const payments = require('../../services/payments');
const { audit } = require('../../utils/log');
const delivery = require('../../services/notifications');
const auth = require('../../middleware/auth');
const { whatsappNumber } = require('../../utils/phone');
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
      brand: payments.brand(),
      simulator: payments.isSimulator(),
      webhookUrl: `${config.publicUrl}/webhooks/paystack`,
      secretSet: !!payments.secret(),
    },
    dateFmt,
  });
});

/* ---------------------------------------------------------- mail outbox */
router.get('/mail', auth.requireOwner, (req, res) => {
  res.render('admin/mail', {
    layout: false, pageTitle: 'Order alerts & delivery log | Admin', bodyClass: 'admin admin-mail', adminNav: 'mail',
    messages: delivery.messages(), channels: delivery.configuration(),
    preferences: {
      email: settings.get('owner_notification_email'), whatsapp: settings.get('owner_notification_whatsapp'),
      optedIn: settings.get('owner_whatsapp_opt_in'),
    }, dateFmt,
  });
});

router.post('/mail/settings', auth.requireOwner, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const whatsapp = String(req.body.whatsapp || '').trim();
  if ((email && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) || (whatsapp && !whatsappNumber(whatsapp))) {
    req.flash('danger', 'Enter a valid email and a WhatsApp number with a country code, e.g. +233241234567.');
    return res.redirect('/admin/system/mail');
  }
  settings.setMany({ owner_notification_email: email, owner_notification_whatsapp: whatsapp,
    owner_whatsapp_opt_in: req.body.opt_in === '1' ? 'true' : 'false' });
  audit(req, 'notifications.settings', 'settings', null, { email: !!email, whatsapp: !!whatsapp, optedIn: req.body.opt_in === '1' });
  req.flash('success', 'Order alert preferences saved. Provider credentials must also be set on the server.');
  return res.redirect('/admin/system/mail');
});

router.post('/mail/retry', auth.requireOwner, async (req, res, next) => {
  try {
    delivery.retryPending();
    const results = await delivery.flush({ limit: 20 });
    const sent = results.filter(item => item.status === 'sent').length;
    audit(req, 'notifications.retry', 'system', null, { processed: results.length, accepted: sent });
    req.flash('info', `${sent} message(s) accepted by the delivery provider. Check the log for any setup requirements or failures.`);
    return res.redirect('/admin/system/mail');
  } catch (error) { return next(error); }
});

// Explicit, owner-authorized verification only. No check or deployment silently
// sends a test message or creates a customer order.
router.post('/mail/verify', auth.requireOwner, async (req, res, next) => {
  if (req.body.confirm !== 'SEND') return res.status(400).send('Confirm SEND to authorize delivery to your configured owner recipients.');
  const channels = delivery.configuration();
  if (!channels.email.ready || !channels.whatsapp.ready) {
    req.flash('warn', 'Both providers and owner consent must be configured before verification. Nothing was sent.');
    return res.redirect('/admin/system/mail');
  }
  try {
    const key = `verification:${require('node:crypto').randomUUID()}`;
    const text = `POINTGH delivery verification. This is a test of the configured owner alert channel, not a customer order. ${config.publicUrl}/admin`;
    const email = delivery.queueEmail({ to: channels.email.recipient, subject: 'POINTGH owner alert verification', text, key: `${key}:email` });
    const whatsapp = delivery.enqueue({ channel: 'whatsapp', key: `${key}:whatsapp`, to: channels.whatsapp.recipient,
      subject: 'POINTGH owner alert verification', text,
      payload: { parameters: ['POINTGH-VERIFY', 'Owner delivery verification', '0', 'GH₵0.00', 'Verification only — not an order', `${config.publicUrl}/admin`] } });
    const results = await delivery.flush({ ids: [email.id, whatsapp.id], limit: 2 });
    const accepted = results.filter(item => item.status === 'sent').length;
    audit(req, 'notifications.verify', 'system', null, { accepted });
    req.flash('info', `${accepted} of 2 verification messages accepted by providers. Check both recipient devices and the delivery log; acceptance is not proof of delivery.`);
    return res.redirect('/admin/system/mail');
  } catch (error) { return next(error); }
});

/* ------------------------------------------------------- health & backup */
router.get('/health', auth.requireOwner, (req, res) => {
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
    readiness: require('../../services/readiness').report(db, config),
    storagePaths: { database: config.db.file, uploads: config.uploads.dir, backups: config.backups.dir },
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

router.post('/backup', auth.requireOwner, async (req, res, next) => {
  try {
    const result = await require('../../services/backups').create();
    audit(req, 'system.backup', 'system', null, { file: result.name });
    return res.download(result.file, result.name);
  } catch (error) { return next(error); }
});

router.post('/vacuum', auth.requireOwner, (req, res) => {
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

router.post('/cache/clear', auth.requireOwner, (req, res) => {
  db.prepare(`DELETE FROM sessions WHERE expire < ?`).run(Date.now());
  db.prepare(`DELETE FROM cart_items WHERE session_id IS NOT NULL AND added_at < datetime('now','-30 days')`).run();
  require('../../middleware/context').invalidateMenu();
  audit(req, 'system.cache_clear', 'system', null, {});
  req.flash('success', 'Expired sessions and abandoned guest carts cleared.');
  return res.redirect('/admin/system/health');
});

module.exports = router;
