'use strict';
const db = require('../db');
const settings = require('./settings');
const { paginate, parseJson, slugify, round2, discountPercent } = require('../utils/helpers');

/* ------------------------------------------------------------- categories */

// Biahens Enterprise is a fashion-only single-seller store. These are the
// only public catalogue roots; descendants inherit the same restriction.
const FASHION_ROOT_SLUGS = Object.freeze(['fashion', 'shoes-bags']);

function fashionCategoryIds() {
  const roots = db.prepare(
    `SELECT id FROM categories WHERE slug IN (${FASHION_ROOT_SLUGS.map(() => '?').join(',')})`
  ).all(...FASHION_ROOT_SLUGS);
  return [...new Set(roots.flatMap((row) => categoryIdsIncludingChildren(row.id)))];
}

function isFashionCategory(categoryId) {
  return fashionCategoryIds().includes(Number(categoryId));
}

function categoryTree({ activeOnly = true, withCounts = false, fashionOnly = true } = {}) {
  const where = activeOnly ? 'WHERE is_active = 1' : '';
  const rows = db.prepare(`SELECT * FROM categories ${where} ORDER BY sort_order, name`).all();
  const counts = {};
  if (withCounts) {
    db.prepare(
      `SELECT category_id AS id, COUNT(*) AS n FROM products
       WHERE is_active = 1 AND status = 'active' GROUP BY category_id`
    ).all().forEach((r) => { counts[r.id] = r.n; });
  }
  const byParent = new Map();
  rows.forEach((c) => {
    c.children = [];
    c.product_count = counts[c.id] || 0;
    if (!byParent.has(c.parent_id || 0)) byParent.set(c.parent_id || 0, []);
    byParent.get(c.parent_id || 0).push(c);
  });
  rows.forEach((c) => {
    c.children = (byParent.get(c.id) || []).slice(0, 8);
    c.total_count = c.product_count + c.children.reduce((s, ch) => s + (ch.product_count || 0), 0);
  });
  const roots = byParent.get(0) || [];
  return fashionOnly ? roots.filter((c) => FASHION_ROOT_SLUGS.includes(c.slug)) : roots;
}

function menuCategories(limit = 9) {
  return db.prepare(
    `SELECT * FROM categories WHERE is_active = 1 AND show_in_menu = 1 AND parent_id IS NULL
       AND slug IN (${FASHION_ROOT_SLUGS.map(() => '?').join(',')})
     ORDER BY sort_order, name LIMIT ?`
  ).all(...FASHION_ROOT_SLUGS, limit).map((c) => {
    c.children = db.prepare(
      `SELECT * FROM categories WHERE parent_id = ? AND is_active = 1 ORDER BY sort_order, name LIMIT 12`
    ).all(c.id);
    return c;
  });
}

function getCategoryBySlug(slug) {
  return db.prepare('SELECT * FROM categories WHERE slug = ?').get(slug);
}

function getCategory(id) {
  return db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
}

/** All descendant category ids (inclusive). */
function categoryIdsIncludingChildren(id) {
  const out = [Number(id)];
  let frontier = [Number(id)];
  const guard = new Set();
  while (frontier.length) {
    const q = frontier.map(() => '?').join(',');
    const kids = db.prepare(`SELECT id FROM categories WHERE parent_id IN (${q})`).all(...frontier).map((r) => r.id);
    frontier = kids.filter((k) => !guard.has(k));
    frontier.forEach((k) => guard.add(k));
    out.push(...frontier);
  }
  return out;
}

function breadcrumbsForCategory(cat) {
  const trail = [];
  let cur = cat;
  let guard = 0;
  while (cur && guard < 8) {
    trail.unshift(cur);
    cur = cur.parent_id ? getCategory(cur.parent_id) : null;
    guard += 1;
  }
  return trail;
}

/* ----------------------------------------------------------------- brands */

