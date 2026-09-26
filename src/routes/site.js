'use strict';
const express = require('express');
const db = require('../db');
const settings = require('../services/settings');
const catalog = require('../services/catalog');
const orders = require('../services/orders');
const helpers = require('../utils/helpers');

const router = express.Router();
const PAGE = Number(settings.get('page_size')) || 24;

/* ------------------------------------------------------------------- home */
router.get('/', (req, res) => {
  const slides = db.prepare('SELECT * FROM slides WHERE is_active = 1 ORDER BY sort_order, id').all();
  const dealEnds = new Date(Date.now() + 2 * 86400000 + 7 * 3600000).toISOString();

  const featured = catalog.queryProducts({ featured: true, sort: 'popular', perPage: 12 });
  const flashDeals = catalog.queryProducts({ onSale: true, sort: 'discount', perPage: 10 });
  const newArrivals = catalog.queryProducts({ sort: 'newest', perPage: 12 });
  const bestSellers = catalog.queryProducts({ sort: 'popular', perPage: 12 });
  const deals = catalog.queryProducts({ onSale: true, sort: 'popular', perPage: 12 });
  const budgetPicks = catalog.queryProducts({ max: 500, sort: 'rating', perPage: 10 });

  const cats = catalog.categoryTree({ withCounts: true });
  const brands = catalog.brandList().slice(0, 14);

  res.render('home', {
    pageTitle: settings.get('meta_title'),
    bodyClass: 'page-home',
    slides,
    dealEnds,
    featured: featured.items,
    flashDeals: flashDeals.items,
    newArrivals: newArrivals.items,
    bestSellers: bestSellers.items,
    deals: deals.items,
    budgetPicks: budgetPicks.items,
    cats,
    brands,
    productTotal: catalog.countActive(),
  });
});

/* ------------------------------------------------------ category & search */
function listingView(req, res, opts) {
  const { items, pager } = catalog.queryProducts(opts.query);
  const brands = catalog.brandList({ withCounts: true });
  const bounds = catalog.priceBounds();
  const cats = catalog.categoryTree({ withCounts: true });

  res.render('catalog/listing', Object.assign({
    bodyClass: 'page-listing',
    items,
    pager,
    brands,
    bounds,
    cats,
    sort: opts.query.sort || 'relevance',
    view: req.query.view === 'list' ? 'list' : 'grid',
    activeFilters: opts.activeFilters || [],
    totalFound: pager.total,
  }, opts.view));
}

function buildQuery(req, extra = {}) {
  const q = {
    q: (req.query.q || '').trim(),
    min: req.query.min || null,
    max: req.query.max || null,
    rating: req.query.rating || 0,
    inStock: req.query.stock === '1',
    onSale: req.query.sale === '1',
    sort: req.query.sort || 'relevance',
    page: Number(req.query.page) || 1,
    perPage: req.query.per_page ? Math.min(60, Number(req.per_page)) : PAGE,
  };
  const brandSlugs = [].concat(req.query.brand || []).filter(Boolean);
  if (brandSlugs.length) {
    const marks = brandSlugs.map(() => '?').join(',');
    q.brandIds = db.prepare(`SELECT id FROM brands WHERE slug IN (${marks})`).all(...brandSlugs).map((r) => r.id);
  }
  return Object.assign(q, extra);
}

