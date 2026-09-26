'use strict';
const db = require('../db');
const settings = require('./settings');
const catalog = require('./catalog');
const cartSvc = require('./cart');
const { round2, toNumber } = require('../utils/helpers');
const { audit, notify } = require('../utils/log');

const NEXT_STATUS = {
  pending_payment: ['paid', 'cancelled'],
  paid: ['processing', 'cancelled', 'refunded'],
  processing: ['shipped', 'cancelled', 'refunded'],
  shipped: ['delivered', 'cancelled'],
  delivered: ['refunded'],
  cancelled: [],
  refunded: [],
};

function orderNumber() {
  const y = new Date().getFullYear();
  const seq = db.prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE order_number LIKE ?`
  ).get(`BX-${y}-%`).n + 1;
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `BX-${y}-${String(seq).padStart(4, '0')}${rand}`;
}

/**
 * Turn the current cart into an order. Stock is only decremented once payment
 * succeeds (or immediately for cash-on-delivery).
 */
function createFromCart(req, { shipping, payment, delivery }) {
  const cart = cartSvc.getCart(req, { region: shipping.region, method: delivery.method });
  if (cart.isEmpty) return { ok: false, message: 'Your cart is empty.' };

  const minOrder = toNumber(settings.get('min_order'), 0);
  if (cart.subtotal < minOrder) {
    return { ok: false, message: `Minimum order value is GH₵${minOrder.toFixed(2)}.` };
  }

  const number = orderNumber();
  const status = payment.method === 'cod' ? 'processing' : 'pending_payment';
  const paymentStatus = payment.method === 'cod' ? 'unpaid' : 'unpaid';

  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO orders (order_number, user_id, guest_name, guest_email, status, payment_status,
        payment_method, subtotal, discount, shipping_fee, tax, total, currency, coupon_id, coupon_code,
        ship_name, ship_phone, ship_email, ship_region, ship_city, ship_line, ship_landmark,
        delivery_method, delivery_note, admin_notes)
       VALUES (@order_number,@user_id,@guest_name,@guest_email,@status,@payment_status,@payment_method,
        @subtotal,@discount,@shipping_fee,@tax,@total,@currency,@coupon_id,@coupon_code,
        @ship_name,@ship_phone,@ship_email,@ship_region,@ship_city,@ship_line,@ship_landmark,
        @delivery_method,@delivery_note,@admin_notes)`
    ).run({
      order_number: number,
      user_id: req.user ? req.user.id : null,
      guest_name: req.user ? null : shipping.name,
      guest_email: req.user ? null : shipping.email || null,
      status,
      payment_status: paymentStatus,
      payment_method: payment.method,
      subtotal: cart.subtotal,
      discount: cart.discount,
      shipping_fee: cart.shipping,
      tax: cart.tax,
      total: cart.total,
      currency: settings.get('currency', 'GHS'),
      coupon_id: cart.coupon ? cart.coupon.id : null,
      coupon_code: cart.coupon ? cart.coupon.code : null,
      ship_name: shipping.name,
      ship_phone: shipping.phone,
      ship_email: shipping.email || (req.user ? req.user.email : null),
      ship_region: shipping.region,
      ship_city: shipping.city,
      ship_line: shipping.line,
      ship_landmark: shipping.landmark || null,
      delivery_method: delivery.method,
      delivery_note: delivery.note || null,
      admin_notes: null,
    });

    const orderId = info.lastInsertRowid;
    const insItem = db.prepare(
      `INSERT INTO order_items (order_id, product_id, variant_id, name, slug, sku, image,
        variant_title, price, qty, total) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    cart.items.forEach((i) => {
      insItem.run(
        orderId, i.product.id, i.variant ? i.variant.id : null, i.product.name, i.product.slug,
        (i.variant && i.variant.sku) || i.product.sku || null,
        i.image || i.product.image || (i.product.images_list || [])[0] || null,
        i.variant ? i.variant.title : null, i.unit_price, i.qty, i.line_total
      );
    });

    db.prepare(
      `INSERT INTO order_events (order_id, status, note, actor) VALUES (?,?,?,?)`
    ).run(orderId, status, payment.method === 'cod'
      ? 'Order placed — cash on delivery. Awaiting fulfilment.'
      : `Order placed — awaiting ${payment.method === 'momo' ? 'Mobile Money' : 'card'} payment.`, 'customer');

    if (cart.coupon) {
      db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').run(cart.coupon.id);
    }

    if (payment.method === 'cod') reserveStock(orderId);
    return orderId;
  });

  const orderId = tx();
  notify('order', 'info', `New order ${number}`,
    `${cart.count} item(s) · GH₵${cart.total.toFixed(2)} · ${payment.method === 'cod' ? 'Cash on delivery' : payment.method === 'momo' ? 'Mobile Money' : 'Card'}`,
    `/admin/orders/${orderId}`);

  return { ok: true, orderId, orderNumber: number, cart };
}

function reserveStock(orderId) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
  items.forEach((i) => catalog.adjustStock(i.product_id, i.variant_id, -i.qty));
}

function releaseStock(orderId) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
  items.forEach((i) => catalog.adjustStock(i.product_id, i.variant_id, i.qty));
}

function markSold(orderId) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
  items.forEach((i) => {
    if (!i.product_id) return;
    db.prepare('UPDATE products SET sold_count = sold_count + ? WHERE id = ?').run(i.qty, i.product_id);
  });
}

function getOrder(id) {
  const o = db.prepare(
    `SELECT o.*, u.name AS customer_name, u.email AS customer_email, u.phone AS customer_phone,
            u.id AS customer_user_id, c.code AS coupon_ref
     FROM orders o
     LEFT JOIN users u ON u.id = o.user_id
     LEFT JOIN coupons c ON c.id = o.coupon_id
     WHERE o.id = ?`
  ).get(id);
  if (!o) return null;
  o.items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(o.id);
  o.events = db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at, id').all(o.id);
  o.payments = db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC').all(o.id);
  o.item_count = o.items.reduce((s, i) => s + i.qty, 0);
  return o;
}

function getOrderByNumber(number) {
  const row = db.prepare('SELECT id FROM orders WHERE order_number = ?').get(number);
  return row ? getOrder(row.id) : null;
}

function listOrders({ q = '', status = 'all', userId = null, page = 1, perPage = 20, from = null, to = null } = {}) {
  const where = [];
  const params = {};
  if (status && status !== 'all') { where.push('o.status = @status'); params.status = status; }
  if (userId) { where.push('o.user_id = @userId'); params.userId = userId; }
  if (q) {
    where.push(`(o.order_number LIKE @q OR o.ship_name LIKE @q OR o.ship_phone LIKE @q OR COALESCE(o.ship_email,'') LIKE @q OR COALESCE(o.tracking_number,'') LIKE @q)`);
    params.q = `%${q}%`;
  }
  if (from) { where.push("date(o.placed_at) >= date(@from)"); params.from = from; }
  if (to) { where.push("date(o.placed_at) <= date(@to)"); params.to = to; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM orders o ${whereSql}`).get(params).n;
  params.limit = perPage;
  params.offset = (Math.max(1, page) - 1) * perPage;
  const rows = db.prepare(
    `SELECT o.*, u.name AS customer_name,
      (SELECT COALESCE(SUM(qty),0) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
     FROM orders o LEFT JOIN users u ON u.id = o.user_id
     ${whereSql} ORDER BY o.placed_at DESC, o.id DESC LIMIT @limit OFFSET @offset`
  ).all(params);
  return { items: rows, total, page, perPage };
}