function brandList({ activeOnly = true, withCounts = false, fashionOnly = activeOnly } = {}) {
  const rows = db.prepare(
    `SELECT * FROM brands ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY sort_order, name`
  ).all();
  if (fashionOnly) {
    const ids = fashionCategoryIds();
    if (!ids.length) return [];
    const marks = ids.map(() => '?').join(',');
    const counts = {};
    db.prepare(
      `SELECT brand_id AS id, COUNT(*) AS n FROM products
       WHERE is_active = 1 AND status = 'active' AND category_id IN (${marks})
       GROUP BY brand_id`
    ).all(...ids).forEach((r) => { counts[r.id] = r.n; });
    rows.forEach((b) => { b.product_count = counts[b.id] || 0; });
    return rows.filter((b) => b.product_count > 0);
  }
  if (withCounts) {
    const counts = {};
    db.prepare(
      `SELECT brand_id AS id, COUNT(*) AS n FROM products WHERE is_active = 1 AND status='active' GROUP BY brand_id`
    ).all().forEach((r) => { counts[r.id] = r.n; });
    rows.forEach((b) => { b.product_count = counts[b.id] || 0; });
  }
  return rows;
}

function getBrandBySlug(slug) { return db.prepare('SELECT * FROM brands WHERE slug = ?').get(slug); }

/* --------------------------------------------------------------- products */

const PUBLIC_COLS = `p.id, p.name, p.slug, p.sku, p.short_description, p.description, p.price,
  p.compare_at_price, p.cost_price, p.stock, p.low_stock_at, p.weight_kg, p.rating_avg,
  p.rating_count, p.sold_count, p.views_count, p.image, p.images, p.options, p.tags,
  p.meta_title, p.meta_description,
  (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id AND v.is_active = 1) AS variant_count,
  p.is_active, p.is_featured, p.status, p.published_at, p.created_at, p.updated_at,
  c.name AS category_name, c.slug AS category_slug, c.id AS category_id,
  b.name AS brand_name, b.slug AS brand_slug, b.id AS brand_id`;

function decorate(p) {
  if (!p) return p;
  p.images_list = parseJson(p.images, []).filter(Boolean);
  if (p.image && !p.images_list.length) p.images_list = [p.image];
  p.options_list = parseJson(p.options, []);
  p.discount = discountPercent(p.price, p.compare_at_price);
  p.in_stock = p.stock > 0;
  p.low_stock = p.stock > 0 && p.stock <= (p.low_stock_at || 5);
  p.price_fmt = p.price;
  return p;
}

function getVariants(productId) {
  return db.prepare('SELECT * FROM variants WHERE product_id = ? AND is_active = 1 ORDER BY sort_order, id').all(productId);
}

function publicFashionClause() {
  const ids = fashionCategoryIds();
  if (!ids.length) return { sql: 'AND 1 = 0', params: {} };
  const params = {};
  const marks = ids.map((id, i) => {
    params[`fashionCat${i}`] = id;
    return `@fashionCat${i}`;
  });
  return { sql: `AND p.category_id IN (${marks.join(',')})`, params };
}

function getProductBySlug(slug, { admin = false } = {}) {
  const fashion = admin ? { sql: '', params: {} } : publicFashionClause();
  const p = db.prepare(
    `SELECT ${PUBLIC_COLS} FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN brands b ON b.id = p.brand_id
     WHERE p.slug = @slug ${admin ? '' : "AND p.is_active = 1 AND p.status = 'active'"} ${fashion.sql}`
  ).get(Object.assign({ slug }, fashion.params));
  if (!p) return null;
  decorate(p);
  p.variants = getVariants(p.id);
  return p;
}

function getProductById(id, { admin = false } = {}) {
  const fashion = admin ? { sql: '', params: {} } : publicFashionClause();
  const p = db.prepare(
    `SELECT ${PUBLIC_COLS} FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN brands b ON b.id = p.brand_id
     WHERE p.id = @id ${admin ? '' : "AND p.is_active = 1 AND p.status = 'active'"} ${fashion.sql}`
  ).get(Object.assign({ id }, fashion.params));
  if (!p) return null;
  decorate(p);
  p.variants = getVariants(p.id);
  return p;
}

function bumpViews(id) {
  try { db.prepare('UPDATE products SET views_count = views_count + 1 WHERE id = ?').run(id); } catch (_) {}
}

