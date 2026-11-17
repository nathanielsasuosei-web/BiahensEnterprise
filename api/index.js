'use strict';
/**
 * Vercel's Node request handler. Load the application lazily so an unsafe
 * configuration or unavailable native module returns a controlled 503 rather
 * than crashing the function during module evaluation. Runtime safety checks
 * still run before any database or provider work; they are never bypassed.
 */
let app;
let startupFailed = false;
const diagnosticCodes = new Set([
  'UNSAFE_STORE_CONFIGURATION', 'MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED',
  'SQLITE_CANTOPEN', 'SQLITE_READONLY', 'SQLITE_CORRUPT', 'SQLITE_NOTADB', 'EACCES', 'EROFS', 'ENOENT',
]);
const unavailable = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Temporarily unavailable | POINTGH</title>
<style>body{margin:0;background:#f6f5ef;color:#242820;font:16px/1.6 system-ui,sans-serif;min-height:100vh;display:grid;place-items:center}main{max-width:34rem;padding:2rem}b{letter-spacing:.12em}h1{font-size:clamp(1.8rem,6vw,2.6rem);line-height:1.15}a{color:inherit}</style></head>
<body><main><b>POINTGH</b><h1>Temporarily unavailable</h1><p>The storefront could not start. Please try again later.</p><p>If you already approved a payment, please do not pay again. Keep your order number for support.</p><a href="/">Try the storefront again</a></main></body></html>`;

module.exports = function handler(req, res) {
  if (!app && !startupFailed) {
    try { app = require('../src/app'); }
    catch (error) {
      // Do not leak provider credentials, file paths or arbitrary error text.
      startupFailed = true;
      const code = diagnosticCodes.has(error.code) ? error.code : 'STARTUP_FAILED';
      console.error(`[POINTGH] Function startup failed (${code}).`);
      // This application's configuration diagnostics contain variable names
      // and requirements only, never configured secret values.
      if (code === 'UNSAFE_STORE_CONFIGURATION') console.error(error.message);
    }
  }
  if (app) return app(req, res);

  res.statusCode = 503;
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Retry-After', '60');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const pathname = (req.url || '').split('?')[0];
  const json = pathname === '/healthz' || pathname.startsWith('/api/') || (req.headers.accept || '').includes('application/json');
  res.setHeader('Content-Type', json ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8');
  if (req.method === 'HEAD') return res.end();
  return res.end(json ? JSON.stringify({ ok: false, message: 'The storefront is temporarily unavailable.' }) : unavailable);
};
