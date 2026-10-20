# Migrasi backend: dari Supabase ke PostgreSQL + backend sendiri (model B)

> **Dokumen sejarah — migrasi ini sudah selesai.** Disimpan karena menjelaskan
> *mengapa* skema dan lapisan data ETNA berbentuk seperti sekarang
> (`db/bootstrap/0000_postgres_bootstrap.sql` merujuk ke §2 dokumen ini).
> Keadaan per 4 Okt 2026, yang berbeda dari isi di bawah:
>
> - **Hosting:** server Windows sendiri (aplikasi dan database di dua server
>   terpisah), bukan Netlify; tidak ada pooler koneksi. Lihat
>   [INSTALL-SERVER.md](INSTALL-SERVER.md).
> - **Desktop (Electron) dan route OpenAI sudah dihapus.**
> - **Supabase tidak lagi dipakai dan belum ada data produksi**; server baru
>   dimulai dengan database kosong. `scripts/db/transfer.mjs` tetap ada untuk
>   memindahkan data antar database ETNA.
> - Bagian "Keputusan yang masih dibutuhkan" (§8) sudah terjawab oleh poin di
>   atas.
> - Cara menjalankan secara lokal: [DEVELOPMENT.md](DEVELOPMENT.md);
>   pengaturan: [CONFIGURATION.md](CONFIGURATION.md).
>
> Komentar `supabase/migrations/*` di file bootstrap merujuk ke folder lama;
> sekarang `db/migrations`. File bootstrap tidak diubah karena checksum-nya
> tercatat di setiap database.

Status (28 Sep 2026): **kode sudah lepas dari Supabase.** Tidak ada lagi
package, klien, middleware, atau route Supabase di aplikasi; satu-satunya
backend adalah PostgreSQL dengan auth ETNA sendiri. Cara menjalankan:
[DEVELOPMENT.md](DEVELOPMENT.md). Data produksi dipindahkan dengan
`scripts/db/transfer.mjs` (export dari Supabase → import → reconcile); project
Supabase lama tidak diubah dan menjadi cadangan hanya-baca.

Audit awal (ringkas): ETNA memakai PostgreSQL + RLS, Supabase Auth (password,
sesi, MFA TOTP), PostgREST (68 query + 60 RPC dari browser, 11 route server),
hook pre-request (2FA), dan Realtime (dua dashboard). Tidak dipakai: Storage,
Edge Functions, OAuth, broadcast/presence, pg_cron, pg_net, Vault.

---

## Progres

| Langkah | Status | Isi |
|---|---|---|
| B1 | selesai | `db/bootstrap/0000_postgres_bootstrap.sql` (role + skema `auth` pengganti), `npm run db:migrate` |
| B2 | selesai | Lapisan data server `src/server/db` (semantik PostgREST: RLS, klaim, aturan 2FA, timeout) + `/api/data` |
| B3 | selesai | Auth sendiri `src/server/auth` + `/api/auth/*`; `scripts/admin/users.mjs` |
| B4 | selesai | Middleware tanpa Supabase, polling pengganti realtime, health check database |
| Alat data | selesai | `scripts/db/transfer.mjs` export / import / reconcile |
| Hapus Supabase | selesai | `@supabase/*` dicopot; `src/lib/supabase`, `/auth/callback`, folder `supabase/` dihapus; migrasi di `db/migrations`, rollback di `db/rollback`; `scripts/setup-local.mjs` |
| Pindah data | lihat laporan pemindahan | export → import → reconcile ke server tujuan |

Tes: unit 48, DB 128 (semua di PostgreSQL biasa). Uji ujung-ke-ujung di
PostgreSQL 17 (akun uji): login, transaksi, buku besar, 2FA, kode pemulihan,
semua halaman, route API, export → import → reconcile.

### Penyimpangan dari desain §2.4 (dan alasannya)

Desain awal memindahkan setiap service ke fungsi server bertipe. Yang dibangun:
klien dengan API yang sama (`from`/`rpc`/`auth`) yang mengirim spesifikasi query
ke `/api/data`, dieksekusi dengan pemeriksaan identifier, parameter terikat,
RLS, aturan 2FA dan timeout — sehingga 26 file halaman/service tidak perlu
ditulis ulang. Rencana lanjutan: pindahkan service ke fungsi server bertipe satu
per satu, lalu hapus `src/lib/db/rest-client.ts` dan `/api/data`.

