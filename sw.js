/* App shell with offline fallback. Network-FIRST for our own files so code updates
   always reach the user when online; falls back to cache only when offline. */
const CACHE = 'roadbite-v2';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './config.js', './manifest.webmanifest',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Let Google (Maps/Places/fonts) and any cross-origin request go straight to network.
  if (url.origin !== location.origin) return;
  // Network-first: fetch fresh, cache a copy, fall back to cache when offline.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});
