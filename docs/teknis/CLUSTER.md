# Beberapa server aplikasi (horizontal scaling)

Kalau satu server sudah tidak cukup, tambah **server aplikasi** baru. Semua
server aplikasi memakai **satu database** dan **satu folder data** yang sama,
lalu Cloudflare Tunnel membagi pengunjung ke semuanya. Kalau satu server mati,
pengunjung otomatis dilayani server lain.

```
                    Cloudflare Tunnel (satu tunnel, satu connector per server)
                   ┌───────────────┬───────────────┐
                   ▼               ▼               ▼
              app1 (utama)       app2            app3        ← app + worker di tiap server
                   │  ▲            │               │
                   │  └──── NFS ───┴───────────────┘           folder data /var/lib/etna milik app1
                   ▼
              db1 (PostgreSQL, server sendiri, TLS)
```

| Bagian | Di mana | Catatan |
|---|---|---|
| Database | Server sendiri (`db1`) | Wajib: app lain tidak bisa memakai database yang hanya mendengarkan di `localhost` app1 |
| Folder data (dokumen, file perusahaan) | Disk app1, dibagi lewat NFS | Server lain me-mount-nya di `/var/lib/etna` |
| Backup | Hanya di app1 | `psctl backup`, `restore` dan `db move` ditolak di server tambahan |
| Job (import, pipeline, jadwal) | Worker di **setiap** server | Aman: job diambil dengan `FOR UPDATE SKIP LOCKED`, satu job hanya dijalankan satu worker |
| Migrasi database | Server mana pun yang di-update | Dikunci (`pg_advisory_lock`): satu per satu, yang lain menunggu |
| Login, sesi, rate limit | Database + kunci di `etna.env` | `etna.env` **sama persis** di semua server |

## Yang dibutuhkan

- Database sudah di server sendiri. Kalau belum, pindahkan dulu:
  `sudo psctl db move "postgres://etna_owner@10.0.0.20:5432/etna?sslmode=verify-full"`
  (lihat [INSTALL-LINUX.md](INSTALL-LINUX.md) bagian A11).
- Semua server di **jaringan lokal yang sama** (misalnya `10.0.0.0/24`). NFS
  tidak dienkripsi: jangan pernah lewat internet.
- Server baru: Ubuntu Server, Node.js 24, dan kode PrintStream **versi yang
  sama** dengan app1.
- Cloudflare Tunnel yang dibuat dari dashboard (token). Tunnel lokal dengan
  `config.yml` juga bisa, tapi file kredensialnya harus disalin sendiri.

## 1. Di app1: bagikan folder data

```bash
sudo psctl cluster share --allow 10.0.0.0/24
```

Perintah ini memasang server NFS, membagikan `/var/lib/etna` hanya ke jaringan
itu (`root_squash`: root di server lain tidak punya hak root di sini), membuka
port 2049 di ufw kalau ufw aktif, lalu menampilkan perintah untuk server baru.

## 2. Di database server: izinkan server baru

Tambahkan IP server baru di `pg_hba.conf` (baris `hostssl ... scram-sha-256`
yang sama seperti app1), lalu `sudo systemctl reload postgresql`.

## 3. Di server baru: pasang

Salin pengaturan dari app1 (berisi kunci rahasia: hanya lewat `scp` sebagai
root, jangan lewat chat atau e-mail):

```bash
sudo scp root@10.0.0.10:/etc/etna/etna.env /root/etna.env
```

Lalu, di folder PrintStream:

```bash
sudo deploy/linux/install.sh --database-url "postgres://etna_owner@10.0.0.20:5432/etna?sslmode=verify-full" --settings-from /root/etna.env --shared-data 10.0.0.10:/var/lib/etna
```

```bash
sudo rm /root/etna.env
```

Installer akan:

1. memasang klien NFS, menulis baris di `/etc/fstab` (cadangannya
   `/etc/fstab.etna-backup`) dan me-mount folder data;
2. membuat user `etna` dengan **uid dan gid yang sama** dengan pemilik folder
   data di app1 (kalau user `etna` sudah ada dengan id lain, installer
   berhenti);
3. memakai `etna.env` dari app1 (kunci yang sama: sesi dan two-factor berlaku
   di semua server);
4. build dengan build id yang sama dengan server lain (diambil dari commit git,
   atau dari isi kode kalau tanpa git);
5. menyimpan `ETNA_SHARED_DATA` di `/etc/etna/psctl.env`, jadi update
   berikutnya (`sudo deploy/linux/install.sh` atau `psctl upgrade`) tetap
   memakai folder data bersama.

Layanan `etna` dan `etna-worker` tidak mau jalan kalau folder data belum
ter-mount (`RequiresMountsFor=/var/lib/etna`), supaya file tidak pernah
tersimpan diam-diam di disk lokal.

## 4. Cloudflare Tunnel di setiap server

Di **setiap** server aplikasi (termasuk app1), pasang connector dengan **token
tunnel yang sama** (Cloudflare Zero Trust → Networks → Tunnels → tunnel kamu →
Configure):

```bash
sudo cloudflared service install <token tunnel>
```

```bash
sudo psctl cluster tunnel
```

`psctl cluster tunnel` membuat cloudflared berhenti saat aplikasi di server itu
berhenti (dan jalan lagi saat aplikasi jalan). Jadi kalau app di satu server
mati atau sedang di-update, Cloudflare hanya mengirim pengunjung ke server
yang masih hidup.

Public hostname tunnel tetap mengarah ke `http://127.0.0.1:4028`: setiap
connector meneruskan ke aplikasi di servernya sendiri.

## 5. Cek

```bash
sudo psctl cluster status
```

```
● app1                     1.0.1+3f2a9c1d07b4e6aa       0 job(s) running
● app2                     1.0.1+3f2a9c1d07b4e6aa       1 job(s) running
This server keeps the data folder itself.
```

Versi ditampilkan bersama build id. Kalau berbeda antar server, psctl memberi
peringatan: halaman bisa gagal dimuat saat permintaan pindah server. Di server
tambahan, `sudo psctl doctor` juga memeriksa apakah folder data ter-mount.

## Update

1. Update **app1 dulu** (`sudo psctl upgrade <folder>` atau
   `sudo deploy/linux/install.sh` setelah `git pull`): backup dibuat, migrasi
   dijalankan.
2. Lalu server lain, satu per satu, dari **commit yang sama**. Migrasi sudah
   tidak ada yang tersisa, jadi cepat.

Selama update, server yang sedang di-restart tidak menerima pengunjung
(berkat `psctl cluster tunnel`). Migrasi hanya menambah, jadi versi lama tetap
jalan dengan database baru selama beberapa menit itu.

## Melepas server

Di server itu: `sudo psctl stop`, `sudo systemctl disable --now cloudflared`,
lalu hapus baris `/var/lib/etna` di `/etc/fstab`. Hapus juga IP-nya dari
`pg_hba.conf` di database server. Di `psctl cluster status`, server itu tampil
mati lalu hilang setelah 7 hari.

## Batasan

- **app1 tetap penting**: kalau app1 mati, server lain tidak bisa membaca atau
  menyimpan dokumen dan file perusahaan (halaman lain tetap jalan selama
  database hidup). Folder data di NAS terpisah belum didukung (backup hanya
  jalan di server yang memegang folder data).
- **Database tetap satu**: scaling ini menambah tenaga aplikasi dan worker,
  bukan database. Kalau database yang penuh, besarkan VM database-nya.
- Batas permintaan undangan workspace dihitung per server (batas lain dihitung
  di database, berlaku untuk semua server).