## Konfigurasi

Lihat `.env.example`; `scripts/setup-local.mjs` menulis `.env.local` untuk
server lokal.

| Variabel | Isi |
|---|---|
| `DATABASE_URL` | role `etna_app` (produksi: lewat pooler mode transaksi) |
| `AUTH_DATABASE_URL` | role `etna_auth` |
| `MFA_ENCRYPTION_KEY` | 32 byte acak, base64 — **jangan sampai hilang** |
| `SESSION_HINT_SECRET` | ≥ 32 karakter acak |
| `MIGRATION_DATABASE_URL` / `ADMIN_DATABASE_URL` | pemilik skema — hanya di mesin admin |

### Keterbatasan yang diketahui

- Rate limit `/api/data` per instance server; limit login per-IP bergantung
  pada `x-forwarded-for` dari proxy (di laptop: alamat lokal).
- Realtime diganti polling 30 detik di dua dashboard.
- Tidak ada reset password lewat email; reset lewat `scripts/admin/users.mjs`.
- "Hapus semua data" di Settings memeriksa password dengan login ulang; bagi
  user ber-2FA sesi turun ke aal1 sehingga penghapusan ditolak sampai
  verifikasi ulang (perilaku lama, dipertahankan).
- Impor memuat satu tabel penuh di memori (cukup untuk skala menengah).

## 1. Prinsip

1. **Aturan bisnis dan isolasi workspace tetap di database.** 165 fungsi,
   58 trigger dan 43 policy RLS dipakai apa adanya. Backend baru tidak menulis
   ulang aturan itu; ia hanya menggantikan lapisan di depannya (auth + API).
2. **Browser tidak lagi bicara langsung dengan database.** Semua akses data
   lewat server Next.js (Node runtime), yang menjalankan setiap query sebagai
   user yang login — RLS tetap berlaku seperti sekarang.
3. **Dua langkah terpisah** agar setiap langkah bisa direview dan dibatalkan:
   - **Langkah A — pindahkan batas browser→server, backend tetap Supabase.**
     Service ERP pindah ke server (server actions / route) dan di dalamnya
     masih memakai Supabase dengan sesi user. UI tidak berubah; perilaku sama.
   - **Langkah B — ganti implementasi server** dari supabase-js ke PostgreSQL
     langsung + auth sendiri. UI tidak disentuh lagi.
4. **Tidak ada cutover** tanpa persetujuan eksplisit per langkah (bagian 8).

## 2. Arsitektur target

```
Browser ──(cookie sesi httpOnly)──▶ Next.js (Node)
                                     ├─ middleware (Edge): cek ada/tidaknya sesi, redirect UX
                                     ├─ lapisan auth: sesi, password, TOTP, kode pemulihan
                                     └─ lapisan data: withUserTx(session, fn)
                                           │  BEGIN
                                           │  SET LOCAL ROLE authenticated
                                           │  set_config('request.jwt.claims', {sub,email,aal}, true)
                                           │  ... query / fungsi yang sama seperti sekarang ...
                                           │  COMMIT
                                           ▼
                                  PostgreSQL 17 (via pooler mode transaction)
                                     ├─ skema public: tabel, fungsi, trigger, RLS (tidak berubah)
                                     └─ skema auth (pengganti): users, mfa_factors, sessions,
                                        uid(), jwt()
```

### 2.1 Skema `auth` pengganti (migrasi aditif baru)

Kompatibel dengan yang dipakai migrasi ETNA — pola ini **sudah terbukti** di
`tests/db/harness.mjs` (89 tes DB berjalan di PostgreSQL biasa):

| Objek | Isi | Dipakai oleh |
|---|---|---|
| `auth.users` | `id`, `email`, `encrypted_password` (bcrypt), `raw_user_meta_data`, `email_confirmed_at`, `created_at`, `banned_until` | FK dari `user_profiles`, trigger `on_auth_user_created`, `trg_initialize_approval_settings` |
| `auth.mfa_factors` | `id`, `user_id`, `friendly_name`, `factor_type`, `status`, `secret_enc` (terenkripsi), `created_at` | `erp_mfa_enrolled()`, kode pemulihan |
| `auth.sessions` | `id`, `user_id`, `token_hash`, `aal`, `created_at`, `last_seen_at`, `expires_at`, `revoked_at`, `ip`, `user_agent` | lapisan auth |
| `auth.login_attempts` | per email/IP, untuk rate limit & lockout login | lapisan auth |
| `auth.uid()`, `auth.jwt()` | membaca `request.jwt.claims` yang di-set server | 205× `auth.uid()`, klaim `email` (approval) dan `aal` (2FA) |

