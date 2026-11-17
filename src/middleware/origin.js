'use strict';
const config = require('../config');

/** SameSite cookies plus strict origin checks on live browser mutations.
 * Provider webhooks use their own raw-body HMAC; cron uses a bearer secret.
 * No browser-facing backend URL or localhost exception is necessary.
 */
function sameOriginMutation(req, res, next) {
  if (config.storeMode !== 'live' || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      || req.path.startsWith('/webhooks/')) return next();
  const origin = req.get('Origin');
  const referer = req.get('Referer');
  let allowed = false;
  try {
    const expected = new URL(config.publicUrl).origin;
    if (origin) allowed = origin !== 'null' && new URL(origin).origin === expected && new URL(origin).pathname === '/';
    else if (referer) allowed = new URL(referer).origin === expected;
    else allowed = req.get('Sec-Fetch-Site') === 'same-origin';
  } catch (_) { /* reject malformed origins */ }
  if (!allowed || req.get('Sec-Fetch-Site') === 'cross-site') {
    return res.status(403).send('Request origin rejected. Reload the store using its public HTTPS address and try again.');
  }
  return next();
}
module.exports = { sameOriginMutation };
