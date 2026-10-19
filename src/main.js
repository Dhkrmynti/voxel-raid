import './style.css';
import { sfx } from './game/audio.js';
import { music } from './game/music.js';
import { loadSettings, QUALITY_MODES, saveSettings } from './settings.js';
import { loadScores, playerSummary, saveScore } from './scores.js';
import { equippedSkin, initArsenalUI, refresh as refreshArsenal } from './ui/arsenalUI.js';
import { avatarImg, currentPlayer, initWalletUI } from './ui/walletUI.js';
import { getPilotName, shortAddress } from './web3/profile.js';
import { LEADERBOARD_ADDRESS, rankedState, readLeaderboard, startRankedRun, submitRun, txUrl } from './web3/ranked.js';
import { TARGET_CHAIN, walletErrorText } from './web3/wallet.js';

const $ = (s) => document.querySelector(s);
const landing = $('#landing');
const heroCanvas = $('#hero-canvas');
const gameEl = $('#game');
const overEl = $('#gameover-overlay');
// The 3D hero and the game load lazily so the landing page is usable before three.js arrives.
let hero = { setActive() {} };
import('./hero.js').then(({ initHero }) => {
  hero = initHero(heroCanvas, $('.hero'));
  hero.setActive(!landing.hidden);
});
let gameModule = null;
const loadGame = () => (gameModule ??= import('./game/Game.js'));
// Warm the game chunk up while the player reads the landing page.
(window.requestIdleCallback ?? ((cb) => setTimeout(cb, 1500)))(() => loadGame());
const fmt = (n) => Number(n).toLocaleString('id-ID');
// Touch controls on phones/tablets; `?touch` forces them for testing on desktop (dev only).
const TOUCH =
  window.matchMedia('(pointer: coarse)').matches || (import.meta.env.DEV && new URLSearchParams(location.search).has('touch'));

let game = null;
let runId = 0;
let rankedRun = null; // { ticket, seed } for ranked runs, null otherwise
let lastRun = null;
let chainBoard = null; // last on-chain leaderboard read

async function getGame() {
  if (!game) {
    const { Game } = await loadGame();
    game = new Game({ container: gameEl, onGameOver: showGameOver, onMuteKey: toggleAllSound, touch: TOUCH });
    game.setQualityMode(settings.quality);
    if (import.meta.env.DEV) window.__game = game;
  }
  return game;
}

async function startGame() {
  landing.hidden = true;
  heroCanvas.hidden = true;
  hero.setActive(false);
  gameEl.hidden = false;
  overEl.hidden = true;
  const myRun = ++runId;
  const name = currentPlayer()?.name ?? 'GUEST';
  $('#hud-pilot').textContent = name;
  // Ranked runs must use the server's seed, so wait for the ticket before the first tick.
  const [ranked, g] = await Promise.all([startRankedRun(), getGame()]);
  if (myRun !== runId) return;
  rankedRun = ranked;
  $('#hud-pilot').textContent = ranked ? `${name} · RANKED` : name;
  g.setSkin(equippedSkin());
  g.start({ seed: ranked?.seed });
}

function toMenu() {
  loadChainBoard();
  refreshArsenal();
  game?.quit();
  gameEl.hidden = true;
  overEl.hidden = true;
  landing.hidden = false;
  heroCanvas.hidden = false;
  hero.setActive(true);
  renderLeaderboard();
  renderStats();
  window.scrollTo(0, 0);
}

function showGameOver(stats, replay) {
  const player = currentPlayer();
  const { rank, best, isBest } = saveScore(stats, player);
  $('#go-score').textContent = fmt(stats.score);
  $('#go-wave').textContent = stats.wave;
  $('#go-kills').textContent = stats.kills;
  $('#go-tokens').textContent = stats.tokens;
  $('#go-best').textContent = isBest ? 'SKOR TERBAIK BARU!' : `Best: ${fmt(best)}${rank ? ` · Peringkat #${rank}` : ''}`;
  $('#go-best').classList.toggle('new', isBest);
  lastRun = { stats, replay, ticket: rankedRun?.ticket ?? null, submitted: false };
  const ranked = player && rankedState().active && !!lastRun.ticket;
  $('#go-pilot').textContent = !player
    ? 'Kamu main sebagai guest. Connect wallet supaya skor & token tercatat atas namamu.'
    : ranked
      ? `Run ranked milik ${player.name}. Kirim ke chain untuk masuk leaderboard mingguan.`
      : `Tercatat lokal untuk ${player.name}. Aktifkan mode ranked di profil supaya skor bisa dikirim on-chain.`;
  $('#go-chain').hidden = !ranked;
  $('#chain-submit-btn').hidden = false;
  $('#chain-submit-btn').disabled = false;
  $('#chain-status').replaceChildren();
  // Short delay so the death animation reads before the panel appears
  setTimeout(() => (overEl.hidden = false), 900);
}

