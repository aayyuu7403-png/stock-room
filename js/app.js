(function () {
  "use strict";
  var CFG = window.STOCKROOM_CONFIG || {};
  var LOW_DEFAULT = Number(CFG.lowStockDefault) >= 0 ? Number(CFG.lowStockDefault) : 5;
  var XLSX_SRC = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";

  var store = window.StockStore.create(CFG);
  var products = [], loaded = false, loadError = null;
  var ui = { q: "", cat: "all", sortKey: "name", sortDir: "asc" };
  var editingId = null, pendingPhoto = null; // {job: Promise<Blob>} for a new photo, {id} for the existing one
  var qtyTimers = {};

  var el = function (id) { return document.getElementById(id); };
  function inr(n) { n = Math.round(Number(n) || 0); return "₹" + n.toLocaleString("en-IN"); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function slug(s) { return String(s || "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || ("ITEM-" + Date.now().toString(36).toUpperCase()); }
  function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }

  /* ---------- theme ---------- */
  function initTheme() {
    el("themeBtn").addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      var sysDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      var next = cur ? (cur === "dark" ? "light" : "dark") : (sysDark ? "light" : "dark");
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("sr-theme", next); } catch (e) {}
    });
  }

  /* ---------- derived ---------- */
  function statusOf(p) { var low = (p.low == null ? LOW_DEFAULT : p.low); var q = Number(p.quantity) || 0; if (q <= 0) return "out"; if (q <= low) return "low"; return "in"; }
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

  function renderKpis() {
    var t = totals(), alertN = t.low + t.out;
    var tiles = [
      { ic: '<path d="M20 7L12 3 4 7v10l8 4 8-4z"/><path d="M4 7l8 4 8-4M12 11v10"/>', lab: "Products", val: t.count.toLocaleString("en-IN"), sub: "active SKUs" },
      { ic: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v16"/>', lab: "Units in stock", val: t.units.toLocaleString("en-IN"), sub: "total pieces" },
      { ic: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9a2.5 2.5 0 0 0-2.5-2h-1a2 2 0 0 0 0 4h1a2 2 0 0 1 0 4h-1A2.5 2.5 0 0 1 9.5 15"/><path d="M12 6v1.5M12 16v1.5"/>', lab: "Stock value", val: inr(t.stockVal), sub: "at cost price" },
      { ic: '<path d="M3 17l6-6 4 4 7-7"/><path d="M17 8h4v4"/>', lab: "Potential sales", val: inr(t.sales), sub: "at selling price" },
      { ic: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>', lab: "Needs attention", val: alertN.toLocaleString("en-IN"), sub: t.out + " out · " + t.low + " low", alert: true, none: alertN === 0 }
    ];
    el("kpis").innerHTML = tiles.map(function (k) {
      return '<div class="kpi' + (k.alert ? " alert span" : "") + (k.none ? " none" : "") + '"><div class="k-top"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + k.ic + '</svg>' + k.lab + '</div><div class="k-val num">' + k.val + '</div><div class="k-sub">' + k.sub + '</div></div>';
    }).join("");
  }

  function renderBars() {
    var map = {};
    products.forEach(function (p) {
      var c = (p.category || "").trim() || "uncategorized";
      if (!map[c]) map[c] = { units: 0, val: 0 };
      var q = Number(p.quantity) || 0; map[c].units += q; map[c].val += q * (Number(p.cost) || 0);
    });
    var rows = Object.keys(map).map(function (c) { return { name: c, units: map[c].units, val: map[c].val }; });
    rows.sort(function (a, b) { return b.units - a.units; });
    var max = rows.reduce(function (m, r) { return Math.max(m, r.units); }, 0) || 1;
    if (!rows.length) { el("bars").innerHTML = '<div style="color:var(--fg-faint);font-size:13px">No categories yet.</div>'; return; }
    el("bars").innerHTML = rows.map(function (r) {
      return '<div class="bar-row"><div class="bar-name" title="' + esc(r.name) + '">' + esc(r.name) + '</div><div class="bar-track"><div class="bar-fill" style="width:' + (r.units / max * 100) + '%"></div></div><div class="bar-val num">' + r.units.toLocaleString("en-IN") + ' u · ' + inr(r.val) + '</div></div>';
    }).join("");
  }

  function renderChips() {
    var cats = {};
    products.forEach(function (p) { var c = (p.category || "").trim(); if (c) cats[c] = (cats[c] || 0) + 1; });
    if (ui.cat !== "all" && !cats[ui.cat]) ui.cat = "all";
    var list = ["all"].concat(Object.keys(cats).sort());
    el("catChips").innerHTML = list.map(function (c) {
      var lab = c === "all" ? "All" : c;
      return '<button class="chip' + (ui.cat === c ? " active" : "") + '" data-cat="' + esc(c) + '" aria-pressed="' + (ui.cat === c) + '">' + esc(cap(lab)) + (c !== "all" ? ' <span class="num" style="opacity:.6">' + cats[c] + '</span>' : '') + '</button>';
    }).join("");
    el("catList").innerHTML = Object.keys(cats).sort().map(function (c) { return '<option value="' + esc(c) + '">'; }).join("");
  }

  function filteredSorted() {
    var q = ui.q.toLowerCase().trim();
    var rows = products.filter(function (p) {
      if (ui.cat !== "all" && (p.category || "").trim() !== ui.cat) return false;
      if (q) { var hay = ((p.name || "") + " " + (p.sku || "") + " " + (p.category || "")).toLowerCase(); if (hay.indexOf(q) < 0) return false; }
      return true;
    });
    var k = ui.sortKey, dir = ui.sortDir === "asc" ? 1 : -1;
    rows.sort(function (a, b) {
      var av, bv;
      if (k === "name" || k === "category") { av = (a[k] || "").toLowerCase(); bv = (b[k] || "").toLowerCase(); return av < bv ? -dir : av > bv ? dir : 0; }
      if (k === "status") { var ord = { out: 0, low: 1, "in": 2 }; return (ord[statusOf(a)] - ord[statusOf(b)]) * dir; }
      if (k === "value") { av = (Number(a.quantity) || 0) * (Number(a.cost) || 0); bv = (Number(b.quantity) || 0) * (Number(b.cost) || 0); return (av - bv) * dir; }
      av = Number(a[k]) || 0; bv = Number(b[k]) || 0; return (av - bv) * dir;
    });
    return rows;
  }

  var PH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M21 15l-5-5L5 21"/><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/></svg>';

  function renderTable() {
    var wrap = el("tableWrap");
    if (loadError) {
      wrap.innerHTML = '<div class="state"><h3>Could not load inventory</h3><p>' + esc(loadError) + '</p><button class="btn" id="retryBtn">Try again</button></div>';
      el("retryBtn").addEventListener("click", function () { loadError = null; loaded = false; renderTable(); refresh(); });
      return;
    }
    if (!loaded) {
      wrap.innerHTML = '<div style="padding:16px">' + [72, 64, 80, 58].map(function (w) { return '<div class="skel" style="margin:12px 0;width:' + w + '%"></div>'; }).join("") + '</div>';
      return;
    }
    if (!products.length) {
      wrap.innerHTML = '<div class="state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 7L12 3 4 7v10l8 4 8-4z"/><path d="M4 7l8 4 8-4M12 11v10"/></svg><h3>No products yet</h3><p>Add your first product, or import an Excel sheet, to start tracking stock, value and low-stock alerts.</p><button class="btn btn-primary" data-action="add">Add product</button></div>';
      return;
    }
    var rows = filteredSorted();
    if (!rows.length) { wrap.innerHTML = '<div class="state"><h3>No matches</h3><p>Nothing matches your search or filter.</p></div>'; return; }
    function hd(key, label, cls) {
      var active = ui.sortKey === key, ind = active ? (ui.sortDir === "asc" ? " ↑" : " ↓") : "";
      return '<th class="' + (cls || "") + '" data-sort="' + key + '" aria-sort="' + (active ? (ui.sortDir === "asc" ? "ascending" : "descending") : "none") + '" tabindex="0">' + label + '<span class="sort-ind">' + ind + '</span></th>';
    }
    var head = '<thead><tr>' + hd("name", "Product") + hd("category", "Category") + hd("quantity", "Qty", "right") + hd("value", "Stock value", "right") + hd("price", "Sell ₹", "right") + hd("status", "Status") + '<th class="no-sort right">Actions</th></tr></thead>';
    var body = rows.map(function (p) {
      var q = Number(p.quantity) || 0, st = statusOf(p);
      var stLab = { "in": "In stock", low: "Low", out: "Out" }[st];
      var thumb;
      if (p.imageId) {
        var cached = store.cachedPhotoUrl(p.imageId);
        thumb = cached ? '<img class="thumb" src="' + esc(cached) + '" alt="">' : '<img class="thumb" data-photo="' + esc(p.imageId) + '" alt="">';
      } else thumb = '<div class="thumb ph">' + PH_SVG + '</div>';
      var id = esc(p.id);
      return '<tr><td><div class="prod-cell">' + thumb + '<div style="min-width:0"><div class="prod-name" title="' + esc(p.name) + '">' + esc(p.name || "Untitled") + '</div><div class="prod-sku mono">' + esc(p.sku || "") + '</div></div></div></td>' +
        '<td><span class="cat-tag">' + esc(p.category || "—") + '</span></td>' +
        '<td class="right"><div class="qty-edit" data-id="' + id + '"><button class="qd" aria-label="Decrease quantity">−</button><input class="qi num" type="text" inputmode="numeric" value="' + q + '" aria-label="Quantity for ' + esc(p.name) + '"><button class="qu" aria-label="Increase quantity">+</button></div></td>' +
        '<td class="right num">' + inr(q * (Number(p.cost) || 0)) + '</td>' +
        '<td class="right num">' + inr(p.price) + '</td>' +
        '<td><span class="status ' + st + '">' + stLab + '</span></td>' +
        '<td class="right" style="position:relative"><div class="row-actions"><button class="ed" data-id="' + id + '" title="Edit" aria-label="Edit ' + esc(p.name) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button><button class="del" data-id="' + id + '" title="Delete" aria-label="Delete ' + esc(p.name) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button></div></td></tr>';
    }).join("");
    wrap.innerHTML = '<table>' + head + '<tbody>' + body + '</tbody></table>';
    hydratePhotos(wrap);
  }

  function hydratePhotos(root) {
    root.querySelectorAll("img[data-photo]").forEach(function (img) {
      var id = img.getAttribute("data-photo");
      store.photoUrl(id).then(function (url) { if (url) img.src = url; else swapPlaceholder(img); }).catch(function () { swapPlaceholder(img); });
    });
  }
  function swapPlaceholder(img) { var d = document.createElement("div"); d.className = "thumb ph"; d.innerHTML = PH_SVG; img.replaceWith(d); }

  /* ---------- data ---------- */
  var refreshing = null, refreshAgain = false;
  function refresh() {
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = store.list().then(function (list) {
      products = list; loaded = true; loadError = null; render();
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
  function wireEvents() {
    el("search").addEventListener("input", function (e) { ui.q = e.target.value; renderTable(); });
    el("catChips").addEventListener("click", function (e) { var b = e.target.closest(".chip"); if (!b) return; ui.cat = b.getAttribute("data-cat"); renderChips(); renderTable(); });
    var wrap = el("tableWrap");
    function sortBy(th) { var k = th.getAttribute("data-sort"); if (ui.sortKey === k) ui.sortDir = ui.sortDir === "asc" ? "desc" : "asc"; else { ui.sortKey = k; ui.sortDir = (k === "name" || k === "category") ? "asc" : "desc"; } renderTable(); }
    wrap.addEventListener("click", function (e) {
      var th = e.target.closest("th[data-sort]"); if (th) { sortBy(th); return; }
      if (e.target.closest("[data-action=add]")) { openSheet(null); return; }
      var ed = e.target.closest(".ed"); if (ed) { openSheet(ed.getAttribute("data-id")); return; }
      var del = e.target.closest(".del"); if (del) { askDelete(del); return; }
      var qd = e.target.closest(".qd"); if (qd) { stepQty(qd.closest(".qty-edit").getAttribute("data-id"), -1); return; }
      var qu = e.target.closest(".qu"); if (qu) { stepQty(qu.closest(".qty-edit").getAttribute("data-id"), 1); return; }
    });
    wrap.addEventListener("keydown", function (e) {
      var th = e.target.closest("th[data-sort]"); if (th && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); sortBy(th); }
      if (e.target.classList.contains("qi") && e.key === "Enter") e.target.blur();
    });
    wrap.addEventListener("change", function (e) {
      var qi = e.target.closest(".qi");
      if (qi) setQty(qi.closest(".qty-edit").getAttribute("data-id"), Math.max(0, Math.round(Number(qi.value) || 0)));
    });

    el("addBtn").addEventListener("click", function () { openSheet(null); });
    el("sheetClose").addEventListener("click", closeSheet);
    el("sheetCancel").addEventListener("click", closeSheet);
    el("scrim").addEventListener("click", closeSheet);
    el("sheetSave").addEventListener("click", saveProduct);
    el("productForm").addEventListener("submit", function (e) { e.preventDefault(); saveProduct(); });
    ["fQty", "fCost", "fPrice"].forEach(function (id) { el(id).addEventListener("input", updateCalc); });

    el("camBtn").addEventListener("click", function () { el("camInput").click(); });
    el("uploadBtn").addEventListener("click", function () { el("photoInput").click(); });
    el("photoInput").addEventListener("change", handlePhoto);
    el("camInput").addEventListener("change", handlePhoto);
    el("photoRemove").addEventListener("click", function () { setPhotoPreview(null); pendingPhoto = null; });

    var menu = el("exportMenu"), expBtn = el("exportBtn");
    expBtn.addEventListener("click", function (e) { e.stopPropagation(); var open = menu.hidden; menu.hidden = !open; expBtn.setAttribute("aria-expanded", String(open)); });
    menu.addEventListener("click", function (e) {
      var b = e.target.closest("[data-export]"); if (!b) return;
      closeMenu();
      if (b.getAttribute("data-export") === "xlsx") exportXlsx(); else exportBackup();
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".menu-wrap")) closeMenu();
      if (!e.target.closest(".confirm") && !e.target.closest(".del")) document.querySelectorAll(".confirm").forEach(function (c) { c.remove(); });
    });
    el("importBtn").addEventListener("click", function () { el("importFile").click(); });
    el("importFile").addEventListener("change", function (e) { var f = e.target.files && e.target.files[0]; if (f) importFile(f); e.target.value = ""; });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      closeMenu(); document.querySelectorAll(".confirm").forEach(function (c) { c.remove(); });
      if (el("sheet").classList.contains("open")) closeSheet();
    });
    window.addEventListener("beforeunload", function (e) {
      if (Object.keys(qtyTimers).length) { flushQty(); e.preventDefault(); e.returnValue = ""; }
    });
  }
  function closeMenu() { el("exportMenu").hidden = true; el("exportBtn").setAttribute("aria-expanded", "false"); }

  /* ---------- quantity (debounced writes) ---------- */
  function stepQty(id, d) { var p = byId(id); if (!p) return; setQty(id, Math.max(0, (Number(p.quantity) || 0) + d)); }
  function setQty(id, v) {
    var p = byId(id); if (!p) return;
    p.quantity = v; p.updatedAt = Date.now();
    renderKpis(); renderBars();
    var row = document.querySelector('.qty-edit[data-id="' + cssEsc(id) + '"]');
    if (row) {
      row.querySelector(".qi").value = v;
      var tr = row.closest("tr"), st = statusOf(p);
      tr.children[3].textContent = inr(v * (Number(p.cost) || 0));
      var s = tr.querySelector(".status"); s.className = "status " + st; s.textContent = { "in": "In stock", low: "Low", out: "Out" }[st];
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
  function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }

  /* ---------- delete with inline confirm ---------- */
  function askDelete(btn) {
    var id = btn.getAttribute("data-id"), cell = btn.closest("td");
    var ex = cell.querySelector(".confirm"); if (ex) { ex.remove(); return; }
    document.querySelectorAll(".confirm").forEach(function (c) { c.remove(); });
    var box = document.createElement("div"); box.className = "confirm"; box.setAttribute("role", "alertdialog");
    box.innerHTML = '<p>Delete this product? This cannot be undone.</p><div class="row"><button class="no">Cancel</button><button class="yes">Delete</button></div>';
    cell.appendChild(box);
    box.querySelector(".yes").focus();
    box.querySelector(".no").addEventListener("click", function () { box.remove(); });
    box.querySelector(".yes").addEventListener("click", function () { box.remove(); doDelete(id); });
  }
  function doDelete(id) {
    var p = byId(id); if (!p) return;
    clearTimeout(qtyTimers[id]); delete qtyTimers[id];
    products = products.filter(function (x) { return x.id !== id; }); render();
    store.remove(p).then(function () { toast("Product deleted"); }).catch(function (err) { saveFailed(err); refresh(); });
  }

  /* ---------- sheet (add/edit) ---------- */
  var lastFocus = null;
  function openSheet(id) {
    editingId = id; pendingPhoto = null; el("formErr").hidden = true;
    var p = id ? byId(id) : null;
    el("sheetTitle").textContent = id ? "Edit product" : "Add product";
    el("sheetSave").textContent = id ? "Save changes" : "Save product";
    el("sheetSave").disabled = false;
    el("fName").value = p ? p.name || "" : "";
    el("fSku").value = p ? p.sku || "" : "";
    el("fCat").value = p ? p.category || "" : "";
    el("fQty").value = p && p.quantity != null ? p.quantity : "";
    el("fCost").value = p && p.cost != null ? p.cost : "";
    el("fPrice").value = p && p.price != null ? p.price : "";
    el("fLow").value = p && p.low != null ? p.low : "";
    el("fNotes").value = p ? p.notes || "" : "";
    setPhotoPreview(null);
    if (p && p.imageId) {
      pendingPhoto = { id: p.imageId };
      store.photoUrl(p.imageId).then(function (url) { if (url && pendingPhoto && pendingPhoto.id === p.imageId) setPhotoPreview(url); }).catch(function () {});
    }
    updateCalc();
    lastFocus = document.activeElement;
    el("scrim").classList.add("open"); el("sheet").classList.add("open"); el("sheet").setAttribute("aria-hidden", "false");
    setTimeout(function () { el("fName").focus(); }, 260);
  }
  function closeSheet() {
    el("scrim").classList.remove("open"); el("sheet").classList.remove("open"); el("sheet").setAttribute("aria-hidden", "true");
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function setPhotoPreview(url) {
    var img = el("photoImg");
    if (img.dataset.blob) { URL.revokeObjectURL(img.src); delete img.dataset.blob; }
    if (url) { img.src = url; el("photoPrev").hidden = false; el("photoBtns").hidden = true; }
    else { img.removeAttribute("src"); el("photoPrev").hidden = true; el("photoBtns").hidden = false; }
    el("photoInput").value = ""; el("camInput").value = "";
  }
  function updateCalc() {
    var q = Number(el("fQty").value) || 0, c = Number(el("fCost").value) || 0, pr = Number(el("fPrice").value) || 0;
    el("calcStock").textContent = inr(q * c); el("calcSales").textContent = inr(q * pr); el("calcMargin").textContent = inr(pr - c);
  }
  function handlePhoto(e) {
    var f = e.target.files && e.target.files[0]; if (!f) return;
    if (!/^image\//.test(f.type)) { toast("Please choose an image file"); return; }
    var job = compressImage(f, 1000, 0.82);
    pendingPhoto = { job: job };
    job.then(function (blob) {
      if (!pendingPhoto || pendingPhoto.job !== job) return;
      setPhotoPreview(URL.createObjectURL(blob)); el("photoImg").dataset.blob = "1";
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

  function saveProduct() {
    var btn = el("sheetSave");
    if (btn.disabled) return;
    var name = el("fName").value.trim();
    if (!name) { showFormErr("Please enter a product name."); el("fName").focus(); return; }
    var sku = el("fSku").value.trim() || slug(name);
    var dup = products.filter(function (p) { return p.id !== editingId && (p.sku || "").toLowerCase() === sku.toLowerCase(); })[0];
    if (dup) { showFormErr("SKU “" + sku + "” is already used by “" + dup.name + "”."); el("fSku").focus(); return; }
    var existing = editingId ? byId(editingId) : null;
    if (editingId && !existing) { showFormErr("This product was deleted elsewhere."); return; }
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
    btn.disabled = true; btn.textContent = "Saving…"; el("formErr").hidden = true;
    var photoWarn = false;
    var chain = Promise.resolve();
    if (pendingPhoto && pendingPhoto.job) {
      chain = pendingPhoto.job.then(function (blob) { return store.putPhoto(blob); }).then(function (id) { data.imageId = id; }).catch(function () { photoWarn = true; data.imageId = oldImage || null; });
    } else if (pendingPhoto && pendingPhoto.id) data.imageId = pendingPhoto.id;
    if (editingId && qtyTimers[editingId]) { clearTimeout(qtyTimers[editingId]); delete qtyTimers[editingId]; }
    chain.then(function () { return store.save(data); }).then(function () {
      if (oldImage && oldImage !== data.imageId) store.deletePhoto(oldImage).catch(function () {});
      var i = products.indexOf(existing);
      if (i >= 0) products[i] = data; else products.push(data);
      render(); closeSheet();
      toast(photoWarn ? "Saved, but photo upload failed" : (editingId ? "Changes saved" : "Product added"));
    }).catch(function (err) {
      btn.disabled = false; btn.textContent = editingId ? "Save changes" : "Save product";
      showFormErr("Could not save. " + errText(err));
    });
  }
  function showFormErr(m) { var e = el("formErr"); e.textContent = m; e.hidden = false; }
  function errText(err) {
    if (!navigator.onLine) return "You appear to be offline.";
    var m = err && (err.message || err.error_description);
    return m ? m : "Please try again.";
  }
  function saveFailed(err) { toast("Save failed — " + errText(err)); }

  var toastT;
  function toast(m) { var t = el("toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("show"); }, 2600); }

  /* ---------- export / import ---------- */
  var xlsxP = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (xlsxP) return xlsxP;
    xlsxP = new Promise(function (res, rej) {
      var s = document.createElement("script"); s.src = XLSX_SRC; s.async = true;
      s.onload = function () { res(window.XLSX); };
      s.onerror = function () { xlsxP = null; rej(new Error("Could not load Excel library — check your connection.")); };
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
          "Status": { "in": "In stock", low: "Low", out: "Out" }[statusOf(p)], "Has Photo": p.imageId ? "Yes" : "No", "Notes": p.notes || ""
        };
      });
      var ws = XLSX.utils.json_to_sheet(rows);
      ws["!cols"] = [{ wch: 26 }, { wch: 22 }, { wch: 16 }, { wch: 9 }, { wch: 11 }, { wch: 13 }, { wch: 12 }, { wch: 12 }, { wch: 15 }, { wch: 10 }, { wch: 10 }, { wch: 24 }];
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
      if (!rows.length) { toast("No rows found in file"); return; }
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
    if (!out.length) { toast("No product rows found — need a Product or SKU column"); return; }
    store.saveMany(out).then(function () { toast("Imported: " + added + " new, " + updated + " updated"); return refresh(); })
      .catch(function (err) { toast("Import failed — " + errText(err)); });
  }
  function importBackup(file) {
    file.text().then(function (txt) {
      var data = JSON.parse(txt);
      if (!data || data.app !== "stockroom" || !Array.isArray(data.products)) throw new Error("Not a Stock Room backup file");
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
      })).then(function (list) { return store.saveMany(list).then(function () { toast("Restored " + list.length + " products"); return refresh(); }); });
    }).catch(function (err) { toast((err && err.message) || "Could not read backup"); });
  }

  /* ---------- auth (cloud mode) ---------- */
  var signupMode = false;
  function showAuth() {
    el("appView").hidden = true; el("authView").hidden = false;
    el("authSwitch").hidden = CFG.allowSignup === false;
    setAuthMode(false);
  }
  function setAuthMode(signup) {
    signupMode = signup;
    el("authTitle").textContent = signup ? "Create account" : "Sign in";
    el("authSubmit").textContent = signup ? "Create account" : "Sign in";
    el("authSwitchText").textContent = signup ? "Already have an account?" : "New here?";
    el("authToggle").textContent = signup ? "Sign in" : "Create account";
    el("aPass").setAttribute("autocomplete", signup ? "new-password" : "current-password");
    el("authErr").hidden = true; el("authOk").hidden = true;
  }
  function wireAuth() {
    el("authToggle").addEventListener("click", function () { setAuthMode(!signupMode); });
    el("authForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var email = el("aEmail").value.trim(), pass = el("aPass").value, btn = el("authSubmit");
      el("authErr").hidden = true; el("authOk").hidden = true;
      if (!/^\S+@\S+\.\S+$/.test(email)) return authErr("Enter a valid email address.");
      if (pass.length < 6) return authErr("Password must be at least 6 characters.");
      btn.disabled = true;
      var p = signupMode ? store.signUp(email, pass) : store.signIn(email, pass);
      p.then(function (r) {
        if (signupMode && !(r && r.session)) {
          el("authOk").textContent = "Account created. Check your email to confirm, then sign in.";
          el("authOk").hidden = false; setAuthMode(false); el("authOk").hidden = false;
          return;
        }
        // Signed in: store.onAuth() switches to the app.
      }).catch(function (err) { authErr((err && err.message) || "Could not sign in."); })
        .then(function () { btn.disabled = false; });
    });
    el("signOutBtn").addEventListener("click", function () {
      flushQty();
      store.signOut().then(function () { products = []; loaded = false; showAuth(); });
    });
  }
  function authErr(m) { var e = el("authErr"); e.textContent = m; e.hidden = false; }

  /* ---------- boot ---------- */
  var started = false;
  function startApp(user) {
    el("authView").hidden = true; el("appView").hidden = false;
    var badge = el("modeBadge");
    if (store.mode === "cloud") {
      badge.textContent = "Synced · " + ((user && user.email) || ""); badge.className = "badge cloud"; badge.title = "Saved to your cloud account";
      el("signOutBtn").hidden = false;
    } else {
      badge.textContent = "This device only"; badge.className = "badge"; badge.title = "Data is stored in this browser";
      var dismissed = false; try { dismissed = localStorage.getItem("sr-local-notice") === "1"; } catch (e) {}
      el("localNotice").hidden = dismissed;
    }
    loaded = false; render(); refresh();
    if (!started) {
      started = true;
      var t; store.onChange(function () { clearTimeout(t); t = setTimeout(refresh, 250); });
      document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") refresh(); else flushQty(); });
    }
  }

  initTheme(); wireEvents(); wireAuth();
  el("localNoticeClose").addEventListener("click", function () { el("localNotice").hidden = true; try { localStorage.setItem("sr-local-notice", "1"); } catch (e) {} });

  store.init().then(function (r) {
    if (store.mode === "cloud") {
      store.onAuth(function (u) { if (u) startApp(u); else showAuth(); });
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
