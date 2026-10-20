# Memasang ETNA di server baru (Windows)

Panduan ini memasang ETNA dari nol di **dua server Windows** yang menyala
terus: satu **server aplikasi** dan satu **server database**. Produksi dibuka
ke internet lewat **Cloudflare Tunnel**; staging lewat **Caddy** di alamat IP
publik. Anggapan awal: servernya baru dan belum ada yang dipasang.

Bentuk akhirnya:

```
Karyawan ──HTTPS──▶ Cloudflare ──tunnel──▶ cloudflared ──▶ ETNA produksi 127.0.0.1:4028 ─┐
Tim uji  ──HTTPS──▶ Caddy :443 (staging.domainmu.com) ───▶ ETNA staging  127.0.0.1:4029 ─┤
                              SERVER APLIKASI (10.0.0.10)                                 │ jaringan privat,
                                                                                          │ terenkripsi (TLS)
                              SERVER DATABASE (10.0.0.20)                                 ▼
                    PostgreSQL 18 produksi :5432 (database etna)
                    PostgreSQL 18 staging  :5433 (database etna_staging), service terpisah
```

- ETNA hanya mendengarkan di `127.0.0.1`. Port 4028/4029 **tidak pernah**
  dibuka ke jaringan.
- Produksi tidak membuka port apa pun: `cloudflared` yang menghubungi
  Cloudflare dari dalam.
- Staging membuka port 80 dan 443 untuk Caddy (sertifikat HTTPS otomatis).
- PostgreSQL hanya menerima koneksi dari server aplikasi, lewat TLS.
- Staging memakai **service PostgreSQL sendiri** (port 5433), bukan database
  kedua di service produksi. Nama role ETNA (`etna_app`, `etna_auth`) berlaku
  untuk satu service PostgreSQL. Kalau staging menumpang di service produksi,
  setup staging akan mengganti password produksi dan produksi berhenti.

Perintah ditulis untuk **cmd** (Command Prompt). Ganti contoh berikut dengan
milikmu:

| Contoh di panduan | Ganti dengan |
|---|---|
| `10.0.0.10` | IP privat server aplikasi |
| `10.0.0.20` | IP privat server database |
| `C:\ETNA`, `C:\ETNA-staging` | folder ETNA produksi dan staging |
| `erp.domainmu.com` | alamat produksi untuk karyawan |
| `staging.domainmu.com` | alamat staging |
| `https://github.com/AKUN/REPO.git` | repo GitHub privat ETNA |
| `admin@perusahaan.com` | email admin (kamu) |

Simpan semua password dan isi `.env.local` di **password manager**. Jangan
pernah menempelnya di chat, screenshot, atau dokumen bersama.

---

## 0. Yang dibutuhkan

- **Server aplikasi**: Windows Server 2019+ (atau Windows 10/11 Pro), minimal
  4 core, 8 GB RAM, SSD.
- **Server database**: Windows Server 2019+, minimal 4 core, 8 GB RAM, SSD.
  Disk tambahan untuk backup kalau ada (contoh di panduan: `D:`).
- Kedua server di jaringan privat yang sama (LAN atau VPN) dan bisa saling
  `ping`.
- Akun Cloudflare (gratis) dan domain (misalnya dari Hostinger).
- Akses baca ke repo GitHub privat ETNA.
- Untuk staging: alamat IP publik yang mengarah ke server aplikasi (port 80
  dan 443 diteruskan di router, kalau server ada di belakang NAT).

Di **kedua** server, matikan sleep: **Settings → System → Power → Screen and
sleep → When plugged in, put my device to sleep: Never**.

---

## 1. Pindahkan pengelolaan DNS domain ke Cloudflare

1. Login ke <https://dash.cloudflare.com> → **Add a domain** → masukkan
   `domainmu.com` → pilih plan **Free**.
2. Cloudflare menampilkan **dua nameserver** (misalnya `xxx.ns.cloudflare.com`).
3. Di panel domain (Hostinger: **Domains → domainmu.com → DNS / Nameservers →
   Change nameservers**), pilih "Use custom nameservers" lalu isi dua
   nameserver dari Cloudflare.
4. Tunggu sampai Cloudflare menandai domainnya **Active**: beberapa menit
   sampai 24 jam.

Kalau domain ini juga dipakai untuk email atau website, pastikan record DNS
lamanya (MX, A, dan lain-lain) ikut tersalin ke Cloudflare sebelum nameserver
diganti. Cek di **DNS → Records**.

---

## 2. Server database: PostgreSQL produksi

### 2a. Pasang PostgreSQL 18

Unduh installer EDB dari <https://www.postgresql.org/download/windows/>.

