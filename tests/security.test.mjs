// Contract hardening: run caps, pause/guardian, two-step ownership, daily mint cap,
// entry removal — and a full "leaked signer" incident drill.
//   npm test
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { createPublicClient, createWalletClient, http, parseEther, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { SCORE_TYPES } from '../server/app.js';
import { startAnvil } from '../scripts/anvil.mjs';
import { deploy } from '../scripts/deploy.mjs';

const abiOf = (name) => JSON.parse(readFileSync(new URL(`../contracts/out/${name}.json`, import.meta.url), 'utf8')).abi;
const LB = abiOf('VoxelRaidLeaderboard');
const TOKEN = abiOf('VoxelToken');
const ARSENAL = [...abiOf('VoxelArsenal'), ...TOKEN.filter((x) => x.type === 'error')];
const ANVIL_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PORT = 8557;

let node;
let client;
let addr;
let owner;
let guardian;
let signer = privateKeyToAccount(generatePrivateKey());

const walletFor = (account) => createWalletClient({ account, chain: anvil, transport: http(node.url) });

async function newPlayer() {
  const account = privateKeyToAccount(generatePrivateKey());
  await client.request({ method: 'anvil_setBalance', params: [account.address, toHex(parseEther('10'))] });
  return { account, wallet: walletFor(account) };
}

async function send(actor, address, abi, functionName, args = []) {
  const hash = await actor.wallet.writeContract({ address, abi, functionName, args });
  return client.waitForTransactionReceipt({ hash });
}

async function expectRevert(promise, errorName) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.walk?.((e) => e.data?.errorName)?.data?.errorName, errorName);
    return true;
  });
}

const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });

async function attest(player, { score = 1000n, tokens = 5, key = signer } = {}) {
  const sessionId = toHex(randomBytes(32));
  // Chain time, not wall time: tests fast-forward the chain by days.
  const deadline = (await client.getBlock()).timestamp + 3600n;
  const message = { player: player.account.address, score, wave: 3, kills: 20, tokens, sessionId, deadline };
  const signature = await key.signTypedData({
    domain: { name: 'VoxelRaid', version: '1', chainId: anvil.id, verifyingContract: addr.leaderboard },
    types: SCORE_TYPES,
    primaryType: 'Score',
    message,
  });
  return [score, 3, 20, tokens, sessionId, deadline, signature];
}

const submit = async (player, opts) => send(player, addr.leaderboard, LB, 'submitScore', await attest(player, opts));

async function advanceDays(days) {
  await client.request({ method: 'evm_increaseTime', params: [toHex(days * 86400)] });
  await client.request({ method: 'evm_mine', params: [] });
}

before(async () => {
  node = await startAnvil({ port: PORT });
  client = createPublicClient({ chain: anvil, transport: http(node.url) });
  process.env.SERVER_SIGNER_KEY = generatePrivateKey();
  addr = await deploy({ chainName: 'anvil', rpcUrl: node.url, record: false, log: () => {} });
  owner = { account: privateKeyToAccount(ANVIL_KEY_0), wallet: walletFor(privateKeyToAccount(ANVIL_KEY_0)) };
  guardian = await newPlayer();
  for (const [address, abi] of [
    [addr.leaderboard, LB],
    [addr.token, TOKEN],
    [addr.arsenal, ARSENAL],
  ]) {
    await send(owner, address, abi, 'setGuardian', [guardian.account.address]);
  }
  await send(owner, addr.leaderboard, LB, 'setSigner', [signer.address]);
});

after(() => node?.stop());

describe('leaderboard hardening', () => {
  test('rejects runs above the per-run caps', async () => {
    const p = await newPlayer();
    await expectRevert(submit(p, { tokens: 5001 }), 'RunOverCap');
    await expectRevert(submit(p, { score: 50_000_001n }), 'RunOverCap');
    assert.equal((await submit(p, { tokens: 5000, score: 50_000_000n })).status, 'success');
  });

  test('only the owner can change caps', async () => {
    const p = await newPlayer();
    await expectRevert(send(p, addr.leaderboard, LB, 'setRunCaps', [1n, 1]), 'OwnableUnauthorizedAccount');
    await send(owner, addr.leaderboard, LB, 'setRunCaps', [10_000n, 10]);
    await expectRevert(submit(p, { tokens: 11 }), 'RunOverCap');
    await send(owner, addr.leaderboard, LB, 'setRunCaps', [50_000_000n, 5000]);
  });

  test('guardian can pause but not unpause; strangers can do neither', async () => {
    const p = await newPlayer();
    await expectRevert(send(p, addr.leaderboard, LB, 'pause'), 'NotGuardianOrOwner');
    await send(guardian, addr.leaderboard, LB, 'pause');
    await expectRevert(submit(p), 'EnforcedPause');
    await expectRevert(send(guardian, addr.leaderboard, LB, 'unpause'), 'OwnableUnauthorizedAccount');
    await send(owner, addr.leaderboard, LB, 'unpause');
    assert.equal((await submit(p)).status, 'success');
  });

  test('owner can remove a forged entry; order is preserved', async () => {
    const [a, b, c] = await Promise.all([newPlayer(), newPlayer(), newPlayer()]);
    await submit(a, { score: 9_000_000n });
    await submit(b, { score: 8_000_000n });
    await submit(c, { score: 7_000_000n });
    const week = await read(addr.leaderboard, LB, 'currentWeek');
    await expectRevert(send(a, addr.leaderboard, LB, 'removeEntry', [week, b.account.address]), 'OwnableUnauthorizedAccount');
    await send(owner, addr.leaderboard, LB, 'removeEntry', [week, b.account.address]);
    const top = (await read(addr.leaderboard, LB, 'getTop', [week])).map((e) => e.player);
    assert.ok(!top.includes(b.account.address));
    assert.ok(top.indexOf(a.account.address) < top.indexOf(c.account.address));
    assert.equal(await read(addr.leaderboard, LB, 'bestScore', [week, b.account.address]), 0n);
    await expectRevert(send(owner, addr.leaderboard, LB, 'removeEntry', [week, b.account.address]), 'EntryNotFound');
  });
});

