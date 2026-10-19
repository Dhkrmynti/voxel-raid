// Offline support: the game itself runs without a network (guest mode), so the shell and its
// hashed assets are cached. The API and chain RPC always go to the network.
const VERSION = 'v2';
const SHELL = `voxelraid-shell-${VERSION}`;
const ASSETS = `voxelraid-assets-${VERSION}`;
const PRECACHE = ['/', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
const PAGE_TIMEOUT_MS = 4000; // a flaky connection falls back to the cached page instead of hanging
const MAX_ASSETS = 60; // old deploys' chunks are evicted, oldest first

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

/** Network first so a new deploy shows up right away; the cached page is the offline fallback. */
async function page(request) {
  const network = fetch(request).then(async (res) => {
    if (res.ok) await (await caches.open(SHELL)).put('/', res.clone());
    return res;
  });
  try {
    return await Promise.race([network, timeout(PAGE_TIMEOUT_MS)]);
  } catch {
    // Slow or offline: the cached page if there is one, else keep waiting for the network.
    return (await caches.match('/')) ?? network.catch(() => Response.error());
  }
}

/** Unhashed shell files (manifest, icons): answer from cache, refresh it in the background. */
async function shellFile(request, event) {
  const cache = await caches.open(SHELL);
  const update = fetch(request)
    .then((res) => (res.ok ? cache.put(request, res.clone()).then(() => res) : res))
    .catch(() => null);
  event.waitUntil(update);
  return (await cache.match(request)) ?? (await update) ?? Response.error();
}

/** Hashed build files and fonts never change under the same URL: cache first. */
async function asset(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // A host that answers a missing chunk with index.html must not poison the cache.
  const html = (res.headers.get('content-type') ?? '').includes('text/html');
  if ((res.ok && !html) || res.type === 'opaque') {
    const cache = await caches.open(ASSETS);
    await cache.put(request, res.clone());
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ASSETS)).map((k) => cache.delete(k)));
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/')) return;
    if (request.mode === 'navigate') event.respondWith(page(request));
    else if (url.pathname.startsWith('/assets/')) event.respondWith(asset(request));
    else if (PRECACHE.includes(url.pathname)) event.respondWith(shellFile(request, event));
  } else if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(asset(request));
  }
});