router.get('/c/:slug', (req, res, next) => {
  const cat = catalog.getCategoryBySlug(req.params.slug);
  if (!cat) return next();
  const ids = catalog.categoryIdsIncludingChildren(cat.id);
  const children = db.prepare('SELECT * FROM categories WHERE parent_id = ? AND is_active = 1 ORDER BY sort_order, name').all(cat.id);
  const parent = cat.parent_id ? catalog.getCategory(cat.parent_id) : null;
  const query = buildQuery(req, { categoryIds: ids });
  const active = [];
  if (query.min) active.push({ label: `From GH₵${query.min}`, clear: 'min' });
  if (query.max) active.push({ label: `Up to GH₵${query.max}`, clear: 'max' });
  if (query.rating) active.push({ label: `${query.rating}★ & up`, clear: 'rating' });
  if (query.inStock) active.push({ label: 'In stock only', clear: 'stock' });
  if (query.onSale) active.push({ label: 'On sale', clear: 'sale' });
  [].concat(req.query.brand || []).forEach((b) => active.push({ label: `Brand: ${b}`, clear: 'brand', value: b }));

  return listingView(req, res, {
    query,
    activeFilters: active,
    view: {
      pageTitle: `${cat.name} — Price in Ghana | ${settings.get('store_name')}`,
      metaDescription: `Buy ${cat.name} online in Ghana at the best prices. Genuine products, MoMo & card payment, fast nationwide delivery from Biahens Enterprise.`,
      heading: cat.name,
      subheading: cat.description || `${catalog.queryProducts({ categoryIds: ids }).pager.total} products available with fast delivery across Ghana`,
      hero: { icon: cat.icon, accent: cat.accent, image: cat.image },
      children,
      parent,
      activeCategory: cat,
      breadcrumbs: catalog.breadcrumbsForCategory(cat).map((c) => ({ label: c.name, url: `/c/${c.slug}` })),
      canonical: `/c/${cat.slug}`,
    },
  });
});

router.get('/b/:slug', (req, res, next) => {
  const brand = catalog.getBrandBySlug(req.params.slug);
  if (!brand) return next();
  const query = buildQuery(req, { brandIds: [brand.id] });
  return listingView(req, res, {
    query,
    view: {
      pageTitle: `${brand.name} products in Ghana | ${settings.get('store_name')}`,
      metaDescription: `Shop genuine ${brand.name} products in Ghana. ${brand.tagline || ''} Fast delivery, MoMo & card payment, Biahens warranty.`,
      heading: brand.name,
      subheading: brand.tagline || `${query.brandIds.length ? '' : ''}Official ${brand.name} products stocked and warrantied by Biahens Enterprise`,
      hero: { icon: '🏷', accent: '#0F2A43', image: brand.logo },
      activeBrand: brand,
      breadcrumbs: [{ label: 'Brands', url: '/brands' }, { label: brand.name, url: `/b/${brand.slug}` }],
      canonical: `/b/${brand.slug}`,
    },
  });
});

router.get('/search', (req, res) => {
  const query = buildQuery(req);
  const active = [];
  if (query.q) active.push({ label: `Search: “${query.q}”`, clear: 'q' });
  return listingView(req, res, {
    query,
    activeFilters: active,
    view: {
      pageTitle: query.q ? `Results for “${query.q}” | ${settings.get('store_name')}` : `Search | ${settings.get('store_name')}`,
      heading: query.q ? `Results for “${query.q}”` : 'Search the store',
      subheading: query.q ? `Showing products matching your search across every category` : 'Type a product, brand or category to begin.',
      hero: { icon: '🔎', accent: '#0F2A43' },
      searchMode: true,
      breadcrumbs: [{ label: 'Search', url: '/search' }],
    },
  });
});

router.get('/deals', (req, res) => {
  const query = buildQuery(req, { onSale: true, sort: req.query.sort || 'discount' });
  return listingView(req, res, {
    query,
    view: {
      pageTitle: `Today's Deals & Offers in Ghana | ${settings.get('store_name')}`,
      metaDescription: 'Ghana’s best online deals — phones, electronics, fashion, appliances and groceries discounted daily. Free Accra delivery above GH₵1,500.',
      heading: "Today's Deals",
      subheading: 'Real discounts, checked daily by our buyers. Prices include all duties and VAT.',
      hero: { icon: '🔥', accent: '#F26B21' },
      dealsPage: true,
      breadcrumbs: [{ label: 'Deals', url: '/deals' }],
    },
  });
});

router.get('/new-arrivals', (req, res) => listingView(req, res, {
  query: buildQuery(req, { sort: 'newest' }),
  view: {
    pageTitle: `New Arrivals | ${settings.get('store_name')}`,
    heading: 'New Arrivals',
    subheading: 'Fresh stock that landed in our Spintex warehouse this month.',
    hero: { icon: '✨', accent: '#14624A' },
    breadcrumbs: [{ label: 'New arrivals', url: '/new-arrivals' }],
  },
}));

