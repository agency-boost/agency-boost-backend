import type { SeedProductWords } from './product-catalog';

// The objections a customer raises, one per need, shared wherever the seed's English is the same.
const HEALTH_OBJECTION = 'Saya sudah punya asuransi kesehatan dari kantor.';
const ACCIDENT_OBJECTION = 'Sepertinya saya sudah punya perlindungan untuk itu.';
const CI_OBJECTION = 'Semoga saya tidak pernah perlu memakainya.';
const EDUCATION_OBJECTION = 'Saya menabung sendiri saja untuk itu.';
const INVESTMENT_OBJECTION = 'Bukankah unit link itu berisiko?';

// Sentences the seed repeats word for word across fields or products.
const SHARIA_FUND = 'Pengelolaan dana secara syariah.';
const SHARIA_COMPLIANT_FUND = 'Pengelolaan dana sesuai prinsip syariah.';
const SOLUSI_ALTERNATIVE =
  'PRUSolusi Kondisi Kritis Syariah adalah alternatif penyakit kritis syariah tingkat awal yang terjangkau.';
const LEGACY_PGB_FIT =
  'Pemegang polis PGB yang sudah ada (portofolio lama); tidak lagi diterbitkan untuk calon nasabah baru.';
const LEGACY_PSGB_FIT =
  'Pemegang polis PSGB yang sudah ada (portofolio lama); tidak lagi diterbitkan untuk calon nasabah baru.';

// PRUWell Health Syariah
const WELL_SY_FIT =
  'Pemegang polis PAYDI syariah yang menginginkan asuransi kesehatan berbasis gaya hidup sehat, sekaligus ikut ' +
  'serta dalam surplus.';
const WELL_SY_OPENING =
  'Karena Bapak/Ibu sudah memiliki polis dasar PAYDI syariah, rider ini memberikan mekanisme gaya hidup sehat ' +
  'yang sama, ditambah fitur khusus syariah yang tidak ada di produk konvensional:';
const WELL_SY_BENEFITS: readonly string[] = [
  'Manfaat dan mekanisme keadilan yang sama dengan PRUWell Health.',
  'Rider yang dilekatkan pada polis dasar PAYDI syariah.',
  'Biaya asuransi dipotong dari nilai tunai; cuti premi dimungkinkan setelah nilai tunai terkumpul.',
  'Potensi surplus underwriting setiap tahun kalender (jika ada).',
];
const WELL_SY_NEXT = 'Boleh saya buatkan simulasi potongan kontribusi dan proyeksi pengembalian surplusnya?';

// PRUPrime Healthcare Plus Pro Syariah
const PRIME_SY_FIT =
  'Pemegang polis PAYDI syariah yang menginginkan perlindungan rumah sakit dan operasi tingkat teratas.';
const PRIME_SY_OPENING =
  'Untuk perlindungan kesehatan syariah tingkat premium yang dilekatkan pada polis dasar PAYDI Bapak/Ibu, ' +
  'inilah tingkat teratasnya.';
const PRIME_SY_BENEFITS: readonly string[] = [
  'Pilihan plan dari Bronze A hingga Diamond, sama dengan versi konvensional.',
  'Rawat inap sesuai tagihan dengan mekanisme klaim pro-rata.',
  'PRUPrime Limit Booster hingga perlindungan tingkat tinggi.',
  SHARIA_FUND,
];
const PRIME_SY_NEXT =
  'Boleh saya bandingkan kedua pilihan ini sesuai rumah sakit dan wilayah yang biasa Bapak/Ibu pilih?';

// PRUPersonal Accident D&D Plus
const PA_FIT =
  'Nasabah dengan mobilitas tinggi dan nasabah yang ingin tambahan perlindungan kecelakaan di atas polis dasar.';
const PA_OPENING =
  'Dengan gaya hidup yang Bapak/Ibu ceritakan, risiko kecelakaan itu nyata, dan perlindungannya perlu sesuai.';
const PA_BENEFITS: readonly string[] = [
  'Perlindungan meninggal dunia akibat kecelakaan.',
  'Perlindungan cacat total dan tetap akibat kecelakaan.',
  'Manfaat sekaligus untuk patah tulang kompleks.',
  'Manfaat luka bakar sesuai tingkat keparahan luka bakar.',
  'Penggantian biaya rawat jalan darurat akibat kecelakaan.',
];
const PA_NEXT = 'Boleh saya tunjukkan besar manfaatnya untuk beberapa pilihan uang pertanggungan?';

// PRUPersonal Accident D&D Plus Syariah
const PA_SY_FIT = 'Nasabah Muslim yang ingin tambahan perlindungan kecelakaan sesuai prinsip syariah.';
const PA_SY_OPENING =
  'Versi syariah dari perlindungan kecelakaan ini mengikuti struktur versi konvensionalnya, dengan tata kelola ' +
  'syariah.';
