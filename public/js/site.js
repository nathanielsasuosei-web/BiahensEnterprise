/* ============================================================================
   POINTGH — storefront behaviour
   No dependencies. Everything degrades gracefully without JS.
   ========================================================================== */
(function () {
  'use strict';
  const CFG = window.BIAHENS || {};
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const on = (el, ev, fn, opt) => el && el.addEventListener(ev, fn, opt);
  const money = (n) => `${CFG.currency || 'GH₵'} ${Number(n || 0).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
      stack.setAttribute('role', 'status');
      stack.setAttribute('aria-live', 'polite');
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
  let drawerReturnFocus = null;
  function setDrawer(open) {
    if (!drawer) return;
    const wasOpen = drawer.classList.contains('open');
    if (open && !wasOpen) drawerReturnFocus = document.activeElement;
    drawer.inert = !open;
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    document.body.style.overflow = open || $('.modal.open') ? 'hidden' : '';
    const btn = $('#burgerBtn');
    if (btn) btn.setAttribute('aria-expanded', String(open));
    if (open) requestAnimationFrame(() => $('.drawer-close', drawer).focus());
    else if (wasOpen && drawerReturnFocus && drawerReturnFocus.isConnected) drawerReturnFocus.focus();
  }
  on($('#burgerBtn'), 'click', () => setDrawer(!drawer.classList.contains('open')));
  $$('[data-drawer-close]').forEach((el) => on(el, 'click', () => setDrawer(false)));
  on(document, 'keydown', (e) => {
    if (e.key === 'Escape') {
      setDrawer(false); closeMega(); closeQV(); closeDropdowns();
    }
    // Keep keyboard navigation inside the currently open dialog.
    if (e.key === 'Tab') {
      const dialog = $('.modal.open .modal-box') || $('.drawer.open .drawer-panel');
      if (!dialog) return;
      const focusable = $$('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex="0"]', dialog)
        .filter((el) => el.getClientRects().length && !el.closest('[inert]'));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first) { e.preventDefault(); dialog.focus(); return; }
      if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
  });

  /* ------------------------------------------------------- header: mega */
  const mega = $('#megaMenu');
  const megaBtn = $('#megaBtn');
  function openMega() {
    if (!mega) return;
    mega.inert = false;
    mega.classList.add('open');
    if (megaBtn) megaBtn.setAttribute('aria-expanded', 'true');
  }
  function closeMega() {
    if (!mega) return;
    const restoreFocus = mega.contains(document.activeElement);
    mega.classList.remove('open');
    mega.inert = true;
    if (megaBtn) {
      megaBtn.setAttribute('aria-expanded', 'false');
      if (restoreFocus) megaBtn.focus();
    }
  }
  on(megaBtn, 'click', (e) => { e.stopPropagation(); mega.classList.contains('open') ? closeMega() : openMega(); });
  on(document, 'click', (e) => { if (mega && mega.classList.contains('open') && !mega.contains(e.target) && e.target !== megaBtn) closeMega(); });
  // Only the category trigger opens this menu, never an unrelated nav link.
  on(megaBtn, 'keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); openMega(); const first = $('a', mega); if (first) first.focus(); }
  });

  /* ------------------------------------------------- header: dropdowns */
  function closeDropdowns() {
    $$('.dd.open').forEach((dd) => {
      dd.classList.remove('open');
      const button = $('button', dd);
      if (button) button.setAttribute('aria-expanded', 'false');
    });
  }
  $$('.dd > button').forEach((btn) => {
    on(btn, 'click', (e) => {
      e.stopPropagation();
      const dd = btn.closest('.dd');
      const isOpen = dd.classList.contains('open');
      closeDropdowns();
      closeMega();
      dd.classList.toggle('open', !isOpen);
      btn.setAttribute('aria-expanded', String(!isOpen));
    });
  });
  // Do not stop panel events: remove-from-bag uses the shared click handler.
  on(document, 'click', (e) => { if (!e.target.closest('.dd')) closeDropdowns(); });

  /* ---------------------------------------------- search autocomplete */
  const input = $('#searchInput');
  const box = $('#suggestBox');
  let sTimer = null;
  let sIndex = -1;
  let sItems = [];
  let suggestRequest = 0;
  function closeSuggest() {
    suggestRequest += 1;
    if (box) box.classList.remove('open');
    if (input) {
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
  }
  on(document, 'keydown', (e) => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.closest('input, textarea, select, [contenteditable]') && !$('.modal.open') && !$('.drawer.open')) {
      e.preventDefault(); if (input) input.focus();
    }
  });

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
    if (!parts.length) parts.push('<div class="suggest-empty">No matches for “' + escapeHtml(data.q) + '”. Try another word or browse <a class="suggest-item" href="/categories">all categories</a>.</div>');
    box.innerHTML = parts.join('');
    $$('.suggest-item', box).forEach((link, index) => {
      link.id = `search-option-${index}`;
      link.setAttribute('role', 'option');
      link.setAttribute('aria-selected', 'false');
    });
    box.classList.add('open');
    if (input) input.setAttribute('aria-expanded', 'true');
    sIndex = -1;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function suggest(q) {
    if (!box) return;
    if (q.length < 2) { closeSuggest(); return; }
    const request = ++suggestRequest;
    try {
      const data = await api(`/api/suggest?q=${encodeURIComponent(q)}`);
      if (request !== suggestRequest || input.value.trim() !== q) return;
      sItems = [];
      renderSuggest(data);
    } catch (_) { if (request === suggestRequest) closeSuggest(); }
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
      links.forEach((link, index) => {
        link.classList.toggle('active', index === sIndex);
        link.setAttribute('aria-selected', String(index === sIndex));
      });
      if (links[sIndex]) {
        input.setAttribute('aria-activedescendant', links[sIndex].id);
        links[sIndex].scrollIntoView({ block: 'nearest' });
      }
    } else if (e.key === 'Enter' && sIndex >= 0 && links[sIndex]) {
      e.preventDefault();
      window.location.href = links[sIndex].getAttribute('href');
    } else if (e.key === 'Escape') {
      e.preventDefault(); // Close suggestions without clearing the search field.
      closeSuggest();
    }
  });
  on(document, 'click', (e) => { if (box && !box.contains(e.target) && e.target !== input) closeSuggest(); });
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
    $$('[data-cart-count]').forEach((el) => { el.textContent = data.count; });
    const bagButton = $('#cartDD > button');
    if (bagButton) bagButton.setAttribute('aria-label', `Shopping bag, ${data.count} items`);
    $$('[data-cart-subtotal]').forEach((el) => { el.textContent = money(data.subtotal); });
    $$('[data-cart-discount]').forEach((el) => { el.textContent = `− ${money(data.discount)}`; });
    $$('[data-cart-discount-row]').forEach((el) => { el.hidden = !(data.discount > 0); });
    $$('[data-cart-tax]').forEach((el) => { el.textContent = money(data.tax); });
    $$('[data-cart-vat-label]').forEach((el) => { el.textContent = `VAT (${Number(data.taxRate)}%)`; });
    $$('[data-cart-vat-row]').forEach((el) => { el.hidden = !(data.taxRate > 0); });
    $$('[data-minicart-footer]').forEach((el) => { el.hidden = !data.count; });
    const items = $('[data-minicart-items]');
    if (items && data.items) {
      if (!data.items.length) {
        const bagIcon = $('.hdr-btn.cart > .ico');
        items.innerHTML = '<div class="mc-empty"><span class="empty-bag-icon">' + (bagIcon ? bagIcon.outerHTML : '') + '</span><b>Room for something good.</b><p>Your next favourite is just a few clicks away.</p><a class="btn primary sm" href="/new-arrivals">Start exploring →</a></div>';
      } else {
        items.innerHTML = data.items.slice(0, 4).map((i) => `<div class="mc-item"><img src="${escapeHtml(i.image)}" alt="${escapeHtml(i.name)}" loading="lazy"><div class="grow"><div class="n clamp-2"><a href="/p/${encodeURIComponent(i.slug)}">${escapeHtml(i.name)}</a></div>${i.variant ? `<div class="v">${escapeHtml(i.variant)}</div>` : ''}<div class="p">${money(i.unit_price)} <span class="muted small">× ${i.qty}</span></div></div><button class="rm" type="button" data-remove-item="${i.id}" aria-label="Remove ${escapeHtml(i.name)}">&times;</button></div>`).join('');
      }
    }
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
        $$('.p-tool[data-wish], button[data-wish]').filter((button) => button.getAttribute('data-wish') === wish.getAttribute('data-wish')).forEach((button) => {
          button.classList.toggle('active', data.added);
          button.setAttribute('aria-pressed', String(data.added));
        });
        $$('[data-wish-count]').forEach((el) => { el.textContent = data.count; el.hidden = !data.count; });
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
      $$('[data-wish]').forEach((b) => {
        const saved = set.has(Number(b.getAttribute('data-wish')));
        b.classList.toggle('active', saved);
        b.setAttribute('aria-pressed', String(saved));
      });
    } catch (_) {}
  })();

  /* ---------------------------------------------------------- quick view */
  const qvModal = $('#quickViewModal');
  const qvBody = $('#qvContent');
  let qvProduct = null;
  let qvReturnFocus = null;
  let qvRequest = 0;

  function closeQV() {
    if (!qvModal) return;
    qvRequest += 1;
    const wasOpen = qvModal.classList.contains('open');
    qvModal.classList.remove('open');
    qvModal.setAttribute('aria-hidden', 'true');
    qvModal.inert = true;
    document.body.style.overflow = drawer && drawer.classList.contains('open') ? 'hidden' : '';
    if (wasOpen && qvReturnFocus && qvReturnFocus.isConnected) qvReturnFocus.focus();
  }
  $$('[data-qv-close]').forEach((el) => on(el, 'click', closeQV));
  on(document, 'click', (e) => {
    const t = e.target.closest('[data-quickview]');
    if (t) { e.preventDefault(); openQuickView(t.getAttribute('data-quickview')); }
  });

  async function openQuickView(slug) {
    if (!qvModal || !qvBody) { window.location.href = `/p/${slug}`; return; }
    if (!qvModal.classList.contains('open')) qvReturnFocus = document.activeElement;
    const request = ++qvRequest;
    qvModal.inert = false;
    qvModal.classList.add('open');
    qvModal.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => $('[data-qv-close].modal-close', qvModal).focus());
    document.body.style.overflow = 'hidden';
    qvBody.innerHTML = '<div class="qv-media"><div class="muted">Loading…</div></div><div class="qv-body"><div class="muted">Loading product…</div></div>';
    try {
      const data = await api(`/api/products/${slug}/quickview`);
      if (request !== qvRequest || !qvModal.classList.contains('open')) return;
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
            <button class="btn primary" id="qvAdd" ${p.in_stock ? '' : 'disabled'} style="flex:1">Add to bag</button>
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
      if (request !== qvRequest || !qvModal.classList.contains('open')) return;
      qvBody.innerHTML = `<div class="qv-body"><h3>Could not load this product</h3><p class="muted">${escapeHtml(err.message)}</p>
        <a class="btn primary" href="/p/${slug}">Open the product page</a></div>`;
    }
  }

  /* --------------------------------------- homepage collection browsing */
  $$('[data-product-tabs]').forEach((section) => {
    const tabs = $$('[data-product-tab]', section);
    function activate(tab, focus) {
      tabs.forEach((button) => {
        const active = button === tab;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
        const panel = document.getElementById(button.getAttribute('aria-controls'));
        if (panel) panel.hidden = !active;
      });
      if (focus) tab.focus();
    }
    tabs.forEach((tab, index) => {
      on(tab, 'click', () => activate(tab, false));
      on(tab, 'keydown', (e) => {
        const next = e.key === 'ArrowRight' ? (index + 1) % tabs.length : e.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
        if (next >= 0) { e.preventDefault(); activate(tabs[next], true); }
      });
    });
  });

  /* ------------------------------------------- progressive email signup */
  $$('[data-newsletter-form]').forEach((form) => on(form, 'submit', async (e) => {
    e.preventDefault();
    const button = $('button[type="submit"]', form);
    const label = button.innerHTML;
    const status = $('[data-newsletter-status]', form.parentElement);
    button.disabled = true;
    button.textContent = 'Joining…';
    if (status) status.textContent = 'Saving your spot…';
    try {
      const response = await fetch(form.action, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        body: new URLSearchParams(new FormData(form)).toString(),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.message || 'Could not subscribe. Please try again.');
      if (status) { status.textContent = data.message; status.className = 'newsletter-note success'; }
      form.reset();
    } catch (err) {
      if (status) { status.textContent = err.message || 'Something went wrong. Please try again.'; status.className = 'newsletter-note error'; }
    } finally { button.disabled = false; button.innerHTML = label; }
  }));

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
    variantBtns.forEach((x) => {
      x.classList.toggle('active', x === b);
      x.setAttribute('aria-pressed', String(x === b));
    });
    const price = b.getAttribute('data-price');
    const stock = Number(b.getAttribute('data-stock') || 0);
    const input = $('[data-variant-input]');
    if (input) input.value = b.getAttribute('data-variant');
    const quantity = $('#buyForm input[name="qty"]');
    if (quantity) {
      quantity.max = Math.max(1, stock);
      quantity.value = Math.max(1, Math.min(stock, Number(quantity.value) || 1));
    }
    const maximum = $('[data-variant-max]');
    if (maximum) maximum.textContent = stock;
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
    // Cart controls persist their own quantity below; do not increment twice.
    if (!input || input.hasAttribute('data-qty-input')) return;
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

  /* ------------------------------------------- private automatic tracking */
  const tracker = $('[data-order-tracker]');
  if (tracker) {
    const message = $('[data-track-message]', tracker);
    const refresh = $('[data-track-refresh]', tracker);
    let busy = false;
    let expired = false;
    async function refreshTracking() {
      if (busy || expired || document.hidden) return;
      busy = true;
      refresh.disabled = true;
      try {
        const response = await fetch(`/api/orders/${encodeURIComponent(tracker.dataset.orderTracker)}/tracking`, {
          headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(10000),
        });
        if (response.status === 401) {
          expired = true;
          message.innerHTML = 'Your session expired. <a href="/login?next=%2Ftrack-order">Sign in to continue tracking.</a>';
          return;
        }
        if (!response.ok) throw new Error('Tracking is temporarily unavailable.');
        const { order } = await response.json();
        $('[data-track-status]', tracker).textContent = order.label;
        const selectedOrder = $('.tracking-order-link.active small');
        if (selectedOrder) selectedOrder.textContent = order.label;
        $('[data-track-status]', tracker).className = `badge ${order.tone}`;
        $('[data-track-progress]', tracker).innerHTML = order.steps.map(step => `<div class="seg ${step.done ? 'done' : ''} ${step.current ? 'current' : ''}">${escapeHtml(step.label)}</div>`).join('');
        $('[data-track-events]', tracker).innerHTML = order.events.map(event => `<div class="tl-item"><span class="dot"></span><div><b class="small">${escapeHtml(event.label)}</b><time class="tiny muted">${escapeHtml(event.date)}</time>${event.note ? `<p class="small">${escapeHtml(event.note)}</p>` : ''}</div></div>`).join('');
        $('[data-track-carrier] span', tracker).textContent = order.tracking_number
          ? [order.carrier, order.tracking_number].filter(Boolean).join(' · ')
          : 'Carrier details will appear once your order is dispatched.';
        message.textContent = `Up to date at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Checks automatically every 20 seconds.`;
      } catch (_) {
        message.textContent = 'Unable to refresh just now. Your last update is still shown; we’ll try again.';
      } finally {
        busy = false;
        refresh.disabled = expired;
      }
    }
    on(refresh, 'click', refreshTracking);
    on(document, 'visibilitychange', () => { if (!document.hidden) refreshTracking(); });
    setInterval(refreshTracking, 20000);
  }

  /* ------------------------------------------------ sticky header shadow */
  const header = $('#siteHeader');
  if (header) {
    on(window, 'scroll', () => header.classList.toggle('scrolled', window.scrollY > 8), { passive: true });
  }

  console.log('%c POINTGH ', 'background:#242820;color:#d9f58b;font-weight:700;border-radius:4px', 'storefront ready');
})();
