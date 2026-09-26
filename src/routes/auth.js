'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const settings = require('../services/settings');
const auth = require('../middleware/auth');
const { sendMail, audit } = require('../utils/log');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: config.security.loginWindowMs,
  max: config.security.loginMaxAttempts,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Too many sign-in attempts. Please wait 15 minutes and try again.' },
  handler(req, res, _next, options) {
    if (req.xhr || req.headers.accept === 'application/json') return res.status(429).json(options.message);
    req.flash('danger', options.message.message);
    return res.status(429).render('auth/login', { pageTitle: 'Sign in', bodyClass: 'page-auth', error: options.message.message, values: {} });
  },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 12, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, message: 'Too many accounts created from this connection. Try again later.' },
});

/* ------------------------------------------------------------------ login */
router.get('/login', auth.guestOnly, (req, res) => {
  res.render('auth/login', {
    pageTitle: `Sign in | ${settings.get('store_name')}`,
    bodyClass: 'page-auth',
    error: null,
    values: { email: (req.query.email || '').trim() },
    returnTo: req.session.returnTo || null,
    demoHint: !config.isProd,
  });
});

router.post('/login', loginLimiter, auth.guestOnly, (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const result = auth.credentials(email, password);

  if (!result.ok) {
    audit(req, 'auth.login_failed', 'user', null, { email });
    if (req.xhr) return res.status(401).json({ ok: false, message: result.message });
    return res.status(401).render('auth/login', {
      pageTitle: `Sign in | ${settings.get('store_name')}`,
      bodyClass: 'page-auth',
      error: result.message,
      values: { email },
      returnTo: req.session.returnTo || null,
      demoHint: !config.isProd,
    });
  }

  auth.login(req, result.user);
  const returnTo = req.session.returnTo;
  const adminReturn = req.session.adminReturn;
  delete req.session.returnTo;
  delete req.session.adminReturn;

  req.flash('success', `Welcome back, ${result.user.name.split(' ')[0]}!`);
  if (req.xhr) return res.json({ ok: true, redirect: adminReturn || returnTo || '/account' });
  if (adminReturn || (result.user.role !== 'customer')) return res.redirect(adminReturn || '/admin');
  return res.redirect(returnTo || '/account');
});

/* --------------------------------------------------------------- register */
router.get('/register', auth.guestOnly, (req, res) => {
  res.render('auth/register', {
    pageTitle: `Create your account | ${settings.get('store_name')}`,
    bodyClass: 'page-auth',
    errors: {},
    values: {},
  });
});

router.post('/register', registerLimiter, auth.guestOnly, (req, res) => {
  const values = {
    name: (req.body.name || '').trim(),
    email: (req.body.email || '').trim().toLowerCase(),
    phone: (req.body.phone || '').replace(/[\s-]/g, ''),
    password: req.body.password || '',
    confirm: req.body.confirm_password || '',
  };
  const errors = {};

  if (values.name.length < 3) errors.name = 'Enter your full name (at least 3 characters).';
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(values.email)) errors.email = 'Enter a valid email address.';
  if (values.phone && !/^(\+233|0)\d{9}$/.test(values.phone)) errors.phone = 'Enter a valid Ghanaian phone number.';
  if (values.password.length < 8) errors.password = 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(values.password)) errors.password = 'Include at least one capital letter.';
  if (!/[0-9]/.test(values.password)) errors.password = 'Include at least one number.';
  if (values.password !== values.confirm) errors.confirm = 'Passwords do not match.';
  if (!values.terms && req.body.terms !== '1' && req.body.terms !== 'on') errors.terms = 'Please accept the terms and privacy policy.';

  const exists = db.prepare('SELECT id, role FROM users WHERE email = ?').get(values.email);
  if (exists) errors.email = 'An account with this email already exists. Try signing in.';

  if (Object.keys(errors).length) {
    if (req.xhr) return res.status(400).json({ ok: false, errors, message: Object.values(errors)[0] });
    return res.status(400).render('auth/register', {
      pageTitle: `Create your account | ${settings.get('store_name')}`,
      bodyClass: 'page-auth', errors, values,
    });
  }

  // NOTE: role is always 'customer' — owner/staff accounts are created by the
  // owner inside the admin panel, never through public registration.
  const info = db.prepare(
    `INSERT INTO users (name, email, phone, password_hash, role, email_verified)
     VALUES (?,?,?,?, 'customer', 0)`
  ).run(values.name, values.email, values.phone || null, bcrypt.hashSync(values.password, 10));

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  auth.login(req, user);
  sendMail({
    to: user.email, subject: `Welcome to ${settings.get('store_name')}!`,
    text: `Hi ${user.name},\n\nYour account is ready. Track orders, save your wishlist and check out faster next time.\n\n${config.publicUrl}/account`,
  });
  audit(req, 'auth.register', 'user', user.id, {});
  req.flash('success', 'Your account is ready — welcome to Biahens Enterprise!');
  const returnTo = req.session.returnTo;
  delete req.session.returnTo;
  return res.redirect(returnTo || '/account');
});

