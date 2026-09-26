'use strict';
const express = require('express');
const db = require('../../db');
const settings = require('../../services/settings');
const catalog = require('../../services/catalog');
const stats = require('../../services/stats');
const auth = require('../../middleware/auth');
const { audit, notify } = require('../../utils/log');
const { round2, toNumber, paginate, discountPercent, slugify, parseJson } = require('../../utils/helpers');

const router = express.Router();

/** ONLY the store owner may upload, edit or delete products. */
router.use(auth.ownerArea('the product catalogue'));

const PER_PAGE = Number(settings.get('admin_page_size')) || 20;

function formContext(req, res, extra = {}) {
  res.render('admin/products/form', Object.assign({
    layout: false,
    bodyClass: 'admin admin-product-form',
    adminNav: 'products',
    categories: catalog.categoryTree({ activeOnly: false, withCounts: true }),
    brands: catalog.brandList({ activeOnly: false }),
    errors: {},
    values: {},
    variants: [],
    product: null,
    pageTitle: 'New product | Admin',
    mode: 'create',
  }, extra));
}

function parseOptions(body) {
  const raw = body.options_json;
  if (raw) {
    const parsed = parseJson(raw, []);
    if (Array.isArray(parsed)) return parsed.filter((o) => o && o.name);
  }
  const names = [].concat(body.option_name || []).filter(Boolean);
  const values = [].concat(body.option_values || []);
  return names.map((n, i) => ({
    name: String(n).trim(),
    values: String(values[i] || '').split(',').map((v) => v.trim()).filter(Boolean),
  })).filter((o) => o.name && o.values.length);
}

function parseVariants(body) {
  const titles = [].concat(body.variant_title || []).map((t) => String(t || '').trim());
  const skus = [].concat(body.variant_sku || []);
  const deltas = [].concat(body.variant_delta || []);
  const stocks = [].concat(body.variant_stock || []);
  const actives = [].concat(body.variant_active || []);
  const out = [];
  titles.forEach((title, i) => {
    if (!title) return;
    out.push({
      title,
      sku: String(skus[i] || '').trim() || null,
      price_delta: round2(toNumber(deltas[i], 0)),
      stock: Math.max(0, Number(stocks[i]) || 0),
      is_active: true,
    });
  });
  return out;
}

