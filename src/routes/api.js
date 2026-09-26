'use strict';
const express = require('express');
const db = require('../db');
const settings = require('../services/settings');
const catalog = require('../services/catalog');
const cartSvc = require('../services/cart');
const stats = require('../services/stats');
const { placeholderSvg, imgSrc } = require('../utils/images');
const { round2, discountPercent, truncate } = require('../utils/helpers');

const router = express.Router();

/* ----------------------------------------------- generated placeholder art */
router.get('/img/ph.svg', (req, res) => {
  const svg = placeholderSvg({
    name: req.query.n ? String(req.query.n).slice(0, 90) : '',
    hint: req.query.k ? String(req.query.k).slice(0, 40) : '',
    palette: req.query.p !== undefined ? Number(req.query.p) : undefined,
    w: Math.min(1600, Number(req.query.w) || 640),
    h: Math.min(1600, Number(req.query.h) || 640),
    label: req.query.l ? String(req.query.l).slice(0, 24) : '',
  });
  res.type('image/svg+xml');
  res.set('Cache-Control', 'public, max-age=604800, immutable');
  res.send(svg);
});

/* ------------------------------------------------------ search autocomplete */
router.get('/api/suggest', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ ok: true, q, products: [], categories: [], brands: [] });

  const like = `%${q.toLowerCase()}%`;
  const products = db.prepare(
    `SELECT p.id, p.name, p.slug, p.price, p.compare_at_price, p.image, p.rating_avg, p.stock,
            c.name AS category_name, c.slug AS category_slug
     FROM products p LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.is_active = 1 AND p.status = 'active'
       AND (LOWER(p.name) LIKE @like OR LOWER(COALESCE(p.tags,'')) LIKE @like OR LOWER(COALESCE(p.sku,'')) LIKE @like)
     ORDER BY p.sold_count DESC, p.rating_avg DESC LIMIT 8`
  ).all({ like });

  const categories = db.prepare(
    `SELECT name, slug FROM categories WHERE is_active = 1 AND (LOWER(name) LIKE @like OR LOWER(slug) LIKE @like)
     ORDER BY (parent_id IS NULL) DESC, sort_order LIMIT 4`
  ).all({ like });

  const brands = db.prepare(
    `SELECT name, slug FROM brands WHERE is_active = 1 AND LOWER(name) LIKE @like ORDER BY sort_order LIMIT 4`
  ).all({ like });

  return res.json({
    ok: true,
    q,
    products: products.map((p) => ({
      id: p.id, name: p.name, url: `/p/${p.slug}`,
      price: round2(p.price), compare: p.compare_at_price ? round2(p.compare_at_price) : null,
      discount: discountPercent(p.price, p.compare_at_price),
      rating: round2(p.rating_avg), in_stock: p.stock > 0,
      category: p.category_name, categoryUrl: p.category_slug ? `/c/${p.category_slug}` : null,
      image: imgSrc(p.image, { w: 160, h: 160, hint: p.category_name, name: p.name }),
    })),
    categories: categories.map((c) => ({ name: c.name, url: `/c/${c.slug}` })),
    brands: brands.map((b) => ({ name: b.name, url: `/b/${b.slug}` })),
    total: products.length + categories.length + brands.length,
  });
});

/* ------------------------------------------------------------- quick view */
router.get('/api/products/:slug/quickview', (req, res) => {
  const p = catalog.getProductBySlug(req.params.slug);
  if (!p) return res.status(404).json({ ok: false, message: 'Product not found.' });
  return res.json({
    ok: true,
    product: {
      id: p.id, name: p.name, slug: p.slug, url: `/p/${p.slug}`,
      short: truncate(p.short_description || p.description || '', 180),
      price: round2(p.price), compare: p.compare_at_price ? round2(p.compare_at_price) : null,
      discount: p.discount, stock: p.stock, in_stock: p.in_stock,
      rating: round2(p.rating_avg), reviews: p.rating_count, brand: p.brand_name,
      category: p.category_name,
      images: (p.images_list.length ? p.images_list : [null]).slice(0, 6)
        .map((img, i) => imgSrc(img, { w: 800, h: 800, hint: p.category_name, name: p.name, palette: i })),
      variants: p.variants.map((v) => ({
        id: v.id, title: v.title, stock: v.stock,
        price: round2(p.price + v.price_delta), delta: v.price_delta,
      })),
      sku: p.sku, weight: p.weight_kg, tags: String(p.tags || '').split(',').filter(Boolean),
    },
  });
});

