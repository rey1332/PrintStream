# HOW TO WORKFLOWS: otomatisasi analisis data di ETNA

Panduan memakai **Workflows** (ERP, Automation, Workflows; di layar berbahasa
Indonesia disebut **Alur Kerja**) untuk mengolah data ERP menjadi tabel, KPI,
grafik, dan berkas CSV tanpa menulis kode.

Dokumen ini adalah panduan memakai. Aturan teknis dan keamanannya ada di
[WORKFLOWS.md](WORKFLOWS.md).

## 0. Yang perlu dipahami dulu

Workflow di ETNA adalah **otomatisasi analisis**, bukan otomatisasi tindakan.

| Bisa | Tidak bisa |
|---|---|
| Membaca data ERP (hanya baca) | Mengubah data ERP (membuat invoice, mengubah stok, dan sebagainya) |
| Menyaring, menghitung, mengelompokkan, menggabungkan | Berjalan sendiri sesuai jadwal atau saat data berubah |
| Menampilkan tabel, KPI, grafik, mengunduh CSV | Menjalankan kode Python atau skrip |
| **Auto-refresh tiap 1 menit** selama halamannya terbuka | Mengirim e-mail atau notifikasi |
| Menyimpan versi dan riwayat jalan | Membaca data weighbridge, produksi, atau equipment (belum ada di katalog data) |

Kalau yang kamu cari adalah persetujuan pembelian atau notifikasi, itu fitur lain
dan bukan bagian dari Workflows.

**Siapa yang bisa memakai:** Owner, Admin, dan Finance. Peran Sales dan Inventory
tidak melihat menu ini (lihat [ROLES.md](ROLES.md)). Semua anggota workspace bisa
membuka, menjalankan, dan menduplikasi workflow di workspace itu, tapi hanya
**pembuatnya** yang bisa mengubahnya.

## 1. Konsep dalam satu menit

Workflow adalah **diagram** berisi kotak (disebut **node**) yang dihubungkan
dengan garis. Data mengalir dari kiri ke kanan:

```
Sumber data  →  Transformasi  →  (Analisis)  →  Output
 (ambil data)    (olah data)      (statistik)     (tampilkan atau unduh)
```

Empat jenis node (warna di palet):

| Jenis | Fungsi |
|---|---|
| **Data Sources** (biru) | Mengambil data dari ERP |
| **Transform** (ungu) | Menyaring, mengurutkan, menghitung, menggabungkan |
| **Analysis** (oranye) | Statistik kolom |
| **Outputs** (hijau) | Hasil akhir: tabel, grafik, KPI, CSV |

Setiap node yang dijalankan menampilkan pratinjau hasilnya, jadi kamu bisa
memeriksa setiap langkah.

## 2. Membuat workflow pertama

1. Buka **ERP, Automation, Workflows**, klik **New Workflow** (Alur Kerja Baru).
2. Beri nama di kolom **Workflow name**.
3. **Seret node dari palet di kiri** ke kanvas.
4. **Hubungkan** node dengan menarik garis dari titik keluar satu node ke titik
   masuk node berikutnya.
5. Klik sebuah node untuk mengaturnya (panel **Configure** di kanan).
6. Klik **Run** (Jalankan). Hasil tiap node muncul di **Output Preview**.
7. Klik **Save** (Simpan). Tanda `unsaved` hilang kalau sudah tersimpan.

Tombol lain: **Duplicate** menyalin node atau workflow, **Delete** menghapus.

## 3. Node yang tersedia

### Sumber data

| Node | Pakai untuk |
|---|---|
| **ERP Data** | Baris data satu jenis catatan (misalnya invoice) beserta kolom dari catatan terkait. Maksimal 5.000 baris |
| **ERP Summary** | Pengelompokan dan total yang dihitung **database** atas **semua** catatan yang cocok. Pakai ini untuk angka total |
| Customers, Suppliers, Products, Invoices, Payments, Transactions, Inventory Items, Sales Orders, Purchase Orders | Cara lama: memuat satu jenis data penuh atau satu catatan. Untuk analisis baru, pakai **ERP Data** |

