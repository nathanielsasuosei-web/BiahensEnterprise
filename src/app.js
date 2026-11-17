'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const config = require('./config');
// On serverless platforms this restores the baked database into /tmp and
// seeds it if needed — it must run before anything touches the DB.
require('./db/bootstrap').bootstrap();
const db = require('./db');
const settings = require('./services/settings');
const SQLiteStore = require('./db/sessionStore');
const { loadUser } = require('./middleware/auth');
const { context } = require('./middleware/context');
const { notFound, handler } = require('./middleware/errors');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Process/database liveness only; no session, customer data, provider calls or
// maintenance page. Deployment readiness is a separate owner-only check.
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try { db.prepare('SELECT 1').get(); return res.json({ ok: true }); }
  catch (_) { return res.status(503).json({ ok: false }); }
});
app.use(require('./middleware/origin').sameOriginMutation);

/* ------------------------------------------------------------ view engine */
app.set('views', path.join(config.root, 'views'));
app.set('view engine', 'ejs');

/* ------------------------------------------------------------- middleware */
app.use(compression());
morgan.token('pointgh-path', req => req.path.replace(/^(\/reset-password\/)[^/]+/, '$1[redacted]'));
app.use(morgan(config.isProd ? ':remote-addr :method :pointgh-path :status :res[content-length] :response-time ms' : 'dev', {
  skip: (req) => req.path.startsWith('/img/ph.svg') || req.path.endsWith('.css') || req.path.endsWith('.js'),
}));

// Static assets (uploads included)
app.use(express.static(path.join(config.root, 'public'), {
  maxAge: config.isProd ? '7d' : 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.svg')) res.set('Cache-Control', 'public, max-age=604800');
  },
}));

// Runtime uploads live outside ./public on serverless hosts (/tmp/uploads),
// so they need their own mount. Short cache: files are immutable by name.
if (path.resolve(config.uploads.dir) !== path.resolve(path.join(config.root, 'public', 'uploads'))) {
  app.use('/uploads', express.static(config.uploads.dir, { maxAge: '1h', fallthrough: true }));
}

// This must precede every body parser, including urlencoded. A parsed object
// reserialized into JSON is not the raw body Paystack signed.
app.use('/webhooks', express.raw({ type: '*/*', limit: '1mb', inflate: false }), require('./routes/webhooks'),
  (error, _req, res, _next) => res.status([400, 413, 415].includes(error.status) ? error.status : 400)
    .json({ ok: false, message: 'Invalid webhook request body.' }));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use('/admin/api', express.json({ limit: '1mb' }));
app.use('/api', express.json({ limit: '1mb' }));

app.use(session({
  name: config.session.name,
  secret: config.session.secret,
  store: new SQLiteStore({ ttl: config.session.maxAge }),
  resave: false,
  saveUninitialized: true,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd && config.publicUrl.startsWith('https'),
    maxAge: config.session.maxAge,
  },
}));

app.use(loadUser);

// polite rate limiting for JSON endpoints
app.use('/api', rateLimit({
  windowMs: config.security.apiWindowMs,
  max: config.security.apiMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Too many requests — slow down a little.' },
}));

app.use(context);

/* --------------------------------------------------------- security heads */
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  // Allow the development storefront to be embedded in the live preview.
  // The deployed shop keeps its same-origin clickjacking protection.
  if (config.isProd) res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (config.storeMode === 'live' && config.publicUrl.startsWith('https:')) res.set('Strict-Transport-Security', 'max-age=31536000');
  if (/^\/(admin|account|checkout|order|pay|track-order|login|register|forgot-password|reset-password|api\/(?:orders|internal))(\/|$)/.test(req.path)) {
    res.set('Cache-Control', 'private, no-store, max-age=0');
  }
  next();
});

/* -------------------------------------------------------------- maintenance */
app.use((req, res, next) => {
  if (settings.get('maintenance_mode') && !req.path.startsWith('/admin')
      && !req.path.startsWith('/api') && !req.path.startsWith('/webhooks')
      && !req.path.startsWith('/img') && !req.path.startsWith('/pay')
      && !(req.user && req.user.role !== 'customer')) {
    return res.status(503).render('errors/maintenance', {
      layout: false,
      pageTitle: 'Temporarily unavailable',
      message: settings.get('maintenance_message'),
    });
  }
  return next();
});

/* ------------------------------------------------------------------ routes */
app.use('/', require('./routes/api'));       // /img/ph.svg, /api/*
app.use('/', require('./routes/site'));      // home, catalogue, pages
app.use('/', require('./routes/auth'));      // login, register, reset
app.use('/', require('./routes/cart'));      // cart, wishlist
app.use('/', require('./routes/checkout'));  // checkout, confirmation
app.use('/', require('./routes/pay'));       // hosted gateway + webhooks
app.use('/account', require('./routes/account'));
app.use('/admin', require('./routes/admin'));

app.use(notFound);
app.use(handler);

module.exports = app;
