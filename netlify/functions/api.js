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
 * We normalize event.path, event.rawPath, and query parameters so Express
 * matches the original requested path whether invoked directly or via rewrite.
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
  // Normalize path and query string across API Gateway v1 / v2 and Netlify rewrites
  let pathname = '/';
  if (event.rawUrl) {
    try {
      const parsed = new URL(event.rawUrl);
      pathname = parsed.pathname || '/';
      if (!event.queryStringParameters && parsed.search) {
        event.queryStringParameters = {};
        parsed.searchParams.forEach((val, key) => {
          event.queryStringParameters[key] = val;
        });
      }
    } catch (_) {
      pathname = (event.path || '/').replace(/^\/\.netlify\/functions\/[^\/]+/, '') || '/';
    }
  } else if (event.path) {
    pathname = event.path.replace(/^\/\.netlify\/functions\/[^\/]+/, '') || '/';
  }

  event.path = pathname;
  event.rawPath = pathname;
  if (event.requestPath) event.requestPath = pathname;

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