Data yang bisa dibaca (katalog): Customers, Suppliers, Products, Sales orders
dan barisnya, Purchase orders dan barisnya, Invoices, Payments, Cash
transactions, Stock movements, Ledger accounts, Journal entries, Journal lines.

**ERP Data** punya pengaturan:

- **Entity** dan **fields** (kolom yang diambil, maksimal 60).
- **Related**: kolom dari catatan terkait. Kolom terkait diberi nama
  `hubungan.kolom`, misalnya `customer.name`.
- **Filters** (maksimal 20). Operator tergantung jenis kolom:

| Jenis kolom | Operator |
|---|---|
| Angka, uang, tanggal | sama dengan, tidak sama, lebih besar, lebih besar atau sama, lebih kecil, lebih kecil atau sama |
| Teks | sama dengan, tidak sama, mengandung |
| Status (enum) dan ID | sama dengan, tidak sama, salah satu dari (maksimal 100 nilai) |
| Ya atau tidak | sama dengan |
| Kolom yang boleh kosong | ditambah "kosong" dan "tidak kosong" |

- **Sort** dan **limit** (bawaan 1.000, maksimal 5.000 baris).
- Kolom yang dihitung database (misalnya `balance_due` pada invoice) tidak bisa
  dipakai di filter sumber. Saring dengan node **Filter Rows** setelahnya.

**ERP Summary** punya pengaturan:

- **Group by**: maksimal 3 kolom. Kolom tanggal bisa dikelompokkan per hari,
  bulan, kuartal, atau tahun.
- **Measures**: maksimal 8 dari jumlah catatan, jumlah nilai unik, jumlah
  (sum), rata-rata, minimum, maksimum.
- **Filters**, **sort**, **limit** (bawaan 200, maksimal 1.000 baris).
- Catatan yang dibatalkan atau di-void **tidak ikut dihitung**, kecuali kamu
  memilih untuk menyertakannya.
- Setiap baris punya kolom `record_count`. Klik sebuah baris untuk melihat
  daftar catatan yang dihitungnya (drill-down).

### Transformasi

| Node | Fungsi | Pengaturan |
|---|---|---|
| **Filter Rows** | Simpan baris yang cocok | kolom, operator (`=`, `!=`, `>`, `>=`, `<`, `<=`, `contains`), nilai |
| **Sort** | Urutkan | kolom, naik atau turun |
| **Limit Rows** | Ambil N baris pertama | jumlah |
| **Select & Rename** | Pilih kolom dan ganti nama | `columns`: daftar dipisah koma. `rename`: pasangan `lama:baru` dipisah koma |
| **Aggregate** | Kelompokkan satu kolom dan hitung kolom lain | group by, kolom, operasi (`sum`, `avg`, `min`, `max`, `count`) |
| **Calculated Field** | Kolom baru dari rumus | nama kolom baru, rumus (lihat bagian 4) |
| **Compute Column** | Kolom baru dari rumus atas dua kolom `a` dan `b` | kolom A, kolom B, rumus |
| **Join Tables** | Gabungkan dua tabel lewat kunci | kunci kiri, kunci kanan, jenis (`inner`, `left`, `right`, `outer`). Butuh **dua** input |
| **Validate Data** | Periksa kualitas data | kolom wajib, kolom angka, kolom tanggal, kunci unik, aksi: laporkan atau buang baris bermasalah |
| **Branch** | Pecah jadi dua jalur | kolom, operator, nilai. Dua keluaran: baris cocok (`match`) dan sisanya (`else`) |

### Analisis

| Node | Fungsi |
|---|---|
| **Describe Column** | Statistik kolom angka: jumlah, rata-rata, simpangan baku, median, min, maks, persentil 25 dan 75 |
| **Fit Distribution** | Mencocokkan distribusi normal, eksponensial, atau lognormal |

### Output

