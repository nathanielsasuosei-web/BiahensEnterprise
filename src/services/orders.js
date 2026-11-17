'use strict';
const db = require('../db');
const settings = require('./settings');
const catalog = require('./catalog');
const cartSvc = require('./cart');
const { round2, toNumber, STATUS_META, dateFmt } = require('../utils/helpers');
const { audit, notify } = require('../utils/log');
const { isGhanaPhone } = require('../utils/phone');
const notifications = require('./notifications');

// Payment/refund states are financial facts, not fulfilment dropdown options.
const NEXT_STATUS = {
  pending_payment: ['cancelled'],
  paid: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
  refunded: [],
};

class StockError extends Error {
  constructor() { super('An item is no longer available in the requested quantity. Please review your bag.'); this.code = 'STOCK_UNAVAILABLE'; }
}

function orderNumber() {
  const y = new Date().getFullYear();
  const seq = db.prepare(
    `SELECT COUNT(*) AS n FROM orders WHERE order_number LIKE ?`
  ).get(`BX-${y}-%`).n + 1;
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `BX-${y}-${String(seq).padStart(4, '0')}${rand}`;
}

/**
 * Turn the cart into an order and allocate stock in one transaction. Online
 * orders hold stock for 30 minutes; COD holds it until cancellation/fulfilment.
 */
