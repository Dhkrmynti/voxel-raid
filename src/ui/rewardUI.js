// "Last week's reward" card: shows the pilot's rank on the finished week and lets them claim.
import { claimWeeklyReward, readRewardStatus, TOKEN_ADDRESS } from '../web3/arsenal.js';
import { TARGET_CHAIN, walletErrorText } from '../web3/wallet.js';
import { currentPlayer } from './walletUI.js';

const $ = (s) => document.querySelector(s);
const STEP_TEXT = {
  switching: `Ganti jaringan ke ${TARGET_CHAIN.name} di wallet…`,
  confirm: 'Konfirmasi transaksi di wallet kamu…',
  pending: 'Menunggu konfirmasi blok…',
};

let state = null; // { week, rank, reward, claimed, opensAt }
let busy = false;

function untilText(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.ceil((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h} jam ${m} menit` : `${m} menit`;
}

function render() {
  const card = $('#reward-card');
  card.hidden = !state || state.rank === 0;
  if (card.hidden) return;
  const { week, rank, reward, claimed, opensAt } = state;
  $('#reward-title').textContent = `Minggu #${week}: kamu peringkat #${rank}`;
  $('#reward-amount').textContent = `${reward.toLocaleString('id-ID')} VXL`;
  const btn = $('#reward-btn');
  const wait = opensAt - Date.now();
  if (claimed) {
    btn.hidden = true;
    $('#reward-note').textContent = '✓ Hadiah sudah di-claim.';
  } else if (wait > 0) {
    btn.hidden = true;
    $('#reward-note').textContent = `Bisa di-claim dalam ${untilText(wait)} (masa verifikasi setelah minggu berakhir).`;
  } else {
    btn.hidden = false;
    btn.disabled = busy;
    if (!busy) $('#reward-note').textContent = '';
  }
}

/**
 * @param {number} currentWeek the leaderboard's running week; rewards are for the one before
 * @param {number[]} rewards VXL per rank
 */
let refreshReq = 0; // a slow read for a previous wallet must not overwrite the current one

export async function refreshReward(currentWeek, rewards) {
  const p = currentPlayer();
  const req = ++refreshReq;
  if (!p || !TOKEN_ADDRESS || !rewards) {
    state = null;
    return render();
  }
  const week = currentWeek - 1;
  let next = null;
  try {
    const s = await readRewardStatus(week, p.address);
    next = { week, ...s, reward: s.rank ? rewards[s.rank - 1] : 0 };
  } catch {
    // unknown: the card stays hidden
  }
  if (req !== refreshReq) return;
  state = next;
  render();
}

export function initRewardUI({ onClaimed }) {
  $('#reward-btn').addEventListener('click', async () => {
    if (!state || busy) return;
    busy = true;
    render();
    const note = $('#reward-note');
    note.classList.remove('error');
    try {
      await claimWeeklyReward(state.week, (step) => (note.textContent = STEP_TEXT[step]));
      state.claimed = true;
      onClaimed?.();
    } catch (err) {
      note.textContent = walletErrorText(err);
      note.classList.add('error');
    } finally {
      busy = false;
      render();
    }
  });
  setInterval(render, 60_000);
}
