'use strict';
const db = require('../db');
const settings = require('./settings');
const catalog = require('./catalog');
const { round2, parseJson, toNumber } = require('../utils/helpers');

function key(req) {
  return { userId: req.user ? req.user.id : null, sessionId: req.sessionID || null };
}

function rawItems(req) {
  const { userId, sessionId } = key(req);
  const rows = userId
    ? db.prepare('SELECT * FROM cart_items WHERE user_id = ? ORDER BY added_at DESC').all(userId)
    : db.prepare('SELECT * FROM cart_items WHERE session_id = ? AND user_id IS NULL ORDER BY added_at DESC').all(sessionId);

  const out = [];
  rows.forEach((r) => {
    const p = catalog.getProductById(r.product_id);
    if (!p || p.status !== 'active') {
      db.prepare('DELETE FROM cart_items WHERE id = ?').run(r.id);
      return;
    }
    let variant = null;
    if (r.variant_id) {
      variant = db.prepare('SELECT * FROM variants WHERE id = ?').get(r.variant_id);
      if (!variant || !variant.is_active) {
        db.prepare('UPDATE cart_items SET variant_id = NULL WHERE id = ?').run(r.id);
        variant = null;
      }
    }
    const unit = round2(p.price + (variant ? variant.price_delta : 0));
    const available = variant ? variant.stock : p.stock;
    out.push({
      id: r.id, product: p, variant, qty: r.qty, unit_price: unit,
      line_total: round2(unit * r.qty), available,
      requires_variant: p.variants.length > 0 && !variant,
      over_stock: r.qty > available && available >= 0,
      image: (variant && variant.image) || p.image || (p.images_list && p.images_list[0]) || '',
      added_at: r.added_at,
    });
  });
  return out;
}

/** Shipping fee for a region + delivery method (free above threshold). */
function shippingQuote({ region = '', method = 'standard', subtotal = 0 }) {
  if (method === 'pickup') return { fee: toNumber(settings.get('pickup_fee'), 0), eta: 'Ready in 2–6 hours' };
  if (method === 'express') {
    const base = toNumber(settings.get('express_shipping_fee'), 70);
    const zone = region ? db.prepare('SELECT * FROM shipping_rates WHERE region = ?').get(region) : null;
    const fee = round2(base + (zone ? zone.fee * 0.35 : 0));
    return { fee, eta: zone && zone.eta_days ? `Express ${zone.eta_days}` : 'Express 24 hours' };
  }
  const zone = region ? db.prepare('SELECT * FROM shipping_rates WHERE region = ? AND is_active = 1').get(region) : null;
  const base = zone ? zone.fee : toNumber(settings.get('default_shipping_fee'), 35);
  const threshold = toNumber(settings.get('free_shipping_threshold'), 1500);
  const free = threshold > 0 && subtotal >= threshold;
  return {
    fee: free ? 0 : round2(base),
    free,
    threshold,
    eta: zone ? zone.eta_days : '2–4 days',
  };
}

function findCoupon(code) {
  return db.prepare('SELECT * FROM coupons WHERE code = ? COLLATE NOCASE').get(String(code || '').trim());
}

/** Validate + price a coupon against a cart. Returns {ok, coupon, discount, message}. */
function evaluateCoupon(code, { subtotal, items, userId }) {
  const coupon = findCoupon(code);
  if (!coupon) return { ok: false, message: 'That coupon code does not exist.' };
  if (!coupon.is_active) return { ok: false, message: 'That coupon is no longer active.' };
  const now = Date.now();
  const ts = (s) => (s ? new Date(String(s).replace(' ', 'T') + 'Z').getTime() : null);
  if (ts(coupon.starts_at) && now < ts(coupon.starts_at)) return { ok: false, message: 'This coupon is not valid yet.' };
  if (ts(coupon.expires_at) && now > ts(coupon.expires_at)) return { ok: false, message: 'This coupon has expired.' };
  if (coupon.usage_limit && coupon.used_count >= coupon.usage_limit) return { ok: false, message: 'This coupon has reached its usage limit.' };

  if (coupon.scope !== 'all') {
    let match = false;
    if (coupon.scope === 'category') {
      const eligibleCategories = new Set(catalog.categoryIdsIncludingChildren(coupon.scope_id));
      match = items.some((i) => eligibleCategories.has(Number(i.product.category_id)));
    } else {
      const field = coupon.scope === 'brand' ? 'brand_id' : 'id';
      match = items.some((i) => Number(i.product[field]) === Number(coupon.scope_id));
    }
    if (!match) return { ok: false, message: `This coupon only applies to selected ${coupon.scope} items.` };
  }
  if (coupon.min_subtotal && subtotal < coupon.min_subtotal) {
    return { ok: false, message: `Spend at least GH₵${coupon.min_subtotal.toFixed(2)} to use this coupon.` };
  }

  let discount = 0;
  if (coupon.type === 'percent') {
    discount = subtotal * (coupon.value / 100);
    if (coupon.max_discount) discount = Math.min(discount, coupon.max_discount);
  } else if (coupon.type === 'fixed') {
    discount = Math.min(coupon.value, subtotal);
  } else if (coupon.type === 'free_shipping') {
    discount = 0;
  }
  return { ok: true, coupon, discount: round2(discount), message: 'Coupon applied.' };
}

