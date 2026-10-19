// VXL token claims and arsenal skin purchases.
import { readContract, signTypedData, simulateContract, waitForTransactionReceipt, writeContract } from '@wagmi/core';
import { formatEther, parseSignature } from 'viem';
import arsenalArtifact from '../../contracts/out/VoxelArsenal.json';
import tokenArtifact from '../../contracts/out/VoxelToken.json';
import { deploymentFor } from './chains.js';
import deployments from './deployments.json';
import { config, TARGET_CHAIN, wallet } from './wallet.js';

const deployment = deploymentFor(deployments, TARGET_CHAIN.id);
export const TOKEN_ADDRESS = deployment?.token ?? null;
export const ARSENAL_ADDRESS = deployment?.arsenal ?? null;

const chainId = TARGET_CHAIN.id;
const tokenAbi = tokenArtifact.abi;
// Purchases burn VXL inside the call, so token errors must be decodable too.
const arsenalAbi = [...arsenalArtifact.abi, ...tokenAbi.filter((x) => x.type === 'error')];

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

const tokenCall = (functionName, args) => readContract(config, { address: TOKEN_ADDRESS, abi: tokenAbi, functionName, args, chainId });
const arsenalCall = (functionName, args) =>
  readContract(config, { address: ARSENAL_ADDRESS, abi: arsenalAbi, functionName, args, chainId });

export async function readCatalog() {
  const items = await arsenalCall('items');
  const svgs = await Promise.all(items.map((_, i) => arsenalCall('svg', [BigInt(i)])));
  return items.map((it, i) => ({
    id: i,
    name: it.name,
    price: it.price,
    priceVxl: Number(formatEther(it.price)),
    colors: { body: it.body, accent: it.accent, glow: it.glow },
    active: it.active,
    svg: svgs[i],
  }));
}

export async function readPlayer(address) {
  const [balance, claimable, owned] = await Promise.all([
    tokenCall('balanceOf', [address]),
    tokenCall('claimable', [address]),
    arsenalCall('ownedItems', [address]),
  ]);
  return { balance, balanceVxl: Number(formatEther(balance)), claimable: Number(claimable), owned: new Set(owned.map(Number)) };
}

async function ensureChain(onStep) {
  if (wallet.state.chainId !== chainId) {
    onStep('switching');
    await wallet.switchToTarget();
  }
}

async function sendTx(params, onStep) {
  onStep('confirm');
  const { request } = await simulateContract(config, { ...params, account: wallet.state.address, chainId });
  const hash = await writeContract(config, request);
  onStep('pending', hash);
  const receipt = await waitForTransactionReceipt(config, { hash, chainId });
  if (receipt.status !== 'success') throw new Error('Transaksi gagal di chain.');
  return hash;
}

export async function claimTokens(onStep) {
  await ensureChain(onStep);
  return sendTx({ address: TOKEN_ADDRESS, abi: tokenAbi, functionName: 'claim' }, onStep);
}

/** Signs an EIP-2612 permit (no gas) and buys the skin in a single transaction. */
export async function buySkin(item, onStep) {
  await ensureChain(onStep);
  onStep('permit');
  const owner = wallet.state.address;
  const [, name, version] = await tokenCall('eip712Domain');
  const nonce = await tokenCall('nonces', [owner]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
  const signature = await signTypedData(config, {
    account: owner,
    domain: { name, version, chainId, verifyingContract: TOKEN_ADDRESS },
    types: PERMIT_TYPES,
    primaryType: 'Permit',
    message: { owner, spender: ARSENAL_ADDRESS, value: item.price, nonce, deadline },
  });
  const { r, s, v, yParity } = parseSignature(signature);
  return sendTx(
    {
      address: ARSENAL_ADDRESS,
      abi: arsenalAbi,
      functionName: 'buyWithPermit',
      args: [BigInt(item.id), deadline, Number(v ?? BigInt(yParity + 27)), r, s],
    },
    onStep,
  );
}
