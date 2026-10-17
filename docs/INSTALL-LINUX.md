# Memasang ETNA di server Linux

ETNA berjalan di Linux dengan dua cara. Keduanya diuji di CI setiap push
(`.github/workflows/ci.yml`: job *Linux install (systemd)* dan *Linux install
(Docker Compose)*), sampai sign-in dan membaca data.

| | A. Langsung (systemd) | B. Docker Compose |
|---|---|---|
| Cocok untuk | Server khusus ETNA, seperti instalasi Windows | Server yang sudah memakai Docker, atau coba cepat |
| PostgreSQL | Paket distribusi/PGDG, di server ini atau server lain | Container `postgres:18` |
| Update | `sudo deploy/linux/install.sh` dari versi baru | `git pull` lalu `docker compose up -d --build` |
| Kembali ke versi sebelumnya | Ganti symlink `/opt/etna/current` | Build ulang dari versi sebelumnya |

Di Windows tetap pakai `etna.bat` ([INSTALL-SERVER.md](INSTALL-SERVER.md)).
Pengaturan aplikasi sama di semua sistem: [CONFIGURATION.md](CONFIGURATION.md).

---

## A. Langsung, dengan systemd

Diuji di Ubuntu 24.04; distribusi lain dengan systemd (Debian 12, RHEL 9 dan
turunannya) bekerja sama.

### A1. Yang dibutuhkan

