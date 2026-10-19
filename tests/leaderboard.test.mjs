// Integration tests: contract + API against a throwaway Anvil node.
//   npm test
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { createPublicClient, createWalletClient, http, parseEther, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { createSiweMessage } from 'viem/siwe';
import { createApp, SCORE_TYPES } from '../server/app.js';
import { ReplayWriter } from '../src/game/replay.js';
import { validateRun, waveEnemyCount } from '../src/game/rules.js';
import { Sim, SIM_VERSION, TICK } from '../src/game/sim.js';
import { playToDeath } from './bot.mjs';
import { startAnvil } from '../scripts/anvil.mjs';
import { deploy } from '../scripts/deploy.mjs';

const { abi } = JSON.parse(readFileSync(new URL('../contracts/out/VoxelRaidLeaderboard.json', import.meta.url), 'utf8'));
const PORT = 8555;

let node;
let client;
let contract;
let app;
let clock = Date.now(); // the API's clock; tests move it forward instead of waiting
const signerKey = generatePrivateKey();
const signer = privateKeyToAccount(signerKey);

async function newPlayer() {
  const account = privateKeyToAccount(generatePrivateKey());
  await client.request({ method: 'anvil_setBalance', params: [account.address, toHex(parseEther('10'))] });
  const wallet = createWalletClient({ account, chain: anvil, transport: http(node.url) });
  return { account, wallet };
}

function attest(player, run, { sessionId = toHex(randomBytes(32)), deadline, key = signer } = {}) {
  const dl = deadline ?? BigInt(Math.floor(Date.now() / 1000) + 3600);
  const message = {
    player,
    score: BigInt(run.score),
    wave: run.wave,
    kills: run.kills,
    tokens: run.tokens,
    sessionId,
    deadline: dl,
  };
  return key
    .signTypedData({
      domain: { name: 'VoxelRaid', version: '1', chainId: anvil.id, verifyingContract: contract },
      types: SCORE_TYPES,
      primaryType: 'Score',
      message,
    })
    .then((signature) => ({ args: [message.score, run.wave, run.kills, run.tokens, sessionId, dl, signature] }));
}

async function submit(player, args) {
  const hash = await player.wallet.writeContract({ address: contract, abi, functionName: 'submitScore', args });
  return client.waitForTransactionReceipt({ hash });
}

async function expectRevert(promise, errorName) {
  await assert.rejects(promise, (err) => {
    const name = err.walk?.((e) => e.data?.errorName)?.data?.errorName;
    assert.equal(name, errorName);
    return true;
  });
}

const read = (functionName, args = []) => client.readContract({ address: contract, abi, functionName, args });

before(async () => {
  node = await startAnvil({ port: PORT });
  client = createPublicClient({ chain: anvil, transport: http(node.url) });
  process.env.SERVER_SIGNER_KEY = signerKey;
  ({ leaderboard: contract } = await deploy({ chainName: 'anvil', rpcUrl: node.url, record: false, log: () => {} }));
  app = createApp(
    {
      CHAIN: 'anvil',
      RPC_URL: node.url,
      SERVER_SIGNER_KEY: signerKey,
      SESSION_SECRET: randomBytes(32).toString('hex'),
      LEADERBOARD_ADDRESS: contract,
    },
    { now: () => clock, limits: false },
  ); // rate limiting has its own tests
});

after(() => node?.stop());

describe('contract', () => {
  const run = { score: 1500, wave: 2, kills: 7, tokens: 3 };

  test('accepts an attested score and records it', async () => {
    const p = await newPlayer();
    const { args } = await attest(p.account.address, run);
    const receipt = await submit(p, args);
    assert.equal(receipt.status, 'success');
    const week = await read('currentWeek');
    assert.equal(await read('bestScore', [week, p.account.address]), 1500n);
    assert.equal(await read('totalTokens', [p.account.address]), 3n);
    const top = await read('getTop', [week]);
    assert.ok(top.some((e) => e.player === p.account.address && e.score === 1500n));
  });

  test('rejects a replayed session', async () => {
    const p = await newPlayer();
    const { args } = await attest(p.account.address, run);
    await submit(p, args);
    await expectRevert(submit(p, args), 'SessionAlreadyUsed');
  });

  test("rejects someone else's attestation", async () => {
    const a = await newPlayer();
    const b = await newPlayer();
    const { args } = await attest(a.account.address, run);
    await expectRevert(submit(b, args), 'InvalidAttestation');
  });

  test('rejects an attestation from the wrong signer', async () => {
    const p = await newPlayer();
    const { args } = await attest(p.account.address, run, { key: privateKeyToAccount(generatePrivateKey()) });
    await expectRevert(submit(p, args), 'InvalidAttestation');
  });

  test('rejects an expired attestation', async () => {
    const p = await newPlayer();
    const { args } = await attest(p.account.address, run, { deadline: 1n });
    await expectRevert(submit(p, args), 'AttestationExpired');
  });

  test('keeps the best score but still counts tokens from worse runs', async () => {
    const p = await newPlayer();
    await submit(p, (await attest(p.account.address, { ...run, score: 2000 })).args);
    await submit(p, (await attest(p.account.address, { ...run, score: 900, tokens: 5 })).args);
    const week = await read('currentWeek');
    assert.equal(await read('bestScore', [week, p.account.address]), 2000n);
    assert.equal(await read('totalTokens', [p.account.address]), 8n);
    assert.equal(await read('gamesSubmitted', [p.account.address]), 2n);
  });

  test('top list stays sorted, unique per player and capped at 10', async () => {
    const players = await Promise.all(Array.from({ length: 12 }, newPlayer));
    for (const [i, p] of players.entries()) {
      await submit(p, (await attest(p.account.address, { ...run, score: 100_000 + ((i * 7919) % 12) * 1000 })).args);
    }
    // One player improves and must move up without appearing twice.
    const climber = players[0];
    await submit(climber, (await attest(climber.account.address, { ...run, score: 500_000 })).args);

    const top = await read('getTop', [await read('currentWeek')]);
    assert.equal(top.length, 10);
    for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].score >= top[i].score);
    assert.equal(top[0].player, climber.account.address);
    assert.equal(new Set(top.map((e) => e.player)).size, 10);
  });

  test('only the owner can rotate the signer', async () => {
    const p = await newPlayer();
    await expectRevert(
      p.wallet.writeContract({ address: contract, abi, functionName: 'setSigner', args: [p.account.address] }),
      'OwnableUnauthorizedAccount',
    );
  });
});

