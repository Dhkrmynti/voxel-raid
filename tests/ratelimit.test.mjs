// Rate limiting and request-size protection for the ranked API.
//   npm test
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { createSiweMessage } from 'viem/siwe';
import { createApp } from '../server/app.js';
import { createRateLimiter } from '../server/ratelimit.js';
import { ReplayWriter } from '../src/game/replay.js';
import { idleInput, SIM_VERSION } from '../src/game/sim.js';

describe('token bucket', () => {
  test('allows the limit, then refills smoothly over the window', () => {
    let t = 0;
    const rl = createRateLimiter({ now: () => t });
    const rule = { limit: 3, windowMs: 3000 };
    assert.ok(rl.take('a', rule).ok);
    assert.ok(rl.take('a', rule).ok);
    assert.ok(rl.take('a', rule).ok);
    const denied = rl.take('a', rule);
    assert.equal(denied.ok, false);
    assert.equal(denied.retryAfter, 1);
    assert.ok(rl.take('b', rule).ok, 'keys are independent');
    t += 1000; // one token back
    assert.ok(rl.take('a', rule).ok);
    assert.equal(rl.take('a', rule).ok, false);
  });

  test('a full table only drops buckets that refilled by their own window', () => {
    let t = 0;
    const rl = createRateLimiter({ now: () => t });
    const hourly = { limit: 1, windowMs: 60 * 60 * 1000 };
    const minutely = { limit: 5, windowMs: 60 * 1000 };
    assert.ok(rl.take('finish:a', hourly).ok);
    for (let i = 1; i < 50_000; i++) rl.take(`read:${i}`, minutely);
    t += 2 * 60 * 1000; // the per-minute buckets have refilled; the hourly one has not
    rl.take('read:new', minutely); // table is full: sweeps
    assert.ok(rl.size() < 100);
    assert.equal(rl.take('finish:a', hourly).ok, false, 'an hourly limit must survive a sweep');
  });
});

// The API without a chain: SIWE signatures from plain accounts verify offline.
function makeApp(options, extraEnv = {}) {
  return createApp(
    {
      CHAIN: 'anvil',
      RPC_URL: 'http://127.0.0.1:1', // never reached for EOA signatures
      SERVER_SIGNER_KEY: generatePrivateKey(),
      SESSION_SECRET: randomBytes(32).toString('hex'),
      LEADERBOARD_ADDRESS: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      ...extraEnv,
    },
    options,
  );
}

function agent(app) {
  const jar = new Map();
  return async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    if (init.body) headers.set('content-type', 'application/json');
    const res = await app.request(`http://localhost${path}`, { ...init, headers });
    for (const c of res.headers.getSetCookie()) {
      const [k, v] = c.split(';')[0].split('=');
      if (v) jar.set(k, v);
      else jar.delete(k);
    }
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json() };
  };
}

async function signIn(req) {
  const account = privateKeyToAccount(generatePrivateKey());
  const { body } = await req('/api/auth/nonce');
  const message = createSiweMessage({
    domain: 'localhost',
    address: account.address,
    uri: 'http://localhost',
    version: '1',
    chainId: anvil.id,
    nonce: body.nonce,
  });
  return req('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ message, signature: await account.signMessage({ message }) }),
  });
}

describe('API limits', () => {
  test('login endpoints are limited per IP with Retry-After', async () => {
    const req = agent(makeApp());
    for (let i = 0; i < 20; i++) assert.equal((await req('/api/auth/nonce')).status, 200);
    const res = await req('/api/auth/nonce');
    assert.equal(res.status, 429);
    assert.ok(Number(res.retryAfter) >= 1);
    assert.match(res.body.error, /Terlalu banyak permintaan/);
  });

  test('behind a proxy, a forged X-Forwarded-For prefix does not dodge the IP limit', async () => {
    const req = agent(makeApp(undefined, { TRUST_PROXY: '1' }));
    // The proxy appends the real client address; anything before it came from the client.
    const from = (spoof) => ({ headers: { 'x-forwarded-for': `${spoof}, 203.0.113.7` } });
    for (let i = 0; i < 20; i++) assert.equal((await req('/api/auth/nonce', from(`10.0.0.${i}`))).status, 200);
    assert.equal((await req('/api/auth/nonce', from('10.9.9.9'))).status, 429);
    const other = await req('/api/auth/nonce', { headers: { 'x-forwarded-for': '198.51.100.1' } });
    assert.equal(other.status, 200, 'a different real client has its own budget');
  });

  test('game tickets are limited per wallet, not shared between wallets', async () => {
    const app = makeApp({
      limits: {
        nonce: { limit: 100, windowMs: 60_000 },
        verify: { limit: 100, windowMs: 60_000 },
        start: { limit: 2, windowMs: 3_600_000 },
      },
    });
    const a = agent(app);
    const b = agent(app);
    await signIn(a);
    await signIn(b);
    assert.equal((await a('/api/game/start', { method: 'POST' })).status, 200);
    assert.equal((await a('/api/game/start', { method: 'POST' })).status, 200);
    assert.equal((await a('/api/game/start', { method: 'POST' })).status, 429);
    assert.equal((await b('/api/game/start', { method: 'POST' })).status, 200);
  });

  test('oversized request bodies are refused before parsing', async () => {
    const req = agent(makeApp());
    const res = await req('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ message: 'x'.repeat(64 * 1024), signature: '0x' }),
    });
    assert.equal(res.status, 413);
  });

  test('replays longer than the real time elapsed are rejected without re-simulating', async () => {
    let clock = Date.now();
    const req = agent(makeApp({ now: () => clock }));
    await signIn(req);
    const { body: start } = await req('/api/game/start', { method: 'POST' });
    // Ten minutes of ticks, submitted one minute after the ticket was issued.
    const w = new ReplayWriter();
    for (let i = 0; i < 60 * 60 * 10; i++) w.push(idleInput());
    clock += 60 * 1000;
    const t0 = performance.now();
    const res = await req('/api/game/finish', {
      method: 'POST',
      body: JSON.stringify({
        ticket: start.ticket,
        score: 0,
        wave: 1,
        kills: 0,
        tokens: 0,
        detonations: 0,
        simVersion: SIM_VERSION,
        replay: gzipSync(w.bytes()).toString('base64'),
      }),
    });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /waktu nyata/);
    assert.ok(performance.now() - t0 < 200, 'should be rejected before simulation');
  });
});
