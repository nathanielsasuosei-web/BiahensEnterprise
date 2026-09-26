'use strict';
const config = require('../config');

const CURRENCY = config.catalog.currency;
const SYMBOL = config.catalog.currencySymbol;

/** 1299.5 -> "GH₵ 1,299.50" */
function money(value, opts = {}) {
  const n = Number(value || 0);
  const symbol = opts.symbol === false ? '' : SYMBOL;
  const str = n.toLocaleString('en-GH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${symbol}${opts.symbol === false ? '' : ' '}${str}`.trim();
}

/** Compact money for tight UI spots: "GH₵1.3k" */
function moneyShort(value) {
  const n = Number(value || 0);
  if (n >= 1000000) return `${SYMBOL}${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${SYMBOL}${(n / 1000).toFixed(1)}k`;
  return `${SYMBOL}${n.toFixed(0)}`;
}

function toNumber(v, fallback = 0) {
  const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function discountPercent(price, compareAt) {
  if (!compareAt || compareAt <= price) return 0;
  return Math.round(((compareAt - price) / compareAt) * 100);
}

function truncate(str, len = 120) {
  const s = String(str || '');
  return s.length > len ? `${s.slice(0, len - 1).trimEnd()}…` : s;
}

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function dateFmt(iso, style = 'medium') {
  if (!iso) return '—';
  const d = new Date(String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return iso;
  const opts = {
    short: { day: '2-digit', month: 'short', year: '2-digit' },
    medium: { day: 'numeric', month: 'short', year: 'numeric' },
    long: { day: 'numeric', month: 'long', year: 'numeric' },
    time: { hour: '2-digit', minute: '2-digit' },
    full: { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' },
  }[style] || { dateStyle: 'medium' };
  return new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: 'Africa/Accra' }, opts)).format(d);
}

function timeAgo(iso) {
  if (!iso) return '—';
  const then = new Date(String(iso).replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(then)) return iso;
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  const units = [
    ['y', 31536000], ['mo', 2592000], ['w', 604800], ['d', 86400], ['h', 3600], ['m', 60],
  ];
  for (const [label, secs] of units) {
    const v = Math.floor(s / secs);
    if (v >= 1) return `${v}${label} ago`;
  }
  return 'just now';
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function parseJson(str, fallback) {
  if (str == null) return fallback;
  if (typeof str === 'object') return str;
  try { return JSON.parse(str); } catch (_) { return fallback; }
}

function paginate(total, page, perPage) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (current - 1) * perPage;
  const window = 2;
  const nums = [];
  for (let i = Math.max(1, current - window); i <= Math.min(pages, current + window); i += 1) nums.push(i);
  return { total, pages, page: current, perPage, start, limit: perPage, nums, hasPrev: current > 1, hasNext: current < pages };
}

function pick(obj, keys) {
  const out = {};
  keys.forEach((k) => { if (obj[k] !== undefined) out[k] = obj[k]; });
  return out;
}

function firstDefined(...vals) {
  return vals.find((v) => v !== undefined && v !== null && v !== '');
}

const GHANA_REGIONS = [
  'Greater Accra', 'Ashanti', 'Western', 'Western North', 'Central', 'Eastern',
  'Volta', 'Oti', 'Northern', 'Savannah', 'North East', 'Upper East',
  'Upper West', 'Bono', 'Bono East', 'Ahafo',
];

const ORDER_STATUS_FLOW = ['pending_payment', 'paid', 'processing', 'shipped', 'delivered'];

const STATUS_META = {
  pending_payment: { label: 'Pending payment', tone: 'warn' },
  paid:            { label: 'Paid', tone: 'info' },
  processing:      { label: 'Processing', tone: 'info' },
  shipped:         { label: 'Shipped', tone: 'brand' },
  delivered:       { label: 'Delivered', tone: 'success' },
  cancelled:       { label: 'Cancelled', tone: 'danger' },
  refunded:        { label: 'Refunded', tone: 'muted' },
  unpaid:          { label: 'Unpaid', tone: 'warn' },
  partially_refunded: { label: 'Partially refunded', tone: 'warn' },
};

module.exports = {
  money, moneyShort, toNumber, round2, discountPercent, truncate, slugify,
  dateFmt, timeAgo, escapeHtml, parseJson, paginate, pick, firstDefined,
  GHANA_REGIONS, ORDER_STATUS_FLOW, STATUS_META, CURRENCY, SYMBOL,
};
