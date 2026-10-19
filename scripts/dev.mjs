// One command for the full local stack: Anvil → contract deploy → API server → Vite.
//   npm run dev:full
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http } from 'viem';
import { deploymentFor, resolveChain } from '../src/web3/chains.js';
import { rpcReady, startAnvil } from './anvil.mjs';
import { deploy } from './deploy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chain = resolveChain(process.env.CHAIN);
const children = [];
let anvil = null;
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill();
  anvil?.stop();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function run(name, args) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: process.env });
  children.push(child);
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`[${name}] exited with code ${code}`);
    shutdown(code ?? 1);
  });
}

if (chain.id === 31337) {
  const url = process.env.RPC_URL || 'http://127.0.0.1:8545';
  if (await rpcReady(url)) {
    console.log(`[anvil] reusing node at ${url}`);
  } else {
    anvil = await startAnvil({ port: Number(new URL(url).port) });
    console.log(`[anvil] started at ${anvil.url}`);
  }
  // Anvil starts with empty state, so deploy unless the recorded address already has code.
  const deployments = JSON.parse(readFileSync(path.join(root, 'src/web3/deployments.json'), 'utf8'));
  const recorded = deploymentFor(deployments, chain.id)?.arsenal;
  const client = createPublicClient({ chain, transport: http(url) });
  const code = recorded ? await client.getCode({ address: recorded }) : undefined;
  if (code && code !== '0x') console.log('[deploy] using existing contracts');
  else await deploy({ chainName: 'anvil', rpcUrl: url, log: (m) => console.log(`[deploy] ${m}`) });
}

run('api', ['server/dev.js']);
run('web', ['node_modules/vite/bin/vite.js']);