const PA_SY_BENEFITS: readonly string[] = [
  'Meninggal dunia akibat kecelakaan, cacat total dan tetap, patah tulang kompleks, luka bakar, rawat jalan darurat.',
  'Pengelolaan dana secara syariah dengan kontribusi tabarru.',
];
const PA_SY_NEXT = 'Boleh saya jelaskan besar manfaatnya untuk beberapa tingkat uang pertanggungan?';

// PRUCritical Benefit 88
const CB88_FIT =
  'Pencari nafkah yang ingin pengganti penghasilan dalam jumlah besar, dibayar sekaligus saat didiagnosis ' +
  'penyakit kritis.';
const CB88_OPENING =
  'Penyakit kritis adalah peristiwa keuangan yang menggoyahkan kebanyakan keluarga pekerja: penghasilan berhenti, ' +
  'tagihan tidak.';
const CB88_BENEFITS: readonly string[] = [
  'Pembayaran sekaligus saat didiagnosis penyakit kritis yang ditanggung.',
  'Manfaat meninggal dunia jika belum ada klaim penyakit kritis.',
  'Masa perlindungan hingga usia 88 tahun.',
  'Pilihan premi: premi berkala dan premi tunggal.',
  'Dirancang sebagai pengganti penghasilan selama masa pemulihan dan penyesuaian gaya hidup.',
];
const CB88_NEXT = 'Boleh saya buatkan ilustrasi dengan premi berkala dan premi tunggal?';

// PRULady
const LADY_FIT = 'Wanita yang mengutamakan perlindungan kanker payudara, termasuk pilihan operasi rekonstruksi.';
const LADY_OPENING =
  'Bagi wanita, kanker payudara adalah risiko yang nyata dan didukung banyak data, dan PRULady dirancang khusus ' +
  'untuk risiko itu.';
const LADY_BENEFITS: readonly string[] = [
  'Manfaat kanker payudara stadium awal.',
  'Manfaat kanker payudara stadium lanjut.',
  'Manfaat operasi dan operasi rekonstruksi.',
  'Manfaat tambahan untuk kondisi kritis stadium lanjut yang khusus dialami wanita.',
  'Total pembayaran hingga 140% uang pertanggungan.',
  'PRULady Save: diskon premi untuk pemeriksaan kesehatan rutin.',
];
const LADY_NEXT = 'Boleh saya buatkan simulasi pembayaran bertahapnya dengan uang pertanggungan pilihan Bapak/Ibu?';

// PRUSolusi Kondisi Kritis Syariah
const SOLUSI_FIT =
  'Nasabah Muslim kelas menengah yang membutuhkan perlindungan penyakit kritis dengan kontribusi terjangkau.';
const SOLUSI_OPENING =
  'Untuk nasabah Muslim kelas menengah yang ingin perlindungan penyakit kritis tanpa kontribusi tingkat premium, ' +
  'inilah pilihan awalnya.';
const SOLUSI_BENEFITS: readonly string[] = [
  'Perlindungan untuk berbagai kondisi kritis dengan pembayaran berdasarkan stadium (awal dan lanjut).',
  'Berbasis tabarru, dengan potensi pengembalian surplus underwriting.',
  'Kontribusi yang hemat untuk pasar Muslim kelas menengah.',
  SHARIA_COMPLIANT_FUND,
];
const SOLUSI_NEXT = 'Boleh saya tunjukkan besar kontribusi keduanya sebagai perbandingan?';

// PRUCritical Amanah
const AMANAH_FIT =
  'Nasabah Muslim yang mapan dan menginginkan perlindungan penyakit kritis tingkat teratas, dengan pembayaran ' +
  'sejak diagnosis tahap awal.';
const AMANAH_OPENING =
  'PRUCritical Amanah memberikan perlindungan penyakit kritis syariah yang menyeluruh, termasuk sejak stadium awal.';
const AMANAH_BENEFITS: readonly string[] = [
  'Perlindungan untuk 61 kondisi kritis, termasuk diagnosis stadium awal.',
  'Produk penyakit kritis syariah tingkat premium, setara dengan PRUCritical Benefit 88 di lini konvensional.',
  'Struktur pembayaran bertahap; dibayar sekaligus saat didiagnosis.',
  SHARIA_FUND,
];
const AMANAH_NEXT =
  'Boleh saya buatkan ilustrasi kontribusi dengan besar perlindungan yang sesuai penghasilan Bapak/Ibu?';

// PRUCerah
const CERAH_FIT = 'Orang tua yang mengutamakan kepastian dana kuliah khusus, dalam kerangka syariah.';
const CERAH_OPENING =
  'Bapak/Ibu ingin kepastian bahwa biaya kuliah anak tetap terpenuhi, apa pun yang terjadi pada Bapak/Ibu.';
