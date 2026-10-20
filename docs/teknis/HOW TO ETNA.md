# HOW TO ETNA: memasang ETNA di PC server dan membagi bebannya

Panduan ringkas untuk memasang ETNA di PC atau server Windows, dan memutuskan
**komponen mana jalan di mesin mana**. Langkah rinci dua server (TLS antar
server, staging, Caddy) ada di [INSTALL-SERVER.md](INSTALL-SERVER.md); dokumen
ini adalah peta dan pilihan layout. Ikuti urutannya dari atas.

Perintah ditulis untuk **PowerShell sebagai Administrator** kecuali dikatakan
lain. Ganti nilai contoh: `ETNA-SRV` (nama server), `erp.contoh.com` (domain),
`203.0.113.10` (IP admin).

> Jangan menulis password di command line, chat, atau screenshot. Pakai
> `Read-Host -AsSecureString`, `\password` di psql, atau password manager.

---

## 0. Cara cepat: satu server dengan pengelola server

Untuk layout A (ETNA dan PostgreSQL di satu PC/server, tanpa Docker) semua
langkah di bawah dikerjakan oleh **pengelola server** (`scripts\server\manager.mjs`). Bagian 1–13 tetap
berlaku sebagai penjelasan dan untuk layout dua server.

**Di PC development**

```bat
npm run package
```

Hasilnya folder `dist\ETNA-<versi>-<tanggal>\` berisi
`app\` (aplikasi yang sudah di-build, `node_modules` produksi, migrasi,
skrip, dokumen). Tidak ada `.env.local`, `storage\`, atau test di dalamnya.
`npm run package -- --zip` juga membuat file `.zip`.

**Di server** (sekali saja, sebagai administrator)

1. Pasang **Node.js 24 LTS** (nodejs.org) dan program **PostgreSQL 18**
   (postgresql.org) di server. ETNA membuat service database-nya sendiri.
2. Salin folder paket ke server (USB, jaringan), buka **Command Prompt
   sebagai administrator** di folder paket, lalu jalankan
   `node app\scripts\server\manager.mjs` dan pilih **[1] Pasang / Setup ETNA**.
3. Jawab pertanyaannya: drive atau folder data (`ETNA_DATA_ROOT`, mis.
   `D:\ETNA`), lokasi backup (sebaiknya disk lain), alamat publik
   (`https://erp.perusahaan.com`), super admin pertama (e-mail dan kata
   sandi), **passphrase backup**, dan jam backup harian.
4. Catat dua password PostgreSQL yang ditampilkan sekali di akhir ke password
   manager.
5. Pasang Cloudflare Tunnel (bagian 8) dan arahkan ke `http://127.0.0.1:4028`.
6. Buka alamat publik, masuk sebagai super admin, aktifkan two-factor di
   ERP → Settings.

**Apa yang dibuat installer**

