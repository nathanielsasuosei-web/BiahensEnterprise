'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const settings = require('../services/settings');
const catalog = require('../services/catalog');
const cartSvc = require('../services/cart');
const orders = require('../services/orders');
const stats = require('../services/stats');
const auth = require('../middleware/auth');
const { GHANA_REGIONS, round2 } = require('../utils/helpers');
const { audit } = require('../utils/log');

const router = express.Router();
router.use(auth.requireUser);

function decorateOrder(o) {
  o.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(o.id);
  o.item_count = o.items.reduce((s, i) => s + i.qty, 0);
  o.events = db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at, id').all(o.id);
  return o;
}

/* ------------------------------------------------------------- dashboard */
router.get('/', (req, res) => {
  const userId = req.user.id;
  const myOrders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY placed_at DESC LIMIT 5').all(userId);
  myOrders.forEach((o) => {
    o.item_count = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM order_items WHERE order_id = ?').get(o.id).n;
  });
  const totals = db.prepare(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS spent FROM orders WHERE user_id = ? AND status != 'cancelled'`
  ).get(userId);
  const wishlist = cartSvc.wishlistItems(userId);
  const addresses = db.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id').all(userId);
  const reviews = db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE user_id = ?').get(userId).n;
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE user_id = ? AND status IN ('pending_payment','paid','processing','shipped')`).get(userId).n;

  const recommended = catalog.queryProducts({ sort: 'popular', perPage: 8 }).items;

  const completeness = [
    ['Name', !!req.user.name], ['Email', !!req.user.email], ['Phone', !!req.user.phone],
    ['Delivery address', addresses.length > 0], ['Avatar', !!req.user.avatar],
  ];
  const profileScore = Math.round((completeness.filter(([, ok]) => ok).length / completeness.length) * 100);

  res.render('account/dashboard', {
    pageTitle: `My Account | ${settings.get('store_name')}`,
    bodyClass: 'page-account',
    myOrders,
    totals: { orders: totals.orders || 0, spent: round2(totals.spent || 0) },
    wishlist: wishlist.slice(0, 6),
    wishlistCount: wishlist.length,
    addresses,
    reviewCount: reviews,
    pendingCount: pending,
    completeness,
    profileScore,
    recommended,
    accountNav: 'dashboard',
  });
});

/* ----------------------------------------------------------------- orders */
router.get('/orders', (req, res) => {
  const status = req.query.status || 'all';
  let list = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY placed_at DESC').all(req.user.id);
  if (status !== 'all') list = list.filter((o) => o.status === status);
  list.forEach((o) => {
    o.item_count = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM order_items WHERE order_id = ?').get(o.id).n;
    o.preview = db.prepare('SELECT name, image, qty, slug FROM order_items WHERE order_id = ? ORDER BY id LIMIT 6').all(o.id);
  });
  const counts = {};
  db.prepare('SELECT status, COUNT(*) AS n FROM orders WHERE user_id = ? GROUP BY status').all(req.user.id)
    .forEach((r) => { counts[r.status] = r.n; });

  res.render('account/orders', {
    pageTitle: `My Orders | ${settings.get('store_name')}`,
    bodyClass: 'page-account',
    orders: list,
    counts,
    status,
    accountNav: 'orders',
  });
});

router.get('/orders/:number', (req, res, next) => {
  const order = orders.getOrderByNumber(req.params.number);
  if (!order || (order.user_id !== req.user.id && req.user.role === 'customer')) return next();
  const reviewedIds = new Set(db.prepare('SELECT product_id FROM reviews WHERE user_id = ?').all(req.user.id).map((r) => r.product_id));
  const canReorder = true;
  res.render('account/order-detail', {
    pageTitle: `Order ${order.order_number} | ${settings.get('store_name')}`,
    bodyClass: 'page-account',
    order,
    reviewedIds,
    canReorder,
    accountNav: 'orders',
  });
});

router.post('/orders/:number/cancel', (req, res) => {
  const order = orders.getOrderByNumber(req.params.number);
  if (!order || order.user_id !== req.user.id) { req.flash('danger', 'Order not found.'); return res.redirect('/account/orders'); }
  if (!['pending_payment', 'paid', 'processing'].includes(order.status)) {
    req.flash('danger', 'This order has already been dispatched and can no longer be cancelled online. Call our support line.');
    return res.redirect(`/account/orders/${order.order_number}`);
  }
  orders.setStatus(order.id, 'cancelled', { note: `Cancelled by customer: ${req.body.reason || 'no reason given'}`, actor: 'customer' });
  audit(req, 'order.customer_cancel', 'order', order.id, {});
  req.flash('success', `Order ${order.order_number} was cancelled.`);
  return res.redirect(`/account/orders/${order.order_number}`);
});

