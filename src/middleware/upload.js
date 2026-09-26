'use strict';
const multer = require('multer');
const config = require('../config');
const { saveUpload } = require('../utils/images');

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: config.uploads.maxFileSize, files: 10 },
  fileFilter(req, file, cb) {
    if (config.uploads.allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error(`Unsupported file type "${file.mimetype}". Use JPG, PNG, WEBP, AVIF or GIF.`));
  },
});

/**
 * Turn uploaded buffers into optimised files and return their public URLs.
 * req.uploaded = [{ url, card, thumb, large, name, size }]
 */
async function processUploads(req, _res, next) {
  try {
    const files = [].concat(req.files || req.file || []);
    if (!files.length) return next();
    const folder = req.body && req.body.upload_folder === 'banners' ? 'banners'
      : req.body && req.body.upload_folder === 'brands' ? 'brands' : 'products';
    const out = [];
    for (const f of files) {
      // eslint-disable-next-line no-await-in-loop
      const saved = await saveUpload(f.buffer, {
        folder, mime: f.mimetype, name: (f.originalname || 'image').replace(/\.\w+$/, ''),
      });
      out.push(Object.assign({ name: f.originalname, size: f.size }, saved));
    }
    req.uploaded = out;
    next();
  } catch (err) {
    next(err);
  }
}

function uploadErrors(err, req, res, _next) {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE'
      ? `Image too large (max ${Math.round(config.uploads.maxFileSize / 1024 / 1024)}MB).`
      : err.code === 'LIMIT_FILE_COUNT' ? 'Too many files in one upload (max 10).' : err.message;
    if (req.xhr || req.headers.accept === 'application/json') return res.status(400).json({ ok: false, message: msg });
    req.flash('danger', msg);
    return res.redirect(req.get('Referrer') || '/admin');
  }
  return res.status(400).json({ ok: false, message: err.message || 'Upload failed.' });
}

module.exports = { upload, processUploads, uploadErrors };
