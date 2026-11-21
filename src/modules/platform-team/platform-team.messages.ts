import { refusals } from '@/common/i18n/sentence';

/**
 * ***Tim Super Admin*'s refusals, in both languages** (P19.23-T6 AC-2; ADR-0279): somebody who cannot be made one —
 * no account, a deactivated one, an address not yet proved, a KPM member — and a removal that would leave the caller
 * locked out or the platform with nobody. Each said under the field it names, where it names one.
 */
export const PLATFORM_TEAM_REFUSALS = refusals('modules/platform-team: refusals', {
  SUPER_ADMIN_NO_ACCOUNT: {
    noAccount: {
      en: 'There is no account with this email yet. Ask the person to register first, then add them again.',
      id: 'Belum ada akun dengan email ini. Minta orang itu mendaftar dulu, lalu tambahkan lagi.',
    },
    deactivated: {
      en: 'This account is deactivated, so it cannot be made a Super Admin.',
      id: 'Akun ini dinonaktifkan, jadi tidak dapat dijadikan Super Admin.',
    },
  },
  SUPER_ADMIN_UNVERIFIED: {
    unverified: {
      en: 'This account has not verified its email address yet. Ask the person to open the verification email first.',
      id: 'Akun ini belum memverifikasi alamat emailnya. Minta orang itu membuka email verifikasi dulu.',
    },
  },
  SUPER_ADMIN_HAS_MEMBERSHIP: {
    member: {
      en: 'This account is a member of a KPM. A Super Admin is AgencyBoost staff and never a KPM role: use another account.',
      id: 'Akun ini anggota sebuah KPM. Super Admin adalah tim AgencyBoost dan bukan peran di KPM: pakai akun lain.',
    },
  },
  SUPER_ADMIN_SELF: {
    self: {
      en: 'You cannot remove your own Super Admin role. Ask another Super Admin to do it.',
      id: 'Anda tidak dapat mencabut peran Super Admin Anda sendiri. Minta Super Admin lain melakukannya.',
    },
  },
  SUPER_ADMIN_LAST: {
    last: {
      en: 'This is the last active Super Admin. Add another one before removing this one.',
      id: 'Ini Super Admin aktif terakhir. Tambahkan Super Admin lain sebelum mencabut yang ini.',
    },
  },
  VALIDATION_FAILED: {
    email: {
      en: 'Enter an email address.',
      id: 'Masukkan alamat email.',
    },
  },
});