- Komponen: **PostgreSQL Server**, **pgAdmin 4**, **Command Line Tools**.
  Stack Builder tidak perlu.
- Port: biarkan **5432**.
- Password user `postgres`: buat yang kuat, simpan di password manager.

### 2b. Sertifikat TLS

Koneksi dari server aplikasi ke database lewat jaringan, jadi harus
dienkripsi. Sertifikat dibuat sekali, di komputer mana saja yang punya **Git
for Windows** (misalnya laptop admin, atau server aplikasi setelah langkah 5).
Isi `IP:` dengan IP privat server database:

```bat
mkdir C:\etna-cert
```
```bat
cd /d C:\etna-cert
```
```bat
"C:\Program Files\Git\usr\bin\openssl.exe" req -x509 -newkey rsa:3072 -nodes -days 3650 -subj "/CN=etna-db" -addext "subjectAltName=IP:10.0.0.20" -keyout server.key -out server.crt
```

Hasilnya dua file:

| File | Ke mana | Rahasia? |
|---|---|---|
| `server.key` | **hanya** folder data PostgreSQL di server database | **Ya.** Jangan disalin ke tempat lain. |
| `server.crt` | folder data PostgreSQL, **dan** server aplikasi sebagai `C:\ETNA-certs\db-ca.crt` | Tidak |

Salin keduanya ke `C:\Program Files\PostgreSQL\18\data\` di server database.
Hapus `C:\etna-cert` setelah selesai (simpan `server.crt` dulu untuk langkah 5).

Sertifikat berlaku 10 tahun dan hanya untuk IP itu. Kalau IP server database
berubah, buat ulang.

### 2c. Konfigurasi PostgreSQL

Buka `C:\Program Files\PostgreSQL\18\data\postgresql.conf` dengan Notepad
(**Run as administrator**). Cari dan ubah baris berikut (hapus `#` di depannya
kalau ada):

```
listen_addresses = 'localhost,10.0.0.20'
ssl = on
```

Buka `C:\Program Files\PostgreSQL\18\data\pg_hba.conf`, tambahkan di **akhir**
file:

```
# ETNA: hanya dari server aplikasi, hanya terenkripsi
hostssl  etna  etna_app,etna_auth,etna_owner  10.0.0.10/32  scram-sha-256
```

Jangan menambah baris dengan `0.0.0.0/0` atau `all`. Baris bawaan untuk
`127.0.0.1` dan `::1` biarkan.

Restart service (cmd **sebagai administrator**):

```bat
net stop postgresql-x64-18
```
```bat
net start postgresql-x64-18
```

### 2d. Firewall server database

Izinkan port PostgreSQL **hanya** dari server aplikasi (cmd administrator):

```bat
netsh advfirewall firewall add rule name="ETNA PostgreSQL (server aplikasi saja)" dir=in action=allow protocol=TCP localport=5432,5433 remoteip=10.0.0.10 profile=any
```

Lalu cek apakah installer membuat aturan PostgreSQL lain yang terbuka untuk
semua alamat:

```bat
netsh advfirewall firewall show rule name=all | findstr /i "postgre"
```

Kalau ada aturan selain yang baru dibuat, buka **Windows Defender Firewall →
Advanced settings → Inbound Rules**, klik kanan aturan itu → **Disable Rule**.

### 2e. Pemilik database produksi

Buka **SQL Shell (psql)** dari Start menu, login sebagai `postgres` (server
`localhost`, port `5432`). Jalankan satu per satu:

```sql
CREATE ROLE etna_owner LOGIN CREATEROLE PASSWORD 'ganti-dengan-password-kuat';
```
```sql
CREATE DATABASE etna OWNER etna_owner;
```

Simpan password `etna_owner` produksi di password manager. Password ini
**tidak pernah disimpan** di server aplikasi; ia hanya diketik saat
menjalankan migrasi.

---

## 3. Server database: PostgreSQL staging (service kedua, port 5433)

Semua perintah di cmd **sebagai administrator**.

1. Buat folder data staging dan isi awalnya. Perintah ini menanyakan password
   baru untuk user `postgres` staging (buat yang berbeda dari produksi):
   ```bat
   "C:\Program Files\PostgreSQL\18\bin\initdb.exe" -D "C:\Program Files\PostgreSQL\18\data-staging" -U postgres -W -E UTF8 -A scram-sha-256
   ```
2. Beri akses ke akun service PostgreSQL:
   ```bat
   icacls "C:\Program Files\PostgreSQL\18\data-staging" /grant "NT AUTHORITY\NetworkService:(OI)(CI)F"
   ```