### 2.2 Role database

| Role | Hak | Dipakai oleh |
|---|---|---|
| `etna_owner` | pemilik skema, tabel, fungsi `SECURITY DEFINER` | hanya runner migrasi |
| `etna_app` (LOGIN) | **bukan** superuser, **tanpa** BYPASSRLS; anggota `authenticated` dan `anon`; tidak memiliki tabel | server aplikasi |
| `authenticated`, `anon` (NOLOGIN) | hak yang sudah didefinisikan di migrasi sekarang | di-`SET LOCAL ROLE` per transaksi |
| `etna_auth` (LOGIN) | hanya skema `auth` (baca/tulis sesi, users) | lapisan auth |

Server tidak pernah memakai `etna_owner` saat melayani request.

### 2.3 Auth

- **Password:** bcrypt (`$2a$`/`$2b$`), kompatibel dengan hash dari Supabase,
  jadi **password lama tetap berlaku**. Password baru: bcrypt cost 12.
- **Sesi:** token acak 256-bit di cookie `httpOnly; Secure; SameSite=Lax;
  Path=/`; database hanya menyimpan hash-nya. Masa aktif idle 12 jam, absolut
  30 hari (bisa disetel), rotasi setelah login/2FA, bisa dicabut (logout,
  reset admin). Tanpa JWT, sehingga pencabutan langsung berlaku.
- **2FA:** TOTP RFC 6238 (SHA-1, 6 digit, 30 detik, toleransi ±1 langkah)
  dengan `node:crypto`; secret dienkripsi AES-256-GCM (`MFA_ENCRYPTION_KEY`).
  Sesi naik ke `aal2` setelah kode valid. Aturan yang sama dengan sekarang:
  user dengan perangkat terverifikasi tidak bisa mengakses data di `aal1`
  (dulu hook PostgREST, sekarang dicek di `withUserTx`). Kode pemulihan:
  tabel dan fungsi yang sudah ada.
- **Verifikasi ulang password** (Settings → hapus data): endpoint verifikasi
  password, tanpa membuat sesi baru.
- **Rate limit login:** 5 gagal / 15 menit per email + per IP, penundaan
  bertahap; pesan error tidak membedakan email tidak ada vs password salah.
- **Pembuatan akun & reset** (sign-up tetap mati): script admin
  (`scripts/admin/*.mjs`) — buat user, set password sementara, cabut sesi,
  reset 2FA — dijalankan dengan kredensial admin terpisah, tercatat di audit.
- **Middleware (Edge):** hanya memeriksa keberadaan cookie sesi dan cookie
  petunjuk `aal` yang ditandatangani HMAC (untuk redirect ke `/mfa`).
  Keputusan akses yang sebenarnya selalu di server (Node) — sama seperti
  sekarang, di mana middleware membaca sesi tanpa verifikasi.
- **CSRF:** server actions Next.js memeriksa Origin; route API yang mengubah
  data menolak request tanpa Origin yang cocok.

### 2.4 Lapisan data

- Folder `src/server/` (hanya server): `db.ts` (pool, `withUserTx`,
  `withAuthTx`), `auth/*`, `erp/*` (satu modul per service yang sekarang ada di
  `erpService.ts` / `accountingService.ts`).
- **Antarmuka dipertahankan:** fungsi seperti `customerService.getAll(userId)`
  tetap ada di client dengan tanda tangan yang sama, tetapi memanggil server
  action; halaman tidak perlu diubah.
- 68 query PostgREST diterjemahkan ke SQL berparameter (tanpa ORM). Join
  bertingkat (`select('*, items:…(*)')`) menjadi `json_agg`. Paging per 1000
  dan urutan dipertahankan.
- 60 RPC dipanggil sebagai `select * from fungsi($1, …)` dengan nama dan
  argumen yang sama.
- Rate limit API: `api_rate_limit_hit()` yang sudah ada.
- Dependensi baru yang dibutuhkan: `pg` (driver) dan `bcryptjs` (hash,
  JavaScript murni — cocok untuk serverless). Tidak ada ORM.

