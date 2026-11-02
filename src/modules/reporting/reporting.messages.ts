import { formatDate, formatMonth, formatMonthName } from '@/common/format/format';
import { messages, refusals } from '@/common/i18n/sentence';

/**
 * **The Owner's reporting's refusals, in both languages** (P18.98-T5 AC-2, AC-3): the Overview's recruitment target,
 * the compliance tree's item, and the target's month as a DTO checks it. *Target* and *Recruitment* stay English
 * (§A.6); the office is *KPM* (§B.9).
 */
export const REPORTING_REFUSALS = refusals('modules/reporting', {
  VALIDATION_FAILED: {
    recruitTargetMonth: ({ month }: { month: string }) => ({
      en: (figures) => `A recruitment target is set for ${formatMonth(month, figures)}, the agency's current month.`,
      id: `Target recruitment ditetapkan untuk ${formatMonth(month, 'id')}, bulan berjalan KPM.`,
    }),
    /** `SetRecruitTargetDto.month` (`field`). */
    monthShape: {
      en: 'month must be YYYY-MM',
      id: 'month harus dengan format YYYY-MM',
    },
    itemNotTaken: ({ category }: { category: string }) => ({
      en: `item is not taken by category ${category}: it has one item only.`,
      id: `item tidak diterima oleh kategori ${category}: kategori ini hanya memiliki satu item.`,
    }),
  },
});

/**
 * **The periods the analytics' figures are read over, in the reader's words** (P18.98-T5 AC-4; ADR-0167 §1): MOC's
 * criteria each say when their input was read — *Agu and Sep 2026*, *As of 9 Okt 2026*, *Not uploaded yet* (§B.3's
 * *Belum diunggah*) — the months and the days in the reader's figures, the words between them in their language.
 */
export const REPORTING_MESSAGES = messages('modules/reporting', {
  notUploadedYet: {
    en: 'Not uploaded yet',
    id: 'Belum diunggah',
  },
  /** A count read today: *As of 9 Okt 2026* — *Per 9 Okt 2026*. */
  asOf: ({ day }: { day: string }) => ({
    en: (figures) => `As of ${formatDate(day, figures)}`,
    id: `Per ${formatDate(day, 'id')}`,
  }),
  /** The two months a `MONTHLY2_AA` count read: *Agu and Sep 2026*, *Des 2025 and Jan 2026* — *Agu dan Sep 2026*. */
  twoMonths: ({ first, second }: { first: string; second: string }) => {
    const sameYear = first.slice(0, 4) === second.slice(0, 4);
    return {
      en: (figures) => `${sameYear ? formatMonthName(first, figures) : formatMonth(first, figures)} and ${formatMonth(second, figures)}`,
      id: `${sameYear ? formatMonthName(first, 'id') : formatMonth(first, 'id')} dan ${formatMonth(second, 'id')}`,
    };
  },
});
