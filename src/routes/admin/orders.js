'use strict';
const express = require('express');
const db = require('../../db');
const settings = require('../../services/settings');
const orders = require('../../services/orders');
const payments = require('../../services/payments');
const { audit, notify, sendMail } = require('../../utils/log');
const { paginate, round2, toNumber, GHANA_REGIONS, STATUS_META, dateFmt } = require('../../utils/helpers');

const router = express.Router();

const PER_PAGE = 20;

router.get('/', (req, res) => {
  const page = Number(req.query.page) || 1;
  const status = req.query.status || 'all';
  const pay = req.query.payment || 'all';
  const q = String(req.query.q || '').trim();
  const from = req.query.from || '';
  const to = req.query.to || '';
  const method = req.query.method || 'all';

  const result = orders.listOrders({ q, status, page, perPage: PER_PAGE, from, to });
  let items = result.items;
  if (pay !== 'all') items = items.filter((o) => o.payment_status === pay);
  if (method !== 'all') items = items.filter((o) => o.payment_method === method);

  const totals = db.prepare(
    `SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS n FROM orders
     WHERE payment_status = 'paid' AND status NOT IN ('cancelled','refunded')`
  ).get();

  res.render('admin/orders/index', {
    layout: false,
    pageTitle: 'Orders | Admin',
    bodyClass: 'admin admin-orders',
    adminNav: 'orders',
    orders: items,
    pager: paginate(result.total, page, PER_PAGE),
    filters: { status, payment: pay, q, from, to, method },
    statusCounts: orders.statusCounts(),
    paymentCounts: (() => {
      const out = {};
      db.prepare('SELECT payment_status AS s, COUNT(*) AS n FROM orders GROUP BY payment_status').all()
        .forEach((r) => { out[r.s] = r.n; });
      return out;
    })(),
    totals,
    STATUS_META,
    dateFmt,
    regions: GHANA_REGIONS,
  });
});

