import { formatMonth } from '@/common/format/format';
import { messages } from '@/common/i18n/sentence';

/**
 * **The monthly template's guide, in both languages** (ADR-0184): the *Petunjuk* sheet of the Excel template — what to
 * do, what each column holds, This Month against YTD, the decimal mark, what not to change, and that a partial file is
 * fine (ADR-0051). Its headings are `common/spreadsheet`'s.
 *
 * **The file's own words stay the file's** (P18.98-T3 AC-4): a column is named as the header names it — *Agent Code*,
 * *APE (Rp M) — This Month* — in both languages; *APE*, *FYP*, *YTD* and *Data upload* are kept (§A.4).
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
  ape: {
    en: 'APE, in millions of rupiah: 1.5 is Rp 1,500,000.',
    id: 'APE, dalam juta rupiah: 1,5 berarti Rp 1.500.000.',
  },
  persistency: {
    en: 'Rolling persistency, a percentage from 0 to 100: 85, or 85%.',
    id: 'Rolling persistency, persentase dari 0 sampai 100: 85, atau 85%.',
  },
  recruitment: {
    en: 'People recruited, a whole number.',
    id: 'Orang yang direkrut, bilangan bulat.',
  },
  newActiveAgents: {
    en: 'New active agents, a whole number.',
    id: 'Agen aktif baru, bilangan bulat.',
  },
  fyp: {
    en: 'FYP, in millions of rupiah.',
    id: 'FYP, dalam juta rupiah.',
  },
  policyCount: {
    en: 'Policies, a whole number.',
    id: 'Jumlah polis, bilangan bulat.',
  },
  thisMonth: {
    en: 'This month alone.',
    id: 'Bulan ini saja.',
  },
  yearToDate: {
    en: 'From January to this month.',
    id: 'Dari Januari sampai bulan ini.',
  },
  ruleCadence: {
    en: 'This Month is the month alone; YTD is the year so far, January to this month — so YTD is never less than This '
      + 'Month.',
    id: 'This Month adalah bulan ini saja; YTD adalah tahun berjalan, Januari sampai bulan ini — jadi YTD tidak pernah lebih '
      + 'kecil dari This Month.',
  },
  ruleNumbers: {
    en: 'Type a figure as a number, with your spreadsheet’s own decimal mark. Money is in millions of rupiah (Rp M).',
    id: 'Ketik angka sebagai angka, dengan tanda desimal spreadsheet Anda sendiri. Uang dalam juta rupiah (Rp M).',
  },
  ruleUnchanged: {
    en: 'Do not change the Agent Code column, the column names or their order, and do not rename the Data sheet.',
    id: 'Jangan mengubah kolom Agent Code, nama kolom, atau urutannya, dan jangan mengganti nama sheet Data.',
  },
  rulePartial: {
    en: 'A partial file is fine: an empty cell or a missing row keeps what is stored, and a row that cannot be read is '
      + 'listed in the preview while the rest imports.',
    id: 'File sebagian tidak masalah: sel kosong atau baris yang tidak ada tetap seperti yang tersimpan, dan baris yang tidak '
      + 'dapat dibaca ditampilkan di pratinjau sementara sisanya diimpor.',
  },
});