| Node | Fungsi |
|---|---|
| **Table View** | Tabel lengkap (bawaan 200 baris tampil) |
| **Bar Chart** | Grafik batang: kolom kategori, kolom nilai, agregasi |
| **Line Chart** | Grafik garis: kolom X dan Y |
| **KPI Value** | Satu angka: kolom, label, operasi |
| **Export CSV** | Unduh sebagai CSV (nama berkas bisa diatur). Sel yang berawalan `=`, `+`, `-`, `@` diamankan agar tidak dijalankan sebagai rumus di Excel |
| **Output Dataset** | Memberi nama pada hasil workflow |

## 4. Menulis rumus (Calculated Field)

Rumus hanya **aritmetika**, tidak pernah dijalankan sebagai kode.

- Operator: `+  -  *  /  %` dan tanda kurung.
- Fungsi: `abs`, `round`, `floor`, `ceil`, `sqrt`, `min`, `max`.
- Nama kolom dipakai langsung sebagai variabel, misalnya `min_stock - current_stock`.
- Nama kolom berisi titik atau spasi ditulis dalam **kurung siku**, misalnya
  `[customer.credit_limit] - total`.
- Panjang rumus maksimal 500 karakter.
- Kolom kosong dihitung sebagai kosong (bukan 0), jadi hasilnya juga kosong.

## 5. Resep siap pakai

Nama kolom hasil (misalnya hasil `sum` dari `total`) ditampilkan editor setelah
kamu menjalankan node-nya. Pilih dari daftar itu di node berikutnya.

### Resep 1: Penjualan per bulan per pelanggan

`ERP Summary` → `Bar Chart` (atau `Table View`)

1. **ERP Summary**: Entity **Invoices**.
   Group by `invoice_date` (per **bulan**), `customer_name`, dan `currency`.
   Measures: **sum** `total` dan **count**.
2. Hubungkan ke **Table View** atau **Bar Chart**.

Kenapa `currency` ikut dikelompokkan: nilai dokumen dalam mata uang berbeda
tidak dijumlahkan bersama. Tanpa pengelompokan mata uang, baris yang campuran
dikosongkan dengan peringatan.

### Resep 2: Piutang jatuh tempo

`ERP Data` → `Sort` → `KPI Value` + `Table View` + `Export CSV`

1. **ERP Data**: Entity **Invoices**, fields `doc_no`, `customer_name`,
   `due_date`, `status`, `balance_due`, `currency`. Filter `status` sama dengan
   `overdue`.
2. **Sort** kolom `due_date`, naik.
3. Hubungkan ke tiga output: **KPI Value** (kolom `balance_due`, operasi sum,
   label "Total piutang jatuh tempo"), **Table View**, dan **Export CSV**.

Kalau ada lebih dari satu mata uang, tambahkan filter `currency` sama dengan
satu mata uang dulu supaya totalnya tidak mencampur mata uang.

### Resep 3: Stok yang menipis

`ERP Data` → `Calculated Field` → `Filter Rows` → `Sort` → `Table View` + `Export CSV`

1. **ERP Data**: Entity **Products**, fields `name`, `sku`, `category`,
   `unit`, `current_stock`, `min_stock`.
2. **Calculated Field**: kolom baru `kekurangan`, rumus
   `min_stock - current_stock`.
3. **Filter Rows**: kolom `kekurangan`, operator `>`, nilai `0`.
4. **Sort**: kolom `kekurangan`, turun.
5. Hubungkan ke **Table View** dan **Export CSV** (daftar belanja).

### Resep 4: Margin per produk

`ERP Data` → `Filter Rows` → `Calculated Field` → `Sort` → `Bar Chart`

1. **ERP Data**: Entity **Products**, fields `name`, `selling_price`, `avg_cost`.
2. **Filter Rows**: `selling_price` `>` `0` (menghindari pembagian dengan nol).
3. **Calculated Field**: `margin_persen` = `(selling_price - avg_cost) / selling_price * 100`.
4. **Sort**: `margin_persen`, turun.
5. **Bar Chart**: kategori `name`, nilai `margin_persen`.

Produk tanpa `avg_cost` (belum punya riwayat biaya) menghasilkan nilai kosong.
Isi dulu biaya produk di menu Products.

### Resep 5: Pemeriksaan kualitas data pelanggan

