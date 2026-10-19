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

## Aturan anti-farming

- **Satu tiket = satu run.** Tiket game hanya bisa dipakai untuk satu replay. Mengirim replay yang sama lagi
  (misalnya setelah koneksi putus) aman dan dijawab sama; replay lain di tiket yang sama ditolak (409).
- **Daily: satu run on-chain per wallet per hari.** Semua pemain dapat seed daily yang sama, jadi satu replay
  bagus bisa saja dikirim ulang di tiket daily baru untuk memanen VXL. Hanya run daily pertama yang terverifikasi
  hari itu yang dapat atestasi; run berikutnya hanya masuk papan daily.
- **Replay daily hari ini privat.** Sampai hari berganti, replay daily hanya bisa ditonton pemiliknya (lewat id
  maupun lookup "terbaik minggu ini"), supaya tidak bisa disalin wallet lain.
- **Harga skin dikunci saat ditandatangani.** `buy`/`buyWithPermit` menerima `maxPrice`; kalau owner menaikkan harga
  sebelum transaksi masuk, pembelian revert (`PriceAboveMax`), bukan membakar VXL lebih banyak.

### Risiko yang diterima

Verifikasi replay membuktikan bahwa input menghasilkan skor itu, **bukan** bahwa manusia yang memainkannya.
Simulasi berjalan di klien dan seed diketahui sejak tiket dibuat, jadi bot atau run berbantuan tool (aimbot,
input yang dicari offline selama umur tiket 2 jam) tetap mungkin dan sulit dibedakan dari pemain yang sangat
jago. Mitigasinya: hadiah mingguan dibatasi (top 10), batas klaim harian global di `VoxelToken`, dan owner bisa
menghapus entri (`removeEntry`) setelah ditinjau. Pertimbangkan deteksi pola input (reaksi tidak manusiawi,
akurasi sempurna) sebelum hadiah bernilai besar.

## Sebelum mainnet

- Audit independen untuk ketiga contract dan server verifikasi.
- Owner dipindah ke Safe multisig, guardian dipasang, dan seluruh runbook dilatih di testnet.
- Rate limiter memakai store bersama (misalnya Redis) kalau server berjalan di lebih dari satu instance. Bawaannya
  in-memory per proses.
- Set `TRUST_PROXY=1` **hanya** di belakang tepat satu proxy yang menambahkan alamat klien ke `X-Forwarded-For`.
  Server memakai entri **paling kanan** (yang ditambahkan proxy kita); entri di kirinya bisa dipalsukan klien.
- Simpan `SERVER_SIGNER_KEY` di KMS/HSM, bukan di file env.

## Melaporkan celah

Hubungi pemilik repo secara pribadi. Jangan membuka issue publik untuk celah keamanan.
