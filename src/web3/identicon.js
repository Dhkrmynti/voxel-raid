// Deterministic, mirrored 8x8 pixel avatar derived from a wallet address.
const cache = new Map();

export function identicon(address, size = 8) {
  const key = address.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const hex = key.replace(/^0x/, '');
  let seed = parseInt(hex.slice(0, 8), 16) | 0 || 1;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 1000) / 1000;
  };
  const hue = parseInt(hex.slice(8, 11), 16) % 360;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `hsl(${hue} 40% 14%)`;
  ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size / 2; x++) {
      const r = rand();
      if (r < 0.45) continue;
      ctx.fillStyle = r > 0.88 ? `hsl(${(hue + 150) % 360} 90% 60%)` : `hsl(${hue} 85% 62%)`;
      ctx.fillRect(x, y, 1, 1);
      ctx.fillRect(size - 1 - x, y, 1, 1);
    }
  }
  const url = canvas.toDataURL();
  cache.set(key, url);
  return url;
}
