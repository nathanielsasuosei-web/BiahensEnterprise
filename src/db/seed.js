'use strict';
/* eslint-disable no-console */
/**
 * Seeds Biahens Enterprise with a realistic Ghanaian marketplace:
 * categories, brands, products, variants, customers, reviews, coupons,
 * shipping zones, homepage slides and ~70 orders across every status.
 *
 *   node src/db/seed.js           # seeds only if the database is empty
 *   node src/db/seed.js --fresh   # wipes and rebuilds everything
 */
const db = require('./index');
const settings = require('../services/settings');
const catalog = require('../services/catalog');
const { round2, slugify } = require('../utils/helpers');
const config = require('../config');
const bcrypt = require('bcryptjs');
const DATA = require('./catalog-data');

const argv = process.argv.slice(2);
const FRESH = argv.includes('--fresh') || argv.includes('--force');

/* deterministic RNG so re-seeding produces the same store */
let seedState = 20260926;
function rnd() {
  seedState |= 0; seedState = (seedState + 0x6D2B79F5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const chance = (p) => rnd() < p;

const GH_FIRST = ['Kwame', 'Akosua', 'Kofi', 'Abena', 'Yaw', 'Ama', 'Kojo', 'Afia', 'Kwabena', 'Adwoa',
  'Nana', 'Efua', 'Selorm', 'Mensah', 'Gifty', 'Daniel', 'Comfort', 'Emmanuel', 'Nhyira', 'Fiifi',
  'Zainab', 'Ibrahim', 'Hawa', 'Rachael', 'Michael', 'Priscilla', 'Samuel', 'Esi', 'Tetteh', 'Linda'];
const GH_LAST = ['Mensah', 'Owusu', 'Asante', 'Boateng', 'Adjei', 'Darko', 'Agyeman', 'Quartey', 'Amoah',
  'Ofori', 'Appiah', 'Ntim', 'Agbeko', 'Bonsu', 'Tetteh', 'Ansah', 'Addo', 'Sarpong', 'Ayeh', 'Kumi',
  'Iddrisu', 'Abdul-Rahman', 'Nartey', 'Amankwah', 'Osei', 'Yeboah', 'Baidoo', 'Nyarko'];
const CITIES = {
  'Greater Accra': ['Accra – East Legon', 'Accra – Osu', 'Tema – Community 25', 'Accra – Spintex', 'Accra – Madina', 'Dansoman', 'Accra – Airport Residential', 'Adenta'],
  'Ashanti': ['Kumasi – Ahodwo', 'Kumasi – Asokwa', 'Obuasi', 'Kumasi – Tanoso', 'Ejisu'],
  'Central': ['Cape Coast', 'Kasoa', 'Winneba', 'Mankessim', 'Elmina'],
  'Eastern': ['Koforidua', 'Nkawkaw', 'Akim Oda', 'Aburi', 'Somanya'],
  'Western': ['Takoradi', 'Sekondi', 'Tarkwa', 'Axim', 'Half Assini'],
  'Volta': ['Ho', 'Keta', 'Aflao', 'Hohoe', 'Dzodze'],
  'Northern': ['Tamale', 'Yendi', 'Bimbilla', 'Savelugu'],
  'Bono': ['Sunyani', 'Berekum', 'Wenchi', 'Dormaa Ahenkro'],
  'Upper East': ['Bolgatanga', 'Bawku', 'Navrongo', 'Zebilla'],
  'Upper West': ['Wa', 'Lawra', 'Tumu', 'Jirapa'],
  'Savannah': ['Damongo', 'Salaga', 'Bole'],
  'Ahafo': ['Goaso', 'Hwidiem', 'Kenyasi'],
  'Bono East': ['Techiman', 'Kintampo', 'Nkoranza'],
  'North East': ['Nalerigu', 'Walewale'],
  'Oti': ['Dambai', 'Jasikan', 'Kadjebi'],
  'Western North': ['Sefwi Wiawso', 'Enchi', 'Bibiani'],
};

function clearAll() {
  const tables = ['audit_log', 'notifications', 'newsletter', 'slides', 'settings', 'payments',
    'order_events', 'order_items', 'orders', 'shipping_rates', 'coupons', 'reviews', 'wishlists',
    'cart_items', 'variants', 'products', 'brands', 'categories', 'addresses', 'users', 'sessions'];
  db.pragma('foreign_keys = OFF');
  tables.forEach((t) => { try { db.prepare(`DELETE FROM ${t}`).run(); } catch (_) {} });
  db.pragma('foreign_keys = ON');
  tables.forEach((t) => {
    try { db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(t); } catch (_) {}
  });
}

function main(opts = {}) {
  const fresh = opts.fresh === undefined ? FRESH : !!opts.fresh;
  const quiet = !!opts.quiet;
  const hasProducts = db.prepare('SELECT COUNT(*) AS n FROM products').get().n > 0;
  if (hasProducts && !fresh) {
    if (!quiet) console.log('ℹ  Database already contains products. Re-run with --fresh to rebuild.');
    settings.ensureDefaults();
    return;
  }
  if (fresh) {
    if (!quiet) console.log('↻  Wiping existing data (--fresh)…');
    clearAll();
  }
  settings.ensureDefaults();

  const t0 = Date.now();
  const ids = {};

  /* ------------------------------------------------------------ categories */
  ids.categories = {};
  const insCat = db.prepare(
    `INSERT INTO categories (name, slug, parent_id, description, icon, accent, sort_order, is_active, show_in_menu)
     VALUES (?,?,?,?,?,?,?,1,1)`
  );
  const catTx = db.transaction(() => {
    DATA.CATEGORIES.forEach((parent, i) => {
      const info = insCat.run(parent.name, parent.slug, null,
        `Shop ${parent.name.toLowerCase()} on Biahens Enterprise with fast delivery across Ghana.`,
        parent.icon || '🛍', parent.accent || '#0F2A43', i + 1);
      ids.categories[parent.slug] = info.lastInsertRowid;
      (parent.children || []).forEach((child, j) => {
        const cinfo = insCat.run(child.name, child.slug, info.lastInsertRowid,
          `Browse ${child.name} — quality checked, warrantied and delivered by Biahens Enterprise.`,
          null, parent.accent || '#0F2A43', j + 1);
        ids.categories[child.slug] = cinfo.lastInsertRowid;
      });
    });
  });
  catTx();
  console.log(`✓  categories: ${Object.keys(ids.categories).length}`);

  /* ---------------------------------------------------------------- brands */
  ids.brands = {};
  const insBrand = db.prepare('INSERT INTO brands (name, slug, tagline, sort_order) VALUES (?,?,?,?)');
  DATA.BRANDS.forEach((b, i) => {
    ids.brands[b.name] = insBrand.run(b.name, slugify(b.name), b.tagline || null, i + 1).lastInsertRowid;
  });
  console.log(`✓  brands: ${Object.keys(ids.brands).length}`);

  /* -------------------------------------------------------------- products */
  ids.products = [];
  const productByCat = {};
  const prodTx = db.transaction(() => {
    DATA.PRODUCTS.forEach((p, i) => {
      const catId = ids.categories[p.cat];
      if (!catId) { console.warn(`  ! unknown category "${p.cat}" for ${p.name}`); return; }
      const brandId = ids.brands[p.brand] || null;
      const id = catalog.saveProduct({
        name: p.name,
        slug: slugify(p.name),
        sku: `BX-${String(i + 1001).padStart(5, '0')}`,
        short_description: p.short || null,
        description: p.desc || null,
        category_id: catId,
        brand_id: brandId,
        price: p.price,
        compare_at_price: p.compare || null,
        cost_price: p.cost ? p.cost : round2(p.price * (0.62 + rnd() * 0.15)),
        stock: p.stock,
        low_stock_at: Math.max(3, Math.round(p.stock * 0.2)),
        weight_kg: p.weight || 0.5,
        image: null,
        images: [],
        options: p.var ? p.var.map((v) => ({ name: v.title.split('/')[0].trim(), values: [v.title] })) : [],
        tags: p.tags || '',
        is_active: 1,
        is_featured: p.featured ? 1 : 0,
        status: 'active',
        published_at: new Date(Date.now() - between(2, 240) * 86400000).toISOString(),
      });
      if (p.var && p.var.length) {
        catalog.saveVariants(id, p.var.map((v, vi) => ({
          title: v.title,
          sku: `BX-${String(i + 1001).padStart(5, '0')}-V${vi + 1}`,
          price_delta: v.delta || 0,
          stock: v.stock,
          is_active: true,
        })));
        db.prepare('UPDATE products SET stock = ? WHERE id = ?')
          .run(p.var.reduce((s, v) => s + v.stock, 0), id);
      }
      ids.products.push(id);
      (productByCat[p.cat] = productByCat[p.cat] || []).push(id);
    });
  });
  prodTx();
  console.log(`✓  products: ${ids.products.length}`);

  /* ----------------------------------------------------------------- users */
  const hash = (pw) => bcrypt.hashSync(pw, 10);
  ids.users = [];
  const insUser = db.prepare(
    `INSERT INTO users (name, email, phone, password_hash, role, is_blocked, email_verified, created_at, last_login_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const insAddr = db.prepare(
    `INSERT INTO addresses (user_id, label, receiver, phone, region, city, line, is_default)
     VALUES (?,?,?,?,?,?,?,1)`
  );

  // The owner — the only account allowed to upload products
  const ownerId = insUser.run(config.owner.name, config.owner.email, config.owner.phone,
    hash(config.owner.password), 'owner', 0, 1,
    new Date(Date.now() - 400 * 86400000).toISOString(), new Date().toISOString()).lastInsertRowid;
  console.log(`✓  owner account: ${config.owner.email} / ${config.owner.password}`);

  // Optional staff (can manage orders/customers, NOT products or settings)
  const staffId = insUser.run('Aba Support', 'staff@biahensenterprise.com', '+233 20 111 2233',
    hash('Staff@2026'), 'staff', 0, 1,
    new Date(Date.now() - 200 * 86400000).toISOString(), new Date(Date.now() - 86400000).toISOString()).lastInsertRowid;

  for (let i = 0; i < 26; i += 1) {
    const first = pick(GH_FIRST);
    const last = pick(GH_LAST);
    const name = `${first} ${last}`;
    const email = `${slugify(name).replace(/-/g, '.')}${between(1, 999)}@${pick(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com'])}`;
    const region = pick(Object.keys(CITIES));
    const city = pick(CITIES[region]);
    const phone = `+233 ${pick(['24', '20', '54', '55', '27', '59', '26', '50'])} ${between(100, 999)} ${between(1000, 9999)}`;
    const uid = insUser.run(name, email, phone, hash('Customer@2026'), 'customer',
      chance(0.04) ? 1 : 0, chance(0.7) ? 1 : 0,
      new Date(Date.now() - between(3, 300) * 86400000).toISOString(),
      new Date(Date.now() - between(0, 20) * 86400000).toISOString()).lastInsertRowid;
    insAddr.run(uid, chance(0.3) ? 'Work' : 'Home', name, phone, region, city,
      `${pick(['Hse No.', 'Block', 'Plot'])} ${between(1, 90)}, ${pick(['Osu Road', 'Ring Road', 'Market Street', 'Spintex Road', 'Ahodwo Road', 'Cape Coast Road'])}`);
    ids.users.push(uid);
  }
  console.log(`✓  customers: ${ids.users.length} (+ 1 staff)`);

  /* --------------------------------------------------------------- reviews */
  const REVIEW_TEXT = [
    { r: 5, t: 'Exactly as described', b: 'Delivered to East Legon in less than 24 hours and the packaging was solid. Item works perfectly — I would order from Biahens again.' },
    { r: 5, t: 'Great value for the price', b: 'I compared prices all over Accra and this was the best deal. Customer care even called to confirm my address before dispatch.' },
    { r: 4, t: 'Good, minor delay', b: 'Quality is genuinely good. Delivery took two days instead of one because of rain, but the rider kept me updated the whole time.' },
    { r: 5, t: 'Authentic product', b: 'Was worried about fakes but I verified the serial with the manufacturer. 100% original with the full warranty card.' },
    { r: 4, t: 'Solid purchase', b: 'Does everything I need. Packaging could be neater but the product itself is fine and the price was fair.' },
    { r: 3, t: 'It works but check the specs', b: 'Not bad for the price, though I expected slightly better build quality. Support offered a return but I decided to keep it.' },
    { r: 5, t: 'MoMo payment was smooth', b: 'Paid with MTN MoMo, got the confirmation instantly and the order shipped the same afternoon. Very impressed.' },
    { r: 2, t: 'Late delivery', b: 'The item is fine but delivery to Kumasi took five days instead of the promised two. Support did refund the shipping fee.' },
    { r: 5, t: 'Bought a second one', b: 'My first one lasted over a year of daily use so I bought this as a gift for my sister. Highly recommended.' },
    { r: 4, t: 'Nice finish', b: 'Looks more expensive than it is. Arrived well wrapped with no scratches at all.' },
    { r: 5, t: 'Best online store in Ghana', b: 'Third order from Biahens Enterprise. Prices are honest, items are original and returns are straightforward.' },
    { r: 3, t: 'Average', b: 'It does the job. Nothing special but nothing wrong either. Delivery was on time.' },
  ];
  let reviewCount = 0;
  const insReview = db.prepare(
    `INSERT INTO reviews (product_id, user_id, author, rating, title, body, is_approved, helpful_count, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  const reviewTx = db.transaction(() => {
    ids.products.forEach((pid) => {
      const n = between(0, 7);
      for (let i = 0; i < n; i += 1) {
        const tpl = pick(REVIEW_TEXT);
        const u = db.prepare('SELECT name FROM users WHERE id = ?').get(pick(ids.users));
        const approved = chance(0.85) ? 1 : 0;
        insReview.run(pid, null, u ? u.name : 'Verified Buyer', tpl.r, tpl.t, tpl.b, approved,
          between(0, 24), new Date(Date.now() - between(1, 180) * 86400000).toISOString());
        reviewCount += 1;
      }
      catalog.recomputeRating(pid);
    });
  });
  reviewTx();
  console.log(`✓  reviews: ${reviewCount}`);

  /* --------------------------------------------------------------- coupons */
  const insCoupon = db.prepare(
    `INSERT INTO coupons (code, description, type, value, max_discount, min_subtotal, usage_limit,
       used_count, expires_at, scope, scope_id, is_active)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  DATA.COUPONS.forEach((c) => {
    let scopeId = null;
    if (c.scope !== 'all' && c.scope_slug) scopeId = ids.categories[c.scope_slug] || null;
    insCoupon.run(c.code, c.description, c.type, c.value, c.max_discount || null, c.min_subtotal || 0,
      c.usage_limit || null, between(0, 20),
      c.expires_in_days ? new Date(Date.now() + c.expires_in_days * 86400000).toISOString()
        : new Date(Date.now() + between(45, 220) * 86400000).toISOString(),
      c.scope, scopeId, c.expires_in_days && c.expires_in_days < 0 ? 1 : 1);
  });
  console.log(`✓  coupons: ${DATA.COUPONS.length}`);

  /* -------------------------------------------------------- shipping zones */
  const insZone = db.prepare(
    'INSERT INTO shipping_rates (region, fee, eta_days, sort_order) VALUES (?,?,?,?)'
  );
  DATA.SHIPPING_ZONES.forEach((z) => insZone.run(z.region, z.fee, z.eta_days, z.sort_order));
  console.log(`✓  shipping zones: ${DATA.SHIPPING_ZONES.length}`);

  /* -------------------------------------------------------------- slides */
  const insSlide = db.prepare(
    `INSERT INTO slides (title, subtitle, badge, bg, link_text, link_url, sort_order, is_active)
     VALUES (?,?,?,?,?,?,?,1)`
  );
  DATA.SLIDES.forEach((s, i) => insSlide.run(s.title, s.subtitle, s.badge, s.bg, s.link_text, s.link_url, i + 1));
  console.log(`✓  homepage slides: ${DATA.SLIDES.length}`);

  /* ---------------------------------------------------------------- orders */
  const STATUSES = [
    ['delivered', 'paid', 34], ['processing', 'paid', 9], ['paid', 'paid', 7],
    ['shipped', 'paid', 7], ['pending_payment', 'unpaid', 8],
    ['cancelled', 'unpaid', 3], ['refunded', 'refunded', 2],
  ];
  const METHODS = [['card', 46], ['momo', 34], ['cod', 20]];
  /** weighted([[value, weight], ...]) -> value */
  function weighted(list) {
    const total = list.reduce((s, x) => s + x[1], 0);
    let r = rnd() * total;
    for (const [value, w] of list) {
      r -= w;
      if (r <= 0) return value;
    }
    return list[0][0];
  }

  const insOrder = db.prepare(
    `INSERT INTO orders (order_number, user_id, guest_name, guest_email, status, payment_status,
      payment_method, subtotal, discount, shipping_fee, tax, total, currency, coupon_id, coupon_code,
      ship_name, ship_phone, ship_email, ship_region, ship_city, ship_line, ship_landmark,
      delivery_method, delivery_note, tracking_number, carrier, admin_notes, placed_at, updated_at)
     VALUES (@order_number,@user_id,@guest_name,@guest_email,@status,@payment_status,@payment_method,
      @subtotal,@discount,@shipping_fee,@tax,@total,@currency,@coupon_id,@coupon_code,
      @ship_name,@ship_phone,@ship_email,@ship_region,@ship_city,@ship_line,@ship_landmark,
      @delivery_method,@delivery_note,@tracking_number,@carrier,@admin_notes,@placed_at,@updated_at)`
  );
  const insItem = db.prepare(
    `INSERT INTO order_items (order_id, product_id, variant_id, name, slug, sku, image,
      variant_title, price, qty, total) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insEvent = db.prepare(
    'INSERT INTO order_events (order_id, status, note, actor, created_at) VALUES (?,?,?,?,?)'
  );
  const insPayment = db.prepare(
    `INSERT INTO payments (order_id, reference, gateway, method, status, amount, currency, channel,
      payer, last4, gateway_ref, paid_at, created_at, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  let seq = 1;
  let orderCount = 0;
  const orderTx = db.transaction(() => {
    for (let d = 78; d >= 0; d -= 1) {
      const perDay = d > 45 ? between(0, 1) : d > 20 ? between(0, 2) : between(1, 3);
      for (let k = 0; k < perDay; k += 1) {
        const placed = new Date(Date.now() - d * 86400000 - between(0, 20) * 3600000);
        const statusName = weighted(STATUSES.map((s) => [s[0], s[2]]));
        const statusIdx = Math.max(0, STATUSES.findIndex((s) => s[0] === statusName));
        const status = STATUSES[statusIdx][0];
        const payStatus = STATUSES[statusIdx][1];
        const payMethod = weighted(METHODS);

        const isGuest = chance(0.18);
        const uid = isGuest ? null : pick(ids.users);
        const cust = uid ? db.prepare('SELECT * FROM users WHERE id = ?').get(uid) : null;
        const addr = uid ? db.prepare('SELECT * FROM addresses WHERE user_id = ? LIMIT 1').get(uid) : null;
        const region = addr ? addr.region : pick(Object.keys(CITIES));
        const city = addr ? addr.city : pick(CITIES[region]);
        const shipName = cust ? cust.name : `${pick(GH_FIRST)} ${pick(GH_LAST)}`;
        const shipPhone = cust && cust.phone ? cust.phone : `+233 ${pick(['24', '20', '54', '27'])} ${between(100, 999)} ${between(1000, 9999)}`;
        const shipEmail = cust ? cust.email : `${slugify(shipName).replace(/-/g, '.')}@gmail.com`;

        const lines = between(1, 4);
        const chosen = new Set();
        let subtotal = 0;
        const items = [];
        for (let l = 0; l < lines; l += 1) {
          let pid = pick(ids.products);
          let guard = 0;
          while (chosen.has(pid) && guard < 8) { pid = pick(ids.products); guard += 1; }
          chosen.add(pid);
          const p = db.prepare('SELECT * FROM products WHERE id = ?').get(pid);
          const variants = db.prepare('SELECT * FROM variants WHERE product_id = ?').all(pid);
          const v = variants.length ? pick(variants) : null;
          const unit = round2(p.price + (v ? v.price_delta : 0));
          const qty = chance(0.78) ? 1 : between(2, 3);
          subtotal = round2(subtotal + unit * qty);
          items.push({ p, v, unit, qty });
        }

        const zone = db.prepare('SELECT * FROM shipping_rates WHERE region = ?').get(region);
        const delivery = chance(0.12) ? 'express' : chance(0.06) ? 'pickup' : 'standard';
        let shippingFee = delivery === 'pickup' ? 0
          : delivery === 'express' ? round2((zone ? zone.fee : 35) + 70)
            : (zone ? zone.fee : 35);

        let discount = 0;
        let couponId = null;
        let couponCode = null;
        const threshold = Number(settings.get('free_shipping_threshold'));
        if (delivery === 'standard' && subtotal >= threshold) shippingFee = 0;
        if (chance(0.22)) {
          const c = db.prepare(`SELECT * FROM coupons WHERE code IN ('AKWAABA','WELCOME10','FREESHIP') ORDER BY RANDOM() LIMIT 1`).get();
          if (c && subtotal >= c.min_subtotal) {
            couponId = c.id; couponCode = c.code;
            if (c.type === 'percent') discount = round2(Math.min(subtotal * c.value / 100, c.max_discount || 1e9));
            else if (c.type === 'fixed') discount = round2(Math.min(c.value, subtotal));
            else if (c.type === 'free_shipping') shippingFee = 0;
          }
        }
        const total = round2(Math.max(0, subtotal - discount + shippingFee));
        const orderNumber = `BX-${placed.getFullYear()}-${String(seq).padStart(4, '0')}${between(1000, 9999)}`;
        seq += 1;

        const info = insOrder.run({
          order_number: orderNumber,
          user_id: uid,
          guest_name: isGuest ? shipName : null,
          guest_email: isGuest ? shipEmail : null,
          status,
          payment_status: payStatus,
          payment_method: payMethod,
          subtotal, discount, shipping_fee: shippingFee, tax: 0, total,
          currency: 'GHS', coupon_id: couponId, coupon_code: couponCode,
          ship_name: shipName, ship_phone: shipPhone, ship_email: shipEmail,
          ship_region: region, ship_city: city,
          ship_line: addr ? addr.line : `${pick(['Hse No.', 'Block', 'Plot'])} ${between(1, 90)}, ${pick(['Osu Road', 'Spintex Road', 'Market Street'])}`,
          ship_landmark: chance(0.4) ? pick(['Opposite the Total filling station', 'Behind Melcom', 'Near the Goil roundabout', 'Same gate as the pharmacy', 'Beside the Presbyterian church']) : null,
          delivery_method: delivery,
          delivery_note: chance(0.2) ? pick(['Call before coming', 'Deliver after 5pm', 'Ask for Ama at the gate', 'Please use the back entrance']) : null,
          tracking_number: ['shipped', 'delivered'].includes(status) ? `GH${between(100000000, 999999999)}BX` : null,
          carrier: ['shipped', 'delivered'].includes(status) ? pick(['Biahens Logistics', 'VIP Parcel', 'Ghana Post EMS', 'CityRider']) : null,
          admin_notes: chance(0.12) ? pick(['Repeat customer — prioritise dispatch', 'Requested a receipt for company expense', 'Gift wrap requested']) : null,
          placed_at: placed.toISOString(),
          updated_at: new Date(placed.getTime() + between(1, 72) * 3600000).toISOString(),
        });
        const orderId = info.lastInsertRowid;

        items.forEach(({ p, v, unit, qty }) => {
          insItem.run(orderId, p.id, v ? v.id : null, p.name, p.slug,
            (v && v.sku) || p.sku || null, p.image || null, v ? v.title : null, unit, qty, round2(unit * qty));
        });

        // timeline
        const flow = { pending_payment: ['pending_payment'], paid: ['pending_payment', 'paid'],
          processing: ['pending_payment', 'paid', 'processing'],
          shipped: ['pending_payment', 'paid', 'processing', 'shipped'],
          delivered: ['pending_payment', 'paid', 'processing', 'shipped', 'delivered'],
          cancelled: ['pending_payment', 'cancelled'], refunded: ['pending_payment', 'paid', 'processing', 'refunded'] };
        (flow[status] || ['pending_payment']).forEach((s, idx) => {
          insEvent.run(orderId, s, idx === 0 ? 'Order placed by customer.' : null,
            idx === 0 ? 'customer' : s === 'paid' ? 'gateway' : 'admin',
            new Date(placed.getTime() + idx * between(2, 18) * 3600000).toISOString());
        });

        if (payStatus === 'paid' || status === 'refunded') {
          const paidAt = new Date(placed.getTime() + between(5, 900) * 60000);
          insPayment.run(orderId, `bxp_${placed.getTime().toString(36)}${between(1000, 9999)}`,
            'biahens-stub', payMethod, status === 'refunded' ? 'refunded' : 'success',
            total, 'GHS', payMethod === 'momo' ? 'mobile_money' : payMethod === 'cod' ? 'cod' : 'card',
            payMethod === 'momo' ? `${pick(['MTN', 'TELECEL', 'AT'])} ${shipPhone}` : payMethod === 'cod' ? 'Cash on delivery' : `${pick(['Visa', 'Mastercard', 'Verve'])} •••• ${between(1000, 9999)}`,
            payMethod === 'card' ? String(between(1000, 9999)) : null,
            `ch_${between(100000, 999999)}`, paidAt.toISOString(), placed.toISOString(), '{}');
          db.prepare(`UPDATE orders SET payment_status = ? WHERE id = ?`).run(status === 'refunded' ? 'refunded' : 'paid', orderId);
          if (status === 'delivered') {
            db.prepare('UPDATE products SET sold_count = sold_count + ? WHERE id = ?')
              .run(items.reduce((s, i) => s + i.qty, 0), items[0].p.id);
          }
        } else {
          insPayment.run(orderId, `bxp_${placed.getTime().toString(36)}${between(1000, 9999)}`,
            'biahens-stub', payMethod, status === 'cancelled' ? 'abandoned' : 'initiated',
            total, 'GHS', payMethod === 'momo' ? 'mobile_money' : payMethod === 'cod' ? 'cod' : 'card',
            null, null, null, null, placed.toISOString(), '{}');
        }
        orderCount += 1;
      }
    }
  });
  orderTx();
  console.log(`✓  orders: ${orderCount}`);

  /* ---------------------------------------------------- wishlist + newsletter */
  const insWish = db.prepare('INSERT OR IGNORE INTO wishlists (user_id, product_id) VALUES (?,?)');
  ids.users.forEach((u) => {
    const n = between(0, 5);
    for (let i = 0; i < n; i += 1) insWish.run(u, pick(ids.products));
  });
  const insNews = db.prepare('INSERT OR IGNORE INTO newsletter (email) VALUES (?)');
  for (let i = 0; i < 45; i += 1) {
    insNews.run(`${slugify(`${pick(GH_FIRST)} ${pick(GH_LAST)}`).replace(/-/g, '.')}${between(1, 99)}@gmail.com`);
  }

  /* ---------------------------------------------------- notifications + log */
  const insNote = db.prepare('INSERT INTO notifications (type, level, title, body, link, is_read, created_at) VALUES (?,?,?,?,?,?,?)');
  const lowStock = catalog.lowStockProducts(6);
  lowStock.forEach((p) => insNote.run('stock', p.stock === 0 ? 'danger' : 'warn',
    p.stock === 0 ? `Out of stock: ${p.name}` : `Low stock: ${p.name}`,
    `Only ${p.stock} unit(s) left. Reorder from your supplier.`, `/admin/products/${p.id}/edit`, chance(0.4) ? 1 : 0,
    new Date(Date.now() - between(1, 72) * 3600000).toISOString()));
  const pendingOrders = db.prepare(`SELECT * FROM orders WHERE status='pending_payment' ORDER BY placed_at DESC LIMIT 3`).all();
  pendingOrders.forEach((o) => insNote.run('order', 'info', `Awaiting payment — ${o.order_number}`,
    `GH₵${o.total.toFixed(2)} via ${o.payment_method.toUpperCase()}.`, `/admin/orders/${o.id}`, 0, o.placed_at));
  const unmoderated = db.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE is_approved = 0`).get().n;
  if (unmoderated) insNote.run('review', 'info', `${unmoderated} review(s) waiting for approval`,
    'Moderate them to keep your product ratings trustworthy.', '/admin/reviews', 0, new Date().toISOString());

  const insAudit = db.prepare(
    `INSERT INTO audit_log (actor_id, actor_name, actor_role, action, entity, entity_id, meta, ip, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  [
    ['owner.login', null, null, 3],
    ['product.create', 'product', String(ids.products[0]), 30],
    ['product.update', 'product', String(ids.products[3]), 18],
    ['order.status.shipped', 'order', '12', 9],
    ['settings.update', 'settings', null, 6],
    ['coupon.create', 'coupon', '1', 24],
    ['order.refund', 'order', '8', 40],
  ].forEach(([action, entity, entityId, hrs]) => {
    insAudit.run(ownerId, config.owner.name, 'owner', action, entity, entityId,
      JSON.stringify({ seeded: true }), '127.0.0.1', new Date(Date.now() - hrs * 3600000).toISOString());
  });

  /* -------------------------------------------------------- view counts etc */
  const upd = db.prepare('UPDATE products SET views_count = ?, sold_count = sold_count + ? WHERE id = ?');
  ids.products.forEach((pid) => upd.run(between(40, 4200), between(0, 26), pid));

  console.log(`\n🎉 Seed complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`   Products : ${ids.products.length}`);
  console.log(`   Customers: ${ids.users.length}`);
  console.log(`   Orders   : ${orderCount}`);
  console.log(`   Reviews  : ${reviewCount}`);
  console.log(`\n   Owner login  → ${config.owner.email}  /  ${config.owner.password}`);
  console.log(`   Staff login  → staff@biahensenterprise.com  /  Staff@2026`);
  console.log(`   Demo shopper → any seeded customer email   /  Customer@2026\n`);
}

if (require.main === module) {
  main();
  process.exit(0);
}

module.exports = { main };
