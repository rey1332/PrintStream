# Memasang ETNA di server Linux

ETNA berjalan di Linux dengan dua cara. Keduanya diuji di CI setiap push
(`.github/workflows/ci.yml`: job *Linux install (systemd)* dan *Linux install
(Docker Compose)*), sampai sign-in dan membaca data.

| | A. Langsung (systemd) | B. Docker Compose |
|---|---|---|
| Cocok untuk | Server khusus ETNA, seperti instalasi Windows | Server yang sudah memakai Docker, atau coba cepat |
| PostgreSQL | Paket distribusi/PGDG, di server ini atau server lain | Container `postgres:18` |
| Update | `sudo deploy/linux/install.sh` atau `psctl upgrade <file>` | `git pull` lalu `docker compose up -d --build` |
| Kembali ke versi sebelumnya | `psctl rollback` | Build ulang dari versi sebelumnya |
| Backup, restore, pindah server | `psctl backup` / `restore` / `db move` | B5 |

Di Windows: pengelola server (`node scripts\server\manager.mjs`, sebagai administrator; [HOW TO ETNA.md](HOW%20TO%20ETNA.md) bagian 0) atau [INSTALL-SERVER.md](INSTALL-SERVER.md).
Pengaturan aplikasi sama di semua sistem: [CONFIGURATION.md](CONFIGURATION.md).

---

## A. Langsung, dengan systemd (dan psctl)

Diuji di CI pada Ubuntu 24.04 (job *Linux install (systemd)* dan *Linux
install (local PostgreSQL)*); distribusi lain dengan systemd (Debian 12)
bekerja sama. Cocok untuk VM Ubuntu Server di Proxmox.

ETNA tidak bergantung pada layanan luar: login, two-factor, sesi, hak akses,
dan semua data ada di server Anda sendiri (PostgreSQL dan `/var/lib/etna`).
Tanpa internet, ETNA tetap berjalan di jaringan kantor; hanya fitur yang
memang memakai internet (e-mail keluar, kurs online, konektor ke layanan
luar) yang gagal sampai koneksi kembali.

### A1. Yang dibutuhkan

- **Ubuntu Server 24.04** (VM Proxmox: 2 vCPU, 4 GB RAM, disk 40 GB untuk
  awal; PostgreSQL di VM yang sama butuh tambahan sesuai data).
