import type { RecruitmentPlaybookBody } from './recruitment';

/**
 * **The seed recruitment playbook in Bahasa Indonesia** (UI V1, UI-107; Phase 18.99 T13): `SEED_RECRUITMENT_PLAYBOOK`,
 * path for path. Served to a reader in Indonesian wherever a company's playbook still holds the platform's English word
 * for word (`modules/recruitment/recruitment-words.ts`); a word a company typed is shown as typed. Translated for the
 * product owner's review before release.
 */
export const SEED_RECRUITMENT_PLAYBOOK_ID: RecruitmentPlaybookBody = {
  profiles: {
    'fresh-grad': {
      label: 'Lulusan baru',
      tagline:
        'Baru memasuki dunia kerja dan sedang menentukan langkah karier pertama yang sesungguhnya.',
      goodFitFor:
        'Orang yang sedang membandingkan peluang ini dengan pekerjaan level pemula di perusahaan, dan perlu tahu bahwa perkembangan di sini tidak dibatasi masa kerja atau jenjang jabatan.',
      benefits: [
        'Tidak perlu pengalaman sebelumnya. Ada pelatihan terstruktur yang lengkap dan dukungan pengurusan lisensi sejak hari pertama.',
        'Jalur promosi yang jelas: Agent → Associate Agency Builder → Agency Builder, dengan tahapan pencapaian yang ditetapkan, bukan masa kerja.',
        'Penghasilan berbasis kinerja sejak awal, jadi hasil usaha terus berlipat, bukan menunggu kenaikan gaji tahunan.',
        'Coaching setiap hari di dalam lingkungan tim yang sudah siap, bukan duduk sendirian tanpa arahan.',
      ],
      openings: {
        'side-income':
          'Untuk sekarang, apakah Anda melihat ini sebagai kegiatan sampingan, atau bisa menjadi pekerjaan utama Anda kalau berjalan baik?',
        'full-career':
          'Apa yang perlu terbukti supaya Anda yakin ini bisa menjadi karier yang sesungguhnya, bukan sekadar pekerjaan pertama?',
        'flexibility':
          'Seperti apa sebenarnya minggu kerja yang ideal bagi Anda: jam kerjanya, strukturnya, dan kepada siapa Anda melapor?',
        'leadership':
          'Tiga tahun lagi Anda ingin berada di mana: masih di peran yang sama, atau memimpin tim sendiri?',
      },
    },
    'career-switch': {
      label: 'Pindah karier',
      tagline:
        'Saat ini bekerja, sedang menimbang apakah akan meninggalkan pekerjaan yang stabil.',
      goodFitFor:
        'Orang yang secara finansial siap mengambil risiko terukur dan lelah dengan penghasilan yang dibatasi di posisinya sekarang.',
      benefits: [
        'Penghasilan tanpa batas sesuai usaha dan hasil, bukan masa kerja atau gaji tetap.',
        'Keahlian yang sudah dimiliki (mengelola hubungan, komunikasi, memecahkan masalah) langsung terpakai.',
        'Bisa mulai paruh waktu dan membuktikannya dulu, dengan activation checklist yang jelas.',
        'Jalur cepat menjadi leader jika ingin membangun dan memimpin tim.',
      ],
      openings: {
        'side-income':
          'Bagaimana kalau dicoba dulu sambil tetap bekerja, sebelum mengambil keputusan yang lebih besar?',
        'full-career':
          'Sebenarnya sampai mana batas tertinggi di posisi Anda sekarang, dan apakah Anda bisa menerima batas itu untuk jangka panjang?',
        'flexibility':
          'Seberapa besar rasa frustrasi Anda sebenarnya karena pekerjaannya, dan seberapa besar karena Anda tidak bisa mengatur jadwal sendiri?',
        'leadership':
          'Pernahkah Anda mendapat kesempatan membangun dan memimpin tim sendiri, atau selama ini itu selalu keputusan orang lain?',
      },
    },
    'business-owner': {
      label: 'Pemilik usaha',
      tagline:
        'Sudah menjalankan sesuatu: usaha kecil, pekerjaan lepas, atau usaha sampingan.',
      goodFitFor:
        'Orang yang menginginkan kepemilikan dan skala, bukan sekadar pekerjaan lain dengan nama yang berbeda.',
      benefits: [
        'Membangun agensi berarti membangun usaha sendiri: portofolio nasabah, tim, dan angka-angkanya sepenuhnya milik Anda.',
        'Anda sudah memahami risiko, arus kas, dan hubungan dengan klien. Dasar-dasarnya langsung terpakai.',
        'Merekrut dan membangun downline melipatgandakan penghasilan, sama seperti cara Anda memikirkan pengembangan usaha selama ini.',
        'Biaya operasional untuk memulai sangat kecil. Anda mengembangkannya dengan cara yang sama seperti Anda membesarkan usaha yang Anda jalankan sekarang.',
      ],
      openings: {
        'side-income':
          'Apakah ini akan Anda jalankan bersamaan dengan usaha yang sudah ada, atau suatu saat Anda ingin menggantikannya?',
        'full-career':
          'Apa yang membuat Anda ingin beralih dari usaha yang Anda jalankan sekarang: batas penghasilan, stabilitas, atau hal lain?',
        'flexibility':
          'Anda sudah mengatur jadwal sendiri. Apa yang akan membuat waktu itu lebih baik dipakai untuk ini daripada untuk yang Anda kerjakan sekarang?',
        'leadership':
          'Anda sudah membangun sesuatu. Bagaimana kalau yang Anda bangun berikutnya adalah tim, bukan hanya basis klien?',
      },
    },
    'retiree': {
      label: 'Pensiunan',
      tagline:
        'Kembali bekerja setelah lama berhenti, atau mencari pekerjaan dengan jam kerja yang lebih sedikit.',
      goodFitFor:
        'Orang yang lebih membutuhkan fleksibilitas daripada jadwal tetap, dan punya jaringan pribadi yang belum banyak dimanfaatkan.',
      benefits: [
        'Jadwal fleksibel: aktivitas diukur dari hasilnya, bukan dari jam absen.',
        'Jeda dalam riwayat kerja tidak menjadi masalah. Yang dihitung adalah kinerja sejak hari pertama, bukan riwayat kerja terakhir.',
        'Terhubung kembali dengan jaringan pribadi yang sudah ada dan menjadikannya sumber penghasilan. Hubungan bertahun-tahun sering menjadi leads pertama Anda.',
        'Mulai dengan kecepatan yang sesuai, lalu tingkatkan begitu jadwal Anda memungkinkan.',
      ],
      openings: {
        'side-income':
          'Apakah Anda mencari sesuatu yang ringan untuk memulai, atau terbuka untuk mengembangkannya setelah Anda kembali mantap?',
        'full-career':
          'Apa yang akan membuat ini terasa seperti babak kedua yang sesungguhnya bagi Anda, bukan sekadar mengisi waktu?',
        'flexibility':
          'Dalam seminggu biasa, berapa banyak waktu yang sebenarnya Anda punya saat ini?',
        'leadership':
          'Dengan semua yang sudah Anda ketahui dari karier Anda, apakah suatu saat Anda ingin membimbing orang lain melalui hal yang sama?',
      },
    },
    'other-insurer': {
      label: 'Agent (asuransi lain)',
      tagline:
        'Saat ini sudah berlisensi dan menjual untuk perusahaan asuransi lain.',
      goodFitFor:
        'Orang yang sudah terbiasa menjual asuransi dan sedang menimbang apakah komisi, budaya, atau dukungan di agensi Anda lebih baik daripada tempatnya sekarang.',
      benefits: [
        'Sudah berlisensi, jadi pembicaraan langsung ke platform, komisi, dan dukungan, bukan soal apakah menjual asuransi cocok untuknya.',
        'Bisa membawa portofolio nasabah dan jaringan yang sudah ada, tidak mulai dari nol.',
        'Perbandingan langsung dan berdampingan: struktur kompensasi dan dukungan leader di sini dibanding yang dia dapat sekarang.',
        'Lebih cepat produktif dibanding profil lain mana pun, karena tidak perlu lagi belajar dasar-dasar menjual asuransi.',
      ],
      openings: {
        'side-income':
          'Apakah Anda ingin mencoba bersama kami sambil tetap mengelola portofolio nasabah Anda sekarang, atau siap pindah sepenuhnya kalau angkanya cocok?',
        'full-career':
          'Apa yang kurang di tempat Anda sekarang, sehingga pindah menjadi sepadan?',
        'flexibility':
          'Saat ini, seberapa besar sebenarnya kendali Anda atas jadwal dan wilayah kerja Anda?',
        'leadership':
          'Apakah agensi Anda sekarang memberi kesempatan untuk membangun dan memimpin tim sendiri, atau hal itu selama ini di luar jangkauan?',
      },
    },
  },
  objections: {
    'no-experience': {
      theySay: 'Saya tidak punya pengalaman menjual. Rasanya saya tidak akan bisa.',
      youSay:
        'Tidak ada yang mulai dengan pengalaman. Setiap agent di KPM ini menjalani proses lisensi dan shadowing yang sama dengan yang akan Anda jalani. Masa 90 hari pertama sudah terstruktur, jadi Anda tidak pernah menjual sendirian.',
    },
    'stable-job': {
      theySay: 'Saya sudah punya pekerjaan yang stabil. Kenapa saya harus melepasnya?',
      youSay:
        'Anda tidak perlu berhenti bekerja di hari pertama. Kebanyakan agent mulai paruh waktu, mencapai target aktivitas dan penghasilan tertentu, lalu baru beralih sepenuhnya setelah angkanya terbukti. Ini langkah yang terukur, bukan langkah nekat.',
    },
    'reputation': {
      theySay: 'Asuransi punya reputasi buruk. Orang tidak percaya pada agent.',
      youSay:
        'Reputasi itu muncul dari produk yang dijual dengan cara yang buruk, bukan dari industrinya sendiri. Proses kami dibangun untuk menjaga nasabah dalam jangka panjang, bukan untuk penjualan sekali jalan. Hal itu mengubah cara Anda menjual dalam praktiknya.',
    },
    'no-network': {
      theySay: 'Saya tidak punya jaringan untuk dijual.',
      youSay:
        'Tidak ada yang mulai dengan jaringan lengkap. Di 90 hari pertama kita membangun daftar kontak secara terstruktur: referensi, komunitas, dan sumber leads yang jelas, bukan hanya keluarga dan teman.',
    },
    'time': {
      theySay: 'Saya khawatir soal berapa banyak waktu yang dibutuhkan di luar jadwal rutin saya.',
      youSay:
        'Yang dicatat adalah aktivitas, bukan jam kerja. Fitur Goal Settings menunjukkan aktivitas minimum yang dibutuhkan untuk mencapai target, jadi Anda merencanakan berdasarkan angka, bukan menebak-nebak jam kerja.',
    },
  },
  profileObjections: {
    'business-owner': {
      'stable-job': {
        theySay: 'Saya sudah punya usaha sendiri yang berjalan. Kenapa harus menambah ini?',
        youSay:
          'Anda tidak meninggalkan apa yang sudah Anda bangun. Anda menambah mesin kedua yang tumbuh dengan cara yang sama: lewat orang-orang dan aktivitas yang konsisten, bukan hanya dari jam kerja Anda sendiri.',
      },
    },
    'retiree': {
      'time': {
        theySay: 'Saya tidak yakin saat ini punya banyak waktu untuk ini.',
        youSay:
          'Justru karena itu aktivitas diukur dari hasilnya, bukan jam kerja. Anda bisa mulai ringan, dan fitur Goal Settings akan menunjukkan batas minimum yang dibutuhkan. Tidak perlu menebak, tidak perlu memaksakan diri.',
      },
    },
    'other-insurer': {
      'stable-job': {
        theySay: 'Saya sudah membangun hubungan di agensi saya sekarang. Kenapa harus mulai dari awal lagi?',
        youSay:
          'Anda tidak mulai dari awal. Portofolio nasabah dan hubungan Anda ikut Anda bawa. Yang berubah adalah struktur komisi dan dukungan di belakang Anda, bukan hubungan yang sudah Anda bangun.',
      },
    },
  },
  nextAction:
    'Kirim Opportunity Overview dari Pitch Materials, lalu tetapkan tanggal ujian lisensi atau sesi shadowing pertama. Jangan dibiarkan terbuka.',
};
