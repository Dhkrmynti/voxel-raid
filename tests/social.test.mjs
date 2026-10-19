// Daily challenge, stored replays and pilot names (server/store.js + their API routes).
//   npm test
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { createSiweMessage } from 'viem/siwe';
import { createApp } from '../server/app.js';
import { createStore } from '../server/store.js';
import { decodeReplay, ReplayWriter } from '../src/game/replay.js';
import { Sim, SIM_VERSION, TICK } from '../src/game/sim.js';
import { replayRun } from '../src/game/verify.js';
import { playToDeath } from './bot.mjs';

const DAY = 24 * 60 * 60 * 1000;

function setup({ secret = randomBytes(32).toString('hex'), start = Date.UTC(2026, 9, 19, 12) } = {}) {
  const env = {
    CHAIN: 'anvil',
    RPC_URL: 'http://127.0.0.1:1',
    SERVER_SIGNER_KEY: generatePrivateKey(),
    SESSION_SECRET: secret,
    LEADERBOARD_ADDRESS: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  };
  const clock = { t: start };
  const app = createApp(env, { now: () => clock.t, limits: false });
  return { app, clock };
}

function agent(app) {
  const jar = new Map();
  return async (pathname, init = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    if (init.body) headers.set('content-type', 'application/json');
    const res = await app.request(`http://localhost${pathname}`, { ...init, headers });
    for (const c of res.headers.getSetCookie()) {
      const [k, v] = c.split(';')[0].split('=');
      if (v) jar.set(k, v);
      else jar.delete(k);
    }
    return { status: res.status, body: await res.json() };
  };
}

async function player(app) {
  const req = agent(app);
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
  const res = await req('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ message, signature: await account.signMessage({ message }) }),
  });
  assert.equal(res.status, 200);
  return { req, address: account.address };
}

const encode = (inputs) => {
  const w = new ReplayWriter();
  for (const i of inputs) w.push(i);
  return gzipSync(w.bytes()).toString('base64');
};

/** Starts a run, plays the bot on the ticket's seed/arena (optionally cut short), and submits it. */
async function playAndSubmit(p, clock, { mode, maxTicks } = {}) {
  const { body: start } = await p.req('/api/game/start', { method: 'POST', body: JSON.stringify({ mode }) });
  const { sim, inputs } = playToDeath(Sim, start.seed, maxTicks, { arena: start.arena });
  // A cut-short run must still end in death to be a complete replay: stop shooting and stand still.
  // (Editing hp directly would be exactly the memory cheat the server's re-simulation catches.)
  while (!sim.over) {
    const i = { ...inputs.at(-1), fire: false, mx: 0, mz: 0, dash: false, reload: false, weapon: -1, jump: false };
    inputs.push(i);
    sim.step(i);
  }
  clock.t += sim.tick * TICK * 1000;
  const res = await p.req('/api/game/finish', {
    method: 'POST',
    body: JSON.stringify({ ticket: start.ticket, ...sim.stats(), simVersion: SIM_VERSION, replay: encode(inputs) }),
  });
  return { res, start, sim, inputs };
}

