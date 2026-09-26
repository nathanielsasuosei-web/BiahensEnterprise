'use strict';
/**
 * Hosted stub payment gateway + Paystack-compatible webhook endpoint.
 */
const express = require('express');
const db = require('../db');
const config = require('../config');
const settings = require('../services/settings');
const orders = require('../services/orders');
const payments = require('../services/payments');
const { money, round2 } = require('../utils/helpers');
const { sendMail } = require('../utils/log');

const router = express.Router();

function orderForReference(ref) {
  const payment = payments.findByReference(ref);
  if (!payment) return null;
  const order = orders.getOrder(payment.order_id);
  return order ? { payment, order } : null;
}

/* --------------------------------------------------------- hosted checkout */
router.get('/pay/:reference', (req, res, next) => {
  const ctx = orderForReference(req.params.reference);
  if (!ctx) return next();
  const { payment, order } = ctx;

  if (payment.status === 'success' || order.payment_status === 'paid') {
    return res.redirect(`/order/${order.order_number}?paid=1`);
  }

  res.render('checkout/gateway', {
    layout: false,
    pageTitle: `${settings.get('gateway_brand')} — Secure payment`,
    bodyClass: 'page-gateway',
    order,
    payment,
    mode: payments.mode(),
    momoNetworks: payments.MOMO_NETWORKS,
    banks: payments.BANKS,
    testCards: payments.TEST_CARDS,
    channel: req.query.channel || (payment.method === 'momo' ? 'mobile_money' : 'card'),
    error: req.query.error || null,
    money,
    round2,
    storeName: settings.get('store_name'),
    supportPhone: settings.get('support_phone'),
    gatewayBrand: settings.get('gateway_brand'),
  });
  return undefined;
});

router.post('/pay/:reference', (req, res) => {
  const ctx = orderForReference(req.params.reference);
  if (!ctx) return res.redirect('/');
  const { order } = ctx;

  const channel = req.body.channel === 'mobile_money' ? 'mobile_money'
    : req.body.channel === 'bank' ? 'bank' : 'card';

  const result = payments.authorize(req.params.reference, {
    channel,
    card: {
      number: req.body.card_number,
      expiry: req.body.card_expiry,
      cvv: req.body.card_cvv,
      brand: req.body.card_brand || (String(req.body.card_number || '').startsWith('4') ? 'Visa' : 'Mastercard'),
    },
    momo: { number: req.body.momo_number, network: req.body.momo_network },
    bank: { id: req.body.bank_id },
    simulate: req.body.simulate || null,
  });

  if (result.ok && !result.alreadyPaid) {
    sendMail({
      to: order.ship_email || order.guest_email || 'customer@example.com',
      subject: `Payment received — order ${order.order_number}`,
      text: `We have received GH₵${round2(order.total).toFixed(2)} for order ${order.order_number}.\n\n`
        + `You can track it here: ${config.publicUrl}/order/${order.order_number}\n\n`
        + `${settings.get('store_name')} · ${settings.get('support_phone')}`,
    });
    return res.redirect(`/order/${order.order_number}?paid=1`);
  }
  if (result.ok && result.alreadyPaid) return res.redirect(`/order/${order.order_number}?paid=1`);

  return res.redirect(`/pay/${req.params.reference}?channel=${channel}&error=${encodeURIComponent(result.message || 'Payment declined')}`);
});

router.post('/pay/:reference/cancel', (req, res) => {
  const ctx = orderForReference(req.params.reference);
  if (!ctx) return res.redirect('/');
  const { payment, order } = ctx;
  if (payment.status === 'initiated') {
    db.prepare(`UPDATE payments SET status = 'abandoned', error = 'Cancelled by customer' WHERE id = ?`).run(payment.id);
  }
  orders.addEvent(order.id, order.status, 'Customer cancelled the payment attempt and can retry from the order page.', 'customer');
  req.flash('info', 'Payment cancelled. You can retry any time from your order confirmation page.');
  return res.redirect(`/order/${order.order_number}`);
});

/**
 * Demo helper: fires a correctly-signed webhook at the real endpoint so you
 * can watch signature verification + idempotent order completion work.
 */
router.post('/pay/:reference/simulate-webhook', async (req, res) => {
  const ctx = orderForReference(req.params.reference);
  if (!ctx) return res.status(404).json({ ok: false, message: 'Unknown reference.' });
  const { payment, order } = ctx;
  const payload = payments.buildWebhookPayload(payment);
  const signature = payments.signPayload(payload);
  const target = `${config.publicUrl.replace(/\/$/, '')}/webhooks/paystack`;

  try {
    const resp = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
      body: JSON.stringify(payload),
    });
    const body = await resp.json().catch(() => ({}));
    return res.json({
      ok: resp.ok,
      status: resp.status,
      endpoint: target,
      signature,
      response: body,
      order: orders.getOrder(order.id),
    });
  } catch (err) {
    // fall back to in-process handling so the demo never dead-ends
    const handled = payments.handleWebhook(payload);
    return res.json({ ok: true, fallback: true, reason: err.message, handled, order: orders.getOrder(order.id) });
  }
});

/* ---------------------------------------------------------------- webhook */
// Paystack pings the endpoint with GET when you set it in the dashboard.
router.get('/webhooks/paystack', (_req, res) => res.status(200).send('Biahens Enterprise webhook endpoint is live.'));

/**
 * Mounted with express.raw() in app.js so we can verify the HMAC over the
 * exact bytes that were sent.
 */
router.post('/webhooks/paystack', (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body || {});

  if (!payments.verifySignature(raw, signature)) {
    console.warn('⚠  webhook rejected — bad signature');
    return res.status(401).json({ ok: false, message: 'Invalid signature.' });
  }

  let body;
  try { body = JSON.parse(raw); } catch (_) { return res.status(400).json({ ok: false, message: 'Malformed JSON.' }); }

  const result = payments.handleWebhook(body, req);
  // Always answer 200 quickly so the gateway stops retrying.
  return res.status(200).json({ ok: true, received: true, result });
});

/** Local webhook tester used by the admin panel (signs + posts to itself). */
router.post('/admin/api/webhooks/test', async (req, res) => {
  const reference = String(req.body.reference || '').trim();
  const event = String(req.body.event || 'charge.success');
  const payment = payments.findByReference(reference);
  if (!payment) return res.status(404).json({ ok: false, message: 'No payment with that reference.' });

  const payload = event === 'charge.success'
    ? payments.buildWebhookPayload(payment)
    : { event, data: { reference, gateway_response: 'Simulated by admin' } };
  const signature = payments.signPayload(payload);
  const target = `${config.publicUrl.replace(/\/$/, '')}/webhooks/paystack`;

  try {
    const resp = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
      body: JSON.stringify(payload),
    });
    return res.json({ ok: resp.ok, status: resp.status, endpoint: target, signature, sent: payload, response: await resp.json().catch(() => ({})) });
  } catch (err) {
    const handled = payments.handleWebhook(payload, req);
    return res.json({ ok: true, fallback: true, reason: err.message, handled });
  }
});

module.exports = router;
