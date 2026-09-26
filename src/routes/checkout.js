'use strict';
const express = require('express');
const db = require('../db');
const settings = require('../services/settings');
const cartSvc = require('../services/cart');
const orders = require('../services/orders');
const payments = require('../services/payments');
const { GHANA_REGIONS, round2, toNumber } = require('../utils/helpers');

const router = express.Router();

const STEPS = [
  { n: 1, key: 'address', label: 'Delivery details' },
  { n: 2, key: 'delivery', label: 'Delivery method' },
  { n: 3, key: 'payment', label: 'Payment' },
  { n: 4, key: 'review', label: 'Review & place order' },
];

function draft(req) {
  if (!req.session.checkout) {
    req.session.checkout = {
      step: 1,
      shipping: {},
      delivery: { method: 'standard', note: '' },
      payment: { method: settings.get('card_enabled') ? 'card' : settings.get('momo_enabled') ? 'momo' : 'cod' },
    };
  }
  return req.session.checkout;
}

function prefill(req, d) {
  if (req.user && !d.shipping.name) {
    const addr = db.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT 1').get(req.user.id);
    d.shipping = {
      name: req.user.name,
      phone: req.user.phone || '',
      email: req.user.email,
      region: addr ? addr.region : 'Greater Accra',
      city: addr ? addr.city : 'Accra',
      line: addr ? addr.line : '',
      landmark: addr ? addr.landmark : '',
    };
  }
  return d;
}

function renderStep(req, res, step, errors = {}) {
  const d = prefill(req, draft(req));
  d.step = step;
  const cart = cartSvc.getCart(req, { region: d.shipping.region, method: d.delivery.method });
  if (cart.isEmpty && step < 5) {
    req.flash('info', 'Your cart is empty — add something before checking out.');
    return res.redirect('/cart');
  }
  res.render('checkout/index', {
    pageTitle: `Secure Checkout — Step ${step} of 4 | ${settings.get('store_name')}`,
    bodyClass: 'page-checkout',
    cart,
    draft: d,
    steps: STEPS,
    step,
    errors,
    regions: GHANA_REGIONS,
    zones: db.prepare('SELECT * FROM shipping_rates WHERE is_active = 1 ORDER BY sort_order').all(),
    momoNetworks: payments.MOMO_NETWORKS,
    banks: payments.BANKS,
    testCards: payments.TEST_CARDS,
    breadcrumbs: [{ label: 'Cart', url: '/cart' }, { label: 'Checkout' }],
  });
  return undefined;
}

function requireCart(req, res, next) {
  const cart = cartSvc.getCart(req);
  if (cart.isEmpty) {
    req.flash('info', 'Your cart is empty.');
    return res.redirect('/cart');
  }
  return next();
}

router.get('/checkout', requireCart, (req, res) => renderStep(req, res, Number(req.query.step) || draft(req).step || 1));

/* ------------------------------------------------------ step 1: address */
const GH_PHONE = /^(\+233|0)(20|23|24|25|26|27|28|50|54|55|56|57|59)[0-9]{7}$/;
function validateShipping(body) {
  const errors = {};
  const s = {
    name: (body.name || '').trim(),
    phone: (body.phone || '').replace(/[\s-]/g, ''),
    email: (body.email || '').trim().toLowerCase(),
    region: (body.region || '').trim(),
    city: (body.city || '').trim(),
    line: (body.line || '').trim(),
    landmark: (body.landmark || '').trim(),
    save_address: body.save_address === '1' || body.save_address === 'on',
  };
  if (s.name.length < 3) errors.name = 'Enter the full name of the person receiving the order.';
  if (!GH_PHONE.test(s.phone)) errors.phone = 'Enter a valid Ghanaian number, e.g. 024 123 4567 or +233 24 123 4567.';
  if (s.email && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s.email)) errors.email = 'Enter a valid email address (or leave it blank).';
  if (!GHANA_REGIONS.includes(s.region)) errors.region = 'Choose your region.';
  if (s.city.length < 2) errors.city = 'Enter your town or city.';
  if (s.line.length < 5) errors.line = 'Enter a house/street description a rider can find.';
  return { errors, shipping: s };
}

