'use strict';
const db = require('../db');
const { round2 } = require('../utils/helpers');

const PAID = `o.payment_status = 'paid' AND o.status NOT IN ('cancelled','refunded')`;

function one(sql, params) { return db.prepare(sql).get(params || {}) || {}; }

function totals() {
  const revenue = one(
    `SELECT COALESCE(SUM(o.total),0) AS v, COUNT(*) AS n FROM orders o WHERE ${PAID}`
  );
  const outstanding = one(
    `SELECT COALESCE(SUM(o.total),0) AS v, COUNT(*) AS n FROM orders o
     WHERE o.payment_status = 'unpaid' AND o.status NOT IN ('cancelled','refunded')`
  );
  const products = one(`SELECT COUNT(*) AS n, COALESCE(SUM(stock),0) AS units FROM products WHERE status != 'archived'`);
  const customers = one(`SELECT COUNT(*) AS n FROM users WHERE role = 'customer'`);
  const lowStock = one(`SELECT COUNT(*) AS n FROM products WHERE status != 'archived' AND stock <= low_stock_at`);
  const outOfStock = one(`SELECT COUNT(*) AS n FROM products WHERE status='active' AND is_active=1 AND stock <= 0`);
  const pendingFulfil = one(
    `SELECT COUNT(*) AS n FROM orders WHERE status IN ('paid','processing')`
  );
  return {
    revenue: round2(revenue.v || 0),
    paidOrders: revenue.n || 0,
    outstanding: round2(outstanding.v || 0),
    outstandingOrders: outstanding.n || 0,
    products: products.n || 0,
    units: products.units || 0,
    customers: customers.n || 0,
    lowStock: lowStock.n || 0,
    outOfStock: outOfStock.n || 0,
    pendingFulfil: pendingFulfil.n || 0,
  };
}

function windowTotals(days) {
  const row = one(
    `SELECT COALESCE(SUM(o.total),0) AS revenue, COUNT(*) AS orders,
            COALESCE(SUM((SELECT SUM(qty) FROM order_items oi WHERE oi.order_id = o.id)),0) AS units
     FROM orders o WHERE ${PAID} AND date(o.placed_at) >= date('now', ?)`,
    [`-${Number(days)} days`]
  );
  return { revenue: round2(row.revenue || 0), orders: row.orders || 0, units: row.units || 0 };
}

function delta(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return round2(((current - previous) / previous) * 100);
}

function series(days = 30, metric = 'revenue') {
  const col = metric === 'orders' ? 'COUNT(*)' : 'COALESCE(SUM(o.total),0)';
  const rows = db.prepare(
    `SELECT date(o.placed_at) AS d, ${col} AS v, COUNT(*) AS n
     FROM orders o WHERE ${PAID} AND date(o.placed_at) >= date('now', @from)
     GROUP BY date(o.placed_at) ORDER BY d`
  ).all({ from: `-${Number(days) - 1} days` });
  const map = new Map(rows.map((r) => [r.d, r]));
  const out = [];
  for (let i = Number(days) - 1; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const hit = map.get(d);
    out.push({
      date: d,
      label: new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
      value: hit ? round2(metric === 'orders' ? hit.n : hit.v) : 0,
      orders: hit ? hit.n : 0,
    });
  }
  return out;
}

function topProducts(limit = 8, days = null) {
  const filter = days ? `AND date(o.placed_at) >= date('now','-${Number(days)} days')` : '';
  return db.prepare(
    `SELECT oi.name, oi.slug, oi.image, oi.price,
            SUM(oi.qty) AS units, ROUND(SUM(oi.total),2) AS revenue,
            p.id AS product_id, p.stock, p.views_count
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN products p ON p.id = oi.product_id
     WHERE ${PAID} ${filter}
     GROUP BY oi.product_id, oi.name
     ORDER BY units DESC LIMIT ?`
  ).all(limit);
}

function byCategory(limit = 8) {
  return db.prepare(
    `SELECT c.name, c.slug, c.accent, COALESCE(SUM(oi.total),0) AS revenue, SUM(oi.qty) AS units
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN products p ON p.id = oi.product_id
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE ${PAID}
     GROUP BY c.id ORDER BY revenue DESC LIMIT ?`
  ).all(limit);
}