const STEP_TEXT = {
  validating: 'Server memutar ulang replay run kamu…',
  switching: `Ganti jaringan ke ${TARGET_CHAIN.name} di wallet…`,
  confirm: 'Konfirmasi transaksi di wallet kamu…',
  pending: 'Menunggu konfirmasi blok…',
};

async function submitLastRun() {
  const btn = $('#chain-submit-btn');
  const status = $('#chain-status');
  const setStatus = (text, isError = false) => {
    status.replaceChildren(text);
    status.classList.toggle('error', isError);
  };
  if (!lastRun || lastRun.submitted) return;
  btn.disabled = true;
  try {
    if (!lastRun.ticket) throw new Error('Run ini tidak punya tiket ranked (server offline saat game dimulai?).');
    const hash = await submitRun(lastRun.ticket, lastRun.stats, lastRun.replay, (step) => setStatus(STEP_TEXT[step]));
    lastRun.submitted = true;
    btn.hidden = true;
    setStatus('✓ Skor tercatat on-chain! ');
    const url = txUrl(hash);
    if (url) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Lihat transaksi';
      status.append(a);
    } else {
      status.append(`Tx ${shortAddress(hash)}`);
    }
    loadChainBoard();
    refreshArsenal();
  } catch (err) {
    setStatus(err.status ? err.message : walletErrorText(err), true);
    btn.disabled = false;
  }
}

function pilotCell(address) {
  const td = document.createElement('td');
  td.className = 'pilot';
  td.append(avatarImg(address, 'avatar'), document.createTextNode(getPilotName(address)));
  return td;
}

function messageRow(body, colSpan, text) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = colSpan;
  td.className = 'empty';
  td.textContent = text;
  tr.append(td);
  body.replaceChildren(tr);
}

async function loadChainBoard() {
  const body = $('#lb-chain-body');
  if (!LEADERBOARD_ADDRESS) {
    $('#lb-meta').textContent = `Contract belum di-deploy di ${TARGET_CHAIN.name}.`;
    messageRow(body, 4, 'Leaderboard on-chain belum tersedia.');
    return;
  }
  $('#lb-refresh').disabled = true;
  try {
    chainBoard = await readLeaderboard();
    renderChainBoard();
  } catch {
    chainBoard = null;
    $('#lb-meta').textContent = `Gagal membaca ${TARGET_CHAIN.name}.`;
    messageRow(body, 4, 'Leaderboard on-chain tidak bisa dimuat. Coba muat ulang.');
  } finally {
    $('#lb-refresh').disabled = false;
  }
}

