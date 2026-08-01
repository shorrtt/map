// Bump this whenever the app shell changes so deployed clients discard stale files.
const CACHE_NAME = "map-shell-v3";
const urlsToCache = [
  new URL("./", self.registration.scope).href,
  new URL("./index.html", self.registration.scope).href,
  new URL("./style.css?v=20260801", self.registration.scope).href,
  new URL("./map.js?v=20260801", self.registration.scope).href,
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(urlsToCache);
    })
  );
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  // If the request is for a CDN asset, try to return a cached response first.
  if (requestUrl.hostname === "cdn.prodigyrp.net") {
    event.respondWith(
      caches.match(event.request).then((response) => {
        if (response) {
          return response;
        }
        return fetch(event.request).then((networkResponse) => {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, networkResponse.clone());
          });
          return networkResponse;
        });
      })
    );
  } else if (requestUrl.origin === self.location.origin) {
    // Keep the deployed app current while still working offline after a visit.
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse.ok) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, networkResponse.clone());
            });
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
  }
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (!cacheWhitelist.includes(cacheName)) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
