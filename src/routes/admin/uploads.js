'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const auth = require('../../middleware/auth');
const { upload, processUploads, uploadErrors } = require('../../middleware/upload');
const { audit } = require('../../utils/log');

const router = express.Router();

/** Uploading product imagery is an owner-only capability. */
router.use(auth.requireOwner);

/*
 * POST /admin/uploads/images   (multipart, field: images[] or images)
 * Returns JSON so the drag-and-drop uploader can attach files before the
 * product form is submitted.
 */
router.post('/images', upload.array('images', 10), processUploads, (req, res) => {
  const files = req.uploaded || [];
  audit(req, 'upload.image', 'upload', null, { count: files.length, names: files.map((f) => f.name) });
  return res.json({
    ok: true,
    files: files.map((f) => ({
      url: f.url, large: f.large, card: f.card, thumb: f.thumb,
      name: f.name, size: f.size,
    })),
    message: `${files.length} image(s) uploaded.`,
  });
});

router.post('/single', upload.single('image'), processUploads, (req, res) => {
  const file = (req.uploaded || [])[0];
  if (!file) return res.status(400).json({ ok: false, message: 'No file received.' });
  audit(req, 'upload.image', 'upload', null, { name: file.name });
  return res.json({ ok: true, file });
});

router.post('/delete', (req, res) => {
  const url = String(req.body.url || '');
  if (!url.startsWith('/uploads/')) return res.status(400).json({ ok: false, message: 'Only uploaded files can be deleted.' });
  // /uploads/products/x.jpg → <uploads.dir>/products/x.jpg (works on /tmp too)
  const rel = url.replace(/^\/?uploads\//, '');
  const abs = path.resolve(config.uploads.dir, rel);
  if (!abs.startsWith(path.resolve(config.uploads.dir))) {
    return res.status(400).json({ ok: false, message: 'Invalid path.' });
  }
  const variants = ['', '-card', '-thumb', '-large'].map((s) => abs.replace(/(\.\w+)$/, `${s}$1`));
  let removed = 0;
  variants.forEach((f) => {
    try { if (fs.existsSync(f)) { fs.unlinkSync(f); removed += 1; } } catch (_) {}
  });
  audit(req, 'upload.delete', 'upload', null, { url, removed });
  return res.json({ ok: removed > 0, removed, message: removed ? 'File removed from the server.' : 'File not found.' });
});

router.use(uploadErrors);

module.exports = router;