`ERP Data` → `Validate Data` → `Table View`

1. **ERP Data**: Entity **Customers**, fields `name`, `email`, `city`.
2. **Validate Data**: kolom wajib `name,email`, kunci unik `email`, aksi
   **report**.
3. **Table View** menampilkan hasil. Ringkasan masalah (baris tidak lengkap,
   kunci ganda) ada di metadata hasil.

Ganti aksi ke **exclude** kalau kamu ingin baris bermasalah dibuang sebelum
langkah berikutnya.

### Resep 6: Dasbor yang diperbarui otomatis

1. Susun **ERP Summary** (misalnya penjualan per hari) dengan **KPI Value** dan
   **Bar Chart**.
2. **Save**, lalu **Publish** (bagian 6).
3. Buka halaman workflow dan nyalakan **Auto-refresh 1 min** (bagian 7).
   Biarkan tab terbuka di layar.

## 6. Versi: draf dan terbit

- Perubahan yang kamu simpan adalah **draf**.
- **Publish** (Terbitkan) membuat **versi bernomor** yang tidak bisa diubah
  (v1, v2, ...). Status di bilah versi: *Not published*, *Published v2*,
  *Draft differs from published v2*, atau *Draft matches published v2*.
- Tombol **Versions** menampilkan semua versi. Kamu bisa menerbitkan versi
  lama lagi dan menjalankan versi terbit.
- Gunakan versi terbit untuk laporan yang dipakai orang lain, dan draf untuk
  bereksperimen.

## 7. Auto-refresh

Tombol **Auto-refresh 1 min** di toolbar editor menjalankan workflow lagi **tiap
menit**, selama halaman terbuka dan tabnya terlihat.

- Ini hampir real-time, bukan dorongan dari server. **Kalau halaman ditutup atau
  tab di latar belakang, tidak ada yang berjalan.**
- Yang dijalankan adalah yang terakhir kamu jalankan: draf tersimpan atau versi
  terbit. Auto-refresh tidak pernah menyimpan.
- Dijeda kalau ada perubahan yang belum disimpan atau ada masalah di diagram.
- **Berhenti sendiri setelah 3 kegagalan berturut-turut.** Periksa langkahnya,
  lalu nyalakan lagi.
- Database menolak refresh yang kurang dari 45 detik setelah refresh
  sebelumnya, dan hanya menyimpan 100 riwayat auto-refresh terbaru per pengguna
  per workflow.
- Setiap refresh adalah satu kali jalan oleh kamu. Pakai **ERP Summary** untuk
  dasbor karena dihitung di database dan ringan. **ERP Data** membaca sampai
  5.000 baris tiap kali.

## 8. Riwayat jalan

Panel **Run history** mencatat setiap jalan: status, waktu mulai dan selesai,
versi, siapa yang menjalankan, pemicu (manual atau auto-refresh), jumlah baris,
dan hitungan masalah kualitas data. **Isi data hasil tidak disimpan** di riwayat.
Jalan auto-refresh disembunyikan kecuali kamu mencentang
**Show auto-refresh runs**.

## 9. Aturan yang menjaga angka tetap jujur

ETNA menolak atau menandai hal-hal yang menghasilkan angka salah:

| Situasi | Yang terjadi |
|---|---|
| Menjumlahkan kolom milik catatan induk yang berulang di tiap baris (misalnya saldo pelanggan pada tiap invoice) | **Ditolak**: jumlah dan rata-rata akan berlipat |
| Join dengan kunci kanan yang berulang | **Ditolak**: baris akan berlipat ganda |
| Join dengan kunci yang jenisnya berbeda | **Ditolak** |
| Menjumlah uang dalam mata uang dokumen lintas mata uang | Baris campuran **dikosongkan** dengan peringatan. Kelompokkan per mata uang atau pakai jumlah mata uang dasar |
| Total dari **ERP Data** yang tidak membaca semua baris yang cocok | Ditandai **partial** |
| Rata-rata, minimum, maksimum dari nilai yang semuanya kosong | Hasilnya **kosong**, bukan 0 |
| Catatan void atau dibatalkan | Tidak ikut dihitung di **ERP Summary** kecuali dipilih |