function renderChainBoard() {
  if (!chainBoard) return;
  const reset = chainBoard.resetsAt.toLocaleString('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  $('#lb-meta').textContent =
    `Minggu #${chainBoard.week} · reset ${reset} · ${TARGET_CHAIN.name} · ${shortAddress(LEADERBOARD_ADDRESS)}`;
  const body = $('#lb-chain-body');
  if (!chainBoard.top.length) {
    messageRow(body, 4, 'Belum ada skor minggu ini. Jadilah yang pertama!');
    return;
  }
  const me = currentPlayer()?.address?.toLowerCase();
  body.replaceChildren(
    ...chainBoard.top.map((e, i) => {
      const tr = document.createElement('tr');
      if (e.player.toLowerCase() === me) tr.className = 'me';
      const rank = document.createElement('td');
      rank.textContent = `#${i + 1}`;
      const score = document.createElement('td');
      score.textContent = fmt(e.score);
      const wave = document.createElement('td');
      wave.textContent = e.wave;
      tr.append(rank, pilotCell(e.player), score, wave);
      return tr;
    }),
  );
}

function selectTab(name) {
  for (const tab of document.querySelectorAll('[data-tab]')) {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  $('#lb-chain').hidden = name !== 'chain';
  $('#lb-local').hidden = name !== 'local';
}

function renderStats() {
  const player = currentPlayer();
  const s = playerSummary(player?.address);
  $('#stat-best').textContent = fmt(s.best);
  $('#stat-tokens').textContent = fmt(s.tokens);
  $('#stat-played').textContent = fmt(s.played);
  $('#stats-owner').textContent = player?.name ?? 'GUEST';
}

function renderLeaderboard() {
  const body = $('#lb-body');
  const me = currentPlayer()?.address?.toLowerCase();
  const scores = loadScores();
  body.replaceChildren();
  if (!scores.length) {
    messageRow(body, 6, 'Belum ada skor. Jadilah yang pertama!');
    return;
  }
  scores.forEach((s, i) => {
    const tr = document.createElement('tr');
    const addr = s.player?.address;
    if (addr && addr.toLowerCase() === me) tr.className = 'me';

    let pilot;
    if (addr) {
      pilot = pilotCell(addr);
    } else {
      pilot = document.createElement('td');
      pilot.textContent = 'GUEST';
    }

    const cells = [`#${i + 1}`, pilot, fmt(s.score), s.wave, s.kills, new Date(s.date).toLocaleDateString('id-ID')];
    for (const v of cells) {
      if (v instanceof HTMLElement) {
        tr.append(v);
        continue;
      }
      const td = document.createElement('td');
      td.textContent = v;
      tr.append(td);
    }
    body.append(tr);
  });
}

document.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', startGame));
$('#retry-btn').addEventListener('click', startGame);
$('#chain-submit-btn').addEventListener('click', submitLastRun);
$('#lb-refresh').addEventListener('click', loadChainBoard);
document.querySelectorAll('[data-tab]').forEach((tab) => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));
$('[role="tablist"]').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const next = $('#tab-chain').getAttribute('aria-selected') === 'true' ? 'local' : 'chain';
  selectTab(next);
  $(`#tab-${next}`).focus();
});
$('#menu-btn').addEventListener('click', toMenu);
$('#resume-btn').addEventListener('click', () => game?.resume());
$('#quit-btn').addEventListener('click', toMenu);
const settings = loadSettings();
const SETTING_LABELS = { sfx: 'SUARA', music: 'MUSIK', quality: 'KUALITAS' };
const QUALITY_LABELS = { auto: 'AUTO', high: 'TINGGI', low: 'RENDAH' };

function applySettings() {
  sfx.setMuted(!settings.sfx);
  music.setMuted(!settings.music);
  game?.setQualityMode(settings.quality);
  document.querySelectorAll('[data-setting]').forEach((b) => {
    const key = b.dataset.setting;
    const value = key === 'quality' ? QUALITY_LABELS[settings.quality] : settings[key] ? 'ON' : 'OFF';
    b.textContent = `${SETTING_LABELS[key]}: ${value}`;
    if (key !== 'quality') b.setAttribute('aria-pressed', String(settings[key]));
  });
  saveSettings(settings);
}

// M in-game mutes or unmutes sound and music together.
function toggleAllSound() {
  const on = !(settings.sfx || settings.music);
  settings.sfx = on;
  settings.music = on;
  applySettings();
}

document.querySelectorAll('[data-setting]').forEach((b) =>
  b.addEventListener('click', () => {
    const key = b.dataset.setting;
    if (key === 'quality') settings.quality = QUALITY_MODES[(QUALITY_MODES.indexOf(settings.quality) + 1) % QUALITY_MODES.length];
    else settings[key] = !settings[key];
    applySettings();
  }),
);
applySettings();

if (TOUCH) $('#touch-note').hidden = false;

initWalletUI({
  getStats: (address) => playerSummary(address),
  onChange: () => {
    renderStats();
    renderLeaderboard();
    renderChainBoard();
  },
});
loadChainBoard();
initArsenalUI();
