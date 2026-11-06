import type { ProductNeed, SeedProductWords } from './product-catalog';

/**
 * **The seed products' words in Bahasa Indonesia, part A** (UI V1, UI-107; Phase 18.11 T13): the first sixteen of
 * `SEED_PRODUCTS`, field for field, and the eight needs' replies. Served to a reader in Indonesian wherever a company
 * still holds the platform's English word for word (`modules/products/product-words.ts`); a word a company or an office
 * typed is shown as typed. Translated for the product owner's review before release.
 */
export const SEED_REPLY_BY_NEED_ID: Readonly<Record<ProductNeed, string>> = {
  'life-protection':
    'Saya mengerti, tidak ada yang ingin tagihan bertambah. Tapi ini sebenarnya bukan soal menambah asuransi. ' +
    'Ini soal memastikan orang-orang yang bergantung pada Bapak/Ibu tetap bisa melanjutkan hidup jika Bapak/Ibu ' +
    'tiba-tiba tidak ada. Boleh saya tunjukkan gambarannya untuk keluarga Bapak/Ibu, supaya Bapak/Ibu bisa ' +
    'memutuskan sendiri apakah ini sepadan?',
  health:
    'Bagus sekali, saya senang Bapak/Ibu sudah punya perlindungan. Boleh saya tanya: apa yang terjadi dengan ' +
    'perlindungan itu saat Bapak/Ibu pindah kerja atau pensiun? Asuransi kantor itu pinjaman, bukan milik sendiri. ' +
    'Ini tentang punya perlindungan yang tetap milik Bapak/Ibu di mana pun bekerja.',
  ci:
    'Saya juga berharap Bapak/Ibu tidak pernah perlu memakainya. Sejujurnya, justru itu intinya. Ini bukan soal ' +
    'mengharapkan yang terburuk. Ini soal memastikan, jika hal itu terjadi, Bapak/Ibu tidak perlu memikirkan uang ' +
    'dan bisa fokus pada pemulihan.',
  accident:
    'Senang mendengarnya. Tapi apakah Bapak/Ibu tahu persis apa saja yang ditanggung? Banyak orang baru tahu ' +
    'detailnya saat sudah mengajukan klaim. Ini hanya cara untuk memastikan tidak ada kejutan jika sesuatu terjadi.',
  education:
    'Itu kebiasaan yang bagus, dan saya sangat menghargainya. Satu hal yang tidak bisa dijamin oleh tabungan saja ' +
    'adalah jika terjadi sesuatu pada Bapak/Ibu di tengah jalan. Ini memastikan pendidikan anak Bapak/Ibu tetap ' +
    'berjalan, apa pun yang terjadi.',
  investment:
    'Pertanyaan yang wajar. Saya pun ingin memahaminya sebelum menaruh uang. Boleh saya tunjukkan cara kerja ' +
    'pilihan fund-nya, supaya Bapak/Ibu bisa melihat persis seberapa besar risikonya dan memilih yang membuat ' +
    'Bapak/Ibu nyaman?',
  retirement:
    'Saya sering mendengar itu, rasanya memang belum mendesak. Tapi justru itu alasan terbaik untuk mulai sekarang: ' +
    'makin awal Bapak/Ibu mulai, makin kecil biaya per bulan untuk mencapai tujuan yang sama nanti. Ini bukan soal ' +
    'pensiun besok. Ini soal membuat Bapak/Ibu di masa depan jauh lebih tenang.',
  legacy:
    'Bagus sekali, bebas utang sudah membuat Bapak/Ibu selangkah lebih maju. Tapi ini sebenarnya bukan soal utang. ' +
    'Ini soal apa yang ingin Bapak/Ibu tinggalkan untuk orang-orang tercinta, dengan cara Bapak/Ibu sendiri. ' +
    'Anggap ini bukan sekadar asuransi, tapi hadiah yang Bapak/Ibu siapkan sejak sekarang.',
};

/* The customer's objection, one per need, and the one benefit several products share word for word. */
const SAYS_LIFE = 'Kedengarannya lebih besar dari yang sudah saya bayar untuk asuransi sekarang.';
const SAYS_HEALTH = 'Saya sudah punya asuransi kesehatan dari kantor.';
const SAYS_RETIREMENT = 'Pensiun masih terlalu jauh untuk dipikirkan sekarang.';
const SAYS_LEGACY = 'Saya tidak perlu asuransi jiwa, saya tidak punya utang.';
const NO_MEDICAL_EXAM = 'Tanpa pemeriksaan kesehatan hingga premi tahunan Rp250 juta.';

/*
 * Each product's words that the seed repeats: `bestFor` is `goodFit`, the attack plan's benefits are the product's,
 * and the full script opens with `opening` and ends with `nextAction`. One constant each keeps them identical.
 */

// PRUMapan
const MAPAN_FIT = 'Milenial dan Gen Z generasi sandwich yang sedang membangun kepastian keuangan jangka panjang.';
const MAPAN_OPENING =
  'Menyiapkan penghasilan pensiun di tengah kebutuhan sehari-hari memang tidak mudah, apalagi saat Bapak/Ibu ' +
  'menanggung anak sekaligus orang tua.';
const MAPAN_NEXT =
  'Boleh saya siapkan ilustrasi yang menunjukkan pembayaran Dana Mapan persisnya untuk besar premi Bapak/Ibu?';
const MAPAN_BENEFITS: readonly string[] = [
  'Manfaat Dana Mapan dibayarkan setiap tahun dari usia 55 sampai 75 (21 kali), total hingga sekitar 5,8× ' +
    'premi tahunan.',
  'Perlindungan meninggal dunia (sebab alami maupun kecelakaan), dengan tambahan manfaat meninggal karena ' +
    'kecelakaan hingga +100% (maksimal Rp2 miliar).',
  'Premi mulai sekitar Rp200 ribu/bulan; dirancang untuk milenial dan Gen Z.',
  NO_MEDICAL_EXAM,
  'Pilihan mempercepat Dana Mapan mulai usia 45 (atau setelah 11 kali pembayaran premi).',
];

// PRUSmart Plan
const SMART_FIT = 'Keluarga berpenghasilan menengah dengan tujuan keuangan 20 tahun yang jelas.';
const SMART_OPENING =
  'Bapak/Ibu tadi bilang ingin perlindungan yang juga mengembalikan lebih dari yang Bapak/Ibu setorkan.';