function setStatus(orderId, status, { note = '', actor = 'admin', req = null, refundStock = false } = {}) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return { ok: false, message: 'Order not found.' };
  if (!NEXT_STATUS[order.status] || !NEXT_STATUS[order.status].includes(status)) {
    // Allow admins to force any state (real support desks need this).
    if (!['pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'].includes(status)) {
      return { ok: false, message: 'Unknown status.' };
    }
  }

  const tx = db.transaction(() => {
    if (status === 'paid' && order.payment_status !== 'paid') {
      db.prepare(`UPDATE orders SET payment_status = 'paid' WHERE id = ?`).run(orderId);
      reserveStock(orderId);
      markSold(orderId);
    }
    if (status === 'cancelled') {
      if (order.payment_status === 'paid') releaseStock(orderId);
      db.prepare(`UPDATE orders SET payment_status = CASE WHEN payment_status='paid' THEN 'refunded' ELSE payment_status END WHERE id = ?`).run(orderId);
    }
    if (status === 'refunded') {
      db.prepare(`UPDATE orders SET payment_status = 'refunded' WHERE id = ?`).run(orderId);
      if (refundStock) releaseStock(orderId);
    }
    db.prepare(`UPDATE orders SET status = @status, updated_at = datetime('now'), cancel_reason = @cancel WHERE id = @id`)
      .run({ status, id: orderId, cancel: status === 'cancelled' ? (note || null) : order.cancel_reason });
    db.prepare('INSERT INTO order_events (order_id, status, note, actor) VALUES (?,?,?,?)')
      .run(orderId, status, note || null, actor);
  });
  tx();

  if (req) audit(req, `order.status.${status}`, 'order', orderId, { from: order.status, note });
  return { ok: true, message: `Order ${order.order_number} marked as ${status.replace('_', ' ')}.` };
}

function updateOrder(orderId, patch) {
  const allowed = ['tracking_number', 'carrier', 'admin_notes', 'ship_name', 'ship_phone',
    'ship_email', 'ship_region', 'ship_city', 'ship_line', 'ship_landmark', 'delivery_method', 'delivery_note'];
  const sets = [];
  const params = { id: orderId };
  allowed.forEach((k) => {
    if (patch[k] !== undefined) { sets.push(`${k} = @${k}`); params[k] = patch[k]; }
  });
  if (!sets.length) return { ok: false, message: 'Nothing to update.' };
  db.prepare(`UPDATE orders SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = @id`).run(params);
  return { ok: true, message: 'Order updated.' };
}

function addEvent(orderId, status, note, actor = 'system') {
  db.prepare('INSERT INTO order_events (order_id, status, note, actor) VALUES (?,?,?,?)').run(orderId, status, note, actor);
}

/** Customer-facing order list for the account area. */
function ordersForUser(userId, limit = 100) {
  return db.prepare(
    `SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS lines
     FROM orders o WHERE o.user_id = ? ORDER BY o.placed_at DESC LIMIT ?`
  ).all(userId, limit);
}

function statusCounts() {
  const out = {};
  db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all().forEach((r) => { out[r.status] = r.n; });
  return out;
}

function findForTracking(number, contact) {
  const c = String(contact || '').trim().toLowerCase();
  const row = db.prepare(
    `SELECT * FROM orders WHERE order_number = ? COLLATE NOCASE
     AND (LOWER(COALESCE(ship_phone,'')) LIKE @c OR LOWER(COALESCE(ship_email,'')) LIKE @c
          OR LOWER(COALESCE(guest_email,'')) LIKE @c)`
  ).get(number, { c: `%${c.replace(/[^0-9a-z@._+-]/g, '')}%` });
  return row ? getOrder(row.id) : null;
}

module.exports = {
  createFromCart, getOrder, getOrderByNumber, listOrders, setStatus, updateOrder, addEvent,
  ordersForUser, statusCounts, findForTracking, reserveStock, releaseStock, orderNumber, NEXT_STATUS,
};
