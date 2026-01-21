self.addEventListener('install', (e) => {
  // Force new service worker to active immediately
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // Delete all old caches
  e.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          console.log('Service Worker: Clearing Old Cache', cacheName);
          return caches.delete(cacheName);
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', (e) => {
  // Network-first strategy: always try network, fallback to cache only if offline
  e.respondWith(
    fetch(e.request)
      .then(response => {
        return response;
      })
      .catch(() => {
        return caches.match(e.request);
      })
  );
});
