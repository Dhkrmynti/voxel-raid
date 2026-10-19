# Keamanan & respons insiden

## Peran dan kunci

| Peran                                | Disimpan di                      | Bisa melakukan                                                                  | Tidak bisa                                    |
| ------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------- |
| **Owner** (disarankan Safe multisig) | Safe, beberapa penanda tangan    | Ganti signer, atur batas, unpause, hapus entri leaderboard, kelola katalog skin | —                                             |
| **Guardian**                         | Kunci "panas" milik tim          | **Hanya `pause()`** di ketiga contract                                          | Unpause, mengubah konfigurasi, menyentuh dana |
| **Signer skor**                      | Server API (`SERVER_SIGNER_KEY`) | Menandatangani atestasi skor                                                    | Apa pun selain itu                            |

Kepemilikan dipindah dua langkah (`transferOwnership` → `acceptOwnership` dari alamat baru), jadi salah ketik
alamat tidak membuat contract kehilangan pemilik. Script deploy mendukung `GUARDIAN=` dan `FINAL_OWNER=`.

## Batas bawaan (bisa diubah owner)

| Batas                 | Nilai awal                         | Fungsi                                                                  |
| --------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| `maxScorePerRun`      | 50.000.000                         | Atestasi palsu tidak bisa mendorong skor absurd ke leaderboard          |
| `maxTokensPerRun`     | 5.000                              | Satu atestasi palsu tidak bisa membawa token dalam jumlah besar         |
| `dailyClaimCap` (VXL) | 250.000 / hari (UTC), semua pemain | Circuit breaker: kerugian maksimum per hari terbatas meski signer bocor |

Claim yang melebihi sisa kuota harian akan dicetak sebagian; sisanya tetap bisa di-claim keesokan harinya.

## Runbook: kunci signer server bocor

Tanda-tandanya: skor di leaderboard tidak masuk akal, lonjakan `Claimed` dari alamat baru, atau `remainingToday()`
habis jauh lebih cepat dari biasanya.

1. **Hentikan** (guardian, hitungan menit): panggil `pause()` di `VoxelRaidLeaderboard` dan `VoxelToken`.
   Jeda juga `VoxelArsenal` kalau VXL hasil kecurangan sedang dibelanjakan.
2. **Ganti kunci server**: buat `SERVER_SIGNER_KEY` baru, deploy ulang API, lalu cabut akses ke kunci lama.
3. **Rotasi signer** (owner/multisig): `setSigner(alamatBaru)`. Semua atestasi yang ditandatangani kunci lama
   langsung tidak berlaku, termasuk yang belum dikirim.
4. **Bersihkan**: `removeEntry(week, pemainCurang)` untuk setiap entri palsu di leaderboard minggu berjalan.
5. **Lanjutkan** (owner): `unpause()`. Pertimbangkan menurunkan `dailyClaimCap` sementara waktu.
6. **Catat**: alamat penyerang, jumlah VXL yang sempat dicetak, dan transaksi-transaksinya.

Langkah 1–5 diuji otomatis di `tests/security.test.mjs` (_incident drill: leaked signer key_).

## Runbook lain

- **Bug di logika game atau validator**: jeda `VoxelRaidLeaderboard`, perbaiki, naikkan `SIM_VERSION`, lalu deploy.
  Replay dari versi lama otomatis ditolak.
- **Server API diserang (CPU/DoS)**: verifikasi replay butuh ~13 ms CPU per menit permainan. Lapisan yang sudah ada:
  - Rate limit token bucket (`server/ratelimit.js`, angka di `DEFAULT_LIMITS` pada `server/app.js`):

    | Endpoint       | Batas                              |
    | -------------- | ---------------------------------- |
    | `/auth/nonce`  | 20/menit per IP                    |
    | `/auth/verify` | 10/menit per IP                    |
    | `/game/start`  | 60/jam per wallet                  |
    | `/game/finish` | 30/jam per wallet + 120/jam per IP |

  - Batas ukuran body: 32 KB untuk endpoint biasa, ~4 MB untuk replay. Zip bomb ditolak saat dekompresi.
  - Replay yang lebih panjang dari waktu nyata sejak tiket dibuat ditolak **sebelum** simulasi dijalankan.

  Kalau serangan tetap terjadi, turunkan angka di `DEFAULT_LIMITS` lalu deploy ulang server.

## Sebelum mainnet

- Audit independen untuk ketiga contract dan server verifikasi.
- Owner dipindah ke Safe multisig, guardian dipasang, dan seluruh runbook dilatih di testnet.
- Rate limiter memakai store bersama (misalnya Redis) kalau server berjalan di lebih dari satu instance. Bawaannya
  in-memory per proses.
- Set `TRUST_PROXY=1` **hanya** di belakang proxy yang menimpa `X-Forwarded-For`. Tanpa itu, header tersebut bisa
  dipalsukan klien untuk menghindari limit per IP.
- Simpan `SERVER_SIGNER_KEY` di KMS/HSM, bukan di file env.

## Melaporkan celah

Hubungi pemilik repo secara pribadi. Jangan membuka issue publik untuk celah keamanan.
