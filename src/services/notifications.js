'use strict';
const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');
const settings = require('./settings');
const { money, parseJson, vatLabel } = require('../utils/helpers');
const { whatsappNumber } = require('../utils/phone');

const MAX_ATTEMPTS = 5;
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;

function configuration() {
  const owner = db.prepare("SELECT email, phone FROM users WHERE role = 'owner' AND is_blocked = 0 ORDER BY id LIMIT 1").get() || {};
  const email = config.notifications.email;
  const wa = config.notifications.whatsapp;
  const emailTo = email.owner || settings.get('owner_notification_email') || owner.email || '';
  const whatsappTo = whatsappNumber(wa.owner || settings.get('owner_notification_whatsapp') || owner.phone);
  const consent = wa.optedIn || settings.get('owner_whatsapp_opt_in');
  const disabled = !config.notifications.enabled && 'NOTIFICATIONS_ENABLED=true';
  const emailMissing = [disabled, !email.apiKey && 'RESEND_API_KEY', !email.from && 'MAIL_FROM', !EMAIL.test(emailTo) && 'owner email address'].filter(Boolean);
  const whatsappMissing = [disabled, !wa.accessToken && 'WHATSAPP_ACCESS_TOKEN', !/^\d+$/.test(wa.phoneNumberId) && 'WHATSAPP_PHONE_NUMBER_ID',
    !/^[a-z0-9_]+$/.test(wa.template) && 'approved WHATSAPP_ORDER_TEMPLATE', !whatsappTo && 'owner WhatsApp number', !consent && 'owner WhatsApp opt-in'].filter(Boolean);
  return {
    email: { ready: emailMissing.length === 0, recipient: emailTo, missing: emailMissing, sender: email.from },
    whatsapp: { ready: whatsappMissing.length === 0, recipient: whatsappTo, missing: whatsappMissing, optedIn: !!consent },
  };
}

function enqueue({ channel, orderId = null, key, to = '', subject, text, payload = {} }) {
  const deliveryKey = key || crypto.randomUUID();
  db.prepare(`INSERT OR IGNORE INTO notification_outbox
    (channel, order_id, dedupe_key, recipient, subject, text, payload) VALUES (?,?,?,?,?,?,?)`)
    .run(channel, orderId, deliveryKey, to, subject, text || '', JSON.stringify(payload));
  return db.prepare('SELECT * FROM notification_outbox WHERE dedupe_key = ?').get(deliveryKey);
}

function queueEmail({ to, subject, text = '', html, key = crypto.randomUUID() }) {
  return enqueue({ channel: 'email', key, to, subject, text, payload: { html: html || undefined } });
}

/** Enqueued in the same transaction as the order: no alerts for rolled-back orders. */
function queueOwnerOrder(orderId) {
  const order = db.prepare(`SELECT o.*, u.name AS customer_name FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?`).get(orderId);
  if (!order) return;
  const items = db.prepare('SELECT name, qty, total FROM order_items WHERE order_id = ?').all(order.id);
  const count = items.reduce((n, item) => n + item.qty, 0);
  const customer = order.customer_name || order.ship_name;
  const method = order.payment_method === 'cod' ? 'Cash on delivery' : order.payment_method === 'momo' ? 'Mobile Money' : 'Card';
  const payment = `${method} · ${order.payment_status === 'paid' ? 'paid' : 'not paid yet'}`;
  const url = `${config.publicUrl}/admin/orders/${order.id}`;
  const subject = `New order ${order.order_number} | ${settings.get('store_name')}`;
  const text = `${subject}\n\nCustomer: ${customer}\nPhone: ${order.ship_phone}\nDelivery: ${order.ship_city}, ${order.ship_region}\n\n`
    + items.map(item => `${item.qty} × ${item.name} — ${money(item.total)}`).join('\n')
    + `\n\nSubtotal: ${money(order.subtotal)}\nDiscount: ${money(order.discount)}\nDelivery: ${money(order.shipping_fee)}`
    + (order.tax_rate > 0 || order.tax > 0 ? `\n${vatLabel(order.tax_rate)}: ${money(order.tax)}` : '')
    + `\nTotal: ${money(order.total)}\nPayment: ${payment}\n\nReview and fulfil this order: ${url}\nSign in as the store owner to see the full order.`;
  const channels = configuration();
  enqueue({ channel: 'email', orderId, key: `order:${orderId}:owner:email`, to: channels.email.recipient, subject, text, payload: { kind: 'owner_order' } });
  enqueue({ channel: 'whatsapp', orderId, key: `order:${orderId}:owner:whatsapp`, to: channels.whatsapp.recipient, subject, text,
    payload: { kind: 'owner_order', parameters: [order.order_number, customer.slice(0, 80), String(count), money(order.total), payment, url] } });
}

function configurationForMessage(row, payload) {
  const status = configuration()[row.channel];
  if (payload.kind === 'owner_order') row.recipient = status.recipient;
  const missing = status.missing.filter(item => item !== 'owner email address');
  if (row.channel === 'email' && !EMAIL.test(row.recipient)) missing.push('valid recipient email');
  if (row.channel === 'whatsapp' && !whatsappNumber(row.recipient)) missing.push('valid recipient WhatsApp number');
  return missing;
}

