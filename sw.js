// TidyAI service worker — network-first so updates always reach the user.
const CACHE = 'tidyai-v10-stains-hacks';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './laundry_playbook_v3.json',
  './laundry_playbook.json',
  './product_ifthen_rules.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.host.includes('openai.com')) return;
  if (url.origin !== location.origin) return;

  // Network-first for HTML/JS/JSON so code updates take effect on next load.
  // Cache-first only for static binary assets (icons).
  const isAsset = /\.(png|jpg|jpeg|svg|webp|ico)$/i.test(url.pathname);

  if (isAsset) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      }))
    );
  } else {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
    );
  }
});
