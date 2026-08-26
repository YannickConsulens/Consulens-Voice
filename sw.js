const CACHE = 'consulens-voice-v3';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.svg', './icon-512.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // API-verzoeken (eigen proxy of Anthropic) nooit cachen — altijd live via het netwerk.
  if (url.includes('/api/') || url.includes('anthropic.com')) return;
  // Assets: cache-first, val terug op netwerk.
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
