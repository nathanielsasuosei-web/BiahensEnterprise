'use strict';
/** Owned Paystack redirects/callbacks and raw-body signed webhooks. */
const express = require('express');
const db = require('../db');
const settings = require('../services/settings');
const orders = require('../services/orders');
const payments = require('../services/payments');
const auth = require('../middleware/auth');
const { money, round2 } = require('../utils/helpers');
const router = express.Router();

function requirePaymentOwner(req, res, next) {
  const payment = payments.findByReference(req.params.reference);
  const order = payment && orders.getOrder(payment.order_id);
  if (!order || !orders.canAccess(req.user, order)) return res.status(404).send('Payment not found.');
  req.paymentContext = { payment, order };
  return next();
}
router.use('/pay/:reference', auth.requireUser, requirePaymentOwner);

function redirectResult(req, res, result) {
  const { order } = req.paymentContext;
  if (result.needsReview) req.flash('warn', 'Your payment was received but needs support review. Do not pay again.');
  else if (!result.ok) req.flash('info', result.message || 'Payment is not yet confirmed.');
  return res.redirect(`/order/${order.order_number}${result.ok && !result.needsReview ? '?paid=1' : ''}`);
}

router.get('/pay/:reference/callback', async (req, res, next) => {
  const ref = req.params.reference;
  if (['reference', 'trxref'].some(key => req.query[key] !== undefined && req.query[key] !== ref)) {
    return res.status(400).send('The callback reference does not match this order. No payment was credited.');
  }
  try { return redirectResult(req, res, await payments.verify(ref)); } catch (error) {
    if (!error.code || !error.code.startsWith('PAYSTACK_')) return next(error);
    req.flash('warn', error.message);
    return res.redirect(`/order/${req.paymentContext.order.order_number}`);
  }
});
router.post('/pay/:reference/check', async (req, res, next) => {
  try { return redirectResult(req, res, await payments.verify(req.params.reference)); } catch (error) {
    if (!error.code || !error.code.startsWith('PAYSTACK_')) return next(error);
    req.flash('warn', error.message);
    return res.redirect(`/order/${req.paymentContext.order.order_number}`);
  }
});

router.get('/pay/:reference', async (req, res, next) => {
  const { payment, order } = req.paymentContext;
  if (payment.status === 'success' || ['paid', 'partially_refunded', 'refunded'].includes(order.payment_status)) {
    return res.redirect(`/order/${order.order_number}${order.payment_status === 'paid' && !payment.needs_review ? '?paid=1' : ''}`);
  }
  orders.expirePaymentHolds(order.id);
  if (orders.getOrder(order.id).status !== 'pending_payment') return res.redirect(`/order/${order.order_number}`);
  if (!payments.isSimulator()) {
    // No live card, expiry, CVV or MoMo credential form is ever rendered here.
    try {
      const initialized = await payments.initialize(order);
      return res.redirect(303, initialized.authorization_url);
    } catch (error) {
      if (error.code && error.code.startsWith('SQLITE_')) return next(error);
      req.flash('warn', error.message);
      return res.redirect(`/order/${order.order_number}`);
    }
  }
  return res.render('checkout/gateway', {
    layout: false, pageTitle: 'POINTGH — Demo payment simulator', bodyClass: 'page-gateway', order, payment,
    mode: payments.mode(), momoNetworks: payments.MOMO_NETWORKS, banks: payments.BANKS, testCards: payments.TEST_CARDS,
    channel: req.query.channel || (payment.method === 'momo' ? 'mobile_money' : 'card'),
    error: req.query.error || null, money, round2, storeName: settings.get('store_name'),
    supportPhone: settings.get('support_phone'), gatewayBrand: payments.brand(),
  });
});

router.post('/pay/:reference', (req, res) => {
  if (!payments.isSimulator()) return res.status(403).send('Local payment entry is disabled. Use Paystack-hosted checkout.');
  const channel = ['mobile_money', 'bank'].includes(req.body.channel) ? req.body.channel : 'card';
  const result = payments.authorize(req.params.reference, {
    channel, card: { number: req.body.card_number, expiry: req.body.card_expiry, cvv: req.body.card_cvv },
    momo: { number: req.body.momo_number, network: req.body.momo_network }, bank: { id: req.body.bank_id }, simulate: req.body.simulate,
  });
  if (result.ok) return redirectResult(req, res, result);
  return res.redirect(`/pay/${req.params.reference}?channel=${channel}&error=${encodeURIComponent(result.message || 'Demo payment failed')}`);
});

router.post('/pay/:reference/cancel', (req, res) => {
  const { payment, order } = req.paymentContext;
  // Navigating away from a hosted checkout does not cancel an in-flight MoMo
  // approval. Never create a new reference just because the customer left it.
  if (payments.isSimulator() && payment.status === 'initiated') {
    db.prepare("UPDATE payments SET status = 'abandoned', error = 'Demo attempt cancelled' WHERE id = ?").run(payment.id);
  }
  req.flash('info', 'Your order is saved. Check payment before retrying if you already approved a payment prompt.');
  return res.redirect(`/order/${order.order_number}`);
});

router.post('/pay/:reference/simulate-webhook', (req, res) => {
  if (!payments.isSimulator()) return res.status(403).json({ ok: false, message: 'Simulator helpers are disabled.' });
  const { payment, order } = req.paymentContext;
  if (!['simulator', 'biahens-stub'].includes(payment.gateway)) return res.status(403).json({ ok: false });
  const payload = payments.buildWebhookPayload(payment);
  const result = payments.handleWebhook(payload);
  return res.json({ ok: result.ok, result, order: orders.trackingSnapshot(orders.getOrder(order.id)) });
});

router.post('/admin/api/webhooks/test', auth.requireAdmin, (req, res) => {
  if (!payments.isSimulator()) return res.status(403).json({ ok: false, message: 'Simulator helpers are disabled.' });
  const payment = payments.findByReference(String(req.body.reference || ''));
  if (!payment || !['simulator', 'biahens-stub'].includes(payment.gateway)) return res.status(404).json({ ok: false, message: 'No simulator reference found.' });
  const event = String(req.body.event || 'charge.success');
  if (!['charge.success', 'charge.failed', 'charge.abandoned'].includes(event)) return res.status(400).json({ ok: false });
  const payload = { ...payments.buildWebhookPayload(payment), event };
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = payments.signPayload(payload);
  if (!payments.verifyWebhookSignature(raw, { 'x-paystack-signature': signature })) return res.status(500).json({ ok: false });
  return res.json({ ok: true, result: payments.handleWebhook(payload, req, { rawBody: raw }) });
});
module.exports = router;