Kalau datamu lebih dari 5.000 baris dan butuh total yang benar, pakai
**ERP Summary**, bukan **ERP Data** diikuti **Aggregate**.

## 10. Batas yang berlaku

| Hal | Batas |
|---|---|
| Baris **ERP Data** | bawaan 1.000, maksimal 5.000 |
| Kolom per **ERP Data** | 60 |
| Filter per sumber | 20 |
| Nilai di filter "salah satu dari" | 100 |
| Group by **ERP Summary** | 3 |
| Measures **ERP Summary** | 8 |
| Baris **ERP Summary** | bawaan 200, maksimal 1.000 |
| Panjang rumus | 500 karakter |
| Jalan bersamaan per pengguna | 3 |
| Waktu satu jalan | langkah baru berhenti dimulai setelah 8 detik |

## 11. Keamanan dan izin

- Setiap jalan membaca data **workspace** workflow itu dengan **peran kamu
  sendiri**. Keanggotaan dan izin baca tiap jenis data diperiksa, lalu database
  menerapkan row-level security.
- Orang di luar workspace tidak bisa melihat, menjalankan, atau mengintip
  workflow-nya.
- Workflow **hanya membaca**. Tidak ada langkah yang menulis ke data ERP.
- Riwayat tidak menyimpan hasil, hanya status dan metadata.

## 12. Kalau ada masalah

| Gejala | Penyebab dan solusi |
|---|---|
| Node berwarna merah, pesan tentang kolom | Nama kolom salah atau tidak ada di input. Jalankan node sebelumnya, lalu pilih kolom dari daftar yang ditampilkan |
| "Tidak ada input" | Node belum dihubungkan ke node sebelumnya. Tarik garisnya |
| Join minta dua input | **Join Tables** butuh dua sumber; hubungkan keduanya |
| Kolom `customer.name` tidak ketemu di rumus | Tulis `[customer.name]` dengan kurung siku |
| Total hasil ditandai *partial* | Sumber membaca kurang dari semua baris yang cocok. Perkecil filter atau pakai **ERP Summary** |
| Baris campuran mata uang kosong | Tambahkan `currency` ke Group by, atau saring satu mata uang |
| Auto-refresh berhenti sendiri | Tiga kali gagal berturut-turut. Perbaiki lalu nyalakan lagi |
| Auto-refresh tidak jalan di malam hari | Memang begitu: halamannya harus terbuka dan terlihat |
| Tidak melihat menu Workflows | Peran kamu (Sales atau Inventory) tidak punya akses. Minta Owner mengubah perannya |
| Tidak bisa mengubah workflow orang lain | Hanya pembuatnya yang bisa mengubah. Pakai **Duplicate** untuk membuat salinanmu |
| Data weighbridge atau produksi tidak ada di daftar | Belum ada di katalog analitik. Pakai halaman modulnya (laporan periode) |

## 13. Tips

- Mulai dari **ERP Summary** untuk angka total, dan **ERP Data** untuk daftar
  rinci.
- Pilih kolom **terkait** di ERP Data (misalnya `customer.name`) daripada
  **Join Tables**; hasilnya lebih aman karena tidak melipatgandakan baris.
- Saring sedini mungkin (di sumber) supaya baris yang diproses lebih sedikit.
- Beri nama node dan workflow yang jelas, dan terbitkan versi untuk laporan
  yang dipakai tim.
- Gunakan **Validate Data** sebelum menghitung kalau datanya diimpor atau diisi
  banyak orang.

## Dokumen terkait

- [WORKFLOWS.md](WORKFLOWS.md): referensi teknis, aturan keamanan, hal yang belum didukung
- [ROLES.md](ROLES.md): siapa boleh melihat apa
- [ONTOLOGY.md](ONTOLOGY.md): ontologi ERP dan halaman pencarian (ERP, Search)
- [INDUSTRY-MODULES.md](INDUSTRY-MODULES.md): modul quarry dan payroll
