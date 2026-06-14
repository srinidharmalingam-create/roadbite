/* Minimal offline shell. Caches the app files; live data still needs network. */
const CACHE = 'roadbite-v1';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './manifest.webmanifest',
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
  const url = new URL(e.request.url);
  // Never cache Google API calls — always go to network.
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('google.com')) return;
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request))
  );
});