| Di mana | Isi |
|---|---|
| `<root>\app\<versi>\`, `<root>\app\current` | Versi aplikasi (yang jalan dan satu sebelumnya); `current` adalah junction ke yang jalan |
| `<root>\config\` | `etna.env` (pengaturan dan kunci), `pgpass.conf` (password pemilik skema), kunci backup |
| `<root>\postgres\data\` | Cluster PostgreSQL ETNA, service **etna-postgres** (NetworkService, hanya localhost, port 5432 atau berikutnya yang kosong) |
| `<root>\documents\`, `<root>\logs\` | Dokumen unggahan; log server (`server-YYYYMMDD.log`, 30 hari) dan `manager.log` |
| `<root>\backups\full\` (atau lokasi backup pilihanmu) | Backup lengkap `.tar.gz` |
| Akun Windows **etna-svc** | Menjalankan ETNA dan backup; bukan admin; password acak yang tidak perlu diketahui siapa pun |
| Task Scheduler `\ETNA\Server`, `\ETNA\Backup` | ETNA dan **worker TERMINAL** jalan saat boot (dan dijalankan ulang kalau berhenti); backup lengkap setiap malam |
| `<root>\companies\<id>\` | File per perusahaan: `imports` (file impor TERMINAL), `artifacts` (ekspor), `tmp`. Menu **Company storage** bisa memindahkan satu perusahaan ke folder/drive sendiri |
| `%ProgramData%\ETNA\install.json` | Catatan instalasi (lokasi, port) |

Hanya Administrators, SYSTEM, dan etna-svc yang bisa membuka `<root>`;
etna-svc hanya bisa menulis `documents`, `logs`, dan `backups`.

**Backup lengkap** berisi database, dokumen, log, konfigurasi PostgreSQL,
versi aplikasi beserta foldernya, dan `etna.env` yang **dikunci**: backup
dibuat tanpa passphrase (task malam), tapi hanya bisa dibuka dengan
passphrase. Lupa passphrase = data tetap bisa dipulihkan, tapi semua
pengguna harus mengatur two-factor lagi. Satu backup kira-kira sebesar
database + dokumen + ±150 MB aplikasi (terkompresi); atur jumlah yang
disimpan di menu [9]. Salin backup ke tempat lain secara rutin.

**Menu sesudahnya** (sebagai administrator: `node <root>\app\current\scripts\server\manager.mjs`): jalankan/hentikan/restart,
cek kesehatan (dengan penjelasan masalah dan solusinya), backup sekarang,
daftar backup, pulihkan (selalu membuat backup kondisi sekarang dulu dan
meminta nama database diketik), jadwal backup, lihat log, update (dari paket
baru: backup dulu, migrasi, health check, kembali ke versi lama kalau gagal),
pindah penyimpanan ke drive lain (folder lama tidak dihapus), info server,
folder per perusahaan, batas unggahan, **[16] Perbaiki** (service, task, izin
folder) dan **[17] Persiapan uninstall** (backup terakhir, lalu service dan
task dihapus; data tidak dihapus).

> **Pilihan saat instalasi:** backup dari aplikasi (`/admin/system` → Back up
> now) aktif, jadi proses ETNA bisa memakai password pemilik database dari
> `pgpass.conf`. Untuk mematikannya hapus `ETNA_BACKUP_DATABASE_URL` dari
> `<root>\config\etna.env` lalu restart ETNA.

---

## 1. Komponen ETNA dan bebannya

ETNA hanya punya lima bagian yang bekerja. Semuanya bisa di satu mesin, atau
dipisah.

| Komponen | Tugas | Beban | Catatan |
|---|---|---|---|
| **Aplikasi Next.js** (`next start`, port 4028) | Halaman, API, login, hitung gaji, cetak | CPU sedang, RAM 0,5 sampai 1 GB | Satu proses Node. Tidak bisa di-cluster begitu saja (lihat bagian 12) |
| **PostgreSQL 18** (port 5432) | Semua data, aturan akses (RLS), jurnal, audit | CPU dan disk paling berat, RAM 2 GB lebih | Beban terbesar. Pisahkan ke server sendiri kalau pengguna bertambah |
| **Penyimpanan dokumen** (`storage\documents`) | Berkas unggahan | Disk | Bukan di database, backup terpisah |
| **Gerbang** (Cloudflare Tunnel atau Caddy) | HTTPS dan pembatasan trafik | Ringan | Satu-satunya yang menghadap internet |
| **Backup** (`etna-db-backup.cmd`) | `pg_dump` harian | Disk dan CPU saat jalan | Jalankan malam hari, dengan akun sendiri |
| **Worker TERMINAL** (`scripts\server\worker.mjs`) | Pekerjaan latar: tabel dataset, impor, pipeline terjadwal, perawatan harian | CPU dan RAM saat impor/pipeline besar | Login database sendiri (`etna_worker`, `WORKER_DATABASE_URL`). Butuh Node.js 22.6 atau lebih baru |

Batas bawaan di kode (berguna untuk perencanaan kapasitas):

- Koneksi database aplikasi maksimal 10, untuk login maksimal 5.
- Maksimal 4 hash password (bcrypt) bersamaan, antrean 16.
- Satu pengguna maksimal 3 permintaan data bersamaan.
- Batas permintaan: 120 per menit per pengguna untuk API ERP, 1200 per menit untuk `/api/data`.

---

## 2. Pilih layout

| Layout | Cocok untuk | Mesin | Catatan |
|---|---|---|---|
| **A. Satu PC server** | Pilot, 1 sampai 2 perusahaan, sampai sekitar 20 pengguna | 1 mesin: aplikasi + PostgreSQL + gerbang | Paling sederhana. PostgreSQL hanya `localhost`, tanpa TLS |
| **B. Dua server** | Produksi sungguhan, banyak pengguna | Server aplikasi + server database | Ikuti [INSTALL-SERVER.md](INSTALL-SERVER.md). Database hanya menerima koneksi dari server aplikasi lewat TLS |
| **C. B + staging** | Sebelum update ke produksi | Staging memakai service PostgreSQL sendiri (port 5433) dan folder `C:\ETNA-staging` | Selalu coba update di staging dulu |

Ukuran mesin yang masuk akal (perkiraan, sesuaikan dengan beban nyata):

- Layout A: 4 core, 8 sampai 16 GB RAM, SSD 250 GB atau lebih, disk kedua untuk backup.
- Layout B: server aplikasi 4 core dan 8 GB, server database 4 core dan 8 sampai 16 GB RAM, SSD.

Pembagian kerja antar akun Windows (semua layout):

| Akun | Menjalankan | Hak |
|---|---|---|
| `etna-svc` | Tugas "ETNA" (aplikasi) | Baca kode, tulis `storage` dan folder dokumen. **Bukan administrator** |
| `etna-backup` | Tugas backup database dan dokumen | Tulis folder backup, baca `pgpass.conf` miliknya |
| Akun admin (kamu) | Instalasi, update, migrasi | Administrator, tidak dipakai untuk menjalankan ETNA |

---

## 3. Persiapan Windows (sekali saja)

```powershell
Rename-Computer -NewName ETNA-SRV
Set-TimeZone -Id "SE Asia Standard Time"
Restart-Computer
```

1. Jalankan Windows Update sampai bersih: `sconfig`, pilih 6.
2. Matikan sleep: Settings, System, Power, "put my device to sleep" = Never.
3. Siapkan **akses konsol** (monitor atau hypervisor) sebelum mengubah firewall,
   supaya tidak terkunci dari RDP.
4. Buat akun:

```powershell
$p = Read-Host "Password etna-svc" -AsSecureString
New-LocalUser -Name "etna-svc" -Password $p -PasswordNeverExpires -UserMayNotChangePassword
$p = Read-Host "Password etna-backup" -AsSecureString
New-LocalUser -Name "etna-backup" -Password $p -PasswordNeverExpires -UserMayNotChangePassword
```

5. Buat folder (pakai disk kedua untuk `D:` kalau ada):

```powershell
New-Item -ItemType Directory -Force C:\ETNA, C:\etna-tools, D:\etna-data\documents, D:\etna-backup\db, D:\etna-backup\documents | Out-Null
```

---

## 4. Pasang program

ETNA tidak memakai Docker, WSL2, atau Supabase. **Jangan memasangnya.**

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
```

