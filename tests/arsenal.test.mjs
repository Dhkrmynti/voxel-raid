// Integration tests for the VXL token and the arsenal (phase 4).
//   npm test
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { createPublicClient, createWalletClient, http, parseEther, parseSignature, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { SCORE_TYPES } from '../server/app.js';
import { startAnvil } from '../scripts/anvil.mjs';
import { deploy, SKINS } from '../scripts/deploy.mjs';

const abiOf = (name) => JSON.parse(readFileSync(new URL(`../contracts/out/${name}.json`, import.meta.url), 'utf8')).abi;
const LB = abiOf('VoxelRaidLeaderboard');
const TOKEN = abiOf('VoxelToken');
// Purchases burn VXL inside the call, so token errors must be decodable too.
const ARSENAL = [...abiOf('VoxelArsenal'), ...TOKEN.filter((x) => x.type === 'error')];
const PORT = 8556;
const ANVIL_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

let node;
let client;
let addr;
const signer = privateKeyToAccount(generatePrivateKey());

async function newPlayer() {
  const account = privateKeyToAccount(generatePrivateKey());
  await client.request({ method: 'anvil_setBalance', params: [account.address, toHex(parseEther('10'))] });
  return { account, wallet: createWalletClient({ account, chain: anvil, transport: http(node.url) }) };
}

async function send(player, address, abi, functionName, args = []) {
  const hash = await player.wallet.writeContract({ address, abi, functionName, args });
  return client.waitForTransactionReceipt({ hash });
}

async function expectRevert(promise, errorName) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.walk?.((e) => e.data?.errorName)?.data?.errorName, errorName);
    return true;
  });
}

const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });

/** Records `tokens` pickups for the player via a server-attested leaderboard submission. */
async function earn(player, tokens) {
  const sessionId = toHex(randomBytes(32));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const run = { score: 1000n, wave: 1, kills: 5, tokens };
  const signature = await signer.signTypedData({
    domain: { name: 'VoxelRaid', version: '1', chainId: anvil.id, verifyingContract: addr.leaderboard },
    types: SCORE_TYPES,
    primaryType: 'Score',
    message: { player: player.account.address, ...run, sessionId, deadline },
  });
  await send(player, addr.leaderboard, LB, 'submitScore', [
    run.score,
    run.wave,
    run.kills,
    run.tokens,
    sessionId,
    deadline,
    signature,
  ]);
}

async function permit(player, value, { deadline = BigInt(Math.floor(Date.now() / 1000) + 3600) } = {}) {
  const nonce = await read(addr.token, TOKEN, 'nonces', [player.account.address]);
  const sig = await player.account.signTypedData({
    domain: { name: 'Voxel Raid Token', version: '1', chainId: anvil.id, verifyingContract: addr.token },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: { owner: player.account.address, spender: addr.arsenal, value, nonce, deadline },
  });
  const { r, s, v, yParity } = parseSignature(sig);
  return { deadline, v: Number(v ?? BigInt(yParity + 27)), r, s };
}

before(async () => {
  node = await startAnvil({ port: PORT });
  client = createPublicClient({ chain: anvil, transport: http(node.url) });
  process.env.SERVER_SIGNER_KEY = toHex(randomBytes(32));
  // Re-point the deployed leaderboard at our in-test signer.
  addr = await deploy({ chainName: 'anvil', rpcUrl: node.url, record: false, log: () => {} });
  const owner = {
    wallet: createWalletClient({ account: privateKeyToAccount(ANVIL_KEY_0), chain: anvil, transport: http(node.url) }),
  };
  await send(owner, addr.leaderboard, LB, 'setSigner', [signer.address]);
});

after(() => node?.stop());

describe('VXL token', () => {
  test('claims pickups recorded on the leaderboard, once', async () => {
    const p = await newPlayer();
    await earn(p, 7);
    assert.equal(await read(addr.token, TOKEN, 'claimable', [p.account.address]), 7n);
    await send(p, addr.token, TOKEN, 'claim');
    assert.equal(await read(addr.token, TOKEN, 'balanceOf', [p.account.address]), parseEther('7'));
    assert.equal(await read(addr.token, TOKEN, 'claimable', [p.account.address]), 0n);
    await expectRevert(send(p, addr.token, TOKEN, 'claim'), 'NothingToClaim');

    await earn(p, 3);
    await send(p, addr.token, TOKEN, 'claim');
    assert.equal(await read(addr.token, TOKEN, 'balanceOf', [p.account.address]), parseEther('10'));
  });
});