const SMART_NEXT =
  'Apakah Bapak/Ibu ingin ilustrasi dengan jadwal manfaat tunai persisnya untuk besar premi Bapak/Ibu?';
const SMART_BENEFITS: readonly string[] = [
  'Masa pembayaran premi singkat: 6 atau 8 tahun untuk perlindungan 20 tahun.',
  'Manfaat tunai tahunan sekitar 25% dari premi tahunan, naik setiap tahun mulai tahun polis ke-7 atau ke-9.',
  'Manfaat tunai akhir masa polis hingga sekitar 920% dari premi tahunan.',
  'Manfaat meninggal dunia 100%–150% dari premi tahunan, tergantung masa pembayaran premi yang dipilih.',
  NO_MEDICAL_EXAM,
];

// PRUFuture
const FUTURE_FIT =
  'Nasabah yang memperhatikan biaya dan ingin asuransi jiwa jangka panjang dengan fleksibilitas mata uang.';
const FUTURE_OPENING =
  'Keuntungan memulai asuransi jiwa seumur hidup sekarang, selagi Bapak/Ibu sehat, adalah preminya terkunci ' +
  'dan tetap terjangkau.';
const FUTURE_NEXT = 'Apakah Bapak/Ibu ingin melihat perbandingan keduanya secara berdampingan?';
const FUTURE_BENEFITS: readonly string[] = [
  'Perlindungan hingga usia 100.',
  'Uang pertanggungan minimal Rp500 juta / USD 50.000.',
  'Masa pembayaran premi 5, 10, atau 15 tahun.',
  'Pilihan Plan Waiver: pembebasan pembayaran premi jika tertanggung didiagnosis penyakit kritis selama masa ' +
    'pembayaran premi.',
  'Tersedia dalam Rupiah dan USD.',
];

// PRUWarisan
const WARISAN_FIT = 'Nasabah mapan yang merencanakan pengalihan kekayaan antargenerasi.';
const WARISAN_OPENING =
  'Yang Bapak/Ibu ceritakan, memastikan ada sesuatu yang kokoh untuk diwariskan ke anak-anak, persis tujuan ' +
  'PRUWarisan dibuat.';
const WARISAN_NEXT =
  'Boleh saya siapkan proyeksi nilai warisan di usia 99 untuk uang pertanggungan yang Bapak/Ibu inginkan?';
const WARISAN_BENEFITS: readonly string[] = [
  'Perlindungan jiwa hingga usia 99.',
  'Masa pembayaran premi 5, 10, atau 15 tahun (setelah itu polis bebas premi).',
  'PRUWarisan Booster menaikkan uang pertanggungan secara bertahap dari waktu ke waktu.',
  '100% uang pertanggungan + Booster saat meninggal dunia, dikurangi kewajiban yang masih ada.',
  'Manfaat akhir polis jika tertanggung hidup hingga usia 99.',
];

// PRUAnugerah
const ANUGERAH_FIT =
  'Profesional menjelang pensiun yang ingin pembayaran pensiun terstruktur tanpa risiko pasar unit link.';
const ANUGERAH_OPENING =
  'Nasabah menjelang pensiun seperti Bapak/Ibu sering ingin satu produk yang mencakup perlindungan jiwa sekaligus ' +
  'pembayaran pensiun terstruktur, bukan dua polis terpisah.';
const ANUGERAH_NEXT =
  'Apakah Bapak/Ibu ingin melihat proyeksi bagaimana perlindungan dan pembayaran pensiunnya bertumbuh selama ' +
  'sisa tahun kerja Bapak/Ibu?';
const ANUGERAH_BENEFITS: readonly string[] = [
  'Perlindungan jiwa jangka panjang yang digabung dengan fitur penghasilan pensiun.',
  'Pembayaran terstruktur yang diarahkan untuk kebutuhan dana di masa pensiun.',
  'Manfaat meninggal dunia dan manfaat hidup sepanjang masa polis.',
  'Unsur perlindungan keluarga di samping fokus pada pensiun.',
];

// PRUHeritage Syariah
const HERITAGE_FIT = 'Nasabah muslim mapan yang merencanakan warisan lintas generasi.';
const HERITAGE_OPENING =
  'Perencanaan warisan lintas generasi sesuai prinsip syariah punya ketentuan khusus, dan PRUHeritage Syariah ' +
  'dibuat untuk memenuhinya.';
const HERITAGE_NEXT = 'Boleh saya siapkan ilustrasi dalam Rupiah dan USD?';
const HERITAGE_BENEFITS: readonly string[] = [
  'Perlindungan seumur hidup sesuai prinsip syariah hingga usia 100.',
  'Pilihan premi yang memadukan masa pembayaran singkat dengan masa perlindungan panjang.',
  'Tersedia versi mata uang USD untuk perencanaan warisan dalam mata uang kuat.',
  'Akumulasi nilai tunai dengan pengelolaan syariah; struktur tabarru dan ujrah.',
];

// PRUCinta
const CINTA_FIT =
  'Keluarga muslim muda yang ingin perlindungan syariah yang kuat untuk risiko meninggal karena kecelakaan ' +
  'saat mudik Ramadan.';
const CINTA_OPENING = 'Bagi keluarga muslim muda, Ramadan membawa fokus ibadah sekaligus banyak perjalanan mudik.';
const CINTA_NEXT =
  'Apakah Bapak/Ibu ingin ilustrasi yang menghitung manfaat meninggal karena kecelakaan untuk uang pertanggungan ' +
  'pilihan Bapak/Ibu?';
const CINTA_BENEFITS: readonly string[] = [
  'Perlindungan syariah selama 20 tahun.',
  '100% uang pertanggungan + nilai tunai saat meninggal dunia.',
  '300% uang pertanggungan + nilai tunai jika meninggal karena kecelakaan sebelum usia 70.',
  '400% jika meninggal karena kecelakaan dalam periode 6 minggu Ramadan setiap tahun.',
  'Kontribusi tabarru\' sebesar 17% dari kontribusi yang dibayar.',
];

