'use strict';
const express = require('express');
const payments = require('../services/payments');
const router = express.Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Content-Type-Options', 'nosniff'); next(); });
router.get('/paystack', (_req, res) => res.status(200).send('POINTGH payment webhook endpoint.'));
router.post('/paystack', (req, res) => {
  if (!payments.verifyWebhookSignature(req.body, req.headers)) return res.status(401).json({ ok: false, message: 'Invalid signature.' });
  let body;
  try { body = JSON.parse(req.body.toString('utf8')); } catch (_) { return res.status(400).json({ ok: false, message: 'Malformed JSON.' }); }
  try {
    // No session, template rendering or external request is needed to receive
    // provider events. Acknowledge only after a durable transactional commit.
    payments.handleWebhook(body, req, { rawBody: req.body });
    return res.status(200).json({ ok: true, received: true });
  } catch (_) {
    console.error('[payment webhook] Durable processing failed; awaiting provider retry.');
    return res.status(500).json({ ok: false, received: false });
  }
});
module.exports = router;