describe('daily challenge', () => {
  test('everyone gets the same seed for a day; it changes the next day', async () => {
    const secret = randomBytes(32).toString('hex');
    const a = setup({ secret });
    const b = setup({ secret });
    const da = (await agent(a.app)('/api/daily')).body;
    const db = (await agent(b.app)('/api/daily')).body;
    assert.equal(da.seed, db.seed);
    assert.equal(da.arena, db.arena);
    a.clock.t += DAY;
    const next = (await agent(a.app)('/api/daily')).body;
    assert.notEqual(next.seed, da.seed);
    assert.notEqual(next.arena, da.arena, 'arenas alternate day by day');
  });

  test('daily tickets use the daily seed, and the board ranks verified runs', async () => {
    const { app, clock } = setup();
    const daily = (await agent(app)('/api/daily')).body;
    const p1 = await player(app);
    const p2 = await player(app);

    const r1 = await playAndSubmit(p1, clock, { mode: 'daily', maxTicks: 60 * 40 });
    assert.equal(r1.start.seed, daily.seed);
    assert.equal(r1.start.arena, daily.arena);
    assert.equal(r1.res.status, 200, JSON.stringify(r1.res.body));
    assert.equal(r1.res.body.dailyRank, 1);

    const r2 = await playAndSubmit(p2, clock, { mode: 'daily' });
    assert.equal(r2.res.status, 200);
    assert.ok(r2.sim.stats().score > r1.sim.stats().score, 'the full run should beat the cut-short one');
    assert.equal(r2.res.body.dailyRank, 1);

    await p1.req('/api/profile/name', { method: 'POST', body: JSON.stringify({ name: 'Ace<script>' }) });
    const board = (await agent(app)('/api/daily')).body.top;
    assert.deepEqual(
      board.map((e) => e.address),
      [p2.address, p1.address],
    );
    assert.equal(board[1].name, 'Acescript');
  });
});

describe('stored replays', () => {
  test('a verified run can be fetched and re-simulates to the same result', async () => {
    const { app, clock } = setup();
    const p = await player(app);
    const { res, start, sim } = await playAndSubmit(p, clock);
    assert.equal(res.status, 200);

    const rec = (await agent(app)(`/api/replays/${res.body.attestation.sessionId}`)).body;
    assert.equal(rec.seed, start.seed);
    assert.equal(rec.arena, start.arena);
    const inputs = decodeReplay(gunzipSync(Buffer.from(rec.replay, 'base64')));
    const again = replayRun(rec.seed, inputs, rec.arena);
    assert.deepEqual(again.stats, sim.stats());

    const week = Math.floor(clock.t / 1000 / 604800); // still the week the run started in
    const best = await agent(app)(`/api/replays/best?week=${week}&player=${p.address}`);
    assert.equal(best.status, 200);
    assert.equal(best.body.sessionId, res.body.attestation.sessionId);
    assert.equal((await agent(app)('/api/replays/0xnope')).status, 404);
  });

  test('only a personal best is kept', async () => {
    const { app, clock } = setup();
    const p = await player(app);
    const good = await playAndSubmit(p, clock);
    const worse = await playAndSubmit(p, clock, { maxTicks: 60 * 30 });
    assert.ok(worse.sim.stats().score < good.sim.stats().score);
    assert.equal((await agent(app)(`/api/replays/${worse.res.body.attestation.sessionId}`)).status, 404);
    assert.equal((await agent(app)(`/api/replays/${good.res.body.attestation.sessionId}`)).status, 200);
  });
});

describe('pilot names', () => {
  test('need a session, are sanitised, and can be looked up in bulk', async () => {
    const { app } = setup();
    assert.equal((await agent(app)('/api/profile/name', { method: 'POST', body: JSON.stringify({ name: 'x' }) })).status, 401);
    const p = await player(app);
    assert.equal((await p.req('/api/profile/name', { method: 'POST', body: JSON.stringify({ name: '!' }) })).status, 400);
    const ok = await p.req('/api/profile/name', { method: 'POST', body: JSON.stringify({ name: '  Raider   One  ' }) });
    assert.equal(ok.body.name, 'Raider One');
    const other = privateKeyToAccount(generatePrivateKey()).address;
    const { body } = await agent(app)(`/api/profiles?addresses=${p.address},${other},not-an-address`);
    assert.deepEqual(body.names, { [p.address]: 'Raider One' });
  });
});

describe('store persistence', () => {
  test('data survives a restart via the JSON file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'voxelraid-'));
    const file = path.join(dir, 'store.json');
    try {
      const a = createStore({ file });
      a.setName('0x5FbDB2315678afecb367f032d93F642f64180aa3', 'PERSIST');
      a.flush();
      const b = createStore({ file });
      assert.deepEqual(b.names(['0x5FbDB2315678afecb367f032d93F642f64180aa3']), {
        '0x5FbDB2315678afecb367f032d93F642f64180aa3': 'PERSIST',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