function orderStatusBreakdown() {
  return db.prepare(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(total),0) AS value FROM orders GROUP BY status ORDER BY n DESC`
  ).all();
}

function paymentMethodBreakdown() {
  return db.prepare(
    `SELECT payment_method AS method, COUNT(*) AS n, COALESCE(SUM(total),0) AS value
     FROM orders GROUP BY payment_method ORDER BY n DESC`
  ).all();
}

function regionBreakdown(limit = 10) {
  return db.prepare(
    `SELECT ship_region AS region, COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue
     FROM orders WHERE status != 'cancelled' GROUP BY ship_region ORDER BY orders DESC LIMIT ?`
  ).all(limit);
}

function hourlyPattern() {
  return db.prepare(
    `SELECT CAST(strftime('%H', placed_at) AS INTEGER) AS h, COUNT(*) AS n
     FROM orders GROUP BY h ORDER BY h`
  ).all();
}

function recentOrders(limit = 8) {
  return db.prepare(
    `SELECT o.*, u.name AS customer_name FROM orders o LEFT JOIN users u ON u.id = o.user_id
     ORDER BY o.placed_at DESC LIMIT ?`
  ).all(limit);
}

function recentCustomers(limit = 6) {
  return db.prepare(
    `SELECT u.*, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders,
            (SELECT COALESCE(SUM(o.total),0) FROM orders o WHERE o.user_id = u.id AND ${PAID.replace(/o\./g, 'o.')}) AS spent
     FROM users u WHERE u.role = 'customer' ORDER BY u.created_at DESC LIMIT ?`
  ).all(limit).map((r) => ({ ...r, spent: round2(r.spent || 0) }));
}

function customerGrowth(days = 30) {
  const rows = db.prepare(
    `SELECT date(created_at) AS d, COUNT(*) AS n FROM users WHERE role='customer'
     AND date(created_at) >= date('now', @from) GROUP BY date(created_at)`
  ).all({ from: `-${days} days` });
  const map = new Map(rows.map((r) => [r.d, r.n]));
  const out = [];
  let running = one(`SELECT COUNT(*) AS n FROM users WHERE role='customer' AND date(created_at) < date('now', @from)`, { from: `-${days} days` }).n || 0;
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    running += map.get(d) || 0;
    out.push({ date: d, label: new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }), value: running, added: map.get(d) || 0 });
  }
  return out;
}

function aov() {
  const r = one(`SELECT COALESCE(AVG(o.total),0) AS v FROM orders o WHERE ${PAID}`);
  return round2(r.v || 0);
}

function dashboard() {
  const t = totals();
  const today = windowTotals(0);
  const w7 = windowTotals(7);
  const p7 = (() => {
    const r = one(
      `SELECT COALESCE(SUM(o.total),0) AS revenue, COUNT(*) AS orders FROM orders o
       WHERE ${PAID} AND date(o.placed_at) >= date('now','-14 days') AND date(o.placed_at) < date('now','-7 days')`
    );
    return { revenue: round2(r.revenue || 0), orders: r.orders || 0 };
  })();
  const w30 = windowTotals(30);

  return {
    totals: t,
    kpis: {
      revenueToday: today.revenue,
      ordersToday: today.orders,
      revenue7: w7.revenue,
      revenue7Delta: delta(w7.revenue, p7.revenue),
      orders7: w7.orders,
      orders7Delta: delta(w7.orders, p7.orders),
      revenue30: w30.revenue,
      units30: w30.units,
      aov: aov(),
    },
    chart: series(30, 'revenue'),
    chartOrders: series(14, 'orders'),
    topProducts: topProducts(6),
    byCategory: byCategory(6),
    statuses: orderStatusBreakdown(),
    payments: paymentMethodBreakdown(),
    regions: regionBreakdown(6),
    recentOrders: recentOrders(8),
    recentCustomers: recentCustomers(5),
    growth: customerGrowth(30),
  };
}

module.exports = {
  totals, windowTotals, series, topProducts, byCategory, orderStatusBreakdown,
  paymentMethodBreakdown, regionBreakdown, hourlyPattern, recentOrders,
  recentCustomers, customerGrowth, aov, delta, dashboard,
};