function createFromCart(req, { shipping, payment, delivery }) {
  if (!req.user || !req.user.id) return { ok: false, code: 'AUTH_REQUIRED', message: 'Sign in or create an account before placing an order.' };
  if (!isGhanaPhone(req.user.phone)) return { ok: false, code: 'PHONE_REQUIRED', message: 'Add a valid phone number to your account before placing an order.' };
  const cart = cartSvc.getCart(req, { region: shipping.region, method: delivery.method });
  if (cart.isEmpty) return { ok: false, message: 'Your cart is empty.' };
  if (cart.dropped) return { ok: false, message: 'Some items are no longer available. Please review your bag before ordering.' };
  if (!['card', 'momo', 'cod'].includes(payment.method) || !settings.get(`${payment.method}_enabled`)) {
    return { ok: false, message: 'That payment method is currently unavailable.' };
  }

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
        payment_method, subtotal, discount, shipping_fee, tax, tax_rate, total, currency, coupon_id, coupon_code,
        ship_name, ship_phone, ship_email, ship_region, ship_city, ship_line, ship_landmark,
        delivery_method, delivery_note, admin_notes)
       VALUES (@order_number,@user_id,@guest_name,@guest_email,@status,@payment_status,@payment_method,
        @subtotal,@discount,@shipping_fee,@tax,@tax_rate,@total,@currency,@coupon_id,@coupon_code,
        @ship_name,@ship_phone,@ship_email,@ship_region,@ship_city,@ship_line,@ship_landmark,
        @delivery_method,@delivery_note,@admin_notes)`
    ).run({
      order_number: number,
      user_id: req.user.id,
      guest_name: null,
      guest_email: null,
      status,
      payment_status: paymentStatus,
      payment_method: payment.method,
      subtotal: cart.subtotal,
      discount: cart.discount,
      shipping_fee: cart.shipping,
      tax: cart.tax,
      tax_rate: cart.taxRate,
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
      `INSERT INTO order_events (order_id, status, note, actor, is_public) VALUES (?,?,?,?,1)`
    ).run(orderId, status, payment.method === 'cod'
      ? 'Order placed — cash on delivery. Awaiting fulfilment.'
      : `Order placed — awaiting ${payment.method === 'momo' ? 'Mobile Money' : 'card'} payment.`, 'customer');

    if (cart.coupon) {
      db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').run(cart.coupon.id);
    }

    reserveStock(orderId);
    if (payment.method !== 'cod') db.prepare("UPDATE orders SET stock_held_until = datetime('now','+30 minutes') WHERE id = ?").run(orderId);
    notifications.queueOwnerOrder(orderId);
    return orderId;
  });

  let orderId;
  try { orderId = tx.immediate(); } catch (error) {
    if (error.code === 'STOCK_UNAVAILABLE') return { ok: false, message: error.message };
    throw error;
  }
  notify('order', 'info', `New order ${number}`,
    `${cart.count} item(s) · GH₵${cart.total.toFixed(2)} · ${payment.method === 'cod' ? 'Cash on delivery' : payment.method === 'momo' ? 'Mobile Money' : 'Card'}`,
    `/admin/orders/${orderId}`);

  return { ok: true, orderId, orderNumber: number, cart };
}

/** Stock flags and all line updates commit together, so retries never allocate twice. */
function reserveStock(orderId) {
  return db.transaction(() => {
    const order = db.prepare('SELECT stock_state FROM orders WHERE id = ?').get(orderId);
    if (!order || order.stock_state === 'allocated') return false;
    if (order.stock_state === 'released') throw new StockError();
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    for (const item of items) {
      if (!item.product_id || !Number.isSafeInteger(item.qty) || item.qty <= 0) throw new StockError();
      const product = db.prepare(`UPDATE products SET stock = stock - ? WHERE id = ?
        AND stock >= ? AND is_active = 1 AND status = 'active'`).run(item.qty, item.product_id, item.qty);
      if (!product.changes) throw new StockError();
      if (item.variant_id) {
        const variant = db.prepare(`UPDATE variants SET stock = stock - ? WHERE id = ?
          AND product_id = ? AND stock >= ? AND is_active = 1`).run(item.qty, item.variant_id, item.product_id, item.qty);
        if (!variant.changes) throw new StockError();
      }
    }
    db.prepare("UPDATE orders SET stock_state = 'allocated' WHERE id = ?").run(orderId);
    return true;
  })();
}

function releaseStock(orderId) {
  return db.transaction(() => {
    const changed = db.prepare("UPDATE orders SET stock_state = 'released', stock_held_until = NULL WHERE id = ? AND stock_state = 'allocated'").run(orderId);
    if (!changed.changes) return false;
    for (const item of db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId)) {
      if (item.product_id) db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(item.qty, item.product_id);
      if (item.variant_id) db.prepare('UPDATE variants SET stock = stock + ? WHERE id = ? AND product_id = ?').run(item.qty, item.variant_id, item.product_id);
    }
    return true;
  })();
}

function markSold(orderId) {
  return db.transaction(() => {
    const changed = db.prepare('UPDATE orders SET sold_recorded = 1 WHERE id = ? AND sold_recorded = 0').run(orderId);
    if (!changed.changes) return false;
    for (const item of db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId)) {
      if (item.product_id) db.prepare('UPDATE products SET sold_count = sold_count + ? WHERE id = ?').run(item.qty, item.product_id);
    }
    return true;
  })();
}

/** Expiration is also checked at initialize/verify, not just by the timer. */
function expirePaymentHolds(orderId = null) {
  return db.transaction(() => {
    const rows = db.prepare(`SELECT id FROM orders WHERE payment_status = 'unpaid' AND status = 'pending_payment'
      AND stock_held_until IS NOT NULL AND datetime(stock_held_until) <= datetime('now')
      ${orderId ? 'AND id = ?' : ''}`).all(...(orderId ? [orderId] : []));
    for (const row of rows) {
      setStatus(row.id, 'cancelled', { note: 'The 30-minute payment window expired. Please place a new order if you still want these items.', actor: 'system' });
    }
    return rows.length;
  })();
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

function setStatus(orderId, status, { note = '', actor = 'admin', req = null } = {}) {
  return db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return { ok: false, message: 'Order not found.' };
    if (status === order.status) return { ok: true, message: 'Order already has this status.' };
    if (status === 'paid' || status === 'refunded') {
      return { ok: false, message: 'Payment and refund states cannot be set manually. Verify the Paystack payment, or record an actual cash-on-delivery collection.' };
    }
    if (!(NEXT_STATUS[order.status] || []).includes(status)) return { ok: false, message: 'That order status transition is not allowed.' };
    if (['processing', 'shipped', 'delivered'].includes(status) && order.payment_method !== 'cod' && order.payment_status !== 'paid') {
      return { ok: false, message: 'Verify the online payment before fulfilling this order.' };
    }
    if (status === 'cancelled') {
      releaseStock(orderId);
      // Cancellation is NOT a refund. Any captured payment stays paid and is
      // explicitly flagged for the owner to refund through the provider.
      if (order.payment_status === 'paid') notify('order', 'warn', `Refund review — ${order.order_number}`,
        'Order cancelled after payment. No refund has been sent. Review the payment in Paystack.', `/admin/orders/${orderId}`);
    }
    db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now'), cancel_reason = ? WHERE id = ?`)
      .run(status, status === 'cancelled' ? (note || null) : order.cancel_reason, orderId);
    addEvent(orderId, status, note || null, actor, { isPublic: true });
    if (req) audit(req, `order.status.${status}`, 'order', orderId, { from: order.status, note });
    return { ok: true, message: `Order ${order.order_number} marked as ${status.replace('_', ' ')}.${status === 'cancelled' && order.payment_status === 'paid' ? ' Payment has not been refunded.' : ''}` };
  })();
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

