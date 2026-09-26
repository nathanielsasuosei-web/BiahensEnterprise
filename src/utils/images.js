'use strict';
/**
 * Image helpers.
 *  - real uploads are optimised with sharp into 3 sizes
 *  - products without a photo get a generated SVG placeholder that is served
 *    straight to the browser (vector + text, crisp at any size)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

/*
 * sharp is a native module. It is bundled with the Vercel Node runtime, but if
 * it ever fails to load we must not take the whole store down — fall back to
 * storing the original upload un-resized.
 */
let sharp = null;
try { sharp = require('sharp'); } catch (err) {
  console.warn('[images] sharp unavailable — uploads will be stored un-optimised:', err.message);
}
const { slugify } = require('./helpers');

const DIRS = {
  products: path.join(config.uploads.dir, 'products'),
  banners: path.join(config.uploads.dir, 'banners'),
  brands: path.join(config.uploads.dir, 'brands'),
  cache: path.join(config.uploads.dir, 'cache'),
};
Object.values(DIRS).forEach((d) => fs.mkdirSync(d, { recursive: true }));

/** Colour pairs used for placeholder art. */
const PALETTES = [
  ['#0F2A43', '#1E5C7A', '#F26B21'],
  ['#12263A', '#3A5A78', '#FFB300'],
  ['#241B3A', '#513C74', '#FF7A59'],
  ['#08281F', '#14624A', '#5FD08A'],
  ['#2B1520', '#6E2B45', '#FF8FA3'],
  ['#101820', '#2E4057', '#04D9FF'],
  ['#2A1F0B', '#7A5B1E', '#FCD116'],
  ['#131F2B', '#2F5D7C', '#9BE15D'],
];

