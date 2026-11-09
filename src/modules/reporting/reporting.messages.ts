import { formatDate, formatMonth } from '@/common/format/format';
import { messages, refusals } from '@/common/i18n/sentence';

/**
 * **The Owner's reporting's refusals, in both languages** (P18.10-T5 AC-2, AC-3): the Overview's recruitment target,
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
 * **The periods the analytics' figures are read over, in the reader's words** (P18.10-T5 AC-4; ADR-0167 §1): MOC's
 * criteria each say when their input was read — *Jan – Sep 2026*, *based on today's upline*, *Not uploaded yet* (§B.3's
 * *Belum diunggah*) — the months and the days in the reader's figures, the words between them in their language.
 */
export const REPORTING_MESSAGES = messages('modules/reporting', {
  notUploadedYet: {
    en: 'Not uploaded yet',
    id: 'Belum diunggah',
  },
  /**
   * **MOC's *Direct AB* line** (P19.3-T1; ADR-0201 §5, the data sources' Q7): the app keeps only today's upline, so the
   * count says how it was read — the ABs whose upline is this AB today, never who promoted whom.
   */
  byTodaysUpline: {
    en: 'based on today’s upline',
    id: 'berdasarkan upline saat ini',
  },
  /** A count read today: *As of 9 Okt 2026* — *Per 9 Okt 2026*. */
  asOf: ({ day }: { day: string }) => ({
    en: (figures) => `As of ${formatDate(day, figures)}`,
    id: `Per ${formatDate(day, 'id')}`,
  }),
});