const CERAH_BENEFITS: readonly string[] = [
  'Pencairan dana pendidikan yang dijamin selama anak kuliah (4 tahun).',
  'Perlindungan orang tua: pembebasan premi jika orang tua meninggal dunia atau menderita penyakit kritis.',
  SHARIA_COMPLIANT_FUND,
  'Dirancang mengikuti laju inflasi biaya pendidikan di Indonesia.',
];
const CERAH_NEXT =
  'Boleh saya buatkan proyeksi dana pendidikan berdasarkan usia anak Bapak/Ibu saat ini dan jenis universitas ' +
  'yang dituju?';

// PRULink NextGen
const NEXTGEN_FIT = 'Nasabah PAYDI baru yang mencari perlindungan jangka panjang sekaligus investasi.';
const NEXTGEN_OPENING =
  'Bapak/Ibu ingin perlindungan jangka panjang sekaligus investasi, dan PRULink NextGen adalah PAYDI konvensional ' +
  'unggulan saat ini.';
const NEXTGEN_BENEFITS: readonly string[] = [
  'Usia masuk hingga 75 tahun; perlindungan hingga usia 75 / 85 / 99 tahun.',
  'Biaya akuisisi awal lebih rendah (~40%) yang dibagi selama 10 tahun, dibandingkan PGB yang ~70% selama 5 tahun.',
  'Loyalty Bonus: tambahan alokasi investasi pada tahun polis ke-11 hingga ke-20.',
  '200% uang pertanggungan jika meninggal dunia akibat kecelakaan; 300% selama masa libur Tahun Baru atau Idulfitri.',
  'Manfaat peristiwa penting: +10% uang pertanggungan saat menikah atau kelahiran anak (tanpa pemeriksaan kesehatan).',
];
const NEXTGEN_NEXT =
  'Boleh saya buatkan proyeksi dengan besar premi dan komposisi dana investasi pilihan Bapak/Ibu?';

// PRULink Investor Account
const INVESTOR_FIT =
  'Investor yang menempatkan dana sekaligus dan menginginkan investasi dengan perlindungan jiwa yang ringan.';
const INVESTOR_OPENING =
  'Bagi nasabah yang memiliki dana siap dan ingin berinvestasi tanpa kewajiban premi berkala, struktur premi ' +
  'tunggal adalah pilihan yang tepat.';
const INVESTOR_BENEFITS: readonly string[] = [
  'Premi tunggal dibayar sekaligus; tanpa kewajiban premi berkala.',
  'Manfaat meninggal dunia = 125% premi tunggal + nilai tunai (jika ada).',
  'Perlindungan cacat total dan tetap (usia 6 hingga 60 tahun), dibayar 20%, lalu 80% satu tahun kemudian.',
  'Manfaat akhir masa polis = nilai tunai pada akhir masa polis.',
];
const INVESTOR_NEXT =
  'Boleh saya buatkan simulasi skenario kinerja dana investasi sesuai besar dana yang Bapak/Ibu tempatkan?';

// PRULink Generasi Baru (PGB), closed to new business: no opening, script or next action.
const PGB_BENEFITS: readonly string[] = [
  'PRUbooster Investasi: alokasi top-up investasi otomatis setiap tahun.',
  'PRUbooster Proteksi: kenaikan uang pertanggungan otomatis setiap tahun tanpa pernyataan medis.',
  'Alokasi investasi sejak hari pertama.',
  '200% uang pertanggungan jika meninggal dunia akibat kecelakaan.',
  'Banyak pilihan dana investasi.',
];

// PRULink NextGen Syariah
const NEXTGEN_SY_FIT = 'Nasabah Muslim yang menginginkan PAYDI syariah jangka panjang yang menyeluruh.';
const NEXTGEN_SY_OPENING =
  'Bagi nasabah Muslim yang merencanakan Umroh atau Haji, produk ini dirancang khusus untuk momen hidup tersebut.';
const NEXTGEN_SY_BENEFITS: readonly string[] = [
  'Struktur yang sama dengan NextGen: usia masuk hingga 75 tahun; perlindungan hingga usia 75 / 85 / 99 tahun.',
  'Loyalty Bonus tahun ke-11 hingga ke-20.',
  '300% uang pertanggungan jika meninggal dunia akibat kecelakaan selama Umroh, Haji, atau masa libur.',
  'Manfaat peristiwa penting: +10% uang pertanggungan saat menikah atau kelahiran anak.',
  SHARIA_COMPLIANT_FUND,
];
const NEXTGEN_SY_NEXT = 'Boleh saya buatkan proyeksi yang memperhitungkan rencana waktu Umroh atau Haji Bapak/Ibu?';

// PRULink Syariah Investor Account
const INVESTOR_SY_FIT =
  'Investor Muslim yang menempatkan dana sekaligus dan menginginkan investasi sesuai prinsip syariah.';
const INVESTOR_SY_OPENING =
  'PAYDI syariah kontribusi tunggal ini untuk nasabah Muslim yang memiliki dana siap dan ingin berinvestasi ' +
  'dengan perlindungan jiwa yang ringan.';
