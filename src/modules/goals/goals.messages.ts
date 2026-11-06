import { refusals } from '@/common/i18n/sentence';

/**
 * **The goals module's refusals, in both languages** (P18.10-T5 AC-2, AC-3): a goal's own fields, the assumptions
 * the cascade needs before there is any arithmetic, and a period that has ended. *Goal*, *Target* and *APE* stay
 * English (glossary §A.6), and so do Goal Settings' own labels — *Closing rate*, *Commission rate*, *Average case
 * size*, *Appointment to Sales meeting* (§A.4) — which the refusals name as the reader sees them. A figure is written
 * in the reader's figures: *12,5*.
 */
export const GOAL_REFUSALS = refusals('modules/goals', {
  VALIDATION_FAILED: {
    periodShape: {
      en: 'period must be a calendar year, written YYYY.',
      id: 'period harus berupa tahun kalender, dengan format YYYY.',
    },
    wholeSen: ({ field }: { field: string }) => ({
      en: `${field} is IDR sen and must be a whole number.`,
      id: `${field} dalam satuan sen IDR dan harus berupa bilangan bulat.`,
    }),
    percentShape: ({ field }: { field: string }) => ({
      en: `${field} must be a percentage, written as a number like 30 or 12.5.`,
      id: `${field} harus berupa persentase, ditulis sebagai angka seperti 30 atau 12,5.`,
    }),
  },
  GOAL_INVALID_ASSUMPTION: {
    commissionRate: {
      en: 'A savings target needs a commission rate above zero to become an APE target.',
      id: 'Target tabungan memerlukan commission rate di atas nol untuk menjadi target APE.',
    },
    caseSize: {
      en: 'Average case size must be above zero: it is what a policy is worth.',
      id: 'Average case size harus di atas nol: itulah nilai satu polis.',
    },
    /** `label` is the field's own on Goal Settings (ADR-0160 §4), kept English in both languages. */
    percentBounds: ({ label }: { label: string }) => ({
      en: `${label} must be above 0 and at most 100 per cent.`,
      id: `${label} harus di atas 0 dan paling tinggi 100 persen.`,
    }),
  },
  GOAL_PERIOD_LOCKED: {
    ended: ({ period, thisYear }: { period: string; thisYear: string }) => ({
      en: `${period} has ended. Its plan is what was agreed at the time and stays as it was; `
        + `set a plan for ${thisYear} instead.`,
      id: `${period} sudah berakhir. Rencananya adalah yang disepakati saat itu dan tetap seperti semula; `
        + `buat rencana untuk ${thisYear} sebagai gantinya.`,
    }),
  },
});