describe('arsenal', () => {
  test('lists the launch skins', async () => {
    const items = await read(addr.arsenal, ARSENAL, 'items');
    assert.deepEqual(
      items.map((i) => i.name),
      SKINS.map((s) => s[0]),
    );
    assert.equal(items[0].price, parseEther(String(SKINS[0][1])));
  });

  test('buys a skin with a permit: VXL is burned and the NFT minted', async () => {
    const p = await newPlayer();
    await earn(p, 30);
    await send(p, addr.token, TOKEN, 'claim');
    const supplyBefore = await read(addr.token, TOKEN, 'totalSupply');

    const price = parseEther('25');
    const { deadline, v, r, s } = await permit(p, price);
    await send(p, addr.arsenal, ARSENAL, 'buyWithPermit', [0n, price, deadline, v, r, s]);

    assert.equal(await read(addr.token, TOKEN, 'balanceOf', [p.account.address]), parseEther('5'));
    assert.equal(await read(addr.token, TOKEN, 'totalSupply'), supplyBefore - price);
    assert.deepEqual(await read(addr.arsenal, ARSENAL, 'ownedItems', [p.account.address]), [0n]);
  });

  test('a front-run permit does not block the purchase', async () => {
    const p = await newPlayer();
    await earn(p, 30);
    await send(p, addr.token, TOKEN, 'claim');
    const { deadline, v, r, s } = await permit(p, parseEther('25'));
    // Someone else submits the permit first.
    const griefer = await newPlayer();
    await send(griefer, addr.token, TOKEN, 'permit', [p.account.address, addr.arsenal, parseEther('25'), deadline, v, r, s]);
    await send(p, addr.arsenal, ARSENAL, 'buyWithPermit', [0n, parseEther('25'), deadline, v, r, s]);
    assert.equal((await read(addr.arsenal, ARSENAL, 'ownedItems', [p.account.address])).length, 1);
  });

  test('fails without enough VXL', async () => {
    const p = await newPlayer();
    await earn(p, 10);
    await send(p, addr.token, TOKEN, 'claim');
    const { deadline, v, r, s } = await permit(p, parseEther('120'));
    await expectRevert(
      send(p, addr.arsenal, ARSENAL, 'buyWithPermit', [4n, parseEther('120'), deadline, v, r, s]),
      'ERC20InsufficientBalance',
    );
  });

  test('tokenURI is valid on-chain JSON with an SVG image', async () => {
    const p = await newPlayer();
    await earn(p, 60);
    await send(p, addr.token, TOKEN, 'claim');
    const { deadline, v, r, s } = await permit(p, parseEther('60'));
    await send(p, addr.arsenal, ARSENAL, 'buyWithPermit', [2n, parseEther('60'), deadline, v, r, s]);
    const tokenId = await read(addr.arsenal, ARSENAL, 'tokenOfOwnerByIndex', [p.account.address, 0n]);

    const uri = await read(addr.arsenal, ARSENAL, 'tokenURI', [tokenId]);
    const meta = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'));
    assert.equal(meta.name, `GOLD RUSH #${tokenId}`);
    assert.equal(meta.attributes[0].value, 'GOLD RUSH');
    const svg = Buffer.from(meta.image.split(',')[1], 'base64').toString('utf8');
    assert.match(svg, /^<svg .*<\/svg>$/);
    assert.match(svg, /#ffd23f/);
  });

  test('a price raised after the player signed reverts instead of burning more', async () => {
    const owner = {
      wallet: createWalletClient({ account: privateKeyToAccount(ANVIL_KEY_0), chain: anvil, transport: http(node.url) }),
    };
    const p = await newPlayer();
    await earn(p, 100);
    await send(p, addr.token, TOKEN, 'claim');
    // An old, generous approval is still around when the owner raises the price.
    await send(p, addr.token, TOKEN, 'approve', [addr.arsenal, parseEther('100')]);
    await send(owner, addr.arsenal, ARSENAL, 'setItem', [3n, parseEther('90'), true]);
    await expectRevert(send(p, addr.arsenal, ARSENAL, 'buy', [3n, parseEther('80')]), 'PriceAboveMax');
    assert.equal(await read(addr.token, TOKEN, 'balanceOf', [p.account.address]), parseEther('100'));
    await send(owner, addr.arsenal, ARSENAL, 'setItem', [3n, parseEther('80'), true]);
  });

  test('inactive items cannot be bought and only the owner manages the catalog', async () => {
    const owner = {
      wallet: createWalletClient({ account: privateKeyToAccount(ANVIL_KEY_0), chain: anvil, transport: http(node.url) }),
    };
    const p = await newPlayer();
    await expectRevert(send(p, addr.arsenal, ARSENAL, 'addItem', ['HACK', 0n, 0, 0, 0]), 'OwnableUnauthorizedAccount');
    await expectRevert(send(owner, addr.arsenal, ARSENAL, 'addItem', ['bad"name', 0n, 0, 0, 0]), 'InvalidName');

    await send(owner, addr.arsenal, ARSENAL, 'setItem', [1n, parseEther('40'), false]);
    await earn(p, 40);
    await send(p, addr.token, TOKEN, 'claim');
    const { deadline, v, r, s } = await permit(p, parseEther('40'));
    await expectRevert(
      send(p, addr.arsenal, ARSENAL, 'buyWithPermit', [1n, parseEther('40'), deadline, v, r, s]),
      'ItemInactive',
    );
    await expectRevert(read(addr.arsenal, ARSENAL, 'svg', [99n]), 'UnknownItem');
  });
});
