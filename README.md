# VOXEL//RAID

Arena shooter 3D bergaya voxel/pixel di browser, dengan leaderboard mingguan on-chain, token VXL, dan skin senjata NFT
di **Robinhood Chain** (L2 Arbitrum Orbit, gas dibayar dengan ETH).

| Jaringan | Chain ID | Dipakai untuk |
| --- | --- | --- |
| Anvil (lokal) | 31337 | Development (`npm run dev:full`) |
| Robinhood Chain Testnet | 46630 | Default target, testing publik |
| Robinhood Chain | 4663 | Mainnet (aset sungguhan, deploy hanya setelah audit) |

## Jalankan

```bash
npm install            # di Windows: npm install --ignore-scripts (lihat catatan di bawah)
npm run dev:full       # Anvil + deploy contract + API + Vite → http://localhost:5173
```

`dev:full` membuat `.env.local` berisi secret lokal baru saat pertama kali dijalankan, menjalankan node Anvil,
lalu men-deploy tiga contract (leaderboard, VXL, arsenal) dan mendaftarkan skin, kemudian menyalakan server API
(port 8787) dan Vite. State Anvil hilang setiap kali di-restart, jadi contract akan di-deploy ulang dari nol.

| Perintah | Fungsi |
| --- | --- |
| `npm run dev` | Frontend saja (tanpa server ranked) |
| `npm test` | Test integrasi contract + API + validasi skor di Anvil sementara |
| `npm run compile` | Compile contract ke `contracts/out/` |
| `npm run deploy` | Deploy semua contract ke jaringan di `CHAIN` |
| `npm run build` | Build frontend ke `dist/` |

Untuk tes UI wallet tanpa ekstensi, buka `http://localhost:5173/?mockWallet` (hanya di mode dev). Di Anvil,
mock wallet memakai akun default Anvil yang tidak terkunci, sehingga login, transaksi, dan permit benar-benar jalan.

**MetaMask + Anvil:** setelah Anvil di-restart, MetaMask bisa menyimpan nonce lama dan muncul error "nonce too high".
Perbaiki lewat Settings → Advanced → *Clear activity tab data*.

**Windows:** postinstall `@foundry-rs/anvil` memakai sintaks shell Unix dan gagal di `cmd`. Binary Anvil sudah ikut
terpasang lewat optional dependency, jadi `npm install --ignore-scripts` aman dipakai.

## Cara kerja

```
pemain ── SIWE (tanda tangan, tanpa gas) ──▶ API             → cookie sesi
pemain ── mulai game ──────────────────────▶ API             → tiket + seed acak dari server
pemain ── main (setiap input direkam) ─────▶ browser         → replay ringkas (~5 KB/menit gzip)
pemain ── game over: replay + tiket ───────▶ API             → simulasi ulang → atestasi EIP-712
pemain ── submitScore(atestasi) ───────────▶ Leaderboard     → top 10 mingguan + total koin
pemain ── claim() ─────────────────────────▶ VoxelToken      → 1 koin = 1 VXL
pemain ── permit (tanda tangan) + buy ─────▶ VoxelArsenal    → VXL dibakar, NFT skin di-mint
```

### Anti-cheat: replay yang diverifikasi server

- **Simulasi deterministik** (`src/game/sim.js`): fixed 60 Hz, RNG ber-seed, hitbox matematis, tanpa grafis.
  Rendering, suara, dan HUD (`Game.js`) hanya membaca state simulasi.
- **Math deterministik** (`src/game/dmath.js`): `Math.sin/cos/atan2/exp/hypot` bisa berbeda di digit terakhir
  antar-engine (V8, SpiderMonkey, JavaScriptCore). Simulasi memakai versi sendiri yang hanya terdiri dari `+ − × ÷`
  dan `sqrt`, sehingga replay identik bit-per-bit di Chrome, Firefox, Safari, dan Node.
- **Seed dari server**: pemain tidak bisa memilih "dunia" yang menguntungkan.
- **Server memutar ulang run** (`src/game/verify.js`) dan menandatangani hasil simulasinya sendiri. Skor yang dikirim
  browser hanya dipakai sebagai cek konsistensi. Run ditolak kalau:
  - hasil replay berbeda dari skor yang diklaim
  - replay tidak berakhir dengan kematian, atau masih berlanjut setelah mati
  - run berjalan lebih cepat dari waktu nyata
  - `SIM_VERSION` berbeda
  - replay rusak, terlalu besar, atau berupa zip bomb
- Cheat yang **tertangkap**: edit skor atau statistik, edit memori (HP, amunisi, damage), speedhack, dan
  memilih seed sendiri.
- Cheat yang **tidak tertangkap**: bot atau aimbot yang memberi input "sempurna" lewat kontrol normal. Ini batas
  semua game yang berjalan di sisi klien. Mitigasi lanjutan bisa berupa analisis statistik input (akurasi atau
  kecepatan reaksi yang tidak manusiawi) dan rate limit per wallet.