router.post('/checkout/address', requireCart, (req, res) => {
  const { errors, shipping } = validateShipping(req.body);
  const d = draft(req);
  d.shipping = Object.assign({}, d.shipping, shipping);
  if (Object.keys(errors).length) return renderStep(req, res, 1, errors);

  if (req.user && shipping.save_address) {
    db.prepare(
      `INSERT INTO addresses (user_id, label, receiver, phone, region, city, line, landmark, is_default)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(req.user.id, 'Checkout', shipping.name, shipping.phone, shipping.region, shipping.city,
      shipping.line, shipping.landmark || null,
      db.prepare('SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?').get(req.user.id).n === 0 ? 1 : 0);
  }
  req.session.shipRegion = shipping.region;
  return renderStep(req, res, 2);
});

/* ----------------------------------------------------- step 2: delivery */
router.post('/checkout/delivery', requireCart, (req, res) => {
  const d = draft(req);
  const method = ['standard', 'express', 'pickup'].includes(req.body.method) ? req.body.method : 'standard';
  if (method === 'express' && toNumber(settings.get('express_shipping_fee')) === 0 && !settings.get('cod_enabled')) {
    req.flash('warn', 'Express delivery is not available right now.');
    return renderStep(req, res, 2);
  }
  d.delivery = { method, note: (req.body.note || '').slice(0, 240) };
  req.session.shipMethod = method;
  return renderStep(req, res, 3);
});

/* ------------------------------------------------------ step 3: payment */
router.post('/checkout/payment', requireCart, (req, res) => {
  const d = draft(req);
  const method = ['card', 'momo', 'cod'].includes(req.body.method) ? req.body.method : 'card';
  const enabled = { card: settings.get('card_enabled'), momo: settings.get('momo_enabled'), cod: settings.get('cod_enabled') };
  if (!enabled[method]) {
    req.flash('danger', 'That payment method is currently disabled.');
    return renderStep(req, res, 3);
  }
  if (method === 'cod') {
    const cart = cartSvc.getCart(req, { region: d.shipping.region, method: d.delivery.method });
    const cap = 5000;
    if (cart.total > cap) {
      req.flash('danger', `Cash on delivery is only available for orders up to GH₵${cap.toFixed(2)}. Please pay with MoMo or card.`);
      return renderStep(req, res, 3);
    }
  }
  d.payment = { method, terms: req.body.terms === '1' || req.body.terms === 'on' };
  return renderStep(req, res, 4);
});

/* ------------------------------------------ step 4: place order & pay */
router.post('/checkout/place', requireCart, (req, res, next) => {
  const d = draft(req);
  if (!d.shipping || !d.shipping.name || !d.shipping.phone) {
    req.flash('danger', 'Please complete your delivery details.');
    return renderStep(req, res, 1);
  }
  if (!d.payment || !d.payment.method) {
    req.flash('danger', 'Please choose a payment method.');
    return renderStep(req, res, 3);
  }
  if (req.body.terms !== '1' && req.body.terms !== 'on') {
    req.flash('danger', 'Please accept the terms of sale and privacy policy to continue.');
    return renderStep(req, res, 4);
  }

  const result = orders.createFromCart(req, { shipping: d.shipping, payment: d.payment, delivery: d.delivery });
  if (!result.ok) {
    req.flash('danger', result.message);
    return renderStep(req, res, 4);
  }

  const order = orders.getOrder(result.orderId);
  req.session.lastOrderNumber = order.order_number;

  // snapshot the cart lines into the session so the confirmation page can show them
  req.session.placedCart = result.cart.items.map((i) => ({ name: i.product.name, qty: i.qty, total: i.line_total }));

  if (d.payment.method === 'cod') {
    cartSvc.clear(req);
    req.session.checkout = null;
    return res.redirect(`/order/${order.order_number}?placed=1`);
  }

  const init = payments.initialize(order, { method: d.payment.method, email: d.shipping.email || (req.user && req.user.email) });
  req.session.pendingReference = init.reference;
  return res.redirect(init.authorization_url);
});

router.get('/checkout/back/:step', requireCart, (req, res) => renderStep(req, res, Number(req.params.step) || 1));

/* ------------------------------------------------- confirmation / receipt */
router.get('/order/:number', (req, res, next) => {
  const order = orders.getOrderByNumber(req.params.number);
  if (!order) return next();
  const allowed = (req.user && order.user_id === req.user.id)
    || req.session.lastOrderNumber === order.order_number
    || (req.user && (req.user.role === 'owner' || req.user.role === 'staff'));
  if (!allowed) {
    req.flash('danger', 'That order does not belong to this session.');
    return res.redirect('/account/orders');
  }
  const justPlaced = req.query.placed === '1';
  const justPaid = req.query.paid === '1';
  if (justPaid || justPlaced) {
    delete req.session.checkout;
    if (justPaid) cartSvc.clear(req);
  }
  res.render('checkout/confirmation', {
    pageTitle: `Order ${order.order_number} | ${settings.get('store_name')}`,
    bodyClass: 'page-confirmation',
    order,
    justPlaced,
    justPaid,
    placedCart: req.session.placedCart || null,
    breadcrumbs: [{ label: 'Home', url: '/' }, { label: 'Order confirmation' }],
  });
  return undefined;
});

router.get('/order/:number/receipt', (req, res, next) => {
  const order = orders.getOrderByNumber(req.params.number);
  if (!order) return next();
  res.render('admin/partials/invoice', {
    layout: false,
    order,
    printView: true,
    pageTitle: `Receipt ${order.order_number}`,
  });
});

module.exports = router;
