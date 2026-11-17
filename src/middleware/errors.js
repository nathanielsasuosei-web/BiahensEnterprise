'use strict';
const config = require('../config');

function notFound(req, res) {
  if (req.path.startsWith('/api/') || req.path.startsWith('/admin/api')) {
    return res.status(404).json({ ok: false, message: 'Endpoint not found.' });
  }
  res.status(404);
  return res.render('errors/404', {
    pageTitle: 'Page not found — POINTGH',
    bodyClass: 'page-error',
    path: req.path,
  });
}

// eslint-disable-next-line no-unused-vars
function handler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  if (status === 404) return notFound(req, res);

  const safePath = req.path.replace(/^(\/reset-password\/)[^/]+/, '$1[redacted]');
  if (config.isProd) console.error(`[request error] ${req.method} ${safePath} — ${err.code || err.name || 'Error'}`);
  else console.error(`\n✖  ${req.method} ${req.originalUrl}\n   ${err.stack || err.message}\n`);

  const message = status < 500 || !config.isProd ? err.message : 'Something went wrong on our side.';
  if (req.xhr || req.path.startsWith('/api') || req.headers.accept === 'application/json') {
    return res.status(status).json({ ok: false, message, stack: config.isProd ? undefined : err.stack });
  }
  res.status(status);
  return res.render('errors/error', {
    pageTitle: 'Error — POINTGH',
    bodyClass: 'page-error',
    status,
    message,
    stack: config.isProd ? null : err.stack,
  });
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { notFound, handler, asyncRoute };
