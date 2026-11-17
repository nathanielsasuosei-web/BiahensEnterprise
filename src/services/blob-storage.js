'use strict';

/** Small injectable Vercel Blob adapter; upload routes are migrated separately. */
function createBlobStorage({ put, del, token }) {
  if (typeof put !== 'function' || typeof del !== 'function') {
    throw new TypeError('Vercel Blob put and del functions are required.');
  }
  if (!String(token || '').trim()) {
    const error = new Error('Set BLOB_READ_WRITE_TOKEN in the hosting environment.');
    error.code = 'BLOB_READ_WRITE_TOKEN_REQUIRED';
    throw error;
  }

  return {
    async put(pathname, content, { contentType = 'application/octet-stream', cacheControlMaxAge = 31536000 } = {}) {
      if (!Buffer.isBuffer(content)) throw new TypeError('Blob content must be a Buffer.');
      const name = String(pathname || '').replace(/^\/+/, '');
      if (!name || name.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new TypeError('A safe, non-empty Blob pathname is required.');
      }
      const result = await put(name, content, {
        access: 'public',
        addRandomSuffix: false,
        cacheControlMaxAge,
        contentType,
        token,
      });
      if (!result || typeof result.url !== 'string' || !/^https:\/\//i.test(result.url)) {
        throw new Error('Vercel Blob did not return a public HTTPS URL.');
      }
      return { url: result.url, pathname: result.pathname || name };
    },

    async delete(urlOrUrls) {
      const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];
      if (urls.some(url => typeof url !== 'string' || !/^https:\/\//i.test(url))) {
        throw new TypeError('Only HTTPS Blob URLs can be deleted.');
      }
      if (!urls.length) return;
      return del(urls, { token });
    },
  };
}

function createFromEnvironment(env = process.env) {
  const token = String(env.BLOB_READ_WRITE_TOKEN || '').trim();
  if (!token) {
    const error = new Error('Set BLOB_READ_WRITE_TOKEN in the hosting environment.');
    error.code = 'BLOB_READ_WRITE_TOKEN_REQUIRED';
    throw error;
  }
  let blob;
  async function module() {
    if (!blob) blob = import('@vercel/blob');
    return blob;
  }
  return createBlobStorage({
    token,
    put: async (...args) => (await module()).put(...args),
    del: async (...args) => (await module()).del(...args),
  });
}

module.exports = { createBlobStorage, createFromEnvironment };
