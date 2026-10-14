/*
 * Storage layer. Both stores expose the same promise-based API:
 *
 *   mode, init(), list(), onChange(cb), save(p), patch(id, fields), remove(p),
 *   saveMany(list), putPhoto(blob) → id, photoUrl(id), photoBlob(id), deletePhoto(id)
 *
 * Product shape used by the app:
 *   {id, name, sku, category, quantity, cost, price, low, notes, imageId, createdAt, updatedAt}
 */
(function () {
  "use strict";

  function uid(prefix) {
    var r = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    return (prefix || "") + r;
  }

  /* ================= Local (IndexedDB) ================= */
  function LocalStore() {
    var dbp = null, listeners = [], urlCache = {};
    var bc = ("BroadcastChannel" in window) ? new BroadcastChannel("stockroom") : null;
    if (bc) bc.onmessage = function () { emit(false); };

    function open() {
      if (dbp) return dbp;
      dbp = new Promise(function (res, rej) {
        var r = indexedDB.open("stockroom", 1);
        r.onupgradeneeded = function () {
          var d = r.result;
          if (!d.objectStoreNames.contains("products")) d.createObjectStore("products", { keyPath: "id" });
          if (!d.objectStoreNames.contains("photos")) d.createObjectStore("photos");
        };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
      return dbp;
    }
    // Run fn inside one transaction; resolves with whatever fn's callback set via done().
    function tx(stores, mode, fn) {
      return open().then(function (d) {
        return new Promise(function (res, rej) {
          var t = d.transaction(stores, mode), out;
          fn(t, function (v) { out = v; });
          t.oncomplete = function () { res(out); };
          t.onerror = function () { rej(t.error); };
          t.onabort = function () { rej(t.error || new Error("Transaction aborted")); };
        });
      });
    }
    function emit(broadcast) {
      listeners.forEach(function (cb) { try { cb(); } catch (e) {} });
      if (broadcast && bc) bc.postMessage("changed");
    }
    function changed(v) { emit(true); return v; }

    return {
      mode: "local",
      init: function () {
        if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
        return open().then(function () { return { user: null }; });
      },
      list: function () {
        return tx("products", "readonly", function (t, done) {
          var r = t.objectStore("products").getAll();
          r.onsuccess = function () { done(r.result || []); };
        });
      },
      onChange: function (cb) { listeners.push(cb); },
      save: function (p) {
        return tx("products", "readwrite", function (t) { t.objectStore("products").put(p); }).then(changed);
      },
      patch: function (id, fields) {
        return tx("products", "readwrite", function (t) {
          var s = t.objectStore("products"), r = s.get(id);
          r.onsuccess = function () { if (r.result) s.put(Object.assign(r.result, fields)); };
        }).then(changed);
      },
      remove: function (p) {
        return tx(["products", "photos"], "readwrite", function (t) {
          t.objectStore("products").delete(p.id);
          if (p.imageId) t.objectStore("photos").delete(p.imageId);
        }).then(changed);
      },
      saveMany: function (list) {
        return tx("products", "readwrite", function (t) {
          var s = t.objectStore("products");
          list.forEach(function (p) { s.put(p); });
        }).then(changed);
      },
      putPhoto: function (blob) {
        var id = uid("ph-");
        return tx("photos", "readwrite", function (t) { t.objectStore("photos").put(blob, id); })
          .then(function () { return id; });
      },
      photoBlob: function (id) {
        return tx("photos", "readonly", function (t, done) {
          var r = t.objectStore("photos").get(id);
          r.onsuccess = function () { done(r.result || null); };
        });
      },
      photoUrl: function (id) {
        if (urlCache[id]) return Promise.resolve(urlCache[id]);
        return this.photoBlob(id).then(function (b) {
          if (!b) return null;
          return (urlCache[id] = URL.createObjectURL(b));
        });
      },
      cachedPhotoUrl: function (id) { return urlCache[id] || null; },
      deletePhoto: function (id) {
        if (urlCache[id]) { URL.revokeObjectURL(urlCache[id]); delete urlCache[id]; }
        return tx("photos", "readwrite", function (t) { t.objectStore("photos").delete(id); });
      }
    };
  }

  /* ================= Cloud (Supabase) ================= */
  var SUPABASE_SRC = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
  var BUCKET = "photos";
  var FIELD_MAP = {
    name: "name", sku: "sku", category: "category", quantity: "quantity", cost: "cost",
    price: "price", low: "low", notes: "notes", imageId: "image_path"
  };

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = src; s.async = true; s.crossOrigin = "anonymous";
      s.onload = res; s.onerror = function () { rej(new Error("Could not load " + src)); };
      document.head.appendChild(s);
    });
  }
  function check(r) { if (r.error) throw r.error; return r.data; }

  function SupabaseStore(cfg) {
    var sb = null, user = null, channel = null, listeners = [], urlCache = {};

    function toRow(p) {
      return {
        id: p.id, user_id: user.id, name: p.name, sku: p.sku || "", category: p.category || "",
        quantity: p.quantity | 0, cost: Number(p.cost) || 0, price: Number(p.price) || 0,
        low: p.low == null ? 5 : p.low | 0, notes: p.notes || "", image_path: p.imageId || null,
        created_at: new Date(p.createdAt || Date.now()).toISOString(),
        updated_at: new Date(p.updatedAt || Date.now()).toISOString()
      };
    }
    function fromRow(r) {
      return {
        id: r.id, name: r.name, sku: r.sku, category: r.category, quantity: r.quantity,
        cost: Number(r.cost), price: Number(r.price), low: r.low, notes: r.notes,
        imageId: r.image_path, createdAt: Date.parse(r.created_at), updatedAt: Date.parse(r.updated_at)
      };
    }
    function subscribe() {
      if (channel || !user) return;
      channel = sb.channel("products-" + user.id)
        .on("postgres_changes", { event: "*", schema: "public", table: "products", filter: "user_id=eq." + user.id },
          function () { listeners.forEach(function (cb) { try { cb(); } catch (e) {} }); })
        .subscribe();
    }

    return {
      mode: "cloud",
      init: function () {
        return loadScript(SUPABASE_SRC).then(function () {
          sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
            auth: { persistSession: true, autoRefreshToken: true }
          });
          return sb.auth.getSession();
        }).then(function (r) {
          user = (r.data && r.data.session && r.data.session.user) || null;
          return { user: user };
        });
      },
      onAuth: function (cb) {
        sb.auth.onAuthStateChange(function (_evt, session) {
          var next = (session && session.user) || null;
          if ((next && next.id) === (user && user.id)) return;
          user = next;
          if (!user && channel) { sb.removeChannel(channel); channel = null; }
          cb(user);
        });
      },
      signIn: function (email, password) {
        return sb.auth.signInWithPassword({ email: email, password: password }).then(check)
          .then(function (d) { user = d.user; return user; });
      },
      signUp: function (email, password) {
        return sb.auth.signUp({ email: email, password: password, options: { emailRedirectTo: location.href.split("#")[0] } })
          .then(check).then(function (d) { if (d.session) user = d.user; return d; });
      },
      signOut: function () {
        if (channel) { sb.removeChannel(channel); channel = null; }
        return sb.auth.signOut();
      },
      user: function () { return user; },
      list: function () {
        subscribe();
        var page = 1000, all = [];
        function next(from) {
          return sb.from("products").select("*").order("created_at", { ascending: true }).range(from, from + page - 1)
            .then(check).then(function (rows) {
              all = all.concat(rows.map(fromRow));
              return rows.length === page ? next(from + page) : all;
            });
        }
        return next(0);
      },
      onChange: function (cb) { listeners.push(cb); },
      save: function (p) { return sb.from("products").upsert(toRow(p)).then(check); },
      patch: function (id, fields) {
        var row = {};
        Object.keys(fields).forEach(function (k) {
          if (FIELD_MAP[k]) row[FIELD_MAP[k]] = fields[k];
          else if (k === "updatedAt") row.updated_at = new Date(fields[k]).toISOString();
        });
        return sb.from("products").update(row).eq("id", id).then(check);
      },
      remove: function (p) {
        return sb.from("products").delete().eq("id", p.id).then(check).then(function () {
          if (p.imageId) return sb.storage.from(BUCKET).remove([p.imageId]).catch(function () {});
        });
      },
      saveMany: function (list) {
        var chunks = [], i;
        for (i = 0; i < list.length; i += 500) chunks.push(list.slice(i, i + 500));
        return chunks.reduce(function (chain, c) {
          return chain.then(function () { return sb.from("products").upsert(c.map(toRow)).then(check); });
        }, Promise.resolve());
      },
      putPhoto: function (blob) {
        var path = user.id + "/" + uid() + ".jpg";
        return sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || "image/jpeg", upsert: false })
          .then(check).then(function () { return path; });
      },
      photoBlob: function (path) {
        return sb.storage.from(BUCKET).download(path).then(check);
      },
      photoUrl: function (path) {
        var c = urlCache[path];
        if (c && c.exp > Date.now()) return Promise.resolve(c.url);
        return sb.storage.from(BUCKET).createSignedUrl(path, 3600).then(check).then(function (d) {
          urlCache[path] = { url: d.signedUrl, exp: Date.now() + 3300 * 1000 };
          return d.signedUrl;
        });
      },
      cachedPhotoUrl: function (path) {
        var c = urlCache[path];
        return c && c.exp > Date.now() ? c.url : null;
      },
      deletePhoto: function (path) {
        delete urlCache[path];
        return sb.storage.from(BUCKET).remove([path]).then(check);
      }
    };
  }

  window.StockStore = {
    create: function (cfg) {
      return (cfg && cfg.supabaseUrl && cfg.supabaseAnonKey) ? SupabaseStore(cfg) : LocalStore();
    },
    uid: uid
  };
})();
