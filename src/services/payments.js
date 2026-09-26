'use strict';
/**
 * Stub payment gateway.
 *
 * The flow deliberately mirrors Paystack so it can be swapped for the real
 * thing without touching the storefront:
 *
 *   1. POST /checkout            ->  initialize(order)   -> reference + hosted URL
 *   2. GET  /pay/:reference      ->  hosted checkout page (card / MoMo / bank)
 *   3. POST /pay/:reference      ->  authorize()         -> success | failed
 *   4. POST /webhooks/paystack   ->  verifySignature()   -> charge.success handler
 *
 * In GATEWAY_MODE=live the same four steps hit api.paystack.com instead.
 */
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const settings = require('./settings');
const orders = require('./orders');
const { round2 } = require('../utils/helpers');
const { notify, audit } = require('../utils/log');

const MOMO_NETWORKS = [
  { id: 'mtn', label: 'MTN Mobile Money', hint: '024 / 054 / 055 / 059' },
  { id: 'telecel', label: 'Telecel Cash', hint: '020 / 050' },
  { id: 'at', label: 'AT Money', hint: '026 / 056 / 057' },
];

const BANKS = [
  { id: 'ghana-commercial', label: 'GCB Bank' },
  { id: 'absa', label: 'Absa Bank Ghana' },
  { id: 'stanbic', label: 'Stanbic Bank' },
  { id: 'ecobank', label: 'Ecobank' },
  { id: 'calbank', label: 'CalBank' },
  { id: 'fidelity', label: 'Fidelity Bank' },
  { id: 'zenith', label: 'Zenith Bank' },
];

/**
 * Deterministic test outcomes (mirrors Paystack test cards):
 *   4084 0840 8408 4081 -> success        5060 6666 6666 6666 666 -> failed
 *   4084 0999 9999 9995 -> insufficient   anything else           -> success
 */
const TEST_CARDS = {
  '4084084084084081': { status: 'success', message: 'Approved' },
  '5060666666666666666': { status: 'failed', message: 'Do not honour' },
  '4084099999999995': { status: 'failed', message: 'Insufficient funds' },
  '5060666666666666667': { status: 'failed', message: 'Incorrect CVV' },
};

function secret() {
  return settings.get('gateway_webhook_secret') || config.payments.webhookSecret;
}

function mode() {
  return settings.get('gateway_mode') || config.payments.mode || 'test';
}

function reference(prefix = 'bxp') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