describe('api', () => {
  // Minimal cookie jar around app.request()
  function agent() {
    const jar = new Map();
    return async (path, init = {}) => {
      const headers = new Headers(init.headers);
      if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
      if (init.body) headers.set('content-type', 'application/json');
      const res = await app.request(`http://localhost${path}`, { ...init, headers });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const [k, v] = pair.split('=');
        if (v) jar.set(k, v);
        else jar.delete(k);
      }
      return { status: res.status, body: await res.json() };
    };
  }

  async function signIn(req, account, { domain = 'localhost' } = {}) {
    const { body } = await req('/api/auth/nonce');
    const message = createSiweMessage({
      domain,
      address: account.address,
      statement: 'Masuk ke VOXEL//RAID ranked.',
      uri: `http://${domain}`,
      version: '1',
      chainId: anvil.id,
      nonce: body.nonce,
    });
    return req('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ message, signature: await account.signMessage({ message }) }),
    });
  }

  test('SIWE sign-in creates a session', async () => {
    const req = agent();
    const p = await newPlayer();
    const res = await signIn(req, p.account);
    assert.equal(res.status, 200);
    assert.equal((await req('/api/auth/me')).body.address, p.account.address);
  });

  test('SIWE rejects a message for another domain', async () => {
    const res = await signIn(agent(), (await newPlayer()).account, { domain: 'evil.example' });
    assert.equal(res.status, 401);
  });

  test('game endpoints require a session', async () => {
    assert.equal((await agent()('/api/game/start', { method: 'POST' })).status, 401);
  });

  /** Signs in, gets a ticket, and plays a bot run to death on the ticket's seed. */
  async function rankedRun({ seedOffset = 0, arena } = {}) {
    const req = agent();
    const p = await newPlayer();
    await signIn(req, p.account);
    const { body: start } = await req('/api/game/start', { method: 'POST', body: JSON.stringify({ arena }) });
    assert.equal(start.simVersion, SIM_VERSION);
    const { sim, inputs } = playToDeath(Sim, (start.seed + seedOffset) >>> 0, undefined, { arena: start.arena });
    assert.ok(sim.over, 'bot run should end in death');
    return { req, p, start, sim, inputs };
  }

  const encode = (inputs) => {
    const w = new ReplayWriter();
    for (const input of inputs) w.push(input);
    return gzipSync(w.bytes()).toString('base64');
  };

  const finish = (req, ticket, stats, replay, extra = {}) =>
    req('/api/game/finish', {
      method: 'POST',
      body: JSON.stringify({ ticket, ...stats, simVersion: SIM_VERSION, replay, ...extra }),
    });

  test('honest run: replay verified → attestation → on-chain submission', async () => {
    const { req, p, start, sim, inputs } = await rankedRun();
    clock += sim.tick * TICK * 1000; // the run took this long in real time
    const fin = await finish(req, start.ticket, sim.stats(), encode(inputs));
    assert.equal(fin.status, 200, JSON.stringify(fin.body));

    const a = fin.body.attestation;
    assert.equal(a.score, sim.stats().score);
    assert.equal(a.kills, sim.stats().kills);
    const args = [BigInt(a.score), a.wave, a.kills, a.tokens, a.sessionId, BigInt(a.deadline), fin.body.signature];

    // Front-running: someone copying the attestation from the mempool cannot use it.
    await expectRevert(submit(await newPlayer(), args), 'InvalidAttestation');
    assert.equal((await submit(p, args)).status, 'success');
  });

  test('the arena is sealed into the ticket and used to verify the replay', async () => {
    const { req, start, sim, inputs } = await rankedRun({ arena: 'foundry' });
    assert.equal(start.arena, 'foundry');
    clock += sim.tick * TICK * 1000;
    assert.equal((await finish(req, start.ticket, sim.stats(), encode(inputs))).status, 200);

    const bad = await req('/api/game/start', { method: 'POST', body: JSON.stringify({ arena: 'moon' }) });
    assert.equal(bad.status, 400);
  });

  test('rejects an inflated score even with a valid replay', async () => {
    const { req, start, sim, inputs } = await rankedRun();
    clock += sim.tick * TICK * 1000;
    const res = await finish(req, start.ticket, { ...sim.stats(), score: sim.stats().score + 1000 }, encode(inputs));
    assert.equal(res.status, 422);
    assert.match(res.body.error, /tidak cocok/);
  });

  test('rejects runs submitted faster than real time', async () => {
    const { req, start, sim, inputs } = await rankedRun();
    const res = await finish(req, start.ticket, sim.stats(), encode(inputs));
    assert.equal(res.status, 422);
    assert.match(res.body.error, /waktu nyata/);
  });

  test('rejects a run played on a different seed', async () => {
    const { req, start, sim, inputs } = await rankedRun({ seedOffset: 1 });
    clock += sim.tick * TICK * 1000;
    const res = await finish(req, start.ticket, sim.stats(), encode(inputs));
    assert.equal(res.status, 422);
  });

  test('rejects truncated, extended and garbage replays', async () => {
    const { req, start, sim, inputs } = await rankedRun();
    clock += sim.tick * TICK * 1000;
    const stats = sim.stats();
    const truncated = await finish(req, start.ticket, stats, encode(inputs.slice(0, -30)));
    assert.equal(truncated.status, 422);
    assert.match(truncated.body.error, /tidak berakhir/);
    const extended = await finish(req, start.ticket, stats, encode([...inputs, inputs.at(-1)]));
    assert.equal(extended.status, 422);
    assert.match(extended.body.error, /setelah game over/);
    assert.equal((await finish(req, start.ticket, stats, Buffer.from('not a replay').toString('base64'))).status, 400);
    assert.equal((await finish(req, start.ticket, stats, undefined)).status, 400);
    // A tiny upload that inflates to 32 MB must be refused, not decompressed.
    const bomb = gzipSync(Buffer.alloc(32 * 1024 * 1024)).toString('base64');
    assert.equal((await finish(req, start.ticket, stats, bomb)).status, 400);
  });

  test('rejects a stale game version and foreign or tampered tickets', async () => {
    const { req, start, sim, inputs } = await rankedRun();
    clock += sim.tick * TICK * 1000;
    const replay = encode(inputs);
    assert.equal((await finish(req, start.ticket, sim.stats(), replay, { simVersion: SIM_VERSION - 1 })).status, 409);
    assert.equal((await finish(req, `${start.ticket}x`, sim.stats(), replay)).status, 400);

    const other = agent();
    await signIn(other, (await newPlayer()).account);
    assert.equal((await finish(other, start.ticket, sim.stats(), replay)).status, 400);
  });
});

describe('validateRun', () => {
  const wave3Kills = waveEnemyCount(1) + waveEnemyCount(2) + 2;

  test('accepts a plausible wave-3 run', () => {
    // 2 waves cleared (7 + 9 kills), 2 kills into wave 3, a few tokens.
    const score = wave3Kills * 100 + 250 + 500 + 6 * 50 + 1200;
    assert.equal(validateRun({ score, wave: 3, kills: wave3Kills, tokens: 6 }, 60), null);
  });

  test('rejects runs that finish faster than enemies can spawn', () => {
    const score = wave3Kills * 100 + 750;
    assert.match(validateRun({ score, wave: 3, kills: wave3Kills, tokens: 0 }, 5), /lebih cepat/);
  });

  test('rejects malformed values', () => {
    assert.ok(validateRun({ score: -1, wave: 1, kills: 0, tokens: 0 }, 10));
    assert.ok(validateRun({ score: 1.5, wave: 1, kills: 0, tokens: 0 }, 10));
    assert.ok(validateRun({ score: '100', wave: 1, kills: 0, tokens: 0 }, 10));
  });
});
