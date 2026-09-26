/* =========================================================================
   BIAHENS ENTERPRISE — admin panel behaviour
   Vanilla JS, no dependencies. Loaded with `defer` on every admin page.
   Everything is feature-detected, so a page that lacks a widget simply skips it.
   ========================================================================= */
(function () {
  'use strict';

  var CFG = window.BIAHENS || {};
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ------------------------------------------------------------ tiny helpers */
  function post(url, data) {
    var body = Object.keys(data || {}).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(data[k]);
    }).join('&');
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body,
      credentials: 'same-origin',
    }).then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); });
  }

  function toast(message, tone) {
    var stack = $('.flash-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'flash-stack';
      document.body.appendChild(stack);
    }
    var el = document.createElement('div');
    el.className = 'flash ' + (tone || 'info');
    el.innerHTML = '<span>' + String(message).replace(/[<>&]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c];
    }) + '</span><button class="x" type="button" aria-label="Dismiss">&times;</button>';
    stack.appendChild(el);
    var kill = function () { if (el.parentNode) el.parentNode.removeChild(el); };
    $('.x', el).addEventListener('click', kill);
    setTimeout(kill, 4200);
  }

  function busy(el, on) {
    if (!el) return;
    if (on) { el.dataset.label = el.innerHTML; el.disabled = true; el.style.opacity = '.6'; }
    else { if (el.dataset.label) el.innerHTML = el.dataset.label; el.disabled = false; el.style.opacity = ''; }
  }

  /* ==================================================================== 1
     Sidebar (mobile drawer) + topbar dropdowns
     ==================================================================== */
  function initChrome() {
    var sidebar = $('#sidebar');
    var toggle = $('#sbToggle');
    var backdrop = null;

    function closeSidebar() {
      if (!sidebar) return;
      sidebar.classList.remove('open');
      document.body.style.overflow = '';
      if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      backdrop = null;
    }

    if (toggle && sidebar) {
      toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = sidebar.classList.toggle('open');
        document.body.style.overflow = open ? 'hidden' : '';
        if (open && !backdrop) {
          backdrop = document.createElement('div');
          backdrop.className = 'sb-backdrop';
          backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(8,20,33,.5);z-index:899';
          backdrop.addEventListener('click', closeSidebar);
          document.body.appendChild(backdrop);
        } else if (!open) { closeSidebar(); }
      });
    }

    /* dropdowns -------------------------------------------------------- */
    $$('[data-dd-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var dd = document.getElementById(btn.getAttribute('data-dd-toggle'));
        if (!dd) return;
        var wasOpen = dd.classList.contains('open');
        $$('.dd.open').forEach(function (o) { o.classList.remove('open'); });
        if (!wasOpen) dd.classList.add('open');
      });
      var panel = $('.dd-panel', btn.parentNode);
      if (panel) panel.addEventListener('click', function (e) { e.stopPropagation(); });
    });

    document.addEventListener('click', function () {
      $$('.dd.open').forEach(function (o) { o.classList.remove('open'); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        $$('.dd.open').forEach(function (o) { o.classList.remove('open'); });
        $$('.modal:not([hidden])').forEach(closeModal);
        closeSidebar();
      }
    });

    /* topbar search: jump straight to the right section on Enter -------- */
    var search = $('[data-admin-search]');
    if (search) {
      search.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var q = search.value.trim();
          if (!q) { e.preventDefault(); return; }
          if (/^BIA-|^ORD-/i.test(q)) { e.preventDefault(); window.location = '/admin/orders?q=' + encodeURIComponent(q); }
          else if (/@/.test(q)) { e.preventDefault(); window.location = '/admin/customers?q=' + encodeURIComponent(q); }
        }
      });
    }

    /* keyboard shortcut: press "/" to focus search ---------------------- */
    document.addEventListener('keydown', function (e) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target;
      if (t && /input|textarea|select/i.test(t.tagName)) return;
      if (search) { e.preventDefault(); search.focus(); }
    });

    /* auto-dismiss server-rendered flashes ------------------------------ */
    $$('.flash-stack .flash').forEach(function (f) {
      setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 5200);
    });
  }

  /* ==================================================================== 2
     Tabs (client-side panels)
     ==================================================================== */
  function initTabs() {
    $$('[data-tabs]').forEach(function (wrap) {
      var buttons = $$('[data-tab-btn]', wrap);
      var panels = $$('[data-tab-panel]');
      buttons.forEach(function (btn) {
        btn.addEventListener('click', function () {
          var key = btn.getAttribute('data-tab-btn');
          buttons.forEach(function (b) { b.classList.toggle('active', b === btn); });
          panels.forEach(function (p) {
            var match = p.getAttribute('data-tab-panel') === key;
            p.hidden = !match;
            p.classList.toggle('active', match);
          });
          if (history.replaceState) history.replaceState(null, '', '#' + key);
        });
      });
      /* deep-link with #hash */
      if (location.hash) {
        var target = buttons.filter(function (b) { return b.getAttribute('data-tab-btn') === location.hash.slice(1); })[0];
        if (target) target.click();
      }
    });
  }

  /* ==================================================================== 3
     Bulk selection (products + orders)
     ==================================================================== */
  function initBulk() {
    var form = $('[data-bulk]');
    var checks = $$('[data-row-check]');
    if (!checks.length) return;
    var bar = form ? $('[data-bulk-bar]', form) : $('[data-bulk-bar]');
    var counter = $('[data-bulk-count]');
    var all = $('[data-check-all]');
    var action = $('[data-bulk-action]');

    function selected() { return checks.filter(function (c) { return c.checked; }); }

    function sync() {
      var sel = selected();
      if (counter) counter.textContent = sel.length;
      if (bar) bar.classList.toggle('hidden', sel.length === 0);
      if (all) {
        all.checked = sel.length === checks.length && checks.length > 0;
        all.indeterminate = sel.length > 0 && sel.length < checks.length;
      }
      checks.forEach(function (c) {
        var row = c.closest('tr');
        if (row) row.classList.toggle('selected', c.checked);
      });
    }

    checks.forEach(function (c) {
      c.addEventListener('change', sync);
      var row = c.closest('tr');
      if (row) {
        row.addEventListener('click', function (e) {
          var tag = (e.target.tagName || '').toLowerCase();
          if (tag === 'input' || tag === 'a' || tag === 'button' || tag === 'select' || e.target.closest('a,button,select,label,.row-actions')) return;
          c.checked = !c.checked;
          sync();
        });
      }
    });

    if (all) all.addEventListener('change', function () {
      checks.forEach(function (c) { c.checked = all.checked; });
      sync();
    });

    var clear = $('[data-bulk-clear]');
    if (clear) clear.addEventListener('click', function () {
      checks.forEach(function (c) { c.checked = false; });
      sync();
    });

    if (form) {
      form.addEventListener('submit', function (e) {
        if (!selected().length) { e.preventDefault(); toast('Select at least one row first.', 'warn'); return; }
        var label = action && action.options[action.selectedIndex] ? action.options[action.selectedIndex].text : 'this action';
        if (!window.confirm('Apply "' + label + '" to ' + selected().length + ' selected row(s)?')) e.preventDefault();
      });
    }
    sync();
  }

  /* ==================================================================== 4
     Inline product mutations: stock, price modal, visibility toggles
     ==================================================================== */
  function initProductWidgets() {
    /* --- stock +/- (XHR) ------------------------------------------------ */
    $$('[data-stock-adjust]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-stock-adjust');
        var delta = Number(btn.getAttribute('data-delta') || 0);
        busy(btn, true);
        post('/admin/products/' + id + '/stock', { delta: delta }).then(function (res) {
          busy(btn, false);
          if (!res || res.ok === false) { toast((res && res.message) || 'Could not update stock.', 'danger'); return; }
          var row = btn.closest('tr');
          if (row) {
            var cell = $('[data-stock-cell]', row) || $('.stock-pill', row);
            if (cell) {
              cell.textContent = res.stock;
              cell.classList.remove('in', 'low', 'out');
              cell.classList.add(res.stock <= 0 ? 'out' : res.stock <= 5 ? 'low' : 'in');
            }
          }
          toast('Stock is now ' + res.stock + '.', res.stock <= 0 ? 'warn' : 'success');
        }).catch(function () { busy(btn, false); toast('Network error — stock unchanged.', 'danger'); });
      });
    });

    /* --- price modal ---------------------------------------------------- */
    var modal = $('#priceModal');
    var priceForm = $('#priceForm');
    if (modal && priceForm) {
      $$('[data-edit-price]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-edit-price');
          priceForm.setAttribute('action', '/admin/products/' + id + '/price');
          var price = $('#pmPrice'); var compare = $('#pmCompare');
          if (price) price.value = btn.getAttribute('data-price') || '';
          if (compare) compare.value = btn.getAttribute('data-compare') || '';
          openModal(modal);
          if (price) price.focus();
        });
      });
      priceForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var submit = $('button[type="submit"]', priceForm);
        busy(submit, true);
        var data = {};
        $$('input,select,textarea', priceForm).forEach(function (f) { if (f.name) data[f.name] = f.value; });
        post(priceForm.getAttribute('action'), data).then(function (res) {
          busy(submit, false);
          if (!res || res.ok === false) { toast('Price not saved.', 'danger'); return; }
          closeModal(modal);
          toast('Price updated to ' + (CFG.currency || '') + ' ' + Number(res.price).toFixed(2)
            + (res.discount ? ' (−' + res.discount + '%)' : ''), 'success');
          setTimeout(function () { window.location.reload(); }, 700);
        }).catch(function () { busy(submit, false); toast('Network error.', 'danger'); });
      });
    }

    /* --- visibility / feature switches (XHR) ---------------------------- */
    $$('input[data-toggle]').forEach(function (input) {
      input.addEventListener('change', function () {
        var id = input.getAttribute('data-toggle');
        var field = input.getAttribute('data-field') || 'is_active';
        input.disabled = true;
        post('/admin/products/' + id + '/toggle', { field: field }).then(function (res) {
          input.disabled = false;
          if (!res || res.ok === false) { input.checked = !input.checked; toast('Change rejected.', 'danger'); return; }
          toast(field === 'is_featured' ? (res.value ? 'Added to the featured rail.' : 'Removed from the featured rail.')
            : (res.value ? 'Product is live on the storefront.' : 'Product hidden from the storefront.'), 'success');
        }).catch(function () { input.disabled = false; input.checked = !input.checked; toast('Network error — reverted.', 'danger'); });
      });
    });
  }

  /* ==================================================================== 5
     Modals (generic)
     ==================================================================== */
  function openModal(el) {
    if (!el) return;
    el.hidden = false;
    el.classList.add('open');
    document.body.style.overflow = 'hidden';
    var focus = $('[data-autofocus],input,select,textarea,button', el);
    if (focus) setTimeout(function () { focus.focus(); }, 40);
  }
  function closeModal(el) {
    if (!el) return;
    el.hidden = true;
    el.classList.remove('open');
    document.body.style.overflow = '';
  }
  function initModals() {
    $$('[data-close-modal]').forEach(function (b) {
      b.addEventListener('click', function () { closeModal(b.closest('.modal')); });
    });
    $$('[data-modal-open]').forEach(function (b) {
      b.addEventListener('click', function () { openModal($(b.getAttribute('data-modal-open'))); });
    });
    $$('.modal').forEach(function (m) {
      m.addEventListener('click', function (e) { if (e.target === m) closeModal(m); });
    });
  }

  /* ==================================================================== 6
     Character counters + slug generation
     ==================================================================== */
  function initFields() {
    $$('[data-counter]').forEach(function (field) {
      var max = Number(field.getAttribute('data-counter')) || 0;
      var out = field.parentNode ? $('[data-counter-out]', field.parentNode) : null;
      function paint() {
        if (!out) return;
        var n = field.value.length;
        out.textContent = n + ' / ' + max + ' characters';
        out.style.color = n > max * 0.92 ? 'var(--red)' : n > max * 0.75 ? '#9A6700' : '';
      }
      field.addEventListener('input', paint);
      paint();
    });

    $$('[data-slug-source]').forEach(function (source) {
      var target = $(source.getAttribute('data-slug-source'));
      if (!target) return;
      var touched = !!target.value;
      target.addEventListener('input', function () { touched = true; });
      source.addEventListener('input', function () {
        if (touched) return;
        target.value = String(source.value).toLowerCase().trim()
          .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
      });
    });

    /* disable double submits on long forms */
    $$('form[data-busy]').forEach(function (form) {
      form.addEventListener('submit', function () {
        $$('button[type="submit"]', form).forEach(function (b) {
          if (b.form && b.form !== form) return;
          b.disabled = true;
          b.style.opacity = '.65';
        });
        setTimeout(function () {
          $$('button[type="submit"]', form).forEach(function (b) { b.disabled = false; b.style.opacity = ''; });
        }, 9000);
      });
    });

    /* generic confirm attribute */
    $$('[data-confirm]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        if (!window.confirm(el.getAttribute('data-confirm'))) e.preventDefault();
      });
    });

    /* copy-to-clipboard buttons */
    $$('[data-copy]').forEach(function (b) {
      if (b.dataset.copyBound) return;
      b.dataset.copyBound = '1';
      b.addEventListener('click', function () {
        var text = b.getAttribute('data-copy');
        var done = function () {
          var old = b.innerHTML;
          b.innerHTML = '✓ copied';
          setTimeout(function () { b.innerHTML = old; }, 1300);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
        else {
          var ta = document.createElement('textarea');
          ta.value = text; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); } catch (err) { /* ignore */ }
          document.body.removeChild(ta); done();
        }
      });
    });
  }

  /* ==================================================================== 7
     Review reply drawers
     ==================================================================== */
  function initReviews() {
    $$('[data-reply-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var form = $('[data-reply-form="' + btn.getAttribute('data-reply-toggle') + '"]');
        if (!form) return;
        var show = form.style.display === 'none' || !form.style.display;
        form.style.display = show ? 'block' : 'none';
        if (show) { var ta = $('textarea', form); if (ta) ta.focus(); }
      });
    });
  }

  /* ==================================================================== 8
     Image uploader (product form)
     ==================================================================== */
  function initUploader() {
    var drop = $('#uploader');
    var input = $('#fileInput');
    var grid = $('#uploadGrid');
    var progress = $('#uploadProgress');
    var mainInput = $('#mainImageInput');
    if (!drop || !input || !grid) return;

    var endpoint = (drop.getAttribute('data-upload-url') || '/admin/uploads') + '/images';
    var fieldName = grid.getAttribute('data-images-input') || 'images';
    var MAX = 8;

    function items() { return $$('.upload-item', grid); }

    function syncMain() {
      var list = items();
      list.forEach(function (it, i) {
        it.classList.toggle('primary', i === 0);
        var tag = $('.tag', it);
        if (i === 0 && !tag) {
          tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = 'Main';
          it.appendChild(tag);
        } else if (i > 0 && tag) { tag.parentNode.removeChild(tag); }
      });
      if (mainInput) mainInput.value = list.length ? list[0].getAttribute('data-src') : '';
    }

    function addImage(src) {
      var item = document.createElement('div');
      item.className = 'upload-item';
      item.setAttribute('data-src', src);
      item.innerHTML = '<img src="' + src + '" alt="Product image" loading="lazy">'
        + '<div class="acts">'
        + '<button type="button" title="Make main image" data-make-primary>★ Main</button>'
        + '<button type="button" title="Remove image" data-remove-image>✕ Remove</button>'
        + '</div>'
        + '<input type="hidden" name="' + fieldName + '" value="' + src + '">';
      grid.appendChild(item);
      syncMain();
    }

    grid.addEventListener('click', function (e) {
      var item = e.target.closest('.upload-item');
      if (!item) return;
      if (e.target.closest('[data-remove-image]')) {
        var src = item.getAttribute('data-src') || '';
        item.parentNode.removeChild(item);
        syncMain();
        if (src.indexOf('/uploads/') === 0) {
          post('/admin/uploads/delete', { url: src }).catch(function () {});
        }
      } else if (e.target.closest('[data-make-primary]')) {
        grid.insertBefore(item, grid.firstChild);
        syncMain();
      }
    });

    function upload(files) {
      var list = Array.prototype.slice.call(files || []);
      if (!list.length) return;
      if (items().length + list.length > MAX) {
        toast('Maximum ' + MAX + ' images per product.', 'warn');
        list = list.slice(0, Math.max(0, MAX - items().length));
        if (!list.length) return;
      }
      var data = new FormData();
      list.forEach(function (f) { data.append('images', f, f.name); });

      if (progress) progress.classList.add('show');
      var xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint);
      xhr.withCredentials = true;
      xhr.upload.onprogress = function (e) {
        if (!progress || !e.lengthComputable) return;
        $('i', progress).style.width = Math.round(e.loaded / e.total * 100) + '%';
      };
      xhr.onload = function () {
        if (progress) { progress.classList.remove('show'); $('i', progress).style.width = '0'; }
        var res = null;
        try { res = JSON.parse(xhr.responseText); } catch (err) { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300 && res && res.ok) {
          (res.files || []).forEach(function (f) { addImage(f.url); });
          toast((res.files || []).length + ' image(s) uploaded.', 'success');
        } else {
          toast((res && res.message) || 'Upload failed (HTTP ' + xhr.status + ').', 'danger');
        }
      };
      xhr.onerror = function () {
        if (progress) progress.classList.remove('show');
        toast('Upload failed — check your connection.', 'danger');
      };
      xhr.send(data);
    }

    drop.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () { upload(input.files); input.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('drag'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) upload(e.dataTransfer.files);
    });
    /* paste an image straight from the clipboard */
    document.addEventListener('paste', function (e) {
      if (!e.clipboardData || !e.clipboardData.files || !e.clipboardData.files.length) return;
      var t = e.target;
      if (t && /input|textarea/i.test(t.tagName) && t.type !== 'file') return;
      upload(e.clipboardData.files);
    });
    syncMain();
  }

  /* ==================================================================== 9
     Variant / option repeaters (product form)
     ==================================================================== */
  function initRepeaters() {
    $$('[data-add-row]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var template = $(btn.getAttribute('data-add-row'));
        var host = $(btn.getAttribute('data-add-into') || btn.getAttribute('data-add-row') + '-host');
        if (!template || !host) return;
        var clone = template.cloneNode(true);
        clone.hidden = false;
        clone.classList.remove('template');
        $$('input,select,textarea', clone).forEach(function (f) { f.value = ''; f.removeAttribute('disabled'); });
        host.appendChild(clone);
      });
    });

    document.addEventListener('click', function (e) {
      var rm = e.target.closest('[data-remove-row]');
      if (!rm) return;
      var row = rm.closest('[data-repeatable]') || rm.closest('tr') || rm.parentNode;
      if (row && row.parentNode) row.parentNode.removeChild(row);
    });
  }

  /* ==================================================================== 10
     Auto-save filters + table sorting affordances
     ==================================================================== */
  function initFilters() {
    $$('form[data-auto-submit] select, select[data-auto-submit]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var form = sel.form || sel.closest('form');
        if (form) form.submit();
      });
    });
    /* remember the last visited list filters in the URL for back-navigation */
    $$('[data-persist-scroll]').forEach(function (el) {
      var key = 'biahens-scroll-' + location.pathname;
      var saved = sessionStorage.getItem(key);
      if (saved) window.scrollTo(0, Number(saved));
      window.addEventListener('beforeunload', function () {
        sessionStorage.setItem(key, String(window.scrollY));
      });
    });
  }

  /* ==================================================================== boot */
  function boot() {
    initChrome();
    initTabs();
    initBulk();
    initModals();
    initFields();
    initReviews();
    initProductWidgets();
    initUploader();
    initRepeaters();
    initFilters();
    document.documentElement.classList.add('js-ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