router.get('/export.csv', (req, res) => {
  const rows = db.prepare(
    `SELECT o.order_number, o.placed_at, o.status, o.payment_status, o.payment_method,
            o.ship_name, o.ship_phone, o.ship_email, o.ship_region, o.ship_city,
            o.subtotal, o.discount, o.shipping_fee, o.total, o.coupon_code, o.tracking_number, o.carrier
     FROM orders o ORDER BY o.placed_at DESC`
  ).all();
  const headers = Object.keys(rows[0] || { order_number: '' });
  const csv = [headers.join(',')].concat(rows.map((r) => headers.map((h) => {
    const v = r[h] == null ? '' : String(r[h]);
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(','))).join('\n');
  audit(req, 'order.export_csv', 'order', null, { rows: rows.length });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="biahens-orders-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.send(csv);
});

router.get('/:id', (req, res, next) => {
  const order = orders.getOrder(Number(req.params.id));
  if (!order) return next();
  const customer = order.user_id ? db.prepare('SELECT * FROM users WHERE id = ?').get(order.user_id) : null;
  const history = customer ? db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS spent FROM orders WHERE user_id = ? AND id != ?`
  ).get(customer.id, order.id) : { n: 0, spent: 0 };

  res.render('admin/orders/show', {
    layout: false,
    pageTitle: `Order ${order.order_number} | Admin`,
    bodyClass: 'admin admin-order-detail',
    adminNav: 'orders',
    order,
    customer,
    history,
    nextStatuses: orders.NEXT_STATUS[order.status] || [],
    allStatuses: Object.keys(STATUS_META),
    momoNetworks: payments.MOMO_NETWORKS,
    regions: GHANA_REGIONS,
    STATUS_META,
    dateFmt,
  });
  return undefined;
});

router.get('/:id/invoice', (req, res, next) => {
  const order = orders.getOrder(Number(req.params.id));
  if (!order) return next();
  return res.render('admin/partials/invoice', {
    layout: false,
    order,
    printView: true,
    pageTitle: `Invoice ${order.order_number} | Admin`,
  });
});

router.post('/:id/status', (req, res, next) => {
  const order = orders.getOrder(Number(req.params.id));
  if (!order) return next();
  const status = String(req.body.status || '');
  const note = String(req.body.note || '').slice(0, 500);
  const result = orders.setStatus(order.id, status, { note, actor: `${req.user.name} (admin)`, req });

  if (result.ok && req.body.notify_customer === '1' && (order.ship_email || order.guest_email)) {
    sendMail({
      to: order.ship_email || order.guest_email,
      subject: `Order ${order.order_number} — ${STATUS_META[status] ? STATUS_META[status].label : status}`,
      text: `Hello ${order.ship_name},\n\nYour order ${order.order_number} is now: ${status.replace(/_/g, ' ')}.\n`
        + `${note ? `\nNote from our team: ${note}\n` : ''}\n`
        + `Track it any time: ${settings.get('store_name')} → /order/${order.order_number}\n\n`
        + `Thank you for shopping with ${settings.get('store_name')}.`,
    });
  }
  if (result.ok && status === 'cancelled') {
    // stock was already released for paid orders inside setStatus
    notify('order', 'warn', `Order cancelled — ${order.order_number}`, note || 'No reason recorded.', `/admin/orders/${order.id}`);
  }
  req.flash(result.ok ? 'success' : 'danger', result.message);
  return res.redirect(`/admin/orders/${order.id}`);
});

router.post('/:id/update', (req, res, next) => {
  const order = orders.getOrder(Number(req.params.id));
  if (!order) return next();
  const patch = {};
  ['tracking_number', 'carrier', 'admin_notes', 'ship_name', 'ship_phone', 'ship_email',
    'ship_region', 'ship_city', 'ship_line', 'ship_landmark', 'delivery_method', 'delivery_note']
    .forEach((k) => { if (req.body[k] !== undefined) patch[k] = String(req.body[k]).slice(0, 300); });
  const result = orders.updateOrder(order.id, patch);
  audit(req, 'order.update', 'order', order.id, patch);
  if (result.ok && (patch.tracking_number && patch.tracking_number !== order.tracking_number)) {
    orders.addEvent(order.id, 'shipped', `Tracking number ${patch.tracking_number}${patch.carrier ? ` (${patch.carrier})` : ''} added.`, 'admin');
  }
  req.flash(result.ok ? 'success' : 'danger', result.message);
  return res.redirect(`/admin/orders/${order.id}`);
});

router.post('/:id/event', (req, res, next) => {
  const order = orders.getOrder(Number(req.params.id));
  if (!order) return next();
  const note = String(req.body.note || '').slice(0, 500);
  if (!note) { req.flash('danger', 'Write a note first.'); return res.redirect(`/admin/orders/${order.id}`); }
  orders.addEvent(order.id, order.status, note, `${req.user.name} (admin)`);
  audit(req, 'order.note', 'order', order.id, { note });
  req.flash('success', 'Note added to the order timeline.');
  return res.redirect(`/admin/orders/${order.id}`);
});

/* ------------------------------------------------- payment reconciliation */
router.post('/:id/collect', (req, res, next) => {
  const order = orders.getOrder(Number(req.params.id));
  if (!order) return next();
  if (order.payment_status === 'paid') {
    req.flash('info', 'This order is already marked as paid.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  const result = payments.markCollected(order.id, {
    method: ['momo', 'cod', 'card'].includes(req.body.method) ? req.body.method : order.payment_method,
    note: String(req.body.note || '').slice(0, 300),
    req,
  });
  req.flash(result.ok ? 'success' : 'danger', result.message);
  return res.redirect(`/admin/orders/${order.id}`);
});

router.post('/:id/refund', (req, res, next) => {
  const order = orders.getOrder(Number(req.params.id));
  if (!order) return next();
  const result = payments.refund(order.id, {
    amount: req.body.amount ? toNumber(req.body.amount) : null,
    reason: String(req.body.reason || '').slice(0, 300),
    req,
  });
  req.flash(result.ok ? 'success' : 'danger', result.message);
  return res.redirect(`/admin/orders/${order.id}`);
});

/* ----------------------------------------------------------- bulk actions */
router.post('/bulk', (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  const action = req.body.action;
  if (!ids.length) { req.flash('danger', 'Select at least one order.'); return res.redirect('/admin/orders'); }
  if (action === 'mark_processing') {
    ids.forEach((id) => {
      const o = orders.getOrder(id);
      if (o && ['paid', 'pending_payment'].includes(o.status)) orders.setStatus(id, 'processing', { actor: 'admin bulk', req });
    });
  } else if (action === 'mark_shipped') {
    ids.forEach((id) => {
      const o = orders.getOrder(id);
      if (o && o.payment_status === 'paid' && ['paid', 'processing'].includes(o.status)) orders.setStatus(id, 'shipped', { actor: 'admin bulk', req });
    });
  } else if (action === 'cancel') {
    ids.forEach((id) => orders.setStatus(id, 'cancelled', { note: 'Cancelled in bulk by admin', actor: 'admin bulk', req }));
  } else if (action === 'print') {
    return res.redirect(`/admin/orders?print=${ids.join(',')}`);
  }
  audit(req, `order.bulk.${action}`, 'order', ids.join(','), { count: ids.length });
  req.flash('success', `${action.replace(/_/g, ' ')} applied to ${ids.length} order(s).`);
  return res.redirect('/admin/orders');
});

/* ------------------------------------------------------------- fulfilment */
router.get('/fulfilment/picklist', (req, res) => {
  const rows = db.prepare(
    `SELECT o.order_number, o.placed_at, o.ship_name, o.ship_region, o.ship_city, o.delivery_method,
            oi.name, oi.variant_title, oi.qty, oi.sku
     FROM orders o JOIN order_items oi ON oi.order_id = o.id
     WHERE o.status IN ('paid','processing') ORDER BY o.placed_at ASC`
  ).all();
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', 'inline; filename="picklist.txt"');
  let current = null;
  const lines = rows.map((r) => {
    let out = '';
    if (r.order_number !== current) {
      current = r.order_number;
      out += `\n=== ${r.order_number} · ${dateFmt(r.placed_at, 'full')} · ${r.ship_name} (${r.ship_city}, ${r.ship_region}) · ${r.delivery_method}\n`;
    }
    out += `   ${String(r.qty).padStart(3)}× ${r.name}${r.variant_title ? ` [${r.variant_title}]` : ''}${r.sku ? ` (${r.sku})` : ''}\n`;
    return out;
  });
  return res.send(`BIAHENS ENTERPRISE — WAREHOUSE PICK LIST\nGenerated ${new Date().toLocaleString('en-GB')}\n${lines.join('')}`);
});

module.exports = router;
