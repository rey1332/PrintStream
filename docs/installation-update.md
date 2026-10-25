# Instalasi & Update PrintStream

Panduan lengkap dari mesin kosong sampai PrintStream siap dipakai: server
Ubuntu untuk produksi, PC Windows untuk development, beberapa server sekaligus
(cluster), dan cara meng-update semuanya.

Ringkasan singkatnya ada di [PANDUAN.md](PANDUAN.md); detail teknis di
[teknis/](teknis/).

## Daftar isi

- [0. Pilih jalurnya](#0-pilih-jalurnya)
- [A. Server Ubuntu (produksi, satu server)](#a-server-ubuntu-produksi-satu-server)
- [B. PC Windows (development)](#b-pc-windows-development)
- [C. Beberapa server (cluster multi-node)](#c-beberapa-server-cluster-multi-node)
- [D. Update ke versi baru](#d-update-ke-versi-baru)
- [E. Kalau ada masalah](#e-kalau-ada-masalah)

Aturan untuk semua bagian:

- Jalankan perintah **satu per satu**, baca hasilnya sebelum lanjut.
- **Jangan pernah** menempelkan isi `etna.env`, `.env.local`, password,
  passphrase backup, atau token tunnel di chat, e-mail, atau screenshot.
- Tulisan seperti `kamu@domain.com`, `10.0.0.20`, `erp.domainkamu.com` adalah
  contoh: ganti dengan milikmu.

---

## 0. Pilih jalurnya

| Mau apa | Bagian | Yang dipasang manual |
|---|---|---|
| Dipakai kantor / customer | **A** | Ubuntu, Node.js, Git. Sisanya (PostgreSQL, `npm ci`, build, migrasi, layanan) dikerjakan installer |
| Mencoba & mengembangkan di PC sendiri | **B** | Node.js, Git, PostgreSQL + pgAdmin, lalu `npm ci`, setup, `npm run dev` / `npm run build` |
| Satu server sudah tidak cukup | **A** dulu, lalu **C** | Server database sendiri + server aplikasi tambahan |

Di Ubuntu **tidak perlu** `npm install` atau `npm run build` sendiri: installer
yang menjalankannya, di folder rilis terpisah, lalu memindahkan aplikasi ke
versi baru hanya kalau semuanya berhasil.

---

## A. Server Ubuntu (produksi, satu server)

### A1. Yang dibutuhkan

| | Minimal | Catatan |
|---|---|---|
| Sistem | **Ubuntu Server 24.04 LTS** | 26.04 juga bisa (lihat A5). Ubuntu Desktop bisa untuk tes, Server untuk produksi |
| CPU / RAM / disk | 2 CPU, 4 GB RAM, 40 GB | Tambah sesuai data. VM Proxmox/VMware boleh |
| Jaringan | Internet saat instalasi | Untuk paket apt, Node.js, dan npm |
| Backup | Satu tempat **di luar** server | NAS, disk kedua, atau share jaringan |
| Domain | Opsional, untuk akses dari luar | Lewat Cloudflare (A8) |

Saat memasang Ubuntu, centang **OpenSSH server** supaya server bisa dikelola
dari PC lain.

### A2. Siapkan Ubuntu

Masuk ke server (dari PC Windows: buka Command Prompt / PowerShell):

```bash
ssh namauser@ip-server
```

Update sistem:

```bash
sudo apt update && sudo apt upgrade -y
```

Pasang Git dan curl:

```bash
sudo apt install -y git curl
```

Atur zona waktu (backup otomatis jalan jam 02:30 waktu server):

```bash
sudo timedatectl set-timezone Asia/Jakarta
```

### A3. Pasang Node.js 24

Dari NodeSource, supaya Node terpasang untuk semua user sistem:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
```
```bash
sudo apt install -y nodejs
```

Cek:

```bash
node -v
```

Harus `v24.…` (minimal `v22.18`).

> **Jangan pakai `nvm`.** `nvm` memasang Node di folder home, dan layanan
> PrintStream sengaja tidak boleh membaca folder home, jadi Node tidak akan
> ditemukan.

### A4. Ambil kode PrintStream

Pakai **`git clone`**, bukan download ZIP. Dengan Git, update cukup
`git pull` dan installer bisa memberi build id yang sama di semua server.

```bash
cd ~
```
```bash
git clone https://github.com/rey1332/PrintStream.git etna-src
```
```bash
cd etna-src
```

### A5. Jalankan installer

```bash
sudo deploy/linux/install.sh
```

Installer bertanya di mana PostgreSQL-nya:

```
Where is the PostgreSQL for ETNA?
  [1] on this server (PostgreSQL 18 is installed when missing)
  [2] on another server, or already set up here (you give its owner connection)
```

- **Pilih `1`** untuk server pertama. PostgreSQL dipasang otomatis, lalu role
  `etna_owner` (password acak) dan database `etna` dibuat.
- **`2`** hanya kalau database ada di server lain (bagian C).

Yang dikerjakan installer, berurutan:

1. memeriksa Node.js dan membuat user sistem `etna`;
2. memasang PostgreSQL bila belum ada (PostgreSQL 18; di Ubuntu yang belum
   didukung apt.postgresql.org, misalnya 26.04, dipakai PostgreSQL bawaan
   Ubuntu), membuat role `etna_owner` dan database `etna`;
3. menyalin kode ke `/opt/etna/releases/<versi>`, menjalankan **`npm ci`** dan
   **`next build`** di sana;
4. membuat `/etc/etna/etna.env` (kunci rahasia: two-factor, sesi) dan
   password untuk role aplikasi;
5. menjalankan **migrasi database**;
6. memasang dan menyalakan layanan `etna` (aplikasi) dan `etna-worker`
   (import, pipeline, jadwal);
7. memasang perintah **`psctl`** untuk mengelola server.

Butuh beberapa menit. Selesai kalau muncul `ETNA answers on 127.0.0.1:4028`
lalu `Done`.

Lokasi penting setelah instalasi:

| Path | Isi | Rahasia? |
|---|---|---|
| `/etc/etna/etna.env` | Pengaturan aplikasi dan kunci | **Ya** |
| `/etc/etna/psctl.env`, `/etc/etna/owner.pgpass` | Koneksi dan password owner database | **Ya** |
| `/opt/etna/current` | Versi yang sedang jalan | Tidak |
| `/var/lib/etna` | Dokumen dan file perusahaan | Data customer |
| `/var/backups/etna` | Backup | Terenkripsi |

Installer **aman dijalankan ulang**: ia tidak pernah menghapus atau menimpa
database.

### A6. Akun admin pertama

Tidak ada pendaftaran dari halaman web: akun hanya dibuat dari server
(atau oleh admin ETNA di panel admin).

Buat akunmu:

```bash
sudo psctl users create-user --email kamu@domain.com --name "Nama Kamu"
```

Password sementara tampil **sekali**: catat.

Jadikan admin platform (super admin):

```bash
sudo psctl users grant-admin --email kamu@domain.com
```

Sembunyikan panel admin di alamat rahasia (`/admin` jadi 404 untuk semua orang):

```bash
sudo psctl admin-path new
```

Simpan alamatnya di password manager. Lihat lagi kapan saja dengan
`sudo psctl admin-path`. Penjelasan lengkap: [teknis/ADMIN.md](teknis/ADMIN.md).

### A7. Backup otomatis

Kalau ada NAS atau disk kedua, mount dulu (misalnya di `/mnt/nas`), lalu:

```bash
sudo psctl backup-setup --copy-to /mnt/nas/etna
```

Belum punya tempat kedua? Boleh tanpa `--copy-to` dulu, tapi segera tambahkan:

```bash
sudo psctl backup-setup
```

Kamu diminta membuat **passphrase backup** (minimal 12 karakter). Simpan di
**dua tempat** (password manager + kertas di tempat aman). Tanpa passphrase,
backup tidak bisa dibuka oleh siapa pun.

Backup pertama sekarang:

```bash
sudo psctl backup
```

Setelah itu backup jalan sendiri setiap malam jam 02:30. Satu file backup
berisi **database + dokumen + folder perusahaan + `etna.env`**, terenkripsi.

### A8. Akses dari internet (HTTPS)

Aplikasi hanya mendengarkan di `127.0.0.1:4028`. Login **wajib** lewat HTTPS.
Pilih satu.

#### Pilihan 1: Cloudflare Tunnel (disarankan, tanpa membuka port)

Butuh domain yang sudah dikelola Cloudflare.

Pasang `cloudflared`:

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
```
```bash
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
```
```bash
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
```
```bash
sudo apt update && sudo apt install -y cloudflared
```

Di dashboard Cloudflare:

1. **Zero Trust → Networks → Tunnels → Create a tunnel** → pilih
   **Cloudflared** → beri nama (misalnya `printstream`).
2. Salin **token**-nya, lalu di server:
   ```bash
   sudo cloudflared service install <token-tunnel>
   ```
3. Tab **Public Hostname** → **Add**: hostname `erp.domainkamu.com`,
   service **HTTP**, URL `localhost:4028`.

Beri tahu PrintStream alamatnya:

```bash
sudo nano /etc/etna/etna.env
```

Tambahkan di paling bawah (simpan: Ctrl+O, Enter, keluar: Ctrl+X):

```
TRUST_PROXY=cloudflare
ETNA_PUBLIC_URL=https://erp.domainkamu.com
```

```bash
sudo psctl restart
```

#### Pilihan 2: Caddy (domain mengarah langsung ke IP server)

```bash
sudo apt install -y caddy
```
```bash
sudo cp deploy/linux/Caddyfile /etc/caddy/Caddyfile
```
```bash
sudo nano /etc/caddy/Caddyfile
```

Ganti `erp.example.com` dengan domainmu, simpan, lalu:

```bash
sudo systemctl reload caddy
```

Di `/etc/etna/etna.env` tambahkan `TRUST_PROXY=1` dan
`ETNA_PUBLIC_URL=https://erp.domainkamu.com`, lalu `sudo psctl restart`.
Port 80 dan 443 harus terbuka (A9).

### A9. Firewall

Dengan Cloudflare Tunnel cukup SSH:

```bash
sudo ufw allow OpenSSH && sudo ufw enable
```

Dengan Caddy tambahkan web:

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

Port 4028 (aplikasi) dan 5432 (PostgreSQL) **tidak** dibuka.

### A10. Cek semuanya

```bash
sudo psctl status
```
```bash
sudo psctl doctor
```

`status`: layanan, versi, database, backup, disk. `doctor`: izin file, kunci,
TLS, umur backup, alamat panel admin. Target: semua `ok`. Baris `warn` dibaca
dan ditindaklanjuti.

### A11. Login pertama dan perusahaan pertama

1. Buka `https://erp.domainkamu.com`, login dengan password sementara.
2. **ERP → Settings → Ubah kata sandi**: ganti password.
3. **ERP → Settings → Two-factor**: nyalakan (pakai Google Authenticator,
   Microsoft Authenticator, 1Password, dll). Wajib untuk panel admin.
4. Buka panel admin di `https://erp.domainkamu.com/<alamat-rahasia>`.
5. **Workspaces → New company**: buat perusahaan customer beserta akun
   owner-nya. Owner customer hanya bisa menambahkan akun yang sudah ada ke
   perusahaannya; akun baru selalu dibuat oleh admin ETNA.

### A12. pgAdmin untuk melihat database server (opsional)

pgAdmin dipasang di **PC kamu**, bukan di server. Koneksinya lewat **SSH
tunnel**, jadi port 5432 tetap tertutup.

1. Pasang pgAdmin 4 dari [pgadmin.org](https://www.pgadmin.org/download/).
2. Lihat port PostgreSQL di server:
   ```bash
   pg_lsclusters
   ```
3. Lihat password `etna_owner` **di terminal server sendiri** (bagian
   terakhir baris, setelah `:etna_owner:`):
   ```bash
   sudo cat /etc/etna/owner.pgpass
   ```
4. Di pgAdmin: **Register → Server**.
   - **General**: Name `PrintStream (server)`.
   - **Connection**: Host `localhost`, Port dari langkah 2, Maintenance
     database `etna`, Username `etna_owner`, Password dari langkah 3.
   - **SSH Tunnel**: Use SSH tunneling **Yes**, Tunnel host = IP server,
     Port `22`, Username = user SSH-mu, Authentication = password atau key.
5. **Save**.

> `etna_owner` adalah pemilik seluruh database. Pakai untuk **melihat** data
> dan memeriksa masalah. Jangan mengubah data langsung dari pgAdmin: perubahan
> itu melewati aturan aplikasi dan tidak tercatat di audit log. Perubahan
> struktur selalu lewat migrasi (`psctl migrate`).

### A13. Latihan restore (lakukan sekali, sebelum ada data customer)

Membuktikan backup benar-benar bisa memulihkan semuanya.

1. Isi data contoh: perusahaan, customer, invoice, upload dokumen.
2. Backup:
   ```bash
   sudo psctl backup
   ```
3. Siapkan VM kedua: ulangi A2–A5 di sana.
4. Salin file backup terbaru (`/var/backups/etna/etna-offsite-<waktu>.etnabak`)
   ke VM kedua, misalnya dengan `scp`.
5. Di VM kedua:
   ```bash
   sudo psctl restore /root/etna-offsite-<waktu>.etnabak
   ```
   Masukkan passphrase, baca ringkasannya, ketik `switch`.
6. Login di VM kedua: semua data contoh, akun, dan dokumen harus ada.

Restore selalu mengisi **database baru**; yang lama tidak pernah dihapus.

---

## B. PC Windows (development)

Untuk mencoba dan mengembangkan. Untuk dipakai kantor, pakai bagian A.

### B1. Pasang program

| Program | Dari | Catatan |
|---|---|---|
| **Node.js 24 LTS** | [nodejs.org](https://nodejs.org) | Centang "Add to PATH" |
| **Git** | [git-scm.com](https://git-scm.com) | Pilihan bawaan sudah benar |
| **PostgreSQL 18** | [postgresql.org/download/windows](https://www.postgresql.org/download/windows/) (installer EDB) | Centang **pgAdmin 4**. Catat **password `postgres`** dan **port** (bawaan 5432) |

Cek di Command Prompt baru:

```bat
node -v
```
```bat
git --version
```

### B2. Buat database dengan pgAdmin

1. Buka **pgAdmin 4** → klik **Servers → PostgreSQL 18** → masukkan password
   `postgres`.
2. Klik kanan **PostgreSQL 18 → Query Tool**.
3. Jalankan **satu baris per satu kali** (blok satu baris, lalu Execute / F5):

```sql
CREATE ROLE etna_owner LOGIN CREATEROLE PASSWORD 'ganti-dengan-password-kuat';
```
```sql
CREATE DATABASE etna OWNER etna_owner;
```

Catat password `etna_owner`: dibutuhkan di B4.

### B3. Ambil kode dan pasang dependency

Simpan di folder biasa, **bukan** di OneDrive (sinkronisasi OneDrive merusak
`node_modules`):

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

`npm ci` memasang versi **persis** seperti di `package-lock.json`. Pakai
`npm install <paket>` hanya kalau memang menambah paket baru.

### B4. Siapkan PrintStream (sekali saja)

```bat
node scripts\setup-local.mjs
```

Ditanya:

1. **Koneksi owner**: Enter kalau port 5432, atau ketik misalnya
   `postgres://etna_owner@localhost:5433/etna` kalau port-nya lain.
2. **Password `etna_owner`** (tidak tampil saat diketik).

Ini menjalankan migrasi, membuat role aplikasi, menulis **`.env.local`**
(berisi kunci rahasia), dan menyimpan koneksi owner supaya perintah berikutnya
tidak perlu password lagi.

> Simpan salinan `.env.local` di password manager. Isinya kunci two-factor.

### B5. Akun admin

```bat
node scripts\admin\users.mjs create-user --email kamu@domain.com --name "Nama Kamu"
```

Password sementara tampil sekali. Jadikan admin platform:

```bat
node scripts\admin\users.mjs grant-admin --email kamu@domain.com
```

Panel admin di PC development: `http://localhost:4028/admin` (selama
`ETNA_ADMIN_PATH` tidak diisi di `.env.local`).

### B6. Jalankan

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

Buka **http://localhost:4028/erp/login**.

Untuk fitur Terminal (import, pipeline, jadwal), buka **Command Prompt
kedua**:

```bat
cd /d C:\PrintStream
```
```bat
npm run worker
```

### B7. Sebelum push perubahan

| Perintah | Isinya |
|---|---|
| `npm run i18n:tables` | Setelah mengubah teks di `src/lib/i18n/messages` |
| `npm run check` | Type-check, semua tes, scan i18n, format |
| `npm run lint` | ESLint |
| `npm run verify` | Semua di atas + build produksi + audit paket (sebelum rilis) |

### B8. Backup di Windows dan pindah PC

Satu file `.etnabak` terenkripsi berisi database, folder `storage` (dokumen,
upload), dan `.env.local` (kunci two-factor):

```bat
npm run pc:backup
```

Pertama kali ditanya folder backup (pakai disk lain: flashdisk, NAS) dan
passphrase (simpan di password manager). Cek file-nya:

```bat
npm run pc:verify -- E:\ETNA-backup\etna-offsite-<waktu>.etnabak
```

Di PC baru, setelah B1–B3 dan B2 (owner + database **kosong**, tanpa B4/B5):

```bat
npm run pc:restore -- E:\etna-offsite-<waktu>.etnabak
```

Akun, two-factor, perusahaan, data, dan dokumen ikut semua. Restore hanya
mengisi database kosong dan menyimpan `.env.local` / dokumen lama ke samping
dulu. Langkah lengkapnya: [PANDUAN.md bagian 4.7 dan 4.8](PANDUAN.md#47-backup-di-windows-wajib-kalau-ada-data-asli).
File yang sama bisa dipulihkan di Ubuntu dengan `sudo psctl restore`.

---

## C. Beberapa server (cluster multi-node)

Kalau satu server sudah berat, tambah **server aplikasi**. Semua server
aplikasi memakai **satu database** dan **satu folder data**, dan Cloudflare
Tunnel membagi pengunjung ke semuanya. Kalau satu server mati, pengunjung
dilayani server lain.

```
                 Cloudflare Tunnel (satu tunnel, satu connector per server)
                ┌───────────────┬───────────────┐
                ▼               ▼               ▼
           app1 (utama)       app2            app3       ← aplikasi + worker
                │  ▲            │               │
                │  └──── NFS ───┴───────────────┘          folder data /var/lib/etna milik app1
                ▼
           db1 (PostgreSQL, TLS)
```

Contoh alamat di bagian ini (ganti dengan milikmu):

| Server | IP | Peran |
|---|---|---|
| `db1` | `10.0.0.20` | PostgreSQL saja |
| `app1` | `10.0.0.10` | Server aplikasi pertama (sudah terpasang lewat bagian A), pemegang folder data dan backup |
| `app2` | `10.0.0.11` | Server aplikasi tambahan |

Syarat:

- Semua server di **jaringan lokal yang sama** (`10.0.0.0/24`). NFS tidak
  dienkripsi: jangan pernah lewat internet.
- Semua server aplikasi menjalankan **versi kode yang sama** (`git clone` +
  commit yang sama).
- `app1` sudah jalan lengkap (bagian A), termasuk Cloudflare Tunnel dari
  dashboard (token).

### C1. Siapkan server database (`db1`)

Di `db1`: lakukan A2 (update, Git/curl, zona waktu), lalu pasang PostgreSQL:

```bash
sudo apt install -y postgresql
```

Buat role dan database (dua perintah terpisah):

```bash
sudo -u postgres psql -c "CREATE ROLE etna_owner LOGIN CREATEROLE CREATEDB PASSWORD 'ganti-dengan-password-kuat'"
```
```bash
sudo -u postgres psql -c "CREATE DATABASE etna OWNER etna_owner"
```

`etna_owner` bukan superuser. `CREATEDB` dipakai `psctl restore` untuk
membuat database baru di samping yang lama.

#### Sertifikat TLS

Koneksi database lewat jaringan **wajib** terenkripsi dan diperiksa
(`sslmode=verify-full`); installer dan psctl menolak tanpa itu. Lihat versi
PostgreSQL-mu (`pg_lsclusters`, kolom pertama), lalu buat sertifikat untuk IP
`db1` (contoh untuk versi 18):

```bash
sudo openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj "/CN=etna-db" -addext "subjectAltName=IP:10.0.0.20" -keyout /etc/postgresql/18/main/etna-server.key -out /etc/postgresql/18/main/etna-server.crt
```
```bash
sudo chown postgres:postgres /etc/postgresql/18/main/etna-server.key /etc/postgresql/18/main/etna-server.crt
```
```bash
sudo chmod 600 /etc/postgresql/18/main/etna-server.key
```

Sertifikat berlaku 10 tahun, hanya untuk IP itu. Kalau IP `db1` berubah, buat
ulang.

#### Konfigurasi PostgreSQL

```bash
sudo -u postgres psql -c "ALTER SYSTEM SET listen_addresses = 'localhost,10.0.0.20'"
```
```bash
sudo -u postgres psql -c "ALTER SYSTEM SET ssl = on"
```
```bash
sudo -u postgres psql -c "ALTER SYSTEM SET ssl_cert_file = '/etc/postgresql/18/main/etna-server.crt'"
```
```bash
sudo -u postgres psql -c "ALTER SYSTEM SET ssl_key_file = '/etc/postgresql/18/main/etna-server.key'"
```

Izinkan **hanya** server aplikasi, **hanya** terenkripsi:

```bash
sudo nano /etc/postgresql/18/main/pg_hba.conf
```

Tambahkan di **akhir** file (satu baris per server aplikasi):

```
# ETNA: hanya dari server aplikasi, hanya TLS
hostssl  all  etna_owner,etna_app,etna_auth,etna_worker  10.0.0.10/32  scram-sha-256
hostssl  all  etna_owner,etna_app,etna_auth,etna_worker  10.0.0.11/32  scram-sha-256
```

Jangan menambah baris `0.0.0.0/0`. Lalu:

```bash
sudo systemctl restart postgresql
```

#### Firewall `db1`

```bash
sudo ufw allow OpenSSH
```
```bash
sudo ufw allow from 10.0.0.0/24 to any port 5432 proto tcp
```
```bash
sudo ufw enable
```

### C2. Salin sertifikat ke setiap server aplikasi

`etna-server.crt` **bukan** rahasia (kuncinya, `.key`, tetap hanya di `db1`).
Di **setiap** server aplikasi (`app1`, `app2`, …):

```bash
sudo scp namauser@10.0.0.20:/etc/postgresql/18/main/etna-server.crt /etc/etna/db-ca.crt
```
```bash
sudo chmod 644 /etc/etna/db-ca.crt
```

(Kalau `scp` ditolak karena izin file, salin dulu ke folder home di `db1`
dengan `sudo cp`, lalu ambil dari sana.)

Alamat koneksi owner yang dipakai di langkah berikutnya:

```
postgres://etna_owner@10.0.0.20:5432/etna?sslmode=verify-full&sslrootcert=/etc/etna/db-ca.crt
```

### C3. Pindahkan database `app1` ke `db1`

Di `app1`:

```bash
sudo psctl db move "postgres://etna_owner@10.0.0.20:5432/etna?sslmode=verify-full&sslrootcert=/etc/etna/db-ca.crt"
```

Ditanya password `etna_owner` di `db1`. Aplikasi berhenti sebentar, database
disalin, role aplikasi di `db1` mendapat password baru, `etna.env` diarahkan
ke `db1`, aplikasi dinyalakan dan diperiksa. Gagal → kembali ke database lama
sendiri. Database lama di `app1` tidak dihapus.

Cek:

```bash
sudo psctl status
```

### C4. Bagikan folder data dari `app1`

Di `app1`:

```bash
sudo psctl cluster share --allow 10.0.0.0/24
```

Ini memasang server NFS, membagikan `/var/lib/etna` hanya ke jaringan itu
(`root_squash`), membuka port 2049 di ufw, lalu menampilkan perintah untuk
server baru.

### C5. Pasang server aplikasi baru (`app2`)

Di `app2`: lakukan A2, A3, A4 (**commit yang sama** dengan `app1`), dan C2.

Salin pengaturan dari `app1` (berisi kunci rahasia: hanya lewat `scp` sebagai
root, jangan lewat chat atau e-mail):

```bash
sudo scp root@10.0.0.10:/etc/etna/etna.env /root/etna.env
```

Pasang, di folder `etna-src`:

```bash
sudo deploy/linux/install.sh --database-url "postgres://etna_owner@10.0.0.20:5432/etna?sslmode=verify-full&sslrootcert=/etc/etna/db-ca.crt" --settings-from /root/etna.env --shared-data 10.0.0.10:/var/lib/etna
```

Hapus salinan pengaturan:

```bash
sudo rm /root/etna.env
```

Installer akan me-mount folder data `app1` (lewat `/etc/fstab`), membuat user
`etna` dengan uid/gid yang sama dengan `app1`, memakai kunci yang sama
(sesi dan two-factor berlaku di semua server), dan build dengan build id yang
sama. Layanan tidak mau jalan kalau folder data belum ter-mount.

Kalau memakai panel admin di alamat rahasia (`ETNA_ADMIN_PATH`), nilainya ikut
terbawa di `etna.env` yang disalin.

### C6. Cloudflare Tunnel di setiap server

Di **setiap** server aplikasi (termasuk `app1`), pasang `cloudflared` seperti
A8 dan pakai **token tunnel yang sama**:

```bash
sudo cloudflared service install <token-tunnel>
```

Lalu:

```bash
sudo psctl cluster tunnel
```

Ini membuat `cloudflared` berhenti saat aplikasi di server itu berhenti, jadi
Cloudflare hanya mengirim pengunjung ke server yang hidup. Public hostname
tetap `localhost:4028`: setiap connector meneruskan ke aplikasi di servernya
sendiri.

### C7. Cek cluster

```bash
sudo psctl cluster status
```

```
● app1                     1.0.1+3f2a9c1d07b4e6aa       0 job(s) running
● app2                     1.0.1+3f2a9c1d07b4e6aa       1 job(s) running
This server keeps the data folder itself.
```

Semua server harus versi dan build id yang sama. Di `app2` jalankan juga
`sudo psctl doctor` (memeriksa folder data ter-mount).

### C8. Pembagian tugas di cluster

| Bagian | Di mana |
|---|---|
| Backup, restore, `db move` | **Hanya `app1`** (ditolak di server lain) |
| Job Terminal (import, pipeline, jadwal) | Worker di setiap server; satu job hanya diambil satu worker |
| Migrasi database | Server mana pun yang di-update; dikunci, satu per satu |
| `etna.env` | **Sama persis** di semua server |

Batasan: kalau `app1` mati, server lain tetap jalan tetapi tidak bisa
membaca/menyimpan dokumen dan file perusahaan. Database tetap satu: kalau
database yang penuh, besarkan VM `db1`.

### C9. Melepas server

Di server itu:

```bash
sudo psctl stop
```
```bash
sudo systemctl disable --now cloudflared
```

Lalu hapus baris `/var/lib/etna` di `/etc/fstab`, dan hapus IP-nya dari
`pg_hba.conf` di `db1` (`sudo systemctl reload postgresql`). Di
`psctl cluster status` server itu tampil mati lalu hilang setelah 7 hari.

Detail teknis cluster: [teknis/CLUSTER.md](teknis/CLUSTER.md).

---

## D. Update ke versi baru

### D1. Ubuntu, satu server

```bash
cd ~/etna-src
```
```bash
git pull
```
```bash
sudo deploy/linux/install.sh --yes
```

Urutannya: backup → `npm ci` + build di folder rilis baru → migrasi →
pindah ke versi baru → dicek. Kalau versi baru tidak menjawab, **versi lama
dipasang lagi otomatis**. Kembali manual:

```bash
sudo psctl rollback
```

Tanpa internet (file rilis dari USB):

```bash
sudo psctl upgrade etna-<versi>.tar.gz
```

Membuat file rilis dari PC yang punya kode terbaru:

```bash
git archive --prefix=etna-1.0.1/ -o etna-1.0.1.tar.gz HEAD
```

### D2. Cluster

1. Update **`app1` dulu** (D1): backup dibuat, migrasi dijalankan.
2. Lalu server lain **satu per satu**, dari **commit yang sama**
   (`git pull` + `sudo deploy/linux/install.sh --yes`).
3. Cek `sudo psctl cluster status`: semua versi dan build id sama.

Server yang sedang di-restart tidak menerima pengunjung (berkat
`psctl cluster tunnel`).

### D3. Windows (development)

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

Lalu jalankan lagi `npm start` dan `npm run worker` (atau `npm run dev`).

---

## E. Kalau ada masalah

Selalu mulai dari:

- Ubuntu: `sudo psctl doctor`, lalu `sudo psctl logs -n 100`
- Windows: pesan error di jendela yang menjalankan `npm run dev` / `npm start`

| Gejala | Penyebab dan solusi |
|---|---|
| `The repository '…postgresql.org resolute Release' does not have a Release file` | Ubuntu 26.04 belum didukung apt.postgresql.org. Cari file repo-nya: `grep -rl "postgresql.org" /etc/apt/sources.list.d/`, hapus file itu (`sudo rm …`), lalu `sudo apt update && sudo apt install -y postgresql` dan jalankan installer lagi (pilih `1`) |
| `node: command not found` saat installer jalan | Node dipasang lewat `nvm`. Pasang dari NodeSource (A3) |
| Tidak bisa login padahal password benar | Dibuka lewat `http://` dari PC lain: login butuh HTTPS (A8). Atau akun terkunci: `sudo psctl users unlock --email …` |
| Panel admin 404 | Alamatnya sudah dirahasiakan: `sudo psctl admin-path`. Akun juga harus admin platform dan two-factor aktif |
| `password authentication failed for user "etna_owner"` | Password owner salah, atau `pg_hba.conf` di `db1` belum mengizinkan IP server ini |
| `is another machine: add ?sslmode=verify-full` | Koneksi ke database di server lain wajib `sslmode=verify-full&sslrootcert=/etc/etna/db-ca.crt` (C2) |
| `certificate verify failed` / `Hostname/IP does not match` | Sertifikat `db1` dibuat untuk IP lain, atau `db-ca.crt` bukan salinan `etna-server.crt` terbaru. Buat ulang (C1) dan salin lagi (C2) |
| `the database already holds ETNA` | Database berisi data tapi server ini belum punya `etna.env`. Pakai `--settings-from <etna.env lama>`, atau database kosong + `psctl restore` |
| `/api/health` → `"database":"unreachable"` | PostgreSQL mati atau koneksi salah. Nyalakan PostgreSQL, lalu `sudo psctl restart` |
| Fitur Terminal (import/pipeline) diam | Worker tidak jalan. Ubuntu: `sudo psctl status`. Windows: `npm run worker` |
| `psctl cluster status` versi berbeda | Update semua server ke commit yang sama (D2) |
| Layanan tidak mau start di `app2` | Folder data belum ter-mount: `sudo mount /var/lib/etna`, cek NFS di `app1` (`sudo psctl cluster share` sudah dijalankan?) |
| `ConfigError: DATABASE_URL is not set` (Windows) | Belum ada `.env.local`: `node scripts\setup-local.mjs` |
| Halaman error setelah update (Windows) | Lupa `npm run db:migrate` |
| Backup gagal | `sudo psctl doctor` dan `journalctl -u etna-backup -n 50`; biasanya NAS tidak ter-mount atau disk penuh |

Dokumen terkait:

| File | Isinya |
|---|---|
| [PANDUAN.md](PANDUAN.md) | Ringkasan pemakaian, perintah sehari-hari, backup & restore |
| [teknis/INSTALL-LINUX.md](teknis/INSTALL-LINUX.md) | Instalasi Linux detail, Docker Compose |
| [teknis/CLUSTER.md](teknis/CLUSTER.md) | Cluster multi-node |
| [teknis/ADMIN.md](teknis/ADMIN.md) | Panel admin, alamat rahasia |
| [teknis/CONFIGURATION.md](teknis/CONFIGURATION.md) | Semua pengaturan `etna.env` / `.env.local` |
| [teknis/DEVELOPMENT.md](teknis/DEVELOPMENT.md) | Development, tes, struktur kode |
