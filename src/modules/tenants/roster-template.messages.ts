import { messages } from '@/common/i18n/sentence';

/**
 * **The roster template's guide, in both languages** (ADR-0184): the *Petunjuk* sheet of the Excel template — what the
 * CSV template carried as `#` lines above its header until 2026-11-01, and more: how to fill it in, what each column
 * holds, the rules, and the three worked examples. Its headings are `common/spreadsheet`'s.
 *
 * **Files are not words** (P18.98-T3 AC-4): a column is named as the header names it (`fullName`, `leaderAgentCode`),
 * and what is typed in a cell (`full-time`, `male`, `YYYY-MM-DD`) is the import's contract, the same in both. A rung is a
 * *jenjang* and the ladder the *susunan jenjang*, as the import's own refusals say; *leader* and *KPM* are kept (§B.9).
 */
export const ROSTER_TEMPLATE_WORDS = messages('modules/tenants roster template', {
  title: {
    en: 'AgencyBoost — the roster template',
    id: 'AgencyBoost — template roster',
  },
  stepFill: {
    en: 'Fill in the Data sheet: one row per person, from row 2. Leave its first row, the column names, as it is.',
    id: 'Isi sheet Data: satu baris per orang, mulai baris 2. Biarkan baris pertamanya, nama kolom, apa adanya.',
  },
  stepColumns: {
    en: 'Each column is described below. Every column must be filled in but leaderAgentCode.',
    id: 'Setiap kolom dijelaskan di bawah. Semua kolom wajib diisi kecuali leaderAgentCode.',
  },
  stepUpload: {
    en: 'Save the file as it is (.xlsx), upload it on the import page and check it. Nobody is created until you import.',
    id: 'Simpan file apa adanya (.xlsx), unggah di halaman impor, lalu periksa. Belum ada yang dibuat sebelum Anda mengimpor.',
  },
  fullName: {
    en: 'The person’s full name.',
    id: 'Nama lengkap orang tersebut.',
  },
  email: {
    en: 'Their email address, one nobody has registered yet. You send them their password yourself: nothing is emailed.',
    id: 'Alamat email orang tersebut, yang belum didaftarkan siapa pun. Anda sendiri yang mengirimkan kata sandinya: tidak '
      + 'ada email yang dikirim.',
  },
  agentCode: {
    en: 'The code their insurer issued: digits only, 3 to 32 of them, unique within the insurer.',
    id: 'Kode dari perusahaan asuransinya: hanya angka, 3 sampai 32 digit, unik di perusahaan asuransi itu.',
  },
  /** `rungs` the ladder's codes, as the dropdown offers them. */
  roleFromLadder: ({ rungs }: { rungs: string }) => ({
    en: `The code of their rung on your company’s ladder: ${rungs}. Choose it from the list.`,
    id: `Kode jenjangnya di susunan jenjang perusahaan Anda: ${rungs}. Pilih dari daftar.`,
  }),
  role: {
    en: 'The code of their rung on your company’s ladder: AB, AAB or Agent, or a rung the company added.',
    id: 'Kode jenjangnya di susunan jenjang perusahaan Anda: AB, AAB, atau Agent, atau jenjang yang ditambahkannya.',
  },
  leaderAgentCode: {
    en: 'The agent code of the leader they report to. Leave it empty for somebody who reports to nobody.',
    id: 'Kode agen leader orang tersebut. Kosongkan untuk orang yang tidak melapor kepada siapa pun.',
  },
  dateOfBirth: {
    en: 'YYYY-MM-DD, like 1990-03-15. They must be at least 18.',
    id: 'YYYY-MM-DD, misalnya 1990-03-15. Minimal berusia 18 tahun.',
  },
  companyJoinMonth: {
    en: 'YYYY-MM, like 2021-07: the month they joined the insurer.',
    id: 'YYYY-MM, misalnya 2021-07: bulan orang tersebut bergabung dengan perusahaan asuransi.',
  },
  workStatus: {
    en: 'full-time or part-time. Choose it from the list.',
    id: 'full-time atau part-time. Pilih dari daftar.',
  },
  gender: {
    en: 'male or female. Choose it from the list.',
    id: 'male atau female. Pilih dari daftar.',
  },
  ruleOnePerRow: {
    en: 'One person per row: an email or an agent code appears once in the file.',
    id: 'Satu orang per baris: sebuah email atau kode agen hanya muncul sekali di file.',
  },
  ruleLeaders: {
    en: 'Rows can come in any order: a leader may be above or below the people who report to them, or already in the '
      + 'office.',
    id: 'Urutan baris bebas: leader boleh di atas atau di bawah orang yang melapor kepadanya, atau sudah ada di KPM.',
  },
  ruleDates: {
    en: 'Dates are written YYYY-MM-DD and months YYYY-MM. Those columns are text, so what you type stays as you typed it.',
    id: 'Tanggal ditulis YYYY-MM-DD dan bulan YYYY-MM. Kolom itu berformat teks, jadi yang Anda ketik tetap seperti '
      + 'yang diketik.',
  },
  ruleUnchanged: {
    en: 'Do not rename, move or delete the Data sheet’s columns, and do not rename the sheet.',
    id: 'Jangan mengganti nama, memindahkan, atau menghapus kolom di sheet Data, dan jangan mengganti nama sheet-nya.',
  },
  ruleAllOrNothing: {
    en: 'The import is all or nothing: if any row has a problem nobody is created, and the check lists every problem by '
      + 'its row.',
    id: 'Impor ini semua atau tidak sama sekali: jika ada satu baris yang bermasalah, tidak ada yang dibuat, dan '
      + 'pemeriksaan menampilkan setiap masalah per barisnya.',
  },
});
