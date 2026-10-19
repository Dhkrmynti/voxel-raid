import './style.css';
import { sfx } from './game/audio.js';
import { music } from './game/music.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings.js';
import { loadScores, playerSummary, saveScore } from './scores.js';
import { loadReplay } from './replays.js';
import { equippedSkin, initArsenalUI, refresh as refreshArsenal } from './ui/arsenalUI.js';
import { currentDaily, initDailyUI, loadDaily, render as renderDaily } from './ui/dailyUI.js';
import { initRewardUI, refreshReward } from './ui/rewardUI.js';
import { readWeeklyRewards } from './web3/arsenal.js';
import { avatarImg, currentPlayer, initWalletUI } from './ui/walletUI.js';
import { api } from './web3/api.js';
import { getPilotName, rememberNames, shortAddress } from './web3/profile.js';
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
let rankedRun = null; // { ticket, seed, arena, mode } for ranked runs, null otherwise
let lastMode = { daily: false }; // what "MAIN LAGI" repeats
let lastRun = null;
let chainBoard = null; // last on-chain leaderboard read
let weeklyRewards = null; // VXL per rank, read once from the token

async function getGame() {
  if (!game) {
    const { Game } = await loadGame();
    game = new Game({ container: gameEl, onGameOver: showGameOver, onQuit: showMenu, onMuteKey: toggleAllSound, touch: TOUCH });
    game.setQualityMode(settings.quality);
    game.setControls(settings);
    if (import.meta.env.DEV) window.__game = game;
  }
  return game;
}

// ---------- arena choice ----------

