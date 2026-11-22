import { refusals } from '@/common/i18n/sentence';

/**
 * **The Owner's invitation by WhatsApp, refused** (P19.23-T2 AC-3; ADR-0277; OD-420): a claim link that opens nothing,
 * and too many of them asked for. Written for the person holding the link — the KPM's future Owner, on their phone —
 * and for the Super Admin asking for one. An office is a *KPM* (§B.9); *Owner* is kept (§A.5).
 */
export const OWNER_CLAIM_REFUSALS = refusals('modules/tenants: owner claims', {
  NOT_FOUND: {
    linkNotValid: {
      en: 'This owner invitation link is not valid. Check you opened the whole link, or ask AgencyBoost for a new one.',
      id: 'Tautan undangan owner ini tidak valid. Pastikan Anda membuka seluruh tautannya, atau minta tautan baru kepada '
        + 'AgencyBoost.',
    },
    alreadyUsed: {
      en: 'This owner invitation was already used. Sign in to open the KPM.',
      id: 'Undangan owner ini sudah dipakai. Silakan masuk untuk membuka KPM-nya.',
    },
    expired: {
      en: 'This owner invitation has expired. Ask AgencyBoost to send it again.',
      id: 'Undangan owner ini sudah kedaluwarsa. Minta AgencyBoost mengirimkannya lagi.',
    },
  },
  AUTH_RATE_LIMITED: {
    tooMany: ({ minutes }: { minutes: number }) => ({
      en: `Too many attempts. Try again in ${minutes} minute(s).`,
      id: `Terlalu banyak percobaan. Coba lagi dalam ${minutes} menit.`,
    }),
  },
});
