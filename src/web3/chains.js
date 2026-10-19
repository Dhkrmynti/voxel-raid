import { anvil, robinhood, robinhoodTestnet } from 'viem/chains';

// Shared by the frontend (VITE_CHAIN) and the API server / scripts (CHAIN).
// Robinhood Chain is an Arbitrum Orbit L2 that pays gas in ETH: 46630 = testnet, 4663 = mainnet.
export const CHAINS = { anvil, robinhoodTestnet, robinhood };

export function resolveChain(name) {
  return CHAINS[name] ?? robinhoodTestnet;
}

// Where to get test ETH for gas, per chain id.
export const FAUCETS = {
  [robinhoodTestnet.id]: 'https://www.alchemy.com/faucets/robinhood-testnet',
};

export function explorerUrl(chain) {
  return chain.id === anvil.id ? null : (chain.blockExplorers?.default?.url ?? null);
}

/** Contract addresses for a chain from deployments.json, or null when not deployed. */
export function deploymentFor(deployments, chainId) {
  const d = deployments[chainId];
  return d && typeof d === 'object' ? d : null;
}