// PRUAnugerah Syariah
const ANUGERAH_SYARIAH_FIT = 'Nasabah muslim kelas menengah yang membangun warisan secara bertahap.';
const ANUGERAH_SYARIAH_OPENING = 'Merencanakan warisan tidak harus menunggu sampai Bapak/Ibu mapan.';
const ANUGERAH_SYARIAH_NEXT =
  'Apakah Bapak/Ibu ingin membandingkan keduanya secara berdampingan pada besar kontribusi pilihan Bapak/Ibu?';
const ANUGERAH_SYARIAH_BENEFITS: readonly string[] = [
  'Perlindungan jiwa jangka panjang sesuai prinsip syariah.',
  'Pembentukan nilai tunai dengan struktur tabarru / mudharabah.',
  'Struktur pembayaran yang berfokus pada warisan untuk ahli waris.',
  'Kontribusi awal terjangkau, mulai sekitar Rp500 ribu/bulan.',
];

// PRUTect Care
const TECT_FIT = 'Pembeli asuransi pertama kali yang melek teknologi di pasar massal.';
const TECT_OPENING =
  'Bapak/Ibu lebih suka mengurus ini secara digital tanpa pertemuan panjang dengan agen, dan itulah yang ' +
  'ditawarkan PRUTect Care.';
const TECT_NEXT = 'Untuk sekarang, boleh saya pandu Bapak/Ibu menyiapkannya di OVO?';
const TECT_BENEFITS: readonly string[] = [
  'Dipasarkan melalui aplikasi dompet digital OVO.',
  'Santunan tunai saat menjalani rawat inap di rumah sakit.',
  'Perlindungan syariah yang sederhana dengan proses underwriting yang minim hambatan.',
  'Dirancang untuk pembeli asuransi digital pertama kali.',
];

// PRUTahapan Cemerlang
const TAHAPAN_FIT = 'Nasabah syariah yang ingin perlindungan yang ikut berkembang seiring peristiwa hidup.';
const TAHAPAN_OPENING =
  'Produk ini disusun untuk perlindungan syariah yang menyesuaikan saat Bapak/Ibu menikah, punya anak, dan ' +
  'melewati peristiwa hidup lainnya.';
const TAHAPAN_NEXT = 'Boleh saya petakan produk ini dengan rencana tahapan hidup Bapak/Ibu dalam 10 tahun ke depan?';
const TAHAPAN_BENEFITS: readonly string[] = [
  'Perlindungan jiwa syariah yang disusun mengikuti tahapan hidup.',
  'Manfaat yang menyesuaikan saat peserta melewati peristiwa-peristiwa dalam hidupnya.',
  'Pengelolaan dana sesuai syariah dengan kontribusi tabarru.',
  'Dirancang sebagai pelengkap produk syariah lain dalam portofolio keluarga.',
];

// PRUSehat
const SEHAT_FIT =
  'Nasabah yang ingin perlindungan kesehatan yang membayar tagihan rumah sakit secara langsung, dengan hadiah ' +
  'jika tidak klaim.';
const SEHAT_OPENING =
  'Bapak/Ibu ingin asuransi kesehatan yang langsung membayar tagihan rumah sakit tanpa ribet, dan PRUSehat ' +
  'memberikan itu.';
const SEHAT_NEXT = 'Boleh saya buatkan ilustrasi dengan plan yang sesuai rumah sakit dan kamar pilihan Bapak/Ibu?';
const SEHAT_BENEFITS: readonly string[] = [
  '8 pilihan plan berdasarkan jenis kamar, batas harga kamar, dan wilayah.',
  'Penggantian rawat inap sesuai tagihan.',
  'Limit tahunan hingga Rp65 miliar dengan Limit Booster.',
  'Rawat jalan 30 hari sebelum dan 90 hari setelah operasi ditanggung.',
  'Pengobatan kanker dan cuci darah rawat jalan ditanggung tanpa harus rawat inap dulu.',
  'No Claim Bonus: limit tahunan naik 10% setiap tahun tanpa klaim, maksimal +50%.',
];

// PRUWell Medical
const WELL_MEDICAL_FIT =
  'Nasabah yang peduli kesehatan dan mau aktif menjaga gaya hidup sehat demi hemat premi yang berkelanjutan.';
const WELL_MEDICAL_OPENING =
  'Bapak/Ibu peduli kesehatan, dan hadiah gaya hidup sehat di PRUWell Medical mengubahnya langsung menjadi ' +
  'hemat premi.';
const WELL_MEDICAL_NEXT =
  'Apakah Bapak/Ibu ingin ilustrasi yang menunjukkan perkiraan premi Bapak/Ibu setelah diskon gaya hidup sehat?';
const WELL_MEDICAL_BENEFITS: readonly string[] = [
  'Fitur keadilan PRUWell: diskon premi hingga 20% di tahun berikutnya berdasarkan gaya hidup sehat dan ' +
    'riwayat klaim.',
  'Plan dari Bronze A hingga Diamond, dengan fleksibilitas wilayah, jenis kamar, dan batas harga kamar.',
  'Manfaat tahunan hingga Rp72,5 miliar dengan Limit Booster.',
  'Telehealth di Indonesia; telehealth kanker di Malaysia dan Singapura (plan tertentu).',
  'Perawatan paliatif, pengobatan tradisional, fisioterapi, terapi okupasi, dan terapi wicara.',
];

// PRUWell Health
const WELL_HEALTH_FIT =
  'Pemegang polis PAYDI yang ingin menyatukan asuransi kesehatan berbasis gaya hidup sehat dalam satu laporan.';
const WELL_HEALTH_OPENING =
  'Karena Bapak/Ibu sudah punya polis dasar PAYDI, langkah yang cerdas adalah menambah perlindungan kesehatan ' +
  'yang dibayar dari nilai tunai yang sudah ada.';
const WELL_HEALTH_NEXT = 'Boleh saya buatkan gambaran bagaimana ini dilekatkan ke polis PAYDI Bapak/Ibu saat ini?';
const WELL_HEALTH_BENEFITS: readonly string[] = [
  'Tabel manfaat dan mekanisme PRUWell yang sama dengan PRUWell Medical.',
  'Dilekatkan sebagai rider pada polis dasar unit link (PAYDI); biaya asuransi dibayar dari nilai tunai.',
  'Bisa cuti premi setelah nilai tunai polis mencukupi.',
  'Usia masuk hingga 75; manfaat tahunan hingga Rp72,5 miliar.',
];