- **Node.js 24 LTS** (minimal 22.18, karena worker Terminal menjalankan
  TypeScript langsung), terpasang di PATH sistem (`/usr/bin/node` atau
  `/usr/local/bin/node`), misalnya dari [NodeSource](https://github.com/nodesource/distributions)
  atau paket distribusi. Jangan dari `nvm` di folder home: layanan tidak bisa
  membaca `/home` (`ProtectHome=yes`).
- **PostgreSQL 18** (repository [PGDG](https://www.postgresql.org/download/linux/)),
  di server ini atau server database tersendiri.
- `git`, `tar`, dan akses root (`sudo`).
- Untuk HTTPS: Caddy (`apt install caddy`) atau Cloudflare Tunnel.

### A2. Database

Sekali saja, sebagai `postgres`. `CREATE DATABASE` tidak boleh berada dalam
satu transaksi, jadi jalankan sebagai dua perintah:

```bash
sudo -u postgres psql -c "CREATE ROLE etna_owner LOGIN CREATEROLE PASSWORD 'ganti-dengan-password-kuat'"
sudo -u postgres psql -c "CREATE DATABASE etna OWNER etna_owner"
```

`etna_owner` bukan superuser. Database di server lain: pakai alamatnya di
`MIGRATION_DATABASE_URL` di bawah, dengan `?sslmode=verify-full` (lihat
[CONFIGURATION.md](CONFIGURATION.md#database-connections-across-the-network)).

### A3. Pasang

```bash
git clone <repository> etna-src && cd etna-src
read -rs -p "Password etna_owner: " PGPASSWORD; echo
sudo MIGRATION_DATABASE_URL=postgres://etna_owner@localhost:5432/etna \
     PGPASSWORD="$PGPASSWORD" deploy/linux/install.sh
```

`install.sh` memeriksa Node.js, membuat user sistem `etna`, menyalin dan
mem-build aplikasi, menyiapkan database (migrasi dan password baru untuk role
aplikasi), menulis `/etc/etna/etna.env` berisi koneksi dan kunci baru,
memasang layanan systemd, lalu menunggu sampai `/api/health` menjawab.

| Lokasi | Isi | Pemilik |
|---|---|---|
| `/opt/etna/releases/etna-<versi>-<waktu>/` | Versi aplikasi (yang aktif dan satu sebelumnya) | root, hanya dibaca layanan |
| `/opt/etna/current` | Symlink ke versi yang berjalan | root |
| `/etc/etna/etna.env` | Pengaturan dan kunci (`MFA_ENCRYPTION_KEY`, `SESSION_HINT_SECRET`, koneksi database) | `root:etna`, `0640` |
| `/var/lib/etna/` | `ETNA_DATA_ROOT`: dokumen, folder perusahaan, cache | `etna`, `0750` |
| journal | Log: `journalctl -u etna -u etna-worker` | |

**Simpan salinan `/etc/etna/etna.env` di password manager.** Tanpa
`MFA_ENCRYPTION_KEY`, semua pengguna harus mendaftarkan authenticator lagi.

Layanan:

- `etna.service`: aplikasi di `127.0.0.1:4028` saja.
- `etna-worker.service`: worker Terminal.

Keduanya berjalan sebagai `etna` dengan pengamanan systemd: folder aplikasi
hanya bisa dibaca, yang bisa ditulis hanya `/var/lib/etna`, tanpa hak
tambahan, tanpa akses `/home`. Periksa dengan `systemd-analyze security etna`.

### A4. Akun pertama

Tidak ada pendaftaran mandiri.

```bash
cd /opt/etna/current
sudo ADMIN_DATABASE_URL=postgres://etna_owner@localhost:5432/etna PGPASSWORD="$PGPASSWORD" \
     node scripts/admin/users.mjs create-user --email anda@contoh.com --name "Nama Anda"
```

Password sementara tampil sekali. Ganti setelah sign-in. Admin platform:
`node scripts/admin/users.mjs grant-admin --email anda@contoh.com` (lihat
[ADMIN.md](ADMIN.md)).

### A5. HTTPS

**Caddy di server ini:** salin `deploy/linux/Caddyfile` ke
`/etc/caddy/Caddyfile`, ganti `erp.example.com`, lalu `sudo systemctl reload
caddy`. Tambahkan ke `/etc/etna/etna.env`:

```
TRUST_PROXY=1
ETNA_PUBLIC_URL=https://erp.example.com
```

lalu `sudo systemctl restart etna`.

**Cloudflare Tunnel:** arahkan tunnel ke `http://127.0.0.1:4028` dan pakai
`TRUST_PROXY=cloudflare` (sama seperti di Windows,
[INSTALL-SERVER.md](INSTALL-SERVER.md) langkah 9).

Firewall: buka hanya 22 (SSH) dan, dengan Caddy, 80 dan 443. Port 4028 dan
5432 tidak perlu dibuka.

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

### A6. Backup harian database

Di server database (PostgreSQL di server yang sama: di sini juga):

```bash
sudo install -d -m 0700 -o postgres -g postgres /var/backups/etna
sudo systemctl enable --now etna-db-backup.timer
systemctl list-timers etna-db-backup.timer
```

Setiap hari pukul 02:30, `pg_dump` menyimpan `/var/backups/etna/etna-<waktu>.dump`.
Yang disimpan: 14 hari terakhir, ditambah dump tanggal 1 setiap bulan selama
setahun. Database atau folder lain: `sudo systemctl edit etna-db-backup`,
lalu isi `ExecStart=` kosong dan `ExecStart=/opt/etna/bin/etna-db-backup.sh <database> <folder>`
(tambahkan juga `ReadWritePaths=<folder>`).

Jika server database terpisah dari server aplikasi, salin
`deploy/linux/etna-db-backup.sh` ke `/opt/etna/bin/` dan kedua file
`etna-db-backup.*` ke `/etc/systemd/system/` di server database.

**Backup off-site terenkripsi** (database, dokumen, dan `etna.env` dalam
satu file, ke disk lain, NAS, atau share jaringan; rinciannya di
[OPERATIONS.md](OPERATIONS.md#off-site-backups)). Sekali saja, di server
aplikasi:

```bash
cd /opt/etna/current
sudo env PATH="$PATH" node scripts/db/offsite.mjs keys --dir /etc/etna   # passphrase: simpan di password manager
sudo chown etna:etna /etc/etna/offsite-key.*
sudo install -m 0600 -o etna -g etna /dev/null /etc/etna/offsite.env
sudo install -m 0600 -o etna -g etna /dev/null /etc/etna/offsite.pgpass
sudoedit /etc/etna/offsite.env
#   OFFSITE_DATABASE_URL=postgres://etna_owner@localhost:5432/etna
#   ETNA_OFFSITE_DIR=/mnt/backup/etna
#   ETNA_OFFSITE_KEY=/etc/etna/offsite-key.pub.pem
sudoedit /etc/etna/offsite.pgpass
#   localhost:5432:etna:etna_owner:<password etna_owner>
sudo systemctl edit etna-offsite      # [Service] ReadWritePaths=/mnt/backup/etna
sudo systemctl enable --now etna-offsite.timer
sudo systemctl start etna-offsite     # coba sekarang; lalu journalctl -u etna-offsite
```

Setiap malam pukul 03:15 satu file `etna-offsite-<waktu>.etnabak` dibuat;
14 file terakhir disimpan. Periksa sebulan sekali dengan
`node scripts/db/offsite.mjs verify <file>`, dan uji pemulihan ke staging
setiap kuartal (`restore`, OPERATIONS.md). Gagal backup tercatat sebagai
`[offsite] backup failed` dan dikirim lewat alert e-mail.

### A7. Memperbarui

```bash
cd etna-src && git pull
sudo MIGRATION_DATABASE_URL=postgres://etna_owner@localhost:5432/etna \
     PGPASSWORD="$PGPASSWORD" deploy/linux/install.sh
```

Versi baru di-build di folder sendiri, migrasi dijalankan, lalu
`/opt/etna/current` dipindah dan layanan di-restart. Jika build atau migrasi
gagal, versi yang berjalan tidak tersentuh. Tanpa `MIGRATION_DATABASE_URL`,
migrasi dilewati (hanya aman jika versi baru tidak membawa migrasi).

**Kembali ke versi sebelumnya:** install.sh menampilkan perintahnya bila
`/api/health` tidak menjawab. Secara umum:

```bash
ls /opt/etna/releases/
sudo ln -sfn /opt/etna/releases/<versi-sebelumnya> /opt/etna/current
sudo systemctl restart etna etna-worker
```

Migrasi tidak ikut dibatalkan: lihat `db/rollback/` dan
[OPERATIONS.md](OPERATIONS.md).

### A8. Pemeriksaan

```bash
systemctl status etna etna-worker
journalctl -u etna -u etna-worker -f
curl -s http://127.0.0.1:4028/api/health
sh /opt/etna/current/deploy/smoke-test.sh http://127.0.0.1:4028 anda@contoh.com 'password'
```

`smoke-test.sh` memeriksa health, sign-in, sesi, dan satu permintaan data.

---

## B. Docker Compose

### B1. Yang dibutuhkan

Docker Engine dengan plugin Compose (`docker compose version`).

### B2. Pasang

```bash
git clone <repository> etna-src && cd etna-src/deploy/docker
cp .env.example .env
# isi POSTGRES_PASSWORD dan ETNA_OWNER_PASSWORD dengan password kuat yang berbeda
docker compose up -d --build
```

Yang terjadi:

1. `db` (PostgreSQL 18) dibuat. Pada start pertama ia membuat `etna_owner`
   dan database `etna` (`initdb/01-etna-owner.sh`).
2. `setup` berjalan sekali setiap start. Pertama kali: skema, password role
   aplikasi, dan `/config/etna.env` dengan kunci baru. Berikutnya: migrasi
   baru saja; kunci tetap.
3. `app` (port `127.0.0.1:4028` mesin ini) dan `worker` mulai setelah
   `setup` selesai.

| Volume | Isi | Backup? |
|---|---|---|
| `etna_pgdata` | Database | Ya (dump, lihat B5) |
| `etna_config` | `etna.env`: koneksi dan kunci | **Ya, wajib** |
| `etna_data` | Dokumen dan folder perusahaan | Ya |

### B3. Akun pertama

```bash
docker compose run --rm -e ADMIN_DATABASE_URL=postgres://etna_owner@db:5432/etna \
  setup node scripts/admin/users.mjs create-user --email anda@contoh.com --name "Nama Anda"
```

### B4. HTTPS

Dengan Caddy dari compose ini: di `.env` isi `ETNA_DOMAIN`, `TRUST_PROXY=1`
dan `ETNA_PUBLIC_URL=https://<domain>`, lalu:

```bash
docker compose --profile https up -d
```

DNS domain harus mengarah ke mesin ini, dan port 80 dan 443 harus terbuka.
Dengan Caddy, nginx atau Cloudflare Tunnel di mesin ini sendiri: arahkan ke
`127.0.0.1:4028`, dan isi `TRUST_PROXY` (`1` atau `cloudflare`) serta
`ETNA_PUBLIC_URL` di `.env`. `TRUST_PROXY` dan `ETNA_PUBLIC_URL` diambil dari
`.env` setiap start; jangan ubah keduanya di `etna.env`.

### B5. Backup dan pemulihan

Backup off-site terenkripsi (database, dokumen, dan `etna.env` dalam satu
file; rinciannya di [OPERATIONS.md](OPERATIONS.md#off-site-backups)). Sekali
saja, di `deploy/docker`:

```bash
mkdir -p offsite offsite-keys
sudo chown -R 1000:1000 offsite offsite-keys    # user di dalam container (uid 1000)
docker compose run --rm --entrypoint node -v "$PWD/offsite-keys":/k setup \
  scripts/db/offsite.mjs keys --dir /k      # ketik passphrase; simpan di password manager
```

Backup folder lain (NAS, share yang di-mount): isi `ETNA_OFFSITE_PATH` di
`.env`. Jadwalkan setiap malam dengan cron:

```
15 3 * * * cd /path/to/etna-src/deploy/docker && docker compose --profile offsite run --rm offsite
```

Periksa satu backup:
`docker compose --profile offsite run --rm offsite node scripts/db/offsite.mjs verify /offsite/<file>`.

Pemulihan database dari dump biasa: hentikan `app` dan `worker`
(`docker compose stop app worker`), lalu
`docker compose exec -T db pg_restore -U postgres --clean --if-exists -d etna < file.dump`,
lalu `docker compose start app worker`. Dari backup off-site: `restore` (OPERATIONS.md).

### B6. Memperbarui

```bash
cd etna-src && git pull && cd deploy/docker
docker compose up -d --build
```

`setup` menjalankan migrasi baru sebelum `app` dan `worker` dimulai ulang.

### B7. Pemeriksaan

```bash
docker compose ps
docker compose logs -f app worker
sh ../smoke-test.sh http://127.0.0.1:4028 anda@contoh.com 'password'
```

---

## Masalah umum

| Gejala | Penyebab dan solusi |
|---|---|
| `Node.js … is too old` | Pasang Node.js 24 LTS di PATH sistem |
| `etna.env does not exist yet` | Pemasangan pertama butuh `MIGRATION_DATABASE_URL` dan `PGPASSWORD` |
| `password authentication failed for user "etna_owner"` | `PGPASSWORD` salah, atau `pg_hba.conf` tidak mengizinkan `scram-sha-256` dari alamat itu |
| Layanan `etna` restart terus | `journalctl -u etna -n 100`; biasanya koneksi database (`DATABASE_URL`) |
| Link reset password memakai alamat salah | Isi `ETNA_PUBLIC_URL` |
| Batas sign-in berlaku per akun, bukan per alamat | Di belakang proxy: isi `TRUST_PROXY` |
| Docker: `setup` gagal | `docker compose logs setup`; password di `.env` tidak sama dengan saat volume `etna_pgdata` dibuat |
