'use strict';
const express = require('express');
const cartSvc = require('../services/cart');
const catalog = require('../services/catalog');
const settings = require('../services/settings');
const { round2 } = require('../utils/helpers');

const router = express.Router();

function jsonCart(req, res, message, status = 200) {
  const cart = cartSvc.getCart(req);
  return res.status(status).json({
    ok: status < 400,
    message,
    cart: {
      count: cart.count,
      subtotal: cart.subtotal,
      discount: cart.discount,
      shipping: cart.shipping,
      total: cart.total,
      savings: cart.savings,
      isEmpty: cart.isEmpty,
      freeShippingGap: cart.freeShippingGap,
      items: cart.items.map((i) => ({
        id: i.id,
        name: i.product.name,
        slug: i.product.slug,
        variant: i.variant ? i.variant.title : null,
        qty: i.qty,
        unit_price: i.unit_price,
        line_total: i.line_total,
        image: i.image,
        available: i.available,
      })),
    },
  });
}

router.get('/cart', (req, res) => {
  const cart = cartSvc.getCart(req);
  res.render('cart/index', {
    pageTitle: `Your Shopping Cart (${cart.count}) | ${settings.get('store_name')}`,
    bodyClass: 'page-cart',
    cart,
    shipRegion: req.session.shipRegion || '',
    shipMethod: req.session.shipMethod || 'standard',
    suggestions: cart.isEmpty ? catalog.queryProducts({ sort: 'popular', perPage: 8 }).items : [],
    breadcrumbs: [{ label: 'Home', url: '/' }, { label: 'Shopping cart' }],
  });
});

router.post('/cart/add', (req, res) => {
  const result = cartSvc.addToCart(req, {
    productId: req.body.product_id || req.body.productId,
    variantId: req.body.variant_id || req.body.variantId || null,
    qty: req.body.qty || req.body.quantity || 1,
  });
  if (req.xhr || req.headers.accept === 'application/json') {
    return jsonCart(req, res, result.message, result.ok ? 200 : 400);
  }
  req.flash(result.ok ? 'success' : 'danger', result.message);
  if (result.ok && req.body.buy_now === '1') return res.redirect('/checkout');
  if (result.ok && req.body.redirect !== 'back') return res.redirect('/cart');
  return res.redirect(req.get('Referrer') || '/cart');
});

router.post('/cart/update', (req, res) => {
  const result = cartSvc.setQty(req, Number(req.body.item_id || req.body.id), req.body.qty);
  if (req.xhr || req.headers.accept === 'application/json') return jsonCart(req, res, result.message, result.ok ? 200 : 400);
  req.flash(result.ok ? 'success' : 'danger', result.message);
  return res.redirect('/cart');
});

router.post('/cart/remove', (req, res) => {
  const result = cartSvc.removeItem(req, Number(req.body.item_id || req.body.id));
  if (req.xhr || req.headers.accept === 'application/json') return jsonCart(req, res, result.message, result.ok ? 200 : 404);
  req.flash('info', result.message);
  return res.redirect(req.get('Referrer') || '/cart');
});

router.post('/cart/coupon', (req, res) => {
  const code = (req.body.code || '').trim();
  const cart = cartSvc.getCart(req);
  if (cart.isEmpty) {
    req.flash('danger', 'Add something to your cart before applying a coupon.');
    return res.redirect('/cart');
  }
  const result = cartSvc.evaluateCoupon(code, { subtotal: cart.subtotal, items: cart.items, userId: req.user && req.user.id });
  if (result.ok) {
    req.session.couponCode = result.coupon.code;
    req.flash('success', `Coupon ${result.coupon.code.toUpperCase()} applied — you saved GH₵${round2(result.discount).toFixed(2)}.`);
  } else {
    req.session.couponCode = null;
    req.flash('danger', result.message);
  }
  return res.redirect(req.get('Referrer') || '/cart');
});

