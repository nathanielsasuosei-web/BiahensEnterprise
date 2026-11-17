'use strict';
/**
 * Netlify Function entry point for Biahens Enterprise.
 *
 * netlify.toml redirects all non-static requests here:
 *   [[redirects]]
 *     from = "/*"
 *     to = "/.netlify/functions/api/:splat"
 *     status = 200
 *
 * serverless-http wraps Express for AWS Lambda / Netlify Functions.
 * We normalize event.path and query parameters so Express matches the original
 * requested path whether invoked directly or via redirect rewrite.
 */
const serverless = require('serverless-http');
const app = require('../../src/app');

const serverlessHandler = serverless(app, {
  binary: [
    'image/*',
    'font/*',
    'application/octet-stream',
    'application/pdf',
    'application/zip',
  ],
});

exports.handler = async (event, context) => {
  // Normalize path and query string when rewritten by Netlify redirects
  if (event.rawUrl) {
    try {
      const parsed = new URL(event.rawUrl);
      event.path = parsed.pathname;
      if (!event.queryStringParameters && parsed.search) {
        event.queryStringParameters = {};
        parsed.searchParams.forEach((val, key) => {
          event.queryStringParameters[key] = val;
        });
      }
    } catch (_) {
      if (event.path) {
        event.path = event.path.replace(/^\/\.netlify\/functions\/[^\/]+/, '') || '/';
      }
    }
  } else if (event.path) {
    event.path = event.path.replace(/^\/\.netlify\/functions\/[^\/]+/, '') || '/';
  }

  // Ensure client IP is available on requestContext to prevent rate-limit errors
  if (!event.requestContext) event.requestContext = {};
  if (!event.requestContext.identity) event.requestContext.identity = {};
  if (!event.requestContext.identity.sourceIp) {
    const clientIp = (event.headers && (
      event.headers['x-nf-client-connection-ip'] ||
      event.headers['client-ip'] ||
      event.headers['x-forwarded-for']
    )) || '127.0.0.1';
    event.requestContext.identity.sourceIp = clientIp.split(',')[0].trim();
  }

  return serverlessHandler(event, context);
};
