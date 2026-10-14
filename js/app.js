(function () {
  "use strict";
  var CFG = window.STOCKROOM_CONFIG || {};
  var LOW_DEFAULT = Number(CFG.lowStockDefault) >= 0 ? Number(CFG.lowStockDefault) : 5;
  var XLSX_SRC = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
  var UNDO_MS = 6000;

  var store = window.StockStore.create(CFG);
  var products = [], loaded = false, loadError = null;
  var ui = { q: "", cat: "all", attn: false, sortKey: "name", sortDir: "asc" };
  var editingId = null, pendingPhoto = null; // {job: Promise<Blob>} for a new photo, {id} for the existing one
  var qtyTimers = {};
  var pendingDeletes = {}; // id → {product, timer}

  var el = function (id) { return document.getElementById(id); };
  function inr(n) { n = Math.round(Number(n) || 0); return (n < 0 ? "−₹" : "₹") + Math.abs(n).toLocaleString("en-IN"); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function slug(s) { return String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || ("ITEM-" + Date.now().toString(36).toUpperCase()); }
  function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }
  function icon(name, extra) { return '<svg aria-hidden="true"' + (extra || "") + '><use href="#i-' + name + '"/></svg>'; }
  function plural(n, one, many) { return n.toLocaleString("en-IN") + " " + (n === 1 ? one : many); }

  /* ---------- theme ---------- */
  function isDark() {
    var cur = document.documentElement.getAttribute("data-theme");
    if (cur) return cur === "dark";
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }
  function syncThemeLabel() { el("themeBtn").setAttribute("aria-label", isDark() ? "Switch to light theme" : "Switch to dark theme"); el("themeBtn").title = el("themeBtn").getAttribute("aria-label"); }
  function initTheme() {
    syncThemeLabel();
    el("themeBtn").addEventListener("click", function () {
      var next = isDark() ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("sr-theme", next); } catch (e) {}
      syncThemeLabel();
    });
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      if (mq.addEventListener) mq.addEventListener("change", syncThemeLabel);
    }
  }

  /* ---------- derived ---------- */
  var STATUS = { "in": { label: "In stock", icon: "check" }, low: { label: "Low stock", icon: "alert" }, out: { label: "Out of stock", icon: "x-circle" } };
  function statusOf(p) { var low = (p.low == null ? LOW_DEFAULT : p.low); var q = Number(p.quantity) || 0; if (q <= 0) return "out"; if (q <= low) return "low"; return "in"; }
  function statusHtml(st) { return '<span class="status ' + st + '">' + icon(STATUS[st].icon) + STATUS[st].label + '</span>'; }
  function totals() {
    var t = { count: products.length, units: 0, stockVal: 0, sales: 0, low: 0, out: 0 };
    products.forEach(function (p) {
      var q = Number(p.quantity) || 0; t.units += q; t.stockVal += q * (Number(p.cost) || 0); t.sales += q * (Number(p.price) || 0);
      var s = statusOf(p); if (s === "low") t.low++; if (s === "out") t.out++;
    });
    return t;
  }

  /* ---------- render ---------- */
  function render() { renderKpis(); renderBars(); renderChips(); renderTable(); }

  var KPI_ICONS = {
    products: '<path d="M20 7L12 3 4 7v10l8 4 8-4z"/><path d="M4 7l8 4 8-4M12 11v10"/>',
    units: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v16"/>',
    value: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9a2.5 2.5 0 0 0-2.5-2h-1a2 2 0 0 0 0 4h1a2 2 0 0 1 0 4h-1A2.5 2.5 0 0 1 9.5 15"/><path d="M12 6v1.5M12 16v1.5"/>',
    sales: '<path d="M3 17l6-6 4 4 7-7"/><path d="M17 8h4v4"/>',
    alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'
  };
  function kpiIcon(k) { return '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + KPI_ICONS[k] + '</svg>'; }
  function renderKpis() {
    var t = totals(), alertN = t.low + t.out;
    function tile(k, lab, val, sub) { return '<div class="kpi"><div class="k-top">' + kpiIcon(k) + lab + '</div><div class="k-val num">' + val + '</div><div class="k-sub">' + sub + '</div></div>'; }
    var html = tile("products", "Products", t.count.toLocaleString("en-IN"), "active SKUs") +
      tile("units", "Units in stock", t.units.toLocaleString("en-IN"), "total pieces") +
      tile("value", "Stock value", inr(t.stockVal), "at cost price") +
      tile("sales", "Potential sales", inr(t.sales), "at selling price");
    if (alertN > 0) {
      html += '<button type="button" class="kpi alert span" id="attnKpi" aria-pressed="' + ui.attn + '"><span class="k-top">' + kpiIcon("alert") + 'Needs attention</span><span class="k-val num" style="display:block">' + alertN.toLocaleString("en-IN") + '</span><span class="k-sub" style="display:block">' + t.out + ' out of stock · ' + t.low + ' low</span><span class="k-cta">' + (ui.attn ? "Showing these — show all" : "Show these products") + icon("arrow") + '</span></button>';
    } else {
      html += '<div class="kpi alert none span"><div class="k-top">' + kpiIcon("alert") + 'Needs attention</div><div class="k-val num">0</div><div class="k-sub">All products are well stocked</div></div>';
    }
    el("kpis").innerHTML = html;
  }

  function renderBars() {
    var map = {};
    products.forEach(function (p) {
      var c = (p.category || "").trim() || "uncategorized";
      if (!map[c]) map[c] = { units: 0, val: 0 };
      var q = Number(p.quantity) || 0; map[c].units += q; map[c].val += q * (Number(p.cost) || 0);
    });
    var rows = Object.keys(map).map(function (c) { return { name: c, units: map[c].units, val: map[c].val }; });
    rows.sort(function (a, b) { return b.units - a.units || a.name.localeCompare(b.name); });
    var max = rows.reduce(function (m, r) { return Math.max(m, r.units); }, 0) || 1;
    if (!rows.length) { el("bars").innerHTML = '<li class="empty-line">' + (loaded ? "No categories yet — they appear as you add products." : "Loading…") + '</li>'; return; }
    el("bars").innerHTML = rows.map(function (r) {
      var v = r.units ? Math.max(0.015, r.units / max) : 0;
      return '<li class="bar-row"><span class="bar-name" title="' + esc(r.name) + '">' + esc(r.name) + '</span><span class="bar-track" aria-hidden="true"><span class="bar-fill" style="display:block;--v:' + v.toFixed(4) + '"></span></span><span class="bar-val num">' + plural(r.units, "unit", "units") + ' · ' + inr(r.val) + '</span></li>';
    }).join("");
  }

  function renderChips() {
    var cats = {}, t = totals(), alertN = t.low + t.out;
    products.forEach(function (p) { var c = (p.category || "").trim(); if (c) cats[c] = (cats[c] || 0) + 1; });
    if (ui.cat !== "all" && !cats[ui.cat]) ui.cat = "all";
    if (ui.attn && !alertN) ui.attn = false;
    var html = '<button type="button" class="chip" data-cat="all" aria-pressed="' + (ui.cat === "all" && !ui.attn) + '">All <span class="count num">' + products.length + '</span></button>';
    if (alertN) html += '<button type="button" class="chip attn" data-attn="1" aria-pressed="' + ui.attn + '">' + icon("alert") + 'Needs attention <span class="count num">' + alertN + '</span></button>';
    var keys = Object.keys(cats).sort();
    if (keys.length) html += '<span class="chip-sep" aria-hidden="true"></span>';
    html += keys.map(function (c) {
      return '<button type="button" class="chip" data-cat="' + esc(c) + '" aria-pressed="' + (ui.cat === c) + '">' + esc(cap(c)) + ' <span class="count num">' + cats[c] + '</span></button>';
    }).join("");
    el("catChips").innerHTML = html;
    el("catList").innerHTML = keys.map(function (c) { return '<option value="' + esc(c) + '">'; }).join("");
  }

  function filteredSorted() {
    var q = ui.q.toLowerCase().trim();
    var rows = products.filter(function (p) {
      if (ui.cat !== "all" && (p.category || "").trim() !== ui.cat) return false;
      if (ui.attn && statusOf(p) === "in") return false;
      if (q) { var hay = ((p.name || "") + " " + (p.sku || "") + " " + (p.category || "")).toLowerCase(); if (hay.indexOf(q) < 0) return false; }
      return true;
    });
    var k = ui.sortKey, dir = ui.sortDir === "asc" ? 1 : -1;
    function byName(a, b) { return (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base", numeric: true }); }
    rows.sort(function (a, b) {
      var r;
      if (k === "name") r = byName(a, b) * dir;
      else if (k === "category") r = (a.category || "").localeCompare(b.category || "") * dir;
      else if (k === "status") { var ord = { out: 0, low: 1, "in": 2 }; r = (ord[statusOf(a)] - ord[statusOf(b)]) * dir; }
      else if (k === "value") r = ((Number(a.quantity) || 0) * (Number(a.cost) || 0) - (Number(b.quantity) || 0) * (Number(b.cost) || 0)) * dir;
      else r = ((Number(a[k]) || 0) - (Number(b[k]) || 0)) * dir;
      return r || byName(a, b);
    });
    return rows;
  }

  var SORTABLE = [["name", "Product", ""], ["category", "Category", ""], ["quantity", "Qty", "right"], ["value", "Value", "right"], ["price", "Price", "right"], ["status", "Status", ""]];
  function renderTable() {
    var wrap = el("tableWrap");
    wrap.setAttribute("aria-busy", String(!loaded));
    if (loadError) {
      wrap.innerHTML = '<div class="state" role="alert">' + icon("alert") + '<h3>Could not load inventory</h3><p>' + esc(loadError) + '</p><button type="button" class="btn" id="retryBtn">Try again</button></div>';
      el("retryBtn").addEventListener("click", function () { loadError = null; loaded = false; renderTable(); refresh(); });
      setCount("");
      return;
    }
    if (!loaded) {
      wrap.innerHTML = '<div class="skel-list" aria-label="Loading products">' + [0, 1, 2, 3].map(function () { return '<div class="skel"></div>'; }).join("") + '</div>';
      return;
    }
    if (!products.length) {
      wrap.innerHTML = '<div class="state">' + icon("box") + '<h3>No products yet</h3><p>Add your first product, or import an Excel sheet, to start tracking stock, value and low-stock alerts.</p><div class="row"><button type="button" class="btn btn-primary" data-action="add">Add product</button><button type="button" class="btn" data-action="import">Import Excel</button></div></div>';
      setCount("No products");
      return;
    }
    var rows = filteredSorted();
    setCount(rows.length === products.length ? plural(rows.length, "product", "products") : rows.length + " of " + plural(products.length, "product", "products") + " shown");
    if (!rows.length) {
      wrap.innerHTML = '<div class="state"><h3>No matches</h3><p>Nothing matches your search or filter.</p><button type="button" class="btn" data-action="clear">Clear search and filters</button></div>';
      return;
    }
    var head = '<thead><tr>' + SORTABLE.map(function (c) {
      var active = ui.sortKey === c[0];
      var aria = active ? ' aria-sort="' + (ui.sortDir === "asc" ? "ascending" : "descending") + '"' : "";
      return '<th scope="col" class="' + c[2] + '"' + aria + '><button type="button" class="th-btn" data-sort="' + c[0] + '">' + c[1] + '<span class="sort-ind" aria-hidden="true">' + (active ? (ui.sortDir === "asc" ? "↑" : "↓") : "") + '</span></button></th>';
    }).join("") + '<th scope="col" class="right"><span>Actions</span></th></tr></thead>';
    var body = rows.map(function (p) {
      var q = Number(p.quantity) || 0, st = statusOf(p), name = p.name || "Untitled";
      var thumb;
      if (p.imageId) {
        var cached = store.cachedPhotoUrl(p.imageId);
        thumb = '<img class="thumb" alt="" width="44" height="44" loading="lazy" decoding="async" ' + (cached ? 'src="' + esc(cached) + '"' : 'data-photo="' + esc(p.imageId) + '"') + '>';
      } else thumb = '<div class="thumb ph">' + icon("img") + '</div>';
      var id = esc(p.id), en = esc(name);
      return '<tr data-row="' + id + '">' +
        '<td class="c-prod"><div class="prod-cell">' + thumb + '<div style="min-width:0"><div class="prod-name" title="' + en + '">' + en + '</div><div class="prod-sku mono">' + esc(p.sku || "") + '</div></div></div></td>' +
        '<td class="c-cat"><span class="cat-tag">' + esc(p.category || "—") + '</span></td>' +
        '<td class="c-qty right"><span class="c-label">Quantity</span><div class="qty-edit" data-id="' + id + '" role="group" aria-label="Quantity for ' + en + '"><button type="button" class="qd" aria-label="Decrease">−</button><input class="qi num" type="text" inputmode="numeric" pattern="[0-9]*" value="' + q + '" aria-label="Quantity"><button type="button" class="qu" aria-label="Increase">+</button></div></td>' +
        '<td class="c-val right num"><span class="c-label">Stock value</span><span class="v">' + inr(q * (Number(p.cost) || 0)) + '</span></td>' +
        '<td class="c-sell right num"><span class="c-label">Sells at</span>' + inr(p.price) + '</td>' +
        '<td class="c-status">' + statusHtml(st) + '</td>' +
        '<td class="c-actions right"><div class="row-actions"><button type="button" class="ed" data-id="' + id + '" aria-label="Edit ' + en + '" title="Edit">' + icon("edit") + '</button><button type="button" class="del" data-id="' + id + '" aria-label="Delete ' + en + '" title="Delete">' + icon("trash") + '</button></div></td></tr>';
    }).join("");
    wrap.innerHTML = '<table><caption class="sr-only">Products. Column headers are sort buttons.</caption>' + head + '<tbody>' + body + '</tbody></table>';
    hydratePhotos(wrap);
  }
  function setCount(t) { el("resultCount").textContent = t ? "— " + t : ""; }

  function hydratePhotos(root) {
    root.querySelectorAll("img[data-photo]").forEach(function (img) {
      var id = img.getAttribute("data-photo");
      store.photoUrl(id).then(function (url) { if (url) img.src = url; else swapPlaceholder(img); }).catch(function () { swapPlaceholder(img); });
    });
  }
  function swapPlaceholder(img) { var d = document.createElement("div"); d.className = "thumb ph"; d.innerHTML = icon("img"); img.replaceWith(d); }

  /* ---------- data ---------- */
  var refreshing = null, refreshAgain = false;
  function refresh() {
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = store.list().then(function (list) {
      // hide rows whose delete is still in the undo window
      products = list.filter(function (p) { return !pendingDeletes[p.id]; });
      loaded = true; loadError = null; render();
    }).catch(function (err) {
      loaded = true; loadError = (err && err.message) || "Please check your connection and reload.";
      renderTable();
    }).then(function () {
      refreshing = null;
      if (refreshAgain) { refreshAgain = false; refresh(); }
    });
    return refreshing;
  }
  function byId(id) { for (var i = 0; i < products.length; i++) if (products[i].id === id) return products[i]; return null; }

  /* ---------- events (delegated) ---------- */
  function syncSortSelect() {
    var v = ui.sortKey + ":" + ui.sortDir, sel = el("sortSel");
    var has = Array.prototype.some.call(sel.options, function (o) { return o.value === v; });
    if (!has) { var o = document.createElement("option"); o.value = v; o.textContent = "Custom (from table)"; sel.appendChild(o); }
    sel.value = v;
  }
  function wireEvents() {
    var searchT;
    el("search").addEventListener("input", function (e) { ui.q = e.target.value; clearTimeout(searchT); searchT = setTimeout(renderTable, 120); });
    el("sortSel").addEventListener("change", function (e) { var v = e.target.value.split(":"); ui.sortKey = v[0]; ui.sortDir = v[1]; renderTable(); });
    el("catChips").addEventListener("click", function (e) {
      var b = e.target.closest(".chip"); if (!b) return;
      if (b.hasAttribute("data-attn")) ui.attn = !ui.attn;
      else { ui.cat = b.getAttribute("data-cat"); if (ui.cat === "all") ui.attn = false; }
      renderKpis(); renderChips(); renderTable();
      var same = el("catChips").querySelector(b.hasAttribute("data-attn") ? "[data-attn]" : '[data-cat="' + cssEsc(b.getAttribute("data-cat")) + '"]');
      if (same) same.focus();
    });
    el("kpis").addEventListener("click", function (e) {
      if (!e.target.closest("#attnKpi")) return;
      ui.attn = !ui.attn; renderKpis(); renderChips(); renderTable();
      el("attnKpi").focus();
      if (ui.attn) el("hProducts").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    });
    var wrap = el("tableWrap");
    wrap.addEventListener("click", function (e) {
      var th = e.target.closest("[data-sort]");
      if (th) {
        var k = th.getAttribute("data-sort");
        if (ui.sortKey === k) ui.sortDir = ui.sortDir === "asc" ? "desc" : "asc"; else { ui.sortKey = k; ui.sortDir = (k === "name" || k === "category" || k === "status") ? "asc" : "desc"; }
        renderTable(); syncSortSelect();
        var again = wrap.querySelector('[data-sort="' + k + '"]'); if (again) again.focus();
        return;
      }
      var act = e.target.closest("[data-action]");
      if (act) {
        var a = act.getAttribute("data-action");
        if (a === "add") openSheet(null);
        else if (a === "import") el("importFile").click();
        else if (a === "clear") { ui.q = ""; ui.cat = "all"; ui.attn = false; el("search").value = ""; render(); el("search").focus(); }
        return;
      }
      var ed = e.target.closest(".ed"); if (ed) { openSheet(ed.getAttribute("data-id")); return; }
      var del = e.target.closest(".del"); if (del) { doDelete(del.getAttribute("data-id")); return; }
      var qd = e.target.closest(".qd"); if (qd) { stepQty(qd.closest(".qty-edit").getAttribute("data-id"), -1); return; }
      var qu = e.target.closest(".qu"); if (qu) { stepQty(qu.closest(".qty-edit").getAttribute("data-id"), 1); return; }
    });
    wrap.addEventListener("keydown", function (e) {
      if (!e.target.classList.contains("qi")) return;
      if (e.key === "Enter") e.target.blur();
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault(); stepQty(e.target.closest(".qty-edit").getAttribute("data-id"), e.key === "ArrowUp" ? 1 : -1);
      }
    });
    wrap.addEventListener("focusin", function (e) { if (e.target.classList.contains("qi")) e.target.select(); });
    wrap.addEventListener("change", function (e) {
      var qi = e.target.closest(".qi");
      if (qi) setQty(qi.closest(".qty-edit").getAttribute("data-id"), Math.max(0, Math.round(Number(qi.value.replace(/[^0-9.]/g, "")) || 0)));
    });

    el("addBtn").addEventListener("click", function () { openSheet(null); });
    el("sheetClose").addEventListener("click", closeSheet);
    el("sheetCancel").addEventListener("click", closeSheet);
    el("scrim").addEventListener("click", closeSheet);
    el("sheetSave").addEventListener("click", saveProduct);
    el("productForm").addEventListener("submit", function (e) { e.preventDefault(); saveProduct(); });
    ["fQty", "fCost", "fPrice"].forEach(function (id) { el(id).addEventListener("input", updateCalc); });
    ["fName", "fSku"].forEach(function (id) { el(id).addEventListener("input", function () { clearFieldErr(id); }); });
    el("sheet").addEventListener("keydown", trapFocus);

    el("camBtn").addEventListener("click", function () { el("camInput").click(); });
    el("uploadBtn").addEventListener("click", function () { el("photoInput").click(); });
    el("photoInput").addEventListener("change", handlePhoto);
    el("camInput").addEventListener("change", handlePhoto);
    el("photoRemove").addEventListener("click", function () { setPhotoPreview(null); pendingPhoto = null; el("uploadBtn").focus(); });

    var menu = el("exportMenu"), expBtn = el("exportBtn");
    expBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (menu.hidden) { menu.hidden = false; expBtn.setAttribute("aria-expanded", "true"); menu.querySelector("button").focus(); }
      else closeMenu();
    });
    menu.addEventListener("click", function (e) {
      var b = e.target.closest("[data-export]"); if (!b) return;
      closeMenu(true);
      if (b.getAttribute("data-export") === "xlsx") exportXlsx(); else exportBackup();
    });
    menu.addEventListener("keydown", function (e) {
      var items = Array.prototype.slice.call(menu.querySelectorAll("button")), i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === "Tab") closeMenu();
    });
    document.addEventListener("click", function (e) { if (!e.target.closest(".menu-wrap")) closeMenu(); });
    el("importBtn").addEventListener("click", function () { el("importFile").click(); });
    el("importFile").addEventListener("change", function (e) { var f = e.target.files && e.target.files[0]; if (f) importFile(f); e.target.value = ""; });
    el("toastAction").addEventListener("click", function () { var fn = toastActionFn; hideToast(); if (fn) fn(); });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (!el("exportMenu").hidden) { closeMenu(true); return; }
      if (el("sheet").classList.contains("open")) closeSheet();
    });
    // "/" focuses search, like most inventory tools
    document.addEventListener("keydown", function (e) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      var t = e.target.tagName; if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || el("sheet").classList.contains("open")) return;
      e.preventDefault(); el("search").focus();
    });
    window.addEventListener("pagehide", flushAll);
    window.addEventListener("beforeunload", function (e) {
      if (Object.keys(qtyTimers).length || Object.keys(pendingDeletes).length) { flushAll(); e.preventDefault(); e.returnValue = ""; }
    });
  }
  function closeMenu(refocus) {
    if (el("exportMenu").hidden) return;
    el("exportMenu").hidden = true; el("exportBtn").setAttribute("aria-expanded", "false");
    if (refocus) el("exportBtn").focus();
  }
  function flushAll() { flushQty(); flushDeletes(); }

  /* ---------- quantity (debounced writes) ---------- */
  function stepQty(id, d) { var p = byId(id); if (!p) return; setQty(id, Math.max(0, (Number(p.quantity) || 0) + d)); }
  function setQty(id, v) {
    var p = byId(id); if (!p) return;
    var before = statusOf(p);
    p.quantity = v; p.updatedAt = Date.now();
    renderKpis(); renderBars();
    if (before !== statusOf(p)) renderChips();
    var row = document.querySelector('tr[data-row="' + cssEsc(id) + '"]');
    if (row) {
      var qi = row.querySelector(".qi"); if (document.activeElement !== qi || qi.value !== String(v)) qi.value = v;
      row.querySelector(".c-val .v").textContent = inr(v * (Number(p.cost) || 0));
      row.querySelector(".c-status").innerHTML = statusHtml(statusOf(p));
    }
    clearTimeout(qtyTimers[id]);
    qtyTimers[id] = setTimeout(function () { writeQty(id); }, 500);
  }
  function writeQty(id) {
    delete qtyTimers[id];
    var p = byId(id); if (!p) return;
    store.patch(id, { quantity: p.quantity, updatedAt: p.updatedAt }).catch(function (err) { saveFailed(err); refresh(); });
  }
  function flushQty() { Object.keys(qtyTimers).forEach(function (id) { clearTimeout(qtyTimers[id]); writeQty(id); }); }
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"); }

  /* ---------- delete with undo ---------- */
  function doDelete(id) {
    var p = byId(id); if (!p) return;
    clearTimeout(qtyTimers[id]); delete qtyTimers[id];
    var row = document.querySelector('tr[data-row="' + cssEsc(id) + '"]');
    var next = row && (row.nextElementSibling || row.previousElementSibling);
    var nextId = next && next.getAttribute("data-row");
    products = products.filter(function (x) { return x.id !== id; }); render();
    var focusTarget = nextId && document.querySelector('tr[data-row="' + cssEsc(nextId) + '"] .del');
    (focusTarget || el("search")).focus();
    pendingDeletes[id] = { product: p, timer: setTimeout(function () { commitDelete(id); }, UNDO_MS) };
    toast("Deleted “" + (p.name || "product") + "”", "Undo", function () {
      var pd = pendingDeletes[id]; if (!pd) return;
      clearTimeout(pd.timer); delete pendingDeletes[id];
      products.push(pd.product); render(); toast("Restored");
    }, UNDO_MS);
  }
  function commitDelete(id) {
    var pd = pendingDeletes[id]; if (!pd) return;
    clearTimeout(pd.timer); delete pendingDeletes[id];
    store.remove(pd.product).catch(function (err) { saveFailed(err); refresh(); });
  }
  function flushDeletes() { Object.keys(pendingDeletes).forEach(commitDelete); }

  /* ---------- sheet (add/edit) ---------- */
  var lastFocus = null;
  function setInert(on) {
    ["topbar", "main"].forEach(function (id) { var n = el(id); if (on) n.setAttribute("inert", ""); else n.removeAttribute("inert"); });
  }
  function trapFocus(e) {
    if (e.key !== "Tab") return;
    var f = Array.prototype.filter.call(el("sheet").querySelectorAll("button,input,select,textarea,[tabindex]:not([tabindex='-1'])"), function (n) { return !n.disabled && n.offsetParent !== null && n.tabIndex >= 0; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  function openSheet(id) {
    editingId = id; pendingPhoto = null; el("formErr").hidden = true;
    clearFieldErr("fName"); clearFieldErr("fSku");
    var p = id ? byId(id) : null;
    el("sheetTitle").textContent = id ? "Edit product" : "Add product";
    el("sheetSave").textContent = id ? "Save changes" : "Save product";
    el("sheetSave").disabled = false;
    el("fName").value = p ? p.name || "" : "";
    el("fSku").value = p ? p.sku || "" : "";
    el("fCat").value = p ? p.category || "" : (ui.cat !== "all" ? ui.cat : "");
    el("fQty").value = p && p.quantity != null ? p.quantity : "";
    el("fCost").value = p && p.cost != null ? p.cost : "";
    el("fPrice").value = p && p.price != null ? p.price : "";
    el("fLow").value = p && p.low != null ? p.low : "";
    el("fNotes").value = p ? p.notes || "" : "";
    el("productForm").scrollTop = 0;
    setPhotoPreview(null);
    if (p && p.imageId) {
      pendingPhoto = { id: p.imageId };
      store.photoUrl(p.imageId).then(function (url) { if (url && pendingPhoto && pendingPhoto.id === p.imageId) setPhotoPreview(url); }).catch(function () {});
    }
    updateCalc();
    lastFocus = document.activeElement;
    setInert(true);
    el("scrim").classList.add("open"); el("sheet").classList.add("open");
    setTimeout(function () { el("fName").focus({ preventScroll: true }); }, 60);
  }
  function closeSheet() {
    if (!el("sheet").classList.contains("open")) return;
    el("scrim").classList.remove("open"); el("sheet").classList.remove("open");
    setInert(false);
    if (lastFocus && lastFocus.isConnected && lastFocus.focus) lastFocus.focus();
    if (!document.activeElement || document.activeElement === document.body || el("sheet").contains(document.activeElement)) el("addBtn").focus();
  }
  function setPhotoPreview(url) {
    var img = el("photoImg");
    if (img.dataset.blob) { URL.revokeObjectURL(img.src); delete img.dataset.blob; }
    if (url) { img.src = url; el("photoPrev").hidden = false; el("photoBtns").hidden = true; }
    else { img.removeAttribute("src"); el("photoPrev").hidden = true; el("photoBtns").hidden = false; }
    el("dropHintText").textContent = url ? "drag & drop a new image to replace it" : "or drag & drop an image here";
    el("photoInput").value = ""; el("camInput").value = "";
  }
  function updateCalc() {
    var q = Number(el("fQty").value) || 0, c = Number(el("fCost").value) || 0, pr = Number(el("fPrice").value) || 0;
    el("calcStock").textContent = inr(q * c); el("calcSales").textContent = inr(q * pr);
    var m = el("calcMargin"); m.textContent = inr(pr - c) + (pr && c && pr < c ? " (loss)" : ""); m.classList.toggle("neg", pr - c < 0);
  }
  function handlePhoto(e) {
    var f = e.target.files && e.target.files[0]; if (f) usePhotoFile(f);
  }
  function firstImage(list) {
    for (var i = 0; list && i < list.length; i++) if (/^image\//.test(list[i].type)) return list[i];
    return null;
  }
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0; }
  // Drag & drop anywhere on the open panel, or paste an image from the clipboard.
  function wirePhotoDrop() {
    var sheet = el("sheet"), zone = el("photoDrop"), depth = 0;
    function setDrag(on) { zone.classList.toggle("drag", on); sheet.classList.toggle("drag-any", on); }
    sheet.addEventListener("dragenter", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth++;
      el("dropOverlayText").textContent = el("photoPrev").hidden ? "Drop image to add it" : "Drop image to replace the photo";
      setDrag(true);
    });
    sheet.addEventListener("dragover", function (e) { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
    sheet.addEventListener("dragleave", function (e) { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) setDrag(false); });
    sheet.addEventListener("drop", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; setDrag(false);
      var f = firstImage(e.dataTransfer.files);
      if (f) usePhotoFile(f); else toast("That isn't an image — drop a JPG, PNG or WebP file");
    });
    // stop the browser from opening a file dropped just outside the panel
    window.addEventListener("dragover", function (e) { if (hasFiles(e) && sheet.classList.contains("open")) e.preventDefault(); });
    window.addEventListener("drop", function (e) { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener("paste", function (e) {
      if (!sheet.classList.contains("open") || !e.clipboardData) return;
      var f = firstImage(e.clipboardData.files);
      if (!f) return; // plain text paste into a field stays untouched
      e.preventDefault(); usePhotoFile(f); toast("Photo pasted");
    });
  }
  function usePhotoFile(f) {
    if (!/^image\//.test(f.type)) { toast("Please choose an image file"); return; }
    var job = compressImage(f, 1000, 0.82);
    pendingPhoto = { job: job };
    job.then(function (blob) {
      if (!pendingPhoto || pendingPhoto.job !== job) return;
      setPhotoPreview(URL.createObjectURL(blob)); el("photoImg").dataset.blob = "1";
      el("photoRemove").focus();
    });
  }
  // Downscale large camera photos so storage and loading stay fast.
  function compressImage(file, max, quality) {
    return new Promise(function (res) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { res(b && b.size < file.size ? b : file); }, "image/jpeg", quality);
      };
      img.onerror = function () { URL.revokeObjectURL(url); res(file); };
      img.src = url;
    });
  }

  function fieldErr(id, msg) {
    var input = el(id), errId = id + "Err", node = el(errId);
    if (!node) { node = document.createElement("div"); node.id = errId; node.className = "field-err"; input.parentNode.appendChild(node); }
    node.innerHTML = icon("alert") + "<span>" + esc(msg) + "</span>";
    input.setAttribute("aria-invalid", "true");
    var d = (input.getAttribute("aria-describedby") || "").split(" ").filter(Boolean);
    if (d.indexOf(errId) < 0) { d.unshift(errId); input.setAttribute("aria-describedby", d.join(" ")); }
    input.focus();
  }
  function clearFieldErr(id) {
    var input = el(id), node = el(id + "Err");
    if (node) node.remove();
    input.removeAttribute("aria-invalid");
    var d = (input.getAttribute("aria-describedby") || "").split(" ").filter(function (x) { return x && x !== id + "Err"; });
    if (d.length) input.setAttribute("aria-describedby", d.join(" ")); else input.removeAttribute("aria-describedby");
  }

  function saveProduct() {
    var btn = el("sheetSave");
    if (btn.disabled) return;
    clearFieldErr("fName"); clearFieldErr("fSku"); el("formErr").hidden = true;
    var name = el("fName").value.trim();
    if (!name) { fieldErr("fName", "Enter a product name, e.g. “Gold wheat clutcher”."); return; }
    var sku = el("fSku").value.trim() || slug(name);
    var dup = products.filter(function (p) { return p.id !== editingId && (p.sku || "").toLowerCase() === sku.toLowerCase(); })[0];
    if (dup) { fieldErr("fSku", "“" + sku + "” is already used by “" + dup.name + "”. Use a different code" + (el("fSku").value.trim() ? "." : ", or type one here.")); return; }
    var existing = editingId ? byId(editingId) : null;
    if (editingId && !existing) { showFormErr("This product was deleted on another device. Close this panel and refresh."); return; }
    var now = Date.now();
    var data = {
      id: editingId || window.StockStore.uid("p-"),
      name: name, sku: sku,
      category: el("fCat").value.trim().toLowerCase() || "uncategorized",
      quantity: Math.max(0, Math.round(Number(el("fQty").value) || 0)),
      cost: Math.max(0, Number(el("fCost").value) || 0),
      price: Math.max(0, Number(el("fPrice").value) || 0),
      low: el("fLow").value === "" ? LOW_DEFAULT : Math.max(0, Math.round(Number(el("fLow").value) || 0)),
      notes: el("fNotes").value.trim(),
      imageId: null,
      createdAt: existing ? existing.createdAt || now : now,
      updatedAt: now
    };
    var oldImage = existing && existing.imageId;
    btn.disabled = true; btn.textContent = "Saving…";
    var photoWarn = false;
    var chain = Promise.resolve();
    if (pendingPhoto && pendingPhoto.job) {
      chain = pendingPhoto.job.then(function (blob) { return store.putPhoto(blob); }).then(function (id) { data.imageId = id; }).catch(function () { photoWarn = true; data.imageId = oldImage || null; });
    } else if (pendingPhoto && pendingPhoto.id) data.imageId = pendingPhoto.id;
    if (editingId && qtyTimers[editingId]) { clearTimeout(qtyTimers[editingId]); delete qtyTimers[editingId]; }
    var wasEdit = !!editingId;
    chain.then(function () { return store.save(data); }).then(function () {
      if (oldImage && oldImage !== data.imageId) store.deletePhoto(oldImage).catch(function () {});
      var i = products.indexOf(existing);
      if (i >= 0) products[i] = data; else products.push(data);
      render(); closeSheet();
      var row = document.querySelector('tr[data-row="' + cssEsc(data.id) + '"]');
      if (row) { row.scrollIntoView({ block: "nearest" }); if (!wasEdit) row.querySelector(".ed").focus(); }
      toast(photoWarn ? "Saved, but the photo could not be uploaded" : (wasEdit ? "Changes saved" : "“" + data.name + "” added"));
    }).catch(function (err) {
      btn.disabled = false; btn.textContent = wasEdit ? "Save changes" : "Save product";
      showFormErr("Could not save. " + errText(err));
    });
  }
  function showFormErr(m) { var e = el("formErr"); e.textContent = m; e.hidden = false; el("productForm").scrollTop = 0; }
  function errText(err) {
    if (!navigator.onLine) return "You appear to be offline — reconnect and try again.";
    var m = err && (err.message || err.error_description);
    return m ? m : "Please try again.";
  }
  function saveFailed(err) { toast("Save failed — " + errText(err)); }

  /* ---------- toast ---------- */
  var toastT, toastActionFn = null;
  function toast(m, actionLabel, actionFn, ms) {
    var t = el("toast"), a = el("toastAction");
    el("toastMsg").textContent = m;
    toastActionFn = actionFn || null;
    a.hidden = !actionFn; a.textContent = actionLabel || "";
    t.classList.toggle("has-action", !!actionFn);
    t.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(hideToast, ms || 2800);
  }
  function hideToast() { el("toast").classList.remove("show"); toastActionFn = null; }

  /* ---------- export / import ---------- */
  var xlsxP = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (xlsxP) return xlsxP;
    xlsxP = new Promise(function (res, rej) {
      var s = document.createElement("script"); s.src = XLSX_SRC; s.async = true;
      s.onload = function () { res(window.XLSX); };
      s.onerror = function () { xlsxP = null; rej(new Error("Could not load the Excel library — check your connection.")); };
      document.head.appendChild(s);
    });
    return xlsxP;
  }
  function download(blob, filename) {
    var a = document.createElement("a"), url = URL.createObjectURL(blob);
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }
  function stamp() { return new Date().toISOString().slice(0, 10); }

  function exportXlsx() {
    if (!products.length) { toast("Nothing to export yet"); return; }
    toast("Preparing Excel…");
    loadXlsx().then(function (XLSX) {
      var rows = products.slice().sort(function (a, b) { return (a.name || "").localeCompare(b.name || ""); }).map(function (p) {
        var q = Number(p.quantity) || 0;
        return {
          "Product": p.name || "", "SKU": p.sku || "", "Category": p.category || "", "Quantity": q,
          "Cost Price": Number(p.cost) || 0, "Selling Price": Number(p.price) || 0, "Low Stock At": (p.low == null ? LOW_DEFAULT : p.low),
          "Stock Value": q * (Number(p.cost) || 0), "Potential Sales": q * (Number(p.price) || 0),
          "Status": STATUS[statusOf(p)].label, "Has Photo": p.imageId ? "Yes" : "No", "Notes": p.notes || ""
        };
      });
      var ws = XLSX.utils.json_to_sheet(rows);
      ws["!cols"] = [{ wch: 26 }, { wch: 22 }, { wch: 16 }, { wch: 9 }, { wch: 11 }, { wch: 13 }, { wch: 12 }, { wch: 12 }, { wch: 15 }, { wch: 12 }, { wch: 10 }, { wch: 24 }];
      var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Inventory");
      var buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
      download(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "Stock Room " + stamp() + ".xlsx");
      toast("Excel exported");
    }).catch(function (err) { toast(err.message || "Export failed"); });
  }

  function blobToDataUrl(b) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsDataURL(b); }); }
  function dataUrlToBlob(u) { return fetch(u).then(function (r) { return r.blob(); }); }

  function exportBackup() {
    if (!products.length) { toast("Nothing to back up yet"); return; }
    toast("Preparing backup…");
    var photos = {};
    Promise.all(products.filter(function (p) { return p.imageId; }).map(function (p) {
      return store.photoBlob(p.imageId).then(function (b) { return b && blobToDataUrl(b); })
        .then(function (u) { if (u) photos[p.imageId] = u; }).catch(function () {});
    })).then(function () {
      var data = { app: "stockroom", version: 1, exportedAt: new Date().toISOString(), products: products, photos: photos };
      download(new Blob([JSON.stringify(data)], { type: "application/json" }), "Stock Room backup " + stamp() + ".json");
      toast("Backup downloaded");
    });
  }

  function importFile(file) {
    if (/\.json$/i.test(file.name)) { importBackup(file); return; }
    toast("Reading file…");
    Promise.all([loadXlsx(), file.arrayBuffer()]).then(function (r) {
      var XLSX = r[0], wb = XLSX.read(new Uint8Array(r[1]), { type: "array" });
      var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
      if (!rows.length) { toast("No rows found in that file"); return; }
      importRows(rows);
    }).catch(function (err) { toast((err && err.message) || "Could not read file — use .xlsx or .csv"); });
  }
  function pick(o, keys) {
    var lower = {}; Object.keys(o).forEach(function (k) { lower[k.trim().toLowerCase()] = o[k]; });
    for (var i = 0; i < keys.length; i++) { var v = lower[keys[i]]; if (v !== undefined && v !== "") return v; }
    return "";
  }
  function toNum(v) { if (v === "" || v == null) return 0; var n = Number(String(v).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? 0 : n; }
  function importRows(rows) {
    var bySku = {}; products.forEach(function (p) { if (p.sku) bySku[String(p.sku).toLowerCase()] = p; });
    var out = [], added = 0, updated = 0, now = Date.now();
    rows.forEach(function (r) {
      var name = String(pick(r, ["product", "name", "product name", "item"]) || "").trim();
      var sku = String(pick(r, ["sku", "code", "sku / code", "item code"]) || "").trim();
      if (!name && !sku) return;
      var lowRaw = pick(r, ["low stock at", "low", "low stock", "reorder level"]);
      var data = {
        name: name || sku, sku: sku || slug(name),
        category: String(pick(r, ["category", "type"]) || "uncategorized").trim().toLowerCase() || "uncategorized",
        quantity: Math.max(0, Math.round(toNum(pick(r, ["quantity", "qty", "stock", "units"])))),
        cost: Math.max(0, toNum(pick(r, ["cost price", "cost", "cp", "purchase price"]))),
        price: Math.max(0, toNum(pick(r, ["selling price", "sell", "price", "sp", "mrp"]))),
        low: lowRaw === "" ? LOW_DEFAULT : Math.max(0, Math.round(toNum(lowRaw))),
        notes: String(pick(r, ["notes", "note", "remarks"]) || ""),
        updatedAt: now
      };
      var key = data.sku.toLowerCase(), ex = bySku[key];
      if (ex) { data.id = ex.id; data.imageId = ex.imageId || null; data.createdAt = ex.createdAt || now; if (!ex._seen) updated++; }
      else { data.id = window.StockStore.uid("p-"); data.imageId = null; data.createdAt = now; added++; }
      data._seen = true; bySku[key] = data;
    });
    Object.keys(bySku).forEach(function (k) { if (bySku[k]._seen) { delete bySku[k]._seen; out.push(bySku[k]); } });
    if (!out.length) { toast("No product rows found — the sheet needs a Product or SKU column"); return; }
    store.saveMany(out).then(function () { toast("Imported: " + added + " new, " + updated + " updated"); return refresh(); })
      .catch(function (err) { toast("Import failed — " + errText(err)); });
  }
  function importBackup(file) {
    file.text().then(function (txt) {
      var data = JSON.parse(txt);
      if (!data || data.app !== "stockroom" || !Array.isArray(data.products)) throw new Error("That is not a Stock Room backup file");
      if (!confirm("Restore " + data.products.length + " products from this backup? Products with the same ID will be overwritten.")) return;
      toast("Restoring…");
      var photos = data.photos || {};
      return Promise.all(data.products.map(function (p) {
        var clean = {
          id: String(p.id || window.StockStore.uid("p-")), name: String(p.name || "Untitled"), sku: String(p.sku || ""),
          category: String(p.category || "uncategorized"), quantity: Math.max(0, Math.round(toNum(p.quantity))),
          cost: Math.max(0, toNum(p.cost)), price: Math.max(0, toNum(p.price)),
          low: p.low == null ? LOW_DEFAULT : Math.max(0, Math.round(toNum(p.low))), notes: String(p.notes || ""),
          imageId: null, createdAt: Number(p.createdAt) || Date.now(), updatedAt: Number(p.updatedAt) || Date.now()
        };
        var cur = byId(clean.id);
        var src = p.imageId && photos[p.imageId];
        if (!src) { clean.imageId = cur ? cur.imageId || null : null; return clean; }
        if (cur && cur.imageId === p.imageId) { clean.imageId = cur.imageId; return clean; }
        return dataUrlToBlob(src).then(function (b) { return store.putPhoto(b); })
          .then(function (id) { clean.imageId = id; return clean; }).catch(function () { return clean; });
      })).then(function (list) { return store.saveMany(list).then(function () { toast("Restored " + plural(list.length, "product", "products")); return refresh(); }); });
    }).catch(function (err) { toast((err && err.message) || "Could not read backup"); });
  }

  /* ---------- auth (cloud mode) ---------- */
  var signupMode = false;
  function showAuth() {
    el("appView").hidden = true; el("authView").hidden = false;
    el("authSwitch").hidden = CFG.allowSignup === false;
    setAuthMode(false);
    el("aEmail").focus();
  }
  function setAuthMode(signup) {
    signupMode = signup;
    el("authTitle").textContent = signup ? "Create account" : "Sign in";
    el("authSubmit").textContent = signup ? "Create account" : "Sign in";
    el("authSwitchText").textContent = signup ? "Already have an account?" : "New here?";
    el("authToggle").textContent = signup ? "Sign in" : "Create account";
    el("aPass").setAttribute("autocomplete", signup ? "new-password" : "current-password");
    el("authErr").hidden = true; el("authOk").hidden = true; el("authHelp").hidden = true;
  }
  function wireAuth() {
    el("authToggle").addEventListener("click", function () { setAuthMode(!signupMode); el("aEmail").focus(); });
    el("pwToggle").addEventListener("click", function () {
      var show = el("aPass").type === "password";
      el("aPass").type = show ? "text" : "password";
      this.textContent = show ? "Hide" : "Show"; this.setAttribute("aria-pressed", String(show));
    });
    el("authForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var email = el("aEmail").value.trim(), pass = el("aPass").value, btn = el("authSubmit");
      el("authErr").hidden = true; el("authOk").hidden = true;
      if (!/^\S+@\S+\.\S+$/.test(email)) { el("aEmail").focus(); return authErr("Enter a valid email address, like name@example.com."); }
      if (pass.length < 6) { el("aPass").focus(); return authErr("Password must be at least 6 characters."); }
      btn.disabled = true; btn.textContent = signupMode ? "Creating account…" : "Signing in…";
      var p = signupMode ? store.signUp(email, pass) : store.signIn(email, pass);
      p.then(function (r) {
        if (signupMode && !(r && r.session)) {
          setAuthMode(false);
          el("authOk").textContent = "Account created. Check your email to confirm it, then sign in.";
          el("authOk").hidden = false;
        }
        // Signed in: store.onAuth() switches to the app.
      }).catch(function (err) { authFail(err, email); })
        .then(function () { btn.disabled = false; btn.textContent = signupMode ? "Create account" : "Sign in"; });
    });
    el("signOutBtn").addEventListener("click", function () {
      flushAll();
      store.signOut().then(function () { products = []; loaded = false; showAuth(); });
    });
  }
  function authErr(m) { var e = el("authErr"); e.textContent = m; e.hidden = false; }
  function authOk(m) { var e = el("authOk"); e.textContent = m; e.hidden = false; }
  // Turn Supabase's terse auth errors into instructions the user can act on.
  function authFail(err, email) {
    var code = (err && (err.code || "")) + " " + ((err && err.message) || "");
    if (/email_not_confirmed|not confirmed/i.test(code)) {
      authErr("Your email is not confirmed yet. Open the confirmation email from Supabase (check Spam too) and tap the link, then sign in. Didn't get it? Resend it below.");
      el("authHelp").hidden = false;
    } else if (/invalid_credentials|invalid login/i.test(code)) {
      authErr("Email or password is incorrect. Check for typos, or use “Forgot password?” to set a new one.");
    } else if (/signup.*disabled|signups not allowed/i.test(code)) {
      authErr("New accounts are turned off for this app. Sign in with your existing account.");
    } else if (/rate limit|too many/i.test(code)) {
      authErr("Too many attempts. Wait a minute and try again.");
    } else if (!navigator.onLine || /fetch|network/i.test(code)) {
      authErr("Can't reach the server. Check your internet connection and try again.");
    } else {
      authErr((err && err.message) || "Could not sign in. Please try again.");
    }
  }
  function wireAuthHelp() {
    el("resendBtn").addEventListener("click", function () {
      var email = el("aEmail").value.trim(), b = this;
      if (!/^\S+@\S+\.\S+$/.test(email)) { el("aEmail").focus(); return authErr("Enter your email address above first."); }
      b.disabled = true; b.textContent = "Sending…";
      store.resendConfirm(email).then(function () {
        el("authErr").hidden = true; authOk("Confirmation email sent to " + email + ". Open it, tap the link, then come back and sign in.");
      }).catch(function (err) { authFail(err, email); })
        .then(function () { b.disabled = false; b.textContent = "Resend confirmation email"; });
    });
    el("forgotBtn").addEventListener("click", function () {
      var email = el("aEmail").value.trim();
      el("authErr").hidden = true; el("authOk").hidden = true;
      if (!/^\S+@\S+\.\S+$/.test(email)) { el("aEmail").focus(); return authErr("Type your email address above, then tap “Forgot password?” again."); }
      store.resetPassword(email).then(function () {
        authOk("Password reset link sent to " + email + ". Open it on this device to choose a new password.");
      }).catch(function (err) { authFail(err, email); });
    });
  }
  // Arriving from a password-reset email: ask for the new password right away.
  function askNewPassword() {
    var pw = prompt("Choose a new password (at least 6 characters):");
    if (!pw) return;
    if (pw.length < 6) { alert("Password must be at least 6 characters."); return askNewPassword(); }
    store.updatePassword(pw).then(function () { toast("Password updated"); })
      .catch(function (err) { alert("Could not update password: " + ((err && err.message) || "please try again")); });
  }

  /* ---------- boot ---------- */
  var started = false;
  function startApp(user) {
    el("authView").hidden = true; el("appView").hidden = false;
    var badge = el("modeBadge");
    if (store.mode === "cloud") {
      el("modeText").textContent = "Synced · " + ((user && user.email) || "");
      badge.className = "badge cloud"; badge.querySelector("use").setAttribute("href", "#i-cloud");
      badge.title = "Saved to your cloud account";
      el("signOutBtn").hidden = false;
    } else {
      el("modeText").textContent = "Saved on this device";
      badge.className = "badge"; badge.title = "Data is stored in this browser only";
      var dismissed = false; try { dismissed = localStorage.getItem("sr-local-notice") === "1"; } catch (e) {}
      el("localNotice").hidden = dismissed;
    }
    syncSortSelect();
    loaded = false; render(); refresh();
    if (!started) {
      started = true;
      var t; store.onChange(function () { clearTimeout(t); t = setTimeout(refresh, 250); });
      document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") refresh(); else flushAll(); });
    }
  }

  initTheme(); wireEvents(); wirePhotoDrop(); wireAuth(); if (store.mode === "cloud") wireAuthHelp();
  el("localNoticeClose").addEventListener("click", function () { el("localNotice").hidden = true; try { localStorage.setItem("sr-local-notice", "1"); } catch (e) {} el("main").focus(); });

  var fromRecoveryLink = /type=recovery/.test(location.hash + location.search);
  store.init().then(function (r) {
    if (fromRecoveryLink && r.user) setTimeout(askNewPassword, 400);
    if (store.mode === "cloud") {
      var onAuth = function (u) { if (u) startApp(u); else showAuth(); };
      onAuth.recovery = function () { if (!fromRecoveryLink) setTimeout(askNewPassword, 300); };
      store.onAuth(onAuth);
      if (r.user) startApp(r.user); else showAuth();
    } else startApp(null);
  }).catch(function (err) {
    el("authView").hidden = true; el("appView").hidden = false;
    loaded = true; loadError = (err && err.message) || "Storage is not available in this browser.";
    render();
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
  }
})();
