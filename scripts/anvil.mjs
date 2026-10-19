// Starts a local Anvil node from the @foundry-rs/anvil npm distribution.
// The platform binary is spawned directly so stopping it never leaves an orphan behind.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORMS = {
  'darwin-x64': 'darwin-amd64',
  'darwin-arm64': 'darwin-arm64',
  'linux-x64': 'linux-amd64',
  'linux-arm64': 'linux-arm64',
  'win32-x64': 'win32-amd64',
};

export function anvilBinary() {
  const platform = PLATFORMS[`${process.platform}-${process.arch}`];
  if (!platform) throw new Error(`Anvil is not available for ${process.platform}-${process.arch}.`);
  const bin = path.join(root, 'node_modules', '@foundry-rs', `anvil-${platform}`, 'bin', process.platform === 'win32' ? 'anvil.exe' : 'anvil');
  if (!existsSync(bin)) throw new Error(`Anvil binary not found at ${bin}. Run npm install.`);
  return bin;
}

export async function rpcReady(url) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function startAnvil({ port = 8545, silent = true } = {}) {
  const url = `http://127.0.0.1:${port}`;
  const proc = spawn(anvilBinary(), ['--port', String(port), '--host', '127.0.0.1', ...(silent ? ['--silent'] : [])], {
    stdio: silent ? 'ignore' : 'inherit',
  });
  let exited = false;
  proc.on('exit', () => (exited = true));
  for (let i = 0; i < 100; i++) {
    if (await rpcReady(url)) return { url, proc, stop: () => proc.kill() };
    if (exited) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(`Anvil did not start on ${url}.`);
}
