// "Panduan Ranked": a live checklist from no wallet to an active ranked session.
import { FAUCETS } from '../web3/chains.js';
import { rankedState, signIn } from '../web3/ranked.js';
import { listWallets, TARGET_CHAIN, wallet, walletErrorText } from '../web3/wallet.js';

const $ = (s) => document.querySelector(s);
let balance = null; // ETH on the target chain, null when unknown

function step(label, done, action) {
  const li = document.createElement('li');
  li.className = done ? 'done' : '';
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.textContent = done ? '✓' : '·';
  const text = document.createElement('span');
  text.className = 'label';
  text.textContent = label;
  li.append(mark, text);
  if (!done && action) li.append(action);
  return li;
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-sm';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function link(label, href) {
  const a = document.createElement('a');
  a.className = 'btn btn-sm btn-ghost';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = label;
  return a;
}

async function run(action, statusText) {
  const status = $('#guide-status');
  status.textContent = statusText;
  status.classList.remove('error');
  try {
    await action();
    status.textContent = '';
  } catch (err) {
    status.textContent = err.status ? err.message : walletErrorText(err);
    status.classList.add('error');
  }
  render();
}

function render() {
  const s = wallet.state;
  const connected = s.status === 'connected';
  const hasWallet = connected || listWallets().length > 0;
  const onChain = connected && s.chainId === TARGET_CHAIN.id;
  const local = TARGET_CHAIN.id === 31337;
  const funded = local || (balance !== null && balance > 0);
  const faucet = FAUCETS[TARGET_CHAIN.id];

  $('#guide-steps').replaceChildren(
    step('Pasang wallet di browser (MetaMask atau Rabby)', hasWallet, link('PASANG METAMASK', 'https://metamask.io/download/')),
    step(
      'Hubungkan wallet ke VOXEL//RAID',
      connected,
      button('CONNECT', () => document.querySelector('[data-wallet]').click()),
    ),
    step(
      `Pakai jaringan ${TARGET_CHAIN.name}`,
      onChain,
      connected ? button('GANTI JARINGAN', () => run(() => wallet.switchToTarget(), 'Konfirmasi di wallet…')) : null,
    ),
    step(
      local ? 'ETH untuk gas (otomatis tersedia di chain lokal)' : `Punya sedikit ETH di ${TARGET_CHAIN.name} untuk gas`,
      funded,
      faucet ? link('AMBIL ETH GRATIS', faucet) : null,
    ),
    step(
      'Aktifkan mode ranked (tanda tangan sekali, tanpa gas)',
      rankedState().active,
      connected ? button('AKTIFKAN', () => run(() => signIn(), 'Tanda tangani pesan di wallet…')) : null,
    ),
  );
}

async function refreshBalance() {
  const { address } = wallet.state;
  balance = null;
  if (address) {
    try {
      balance = Number(await wallet.balance(address));
    } catch {
      balance = null;
    }
  }
  render();
}

export function initGuideUI() {
  const modal = $('#guide-modal');
  document.querySelectorAll('[data-open-guide]').forEach((b) =>
    b.addEventListener('click', () => {
      $('#guide-status').textContent = '';
      render();
      modal.showModal();
      refreshBalance();
    }),
  );
  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('[data-close]')) modal.close();
  });
  wallet.subscribe(() => modal.open && refreshBalance());
}