const SORTS = {
  relevance: '',
  popular: 'p.sold_count DESC, p.rating_avg DESC',
  newest: 'COALESCE(p.published_at, p.created_at) DESC',
  price_asc: 'p.price ASC',
  price_desc: 'p.price DESC',
  rating: 'p.rating_avg DESC, p.rating_count DESC',
  discount: '(CASE WHEN p.compare_at_price > p.price THEN (p.compare_at_price - p.price)/p.compare_at_price ELSE 0 END) DESC',
  name: 'p.name ASC',
  low_stock: 'p.stock ASC',
  updated: 'p.updated_at DESC',
};

/**
 * Unified product query used by home rails, category, brand and search pages.
 */
function queryProducts(opts = {}) {
  const {
    q = '', categoryIds = null, brandIds = null, min = null, max = null,
    rating = 0, inStock = false, onSale = false, featured = false,
    sort = 'relevance', page = 1, perPage = settings.get('page_size', 24),
    ids = null, admin = false, status = null,
  } = opts;

  const where = [];
  const params = {};

  if (admin) {
    if (status && status !== 'all') { where.push('p.status = @status'); params.status = status; }
  } else {
    where.push("p.is_active = 1", "p.status = 'active'");
    const fashionIds = fashionCategoryIds();
    if (!fashionIds.length) return { items: [], pager: paginate(0, page, perPage) };
    where.push(`p.category_id IN (${fashionIds.map((_, i) => `@fashionCat${i}`).join(',')})`);
    fashionIds.forEach((value, i) => { params[`fashionCat${i}`] = value; });
  }
  if (ids) {
    if (!ids.length) return { items: [], pager: paginate(0, page, perPage) };
    where.push(`p.id IN (${ids.map((_, i) => `@id${i}`).join(',')})`);
    ids.forEach((v, i) => { params[`id${i}`] = v; });
  }
  if (q) {
    const like = `%${String(q).trim().toLowerCase()}%`;
    where.push(`(LOWER(p.name) LIKE @like OR LOWER(COALESCE(p.short_description,'')) LIKE @like OR LOWER(COALESCE(p.description,'')) LIKE @like OR LOWER(COALESCE(p.tags,'')) LIKE @like OR LOWER(COALESCE(p.sku,'')) LIKE @like OR LOWER(COALESCE(b.name,'')) LIKE @like OR LOWER(COALESCE(c.name,'')) LIKE @like)`);
    params.like = like;
  }
  if (categoryIds && categoryIds.length) {
    where.push(`p.category_id IN (${categoryIds.map((_, i) => `@cat${i}`).join(',')})`);
    categoryIds.forEach((v, i) => { params[`cat${i}`] = v; });
  }
  if (brandIds && brandIds.length) {
    where.push(`p.brand_id IN (${brandIds.map((_, i) => `@br${i}`).join(',')})`);
    brandIds.forEach((v, i) => { params[`br${i}`] = v; });
  }
  if (min !== null && min !== undefined && min !== '') { where.push('p.price >= @min'); params.min = Number(min); }
  if (max !== null && max !== undefined && max !== '') { where.push('p.price <= @max'); params.max = Number(max); }
  if (rating) { where.push('p.rating_avg >= @rating'); params.rating = Number(rating); }
  if (inStock) where.push('p.stock > 0');
  if (onSale) where.push('p.compare_at_price IS NOT NULL AND p.compare_at_price > p.price');
  if (featured) where.push('p.is_featured = 1');

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = SORTS[sort] || SORTS.popular;
  const orderSql = order ? `ORDER BY ${order}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM products p
    LEFT JOIN brands b ON b.id = p.brand_id
    LEFT JOIN categories c ON c.id = p.category_id
    ${whereSql}`).get(params).n;

  params.limit = perPage;
  params.offset = (Math.max(1, Number(page) || 1) - 1) * perPage;

  const rows = db.prepare(
    `SELECT ${PUBLIC_COLS} FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN brands b ON b.id = p.brand_id
     ${whereSql} ${orderSql} LIMIT @limit OFFSET @offset`
  ).all(params);

  rows.forEach(decorate);
  return { items: rows, pager: paginate(total, page, perPage) };
}

