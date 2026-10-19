// PWA wiring: manifest icons exist, index.html links them, and the service worker caches the
// right things (shell + hashed assets) while never touching the API.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ORIGIN = 'https://voxel.test';

/** Runs public/sw.js against in-memory caches and a scripted network. */
function loadWorker(network) {
  const stores = new Map();
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    const key = (r) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).href;
    return {
      put: async (r, res) => void store.set(key(r), res),
      match: async (r) => store.get(key(r)),
      addAll: async (urls) => urls.forEach((u) => store.set(key(u), new Response(`cached ${u}`))),
    };
  };
  const caches = {
    open,
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (r) => {
      for (const name of stores.keys()) {
        const hit = await (await open(name)).match(r);
        if (hit) return hit;
      }
    },
  };
  const listeners = {};
  const self = {
    location: new URL(ORIGIN),
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting() {},
    clients: { claim: async () => {} },
  };
  const calls = [];
  const fetch = async (req) => {
    calls.push(new URL(req.url ?? req).pathname);
    return network(req);
  };
  vm.runInNewContext(read('public/sw.js'), { self, caches, fetch, URL, Response, Promise });

  async function dispatch(type, extra = {}) {
    let pending = null;
    const event = { ...extra, waitUntil: (p) => (pending = p), respondWith: (p) => (pending = p) };
    listeners[type](event);
    return { handled: pending !== null, result: await pending };
  }
  const request = (path, mode = 'cors', method = 'GET') => ({ url: new URL(path, ORIGIN).href, mode, method });
  return { stores, calls, dispatch, request };
}

describe('pwa', () => {
  it('manifest icons and head tags are in place', () => {
    const manifest = JSON.parse(read('public/manifest.webmanifest'));
    for (const icon of manifest.icons) assert.ok(existsSync(new URL(`../public${icon.src}`, import.meta.url)), icon.src);
    assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
    const html = read('index.html');
    for (const tag of ['rel="manifest"', 'rel="icon"', 'rel="apple-touch-icon"', 'og:image', 'twitter:card', 'theme-color']) {
      assert.ok(html.includes(tag), tag);
    }
  });

  it('precaches the shell and drops caches from older versions', async () => {
    const sw = loadWorker(() => new Response('net'));
    sw.stores.set('voxelraid-shell-v0', new Map());
    await sw.dispatch('install');
    await sw.dispatch('activate');
    assert.deepEqual([...sw.stores.keys()], ['voxelraid-shell-v1']);
    assert.equal(sw.stores.get('voxelraid-shell-v1').size, 4);
  });

  it('pages are network first with an offline fallback', async () => {
    let online = true;
    const sw = loadWorker(() => (online ? new Response('fresh page') : Promise.reject(new TypeError('offline'))));
    await sw.dispatch('install');
    const live = await sw.dispatch('fetch', { request: sw.request('/', 'navigate') });
    assert.equal(await live.result.text(), 'fresh page');
    online = false;
    const offline = await sw.dispatch('fetch', { request: sw.request('/?mockWallet', 'navigate') });
    assert.equal(await offline.result.text(), 'fresh page');
  });

  it('hashed assets are cache first', async () => {
    const sw = loadWorker(() => new Response('bundle'));
    await sw.dispatch('fetch', { request: sw.request('/assets/index-abc.js') });
    await sw.dispatch('fetch', { request: sw.request('/assets/index-abc.js') });
    assert.deepEqual(sw.calls, ['/assets/index-abc.js']);
  });

  it('never intercepts the API, writes or other origins', async () => {
    const sw = loadWorker(() => new Response('x'));
    for (const request of [
      sw.request('/api/game/start'),
      sw.request('/api/daily'),
      sw.request('/assets/x.js', 'cors', 'POST'),
      { url: 'https://rpc.example/v2', mode: 'cors', method: 'GET' },
    ]) {
      assert.equal((await sw.dispatch('fetch', { request })).handled, false, request.url);
    }
  });
});
