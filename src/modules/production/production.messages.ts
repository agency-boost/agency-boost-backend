import { formatDate, formatMonth, formatNumber } from '@/common/format/format';
import { readerIn } from '@/common/i18n/reader';
import { refusals, render, type Sentence } from '@/common/i18n/sentence';
import type { Language } from '@/domain/constants';

/** A count in an Indonesian sentence: *1.000*, the same digits below a thousand. English keeps the number as it was. */
const n = (count: number) => formatNumber(count, undefined, 'id');

/** The two cadences as a correction's sentence names a figure: *APE this month*, *APE year to date* (*APE YTD*). */
const CADENCE: Readonly<Record<Language, Readonly<Record<'monthly' | 'ytd', string>>>> = {
  en: { monthly: 'this month', ytd: 'year to date' },
  id: { monthly: 'bulan ini', ytd: 'YTD' },
};

/** What every header refusal ends with: nothing of the file was read. */
const TEMPLATE_TAIL = {
  en: 'Download the template for this month and fill that in — nothing has been read.',
  id: 'Unduh template untuk bulan ini dan isi template itu — belum ada yang dibaca.',
} as const;

/** What a refusal of an agent code a spreadsheet may have rewritten adds. */
const SPREADSHEET = {
  en: ' A spreadsheet may have rewritten it: format the Agent Code column as text, and copy the codes from the template.',
  id: ' Spreadsheet mungkin telah mengubahnya: format kolom Agent Code sebagai teks, lalu salin kode dari template.',
} as const;

/** The same thing to do, after a locked month's reason. */
const REOPEN = {
  en: 'Reopen the month to change its figures.',
  id: 'Buka kembali bulan ini untuk mengubah angkanya.',
} as const;

/**
 * **The production module's sentences, in both languages** (P18.98-T5 AC-2, AC-3): the month a write names, the file —
 * its form, its header, each row and each cell, which the preview answers and a commit keeps with the batch (written
 * for the request's reader, `buildPreview`) — confirm and revert, the month's lock and revision, and a correction by
 * hand. Filed by the code each is raised or reported under; a cell's reason is the end of a sentence, said after the
 * figure it is about.
 *
 * **The file's own words stay the file's** (P18.98-T3 AC-4): a column is named as its header names it — *APE (Rp M) —
 * This Month*, *Agent Code* — in both languages, and a value as the file has it. *APE*, *FYP*, *Rolling persistency*,
 * *Recruitment* and *New active agents* are metric names (§A.4), and *YTD* the forum's own (§A.4); a *figure* is an
 * *angka*, a *preview* a *pratinjau*.
 */
