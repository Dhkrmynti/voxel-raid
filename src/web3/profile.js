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

export function getPilotName(address) {
  return readAll()[address.toLowerCase()] || defaultName(address);
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
