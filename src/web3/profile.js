// Pilot profiles (display names) keyed by wallet address. Local only for now.
const KEY = 'voxelraid.pilots.v1';

function readAll() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const defaultName = (address) => `PILOT-${address.slice(2, 6).toUpperCase()}`;

export function sanitizeName(name) {
  return name
    .replace(/[^A-Za-z0-9_\- ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

// Names other pilots registered on the server, filled in by rememberNames().
const serverNames = new Map();

export function rememberNames(names) {
  for (const [address, name] of Object.entries(names)) serverNames.set(address.toLowerCase(), name);
}

/** A name set in this browser wins, then the one registered on the server, then the default. */
export function getPilotName(address) {
  const key = address.toLowerCase();
  return readAll()[key] || serverNames.get(key) || defaultName(address);
}

export function setPilotName(address, name) {
  const all = readAll();
  all[address.toLowerCase()] = name;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // storage unavailable — name lasts for this session only via the UI
  }
}
