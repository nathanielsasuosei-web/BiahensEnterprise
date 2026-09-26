'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const db = require('../../db');
const config = require('../../config');
const settings = require('../../services/settings');
const stats = require('../../services/stats');
const catalog = require('../../services/catalog');
const orders = require('../../services/orders');
const auth = require('../../middleware/auth');
const { audit } = require('../../utils/log');
const { money, round2, timeAgo } = require('../../utils/helpers');

const router = express.Router();

/* ------------------------------------------------------------- admin login */
const adminLimiter = rateLimit({
  windowMs: config.security.loginWindowMs,
  max: config.security.adminLoginMaxAttempts,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: 'Too many sign-in attempts. Wait 15 minutes and try again.',
});

router.get('/login', (req, res) => {
  if (req.user && req.user.role !== 'customer') return res.redirect('/admin');
  res.render('admin/login', {
    layout: false,
    pageTitle: `Admin sign-in | ${settings.get('store_name')}`,
    bodyClass: 'admin-login',
    error: null,
    values: { email: '' },
    demoHint: !config.isProd,
    ownerEmail: config.owner.email,
    locked: false,
  });
});

router.post('/login', adminLimiter, (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const result = auth.credentials(email, password);

  const fail = (message, code = 401) => res.status(code).render('admin/login', {
    layout: false,
    pageTitle: `Admin sign-in | ${settings.get('store_name')}`,
    bodyClass: 'admin-login',
    error: message,
    values: { email },
    demoHint: !config.isProd,
    ownerEmail: config.owner.email,
    locked: code === 429,
  });

  if (!result.ok) {
    audit(req, 'admin.login_failed', 'user', null, { email });
    return fail(result.message);
  }
  if (result.user.role === 'customer') {
    audit(req, 'admin.login_denied', 'user', result.user.id, {});
    return fail('This account does not have control-panel access. Products are uploaded by the store owner only.');
  }

  auth.login(req, result.user);
  delete req.session.adminReturn;
  audit(req, 'admin.login', 'user', result.user.id, { role: result.user.role });
  req.flash('success', `Signed in as ${result.user.role === 'owner' ? 'store owner' : 'staff'}.`);
  return res.redirect('/admin');
});

router.post('/logout', (req, res) => {
  audit(req, 'admin.logout', 'user', req.user ? req.user.id : null, {});
  auth.logout(req);
  res.clearCookie(config.session.name);
  return res.redirect('/admin/login');
});

/* ----------------------------------------------------- everything below ↓ */
router.use(auth.requireAdmin);

/* -------------------------------------------------------------- dashboard */
router.get('/', (req, res) => {
  const d = stats.dashboard();
  res.render('admin/dashboard', {
    layout: false,
    pageTitle: `Dashboard | Admin · ${settings.get('store_name')}`,
    bodyClass: 'admin admin-dashboard',
    adminNav: 'dashboard',
    data: d,
    money, round2, timeAgo,
    lowStock: catalog.lowStockProducts(8),
    pendingOrders: db.prepare(`SELECT * FROM orders WHERE status IN ('pending_payment','paid','processing') ORDER BY placed_at DESC LIMIT 8`).all(),
    notifications: db.prepare('SELECT * FROM notifications ORDER BY is_read ASC, created_at DESC LIMIT 8').all(),
    activity: db.prepare(
      `SELECT a.*, u.name AS uname FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT 10`
    ).all(),
    statusTotals: orders.statusCounts(),
    quickStats: stats.totals(),
  });
});

/* ---------------------------------------------------- sub-routers (owner) */
router.use('/products', require('./products'));
router.use(require('./catalog'));          // /categories, /brands, /slides
router.use('/orders', require('./orders'));
router.use('/customers', require('./customers'));
router.use('/marketing', require('./marketing'));
router.use('/settings', require('./settings'));
router.use('/analytics', require('./analytics'));
router.use('/system', require('./system'));
router.use('/uploads', require('./uploads'));

/* ------------------------------------------------------- global utilities */
router.post('/notifications/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1').run();
  if (req.xhr) return res.json({ ok: true });
  return res.redirect(req.get('Referrer') || '/admin');
});

router.post('/notifications/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(req.params.id);
  if (req.xhr) return res.json({ ok: true });
  return res.redirect(req.get('Referrer') || '/admin');
});

router.get('/notifications', (req, res) => {
  res.render('admin/notifications', {
    layout: false,
    pageTitle: 'Notifications | Admin',
    bodyClass: 'admin',
    adminNav: 'notifications',
    items: db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 200').all(),
  });
});

module.exports = router;