// PRUPrime Healthcare Plus Pro
const PRIME_FIT =
  'Pemegang polis PAYDI yang ingin perlindungan tagihan rumah sakit dan operasi tingkat teratas.';
const PRIME_OPENING =
  'Bagi nasabah yang ingin perlindungan rumah sakit kelas atas dalam satu paket dengan polis unit link-nya, ' +
  'inilah rider PAYDI paling atas di katalog.';
const PRIME_NEXT =
  'Apakah Bapak/Ibu ingin membandingkan keduanya dengan pilihan kamar dan wilayah yang biasa Bapak/Ibu gunakan?';
const PRIME_BENEFITS: readonly string[] = [
  'Plan Bronze A hingga Diamond dengan tingkatan kamar dan wilayah.',
  'Rawat inap sesuai tagihan, termasuk fleksibilitas tarif kamar untuk 2 kelas kamar terendah.',
  'Klaim pro-rata jika tertanggung dirawat di kelas kamar lebih tinggi atau berobat di luar wilayah.',
  'PRUPrime Limit Booster menaikkan batas tahunan.',
  'Perlindungan dapat diperpanjang hingga usia 99 (dalam polis dasar PAYDI).',
];

// PRUSehat Syariah
const SEHAT_SYARIAH_FIT =
  'Nasabah muslim yang ingin asuransi kesehatan as-billed yang sederhana dengan tata kelola syariah.';
const SEHAT_SYARIAH_OPENING =
  'Untuk asuransi kesehatan syariah yang membayar tagihan rumah sakit, PRUSehat Syariah mengikuti struktur ' +
  'PRUSehat konvensional, dengan 8 tingkat plan dan batas tahunan Rp65 miliar yang sama.';
const SEHAT_SYARIAH_NEXT = 'Boleh saya hitungkan proyeksi pengembalian surplus pada tingkat plan pilihan Bapak/Ibu?';
const SEHAT_SYARIAH_BENEFITS: readonly string[] = [
  'Struktur 8 plan, fleksibilitas kamar dan wilayah yang sama dengan PRUSehat.',
  'Rawat inap sesuai tagihan, limit tahunan hingga Rp65 miliar dengan Limit Booster.',
  'Kanker dan cuci darah rawat jalan ditanggung tanpa harus rawat inap dulu.',
  'Surplus underwriting: sebagian dana tabarru yang tidak terpakai dikembalikan kepada peserta jika tidak ada ' +
    'klaim (jika tersedia).',
  'Manfaat Berkembang: limit tahunan bertambah 10% jika tidak ada klaim, hingga 50% dari limit awal.',
];

// PRUWell Medical Syariah
const WELL_MEDICAL_SYARIAH_FIT =
  'Nasabah muslim yang peduli kesehatan dan ingin asuransi kesehatan syariah dengan harga berbasis gaya hidup sehat.';
const WELL_MEDICAL_SYARIAH_OPENING = 'Mekanisme hadiah gaya hidup sehat di PRUWell Medical Syariah sesuai syariah:';
const WELL_MEDICAL_SYARIAH_NEXT =
  'Boleh saya buatkan ilustrasi yang menunjukkan diskon kontribusi gaya hidup sehat untuk plan pilihan Bapak/Ibu?';
const WELL_MEDICAL_SYARIAH_BENEFITS: readonly string[] = [
  'Fitur keadilan PRUWell yang sama: diskon kontribusi tahun berikutnya hingga 20%.',
  'Pilihan plan, fleksibilitas kamar dan wilayah yang sama, batas Rp72,5 miliar dengan Limit Booster.',
  'Telehealth Indonesia serta telehealth kanker Malaysia dan Singapura (plan tertentu).',
  'Pengelolaan dana syariah dengan struktur tabarru / ujrah.',
];

