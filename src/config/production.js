'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { whatsappNumber } = require('../utils/phone');

const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$/i;
const placeholder = value => !String(value || '').trim() || /change-me|xxxx|example\.|your[-_ ]|replace[-_ ]|local_test_secret/i.test(value);
const inside = (root, file) => !!root && path.resolve(file).startsWith(path.resolve(root) + path.sep);

/** Pure, secret-free diagnostics. "Configured" is NOT provider verification. */
function configurationErrors(config) {
  const errors = [];
  if (!['demo', 'live'].includes(config.storeMode)) errors.push('STORE_MODE must be demo or live.');
  if (!['simulator', 'paystack'].includes(config.payments.provider)) errors.push('PAYMENT_PROVIDER must be simulator or paystack.');
  if (!['test', 'live'].includes(config.payments.mode)) errors.push('GATEWAY_MODE must be test or live.');
  if (config.storeMode !== 'live') {
    if (config.payments.mode === 'live' || config.payments.secretKey.startsWith('sk_live_')) {
      errors.push('Live payments and live keys are forbidden in a demo store.');
    }
    return errors;
  }
  if (!config.isProd) errors.push('A live store requires NODE_ENV=production.');
  if (config.isServerless || config.ephemeralFs) errors.push('A live SQLite store cannot run on an ephemeral/serverless filesystem. Use the persistent server deployment.');
  if (!config.storage.persistent || !config.storage.dataDir) errors.push('Set PERSISTENT_STORAGE=true and DATA_DIR to the attached persistent disk mount.');
  if (config.storage.dataDir && ['/tmp', '/var/tmp', '/dev/shm'].some(dir => config.storage.dataDir === dir || inside(dir, config.storage.dataDir))) {
    errors.push('DATA_DIR must not be a temporary directory.');
  }
  for (const [label, file] of [['DB_FILE', config.db.file], ['UPLOADS_DIR', config.uploads.dir], ['BACKUP_DIR', config.backups.dir]]) {
    if (!inside(config.storage.dataDir, file)) errors.push(`${label} must be inside DATA_DIR on the persistent disk.`);
  }
  if (config.db.autoSeed) errors.push('Demo seeding is forbidden in a live store.');
  if (config.session.secret.length < 32 || placeholder(config.session.secret)) errors.push('SESSION_SECRET must contain at least 32 random characters and must not use the demo value.');
  try {
    const url = new URL(config.publicUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
        || ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'].includes(url.hostname) || placeholder(url.hostname)) throw new Error();
  } catch (_) { errors.push('PUBLIC_URL must be the real HTTPS origin of the store, without a path or query.'); }
  if (config.payments.provider !== 'paystack' || config.payments.mode !== 'live') errors.push('The live store requires PAYMENT_PROVIDER=paystack and GATEWAY_MODE=live.');
  if (!/^sk_live_[A-Za-z0-9]{16,}$/.test(config.payments.secretKey) || placeholder(config.payments.secretKey)) errors.push('Configure a valid live PAYSTACK_SECRET_KEY in the hosting secrets.');
  if (config.payments.publicKey && !/^pk_live_[A-Za-z0-9]{16,}$/.test(config.payments.publicKey)) errors.push('PAYSTACK_PUBLIC_KEY, if set, must belong to live mode. Hosted checkout does not require it.');
  for (const secret of [config.payments.webhookSecret, config.payments.previousWebhookSecret].filter(Boolean)) {
    if (!/^whsec_\S{16,}$/.test(secret) || placeholder(secret)) errors.push('Paystack signing secrets must be real whsec_ values from the provider dashboard.');
  }
  if (!config.notifications.enabled) errors.push('The live store requires NOTIFICATIONS_ENABLED=true for owner email and WhatsApp alerts.');
  const mail = config.notifications.email;
  const sender = (mail.from.match(/<([^<>]+)>\s*$/) || [null, mail.from])[1];
  if (placeholder(mail.apiKey) || !EMAIL.test(sender) || placeholder(sender)) errors.push('Configure RESEND_API_KEY and MAIL_FROM using your verified sending domain.');
  if (!EMAIL.test(mail.owner) || placeholder(mail.owner)) errors.push('Set OWNER_NOTIFICATION_EMAIL to the owner’s real alert address.');
  const wa = config.notifications.whatsapp;
  if (placeholder(wa.accessToken) || !/^\d+$/.test(wa.phoneNumberId) || !/^[a-z0-9_]+$/.test(wa.template)
      || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(wa.language) || !/^v\d+\.\d+$/.test(wa.apiVersion)) {
    errors.push('Configure WhatsApp access token, phone number ID, approved order template, language and supported API version.');
  }
  if (!whatsappNumber(wa.owner) || !wa.optedIn) errors.push('Set OWNER_NOTIFICATION_WHATSAPP and WHATSAPP_OWNER_OPT_IN=true after the owner consents.');
  return errors;
}

function assertRuntime(config = require('./index')) {
  const errors = configurationErrors(config);
  if (errors.length) {
    const error = new Error(`Store configuration is not safe to start:\n- ${errors.join('\n- ')}`);
    error.code = 'UNSAFE_STORE_CONFIGURATION';
    throw error;
  }
  if (config.storeMode === 'live') {
    for (const dir of [config.storage.dataDir, path.dirname(config.db.file), config.uploads.dir, config.backups.dir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
    }
    // This proves writability, not volume durability. The host must actually
    // attach the disk; PERSISTENT_STORAGE is an operator assertion, not magic.
    const probe = path.join(config.storage.dataDir, `.pointgh-write-${process.pid}`);
    fs.writeFileSync(probe, '', { mode: 0o600 });
    fs.unlinkSync(probe);
  }
}

module.exports = { configurationErrors, assertRuntime, inside };
