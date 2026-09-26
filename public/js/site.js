/* ============================================================================
   BIAHENS ENTERPRISE — storefront behaviour
   No dependencies. Everything degrades gracefully without JS.
   ========================================================================== */
(function () {
  'use strict';
  const CFG = window.BIAHENS || {};
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const on = (el, ev, fn, opt) => el && el.addEventListener(ev, fn, opt);
  const money = (n) => `${CFG.currency || 'GH₵'} ${Number(n || 0).toFixed(2)}`;

  async function api(url, opts = {}) {
    const res = await fetch(url, Object.assign({
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      credentials: 'same-origin',
    }, opts.body ? { body: JSON.stringify(opts.body) } : {}));
    const data = await res.json().catch(() => ({ ok: false, message: 'Unexpected response.' }));
    if (!res.ok) throw Object.assign(new Error(data.message || `Request failed (${res.status})`), { data, status: res.status });
    return data;
  }

  /* ---------------------------------------------------------------- flash */
  function toast(message, type) {
    let stack = $('#flashStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'flash-stack';
      stack.id = 'flashStack';
      document.body.appendChild(stack);
    }
    const el = document.createElement('div');
    el.className = `flash ${type || 'info'}`;
    el.innerHTML = `<span>${type === 'success' ? '&#10003;' : type === 'danger' ? '&#9888;' : '&#8505;'}</span>
      <span class="grow"></span><button class="x" type="button" aria-label="Dismiss">&times;</button>`;
    el.querySelector('.grow').textContent = message;
    stack.appendChild(el);
    on(el.querySelector('.x'), 'click', () => el.remove());
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; setTimeout(() => el.remove(), 260); }, 4200);
  }
  $$('.flash .x').forEach((b) => on(b, 'click', () => b.closest('.flash').remove()));
  setTimeout(() => $$('#flashStack .flash').forEach((f) => { f.style.transition = 'opacity .3s'; f.style.opacity = '0'; setTimeout(() => f.remove(), 320); }), 6000);

  /* ------------------------------------------------------- header: drawer */
  const drawer = $('#drawer');
  function setDrawer(open) {
    if (!drawer) return;
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    document.body.style.overflow = open ? 'hidden' : '';
    const btn = $('#burgerBtn');
    if (btn) btn.setAttribute('aria-expanded', String(open));
  }
  on($('#burgerBtn'), 'click', () => setDrawer(!drawer.classList.contains('open')));
  $$('[data-drawer-close]').forEach((el) => on(el, 'click', () => setDrawer(false)));
  on(document, 'keydown', (e) => { if (e.key === 'Escape') { setDrawer(false); closeMega(); closeQV(); } });

  /* ------------------------------------------------------- header: mega */
  const mega = $('#megaMenu');
  const megaBtn = $('#megaBtn');
  function openMega() {
    if (!mega) return;
    mega.classList.add('open');
    if (megaBtn) megaBtn.setAttribute('aria-expanded', 'true');
  }
  function closeMega() {
    if (!mega) return;
    mega.classList.remove('open');
    if (megaBtn) megaBtn.setAttribute('aria-expanded', 'false');
  }
  on(megaBtn, 'click', (e) => { e.stopPropagation(); mega.classList.contains('open') ? closeMega() : openMega(); });
  on(document, 'click', (e) => { if (mega && mega.classList.contains('open') && !mega.contains(e.target) && e.target !== megaBtn) closeMega(); });
  // hover-open on pointer devices
  const navBar = $('.hdr-nav');
  if (navBar && window.matchMedia('(hover:hover) and (min-width: 861px)').matches) {
    navBar.addEventListener('mouseenter', openMega);
    navBar.addEventListener('mouseleave', closeMega);
  }

  /* ------------------------------------------------- header: dropdowns */
  $$('.dd > button').forEach((btn) => {
    on(btn, 'click', (e) => {
      e.stopPropagation();
      const dd = btn.closest('.dd');
      const isOpen = dd.classList.contains('open');
      $$('.dd.open').forEach((d) => d.classList.remove('open'));
      dd.classList.toggle('open', !isOpen);
      btn.setAttribute('aria-expanded', String(!isOpen));
    });
  });
  on(document, 'click', () => $$('.dd.open').forEach((d) => { d.classList.remove('open'); const b = d.querySelector('button'); if (b) b.setAttribute('aria-expanded', 'false'); }));
  $$('.dd-panel').forEach((p) => on(p, 'click', (e) => e.stopPropagation()));

  /* ---------------------------------------------- search autocomplete */
  const input = $('#searchInput');
  const box = $('#suggestBox');
  let sTimer = null;
  let sIndex = -1;
  let sItems = [];

  function renderSuggest(data) {
    if (!box) return;
    const parts = [];
    if (data.categories && data.categories.length) {
      parts.push('<div class="suggest-sec">Categories</div>');
      data.categories.forEach((c) => parts.push(`<a class="suggest-item" href="${c.url}"><span class="si-name">&#128193; ${escapeHtml(c.name)}</span></a>`));
    }
    if (data.brands && data.brands.length) {
      parts.push('<div class="suggest-sec">Brands</div>');
      data.brands.forEach((b) => parts.push(`<a class="suggest-item" href="${b.url}"><span class="si-name">&#127991; ${escapeHtml(b.name)}</span></a>`));
    }
    if (data.products && data.products.length) {
      parts.push('<div class="suggest-sec">Products</div>');
      data.products.forEach((p) => {
        parts.push(`<a class="suggest-item" href="${p.url}" data-idx="${sItems.push(p) - 1}">
          <img src="${p.image}" alt="" loading="lazy">
          <span class="grow"><span class="si-name">${escapeHtml(p.name)}</span>
          <span class="si-meta">${escapeHtml(p.category || '')}${p.in_stock ? '' : ' · out of stock'}${p.rating ? ' · ' + p.rating.toFixed(1) + '&#9733;' : ''}</span></span>
          <span class="si-price">${money(p.price)}${p.discount ? ` <span class="badge orange">-${p.discount}%</span>` : ''}</span></a>`);
      });
    }
    if (!parts.length) parts.push('<div class="suggest-empty">No matches for “' + escapeHtml(data.q) + '”. Try another word or browse <a href="/categories" style="color:#F26B21;font-weight:700">all categories</a>.</div>');
    box.innerHTML = parts.join('');
    box.classList.add('open');
    sIndex = -1;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function suggest(q) {
    if (!box) return;
    if (q.length < 2) { box.classList.remove('open'); return; }
    try {
      const data = await api(`/api/suggest?q=${encodeURIComponent(q)}`);
      sItems = [];
      renderSuggest(data);
    } catch (_) { box.classList.remove('open'); }
  }

  on(input, 'input', () => {
    clearTimeout(sTimer);
    const v = input.value.trim();
    sTimer = setTimeout(() => suggest(v), 190);
  });
  on(input, 'focus', () => { if (input.value.trim().length >= 2) suggest(input.value.trim()); });
  on(input, 'keydown', (e) => {
    if (!box || !box.classList.contains('open')) return;
    const links = $$('.suggest-item', box);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sIndex = e.key === 'ArrowDown' ? Math.min(links.length - 1, sIndex + 1) : Math.max(0, sIndex - 1);
      links.forEach((l, i) => l.classList.toggle('active', i === sIndex));
      links[sIndex] && links[sIndex].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && sIndex >= 0 && links[sIndex]) {
      e.preventDefault();
      window.location.href = links[sIndex].getAttribute('href');
    } else if (e.key === 'Escape') {
      box.classList.remove('open');
    }
  });
  on(document, 'click', (e) => { if (box && !box.contains(e.target) && e.target !== input) box.classList.remove('open'); });
  const catSelect = $('.search-cat');
  on($('#searchForm'), 'submit', (e) => {
    if (catSelect && catSelect.value) {
      e.preventDefault();
      const q = input.value.trim();
      window.location.href = `/c/${catSelect.value}${q ? `?q=${encodeURIComponent(q)}` : ''}`;
    }
  });

  /* ------------------------------------------------------------ cart sync */
  function updateCartUI(data) {
    $$('[data-cart-count]').forEach((el) => { el.textContent = data.count; el.style.display = data.count ? '' : 'none'; });
    const items = $('.minicart-items');
    if (items && data.items) {
      if (!data.items.length) {
        items.innerHTML = `<div class="mc-empty"><div style="font-size:2rem;margin-bottom:.4rem">&#128722;</div>
          <b>Your cart is empty</b><p class="small muted" style="margin:.3rem 0 .8rem">Browse our deals and add something you love.</p>
          <a class="btn primary sm" href="/deals">See today’s deals</a></div>`;
      } else {
        items.innerHTML = data.items.slice(0, 4).map((i) => `<div class="mc-item">
          <img src="${i.image}" alt="" loading="lazy">
          <div class="grow"><div class="n clamp-2"><a href="/p/${i.slug}">${escapeHtml(i.name)}</a></div>
          ${i.variant ? `<div class="v">${escapeHtml(i.variant)}</div>` : ''}
          <div class="p">${money(i.unit_price)} <span class="muted small">× ${i.qty}</span></div></div>
          <button class="rm" type="button" data-remove-item="${i.id}" aria-label="Remove">&times;</button></div>`).join('');
      }
    }
    const totalEl = $('.hdr-btn.cart .lbl small');
    if (totalEl) totalEl.textContent = money(data.total);
  }

  async function addCart(productId, variantId, qty, btn) {
    if (btn) { btn.disabled = true; btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span> Adding…'; }
    try {
      const data = await api('/api/cart/add', { method: 'POST', body: { product_id: productId, variant_id: variantId || null, qty: qty || 1 } });
      updateCartUI(data);
      toast(data.message, 'success');
      return data;
    } catch (err) {
      toast(err.message, 'danger');
      if (err.status === 401) setTimeout(() => { window.location.href = '/login'; }, 900);
      throw err;
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.label || btn.innerHTML; }
    }
  }

  on(document, 'click', async (e) => {
    const addBtn = e.target.closest('[data-add-cart]');
    if (addBtn) {
      e.preventDefault();
      const id = addBtn.getAttribute('data-add-cart');
      const hasVariants = addBtn.getAttribute('data-variants') !== '0';
      if (hasVariants) return openQuickView(addBtn.getAttribute('data-slug'));
      try { await addCart(id, null, 1, addBtn); } catch (_) {}
      return;
    }
    const rm = e.target.closest('[data-remove-item]');
    if (rm) {
      try {
        const data = await api('/api/cart/remove', { method: 'POST', body: { id: rm.getAttribute('data-remove-item') } });
        updateCartUI(data);
        toast('Removed from your cart.', 'info');
        if (window.location.pathname === '/cart') window.location.reload();
      } catch (err) { toast(err.message, 'danger'); }
    }
    const wish = e.target.closest('[data-wish]');
    if (wish) {
      e.preventDefault();
      try {
        const data = await api('/api/wishlist/toggle', { method: 'POST', body: { product_id: wish.getAttribute('data-wish') } });
        wish.classList.toggle('active', data.added);
        $$('[data-wish-count]').forEach((el) => { el.textContent = data.count; });
        toast(data.message, data.added ? 'success' : 'info');
      } catch (err) {
        toast(err.message, 'warn');
        if (err.status === 401) setTimeout(() => { window.location.href = '/login'; }, 900);
      }
    }
  });

  // mark wishlisted items once we know the ids
  (async function markWishlist() {
    if (!CFG.user) return;
    try {
      const data = await api('/api/wishlist/ids');
      const set = new Set(data.ids || []);
      $$('[data-wish]').forEach((b) => b.classList.toggle('active', set.has(Number(b.getAttribute('data-wish')))));
    } catch (_) {}
  })();

  /* ---------------------------------------------------------- quick view */
  const qvModal = $('#quickViewModal');
  const qvBody = $('#qvContent');
  let qvProduct = null;

  function closeQV() {
    if (!qvModal) return;
    qvModal.classList.remove('open');
    qvModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }
  $$('[data-qv-close]').forEach((el) => on(el, 'click', closeQV));
  on(document, 'click', (e) => {
    const t = e.target.closest('[data-quickview]');
    if (t) { e.preventDefault(); openQuickView(t.getAttribute('data-quickview')); }
  });

  async function openQuickView(slug) {
    if (!qvModal || !qvBody) { window.location.href = `/p/${slug}`; return; }
    qvModal.classList.add('open');
    qvModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    qvBody.innerHTML = '<div class="qv-media"><div class="muted">Loading…</div></div><div class="qv-body"><div class="muted">Loading product…</div></div>';
    try {
      const data = await api(`/api/products/${slug}/quickview`);
      qvProduct = data.product;
      const p = qvProduct;
      const swatches = p.variants.length
        ? `<div class="opt-group"><div class="label"><span>Choose an option</span><span class="muted small">Required</span></div>
             <div class="opt-swatches">${p.variants.map((v, i) => `<button type="button" class="opt-swatch" data-variant="${v.id}" data-price="${v.price}" ${v.stock ? '' : 'disabled'}>${escapeHtml(v.title)}<small>${v.stock ? money(v.price) + ' · ' + v.stock + ' in stock' : 'sold out'}</small></button>`).join('')}</div></div>`
        : '';
      qvBody.innerHTML = `
        <div class="qv-media">
          <img id="qvImg" src="${p.images[0]}" alt="${escapeHtml(p.name)}">
          ${p.images.length > 1 ? `<div class="gallery-thumbs" style="margin-top:.6rem">${p.images.map((im, i) => `<button type="button" data-qv-thumb="${im}" class="${i === 0 ? 'active' : ''}"><img src="${im}" alt=""></button>`).join('')}</div>` : ''}
        </div>
        <div class="qv-body">
          ${p.brand ? `<div class="p-brand">${escapeHtml(p.brand)}</div>` : ''}
          <h2 id="qvTitle" style="font-size:1.2rem">${escapeHtml(p.name)}</h2>
          <div class="p-meta">${p.rating ? `<span><span class="stars">${'&#9733;'.repeat(Math.round(p.rating))}</span> ${p.rating.toFixed(1)} (${p.reviews} reviews)</span>` : '<span class="muted">No reviews yet</span>'}
            <span class="muted">·</span><span class="muted">${escapeHtml(p.category || '')}</span></div>
          <div class="p-price-box">
            <span class="now" id="qvPrice">${money(p.price)}</span>
            ${p.compare ? `<span class="was">${money(p.compare)}</span><span class="save">-${p.discount}%</span>` : ''}
            <div class="unit">${p.in_stock ? `<span class="p-stock in">${p.stock} in stock · ready to ship</span>` : '<span class="p-stock out">Out of stock</span>'}${p.sku ? ` · SKU ${escapeHtml(p.sku)}` : ''}</div>
          </div>
          ${swatches}
          <div class="row" style="gap:.6rem;margin:.6rem 0 1rem">
            <div class="qty-box"><button type="button" data-qv-dec aria-label="Decrease">−</button>
              <input type="number" id="qvQty" value="1" min="1" max="${p.stock || 1}" aria-label="Quantity">
              <button type="button" data-qv-inc aria-label="Increase">+</button></div>
            <button class="btn primary" id="qvAdd" ${p.in_stock ? '' : 'disabled'} style="flex:1"><span class="ico"></span> Add to cart</button>
          </div>
          <p class="small muted">${escapeHtml(p.short || '')}</p>
          ${p.tags && p.tags.length ? `<div class="chips" style="margin:.7rem 0">${p.tags.slice(0, 6).map((t) => `<a class="chip" href="/search?q=${encodeURIComponent(t)}">${escapeHtml(t)}</a>`).join('')}</div>` : ''}
          <div class="row" style="gap:.5rem;margin-top:.9rem">
            <a class="btn ghost sm" href="${p.url}">Full details <span aria-hidden="true">›</span></a>
            <button class="btn ghost sm" type="button" data-wish="${p.id}">&#10084; Wishlist</button>
          </div>
        </div>`;
      $$('#qvContent [data-qv-thumb]').forEach((b) => on(b, 'click', () => {
        $('#qvImg').src = b.getAttribute('data-qv-thumb');
        $$('#qvContent [data-qv-thumb]').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
      }));
      $$('#qvContent [data-variant]').forEach((b) => on(b, 'click', () => {
        $$('#qvContent [data-variant]').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        $('#qvPrice').textContent = money(b.getAttribute('data-price'));
      }));
      on($('[data-qv-dec]'), 'click', () => { const q = $('#qvQty'); q.value = Math.max(1, Number(q.value) - 1); });
      on($('[data-qv-inc]'), 'click', () => { const q = $('#qvQty'); q.value = Math.min(Number(q.max) || 99, Number(q.value) + 1); });
      on($('#qvAdd'), 'click', async () => {
        const active = $('#qvContent [data-variant].active');
        if (p.variants.length && !active) return toast('Please choose an option first.', 'warn');
        try {
          await addCart(p.id, active ? active.getAttribute('data-variant') : null, Number($('#qvQty').value) || 1, $('#qvAdd'));
          closeQV();
        } catch (_) {}
      });
    } catch (err) {
      qvBody.innerHTML = `<div class="qv-body"><h3>Could not load this product</h3><p class="muted">${escapeHtml(err.message)}</p>
        <a class="btn primary" href="/p/${slug}">Open the product page</a></div>`;
    }
  }

  /* --------------------------------------------------------- hero slider */
  $$('[data-hero]').forEach((hero) => {
    const track = $('[data-hero-track]', hero);
    const dots = $$('[data-slide]', hero);
    if (!track) return;
    const total = track.children.length;
    let idx = 0;
    let timer = null;
    function go(i) {
      idx = (i + total) % total;
      track.style.transform = `translateX(-${idx * 100}%)`;
      dots.forEach((d, n) => d.classList.toggle('active', n === idx));
    }
    function play() {
      stop();
      timer = setInterval(() => go(idx + 1), Number(hero.dataset.interval) || 6500);
    }
    function stop() { if (timer) clearInterval(timer); }
    on($('[data-hero-next]', hero), 'click', () => { go(idx + 1); play(); });
    on($('[data-hero-prev]', hero), 'click', () => { go(idx - 1); play(); });
    dots.forEach((d, n) => on(d, 'click', () => { go(n); play(); }));
    hero.addEventListener('mouseenter', stop);
    hero.addEventListener('mouseleave', play);
    let x0 = null;
    hero.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; stop(); }, { passive: true });
    hero.addEventListener('touchend', (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 45) go(idx + (dx < 0 ? 1 : -1));
      x0 = null; play();
    });
    if (total > 1) play();
  });

  /* --------------------------------------------------------- countdowns */
  function tickCountdowns() {
    $$('[data-countdown]').forEach((el) => {
      const end = new Date(el.getAttribute('data-countdown')).getTime();
      let diff = Math.max(0, end - Date.now());
      const h = Math.floor(diff / 3600000); diff -= h * 3600000;
      const m = Math.floor(diff / 60000); diff -= m * 60000;
      const s = Math.floor(diff / 1000);
      const pad = (n) => String(n).padStart(2, '0');
      const hh = $('[data-cd-h]', el); const mm = $('[data-cd-m]', el); const ss = $('[data-cd-s]', el);
      if (hh) hh.textContent = pad(h);
      if (mm) mm.textContent = pad(m);
      if (ss) ss.textContent = pad(s);
    });
  }
  if ($('[data-countdown]')) { tickCountdowns(); setInterval(tickCountdowns, 1000); }

  /* -------------------------------------------------------------- rails */
  $$('.rail').forEach((rail) => {
    const scroller = $('[data-rail]', rail);
    const prev = $('[data-rail-prev]', rail);
    const next = $('[data-rail-next]', rail);
    if (!scroller) return;
    const step = () => Math.max(220, scroller.clientWidth * 0.7);
    on(prev, 'click', () => scroller.scrollBy({ left: -step(), behavior: 'smooth' }));
    on(next, 'click', () => scroller.scrollBy({ left: step(), behavior: 'smooth' }));
    const sync = () => {
      if (prev) prev.disabled = scroller.scrollLeft <= 4;
      if (next) next.disabled = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 4;
    };
    scroller.addEventListener('scroll', sync, { passive: true });
    sync();
  });

  /* ------------------------------------------------------- product page */
  const galleryMain = $('.gallery-main img');
  if (galleryMain) {
    $$('[data-thumb]').forEach((b) => on(b, 'click', () => {
      galleryMain.src = b.getAttribute('data-thumb');
      $$('[data-thumb]').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    }));
    const wrap = $('.gallery-main');
    on(wrap, 'mouseenter', () => wrap.classList.add('zooming'));
    on(wrap, 'mouseleave', () => { wrap.classList.remove('zooming'); galleryMain.style.transformOrigin = 'center'; });
    on(wrap, 'mousemove', (e) => {
      if (!wrap.classList.contains('zooming')) return;
      const r = wrap.getBoundingClientRect();
      galleryMain.style.transformOrigin = `${((e.clientX - r.left) / r.width) * 100}% ${((e.clientY - r.top) / r.height) * 100}%`;
    });
  }

  // variant selection on the product page
  const variantBtns = $$('[data-variant-btn]');
  variantBtns.forEach((b) => on(b, 'click', () => {
    variantBtns.forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    const price = b.getAttribute('data-price');
    const stock = Number(b.getAttribute('data-stock') || 0);
    const input = $('[data-variant-input]');
    if (input) input.value = b.getAttribute('data-variant');
    if (price) {
      const el = $('#productPrice');
      if (el) el.textContent = money(price);
    }
    const stockEl = $('#variantStock');
    if (stockEl) {
      stockEl.textContent = stock > 0 ? `${stock} in stock for this option` : 'This option is sold out';
      stockEl.className = `small ${stock > 0 ? 'p-stock in' : 'p-stock out'}`;
    }
    const addBtn = $('#addToCartBtn');
    if (addBtn) addBtn.disabled = stock <= 0;
  }));

  $$('.qty-box').forEach((box) => {
    const input = $('input', box);
    on(box.querySelector('button:first-child'), 'click', () => { input.value = Math.max(1, Number(input.value) - 1); input.dispatchEvent(new Event('change')); });
    on(box.querySelector('button:last-child'), 'click', () => { input.value = Math.min(Number(input.max) || 99, Number(input.value) + 1); input.dispatchEvent(new Event('change')); });
  });

  // product page tabs
  $$('.tab-btn').forEach((b) => on(b, 'click', () => {
    const group = b.closest('.tabs');
    $$('.tab-btn', group).forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    const target = b.getAttribute('data-tab');
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === target));
    if (history.replaceState) history.replaceState(null, '', `#${target}`);
  }));
  // deep-link a tab from the URL hash
  if (window.location.hash) {
    const btn = $(`.tab-btn[data-tab="${window.location.hash.slice(1)}"]`);
    if (btn) btn.click();
  }

  /* ---------------------------------------------------------- cart page */
  $$('[data-qty-change]').forEach((btn) => on(btn, 'click', async () => {
    const id = btn.getAttribute('data-item');
    const input = $(`[data-qty-input="${id}"]`);
    const next = Math.max(0, Number(input.value) + Number(btn.getAttribute('data-qty-change')));
    btn.disabled = true;
    try {
      await api('/api/cart/update', { method: 'POST', body: { id, qty: next } });
      window.location.reload();
    } catch (err) { toast(err.message, 'danger'); btn.disabled = false; }
  }));
  $$('[data-qty-input]').forEach((input) => on(input, 'change', async () => {
    const id = input.getAttribute('data-qty-input');
    try {
      await api('/api/cart/update', { method: 'POST', body: { id, qty: Math.max(0, Number(input.value)) } });
      window.location.reload();
    } catch (err) { toast(err.message, 'danger'); }
  }));

  // shipping estimator (cart + checkout)
  const regionSel = $('[data-ship-region]');
  const methodSel = $('[data-ship-method]');
  async function quoteShipping() {
    if (!regionSel) return;
    const out = $('[data-ship-quote]');
    try {
      const data = await api(`/api/shipping-quote?region=${encodeURIComponent(regionSel.value)}&method=${encodeURIComponent(methodSel ? methodSel.value : 'standard')}`);
      if (out) out.innerHTML = `Delivery to <b>${escapeHtml(regionSel.value || 'Ghana')}</b>: <b>${data.quote.fee ? money(data.quote.fee) : 'FREE'}</b> · ${escapeHtml(data.quote.eta || '')}`;
    } catch (_) {}
  }
  on(regionSel, 'change', () => {
    quoteShipping();
    fetch('/cart/ship', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `region=${encodeURIComponent(regionSel.value)}` }).catch(() => {});
  });
  on(methodSel, 'change', quoteShipping);
  if (regionSel && regionSel.value) quoteShipping();

  /* ------------------------------------------------------- checkout steps */
  $$('[data-method-card]').forEach((card) => on(card, 'click', () => {
    const group = card.closest('[data-method-group]');
    $$('[data-method-card]', group).forEach((c) => c.classList.remove('active'));
    card.classList.add('active');
    const radio = $('input[type=radio]', card);
    if (radio) radio.checked = true;
    const target = card.getAttribute('data-target');
    $$('[data-method-panel]').forEach((p) => { p.style.display = p.getAttribute('data-method-panel') === target ? '' : 'none'; });
  }));

  /* --------------------------------------------------- gateway (stub pay) */
  const gwChannelBtns = $$('.gw-channel');
  gwChannelBtns.forEach((b) => on(b, 'click', () => {
    gwChannelBtns.forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    const ch = b.getAttribute('data-channel');
    $$('[data-channel-panel]').forEach((p) => { p.hidden = p.getAttribute('data-channel-panel') !== ch; });
    const hidden = $('#channelInput');
    if (hidden) hidden.value = ch;
  }));

  const cardNum = $('#card_number');
  if (cardNum) {
    on(cardNum, 'input', () => {
      const digits = cardNum.value.replace(/\D/g, '').slice(0, 19);
      cardNum.value = digits.replace(/(.{4})/g, '$1 ').trim();
      const preview = $('#cardPreviewNum');
      if (preview) preview.textContent = (cardNum.value + '•••• •••• •••• ••••').slice(0, 22);
      const brandEl = $('#cardBrandGuess');
      if (brandEl) {
        const brand = digits.startsWith('4') ? 'Visa' : /^(5[1-5]|2[2-7])/.test(digits) ? 'Mastercard' : digits.startsWith('3') ? 'Amex' : 'Card';
        brandEl.textContent = brand;
        const hidden = $('#card_brand');
        if (hidden) hidden.value = brand;
      }
    });
    const exp = $('#card_expiry');
    on(exp, 'input', () => {
      let v = exp.value.replace(/\D/g, '').slice(0, 4);
      if (v.length > 2) v = `${v.slice(0, 2)}/${v.slice(2)}`;
      exp.value = v;
    });
    $$('[data-fill-card]').forEach((b) => on(b, 'click', () => {
      const kind = b.getAttribute('data-fill-card');
      if (kind === 'success') { cardNum.value = '4084 0840 8408 4081'; exp.value = '12/29'; $('#card_cvv').value = '408'; }
      if (kind === 'decline') { cardNum.value = '5060 6666 6666 6666 666'; exp.value = '12/29'; $('#card_cvv').value = '408'; }
      if (kind === 'funds') { cardNum.value = '4084 0999 9999 9995'; exp.value = '12/29'; $('#card_cvv').value = '408'; }
      cardNum.dispatchEvent(new Event('input'));
    }));
  }
  const momoNum = $('#momo_number');
  if (momoNum) {
    on(momoNum, 'input', () => {
      const d = momoNum.value.replace(/\D/g, '').slice(0, 13);
      momoNum.value = d.replace(/^(\+?233|0)?/, '').replace(/(\d{2})(\d{3})(\d{0,4}).*/, (m, a, b2, c) => [a, b2, c].filter(Boolean).join(' '));
    });
  }

  // busy state on every form submit
  $$('form[data-busy]').forEach((f) => on(f, 'submit', () => {
    const btn = $('button[type=submit]', f);
    if (btn && !btn.disabled) { btn.dataset.html = btn.innerHTML; btn.disabled = true; btn.innerHTML = 'Working…'; setTimeout(() => { btn.disabled = false; btn.innerHTML = btn.dataset.html; }, 8000); }
  }));

  /* ------------------------------------------------------------- to top */
  const toTop = $('#toTop');
  if (toTop) {
    on(window, 'scroll', () => toTop.classList.toggle('show', window.scrollY > 500), { passive: true });
    on(toTop, 'click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }

  /* ------------------------------------------------- password strength */
  const pw = $('#password');
  if (pw && $('#pwMeter')) {
    on(pw, 'input', () => {
      const v = pw.value;
      let score = 0;
      if (v.length >= 8) score += 1;
      if (/[A-Z]/.test(v)) score += 1;
      if (/[0-9]/.test(v)) score += 1;
      if (/[^A-Za-z0-9]/.test(v)) score += 1;
      if (v.length >= 12) score += 1;
      const pct = Math.min(100, score * 20);
      const bar = $('#pwMeter i');
      bar.style.width = `${pct}%`;
      bar.style.background = pct < 40 ? '#D64545' : pct < 70 ? '#FFB300' : '#12805C';
      const label = $('#pwLabel');
      if (label) label.textContent = ['', 'Very weak', 'Weak', 'Fair', 'Strong', 'Excellent'][score] || '';
    });
  }

  /* --------------------------------------------------- FAQ / details a11y */
  $$('.faq-item summary').forEach((s) => on(s, 'keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); s.click(); }
  }));

  /* ----------------------------------------------------- print receipts */
  $$('[data-print]').forEach((b) => on(b, 'click', () => window.print()));

  /* ------------------------------------------------ sticky header shadow */
  const header = $('#siteHeader');
  if (header) {
    on(window, 'scroll', () => header.classList.toggle('scrolled', window.scrollY > 8), { passive: true });
  }

  console.log('%c Biahens Enterprise ', 'background:#0F2A43;color:#FFB300;font-weight:700;border-radius:4px', 'storefront ready');
})();