/* ----------------------------------------------------------------- logout */
router.post('/logout', (req, res) => {
  const wasAdmin = req.user && req.user.role !== 'customer';
  auth.logout(req);
  res.clearCookie(config.session.name);
  req.session = null;
  if (req.xhr) return res.json({ ok: true, redirect: wasAdmin ? '/admin/login' : '/' });
  return res.redirect(wasAdmin ? '/admin/login' : '/');
});
router.get('/logout', (req, res) => {
  auth.logout(req);
  return res.redirect('/');
});

/* -------------------------------------------------- password reset (stub) */
router.get('/forgot-password', auth.guestOnly, (req, res) => {
  res.render('auth/forgot', {
    pageTitle: `Reset your password | ${settings.get('store_name')}`,
    bodyClass: 'page-auth', token: null, sent: false, error: null, email: '',
  });
});

router.post('/forgot-password', auth.guestOnly, (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const generic = {
    pageTitle: `Reset your password | ${settings.get('store_name')}`,
    bodyClass: 'page-auth', sent: true, email, token: null, error: null,
  };
  if (!user) {
    // Never reveal whether an account exists.
    sendMail({ to: email, subject: 'Password reset requested', text: 'No account was found for this address.' });
    return res.render('auth/forgot', generic);
  }
  const token = crypto.randomBytes(24).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  db.prepare('DELETE FROM password_resets WHERE email = ?').run(user.email);
  db.prepare(
    `INSERT INTO password_resets (email, token_hash, expires_at) VALUES (?,?, datetime('now','+45 minutes'))`
  ).run(user.email, hash);
  const link = `${config.publicUrl}/reset-password/${token}`;
  sendMail({
    to: user.email, subject: `Reset your ${settings.get('store_name')} password`,
    text: `Hi ${user.name},\n\nReset your password within 45 minutes:\n${link}\n\nIf you did not request this, ignore this email.`,
  });
  audit(req, 'auth.password_reset_requested', 'user', user.id, {});
  return res.render('auth/forgot', Object.assign({}, generic, {
    devLink: config.isProd ? null : link,
  }));
});

router.get('/reset-password/:token', auth.guestOnly, (req, res) => {
  const hash = crypto.createHash('sha256').update(req.params.token).digest('hex');
  const row = db.prepare(
    `SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')`
  ).get(hash);
  if (!row) {
    req.flash('danger', 'That reset link is invalid or has expired. Please request a new one.');
    return res.redirect('/forgot-password');
  }
  return res.render('auth/reset', {
    pageTitle: `Choose a new password | ${settings.get('store_name')}`,
    bodyClass: 'page-auth', token: req.params.token, email: row.email, error: null, values: {},
  });
});

router.post('/reset-password/:token', auth.guestOnly, (req, res) => {
  const hash = crypto.createHash('sha256').update(req.params.token).digest('hex');
  const row = db.prepare(
    `SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')`
  ).get(hash);
  if (!row) {
    req.flash('danger', 'That reset link is invalid or has expired.');
    return res.redirect('/forgot-password');
  }
  const password = req.body.password || '';
  const confirm = req.body.confirm_password || '';
  const error = password.length < 8 ? 'Password must be at least 8 characters.'
    : !/[A-Z]/.test(password) ? 'Include at least one capital letter.'
      : !/[0-9]/.test(password) ? 'Include at least one number.'
        : password !== confirm ? 'Passwords do not match.' : null;
  if (error) {
    return res.status(400).render('auth/reset', {
      pageTitle: 'Choose a new password', bodyClass: 'page-auth',
      token: req.params.token, email: row.email, error, values: {},
    });
  }
  db.prepare(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE email = ?`)
    .run(bcrypt.hashSync(password, 10), row.email);
  db.prepare(`UPDATE password_resets SET used_at = datetime('now') WHERE id = ?`).run(row.id);
  audit(req, 'auth.password_reset_used', 'user', null, { email: row.email });
  req.flash('success', 'Password updated — you can sign in now.');
  return res.redirect('/login');
});

module.exports = router;