- Biaya verifikasi: ~13 ms CPU per menit permainan.

Pengamanan contract (detail lengkap dan runbook insiden ada di [SECURITY.md](SECURITY.md)):
- Batas skor dan token per run, serta batas claim VXL harian global (circuit breaker).
- `pause()` darurat oleh **guardian** (kunci yang hanya bisa menjeda), `unpause()` hanya oleh owner.
- Kepemilikan dua langkah (Ownable2Step), disiapkan untuk Safe multisig.
- Owner bisa merotasi signer dan menghapus entri leaderboard palsu.

Kontrak:
- **VoxelRaidLeaderboard**: hanya menerima skor yang ditandatangani signer server, untuk `msg.sender` itu sendiri
  (atestasi curian dari mempool tidak bisa dipakai), dengan deadline, dan setiap sessionId hanya bisa dipakai sekali.
- **VoxelToken (VXL, ERC-20 + permit)**: jumlah yang bisa di-claim = koin di leaderboard − yang sudah di-claim.
  Tidak ada server atau admin yang bisa mencetak VXL di luar jalur ini.
- **VoxelArsenal (ERC-721)**: skin dibeli dengan membakar VXL, dengan gambar SVG dan metadata yang dibuat on-chain.
  Skin hanya kosmetik (warna senjata dan tracer), jadi ranked tetap adil.

## Deploy ke Robinhood Chain Testnet

> **Catatan jaringan Indonesia:** beberapa ISP (misalnya XL) memblokir domain `*.robinhood.com`, termasuk RPC publik
> `rpc.testnet.chain.robinhood.com`. Pakai endpoint RPC dari provider seperti Alchemy
> (`https://robinhood-testnet.g.alchemy.com/v2/<API_KEY>`) di `RPC_URL`, `VITE_RPC_URL`, dan pengaturan jaringan
> di MetaMask.

1. Buat `.env.production.local` (jangan di-commit):
   ```
   CHAIN=robinhoodTestnet
   VITE_CHAIN=robinhoodTestnet
   SIWE_DOMAIN=<domain-game-kamu>
   SERVER_SIGNER_KEY=0x<kunci baru, khusus signer>
   SESSION_SECRET=<string acak ≥ 32 karakter>
   RPC_URL=<endpoint RPC server>
   VITE_RPC_URL=<endpoint RPC browser; batasi domain-nya di dashboard provider>
   ```
2. Isi wallet deployer dengan ETH testnet dari faucet Robinhood Chain Testnet (misalnya faucet Alchemy).
3. Jalankan `DEPLOYER_KEY=<kunci-kamu> node --env-file=.env.production.local scripts/deploy.mjs`.
   Alamat ketiga contract tercatat di `src/web3/deployments.json`.
4. Jalankan server API (`server/app.js`) di hosting Node dengan env yang sama, lalu arahkan `/api` ke sana.

## Kontrol

**Desktop:** WASD bergerak · Mouse membidik · Klik menembak · 1/2/3 atau scroll ganti senjata · Q senjata sebelumnya ·
R reload · Space lompat · Shift dash · M mute · Esc pause

**HP/tablet:** kontrol sentuh aktif otomatis. Joystick muncul di mana jempol kiri menyentuh, geser di sisi kanan
untuk membidik, dan tahan FIRE (bisa sambil digeser untuk membidik). Ada juga tombol DASH, LOMPAT, R, dan GANTI.
Untuk tes di desktop, buka `?touch` (hanya di mode dev).

**Kualitas grafis** (menu pause): AUTO mulai di TINGGI (RENDAH di perangkat sentuh) dan otomatis turun kalau FPS
drop. RENDAH mematikan glow, menurunkan resolusi render, dan mengurangi partikel.

## Struktur

- `index.html`: landing page, HUD game, dan dialog wallet
- `src/main.js`: alur menu, game over, dan leaderboard lokal/on-chain
- `src/game/`: game loop (`Game.js`), aturan + validasi run (`rules.js`), model voxel, dan SFX
- `src/web3/`: config wagmi (`wallet.js`), ranked (`ranked.js`), token & arsenal (`arsenal.js`), chain, API client
- `src/ui/`: modal wallet/profil (`walletUI.js`) dan arsenal (`arsenalUI.js`)
- `contracts/`: contract Solidity, script compile, dan hasil ABI/bytecode
- `server/`: API ranked (Hono)
- `scripts/`: dev runner, deploy, Anvil, dan setup env
- `tests/`: test integrasi

## Roadmap

1. **Game core**: selesai
2. **Wallet login**: selesai (wagmi v3 + viem)
3. **Leaderboard on-chain**: selesai di testnet
4. **Token VXL + NFT arsenal**: selesai di testnet
