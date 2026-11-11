import { messages } from '@/common/i18n/sentence';

/**
 * **The member template's guide, in both languages** (ADR-0184; A3's columns since P19.3-T4, ADR-0205 §5): the
 * *Petunjuk* sheet of the Excel template — how to fill it in, what each column holds, the rules, and the three worked
 * examples. Its headings are `common/spreadsheet`'s.
 *
 * **Files are not words** (P18.10-T3 AC-4): a column is named as the header names it (*Kode agen*, *Kode upline*), and
 * what is typed in a cell (`Full-time`, `male`, `DD/MM/YYYY`) is the import's contract, the same in both. A rung is a
 * *jenjang* and the ladder the *susunan jenjang*, as the import's own words say; *leader*, *upline* and *KPM* are kept.
 */
export const ROSTER_TEMPLATE_WORDS = messages('modules/tenants roster template', {
  title: {
    en: 'AgencyBoost — the member template',
    id: 'AgencyBoost — template anggota',
  },
  stepFill: {
    en: 'Fill in the Data sheet: one row per person, from row 2. Leave its first row, the column names, as it is.',
    id: 'Isi sheet Data: satu baris per orang, mulai baris 2. Biarkan baris pertamanya, nama kolom, apa adanya.',
  },
  stepColumns: {
    en: 'Each column is described below. Kode agen, Nama and Peran are required; leave any other cell empty when you do '
      + 'not know it.',
    id: 'Setiap kolom dijelaskan di bawah. Kode agen, Nama, dan Peran wajib diisi; kosongkan sel lain bila tidak tahu '
      + 'isinya.',
  },
  stepUpload: {
    en: 'Save the file as it is (.xlsx), upload it on the import page and check it. Nobody is added until you import.',
    id: 'Simpan file apa adanya (.xlsx), unggah di halaman impor, lalu periksa. Belum ada yang ditambahkan sebelum Anda '
      + 'mengimpor.',
  },
  agentCode: {
    en: 'The code their insurer issued: digits only, 3 to 32 of them. A code already in this KPM updates that person.',
    id: 'Kode dari perusahaan asuransinya: hanya angka, 3 sampai 32 digit. Kode yang sudah ada di KPM ini memperbarui '
      + 'data orang itu.',
  },
  fullName: {
    en: 'The person’s full name.',
    id: 'Nama lengkap orang tersebut.',
  },
  /** `rungs` the ladder's rungs, as the dropdown offers them. */
  roleFromLadder: ({ rungs }: { rungs: string }) => ({
    en: `Their rung on your company’s ladder: ${rungs}. Choose it from the list.`,
    id: `Jenjangnya di susunan jenjang perusahaan Anda: ${rungs}. Pilih dari daftar.`,
  }),
  role: {
    en: 'Their rung on your company’s ladder: Agent, AAB or AB, or a rung the company added.',
    id: 'Jenjangnya di susunan jenjang perusahaan Anda: Agent, AAB, atau AB, atau jenjang yang ditambahkannya.',
  },
  leaderAgentCode: {
    en: 'The agent code of their upline: a leader (AAB or AB) at least their rank, in this file or already in the KPM. '
      + 'Empty only for the top rung.',
    id: 'Kode agen upline-nya: leader (AAB atau AB) yang jenjangnya paling tidak sama, di file ini atau sudah ada di KPM. '
      + 'Kosongkan hanya untuk jenjang teratas.',
  },
  phone: {
    en: 'Their WhatsApp number, like 0812 1100 8801. Without one they are added, and cannot be reminded on WhatsApp yet. '
      + 'A new Agent with no email is invited on it.',
    id: 'Nomor WhatsApp-nya, misalnya 0812 1100 8801. Tanpa nomor, mereka tetap masuk, tetapi belum bisa diingatkan lewat '
      + 'WhatsApp. Agent baru tanpa email diundang lewat nomor ini.',
  },
  /* ADR-0250 §4: an Agent with no email is invited on WhatsApp, as + Tambah agent invites. */
  email: {
    en: 'Their email address, which they sign in with. Needed for somebody new: the invitation to choose a password goes '
      + 'there. A new Agent with no email but a WhatsApp number is invited on WhatsApp, and registers with their own email.',
    id: 'Alamat email-nya, untuk masuk. Wajib untuk orang baru: undangan untuk membuat kata sandi dikirim ke sana. Agent '
      + 'baru tanpa email tetapi dengan nomor WhatsApp diundang lewat WhatsApp, lalu mendaftar dengan email-nya sendiri.',
  },
  joinDate: {
    en: 'DD/MM/YYYY, like 15/01/2026: the day they joined this KPM. Empty is the day of the import.',
    id: 'DD/MM/YYYY, misalnya 15/01/2026: tanggal mereka bergabung di KPM ini. Kosong berarti tanggal impor.',
  },
  workStatus: {
    en: 'Full-time or Part-time. Choose it from the list.',
    id: 'Full-time atau Part-time. Pilih dari daftar.',
  },
  dateOfBirth: {
    en: 'DD/MM/YYYY, like 15/03/1990. They must be at least 18.',
    id: 'DD/MM/YYYY, misalnya 15/03/1990. Minimal berusia 18 tahun.',
  },
  /* ADR-0250 §1: the list offers two words; a paste or a CSV is read in the others too. */
  gender: {
    en: 'male or female. Choose it from the list. Pasted or in a CSV, L or P and Laki-laki or Perempuan are read too.',
    id: 'male atau female. Pilih dari daftar. Bila ditempel atau di CSV, L atau P dan Laki-laki atau Perempuan juga dibaca.',
  },
  companyJoinMonth: {
    en: 'YYYY-MM, like 2021-07: the month they joined the insurer.',
    id: 'YYYY-MM, misalnya 2021-07: bulan mereka bergabung dengan perusahaan asuransi.',
  },
  ruleOnePerRow: {
    en: 'One person per row: an agent code or an email appears once in the file.',
    id: 'Satu orang per baris: sebuah kode agen atau email hanya muncul sekali di file.',
  },
  ruleUplines: {
    en: 'Rows can come in any order: an upline is matched in the file and among the people already in the KPM.',
    id: 'Urutan baris bebas: upline dicocokkan dari file dan dari anggota yang sudah ada di KPM.',
  },
  ruleExisting: {
    en: 'A code already in this KPM updates that person: an empty cell keeps what is stored, and an email is never changed.',
    id: 'Kode yang sudah ada di KPM ini memperbarui data orang itu: sel kosong mempertahankan data yang tersimpan, dan '
      + 'email tidak pernah diubah.',
  },
  ruleDates: {
    en: 'Days are written DD/MM/YYYY and months YYYY-MM. Those columns are text, so what you type stays as you typed it.',
    id: 'Tanggal ditulis DD/MM/YYYY dan bulan YYYY-MM. Kolom itu berformat teks, jadi yang Anda ketik tetap seperti yang '
      + 'diketik.',
  },
  ruleUnchanged: {
    en: 'Do not rename, move or delete the Data sheet’s columns, and do not rename the sheet.',
    id: 'Jangan mengganti nama, memindahkan, atau menghapus kolom di sheet Data, dan jangan mengganti nama sheet-nya.',
  },
  /* ADR-0250 §2: a bad optional cell is left empty, and only a required one skips the row. */
  ruleSkipped: {
    en: 'An optional cell written wrongly is left empty, with a warning, and the person is still added. A row with a problem '
      + 'in Kode agen, Nama, Peran, Kode upline or a new person’s Email is skipped with its reason, and the rest are added '
      + 'together. Download the skipped rows, fix them and upload them again.',
    id: 'Sel opsional yang salah isi dikosongkan, dengan peringatan, dan orangnya tetap masuk. Baris yang bermasalah di '
      + 'Kode agen, Nama, Peran, Kode upline, atau Email orang baru dilewati dengan alasannya, dan sisanya masuk sekaligus. '
      + 'Unduh baris yang dilewati, perbaiki, lalu unggah lagi.',
  },
});
