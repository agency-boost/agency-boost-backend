import { formatMonth } from '@/common/format/format';
import { refusals } from '@/common/i18n/sentence';

/**
 * **The Unit Dashboard's refusals, in both languages** (P18.10-T5 AC-2, AC-3): *Update production*'s save, which
 * takes the agency's current month only, each row a figure, each person once. The month is written in the reader's
 * figures (*Okt 2026*); the agency is the *KPM* (glossary §B.9), production *produksi*, *Unit Dashboard* stays English
 * (§A.1). A field is named as the API names it (`month`).
 */
export const UNIT_DASHBOARD_REFUSALS = refusals('modules/unit-dashboard', {
  VALIDATION_FAILED: {
    currentMonthOnly: ({ month }: { month: string }) => ({
      en: (figures) => `Production can only be updated here for ${formatMonth(month, figures)}, the agency's current month.`,
      id: `Produksi hanya dapat diperbarui di sini untuk ${formatMonth(month, 'id')}, bulan berjalan KPM.`,
    }),
    rowNeedsFigure: {
      en: 'Each row needs this month’s figure, the year’s, or both.',
      id: 'Setiap baris memerlukan angka bulan ini, angka tahun ini, atau keduanya.',
    },
    personOnce: {
      en: 'Each person appears once in a save.',
      id: 'Setiap orang hanya boleh muncul sekali dalam satu penyimpanan.',
    },

    /* The save's own DTO sentence (`field`, `unit-dashboard.dto.ts`). */
    monthShape: {
      en: 'month must be YYYY-MM',
      id: 'month harus dengan format YYYY-MM',
    },

    /*
     * The Activities tab's read (UI V1, UI-001): `date` names a day in the period to read, never one after the agency's
     * today — › stops at the current week or month. A field is named as the API names it (`date`).
     */
    dateShape: {
      en: 'date must be a day, YYYY-MM-DD',
      id: 'date harus berupa tanggal, dengan format YYYY-MM-DD',
    },
    futureDate: {
      en: 'There is nothing to show after today: pick this week or month, or an earlier one.',
      id: 'Belum ada yang bisa ditampilkan setelah hari ini: pilih minggu atau bulan ini, atau yang sebelumnya.',
    },

    /*
     * The *Potensi* tab's reads (P19.1-T6, UI-155): `month` names a calendar month on the agency's calendar, never one
     * after the current month — the month picker stops there.
     */
    potensiMonthShape: {
      en: 'month must be a month, YYYY-MM',
      id: 'month harus berupa bulan, dengan format YYYY-MM',
    },
    futureMonth: {
      en: 'There is nothing to show after this month: pick this month or an earlier one.',
      id: 'Belum ada yang bisa ditampilkan setelah bulan ini: pilih bulan ini atau yang sebelumnya.',
    },
  },
});
