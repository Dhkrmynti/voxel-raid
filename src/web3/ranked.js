// Ranked mode: SIWE session, server-issued game tickets and on-chain score submission.
import { readContract, signMessage, simulateContract, waitForTransactionReceipt, writeContract } from '@wagmi/core';
import { createSiweMessage } from 'viem/siwe';
import { SIM_VERSION } from '../game/version.js';
import artifact from '../../contracts/out/VoxelRaidLeaderboard.json';
import { api } from './api.js';
import { deploymentFor, explorerUrl } from './chains.js';
import deployments from './deployments.json';
import { config, TARGET_CHAIN, wallet } from './wallet.js';

export const LEADERBOARD_ADDRESS = deploymentFor(deployments, TARGET_CHAIN.id)?.leaderboard ?? null;
const { abi } = artifact;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// ---------- session ----------

let sessionAddress = null;
const listeners = new Set();

export function rankedState() {
  const address = wallet.state.address;
  return { active: !!address && !!sessionAddress && sessionAddress.toLowerCase() === address.toLowerCase() };
}

function emit() {
  const s = rankedState();
  listeners.forEach((fn) => fn(s));
}

export function onRankedChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function refreshSession() {
  try {
    sessionAddress = (await api.me()).address;
  } catch {
    sessionAddress = null;
  }
  emit();
}

export async function signIn() {
  const { address } = wallet.state;
  if (!address) throw new Error('Connect wallet dulu.');
  const { nonce } = await api.nonce();
  const message = createSiweMessage({
    domain: location.host,
    address,
    statement: 'Masuk ke mode ranked VOXEL//RAID. Ini hanya tanda tangan, bukan transaksi, dan tidak memakan gas.',
    uri: location.origin,
    version: '1',
    chainId: TARGET_CHAIN.id,
    nonce,
    issuedAt: new Date(),
    expirationTime: new Date(Date.now() + 10 * 60 * 1000),
  });
  const signature = await signMessage(config, { account: address, message });
  sessionAddress = (await api.verify(message, signature)).address;
  emit();
}

export async function signOut() {
  await api.logout().catch(() => {});
  sessionAddress = null;
  emit();
}

// A disconnected wallet should not leave a ranked session behind.
wallet.subscribe((s) => {
  if (s.status === 'disconnected' && sessionAddress) signOut();
  else emit();
});

// ---------- runs ----------

/**
 * Asks the server for a game ticket and the seed the run must use.
 * Resolves to null (an unranked run) when not signed in, offline, or too slow.
 */
export async function startRankedRun(timeoutMs = 4000) {
  if (!rankedState().active) return null;
  try {
    const res = await Promise.race([api.startGame(), new Promise((_, reject) => setTimeout(reject, timeoutMs))]);
    if (res.simVersion !== SIM_VERSION) return null; // stale page: play unranked rather than fail later
    return { ticket: res.ticket, seed: res.seed };
  } catch {
    return null;
  }
}

async function gzipBase64(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  const zipped = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (let i = 0; i < zipped.length; i += 0x8000) binary += String.fromCharCode(...zipped.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Validates the run on the server, then submits the attested score from the player's wallet.
 * @param {(step: 'validating'|'switching'|'confirm'|'pending', hash?: string) => void} onStep
 */
export async function submitRun(ticket, run, replay, onStep) {
  if (!LEADERBOARD_ADDRESS) throw new Error(`Contract belum di-deploy di ${TARGET_CHAIN.name}.`);
  onStep('validating');
  const { attestation: a, signature } = await api.finishGame(ticket, { ...run, simVersion: SIM_VERSION, replay: await gzipBase64(replay) });
  if (a.contract.toLowerCase() !== LEADERBOARD_ADDRESS.toLowerCase()) {
    throw new Error('Alamat contract di server berbeda dengan aplikasi. Muat ulang halaman.');
  }
  if (wallet.state.chainId !== TARGET_CHAIN.id) {
    onStep('switching');
    await wallet.switchToTarget();
  }
  onStep('confirm');
  const { request } = await simulateContract(config, {
    address: LEADERBOARD_ADDRESS,
    abi,
    functionName: 'submitScore',
    args: [BigInt(a.score), a.wave, a.kills, a.tokens, a.sessionId, BigInt(a.deadline), signature],
    account: wallet.state.address,
    chainId: TARGET_CHAIN.id,
  });
  const hash = await writeContract(config, request);
  onStep('pending', hash);
  const receipt = await waitForTransactionReceipt(config, { hash, chainId: TARGET_CHAIN.id });
  if (receipt.status !== 'success') throw new Error('Transaksi gagal di chain.');
  return hash;
}

export function txUrl(hash) {
  const base = explorerUrl(TARGET_CHAIN);
  return base ? `${base}/tx/${hash}` : null;
}

// ---------- leaderboard ----------

export async function readLeaderboard() {
  if (!LEADERBOARD_ADDRESS) return null;
  const opts = { address: LEADERBOARD_ADDRESS, abi, chainId: TARGET_CHAIN.id };
  const week = await readContract(config, { ...opts, functionName: 'currentWeek' });
  const top = await readContract(config, { ...opts, functionName: 'getTop', args: [week] });
  return {
    week: Number(week),
    resetsAt: new Date((Number(week) + 1) * WEEK_MS),
    top: top.map((e) => ({ player: e.player, score: Number(e.score), wave: Number(e.wave) })),
  };
}