function parseImages(body) {
  const list = [].concat(body.images || []).map((s) => String(s).trim()).filter(Boolean);
  const extra = String(body.images_extra || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return list.concat(extra);
}

function readForm(body) {
  return {
    name: String(body.name || '').trim(),
    slug: String(body.slug || '').trim(),
    sku: String(body.sku || '').trim(),
    short_description: String(body.short_description || '').trim(),
    description: String(body.description || '').trim(),
    category_id: body.category_id ? Number(body.category_id) : null,
    brand_id: body.brand_id ? Number(body.brand_id) : null,
    price: round2(toNumber(body.price, 0)),
    compare_at_price: body.compare_at_price ? round2(toNumber(body.compare_at_price, 0)) : null,
    cost_price: body.cost_price ? round2(toNumber(body.cost_price, 0)) : null,
    stock: Math.max(0, Number(body.stock) || 0),
    low_stock_at: Math.max(0, Number(body.low_stock_at) || 5),
    weight_kg: toNumber(body.weight_kg, 1),
    image: String(body.image || '').trim() || null,
    images: parseImages(body),
    options: parseOptions(body),
    tags: String(body.tags || '').trim(),
    is_active: body.is_active === '1' || body.is_active === 'on',
    is_featured: body.is_featured === '1' || body.is_featured === 'on',
    status: ['draft', 'active', 'archived'].includes(body.status) ? body.status : 'draft',
    meta_title: String(body.meta_title || '').trim(),
    meta_description: String(body.meta_description || '').trim(),
  };
}

function validate(data) {
  const errors = {};
  if (data.name.length < 3) errors.name = 'Product name must be at least 3 characters.';
  if (!(data.price > 0)) errors.price = 'Enter a selling price greater than zero.';
  if (data.compare_at_price && data.compare_at_price <= data.price) {
    errors.compare_at_price = 'The “was” price must be higher than the selling price.';
  }
  if (!data.category_id) errors.category_id = 'Choose a category so shoppers can find this product.';
  if (data.stock < 0) errors.stock = 'Stock cannot be negative.';
  if (data.short_description.length > 240) errors.short_description = 'Keep the short description under 240 characters.';
  if (data.cost_price && data.cost_price > data.price) errors.cost_price = 'Cost price is higher than the selling price — check this.';
  return errors;
}

/* ------------------------------------------------------------------ list */
router.get('/', (req, res) => {
  const page = Number(req.query.page) || 1;
  const per = Number(req.query.per_page) || PER_PAGE;
  const q = String(req.query.q || '').trim();
  const status = req.query.status || 'all';
  const categorySlug = req.query.category || '';
  const brandSlug = req.query.brand || '';
  const stockFilter = req.query.stock || 'all';
  const sort = req.query.sort || 'updated';

  let categoryIds = null;
  if (categorySlug) {
    const cat = catalog.getCategoryBySlug(categorySlug);
    if (cat) categoryIds = catalog.categoryIdsIncludingChildren(cat.id);
  }
  let brandIds = null;
  if (brandSlug) {
    const b = catalog.getBrandBySlug(brandSlug);
    if (b) brandIds = [b.id];
  }

  const result = catalog.queryProducts({
    q, admin: true, status, categoryIds, brandIds,
    sort, page, perPage: per,
    inStock: stockFilter === 'in',
  });

  let items = result.items;
  if (stockFilter === 'low') items = items.filter((p) => p.stock > 0 && p.stock <= p.low_stock_at);
  if (stockFilter === 'out') items = items.filter((p) => p.stock <= 0);

  res.render('admin/products/index', {
    layout: false,
    pageTitle: 'Products | Admin',
    bodyClass: 'admin admin-products',
    adminNav: 'products',
    items,
    pager: paginate(result.pager.total, page, per),
    categories: catalog.categoryTree({ activeOnly: false, withCounts: true }),
    brands: catalog.brandList({ activeOnly: false, withCounts: true }),
    filters: { q, status, category: categorySlug, brand: brandSlug, stock: stockFilter, sort, per_page: per },
    counts: {
      all: db.prepare(`SELECT COUNT(*) AS n FROM products`).get().n,
      active: db.prepare(`SELECT COUNT(*) AS n FROM products WHERE status='active' AND is_active=1`).get().n,
      draft: db.prepare(`SELECT COUNT(*) AS n FROM products WHERE status='draft'`).get().n,
      archived: db.prepare(`SELECT COUNT(*) AS n FROM products WHERE status='archived'`).get().n,
      out: db.prepare(`SELECT COUNT(*) AS n FROM products WHERE stock <= 0 AND status != 'archived'`).get().n,
      low: db.prepare(`SELECT COUNT(*) AS n FROM products WHERE stock > 0 AND stock <= low_stock_at AND status != 'archived'`).get().n,
      featured: db.prepare(`SELECT COUNT(*) AS n FROM products WHERE is_featured = 1`).get().n,
    },
    topSellers: stats.topProducts(5),
  });
});

/* ------------------------------------------------------------------ form */
router.get('/new', (req, res) => formContext(req, res, {
  pageTitle: 'New product | Admin',
  mode: 'create',
  values: {
    status: 'active', is_active: true, low_stock_at: 5, weight_kg: 0.5, stock: 0, price: '',
    ...(req.query.duplicate ? {} : {}),
  },
}));

router.get('/:id/edit', (req, res, next) => {
  const product = catalog.getProductById(Number(req.params.id), { admin: true });
  if (!product) return next();
  return formContext(req, res, {
    pageTitle: `Edit ${product.name} | Admin`,
    mode: 'edit',
    product,
    values: Object.assign({}, product, { images: product.images_list }),
    variants: product.variants,
    sales: db.prepare(
      `SELECT COALESCE(SUM(oi.qty),0) AS units, COALESCE(SUM(oi.total),0) AS revenue
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE oi.product_id = ? AND o.payment_status = 'paid'`
    ).get(product.id),
    reviews: db.prepare('SELECT * FROM reviews WHERE product_id = ? ORDER BY created_at DESC LIMIT 10').all(product.id),
    margin: product.cost_price ? round2(((product.price - product.cost_price) / product.price) * 100) : null,
  });
});

router.post('/', (req, res) => {
  const data = readForm(req.body);
  const errors = validate(data);
  if (Object.keys(errors).length) {
    return formContext(req, res, {
      pageTitle: 'New product | Admin', mode: 'create', values: data, errors,
      variants: parseVariants(req.body),
    });
  }
  const variants = parseVariants(req.body);
  if (variants.length) data.stock = variants.reduce((s, v) => s + v.stock, 0);

  const id = catalog.saveProduct(data);
  catalog.saveVariants(id, variants);
  audit(req, 'product.create', 'product', id, { name: data.name, price: data.price, stock: data.stock });
  notify('system', 'success', 'Product published', `${data.name} was added to the catalogue.`, `/admin/products/${id}/edit`);
  req.flash('success', `“${data.name}” was added to your catalogue.`);

  if (req.body.save_and_new === '1') return res.redirect('/admin/products/new');
  return res.redirect(`/admin/products/${id}/edit`);
});

router.post('/:id', (req, res, next) => {
  const product = catalog.getProductById(Number(req.params.id), { admin: true });
  if (!product) return next();
  const data = readForm(req.body);
  const errors = validate(data);
  const variants = parseVariants(req.body);
  if (Object.keys(errors).length) {
    return formContext(req, res, {
      pageTitle: `Edit ${product.name} | Admin`, mode: 'edit', product, values: data, errors, variants,
    });
  }
  if (variants.length) data.stock = variants.reduce((s, v) => s + v.stock, 0);

  catalog.saveProduct(data, product.id);
  catalog.saveVariants(product.id, variants);
  audit(req, 'product.update', 'product', product.id, { name: data.name, price: data.price, stock: data.stock });
  req.flash('success', `“${data.name}” was updated.`);
  if (req.body.save_and_new === '1') return res.redirect('/admin/products/new');
  if (req.body.view_on_store === '1') return res.redirect(`/p/${catalog.uniqueSlug(data.slug || data.name, product.id)}`);
  return res.redirect(`/admin/products/${product.id}/edit`);
});

/* ------------------------------------------------------- quick mutations */
router.post('/:id/duplicate', (req, res, next) => {
  const product = catalog.getProductById(Number(req.params.id), { admin: true });
  if (!product) return next();
  const copy = Object.assign({}, product, {
    name: `${product.name} (copy)`,
    slug: '',
    sku: product.sku ? `${product.sku}-C` : null,
    status: 'draft',
    is_active: false,
    is_featured: false,
    sold_count: 0,
    views_count: 0,
    rating_avg: 0,
    rating_count: 0,
    images: product.images_list,
    options: product.options_list,
    published_at: null,
  });
  const id = catalog.saveProduct(copy);
  catalog.saveVariants(id, product.variants.map((v) => ({ ...v, sku: v.sku ? `${v.sku}-C` : null })));
  audit(req, 'product.duplicate', 'product', id, { from: product.id });
  req.flash('success', 'Product duplicated as a draft.');
  return res.redirect(`/admin/products/${id}/edit`);
});

router.post('/:id/delete', (req, res, next) => {
  const product = catalog.getProductById(Number(req.params.id), { admin: true });
  if (!product) return next();
  const orderCount = db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE product_id = ?').get(product.id).n;
  if (orderCount && req.body.force !== '1') {
    req.flash('warn', `“${product.name}” appears in ${orderCount} order(s). Archiving keeps your sales history intact — use Archive instead, or confirm deletion.`);
    return res.redirect(`/admin/products/${product.id}/edit`);
  }
  catalog.deleteProduct(product.id);
  audit(req, 'product.delete', 'product', product.id, { name: product.name });
  req.flash('success', `“${product.name}” was deleted.`);
  return res.redirect('/admin/products');
});

router.post('/:id/toggle', (req, res) => {
  const field = req.body.field === 'is_featured' ? 'is_featured' : 'is_active';
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  if (!product) return res.status(404).json({ ok: false });
  db.prepare(`UPDATE products SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(product[field] ? 0 : 1, product.id);
  audit(req, `product.toggle.${field}`, 'product', product.id, { value: !product[field] });
  if (req.xhr) return res.json({ ok: true, value: !product[field] });
  req.flash('success', `${field === 'is_featured' ? 'Featured flag' : 'Visibility'} updated for “${product.name}”.`);
  return res.redirect(req.get('Referrer') || '/admin/products');
});

router.post('/:id/stock', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  if (!product) return res.status(404).json({ ok: false, message: 'Product not found.' });
  const delta = Number(req.body.delta) || 0;
  const absolute = req.body.absolute !== undefined ? Number(req.body.absolute) : null;
  const nextStock = absolute !== null ? Math.max(0, absolute) : Math.max(0, product.stock + delta);
  db.prepare(`UPDATE products SET stock = ?, updated_at = datetime('now') WHERE id = ?`).run(nextStock, product.id);
  audit(req, 'product.stock_adjust', 'product', product.id, { from: product.stock, to: nextStock });
  if (nextStock <= product.low_stock_at) {
    notify('stock', nextStock === 0 ? 'danger' : 'warn', `${nextStock === 0 ? 'Out of stock' : 'Low stock'}: ${product.name}`,
      `Stock is now ${nextStock} unit(s).`, `/admin/products/${product.id}/edit`);
  }
  if (req.xhr) return res.json({ ok: true, stock: nextStock });
  req.flash('success', `Stock for “${product.name}” is now ${nextStock}.`);
  return res.redirect(req.get('Referrer') || '/admin/products');
});

router.post('/:id/price', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
  if (!product) return res.status(404).json({ ok: false });
  const price = round2(toNumber(req.body.price, product.price));
  const compare = req.body.compare_at_price ? round2(toNumber(req.body.compare_at_price)) : product.compare_at_price;
  db.prepare(`UPDATE products SET price = @price, compare_at_price = @compare, updated_at = datetime('now') WHERE id = @id`)
    .run({ price, compare: compare && compare > price ? compare : null, id: product.id });
  audit(req, 'product.price_update', 'product', product.id, { from: product.price, to: price });
  if (req.xhr) return res.json({ ok: true, price, discount: discountPercent(price, compare) });
  req.flash('success', `Price updated for “${product.name}”.`);
  return res.redirect(req.get('Referrer') || '/admin/products');
});

/* ------------------------------------------------------------ bulk actions */
router.post('/bulk', (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  const action = req.body.action;
  if (!ids.length) { req.flash('danger', 'Select at least one product.'); return res.redirect(req.get('Referrer') || '/admin/products'); }
  const marks = ids.map(() => '?').join(',');
  const tx = db.transaction(() => {
    if (action === 'activate') db.prepare(`UPDATE products SET status='active', is_active=1, updated_at=datetime('now') WHERE id IN (${marks})`).run(...ids);
    else if (action === 'draft') db.prepare(`UPDATE products SET status='draft', is_active=0, updated_at=datetime('now') WHERE id IN (${marks})`).run(...ids);
    else if (action === 'archive') db.prepare(`UPDATE products SET status='archived', is_active=0, updated_at=datetime('now') WHERE id IN (${marks})`).run(...ids);
    else if (action === 'feature') db.prepare(`UPDATE products SET is_featured=1, updated_at=datetime('now') WHERE id IN (${marks})`).run(...ids);
    else if (action === 'unfeature') db.prepare(`UPDATE products SET is_featured=0, updated_at=datetime('now') WHERE id IN (${marks})`).run(...ids);
    else if (action === 'price_up' || action === 'price_down') {
      const pct = Math.min(90, Math.abs(toNumber(req.body.percent, 5)));
      const factor = action === 'price_up' ? 1 + pct / 100 : 1 - pct / 100;
      const stmt = db.prepare(
        `UPDATE products SET price = ROUND(MAX(price * ?, 1), 2),
           compare_at_price = CASE WHEN compare_at_price IS NOT NULL
             THEN ROUND(MAX(compare_at_price * ?, 1), 2) ELSE NULL END,
           updated_at = datetime('now') WHERE id = ?`
      );
      ids.forEach((id) => stmt.run(factor, factor, id));
    }
  });
  tx();
  audit(req, `product.bulk.${action}`, 'product', ids.join(','), { count: ids.length });
  req.flash('success', `Bulk action “${action}” applied to ${ids.length} product(s).`);
  return res.redirect(req.get('Referrer') || '/admin/products');
});

/* ------------------------------------------------------------------ CSV */
router.get('/export.csv', (req, res) => {
  const rows = db.prepare(
    `SELECT p.id, p.sku, p.name, p.slug, c.name AS category, b.name AS brand, p.price,
            p.compare_at_price, p.cost_price, p.stock, p.low_stock_at, p.weight_kg,
            p.status, p.is_active, p.is_featured, p.rating_avg, p.sold_count, p.tags, p.image
     FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id
     ORDER BY p.id`
  ).all();
  const headers = Object.keys(rows[0] || { id: 1 });
  const csv = [headers.join(',')]
    .concat(rows.map((r) => headers.map((h) => {
      const v = r[h] == null ? '' : String(r[h]);
      return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(',')))
    .join('\n');
  audit(req, 'product.export_csv', 'product', null, { rows: rows.length });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="biahens-products-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.send(csv);
});

router.get('/import', (req, res) => {
  res.render('admin/products/import', {
    layout: false,
    pageTitle: 'CSV import | Admin',
    bodyClass: 'admin',
    adminNav: 'products',
    result: null,
    categories: catalog.categoryTree({ activeOnly: false }),
    brands: catalog.brandList({ activeOnly: false }),
  });
});

router.post('/import', (req, res) => {
  const csv = String(req.body.csv || '');
  const dryRun = req.body.dry_run !== '0';
  if (!csv.trim()) {
    req.flash('danger', 'Paste CSV content or attach a .csv file.');
    return res.redirect('/admin/products/import');
  }
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const header = lines.shift().split(',').map((h) => slugify(h).replace(/-/g, '_'));
  const idx = (name) => header.indexOf(name);
  const required = ['name', 'price', 'category'];
  const missing = required.filter((r) => idx(r) === -1);

  const result = { created: 0, updated: 0, skipped: 0, errors: [], rows: [] };
  if (missing.length) {
    result.errors.push(`Missing column(s): ${missing.join(', ')}. Required: name, price, category.`);
    return res.render('admin/products/import', {
      layout: false, pageTitle: 'CSV import | Admin', bodyClass: 'admin', adminNav: 'products',
      result, categories: catalog.categoryTree({ activeOnly: false }), brands: catalog.brandList({ activeOnly: false }),
    });
  }

  lines.forEach((line, n) => {
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const get = (k) => { const i = idx(k); return i === -1 ? '' : (cells[i] || ''); };
    const row = { line: n + 2, name: get('name'), price: get('price'), category: get('category') };
    result.rows.push(row);
    if (!row.name) { row.error = 'No name'; result.skipped += 1; return; }
    const price = toNumber(row.price, 0);
    if (price <= 0) { row.error = 'Invalid price'; result.skipped += 1; return; }
    const cat = db.prepare('SELECT id FROM categories WHERE slug = ? OR LOWER(name) = LOWER(?)').get(slugify(row.category), row.category);
    if (!cat) { row.error = `Unknown category “${row.category}”`; result.skipped += 1; return; }
    const brand = get('brand') ? db.prepare('SELECT id FROM brands WHERE slug = ? OR LOWER(name) = LOWER(?)').get(slugify(get('brand')), get('brand')) : null;
    if (dryRun) { row.ok = true; result.created += 1; return; }
    const existing = get('sku') ? db.prepare('SELECT id FROM products WHERE sku = ?').get(get('sku')) : null;
    const id = catalog.saveProduct({
      name: row.name, sku: get('sku') || null, price,
      compare_at_price: get('compare_at_price') ? toNumber(get('compare_at_price')) : null,
      cost_price: get('cost_price') ? toNumber(get('cost_price')) : null,
      category_id: cat.id, brand_id: brand ? brand.id : null,
      stock: Number(get('stock')) || 0, low_stock_at: Number(get('low_stock_at')) || 5,
      weight_kg: toNumber(get('weight_kg'), 0.5),
      short_description: get('short_description'), description: get('description'),
      tags: get('tags'), status: get('status') || 'active', is_active: get('status') !== 'draft',
      is_featured: get('featured') === '1',
    }, existing ? existing.id : null);
    row.ok = true;
    if (existing) result.updated += 1; else result.created += 1;
  });

  audit(req, 'product.import_csv', 'product', null, { created: result.created, updated: result.updated, skipped: result.skipped, dryRun });
  req.flash('success', dryRun ? `Dry run complete — ${result.created} row(s) would import.` : `Imported ${result.created} new, ${result.updated} updated, ${result.skipped} skipped.`);
  return res.render('admin/products/import', {
    layout: false, pageTitle: 'CSV import | Admin', bodyClass: 'admin', adminNav: 'products',
    result, categories: catalog.categoryTree({ activeOnly: false }), brands: catalog.brandList({ activeOnly: false }),
  });
});

/* ------------------------------------------------------------- inventory */
router.get('/inventory/overview', (req, res) => {
  res.render('admin/products/inventory', {
    layout: false,
    pageTitle: 'Inventory | Admin',
    bodyClass: 'admin',
    adminNav: 'products',
    low: catalog.lowStockProducts(200),
    outOfStock: db.prepare(`SELECT * FROM products WHERE stock <= 0 AND status != 'archived' ORDER BY sold_count DESC LIMIT 100`).all(),
    value: db.prepare(`SELECT COALESCE(SUM(stock * COALESCE(cost_price, price * 0.65)),0) AS v, COALESCE(SUM(stock),0) AS units FROM products WHERE status != 'archived'`).get(),
    byCategory: db.prepare(
      `SELECT c.name, COUNT(p.id) AS products, COALESCE(SUM(p.stock),0) AS units,
              COALESCE(SUM(p.stock * p.price),0) AS retail_value
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.status != 'archived' GROUP BY c.id ORDER BY units DESC`
    ).all(),
  });
});

module.exports = router;