### 2.5 Realtime

Diganti **polling** di dua dashboard: setiap 30 detik saat tab terlihat,
berhenti saat tab tersembunyi, plus refresh setelah aksi user. **[Tergantung
hosting]** — jika server Node persisten, bisa ditingkatkan ke
LISTEN/NOTIFY + Server-Sent Events.

### 2.6 Konfigurasi & secret

| Variabel (server saja, tidak pernah `NEXT_PUBLIC_`) | Isi |
|---|---|
| `DATABASE_URL` | koneksi `etna_app` via pooler |
| `AUTH_DATABASE_URL` | koneksi `etna_auth` |
| `MIGRATION_DATABASE_URL` | koneksi `etna_owner` — hanya di CI/mesin admin, tidak di server aplikasi |
| `MFA_ENCRYPTION_KEY` | 32 byte acak |
| `SESSION_HINT_SECRET` | HMAC untuk cookie petunjuk middleware |
| `ETNA_BACKEND` | `supabase` \| `postgres` — sakelar selama transisi |

Nilai berbeda per environment (lokal / staging / produksi), disimpan di
pengaturan environment hosting dan password manager, tidak pernah di git.
Variabel Supabase lama tetap terpisah sampai Supabase dipensiunkan.

### 2.7 Migrasi skema, lingkungan, backup, monitoring

- **Migrasi:** `db/migrations/*` tetap sebagai riwayat dan dijalankan
  berurutan oleh runner kecil (`scripts/db/migrate.mjs`, tabel
  `schema_migrations`), didahului migrasi bootstrap skema `auth` + role.
  CI tetap menjalankan semua di PGlite.
- **Lokal:** PostgreSQL 17 di Docker (`docker compose`), data uji dari seed.
- **Staging:** database terpisah, salinan data yang sudah disamarkan atau data
  uji. **[menunggu keputusan penyedia]**
- **Backup:** PITR dari penyedia (jika managed) + dump harian terenkripsi ke
  lokasi terpisah; uji restore bulanan. **[menunggu keputusan]**
- **Monitoring:** `/api/health` (cek koneksi DB), log error server, metrik
  koneksi/CPU/slow query dari penyedia, peringatan gagal login beruntun.

### 2.8 Tanggung jawab yang pindah ke Anda

Yang dulu ditangani Supabase: patch keamanan auth, penyimpanan sesi, rate
limit login, backup/PITR (jika self-managed), upgrade PostgreSQL, rotasi
secret, email auth (saat ini tidak dipakai), dan dashboard admin user.

---

## 3. Migrasi data (Fase 3)

1. **Ekspor dari Supabase** (hanya-baca): skema `public` + data, `auth.users`
   (id, email, hash password, metadata, waktu), `auth.mfa_factors`. Dump
   dienkripsi (age/GPG) sebelum keluar dari mesin; ditransfer lewat kanal
   terenkripsi; dihapus setelah selesai.
2. **Impor ke target:** bootstrap `auth` → semua migrasi → data dengan
   `session_replication_role = replica` (trigger tidak memposting ulang jurnal
   atau stok) → sinkronkan sequence → `ANALYZE`.
3. **Secret TOTP:** dicoba didekripsi/dipakai. Jika Supabase menyimpannya
   terenkripsi dengan kunci yang tidak bisa diekspor, perangkat 2FA **tidak
   bisa dipindah** — user memasang ulang 2FA (dengan jalur admin).
4. **Sesi tidak dipindah:** semua user login ulang sekali.
5. **Rekonsiliasi (wajib sama persis):** jumlah baris per tabel; total debit =
   kredit per workspace; total invoice/pembayaran/saldo per workspace; stok per
   produk dan per gudang; cek relasi (FK) dan orphan; checksum per tabel
   (hash dari baris terurut); 20 record acak per tabel dibandingkan kolom demi
   kolom; tipe data: `timestamptz` (UTC), `NUMERIC` (skala sama), UUID, JSONB.
6. **Gangguan di tengah jalan:** impor dalam satu transaksi per tahap; bila
   gagal, database target dibuang dan diulang dari dump (sumber tidak pernah
   diubah).

## 4. Rencana implementasi (setelah disetujui)

