import { formatNumber } from '@/common/format/format';
import { messages, refusals } from '@/common/i18n/sentence';

/** A count in an Indonesian sentence: *1.000*. English keeps the number as it was. */
const n = (count: number) => formatNumber(count, undefined, 'id');

/**
 * **A spreadsheet file's refusals, in both languages** (ADR-0184): what the roster import and the Data upload both say
 * about a file before either reads a row of it — a file that is neither text nor a workbook, a workbook that will not
 * open or has no sheet to read, and one too large inside. What each import says about a *row* stays its own.
 *
 * *Workbook* and *sheet* are the spreadsheet's own words, kept in Indonesian as a spreadsheet in Indonesian keeps them;
 * *Data* is the sheet's name in both.
 */
export const SPREADSHEET_REFUSALS = refusals('common/spreadsheet', {
  UPLOAD_MALFORMED_CSV: {
    notText: {
      en: 'This is neither a text file nor an Excel workbook. Upload the filled template as .xlsx or .csv.',
      id: 'Ini bukan file teks maupun workbook Excel. Unggah template yang sudah diisi sebagai .xlsx atau .csv.',
    },
    notAWorkbook: {
      en: 'This file looks like a workbook but cannot be opened as one. Save it again from the spreadsheet as Excel '
        + '(.xlsx) or as CSV, and upload that.',
      id: 'File ini tampak seperti workbook tetapi tidak dapat dibuka. Simpan ulang dari spreadsheet sebagai Excel (.xlsx) '
        + 'atau CSV, lalu unggah file itu.',
    },
    noDataSheet: ({ sheet }: { sheet: string }) => ({
      en: `The workbook has no sheet called “${sheet}”, and none of its sheets starts with the template’s header. Fill in `
        + `the template’s ${sheet} sheet and upload that.`,
      id: `Workbook ini tidak memiliki sheet bernama “${sheet}”, dan tidak ada sheet yang diawali header template. Isi sheet `
        + `${sheet} di template, lalu unggah file itu.`,
    }),
  },
  ASSET_TOO_LARGE: {
    unpacksTooLarge: ({ mb }: { mb: number }) => ({
      en: `The workbook unpacks to more than ${mb} MB. A filled template is well under one — check this is the right file.`,
      id: `Workbook ini lebih dari ${n(mb)} MB setelah dibuka. Template yang sudah diisi jauh di bawah 1 MB — periksa apakah `
        + 'ini file yang benar.',
    }),
    tooManyParts: ({ max }: { max: number }) => ({
      en: `The workbook holds more than ${max} parts. A filled template holds about a dozen — check this is the right file.`,
      id: `Workbook ini memuat lebih dari ${n(max)} bagian. Template yang sudah diisi hanya memuat sekitar selusin — periksa `
        + 'apakah ini file yang benar.',
    }),
    tooManyRows: ({ max }: { max: number }) => ({
      en: `The sheet has more than ${max} rows. The template has one row per person — check this is the right file.`,
      id: `Sheet ini memiliki lebih dari ${n(max)} baris. Template berisi satu baris per orang — periksa apakah ini file yang `
        + 'benar.',
    }),
    tooManyColumns: ({ max }: { max: number }) => ({
      en: `The sheet has a value beyond column ${max}. The template has far fewer columns — check this is the right file.`,
      id: `Sheet ini memiliki nilai di luar kolom ${n(max)}. Template memiliki jauh lebih sedikit kolom — periksa apakah ini `
        + 'file yang benar.',
    }),
  },
});

/**
 * **The words every template workbook's guide sheet shares** (ADR-0184): its name, its headings and the dropdown's
 * refusal. What each guide *says* is its import's own (`roster-template.messages.ts`, `production-template.messages.ts`).
 * *Petunjuk* is the guide sheet's name in Indonesian (the glossary's *Petunjuk sheet*); the Data sheet's name is the same
 * in both and is a constant (`SPREADSHEET.DATA_SHEET`), never a word of this catalogue.
 */
export const SPREADSHEET_WORDS = messages('common/spreadsheet', {
  guideSheet: { en: 'Guide', id: 'Petunjuk' },
  stepsHeading: { en: 'How to fill it in', id: 'Cara mengisi' },
  columnsHeading: ({ sheet }: { sheet: string }) => ({
    en: `The ${sheet} sheet’s columns, in order`,
    id: `Kolom di sheet ${sheet}, berurutan`,
  }),
  rulesHeading: { en: 'Rules', id: 'Aturan' },
  examplesHeading: { en: 'Example rows', id: 'Contoh baris' },
  column: { en: 'Column', id: 'Kolom' },
  required: { en: 'Required?', id: 'Wajib?' },
  holds: { en: 'What to enter', id: 'Isi' },
  example: { en: 'Example', id: 'Contoh' },
  yes: { en: 'Yes', id: 'Ya' },
  no: { en: 'No', id: 'Tidak' },
  listErrorTitle: { en: 'Not on the list', id: 'Tidak ada di daftar' },
  listError: { en: 'Choose one of the values on the list.', id: 'Pilih salah satu nilai di daftar.' },
});
