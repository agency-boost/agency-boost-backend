import { refusals } from '@/common/i18n/sentence';

/**
 * **The KPM report's refusals, in both languages** (P19.24-T1, T2; ADR-0280 §5, §6): a month the report is not made for,
 * and a *Kirim ke owner* link that opens nothing — written for the Super Admin choosing a month and for the KPM's Owner
 * holding the link on their phone. An office is a *KPM* (§B.9); *Owner* is kept (§A.5).
 */
export const KPM_REPORT_REFUSALS = refusals('modules/kpm-report', {
  VALIDATION_FAILED: {
    /** `month` not `YYYY-MM` (`field: month`). */
    monthShape: {
      en: 'month must be YYYY-MM',
      id: 'month harus dengan format YYYY-MM',
    },
    /** A month after the KPM's, or more than `KPM_REPORT.MONTHS_BACK` before it. */
    monthOutOfRange: ({ earliest, latest }: { earliest: string; latest: string }) => ({
      en: `A KPM report can be made for ${earliest} to ${latest} only.`,
      id: `Laporan KPM hanya bisa dibuat untuk ${earliest} sampai ${latest}.`,
    }),
  },
  NOT_FOUND: {
    linkNotValid: {
      en: 'This KPM report link is not valid. Check you opened the whole link, or ask AgencyBoost to send it again.',
      id: 'Tautan laporan KPM ini tidak valid. Pastikan Anda membuka seluruh tautannya, atau minta AgencyBoost mengirimnya lagi.',
    },
    expired: {
      en: 'This KPM report link has expired. Ask AgencyBoost to send it again.',
      id: 'Tautan laporan KPM ini sudah kedaluwarsa. Minta AgencyBoost mengirimnya lagi.',
    },
    notYourKpm: {
      en: 'This report is for another KPM. Sign in as that KPM’s Owner or Admin to open it.',
      id: 'Laporan ini untuk KPM lain. Masuk sebagai Owner atau Admin KPM tersebut untuk membukanya.',
    },
  },
  AUTH_RATE_LIMITED: {
    tooMany: ({ minutes }: { minutes: number }) => ({
      en: `Too many report links opened. Try again in ${minutes} minute(s).`,
      id: `Terlalu banyak tautan laporan dibuka. Coba lagi dalam ${minutes} menit.`,
    }),
  },
});
