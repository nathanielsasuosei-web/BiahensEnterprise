'use strict';
const db = require('../db');

/** Append an entry to the admin audit trail. */
function audit(req, action, entity, entityId, meta) {
  try {
    db.prepare(
      `INSERT INTO audit_log (actor_id, actor_name, actor_role, action, entity, entity_id, meta, ip)
       VALUES (@actor_id, @actor_name, @actor_role, @action, @entity, @entity_id, @meta, @ip)`
    ).run({
      actor_id: req.user ? req.user.id : null,
      actor_name: req.user ? req.user.name : 'anonymous',
      actor_role: req.user ? req.user.role : 'guest',
      action,
      entity: entity || null,
      entity_id: entityId == null ? null : String(entityId),
      meta: JSON.stringify(meta || {}),
      ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
    });
  } catch (err) {
    // Audit failures must never break a request
    console.error('[audit]', err.message);
  }
}

/** Push a bell notification into the admin panel. */
function notify(type, level, title, body, link) {
  try {
    db.prepare(
      `INSERT INTO notifications (type, level, title, body, link) VALUES (?,?,?,?,?)`
    ).run(type, level, title, body || null, link || null);
  } catch (err) {
    console.error('[notify]', err.message);
  }
}

/** Dev "outbox" -- emails are recorded instead of sent so nothing is lost. */
const outbox = [];
function sendMail({ to, subject, text, html }) {
  const msg = { to, subject, text, html, at: new Date().toISOString() };
  outbox.unshift(msg);
  if (outbox.length > 100) outbox.pop();
  console.log(`\n✉  [mail-outbox] to=${to} subject="${subject}"\n`);
  return msg;
}

module.exports = { audit, notify, sendMail, outbox };