function relatedProducts(product, limit = 8) {
  if (!product) return [];
  const sameCat = db.prepare(
    `SELECT ${PUBLIC_COLS} FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN brands b ON b.id = p.brand_id
     WHERE p.id != @id AND p.is_active = 1 AND p.status='active' AND p.category_id = @cat
     ORDER BY p.rating_avg DESC, p.sold_count DESC LIMIT @lim`
  ).all({ id: product.id, cat: product.category_id, lim: limit });
  sameCat.forEach(decorate);
  if (sameCat.length >= limit) return sameCat.slice(0, limit);
  const ids = sameCat.map((p) => p.id).concat(product.id);
  const filler = queryProducts({ sort: 'popular', perPage: limit - sameCat.length, ids: undefined, q: product.category_name || '' });
  const out = sameCat.concat(filler.items.filter((p) => !ids.includes(p.id)));
  return out.slice(0, limit);
}

function priceBounds() {
  const ids = fashionCategoryIds();
  if (!ids.length) return { min: 0, max: 1000 };
  const marks = ids.map(() => '?').join(',');
  const r = db.prepare(
    `SELECT MIN(price) AS lo, MAX(price) AS hi FROM products
     WHERE is_active = 1 AND status = 'active' AND category_id IN (${marks})`
  ).get(...ids);
  return { min: Math.floor(r.lo || 0), max: Math.ceil(r.hi || 1000) };
}

function uniqueTags(limit = 30) {
  const ids = fashionCategoryIds();
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT tags FROM products WHERE is_active = 1 AND status = 'active'
     AND category_id IN (${marks}) AND tags != '' LIMIT 500`
  ).all(...ids);
  const set = new Map();
  rows.forEach((r) => String(r.tags).split(',').forEach((t) => {
    const tag = t.trim().toLowerCase();
    if (tag) set.set(tag, (set.get(tag) || 0) + 1);
  }));
  return [...set.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([tag, n]) => ({ tag, n }));
}

function countActive() {
  const ids = fashionCategoryIds();
  if (!ids.length) return 0;
  const marks = ids.map(() => '?').join(',');
  return db.prepare(
    `SELECT COUNT(*) AS n FROM products WHERE is_active = 1 AND status = 'active'
     AND category_id IN (${marks})`
  ).get(...ids).n;
}

/* ---------------------------------------------------------------- reviews */

function productReviews(productId, { approvedOnly = true, limit = 50 } = {}) {
  return db.prepare(
    `SELECT r.*, u.avatar AS user_avatar FROM reviews r
     LEFT JOIN users u ON u.id = r.user_id
     WHERE r.product_id = ? ${approvedOnly ? 'AND r.is_approved = 1' : ''}
     ORDER BY r.helpful_count DESC, r.created_at DESC LIMIT ?`
  ).all(productId, limit);
}

function ratingBreakdown(productId) {
  const out = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  db.prepare('SELECT rating, COUNT(*) AS n FROM reviews WHERE product_id = ? AND is_approved = 1 GROUP BY rating')
    .all(productId).forEach((r) => { out[r.rating] = r.n; });
  return out;
}

function recomputeRating(productId) {
  const r = db.prepare(
    'SELECT COUNT(*) AS n, COALESCE(AVG(rating),0) AS avg FROM reviews WHERE product_id = ? AND is_approved = 1'
  ).get(productId);
  db.prepare('UPDATE products SET rating_avg = ?, rating_count = ? WHERE id = ?')
    .run(round2(r.avg), r.n, productId);
  return r;
}

function addReview({ productId, userId, orderId, author, rating, title, body }) {
  const approved = !settings.get('reviews_moderated');
  const info = db.prepare(
    `INSERT INTO reviews (product_id, user_id, order_id, author, rating, title, body, is_approved)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(productId, userId || null, orderId || null, author, Math.min(5, Math.max(1, Number(rating) || 5)), title || null, body || null, approved ? 1 : 0);
  if (approved) recomputeRating(productId);
  return { id: info.lastInsertRowid, approved };
}

/* ------------------------------------------------------- product mutations */

function uniqueSlug(base, ignoreId = null) {
  let slug = slugify(base);
  let n = 1;
  const stmt = db.prepare('SELECT id FROM products WHERE slug = ?');
  while (true) {
    const row = stmt.get(slug);
    if (!row || (ignoreId && row.id === Number(ignoreId))) return slug;
    n += 1;
    slug = `${slugify(base)}-${n}`;
  }
}