3. Salin `server.crt` dan `server.key` (dari langkah 2b) ke
   `C:\Program Files\PostgreSQL\18\data-staging\`.
4. Di `data-staging\postgresql.conf`, ubah:
   ```
   port = 5433
   listen_addresses = 'localhost,10.0.0.20'
   ssl = on
   ```
5. Di akhir `data-staging\pg_hba.conf`, tambahkan:
   ```
   hostssl  etna_staging  etna_app,etna_auth,etna_owner  10.0.0.10/32  scram-sha-256
   ```
6. Daftarkan dan nyalakan service-nya:
   ```bat
   "C:\Program Files\PostgreSQL\18\bin\pg_ctl.exe" register -N postgresql-x64-18-staging -D "C:\Program Files\PostgreSQL\18\data-staging" -S auto -U "NT AUTHORITY\NetworkService"
   ```
   ```bat
   net start postgresql-x64-18-staging
   ```
7. Login dengan `psql -h localhost -p 5433 -U postgres`, lalu:
   ```sql
   CREATE ROLE etna_owner LOGIN CREATEROLE PASSWORD 'password-lain-dari-produksi';
   ```
   ```sql
   CREATE DATABASE etna_staging OWNER etna_owner;
   ```

Langkah ini belum pernah dijalankan di server kamu. Kalau `net start` gagal,
lihat **Event Viewer → Windows Logs → Application** (sumber `PostgreSQL`):
penyebab tersering adalah izin folder (langkah 2) atau port 5433 sudah dipakai.

---

## 4. Server database: backup otomatis

Backup dijalankan **di server database**, sehingga server aplikasi yang
terhubung ke internet tidak pernah menyimpan password pemilik database.

1. Buat file password PostgreSQL untuk akun Windows yang menjalankan backup.
   Buka Notepad, isi (pakai password masing-masing):
   ```
   localhost:5432:etna:etna_owner:PASSWORD-OWNER-PRODUKSI
   localhost:5433:etna_staging:etna_owner:PASSWORD-OWNER-STAGING
   ```
   Simpan sebagai `%APPDATA%\postgresql\pgpass.conf` (buat folder
   `postgresql` kalau belum ada). Kunci file itu untuk akunmu saja:
   ```bat
   icacls "%APPDATA%\postgresql\pgpass.conf" /inheritance:r /grant:r "%USERNAME%:F"
   ```
2. Salin `scripts\server\etna-db-backup.cmd` dari repo ETNA ke
   `C:\etna-tools\etna-db-backup.cmd` di server database.
3. Coba sekali:
   ```bat
   C:\etna-tools\etna-db-backup.cmd etna 5432 D:\etna-backup\produksi
   ```
   Harus muncul file `D:\etna-backup\produksi\etna-<tanggal>.dump` dan baris
   `ok` di `backup.log` di folder yang sama.
4. Jadwalkan setiap hari. `/RP *` menanyakan password akun Windows-mu, supaya
   backup tetap jalan walau tidak ada yang login:
   ```bat
   schtasks /Create /TN "ETNA Backup Produksi" /TR "C:\etna-tools\etna-db-backup.cmd etna 5432 D:\etna-backup\produksi" /SC DAILY /ST 02:00 /RU %USERNAME% /RP *
   ```
   ```bat
   schtasks /Create /TN "ETNA Backup Staging" /TR "C:\etna-tools\etna-db-backup.cmd etna_staging 5433 D:\etna-backup\staging" /SC WEEKLY /D SUN /ST 03:00 /RU %USERNAME% /RP *
   ```
5. Kunci folder backup. Isinya seluruh database:
   ```bat
   icacls D:\etna-backup /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
   ```

Script menyimpan 14 backup harian dan backup tanggal 1 setiap bulan selama
setahun (`monthly\`). Salin `D:\etna-backup` ke tempat lain secara rutin
(disk eksternal atau cloud privat yang terenkripsi). Backup yang hanya ada di
server database ikut hilang kalau servernya rusak.

**Coba restore** setiap 3 bulan, ke database percobaan di service staging:

```bat
"C:\Program Files\PostgreSQL\18\bin\createdb.exe" -h localhost -p 5433 -U postgres -O etna_owner etna_restore_test
```
```bat
"C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" -h localhost -p 5433 -U postgres -d etna_restore_test --no-owner --role=etna_owner D:\etna-backup\produksi\etna-TANGGAL.dump
```
```bat
"C:\Program Files\PostgreSQL\18\bin\dropdb.exe" -h localhost -p 5433 -U postgres etna_restore_test
```

`pg_restore` tidak boleh menampilkan error. Hapus database percobaan setelah
dicek (perintah terakhir).

---

## 5. Server aplikasi: pasang program

Unduh dan pasang dari situs resminya:

1. **Node.js 24 LTS**: <https://nodejs.org> (centang "Add to PATH").
2. **Git for Windows**: <https://git-scm.com/download/win>.
3. **PostgreSQL 18, hanya Command Line Tools** (installer EDB yang sama;
   hilangkan centang Server, pgAdmin, dan Stack Builder). Ini memberi `psql`
   untuk pemeriksaan dan rollback. Jangan pasang server PostgreSQL di sini.

Buka cmd baru, lalu cek:

```bat
node -v
```
```bat
git --version
```

Salin `server.crt` dari langkah 2b ke server aplikasi sebagai
`C:\ETNA-certs\db-ca.crt`. Cek koneksi ke database produksi (password
`etna_owner` produksi diketik saat diminta):

```bat
psql "postgres://etna_owner@10.0.0.20:5432/etna?sslmode=verify-full&sslrootcert=C:/ETNA-certs/db-ca.crt" -c "select 1"
```

Harus menampilkan `1`. Kalau muncul error sertifikat, IP di sertifikat tidak
sama dengan IP di alamat (`10.0.0.20`).

---

## 6. Server aplikasi: ambil kode ETNA

```bat
git clone https://github.com/AKUN/REPO.git C:\ETNA
```
```bat
git clone https://github.com/AKUN/REPO.git C:\ETNA-staging
```

Saat pertama kali, Git membuka jendela login GitHub. Pakai akun yang punya
akses baca ke repo.

Kunci kedua folder untuk akunmu saja. Nanti isinya `.env.local` (kunci
rahasia) dan dokumen yang diunggah:

```bat
icacls C:\ETNA /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
```
```bat
icacls C:\ETNA-staging /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
```

Pasang dependensi di masing-masing folder:

```bat
cd /d C:\ETNA && npm ci
```
```bat
cd /d C:\ETNA-staging && npm ci
```

Jalankan ETNA, backup dokumen, dan update selalu dari akun Windows yang sama.

---

## 7. Server aplikasi: skema database dan `.env.local`

`scripts\setup-local.mjs` menerapkan semua migrasi, membuat password acak
untuk role `etna_app` dan `etna_auth`, dan menulis `.env.local` (koneksi
aplikasi, kunci enkripsi 2FA, secret sesi).

**Penting di cmd:** alamat database berisi `&`. Selalu pakai tanda kutip di
sekeliling seluruh `set "NAMA=nilai"`, seperti di bawah. Tanpa kutip, cmd
memotong perintahnya di `&`.

### 7a. Produksi

```bat
cd /d C:\ETNA
```
```bat
set "MIGRATION_DATABASE_URL=postgres://etna_owner@10.0.0.20:5432/etna?sslmode=verify-full&sslrootcert=C:/ETNA-certs/db-ca.crt"
```
```bat
set PGPASSWORD=password-etna_owner-produksi
```
```bat
node scripts\setup-local.mjs
```

Lalu buka `C:\ETNA\.env.local` dengan Notepad dan tambahkan di akhir:

```
# Produksi hanya dibuka lewat Cloudflare Tunnel
TRUST_PROXY=cloudflare
```

### 7b. Staging

Di **jendela cmd baru** (supaya variabel produksi tidak terbawa):

```bat
cd /d C:\ETNA-staging
```
```bat
set "MIGRATION_DATABASE_URL=postgres://etna_owner@10.0.0.20:5433/etna_staging?sslmode=verify-full&sslrootcert=C:/ETNA-certs/db-ca.crt"
```
```bat
set PGPASSWORD=password-etna_owner-staging
```
```bat
node scripts\setup-local.mjs
```

Tambahkan di akhir `C:\ETNA-staging\.env.local`:

```
# Staging dibuka lewat Caddy (reverse proxy) di server ini
TRUST_PROXY=1
```

### 7c. Simpan dan jangan simpan

- **Salin isi kedua `.env.local` ke password manager.** Tanpa
  `MFA_ENCRYPTION_KEY`, semua pengguna harus mendaftarkan ulang aplikasi
  authenticator-nya.
- **Jangan** menjalankan `npm run db:backup -- setup` di server ini. Perintah
  itu menyimpan password pemilik database di server aplikasi. Backup sudah
  ditangani server database (langkah 4). Akibatnya menu **Settings → Backup**
  dan **Settings → User accounts** di aplikasi tampil "belum dikonfigurasi";
  akun dikelola lewat SQL (langkah 12).
- Tutup jendela cmd setelah selesai supaya `PGPASSWORD` hilang.

---

## 8. Server aplikasi: build dan jalankan sebagai layanan

Untuk masing-masing folder:

```bat
cd /d C:\ETNA && npm run build
```
```bat
cd /d C:\ETNA-staging && npm run build
```

Coba jalankan produksi sekali secara manual:

```bat
C:\ETNA\scripts\server\etna-server.cmd
```

Di cmd kedua:

```bat
curl http://127.0.0.1:4028/api/health
```

Hasilnya harus `"status":"ok"` dan `"database":"ok"`. Tutup cmd pertama
(Ctrl+C, lalu `Y`) untuk berhenti. Untuk staging sama, dengan
`C:\ETNA-staging\scripts\server\etna-server.cmd 4029` dan port `4029`.

Supaya keduanya jalan sendiri setiap server menyala:

```bat
schtasks /Create /TN "ETNA Produksi" /TR "C:\ETNA\scripts\server\etna-server.cmd" /SC ONSTART /RU %USERNAME% /RP *
```
```bat
schtasks /Create /TN "ETNA Staging" /TR "C:\ETNA-staging\scripts\server\etna-server.cmd 4029" /SC ONSTART /RU %USERNAME% /RP *
```

**Wajib:** tugas yang dibuat dengan `schtasks` secara bawaan **dihentikan
setelah 72 jam**. Matikan batas itu untuk kedua tugas: buka **Task
Scheduler**, klik dua kali tugas **ETNA Produksi** → tab **Settings** →
hilangkan centang **Stop the task if it runs longer than** → **OK** (masukkan
password Windows). Ulangi untuk **ETNA Staging**.

Nyalakan sekarang tanpa restart:

```bat
schtasks /Run /TN "ETNA Produksi"
```
```bat
schtasks /Run /TN "ETNA Staging"
```

- Kalau ETNA berhenti sendiri, `etna-server.cmd` menyalakannya lagi setelah 10
  detik.
- Log: `C:\ETNA\storage\logs\server.log` dan
  `C:\ETNA-staging\storage\logs\server.log`.

### Backup dokumen

Dokumen yang diunggah (File → Documents) tersimpan di
`C:\ETNA\storage\documents`, **bukan** di database. Salin setiap hari ke disk
atau lokasi lain:

```bat
schtasks /Create /TN "ETNA Backup Dokumen" /TR "robocopy C:\ETNA\storage\documents D:\etna-backup\documents /E /R:2 /W:5 /NP /LOG+:C:\ETNA\storage\logs\documents-backup.log" /SC DAILY /ST 02:15 /RU %USERNAME% /RP *
```

`D:\etna-backup\documents` di sini adalah disk di server aplikasi. Kalau tidak
ada disk kedua, pakai share jaringan atau disk eksternal, dan ikutkan ke
salinan luar seperti backup database.

### Firewall server aplikasi

- Jangan pernah membuka port **4028** atau **4029**.
- Kalau muncul jendela "Windows Defender Firewall has blocked some features of
  Node.js", pilih **Cancel**.
- Cek **Windows Defender Firewall → Advanced settings → Inbound Rules**. Kalau
  ada aturan **Node.js JavaScript Runtime** yang **Allow**, klik kanan →
  **Disable Rule**.

---

## 9. Produksi: Cloudflare Tunnel

1. Pasang `cloudflared` di server aplikasi (cmd administrator):
   ```bat
   winget install --id Cloudflare.cloudflared
   ```
   Kalau `winget` tidak ada, unduh `cloudflared-windows-amd64.msi` dari
   <https://github.com/cloudflare/cloudflared/releases>.
2. Buka <https://one.dash.cloudflare.com> → **Networks → Tunnels → Create a
   tunnel** → pilih **Cloudflared** → beri nama `etna-produksi`.
3. Pilih **Windows**. Cloudflare menampilkan perintah
   `cloudflared.exe service install <TOKEN>`. Jalankan di cmd
   **administrator**. Token itu rahasia: jangan dibagikan atau di-screenshot.
4. Di **Public Hostname** (atau **Routes → Published application**):
   - Subdomain: `erp`; Domain: `domainmu.com`.
   - Service Type: **HTTP**; URL: **`127.0.0.1:4028`** (tulis `127.0.0.1`,
     bukan `localhost`).
5. Simpan. Buka `https://erp.domainmu.com/erp/login` dari HP dengan data
   seluler; halaman login ETNA harus muncul.