export const PRODUCTION_REFUSALS = refusals('modules/production', {
  VALIDATION_FAILED: {
    notAMonth: ({ month }: { month: string }) => ({
      en: `${month} is not a month. Use YYYY-MM.`,
      id: `${month} bukan bulan. Gunakan format YYYY-MM.`,
    }),
    monthRequired: {
      en: 'A month is required. Use YYYY-MM.',
      id: 'Bulan wajib diisi. Gunakan format YYYY-MM.',
    },
    attachFile: {
      en: 'Attach the filled template as the `file` field.',
      id: 'Lampirkan template yang sudah diisi sebagai kolom `file`.',
    },
    /** ADR-0184: the template is a workbook with `format=xlsx`, and the CSV without a format. */
    unknownFormat: {
      en: 'That is not a format the template comes in. Ask for format=xlsx, or for no format to have the CSV.',
      id: 'Itu bukan format template. Minta format=xlsx, atau tanpa format untuk CSV.',
    },
    notAForm: {
      en: 'The upload could not be read as a form. Send the filled template as the `file` field, and the month as `month`.',
      id: 'Unggahan tidak dapat dibaca sebagai formulir. Kirim template yang sudah diisi sebagai kolom `file`, dan bulannya '
        + 'sebagai `month`.',
    },
    revisionRequired: {
      en: 'Send the `revision` the preview was taken against.',
      id: 'Kirim `revision` yang menjadi dasar pratinjau.',
    },
    correctionNotInFile: {
      en: 'A correction named to be replaced is not one this file would change. Upload the file again.',
      id: 'Koreksi yang dipilih untuk diganti bukan koreksi yang akan diubah oleh file ini. Unggah file ini lagi.',
    },
    changesNothing: {
      en: 'This file would change nothing: every figure in it is blank, already stored, or not taken.',
      id: 'File ini tidak akan mengubah apa pun: setiap angka di dalamnya kosong, sudah tersimpan, atau tidak diambil.',
    },
    reasonRequired: {
      en: 'Say why the figure is being corrected.',
      id: 'Jelaskan mengapa angka ini dikoreksi.',
    },
    reasonTooLong: ({ max }: { max: number }) => ({
      en: `Keep the reason under ${max} characters.`,
      id: `Alasan tidak boleh lebih dari ${n(max)} karakter.`,
    }),
  },
  ASSET_TOO_LARGE: {
    fileTooLarge: ({ mb }: { mb: number }) => ({
      en: `The file is larger than ${mb} MB. The template for a whole office is a few kilobytes — check this is the right file.`,
      id: `File ini lebih besar dari ${n(mb)} MB. Template untuk satu KPM hanya beberapa kilobyte — periksa apakah ini file `
        + 'yang benar.',
    }),
  },
  UPLOAD_MALFORMED_CSV: {
    empty: {
      en: 'The file is empty.',
      id: 'File ini kosong.',
    },
    // A workbook is read since ADR-0184, and a file neither text nor a workbook is `common/spreadsheet`'s `notText`.
    unclosedQuote: ({ line }: { line: number }) => ({
      en: `A quote opened on line ${line} is never closed, so the rest of the file cannot be read.`,
      id: `Tanda kutip yang dibuka di baris ${line} tidak pernah ditutup, jadi sisa file tidak dapat dibaca.`,
    }),
    /** A row of the preview (`buildPreview`): more cells than the template. */
    tooManyCells: ({ cells, template }: { cells: number; template: number }) => ({
      en: `This row has ${cells} cells; the template has ${template}. A value holding a comma or a semicolon must be in quotes.`,
      id: `Baris ini memiliki ${n(cells)} sel; template memiliki ${n(template)}. Nilai yang berisi koma atau titik koma harus `
        + 'diapit tanda kutip.',
    }),
  },
  UPLOAD_TEMPLATE_MISMATCH: {
    extraColumn: ({ actual, column }: { actual: string | null; column: number }) => ({
      en: `The header has a column the template does not: “${actual}”, column ${column}. ${TEMPLATE_TAIL.en}`,
      id: `Header memiliki kolom yang tidak ada di template: “${actual}”, kolom ${column}. ${TEMPLATE_TAIL.id}`,
    }),
    headerStops: ({ shown, column, expected }: { shown: number; column: number; expected: string }) => ({
      en: `The header stops at column ${shown}; the template’s column ${column} reads “${expected}”. ${TEMPLATE_TAIL.en}`,
      id: `Header berhenti di kolom ${shown}; kolom ${column} di template berisi “${expected}”. ${TEMPLATE_TAIL.id}`,
    }),
    columnDiffers: ({ column, actual, expected }: { column: number; actual: string; expected: string }) => ({
      en: `Column ${column} of the header reads “${actual}”; the template’s reads “${expected}”. ${TEMPLATE_TAIL.en}`,
      id: `Kolom ${column} di header berisi “${actual}”; di template berisi “${expected}”. ${TEMPLATE_TAIL.id}`,
    }),
  },
  UPLOAD_UNKNOWN_AGENT_CODE: {
    noCode: {
      en: 'This row has no agent code.',
      id: 'Baris ini tidak memiliki kode agen.',
    },
    ambiguous: {
      en: 'More than one member’s code reads like this without its leading zeros, so it is not guessed.',
      id: 'Lebih dari satu kode anggota terbaca seperti ini tanpa angka nol di depannya, jadi kode ini tidak ditebak.',
    },
    scientific: {
      en: `No active member has this code, and it reads like a number in scientific notation.${SPREADSHEET.en}`,
      id: `Tidak ada anggota aktif dengan kode ini, dan kode ini terbaca seperti angka dalam notasi ilmiah.${SPREADSHEET.id}`,
    },
    dateLike: {
      en: `No active member has this code, and it reads like a date.${SPREADSHEET.en}`,
      id: `Tidak ada anggota aktif dengan kode ini, dan kode ini terbaca seperti tanggal.${SPREADSHEET.id}`,
    },
    unknown: {
      en: 'No active member of this office has this code.',
      id: 'Tidak ada anggota aktif KPM ini yang memiliki kode ini.',
    },
  },
  UPLOAD_DUPLICATE_AGENT_CODE: {
    /** `who` is the member's name, or their code; `lines` the other lines of the file, as the spreadsheet numbers them. */
    alsoOnLine: ({ who, lines }: { who: string; lines: string }) => ({
      en: `${who} is also on line ${lines}. Neither row is taken — keep one and upload again.`,
      id: `${who} juga ada di baris ${lines}. Kedua baris tidak diambil — pertahankan salah satunya, lalu unggah lagi.`,
    }),
  },
  UPLOAD_VALUE_OUT_OF_RANGE: {
    /* ---- Why a figure cannot be stored: the end of a sentence, after the figure (`refusalFor`, `readNumber`). */
    notANumber: { en: 'is not a number.', id: 'bukan angka.' },
    negative: { en: 'is negative.', id: 'bernilai negatif.' },
    persistencyAbove100: {
      en: 'is above 100 — persistency is a percentage.',
      id: 'lebih dari 100 — persistency adalah persentase.',
    },
    tooLarge: {
      en: 'is larger than any figure this product can hold.',
      id: 'lebih besar dari angka mana pun yang dapat disimpan produk ini.',
    },
    fractionOfSen: { en: 'is a fraction of a sen.', id: 'berupa pecahan sen.' },
    notWhole: ({ counts }: { counts: 'policies' | 'people' }) => ({
      en: `is not a whole number — it counts ${counts}.`,
      id: `bukan bilangan bulat — angka ini menghitung ${counts === 'policies' ? 'polis' : 'orang'}.`,
    }),
    bothMarks: {
      en: 'carries both “.” and “,”. Write it without a thousands separator.',
      id: 'berisi “.” dan “,” sekaligus. Tulis tanpa pemisah ribuan.',
    },
    otherMark: ({ other, mark }: { other: string; mark: string }) => ({
      en: `uses “${other}”, and in this file the decimal mark is “${mark}”. Write it without a thousands separator.`,
      id: `memakai “${other}”, padahal di file ini tanda desimalnya “${mark}”. Tulis tanpa pemisah ribuan.`,
    }),

    /* ---- A cell of the preview, named by its header's words and as the file has it. */
    cell: ({ column, raw, reason }: { column: string; raw: string; reason: Sentence }) => ({
      en: (figures) => `${column}: “${raw}” ${render(reason, { language: 'en', figures })}`,
      id: `${column}: “${raw}” ${render(reason, readerIn('id'))}`,
    }),
    /** `month`: this month's figure — the file's cell in quotes, or the one held as the file would write it. */
    ytdBelowMonth: ({ column, raw, month }: { column: string; raw: string; month: string }) => ({
      en: `${column}: “${raw}” is less than this month’s ${month} — the year so far includes this month.`,
      id: `${column}: “${raw}” lebih kecil dari angka bulan ini, ${month} — YTD sudah mencakup bulan ini.`,
    }),
    heldBack: ({ column, raw }: { column: string; raw: string }) => ({
      en: `${column}: “${raw}” is held back with its YTD, which is refused.`,
      id: `${column}: “${raw}” ikut ditahan bersama YTD-nya, yang ditolak.`,
    }),
    monthAboveYtd: ({ column, raw, ytd }: { column: string; raw: string; ytd: string }) => ({
      en: `${column}: “${raw}” is more than the year to date already held, ${ytd}. Fill in the YTD column too.`,
      id: `${column}: “${raw}” lebih besar dari YTD yang sudah tersimpan, ${ytd}. Isi juga kolom YTD.`,
    }),

    /* ---- A correction by hand (`production-correction.service.ts`): the figure by its metric's name and cadence. */
    correction: ({ name, cadence, reason }: { name: string; cadence: 'monthly' | 'ytd'; reason: Sentence }) => ({
      en: (figures) => `${name} ${CADENCE.en[cadence]} ${render(reason, { language: 'en', figures })}`,
      id: `${name} ${CADENCE.id[cadence]} ${render(reason, readerIn('id'))}`,
    }),
    correctYtdFirst: ({ name }: { name: string }) => ({
      en: `${name} this month would be more than the year to date already held. Correct the year to date first.`,
      id: `${name} bulan ini akan lebih besar dari YTD yang sudah tersimpan. Koreksi YTD dulu.`,
    }),
    correctMonthFirst: ({ name }: { name: string }) => ({
      en: `${name} year to date would be less than this month's figure. Correct this month first.`,
      id: `${name} YTD akan lebih kecil dari angka bulan ini. Koreksi bulan ini dulu.`,
    }),
    correctYtdToo: ({ name }: { name: string }) => ({
      en: `${name} this month would be more than the year to date already held. Correct the year to date too.`,
      id: `${name} bulan ini akan lebih besar dari YTD yang sudah tersimpan. Koreksi juga YTD-nya.`,
    }),
    ytdWouldBeBelowMonth: ({ name }: { name: string }) => ({
      en: `${name} year to date would be less than this month's figure.`,
      id: `${name} YTD akan lebih kecil dari angka bulan ini.`,
    }),
  },
  UPLOAD_BATCH_ALREADY_COMMITTED: {
    importedAlready: {
      en: 'This file was imported already, from this same preview. Its figures are in the table.',
      id: 'File ini sudah diimpor, dari pratinjau yang sama. Angka-angkanya sudah ada di tabel.',
    },
  },
  UPLOAD_NOTHING_TO_REVERT: {
    reverted: {
      en: 'This import has been reverted already.',
      id: 'Impor ini sudah dibatalkan.',
    },
    neverCompleted: {
      en: 'This import never completed, so there is nothing of it to revert.',
      id: 'Impor ini tidak pernah selesai, jadi tidak ada yang perlu dibatalkan.',
    },
  },
  UPLOAD_BATCH_NOT_LATEST: {
    revertThatFirst: ({ filename }: { filename: string }) => ({
      en: `“${filename}” was imported into this month after it. Revert that one first.`,
      id: `“${filename}” diimpor ke bulan ini setelahnya. Batalkan impor itu dulu.`,
    }),
  },
  UPLOAD_MONTH_LOCKED: {
    /** `by`: who locked it, by name, or `null` where nobody can be named. */
    lockedByHand: ({ month, by }: { month: string; by: string | null }) => ({
      en: (figures) => `${formatMonth(month, figures)} was locked${by ? ` by ${by}` : ''}. ${REOPEN.en}`,
      id: `${formatMonth(month, 'id')} dikunci${by ? ` oleh ${by}` : ''}. ${REOPEN.id}`,
    }),
    lockedOnSchedule: ({ month, until }: { month: string; until: string }) => ({
      en: (figures) => `${formatMonth(month, figures)} locked after ${formatDate(until, figures)}, when its window closed. `
        + REOPEN.en,
      id: `${formatMonth(month, 'id')} dikunci setelah ${formatDate(until, 'id')}, saat masa pengisiannya berakhir. `
        + REOPEN.id,
    }),
  },
  VERSION_CONFLICT: {
    monthChanged: ({ month }: { month: string }) => ({
      en: (figures) => `${formatMonth(month, figures)} has changed since you looked at it. Load it again, and upload the file `
        + 'again if you were importing one.',
      id: `${formatMonth(month, 'id')} telah berubah sejak Anda membukanya. Muat ulang, lalu unggah file lagi jika Anda `
        + 'sedang mengimpor.',
    }),
  },
});
