'use strict';
const settings = require('../services/settings');
const catalog = require('../services/catalog');
const cartSvc = require('../services/cart');
const helpers = require('../utils/helpers');
const { icon } = require('../utils/icons');
const db = require('../db');

/* menu is queried on every page — cache it and invalidate on category writes */
let menuCache = null;
let menuCacheAt = 0;
function menuCategories() {
  if (menuCache && Date.now() - menuCacheAt < 30000) return menuCache;
  menuCache = catalog.menuCategories(9);
  menuCacheAt = Date.now();
  return menuCache;
}
function invalidateMenu() { menuCache = null; menuCacheAt = 0; }

let announcements = null;
let announcementsAt = 0;
function topDeals() {
  if (announcements && Date.now() - announcementsAt < 60000) return announcements;
  announcements = catalog.queryProducts({ onSale: true, sort: 'discount', perPage: 6 }).items;
  announcementsAt = Date.now();
  return announcements;
}

function flash(type, text) {
  if (!this.session) return;
  this.session.flash = this.session.flash || [];
  this.session.flash.push({ type: type || 'info', text });
}

function takeFlash(req) {
  const list = (req.session && req.session.flash) || [];
  if (req.session) req.session.flash = [];
  return list;
}

/** Attach everything EJS templates need. */
function context(req, res, next) {
  const s = settings.all();

  res.locals.settings = s;
  res.locals.setting = (k, f) => settings.get(k, f);
  res.locals.cfg = require('../config');
  res.locals.h = helpers;
  res.locals.money = helpers.money;
  res.locals.moneyShort = helpers.moneyShort;
  res.locals.dateFmt = helpers.dateFmt;
  res.locals.timeAgo = helpers.timeAgo;
  res.locals.discountPercent = helpers.discountPercent;
  res.locals.truncate = helpers.truncate;
  res.locals.imgSrc = require('../utils/images').imgSrc;
  res.locals.STATUS_META = helpers.STATUS_META;
  res.locals.icon = icon;
  res.locals.stars = (rating) => {
    const r = Math.max(0, Math.min(5, Number(rating) || 0));
    const full = Math.round(r);
    return '<span class="stars" aria-label="' + r.toFixed(1) + ' out of 5">'
      + '&#9733;'.repeat(full) + '<span style="opacity:.28">' + '&#9733;'.repeat(5 - full) + '</span></span>';
  };
  res.locals.initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  res.locals.user = req.user || null;
  res.locals.isOwner = !!(req.user && req.user.role === 'owner');
  res.locals.isStaff = !!(req.user && req.user.role === 'staff');
  res.locals.isAdminArea = req.path.startsWith('/admin');

  res.locals.currentPath = req.path;
  res.locals.query = req.query || {};
  res.locals.flashes = takeFlash(req);
  req.flash = flash.bind(req);

  res.locals.menuCategories = menuCategories();
  res.locals.topDeals = topDeals();

  // cart summary is needed by the header on every storefront page
  if (!req.path.startsWith('/admin') && !req.path.startsWith('/pay')) {
    try {
      const c = cartSvc.getCart(req);
      res.locals.cart = c;
      res.locals.cartCount = c.count;
      res.locals.wishlistCount = req.user ? cartSvc.wishlistCount(req.user.id) : 0;
    } catch (err) {
      res.locals.cart = { items: [], count: 0, subtotal: 0, total: 0, isEmpty: true };
      res.locals.cartCount = 0;
      res.locals.wishlistCount = 0;
    }
  } else {
    res.locals.cart = { items: [], count: 0, subtotal: 0, total: 0, isEmpty: true };
    res.locals.cartCount = 0;
    res.locals.wishlistCount = 0;
  }

  res.locals.unreadNotifications = 0;
  res.locals.pendingCount = 0;
  res.locals.lowStockCount = 0;
  res.locals.pendingReviews = 0;
  res.locals.adminNotifications = [];
  if (req.path.startsWith('/admin')) {
    try {
      res.locals.unreadNotifications = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE is_read = 0').get().n;
      res.locals.pendingCount = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status IN ('paid','processing','pending_payment')`).get().n;
      res.locals.lowStockCount = db.prepare('SELECT COUNT(*) AS n FROM products WHERE status != \'archived\' AND stock <= low_stock_at').get().n;
      res.locals.pendingReviews = db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE is_approved = 0').get().n;
      res.locals.adminNotifications = db.prepare(
        'SELECT * FROM notifications ORDER BY is_read ASC, created_at DESC LIMIT 8'
      ).all();
    } catch (_) {}
  }

  res.locals.pageTitle = null;
  res.locals.metaDescription = s.meta_description;
  res.locals.metaKeywords = s.meta_keywords;
  res.locals.bodyClass = '';
  res.locals.breadcrumbs = [];

  next();
}

module.exports = { context, invalidateMenu, menuCategories };