Kalau sebelumnya laptop memakai `cloudflared` untuk domain yang sama, matikan
di laptop (`cloudflared service uninstall`, cmd administrator) dan hapus
tunnel lamanya di **Networks → Tunnels**.

---

## 10. Staging: Caddy

1. Di Cloudflare, **DNS → Records → Add record**: Type **A**, Name `staging`,
   IPv4 = IP publik server aplikasi, Proxy status **DNS only** (awan abu-abu).
2. Kalau server di belakang router, teruskan port **80** dan **443** ke
   `10.0.0.10`.
3. Buka port 80 dan 443 di firewall server aplikasi (cmd administrator):
   ```bat
   netsh advfirewall firewall add rule name="Caddy HTTP/HTTPS (staging)" dir=in action=allow protocol=TCP localport=80,443
   ```
4. Unduh Caddy untuk **Windows amd64** dari <https://caddyserver.com/download>,
   ganti nama file menjadi `caddy.exe`, simpan di `C:\caddy\`.
5. Salin `C:\ETNA-staging\scripts\server\Caddyfile.staging` ke
   `C:\caddy\Caddyfile`. Ganti `staging.example.com` dengan
   `staging.domainmu.com`. Kalau staging hanya untuk kantor, aktifkan juga
   baris `remote_ip` di file itu.
6. Cek isinya, lalu coba jalankan:
   ```bat
   C:\caddy\caddy.exe validate --config C:\caddy\Caddyfile
   ```
   ```bat
   C:\caddy\caddy.exe run --config C:\caddy\Caddyfile
   ```
   Buka `https://staging.domainmu.com/erp/login`. Halaman login ETNA harus
   muncul dengan HTTPS. Hentikan dengan Ctrl+C.
