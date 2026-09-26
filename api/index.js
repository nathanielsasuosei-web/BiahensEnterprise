'use strict';
/**
 * Vercel Function entry point.
 *
 * vercel.json rewrites every non-static request here:
 *   { "source": "/(.*)", "destination": "/api" }
 *
 * Vercel takes the exported Express app and calls it as a request handler —
 * there is no listen() and no long-lived process. src/app.js pulls in
 * src/db/bootstrap.js, which restores the database baked at build time into
 * /tmp before the first query runs.
 */
const app = require('../src/app');

module.exports = app;
