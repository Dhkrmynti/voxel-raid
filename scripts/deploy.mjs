// Deploys the leaderboard, VXL token and arsenal, lists the skins, and records the
// addresses in src/web3/deployments.json.
//   Local Anvil:              CHAIN=anvil node --env-file=.env.local scripts/deploy.mjs
//   Robinhood Chain testnet:  set CHAIN=robinhoodTestnet and DEPLOYER_KEY yourself (never commit it)
// Optional:
//   GUARDIAN=0x…     key allowed to pause (and only pause) all three contracts
//   FINAL_OWNER=0x…  e.g. a Safe multisig; ownership transfer is started here and must be
//                    completed by calling acceptOwnership() on each contract from that address
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { resolveChain } from '../src/web3/chains.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOYMENTS = path.join(root, 'src/web3/deployments.json');

// Anvil's first default account — a publicly known key that only exists on local dev chains.
const ANVIL_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// Launch catalog of cosmetic skins: [name, price in VXL, body, accent, glow]
export const SKINS = [
  ['NEON VIPER', 25, 0xff3fa4, 0x3ff2ff, 0x3ff2ff],
  ['TOXIC', 40, 0x2f7a3a, 0x5ed35a, 0xb6ff3f],
  ['GOLD RUSH', 60, 0xffd23f, 0xfff09a, 0xff7b29],
  ['VOID', 80, 0x1a1030, 0x9b5de5, 0xc77dff],
  ['INFERNO', 120, 0x7a1f1f, 0xff7b29, 0xff4d4d],
];

const artifact = (name) => JSON.parse(readFileSync(path.join(root, `contracts/out/${name}.json`), 'utf8'));

export async function deploy({
  chainName = process.env.CHAIN,
  rpcUrl = process.env.RPC_URL,
  record = true,
  log = console.log,
} = {}) {
  const chain = resolveChain(chainName);
  const key = process.env.DEPLOYER_KEY || (chain.id === 31337 ? ANVIL_KEY_0 : null);
  if (!key) throw new Error(`DEPLOYER_KEY is required to deploy on ${chain.name}.`);
  if (!process.env.SERVER_SIGNER_KEY) throw new Error('SERVER_SIGNER_KEY is missing (run `npm run setup`).');

  const account = privateKeyToAccount(key);
  const signer = privateKeyToAccount(process.env.SERVER_SIGNER_KEY).address;
  const transport = http(rpcUrl || undefined);
  const wallet = createWalletClient({ account, chain, transport });
  const client = createPublicClient({ chain, transport });

  async function deployContract(name, args) {
    const { abi, bytecode } = artifact(name);
    const hash = await wallet.deployContract({ abi, bytecode, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`${name} deployment failed: ${hash}`);
    log(`${name}: ${receipt.contractAddress}`);
    return receipt.contractAddress;
  }

  log(`Deploying to ${chain.name} (${chain.id}) from ${account.address}…`);
  const leaderboard = await deployContract('VoxelRaidLeaderboard', [signer, account.address]);
  const token = await deployContract('VoxelToken', [leaderboard, account.address]);
  const arsenal = await deployContract('VoxelArsenal', [token, account.address]);

  const { abi: arsenalAbi } = artifact('VoxelArsenal');
  for (const [name, price, body, accent, glow] of SKINS) {
    const hash = await wallet.writeContract({
      address: arsenal,
      abi: arsenalAbi,
      functionName: 'addItem',
      args: [name, parseEther(String(price)), body, accent, glow],
    });
    await client.waitForTransactionReceipt({ hash });
  }
  log(`Listed ${SKINS.length} skins (server signer ${signer})`);

  const contracts = [
    ['VoxelRaidLeaderboard', leaderboard],
    ['VoxelToken', token],
    ['VoxelArsenal', arsenal],
  ];
  async function callAll(functionName, args) {
    for (const [name, address] of contracts) {
      const hash = await wallet.writeContract({ address, abi: artifact(name).abi, functionName, args });
      await client.waitForTransactionReceipt({ hash });
    }
  }
  if (process.env.GUARDIAN) {
    await callAll('setGuardian', [process.env.GUARDIAN]);
    log(`Guardian (pause only): ${process.env.GUARDIAN}`);
  }
  if (process.env.FINAL_OWNER) {
    await callAll('transferOwnership', [process.env.FINAL_OWNER]);
    log(`Ownership transfer started to ${process.env.FINAL_OWNER}; call acceptOwnership() on all three contracts from it.`);
  }

  const addresses = { leaderboard, token, arsenal };
  if (record) {
    const deployments = JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'));
    deployments[chain.id] = addresses;
    writeFileSync(DEPLOYMENTS, `${JSON.stringify(deployments, null, 2)}\n`);
  }
  return addresses;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  deploy().catch((err) => {
    console.error(err.shortMessage || err.message);
    process.exit(1);
  });
}