7. Jadikan service Windows (cmd administrator):
   ```bat
   sc.exe create caddy start= auto binPath= "C:\caddy\caddy.exe run --config C:\caddy\Caddyfile"
   ```
   ```bat
   sc.exe start caddy
   ```

Caddy hanya meneruskan `staging.domainmu.com` ke port 4029. Produksi tetap
hanya lewat tunnel.

---

## 11. Pengamanan di Cloudflare (produksi, sangat disarankan)

Pengamanan di ETNA sendiri tidak bisa menahan banjir trafik besar (DDoS).
Untuk itu dipakai Cloudflare. Di **dash.cloudflare.com → domainmu.com**:

- **SSL/TLS → Edge Certificates**: **Always Use HTTPS = On**, **Minimum TLS
  Version = 1.2**.
- **Security → WAF → Rate limiting rules → Create rule**: nama `ETNA login`;
  Field **URI Path** **equals** `/api/auth/login`; **5 requests per 10
  seconds** per IP; Action **Block** selama **10 seconds**.
- **Security → Bots → Bot Fight Mode = On**.
- **Cloudflare Access** (pelindung terkuat: orang luar bahkan tidak melihat
  halaman login): **one.dash.cloudflare.com → Access → Applications → Add an
  application → Self-hosted** → domain `erp.domainmu.com` → Policy **Allow**,
  Include **Emails ending in** `@perusahaan.com` (atau daftar email) → login
  method **One-time PIN**. Plan gratis Zero Trust untuk maksimal 50 pengguna.

