import { formatMonth } from '@/common/format/format';
import { refusals } from '@/common/i18n/sentence';

/**
 * **The Summary's refusals, in both languages** (P18.10-T5 AC-2, AC-3): the period a reader asks for, and the
 * query's shapes. **A month is written in the reader's figures** — *Okt 2026*, *Oct 2026* for a reader who chose
 * English — and a year as the name it is, *2026*. The words name no office (ADR-0084): a coachee's *Personal Summary*
 * tab shows a refusal as its banner, so the Indonesian says no *KPM* either.
 */
export const SUMMARY_REFUSALS = refusals('modules/summary', {
  VALIDATION_FAILED: {
    monthOrYear: {
      en: 'Ask for a month or a year, not both.',
      id: 'Pilih bulan atau tahun, bukan keduanya.',
    },
    yearNotBegun: ({ year, latest }: { year: string; latest: string }) => ({
      en: `${year} has not begun yet: the latest year is ${latest}.`,
      id: `${year} belum dimulai: tahun terakhir yang ada adalah ${latest}.`,
    }),
    yearBeforeFirst: ({ year, first }: { year: string; first: string }) => ({
      en: `${year} is before the first year there is, ${first}.`,
      id: `${year} sebelum tahun pertama yang ada, ${first}.`,
    }),
    monthNotBegun: ({ month, latest }: { month: string; latest: string }) => ({
      en: (figures) => `${formatMonth(month, figures)} has not begun yet: the latest month is ${formatMonth(latest, figures)}.`,
      id: `${formatMonth(month, 'id')} belum dimulai: bulan terakhir yang ada adalah ${formatMonth(latest, 'id')}.`,
    }),
    monthBeforeFirst: ({ month, first }: { month: string; first: string }) => ({
      en: (figures) => `${formatMonth(month, figures)} is before the first month there is, ${formatMonth(first, figures)}.`,
      id: `${formatMonth(month, 'id')} sebelum bulan pertama yang ada, ${formatMonth(first, 'id')}.`,
    }),

    /* The query DTO's own sentences (`field`, `summary.controller.ts`). */
    monthShape: {
      en: 'month must be a month, YYYY-MM',
      id: 'month harus berupa bulan, YYYY-MM',
    },
    yearShape: {
      en: 'year must be a year, YYYY',
      id: 'year harus berupa tahun, YYYY',
    },
  },
});