function saveProduct(data, id = null) {
  const fields = {
    name: data.name,
    slug: uniqueSlug(data.slug || data.name, id),
    sku: data.sku || null,
    short_description: data.short_description || null,
    description: data.description || null,
    category_id: data.category_id || null,
    brand_id: data.brand_id || null,
    price: round2(data.price || 0),
    compare_at_price: data.compare_at_price ? round2(data.compare_at_price) : null,
    cost_price: data.cost_price ? round2(data.cost_price) : null,
    stock: Math.max(0, Number(data.stock) || 0),
    low_stock_at: Math.max(0, Number(data.low_stock_at) || 5),
    weight_kg: Number(data.weight_kg) || 1,
    image: data.image || null,
    images: JSON.stringify(Array.isArray(data.images) ? data.images.filter(Boolean) : parseJson(data.images, [])),
    options: JSON.stringify(Array.isArray(data.options) ? data.options : parseJson(data.options, [])),
    tags: Array.isArray(data.tags) ? data.tags.join(',') : (data.tags || ''),
    meta_title: data.meta_title || null,
    meta_description: data.meta_description || null,
    is_active: data.is_active ? 1 : 0,
    is_featured: data.is_featured ? 1 : 0,
    status: ['draft', 'active', 'archived'].includes(data.status) ? data.status : 'active',
  };
  if (fields.status === 'active' && !data.published_at) fields.published_at = new Date().toISOString();

  if (id) {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE products SET ${sets}, updated_at = datetime('now') WHERE id = @__id`)
      .run(Object.assign({ __id: Number(id) }, fields));
    return Number(id);
  }
  const info = db.prepare(
    `INSERT INTO products (name, slug, sku, short_description, description, category_id, brand_id,
      price, compare_at_price, cost_price, stock, low_stock_at, weight_kg, image, images, options,
      tags, meta_title, meta_description, is_active, is_featured, status, published_at)
     VALUES (@name,@slug,@sku,@short_description,@description,@category_id,@brand_id,@price,
      @compare_at_price,@cost_price,@stock,@low_stock_at,@weight_kg,@image,@images,@options,
      @tags,@meta_title,@meta_description,@is_active,@is_featured,@status,@published_at)`
  ).run(Object.assign({ published_at: fields.published_at || new Date().toISOString() }, fields));
  return info.lastInsertRowid;
}

function deleteProduct(id) {
  db.prepare('DELETE FROM products WHERE id = ?').run(Number(id));
}

function saveVariants(productId, list) {
  const rows = (list || []).filter((v) => v && String(v.title || '').trim());
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM variants WHERE product_id = ?').run(productId);
    const ins = db.prepare(
      `INSERT INTO variants (product_id, title, sku, price_delta, stock, image, is_active, sort_order)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    rows.forEach((v, i) => ins.run(
      productId, String(v.title).trim(), v.sku || null, round2(v.price_delta || 0),
      Math.max(0, Number(v.stock) || 0), v.image || null, v.is_active === false ? 0 : 1, i
    ));
  });
  tx();
  return rows.length;
}

function adjustStock(productId, variantId, delta) {
  const d = Number(delta) || 0;
  db.prepare('UPDATE products SET stock = MAX(0, stock + ?) WHERE id = ?').run(d, productId);
  if (variantId) db.prepare('UPDATE variants SET stock = MAX(0, stock + ?) WHERE id = ?').run(d, variantId);
}

function lowStockProducts(limit = 25) {
  return db.prepare(
    `SELECT p.*, c.name AS category_name FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.status != 'archived' AND p.stock <= p.low_stock_at
     ORDER BY p.stock ASC, p.sold_count DESC LIMIT ?`
  ).all(limit);
}

module.exports = {
  FASHION_ROOT_SLUGS, fashionCategoryIds, isFashionCategory,
  categoryTree, menuCategories, getCategoryBySlug, getCategory, categoryIdsIncludingChildren,
  breadcrumbsForCategory, brandList, getBrandBySlug, decorate, getVariants,
  getProductBySlug, getProductById, bumpViews, queryProducts, relatedProducts,
  priceBounds, uniqueTags, countActive, productReviews, ratingBreakdown,
  recomputeRating, addReview, uniqueSlug, saveProduct, deleteProduct, saveVariants,
  adjustStock, lowStockProducts, SORTS,
};
