// Daily challenge section: today's arena, reset countdown, top 10 with replays.
import { api } from '../web3/api.js';
import { getPilotName, rememberNames } from '../web3/profile.js';
import { rankedState } from '../web3/ranked.js';
import { avatarImg, currentPlayer } from './walletUI.js';

const $ = (s) => document.querySelector(s);
const fmt = (n) => Number(n).toLocaleString('id-ID');
const ARENA_NAMES = { citadel: 'CITADEL', foundry: 'FOUNDRY' };

let daily = null;
let offline = false;

/** Today's challenge ({ day, seed, arena, resetsAt, top }) or null when the server is unreachable. */
export function currentDaily() {
  return daily;
}

export async function loadDaily() {
  try {
    daily = await api.daily();
    offline = false;
    rememberNames(Object.fromEntries(daily.top.filter((e) => e.name).map((e) => [e.address, e.name])));
  } catch {
    daily = null;
    offline = true;
  }
  render();
}

function countdown() {
  const el = $('#daily-reset');
  if (!daily) {
    el.textContent = '—';
    return;
  }
  const left = Math.max(0, daily.resetsAt - Date.now());
  if (left === 0) {
    loadDaily();
    return;
  }
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  el.textContent = [h, m, s].map((v) => String(v).padStart(2, '0')).join(':');
}

export function render() {
  $('#daily-arena').textContent = daily ? ARENA_NAMES[daily.arena] : '—';
  countdown();
  const player = currentPlayer();
  $('#daily-note').textContent = offline
    ? 'Server daily sedang offline. Coba lagi nanti.'
    : !player
      ? 'Sebagai guest kamu main versi latihan (tidak masuk papan). Connect wallet dan aktifkan ranked untuk ikut peringkat.'
      : rankedState().active
        ? 'Mode ranked aktif. Setelah game over, kirim skormu supaya masuk papan daily.'
        : 'Aktifkan mode ranked di profil untuk ikut peringkat daily.';

  const body = $('#daily-body');
  const top = daily?.top ?? [];
  if (!top.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'empty';
    td.textContent = offline ? 'Papan daily tidak bisa dimuat.' : 'Belum ada skor hari ini. Jadilah yang pertama!';
    tr.append(td);
    body.replaceChildren(tr);
    return;
  }
  const me = player?.address?.toLowerCase();
  body.replaceChildren(
    ...top.map((e, i) => {
      const tr = document.createElement('tr');
      if (e.address.toLowerCase() === me) tr.className = 'me';
      const rank = document.createElement('td');
      rank.textContent = `#${i + 1}`;
      const pilot = document.createElement('td');
      pilot.className = 'pilot';
      pilot.append(avatarImg(e.address, 'avatar'), document.createTextNode(getPilotName(e.address)));
      const score = document.createElement('td');
      score.textContent = fmt(e.score);
      const wave = document.createElement('td');
      wave.textContent = e.wave;
      const watch = document.createElement('td');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost btn-sm';
      btn.textContent = 'TONTON';
      btn.dataset.session = e.sessionId;
      watch.append(btn);
      tr.append(rank, pilot, score, wave, watch);
      return tr;
    }),
  );
}

export function initDailyUI({ onPlay, onWatch }) {
  $('#daily-play').addEventListener('click', onPlay);
  $('#daily-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-session]');
    if (btn) onWatch({ sessionId: btn.dataset.session });
  });
  setInterval(countdown, 1000);
  loadDaily();
}
