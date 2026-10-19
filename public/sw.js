// Offline support: the game itself runs without a network (guest mode), so the shell and its
// hashed assets are cached. The API and chain RPC always go to the network.
const VERSION = 'v1';
const SHELL = `voxelraid-shell-${VERSION}`;
const ASSETS = `voxelraid-assets-${VERSION}`;
const PRECACHE = ['/', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

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

/** Network first so a new deploy shows up right away; the cached page is the offline fallback. */
async function page(request) {
  try {
    const res = await fetch(request);
    if (res.ok) (await caches.open(SHELL)).put('/', res.clone());
    return res;
  } catch {
    return (await caches.match('/')) ?? Response.error();
  }
}

/** Hashed build files and fonts never change under the same URL: cache first. */
async function asset(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') (await caches.open(ASSETS)).put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/')) return;
    if (request.mode === 'navigate') event.respondWith(page(request));
    else if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname)) event.respondWith(asset(request));
  } else if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(asset(request));
  }
});
