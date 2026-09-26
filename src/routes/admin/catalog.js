'use strict';
const express = require('express');
const db = require('../../db');
const catalog = require('../../services/catalog');
const auth = require('../../middleware/auth');
const { invalidateMenu } = require('../../middleware/context');
const { audit } = require('../../utils/log');
const { slugify } = require('../../utils/helpers');

const router = express.Router();

/** Category / brand / homepage-slide management is owner-only too. */
router.use(auth.ownerArea('catalogue structure'));

/* ------------------------------------------------------------ categories */
router.get('/categories', (req, res) => {
  res.render('admin/categories', {
    layout: false,
    pageTitle: 'Categories | Admin',
    bodyClass: 'admin admin-categories',
    adminNav: 'categories',
    tree: catalog.categoryTree({ activeOnly: false, withCounts: true }),
    flat: db.prepare(
      `SELECT c.*, p.name AS parent_name,
        (SELECT COUNT(*) FROM products pr WHERE pr.category_id = c.id) AS product_count
       FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
       ORDER BY c.parent_id IS NULL DESC, c.sort_order, c.name`
    ).all(),
    editing: req.query.edit ? db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(req.query.edit)) : null,
  });
});

function uniqueCategorySlug(base, ignoreId = null) {
  let slug = slugify(base);
  let n = 1;
  while (true) {
    const row = db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug);
    if (!row || (ignoreId && row.id === Number(ignoreId))) return slug;
    n += 1; slug = `${slugify(base)}-${n}`;
  }
}

router.post('/categories', (req, res) => {
  const id = req.body.id ? Number(req.body.id) : null;
  const data = {
    name: String(req.body.name || '').trim(),
    slug: String(req.body.slug || '').trim(),
    parent_id: req.body.parent_id ? Number(req.body.parent_id) : null,
    description: String(req.body.description || '').trim(),
    icon: String(req.body.icon || '').trim(),
    accent: String(req.body.accent || '#0F2A43').trim(),
    sort_order: Number(req.body.sort_order) || 0,
    is_active: req.body.is_active === '1' || req.body.is_active === 'on' ? 1 : 0,
    show_in_menu: req.body.show_in_menu === '1' || req.body.show_in_menu === 'on' ? 1 : 0,
  };
  if (data.name.length < 2) { req.flash('danger', 'Category name is required.'); return res.redirect('/admin/categories'); }

  const existing = id ? db.prepare('SELECT * FROM categories WHERE id = ?').get(id) : null;
  const editingFashionRoot = !!(existing && !existing.parent_id && catalog.FASHION_ROOT_SLUGS.includes(existing.slug));
  if (id && (!existing || !catalog.isFashionCategory(id))) {
    req.flash('danger', 'Biahens Enterprise only manages fashion categories.');
    return res.redirect('/admin/categories');
  }
  if ((data.parent_id && !catalog.isFashionCategory(data.parent_id))
      || (!data.parent_id && !editingFashionRoot)
      || (editingFashionRoot && data.parent_id)
      || (existing && existing.parent_id && !data.parent_id)) {
    req.flash('danger', 'New categories must live inside the Fashion or Shoes & Bags collections.');
    return res.redirect('/admin/categories');
  }
  data.slug = editingFashionRoot ? existing.slug : uniqueCategorySlug(data.slug || data.name, id);
  if (data.parent_id === id) data.parent_id = null;

  if (id) {
    db.prepare(
      `UPDATE categories SET name=@name, slug=@slug, parent_id=@parent_id, description=@description,
        icon=@icon, accent=@accent, sort_order=@sort_order, is_active=@is_active, show_in_menu=@show_in_menu
       WHERE id=@id`
    ).run(Object.assign({ id }, data));
    audit(req, 'category.update', 'category', id, data);
    req.flash('success', `Category “${data.name}” updated.`);
  } else {
    const info = db.prepare(
      `INSERT INTO categories (name, slug, parent_id, description, icon, accent, sort_order, is_active, show_in_menu)
       VALUES (@name,@slug,@parent_id,@description,@icon,@accent,@sort_order,@is_active,@show_in_menu)`
    ).run(data);
    audit(req, 'category.create', 'category', info.lastInsertRowid, data);
    req.flash('success', `Category “${data.name}” created.`);
  }
  invalidateMenu();
  return res.redirect('/admin/categories');
});

router.post('/categories/:id/delete', (req, res) => {
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(req.params.id));
  if (!cat) { req.flash('danger', 'Category not found.'); return res.redirect('/admin/categories'); }
  const kids = db.prepare('SELECT COUNT(*) AS n FROM categories WHERE parent_id = ?').get(cat.id).n;
  const products = db.prepare('SELECT COUNT(*) AS n FROM products WHERE category_id = ?').get(cat.id).n;
  if ((kids || products) && req.body.force !== '1') {
    req.flash('warn', `“${cat.name}” has ${kids} sub-categories and ${products} product(s). Move them first, or confirm to cascade-delete.`);
    return res.redirect('/admin/categories');
  }
  db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
  invalidateMenu();
  audit(req, 'category.delete', 'category', cat.id, { name: cat.name });
  req.flash('success', `Category “${cat.name}” deleted.`);
  return res.redirect('/admin/categories');
});

