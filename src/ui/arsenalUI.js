import { ARSENAL_ADDRESS, buySkin, claimTokens, readCatalog, readPlayer } from '../web3/arsenal.js';
import { DEFAULT_SKIN } from '../game/skins.js';
import { TARGET_CHAIN, wallet, walletErrorText } from '../web3/wallet.js';
import { currentPlayer } from './walletUI.js';

const $ = (s) => document.querySelector(s);
const fmt = (n) => Number(n).toLocaleString('id-ID', { maximumFractionDigits: 2 });
const SKIN_KEY = 'voxelraid.skin.v1';

const STEP_TEXT = {
  switching: `Ganti jaringan ke ${TARGET_CHAIN.name} di wallet…`,
  permit: 'Tanda tangani izin pembayaran VXL di wallet (gratis, tanpa gas)…',
  confirm: 'Konfirmasi transaksi di wallet kamu…',
  pending: 'Menunggu konfirmasi blok…',
};

let catalog = null;
let player = null; // { balanceVxl, claimable, owned }
let busy = false;

// ---------- equipped skin (per wallet, local) ----------

function readEquipped(address) {
  try {
    const v = JSON.parse(localStorage.getItem(SKIN_KEY) || '{}')[address.toLowerCase()];
    return Number.isInteger(v) ? v : null;
  } catch {
    return null;
  }
}