/** Simple vector silhouettes drawn on a 200x200 canvas. */
const SHAPES = {
  phone: '<rect x="72" y="34" width="56" height="132" rx="10" fill="{fg}" opacity=".92"/><rect x="79" y="48" width="42" height="100" rx="4" fill="{bg}" opacity=".85"/><circle cx="100" cy="156" r="5" fill="{bg}" opacity=".8"/><rect x="90" y="40" width="20" height="3" rx="1.5" fill="{bg}" opacity=".7"/>',
  laptop: '<rect x="34" y="52" width="132" height="84" rx="7" fill="{fg}" opacity=".92"/><rect x="43" y="61" width="114" height="66" rx="3" fill="{bg}" opacity=".85"/><path d="M22 142h156l10 18H12z" fill="{fg}" opacity=".95"/><rect x="84" y="148" width="32" height="5" rx="2.5" fill="{bg}" opacity=".7"/>',
  tv: '<rect x="22" y="42" width="156" height="98" rx="8" fill="{fg}" opacity=".93"/><rect x="31" y="51" width="138" height="80" rx="3" fill="{bg}" opacity=".85"/><rect x="88" y="140" width="24" height="14" fill="{fg}"/><rect x="62" y="154" width="76" height="8" rx="4" fill="{fg}" opacity=".9"/>',
  watch: '<rect x="78" y="26" width="44" height="34" rx="8" fill="{fg}" opacity=".8"/><rect x="78" y="140" width="44" height="34" rx="8" fill="{fg}" opacity=".8"/><rect x="62" y="56" width="76" height="88" rx="22" fill="{fg}"/><circle cx="100" cy="100" r="30" fill="{bg}" opacity=".9"/><rect x="97" y="82" width="5" height="22" rx="2.5" fill="{fg}"/><rect x="100" y="98" width="16" height="5" rx="2.5" fill="{fg}"/>',
  headphone: '<path d="M40 108a60 60 0 0 1 120 0" fill="none" stroke="{fg}" stroke-width="14" stroke-linecap="round"/><rect x="26" y="102" width="34" height="58" rx="16" fill="{fg}"/><rect x="140" y="102" width="34" height="58" rx="16" fill="{fg}"/><rect x="34" y="112" width="18" height="38" rx="9" fill="{bg}" opacity=".7"/><rect x="148" y="112" width="18" height="38" rx="9" fill="{bg}" opacity=".7"/>',
  speaker: '<rect x="56" y="28" width="88" height="144" rx="12" fill="{fg}" opacity=".94"/><circle cx="100" cy="80" r="24" fill="{bg}" opacity=".85"/><circle cx="100" cy="80" r="10" fill="{fg}" opacity=".7"/><circle cx="100" cy="136" r="16" fill="{bg}" opacity=".8"/><rect x="76" y="40" width="48" height="4" rx="2" fill="{bg}" opacity=".5"/>',
  camera: '<rect x="26" y="62" width="148" height="94" rx="12" fill="{fg}" opacity=".94"/><rect x="74" y="46" width="52" height="20" rx="6" fill="{fg}" opacity=".9"/><circle cx="100" cy="110" r="34" fill="{bg}" opacity=".9"/><circle cx="100" cy="110" r="20" fill="{fg}" opacity=".75"/><circle cx="150" cy="82" r="7" fill="{bg}" opacity=".7"/>',
  shirt: '<path d="M66 40l-32 20 14 26 12-6v80h80V80l12 6 14-26-32-20-16-8h-36z" fill="{fg}" opacity=".94"/><path d="M84 34a16 16 0 0 0 32 0" fill="none" stroke="{bg}" stroke-width="6" opacity=".8"/>',
  shoe: '<path d="M22 132c0-14 8-20 20-24l40-14 14-22c4-6 12-6 16 0l10 16 30 12c20 8 28 18 28 30 0 8-6 12-16 12H34c-8 0-12-4-12-10z" fill="{fg}" opacity=".94"/><path d="M40 128h128" stroke="{bg}" stroke-width="7" opacity=".75" stroke-linecap="round"/><path d="M74 96l14 12M92 84l14 12" stroke="{bg}" stroke-width="5" opacity=".7" stroke-linecap="round"/>',
  bag: '<rect x="44" y="66" width="112" height="100" rx="10" fill="{fg}" opacity=".94"/><path d="M74 66V52a26 26 0 0 1 52 0v14" fill="none" stroke="{fg}" stroke-width="10"/><rect x="44" y="94" width="112" height="12" fill="{bg}" opacity=".35"/><circle cx="100" cy="100" r="8" fill="{bg}" opacity=".8"/>',
  bottle: '<rect x="86" y="22" width="28" height="22" rx="5" fill="{fg}" opacity=".9"/><path d="M82 44h36c8 14 14 24 14 42v72c0 10-8 18-18 18H86c-10 0-18-8-18-18V86c0-18 6-28 14-42z" fill="{fg}" opacity=".94"/><rect x="70" y="104" width="60" height="38" rx="4" fill="{bg}" opacity=".55"/>',
  appliance: '<rect x="48" y="24" width="104" height="152" rx="10" fill="{fg}" opacity=".94"/><rect x="48" y="86" width="104" height="6" fill="{bg}" opacity=".45"/><rect x="60" y="36" width="80" height="38" rx="5" fill="{bg}" opacity=".6"/><circle cx="72" cy="106" r="8" fill="{bg}" opacity=".8"/><rect x="92" y="100" width="48" height="12" rx="6" fill="{bg}" opacity=".6"/>',
  furniture: '<rect x="28" y="76" width="144" height="52" rx="14" fill="{fg}" opacity=".94"/><rect x="40" y="42" width="120" height="42" rx="12" fill="{fg}" opacity=".8"/><rect x="34" y="126" width="16" height="34" rx="5" fill="{fg}"/><rect x="150" y="126" width="16" height="34" rx="5" fill="{fg}"/><rect x="44" y="88" width="52" height="30" rx="8" fill="{bg}" opacity=".3"/><rect x="104" y="88" width="52" height="30" rx="8" fill="{bg}" opacity=".3"/>',
  beauty: '<rect x="78" y="40" width="44" height="24" rx="6" fill="{fg}" opacity=".85"/><path d="M70 64h60v96c0 10-8 18-18 18H88c-10 0-18-8-18-18z" fill="{fg}" opacity=".94"/><rect x="80" y="96" width="40" height="48" rx="4" fill="{bg}" opacity=".5"/>',
  grocery: '<path d="M46 62h108l-12 104c-1 10-9 18-19 18H77c-10 0-18-8-19-18z" fill="{fg}" opacity=".94"/><path d="M74 66c0-20 12-34 26-34s26 14 26 34" fill="none" stroke="{fg}" stroke-width="9"/><ellipse cx="100" cy="122" rx="26" ry="26" fill="{bg}" opacity=".45"/>',
  book: '<path d="M40 40h52c10 0 16 6 16 6s6-6 16-6h52v104h-52c-10 0-16 6-16 6s-6-6-16-6H40z" fill="{fg}" opacity=".94"/><path d="M108 46v104" stroke="{bg}" stroke-width="5" opacity=".7"/><path d="M54 66h34M54 86h34M54 106h26M128 66h34M128 86h34" stroke="{bg}" stroke-width="5" opacity=".45" stroke-linecap="round"/>',
  jewelry: '<circle cx="100" cy="112" r="42" fill="none" stroke="{fg}" stroke-width="14"/><path d="M100 44l22 30H78z" fill="{fg}"/><path d="M78 74h44l-22 26z" fill="{bg}" opacity=".85"/>',
  toy: '<circle cx="100" cy="96" r="52" fill="{fg}" opacity=".94"/><circle cx="82" cy="84" r="8" fill="{bg}" opacity=".85"/><circle cx="118" cy="84" r="8" fill="{bg}" opacity=".85"/><path d="M76 116a28 28 0 0 0 48 0" fill="none" stroke="{bg}" stroke-width="8" stroke-linecap="round"/>',
  tool: '<path d="M126 34l40 40-24 24-40-40zM102 82l-58 58a16 16 0 0 0 22 22l58-58z" fill="{fg}" opacity=".94"/><circle cx="52" cy="152" r="6" fill="{bg}" opacity=".8"/>',
  generic: '<rect x="42" y="52" width="116" height="96" rx="12" fill="{fg}" opacity=".94"/><path d="M42 84h116" stroke="{bg}" stroke-width="6" opacity=".4"/><rect x="58" y="98" width="50" height="10" rx="5" fill="{bg}" opacity=".55"/><rect x="58" y="118" width="34" height="10" rx="5" fill="{bg}" opacity=".4"/>',
};

