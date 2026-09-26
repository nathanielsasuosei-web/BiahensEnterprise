'use strict';
const bcrypt = require('bcryptjs');
const db = require('../db');
const cart = require('../services/cart');
const { audit } = require('../utils/log');

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
  if (req.xhr || req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, message: 'Please sign in to continue.', loginUrl: '/login' });
  }
  req.session.returnTo = req.originalUrl;
  req.flash('info', 'Please sign in to continue.');
  return res.redirect('/login');
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
  if (req.user) return res.redirect(req.session.returnTo || '/account');
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

function login(req, user) {
  // Merge the guest cart BEFORE switching the cart key to the account.
  cart.mergeIntoUser(req.sessionID, user.id);
  req.session.userId = user.id;
  req.session.adminReturn = null;
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(user.id);
  audit(req, 'auth.login', 'user', user.id, { role: user.role });
}

function logout(req) {
  if (req.user) audit(req, 'auth.logout', 'user', req.user.id, {});
  const keepFlash = req.session.flash;
  req.session.destroy(() => {});
  return keepFlash;
}

module.exports = {
  loadUser, requireUser, requireAdmin, requireOwner, ownerArea, guestOnly,
  credentials, login, logout,
};
