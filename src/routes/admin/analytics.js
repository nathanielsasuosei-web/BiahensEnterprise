'use strict';
const express = require('express');
const db = require('../../db');
const stats = require('../../services/stats');
const { audit } = require('../../utils/log');
const { round2, dateFmt } = require('../../utils/helpers');

const router = express.Router();
const PAID = `payment_status = 'paid' AND status NOT IN ('cancelled','refunded')`;

router.get('/', (req, res) => {
  const days = [7, 14, 30, 60, 90, 180, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const metric = req.query.metric === 'orders' ? 'orders' : 'revenue';

  const series = stats.series(days, metric);
  const current = series.reduce((s, d) => s + (metric === 'orders' ? d.orders : d.value), 0);
  const prevSeries = (() => {
    const rows = db.prepare(
      `SELECT COALESCE(SUM(total),0) AS v, COUNT(*) AS n FROM orders
       WHERE ${PAID} AND date(placed_at) >= date('now', @from) AND date(placed_at) < date('now', @to)`
    ).get({ from: `-${days * 2} days`, to: `-${days} days` });
    return metric === 'orders' ? rows.n : round2(rows.v);
  })();

  res.render('admin/analytics', {
    layout: false,
    pageTitle: 'Analytics & Reports | Admin',
    bodyClass: 'admin admin-analytics',
    adminNav: 'analytics',
    days,
    metric,
    series,
    current: round2(current),
    previous: round2(prevSeries),
    change: stats.delta(current, prevSeries),
    topProducts: stats.topProducts(15, days),
    byCategory: stats.byCategory(12),
    statuses: stats.orderStatusBreakdown(),
    payments: stats.paymentMethodBreakdown(),
    regions: stats.regionBreakdown(16),
    hourly: (() => {
      const rows = stats.hourlyPattern();
      const map = new Map(rows.map((r) => [r.h, r.n]));
      return Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: map.get(h) || 0 }));
    })(),
    growth: stats.customerGrowth(Math.min(days, 90)),
    aov: stats.aov(),
    totals: stats.totals(),
    bestDay: series.reduce((best, d) => ((metric === 'orders' ? d.orders : d.value) > (metric === 'orders' ? best.orders : best.value) ? d : best), series[0] || { value: 0, orders: 0, date: '—' }),
    weekdays: (() => {
      const rows = db.prepare(
        `SELECT CAST(strftime('%w', placed_at) AS INTEGER) AS w, COUNT(*) AS n, COALESCE(SUM(total),0) AS revenue
         FROM orders WHERE ${PAID} GROUP BY w ORDER BY w`
      ).all();
      const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const map = new Map(rows.map((r) => [r.w, r]));
      return names.map((name, i) => ({
        name, orders: map.has(i) ? map.get(i).n : 0, revenue: map.has(i) ? round2(map.get(i).revenue) : 0,
      }));
    })(),
    categorySales: db.prepare(
      `SELECT c.name, COUNT(DISTINCT p.id) AS products, COALESCE(SUM(p.sold_count),0) AS units,
              COALESCE(AVG(p.rating_avg),0) AS rating, COALESCE(SUM(p.stock),0) AS stock
       FROM categories c LEFT JOIN products p ON p.category_id = c.id
       WHERE c.parent_id IS NOT NULL GROUP BY c.id ORDER BY units DESC LIMIT 20`
    ).all().map((r) => ({ ...r, rating: round2(r.rating) })),
    dateFmt,
  });
});

router.get('/export.csv', (req, res) => {
  const days = Number(req.query.days) || 30;
  const series = stats.series(days, 'revenue');
  const csv = ['date,revenue,orders'].concat(series.map((d) => `${d.date},${d.value},${d.orders}`)).join('\n');
  audit(req, 'analytics.export', 'analytics', null, { days });
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="biahens-revenue-${days}d.csv"`);
  return res.send(csv);
});

router.get('/products.csv', (req, res) => {
  const rows = stats.topProducts(500);
  const headers = ['name', 'units', 'revenue', 'stock', 'views_count'];
  const csv = [headers.join(',')].concat(rows.map((r) => headers.map((h) => {
    const v = r[h] == null ? '' : String(r[h]).replace(/,/g, ' ');
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(','))).join('\n');
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="biahens-top-products.csv"');
  return res.send(csv);
});

module.exports = router;
