import { refusals } from '@/common/i18n/sentence';

/**
 * **The two guards' refusals** (P18.98-T5 AC-2): who is signed in (`AuthGuard`), and whether they may (`PermissionsGuard`).
 * The Indonesian is the approved glossary's §B.6 where it holds the sentence; a support session is a *sesi dukungan*
 * (§A.2).
 */
export const AUTH_GUARD_REFUSALS = refusals('common/auth', {
  AUTH_TOKEN_INVALID: {
    signIn: {
      en: 'Sign in to continue.',
      id: 'Masuk untuk melanjutkan.',
    },
  },
  AUTH_TOKEN_EXPIRED: {
    expired: {
      en: 'Your session has expired. Sign in again.',
      id: 'Sesi Anda telah kedaluwarsa. Silakan masuk lagi.',
    },
    supportEnded: {
      en: 'That support session has ended.',
      id: 'Sesi dukungan itu telah berakhir.',
    },
  },
  AUTH_PASSWORD_CHANGE_REQUIRED: {
    chooseYourOwn: {
      en: 'Choose your own password before you go any further. The one you signed in with '
        + 'was generated for you, and somebody else has seen it.',
      id: 'Buat kata sandi Anda sendiri sebelum melanjutkan. Kata sandi yang Anda pakai untuk masuk dibuatkan untuk '
        + 'Anda, dan sudah dilihat orang lain.',
    },
  },
  PERM_DENIED: {
    ownAccount: {
      en: 'A support session cannot change anybody\'s own account: their profile, their password or where '
        + 'they are signed in. Only they can.',
      id: 'Sesi dukungan tidak dapat mengubah akun milik siapa pun: profilnya, kata sandinya, atau tempat ia masuk. '
        + 'Hanya pemilik akun yang dapat melakukannya.',
    },
    setupScope: {
      en: 'This setup session can change the office\'s settings, import people and upload production '
        + 'files, and nothing else. Ask the office to make this change, or request write access from '
        + 'a second Super Admin.',
      id: 'Sesi penyiapan ini hanya dapat mengubah pengaturan KPM, mengimpor anggota, dan mengunggah file produksi. '
        + 'Minta KPM melakukan perubahan ini, atau minta akses ubah data dari Super Admin kedua.',
    },
    readOnly: {
      en: 'This is a read-only support session. Ask the office to make the change, or '
        + 'request write access from a second Super Admin.',
      id: 'Sesi dukungan ini hanya untuk melihat. Minta KPM melakukan perubahan ini, atau minta akses ubah data dari '
        + 'Super Admin kedua.',
    },
    noPermission: {
      en: 'You do not have permission to perform this action.',
      id: 'Anda tidak memiliki izin untuk melakukan tindakan ini.',
    },
  },
  PERM_OWNER_ONLY: {
    ownerOnly: {
      en: 'Only this office’s Owner can do that.',
      id: 'Hanya Owner KPM ini yang dapat melakukannya.',
    },
  },
});
