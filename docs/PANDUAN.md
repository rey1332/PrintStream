# Panduan PrintStream (ETNA)

Panduan ini menjelaskan cara memasang, memakai, dan merawat PrintStream dengan
bahasa yang sederhana. Penjelasan teknis yang lebih dalam ada di folder
[teknis/](teknis/) (daftarnya di [bagian 9](#9-dokumen-teknis)).

**Isi:**

1. [PrintStream itu apa](#1-printstream-itu-apa)
2. [Data disimpan di mana](#2-data-disimpan-di-mana)
3. [Pasang di Ubuntu Server (untuk dipakai kantor)](#3-pasang-di-ubuntu-server-untuk-dipakai-kantor)
4. [Pasang di Windows (PC development)](#4-pasang-di-windows-pc-development)
5. [Perintah sehari-hari](#5-perintah-sehari-hari)
6. [Update ke versi baru](#6-update-ke-versi-baru)
7. [Backup, restore, dan pindah server](#7-backup-restore-dan-pindah-server)
8. [Kalau ada masalah](#8-kalau-ada-masalah)
9. [Dokumen teknis](#9-dokumen-teknis)

---

## 1. PrintStream itu apa

PrintStream (dibuat oleh ETNA) adalah aplikasi web untuk mengelola data bisnis
dalam satu tempat:

- **ERP**: penjualan, pembelian, stok, akuntansi, pajak, HR, payroll.
- **Terminal**: dataset, import file, pipeline otomatis, dan Query Tool (SQL)
  untuk menganalisis data.
- **Keamanan**: setiap pengguna punya peran (Owner, Admin, Finance, dll.),
  login dengan password dan two-factor (kode dari aplikasi authenticator),
  dan semua perubahan penting tercatat.

Semuanya berjalan **di server kamu sendiri** (self-host). Tidak ada layanan
cloud yang wajib: login, password, two-factor, dan data bisnis tidak pernah
dikirim ke pihak lain. Tanpa internet, PrintStream tetap jalan di jaringan
kantor (hanya fitur yang memang butuh internet, seperti kirim e-mail atau kurs
online, yang berhenti sementara).

**Cara kerjanya, singkat:**

```
Browser  ──►  Aplikasi PrintStream  ──►  PostgreSQL (database)
                     │
                     └──►  Folder data (dokumen, file perusahaan)
```

Aplikasi memeriksa siapa yang login dan apa haknya. Database juga memeriksa
lagi (setiap perusahaan hanya bisa melihat datanya sendiri). Ada juga
**worker**: proses kecil di samping aplikasi yang menjalankan pekerjaan di
belakang layar (import, pipeline, jadwal).

---

## 2. Data disimpan di mana

Ada **tiga hal** yang harus selalu dijaga. Kalau pindah PC atau server, ketiganya
harus ikut:

| Apa | Isinya | Kalau hilang |
|---|---|---|
| **Database** | Akun, password, two-factor, perusahaan, semua data bisnis | Semua data hilang |
| **Folder data** | Dokumen yang di-upload, file per perusahaan | Lampiran/dokumen hilang |
| **File pengaturan** (`etna.env` / `.env.local`) | Kunci rahasia, termasuk kunci two-factor | Semua orang harus daftar ulang authenticator |

Lokasinya:

| | Ubuntu Server | Windows (PC development) |
|---|---|---|
| Database | PostgreSQL (`/var/lib/postgresql/18/main`) | PostgreSQL (`C:\Program Files\PostgreSQL\18\data`) |
| Folder data | `/var/lib/etna` | `C:\PrintStream\storage` |
| File pengaturan | `/etc/etna/etna.env` | `C:\PrintStream\.env.local` |
| Backup | `/var/backups/etna` (+ salinan ke NAS) | folder di `ETNA_BACKUP_DIR` (`.env.local`) |

> Jangan menyalin folder database PostgreSQL secara langsung. Selalu pakai
> **backup** (bagian 7): salinan folder yang diambil saat PostgreSQL jalan bisa
> rusak.

---

## 3. Pasang di Ubuntu Server (untuk dipakai kantor)

Ini cara yang disarankan untuk dipakai sehari-hari. Bisa di PC server biasa
atau VM di Proxmox.

### 3.1 Yang dibutuhkan

- **Ubuntu Server 24.04 LTS**.
- Minimal **2 CPU, 4 GB RAM, disk 40 GB** (tambah sesuai banyaknya data).
- Akses `sudo` dan internet (untuk memasang paket).
- Satu tempat backup di luar server ini: NAS, disk lain, atau share jaringan.

### 3.2 Siapkan Ubuntu

Login ke server, lalu jalankan satu per satu:

```bash
sudo apt update && sudo apt upgrade -y
```
```bash
sudo apt install -y git curl
```

Pasang **Node.js 24** (dari NodeSource, supaya terpasang untuk semua user):

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
```
```bash
sudo apt install -y nodejs
```

Cek: `node -v` harus menampilkan `v24.…`.

> Jangan pasang Node lewat `nvm` di folder home: layanan PrintStream tidak
> boleh membaca folder home, jadi tidak akan menemukannya.

### 3.3 Ambil kode PrintStream

```bash
git clone https://github.com/rey1332/PrintStream.git etna-src
```
```bash
cd etna-src
```

### 3.4 Jalankan installer

```bash
sudo deploy/linux/install.sh
```

Installer akan bertanya **di mana PostgreSQL-nya**:

- **[1] di server ini** → pilih ini kalau baru mulai. PostgreSQL 18 dipasang
  otomatis, database `etna` dan user `etna_owner` dibuat (password acak,
  disimpan di file yang hanya bisa dibaca root).
- **[2] di server lain** → kalau database ada di VM/server terpisah. Kamu
  diminta alamat seperti
  `postgres://etna_owner@10.0.0.20:5432/etna?sslmode=verify-full` dan
  passwordnya (tidak tampil saat diketik). Cara menyiapkan server database:
  [teknis/INSTALL-LINUX.md](teknis/INSTALL-LINUX.md) bagian A2.

Proses build butuh beberapa menit. Selesai kalau muncul
`ETNA answers on 127.0.0.1:4028` dan `Done`.

**Aman dijalankan ulang.** Installer tidak pernah menghapus atau menimpa
database. Kalau database sudah berisi data PrintStream tapi server ini belum
punya `etna.env`, installer **menolak** (supaya kunci two-factor tidak
berubah) dan memberi tahu pilihannya.

### 3.5 Buat akun pertama

Tidak ada pendaftaran sendiri dari halaman web. Akun dibuat dari server:

```bash
sudo psctl users create-user --email kamu@contoh.com --name "Nama Kamu"
```

Password sementara tampil **sekali**: catat, login, lalu ganti di
**ERP → Settings → Ubah kata sandi (Change password)**.

Jadikan akun itu admin platform (opsional):

```bash
sudo psctl users grant-admin --email kamu@contoh.com
```

Sembunyikan panel admin di alamat rahasia (`/admin` jadi 404 untuk semua orang):

```bash
sudo psctl admin-path new
```

Alamatnya tampil sekali di layar: simpan di password manager. Lupa? Jalankan
`sudo psctl admin-path` untuk melihatnya lagi ([ADMIN.md](teknis/ADMIN.md), *Address*).

### 3.6 Nyalakan backup otomatis

```bash
sudo psctl backup-setup --copy-to /mnt/nas/etna
```

Kamu diminta membuat **passphrase backup** (minimal 12 karakter).
**Simpan di password manager.** Tanpa passphrase ini, backup tidak bisa dibuka
oleh siapa pun.

`--copy-to` adalah folder kedua (NAS/disk lain yang sudah di-mount). Boleh
dilewati dulu, tapi sangat disarankan.

Buat backup pertama sekarang:

```bash
sudo psctl backup
```

Setelah itu backup berjalan sendiri setiap malam jam 02:30.

### 3.7 Buka dari komputer lain (HTTPS)

Aplikasi hanya mendengarkan di `127.0.0.1:4028` (dalam server saja). Supaya
bisa dibuka dari PC lain, pasang "pintu depan" HTTPS. Login **harus** lewat
HTTPS. Pilih salah satu:

**A. Punya domain (misalnya `erp.perusahaan.com`)** → pakai Caddy:

```bash
sudo apt install -y caddy
```
```bash
sudo cp deploy/linux/Caddyfile /etc/caddy/Caddyfile
```
```bash
sudo nano /etc/caddy/Caddyfile
```

Ganti `erp.example.com` dengan domain kamu, simpan, lalu:

```bash
sudo systemctl reload caddy
```

Domain harus mengarah ke IP server dan port 80 serta 443 harus terbuka.

**B. Cloudflare Tunnel** (tanpa membuka port): arahkan tunnel ke
`http://127.0.0.1:4028`. Detail: [teknis/INSTALL-SERVER.md](teknis/INSTALL-SERVER.md) langkah 9.

Setelah A atau B, beri tahu PrintStream alamatnya:

```bash
sudo nano /etc/etna/etna.env
```

Tambahkan (untuk Cloudflare Tunnel pakai `TRUST_PROXY=cloudflare`):

```
TRUST_PROXY=1
ETNA_PUBLIC_URL=https://erp.perusahaan.com
```

lalu:

```bash
sudo psctl restart
```

**Firewall** (hanya buka yang perlu):

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

### 3.8 Cek semuanya

```bash
sudo psctl status
```
```bash
sudo psctl doctor
```

`status` menampilkan layanan, versi, database, backup, dan sisa disk.
`doctor` memeriksa izin file, kunci, koneksi, dan umur backup. Semua `ok`
berarti aman.

---

## 4. Pasang di Windows (PC development)

Untuk mencoba dan mengembangkan PrintStream di PC sendiri. Untuk dipakai
kantor, pakai Ubuntu (bagian 3).

### 4.1 Yang dibutuhkan

- **Node.js 24 LTS** dari [nodejs.org](https://nodejs.org).
- **PostgreSQL 18** dari [postgresql.org](https://www.postgresql.org/download/windows/)
  (sekalian pgAdmin). Catat **port** yang dipilih saat instal (bawaannya 5432).
- **Git** dari [git-scm.com](https://git-scm.com).

### 4.2 Ambil kode

Buka **Command Prompt** (cmd). Simpan di folder biasa, **bukan** di OneDrive:

```bat
cd /d C:\
```
```bat
git clone https://github.com/rey1332/PrintStream.git PrintStream
```
```bat
cd /d C:\PrintStream
```
```bat
npm ci
```

### 4.3 Buat database

Buka **pgAdmin** → klik kanan server → **Query Tool** (login sebagai
`postgres`). Jalankan **satu baris per satu kali** (blok satu baris, lalu
Execute):

```sql
CREATE ROLE etna_owner LOGIN CREATEROLE PASSWORD 'ganti-dengan-password-kuat';
```
```sql
CREATE DATABASE etna OWNER etna_owner;
```

### 4.4 Siapkan PrintStream (sekali saja)

```bat
node scripts\setup-local.mjs
```

Kamu ditanya:

1. **Koneksi owner**: tekan Enter kalau port-nya 5432, atau ketik misalnya
   `postgres://etna_owner@localhost:3000/etna` kalau port-nya 3000.
2. **Password `etna_owner`**: tidak tampil saat diketik.

Ini membuat tabel-tabel, membuat file `.env.local` (berisi kunci rahasia), dan
menyimpan koneksi owner. Setelah ini **tidak perlu lagi** mengetik
`set ADMIN_DATABASE_URL=…` atau `set MIGRATION_DATABASE_URL=…`.

> **Simpan salinan `.env.local` di password manager.** Isinya kunci two-factor.

### 4.5 Buat akun pertama

```bat
node scripts\admin\users.mjs create-user --email kamu@contoh.com --name "Nama Kamu"
```

Password sementara tampil sekali.

### 4.6 Jalankan

Mode development (berubah otomatis saat kode diedit):

```bat
npm run dev
```

Atau mode produksi:

```bat
npm run build
```
```bat
npm start
```

Lalu buka **http://localhost:4028/erp/login**.

Untuk fitur Terminal (import, pipeline, jadwal), buka **cmd kedua**:

```bat
cd /d C:\PrintStream
```
```bat
npm run worker
```

### 4.7 Backup di Windows (wajib kalau ada data asli)

Data PrintStream di Windows ada di **tiga tempat**: database PostgreSQL,
folder `C:\PrintStream\storage` (dokumen dan file upload), dan file
`.env.local` (kunci two-factor). Satu perintah ini membungkus **ketiganya**
dalam satu file `.etnabak` terenkripsi:

```bat
npm run pc:backup
```

Pertama kali, ditanya:

1. **Folder backup**: pilih disk lain (flashdisk, NAS, share jaringan),
   misalnya `E:\ETNA-backup`. Backup di disk yang sama ikut hilang kalau
   disk itu rusak.
2. **Passphrase** (minimal 12 karakter, diketik dua kali). **Simpan di
   password manager.** Tanpa passphrase, backup tidak bisa dibuka oleh siapa
   pun, termasuk ETNA.

Setelah itu `npm run pc:backup` tidak bertanya apa-apa lagi. Cek sesekali
bahwa file backup bisa dibuka:

```bat
npm run pc:verify -- E:\ETNA-backup\etna-offsite-20261025-170000.etnabak
```

Supaya otomatis setiap hari: **Task Scheduler** → Create Basic Task → Daily
→ Start a program: `cmd.exe`, argumen
`/c cd /d C:\PrintStream && npm run pc:backup`. 14 backup terbaru disimpan,
yang lebih lama dihapus.

File `.etnabak` yang sama juga bisa dipulihkan di server Ubuntu dengan
`sudo psctl restore` (bagian 7).

> `npm run db:backup` yang lama hanya menyimpan database (tanpa dokumen dan
> kunci). Untuk pindah PC, pakai `npm run pc:backup`.

### 4.8 Pindah ke PC baru

Di **PC lama**: `npm run pc:backup`, lalu salin file `.etnabak` terbaru ke
flashdisk (atau ambil dari NAS).

Di **PC baru**:

1. Pasang Node.js, PostgreSQL, dan Git, ambil kode, lalu `npm ci`
   (bagian 4.1 dan 4.2).
2. Buat owner dan database **kosong** di pgAdmin (bagian 4.3). **Jangan**
   jalankan `setup-local` dan jangan buat akun.
3. Pulihkan:

   ```bat
   npm run pc:restore -- E:\etna-offsite-20261025-170000.etnabak
   ```

   Ditanya koneksi owner (tekan Enter kalau port 5432), password
   `etna_owner`, dan passphrase backup. Ringkasan isi backup ditampilkan;
   ketik `restore` untuk lanjut.
4. Jalankan seperti biasa (`npm run dev` dan `npm run worker`), lalu
   `npm run pc:backup` untuk menyiapkan backup di PC ini.

Semua ikut: akun, password, two-factor (tidak perlu daftar ulang
authenticator), perusahaan, data, setting, dokumen, dan file upload.

Restore **tidak pernah menimpa data**:

- Data hanya diisi ke database yang **kosong**. Kalau database `etna` sudah
  berisi, restore berhenti dan memberi tahu cara membuat database kosong
  baru (`CREATE DATABASE etna_restore OWNER etna_owner;` lalu tambahkan
  `--into etna_restore`).
- `.env.local` yang sudah ada disimpan dulu sebagai
  `.env.local.before-restore-<waktu>`, dan dokumen yang sudah ada dipindah ke
  `storage\before-restore-<waktu>\`.
- Isi backup yang dibuka sementara selalu dihapus setelahnya, berhasil atau
  gagal.

---

## 5. Perintah sehari-hari

### Di Ubuntu Server (`psctl`)

| Mau apa | Perintah |
|---|---|
| Lihat kondisi | `sudo psctl status` |
| Periksa masalah | `sudo psctl doctor` |
| Nyalakan / matikan / restart | `sudo psctl start` / `stop` / `restart` |
| Lihat log | `sudo psctl logs -f` (keluar: Ctrl+C) |
| Buat akun | `sudo psctl users create-user --email …` |
| Reset password akun | `sudo psctl users set-password --email …` |
| HP hilang (reset two-factor) | `sudo psctl users reset-mfa --email …` |
| Kunci / buka akun | `sudo psctl users lock --email …` / `unlock --email …` |
| Backup sekarang | `sudo psctl backup` |
| Daftar backup | `sudo psctl backups` |
| Cek backup bisa dibuka | `sudo psctl verify <file>` |
| Daftar database | `sudo psctl databases` |

### Di Windows

| Mau apa | Perintah (di `C:\PrintStream`) |
|---|---|
| Jalankan | `npm run dev` (atau `npm run build` lalu `npm start`) |
| Jalankan worker | `npm run worker` (cmd kedua) |
| Terapkan perubahan database | `npm run db:migrate` |
| Buat akun | `node scripts\admin\users.mjs create-user --email …` |
| Daftar akun | `node scripts\admin\users.mjs list` |
| Reset password | `node scripts\admin\users.mjs set-password --email …` |
| Backup (database + dokumen + kunci) | `npm run pc:backup` |
| Cek backup bisa dibuka | `npm run pc:verify -- <file>` |
| Pulihkan di PC baru | `npm run pc:restore -- <file>` |

---

## 6. Update ke versi baru

### Ubuntu

```bash
cd etna-src
```
```bash
git pull
```
```bash
sudo deploy/linux/install.sh --yes
```

Yang terjadi: backup dulu → build versi baru di folder terpisah → perubahan
database diterapkan → pindah ke versi baru → dicek. Kalau versi baru tidak
jalan, **versi lama dipasang lagi otomatis**.

Tanpa internet (file rilis dari USB):

```bash
sudo psctl upgrade etna-<versi>.tar.gz
```

Kembali ke versi sebelumnya secara manual:

```bash
sudo psctl rollback
```

### Windows

```bat
cd /d C:\PrintStream
```
```bat
git pull
```
```bat
npm ci
```
```bat
npm run db:migrate
```
```bat
npm run build
```

Lalu jalankan lagi `npm start` (dan `npm run worker`).

---

## 7. Backup, restore, dan pindah server

### Isi backup

Satu file `etna-offsite-<tanggal>.etnabak` berisi **database + dokumen + file
pengaturan (kunci)**, terenkripsi. File itu + passphrase = cukup untuk
memulihkan semuanya di server mana pun.

Aturan penting:

- Simpan backup **di luar server** (NAS, disk lain). Snapshot Proxmox saja
  **bukan** backup.
- Cek sebulan sekali: `sudo psctl verify <file>`.
- Kalau passphrase hilang, backup lama tidak bisa dibuka. Buat kunci baru
  (`psctl backup-setup`) dan backup baru segera.

### Restore (memulihkan)

```bash
sudo psctl backups
```
```bash
sudo psctl restore etna-offsite-20261020-023000.etnabak
```

PrintStream **tidak pernah menimpa database yang ada**:

1. Backup dibuka (diminta passphrase).
2. Data dimasukkan ke **database baru** (`etna_restore_<waktu>`).
3. Ringkasan ditampilkan. Ketik `switch` untuk memindahkan aplikasi ke
   database baru itu.
4. Kalau aplikasi tidak jalan setelahnya, semuanya **kembali seperti semula**
   otomatis.

Database lama dan dokumen lama tetap disimpan sampai kamu hapus sendiri.

### Pindah ke server baru

Di server lama:

```bash
sudo psctl backup
```

Salin file `.etnabak` terbaru ke server baru (atau ambil dari NAS). Di server
baru, setelah langkah 3.2 dan 3.3:

```bash
sudo deploy/linux/install.sh --local-postgres
```
```bash
sudo psctl restore /root/etna-offsite-<waktu>.etnabak
```
```bash
sudo psctl backup-setup --copy-to /mnt/nas/etna
```

Semua ikut: akun, password, two-factor, perusahaan, data, dokumen. Cara ini
juga dipakai kalau Ubuntu diinstal ulang.

### Pisahkan database ke VM sendiri

Siapkan PostgreSQL di VM baru (database `etna` kosong, koneksi TLS; lihat
[teknis/INSTALL-LINUX.md](teknis/INSTALL-LINUX.md) bagian A2), lalu di server
aplikasi:

```bash
sudo psctl db move "postgres://etna_owner@10.0.0.20:5432/etna?sslmode=verify-full"
```

Aplikasi berhenti sebentar, database disalin, lalu aplikasi pindah ke server
database baru. Database lama tidak dihapus.

### Tambah server aplikasi (horizontal scaling)

Kalau satu server sudah berat, tambah server aplikasi. Semua server memakai
database yang sama (harus sudah di VM sendiri, lihat di atas) dan folder data
server pertama lewat NFS. Cloudflare Tunnel membagi pengunjung ke semuanya.

Di server pertama:

```bash
sudo psctl cluster share --allow 10.0.0.0/24
```

Di server baru (setelah menyalin `/etc/etna/etna.env` dari server pertama ke
`/root/etna.env`):

```bash
sudo deploy/linux/install.sh --database-url "postgres://etna_owner@10.0.0.20:5432/etna?sslmode=verify-full" --settings-from /root/etna.env --shared-data 10.0.0.10:/var/lib/etna
```

Lalu di setiap server: `sudo cloudflared service install <token tunnel>` dan
`sudo psctl cluster tunnel`. Cek dengan `sudo psctl cluster status`.
Langkah lengkapnya: [teknis/CLUSTER.md](teknis/CLUSTER.md).

---

## 8. Kalau ada masalah

Selalu mulai dari:

- Ubuntu: `sudo psctl doctor` lalu `sudo psctl logs -n 100`
- Windows: lihat pesan error di jendela cmd yang menjalankan `npm start`

| Gejala | Penyebab dan solusi |
|---|---|
| Tidak bisa login, padahal password benar | Dibuka lewat `http://` dari PC lain: login butuh HTTPS (bagian 3.7). Atau akun terkunci: `psctl users unlock --email …` |
| `password authentication failed for user "etna_owner"` | Password owner salah. Jalankan lagi installer / `setup-local` dan ketik password yang benar |
| `password authentication failed for user "etna_app"` (Windows) | `.env.local` bukan pasangan database ini. Database baru & kosong: `node scripts\setup-local.mjs --force`, lalu buat akun lagi |
| `ConfigError: DATABASE_URL is not set` (Windows) | Belum ada `.env.local`: jalankan `node scripts\setup-local.mjs` |
| `the database already holds ETNA` | Database sudah berisi data tapi server ini belum punya `etna.env`. Pakai `--settings-from <etna.env lama>`, atau database kosong + `psctl restore` |
| `is another machine: add ?sslmode=verify-full` | Koneksi ke database di server lain wajib aman: tambahkan `?sslmode=verify-full` |
| `/api/health` menunjukkan `"database":"unreachable"` | PostgreSQL mati atau koneksi salah. Nyalakan PostgreSQL, lalu `psctl restart` |
| Halaman error setelah update (Windows) | Lupa `npm run db:migrate` |
| Fitur Terminal (import/pipeline) diam saja | Worker tidak jalan. Windows: `npm run worker`. Ubuntu: `sudo psctl status` |
| Link reset password memakai alamat salah | Isi `ETNA_PUBLIC_URL` di file pengaturan |
| Backup gagal | `sudo psctl doctor` dan `journalctl -u etna-backup -n 50`; biasanya NAS tidak ter-mount atau disk penuh |

---

## 9. Dokumen teknis

Untuk detail yang tidak dibahas di sini (semuanya di folder [teknis/](teknis/)):

| File | Isinya |
|---|---|
| [installation-update.md](installation-update.md) | Instalasi & update langkah demi langkah: Ubuntu, Windows + pgAdmin, cluster multi-node, troubleshooting |
| [INSTALL-LINUX.md](teknis/INSTALL-LINUX.md) | Instalasi Linux lengkap, psctl, Docker Compose |
| [INSTALL-SERVER.md](teknis/INSTALL-SERVER.md) | Instalasi server Windows (aplikasi & database terpisah) |
| [HOW TO ETNA.md](teknis/HOW%20TO%20ETNA.md) | Panduan server Windows dengan server manager |
| [CONFIGURATION.md](teknis/CONFIGURATION.md) | Semua pengaturan di `etna.env` / `.env.local` |
| [OPERATIONS.md](teknis/OPERATIONS.md) | Rilis, backup off-site, monitoring, insiden |
| [DEVELOPMENT.md](teknis/DEVELOPMENT.md) | Untuk developer: tes, migrasi database, struktur kode |
| [ADMIN.md](teknis/ADMIN.md) | Admin platform dan dashboard `/admin` |
| [ROLES.md](teknis/ROLES.md) | Peran dan hak akses |
| [FINANCE.md](teknis/FINANCE.md), [TAX.md](teknis/TAX.md), [CURRENCY.md](teknis/CURRENCY.md) | Akuntansi, pajak Indonesia, mata uang |
| [INDUSTRY-MODULES.md](teknis/INDUSTRY-MODULES.md) | Template industri, modul, dan payroll Indonesia |
| [ANALYSIS-QUARRY.md](teknis/ANALYSIS-QUARRY.md) | Analisis: ETNA untuk usaha tambang batu (quarry) |
| [TERMINAL.md](teknis/TERMINAL.md) | Terminal: dataset, import, pipeline, Query Tool, MCP |
| [CONSOLE.md](teknis/CONSOLE.md) | Konsol perintah di dalam aplikasi |
| [WORKFLOWS.md](teknis/WORKFLOWS.md), [HOW TO WORKFLOWS.md](teknis/HOW%20TO%20WORKFLOWS.md) | Pipeline dan workflow |
| [ONTOLOGY.md](teknis/ONTOLOGY.md) | Model data bersama dan pencarian lintas ERP (ERP → Search) |
| [CLUSTER.md](teknis/CLUSTER.md) | Beberapa server aplikasi: NFS, Cloudflare Tunnel, update |
| [TUNNELS.md](teknis/TUNNELS.md) | Menghubungkan sistem di jaringan perusahaan |
| [BACKEND_MIGRATION.md](teknis/BACKEND_MIGRATION.md) | Sejarah: pindah dari Supabase ke PostgreSQL sendiri |
