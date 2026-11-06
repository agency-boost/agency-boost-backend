import { formatMonth } from '@/common/format/format';
import { messages } from '@/common/i18n/sentence';

/**
 * **The monthly template's guide, in both languages** (ADR-0184): the *Petunjuk* sheet of the Excel template — what to
 * do, what each column holds, This Month against YTD, the decimal mark, what not to change, and that a partial file is
 * fine (ADR-0051). Its headings are `common/spreadsheet`'s.
 *
 * *Since P19.5-T2* (ADR-0214 §5) the columns are the KPM's template's, each named as the header names it in the reader's
 * language — *APE (Rp juta) [APE]* — and described by its unit, its start month, whom it is for and its tip.
 */
export const PRODUCTION_TEMPLATE_WORDS = messages('modules/production template', {
  title: ({ month }: { month: string }) => ({
    en: (figures) => `AgencyBoost — the monthly production template, ${formatMonth(month, figures)}`,
    id: `AgencyBoost — template produksi bulanan, ${formatMonth(month, 'id')}`,
  }),
  stepFill: {
    en: 'Fill in the Data sheet: one row per agent, each already listed with their agent code and name.',
    id: 'Isi sheet Data: satu baris per agen, masing-masing sudah berisi kode agen dan namanya.',
  },
  stepFigures: {
    en: 'Type each figure in its column. Leave a cell empty where the carrier has not reported it: an empty cell changes '
      + 'nothing.',
    id: 'Ketik setiap angka di kolomnya. Kosongkan sel yang belum dilaporkan perusahaan asuransi: sel kosong tidak mengubah '
      + 'apa pun.',
  },
  stepUpload: {
    en: 'Save the file as it is (.xlsx) and upload it on Data upload, for this month. You see what would change before '
      + 'anything does.',
    id: 'Simpan file apa adanya (.xlsx) dan unggah di Data upload, untuk bulan ini. Anda melihat apa yang akan berubah '
      + 'sebelum ada yang berubah.',
  },
  agentCode: {
    en: 'The agent’s code, as the office holds it. It is how a row is matched to a person: do not change it.',
    id: 'Kode agen, seperti yang tercatat di KPM. Kode inilah yang mencocokkan baris dengan orangnya: jangan diubah.',
  },
  agentName: {
    en: 'For you to read. It is never used to match a row.',
    id: 'Untuk Anda baca. Nama tidak pernah dipakai untuk mencocokkan baris.',
  },
  /** P19.5-T2 (ADR-0214 §5): a column's unit, as the guide's *Isi* begins. */
  unitOf: ({ unit }: { unit: 'rp_million' | 'percent' | 'count' }) => ({
    en: unit === 'rp_million' ? 'In millions of rupiah: 1.5 is Rp 1,500,000.'
      : unit === 'percent' ? 'A percentage from 0 to 100: 85, or 85%.' : 'A whole number.',
    id: unit === 'rp_million' ? 'Dalam juta rupiah: 1,5 berarti Rp 1.500.000.'
      : unit === 'percent' ? 'Persentase dari 0 sampai 100: 85, atau 85%.' : 'Bilangan bulat.',
  }),
  requiredFrom: ({ month }: { month: string }) => ({
    en: `Required for every agent from ${month}.`,
    id: `Wajib diisi untuk setiap agen mulai ${month}.`,
  }),
  optional: {
    en: 'Optional.',
    id: 'Tidak wajib.',
  },
  startsIn: ({ month }: { month: string }) => ({
    en: `Counts from ${month}.`,
    id: `Berlaku mulai ${month}.`,
  }),
  notYetInForce: {
    en: 'Not yet in force for this month: leave it empty.',
    id: 'Belum berlaku untuk bulan ini: kosongkan.',
  },
  leaderRowsOnly: {
    en: 'AB and AAB rows only; leave it empty on an agent’s row.',
    id: 'Hanya untuk baris AB dan AAB; kosongkan di baris agen.',
  },
  thisMonth: {
    en: 'This month alone.',
    id: 'Bulan ini saja.',
  },
  yearToDate: {
    en: 'The year to date the carrier reports, January to this month.',
    id: 'YTD yang dilaporkan perusahaan, Januari sampai bulan ini.',
  },
  /** P19.5-T2 (R4): a year to date is calculated, and only a column the template uploads one for has a YTD column. */
  ruleCalculatedYtd: {
    en: 'Fill in each month’s own figures. The year to date is calculated from the months, so it has no column here — '
      + 'except for a column marked YTD, whose year to date the carrier reports.',
    id: 'Isi angka bulan ini saja. YTD dihitung dari bulan-bulannya, jadi tidak ada kolomnya di sini — kecuali kolom '
      + 'bertanda YTD, yang YTD-nya dilaporkan perusahaan.',
  },
  ruleNumbers: {
    en: 'Type a figure as a number, with your spreadsheet’s own decimal mark. Money is in millions of rupiah (Rp M).',
    id: 'Ketik angka sebagai angka, dengan tanda desimal spreadsheet Anda sendiri. Uang dalam juta rupiah (Rp juta).',
  },
  ruleUnchanged: {
    en: 'Do not change the Agent Code column, and keep the [KODE] at the end of each column name: it is how a column is '
      + 'read, whatever its name says.',
    id: 'Jangan mengubah kolom Agent Code, dan pertahankan [KODE] di akhir setiap nama kolom: dari situlah kolom dibaca, '
      + 'apa pun namanya.',
  },
  /** P19.3-T1: the leader rows' column — optional, and never on an agent's row. */
  ruleLeaderOnly: {
    en: 'A column for AB and AAB rows only takes no figure on an agent’s row: one there is listed in the preview and not '
      + 'stored; the rest of the row imports.',
    id: 'Kolom khusus baris AB dan AAB tidak diisi di baris agen: angka di sana ditampilkan di pratinjau dan tidak '
      + 'disimpan; sisa barisnya tetap diimpor.',
  },
  rulePartial: {
    en: 'A partial file is fine: an empty cell or a missing row keeps what is stored, and a row that cannot be read is '
      + 'listed in the preview while the rest imports.',
    id: 'File sebagian tidak masalah: sel kosong atau baris yang tidak ada tetap seperti yang tersimpan, dan baris yang tidak '
      + 'dapat dibaca ditampilkan di pratinjau sementara sisanya diimpor.',
  },
});

