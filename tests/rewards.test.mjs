// Weekly top-10 rewards on the VXL token.
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
const ANVIL_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const PORT = 8558;

let node;
let client;
let addr;
let owner;
const signer = privateKeyToAccount(generatePrivateKey());

const walletFor = (account) => createWalletClient({ account, chain: anvil, transport: http(node.url) });
const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });

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

async function submit(p, score) {
  const sessionId = toHex(randomBytes(32));
  const deadline = (await client.getBlock()).timestamp + 3600n;
  const message = { player: p.account.address, score, wave: 3, kills: 10, tokens: 0, sessionId, deadline };
  const signature = await signer.signTypedData({
    domain: { name: 'VoxelRaid', version: '1', chainId: anvil.id, verifyingContract: addr.leaderboard },
    types: SCORE_TYPES,
    primaryType: 'Score',
    message,
  });
  await send(p, addr.leaderboard, LB, 'submitScore', [score, 3, 10, 0, sessionId, deadline, signature]);
}

async function warpTo(timestamp) {
  await client.request({ method: 'evm_setNextBlockTimestamp', params: [toHex(timestamp)] });
  await client.request({ method: 'evm_mine', params: [] });
}

before(async () => {
  node = await startAnvil({ port: PORT });
  client = createPublicClient({ chain: anvil, transport: http(node.url) });
  process.env.SERVER_SIGNER_KEY = generatePrivateKey();
  addr = await deploy({ chainName: 'anvil', rpcUrl: node.url, record: false, log: () => {} });
  owner = { wallet: walletFor(privateKeyToAccount(ANVIL_KEY_0)) };
  await send(owner, addr.leaderboard, LB, 'setSigner', [signer.address]);
});

after(() => node?.stop());

describe('weekly rewards', () => {
  test('top 10 claim by rank once the week is over and the delay has passed', async () => {
    const [first, second, removed, outsider] = await Promise.all([newPlayer(), newPlayer(), newPlayer(), newPlayer()]);
    await submit(first, 9000n);
    await submit(second, 8000n);
    await submit(removed, 7000n);
    const week = await read(addr.leaderboard, LB, 'currentWeek');
    assert.equal(await read(addr.token, TOKEN, 'rankOf', [week, second.account.address]), 2n);

    // Too early: the week is still running.
    await expectRevert(send(first, addr.token, TOKEN, 'claimWeeklyReward', [week]), 'RewardNotOpen');

    // During the grace period the owner removes a forged entry.
    await send(owner, addr.leaderboard, LB, 'removeEntry', [week, removed.account.address]);
    const opensAt = await read(addr.token, TOKEN, 'rewardOpensAt', [week]);
    await warpTo(opensAt - 60n);
    await expectRevert(send(first, addr.token, TOKEN, 'claimWeeklyReward', [week]), 'RewardNotOpen');
    await warpTo(opensAt);

    await send(first, addr.token, TOKEN, 'claimWeeklyReward', [week]);
    await send(second, addr.token, TOKEN, 'claimWeeklyReward', [week]);
    assert.equal(await read(addr.token, TOKEN, 'balanceOf', [first.account.address]), parseEther('500'));
    assert.equal(await read(addr.token, TOKEN, 'balanceOf', [second.account.address]), parseEther('300'));

    await expectRevert(send(first, addr.token, TOKEN, 'claimWeeklyReward', [week]), 'RewardAlreadyClaimed');
    await expectRevert(send(removed, addr.token, TOKEN, 'claimWeeklyReward', [week]), 'NotInTop');
    await expectRevert(send(outsider, addr.token, TOKEN, 'claimWeeklyReward', [week]), 'NotInTop');
  });

  test('claims stop while paused, and only the owner sets the rewards', async () => {
    const p = await newPlayer();
    await submit(p, 5000n);
    const week = await read(addr.leaderboard, LB, 'currentWeek');
    await warpTo(await read(addr.token, TOKEN, 'rewardOpensAt', [week]));

    await expectRevert(
      send(p, addr.token, TOKEN, 'setWeeklyRewards', [[1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n], 0n]),
      'OwnableUnauthorizedAccount',
    );
    await send(owner, addr.token, TOKEN, 'setWeeklyRewards', [[1000n, 1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n, 1n], 86400n]);
    await send(owner, addr.token, TOKEN, 'pause');
    await expectRevert(send(p, addr.token, TOKEN, 'claimWeeklyReward', [week]), 'EnforcedPause');
    await send(owner, addr.token, TOKEN, 'unpause');
    await send(p, addr.token, TOKEN, 'claimWeeklyReward', [week]);
    assert.equal(await read(addr.token, TOKEN, 'balanceOf', [p.account.address]), parseEther('1000'));
  });
});