const INVESTOR_SY_BENEFITS: readonly string[] = [
  'Kontribusi syariah sekali bayar; tanpa komitmen berkala.',
  'Pilihan dana investasi yang dikelola secara syariah.',
  'Uang pertanggungan 125% dari kontribusi tunggal ditambah nilai tunai.',
  'Manfaat cacat total dan tetap (TPD) serta manfaat akhir masa polis, sama dengan struktur konvensionalnya.',
];
const INVESTOR_SY_NEXT =
  'Boleh saya jelaskan pilihan dana syariahnya sesuai besar kontribusi yang Bapak/Ibu rencanakan?';

// PRULink Syariah Generasi Baru (PSGB), closed to new business: no opening, script or next action.
const PSGB_BENEFITS: readonly string[] = [
  'PRUbooster Investasi syariah: top-up investasi otomatis setiap tahun.',
  'PRUbooster Proteksi syariah: kenaikan uang pertanggungan otomatis setiap tahun tanpa pernyataan kesehatan.',
  'Pilihan dana syariah untuk berbagai profil risiko.',
];

/**
 * **The seed products' words in Bahasa Indonesia, part B** (UI V1, UI-107; Phase 18.11 T13): the last fifteen of
 * `SEED_PRODUCTS`, field for field. Served to a reader in Indonesian wherever a company still holds the platform's
 * English word for word (`modules/products/product-words.ts`); a word a company or an office typed is shown as typed.
 * Translated for the product owner's review before release.
 */