router.get('/best-sellers', (req, res) => listingView(req, res, {
  query: buildQuery(req, { sort: 'popular' }),
  view: {
    pageTitle: `Best Sellers | ${settings.get('store_name')}`,
    heading: 'Best Sellers',
    subheading: 'What Ghana is buying right now, ranked by units sold.',
    hero: { icon: '🏆', accent: '#7A5B1E' },
    breadcrumbs: [{ label: 'Best sellers', url: '/best-sellers' }],
  },
}));

router.get('/brands', (req, res) => {
  const brands = catalog.brandList({ withCounts: true });
  const grouped = {};
  brands.forEach((b) => {
    const letter = b.name[0].toUpperCase();
    (grouped[letter] = grouped[letter] || []).push(b);
  });
  res.render('catalog/brands', {
    pageTitle: `Shop by Brand | ${settings.get('store_name')}`,
    bodyClass: 'page-brands',
    grouped,
    letters: Object.keys(grouped).sort(),
    breadcrumbs: [{ label: 'Brands', url: '/brands' }],
  });
});

router.get('/categories', (req, res) => {
  res.render('catalog/categories', {
    pageTitle: `All Categories | ${settings.get('store_name')}`,
    bodyClass: 'page-categories',
    cats: catalog.categoryTree({ withCounts: true }),
    total: catalog.countActive(),
    breadcrumbs: [{ label: 'Categories', url: '/categories' }],
  });
});

/* --------------------------------------------------------- product detail */
router.get('/p/:slug', (req, res, next) => {
  const product = catalog.getProductBySlug(req.params.slug);
  if (!product) return next();
  catalog.bumpViews(product.id);

  const reviews = catalog.productReviews(product.id);
  const breakdown = catalog.ratingBreakdown(product.id);
  const related = catalog.relatedProducts(product, 10);
  const canReview = !!req.user && (!settings.get('reviews_require_purchase') ||
    db.prepare('SELECT COUNT(*) AS n FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.user_id = ? AND oi.product_id = ?').get(req.user.id, product.id).n > 0);
  const alreadyReviewed = req.user
    ? db.prepare('SELECT id FROM reviews WHERE product_id = ? AND user_id = ?').get(product.id, req.user.id)
    : null;

  const trail = [];
  let cat = product.category_id ? catalog.getCategory(product.category_id) : null;
  while (cat) { trail.unshift({ label: cat.name, url: `/c/${cat.slug}` }); cat = cat.parent_id ? catalog.getCategory(cat.parent_id) : null; }

  res.render('catalog/product', {
    pageTitle: `${product.name} — Price in Ghana | ${settings.get('store_name')}`,
    metaDescription: helpers.truncate(product.short_description || product.description || product.name, 158),
    bodyClass: 'page-product',
    product,
    reviews,
    breakdown,
    related,
    canReview,
    alreadyReviewed,
    breadcrumbs: [{ label: 'Home', url: '/' }].concat(trail).concat([{ label: product.name }]),
    canonical: `/p/${product.slug}`,
  });
});

router.post('/p/:slug/review', (req, res) => {
  if (!req.user) { req.flash('info', 'Please sign in to write a review.'); return res.redirect('/login'); }
  const product = catalog.getProductBySlug(req.params.slug);
  if (!product) return res.redirect('/');
  const rating = Math.min(5, Math.max(1, Number(req.body.rating) || 0));
  if (!rating) { req.flash('danger', 'Please choose a star rating.'); return res.redirect(`/p/${product.slug}#reviews`); }
  const result = catalog.addReview({
    productId: product.id,
    userId: req.user.id,
    author: req.user.name,
    rating,
    title: (req.body.title || '').slice(0, 120),
    body: (req.body.body || '').slice(0, 2000),
  });
  require('../utils/log').notify('review', 'info', 'New review submitted',
    `${req.user.name} rated ${product.name} ${rating}★${result.approved ? '' : ' — awaiting moderation'}`,
    `/admin/reviews`);
  req.flash(result.approved ? 'success' : 'info',
    result.approved ? 'Thank you! Your review is now live.' : 'Thank you! Your review will appear after moderation.');
  return res.redirect(`/p/${product.slug}#reviews`);
});