Kalau `winget` tidak ada (Server 2019 dan 2022), unduh installer dari situs
resmi git-scm.com dan nodejs.org. Cek:

```powershell
git --version
node -v
```

Node harus versi **24** (sama dengan CI).

**PostgreSQL 18:** unduh installer EDB dari postgresql.org dan jalankan secara
interaktif.

- Komponen: PostgreSQL Server dan Command Line Tools saja.
- Port 5432. Buat password kuat untuk `postgres` dan simpan di password manager.
- Layout A: di `postgresql.conf` set `listen_addresses = 'localhost'`, lalu
  `Restart-Service postgresql-x64-18`.
- Layout B: ikuti INSTALL-SERVER.md bagian 2 (TLS dan `pg_hba.conf`).

Buat pemilik database. Password diketik di psql, tidak muncul di riwayat:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -h localhost
```

Di dalam psql:

```sql
CREATE ROLE etna_owner LOGIN CREATEROLE;
\password etna_owner
CREATE DATABASE etna OWNER etna_owner;
\q
```

Cek PostgreSQL hanya mendengarkan lokal (layout A):

```powershell
Get-NetTCPConnection -LocalPort 5432 -State Listen
```

---

## 5. Ambil kode ETNA

Repo GitHub sudah dihapus, jadi pindahkan dengan **git bundle**.

Di PC tempat kode berada:

```powershell
cd C:\ETNA
git bundle create etna.bundle --all
```

Salin `etna.bundle` ke server (USB atau jaringan), lalu di server, ke folder
`C:\ETNA` yang masih kosong:

```powershell
git clone etna.bundle C:\ETNA
```

Untuk update berikutnya, buat bundle baru dan jalankan
`git pull C:\path\etna.bundle main` di folder ETNA.

Pasang dependensi dan build:

```powershell
cd C:\ETNA
npm ci
npm run build
```

---

## 6. Skema database dan `.env.local`

`scripts\setup-local.mjs` menerapkan semua migrasi, membuat role `etna_app` dan
`etna_auth` dengan password acak, dan menulis `.env.local`.

```powershell
cd C:\ETNA
$env:MIGRATION_DATABASE_URL = "postgres://etna_owner@localhost:5432/etna"
$s = Read-Host "Password etna_owner" -AsSecureString
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
node scripts\setup-local.mjs
Remove-Item Env:PGPASSWORD, Env:MIGRATION_DATABASE_URL
```

Lalu tambahkan ke `C:\ETNA\.env.local` (ganti sesuai gerbang yang dipakai):

```
TRUST_PROXY=cloudflare
ETNA_PUBLIC_URL=https://erp.contoh.com
ETNA_DOCUMENTS_DIR=D:\etna-data\documents
```

- `TRUST_PROXY=cloudflare` untuk Cloudflare Tunnel, `TRUST_PROXY=1` untuk Caddy.
  **Wajib diisi.** Tanpa ini ETNA tidak tahu IP pengguna: batas login hanya per
  e-mail dan log keamanan tanpa IP.
- `ETNA_PUBLIC_URL` dipakai untuk tautan undangan dan reset password.
- E-mail (opsional): `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`,
  `SMTP_FROM`.
- **Jangan** mengisi `ETNA_BACKUP_DATABASE_URL` dan `ETNA_ADMIN_EMAILS` di
  server. Keduanya memberi aplikasi jalan ke hak pemilik database.

Salin isi `.env.local` ke password manager. Tanpa `MFA_ENCRYPTION_KEY`, semua
pengguna harus mendaftarkan ulang authenticator.

Kunci izin file:

```powershell
icacls C:\ETNA /inheritance:r /grant:r "etna-svc:(OI)(CI)RX" "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F"
icacls C:\ETNA\.env.local /inheritance:r /grant:r "etna-svc:R" "SYSTEM:F" "Administrators:F"
New-Item -ItemType Directory -Force C:\ETNA\storage\logs | Out-Null
icacls C:\ETNA\storage /grant:r "etna-svc:(OI)(CI)M"
icacls D:\etna-data /inheritance:r /grant:r "etna-svc:(OI)(CI)M" "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F"
icacls D:\etna-backup /inheritance:r /grant:r "etna-backup:(OI)(CI)M" "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F"
```

Cek: `icacls C:\ETNA\.env.local` hanya menampilkan tiga akun di atas.

---

## 7. Jalankan ETNA sebagai layanan

`scripts\server\etna-server.cmd` menjalankan ETNA di `127.0.0.1:4028` dan
menyalakannya lagi 10 detik setelah berhenti. Daftarkan di Task Scheduler,
dengan batas 72 jam dimatikan:

```powershell
$action   = New-ScheduledTaskAction -Execute "C:\ETNA\scripts\server\etna-server.cmd"
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$cred     = Get-Credential etna-svc
Register-ScheduledTask -TaskName "ETNA" -Action $action -Trigger $trigger -Settings $settings -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited
Start-ScheduledTask -TaskName "ETNA"
```

**Worker TERMINAL.** Di layout ini jalankan juga worker sebagai task kedua
(akun dan pengaturan yang sama, `WORKER_DATABASE_URL` diisi):

```powershell
$worker = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" -Argument "C:\ETNA\scripts\server\worker.mjs" -WorkingDirectory "C:\ETNA"
Register-ScheduledTask -TaskName "ETNA Worker" -Action $worker -Trigger $trigger -Settings $settings -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Limited
Start-ScheduledTask -TaskName "ETNA Worker"
```

Dengan pengelola server (bagian 0) ini tidak perlu: task `\ETNA\Server` sudah
menjalankan worker di samping aplikasi.

Kalau tugas gagal jalan, akun `etna-svc` mungkin butuh hak "Log on as a batch
job" (`secpol.msc`, Local Policies, User Rights Assignment).

Cek kesehatan:

```powershell
Invoke-RestMethod http://127.0.0.1:4028/api/health
```

Harus muncul `status : ok` dan `database : ok`. Log aplikasi ada di
`C:\ETNA\storage\logs\server.log`.

---

## 8. Buka ke internet dengan aman

**Cloudflare Tunnel (disarankan, tanpa membuka port masuk):**

```powershell
winget install --id Cloudflare.cloudflared -e
```

Di dashboard Cloudflare (Networks, Tunnels) buat tunnel dan hostname
`erp.contoh.com` yang menuju `http://127.0.0.1:4028`. Jalankan perintah
`cloudflared service install <TOKEN>` dari Cloudflare. Token itu rahasia.
Di Cloudflare aktifkan: Always Use HTTPS, TLS minimum 1.2, aturan rate limit
untuk `/api/auth/login`, dan Bot Fight Mode.