- **Node.js 24 LTS** (minimal 22.18), terpasang di PATH sistem
  (`/usr/bin/node` atau `/usr/local/bin/node`), misalnya dari
  [NodeSource](https://github.com/nodesource/distributions). Jangan dari
  `nvm` di folder home: layanan tidak bisa membaca `/home` (`ProtectHome=yes`).
- `git`, `tar`, dan akses root (`sudo`).
- PostgreSQL: **tidak perlu disiapkan** bila memilih "di server ini"
  (installer memasang PostgreSQL 18: dari paket distribusi bila ada, else
  apt.postgresql.org; di rilis yang belum didukung apt.postgresql.org,
  misalnya Ubuntu 26.04, PostgreSQL bawaan distribusi). Untuk server
  database tersendiri, lihat A2.
- Untuk HTTPS: Caddy (`apt install caddy`) atau Cloudflare Tunnel.

### A2. PostgreSQL di server lain (opsional)

Lewati bagian ini bila PostgreSQL di server yang sama. Di server database,
sekali saja, sebagai `postgres` (dua perintah: `CREATE DATABASE` tidak boleh
di dalam transaksi):

```bash
sudo -u postgres psql -c "CREATE ROLE etna_owner LOGIN CREATEROLE CREATEDB PASSWORD 'ganti-dengan-password-kuat'"
sudo -u postgres psql -c "CREATE DATABASE etna OWNER etna_owner"
```

`etna_owner` bukan superuser. `CREATEDB` dipakai `psctl restore` untuk
membuat database baru di samping yang lama (tanpa itu: buat database kosong
sendiri dan pakai `psctl restore <file> --into <nama>`). Koneksi dari server
lain wajib TLS dengan sertifikat yang diperiksa: `?sslmode=verify-full`
([CONFIGURATION.md](CONFIGURATION.md#database-connections-across-the-network));
installer dan psctl menolak koneksi jaringan tanpa itu.

### A3. Pasang

```bash
git clone <repository> etna-src && cd etna-src
sudo deploy/linux/install.sh
```

Installer bertanya di mana PostgreSQL berada:

- **[1] di server ini**: PostgreSQL 18 dipasang bila belum ada, role
  `etna_owner` (password acak) dan database `etna` dibuat bila belum ada.
  Yang sudah ada tidak diubah.
- **[2] di server lain** (atau sudah disiapkan di sini): masukkan koneksi
  owner, misalnya `postgres://etna_owner@10.0.0.20:5432/etna?sslmode=verify-full`,
  lalu password-nya (tidak tampil saat diketik).

Tanpa pertanyaan (otomatis): `sudo deploy/linux/install.sh --local-postgres --yes`,
atau `sudo PGPASSWORD=… deploy/linux/install.sh --database-url <koneksi owner> --yes`.

Lalu installer memeriksa **isi database** sebelum melakukan apa pun:

| Database | Yang dilakukan |
|---|---|
| Kosong | Disiapkan (migrasi), `etna.env` ditulis dengan kunci baru |
| Sudah berisi ETNA, server ini punya `etna.env` | Update biasa (kunci tetap) |
| Sudah berisi ETNA, belum ada `etna.env` | **Ditolak.** Kunci two-factor harus sama dengan yang dulu: `--settings-from <etna.env lama>`, atau pasang di database kosong lalu `psctl restore` |
| Berisi tabel lain (bukan ETNA) | **Ditolak.** Pakai database kosong |

Installer tidak pernah menghapus, mengosongkan, atau membuat ulang database.

| Lokasi | Isi | Pemilik |
|---|---|---|
| `/opt/etna/releases/etna-<versi>-<waktu>/` | Versi aplikasi (yang aktif dan satu sebelumnya) | root, hanya dibaca layanan |
| `/opt/etna/current` | Symlink ke versi yang berjalan | root |
| `/etc/etna/etna.env` | Pengaturan aplikasi dan kunci (`MFA_ENCRYPTION_KEY`, `SESSION_HINT_SECRET`, koneksi database) | `root:etna`, `0640` |
| `/etc/etna/psctl.env` | Pengaturan psctl: koneksi owner (tanpa password), backup | `root`, `0600` |
| `/etc/etna/owner.pgpass` | Password `etna_owner` (owner tidak dibatasi RLS: layanan aplikasi tidak bisa membacanya) | `root`, `0600` |
| `/etc/etna/backup/` | Kunci backup (publik, dan privat terenkripsi passphrase) | `root`, `0700` |
| `/var/lib/etna/` | `ETNA_DATA_ROOT`: dokumen, folder perusahaan, cache | `etna`, `0750` |
| `/var/backups/etna/` | Backup terenkripsi | `root`, `0700` |
| journal | Log: `psctl logs -f` | |

Layanan: `etna.service` (aplikasi, hanya di `127.0.0.1:4028`),
`etna-worker.service` (worker Terminal), `etna-backup.timer` (backup malam).
Aplikasi dan worker berjalan sebagai `etna` dengan pengamanan systemd: folder
aplikasi hanya bisa dibaca, yang bisa ditulis hanya `/var/lib/etna`. Periksa
dengan `systemd-analyze security etna`.

### A4. Akun pertama

Tidak ada pendaftaran mandiri.

```bash
sudo psctl users create-user --email anda@contoh.com --name "Nama Anda"
```

Password sementara tampil sekali. Ganti setelah sign-in. Admin platform:
`sudo psctl users grant-admin --email anda@contoh.com` (lihat [ADMIN.md](ADMIN.md)).

### A5. Backup terenkripsi

```bash
sudo psctl backup-setup --copy-to /mnt/nas/etna   # passphrase: simpan di password manager
sudo psctl backup                                 # yang pertama, sekarang
```

Satu file `etna-offsite-<waktu>.etnabak` berisi **database, dokumen, folder
perusahaan, dan `etna.env` (kunci)**, dienkripsi (AES-256-GCM; setiap isi
diperiksa checksum-nya saat dibuka). Dibuat setiap malam pukul 02:30 ke
`/var/backups/etna`; 14 file terakhir disimpan (`--keep <n>`). Dengan
`--copy-to`, setiap backup juga disalin ke tempat kedua (NAS, disk lain,
share yang di-mount). **Simpan selalu di luar VM ini**: snapshot Proxmox saja
bukan backup (rusak bersama disk/host yang sama).

- File backup + passphrase = cukup untuk memulihkan di server baru mana pun.
- Tanpa passphrase, tidak ada backup yang bisa dibuka (oleh siapa pun).
- Sebulan sekali: `sudo psctl verify <file>` (membuka dan memeriksa semua isi).
- Setiap update (A7) membuat backup dulu; gagal backup = update dibatalkan.
- Gagal backup tercatat di `journalctl -u etna-backup` dan tampil di `psctl doctor`.

### A6. HTTPS

**Caddy di server ini:** salin `deploy/linux/Caddyfile` ke
`/etc/caddy/Caddyfile`, ganti `erp.example.com`, lalu `sudo systemctl reload
caddy`. Tambahkan ke `/etc/etna/etna.env`:

```
TRUST_PROXY=1
ETNA_PUBLIC_URL=https://erp.example.com
```

lalu `sudo psctl restart`.

**Cloudflare Tunnel:** arahkan tunnel ke `http://127.0.0.1:4028` dan pakai
`TRUST_PROXY=cloudflare` (sama seperti di Windows,
[INSTALL-SERVER.md](INSTALL-SERVER.md) langkah 9).

Firewall: buka hanya 22 (SSH) dan, dengan Caddy, 80 dan 443. Port 4028 dan
5432 tidak perlu dibuka (PostgreSQL di server lain: buka 5432 hanya untuk
alamat server aplikasi).

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

### A7. Memperbarui dan kembali ke versi sebelumnya

```bash
cd etna-src && git pull && sudo deploy/linux/install.sh --yes
# atau dari file rilis (tanpa internet, misalnya lewat USB):
sudo psctl upgrade etna-<versi>.tar.gz
```

Urutannya: backup → build di folder baru → migrasi → `/opt/etna/current`
dipindah → restart → `/api/health`. Gagal build, backup, atau migrasi: versi
yang berjalan tidak tersentuh. Versi baru tidak menjawab: versi sebelumnya
dipasang kembali dengan sendirinya. Kembali secara manual:

```bash
sudo psctl rollback
```

Migrasi tidak ikut dibatalkan (migrasi hanya menambah, versi lama biasanya
tetap jalan). Bila tidak: pulihkan backup yang dibuat sebelum update (A9).

Membuat file rilis dari checkout: `git archive --prefix=etna-<versi>/ -o etna-<versi>.tar.gz HEAD`.

### A8. Pemeriksaan

```bash
sudo psctl status        # layanan, health, versi, database, backup, disk
sudo psctl doctor        # izin file, kunci, TLS, umur backup, ruang disk
sudo psctl logs -f
sh /opt/etna/current/deploy/smoke-test.sh http://127.0.0.1:4028 anda@contoh.com 'password'
```

`smoke-test.sh` memeriksa health, sign-in, sesi, dan satu permintaan data.
`/api/health` (200 = aplikasi dan database siap, 503 = database tidak
terjangkau) bisa dipakai load balancer atau monitoring.

### A9. Memulihkan backup

```bash
sudo psctl backups                       # daftar backup
sudo psctl restore etna-offsite-20261020-023000.etnabak
```

psctl **tidak pernah menimpa database yang ada**:

1. Backup dibuka (passphrase) ke folder sementara.
2. Database **baru** dibuat (`etna_restore_<waktu>`), dimigrasi sejauh
   backup-nya, diisi, lalu dimigrasi ke versi ini.
3. Ringkasannya ditampilkan; aplikasi baru dipindah setelah Anda mengetik
   `switch`: aplikasi berhenti sebentar, dokumen saat ini dipindah ke
   `/var/lib/etna/before-restore-<waktu>/`, dokumen dan kunci dari backup
   dipakai, aplikasi dimulai lagi.
4. Aplikasi tidak menjawab: semuanya kembali seperti sebelumnya dengan sendirinya.

Database lama, dokumen lama, dan `etna.env.before-<waktu>` tetap ada sampai
Anda hapus sendiri (`sudo psctl databases` menampilkan semuanya). Backup dari
versi ETNA yang lebih baru ditolak: update server dulu.

### A10. Pindah ke server baru

Di server lama:

```bash
sudo psctl backup          # lalu salin file .etnabak terbaru ke server baru (atau ambil dari NAS)
```

Di server baru:

```bash
sudo deploy/linux/install.sh --local-postgres     # database kosong
sudo psctl restore /root/etna-offsite-<waktu>.etnabak
sudo psctl backup-setup --copy-to /mnt/nas/etna
```

Semua akun, password, two-factor, perusahaan, data, dan dokumen ikut. Ini
juga cara memasang ulang setelah OS diinstal ulang. Jika database tetap di
server database tersendiri (A11) dan hanya server aplikasi yang diganti:
cukup `sudo deploy/linux/install.sh --database-url <koneksi owner> --settings-from <etna.env lama>`.

### A11. Memindah database ke VM tersendiri

Untuk memisahkan aplikasi dan PostgreSQL (misalnya VM database di Proxmox):
siapkan PostgreSQL di VM baru seperti A2 (database `etna` kosong, TLS), lalu
di server aplikasi:

```bash
sudo psctl db move "postgres://etna_owner@10.0.0.20:5432/etna?sslmode=verify-full"
```

Aplikasi berhenti selama penyalinan (agar tidak ada data yang tertinggal),
database disalin, role aplikasi di server baru mendapat password baru,
`etna.env` diarahkan ke sana, aplikasi dimulai lagi dan diperiksa. Gagal:
kembali ke database lama dengan sendirinya. Database lama tidak dihapus.

### A12. Bila ada yang mati

| Yang mati | Akibat | Pemulihan |
|---|---|---|
| Internet | ETNA tetap berjalan di jaringan kantor; e-mail keluar, kurs online, dan konektor ke layanan luar gagal selama itu | Tidak perlu apa-apa |
| Proses aplikasi | systemd memulai ulang dalam 10 detik | `psctl logs`, `psctl doctor` |
| PostgreSQL | `/api/health` 503, pengguna melihat error; tidak ada data yang ditulis setengah (transaksi) | Nyalakan lagi PostgreSQL, lalu `psctl status` (bila belum pulih: `psctl restart`) |
| Disk VM / VM rusak | — | Server baru + `psctl restore` (A10) dari backup di NAS |
| Host Proxmox | — | VM di host lain (Proxmox HA/replikasi), atau A10 |
| Passphrase backup hilang | Backup lama tidak bisa dibuka | `psctl backup-setup` di folder kunci baru, buat backup baru segera |

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
| `first install: give --local-postgres or --database-url` | Jalankan tanpa `--yes` (installer bertanya), atau beri salah satu opsi itu |
| `the database already holds ETNA` | Database berisi ETNA tapi server ini belum punya `etna.env`: `--settings-from <etna.env lama>`, atau database kosong + `psctl restore` (A10) |
| `is another machine: add ?sslmode=verify-full` | Koneksi ke server database lain harus TLS dengan sertifikat yang diperiksa (A2) |
| `Could not create database etna_restore_…` | `etna_owner` tidak punya `CREATEDB`: buat database kosong sendiri, lalu `psctl restore <file> --into <nama>` |
| `password authentication failed for user "etna_owner"` | `PGPASSWORD` salah, atau `pg_hba.conf` tidak mengizinkan `scram-sha-256` dari alamat itu |
| Layanan `etna` restart terus | `journalctl -u etna -n 100`; biasanya koneksi database (`DATABASE_URL`) |
| Link reset password memakai alamat salah | Isi `ETNA_PUBLIC_URL` |
| Batas sign-in berlaku per akun, bukan per alamat | Di belakang proxy: isi `TRUST_PROXY` |
| Docker: `setup` gagal | `docker compose logs setup`; password di `.env` tidak sama dengan saat volume `etna_pgdata` dibuat |