/**
 * Full cart summary used by the mini-cart, cart page and checkout.
 */
function getCart(req, { region = null, method = null, couponCode = null } = {}) {
  const items = rawItems(req);

  // drop anything that is now out of stock / needs a variant choice
  const valid = items.filter((i) => !i.requires_variant && i.available > 0);
  const dropped = items.length - valid.length;

  const subtotal = round2(valid.reduce((s, i) => s + i.line_total, 0));
  const savings = round2(valid.reduce((s, i) => {
    const cmp = i.product.compare_at_price || 0;
    return s + (cmp > i.unit_price ? (cmp - i.unit_price) * i.qty : 0);
  }, 0));
  const weight = round2(valid.reduce((s, i) => s + (i.product.weight_kg || 0) * i.qty, 0));

  const shipRegion = region || (req.session && req.session.shipRegion) || '';
  const shipMethod = method || (req.session && req.session.shipMethod) || 'standard';
  const ship = shippingQuote({ region: shipRegion, method: shipMethod, subtotal });

  let coupon = null;
  let discount = 0;
  let couponError = null;
  const code = couponCode !== null ? couponCode : (req.session && req.session.couponCode);
  if (code) {
    const res = evaluateCoupon(code, { subtotal, items: valid, userId: req.user ? req.user.id : null });
    if (res.ok) {
      coupon = res.coupon;
      discount = res.discount;
      if (coupon.type === 'free_shipping') { ship.fee = 0; ship.free = true; }
    } else {
      couponError = res.message;
      if (req.session) req.session.couponCode = null;
    }
  }

  const taxRate = toNumber(settings.get('tax_rate'), 0) / 100;
  const tax = round2((subtotal - discount) * taxRate);
  const shipping = valid.length ? ship.fee : 0;
  const total = round2(Math.max(0, subtotal - discount + shipping + tax));
  const count = valid.reduce((s, i) => s + i.qty, 0);
  const threshold = toNumber(settings.get('free_shipping_threshold'), 1500);

  return {
    items: valid, count, subtotal, savings, discount, shipping, tax, total, weight,
    coupon, couponError, ship, dropped,
    freeShippingGap: ship.free || !valid.length ? 0 : round2(Math.max(0, threshold - subtotal)),
    threshold,
    isEmpty: valid.length === 0,
  };
}

function addToCart(req, { productId, variantId = null, qty = 1 }) {
  const product = catalog.getProductById(Number(productId));
  if (!product) return { ok: false, message: 'Product not found.' };
  if (product.stock <= 0) return { ok: false, message: 'That item is out of stock.' };

  let variant = null;
  if (product.variants.length) {
    if (!variantId) return { ok: false, message: 'Please choose an option before adding to cart.', needsVariant: true };
    variant = product.variants.find((v) => v.id === Number(variantId));
    if (!variant) return { ok: false, message: 'That option is not available.' };
    if (variant.stock <= 0) return { ok: false, message: 'That option is out of stock.' };
  }

  const { userId, sessionId } = key(req);
  const existing = userId
    ? db.prepare('SELECT * FROM cart_items WHERE user_id = ? AND product_id = ? AND variant_id IS ?').get(userId, product.id, variant ? variant.id : null)
    : db.prepare('SELECT * FROM cart_items WHERE session_id = ? AND user_id IS NULL AND product_id = ? AND variant_id IS ?').get(sessionId, product.id, variant ? variant.id : null);

  const want = Math.max(1, Number(qty) || 1);
  const available = variant ? variant.stock : product.stock;
  const nextQty = Math.min(available, (existing ? existing.qty : 0) + want);

  if (existing) {
    db.prepare('UPDATE cart_items SET qty = ? WHERE id = ?').run(nextQty, existing.id);
  } else {
    db.prepare(
      'INSERT INTO cart_items (session_id, user_id, product_id, variant_id, qty) VALUES (?,?,?,?,?)'
    ).run(userId ? null : sessionId, userId || null, product.id, variant ? variant.id : null, nextQty);
  }
  return {
    ok: true,
    message: nextQty < (existing ? existing.qty : 0) + want
      ? `Only ${nextQty} left in stock — cart updated.`
      : `${product.name} added to your cart.`,
    qty: nextQty,
  };
}