export const SEED_PRODUCTS_ID_B: Readonly<Record<string, SeedProductWords>> = {
  PRUWELL_HEALTH_SYARIAH: {
    tagline: 'Rider PRUWell syariah dengan potensi surplus underwriting.',
    benefits: WELL_SY_BENEFITS,
    differentiator:
      'Versi rider syariah dari PRUWell Medical. Skema harga berbasis gaya hidup sehat, ditambah kemungkinan ' +
      'pengembalian surplus syariah yang tidak tersedia bagi pembeli produk konvensional. PRUPrime Healthcare Plus ' +
      'Pro Syariah adalah alternatif rider kesehatan PAYDI syariah tingkat premium.',
    bestFor: WELL_SY_FIT,
    defaultAttackPlan: {
      goodFit: WELL_SY_FIT,
      opening: WELL_SY_OPENING,
      benefits: WELL_SY_BENEFITS,
      fullScript:
        WELL_SY_OPENING +
        ' potensi surplus underwriting setiap tahun kalender. Kontribusinya dipotong dari nilai tunai Bapak/Ibu, ' +
        'dan setelah nilai tunai cukup terkumpul, Bapak/Ibu bisa mengambil cuti kontribusi. Mekanisme keadilan ' +
        'berbasis gaya hidup sehat dan pengembalian surplus bekerja bersama: gaya hidup sehat menurunkan kontribusi ' +
        'Bapak/Ibu, dan dana tabarru yang tidak terpakai bisa kembali kepada peserta. ' +
        WELL_SY_NEXT,
      objectionTheySay: HEALTH_OBJECTION,
      nextAction: WELL_SY_NEXT,
    },
  },
  PRUPRIME_HEALTHCARE_PLUS_PRO_SYARIAH: {
    tagline: 'Rider kesehatan syariah tingkat teratas, dikelola sesuai prinsip syariah.',
    benefits: PRIME_SY_BENEFITS,
    differentiator:
      'Rider PAYDI syariah tingkat premium. Berfokus pada kelengkapan plan, dengan mekanisme klaim pro-rata untuk ' +
      'kamar di atas kelas atau pengobatan di luar wilayah. PRUWell Health Syariah adalah alternatif rider syariah ' +
      'berbasis gaya hidup sehat.',
    bestFor: PRIME_SY_FIT,
    defaultAttackPlan: {
      goodFit: PRIME_SY_FIT,
      opening: PRIME_SY_OPENING,
      benefits: PRIME_SY_BENEFITS,
      fullScript:
        PRIME_SY_OPENING +
        ' Pilihan plannya dari Bronze A hingga Diamond dengan perlindungan rawat inap sesuai tagihan, dan mekanisme ' +
        'klaim pro-rata memberi Bapak/Ibu fleksibilitas soal kelas kamar atau wilayah perawatan tanpa kehilangan ' +
        'perlindungan sepenuhnya. PRUPrime Limit Booster menaikkan batas tahunan hingga tingkat teratas. ' +
        'Dibandingkan PRUWell Health Syariah yang menekankan hadiah gaya hidup sehat, produk ini menekankan ' +
        'kelengkapan plan dan fleksibilitas klaim. ' +
        PRIME_SY_NEXT,
      objectionTheySay: HEALTH_OBJECTION,
      nextAction: PRIME_SY_NEXT,
    },
  },
  PRUPERSONAL_ACCIDENT_D_D_PLUS: {
    tagline: 'Rider khusus kecelakaan: meninggal dunia, cacat, patah tulang, luka bakar.',
    benefits: PA_BENEFITS,
    differentiator:
      'Produk konvensional khusus kecelakaan. Tidak menanggung penyakit. Terjangkau, biasanya dilekatkan sebagai ' +
      'rider pada polis jiwa atau kesehatan. Padanan syariahnya adalah PRUPersonal Accident D&D Plus Syariah ' +
      'dengan struktur ekonomi yang sama persis.',
    bestFor: PA_FIT,
    defaultAttackPlan: {
      goodFit: PA_FIT,
      opening: PA_OPENING,
      benefits: PA_BENEFITS,
      fullScript:
        PA_OPENING +
        ' PRUPersonal Accident D&D Plus dirancang khusus untuk risiko kecelakaan: meninggal dunia akibat ' +
        'kecelakaan, cacat total dan tetap, patah tulang kompleks, luka bakar, dan biaya rawat jalan darurat. ' +
        'Produk ini memang sengaja tidak menanggung penyakit, sehingga preminya tetap terjangkau. Produk ini ' +
        'dilekatkan sebagai rider pada polis dasar, jadi melengkapi, bukan menggantikan, asuransi kesehatan utama ' +
        'Bapak/Ibu. ' +
        PA_NEXT,
      objectionTheySay: ACCIDENT_OBJECTION,
      nextAction: PA_NEXT,
    },
  },
  PRUPERSONAL_ACCIDENT_D_D_PLUS_SYARIAH: {
    tagline: 'Rider kecelakaan syariah: meninggal dunia, cacat, patah tulang, luka bakar.',
    benefits: PA_SY_BENEFITS,
    differentiator:
      'Produk syariah khusus kecelakaan. Cerminan PRUPersonal Accident D&D Plus, dengan pengelolaan dana secara ' +
      'syariah.',
    bestFor: PA_SY_FIT,
    defaultAttackPlan: {
      goodFit: PA_SY_FIT,
      opening: PA_SY_OPENING,
      benefits: PA_SY_BENEFITS,
      fullScript:
        PA_SY_OPENING +
        ' Meninggal dunia akibat kecelakaan, cacat total dan tetap, patah tulang kompleks, luka bakar, dan biaya ' +
        'rawat jalan darurat semuanya ditanggung, dengan kontribusi tabarru. Produk ini memang sengaja tidak ' +
        'menanggung penyakit. Rider ini dilekatkan pada polis dasar syariah. ' +
        PA_SY_NEXT,
      objectionTheySay: ACCIDENT_OBJECTION,
      nextAction: PA_SY_NEXT,
    },
  },
  PRUCRITICAL_BENEFIT_88: {
    tagline: 'Perlindungan penyakit kritis tingkat premium yang dibayar sekaligus, dengan manfaat meninggal dunia.',
    benefits: CB88_BENEFITS,
    differentiator:
      'Produk unggulan penyakit kritis mandiri di lini konvensional. Varian premi tunggalnya jarang ada dan efisien ' +
      'secara modal. Manfaat meninggal dunia memastikan premi yang dibayarkan tidak hilang jika penyakit kritis ' +
      'tidak pernah terjadi. PRULady adalah alternatif khusus wanita untuk kanker payudara.',
    bestFor: CB88_FIT,
    defaultAttackPlan: {
      goodFit: CB88_FIT,
      opening: CB88_OPENING,
      benefits: CB88_BENEFITS,
      fullScript:
        CB88_OPENING +
        ' PRUCritical Benefit 88 membayar uang sekaligus saat Bapak/Ibu didiagnosis penyakit kritis yang ' +
        'ditanggung, sebagai pengganti penghasilan selama pengobatan dan pemulihan. Ada juga manfaat meninggal ' +
        'dunia, jadi jika Bapak/Ibu tidak pernah membutuhkan pembayaran penyakit kritis, premi yang dibayarkan tidak ' +
        'hilang. Bapak/Ibu bisa membayar dengan premi berkala atau premi tunggal. Pilihan premi tunggal jarang ada ' +
        'di produk penyakit kritis, dan efisien bagi nasabah yang memiliki dana siap. PRULady adalah alternatif ' +
        'khusus wanita yang berfokus pada kanker payudara; PRUCritical Benefit 88 adalah pilihan untuk perlindungan ' +
        'penyakit kritis yang luas. ' +
        CB88_NEXT,
      objectionTheySay: CI_OBJECTION,
      nextAction: CB88_NEXT,
    },
  },
  PRULADY: {
    tagline: 'Perlindungan kanker payudara untuk wanita, hingga 140% uang pertanggungan.',
    benefits: LADY_BENEFITS,
    differentiator:
      'Satu-satunya produk penyakit kritis khusus wanita di katalog. Pembayaran berdasarkan stadium dan ' +
      'perlindungan operasi rekonstruksi jarang ada di kategori penyakit kritis pada umumnya. PRUCritical Benefit ' +
      '88 adalah alternatif penyakit kritis yang luas jika kanker payudara bukan perhatian utama.',
    bestFor: LADY_FIT,
    defaultAttackPlan: {
      goodFit: LADY_FIT,
      opening: LADY_OPENING,
      benefits: LADY_BENEFITS,
      fullScript:
        LADY_OPENING +
        ' Pembayarannya bertahap: stadium awal, stadium lanjut, operasi, dan operasi rekonstruksi, dengan total ' +
        'pembayaran hingga 140% uang pertanggungan. Perlindungan operasi rekonstruksi ini jarang ada di kategori ' +
        'penyakit kritis pada umumnya. Ada juga fitur PRULady Save: diskon premi untuk pemeriksaan kesehatan ' +
        'rutin. PRUCritical Benefit 88 adalah alternatifnya jika Bapak/Ibu lebih memilih perlindungan penyakit ' +
        'kritis yang luas daripada perlindungan khusus kanker payudara. ' +
        LADY_NEXT,
      objectionTheySay: CI_OBJECTION,
      nextAction: LADY_NEXT,
    },
  },
  PRUSOLUSI_KONDISI_KRITIS_SYARIAH: {
    tagline: 'Asuransi penyakit kritis syariah yang terjangkau, dengan pembayaran berdasarkan stadium.',
    benefits: SOLUSI_BENEFITS,
    differentiator:
      'Pilihan penyakit kritis syariah tingkat awal. Harganya di bawah PRUCritical Amanah; ditujukan untuk ' +
      'memperluas jangkauan asuransi penyakit kritis syariah di segmen kelas menengah.',
    bestFor: SOLUSI_FIT,
    defaultAttackPlan: {
      goodFit: SOLUSI_FIT,
      opening: SOLUSI_OPENING,
      benefits: SOLUSI_BENEFITS,
      fullScript:
        SOLUSI_OPENING +
        ' Pembayarannya berdasarkan stadium, mencakup stadium awal dan lanjut, dan dananya berbasis tabarru dengan ' +
        'potensi pengembalian surplus underwriting. Kontribusinya dirancang agar perlindungan penyakit kritis ' +
        'syariah bisa menjangkau lebih banyak orang. Dibandingkan PRUCritical Amanah yang menanggung 61 kondisi, ' +
        'termasuk diagnosis tahap awal, dengan kontribusi tingkat premium, produk ini mengutamakan keterjangkauan. ' +
        SOLUSI_NEXT,
      objectionTheySay: CI_OBJECTION,
      nextAction: SOLUSI_NEXT,
    },
  },
  PRUCRITICAL_AMANAH: {
    tagline: 'Asuransi penyakit kritis syariah yang menyeluruh: 61 kondisi, termasuk diagnosis tahap awal.',
    benefits: AMANAH_BENEFITS,
    differentiator:
      'Pilihan penyakit kritis syariah tingkat premium. 61 kondisi, termasuk stadium awal. Padanan syariah dari ' +
      'PRUCritical Benefit 88 konvensional. ' +
      SOLUSI_ALTERNATIVE,
    bestFor: AMANAH_FIT,
    defaultAttackPlan: {
      goodFit: AMANAH_FIT,
      opening: AMANAH_OPENING,
      benefits: AMANAH_BENEFITS,
      fullScript:
        AMANAH_OPENING +
        ' Produk ini menanggung 61 kondisi kritis, termasuk diagnosis di stadium awal, saat pengobatan paling ' +
        'efektif. Dengan struktur pembayaran bertahap, Bapak/Ibu menerima uang sekaligus saat didiagnosis di setiap ' +
        'stadium yang ditanggung. Dari sisi kedalaman perlindungan, produk ini adalah padanan syariah dari ' +
        'PRUCritical Benefit 88 konvensional. ' +
        SOLUSI_ALTERNATIVE +
        ' ' +
        AMANAH_NEXT,
      objectionTheySay: CI_OBJECTION,
      nextAction: AMANAH_NEXT,
    },
  },
  PRUCERAH: {
    tagline: 'Asuransi pendidikan anak syariah untuk 4 tahun masa kuliah.',
    benefits: CERAH_BENEFITS,
    differentiator:
      'Satu-satunya produk khusus pendidikan di kedua lini. Dikelola secara syariah. Tidak ada alternatif ' +
      'konvensionalnya; nasabah konvensional biasanya memenuhi dana pendidikan melalui PAYDI (PRULink NextGen).',
    bestFor: CERAH_FIT,
    defaultAttackPlan: {
      goodFit: CERAH_FIT,
      opening: CERAH_OPENING,
      benefits: CERAH_BENEFITS,
      fullScript:
        CERAH_OPENING +
        ' PRUCerah memberikan tepat itu: pencairan dana pendidikan yang dijamin, sesuai prinsip syariah, selama ' +
        'empat tahun masa kuliah. Yang terpenting, jika Bapak/Ibu sebagai orang tua meninggal dunia atau ' +
        'didiagnosis penyakit kritis, kontribusi berikutnya dibebaskan, tetapi dananya tetap berkembang untuk anak ' +
        'Bapak/Ibu. Ini satu-satunya produk khusus pendidikan di kedua lini, konvensional dan syariah. Jika ' +
        'Bapak/Ibu memilih konvensional, alternatif yang biasa dipakai adalah PRULink NextGen sebagai sarana ' +
        'investasi jangka panjang untuk tujuan yang sama. ' +
        CERAH_NEXT,
      objectionTheySay: EDUCATION_OBJECTION,
      nextAction: CERAH_NEXT,
    },
  },
  PRULINK_NEXTGEN: {
    tagline: 'PAYDI premi berkala unggulan saat ini; sesuai ketentuan OJK 2022.',
    benefits: NEXTGEN_BENEFITS,
    differentiator:
      'PAYDI konvensional unggulan saat ini. Sesuai SE OJK 5/SEOJK.05/2022. Pembentukan nilai tunai di tahun-tahun ' +
      'awal lebih baik daripada PGB. PRULink Investor Account adalah alternatif premi tunggalnya; PRULink Generasi ' +
      'Baru adalah produk lama sebelum 2023 (tidak lagi dipasarkan).',
    bestFor: NEXTGEN_FIT,
    defaultAttackPlan: {
      goodFit: NEXTGEN_FIT,
      opening: NEXTGEN_OPENING,
      benefits: NEXTGEN_BENEFITS,
      fullScript:
        NEXTGEN_OPENING +
        ' Biaya akuisisinya sekitar 40% yang dibagi selama 10 tahun, jauh lebih rendah daripada struktur PGB ' +
        'sebelumnya yang membebankan sekitar 70% di depan selama 5 tahun. Loyalty Bonus berlaku dari tahun polis ' +
        'ke-11 hingga ke-20, memberi Bapak/Ibu tambahan alokasi investasi tepat saat nilai tunai sedang bertumbuh ' +
        'paling optimal. Ada manfaat 200% uang pertanggungan jika meninggal dunia akibat kecelakaan, naik menjadi ' +
        '300% selama masa libur Tahun Baru atau Idulfitri. Peristiwa penting seperti menikah atau kelahiran anak ' +
        'otomatis menambah 10% uang pertanggungan, tanpa pemeriksaan kesehatan. PRULink Investor Account adalah ' +
        'alternatif premi tunggal jika Bapak/Ibu lebih suka membayar sekaligus. ' +
        NEXTGEN_NEXT,
      objectionTheySay: INVESTMENT_OBJECTION,
      nextAction: NEXTGEN_NEXT,
    },
  },
  PRULINK_INVESTOR_ACCOUNT: {
    tagline: 'PAYDI premi tunggal; mengutamakan investasi, dengan perlindungan jiwa.',
    benefits: INVESTOR_BENEFITS,
    differentiator:
      'Satu-satunya PAYDI premi tunggal di katalog. Berfokus pada investasi, dengan perlindungan yang tipis. ' +
      'Dirancang untuk penempatan dana sekaligus, bukan untuk menabung secara disiplin. PRULink NextGen adalah ' +
      'alternatif unggulan dengan premi berkala.',
    bestFor: INVESTOR_FIT,
    defaultAttackPlan: {
      goodFit: INVESTOR_FIT,
      opening: INVESTOR_OPENING,
      benefits: INVESTOR_BENEFITS,
      fullScript:
        INVESTOR_OPENING +
        ' PRULink Investor Account menerima dana sekaligus dari Bapak/Ibu, memberikan manfaat meninggal dunia ' +
        'berupa uang pertanggungan 125% dari premi ditambah nilai tunai yang terkumpul, serta perlindungan cacat ' +
        'total dan tetap untuk usia 6 hingga 60 tahun dengan pembayaran 20% lalu 80%. Di akhir masa polis, ' +
        'Bapak/Ibu menerima nilai tunainya. Dibandingkan PRULink NextGen yang membangun investasi lewat premi ' +
        'berkala yang disiplin, produk ini untuk yang ingin menempatkan dana sekaligus. ' +
        INVESTOR_NEXT,
      objectionTheySay: INVESTMENT_OBJECTION,
      nextAction: INVESTOR_NEXT,
    },
  },
  PRULINK_GENERASI_BARU_PGB: {
    tagline: 'PAYDI premi berkala sebelum 2023; tidak lagi dijual untuk polis baru.',
    benefits: PGB_BENEFITS,
    differentiator:
      'PAYDI konvensional sebelum 2023, digantikan PRULink NextGen untuk polis baru setelah 6 Maret 2023. Biaya ' +
      'akuisisi awal lebih tinggi (~70%), tetapi dengan amortisasi yang lebih singkat, 5 tahun. Tidak lagi ' +
      'dipasarkan; tidak diterbitkan untuk polis baru.',
    bestFor: LEGACY_PGB_FIT,
    defaultAttackPlan: {
      goodFit: LEGACY_PGB_FIT,
      opening: '',
      benefits: PGB_BENEFITS,
      fullScript: '',
      objectionTheySay: INVESTMENT_OBJECTION,
      nextAction: '',
    },
  },
  PRULINK_NEXTGEN_SYARIAH: {
    tagline: 'PAYDI syariah unggulan dengan tambahan manfaat kecelakaan saat Umroh / Haji.',
    benefits: NEXTGEN_SY_BENEFITS,
    differentiator:
      'PAYDI syariah unggulan saat ini. Strukturnya sama dengan PRULink NextGen, tetapi tambahan manfaat 300% untuk ' +
      'meninggal dunia akibat kecelakaan berlaku saat Umroh / Haji, menggantikan masa libur Tahun Baru / Idulfitri. ' +
      'PRULink Syariah Investor Account adalah alternatif kontribusi tunggalnya; PRULink Syariah Generasi Baru ' +
      'adalah produk lama (tidak lagi dipasarkan).',
    bestFor: NEXTGEN_SY_FIT,
    defaultAttackPlan: {
      goodFit: NEXTGEN_SY_FIT,
      opening: NEXTGEN_SY_OPENING,
      benefits: NEXTGEN_SY_BENEFITS,
      fullScript:
        NEXTGEN_SY_OPENING +
        ' PRULink NextGen Syariah membayar 300% uang pertanggungan jika meninggal dunia akibat kecelakaan selama ' +
        'Umroh, Haji, atau masa libur, di atas perlindungan reguler 200% untuk meninggal dunia akibat kecelakaan. ' +
        'Struktur NextGen, termasuk Loyalty Bonus dari tahun ke-11 hingga ke-20 dan manfaat peristiwa penting saat ' +
        'menikah atau kelahiran anak, berlaku dalam bentuk yang sesuai prinsip syariah. Pengelolaan dananya ' +
        'sepenuhnya mengikuti prinsip syariah. PRULink Syariah Investor Account adalah alternatif kontribusi ' +
        'tunggal bagi investor yang menempatkan dana sekaligus. ' +
        NEXTGEN_SY_NEXT,
      objectionTheySay: INVESTMENT_OBJECTION,
      nextAction: NEXTGEN_SY_NEXT,
    },
  },
  PRULINK_SYARIAH_INVESTOR_ACCOUNT: {
    tagline: 'PAYDI syariah kontribusi tunggal bagi investor yang menempatkan dana sekaligus.',
    benefits: INVESTOR_SY_BENEFITS,
    differentiator:
      'Cerminan syariah dari PRULink Investor Account. Satu-satunya PAYDI kontribusi tunggal di lini syariah.',
    bestFor: INVESTOR_SY_FIT,
    defaultAttackPlan: {
      goodFit: INVESTOR_SY_FIT,
      opening: INVESTOR_SY_OPENING,
      benefits: INVESTOR_SY_BENEFITS,
      fullScript:
        INVESTOR_SY_OPENING +
        ' Bapak/Ibu cukup membayar kontribusi sekali, mendapat uang pertanggungan 125% dari kontribusi ditambah ' +
        'nilai tunai yang terkumpul, dan dananya dikelola sesuai prinsip syariah. Manfaat cacat total dan tetap ' +
        '(TPD) serta manfaat akhir masa polis sama dengan struktur konvensionalnya. Dibandingkan PRULink NextGen ' +
        'Syariah yang membangun investasi lewat kontribusi berkala, produk ini untuk yang ingin menempatkan dana ' +
        'sekaligus. ' +
        INVESTOR_SY_NEXT,
      objectionTheySay: INVESTMENT_OBJECTION,
      nextAction: INVESTOR_SY_NEXT,
    },
  },
  PRULINK_SYARIAH_GENERASI_BARU_PSGB: {
    tagline: 'PAYDI syariah kontribusi berkala sebelum 2023; tidak lagi dipasarkan.',
    benefits: PSGB_BENEFITS,
    differentiator:
      'PAYDI syariah sebelum 2023. Digantikan PRULink NextGen Syariah untuk polis baru setelah 6 Maret 2023. ' +
      'Tidak lagi dipasarkan.',
    bestFor: LEGACY_PSGB_FIT,
    defaultAttackPlan: {
      goodFit: LEGACY_PSGB_FIT,
      opening: '',
      benefits: PSGB_BENEFITS,
      fullScript: '',
      objectionTheySay: INVESTMENT_OBJECTION,
      nextAction: '',
    },
  },
};