**Alternatif Caddy:** pakai `scripts\server\Caddyfile.staging` sebagai contoh,
dengan `reverse_proxy 127.0.0.1:4028` dan `TRUST_PROXY=1`.

Firewall: biarkan semuanya tertutup kecuali yang dibutuhkan.

```powershell
Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultInboundAction Block
New-NetFirewallRule -DisplayName "RDP admin saja" -Direction Inbound -Protocol TCP -LocalPort 3389 -RemoteAddress 203.0.113.10 -Action Allow
```

**Jangan pernah dibuka ke luar:** 4028, 4029, 5432, 5433, 445, 135, 5985.
Uji dari komputer lain; semuanya harus gagal:

```powershell
Test-NetConnection <ip-server> -Port 4028
Test-NetConnection <ip-server> -Port 5432
```

---

## 9. Akun pertama

Buat admin platform pertama (dia lalu mengaktifkan 2FA sebelum `/admin` terbuka):

```powershell
cd C:\ETNA
$env:ADMIN_DATABASE_URL = "postgres://etna_owner@localhost:5432/etna"
$s = Read-Host "Password etna_owner" -AsSecureString
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
node scripts\admin\users.mjs create-user --email kamu@contoh.com --name "Nama Kamu"
node scripts\admin\users.mjs grant-admin --email kamu@contoh.com
Remove-Item Env:PGPASSWORD, Env:ADMIN_DATABASE_URL
```