---

## 12. Akun pengguna

Tidak ada pendaftaran mandiri; admin yang membuat akun. Karena password
pemilik database tidak disimpan di server aplikasi, akun dikelola dengan
salah satu cara berikut.

**Cara A: pgAdmin di server database** (paling mudah). Query Tool pada
database `etna` (atau `etna_staging` di port 5433), login sebagai `postgres`:

| Keperluan | SQL |
|---|---|
| Daftar akun | `select * from etna_admin.users;` |
| Akun baru (password sementara dibuat otomatis, tampil sekali) | `select * from etna_admin.create_user('ana@perusahaan.com', 'Ana');` |
| Reset password (password sementara baru, semua sesi berakhir) | `select * from etna_admin.set_password('ana@perusahaan.com');` |
| Keluarkan dari semua sesi | `select etna_admin.revoke_sessions('ana@perusahaan.com');` |
| HP hilang, tanpa kode pemulihan | `select etna_admin.reset_mfa('ana@perusahaan.com');` |
| Kunci / buka akun | `select etna_admin.lock_user('ana@perusahaan.com');` / `select etna_admin.unlock_user('ana@perusahaan.com');` |

Biarkan password dibuat otomatis: password yang diketik di query ikut
tersimpan di Query History pgAdmin. **Jangan** menambah user lewat *View/Edit
Data* di tabel `auth.users`; hanya fungsi di atas yang meng-hash password.

**Cara B: dari server aplikasi.** Di cmd, folder `C:\ETNA`:

```bat
set "ADMIN_DATABASE_URL=postgres://etna_owner@10.0.0.20:5432/etna?sslmode=verify-full&sslrootcert=C:/ETNA-certs/db-ca.crt"
```
```bat
set PGPASSWORD=password-etna_owner-produksi
```
```bat
node scripts\admin\users.mjs create-user --email admin@perusahaan.com --name "Nama Kamu"
```

