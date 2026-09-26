'use strict';
/**
 * Central configuration. Every value has a working default so the app boots
 * without a .env file.
 */
require('dotenv').config();

const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const bool = (v, d = false) => (v === undefined ? d : String(v).toLowerCase() === 'true');
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

/*
 * Serverless platforms (Vercel, Netlify, Lambda) mount the project read-only —
 * only /tmp is writable, and even that is wiped when the instance recycles.
 * At *build* time the filesystem IS writable, so we build a seeded database
 * into ./data and copy it into /tmp on the first request of each instance.
 * BIAHENS_BUILD=1 is set by scripts/vercel-build.js to opt out of /tmp paths.
 */
const isServerless = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME || !!process.env.NETLIFY;
const isBuilding = bool(process.env.BIAHENS_BUILD, false);
const ephemeralFs = isServerless && !isBuilding;

const publicUrl = (() => {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${num(process.env.PORT, 3000)}`;
})();

const config = {
  root,
  env: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  isServerless,
  isVercel: !!process.env.VERCEL,
  ephemeralFs,
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  publicUrl: publicUrl.replace(/\/$/, ''),

  db: {
    file: process.env.DB_FILE
      ? path.resolve(root, process.env.DB_FILE)
      : ephemeralFs ? '/tmp/biahens.sqlite' : path.resolve(root, 'data', 'biahens.sqlite'),
    /** Database baked at build time — copied into /tmp on cold start. */
    baked: path.resolve(root, 'data', 'biahens.sqlite'),
    /** Seed automatically when the database has no products (serverless boot). */
    autoSeed: ephemeralFs || bool(process.env.SEED_ON_BOOT, false),
  },

  session: {
    secret: process.env.SESSION_SECRET || 'change-me-biahens-enterprise-session-secret',
    name: 'biahens.sid',
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  },

  owner: {
    name: process.env.OWNER_NAME || 'Owner',
    email: (process.env.OWNER_EMAIL || 'owner@biahensenterprise.com').toLowerCase(),
    password: process.env.OWNER_PASSWORD || 'Biahens@2026',
    phone: process.env.OWNER_PHONE || '+233 24 000 0000',
  },

  payments: {
    mode: process.env.GATEWAY_MODE || 'test', // test | live
    publicKey: process.env.PAYSTACK_PUBLIC_KEY || '',
    secretKey: process.env.PAYSTACK_SECRET_KEY || '',
    webhookSecret: process.env.PAYSTACK_WEBHOOK_SECRET || 'whsec_biahens_local_test_secret',
    momoProvider: process.env.MOMO_PROVIDER || 'mock',
  },

  catalog: {
    currency: process.env.DEFAULT_CURRENCY || 'GHS',
    currencySymbol: 'GH\u20B5',
    locale: 'en-GH',
    pageSize: 24,
    adminPageSize: 20,
    freeShippingThreshold: num(process.env.FREE_SHIPPING_THRESHOLD, 1500),
    defaultShippingFee: num(process.env.DEFAULT_SHIPPING_FEE, 35),
    taxRate: num(process.env.TAX_RATE, 0), // VAT is baked into listed prices by default
  },

  uploads: {
    // Serverless: write into /tmp (ephemeral) and serve through Express.
    dir: process.env.UPLOADS_DIR
      ? path.resolve(root, process.env.UPLOADS_DIR)
      : ephemeralFs ? '/tmp/uploads' : path.resolve(root, 'public', 'uploads'),
    // Vercel caps request bodies at 4.5 MB, so stay just under it there.
    maxFileSize: num(process.env.MAX_UPLOAD_MB, isServerless ? 4 : 8) * 1024 * 1024,
    allowed: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'],
    widths: { thumb: 200, card: 480, large: 1000 },
  },

  security: {
    loginWindowMs: 15 * 60 * 1000,
    loginMaxAttempts: 10,
    adminLoginMaxAttempts: 6,
    apiWindowMs: 60 * 1000,
    apiMax: 240,
  },
};

module.exports = config;