const KIND_BY_CATEGORY = {
  phones: 'phone', 'phones-tablets': 'phone', mobiles: 'phone',
  electronics: 'laptop', computing: 'laptop', computers: 'laptop',
  'tv-audio': 'tv', audio: 'headphone', headphones: 'headphone',
  cameras: 'camera', photography: 'camera',
  watches: 'watch', jewelry: 'jewelry', accessories: 'bag',
  fashion: 'shirt', clothing: 'shirt', men: 'shirt', women: 'shirt',
  shoes: 'shoe', sneakers: 'shoe', footwear: 'shoe',
  bags: 'bag', luggage: 'bag',
  beauty: 'beauty', health: 'beauty', perfume: 'bottle',
  groceries: 'grocery', food: 'grocery', drinks: 'bottle',
  appliances: 'appliance', 'home-appliances': 'appliance', kitchen: 'appliance',
  furniture: 'furniture', 'home-office': 'furniture', home: 'furniture',
  books: 'book', stationery: 'book', education: 'book',
  gaming: 'toy', toys: 'toy', kids: 'toy', baby: 'toy',
  tools: 'tool', automotive: 'tool', sports: 'tool', fitness: 'tool',
};

function guessKind(text) {
  const t = String(text || '').toLowerCase();
  const direct = Object.keys(KIND_BY_CATEGORY).find((k) => t.includes(k));
  if (direct) return KIND_BY_CATEGORY[direct];
  const words = [
    ['phone', 'phone'], ['iphone', 'phone'], ['samsung', 'phone'], ['tablet', 'phone'], ['mobile', 'phone'],
    ['laptop', 'laptop'], ['macbook', 'laptop'], ['desktop', 'laptop'], ['computer', 'laptop'], ['monitor', 'tv'],
    ['tv', 'tv'], ['television', 'tv'], ['screen', 'tv'],
    ['headphone', 'headphone'], ['earbud', 'headphone'], ['airpod', 'headphone'], ['earphone', 'headphone'],
    ['speaker', 'speaker'], ['soundbar', 'speaker'], ['subwoofer', 'speaker'],
    ['watch', 'watch'], ['smartwatch', 'watch'],
    ['camera', 'camera'], ['dslr', 'camera'], ['lens', 'camera'], ['drone', 'camera'],
    ['shirt', 'shirt'], ['dress', 'shirt'], ['tee', 'shirt'], ['hoodie', 'shirt'], ['blouse', 'shirt'],
    ['trouser', 'shirt'], ['jeans', 'shirt'], ['jacket', 'shirt'], ['suit', 'shirt'], ['kente', 'shirt'],
    ['shoe', 'shoe'], ['sneaker', 'shoe'], ['boot', 'shoe'], ['sandal', 'shoe'], ['heel', 'shoe'], ['trainer', 'shoe'],
    ['bag', 'bag'], ['backpack', 'bag'], ['handbag', 'bag'], ['luggage', 'bag'], ['wallet', 'bag'], ['purse', 'bag'],
    ['cream', 'beauty'], ['lotion', 'beauty'], ['serum', 'beauty'], ['makeup', 'beauty'], ['lipstick', 'beauty'],
    ['perfume', 'bottle'], ['cologne', 'bottle'], ['oil', 'bottle'], ['juice', 'bottle'], ['water', 'bottle'], ['wine', 'bottle'],
    ['fridge', 'appliance'], ['refrigerator', 'appliance'], ['microwave', 'appliance'], ['washer', 'appliance'],
    ['blender', 'appliance'], ['kettle', 'appliance'], ['iron', 'appliance'], ['cooker', 'appliance'], ['fan', 'appliance'],
    ['air condition', 'appliance'], ['rice cooker', 'appliance'], ['toaster', 'appliance'],
    ['sofa', 'furniture'], ['chair', 'furniture'], ['table', 'furniture'], ['bed', 'furniture'], ['mattress', 'furniture'],
    ['wardrobe', 'furniture'], ['shelf', 'furniture'], ['desk', 'furniture'], ['stool', 'furniture'],
    ['book', 'book'], ['novel', 'book'], ['notebook', 'book'], ['bible', 'book'],
    ['ring', 'jewelry'], ['necklace', 'jewelry'], ['earring', 'jewelry'], ['bracelet', 'jewelry'], ['gold', 'jewelry'],
    ['toy', 'toy'], ['lego', 'toy'], ['game', 'toy'], ['console', 'toy'], ['playstation', 'toy'], ['ball', 'toy'],
    ['drill', 'tool'], ['hammer', 'tool'], ['wrench', 'tool'], ['tool', 'tool'], ['tyre', 'tool'], ['tire', 'tool'],
    ['rice', 'grocery'], ['maize', 'grocery'], ['flour', 'grocery'], ['food', 'grocery'], ['snack', 'grocery'],
  ];
  for (const [needle, kind] of words) if (t.includes(needle)) return kind;
  return 'generic';
}