Password sementara tampil sekali. Setelah masuk, ganti password dan aktifkan 2FA
di ERP, Settings. Seterusnya buat perusahaan klien dari `/admin`, Workspaces,
New company. Detail: [ADMIN.md](ADMIN.md).

---

## 10. Backup (pembagian kerja malam hari)

Jalankan backup sebagai akun `etna-backup`, **bukan** akun aplikasi, supaya
password pemilik database tidak berada di akun yang menjalankan web.

1. Buat `%APPDATA%\postgresql\pgpass.conf` milik `etna-backup` berisi satu baris
   `localhost:5432:etna:etna_owner:<password>` dan kunci izinnya hanya untuk
   akun itu.
2. Salin skrip dan jadwalkan:

```powershell
Copy-Item C:\ETNA\scripts\server\etna-db-backup.cmd C:\etna-tools\ -Force
schtasks /Create /TN "ETNA DB Backup" /TR "C:\etna-tools\etna-db-backup.cmd etna 5432 D:\etna-backup\db" /SC DAILY /ST 02:00 /RU etna-backup /RP *
schtasks /Create /TN "ETNA Docs Backup" /TR "robocopy D:\etna-data\documents D:\etna-backup\documents /E /R:2 /W:5 /NP" /SC DAILY /ST 02:15 /RU etna-backup /RP *
```

3. Jalankan sekali dengan `schtasks /Run /TN "ETNA DB Backup"`. Harus ada
   berkas `.dump` dan baris `ok` di `D:\etna-backup\db\backup.log`.
4. **Salin ke luar server** (disk eksternal atau penyimpanan terenkripsi),
   termasuk `git bundle` kodenya. Backup yang hanya di server ikut hilang kalau
   servernya rusak.