/* ----------------------------------------------------------------- brands */
router.get('/brands', (req, res) => {
  res.render('admin/brands', {
    layout: false,
    pageTitle: 'Brands | Admin',
    bodyClass: 'admin admin-brands',
    adminNav: 'brands',
    brands: db.prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM products p WHERE p.brand_id = b.id) AS product_count,
        (SELECT COALESCE(SUM(p.sold_count),0) FROM products p WHERE p.brand_id = b.id) AS units_sold
       FROM brands b ORDER BY b.sort_order, b.name`
    ).all(),
    editing: req.query.edit ? db.prepare('SELECT * FROM brands WHERE id = ?').get(Number(req.query.edit)) : null,
  });
});

router.post('/brands', (req, res) => {
  const id = req.body.id ? Number(req.body.id) : null;
  const data = {
    name: String(req.body.name || '').trim(),
    tagline: String(req.body.tagline || '').trim(),
    logo: String(req.body.logo || '').trim(),
    sort_order: Number(req.body.sort_order) || 0,
    is_active: req.body.is_active === '1' || req.body.is_active === 'on' ? 1 : 0,
  };
  if (data.name.length < 2) { req.flash('danger', 'Brand name is required.'); return res.redirect('/admin/brands'); }
  let slug = slugify(data.name);
  const clash = db.prepare('SELECT id FROM brands WHERE slug = ?').get(slug);
  if (clash && clash.id !== id) slug = `${slug}-${Date.now().toString().slice(-4)}`;

  if (id) {
    db.prepare(`UPDATE brands SET name=@name, slug=@slug, tagline=@tagline, logo=@logo, sort_order=@sort_order, is_active=@is_active WHERE id=@id`)
      .run(Object.assign({ id, slug }, data));
    audit(req, 'brand.update', 'brand', id, data);
    req.flash('success', `Brand “${data.name}” updated.`);
  } else {
    const info = db.prepare(`INSERT INTO brands (name, slug, tagline, logo, sort_order, is_active) VALUES (@name,@slug,@tagline,@logo,@sort_order,@is_active)`)
      .run(Object.assign({ slug }, data));
    audit(req, 'brand.create', 'brand', info.lastInsertRowid, data);
    req.flash('success', `Brand “${data.name}” created.`);
  }
  return res.redirect('/admin/brands');
});

router.post('/brands/:id/delete', (req, res) => {
  const b = db.prepare('SELECT * FROM brands WHERE id = ?').get(Number(req.params.id));
  if (!b) return res.redirect('/admin/brands');
  db.prepare('UPDATE products SET brand_id = NULL WHERE brand_id = ?').run(b.id);
  db.prepare('DELETE FROM brands WHERE id = ?').run(b.id);
  audit(req, 'brand.delete', 'brand', b.id, { name: b.name });
  req.flash('success', `Brand “${b.name}” deleted. Products were kept and un-branded.`);
  return res.redirect('/admin/brands');
});

/* ------------------------------------------------------ homepage slides */
router.get('/slides', (req, res) => {
  res.render('admin/slides', {
    layout: false,
    pageTitle: 'Homepage banners | Admin',
    bodyClass: 'admin',
    adminNav: 'slides',
    slides: db.prepare('SELECT * FROM slides ORDER BY sort_order, id').all(),
    editing: req.query.edit ? db.prepare('SELECT * FROM slides WHERE id = ?').get(Number(req.query.edit)) : null,
  });
});

router.post('/slides', (req, res) => {
  const id = req.body.id ? Number(req.body.id) : null;
  const data = {
    title: String(req.body.title || '').trim(),
    subtitle: String(req.body.subtitle || '').trim(),
    badge: String(req.body.badge || '').trim(),
    bg: String(req.body.bg || 'linear-gradient(120deg,#0F2A43,#1D4E6B)').trim(),
    image: String(req.body.image || '').trim(),
    link_text: String(req.body.link_text || 'Shop now').trim(),
    link_url: String(req.body.link_url || '/').trim(),
    sort_order: Number(req.body.sort_order) || 0,
    is_active: req.body.is_active === '1' || req.body.is_active === 'on' ? 1 : 0,
  };
  if (data.title.length < 3) { req.flash('danger', 'Banner title is required.'); return res.redirect('/admin/slides'); }
  if (id) {
    db.prepare(`UPDATE slides SET title=@title, subtitle=@subtitle, badge=@badge, bg=@bg, image=@image,
      link_text=@link_text, link_url=@link_url, sort_order=@sort_order, is_active=@is_active WHERE id=@id`)
      .run(Object.assign({ id }, data));
    audit(req, 'slide.update', 'slide', id, data);
    req.flash('success', 'Homepage banner updated.');
  } else {
    const info = db.prepare(`INSERT INTO slides (title, subtitle, badge, bg, image, link_text, link_url, sort_order, is_active)
      VALUES (@title,@subtitle,@badge,@bg,@image,@link_text,@link_url,@sort_order,@is_active)`).run(data);
    audit(req, 'slide.create', 'slide', info.lastInsertRowid, data);
    req.flash('success', 'Homepage banner created.');
  }
  return res.redirect('/admin/slides');
});

router.post('/slides/:id/delete', (req, res) => {
  db.prepare('DELETE FROM slides WHERE id = ?').run(Number(req.params.id));
  audit(req, 'slide.delete', 'slide', req.params.id, {});
  req.flash('info', 'Homepage banner removed.');
  return res.redirect('/admin/slides');
});

module.exports = router;