async function send(row, { fetchImpl = globalThis.fetch } = {}) {
  const payload = parseJson(row.payload, {});
  const missing = configurationForMessage(row, payload);
  if (missing.length) {
    db.prepare("UPDATE notification_outbox SET status = 'unconfigured', recipient = ?, last_error = ?, locked_at = NULL, next_attempt_at = datetime('now','+5 minutes') WHERE id = ? AND status IN ('queued','failed','unconfigured')")
      .run(row.recipient, `Setup required: ${missing.join(', ')}.`, row.id);
    return { status: 'unconfigured' };
  }
  const claim = db.prepare(`UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1,
    locked_at = datetime('now'), recipient = ? WHERE id = ? AND status IN ('queued','failed','unconfigured') AND attempts < ?`)
    .run(row.recipient, row.id, MAX_ATTEMPTS);
  if (!claim.changes) return { status: 'skipped' };

  let retryable = true;
  try {
    let response;
    if (row.channel === 'email') {
      response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.notifications.timeoutMs),
        headers: { Authorization: `Bearer ${config.notifications.email.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': row.dedupe_key },
        body: JSON.stringify({ from: config.notifications.email.from, to: [row.recipient], subject: row.subject, text: row.text, ...(payload.html ? { html: payload.html } : {}) }),
      });
    } else {
      const wa = config.notifications.whatsapp;
      response = await fetchImpl(`https://graph.facebook.com/${encodeURIComponent(wa.apiVersion)}/${encodeURIComponent(wa.phoneNumberId)}/messages`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.notifications.timeoutMs),
        headers: { Authorization: `Bearer ${wa.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: row.recipient, type: 'template', template: {
          name: wa.template, language: { code: wa.language },
          components: [{ type: 'body', parameters: (payload.parameters || []).map(value => ({ type: 'text', text: String(value) })) }],
        } }),
      });
    }
    if (!response.ok) {
      retryable = response.status === 429 || response.status >= 500;
      throw new Error(`Provider rejected the message (HTTP ${response.status}). Check the sender, credentials, recipient and approved template.`);
    }
    const body = await response.json();
    const id = row.channel === 'email' ? body.id : body.messages && body.messages[0] && body.messages[0].id;
    if (!id) throw new Error('Provider did not confirm acceptance of this message.');
    db.prepare("UPDATE notification_outbox SET status = 'sent', sent_at = datetime('now'), provider_id = ?, last_error = NULL, locked_at = NULL, next_attempt_at = NULL WHERE id = ?")
      .run(String(id), row.id);
    return { status: 'sent' };
  } catch (error) {
    const attempts = db.prepare('SELECT attempts FROM notification_outbox WHERE id = ?').get(row.id).attempts;
    const next = retryable && attempts < MAX_ATTEMPTS ? new Date(Date.now() + Math.min(3600, 30 * 2 ** attempts) * 1000).toISOString() : null;
    // Never store tokens or a raw provider response in the delivery log.
    const reason = /^Provider /.test(error.message) ? error.message : 'Delivery could not be confirmed. Check connectivity and retry from the delivery log.';
    db.prepare("UPDATE notification_outbox SET status = 'failed', last_error = ?, locked_at = NULL, next_attempt_at = ? WHERE id = ?")
      .run(reason, next, row.id);
    return { status: 'failed' };
  }
}

async function flush({ orderId = null, ids = null, limit = 20, fetchImpl } = {}) {
  // Recover interrupted workers without allowing two workers to send a row together.
  db.prepare("UPDATE notification_outbox SET status = 'failed', next_attempt_at = datetime('now') WHERE status = 'sending' AND locked_at < datetime('now','-5 minutes')").run();
  const where = ["(status = 'queued' OR (status = 'unconfigured' AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= datetime('now'))) OR (status = 'failed' AND next_attempt_at IS NOT NULL AND datetime(next_attempt_at) <= datetime('now')))", 'attempts < @max'];
  const params = { max: MAX_ATTEMPTS, limit: Math.max(1, Math.min(100, Number(limit) || 20)) };
  if (orderId) { where.push('order_id = @order'); params.order = orderId; }
  if (ids) {
    if (!ids.length) return [];
    where.push(`id IN (${ids.map((id, index) => { params[`id${index}`] = id; return `@id${index}`; }).join(',')})`);
  }
  const rows = db.prepare(`SELECT * FROM notification_outbox WHERE ${where.join(' AND ')} ORDER BY CASE status WHEN 'queued' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END, id LIMIT @limit`).all(params);
  const results = [];
  for (let i = 0; i < rows.length; i += 4) {
    results.push(...await Promise.all(rows.slice(i, i + 4).map(row => send(row, { fetchImpl }))));
  }
  return results;
}

function retryPending() {
  return db.prepare("UPDATE notification_outbox SET status = 'queued', attempts = 0, next_attempt_at = NULL, locked_at = NULL WHERE status IN ('failed','unconfigured')").run().changes;
}

function messages(limit = 100) {
  return db.prepare('SELECT * FROM notification_outbox ORDER BY id DESC LIMIT ?').all(limit)
    .map(row => ({ ...row, to: row.recipient, at: row.created_at, html: parseJson(row.payload, {}).html || '' }));
}

function authorizeWorker(header) {
  const secret = config.notifications.cronSecret;
  if (secret.length < 24) return false;
  const supplied = Buffer.from(String(header || ''));
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

module.exports = { configuration, enqueue, queueEmail, queueOwnerOrder, flush, retryPending, messages, authorizeWorker };
