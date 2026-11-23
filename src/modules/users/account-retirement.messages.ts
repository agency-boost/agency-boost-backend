import { refusals } from '@/common/i18n/sentence';

/**
 * **What *Hapus akun* refuses with** (P19.31-T1 AC-2; ADR-0289 §2), in both languages — each saying what to do first.
 */
export const ACCOUNT_RETIREMENT_REFUSALS = refusals('users/account-retirement', {
  ACCOUNT_RETIRE_PLATFORM_TEAM: {
    platformTeam: {
      en: 'This is an AgencyBoost team account. Remove them from the platform team first, if they should go.',
      id: 'Ini akun tim AgencyBoost. Keluarkan dulu dari tim platform jika memang harus dihapus.',
    },
  },
  ACCOUNT_RETIRE_OWNER: {
    owner: ({ kpms }: { kpms: string }) => ({
      en: `They are an owner of ${kpms}. Remove them as owner first (Kelola owner), then delete the account.`,
      id: `Dia owner ${kpms}. Hapus dia sebagai owner dulu (Kelola owner), lalu hapus akunnya.`,
    }),
  },
  ACCOUNT_RETIRE_HAS_REPORTS: {
    reports: ({ count, kpm }: { count: number; kpm: string }) => ({
      en: `${count} ${count === 1 ? 'person reports' : 'people report'} to them in ${kpm}. Move them to another leader first (Ganti leader), then delete the account.`,
      id: `${count} orang melapor kepadanya di ${kpm}. Pindahkan mereka ke leader lain dulu (Ganti leader), lalu hapus akunnya.`,
    }),
  },
  VALIDATION_FAILED: {
    nameMismatch: {
      en: 'Type their full name exactly as it is written, to confirm.',
      id: 'Ketik nama lengkapnya persis seperti tertulis, untuk memastikan.',
    },
  },
});