function addEvent(orderId, status, note, actor = 'system', { isPublic = false } = {}) {
  db.prepare('INSERT INTO order_events (order_id, status, note, actor, is_public) VALUES (?,?,?,?,?)')
    .run(orderId, status, note, actor, isPublic ? 1 : 0);
}

function customerEvents(order) {
  return (order.events || []).filter(event => event.is_public === 1);
}

/** Customer-facing order list for the account area. */
function ordersForUser(userId, limit = 100) {
  return db.prepare(
    `SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS lines
     FROM orders o WHERE o.user_id = ? ORDER BY o.placed_at DESC, o.id DESC LIMIT ?`
  ).all(userId, limit);
}

function statusCounts() {
  const out = {};
  db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all().forEach((r) => { out[r.status] = r.n; });
  return out;
}

/** All customer-facing order links use the same ownership check. */
function canAccess(user, order, { allowAdmin = true } = {}) {
  return !!(user && order && (order.user_id === user.id
    || (allowAdmin && ['owner', 'staff'].includes(user.role))));
}

function findForTracking(number, userId) {
  if (!userId) return null;
  const row = db.prepare('SELECT id FROM orders WHERE order_number = ? COLLATE NOCASE AND user_id = ?')
    .get(String(number || '').trim(), Number(userId));
  return row ? getOrder(row.id) : null;
}

/** Deliberately excludes addresses, payment credentials and private admin notes. */
function trackingSnapshot(order) {
  const flow = order.payment_method === 'cod' ? ['processing', 'shipped', 'delivered']
    : ['pending_payment', 'paid', 'processing', 'shipped', 'delivered'];
  const index = flow.indexOf(order.status);
  return {
    order_number: order.order_number,
    status: order.status,
    label: (STATUS_META[order.status] || {}).label || order.status,
    tone: (STATUS_META[order.status] || {}).tone || 'muted',
    payment_status: order.payment_status,
    tracking_number: order.tracking_number || '',
    carrier: order.carrier || '',
    updated_at: order.updated_at,
    steps: flow.map((status, position) => ({ status, label: STATUS_META[status].label, done: index > position, current: index === position })),
    events: customerEvents(order).slice().reverse().map(event => ({
      id: event.id, label: (STATUS_META[event.status] || {}).label || event.status,
      date: dateFmt(event.created_at), note: event.note || '',
    })),
  };
}

module.exports = {
  createFromCart, getOrder, getOrderByNumber, listOrders, setStatus, updateOrder, addEvent,
  ordersForUser, statusCounts, findForTracking, canAccess, trackingSnapshot, customerEvents, reserveStock, releaseStock, markSold, expirePaymentHolds, orderNumber, NEXT_STATUS,
};