router.post('/cart/coupon/remove', (req, res) => {
  req.session.couponCode = null;
  if (req.xhr) return jsonCart(req, res, 'Coupon removed.');
  req.flash('info', 'Coupon removed.');
  return res.redirect(req.get('Referrer') || '/cart');
});

router.post('/cart/ship', (req, res) => {
  if (req.body.region !== undefined) req.session.shipRegion = req.body.region;
  if (req.body.method !== undefined) req.session.shipMethod = req.body.method;
  if (req.xhr) {
    const cart = cartSvc.getCart(req, { region: req.body.region, method: req.body.method });
    return res.json({ ok: true, shipping: cart.shipping, total: cart.total, eta: cart.ship.eta, fee: cart.ship.fee });
  }
  return res.redirect(req.get('Referrer') || '/cart');
});

router.post('/cart/clear', (req, res) => {
  cartSvc.clear(req);
  if (req.xhr) return jsonCart(req, res, 'Cart emptied.');
  req.flash('info', 'Your cart has been emptied.');
  return res.redirect('/cart');
});

/* --------------------------------------------------------------- wishlist */
router.post('/wishlist/toggle', (req, res) => {
  if (!req.user) {
    if (req.xhr) return res.status(401).json({ ok: false, message: 'Sign in to save items to your wishlist.', loginUrl: '/login' });
    req.flash('info', 'Sign in to save items to your wishlist.');
    return res.redirect('/login');
  }
  const productId = Number(req.body.product_id || req.body.id);
  const product = catalog.getProductById(productId);
  if (!product) return res.status(404).json({ ok: false, message: 'Product not found.' });
  const result = cartSvc.toggleWishlist(req.user.id, productId);
  if (req.xhr || req.headers.accept === 'application/json') {
    return res.json({ ok: true, added: result.added, message: result.message, count: cartSvc.wishlistCount(req.user.id) });
  }
  req.flash(result.added ? 'success' : 'info', result.message);
  return res.redirect(req.get('Referrer') || '/account/wishlist');
});

router.post('/wishlist/move-to-cart', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const productId = Number(req.body.product_id);
  const product = catalog.getProductById(productId);
  if (!product) { req.flash('danger', 'That item is no longer available.'); return res.redirect('/account/wishlist'); }
  if (product.variants.length) {
    req.flash('info', 'Choose an option for this item before moving it to your cart.');
    return res.redirect(`/p/${product.slug}`);
  }
  const added = cartSvc.addToCart(req, { productId, qty: 1 });
  if (added.ok) cartSvc.toggleWishlist(req.user.id, productId);
  req.flash(added.ok ? 'success' : 'danger', added.message);
  return res.redirect('/account/wishlist');
});

router.post('/wishlist/move-all', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const items = cartSvc.wishlistItems(req.user.id);
  let added = 0;
  let skipped = 0;
  items.forEach((p) => {
    if (!p.in_stock || (p.variants && p.variants.length)) { skipped += 1; return; }
    const r = cartSvc.addToCart(req, { productId: p.id, qty: 1 });
    if (r.ok) { cartSvc.toggleWishlist(req.user.id, p.id); added += 1; } else skipped += 1;
  });
  req.flash(added ? 'success' : 'info', added
    ? `Moved ${added} item${added === 1 ? '' : 's'} to your cart${skipped ? ` · ${skipped} skipped (out of stock or needs an option)` : ''}.`
    : 'Nothing could be moved to the cart right now.');
  return res.redirect(added ? '/cart' : '/account/wishlist');
});

router.post('/wishlist/remove', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const productId = Number(req.body.product_id);
  if (cartSvc.inWishlist(req.user.id, [productId]).has(productId)) {
    cartSvc.toggleWishlist(req.user.id, productId);
    req.flash('info', 'Removed from your wishlist.');
  }
  return res.redirect('/account/wishlist');
});

module.exports = router;