5. Coba restore tiap 3 bulan ke database percobaan.

Nyalakan BitLocker di volume data dan backup, dan simpan kunci pemulihannya di
luar server.

---

## 11. Update dan rollback

Selalu **staging dulu** (layout C), baru produksi.

```powershell
Stop-ScheduledTask ETNA
cd C:\ETNA
git rev-parse --short HEAD           # catat dulu untuk rollback
schtasks /Run /TN "ETNA DB Backup"   # tunggu baris ok baru di backup.log
# ambil kode baru (bundle atau git pull), lalu:
npm ci
$env:MIGRATION_DATABASE_URL = "postgres://etna_owner@localhost:5432/etna"
# set PGPASSWORD seperti di bagian 6
npm run db:migrate
npm run build
Remove-Item Env:PGPASSWORD, Env:MIGRATION_DATABASE_URL
Start-ScheduledTask ETNA
Invoke-RestMethod http://127.0.0.1:4028/api/health
```

Pantau `server.log` selama 30 menit.

Rollback aplikasi: `Stop-ScheduledTask ETNA`, `git checkout <kode-lama>`,
`npm ci`, `npm run build`, `Start-ScheduledTask ETNA`. Migrasi bersifat aditif,
jadi aplikasi lama biasanya tetap jalan di skema baru. Skrip rollback skema
hanya dipakai kalau perlu; baca kepala berkasnya dulu (lihat INSTALL-SERVER.md
bagian 15).

---

## 12. Kapan beban perlu dibagi

| Gejala | Tindakan |
|---|---|
| Halaman lambat, CPU PostgreSQL tinggi | Pindahkan PostgreSQL ke server sendiri (layout B) dan tambah RAM database |
| Disk hampir penuh | Pindahkan dokumen dan backup ke volume besar; skrip backup hanya menyimpan 14 harian dan 12 bulanan |
| Login lambat saat banyak orang masuk bersamaan | Tambah core: bcrypt memakai CPU, maksimal 4 bersamaan |
| Beban aplikasi tinggi | Naikkan RAM dan core dulu. **Jangan menjalankan beberapa proses ETNA di belakang satu domain**: pembatas permintaan tersimpan di memori per proses, jadi batasnya tidak lagi akurat |
| Banyak klien dengan data besar | Satu database per kelompok klien, atau server database yang lebih besar |
| Produksi dan uji coba saling mengganggu | Pisahkan staging ke service PostgreSQL sendiri (port 5433) |

---

## 13. Daftar periksa sebelum dipakai

- [ ] `https://erp.contoh.com` terbuka dari HP lewat data seluler, dengan HTTPS.
- [ ] Port 4028 dan 5432 **tidak** bisa dibuka dari komputer lain.
- [ ] `.env.local` hanya terbaca `etna-svc`, `SYSTEM`, dan `Administrators`.
- [ ] `TRUST_PROXY` dan `ETNA_PUBLIC_URL` terisi; log keamanan menampilkan IP asli.
- [ ] `ETNA_BACKUP_DATABASE_URL` dan `ETNA_ADMIN_EMAILS` **tidak** ada di `.env.local`.
- [ ] Backup harian jalan, `backup.log` berisi `ok`, restore percobaan berhasil.
- [ ] Salinan backup dan `git bundle` ada di luar server.
- [ ] Admin pertama sudah memasang 2FA; perusahaan mewajibkan 2FA untuk semua anggota.
- [ ] Rate limit login dan Bot Fight Mode aktif di Cloudflare.
- [ ] BitLocker aktif di volume data dan backup.
- [ ] Setelah restart server, ETNA, PostgreSQL, dan tunnel menyala sendiri.

## Dokumen terkait

- [INSTALL-SERVER.md](INSTALL-SERVER.md): langkah rinci dua server, TLS, staging, Caddy
- [CONFIGURATION.md](CONFIGURATION.md): semua variabel `.env.local`
- [OPERATIONS.md](OPERATIONS.md): rilis, backup, pemantauan, insiden
- [ADMIN.md](ADMIN.md): panel admin dan log keamanan
- [INDUSTRY-MODULES.md](INDUSTRY-MODULES.md): modul quarry dan payroll
