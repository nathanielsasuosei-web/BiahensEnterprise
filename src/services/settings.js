'use strict';
const db = require('../db');
const { parseJson } = require('../utils/helpers');

const DEFAULTS = {
  // --- identity
  store_name: 'POINTGH',
  store_short: 'POINTGH',
  tagline: 'Good finds. Everyday essentials.',
  logo: '',
  favicon: '',
  hero_note: 'Owner-selected products · Delivered across Ghana',

  // --- contact
  support_phone: '+233 30 200 4455',
  support_whatsapp: '+233 24 700 8899',
  support_email: 'support@biahensenterprise.com',
  sales_email: 'sales@biahensenterprise.com',
  address_line: 'Spintex Road, Baatsona Junction',
  address_city: 'Accra',
  address_region: 'Greater Accra',
  support_hours: 'Mon–Sat, 8:00am – 7:00pm',
  facebook: 'https://facebook.com/',
  instagram: 'https://instagram.com/',
  twitter: 'https://twitter.com/',
  tiktok: 'https://tiktok.com/',
  youtube: 'https://youtube.com/',

  // --- owner order alerts (credentials stay in server environment variables)
  owner_notification_email: '',
  owner_notification_whatsapp: '',
  owner_whatsapp_opt_in: 'false',

  // --- commerce
  currency: 'GHS',
  currency_symbol: 'GH₵',
  tax_rate: '1',
  free_shipping_threshold: '1500',
  default_shipping_fee: '35',
  express_shipping_fee: '70',
  pickup_fee: '0',
  min_order: '20',
  cod_enabled: 'true',
  momo_enabled: 'true',
  card_enabled: 'true',
  return_days: '7',
  warranty_note: 'Carefully checked products, with 7-day easy returns on eligible items.',

  // --- banners / homepage
  announcement: 'New season. New favourites. Find a little more you.',
  announcement_on: 'true',
  rail_flash: 'true',
  rail_featured: 'true',
  rail_new: 'true',
  rail_best: 'true',
  rail_deals: 'true',
  trust_strip: 'true',
  newsletter_on: 'true',

  // --- reviews & policy
  reviews_moderated: 'true',
  reviews_require_purchase: 'false',
  maintenance_mode: 'false',
  maintenance_message: 'We are upgrading our store. Please check back shortly.',

  // --- seo
  meta_title: 'POINTGH — Your Everyday Online Store in Ghana',
  meta_description: 'Discover electronics, fashion, home, beauty, groceries and more at POINTGH. Account checkout and private order tracking, with delivery across Ghana.',
  meta_keywords: 'POINTGH, online shopping Ghana, Accra, fashion, electronics, home, beauty, groceries',

  // --- demo display defaults; production provider/mode/secrets come from environment
  gateway_mode: 'test',
  gateway_public_key: '',
  gateway_webhook_secret: '',
  gateway_brand: 'POINTGH payment simulator',
};

const GROUPS = {
  store_name: 'identity', store_short: 'identity', tagline: 'identity', logo: 'identity',
  favicon: 'identity', hero_note: 'identity',
  support_phone: 'contact', support_whatsapp: 'contact', support_email: 'contact',
  sales_email: 'contact', address_line: 'contact', address_city: 'contact',
  address_region: 'contact', support_hours: 'contact', facebook: 'contact',
  instagram: 'contact', twitter: 'contact', tiktok: 'contact', youtube: 'contact',
  currency: 'commerce', currency_symbol: 'commerce', tax_rate: 'commerce',
  free_shipping_threshold: 'commerce', default_shipping_fee: 'commerce',
  express_shipping_fee: 'commerce', pickup_fee: 'commerce', min_order: 'commerce',
  cod_enabled: 'payments', momo_enabled: 'payments', card_enabled: 'payments',
  gateway_mode: 'payments', gateway_public_key: 'payments',
  gateway_webhook_secret: 'payments', gateway_brand: 'payments',
  announcement: 'homepage', announcement_on: 'homepage', rail_flash: 'homepage',
  rail_featured: 'homepage', rail_new: 'homepage', rail_best: 'homepage',
  rail_deals: 'homepage', trust_strip: 'homepage', newsletter_on: 'homepage',
  return_days: 'policy', warranty_note: 'policy', reviews_moderated: 'policy',
  reviews_require_purchase: 'policy', maintenance_mode: 'policy',
  maintenance_message: 'policy',
  owner_notification_email: 'notifications', owner_notification_whatsapp: 'notifications', owner_whatsapp_opt_in: 'notifications',
  meta_title: 'seo', meta_description: 'seo', meta_keywords: 'seo',
};

const BOOLEAN_KEYS = new Set(Object.keys(DEFAULTS).filter((k) => DEFAULTS[k] === 'true' || DEFAULTS[k] === 'false'));
const NUMBER_KEYS = new Set([
  'tax_rate', 'free_shipping_threshold', 'default_shipping_fee', 'express_shipping_fee',
  'pickup_fee', 'min_order', 'return_days',
]);

let cache = null;

function load(force = false) {
  if (cache && !force) return cache;
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const map = Object.assign({}, DEFAULTS);
  rows.forEach((r) => { map[r.key] = r.value; });
  cache = map;
  return map;
}

function get(key, fallback) {
  const all = load();
  const v = all[key];
  if (v === undefined || v === null) return fallback !== undefined ? fallback : DEFAULTS[key];
  if (NUMBER_KEYS.has(key)) return Number(v) || 0;
  if (BOOLEAN_KEYS.has(key)) return v === true || v === 'true' || v === '1' || v === 1;
  return v;
}

function all() { return load(); }

function set(key, value) {
  const v = value === undefined || value === null ? '' : String(value);
  db.prepare(
    `INSERT INTO settings (key, value, grp, type, label, updated_at)
     VALUES (@key, @value, @grp, @type, @label, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = datetime('now')`
  ).run({ key, value: v, grp: GROUPS[key] || 'other', type: BOOLEAN_KEYS.has(key) ? 'boolean' : NUMBER_KEYS.has(key) ? 'number' : 'text', label: key });
  load(true);
}

function setMany(obj) {
  const tx = db.transaction((entries) => {
    entries.forEach(([k, v]) => {
      db.prepare(
        `INSERT INTO settings (key, value, grp, type, label, updated_at)
         VALUES (@key, @value, @grp, @type, @label, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = datetime('now')`
      ).run({ key: k, value: v == null ? '' : String(v), grp: GROUPS[k] || 'other', type: 'text', label: k });
    });
  });
  tx(Object.entries(obj || {}));
  load(true);
}

/** Ensure every default key exists in the table (used by the seed). */
function ensureDefaults() {
  const existing = new Set(db.prepare('SELECT key FROM settings').all().map((r) => r.key));
  const insert = db.prepare(
    'INSERT INTO settings (key, value, grp, type, label) VALUES (?,?,?,?,?)'
  );
  const tx = db.transaction(() => {
    Object.entries(DEFAULTS).forEach(([k, v]) => {
      if (existing.has(k)) return;
      insert.run(k, v, GROUPS[k] || 'other', BOOLEAN_KEYS.has(k) ? 'boolean' : NUMBER_KEYS.has(k) ? 'number' : 'text', k);
    });
  });
  tx();
  load(true);
}

function asJson(key, fallback) { return parseJson(get(key, JSON.stringify(fallback)), fallback); }

module.exports = { get, set, setMany, all, ensureDefaults, DEFAULTS, GROUPS, BOOLEAN_KEYS, NUMBER_KEYS, asJson };
