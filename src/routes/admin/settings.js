'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../../db');
const config = require('../../config');
const settings = require('../../services/settings');
const auth = require('../../middleware/auth');
const payments = require('../../services/payments');
const { audit } = require('../../utils/log');
const { GHANA_REGIONS, round2, dateFmt } = require('../../utils/helpers');
const { imgSrc } = require('../../utils/images');

const router = express.Router();

/** Everything under /admin/settings is strictly owner-only. */
router.use(auth.requireOwner);

router.get('/', (req, res) => {
  const tab = ['general', 'contact', 'commerce', 'payments', 'homepage', 'policy', 'seo'].includes(req.query.tab)
    ? req.query.tab : 'general';
  res.render('admin/settings/index', {
    layout: false,
    pageTitle: 'Store settings | Admin',
    bodyClass: 'admin admin-settings',
    adminNav: 'settings',
    tab,
    values: settings.all(),
    defaults: settings.DEFAULTS,
    zones: db.prepare('SELECT * FROM shipping_rates ORDER BY sort_order, region').all(),
    regions: GHANA_REGIONS,
    staff: db.prepare(`SELECT id, name, email, phone, role, is_blocked, last_login_at, created_at FROM users WHERE role != 'customer' ORDER BY role DESC, name`).all(),
    logoSrc: imgSrc(settings.get('logo'), { w: 320, h: 120, name: '', hint: 'generic' }),
    dateFmt,
    gatewayMode: payments.mode(),
    dbSize: (() => {
      try {
        const fs = require('fs');
        return round2(fs.statSync(config.db.file).size / 1024);
      } catch (_) { return 0; }
    })(),
  });
});

router.post('/general', (req, res) => {
  const allowed = Object.keys(settings.DEFAULTS);
  const patch = {};
  allowed.forEach((k) => {
    if (req.body[k] === undefined) {
      // unchecked checkboxes arrive missing
      if (settings.BOOLEAN_KEYS.has(k)) patch[k] = 'false';
      return;
    }
    patch[k] = String(req.body[k]).trim();
  });
  // logo/favicon come from the uploader
  if (req.uploaded && req.uploaded.length) {
    const field = req.body.image_field || 'logo';
    patch[field] = req.uploaded[0].url;
  }
  settings.setMany(patch);
  audit(req, 'settings.update', 'settings', null, { keys: Object.keys(patch).length });
  req.flash('success', 'Settings saved.');
  return res.redirect(`/admin/settings?tab=${req.body.tab || 'general'}`);
});

router.post('/settings/save', (req, res) => {
  const patch = {};
  Object.keys(req.body).forEach((k) => {
    if (k === 'tab' || k === 'image_field') return;
    patch[k] = typeof req.body[k] === 'string' ? req.body[k].trim() : req.body[k];
  });
  settings.setMany(patch);
  audit(req, 'settings.update', 'settings', null, { keys: Object.keys(patch).length, tab: req.body.tab });
  req.flash('success', 'Settings saved.');
  return res.redirect(`/admin/settings?tab=${req.body.tab || 'general'}`);
});

/* ------------------------------------------------------- shipping zones */
router.post('/shipping', (req, res) => {
  const region = String(req.body.region || '').trim();
  if (!region) { req.flash('danger', 'Choose a region.'); return res.redirect('/admin/settings?tab=commerce'); }
  const data = {
    region,
    fee: round2(Number(req.body.fee) || 0),
    eta_days: String(req.body.eta_days || '2–4 days').trim(),
    is_active: req.body.is_active === '1' || req.body.is_active === 'on' ? 1 : 0,
    sort_order: Number(req.body.sort_order) || 99,
  };
  db.prepare(
    `INSERT INTO shipping_rates (region, fee, eta_days, is_active, sort_order)
     VALUES (@region,@fee,@eta_days,@is_active,@sort_order)
     ON CONFLICT(region) DO UPDATE SET fee=@fee, eta_days=@eta_days, is_active=@is_active, sort_order=@sort_order`
  ).run(data);
  audit(req, 'shipping.upsert', 'shipping_rate', region, data);
  req.flash('success', `Delivery rate for ${region} saved.`);
  return res.redirect('/admin/settings?tab=commerce');
});

router.post('/shipping/:id/delete', (req, res) => {
  db.prepare('DELETE FROM shipping_rates WHERE id = ?').run(Number(req.params.id));
  audit(req, 'shipping.delete', 'shipping_rate', req.params.id, {});
  req.flash('info', 'Delivery rate removed — the default fee now applies to that region.');
  return res.redirect('/admin/settings?tab=commerce');
});

router.post('/shipping/bulk-defaults', (req, res) => {
  const tx = db.transaction(() => {
    GHANA_REGIONS.forEach((region, i) => {
      db.prepare(
        `INSERT INTO shipping_rates (region, fee, eta_days, sort_order, is_active)
         VALUES (?, ?, '2–4 days', ?, 1)
         ON CONFLICT(region) DO NOTHING`
      ).run(region, region === 'Greater Accra' ? 0 : 45, i + 1);
    });
  });
  tx();
  audit(req, 'shipping.seed_defaults', 'shipping_rate', null, {});
  req.flash('success', 'Default delivery rates created for all 16 regions.');
  return res.redirect('/admin/settings?tab=commerce');
});