router.post('/orders/:number/reorder', (req, res) => {
  const order = orders.getOrderByNumber(req.params.number);
  if (!order || order.user_id !== req.user.id) { req.flash('danger', 'Order not found.'); return res.redirect('/account/orders'); }
  let added = 0;
  order.items.forEach((i) => {
    if (!i.product_id) return;
    const product = catalog.getProductById(i.product_id);
    if (!product || product.stock <= 0) return;
    const r = cartSvc.addToCart(req, { productId: i.product_id, variantId: i.variant_id, qty: i.qty });
    if (r.ok) added += 1;
  });
  req.flash(added ? 'success' : 'info', added ? `Added ${added} available item(s) to your cart.` : 'None of those items are in stock right now.');
  return res.redirect(added ? '/cart' : `/account/orders/${order.order_number}`);
});

router.get('/orders/:number/receipt', (req, res, next) => {
  const order = orders.getOrderByNumber(req.params.number);
  if (!order || (order.user_id !== req.user.id && req.user.role === 'customer')) return next();
  return res.render('admin/partials/invoice', { layout: false, order, printView: true, pageTitle: `Receipt ${order.order_number}` });
});

/* --------------------------------------------------------------- wishlist */
router.get('/wishlist', (req, res) => {
  const items = cartSvc.wishlistItems(req.user.id);
  res.render('account/wishlist', {
    pageTitle: `My Wishlist | ${settings.get('store_name')}`,
    bodyClass: 'page-account',
    items,
    accountNav: 'wishlist',
    recommended: catalog.queryProducts({ sort: 'rating', perPage: 4 }).items,
  });
});

