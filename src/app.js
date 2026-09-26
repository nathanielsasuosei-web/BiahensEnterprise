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

/* ------------------------------------------------------------ view engine */
app.set('views', path.join(config.root, 'views'));
app.set('view engine', 'ejs');

/* ------------------------------------------------------------- middleware */
app.use(compression());
app.use(morgan(config.isProd ? 'combined' : 'dev', {
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

app.use(cookieParser());
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Webhook endpoints must see the RAW body for HMAC verification.
app.use('/webhooks', express.raw({ type: '*/*', limit: '1mb' }));
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
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.path.startsWith('/admin')) {
    res.set('Cache-Control', 'no-store, max-age=0');
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