/** Step 1 — initialise a charge for an order. */
function initialize(order, { method = 'card', email }) {
  const existing = db.prepare(
    `SELECT * FROM payments WHERE order_id = ? AND status = 'initiated' ORDER BY id DESC LIMIT 1`
  ).get(order.id);

  const ref = existing ? existing.reference : reference();
  const amount = round2(order.total);
  const payload = {
    email: email || order.ship_email || order.guest_email || 'customer@biahensenterprise.com',
    amount: Math.round(amount * 100), // pesewas, like Paystack
    currency: order.currency || 'GHS',
    reference: ref,
    metadata: { order_id: order.id, order_number: order.order_number, method },
  };

  if (existing) {
    db.prepare(`UPDATE payments SET raw = ?, method = ? WHERE id = ?`)
      .run(JSON.stringify(payload), method, existing.id);
  } else {
    db.prepare(
      `INSERT INTO payments (order_id, reference, gateway, method, status, amount, currency, channel, raw)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(order.id, ref, 'biahens-stub', method, 'initiated', amount, order.currency || 'GHS',
      method === 'momo' ? 'mobile_money' : method === 'cod' ? 'cod' : 'card', JSON.stringify(payload));
  }

  return {
    ok: true,
    reference: ref,
    amount,
    access_code: ref.slice(-8).toUpperCase(),
    authorization_url: `/pay/${ref}`,
    gateway: settings.get('gateway_brand'),
    mode: mode(),
  };
}

function findByReference(ref) {
  return db.prepare('SELECT * FROM payments WHERE reference = ?').get(ref);
}

/** Step 3 — authorize the payment (simulated gateway response). */
function authorize(ref, { channel = 'card', card = {}, momo = {}, bank = {}, simulate = null }) {
  const payment = findByReference(ref);
  if (!payment) return { ok: false, message: 'Payment reference not found.' };
  if (payment.status === 'success') {
    return { ok: true, alreadyPaid: true, message: 'This payment has already been completed.', orderId: payment.order_id };
  }
  const order = orders.getOrder(payment.order_id);
  if (!order) return { ok: false, message: 'Order not found.' };
  if (['cancelled', 'refunded'].includes(order.status)) return { ok: false, message: 'This order is no longer payable.' };

  let result;
  const digits = String(card.number || '').replace(/\D/g, '');
  if (channel === 'card') {
    if (!digits || digits.length < 12) return { ok: false, message: 'Enter a valid card number.' };
    if (!String(card.expiry || '').match(/^\d{2}\s*\/\s*\d{2}$/)) return { ok: false, message: 'Expiry must be MM/YY.' };
    if (!String(card.cvv || '').match(/^\d{3,4}$/)) return { ok: false, message: 'CVV must be 3 or 4 digits.' };
    result = TEST_CARDS[digits] || { status: 'success', message: 'Approved' };
  } else if (channel === 'mobile_money') {
    const number = String(momo.number || '').replace(/\D/g, '');
    if (number.length < 9) return { ok: false, message: 'Enter a valid Mobile Money number.' };
    if (!MOMO_NETWORKS.find((n) => n.id === momo.network)) return { ok: false, message: 'Choose your MoMo network.' };
    result = number.endsWith('0000')
      ? { status: 'failed', message: 'Customer declined the prompt / no response' }
      : { status: 'success', message: 'Approved' };
  } else if (channel === 'bank') {
    result = bank.id === 'decline'
      ? { status: 'failed', message: 'Bank declined the transfer' }
      : { status: 'success', message: 'Approved' };
  } else {
    result = { status: 'failed', message: 'Unsupported channel' };
  }

  if (simulate === 'fail') result = { status: 'failed', message: 'Simulated failure (test mode)' };
  if (simulate === 'success') result = { status: 'success', message: 'Simulated success (test mode)' };

  const payer = channel === 'card'
    ? `${card.brand || 'Card'} •••• ${digits.slice(-4)}`
    : channel === 'mobile_money'
      ? `${(momo.network || 'momo').toUpperCase()} ${momo.number}`
      : `Bank transfer (${(bank.id || '').replace(/-/g, ' ')})`;

  const raw = Object.assign({}, JSON.parse(payment.raw || '{}'), {
    channel, result, payer, authorized_at: new Date().toISOString(), test: mode() === 'test',
  });

  if (result.status !== 'success') {
    db.prepare(
      `UPDATE payments SET status = 'failed', channel = ?, payer = ?, raw = ?, error = ? WHERE id = ?`
    ).run(channel, payer, JSON.stringify(raw), result.message, payment.id);
    return { ok: false, status: 'failed', message: result.message, reference: ref, orderId: order.id };
  }

  db.prepare(
    `UPDATE payments SET status = 'success', channel = ?, payer = ?, last4 = ?, raw = ?,
       gateway_ref = ?, paid_at = datetime('now'), error = NULL WHERE id = ?`
  ).run(channel, payer, digits ? digits.slice(-4) : null, JSON.stringify(raw),
    `ch_${crypto.randomBytes(6).toString('hex')}`, payment.id);

  completeOrder(order, payment);
  return { ok: true, status: 'success', message: 'Payment approved', reference: ref, orderId: order.id };
}

/** Move the order to paid + emit the same webhook payload the real gateway sends. */
function completeOrder(order, payment) {
  if (order.payment_status === 'paid') return;
  db.prepare(`UPDATE orders SET payment_status = 'paid', status = CASE WHEN status = 'pending_payment' THEN 'paid' ELSE status END, updated_at = datetime('now') WHERE id = ?`).run(order.id);
  orders.reserveStock(order.id);
  orders.markSold(order.id);
  orders.addEvent(order.id, 'paid', `Payment of GH₵${round2(order.total).toFixed(2)} received via ${(payment.channel || 'card').replace('_', ' ')}.`, 'gateway');
  notify('order', 'success', `Payment received — ${order.order_number}`,
    `GH₵${round2(order.total).toFixed(2)} via ${(payment.channel || 'card').replace('_', ' ')}`,
    `/admin/orders/${order.id}`);
}

/**
 * Step 4 — webhook signature verification.
 * Paystack signs the raw request body with HMAC SHA-512 of the secret key.
 */
function verifySignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const key = secret();
  const hash = crypto.createHmac('sha512', key).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(String(signatureHeader).trim(), 'hex'));
  } catch (_) {
    return false;
  }
}

function signPayload(obj) {
  return crypto.createHmac('sha512', secret()).update(JSON.stringify(obj)).digest('hex');
}

/** Build the payload a live Paystack webhook would POST (used by the simulator). */
function buildWebhookPayload(payment) {
  return {
    event: 'charge.success',
    data: {
      id: Math.floor(Math.random() * 9e9),
      reference: payment.reference,
      amount: Math.round(payment.amount * 100),
      currency: payment.currency,
      channel: payment.channel || 'card',
      status: 'success',
      gateway_response: 'Successful',
      paid_at: new Date().toISOString(),
      customer: { email: (JSON.parse(payment.raw || '{}').email) || 'customer@example.com' },
      metadata: JSON.parse(payment.raw || '{}').metadata || {},
    },
  };
}

/** Handle an incoming webhook body (already parsed). Idempotent. */
function handleWebhook(body, req = null) {
  const event = body && body.event;
  const data = (body && body.data) || {};
  if (!data.reference) return { ok: false, ignored: true, message: 'No reference in payload.' };
  const payment = findByReference(data.reference);
  if (!payment) return { ok: false, ignored: true, message: 'Unknown reference.' };

  if (event === 'charge.success') {
    if (payment.status !== 'success') {
      db.prepare(
        `UPDATE payments SET status='success', gateway_ref=?, channel=?, paid_at=datetime('now'), raw=? WHERE id=?`
      ).run(data.id ? `ch_${data.id}` : payment.gateway_ref, data.channel || payment.channel,
        JSON.stringify(Object.assign(JSON.parse(payment.raw || '{}'), { webhook: data })), payment.id);
      const order = orders.getOrder(payment.order_id);
      if (order) completeOrder(order, payment);
    }
    if (req) audit(req, 'webhook.charge.success', 'payment', payment.id, { reference: data.reference });
    return { ok: true, message: 'Charge recorded.' };
  }

  if (event === 'charge.failed' || event === 'charge.abandoned') {
    db.prepare(`UPDATE payments SET status=?, error=? WHERE id=?`)
      .run(event === 'charge.abandoned' ? 'abandoned' : 'failed',
        (data.gateway_response || event), payment.id);
    return { ok: true, message: 'Failure recorded.' };
  }

  if (event === 'refund.processed') {
    db.prepare(`UPDATE payments SET status='refunded' WHERE id=?`).run(payment.id);
    const order = orders.getOrder(payment.order_id);
    if (order) orders.setStatus(order.id, 'refunded', { note: 'Refund processed via webhook', actor: 'gateway' });
    return { ok: true, message: 'Refund recorded.' };
  }

  return { ok: true, ignored: true, message: `Event ${event} ignored.` };
}

/** Owner marks a cash-on-delivery / offline MoMo transfer as collected. */
function markCollected(orderId, { method = 'momo', note = '', req = null } = {}) {
  const order = orders.getOrder(orderId);
  if (!order) return { ok: false, message: 'Order not found.' };
  const ref = reference('manual');
  db.prepare(
    `INSERT INTO payments (order_id, reference, gateway, method, status, amount, currency, channel, payer, paid_at, raw)
     VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),?)`
  ).run(order.id, ref, 'manual', method, 'success', round2(order.total), order.currency,
    method === 'cod' ? 'cod' : 'mobile_money', note || 'Collected by owner', JSON.stringify({ manual: true, note }));
  completeOrder(order, { channel: method === 'cod' ? 'cod' : 'mobile_money' });
  if (req) audit(req, 'payment.mark_collected', 'order', order.id, { method, note });
  return { ok: true, message: `Payment of GH₵${round2(order.total).toFixed(2)} recorded for ${order.order_number}.` };
}

function refund(orderId, { amount = null, reason = '', req = null } = {}) {
  const order = orders.getOrder(orderId);
  if (!order) return { ok: false, message: 'Order not found.' };
  if (order.payment_status !== 'paid') return { ok: false, message: 'Only paid orders can be refunded.' };
  const value = amount ? round2(Math.min(Number(amount), order.total)) : round2(order.total);
  const ref = reference('ref');
  db.prepare(
    `INSERT INTO payments (order_id, reference, gateway, method, status, amount, currency, channel, payer, paid_at, raw)
     VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),?)`
  ).run(order.id, ref, 'refund', order.payment_method, 'refunded', -value, order.currency, 'refund',
    reason || 'Refund issued', JSON.stringify({ refund: true, reason, amount: value }));
  const full = value >= order.total - 0.01;
  db.prepare(`UPDATE orders SET payment_status = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(full ? 'refunded' : 'partially_refunded', full ? 'refunded' : order.status, order.id);
  orders.addEvent(order.id, 'refunded', `Refund of GH₵${value.toFixed(2)}${reason ? ` — ${reason}` : ''}`, 'admin');
  orders.releaseStock(order.id);
  notify('order', 'warn', `Refund issued — ${order.order_number}`, `GH₵${value.toFixed(2)} refunded to customer.`, `/admin/orders/${order.id}`);
  if (req) audit(req, 'order.refund', 'order', order.id, { amount: value, reason });
  return { ok: true, message: `Refund of GH₵${value.toFixed(2)} recorded.` };
}

function listPayments({ limit = 200, status = 'all' } = {}) {
  const where = status && status !== 'all' ? 'WHERE p.status = @status' : '';
  return db.prepare(
    `SELECT p.*, o.order_number, o.ship_name FROM payments p
     LEFT JOIN orders o ON o.id = p.order_id
     ${where} ORDER BY p.created_at DESC LIMIT @limit`
  ).all({ status, limit });
}

module.exports = {
  initialize, authorize, findByReference, completeOrder, verifySignature, signPayload,
  buildWebhookPayload, handleWebhook, markCollected, refund, listPayments,
  MOMO_NETWORKS, BANKS, TEST_CARDS, mode, secret,
};
