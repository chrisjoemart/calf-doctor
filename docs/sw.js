// Keeps the app opening with no signal. Data sync is handled by Firestore's own offline cache.
const CACHE = 'calf-doctor-a4dccfd111';
const SHELL = ["./","index.html","app.js?v=a4dccfd111","app.css?v=a4dccfd111","manifest.webmanifest","icon-192.png","icon-512.png","apple-touch-icon.png"];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('calf-doctor-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // Firebase and Google traffic go straight to the network
  if (req.mode === 'navigate') {
    // Fresh page when online (picks up updates), cached page when not.
    // Weak signal: give the network 3 seconds, then open from the phone.
    const net = fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('index.html', copy));
      }
      return res;
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
    e.respondWith(
      Promise.race([net, timeout])
        .then((res) => res || caches.match('index.html').then((hit) => hit || net))
        .catch(() => caches.match('index.html'))
    );
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
});