| Langkah | Isi | Verifikasi |
|---|---|---|
| A1 | Server actions untuk master data (customers, suppliers, products), masih via Supabase dengan sesi user | tes perilaku sama, cek manual |
| A2 | Order, fulfillment, invoice, pembayaran, akuntansi, dashboard, laporan | sama |
| A3 | Hapus akses Supabase dari browser, kecuali auth | grep: tidak ada `.from(` / `.rpc(` di client |
| B1 | Bootstrap `auth` + role + runner migrasi; tes di PGlite dan Postgres lokal | tes DB baru |
| B2 | `withUserTx` + implementasi SQL per service di belakang `ETNA_BACKEND` | tes DB per service, **tes isolasi workspace per tabel** |
| B3 | Auth sendiri: login, sesi, 2FA, kode pemulihan, script admin | tes unit + DB, tes serangan dasar (brute force, sesi dicabut) |
| B4 | Polling realtime; health check DB | cek manual |
| B5 | Latihan migrasi data ke staging + rekonsiliasi | laporan angka nyata |
| B6 | Uji penuh di staging (Fase 5) | checklist bagian 6 |

Estimasi: 25–38 hari kerja.

## 5. Risiko utama

| Risiko | Mitigasi |
|---|---|
| Bug di `withUserTx` → data lintas workspace terbaca | satu-satunya jalan ke DB; tes isolasi otomatis untuk setiap tabel & fungsi; `etna_app` tanpa BYPASSRLS |
| Lupa `SET LOCAL` / koneksi pooler bocor state | hanya `SET LOCAL` dalam transaksi; tes yang memastikan klaim kosong di awal transaksi |
| 2FA lama tidak bisa dipindah | diketahui di latihan B5; jalur pasang ulang disiapkan |
| Perbedaan perilaku query (urutan, paging, null) | tes per service yang membandingkan hasil versi Supabase vs SQL pada data uji yang sama |
| Beban koneksi serverless | pooler mode transaksi, batas pool per fungsi |
| Keamanan auth buatan sendiri | desain sederhana (token acak + hash), review keamanan sebelum cutover |

## 6. Checklist uji staging (Fase 5)

Login/logout; sesi habis & dicabut; salah password + lockout; 2FA: daftar,
verifikasi, beberapa perangkat, kode pemulihan; workspace: undangan, peran,
anggota dikeluarkan, workspace wajib 2FA; tiap peran mencoba aksi terlarang;
semua alur ERP (master data, PO→terima→bayar, SO→invoice→kirim→bayar, void,
jurnal manual & reversal, tutup buku, multi-mata-uang, transfer gudang);
workflow (jalankan, versi, riwayat); ekspor CSV; dashboard (polling);
rekonsiliasi data; waktu respons halaman utama; backup + restore.

## 7. Cutover (hanya dengan persetujuan per langkah)

1. Umumkan jendela maintenance; aktifkan halaman maintenance (tulis dibekukan).
2. Backup final Supabase (dump + snapshot penyedia).
3. Ekspor → impor → rekonsiliasi. **Selisih apa pun = batal**, matikan
   maintenance, tetap di Supabase.
4. Set `ETNA_BACKEND=postgres` + env baru di hosting; deploy.
5. Uji cepat: login, 2FA, baca dashboard, satu transaksi uji di workspace uji.
6. Buka akses.
7. Pantau 24 jam: error, login gagal, waktu respons.

**Rollback:** sebelum langkah 6 — kembalikan env ke Supabase (tidak pernah
diubah). Setelah akses dibuka, data baru hanya ada di target; rollback berarti
menyalin balik data baru (script sama, arah terbalik), jadi batas keputusan
rollback ditetapkan di jam-jam pertama. Supabase dipertahankan (hanya-baca,
tidak dihapus) minimal 30 hari setelah cutover.

## 8. Keputusan yang masih dibutuhkan

1. **Penyedia PostgreSQL** (managed atau server sendiri, lokasi data, versi 17,
   pooler tersedia?).
2. **Hosting aplikasi:** tetap Netlify (serverless) atau server Node.
3. **Kebijakan user saat cutover:** semua login ulang sekali (pasti), dan
   pasang ulang 2FA jika secret tidak bisa dipindah.
4. **Developer Console** (`src/components/ui/DevConsole.tsx`) menghapus data
   langsung lewat Supabase: boleh diubah jalur aksesnya saja, atau fitur hapus
   di console dibiarkan tidak berfungsi setelah migrasi.
