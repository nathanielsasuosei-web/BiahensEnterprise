'use strict';
const bcrypt = require('bcryptjs');
const db = require('../db');
const cart = require('../services/cart');
const { audit } = require('../utils/log');
const { isGhanaPhone } = require('../utils/phone');

function safeReturnTo(value, fallback = '/account') {
  const path = typeof value === 'string' ? value : '';
  return /^\/(?!\/)/.test(path) && !/[\\\r\n]/.test(path) ? path : fallback;
}

function loadUser(req, _res, next) {
  if (req.session && req.session.userId) {
    const user = db.prepare(
      'SELECT id, name, email, phone, role, avatar, is_blocked, created_at FROM users WHERE id = ?'
    ).get(req.session.userId);
    if (user && !user.is_blocked) {
      req.user = user;
    } else {
      delete req.session.userId;
      if (user && user.is_blocked) req.session.flash = [{ type: 'danger', text: 'This account has been suspended. Contact support.' }];
    }
  }
  next();
}

function requireUser(req, res, next) {
  if (req.user) return next();
  const pathname = req.originalUrl.split('?')[0];
  if (req.xhr || req.headers.accept === 'application/json' || pathname.startsWith('/api/')) {
    return res.status(401).json({ ok: false, message: 'Please sign in to continue.', loginUrl: '/login' });
  }
  // Never return a shopper to a POST-only endpoint after signing in.
  req.session.returnTo = safeReturnTo(req.method === 'GET' ? req.originalUrl
    : pathname.startsWith('/checkout') ? '/checkout'
      : pathname.startsWith('/pay/') ? pathname.replace(/\/(cancel|simulate-webhook)$/, '')
        : pathname.startsWith('/track-order') ? '/track-order' : '/account');
  req.flash('info', 'Sign in or create an account to checkout and track your orders.');
  return res.redirect('/login');
}

function requireCheckoutAccount(req, res, next) {
  return requireUser(req, res, () => {
    if (isGhanaPhone(req.user.phone)) return next();
    if (req.xhr || req.headers.accept === 'application/json') {
      return res.status(403).json({ ok: false, message: 'Add a valid phone number to your account before checkout.', profileUrl: '/account/profile' });
    }
    req.session.returnTo = '/checkout';
    req.flash('info', 'Add a valid phone number to your profile before checking out.');
    return res.redirect('/account/profile');
  });
}

/**
 * Admin gate. Only the OWNER can manage products, settings and staff —
 * that is the core rule of this store. `staff` can handle orders/customers.
 */
function requireAdmin(req, res, next) {
  if (req.user && (req.user.role === 'owner' || req.user.role === 'staff')) return next();
  if (req.xhr || req.path.startsWith('/admin/api')) {
    return res.status(401).json({ ok: false, message: 'Administrator access required.' });
  }
  req.session.adminReturn = req.originalUrl;
  req.flash('warn', 'Sign in with the owner account to open the control panel.');
  return res.redirect('/admin/login');
}

function requireOwner(req, res, next) {
  if (req.user && req.user.role === 'owner') return next();
  const msg = 'Only the store owner can perform this action.';
  if (req.xhr || req.path.startsWith('/admin/api')) return res.status(403).json({ ok: false, message: msg });
  req.flash('danger', msg);
  return res.redirect(req.get('Referrer') || '/admin');
}

/** Owner-only areas of the panel (catalogue, settings, staff, audit). */
function ownerArea(area) {
  return [requireAdmin, (req, res, next) => {
    if (req.user.role === 'owner') return next();
    req.flash('danger', `Staff accounts cannot open ${area}. Only the store owner can.`);
    return res.redirect('/admin');
  }];
}

function guestOnly(req, res, next) {
  if (req.user) return res.redirect(safeReturnTo(req.session.returnTo));
  next();
}

function credentials(email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  if (!user) return { ok: false, message: 'No account found with that email address.' };
  if (!bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return { ok: false, message: 'Incorrect password. Please try again.' };
  }
  if (user.is_blocked) return { ok: false, message: 'This account has been suspended. Please contact support.' };
  return { ok: true, user };
}

async function login(req, user) {
  const previous = {};
  for (const key of ['returnTo', 'adminReturn', 'checkout', 'shipRegion', 'shipMethod', 'couponCode', 'flash']) {
    if (req.session[key] !== undefined) previous[key] = req.session[key];
  }
  // Preserve a guest bag, but never retain the unauthenticated session ID.
  cart.mergeIntoUser(req.sessionID, user.id);
  await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  Object.assign(req.session, previous, { userId: user.id });
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  audit(req, 'auth.login', 'user', user.id, { role: user.role });
}

function logout(req) {
  if (req.user) audit(req, 'auth.logout', 'user', req.user.id, {});
  const keepFlash = req.session.flash;
  req.session.destroy(() => {});
  return keepFlash;
}

module.exports = {
  loadUser, requireUser, requireCheckoutAccount, requireAdmin, requireOwner, ownerArea, guestOnly, safeReturnTo,
  credentials, login, logout,
};