function hashInt(str, mod) {
  const h = crypto.createHash('md5').update(String(str || 'x')).digest();
  return h.readUInt32BE(0) % mod;
}

/** Wrap a long name into up to 2 SVG <tspan> lines. */
function wrapName(name, maxChars = 26) {
  const words = String(name || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  words.forEach((w) => {
    if ((line + ' ' + w).trim().length > maxChars && line) { lines.push(line.trim()); line = w; }
    else line = `${line} ${w}`.trim();
  });
  if (line) lines.push(line.trim());
  if (lines.length > 2) {
    const rest = lines.slice(1).join(' ');
    return [lines[0], rest.length > maxChars ? `${rest.slice(0, maxChars - 1)}…` : rest];
  }
  return lines;
}

/**
 * Build a branded SVG placeholder.
 * @param {{name?:string, kind?:string, hint?:string, palette?:number, w?:number, h?:number, label?:string}} o
 */
function placeholderSvg(o = {}) {
  const w = Math.max(80, Number(o.w) || 640);
  const h = Math.max(80, Number(o.h) || 640);
  const pal = PALETTES[Number.isInteger(o.palette) ? o.palette % PALETTES.length : hashInt(o.name || o.hint, PALETTES.length)];
  const [bg, mid, fg] = pal;
  const kind = o.kind && SHAPES[o.kind] ? o.kind : guessKind(`${o.hint || ''} ${o.name || ''}`);
  const art = SHAPES[kind].replace(/\{fg\}/g, '#ffffff').replace(/\{bg\}/g, bg);
  const scale = Math.min(w, h) / 200;
  const tx = (w - 200 * scale) / 2;
  const ty = (h - 200 * scale) / 2 - (o.name ? h * 0.06 : 0);
  const lines = o.name ? wrapName(o.name) : [];
  const fontSize = Math.round(Math.min(w, h) * (lines.length > 1 ? 0.055 : 0.062));
  const startY = h - Math.round(h * (lines.length > 1 ? 0.2 : 0.15));
  const id = `p${hashInt(`${kind}${bg}${w}${h}`, 99999)}`;
  const text = lines.map((l, i) =>
    `<tspan x="${w / 2}" dy="${i === 0 ? 0 : Math.round(fontSize * 1.25)}">${escapeXml(l)}</tspan>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escapeXml(o.name || 'Product image')}">
<defs>
<linearGradient id="g${id}" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${bg}"/><stop offset="0.55" stop-color="${mid}"/><stop offset="1" stop-color="${bg}"/>
</linearGradient>
<radialGradient id="r${id}" cx="0.22" cy="0.18" r="0.85">
<stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
</radialGradient>
</defs>
<rect width="${w}" height="${h}" fill="url(#g${id})"/>
<rect width="${w}" height="${h}" fill="url(#r${id})"/>
<g opacity="0.14" stroke="#ffffff" stroke-width="1.4">
${Array.from({ length: Math.round(w / 46) }, (_, i) => `<path d="M${i * 46} 0 L${i * 46 + h} ${h}"/>`).join('')}
</g>
<circle cx="${w * 0.86}" cy="${h * 0.16}" r="${Math.round(Math.min(w, h) * 0.09)}" fill="${fg}" opacity="0.85"/>
<circle cx="${w * 0.12}" cy="${h * 0.88}" r="${Math.round(Math.min(w, h) * 0.06)}" fill="${fg}" opacity="0.5"/>
<g transform="translate(${tx} ${ty}) scale(${scale})">${art}</g>
${o.name ? `<text x="${w / 2}" y="${startY}" font-family="Inter, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff" text-anchor="middle" opacity="0.96">${text}</text>` : ''}
${o.label ? `<text x="${Math.round(w * 0.06)}" y="${Math.round(h * 0.1)}" font-family="Inter, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="${Math.round(fontSize * 0.72)}" font-weight="700" fill="#0F2A43" letter-spacing="1">${escapeXml(String(o.label).toUpperCase())}</text>` : ''}
</svg>`;
}

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Optimise an uploaded image buffer and write thumb/card/large versions.
 * @returns {{url:string, card:string, thumb:string, large:string}}
 */
async function saveUpload(buffer, { folder = 'products', mime = 'image/jpeg', name = 'image' } = {}) {
  const dir = DIRS[folder] || DIRS.products;
  fs.mkdirSync(dir, { recursive: true });
  const base = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${slugify(name).slice(0, 40)}`;
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'jpg';
  const rel = path.join('uploads', path.basename(dir), `${base}.${ext}`).split(path.sep).join('/');
  const abs = path.join(dir, `${base}.${ext}`);

  const finalExt = !sharp || ext === 'gif' ? ext : 'jpg';
  const finalRel = rel.replace(/\.\w+$/, `.${finalExt}`);
  const finalAbs = abs.replace(/\.\w+$/, `.${finalExt}`);

  if (!sharp || finalExt === 'gif') {
    // No sharp (or an animated GIF): store the original bytes untouched.
    fs.writeFileSync(finalAbs, buffer);
    const rawClean = finalRel.replace(/\.\w+$/, '');
    return {
      url: `/${finalRel}`,
      large: `/${finalRel}`,
      card: `/${rawClean}.${finalExt}`,
      thumb: `/${rawClean}.${finalExt}`,
    };
  } else {
    const pipeline = sharp(buffer).rotate();
    await pipeline.clone().resize({ width: config.uploads.widths.large, withoutEnlargement: true })
      .jpeg({ quality: 88, mozjpeg: true }).toFile(finalAbs);
    await pipeline.clone().resize({ width: config.uploads.widths.card, withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true }).toFile(finalAbs.replace(/(\.\w+)$/, '-card$1'));
    await pipeline.clone().resize({ width: config.uploads.widths.thumb, height: config.uploads.widths.thumb, fit: 'cover' })
      .jpeg({ quality: 78, mozjpeg: true }).toFile(finalAbs.replace(/(\.\w+)$/, '-thumb$1'));
  }

  const clean = finalRel.replace(/\.\w+$/, '');
  return {
    url: `/${finalRel}`,
    large: `/${finalRel}`,
    card: `/${clean}-card.${finalExt}`,
    thumb: `/${clean}-thumb.${finalExt}`,
  };
}

/** Resolve any stored image value into a usable <img src>. */
function imgSrc(value, { w = 640, h = 640, hint = '', name = '', palette } = {}) {
  if (value && String(value).trim() && !String(value).startsWith('ph:')) return value;
  const q = new URLSearchParams({ w: String(w), h: String(h) });
  if (name) q.set('n', name);
  if (hint) q.set('k', hint);
  if (palette !== undefined) q.set('p', String(palette));
  return `/img/ph.svg?${q.toString()}`;
}

module.exports = { placeholderSvg, saveUpload, imgSrc, guessKind, PALETTES, SHAPES, DIRS };
