/**
 * **Budi's long pipeline** (P13.1-T3 AC-3): enough open leads that `/leads` shows its first 30 and
 * *Show more* (P13.1-T4 AC-8), on an account a reviewer can sign in as.
 *
 * ## Why Budi
 *
 * The leads table pages at 30, and no demo account came near it: Rina, with the most, has 15. One
 * existing Agent in 0417 had to carry the rest, and every other choice moves a demo already reviewed:
 *
 * - **Rina** is the agent every walk and manual describes, lead by lead: her closed cards, the
 *   overdue lead her Summary names first, the leads her coaching sessions name.
 * - **Yanti** came back 28 days ago, and a lead belongs to the membership that registered it, so her
 *   current one cannot hold a pipeline that spans months.
 * - **The coaching cast** (Indah, Dimas, Siti, Novi, Wahyu) are pinned by `coaching-cast.ts`, one lead
 *   promised this month each; Siti holds the one promised with no date, which a session checks.
 * - **Putri and Fajar** are pending and read no leads.
 *
 * **Budi** joined 61 days ago, sold steadily for four weeks a month and more ago, logged one day nine
 * days ago and nothing since (`coaching-cast.ts`): the roster's *Needs attention*, with no 1:1 yet. A
 * pipeline he built while he was working and then let go is that story, and Sari's coaching item for
 * Agus already names it: *"Go through Budi's lapsed prospects with him"* (`coaching-fixture.ts`). Nothing
 * else counted his leads: no other seed spec, walk or manual does, his activation's prospects item is
 * done by any lead at all, and his roster status is read from his goal, activity and production, never
 * from his leads. `settings-seed.spec.ts` pins the count now.
 *
 * ## What is spread across them
 *
 * - **Registered over the weeks he worked** (58 to 32 days back) and on the one day he came back (9
 *   back), every one after he joined. Each move is dated between its registration and its last move,
 *   so the history reads as his weeks, not as one instant.
 * - **Both ladders, every stage but recruitment's last,** and two with no ladder yet (*Unassigned*). One
 *   sits open on the sales ladder's last stage, where ✓ is offered.
 * - **What a lapsed pipeline asks for:** most next actions overdue, some still ahead (set the day he came
 *   back), some never set — so the attention filter has plenty to find.
 * - **Phones as people type them** — `0812-…`, `+62 …`, `62…`, a leading `8`, and one too short to be a
 *   number — so the details dialog's WhatsApp button (P13.1-T4 AC-2) is offered, and once is not.
 * - **None promised for this month**: each coachee holds exactly one such promise (`coaching-cast.ts`).
 * - **No lawful basis**: the field is retired (ADR-0108 §1).
 *
 * Remarks and next actions are one short line each, as an agent types them (the client's item 5). No
 * name is anybody's in the office, which the coaching seed's spec checks for the whole office, nor any
 * other lead's there: `seedLeads` skips a name the office holds, so a clash would drop the lead silently,
 * and `settings-seed.spec.ts` counts all of these.
 */

export interface LongPipelineLead {
  name: string;
  type: 'sales' | 'recruitment' | null;
  /** The stages it has been through, oldest first; the last is where it sits. */
  path?: readonly string[];
  /** Days before the run it was registered. After Budi joined, 61 days back. */
  registeredDaysAgo: number;
  /** Days before the run of its last move; the moves between are spread from registration. */
  movedDaysAgo?: number;
  phone?: string;
  email?: string;
  remarks?: string;
  /** Days from today. Negative is in the past: overdue. */
  nextActionIn?: number;
  nextActionNote?: string;
  source?: string;
}

const SALES = ['NOT_YET_APPROACHED', 'FOLLOW_UP', 'POLICY_SUBMITTED', 'APPROVED_NOT_PAID', 'PAID_AND_ISSUED'];
const RECRUITMENT = [
  'NOT_APPROACHED', 'MEETING_SCHEDULED', 'RECRUITMENT_PRESENTATION', 'AGENT_CODE_CREATED',
  'AAJI_LICENSED', 'JOINT_FIELD_WORK_PLANNED',
];

/** A ladder walked rung by rung, as far as `rungs`. */
const sales = (rungs: number) => SALES.slice(0, rungs);
const recruitment = (rungs: number) => RECRUITMENT.slice(0, rungs);

