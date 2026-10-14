/* Offline support: app files are served network-first and fall back to the
 * cache when offline. Bump VERSION when you change the list below. */
var VERSION = "stockroom-v2";
var SHELL = [
  "./", "index.html", "css/styles.css", "js/config.js", "js/store.js", "js/app.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  var sameOrigin = url.origin === self.location.origin;
  var cdn = /^(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|cdn\.sheetjs\.com)$/.test(url.hostname);
  if (!sameOrigin && !cdn) return; // never cache API / storage calls

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && (res.ok || res.type === "opaque")) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: sameOrigin }).then(function (hit) {
        return hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error());
      });
    })
  );
});