/* ---------------------------------------------------------------- profile */
router.get('/profile', (req, res) => {
  res.render('account/profile', {
    pageTitle: `My Profile | ${settings.get('store_name')}`,
    bodyClass: 'page-account',
    values: req.user,
    errors: {},
    regions: GHANA_REGIONS,
    lifetime: db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS spent FROM orders WHERE user_id = ? AND payment_status='paid'`).get(req.user.id),
    accountNav: 'profile',
  });
});

router.post('/profile', (req, res) => {
  const values = {
    name: (req.body.name || '').trim(),
    phone: (req.body.phone || '').replace(/[\s-]/g, ''),
    email: (req.body.email || '').trim().toLowerCase(),
  };
  const errors = {};
  if (values.name.length < 3) errors.name = 'Enter your full name.';
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(values.email)) errors.email = 'Enter a valid email address.';
  if (values.phone && !/^(\+233|0)\d{9}$/.test(values.phone)) errors.phone = 'Enter a valid Ghanaian phone number.';
  const clash = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(values.email, req.user.id);
  if (clash) errors.email = 'Another account already uses that email.';

  if (Object.keys(errors).length) {
    return res.status(400).render('account/profile', {
      pageTitle: 'My Profile', bodyClass: 'page-account', values, errors, regions: GHANA_REGIONS,
      lifetime: {}, accountNav: 'profile',
    });
  }
  db.prepare(`UPDATE users SET name = @name, phone = @phone, email = @email, updated_at = datetime('now') WHERE id = @id`)
    .run(Object.assign({ id: req.user.id }, values));
  audit(req, 'account.profile_update', 'user', req.user.id, {});
  req.flash('success', 'Your profile has been updated.');
  return res.redirect('/account/profile');
});

/* -------------------------------------------------------------- addresses */
router.get('/addresses', (req, res) => {
  res.render('account/addresses', {
    pageTitle: `My Addresses | ${settings.get('store_name')}`,
    bodyClass: 'page-account',
    addresses: db.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id').all(req.user.id),
    regions: GHANA_REGIONS,
    errors: {},
    values: {},
    accountNav: 'addresses',
  });
});

router.post('/addresses', (req, res) => {
  const v = {
    label: (req.body.label || 'Home').trim(),
    receiver: (req.body.receiver || '').trim(),
    phone: (req.body.phone || '').replace(/[\s-]/g, ''),
    region: (req.body.region || '').trim(),
    city: (req.body.city || '').trim(),
    line: (req.body.line || '').trim(),
    landmark: (req.body.landmark || '').trim(),
  };
  const errors = {};
  if (v.receiver.length < 3) errors.receiver = 'Who should the rider ask for?';
  if (!/^(\+233|0)\d{9}$/.test(v.phone)) errors.phone = 'Enter a valid Ghanaian phone number.';
  if (!GHANA_REGIONS.includes(v.region)) errors.region = 'Choose your region.';
  if (v.city.length < 2) errors.city = 'Enter your town or city.';
  if (v.line.length < 5) errors.line = 'Enter a house/street description.';

  if (Object.keys(errors).length) {
    return res.status(400).render('account/addresses', {
      pageTitle: 'My Addresses', bodyClass: 'page-account',
      addresses: db.prepare('SELECT * FROM addresses WHERE user_id = ?').all(req.user.id),
      regions: GHANA_REGIONS, errors, values: v, accountNav: 'addresses',
    });
  }
  const first = db.prepare('SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?').get(req.user.id).n === 0;
  db.prepare(
    `INSERT INTO addresses (user_id, label, receiver, phone, region, city, line, landmark, is_default)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(req.user.id, v.label, v.receiver, v.phone, v.region, v.city, v.line, v.landmark || null, first ? 1 : 0);
  audit(req, 'account.address_create', 'address', null, { region: v.region });
  req.flash('success', 'Address saved.');
  return res.redirect('/account/addresses');
});

router.post('/addresses/:id/default', (req, res) => {
  db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').run(req.user.id);
  db.prepare('UPDATE addresses SET is_default = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  req.flash('success', 'Default delivery address updated.');
  return res.redirect('/account/addresses');
});

router.post('/addresses/:id/delete', (req, res) => {
  db.prepare('DELETE FROM addresses WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  req.flash('info', 'Address removed.');
  return res.redirect('/account/addresses');
});

/* --------------------------------------------------------------- security */
router.get('/security', (req, res) => {
  res.render('account/security', {
    pageTitle: `Password & Security | ${settings.get('store_name')}`,
    bodyClass: 'page-account', error: null, success: null, accountNav: 'security',
  });
});

router.post('/security/password', (req, res) => {
  const current = req.body.current_password || '';
  const next = req.body.new_password || '';
  const confirm = req.body.confirm_password || '';
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const error = !bcrypt.compareSync(current, row.password_hash) ? 'Your current password is incorrect.'
    : next.length < 8 ? 'New password must be at least 8 characters.'
      : !/[A-Z]/.test(next) || !/[0-9]/.test(next) ? 'Use at least one capital letter and one number.'
        : next !== confirm ? 'New passwords do not match.' : null;
  if (error) {
    return res.status(400).render('account/security', {
      pageTitle: 'Password & Security', bodyClass: 'page-account', error, success: null, accountNav: 'security',
    });
  }
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(bcrypt.hashSync(next, 10), req.user.id);
  audit(req, 'account.password_change', 'user', req.user.id, {});
  return res.render('account/security', {
    pageTitle: 'Password & Security', bodyClass: 'page-account',
    error: null, success: 'Password updated successfully.', accountNav: 'security',
  });
});

/* ---------------------------------------------------------------- reviews */
router.get('/reviews', (req, res) => {
  const reviews = db.prepare(
    `SELECT r.*, p.name AS product_name, p.slug AS product_slug FROM reviews r
     JOIN products p ON p.id = r.product_id WHERE r.user_id = ? ORDER BY r.created_at DESC`
  ).all(req.user.id);
  res.render('account/reviews', {
    pageTitle: `My Reviews | ${settings.get('store_name')}`,
    bodyClass: 'page-account', reviews, accountNav: 'reviews',
  });
});

router.post('/reviews/:id/delete', (req, res) => {
  db.prepare('DELETE FROM reviews WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  req.flash('info', 'Review deleted.');
  return res.redirect('/account/reviews');
});

/* ------------------------------------------------------------- order stats */
router.get('/insights', (req, res) => {
  res.render('account/insights', {
    pageTitle: `My Spending Insights | ${settings.get('store_name')}`,
    bodyClass: 'page-account',
    series: stats.series(30).map((d) => d),
    myTotals: db.prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS spent, COALESCE(AVG(total),0) AS aov
       FROM orders WHERE user_id = ? AND payment_status = 'paid'`
    ).get(req.user.id),
    byCat: db.prepare(
      `SELECT c.name, SUM(oi.total) AS revenue, SUM(oi.qty) AS units FROM order_items oi
       JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE o.user_id = @id AND o.payment_status='paid' GROUP BY c.id ORDER BY revenue DESC LIMIT 6`
    ).all({ id: req.user.id }),
    accountNav: 'insights',
  });
});

module.exports = router;
