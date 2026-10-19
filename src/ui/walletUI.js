import { identicon } from '../web3/identicon.js';
import { getPilotName, sanitizeName, setPilotName, shortAddress } from '../web3/profile.js';
import { onRankedChange, rankedState, refreshSession, signIn, signOut } from '../web3/ranked.js';
import { chainName, listWallets, onWalletsChange, TARGET_CHAIN, wallet, walletErrorText } from '../web3/wallet.js';

const $ = (s) => document.querySelector(s);
const fmt = (n) => Number(n).toLocaleString('id-ID');

export function currentPlayer() {
  const s = wallet.state;
  return s.status === 'connected' && s.address ? { address: s.address, name: getPilotName(s.address) } : null;
}

export function avatarImg(address, className) {
  const img = document.createElement('img');
  img.src = identicon(address);
  img.alt = '';
  img.className = className;
  return img;
}

export function initWalletUI({ onChange, getStats }) {
  const walletModal = $('#wallet-modal');
  const profileModal = $('#profile-modal');
  const connectBody = walletModal.querySelector('.modal-body');
  const rankedStep = $('#ranked-step');
  let pending = null;
  $('#switch-btn').textContent = `GANTI KE ${TARGET_CHAIN.name.toUpperCase()}`;

  for (const d of [walletModal, profileModal]) {
    d.addEventListener('click', (e) => {
      if (e.target === d || e.target.closest('[data-close]')) d.close();
    });
  }

  document
    .querySelectorAll('[data-wallet]')
    .forEach((b) => b.addEventListener('click', () => (currentPlayer() ? openProfile() : openConnect())));

  // ---------- connect ----------

  function setStatus(el, text, isError = false) {
    el.textContent = text;
    el.classList.toggle('error', isError);
  }

  function openConnect() {
    setStatus($('#wallet-status'), '');
    connectBody.hidden = false;
    rankedStep.hidden = true;
    renderWalletList();
    walletModal.showModal();
  }

  function renderWalletList() {
    const list = $('#wallet-list');
    const wallets = listWallets();
    list.replaceChildren();
    $('#wallet-empty').hidden = wallets.length > 0;
    for (const c of wallets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wallet-option';
      btn.disabled = pending !== null;
      // EIP-6963 icons are data URIs supplied by the extension; ignore anything else.
      if (typeof c.icon === 'string' && c.icon.startsWith('data:image/')) {
        const img = document.createElement('img');
        img.src = c.icon;
        img.alt = '';
        btn.append(img);
      } else {
        const ph = document.createElement('span');
        ph.className = 'wallet-icon';
        btn.append(ph);
      }
      const name = document.createElement('span');
      name.textContent = c.id === 'injected' ? 'Browser Wallet' : c.name;
      const st = document.createElement('span');
      st.className = 'state';
      st.textContent = pending === c.uid ? 'MENUNGGU…' : 'TERDETEKSI';
      btn.append(name, st);
      btn.addEventListener('click', () => doConnect(c));
      const li = document.createElement('li');
      li.append(btn);
      list.append(li);
    }
  }

  async function doConnect(connector) {
    const status = $('#wallet-status');
    pending = connector.uid;
    renderWalletList();
    setStatus(status, 'Konfirmasi koneksi di wallet kamu…');
    try {
      await wallet.connect(connector);
      await refreshSession();
      if (rankedState().active) {
        walletModal.close();
      } else {
        // Offer ranked sign-in right away; it's optional.
        connectBody.hidden = true;
        rankedStep.hidden = false;
        setStatus($('#ranked-step-status'), '');
        $('#ranked-step-btn').focus();
      }
    } catch (err) {
      setStatus(status, walletErrorText(err), true);
    } finally {
      pending = null;
      if (walletModal.open) renderWalletList();
    }
  }

  onWalletsChange(() => walletModal.open && renderWalletList());

  // ---------- ranked (SIWE) ----------

  async function activateRanked(statusEl, button) {
    button.disabled = true;
    setStatus(statusEl, 'Tanda tangani pesan login di wallet kamu…');
    try {
      await signIn();
      setStatus(statusEl, 'Mode ranked aktif!');
      return true;
    } catch (err) {
      setStatus(statusEl, err.status ? err.message : walletErrorText(err), true);
      return false;
    } finally {
      button.disabled = false;
    }
  }

  $('#ranked-step-btn').addEventListener('click', async (e) => {
    if (await activateRanked($('#ranked-step-status'), e.currentTarget)) walletModal.close();
  });

  $('#ranked-btn').addEventListener('click', async (e) => {
    if (rankedState().active) {
      await signOut();
      setStatus($('#profile-status'), 'Mode ranked dimatikan.');
    } else {
      await activateRanked($('#profile-status'), e.currentTarget);
    }
  });

  // ---------- profile ----------

  function openProfile() {
    setStatus($('#profile-status'), '');
    renderProfile();
    profileModal.showModal();
    loadBalance();
  }

  function renderProfile() {
    const p = currentPlayer();
    if (!p) {
      if (profileModal.open) profileModal.close();
      return;
    }
    const s = wallet.state;
    $('#profile-avatar').src = identicon(p.address);
    $('#profile-name').textContent = p.name;
    $('#profile-addr').textContent = shortAddress(p.address);
    $('#profile-addr').title = `${p.address} (klik untuk salin)`;
    if (document.activeElement !== $('#name-input')) $('#name-input').value = p.name;
    $('#profile-connector').textContent = s.connectorName ?? '—';

    const onTarget = s.chainId === TARGET_CHAIN.id;
    const net = $('#profile-network');
    net.textContent = onTarget ? TARGET_CHAIN.name : `${chainName(s.chainId)}`;
    net.className = onTarget ? 'net-ok' : 'net-bad';
    $('#switch-btn').hidden = onTarget;

    const ranked = rankedState().active;
    $('#ranked-status').textContent = ranked ? 'AKTIF' : 'Belum aktif';
    $('#ranked-status').className = ranked ? 'net-ok' : 'muted';
    $('#ranked-btn').textContent = ranked ? 'MATIKAN' : 'AKTIFKAN (SIGN-IN)';

    const st = getStats(p.address);
    $('#profile-best').textContent = fmt(st.best);
    $('#profile-tokens').textContent = fmt(st.tokens);
    $('#profile-played').textContent = fmt(st.played);
  }

  let balanceReq = 0;
  async function loadBalance() {
    const p = currentPlayer();
    const el = $('#profile-balance');
    if (!p) return;
    const req = ++balanceReq;
    el.textContent = 'memuat…';
    try {
      const eth = await wallet.balance(p.address);
      if (req === balanceReq) el.textContent = `${Number(eth).toFixed(4)} ETH`;
    } catch {
      if (req === balanceReq) el.textContent = 'tidak tersedia';
    }
  }

  $('#name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const p = currentPlayer();
    if (!p) return;
    const clean = sanitizeName($('#name-input').value);
    if (clean.length < 2) {
      setStatus($('#profile-status'), 'Nama minimal 2 karakter (huruf, angka, spasi, _ atau -).', true);
      return;
    }
    setPilotName(p.address, clean);
    $('#name-input').value = clean;
    setStatus($('#profile-status'), 'Nama pilot disimpan.');
    renderProfile();
    renderButtons();
    onChange?.();
  });

  $('#profile-addr').addEventListener('click', async () => {
    const p = currentPlayer();
    if (!p || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(p.address);
      setStatus($('#profile-status'), 'Alamat disalin.');
    } catch {
      setStatus($('#profile-status'), 'Gagal menyalin alamat.', true);
    }
  });

  $('#switch-btn').addEventListener('click', async () => {
    setStatus($('#profile-status'), 'Konfirmasi ganti jaringan di wallet…');
    try {
      await wallet.switchToTarget();
      setStatus($('#profile-status'), `Sekarang di ${TARGET_CHAIN.name}.`);
    } catch (err) {
      setStatus($('#profile-status'), walletErrorText(err), true);
    }
  });

  $('#disconnect-btn').addEventListener('click', async () => {
    await wallet.disconnect().catch(() => {});
    profileModal.close();
  });

  // ---------- buttons ----------

  function renderButtons() {
    const p = currentPlayer();
    const ranked = rankedState().active;
    const busy = ['connecting', 'reconnecting'].includes(wallet.state.status);
    document.querySelectorAll('[data-wallet]').forEach((b) => {
      b.replaceChildren();
      b.classList.toggle('connected', !!p);
      b.classList.toggle('ranked', !!p && ranked);
      if (p) {
        b.append(avatarImg(p.address, 'avatar'), document.createTextNode(p.name));
        b.setAttribute('aria-label', `Profil pilot ${p.name}`);
      } else {
        b.textContent = busy ? 'MENGHUBUNGKAN…' : 'CONNECT WALLET';
        b.removeAttribute('aria-label');
      }
    });
  }

  let lastAddress = wallet.state.address;
  wallet.subscribe((s) => {
    renderButtons();
    if (profileModal.open) {
      renderProfile();
      if (s.address !== lastAddress) loadBalance();
    }
    lastAddress = s.address;
    onChange?.();
  });
  onRankedChange(() => {
    renderButtons();
    if (profileModal.open) renderProfile();
    onChange?.();
  });
  wallet.init();
  refreshSession();
}
