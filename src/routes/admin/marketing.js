'use strict';
const express = require('express');
const db = require('../../db');
const catalog = require('../../services/catalog');
const { audit, notify } = require('../../utils/log');
const { paginate, round2, dateFmt } = require('../../utils/helpers');

const router = express.Router();

/* --------------------------------------------------------------- coupons */
router.get('/coupons', (req, res) => {
  const coupons = db.prepare(
    `SELECT c.*, cat.name AS scope_name FROM coupons c
     LEFT JOIN categories cat ON cat.id = c.scope_id
     ORDER BY c.is_active DESC, c.created_at DESC`
  ).all();
  res.render('admin/marketing/coupons', {
    layout: false,
    pageTitle: 'Coupons | Admin',
    bodyClass: 'admin admin-coupons',
    adminNav: 'coupons',
    coupons,
    categories: catalog.categoryTree({ activeOnly: false }),
    brands: catalog.brandList({ activeOnly: false }),
    editing: req.query.edit ? db.prepare('SELECT * FROM coupons WHERE id = ?').get(Number(req.query.edit)) : null,
    revenueAttributed: round2(db.prepare(`SELECT COALESCE(SUM(discount),0) AS v FROM orders WHERE coupon_id IS NOT NULL`).get().v),
    ordersWithCoupon: db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE coupon_id IS NOT NULL`).get().n,
    dateFmt,
  });
});

router.post('/coupons', (req, res) => {
  const id = req.body.id ? Number(req.body.id) : null;
  const data = {
    code: String(req.body.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, ''),
    description: String(req.body.description || '').trim(),
    type: ['percent', 'fixed', 'free_shipping'].includes(req.body.type) ? req.body.type : 'percent',
    value: round2(Number(req.body.value) || 0),
    max_discount: req.body.max_discount ? round2(Number(req.body.max_discount)) : null,
    min_subtotal: round2(Number(req.body.min_subtotal) || 0),
    usage_limit: req.body.usage_limit ? Number(req.body.usage_limit) : null,
    per_user_limit: Number(req.body.per_user_limit) || 1,
    starts_at: req.body.starts_at || null,
    expires_at: req.body.expires_at || null,
    scope: ['all', 'category', 'brand', 'product'].includes(req.body.scope) ? req.body.scope : 'all',
    scope_id: req.body.scope_id ? Number(req.body.scope_id) : null,
    is_active: req.body.is_active === '1' || req.body.is_active === 'on' ? 1 : 0,
  };

  if (data.code.length < 3) { req.flash('danger', 'Coupon code must be at least 3 characters.'); return res.redirect('/admin/marketing/coupons'); }
  if (data.type !== 'free_shipping' && data.value <= 0) { req.flash('danger', 'Enter a discount value.'); return res.redirect('/admin/marketing/coupons'); }
  const clash = db.prepare('SELECT id FROM coupons WHERE code = ?').get(data.code);
  if (clash && clash.id !== id) { req.flash('danger', `Code ${data.code} already exists.`); return res.redirect('/admin/marketing/coupons'); }
  if (data.scope !== 'all') data.scope_id = data.scope_id || null; else data.scope_id = null;

  const cols = ['code', 'description', 'type', 'value', 'max_discount', 'min_subtotal', 'usage_limit',
    'per_user_limit', 'starts_at', 'expires_at', 'scope', 'scope_id', 'is_active'];
  if (id) {
    db.prepare(`UPDATE coupons SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`)
      .run(Object.assign({ id }, data));
    audit(req, 'coupon.update', 'coupon', id, data);
    req.flash('success', `Coupon ${data.code} updated.`);
  } else {
    const info = db.prepare(
      `INSERT INTO coupons (${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`
    ).run(data);
    audit(req, 'coupon.create', 'coupon', info.lastInsertRowid, data);
    req.flash('success', `Coupon ${data.code} created.`);
  }
  return res.redirect('/admin/marketing/coupons');
});

router.post('/coupons/:id/toggle', (req, res) => {
  const c = db.prepare('SELECT * FROM coupons WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.redirect('/admin/marketing/coupons');
  db.prepare('UPDATE coupons SET is_active = ? WHERE id = ?').run(c.is_active ? 0 : 1, c.id);
  audit(req, 'coupon.toggle', 'coupon', c.id, { active: !c.is_active });
  req.flash('info', `${c.code} is now ${c.is_active ? 'disabled' : 'active'}.`);
  return res.redirect(req.get('Referrer') || '/admin/marketing/coupons');
});

router.post('/coupons/:id/delete', (req, res) => {
  const c = db.prepare('SELECT * FROM coupons WHERE id = ?').get(Number(req.params.id));
  if (!c) return res.redirect('/admin/marketing/coupons');
  db.prepare('UPDATE orders SET coupon_id = NULL WHERE coupon_id = ?').run(c.id);
  db.prepare('DELETE FROM coupons WHERE id = ?').run(c.id);
  audit(req, 'coupon.delete', 'coupon', c.id, { code: c.code });
  req.flash('success', `Coupon ${c.code} deleted.`);
  return res.redirect('/admin/marketing/coupons');
});

/* --------------------------------------------------------------- reviews */
router.get('/reviews', (req, res) => {
  const page = Number(req.query.page) || 1;
  const filter = req.query.filter || 'pending';
  const q = String(req.query.q || '').trim();
  const where = [];
  const params = {};
  if (filter === 'pending') where.push('r.is_approved = 0');
  if (filter === 'approved') where.push('r.is_approved = 1');
  if (filter === 'low') where.push('r.rating <= 2');
  if (filter === 'replied') where.push('r.reply IS NOT NULL');
  if (q) { where.push('(r.author LIKE @q OR r.title LIKE @q OR r.body LIKE @q OR p.name LIKE @q)'); params.q = `%${q}%`; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM reviews r JOIN products p ON p.id = r.product_id ${whereSql}`
  ).get(params).n;
  params.limit = 20; params.offset = (Math.max(1, page) - 1) * 20;
  const rows = db.prepare(
    `SELECT r.*, p.name AS product_name, p.slug AS product_slug, p.image AS product_image
     FROM reviews r JOIN products p ON p.id = r.product_id
     ${whereSql} ORDER BY r.is_approved ASC, r.created_at DESC LIMIT @limit OFFSET @offset`
  ).all(params);

  res.render('admin/marketing/reviews', {
    layout: false,
    pageTitle: 'Reviews | Admin',
    bodyClass: 'admin admin-reviews',
    adminNav: 'reviews',
    reviews: rows,
    pager: paginate(total, page, 20),
    filter,
    q,
    counts: (() => {
      const out = {};
      db.prepare('SELECT is_approved AS k, COUNT(*) AS n FROM reviews GROUP BY is_approved').all().forEach((r) => { out[r.k ? 'approved' : 'pending'] = r.n; });
      out.low = db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE rating <= 2').get().n;
      out.all = db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n;
      out.avg = round2(db.prepare('SELECT AVG(rating) AS v FROM reviews WHERE is_approved=1').get().v || 0);
      return out;
    })(),
    dateFmt,
  });
});

router.post('/reviews/:id/approve', (req, res) => {
  const r = db.prepare('SELECT * FROM reviews WHERE id = ?').get(Number(req.params.id));
  if (!r) return res.redirect('/admin/marketing/reviews');
  db.prepare('UPDATE reviews SET is_approved = 1 WHERE id = ?').run(r.id);
  catalog.recomputeRating(r.product_id);
  audit(req, 'review.approve', 'review', r.id, {});
  req.flash('success', 'Review published.');
  return res.redirect(req.get('Referrer') || '/admin/marketing/reviews');
});

router.post('/reviews/:id/hide', (req, res) => {
  const r = db.prepare('SELECT * FROM reviews WHERE id = ?').get(Number(req.params.id));
  if (!r) return res.redirect('/admin/marketing/reviews');
  db.prepare('UPDATE reviews SET is_approved = 0 WHERE id = ?').run(r.id);
  catalog.recomputeRating(r.product_id);
  audit(req, 'review.hide', 'review', r.id, {});
  req.flash('info', 'Review hidden from the storefront.');
  return res.redirect(req.get('Referrer') || '/admin/marketing/reviews');
});

router.post('/reviews/:id/reply', (req, res) => {
  const r = db.prepare('SELECT * FROM reviews WHERE id = ?').get(Number(req.params.id));
  if (!r) return res.redirect('/admin/marketing/reviews');
  const reply = String(req.body.reply || '').slice(0, 800);
  db.prepare(`UPDATE reviews SET reply = ?, replied_at = datetime('now') WHERE id = ?`).run(reply || null, r.id);
  audit(req, 'review.reply', 'review', r.id, {});
  req.flash('success', reply ? 'Reply published.' : 'Reply removed.');
  return res.redirect(req.get('Referrer') || '/admin/marketing/reviews');
});

router.post('/reviews/:id/delete', (req, res) => {
  const r = db.prepare('SELECT * FROM reviews WHERE id = ?').get(Number(req.params.id));
  if (!r) return res.redirect('/admin/marketing/reviews');
  db.prepare('DELETE FROM reviews WHERE id = ?').run(r.id);
  catalog.recomputeRating(r.product_id);
  audit(req, 'review.delete', 'review', r.id, {});
  req.flash('success', 'Review deleted.');
  return res.redirect(req.get('Referrer') || '/admin/marketing/reviews');
});

/* ------------------------------------------------------------- newsletter */
router.get('/newsletter', (req, res) => {
  const page = Number(req.query.page) || 1;
  const total = db.prepare('SELECT COUNT(*) AS n FROM newsletter').get().n;
  const rows = db.prepare('SELECT * FROM newsletter ORDER BY created_at DESC LIMIT 25 OFFSET ?').all((page - 1) * 25);
  res.render('admin/marketing/newsletter', {
    layout: false,
    pageTitle: 'Newsletter | Admin',
    bodyClass: 'admin',
    adminNav: 'newsletter',
    subscribers: rows,
    pager: paginate(total, page, 25),
    total,
    dateFmt,
  });
});

router.post('/newsletter/:id/delete', (req, res) => {
  db.prepare('DELETE FROM newsletter WHERE id = ?').run(Number(req.params.id));
  audit(req, 'newsletter.remove', 'newsletter', req.params.id, {});
  req.flash('info', 'Subscriber removed.');
  return res.redirect('/admin/marketing/newsletter');
});

router.get('/newsletter/export.csv', (req, res) => {
  const rows = db.prepare('SELECT email, created_at FROM newsletter ORDER BY created_at DESC').all();
  const csv = ['email,created_at'].concat(rows.map((r) => `${r.email},${r.created_at}`)).join('\n');
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="biahens-subscribers.csv"');
  return res.send(csv);
});

/* ------------------------------------------------------- quick promotions */
router.get('/promotions', (req, res) => {
  res.render('admin/marketing/promotions', {
    layout: false,
    pageTitle: 'Promotions | Admin',
    bodyClass: 'admin',
    adminNav: 'promotions',
    featured: db.prepare(`SELECT * FROM products WHERE is_featured = 1 ORDER BY updated_at DESC LIMIT 30`).all().map(catalog.decorate),
    deals: db.prepare(`SELECT * FROM products WHERE compare_at_price > price AND status='active' ORDER BY (compare_at_price-price)/compare_at_price DESC LIMIT 20`).all().map(catalog.decorate),
    slow: db.prepare(`SELECT * FROM products WHERE status='active' AND sold_count = 0 ORDER BY created_at DESC LIMIT 15`).all().map(catalog.decorate),
    topMargins: db.prepare(
      `SELECT *, ROUND((price - COALESCE(cost_price, price*0.65))/price*100,1) AS margin
       FROM products WHERE status='active' ORDER BY margin DESC LIMIT 15`
    ).all().map(catalog.decorate),
  });
});

module.exports = router;
