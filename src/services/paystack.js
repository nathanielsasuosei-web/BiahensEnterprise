'use strict';
const config = require('../config');

const API = 'https://api.paystack.co';
class PaystackError extends Error {
  constructor(code = 'PAYSTACK_UNAVAILABLE', status = 503) {
    super(code === 'PAYSTACK_CONFIGURATION' ? 'Online payment is not configured. Please contact the store.'
      : code === 'PAYSTACK_REJECTED' ? 'The payment provider could not accept this request. Please try again or contact the store.'
        : 'The payment provider could not be reached. Your order is saved; please retry from your order page.');
    this.name = 'PaystackError';
    this.code = code;
    this.status = status;
  }
}

/** No configurable API host: credentials must only ever go to Paystack. */
async function request(endpoint, { method = 'GET', body, fetchImpl = globalThis.fetch } = {}) {
  const key = config.payments.secretKey;
  const prefix = config.payments.mode === 'live' ? 'sk_live_' : 'sk_test_';
  if (!key || !key.startsWith(prefix)) throw new PaystackError('PAYSTACK_CONFIGURATION');
  let response;
  try {
    response = await fetchImpl(`${API}${endpoint}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(config.payments.timeoutMs),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (_) { throw new PaystackError(); }
  let payload;
  try { payload = await response.json(); } catch (_) { throw new PaystackError(); }
  if (!response.ok || payload.status !== true || !payload.data) {
    // Do not put raw provider replies, access tokens, card authorizations or
    // request headers in the database, flash messages, logs or audit trail.
    throw new PaystackError(response.status === 409 ? 'PAYSTACK_CONFLICT'
      : response.status === 401 || response.status === 403 ? 'PAYSTACK_CONFIGURATION'
        : response.status >= 500 || response.status === 429 ? 'PAYSTACK_UNAVAILABLE' : 'PAYSTACK_REJECTED', response.status >= 500 ? 503 : 502);
  }
  return payload.data;
}

function checkoutUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'checkout.paystack.com' && !url.port && !url.username && !url.password) return url.href;
  } catch (_) { /* fail closed */ }
  throw new PaystackError('PAYSTACK_REJECTED');
}

function initialize(payload, options) {
  return request('/transaction/initialize', { ...options, method: 'POST', body: payload });
}
function verify(reference, options) {
  return request(`/transaction/verify/${encodeURIComponent(reference)}`, options);
}
// Refunds are intentionally handled in the provider dashboard. Do not add a
// local ledger-only action that implies money has been returned.
module.exports = { initialize, verify, checkoutUrl, PaystackError };