/* --------------------------------------------------------- order tracking */
router.get('/track-order', (req, res) => {
  res.render('track', {
    pageTitle: `Track Your Order | ${settings.get('store_name')}`,
    bodyClass: 'page-track',
    order: null,
    notFound: null,
    breadcrumbs: [{ label: 'Track order', url: '/track-order' }],
  });
});

router.post('/track-order', (req, res) => {
  const number = (req.body.order_number || '').trim();
  const contact = (req.body.contact || '').trim();
  if (!number || !contact) {
    req.flash('danger', 'Enter both your order number and the phone number or email used at checkout.');
    return res.redirect('/track-order');
  }
  const order = orders.findForTracking(number, contact);
  if (!order) {
    return res.render('track', {
      pageTitle: `Track Your Order | ${settings.get('store_name')}`,
      bodyClass: 'page-track',
      order: null,
      notFound: `We could not find an order matching “${number}” with those contact details.`,
      breadcrumbs: [{ label: 'Track order', url: '/track-order' }],
    });
  }
  return res.render('track', {
    pageTitle: `Order ${order.order_number} | ${settings.get('store_name')}`,
    bodyClass: 'page-track',
    order,
    notFound: null,
    breadcrumbs: [{ label: 'Track order', url: '/track-order' }, { label: order.order_number }],
  });
});

/* ----------------------------------------------------------- static pages */
const PAGES = [
  { path: '/about', view: 'pages/about', title: 'About Biahens Enterprise' },
  { path: '/contact', view: 'pages/contact', title: 'Contact Us' },
  { path: '/faq', view: 'pages/faq', title: 'Frequently Asked Questions' },
  { path: '/shipping-delivery', view: 'pages/shipping', title: 'Shipping & Delivery' },
  { path: '/returns-refunds', view: 'pages/returns', title: 'Returns & Refunds' },
  { path: '/terms', view: 'pages/terms', title: 'Terms & Conditions' },
  { path: '/privacy', view: 'pages/privacy', title: 'Privacy Policy' },
  { path: '/sell-with-us', view: 'pages/sell', title: 'Our Single-Seller Promise' },
];
PAGES.forEach((p) => {
  router.get(p.path, (req, res) => res.render(p.view, {
    pageTitle: `${p.title} | ${settings.get('store_name')}`,
    bodyClass: 'page-static',
    pageHeading: p.title,
    breadcrumbs: [{ label: 'Home', url: '/' }, { label: p.title }],
    zones: db.prepare('SELECT * FROM shipping_rates WHERE is_active = 1 ORDER BY sort_order').all(),
  }));
});

router.post('/contact', (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim();
  const message = (req.body.message || '').trim();
  if (!name || !email || !message) {
    req.flash('danger', 'Please fill in your name, email and message.');
    return res.redirect('/contact');
  }
  require('../utils/log').notify('system', 'info', `Message from ${name}`, helpers.truncate(message, 220), '/admin/settings');
  require('../utils/log').sendMail({
    to: settings.get('support_email'), subject: `[Website enquiry] ${name}`,
    text: `${name} <${email}> wrote:\n\n${message}\n\nPhone: ${req.body.phone || '—'}`,
  });
  req.flash('success', 'Thank you! Our team will reply within one business day.');
  return res.redirect('/contact');
});

router.post('/newsletter', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) {
    if (req.xhr) return res.status(400).json({ ok: false, message: 'Enter a valid email address.' });
    req.flash('danger', 'Enter a valid email address.');
    return res.redirect(req.get('Referrer') || '/');
  }
  db.prepare('INSERT OR IGNORE INTO newsletter (email) VALUES (?)').run(email);
  db.prepare(`INSERT OR IGNORE INTO coupons (code, description, type, value, min_subtotal, expires_at)
              VALUES ('SUB5','Newsletter subscriber reward','percent',5,0,datetime('now','+180 days'))`).run();
  if (req.xhr) return res.json({ ok: true, message: 'You are on the list! Use code SUB5 for 5% off.' });
  req.flash('success', 'You are on the list — use code SUB5 for 5% off your next order.');
  return res.redirect(req.get('Referrer') || '/');
});

module.exports = router;
