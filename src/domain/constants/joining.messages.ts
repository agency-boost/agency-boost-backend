import { refusals } from '@/common/i18n/sentence';

/**
 * **What is wrong with a join date a leader gave, in both languages** (P18.98-T5 AC-3; ADR-0169 §3) — `joinDate`
 * named as the API names it, as the shared envelope's other field sentences are.
 */
export const JOINING_REFUSALS = refusals('domain/joining', {
  VALIDATION_FAILED: {
    notADate: {
      en: 'joinDate must be a real date, written YYYY-MM-DD.',
      id: 'joinDate harus berupa tanggal yang benar, dengan format YYYY-MM-DD.',
    },
    afterToday: {
      en: 'joinDate cannot be after today.',
      id: 'joinDate tidak boleh setelah hari ini.',
    },
    beforeEarliest: ({ year }: { year: string }) => ({
      en: `joinDate cannot be before ${year}.`,
      id: `joinDate tidak boleh sebelum tahun ${year}.`,
    }),
  },
});
