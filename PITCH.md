# OddsGlance — Demo Day pitch notes (jawaban untuk masukan Danel, TVM Ventures)

Ditulis 27 Nov 2026, setelah Danel (organizer Heads Up, Even Realities
Hackathon) mengirim 4 masukan soal OddsGlance (BUIDL 51723, Under Review).
Poin 1–2 dijawab dengan fitur yang dibangun; poin 3–4 dijawab di bawah
ini sebagai bahan demo — bukan janji produk yang belum ada.

## Yang berubah sejak masukan Danel (dibangun 27 Nov 2026)

### 1. "App cuma nunjukin 8 market terpanas — gimana user ngikutin satu market yang dia peduli kalau tidak masuk top 8?"

**Dibangun: Watchlist (follow) + paging.**
- Di layar Detail, satu tap "☆ Follow this market" — market itu
  dipin di baris paling atas layar Markets dengan tanda ★ dan odds live,
  seberapa pun jauhnya ia di ranking volume.
- "More markets ↓" di bawah daftar: paging lewat keyset cursor Gamma,
  8 market tambahan tiap tap (8 → 16 → 24 …), jadi user bisa menjelajah
  ranking volume dan follow market apa pun yang ia temukan.
- Watchlist tersimpan on-device (maks 20), terpisah dari dana paper.
- Jujur soal batas: Gamma API tidak punya endpoint search (parameter
  `search` diabaikan server — dicek live 27 Nov 2026), jadi menemukan
  market dilakukan lewat paging ranking volume, bukan pencarian teks.
  Itu batas API-nya, bukan batas aplikasinya.

### 2. "Posisi bergerak banyak saat app tertutup — gimana user tahunya?"

**Dibangun: alerts dua lapis, dengan batas platform yang jujur.**
- **Saat app terbuka:** aturan big-move — posisi yang harganya bergerak
  ≥ 10 poin dari harga masuk memunculkan banner `⚠ ALERT` di layar
  Portfolio dan penghitung `⚠ N alerts` di header Markets. Dicek tiap
  refresh 60 detik.
- **Saat app tertutup:** kacamata tidak bisa push apa pun saat app mati
  (DESIGN.md §4.8 — tidak ada background push di device). Jadi separuh
  fitur ini tinggal di luar kacamata: **Telegram alerts relay**
  (`tools/telegram-alerts/`, Node tanpa dependensi). Relay mem-poll Gamma
  dengan aturan 10-poin yang sama dan mengirim satu pesan Telegram per
  pergerakan besar, lalu re-baseline supaya tidak spam. Setup 5 menit
  (BotFather → token → chat id → `node notify.mjs`). Relay hanya membaca
  odds publik — tanpa wallet, tanpa dana, tanpa akun.
- Yang TIDAK diklaim: tidak ada "push notification HP" dari aplikasinya
  sendiri — itu butuh backend + layanan push yang tidak ada di hackathon
  ini. Telegram relay adalah jawaban yang benar-benar jalan.

## 3. "Ada beberapa build Polymarket minggu ini — apa yang bikin orang betah pakai OddsGlance?"

Pembeda bukan "lebih banyak market" — semua orang membaca Gamma API yang
sama. Pembeda adalah **permukaan dan loop-nya**:

- **Glanceable, bukan dashboard.** Satu layar, satu pertanyaan, satu
  angka. Mengecek odds di kacamata butuh ~2 detik dan nol kali merogoh
  ponsel; build lain adalah dashboard HP/web yang harus dibuka. Untuk
  data yang sifatnya "satu angka", kacamata adalah permukaan yang benar.
- **Read AND write dalam satu tarikan napas.** Lihat odds → satu tap
  pasang paper bet → portfolio langsung menunjukkan PnL live. Tidak ada
  build Polymarket lain di hackathon ini yang menutup loop baca-tulis
  secepat itu di kacamata.
- **Jujur soal data.** Kalau jaringan mati, yang tampil adalah data
  terakhir dengan marker `STALE` — bukan angka yang pura-pura live.
  Market yang sudah close auto-settle di harga final. Kejujuran ini yang
  dipuji Danel (STALE marker + automatic settlement).
- **Loop follow → alert → glance → act.** Inilah jawaban poin 1–2
  digabung: user follow market yang ia peduli, relay memberi tahu saat
  bergerak besar, ia melirik kacamata 2 detik, dan memutuskan. Tidak ada
  build lain yang punya loop tertutup seperti ini.
- **Nol risiko untuk mencoba.** 100% paper trading: tanpa wallet, tanpa
  dana nyata, tanpa API key, tanpa akun. Orang berani mencoba karena
  tidak ada yang bisa hilang.

## 4. "Siapa yang bakal pakai tiap hari dan mau bayar?"

**Pengguna harian:** trader prediction-market yang mengecek odds
berkali-kali sehari — mereka yang sudah hidup di Polymarket dan bosan
merogoh ponsel tiap kali mau melihat satu angka. Lapisan kedua:
penggemar olahraga/berita yang mengikuti 2–3 market spesifik (timnya,
pemilu, Fed) dan mau diberi tahu hanya saat ada pergerakan besar —
mereka tidak mau dashboard, mereka mau ketukan di bahu saat penting.

**Model bayar (freemium, jujur soal status):**
- Gratis selamanya: top-8 live, detail, paper bet, portfolio, watchlist.
- Pro (langganan): hosted Telegram alerts relay (tanpa perlu menjalankan
  server sendiri), watchlist tanpa batas, ambang alert yang bisa diatur
  per market, beberapa portfolio paper. Ini yang dijual — **kenyamanan
  dan ketenangan**, bukan akses ke data (datanya publik dan gratis).
- Yang TIDAK dijual: tidak ada real-money betting di aplikasi, tidak ada
  komisi trading, tidak ada penjualan data. Aplikasi ini tidak pernah
  menyentuh dana nyata — dan itu disengaja, karena sekali menyentuh dana
  nyata, kepercayaan dan regulasinya berubah total.

## Batas yang masih terbuka (dicatat jujur)

- Persistensi di simulator: `setLocalStorage` milik bridge simulator
  bersifat per-sesi — setelah simulator dimatikan penuh, portfolio dan
  watchlist kembali segar (terverifikasi 27 Nov 2026: bet $25 No @ 89%
  + follow ★ hilang setelah restart penuh; dalam satu sesi persistensi
  bekerja). Di perangkat G2 asli, `setLocalStorage` adalah API persisten
  resmi Even — verifikasi di perangkat nyata masih terbuka.
- Alert banner live belum tertangkap kamera di simulator (butuh gerakan
  harga live ≥ 10 poin saat sesi QA — tidak terjadi); logika alert
  terverifikasi 51/51 asersi unit + render banner terverifikasi di
  page-object. Relay Telegram terverifikasi end-to-end (dry-run).
- Demo video saat ini adalah slideshow screenshot (103 detik); cuplikan
  watchlist/alerts ada sebagai screenshot QA baru (05–09), belum
  dirangkai ke video baru.