function writeEquipped(address, itemId) {
  try {
    const all = JSON.parse(localStorage.getItem(SKIN_KEY) || '{}');
    if (itemId === null) delete all[address.toLowerCase()];
    else all[address.toLowerCase()] = itemId;
    localStorage.setItem(SKIN_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable — skin stays default
  }
}

/** Colors of the skin the current pilot has equipped and still owns, or null for the default look. */
export function equippedSkin() {
  const p = currentPlayer();
  if (!p || !catalog || !player) return null;
  const id = readEquipped(p.address);
  return id !== null && player.owned.has(id) ? catalog[id].colors : null;
}

// ---------- rendering ----------

// The standard skin is not an NFT, so its art mirrors VoxelArsenal.svg() client-side.
function standardSvg() {
  const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;
  const r = (x, y, w, h, f) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${f}"/>`;
  const { body, accent, glow } = DEFAULT_SKIN;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" shape-rendering="crispEdges"><rect width="24" height="24" fill="#120a24"/>${r(1, 10, 6, 2, '#1a1a24')}${r(0, 10, 1, 2, hex(glow))}${r(6, 9, 12, 4, hex(body))}${r(6, 9, 12, 1, hex(glow))}${r(9, 8, 2, 1, hex(accent))}${r(18, 10, 4, 4, hex(body))}${r(14, 13, 3, 5, '#1a1a24')}${r(12, 13, 1, 2, hex(accent))}</svg>`;
}

function setStatus(text, isError = false) {
  const el = $('#arsenal-status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function skinCard({ id, name, svg, priceText, action, actionLabel, disabled, equipped, note }) {
  const card = document.createElement('article');
  card.className = `skin-card${equipped ? ' equipped' : ''}`;
  const img = document.createElement('img');
  img.className = 'skin-art';
  img.alt = `Skin ${name}`;
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const title = document.createElement('h3');
  title.textContent = name;
  const price = document.createElement('p');
  price.className = 'price';
  price.textContent = priceText;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn btn-sm ${equipped ? 'btn-ghost' : ''}`;
  btn.textContent = actionLabel;
  btn.disabled = disabled || busy;
  if (action) btn.addEventListener('click', () => action(id));
  card.append(img, title, price, btn);
  if (note) {
    const n = document.createElement('p');
    n.className = 'skin-note';
    n.textContent = note;
    card.append(n);
  }
  return card;
}

function render() {
  const p = currentPlayer();
  const grid = $('#skins');
  $('#vxl-balance').textContent = player ? fmt(player.balanceVxl) : '—';
  $('#vxl-claimable').textContent = player ? fmt(player.claimable) : '—';
  $('#claim-btn').disabled = busy || !player || player.claimable === 0;

  if (!ARSENAL_ADDRESS) {
    grid.replaceChildren();
    setStatus(`Contract arsenal belum di-deploy di ${TARGET_CHAIN.name}.`);
    return;
  }
  if (!catalog) return;

  const equippedId = p ? readEquipped(p.address) : null;
  const wearing = (id) => (id === null ? equippedId === null || !player?.owned.has(equippedId) : equippedId === id);
  const cards = [
    skinCard({
      id: null,
      name: 'STANDARD',
      svg: standardSvg(),
      priceText: 'Gratis',
      action: equip,
      actionLabel: wearing(null) ? 'DIPAKAI' : 'PAKAI',
      disabled: !p || wearing(null),
      equipped: wearing(null),
    }),
  ];
  for (const item of catalog) {
    const owned = !!player?.owned.has(item.id);
    if (!item.active && !owned) continue;
    const affordable = !!player && player.balanceVxl >= item.priceVxl;
    cards.push(
      skinCard({
        id: item.id,
        name: item.name,
        svg: item.svg,
        priceText: owned ? 'Dimiliki' : `${fmt(item.priceVxl)} VXL`,
        action: owned ? equip : buy,
        actionLabel: owned ? (wearing(item.id) ? 'DIPAKAI' : 'PAKAI') : 'BELI',
        disabled: !p || (owned ? wearing(item.id) : !affordable),
        equipped: owned && wearing(item.id),
        note: !owned && p && !affordable ? `Butuh ${fmt(item.priceVxl - (player?.balanceVxl ?? 0))} VXL lagi` : '',
      }),
    );
  }
  grid.replaceChildren(...cards);
}

// ---------- actions ----------

function equip(itemId) {
  const p = currentPlayer();
  if (!p) return;
  writeEquipped(p.address, itemId);
  setStatus(itemId === null ? 'Skin standar dipakai.' : `${catalog[itemId].name} dipakai di run berikutnya.`);
  render();
}

async function runTx(fn, successText) {
  busy = true;
  render();
  try {
    await fn((step) => setStatus(STEP_TEXT[step]));
    await refresh();
    setStatus(typeof successText === 'function' ? successText() : successText);
  } catch (err) {
    const message = walletErrorText(err);
    // A price or listing may have changed under us: show the catalog as it is on-chain now.
    catalog = null;
    await refresh();
    setStatus(message, true);
  } finally {
    busy = false;
    render();
  }
}

function buy(itemId) {
  const item = catalog[itemId];
  runTx((onStep) => buySkin(item, onStep), `✓ ${item.name} jadi milikmu! Klik PAKAI untuk memakainya.`);
}

let refreshReq = 0; // a slow read for a previous wallet must not overwrite the current one

export async function refresh() {
  if (!ARSENAL_ADDRESS) return render();
  const p = currentPlayer();
  const req = ++refreshReq;
  try {
    catalog ??= await readCatalog();
    const next = p ? await readPlayer(p.address) : null;
    if (req !== refreshReq) return;
    player = next;
    if (!p) setStatus('Connect wallet untuk claim VXL dan membeli skin.');
  } catch {
    if (req !== refreshReq) return;
    setStatus(`Gagal membaca arsenal dari ${TARGET_CHAIN.name}.`, true);
  }
  render();
}

export function initArsenalUI() {
  $('#claim-btn').addEventListener('click', () =>
    runTx(
      (onStep) => claimTokens(onStep),
      // The global daily cap may let only part of a claim through; the rest waits for tomorrow.
      () =>
        player?.claimable > 0
          ? `✓ Sebagian VXL di-claim. Batas harian tercapai, sisa ${fmt(player.claimable)} bisa di-claim besok.`
          : '✓ VXL berhasil di-claim!',
    ),
  );
  let lastAddress;
  wallet.subscribe((s) => {
    if (s.address === lastAddress) return;
    lastAddress = s.address;
    player = null;
    setStatus('');
    refresh();
  });
}