const ARENA_KEY = 'voxelraid.arena.v1';
function selectedArena() {
  return $('[data-arena][aria-checked="true"]')?.dataset.arena ?? 'citadel';
}
function selectArena(id) {
  document.querySelectorAll('[data-arena]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.arena === id)));
  try {
    localStorage.setItem(ARENA_KEY, id);
  } catch {
    // remembered for this session only
  }
}
document.querySelectorAll('[data-arena]').forEach((b) => b.addEventListener('click', () => selectArena(b.dataset.arena)));
try {
  const saved = localStorage.getItem(ARENA_KEY);
  if (saved && $(`[data-arena="${saved}"]`)) selectArena(saved);
} catch {
  // default arena
}

function showGameScreen() {
  landing.hidden = true;
  heroCanvas.hidden = true;
  hero.setActive(false);
  gameEl.hidden = false;
  overEl.hidden = true;
}

/** @param {{ daily?: boolean }} [mode] daily runs share one server-chosen seed and arena per day */
async function startGame({ daily = false } = {}) {
  lastMode = { daily };
  const today = daily ? currentDaily() : null;
  if (daily && !today) {
    $('#daily-note').textContent = 'Daily challenge belum bisa dimuat. Coba lagi sebentar.';
    return;
  }
  showGameScreen();
  const myRun = ++runId;
  const name = currentPlayer()?.name ?? 'GUEST';
  $('#hud-pilot').textContent = name;
  // Ranked runs must use the server's seed, so wait for the ticket before the first tick.
  const arena = today?.arena ?? selectedArena();
  const [ranked, g] = await Promise.all([startRankedRun(arena, daily ? 'daily' : 'ranked'), getGame()]);
  if (myRun !== runId) return;
  rankedRun = ranked;
  const tag = ranked ? (daily ? ' · DAILY' : ' · RANKED') : daily ? ' · LATIHAN DAILY' : '';
  $('#hud-pilot').textContent = `${name}${tag}`;
  g.setSkin(equippedSkin());
  // Guests practise the daily on the same public seed, just without a ticket.
  g.start({ seed: ranked?.seed ?? today?.seed, arena: ranked?.arena ?? arena });
}

async function watchReplay(source) {
  const status = $('#replay-status');
  status.textContent = 'Memuat replay…';
  status.classList.remove('error');
  try {
    const [replay, g] = await Promise.all([loadReplay(source), getGame()]);
    status.textContent = '';
    showGameScreen();
    $('#hud-pilot').textContent = 'REPLAY';
    g.setSkin(null);
    g.startReplay(replay);
  } catch (err) {
    status.textContent = err.message;
    status.classList.add('error');
  }
}

function toMenu() {
  if (game?.running)
    game.quit(); // quit() calls back into showMenu
  else showMenu();
}

function showMenu() {
  loadChainBoard();
  loadDaily();
  refreshArsenal();
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
  lastRun = { stats, replay, ticket: rankedRun?.ticket ?? null, daily: rankedRun?.mode === 'daily', submitted: false };
  const ranked = player && rankedState().active && !!lastRun.ticket;
  $('#go-pilot').textContent = !player
    ? 'Kamu main sebagai guest. Connect wallet supaya skor & token tercatat atas namamu.'
    : ranked
      ? `Run ${lastRun.daily ? 'daily' : 'ranked'} milik ${player.name}. Kirim untuk masuk leaderboard${lastRun.daily ? ' daily dan' : ''} mingguan.`
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
    const { hash, dailyRank } = await submitRun(lastRun.ticket, lastRun.stats, lastRun.replay, (step) =>
      setStatus(STEP_TEXT[step]),
    );
    lastRun.submitted = true;
    btn.hidden = true;
    setStatus(`✓ Skor tercatat on-chain!${dailyRank ? ` Peringkat daily #${dailyRank}.` : ''} `);
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
    loadDaily();
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
    messageRow(body, 6, 'Leaderboard on-chain belum tersedia.');
    return;
  }
  $('#lb-refresh').disabled = true;
  try {
    chainBoard = await readLeaderboard();
    weeklyRewards ??= await readWeeklyRewards().catch(() => null);
    renderChainBoard();
    refreshReward(chainBoard.week, weeklyRewards);
    // Other pilots' names live on the server; fill them in once they arrive.
    const addresses = chainBoard.top.map((e) => e.player);
    if (addresses.length) {
      api
        .profiles(addresses)
        .then(({ names }) => {
          rememberNames(names);
          renderChainBoard();
        })
        .catch(() => {});
    }
  } catch {
    chainBoard = null;
    $('#lb-meta').textContent = `Gagal membaca ${TARGET_CHAIN.name}.`;
    messageRow(body, 6, 'Leaderboard on-chain tidak bisa dimuat. Coba muat ulang.');
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
    messageRow(body, 6, 'Belum ada skor minggu ini. Jadilah yang pertama!');
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
      const reward = document.createElement('td');
      reward.className = 'reward';
      reward.textContent = weeklyRewards ? `${weeklyRewards[i]} VXL` : '—';
      const watch = document.createElement('td');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost btn-sm';
      btn.textContent = 'TONTON';
      btn.addEventListener('click', () => watchReplay({ week: chainBoard.week, player: e.player }));
      watch.append(btn);
      tr.append(rank, pilotCell(e.player), score, wave, reward, watch);
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

document.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', () => startGame()));
$('#retry-btn').addEventListener('click', () => startGame(lastMode));
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
const settingsModal = $('#settings-modal');
const settingsForm = $('#settings-form');
const SETTING_FORMAT = {
  sensitivity: (v) => `×${v.toFixed(1)}`,
  touchSensitivity: (v) => `×${v.toFixed(1)}`,
  fov: (v) => `${v}°`,
  sfxVolume: (v) => `${Math.round(v * 100)}%`,
  musicVolume: (v) => `${Math.round(v * 100)}%`,
};
let appliedQuality = null;

function applySettings() {
  sfx.setMuted(!settings.sfx);
  sfx.setVolume(settings.sfxVolume);
  music.setMuted(!settings.music);
  music.setVolume(settings.musicVolume);
  game?.setControls(settings);
  // Re-applying quality restarts AUTO's frame-rate measurement, so only do it on change.
  if (game && appliedQuality !== settings.quality) {
    game.setQualityMode(settings.quality);
    appliedQuality = settings.quality;
  }
  saveSettings(settings);
}

function renderSettingsForm() {
  for (const el of settingsForm.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') el.checked = settings[el.name];
    else el.value = settings[el.name];
  }
  for (const out of settingsForm.querySelectorAll('output')) {
    out.textContent = SETTING_FORMAT[out.dataset.for](settings[out.dataset.for]);
  }
}

settingsForm.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.name) return;
  settings[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
  renderSettingsForm();
  applySettings();
});
settingsForm.addEventListener('submit', (e) => e.preventDefault());
$('#settings-reset').addEventListener('click', () => {
  Object.assign(settings, DEFAULT_SETTINGS);
  renderSettingsForm();
  applySettings();
});
document.querySelectorAll('[data-open-settings]').forEach((b) =>
  b.addEventListener('click', () => {
    renderSettingsForm();
    settingsModal.showModal();
  }),
);
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal || e.target.closest('[data-close]')) settingsModal.close();
});

// M in-game mutes or unmutes sound and music together.
function toggleAllSound() {
  const on = !(settings.sfx || settings.music);
  settings.sfx = on;
  settings.music = on;
  applySettings();
}

applySettings();

if (TOUCH) $('#touch-note').hidden = false;

initWalletUI({
  getStats: (address) => playerSummary(address),
  onChange: () => {
    renderStats();
    renderLeaderboard();
    renderChainBoard();
    renderDaily();
    if (chainBoard) refreshReward(chainBoard.week, weeklyRewards);
  },
});
loadChainBoard();
initArsenalUI();
initDailyUI({ onPlay: () => startGame({ daily: true }), onWatch: watchReplay });
initRewardUI({ onClaimed: () => refreshArsenal() });
