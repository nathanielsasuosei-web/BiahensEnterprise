'use strict';
/** Paystack-hosted checkout. The local simulator is isolated to demo/test mode. */
const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const settings = require('./settings');
const orders = require('./orders');
const paystack = require('./paystack');
const notifications = require('./notifications');
const { round2 } = require('../utils/helpers');
const { notify, audit } = require('../utils/log');

const MOMO_NETWORKS = [
  { id: 'mtn', label: 'MTN Mobile Money', hint: '024 / 054 / 055 / 059' },
  { id: 'telecel', label: 'Telecel Cash', hint: '020 / 050' },
  { id: 'at', label: 'AT Money', hint: '026 / 056 / 057' },
];
const BANKS = [
  { id: 'ghana-commercial', label: 'GCB Bank' }, { id: 'absa', label: 'Absa Bank Ghana' },
  { id: 'stanbic', label: 'Stanbic Bank' }, { id: 'ecobank', label: 'Ecobank' },
  { id: 'calbank', label: 'CalBank' }, { id: 'fidelity', label: 'Fidelity Bank' }, { id: 'zenith', label: 'Zenith Bank' },
];
const TEST_CARDS = {
  '4084084084084081': { status: 'success', message: 'Approved' },
  '5060666666666666666': { status: 'failed', message: 'Do not honour' },
  '4084099999999995': { status: 'failed', message: 'Insufficient funds' },
  '5060666666666666667': { status: 'failed', message: 'Incorrect CVV' },
};
const initializing = new Map();
const subunits = value => Math.round(round2(value) * 100);
const validReceiptId = id => typeof id === 'number' ? Number.isSafeInteger(id) && id > 0 : typeof id === 'string' && /^[1-9]\d*$/.test(id);
const reference = (prefix = 'PTGH') => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(10).toString('hex')}`;
function provider() { return config.payments.provider; }
function mode() { return config.payments.modeLocked ? config.payments.mode : settings.get('gateway_mode') || config.payments.mode; }
function isSimulator() { return config.storeMode === 'demo' && provider() === 'simulator' && mode() === 'test'; }
function brand() { return provider() === 'paystack' ? 'Paystack' : 'POINTGH payment simulator'; }
function secret() { return provider() === 'paystack' ? config.payments.secretKey : isSimulator() ? config.payments.simulatorSecret : ''; }
function findByReference(ref) { return db.prepare('SELECT * FROM payments WHERE reference = ?').get(ref); }
function matchesProvider(payment) {
  return provider() === 'paystack'
    ? payment.gateway === 'paystack' && payment.provider_mode === mode()
    : isSimulator() && ['simulator', 'biahens-stub'].includes(payment.gateway);
}
function payable(order) { return order && order.payment_status === 'unpaid' && order.status === 'pending_payment' && order.payment_method !== 'cod'; }

async function initialize(order, options = {}) {
  // Serialize initialization within the required single server process. The
  // unique reference also protects a retry after a network timeout/restart.
  if (initializing.has(order.id)) return initializing.get(order.id);
  const pending = initializeOnce(order.id, options);
  initializing.set(order.id, pending);
  try { return await pending; } finally { initializing.delete(order.id); }
}

async function initializeOnce(orderId, { method, email, fetchImpl } = {}) {
  orders.expirePaymentHolds(orderId);
  const order = orders.getOrder(orderId);
  if (!payable(order)) throw new Error('This order is no longer payable. Check its current status in your account.');
  if (!isSimulator() && provider() !== 'paystack') throw new paystack.PaystackError('PAYSTACK_CONFIGURATION');
  method = method || order.payment_method;
  if (!['card', 'momo'].includes(method) || method !== order.payment_method) throw new Error('The payment method does not match this order.');
  const amount = subunits(order.total);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('This order has an invalid payment total. Contact the store.');
  const gateway = isSimulator() ? 'simulator' : 'paystack';
  const payment = db.transaction(() => {
    orders.reserveStock(order.id);
    db.prepare("UPDATE orders SET stock_held_until = COALESCE(stock_held_until, datetime('now','+30 minutes')) WHERE id = ?").run(order.id);
    const existing = db.prepare(`SELECT * FROM payments WHERE order_id = ? AND gateway = ?
      AND provider_mode = ? AND status = 'initiated' ORDER BY id DESC LIMIT 1`).get(order.id, gateway, mode());
    if (existing) return existing;
    const ref = reference();
    const payload = { email: email || order.customer_email || order.ship_email, amount, currency: order.currency,
      reference: ref, metadata: { order_id: order.id, order_number: order.order_number, user_id: order.user_id, method } };
    db.prepare(`INSERT INTO payments (order_id,reference,gateway,provider_mode,method,status,amount,currency,channel,raw)
      VALUES (?,?,?,?,?,'initiated',?,?,?,?)`).run(order.id, ref, gateway, mode(), method, round2(order.total), order.currency,
      method === 'momo' ? 'mobile_money' : 'card', JSON.stringify(payload));
    return findByReference(ref);
  })();
  if (subunits(payment.amount) !== amount || payment.currency !== order.currency) throw new Error('The saved payment does not match this order total. Contact the store before paying.');
  const localUrl = `/pay/${payment.reference}`;
  const result = { ok: true, reference: payment.reference, amount: payment.amount, gateway: brand(), mode: mode() };
  if (isSimulator()) return { ...result, authorization_url: localUrl };
  if (payment.authorization_url) return { ...result, authorization_url: paystack.checkoutUrl(payment.authorization_url) };

  // Initialization may have reached Paystack even if its reply was lost. Never
  // blindly create another reference after an ambiguous provider failure.
  if (payment.error) {
    let remote;
    try { remote = await paystack.verify(payment.reference, { fetchImpl }); } catch (error) {
      if (error.code !== 'PAYSTACK_REJECTED') throw error;
    }
    if (remote) {
      if (remote.status === 'success') {
        const verified = acceptCharge(payment.reference, remote);
        if (!verified.ok) throw new Error(verified.message);
        return { ...result, authorization_url: `/order/${order.order_number}?paid=1` };
      }
      if (!validateTransaction(payment, remote)) throw new Error('The provider response did not match this order. Please contact the store.');
      if (['failed', 'abandoned', 'reversed'].includes(remote.status)) {
        db.prepare("UPDATE payments SET status = 'failed', error = 'Provider confirmed the attempt was not successful' WHERE id = ? AND status = 'initiated'").run(payment.id);
        return initializeOnce(order.id, { method, email, fetchImpl });
      }
      throw new Error('The provider is still processing this attempt. Check payment from your order page before trying again.');
    }
  }
  const payload = { email: email || order.customer_email || order.ship_email, amount, currency: order.currency,
    reference: payment.reference, callback_url: `${config.publicUrl}${localUrl}/callback`,
    channels: [method === 'momo' ? 'mobile_money' : 'card'],
    metadata: { order_id: order.id, order_number: order.order_number, user_id: order.user_id, method } };
  try {
    const remote = await paystack.initialize(payload, { fetchImpl });
    if (remote.reference !== payment.reference) throw new paystack.PaystackError('PAYSTACK_REJECTED');
    const url = paystack.checkoutUrl(remote.authorization_url);
    db.prepare("UPDATE payments SET authorization_url = ?, initialized_at = datetime('now'), error = NULL WHERE id = ? AND status = 'initiated'").run(url, payment.id);
    // A webhook can win the race while initialize is in flight.
    const latest = orders.getOrder(order.id);
    return { ...result, authorization_url: latest.payment_status === 'paid' ? `/order/${order.order_number}?paid=1`
      : payable(latest) ? url : `/order/${order.order_number}` };
  } catch (error) {
    db.prepare("UPDATE payments SET error = ? WHERE id = ? AND status = 'initiated'").run(error instanceof paystack.PaystackError ? error.code : 'PAYSTACK_UNAVAILABLE', payment.id);
    throw error;
  }
}

/** Exact amount, currency, reference and environment are checked on ALL credits. */
function validateTransaction(payment, data) {
  return !!(data && matchesProvider(payment) && data.reference === payment.reference
    && Number.isSafeInteger(data.amount) && data.amount > 0 && data.amount === subunits(payment.amount)
    && data.currency === payment.currency && data.domain === (payment.provider_mode || 'test'));
}

function customerReceipt(order, payment, review) {
  const to = order.customer_email || order.ship_email;
  if (!to) return;
  notifications.queueEmail({ to, key: `payment:${payment.id}:customer:email`, subject: `Payment received — order ${order.order_number}`,
    text: `We received GH₵${round2(payment.amount).toFixed(2)} for order ${order.order_number}.\n\n`
      + (review ? 'This payment needs a review by our team. Do not pay again; contact support before placing another payment.\n\n' : '')
      + `View your order: ${config.publicUrl}/order/${order.order_number}\n\n${settings.get('store_name')} · ${settings.get('support_phone')}` });
}

function finishOrder(order, payment) {
  orders.reserveStock(order.id); // idempotent, including COD already allocated at placement
  orders.markSold(order.id);
  db.prepare(`UPDATE orders SET payment_status = 'paid', stock_held_until = NULL,
    status = CASE WHEN status = 'pending_payment' THEN 'paid' ELSE status END, updated_at = datetime('now') WHERE id = ?`).run(order.id);
  orders.addEvent(order.id, 'paid', `Payment of GH₵${round2(payment.amount).toFixed(2)} received via ${(payment.channel || 'card').replace(/_/g, ' ')}.`,
    payment.gateway === 'manual' ? 'admin' : 'gateway', { isPublic: true });
  notify('order', 'success', `Payment received — ${order.order_number}`, `GH₵${round2(payment.amount).toFixed(2)} confirmed.`, `/admin/orders/${order.id}`);
}

function acceptCharge(ref, data) {
  return db.transaction(() => {
    const payment = findByReference(ref);
    if (!payment) return { ok: false, ignored: true, message: 'Unknown reference.' };
    const order = orders.getOrder(payment.order_id);
    if (!validateTransaction(payment, data) || !order || subunits(order.total) !== subunits(payment.amount) || order.currency !== payment.currency
        || data.status !== 'success' || !validReceiptId(data.id)) {
      return { ok: false, ignored: true, message: 'Payment verification did not match the saved order. No credit was applied.' };
    }
    if (['success', 'refunded'].includes(payment.status)) return { ok: true, alreadyPaid: true, needsReview: !!payment.needs_review, orderId: order.id };
    if (payment.gateway === 'paystack' && db.prepare("SELECT id FROM payments WHERE gateway = 'paystack' AND provider_mode = ? AND gateway_ref = ? AND id != ?").get(payment.provider_mode, String(data.id), payment.id)) {
      return { ok: false, ignored: true, message: 'This provider receipt has already been recorded for another reference. No additional credit was applied.' };
    }
    orders.expirePaymentHolds(order.id);
    const current = orders.getOrder(order.id);
    let review = current.payment_status !== 'unpaid' || ['cancelled', 'refunded', 'shipped', 'delivered'].includes(current.status);
    if (!review) {
      try { orders.reserveStock(order.id); } catch (error) {
        if (error.code !== 'STOCK_UNAVAILABLE') throw error;
        review = true; // Funds exist; retain them in the ledger even if stock cannot be fulfilled.
      }
    }
    const last4 = data.authorization && /^\d{4}$/.test(data.authorization.last4 || '') ? data.authorization.last4 : null;
    const channel = ['card', 'mobile_money', 'bank', 'bank_transfer', 'ussd', 'qr'].includes(data.channel) ? data.channel : payment.channel;
    const safe = { reference: ref, id: String(data.id), status: 'success', domain: data.domain,
      amount: data.amount, currency: data.currency, channel, paid_at: typeof data.paid_at === 'string' && Number.isFinite(Date.parse(data.paid_at)) ? new Date(data.paid_at).toISOString() : null };
    db.prepare(`UPDATE payments SET status = 'success', gateway_ref = ?, channel = ?, last4 = ?, payer = ?,
      paid_at = datetime('now'), verified_at = datetime('now'), raw = ?, needs_review = ?, error = ? WHERE id = ?`)
      .run(String(data.id), channel, last4, last4 ? `Card •••• ${last4}` : channel === 'mobile_money' ? 'Mobile Money' : 'Provider confirmed',
        JSON.stringify(safe), review ? 1 : 0, review ? 'Captured payment requires review: order closed, already paid, or stock unavailable. Do not fulfil automatically.' : null, payment.id);
    const settled = { ...payment, amount: payment.amount, channel };
    if (review) {
      // A late/duplicate charge is real money, but must not resurrect a cancelled
      // order, consume stock twice, or pretend that a refund has occurred.
      if (current.payment_status === 'unpaid') db.prepare("UPDATE orders SET payment_status = 'paid', updated_at = datetime('now') WHERE id = ?").run(order.id);
      orders.addEvent(order.id, current.status, 'A payment was received and needs support review. Please do not pay again.', 'gateway', { isPublic: true });
      notify('order', 'danger', `Payment review — ${order.order_number}`, `Captured GH₵${round2(payment.amount).toFixed(2)}. Review this payment in Paystack; no automatic refund has been sent.`, `/admin/orders/${order.id}`);
    } else finishOrder(current, settled);
    customerReceipt(order, payment, review);
    return { ok: true, status: 'success', needsReview: review, orderId: order.id, reference: ref };
  }).immediate();
}

async function verify(ref, { fetchImpl } = {}) {
  const payment = findByReference(ref);
  if (!payment || provider() !== 'paystack' || !matchesProvider(payment)) return { ok: false, message: 'This reference does not belong to the configured payment provider.' };
  const data = await paystack.verify(ref, { fetchImpl });
  if (data.status === 'success') return acceptCharge(ref, data);
  if (!validateTransaction(payment, data)) return { ok: false, message: 'Payment verification did not match the saved order. No credit was applied.' };
  // A delayed failure or pending result may never downgrade a captured charge.
  if (['success', 'refunded'].includes(findByReference(ref).status)) return { ok: true, alreadyPaid: true, orderId: payment.order_id, needsReview: !!payment.needs_review };
  const failed = ['failed', 'abandoned', 'reversed'].includes(data.status);
  if (failed) db.prepare("UPDATE payments SET status = 'failed', error = 'Provider confirmed an unsuccessful attempt' WHERE id = ? AND status NOT IN ('success','refunded')").run(payment.id);
  return { ok: false, pending: !failed, orderId: payment.order_id, message: failed ? 'This payment was not completed. You may retry from your order page.' : 'Payment is still pending with Paystack. Approve any prompt on your phone, then check payment again. Do not pay twice.' };
}

function equalHex(expected, supplied) {
  if (!/^[a-f0-9]{128}$/i.test(String(supplied || ''))) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'));
}
function verifySignature(rawBody, signatureHeader) {
  const key = secret();
  if (!key || !(Buffer.isBuffer(rawBody) || typeof rawBody === 'string')) return false;
  return equalHex(crypto.createHmac('sha512', key).update(rawBody).digest('hex'), signatureHeader);
}
function verifyWebhookSignature(rawBody, headers, now = Date.now()) {
  if (!Buffer.isBuffer(rawBody)) return false; // never reserialize a parsed body
  const modern = headers['paystack-signature'];
  if (modern !== undefined) {
    if (provider() !== 'paystack' || typeof modern !== 'string') return false;
    const parts = modern.split(',').map(value => value.trim());
    if (parts.length > 12) return false;
    const times = parts.filter(value => value.startsWith('t='));
    const signatures = parts.filter(value => value.startsWith('v1='));
    if (times.length !== 1 || !/^t=\d{1,12}$/.test(times[0]) || !signatures.length) return false;
    const timestamp = times[0].slice(2);
    if (!Number.isSafeInteger(Number(timestamp)) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
    if (signatures.some(value => !/^v1=whk_[A-Za-z0-9_-]+:[a-f0-9]{128}$/.test(value))) return false;
    const secrets = [config.payments.webhookSecret, config.payments.previousWebhookSecret].filter(value => /^whsec_/.test(value));
    let valid = 0;
    for (const key of secrets) {
      const hmac = crypto.createHmac('sha512', key).update(`${timestamp}.`).update(rawBody).digest('hex');
      // Evaluate every signature to support key rotation without early matches.
      for (const signature of signatures) valid |= Number(equalHex(hmac, signature.slice(signature.indexOf(':') + 1)));
    }
    return !!valid;
  }
  // Legacy Paystack signatures use the API secret, never a whsec_ secret.
  return verifySignature(rawBody, headers['x-paystack-signature']);
}
function signPayload(body) {
  if (!isSimulator()) throw new Error('Simulator signing is disabled.');
  return crypto.createHmac('sha512', secret()).update(JSON.stringify(body)).digest('hex');
}
function buildWebhookPayload(payment) {
  if (!isSimulator() || !matchesProvider(payment)) throw new Error('Simulator helpers cannot operate on provider payments.');
  return { event: 'charge.success', data: { id: Math.floor(Math.random() * 9e9) + 1, reference: payment.reference,
    amount: subunits(payment.amount), currency: payment.currency, domain: 'test', status: 'success',
    channel: payment.channel || 'card', paid_at: new Date().toISOString() } };
}

/** Invoked only after signature validation, or by explicitly isolated demo helpers. */
function handleWebhook(body, req = null, { rawBody } = {}) {
  return db.transaction(() => {
    const digest = rawBody ? crypto.createHash('sha256').update(rawBody).digest('hex') : null;
    if (digest && db.prepare('SELECT digest FROM payment_webhook_receipts WHERE digest = ?').get(digest)) return { ok: true, duplicate: true };
    const event = String(body && body.event || '').slice(0, 100);
    const data = body && body.data || {};
    const payment = typeof data.reference === 'string' ? findByReference(data.reference) : null;
    let result = { ok: true, ignored: true, message: 'Event does not affect an existing charge. Refunds are managed in the provider dashboard.' };
    if (payment && matchesProvider(payment)) {
      if (event === 'charge.success') result = acceptCharge(payment.reference, data);
      if (['charge.failed', 'charge.abandoned'].includes(event) && !['success', 'refunded'].includes(payment.status)
          && (provider() !== 'paystack' || validateTransaction(payment, data))) {
        db.prepare('UPDATE payments SET status = ?, error = ? WHERE id = ?').run(event === 'charge.failed' ? 'failed' : 'abandoned', 'Provider reported an unsuccessful attempt', payment.id);
        result = { ok: true, message: 'Failure recorded.' };
      }
      if (req && result.ok && !result.alreadyPaid && !result.ignored) audit(req, `webhook.${event}`, 'payment', payment.id, { reference: payment.reference });
    }
    if (digest) db.prepare('INSERT INTO payment_webhook_receipts (digest,event,reference,outcome) VALUES (?,?,?,?)')
      .run(digest, event, payment ? payment.reference : null, !result.ok ? 'rejected' : result.ignored ? 'ignored' : 'accepted');
    return result;
  }).immediate();
}

/** Fake PAN/CVV is accepted ONLY by the explicitly configured demo simulator. */
function authorize(ref, { channel = 'card', card = {}, momo = {}, bank = {}, simulate = null } = {}) {
  if (!isSimulator()) return { ok: false, message: 'Local card entry and simulator authorization are disabled. Continue to Paystack-hosted checkout.' };
  const payment = findByReference(ref);
  if (!payment || !matchesProvider(payment)) return { ok: false, message: 'Simulator reference not found.' };
  const order = orders.getOrder(payment.order_id);
  if (!payable(order) && payment.status !== 'success') return { ok: false, message: 'This order is no longer payable.' };
  let result;
  const digits = String(card.number || '').replace(/\D/g, '');
  if (channel === 'card') {
    if (digits.length < 12 || !/^\d{2}\s*\/\s*\d{2}$/.test(card.expiry || '') || !/^\d{3,4}$/.test(card.cvv || '')) return { ok: false, message: 'Use the displayed test card, an MM/YY expiry and a three-digit test CVV.' };
    result = TEST_CARDS[digits] || { status: 'failed', message: 'Use a displayed simulator test card. Never enter real card details here.' };
  } else if (channel === 'mobile_money') {
    if (String(momo.number || '').replace(/\D/g, '').length < 9 || !MOMO_NETWORKS.some(network => network.id === momo.network)) return { ok: false, message: 'Choose a demo MoMo network and number.' };
    result = String(momo.number).endsWith('0000') ? { status: 'failed', message: 'Simulated customer decline' } : { status: 'success' };
  } else if (channel === 'bank') result = { status: bank.id === 'decline' ? 'failed' : 'success' };
  else return { ok: false, message: 'Unsupported demo channel.' };
  if (simulate === 'fail') result = { status: 'failed', message: 'Simulated failure' };
  if (simulate === 'success') result = { status: 'success' };
  if (payment.status === 'success') return { ok: true, alreadyPaid: true, orderId: order.id };
  if (result.status !== 'success') {
    db.prepare("UPDATE payments SET status = 'failed', channel = ?, error = ? WHERE id = ?").run(channel, result.message, payment.id);
    return { ok: false, message: result.message, orderId: order.id };
  }
  return acceptCharge(ref, { ...buildWebhookPayload(payment).data, channel, authorization: { last4: channel === 'card' ? digits.slice(-4) : '' } });
}

/** Only physical COD collection may be recorded locally; never fake online settlement. */
function markCollected(orderId, { method = 'cod', note = '', req = null } = {}) {
  return db.transaction(() => {
    const order = orders.getOrder(orderId);
    if (!order) return { ok: false, message: 'Order not found.' };
    if (order.payment_method !== 'cod' || method !== 'cod') return { ok: false, message: 'Online payments must be verified with Paystack. Only an actual cash-on-delivery collection can be recorded manually.' };
    if (['cancelled', 'refunded'].includes(order.status)) return { ok: false, message: 'Closed orders cannot be collected.' };
    if (order.payment_status === 'paid') return { ok: true, alreadyPaid: true, message: 'This collection was already recorded.' };
    if (order.payment_status !== 'unpaid') return { ok: false, message: 'This order needs a payment review.' };
    const ref = reference('COD');
    const info = db.prepare(`INSERT INTO payments (order_id,reference,gateway,method,status,amount,currency,channel,payer,paid_at,raw)
      VALUES (?,?,'manual','cod','success',?,?,'cod',?,datetime('now'),?)`).run(order.id, ref, round2(order.total), order.currency, 'Cash collected by staff', JSON.stringify({ manual: true, note }));
    const payment = findByReference(ref);
    finishOrder(order, payment);
    customerReceipt(order, payment, false);
    if (req) audit(req, 'payment.cod_collected', 'payment', info.lastInsertRowid, { orderId, note });
    return { ok: true, message: `Actual cash collection of GH₵${round2(order.total).toFixed(2)} recorded.` };
  }).immediate();
}

function refund() {
  return { ok: false, message: 'No refund has been sent. Issue and track online refunds in your Paystack dashboard. This application does not initiate or automatically reconcile refunds; a status change here cannot return money. Handle any cash refund separately.' };
}
function listPayments({ limit = 200, status = 'all' } = {}) {
  return db.prepare(`SELECT p.*, o.order_number, o.ship_name FROM payments p LEFT JOIN orders o ON o.id = p.order_id
    ${status && status !== 'all' ? 'WHERE p.status = @status' : ''} ORDER BY p.id DESC LIMIT @limit`).all({ status, limit });
}

module.exports = { initialize, verify, authorize, findByReference, verifySignature, verifyWebhookSignature, signPayload,
  buildWebhookPayload, handleWebhook, markCollected, refund, listPayments,
  MOMO_NETWORKS, BANKS, TEST_CARDS, provider, mode, secret, isSimulator, brand };
