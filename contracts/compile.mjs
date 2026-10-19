// Compiles the game contracts with solc-js and writes ABI + bytecode to contracts/out.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const require = createRequire(import.meta.url);
const dir = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS = ['VoxelRaidLeaderboard', 'VoxelToken', 'VoxelArsenal'];

const input = {
  language: 'Solidity',
  sources: Object.fromEntries(
    CONTRACTS.map((name) => [`${name}.sol`, { content: readFileSync(path.join(dir, `${name}.sol`), 'utf8') }]),
  ),
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'cancun',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

// Local files (e.g. ./Guarded.sol) first, then packages such as @openzeppelin.
function findImports(importPath) {
  for (const resolve of [() => path.join(dir, importPath), () => require.resolve(importPath)]) {
    try {
      return { contents: readFileSync(resolve(), 'utf8') };
    } catch {
      // try the next location
    }
  }
  return { error: `File not found: ${importPath}` };
}

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
// Library warnings (e.g. OpenZeppelin) are not actionable here; errors always are.
const problems = (output.errors ?? []).filter((p) => p.severity === 'error' || !p.sourceLocation?.file.startsWith('@'));
for (const p of problems) console[p.severity === 'error' ? 'error' : 'warn'](p.formattedMessage);
if (problems.some((p) => p.severity === 'error')) process.exit(1);

mkdirSync(path.join(dir, 'out'), { recursive: true });
for (const name of CONTRACTS) {
  const contract = output.contracts[`${name}.sol`][name];
  const artifact = {
    contractName: name,
    compiler: solc.version(),
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}`,
  };
  writeFileSync(path.join(dir, 'out', `${name}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Compiled ${name} (${(artifact.bytecode.length - 2) / 2} bytes)`);
}
