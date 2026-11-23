/* Service worker: funciona sin conexión.
   Estrategia "red primero con límite de tiempo": si hay red, usa la versión
   nueva (así ves al momento los cambios de routine.json); si no la hay o
   tarda más de 3 s, tira de la copia guardada. */
const CACHE = 'descansos-v1';
const NETWORK_TIMEOUT_MS = 3000;
const ASSETS = [
  './',
  'index.html',
  'app.js',
  'styles.css',
  'routine.json',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(event, req));
});

async function networkFirst(event, req) {
  const cache = await caches.open(CACHE);
  // no-cache: revalida con el servidor (304 si no cambió) en vez de fiarse de la caché HTTP
  const network = fetch(req, { cache: 'no-cache' }).then(res => {
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  });
  event.waitUntil(network.then(() => {}, () => {})); // que termine de actualizar la caché

  const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch { /* sin red */ }

  const cached = await cache.match(req, { ignoreSearch: true })
    || (req.mode === 'navigate' ? (await cache.match('index.html')) || (await cache.match('./')) : undefined);
  return cached || network; // si no hay copia, esperar a la red
}

// Tocar la notificación de "descanso terminado" → volver a la app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find(c => 'focus' in c);
    if (client) return client.focus();
    return self.clients.openWindow('./');
  })());
});
