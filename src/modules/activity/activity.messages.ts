import { formatDate, formatNumber } from '@/common/format/format';
import { messages, refusals } from '@/common/i18n/sentence';

/** A count in an Indonesian sentence: *703.728*. English keeps the number as the API always wrote it. */
const idCount = (n: number) => formatNumber(n, undefined, 'id');

/**
 * **The activity module's refusals, in both languages** (P18.10-T5 AC-2, AC-3): a day logged, saved and corrected,
 * the codes a day may count, and the dashboard's and the summary's ranges. A day is written in the reader's figures
 * (*12 Mei 2026*). An activity type is a *jenis aktivitas*, a rung a *jenjang*, the office *KPM* (glossary §B.9); a
 * code and a field are named as the API names them (`ROLLING_7D`, `from`).
 */
export const ACTIVITY_REFUSALS = refusals('modules/activity', {
  VALIDATION_FAILED: {
    /* The dashboard's range (`activity-dashboard.ts`). */
    notARange: ({ range, ranges }: { range: string; ranges: readonly string[] }) => ({
      en: `${range} is not a range. One of: ${ranges.join(', ')}.`,
      id: `${range} bukan rentang yang tersedia. Gunakan salah satu dari: ${ranges.join(', ')}.`,
    }),
    presetWithDates: ({ range }: { range: string }) => ({
      en: `from and to are for a CUSTOM range; ${range} ends today.`,
      id: `from dan to hanya untuk rentang CUSTOM; ${range} berakhir hari ini.`,
    }),
    customNeedsBoth: ({ field }: { field: string }) => ({
      en: `A custom range needs both dates; ${field} is missing.`,
      id: `Rentang kustom memerlukan kedua tanggal; ${field} belum diisi.`,
    }),
    /** A day that is no day — the dashboard's `from`/`to`, and every day the service reads. */
    notADay: ({ value }: { value: string }) => ({
      en: `${value} is not a date. Days are written YYYY-MM-DD.`,
      id: `${value} bukan tanggal. Tanggal ditulis dengan format YYYY-MM-DD.`,
    }),
    rangeBackwards: {
      en: 'The range starts after it ends.',
      id: 'Tanggal mulai rentang ini setelah tanggal akhirnya.',
    },
    rangeAfterToday: ({ today }: { today: string }) => ({
      en: (figures) => `The range ends after today, ${formatDate(today, figures)}. Nothing has been logged yet.`,
      id: `Rentang ini berakhir setelah hari ini, ${formatDate(today, 'id')}. Belum ada yang tercatat.`,
    }),
    rangeTooLong: ({ days, max }: { days: number; max: number }) => ({
      en: `The range covers ${days} days. The dashboard shows up to ${max} at a time.`,
      id: `Rentang ini mencakup ${idCount(days)} hari. Dashboard menampilkan paling banyak ${idCount(max)} hari sekaligus.`,
    }),

    /* The service (`activity.service.ts`). */
    correctionReason: {
      en: 'Say why the day is being corrected. A correction nobody can explain is a number that '
        + 'changed for no reason anybody can find.',
      id: 'Jelaskan mengapa hari itu dikoreksi. Koreksi yang tidak dapat dijelaskan adalah angka yang berubah tanpa '
        + 'alasan yang dapat ditemukan siapa pun.',
    },
    stillOpen: ({ date }: { date: string }) => ({
      en: (figures) => `${formatDate(date, figures)} is still open — save it normally. A correction is for a day somebody has `
        + 'already read.',
      id: `${formatDate(date, 'id')} masih terbuka — simpan seperti biasa. Koreksi untuk hari yang sudah dibaca orang lain.`,
    }),
    unknownCodes: ({ codes }: { codes: readonly string[] }) => ({
      en: `This office has no activity type with the code ${codes.join(', ')} in the list it has published.`,
      id: `KPM ini tidak memiliki jenis aktivitas dengan kode ${codes.join(', ')} di daftar yang telah diterbitkannya.`,
    }),
    notAPeriod: ({ period }: { period: string }) => ({
      en: `${period} is not a period. One of: ROLLING_7D, ROLLING_30D, CALENDAR_MONTH.`,
      id: `${period} bukan periode yang tersedia. Gunakan salah satu dari: ROLLING_7D, ROLLING_30D, CALENDAR_MONTH.`,
    }),

    /* The DTOs' own sentence (`field`, `activity.dto.ts`). */
    dayShape: {
      en: 'A day is written YYYY-MM-DD, in this office’s timezone.',
      id: 'Tanggal ditulis dengan format YYYY-MM-DD, menurut zona waktu KPM ini.',
    },
  },
  ACTIVITY_FUTURE_DATE: {
    notYet: ({ date }: { date: string }) => ({
      en: (figures) => `${formatDate(date, figures)} has not happened yet in this office. A day is logged after it, not before.`,
      id: `${formatDate(date, 'id')} belum terjadi di KPM ini. Aktivitas sebuah hari dicatat setelah hari itu, bukan sebelumnya.`,
    }),
  },
  ACTIVITY_DATE_OUT_OF_WINDOW: {
    closed: ({ date }: { date: string }) => ({
      en: (figures) => `${formatDate(date, figures)} is closed for editing. Correct it instead, with a reason — the correction stays `
        + 'beside the numbers anybody has already read.',
      id: `${formatDate(date, 'id')} sudah ditutup untuk diubah. Koreksi hari itu dengan alasan — koreksinya disimpan di `
        + 'samping angka yang sudah dibaca orang lain.',
    }),
  },
  ACTIVITY_TYPE_NOT_APPLICABLE: {
    hiddenSection: ({ codes }: { codes: readonly string[] }) => ({
      en: `${codes.join(', ')} counts activity in a section your office does not show your rung.`,
      id: `${codes.join(', ')} mencatat aktivitas di bagian yang tidak ditampilkan KPM Anda untuk jenjang Anda.`,
    }),
  },
  NOT_FOUND: {
    /**
     * A correction of a day nobody logged. It was raised as `NotFoundException(sentence)`, which wrote the sentence
     * as a resource's name and so answered it with *not found.* after it; the sentence is now answered alone.
     */
    noEntryToCorrect: ({ date }: { date: string }) => ({
      en: (figures) => `There is no entry for ${formatDate(date, figures)} to correct. Log the day instead.`,
      id: `Tidak ada catatan untuk ${formatDate(date, 'id')} yang dapat dikoreksi. Catat hari itu seperti biasa.`,
    }),
  },
});

/**
 * **The words the activity module writes into its answers** (P18.10-T5 AC-4), composed for the request's reader:
 * the dashboard's section for a count no category holds, and a balance ratio's tag. Every other label is the
 * office's own (a category, a type), shown as typed (glossary §F).
 */
export const ACTIVITY_MESSAGES = messages('modules/activity', {
  otherSection: { en: 'Other', id: 'Lainnya' },
  balanceTag: { en: 'Balance', id: 'Keseimbangan' },
});
