// Generates the favicon, PWA icons and the social preview image into public/.
// Pure pixel art drawn on a grid, so no image tooling is needed: `npm run icons`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../public/', import.meta.url);
const BG = [0x12, 0x0a, 0x24];
const GRID_LINE = [0x1f, 0x13, 0x3d];
const PINK = [0xff, 0x3f, 0xa4];
const CYAN = [0x3f, 0xf2, 0xff];
const WHITE = [0xff, 0xff, 0xff];
const MUTED = [0xb7, 0x9b, 0xff];
// Isometric (2:1) voxel cube on a 16×16 grid: T top, L left, R right face, W glint.
const CUBE = [
  '................',
  '.......TT.......',
  '.....TTTTTT.....',
  '...TTTTWWTTTT...',
  '.TTTTTTTTTTTTTT.',
  '.LLTTTTTTTTTTRR.',
  '.LLLLTTTTTTRRRR.',
  '.LLLLLLTTRRRRRR.',
  '.LLLLLLLRRRRRRR.',
  '.LLLLLLLRRRRRRR.',
  '.LLLLLLLRRRRRRR.',
  '.LLLLLLLRRRRRRR.',
  '.LLLLLLLRRRRRRR.',
  '...LLLLLRRRRR...',
  '.....LLLRRR.....',
  '.......LR.......',
];
const CUBE_COLORS = { T: CYAN, L: PINK, R: [0xa0, 0x1f, 0x6a], W: WHITE };

// ---------- PNG encoding ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(img) {
  const { width, height, data } = img;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- drawing ----------

function image(width, height, color = BG) {
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) data.set(color, i * 3);
  return { width, height, data };
}
function rect(img, x, y, w, h, color) {
  for (let yy = Math.max(0, y); yy < Math.min(img.height, y + h); yy++) {
    for (let xx = Math.max(0, x); xx < Math.min(img.width, x + w); xx++) img.data.set(color, (yy * img.width + xx) * 3);
  }
}
/** The cube as a list of [x, y, color] cells on the 16×16 grid. */
function cubeCells() {
  return CUBE.flatMap((row, y) => [...row].flatMap((ch, x) => (CUBE_COLORS[ch] ? [[x, y, CUBE_COLORS[ch]]] : [])));
}
function drawCube(img, x0, y0, scale) {
  for (const [x, y, c] of cubeCells()) rect(img, x0 + x * scale, y0 + y * scale, scale, scale, c);
}

// 5×7 pixel font, only the glyphs the preview image needs.
const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};
/** Draws text; `colors` is either one colour or one per character. Returns the end x. */
function text(img, str, x, y, scale, colors) {
  [...str].forEach((ch, i) => {
    const color = Array.isArray(colors[0]) ? colors[i] : colors;
    FONT[ch].forEach((row, ry) => {
      for (let rx = 0; rx < 5; rx++) if (row[rx] === '1') rect(img, x + rx * scale, y + ry * scale, scale, scale, color);
    });
    x += 6 * scale;
  });
  return x;
}

// ---------- outputs ----------

/** Square app icon; `pad` cells of margin keep maskable icons inside the safe zone. */
function icon(size, pad) {
  const grid = 16 + pad * 2;
  const scale = Math.floor(size / grid);
  const img = image(size, size);
  const offset = Math.floor((size - 16 * scale) / 2);
  drawCube(img, offset, offset, scale);
  return png(img);
}

function socialImage() {
  const img = image(1200, 630);
  for (let x = 0; x < 1200; x += 40) rect(img, x, 0, 2, 630, GRID_LINE);
  for (let y = 0; y < 630; y += 40) rect(img, 0, y, 1200, 2, GRID_LINE);
  drawCube(img, 90, 155, 20);
  const title = 'VOXEL//RAID';
  text(
    img,
    title,
    470,
    215,
    10,
    [...title].map((_, i) => (i < 5 ? WHITE : i < 7 ? PINK : CYAN)),
  );
  text(img, '3D PIXEL SHOOTER', 470, 325, 5, MUTED);
  text(img, 'ON-CHAIN LEADERBOARD', 470, 385, 4, CYAN);
  rect(img, 0, 610, 1200, 6, PINK);
  return png(img);
}

function faviconSvg() {
  const rects = cubeCells()
    .map(([x, y, c]) => `<rect x="${x}" y="${y}" width="1" height="1" fill="#${Buffer.from(c).toString('hex')}"/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">${rects}</svg>\n`;
}

mkdirSync(OUT, { recursive: true });
const files = {
  'favicon.svg': faviconSvg(),
  'icon-192.png': icon(192, 1),
  'icon-512.png': icon(512, 1),
  'icon-maskable-512.png': icon(512, 4),
  'apple-touch-icon.png': icon(180, 2),
  'og.png': socialImage(),
};
for (const [name, body] of Object.entries(files)) writeFileSync(new URL(name, OUT), body);
console.log(`wrote ${Object.keys(files).join(', ')}`);