/* --------------------------------------------------------- shipping quote */
router.get('/api/shipping-quote', (req, res) => {
  const cart = cartSvc.getCart(req, { region: String(req.query.region || ''), method: String(req.query.method || 'standard') });
  const quote = cartSvc.shippingQuote({
    region: String(req.query.region || ''),
    method: String(req.query.method || 'standard'),
    subtotal: cart.subtotal,
  });
  return res.json({ ok: true, quote, threshold: toNumber(settings.get('free_shipping_threshold')) });
});
function toNumber(v) { return Number(v) || 0; }

/* ------------------------------------------------------------- cart (XHR) */
router.post('/api/cart/add', (req, res) => {
  const result = cartSvc.addToCart(req, {
    productId: req.body.product_id, variantId: req.body.variant_id || null, qty: req.body.qty || 1,
  });
  const cart = cartSvc.getCart(req);
  return res.status(result.ok ? 200 : 400).json({
    ok: result.ok,
    message: result.message,
    needsVariant: !!result.needsVariant,
    count: cart.count, subtotal: cart.subtotal, total: cart.total,
    freeShippingGap: cart.freeShippingGap,
    items: cart.items.map((i) => ({
      id: i.id, name: i.product.name, slug: i.product.slug, qty: i.qty,
      unit_price: i.unit_price, line_total: i.line_total,
      image: imgSrc(i.image, { w: 160, h: 160, hint: i.product.category_name, name: i.product.name }),
      variant: i.variant ? i.variant.title : null, available: i.available,
    })),
  });
});

router.post('/api/cart/update', (req, res) => {
  const result = cartSvc.setQty(req, Number(req.body.id), req.body.qty);
  const cart = cartSvc.getCart(req);
  return res.json({ ok: result.ok, message: result.message, count: cart.count, subtotal: cart.subtotal, total: cart.total });
});

router.post('/api/cart/remove', (req, res) => {
  const result = cartSvc.removeItem(req, Number(req.body.id));
  const cart = cartSvc.getCart(req);
  return res.json({ ok: result.ok, count: cart.count, subtotal: cart.subtotal, total: cart.total });
});

router.get('/api/wishlist/ids', (req, res) => {
  if (!req.user) return res.json({ ok: true, ids: [] });
  const rows = db.prepare('SELECT product_id FROM wishlists WHERE user_id = ?').all(req.user.id);
  return res.json({ ok: true, ids: rows.map((r) => r.product_id) });
});

router.post('/api/wishlist/toggle', (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, message: 'Sign in to save items.', loginUrl: '/login' });
  const productId = Number(req.body.product_id);
  if (!catalog.getProductById(productId)) return res.status(404).json({ ok: false, message: 'Product not found.' });
  const r = cartSvc.toggleWishlist(req.user.id, productId);
  return res.json({ ok: true, added: r.added, message: r.message, count: cartSvc.wishlistCount(req.user.id) });
});

/* ------------------------------------------------------------------ stats */
router.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: settings.get('store_name'),
    time: new Date().toISOString(),
    db: 'sqlite',
    products: catalog.countActive(),
    gateway: payments_mode(),
  });
});
function payments_mode() { return settings.get('gateway_mode') || 'test'; }

router.get('/api/stats/series', (req, res) => {
  res.json({ ok: true, series: stats.series(Math.min(365, Number(req.query.days) || 30), req.query.metric || 'revenue') });
});

/* ------------------------------------------------- public store data feed */
router.get('/api/categories', (_req, res) => {
  res.json({ ok: true, categories: catalog.categoryTree({ withCounts: true }) });
});

module.exports = router;