describe('token hardening', () => {
  test('claims respect a global daily cap; the rest stays claimable', async () => {
    const p = await newPlayer();
    await submit(p, { tokens: 25 });
    await advanceDays(1); // start from a fresh day
    await send(owner, addr.token, TOKEN, 'setDailyClaimCap', [10n]);

    await send(p, addr.token, TOKEN, 'claim');
    assert.equal(await read(addr.token, TOKEN, 'balanceOf', [p.account.address]), parseEther('10'));
    assert.equal(await read(addr.token, TOKEN, 'claimable', [p.account.address]), 15n);
    await expectRevert(send(p, addr.token, TOKEN, 'claim'), 'DailyCapReached');

    await advanceDays(1);
    await send(p, addr.token, TOKEN, 'claim');
    assert.equal(await read(addr.token, TOKEN, 'balanceOf', [p.account.address]), parseEther('20'));
    await send(owner, addr.token, TOKEN, 'setDailyClaimCap', [250_000n]);
  });

  test('pausing the token stops claims', async () => {
    const p = await newPlayer();
    await submit(p, { tokens: 5 });
    await send(guardian, addr.token, TOKEN, 'pause');
    await expectRevert(send(p, addr.token, TOKEN, 'claim'), 'EnforcedPause');
    await send(owner, addr.token, TOKEN, 'unpause');
    assert.equal((await send(p, addr.token, TOKEN, 'claim')).status, 'success');
  });
});

describe('arsenal hardening', () => {
  test('pausing the arsenal stops purchases', async () => {
    const p = await newPlayer();
    await submit(p, { tokens: 30 });
    await send(p, addr.token, TOKEN, 'claim');
    await send(p, addr.token, TOKEN, 'approve', [addr.arsenal, parseEther('25')]);
    await send(guardian, addr.arsenal, ARSENAL, 'pause');
    await expectRevert(send(p, addr.arsenal, ARSENAL, 'buy', [0n]), 'EnforcedPause');
    await send(owner, addr.arsenal, ARSENAL, 'unpause');
    assert.equal((await send(p, addr.arsenal, ARSENAL, 'buy', [0n])).status, 'success');
  });
});

describe('ownership', () => {
  test('two-step transfer: nothing changes until the new owner accepts', async () => {
    const safe = await newPlayer(); // stands in for a multisig
    await send(owner, addr.arsenal, ARSENAL, 'transferOwnership', [safe.account.address]);
    assert.equal(await read(addr.arsenal, ARSENAL, 'owner'), owner.account.address);
    assert.equal(await read(addr.arsenal, ARSENAL, 'pendingOwner'), safe.account.address);
    await send(safe, addr.arsenal, ARSENAL, 'acceptOwnership');
    assert.equal(await read(addr.arsenal, ARSENAL, 'owner'), safe.account.address);
    await expectRevert(send(owner, addr.arsenal, ARSENAL, 'setItem', [0n, 1n, true]), 'OwnableUnauthorizedAccount');
  });
});

describe('incident drill: leaked signer key', () => {
  test('damage is capped, then pause → rotate → clean up → resume', async () => {
    const attacker = await newPlayer();
    const honest = await newPlayer();
    await advanceDays(1);
    await send(owner, addr.token, TOKEN, 'setDailyClaimCap', [8_000n]);

    // 1. The attacker forges max-size runs with the leaked key…
    await submit(attacker, { score: 50_000_000n, tokens: 5000 });
    await submit(attacker, { score: 50_000_000n, tokens: 5000 });
    // …but the daily cap limits what can be minted today.
    await send(attacker, addr.token, TOKEN, 'claim');
    assert.equal(await read(addr.token, TOKEN, 'balanceOf', [attacker.account.address]), parseEther('8000'));

    // 2. Guardian pauses everything at once.
    for (const [address, abi] of [
      [addr.leaderboard, LB],
      [addr.token, TOKEN],
    ])
      await send(guardian, address, abi, 'pause');
    await expectRevert(submit(attacker), 'EnforcedPause');

    // 3. Owner rotates the signer, removes the forged entry, and resumes.
    const leaked = signer;
    signer = privateKeyToAccount(generatePrivateKey());
    await send(owner, addr.leaderboard, LB, 'setSigner', [signer.address]);
    const week = await read(addr.leaderboard, LB, 'currentWeek');
    await send(owner, addr.leaderboard, LB, 'removeEntry', [week, attacker.account.address]);
    for (const [address, abi] of [
      [addr.leaderboard, LB],
      [addr.token, TOKEN],
    ])
      await send(owner, address, abi, 'unpause');

    // 4. The leaked key is now useless; honest players carry on.
    await expectRevert(submit(attacker, { key: leaked }), 'InvalidAttestation');
    assert.equal((await submit(honest, { score: 2000n })).status, 'success');
    const top = (await read(addr.leaderboard, LB, 'getTop', [week])).map((e) => e.player);
    assert.ok(!top.includes(attacker.account.address));
    assert.ok(top.includes(honest.account.address));
    await send(owner, addr.token, TOKEN, 'setDailyClaimCap', [250_000n]);
  });
});