/** Thirty-nine, every one open: with the three he already had, 42. */
export const LONG_PIPELINE: readonly LongPipelineLead[] = [
  // ------------------------------------------------------------------ sales
  { name: 'Pak Heru Susanto', type: 'sales', path: sales(2), registeredDaysAgo: 58, movedDaysAgo: 50, phone: '0812-7310-4421', remarks: 'Punya dua minimarket di Serpong. Ingin proteksi untuk istrinya.', nextActionIn: -20, nextActionNote: 'Telepon lagi soal produk keluarga.', source: 'Referral — keluarga' },
  { name: 'Pak Lukman Harahap', type: 'sales', path: sales(5), registeredDaysAgo: 58, movedDaysAgo: 33, phone: '0811-7765-4320', remarks: 'Sudah lunas. Menunggu polis cetak.', nextActionIn: 1, nextActionNote: 'Serahkan buku polisnya.', source: 'Referral — jaringan agen' },
  { name: 'Ibu Nining Kartika', type: 'sales', path: sales(1), registeredDaysAgo: 57, phone: '0813-5520-9087', remarks: 'Guru di sekolah swasta di Pamulang.', nextActionIn: -25, nextActionNote: 'Telepon pertama, setelah jam sekolah.', source: 'Canvassing — Pamulang' },
  { name: 'Pak Rudi Hermawan', type: 'sales', path: sales(3), registeredDaysAgo: 56, movedDaysAgo: 39, phone: '+62 821-1144-7788', remarks: 'Asuransi kesehatan untuk sekeluarga. Pemeriksaan medis sudah.', nextActionIn: -4, nextActionNote: 'Follow up underwriting soal hasil medisnya.', source: 'Referral — jaringan agen' },
  { name: 'Ibu Ani Suryani', type: 'sales', path: sales(2), registeredDaysAgo: 55, movedDaysAgo: 47, email: 'ani.suryani@example.com', remarks: 'Membandingkan kita dengan produk yang ditawarkan banknya.', nextActionIn: -15, nextActionNote: 'Kirim tabel perbandingannya.', source: 'Datang langsung — kantor BSD' },
  { name: 'Pak Taufik Rahman', type: 'sales', path: sales(1), registeredDaysAgo: 54, remarks: 'Ketemu di futsal hari Minggu. Tertarik, belum ada nomornya.', source: 'Komunitas — futsal' },
  { name: 'Ibu Veronika Siregar', type: 'sales', path: sales(2), registeredDaysAgo: 53, movedDaysAgo: 45, phone: '0811-8890-2213', remarks: 'Dua anak. Ingin produk dana pendidikan.', nextActionIn: 4, nextActionNote: 'Presentasikan ilustrasi dana pendidikan.', source: 'Referral — Ibu Ani' },
  { name: 'Pak Doni Simanjuntak', type: 'sales', path: sales(2), registeredDaysAgo: 52, movedDaysAgo: 44, phone: '0852-6612-0034', remarks: 'Kontraktor, usaha sendiri. Tanya soal penyakit kritis.', nextActionIn: -11, nextActionNote: 'Hitung premi rider penyakit kritis.', source: 'Canvassing — Alam Sutera' },
  { name: 'Ibu Margaretha Lim', type: 'sales', path: sales(4), registeredDaysAgo: 51, movedDaysAgo: 33, phone: '0816-2219-0905', remarks: 'Sudah disetujui. Premi pertama akan ditransfer.', nextActionIn: -2, nextActionNote: 'Konfirmasi transfer preminya.', source: 'Referral — kelompok gereja' },
  { name: 'Pak Ferry Kusnadi', type: 'sales', path: sales(1), registeredDaysAgo: 50, phone: '0857-4410-3326', remarks: 'Pensiunan PNS. Ingin menambah dana pensiunnya.', nextActionIn: -18, nextActionNote: 'Kunjungi ke rumah, pagi saja.', source: 'Referral — Pak Heru' },
  { name: 'Ibu Endang Sulastri', type: 'sales', path: sales(2), registeredDaysAgo: 49, movedDaysAgo: 41, phone: '0812-9001-6654', remarks: 'Punya usaha katering. Sibuk sampai lewat jam makan siang.', nextActionIn: -9, nextActionNote: 'Telepon setelah jam 14.00.', source: 'Datang langsung — kantor BSD' },
  { name: 'Pak Hadi Purnomo', type: 'sales', path: sales(2), registeredDaysAgo: 48, movedDaysAgo: 36, email: 'hadi.purnomo@example.com', remarks: 'Minta penawaran asuransi berjangka 20 tahun.', nextActionIn: 6, nextActionNote: 'Email penawaran asuransi berjangkanya.', source: 'Media sosial — Instagram' },
  { name: 'Ibu Retno Palupi', type: 'sales', path: sales(1), registeredDaysAgo: 47, phone: '0813-3870-1145', remarks: 'Baru menikah. Tanya proteksi untuk berdua.', source: 'Referral — Ibu Endang' },
  { name: 'Pak Johan Tanuwijaya', type: 'sales', path: sales(3), registeredDaysAgo: 46, movedDaysAgo: 35, phone: '0811-1937-5520', remarks: 'Unit link, Rp 1 juta sebulan. SPAJ sudah masuk.', nextActionIn: 3, nextActionNote: 'Cek status polis ke kantor.', source: 'Referral — Pak Rudi' },
  { name: 'Ibu Fitriani Lubis', type: 'sales', path: sales(2), registeredDaysAgo: 45, movedDaysAgo: 38, phone: '0821-6603-4471', remarks: 'Perawat, sering shift malam. Lebih suka WhatsApp.', nextActionIn: -13, nextActionNote: 'Kirim brosur lewat WhatsApp.', source: 'Canvassing — rumah sakit BSD' },
  // Typed short at a meeting: no WhatsApp button until the number is right.
  { name: 'Pak Benny Manurung', type: 'sales', path: sales(1), registeredDaysAgo: 44, phone: '0812-345', remarks: 'Nomornya kurang digit. Cek lagi saat ketemu berikutnya.', nextActionIn: -6, nextActionNote: 'Minta nomor yang benar.', source: 'Komunitas — rapat RT' },
  { name: 'Ibu Yuni Astuti', type: 'sales', path: sales(2), registeredDaysAgo: 43, movedDaysAgo: 37, phone: '0858-1270-6639', remarks: 'Minta premi lebih rendah dari ilustrasi.', nextActionIn: -7, nextActionNote: 'Buat ulang ilustrasi dengan uang pertanggungan lebih kecil.', source: 'Referral — Ibu Retno' },
  { name: 'Pak Ilham Nasution', type: 'sales', path: sales(1), registeredDaysAgo: 42, email: 'ilham.nst@example.com', remarks: 'Karyawan startup. Sudah dapat asuransi dari kantor.', nextActionIn: 10, nextActionNote: 'Jelaskan apa yang tidak ditanggung asuransi kantornya.', source: 'Media sosial — LinkedIn' },
  { name: 'Ibu Clara Wibisono', type: 'sales', path: sales(2), registeredDaysAgo: 40, movedDaysAgo: 34, phone: '0817-0090-1234', remarks: 'Ingin produk untuk orang tuanya, keduanya di atas 60.', nextActionIn: -1, nextActionNote: 'Cek batas usia sebelum menelepon.', source: 'Referral — Ibu Margaretha' },
  { name: 'Pak Gede Mahendra', type: 'sales', path: sales(3), registeredDaysAgo: 39, movedDaysAgo: 32, phone: '0819-3355-7781', remarks: 'Pindah dari Bali karena pekerjaan. Asuransi jiwa seumur hidup.', nextActionIn: 2, nextActionNote: 'Ambil formulir perubahan yang sudah ditandatangani.', source: 'Datang langsung — kantor BSD' },
  { name: 'Ibu Sri Wahyuni', type: 'sales', path: sales(1), registeredDaysAgo: 38, phone: '0812-1188-4002', remarks: 'Pemilik toko di pasar BSD.', nextActionIn: -16, nextActionNote: 'Mampir ke tokonya.', source: 'Canvassing — pasar BSD' },
  { name: 'Pak Stefanus Kurnia', type: 'sales', path: sales(2), registeredDaysAgo: 36, movedDaysAgo: 33, phone: '+62 813-9077-2210', remarks: 'Sedang menabung untuk rumah. Ragu dengan unit link.', nextActionIn: 8, nextActionNote: 'Tunjukkan produk tabungan tradisional.', source: 'Referral — Pak Johan' },
  { name: 'Ibu Okta Rahayu', type: 'sales', path: sales(1), registeredDaysAgo: 34, phone: '838 4412 7765', remarks: 'Orang tua tunggal, dua anak masih SD.', source: 'Komunitas — arisan' },
  { name: 'Ibu Natalia Pangaribuan', type: 'sales', path: sales(2), registeredDaysAgo: 9, movedDaysAgo: 9, phone: '0812-6021-3378', remarks: 'Ketemu di acara pernikahan. Mau ngobrol setelah gajian.', nextActionIn: 14, nextActionNote: 'Telepon setelah gajian.', source: 'Referral — Ibu Clara' },
  { name: 'Pak Rizky Ananta', type: 'sales', path: sales(1), registeredDaysAgo: 9, email: 'rizky.ananta@example.com', remarks: 'Tanya soal asuransi kesehatan lewat online.', nextActionIn: 5, nextActionNote: 'Balas dengan daftar rumah sakit rekanan.', source: 'Media sosial — Instagram' },

  // ------------------------------------------------------------ recruitment
  { name: 'Ibu Dian Oktaviani', type: 'recruitment', path: recruitment(5), registeredDaysAgo: 58, movedDaysAgo: 33, phone: '0813-6677-2200', remarks: 'Sudah lulus AAJI. Ingin mulai dari jaringannya sendiri.', nextActionIn: -8, nextActionNote: 'Minta tanggal JFW ke Sari.', source: 'Referral — jaringan agen' },
  { name: 'Pak Hendrik Wullur', type: 'recruitment', path: recruitment(6), registeredDaysAgo: 58, movedDaysAgo: 32, phone: '0852-4433-1100', remarks: 'Sudah berlisensi. JFW sudah disepakati, tanggalnya belum.', nextActionIn: 3, nextActionNote: 'Tetapkan tanggal JFW.', source: 'BOP — kantor BSD' },
  { name: 'Sdri. Aulia Rachman', type: 'recruitment', path: recruitment(1), registeredDaysAgo: 57, phone: '0812-4400-1290', remarks: 'Lulusan baru, cari pekerjaan yang fleksibel.', nextActionIn: -22, nextActionNote: 'Undang ke BOP berikutnya.', source: 'Referral — keluarga' },
  { name: 'Sdr. Fikri Alamsyah', type: 'recruitment', path: recruitment(2), registeredDaysAgo: 55, movedDaysAgo: 48, phone: '0856-9012-3344', remarks: 'Pengemudi ojek online. Ingin ganti karier.', nextActionIn: -10, nextActionNote: 'Ngopi sebelum dia mulai narik malam.', source: 'Komunitas — masjid' },
  { name: 'Sdri. Intan Pradipta', type: 'recruitment', path: recruitment(3), registeredDaysAgo: 53, movedDaysAgo: 40, email: 'intan.pradipta@example.com', remarks: 'Sudah ikut NBO. Tanya soal penghasilan tahun pertama.', nextActionIn: -3, nextActionNote: 'Jelaskan tabel penghasilannya.', source: 'BOP — kantor BSD' },
  { name: 'Ibu Wening Prabandari', type: 'recruitment', path: recruitment(1), registeredDaysAgo: 51, phone: '62813-1144-5566', remarks: 'Anak-anak sudah sekolah. Ingin kerja paruh waktu.', source: 'Referral — Ibu Nining' },
  { name: 'Pak Yohanes Sitompul', type: 'recruitment', path: recruitment(4), registeredDaysAgo: 50, movedDaysAgo: 32, phone: '0811-2290-8876', remarks: 'Mantan sales bank. Kode agen sudah terbit, berikutnya ujian AAJI.', nextActionIn: 7, nextActionNote: 'Daftarkan jadwal ujian AAJI-nya.', source: 'Referral — jaringan agen' },
  { name: 'Sdr. Reza Aditya', type: 'recruitment', path: recruitment(2), registeredDaysAgo: 46, movedDaysAgo: 41, phone: '0877-3301-9988', remarks: 'Mahasiswa tingkat akhir. Bisa mulai setelah lulus.', nextActionIn: 12, nextActionNote: 'Follow up setelah sidang skripsinya.', source: 'Career day kampus' },
  { name: 'Sdri. Melinda Susilo', type: 'recruitment', path: recruitment(3), registeredDaysAgo: 44, movedDaysAgo: 34, phone: '0812-8855-0101', remarks: 'Tertarik, tapi suaminya masih ragu.', nextActionIn: -5, nextActionNote: 'Ketemu bersama suaminya.', source: 'BOP — kantor BSD' },
  { name: 'Sdri. Gita Lestiani', type: 'recruitment', path: recruitment(1), registeredDaysAgo: 40, email: 'gita.lestiani@example.com', remarks: 'Kerja di HR. Penasaran dengan karier di agency.', nextActionIn: -12, nextActionNote: 'Kirim brosur kariernya.', source: 'Media sosial — LinkedIn' },
  { name: 'Sdr. Bima Aryasatya', type: 'recruitment', path: recruitment(2), registeredDaysAgo: 37, movedDaysAgo: 33, phone: '0819-5512-6670', remarks: 'Pemilik kafe. Ingin penghasilan tambahan.', nextActionIn: 9, nextActionNote: 'Ketemu di kafenya setelah tutup.', source: 'Referral — Pak Gede' },
  { name: 'Ibu Wiwik Setyaningsih', type: 'recruitment', path: recruitment(2), registeredDaysAgo: 9, movedDaysAgo: 9, phone: '0857-2200-1188', remarks: 'Mantan guru. Tanya soal jadwal pelatihan.', nextActionIn: 6, nextActionNote: 'Undang ke BOP berikutnya.', source: 'Referral — Ibu Okta' },

  // --------------------------------------------------- no ladder yet: Unassigned
  { name: 'Pak Darmawan', type: null, registeredDaysAgo: 47, remarks: 'Nama dari arisan, belum ada info lain.', source: 'Komunitas — arisan' },
  { name: 'Ibu Yeni', type: null, registeredDaysAgo: 33, remarks: 'Tetangga Ibu Okta. Antara proteksi atau karier, belum jelas.', source: 'Referral — Ibu Okta' },
];