/**
 * **What a preview says about the file's columns** (P19.5-T2 AC-3; AA UI-013, AT-3; ADR-0214 §5): a column of the KPM's
 * template the file lacks, and a header the file has that nothing stores. Not refusals — the file still imports — so a
 * catalogue of their own, written for the preview's reader.
 */
export const PRODUCTION_UPLOAD_NOTES = messages('modules/production notes', {
  /** AA UI-013's own words: a column the file lacks is *not provided*, and no row is skipped for it. */
  columnMissing: ({ name }: { name: string }) => ({
    en: `Column ${name} is empty in this file. The rows still import.`,
    id: `Kolom ${name} kosong di file ini. Baris tetap diimpor.`,
  }),
  /** An archived or unknown `[KODE]`, or an issued YTD of a column whose year to date is calculated. */
  columnRetired: ({ name }: { name: string }) => ({
    en: `Column ${name} is no longer used. It is not stored.`,
    id: `Kolom ${name} tidak dipakai lagi`,
  }),
  /** A header that matches nothing, with no `[KODE]`. */
  columnUnknown: ({ header }: { header: string }) => ({
    en: `Column ${header} is not recognised. It is not stored.`,
    id: `Kolom ${header} tidak dikenali`,
  }),
  /** A column whose *Berlaku mulai* is after the month: it is not read for it (R2). */
  columnNotInForce: ({ name, from }: { name: string; from: string }) => ({
    en: (figures) => `Column ${name} counts from ${formatMonth(from, figures)}, so it is not imported for this month.`,
    id: `Kolom ${name} berlaku mulai ${formatMonth(from, 'id')}, jadi tidak diimpor untuk bulan ini.`,
  }),
});