function setQty(req, itemId, qty) {
  const { userId, sessionId } = key(req);
  const row = userId
    ? db.prepare('SELECT * FROM cart_items WHERE id = ? AND user_id = ?').get(itemId, userId)
    : db.prepare('SELECT * FROM cart_items WHERE id = ? AND session_id = ?').get(itemId, sessionId);
  if (!row) return { ok: false, message: 'Cart line not found.' };
  const q = Math.max(0, Number(qty) || 0);
  if (q === 0) {
    db.prepare('DELETE FROM cart_items WHERE id = ?').run(row.id);
    return { ok: true, message: 'Item removed.' };
  }
  const product = catalog.getProductById(row.product_id);
  const available = row.variant_id
    ? (db.prepare('SELECT stock FROM variants WHERE id = ?').get(row.variant_id) || { stock: 0 }).stock
    : (product ? product.stock : 0);
  const final = Math.min(q, available);
  db.prepare('UPDATE cart_items SET qty = ? WHERE id = ?').run(Math.max(1, final), row.id);
  return { ok: true, message: final < q ? `Only ${final} available.` : 'Cart updated.', qty: final };
}

function removeItem(req, itemId) {
  const { userId, sessionId } = key(req);
  const info = userId
    ? db.prepare('DELETE FROM cart_items WHERE id = ? AND user_id = ?').run(itemId, userId)
    : db.prepare('DELETE FROM cart_items WHERE id = ? AND session_id = ?').run(itemId, sessionId);
  return { ok: info.changes > 0, message: 'Item removed from your cart.' };
}

function clear(req) {
  const { userId, sessionId } = key(req);
  if (userId) db.prepare('DELETE FROM cart_items WHERE user_id = ?').run(userId);
  else db.prepare('DELETE FROM cart_items WHERE session_id = ?').run(sessionId);
  if (req.session) { req.session.couponCode = null; req.session.shipRegion = null; req.session.shipMethod = null; }
}

/** Merge the guest session cart into the account cart after login. */
function mergeIntoUser(sessionId, userId) {
  if (!sessionId || !userId) return;
  const guest = db.prepare('SELECT * FROM cart_items WHERE session_id = ? AND user_id IS NULL').all(sessionId);
  const tx = db.transaction(() => {
    guest.forEach((g) => {
      const existing = db.prepare(
        'SELECT * FROM cart_items WHERE user_id = ? AND product_id = ? AND variant_id IS ?'
      ).get(userId, g.product_id, g.variant_id);
      if (existing) {
        db.prepare('UPDATE cart_items SET qty = ? WHERE id = ?').run(existing.qty + g.qty, existing.id);
        db.prepare('DELETE FROM cart_items WHERE id = ?').run(g.id);
      } else {
        db.prepare('UPDATE cart_items SET user_id = ?, session_id = NULL WHERE id = ?').run(userId, g.id);
      }
    });
  });
  tx();
}

function cartCount(req) {
  const { userId, sessionId } = key(req);
  const row = userId
    ? db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM cart_items WHERE user_id = ?').get(userId)
    : db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM cart_items WHERE session_id = ? AND user_id IS NULL').get(sessionId);
  return row.n;
}

/* ---------------------------------------------------------------- wishlist */

function wishlistItems(userId) {
  if (!userId) return [];
  const categoryIds = catalog.fashionCategoryIds();
  if (!categoryIds.length) return [];
  const marks = categoryIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT w.id AS wish_id, w.created_at AS wished_at, p.* FROM wishlists w
     JOIN products p ON p.id = w.product_id
     WHERE w.user_id = ? AND p.category_id IN (${marks})
       AND p.is_active = 1 AND p.status = 'active'
     ORDER BY w.created_at DESC`
  ).all(userId, ...categoryIds).map((r) => catalog.decorate({
    ...r,
    category_name: undefined,
  }));
}

function toggleWishlist(userId, productId) {
  const existing = db.prepare('SELECT id FROM wishlists WHERE user_id = ? AND product_id = ?').get(userId, productId);
  if (existing) {
    db.prepare('DELETE FROM wishlists WHERE id = ?').run(existing.id);
    return { ok: true, added: false, message: 'Removed from your wishlist.' };
  }
  db.prepare('INSERT INTO wishlists (user_id, product_id) VALUES (?,?)').run(userId, productId);
  return { ok: true, added: true, message: 'Saved to your wishlist.' };
}

function inWishlist(userId, productIds) {
  if (!userId || !productIds || !productIds.length) return new Set();
  const q = productIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT product_id FROM wishlists WHERE user_id = ? AND product_id IN (${q})`).all(userId, ...productIds);
  return new Set(rows.map((r) => r.product_id));
}

function wishlistCount(userId) {
  if (!userId) return 0;
  const categoryIds = catalog.fashionCategoryIds();
  if (!categoryIds.length) return 0;
  const marks = categoryIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT COUNT(*) AS n FROM wishlists w
     JOIN products p ON p.id = w.product_id
     WHERE w.user_id = ? AND p.category_id IN (${marks})
       AND p.is_active = 1 AND p.status = 'active'`
  ).get(userId, ...categoryIds).n;
}

module.exports = {
  getCart, addToCart, setQty, removeItem, clear, mergeIntoUser, cartCount,
  shippingQuote, evaluateCoupon, findCoupon,
  wishlistItems, toggleWishlist, inWishlist, wishlistCount,
};
