import {
  connect,
  createConfig,
  disconnect,
  getBalance,
  getConnection,
  getConnectors,
  http,
  injected,
  mock,
  reconnect,
  switchChain,
  watchConnection,
  watchConnectors,
} from '@wagmi/core';
import { formatEther } from 'viem';
import { CHAINS, resolveChain } from './chains.js';

// VITE_CHAIN=anvil for local development, Robinhood Chain testnet by default.
export const TARGET_CHAIN = resolveChain(import.meta.env.VITE_CHAIN);
// Optional RPC override for the target chain (e.g. an Alchemy endpoint when the public RPC is unreachable).
const TARGET_RPC = import.meta.env.VITE_RPC_URL || undefined;
const chains = [TARGET_CHAIN, ...Object.values(CHAINS).filter((c) => c.id !== TARGET_CHAIN.id)];

// Dev-only: `?mockWallet` swaps in wagmi's mock connector to test the UI without an extension.
// On Anvil it uses the node's unlocked default account, so signing and transactions work too.
const useMock = import.meta.env.DEV && new URLSearchParams(location.search).has('mockWallet');
const MOCK_ACCOUNT = TARGET_CHAIN.id === 31337 ? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' : `0x${'a11ce'.padEnd(40, '0')}`;

export const config = createConfig({
  chains,
  // Wallets announcing themselves via EIP-6963 are added automatically;
  // the generic injected() connector is a fallback for older extensions.
  connectors: useMock ? [mock({ accounts: [MOCK_ACCOUNT] })] : [injected()],
  multiInjectedProviderDiscovery: !useMock,
  transports: Object.fromEntries(chains.map((c) => [c.id, http(c.id === TARGET_CHAIN.id ? TARGET_RPC : undefined)])),
});

function snapshot(c) {
  return { status: c.status, address: c.address, chainId: c.chainId, connectorName: c.connector?.name };
}

let state = snapshot(getConnection(config));
const listeners = new Set();
watchConnection(config, {
  onChange(c) {
    state = snapshot(c);
    listeners.forEach((fn) => fn(state));
  },
});

export function onWalletsChange(fn) {
  return watchConnectors(config, { onChange: fn });
}

export function listWallets() {
  const all = getConnectors(config);
  const discovered = all.filter((c) => c.id !== 'injected');
  if (discovered.length) return discovered;
  return window.ethereum ? all.filter((c) => c.id === 'injected') : [];
}

export function chainName(id) {
  return config.chains.find((c) => c.id === id)?.name ?? `Chain ${id}`;
}

export const wallet = {
  get state() {
    return state;
  },
  subscribe(fn) {
    listeners.add(fn);
    fn(state);
    return () => listeners.delete(fn);
  },
  init() {
    reconnect(config).catch(() => {});
  },
  connect(connector) {
    return connect(config, { connector });
  },
  disconnect() {
    return disconnect(config);
  },
  switchToTarget() {
    return switchChain(config, { chainId: TARGET_CHAIN.id });
  },
  async balance(address) {
    const b = await getBalance(config, { address, chainId: TARGET_CHAIN.id });
    return formatEther(b.value);
  },
};

const REVERT_MESSAGES = {
  SessionAlreadyUsed: 'Skor run ini sudah pernah dikirim.',
  AttestationExpired: 'Bukti skor sudah kedaluwarsa (lebih dari 1 jam). Run ini tidak bisa dikirim lagi.',
  InvalidAttestation: 'Bukti skor tidak valid untuk wallet ini.',
  NothingToClaim: 'Belum ada token yang bisa di-claim.',
  ERC20InsufficientBalance: 'Saldo VXL tidak cukup.',
  ItemInactive: 'Skin ini sedang tidak dijual.',
  EnforcedPause: 'Sedang dalam pemeliharaan (dijeda sementara). Coba lagi nanti.',
  DailyCapReached: 'Batas claim VXL global hari ini sudah tercapai. Coba lagi besok, token kamu tetap aman.',
  RunOverCap: 'Hasil run melebihi batas per run yang diizinkan.',
};

// Walks wagmi/viem error causes to produce a short, human message.
export function walletErrorText(err) {
  for (let e = err; e; e = e.cause) {
    const revert = REVERT_MESSAGES[e.data?.errorName];
    if (revert) return revert;
    if (/InsufficientFunds/.test(e.name)) return `Saldo ETH di ${TARGET_CHAIN.name} tidak cukup untuk gas.`;
    if (/ChainMismatch/.test(e.name)) return `Ganti jaringan wallet ke ${TARGET_CHAIN.name} dulu.`;
    if (e.code === 4001 || /UserRejected/.test(e.name)) return 'Permintaan dibatalkan di wallet.';
    if (e.code === -32002 || /ResourceUnavailable/.test(e.name))
      return 'Ada permintaan yang masih menunggu. Buka ekstensi wallet kamu.';
    if (/AlreadyConnected/.test(e.name)) return 'Wallet sudah terhubung.';
    if (/SwitchChainNotSupported/.test(e.name))
      return 'Wallet ini tidak mendukung ganti jaringan otomatis. Ganti manual di wallet.';
  }
  return err?.shortMessage || 'Terjadi kesalahan. Coba lagi.';
}