/* ---------------------------------------------------------------- staff */
router.post('/staff', (req, res) => {
  const id = req.body.id ? Number(req.body.id) : null;
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim();
  const role = req.body.role === 'owner' ? 'owner' : 'staff';
  const password = String(req.body.password || '');

  if (name.length < 3 || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) {
    req.flash('danger', 'Enter a valid name and email.');
    return res.redirect('/admin/settings?tab=general');
  }
  const clash = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (clash && clash.id !== id) {
    req.flash('danger', 'That email is already registered.');
    return res.redirect('/admin/settings?tab=general');
  }
  if (!id && password.length < 8) {
    req.flash('danger', 'Set a password of at least 8 characters.');
    return res.redirect('/admin/settings?tab=general');
  }

  if (id) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user || user.role === 'customer') { req.flash('danger', 'Staff account not found.'); return res.redirect('/admin/settings?tab=general'); }
    if (user.id === req.user.id && role !== 'owner') {
      req.flash('danger', 'You cannot remove your own owner access.');
      return res.redirect('/admin/settings?tab=general');
    }
    db.prepare(`UPDATE users SET name=@name, email=@email, phone=@phone, role=@role,
      password_hash = CASE WHEN @pw != '' THEN @hash ELSE password_hash END, updated_at = datetime('now') WHERE id=@id`)
      .run({ id, name, email, phone, role, pw: password, hash: bcrypt.hashSync(password || 'x', 10) });
    audit(req, 'staff.update', 'user', id, { role });
    req.flash('success', `${name} updated.`);
  } else {
    const info = db.prepare(
      `INSERT INTO users (name, email, phone, password_hash, role, email_verified) VALUES (?,?,?,?,?,1)`
    ).run(name, email, phone || null, bcrypt.hashSync(password, 10), role);
    audit(req, 'staff.create', 'user', info.lastInsertRowid, { role });
    req.flash('success', `${name} can now sign in at /admin/login.`);
  }
  return res.redirect('/admin/settings?tab=general');
});

router.post('/staff/:id/block', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!user || user.role === 'customer') return res.redirect('/admin/settings?tab=general');
  if (user.id === req.user.id) { req.flash('danger', 'You cannot suspend your own account.'); return res.redirect('/admin/settings?tab=general'); }
  db.prepare('UPDATE users SET is_blocked = ? WHERE id = ?').run(user.is_blocked ? 0 : 1, user.id);
  audit(req, user.is_blocked ? 'staff.unblock' : 'staff.block', 'user', user.id, {});
  req.flash('info', `${user.name} ${user.is_blocked ? 'can sign in again' : 'has been suspended'}.`);
  return res.redirect('/admin/settings?tab=general');
});

router.post('/staff/:id/delete', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!user || user.role === 'customer') return res.redirect('/admin/settings?tab=general');
  if (user.id === req.user.id) { req.flash('danger', 'You cannot delete your own account.'); return res.redirect('/admin/settings?tab=general'); }
  const owners = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND is_blocked = 0`).get().n;
  if (user.role === 'owner' && owners <= 1) {
    req.flash('danger', 'The store must always have at least one active owner.');
    return res.redirect('/admin/settings?tab=general');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  audit(req, 'staff.delete', 'user', user.id, { name: user.name });
  req.flash('success', `${user.name} no longer has panel access.`);
  return res.redirect('/admin/settings?tab=general');
});

/* -------------------------------------------------------- payment gateway */
router.post('/gateway/test', (req, res) => {
  const reference = String(req.body.reference || '').trim();
  const event = String(req.body.event || 'charge.success');
  if (!reference) { req.flash('danger', 'Enter a payment reference to test.'); return res.redirect('/admin/settings?tab=payments'); }
  const payment = payments.findByReference(reference);
  if (!payment) { req.flash('danger', 'No payment found with that reference.'); return res.redirect('/admin/settings?tab=payments'); }
  const payload = event === 'charge.success' ? payments.buildWebhookPayload(payment)
    : { event, data: { reference, gateway_response: 'Simulated from the admin panel' } };
  const signature = payments.signPayload(payload);
  const handled = payments.handleWebhook(payload, req);
  audit(req, 'gateway.webhook_test', 'payment', payment.id, { event });
  req.flash(handled.ok ? 'success' : 'danger',
    `Webhook ${event} processed${handled.ignored ? ' (ignored)' : ''}. Signature: ${signature.slice(0, 16)}…`);
  return res.redirect(`/admin/orders/${payment.order_id}`);
});

/* ------------------------------------------------------------ danger zone */
router.post('/danger/reset-demo', (req, res) => {
  if (String(req.body.confirm || '') !== 'RESET') {
    req.flash('danger', 'Type RESET to confirm.');
    return res.redirect('/admin/settings?tab=general');
  }
  audit(req, 'system.reset_demo', 'system', null, {});
  try {
    if (config.ephemeralFs) {
      // Serverless runtimes cannot spawn `node src/db/reset.js` — rebuild in-process.
      require('../../db/seed').main({ fresh: true, quiet: true });
      settings.load(true);
    } else {
      const { execFileSync } = require('child_process');
      execFileSync(process.execPath, [require('path').join(config.root, 'src/db/reset.js')], { cwd: config.root, stdio: 'inherit' });
      settings.setMany({});
    }
    req.flash('success', 'Demo dataset rebuilt. Sign in again with the owner credentials.');
  } catch (err) {
    req.flash('danger', `Reset failed: ${err.message}`);
  }
  return res.redirect('/admin/login');
});

module.exports = router;