export const SEED_PRODUCTS_ID_A: Readonly<Record<string, SeedProductWords>> = {
  PRUMAPAN: {
    tagline: 'Asuransi jiwa model dwiguna dengan dana pensiun terjamin yang cair dari usia 55.',
    benefits: MAPAN_BENEFITS,
    differentiator:
      'Pilihan penghasilan pensiun yang terjangkau (mulai sekitar Rp200 ribu). Struktur Dana Mapan 21 kali ' +
      'memberi penghasilan terjadwal dari usia 55 sampai 75, hingga 5,8× premi tahunan. Produk pendampingnya, ' +
      'PRUAnugerah, adalah produk pensiun konvensional untuk segmen mapan, dengan posisi gabungan jiwa + pensiun.',
    bestFor: MAPAN_FIT,
    defaultAttackPlan: {
      goodFit: MAPAN_FIT,
      opening: MAPAN_OPENING,
      benefits: MAPAN_BENEFITS,
      fullScript:
        MAPAN_OPENING +
        ' PRUMapan dibuat persis untuk situasi itu. Mulai sekitar Rp200 ribu per bulan, Bapak/Ibu membangun ' +
        'perlindungan yang membayar kembali setiap tahun dari usia 55 sampai 75. Itu 21 kali penghasilan terjamin, ' +
        'hingga sekitar 5,8 kali premi tahunan yang Bapak/Ibu bayarkan. Dibandingkan PRUAnugerah, yang ditujukan ' +
        'untuk nasabah mapan yang ingin gabungan jiwa dan pensiun di tingkat lebih tinggi, PRUMapan dimulai dari ' +
        'posisi kebanyakan profesional milenial dan Gen Z saat ini. ' +
        MAPAN_NEXT,
      objectionTheySay: SAYS_RETIREMENT,
      nextAction: MAPAN_NEXT,
    },
  },
  PRUSMART_PLAN: {
    tagline: 'Dwiguna 20 tahun, uang kembali lebih besar dari premi yang dibayar.',
    benefits: SMART_BENEFITS,
    differentiator:
      'Pilihan asuransi jiwa yang berfokus pada pembayaran tunai: masa pembayaran premi paling singkat (6 atau ' +
      '8 tahun) untuk perlindungan penuh 20 tahun, dengan manfaat akhir polis yang secara hitungan lebih besar dari ' +
      'total premi yang dibayar. PRUFuture adalah alternatif konvensional seumur hidup; PRUCinta adalah alternatif ' +
      'syariah 20 tahun.',
    bestFor: SMART_FIT,
    defaultAttackPlan: {
      goodFit: SMART_FIT,
      opening: SMART_OPENING,
      benefits: SMART_BENEFITS,
      fullScript:
        SMART_OPENING +
        ' PRUSmart Plan disusun persis untuk itu, dalam jangka 20 tahun. Bapak/Ibu hanya membayar 6 atau 8 tahun; ' +
        'polisnya melindungi selama 20 tahun. Mulai tahun ke-7 atau ke-9, Bapak/Ibu mulai menerima manfaat tunai ' +
        'tahunan sekitar 25% dari premi, yang naik setiap tahun. Di akhir 20 tahun, Bapak/Ibu menerima manfaat ' +
        'akhir polis yang bisa mencapai 920% dari premi tahunan. Jadi hitungannya jelas: total yang diterima lebih ' +
        'besar dari total premi yang dibayar. Dibandingkan PRUFuture, yang melindungi seumur hidup tetapi tidak ' +
        'membayar tunai di tengah jalan, produk ini memberi hasil bagi Bapak/Ibu yang konsisten menjalankan ' +
        'rencananya. ' +
        SMART_NEXT,
      objectionTheySay: SAYS_LIFE,
      nextAction: SMART_NEXT,
    },
  },
  PRUFUTURE: {
    tagline:
      'Asuransi jiwa seumur hidup yang terjangkau hingga usia 100, dengan pembebasan premi penyakit kritis opsional.',
    benefits: FUTURE_BENEFITS,
    differentiator:
      'Pilihan asuransi jiwa konvensional seumur hidup, dengan pilihan mata uang USD dan pembebasan premi penyakit ' +
      'kritis opsional. Asuransi jiwa seumur hidup paling hemat di katalog. PRUSmart Plan adalah alternatif dwiguna ' +
      '20 tahun; PRUWarisan adalah alternatif khusus warisan.',
    bestFor: FUTURE_FIT,
    defaultAttackPlan: {
      goodFit: FUTURE_FIT,
      opening: FUTURE_OPENING,
      benefits: FUTURE_BENEFITS,
      fullScript:
        FUTURE_OPENING +
        ' PRUFuture memberi perlindungan hingga usia 100 dengan uang pertanggungan minimal Rp500 juta, atau ' +
        'USD 50.000 jika Bapak/Ibu lebih suka mata uang kuat. Bapak/Ibu membayar 5, 10, atau 15 tahun; ' +
        'perlindungannya berlaku seumur hidup. Ada juga pilihan Plan Waiver: jika Bapak/Ibu didiagnosis penyakit ' +
        'kritis selama masa pembayaran premi, premi berikutnya dibebaskan tetapi perlindungan tetap berjalan. ' +
        'PRUSmart Plan adalah alternatif 20 tahun dengan pembayaran tunai; PRUFuture untuk nasabah yang lebih ' +
        'mengutamakan kepastian perlindungan seumur hidup daripada pengembalian tunai terjadwal. ' +
        FUTURE_NEXT,
      objectionTheySay: SAYS_LIFE,
      nextAction: FUTURE_NEXT,
    },
  },
  PRUWARISAN: {
    tagline: 'Asuransi jiwa warisan seumur hidup hingga usia 99 dengan booster uang pertanggungan.',
    benefits: WARISAN_BENEFITS,
    differentiator:
      'Produk warisan konvensional andalan. PRUWarisan Booster terus menumbuhkan nilai warisan dari waktu ke waktu. ' +
      'Padanan syariahnya, PRUHeritage Syariah, berlaku satu tahun lebih lama (hingga usia 100) dengan pilihan USD. ' +
      'PRUAnugerah Syariah adalah alternatif warisan syariah yang lebih terjangkau (mulai sekitar Rp500 ribu).',
    bestFor: WARISAN_FIT,
    defaultAttackPlan: {
      goodFit: WARISAN_FIT,
      opening: WARISAN_OPENING,
      benefits: WARISAN_BENEFITS,
      fullScript:
        WARISAN_OPENING +
        ' Perlindungannya berlaku hingga usia 99. Bapak/Ibu cukup membayar 5, 10, atau 15 tahun; setelah itu polis ' +
        'bebas premi seumur hidup. Keunggulannya adalah PRUWarisan Booster: uang pertanggungan Bapak/Ibu naik ' +
        'bertahap dari waktu ke waktu, sehingga warisannya bertumbuh, bukan tergerus inflasi. Jika Bapak/Ibu ingin ' +
        'alternatif syariah, PRUHeritage Syariah berlaku satu tahun lebih lama hingga usia 100 dan ada pilihan USD. ' +
        WARISAN_NEXT,
      objectionTheySay: SAYS_LEGACY,
      nextAction: WARISAN_NEXT,
    },
  },
  PRUANUGERAH: {
    tagline: 'Gabungan perlindungan jiwa dan penghasilan pensiun; terasa seperti dana pensiun yang terstruktur.',
    benefits: ANUGERAH_BENEFITS,
    differentiator:
      'Produk pensiun konvensional untuk segmen mapan. Posisinya gabungan jiwa + pensiun. Lebih lengkap dari ' +
      'PRUMapan (pilihan pensiun tingkat awal mulai sekitar Rp200 ribu untuk milenial dan Gen Z).',
    bestFor: ANUGERAH_FIT,
    defaultAttackPlan: {
      goodFit: ANUGERAH_FIT,
      opening: ANUGERAH_OPENING,
      benefits: ANUGERAH_BENEFITS,
      fullScript:
        ANUGERAH_OPENING +
        ' PRUAnugerah dibangun untuk kebutuhan gabungan itu. Berbeda dengan produk perlindungan murni, produk ini ' +
        'membangun penghasilan untuk masa pensiun sambil tetap menjaga perlindungan keluarga sepanjang waktu. ' +
        'Dibandingkan PRUMapan, pilihan pensiun tingkat awal sekitar Rp200 ribu per bulan untuk pembeli milenial, ' +
        'PRUAnugerah adalah pilihan perencanaan terpadu untuk segmen mapan. ' +
        ANUGERAH_NEXT,
      objectionTheySay: SAYS_RETIREMENT,
      nextAction: ANUGERAH_NEXT,
    },
  },
  PRUHERITAGE_SYARIAH: {
    tagline: 'Perlindungan warisan syariah jangka panjang hingga usia 100.',
    benefits: HERITAGE_BENEFITS,
    differentiator:
      'Produk warisan dengan masa perlindungan terpanjang di kedua lini, konvensional dan syariah (hingga usia 100). ' +
      'Tersedia dalam USD untuk perencanaan warisan dalam mata uang kuat. Dikelola secara syariah. PRUAnugerah ' +
      'Syariah adalah alternatif warisan syariah untuk tingkat lebih rendah (mulai sekitar Rp500 ribu); PRUWarisan ' +
      'adalah padanan konvensionalnya.',
    bestFor: HERITAGE_FIT,
    defaultAttackPlan: {
      goodFit: HERITAGE_FIT,
      opening: HERITAGE_OPENING,
      benefits: HERITAGE_BENEFITS,
      fullScript:
        HERITAGE_OPENING +
        ' Perlindungannya hingga usia 100, masa perlindungan terpanjang dari semua produk di katalog. Dananya ' +
        'dikelola dengan prinsip tabarru dan ujrah, sehingga strukturnya tetap sesuai syariah sepanjang masa polis. ' +
        'Polisnya juga bisa dalam USD, berguna jika sebagian warisan ditujukan untuk anak yang kuliah atau menetap ' +
        'di luar negeri. Jika keterjangkauan lebih penting daripada masa perlindungan, PRUAnugerah Syariah adalah ' +
        'pilihan warisan syariah tingkat awal mulai sekitar Rp500 ribu per bulan. ' +
        HERITAGE_NEXT,
      objectionTheySay: SAYS_LEGACY,
      nextAction: HERITAGE_NEXT,
    },
  },
  PRUCINTA: {
    tagline:
      'Asuransi jiwa syariah 20 tahun dengan tambahan manfaat meninggal karena kecelakaan saat Ramadan.',
    benefits: CINTA_BENEFITS,
    differentiator:
      'Pilihan asuransi jiwa syariah 20 tahun yang standar, dengan manfaat khas 4× untuk meninggal karena ' +
      'kecelakaan di masa perjalanan Ramadan, yang tidak ada di produk lain dalam katalog. PRUTahapan Cemerlang ' +
      'adalah alternatif syariah bertahap sesuai tahapan hidup; PRUTect Care adalah alternatif syariah digital ' +
      'tingkat awal.',
    bestFor: CINTA_FIT,
    defaultAttackPlan: {
      goodFit: CINTA_FIT,
      opening: CINTA_OPENING,
      benefits: CINTA_BENEFITS,
      fullScript:
        CINTA_OPENING +
        ' PRUCinta memperhitungkan kenyataan itu dengan manfaat meninggal karena kecelakaan 400% selama periode enam ' +
        'minggu Ramadan setiap tahun, dan 300% di luar periode itu. Perlindungannya berlaku 20 tahun dan dikelola ' +
        'secara syariah dengan kontribusi tabarru sebesar 17%. Dibandingkan PRUTahapan Cemerlang, yang menyusun ' +
        'manfaatnya sesuai tahapan hidup, PRUCinta adalah pilihan syariah 20 tahun yang sederhana dengan ' +
        'perlindungan khusus Ramadan yang paling kuat. ' +
        CINTA_NEXT,
      objectionTheySay: SAYS_LIFE,
      nextAction: CINTA_NEXT,
    },
  },
  PRUANUGERAH_SYARIAH: {
    tagline: 'Warisan syariah dengan kontribusi mulai sekitar Rp500 ribu per bulan.',
    benefits: ANUGERAH_SYARIAH_BENEFITS,
    differentiator:
      'Pilihan warisan syariah yang terjangkau (mulai sekitar Rp500 ribu per bulan). Membuat perencanaan warisan ' +
      'terjangkau bagi nasabah muslim kelas menengah mapan. Pilihan tingkat lebih tinggi, PRUHeritage Syariah, ' +
      'berlaku hingga usia 100 dengan mata uang USD.',
    bestFor: ANUGERAH_SYARIAH_FIT,
    defaultAttackPlan: {
      goodFit: ANUGERAH_SYARIAH_FIT,
      opening: ANUGERAH_SYARIAH_OPENING,
      benefits: ANUGERAH_SYARIAH_BENEFITS,
      fullScript:
        ANUGERAH_SYARIAH_OPENING +
        ' PRUAnugerah Syariah membuat perlindungan warisan terjangkau, mulai sekitar Rp500 ribu per bulan. Dananya ' +
        'dikelola dengan prinsip tabarru dan mudharabah, dan nilai tunainya bertumbuh seiring waktu bersama ' +
        'perlindungan jiwanya. Pembayaran kepada ahli waris Bapak/Ibu nantinya disusun sebagai warisan yang sesuai ' +
        'syariah. Pilihan tingkat lebih tinggi adalah PRUHeritage Syariah, yang berlaku hingga usia 100 dan ' +
        'tersedia dalam USD, tetapi ditujukan untuk nasabah mapan. ' +
        ANUGERAH_SYARIAH_NEXT,
      objectionTheySay: SAYS_LEGACY,
      nextAction: ANUGERAH_SYARIAH_NEXT,
    },
  },
  PRUTECT_CARE: {
    tagline: 'Asuransi jiwa syariah digital lewat OVO; santunan tunai rawat inap tingkat awal.',
    benefits: TECT_BENEFITS,
    differentiator:
      'Produk syariah tingkat awal yang sepenuhnya digital. Paling mudah didapat di seluruh katalog; dibeli lewat ' +
      'aplikasi OVO, bukan melalui agen. PRUCinta adalah alternatif syariah 20 tahun yang dipasarkan melalui agen.',
    bestFor: TECT_FIT,
    defaultAttackPlan: {
      goodFit: TECT_FIT,
      opening: TECT_OPENING,
      benefits: TECT_BENEFITS,
      fullScript:
        TECT_OPENING +
        ' Bapak/Ibu membelinya lewat aplikasi OVO: perlindungan jiwa syariah dengan santunan tunai rawat inap, siap ' +
        'dalam hitungan menit. Underwriting-nya disederhanakan, jadi prosesnya mudah. Jika nanti Bapak/Ibu ingin ' +
        'polis jiwa syariah yang lebih lengkap dengan perlindungan kecelakaan yang lebih kuat, PRUCinta dari agen ' +
        'Bapak/Ibu adalah langkah lanjut yang wajar. ' +
        TECT_NEXT,
      objectionTheySay: SAYS_LIFE,
      nextAction: TECT_NEXT,
    },
  },
  PRUTAHAPAN_CEMERLANG: {
    tagline: 'Perlindungan jiwa syariah bertahap mengikuti peristiwa penting dalam hidup.',
    benefits: TAHAPAN_BENEFITS,
    differentiator:
      'Pilihan asuransi jiwa syariah bertahap dengan manfaat yang menyesuaikan peristiwa hidup. PRUCinta adalah ' +
      'alternatif syariah 20 tahun yang standar; PRUTect Care adalah alternatif syariah digital tingkat awal.',
    bestFor: TAHAPAN_FIT,
    defaultAttackPlan: {
      goodFit: TAHAPAN_FIT,
      opening: TAHAPAN_OPENING,
      benefits: TAHAPAN_BENEFITS,
      fullScript:
        TAHAPAN_OPENING +
        ' PRUTahapan Cemerlang menyusun manfaatnya per tahapan hidup, bukan sebagai polis yang statis. Dananya ' +
        'dikelola secara syariah, dan strukturnya memastikan perlindungan ikut berkembang sesuai kebutuhan keluarga ' +
        'yang berubah. Dibandingkan PRUCinta, pilihan syariah 20 tahun yang sederhana, produk ini untuk nasabah yang ' +
        'memperkirakan kebutuhannya akan berubah selama masa polis. ' +
        TAHAPAN_NEXT,
      objectionTheySay: SAYS_LIFE,
      nextAction: TAHAPAN_NEXT,
    },
  },
  PRUSEHAT: {
    tagline: 'Asuransi kesehatan as-billed dengan No Claim Bonus.',
    benefits: SEHAT_BENEFITS,
    differentiator:
      'Pilihan asuransi kesehatan tradisional murni dengan No Claim Bonus dan 8 tingkat plan (paling fleksibel di ' +
      'katalog). Paling mudah untuk mulai di antara produk kesehatan. PRUWell Medical adalah alternatif dengan ' +
      'hadiah gaya hidup sehat; PRUWell Health dan PRUPrime Healthcare Plus Pro adalah versi rider PAYDI.',
    bestFor: SEHAT_FIT,
    defaultAttackPlan: {
      goodFit: SEHAT_FIT,
      opening: SEHAT_OPENING,
      benefits: SEHAT_BENEFITS,
      fullScript:
        SEHAT_OPENING +
        ' Bapak/Ibu memilih dari 8 tingkat plan berdasarkan jenis kamar, batas harga kamar, dan wilayah. Setiap ' +
        'tahun tanpa klaim, limit tahunan Bapak/Ibu naik 10%, maksimal 50%, jadi hidup sehat langsung dihargai. ' +
        'Limit tahunan bisa mencapai Rp65 miliar dengan Limit Booster, dan pengobatan kanker atau cuci darah rawat ' +
        'jalan ditanggung tanpa harus rawat inap dulu. PRUWell Medical adalah alternatifnya jika Bapak/Ibu ingin ' +
        'diskon premi karena aktif menjaga kesehatan; PRUSehat adalah pilihan yang lebih sederhana untuk membayar ' +
        'tagihan rumah sakit. ' +
        SEHAT_NEXT,
      objectionTheySay: SAYS_HEALTH,
      nextAction: SEHAT_NEXT,
    },
  },
  PRUWELL_MEDICAL: {
    tagline: 'Asuransi kesehatan dengan hadiah gaya hidup sehat; diskon premi hingga 20%.',
    benefits: WELL_MEDICAL_BENEFITS,
    differentiator:
      'Pilihan asuransi kesehatan tradisional dengan harga yang mengikuti gaya hidup sehat. Batas tahunan lebih ' +
      'tinggi (Rp72,5 miliar) dari PRUSehat. Struktur tradisional murni, bukan rider PAYDI. PRUSehat adalah ' +
      'alternatif dengan No Claim Bonus; PRUWell Health adalah versi rider unit link.',
    bestFor: WELL_MEDICAL_FIT,
    defaultAttackPlan: {
      goodFit: WELL_MEDICAL_FIT,
      opening: WELL_MEDICAL_OPENING,
      benefits: WELL_MEDICAL_BENEFITS,
      fullScript:
        WELL_MEDICAL_OPENING +
        ' Bapak/Ibu bisa mendapat diskon premi hingga 20% di tahun berikutnya berdasarkan gaya hidup sehat dan ' +
        'riwayat klaim Bapak/Ibu. Manfaat tahunan mencapai Rp72,5 miliar dengan Limit Booster, lebih tinggi dari ' +
        'PRUSehat. Pilihan plannya dari Bronze A hingga Diamond, dengan telehealth di Indonesia dan telehealth ' +
        'kanker di Malaysia dan Singapura pada tingkat tertentu. Dibandingkan PRUWell Health, yang mengemas ' +
        'mekanisme yang sama sebagai rider unit link, PRUWell Medical adalah struktur tradisional murni. ' +
        WELL_MEDICAL_NEXT,
      objectionTheySay: SAYS_HEALTH,
      nextAction: WELL_MEDICAL_NEXT,
    },
  },
  PRUWELL_HEALTH: {
    tagline: 'Manfaat keadilan yang sama, dikemas sebagai rider unit link.',
    benefits: WELL_HEALTH_BENEFITS,
    differentiator:
      'Versi rider PAYDI dari PRUWell Medical. Menambahkan fleksibilitas nilai tunai (cuti premi) pada skema harga ' +
      'berbasis gaya hidup sehat. Memerlukan polis dasar PAYDI. PRUWell Medical adalah alternatif tradisional ' +
      'murni; PRUPrime Healthcare Plus Pro adalah rider PAYDI kelas atas.',
    bestFor: WELL_HEALTH_FIT,
    defaultAttackPlan: {
      goodFit: WELL_HEALTH_FIT,
      opening: WELL_HEALTH_OPENING,
      benefits: WELL_HEALTH_BENEFITS,
      fullScript:
        WELL_HEALTH_OPENING +
        ' PRUWell Health memberi mekanisme hadiah gaya hidup sehat yang sama dengan PRUWell Medical, diskon premi ' +
        'hingga 20%, tetapi biaya asuransinya dibayar dari nilai tunai unit link Bapak/Ibu. Setelah nilai tunainya ' +
        'mencukupi, Bapak/Ibu bisa mengambil cuti premi. Manfaat tahunan mencapai Rp72,5 miliar dengan Limit ' +
        'Booster. PRUWell Medical adalah alternatif tradisional murni jika Bapak/Ibu tidak ingin mengaitkannya ' +
        'dengan polis investasi. ' +
        WELL_HEALTH_NEXT,
      objectionTheySay: SAYS_HEALTH,
      nextAction: WELL_HEALTH_NEXT,
    },
  },
  PRUPRIME_HEALTHCARE_PLUS_PRO: {
    tagline: 'Rider kesehatan as-billed kelas atas untuk polis unit link.',
    benefits: PRIME_BENEFITS,
    differentiator:
      'Rider PAYDI kelas atas. Pilihan plan lebih lengkap dari PRUWell Health dan mekanisme klaim pro-rata ' +
      'untuk kamar di atas kelas atau pengobatan di luar wilayah. Dua cara penetapan harga yang berbeda di lini ' +
      'kesehatan unit link; PRUWell Health menekankan gaya hidup sehat, produk ini menekankan kelengkapan plan.',
    bestFor: PRIME_FIT,
    defaultAttackPlan: {
      goodFit: PRIME_FIT,
      opening: PRIME_OPENING,
      benefits: PRIME_BENEFITS,
      fullScript:
        PRIME_OPENING +
        ' PRUPrime Healthcare Plus Pro mencakup plan Bronze A hingga Diamond dengan perlindungan rawat inap sesuai ' +
        'tagihan. Mekanisme klaim pro-rata berlaku jika Bapak/Ibu dirawat di kelas kamar lebih tinggi atau berobat ' +
        'di luar wilayah pertanggungan, jadi Bapak/Ibu tetap fleksibel tanpa kehilangan seluruh perlindungan. ' +
        'PRUPrime Limit Booster menaikkan batas tahunan lebih jauh lagi. Dibandingkan PRUWell Health yang ' +
        'menghargai gaya hidup sehat, PRUPrime Healthcare Plus Pro berfokus pada kelengkapan plan dan fleksibilitas ' +
        'klaim. ' +
        PRIME_NEXT,
      objectionTheySay: SAYS_HEALTH,
      nextAction: PRIME_NEXT,
    },
  },
  PRUSEHAT_SYARIAH: {
    tagline: 'Versi syariah dari PRUSehat; berpotensi mendapat surplus underwriting.',
    benefits: SEHAT_SYARIAH_BENEFITS,
    differentiator:
      'Padanan syariah dari PRUSehat. Menambahkan surplus underwriting dan manfaat yang berkembang di atas ' +
      'mekanisme No Claim Bonus standar. Struktur plan dan hitungan ekonominya sama dengan PRUSehat konvensional, ' +
      'ditambah tata kelola syariah.',
    bestFor: SEHAT_SYARIAH_FIT,
    defaultAttackPlan: {
      goodFit: SEHAT_SYARIAH_FIT,
      opening: SEHAT_SYARIAH_OPENING,
      benefits: SEHAT_SYARIAH_BENEFITS,
      fullScript:
        SEHAT_SYARIAH_OPENING +
        ' Dua fitur khusus syariahnya adalah potensi surplus underwriting dan Manfaat Berkembang. Surplus ' +
        'underwriting berarti dana tabarru yang tidak terpakai dapat dikembalikan kepada peserta jika tidak ada ' +
        'klaim. Manfaat Berkembang menaikkan limit tahunan Bapak/Ibu 10% setiap tahun tanpa klaim, maksimal 50% dari ' +
        'limit awal. Struktur plan dan hitungan ekonominya sama persis dengan PRUSehat konvensional, ditambah tata ' +
        'kelola syariah. ' +
        SEHAT_SYARIAH_NEXT,
      objectionTheySay: SAYS_HEALTH,
      nextAction: SEHAT_SYARIAH_NEXT,
    },
  },
  PRUWELL_MEDICAL_SYARIAH: {
    tagline: 'Versi syariah dari PRUWell Medical; dengan mekanisme hadiah gaya hidup sehat.',
    benefits: WELL_MEDICAL_SYARIAH_BENEFITS,
    differentiator:
      'Padanan syariah dari PRUWell Medical. Menambahkan tata kelola syariah pada skema keadilan berbasis gaya ' +
      'hidup sehat. PRUWell Health Syariah adalah versi rider PAYDI dengan potensi surplus underwriting.',
    bestFor: WELL_MEDICAL_SYARIAH_FIT,
    defaultAttackPlan: {
      goodFit: WELL_MEDICAL_SYARIAH_FIT,
      opening: WELL_MEDICAL_SYARIAH_OPENING,
      benefits: WELL_MEDICAL_SYARIAH_BENEFITS,
      fullScript:
        WELL_MEDICAL_SYARIAH_OPENING +
        ' diskon kontribusi tahun berikutnya hingga 20% berdasarkan gaya hidup sehat. Pilihan plan, fleksibilitas ' +
        'kamar dan wilayah, serta batas Rp72,5 miliar dengan Limit Booster sama dengan PRUWell Medical ' +
        'konvensional. Pengelolaan dana syariahnya memakai struktur tabarru dan ujrah. Dibandingkan PRUWell Health ' +
        'Syariah, yang mengemasnya sebagai rider dengan potensi surplus underwriting, versi mandiri ini tidak ' +
        'memerlukan polis dasar PAYDI. ' +
        WELL_MEDICAL_SYARIAH_NEXT,
      objectionTheySay: SAYS_HEALTH,
      nextAction: WELL_MEDICAL_SYARIAH_NEXT,
    },
  },
};
