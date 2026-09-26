'use strict';
const express = require('express');
const db = require('../../db');
const catalog = require('../../services/catalog');
const cartSvc = require('../../services/cart');
const { audit } = require('../../utils/log');
const { paginate, round2, dateFmt } = require('../../utils/helpers');

const router = express.Router();
const PER_PAGE = 20;

router.get('/', (req, res) => {
  const page = Number(req.query.page) || 1;
  const q = String(req.query.q || '').trim();
  const sort = req.query.sort || 'recent';
  const segment = req.query.segment || 'all';

  const where = ["u.role = 'customer'"];
  const params = {};
  if (q) {
    where.push(`(u.name LIKE @q OR u.email LIKE @q OR COALESCE(u.phone,'') LIKE @q)`);
    params.q = `%${q}%`;
  }
  if (segment === 'blocked') where.push('u.is_blocked = 1');
  if (segment === 'vip') where.push('spent >= 5000');
  if (segment === 'new') where.push("date(u.created_at) >= date('now','-30 days')");
  if (segment === 'inactive') where.push("date(u.last_login_at) < date('now','-60 days') OR u.last_login_at IS NULL");

  const orderSql = {
    recent: 'u.created_at DESC',
    name: 'u.name ASC',
    spent: 'spent DESC',
    orders: 'orders DESC',
    last_login: 'u.last_login_at DESC',
  }[sort] || 'u.created_at DESC';

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT u.id, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders,
              (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.user_id = u.id AND o.payment_status='paid') AS spent
       FROM users u ${whereSql}
     )`
  ).get(params).n;

  params.limit = PER_PAGE;
  params.offset = (Math.max(1, page) - 1) * PER_PAGE;
  const rows = db.prepare(
    `SELECT u.*, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders,
        (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.user_id = u.id AND o.payment_status='paid') AS spent,
        (SELECT MAX(o.placed_at) FROM orders o WHERE o.user_id = u.id) AS last_order_at,
        (SELECT COUNT(*) FROM reviews r WHERE r.user_id = u.id) AS reviews
     FROM users u ${whereSql} ORDER BY ${orderSql} LIMIT @limit OFFSET @offset`
  ).all(params).map((r) => ({ ...r, spent: round2(r.spent || 0) }));

  res.render('admin/customers/index', {
    layout: false,
    pageTitle: 'Customers | Admin',
    bodyClass: 'admin admin-customers',
    adminNav: 'customers',
    customers: rows,
    pager: paginate(total, page, PER_PAGE),
    filters: { q, sort, segment },
    summary: (() => {
      const s = db.prepare(
        `SELECT COUNT(*) AS total, SUM(is_blocked) AS blocked,
           SUM(CASE WHEN date(created_at) >= date('now','-30 days') THEN 1 ELSE 0 END) AS new30
         FROM users WHERE role = 'customer'`
      ).get();
      s.revenue = round2(db.prepare(`SELECT COALESCE(SUM(total),0) AS v FROM orders WHERE payment_status='paid' AND status NOT IN ('cancelled','refunded')`).get().v);
      s.repeat = db.prepare(
        `SELECT COUNT(*) AS n FROM (SELECT user_id FROM orders WHERE user_id IS NOT NULL GROUP BY user_id HAVING COUNT(*) > 1)`
      ).get().n;
      return s;
    })(),
    dateFmt,
  });
});

router.get('/export.csv', (req, res) => {
  const rows = db.prepare(
    `SELECT u.id, u.name, u.email, u.phone, u.is_blocked, u.created_at, u.last_login_at,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders,
      (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.user_id = u.id AND o.payment_status='paid') AS spent
     FROM users u WHERE u.role = 'customer' ORDER BY spent DESC`
  ).all();
  const headers = Object.keys(rows[0] || { id: '' });
  const csv = [headers.join(',')].concat(rows.map((r) => headers.map((h) => {
    const v = r[h] == null ? '' : String(r[h]);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(','))).join('\n');
  audit(req, 'customer.export_csv', 'user', null, { rows: rows.length });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="biahens-customers-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.send(csv);
});

router.get('/:id', (req, res, next) => {
  const customer = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!customer || customer.role !== 'customer') return next();

  const customerOrders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY placed_at DESC').all(customer.id);
  customerOrders.forEach((o) => {
    o.item_count = db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM order_items WHERE order_id = ?').get(o.id).n;
  });

  res.render('admin/customers/show', {
    layout: false,
    pageTitle: `${customer.name} | Customers · Admin`,
    bodyClass: 'admin admin-customer-detail',
    adminNav: 'customers',
    customer,
    orders: customerOrders,
    addresses: db.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id').all(customer.id),
    wishlist: cartSvc.wishlistItems(customer.id),
    reviews: db.prepare(
      `SELECT r.*, p.name AS product_name, p.slug AS product_slug FROM reviews r
       JOIN products p ON p.id = r.product_id WHERE r.user_id = ? ORDER BY r.created_at DESC`
    ).all(customer.id),
    stats: (() => {
      const s = db.prepare(
        `SELECT COUNT(*) AS orders,
          COALESCE(SUM(CASE WHEN payment_status='paid' AND status NOT IN ('cancelled','refunded') THEN total ELSE 0 END),0) AS spent,
          COALESCE(AVG(CASE WHEN payment_status='paid' THEN total END),0) AS aov,
          MAX(placed_at) AS last_order,
          COALESCE(SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END),0) AS cancelled,
          COALESCE(SUM(CASE WHEN status='refunded' THEN 1 ELSE 0 END),0) AS refunded
         FROM orders WHERE user_id = ?`
      ).get(customer.id);
      return { ...s, spent: round2(s.spent), aov: round2(s.aov) };
    })(),
    topCategories: db.prepare(
      `SELECT c.name, SUM(oi.total) AS revenue, SUM(oi.qty) AS units FROM order_items oi
       JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE o.user_id = @id AND o.payment_status='paid' GROUP BY c.id ORDER BY revenue DESC LIMIT 5`
    ).all({ id: customer.id }),
    notes: db.prepare(
      `SELECT * FROM audit_log WHERE entity = 'user' AND entity_id = ? ORDER BY created_at DESC LIMIT 30`
    ).all(String(customer.id)),
    dateFmt,
  });
  return undefined;
});

router.post('/:id/block', (req, res, next) => {
  const customer = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!customer) return next();
  const block = customer.is_blocked ? 0 : 1;
  db.prepare(`UPDATE users SET is_blocked = ?, updated_at = datetime('now') WHERE id = ?`).run(block, customer.id);
  audit(req, block ? 'customer.block' : 'customer.unblock', 'user', customer.id, { reason: req.body.reason || '' });
  req.flash(block ? 'warn' : 'success', block ? `${customer.name} can no longer sign in.` : `${customer.name} can sign in again.`);
  return res.redirect(req.get('Referrer') || `/admin/customers/${customer.id}`);
});

router.post('/:id/note', (req, res, next) => {
  const customer = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!customer) return next();
  const note = String(req.body.note || '').slice(0, 500);
  if (!note) { req.flash('danger', 'Write something first.'); return res.redirect(`/admin/customers/${customer.id}`); }
  audit(req, 'customer.note', 'user', customer.id, { note });
  req.flash('success', 'Internal note saved.');
  return res.redirect(`/admin/customers/${customer.id}`);
});

router.post('/:id/delete', (req, res, next) => {
  const customer = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!customer) return next();
  const orderCount = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?').get(customer.id).n;
  if (orderCount && req.body.force !== '1') {
    req.flash('warn', `${customer.name} has ${orderCount} order(s). Deleting removes the link to those orders. Block the account instead, or confirm to delete.`);
    return res.redirect(`/admin/customers/${customer.id}`);
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(customer.id);
  audit(req, 'customer.delete', 'user', customer.id, { name: customer.name });
  req.flash('success', `${customer.name} was deleted.`);
  return res.redirect('/admin/customers');
});

module.exports = router;