Perintah lain: `list`, `set-password --email …`, `revoke-sessions --email …`,
`reset-mfa --email …`, `lock --email …`, `unlock --email …`. Tutup cmd
setelah selesai.

Password sementara tampil sekali; berikan lewat jalur yang aman. Pengguna
menggantinya di **ERP → Settings → Ubah kata sandi**.

Agar karyawan masuk ke ERP perusahaan:

1. Kamu (owner) membuat **kode akses** di panel **Workspace**.
2. Karyawan login, lalu memasukkan kode itu. Kode hanya menambahkan akun yang
   sudah ada; kode tidak pernah membuat akun.
3. Atur perannya (Admin, Finance, Sales, Inventory; lihat
   [ROLES.md](ROLES.md)) di daftar anggota.

**Wajibkan 2FA** untuk semua anggota: panel Workspace → Keamanan → **Wajibkan
dua langkah untuk semua anggota**.

---

## 13. Pemeriksaan kesehatan dan log

| Apa | Cara |
|---|---|
| Aplikasi + database produksi | `curl http://127.0.0.1:4028/api/health` di server aplikasi: `200` dan `"database":"ok"`. `503` dan `"database":"unreachable"` berarti database tidak terjangkau. |
| Staging | `curl http://127.0.0.1:4029/api/health` |
| Dari luar | `https://erp.domainmu.com/api/health` (dengan Cloudflare Access aktif, halaman ini juga di balik login Access) |
| Log aplikasi | `C:\ETNA\storage\logs\server.log` (cari `[API Error]`, `[auth]`, `[data]`) |
| Log backup database | `D:\etna-backup\produksi\backup.log` di server database (harus ada baris `ok` setiap hari) |
| Log backup dokumen | `C:\ETNA\storage\logs\documents-backup.log` |
| Tunnel | service **Cloudflared** di `services.msc`; status di **Networks → Tunnels** |
| Caddy | service **caddy** di `services.msc` |

Apa yang diawasi rutin dan audit log mana yang dicek mingguan:
[OPERATIONS.md](OPERATIONS.md) bagian 4.

---

## 14. Memperbarui ETNA

Selalu **staging dulu**, baru produksi.

### 14a. Staging

```bat
cd /d C:\ETNA-staging
```
```bat
git rev-parse --short HEAD
```

Catat kode yang tampil: itu versi untuk rollback.

```bat
schtasks /End /TN "ETNA Staging"
```
```bat
git pull
```
```bat
npm ci
```
```bat
set "MIGRATION_DATABASE_URL=postgres://etna_owner@10.0.0.20:5433/etna_staging?sslmode=verify-full&sslrootcert=C:/ETNA-certs/db-ca.crt"
```
```bat
set PGPASSWORD=password-etna_owner-staging
```
```bat
npm run db:migrate
```
```bat
npm run build
```
```bat
schtasks /Run /TN "ETNA Staging"
```

Buka `https://staging.domainmu.com`, coba layar yang berubah.

### 14b. Produksi

1. Di server database, buat backup sekarang:
   ```bat
   schtasks /Run /TN "ETNA Backup Produksi"
   ```
   Tunggu sampai `backup.log` menampilkan baris `ok` baru.
2. Di server aplikasi, ulangi langkah 14a di `C:\ETNA` dengan
   `"ETNA Produksi"`, port `5432`, database `etna`, dan password owner
   produksi. Catat juga `git rev-parse --short HEAD` sebelum `git pull`.
3. Pantau `curl http://127.0.0.1:4028/api/health` dan `server.log` selama 30
   menit.

Kalau `schtasks /End` tidak menghentikan server (health masih menjawab),
hentikan proses yang memakai port itu:

```bat
for /f "tokens=5" %p in ('netstat -ano ^| findstr "127.0.0.1:4028" ^| findstr LISTENING') do taskkill /PID %p /F
```

---

## 15. Rollback

**Aplikasi** (cara normal). Kembalikan kode ke versi yang dicatat:

```bat
cd /d C:\ETNA
```
```bat
schtasks /End /TN "ETNA Produksi"
```
```bat
git checkout KODE-VERSI-LAMA
```
```bat
npm ci && npm run build
```
```bat
schtasks /Run /TN "ETNA Produksi"
```

Migrasi database bersifat aditif, jadi versi aplikasi lama biasanya tetap
berjalan di atas skema yang lebih baru. Setelah masalahnya diperbaiki, kembali
ke versi terbaru dengan `git checkout main`, lalu langkah 14.

**Skema database** (jarang perlu). Hanya kalau skema itu sendiri harus
mundur, **setelah** aplikasi lama berjalan. Baca dulu kepala file rollback;
sebagian menghapus data yang hanya dipakai fitur baru. Untuk setiap migrasi
yang dibatalkan, dari yang terbaru:

```bat
psql "%MIGRATION_DATABASE_URL%" -v ON_ERROR_STOP=1 -f db\rollback\rollback_NAMA-MIGRASI.sql
```
```bat
psql "%MIGRATION_DATABASE_URL%" -c "delete from etna_meta.schema_migrations where name = 'migrations/NAMA-MIGRASI.sql'"
```

Baris kedua wajib: tanpa itu, `npm run db:migrate` menganggap migrasinya masih
terpasang dan tidak akan menerapkannya lagi nanti.

**Pemulihan penuh** (data rusak). Hentikan ETNA Produksi, lalu di server
database pulihkan backup terakhir yang baik ke database baru, cek, dan arahkan
aplikasi ke sana. Uji dulu di service staging (langkah 4, "Coba restore").

---

## 16. Daftar periksa sebelum dipakai karyawan

- [ ] `https://erp.domainmu.com` terbuka dari HP (data seluler) dengan HTTPS.
- [ ] `http://10.0.0.10:4028` dan `:4029` **tidak** bisa dibuka dari komputer lain.
- [ ] `psql` dari komputer selain server aplikasi ke `10.0.0.20:5432` **ditolak**.
- [ ] `C:\ETNA\.env.local` berisi `TRUST_PROXY=cloudflare`; staging berisi `TRUST_PROXY=1`; keduanya ada di password manager.
- [ ] Server aplikasi **tidak** berisi `pgpass.conf` dan `.env.local` tidak berisi `ETNA_BACKUP_DATABASE_URL`.
- [ ] Batas 72 jam dimatikan di tugas **ETNA Produksi** dan **ETNA Staging**.
- [ ] Backup produksi terjadwal, `backup.log` berisi `ok`, satu restore percobaan berhasil.
- [ ] Backup dokumen terjadwal; salinan backup juga ada di luar kedua server.
- [ ] `icacls` pada `C:\ETNA`, `C:\ETNA-staging`, dan `D:\etna-backup` hanya menampilkan akunmu, `SYSTEM`, dan `Administrators`.
- [ ] Akun admin sudah memasang 2FA; workspace mewajibkan 2FA.
- [ ] Rate limit login dan Bot Fight Mode aktif di Cloudflare; (disarankan) Cloudflare Access aktif.
- [ ] Tunnel lama di laptop sudah dimatikan.

## Masalah umum

| Gejala | Penyebab dan solusi |
|---|---|
| Cloudflare error 502 / 1033 | ETNA atau cloudflared belum jalan. Cek `curl http://127.0.0.1:4028/api/health`, lalu `schtasks /Run /TN "ETNA Produksi"`. Cek service **Cloudflared**. |
| `/api/health` → `"database":"unreachable"` | Service PostgreSQL mati di server database, firewall atau `pg_hba.conf` menolak `10.0.0.10`, atau isi `.env.local` salah. Coba `psql` dari langkah 5. |
| `self-signed certificate` / `ERR_TLS_CERT_ALTNAME_INVALID` | `C:\ETNA-certs\db-ca.crt` bukan `server.crt` yang dipakai PostgreSQL, atau IP di alamat berbeda dengan IP di sertifikat. |
| `no pg_hba.conf entry for host "10.0.0.10"` | Baris `hostssl` belum ditambahkan, nama database salah (`etna` vs `etna_staging`), atau service belum di-restart. |
| `password authentication failed for user "etna_app"` | `.env.local` tidak cocok dengan database ini. Kalau databasenya masih kosong dan belum ada yang memakai 2FA: jalankan ulang langkah 7 dengan `node scripts\setup-local.mjs --force`. |
| `'sslrootcert' is not recognized` di cmd | Tanda kutip hilang di `set "NAMA=nilai"` (langkah 7). |
| `.env.local already exists` | Setup sudah pernah dijalankan di folder ini. Jangan pakai `--force` kalau sudah ada pengguna dengan 2FA. |
| Login selalu "Invalid login credentials" | Password salah atau akun belum dibuat. Reset dengan `etna_admin.set_password` (langkah 12). |
| "Too many sign-in attempts" | 5 kali salah dalam 2 menit. Tunggu 2 menit. |
| ETNA mati setelah tepat 3 hari | Batas 72 jam di Task Scheduler belum dimatikan (langkah 8). |
| Settings → Backup / User accounts "belum dikonfigurasi" | Memang disengaja di server ini (langkah 7c). Pakai langkah 4 dan 12. |
| Halaman rusak setelah update | Migrasi belum dijalankan: `npm run db:migrate` (langkah 14). |
