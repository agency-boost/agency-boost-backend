import { formatDate } from '@/common/format/format';
import { refusals } from '@/common/i18n/sentence';

/**
 * **The auth module's refusals, in both languages** (P18.98-T5 AC-2): signing in and out, the session, registration's
 * password and agent code, the request's context — the account, the office's state — and support sessions. The
 * Indonesian follows the approved glossary (§B.0 voice, §B.6 refusals): a support session is a *sesi dukungan* and
 * acting as somebody *bertindak sebagai pengguna lain* (§A.2).
 */
export const AUTH_REFUSALS = refusals('modules/auth', {
  AUTH_INVALID_CREDENTIALS: {
    wrongCredentials: {
      en: 'That email or password is not correct.',
      id: 'Email atau kata sandi itu salah.',
    },
    wrongCurrentPassword: {
      en: 'Your current password is not correct.',
      id: 'Kata sandi Anda saat ini salah.',
    },
  },
  AUTH_ACCOUNT_DEACTIVATED: {
    contactOwner: {
      en: 'This account has been deactivated. Contact your KPM Owner.',
      id: 'Akun ini telah dinonaktifkan. Hubungi KPM Owner Anda.',
    },
    deactivated: {
      en: 'This account has been deactivated.',
      id: 'Akun ini telah dinonaktifkan.',
    },
  },
  AUTH_EMAIL_NOT_VERIFIED: {
    verifyFirst: {
      en: 'Verify your email address before signing in. Check your inbox.',
      id: 'Verifikasi alamat email Anda sebelum masuk. Periksa kotak masuk email Anda.',
    },
  },
  AGENT_CODE_TAKEN: {
    registered: ({ agentCode, company }: { agentCode: string; company: string }) => ({
      en: `Agent code ${agentCode} is already registered at ${company}. `
        + 'Check the code on your contract, or ask your office to sort it out.',
      id: `Kode agen ${agentCode} sudah terdaftar di ${company}. `
        + 'Periksa kode di kontrak Anda, atau minta KPM Anda menyelesaikannya.',
    }),
  },
  AUTH_RESET_TOKEN_INVALID: {
    linkInvalid: {
      en: 'That link is no longer valid. Request a new one.',
      id: 'Tautan itu sudah tidak berlaku. Minta tautan baru.',
    },
  },
  AUTH_TOKEN_INVALID: {
    linkInvalid: {
      en: 'That link is no longer valid. Request a new one.',
      id: 'Tautan itu sudah tidak berlaku. Minta tautan baru.',
    },
    noSession: {
      en: 'No session to refresh. Sign in again.',
      id: 'Tidak ada sesi untuk diperbarui. Silakan masuk lagi.',
    },
    noLongerValid: {
      en: 'Your session is no longer valid. Sign in again.',
      id: 'Sesi Anda tidak berlaku lagi. Silakan masuk lagi.',
    },
  },
  /* UI V1 (2026-10-30; UI-111, ADR-0181): a new email address another account already has. */
  AUTH_EMAIL_TAKEN: {
    belongsToAnother: {
      en: 'That address belongs to another account. Use a different one.',
      id: 'Alamat itu sudah dipakai akun lain. Gunakan alamat lain.',
    },
    takenSinceRequest: {
      en: 'That address now belongs to another account, so your email has not changed. Ask again with a different one.',
      id: 'Alamat itu sekarang dipakai akun lain, jadi email Anda tidak berubah. Minta lagi dengan alamat lain.',
    },
  },
  AUTH_SESSION_ENDED: {
    ended: {
      en: 'Your session ended. Sign in again.',
      id: 'Sesi Anda telah berakhir. Silakan masuk lagi.',
    },
  },
  AUTH_ORIGIN_REFUSED: {
    foreignSite: {
      en: 'Signing in, refreshing a session and signing out are not accepted from that site.',
      id: 'Masuk, memperbarui sesi, dan keluar tidak diterima dari situs itu.',
    },
  },
  AUTH_RATE_LIMITED: {
    tooMany: ({ minutes }: { minutes: number }) => ({
      en: `Too many attempts. Try again in ${minutes} minute(s).`,
      id: `Terlalu banyak percobaan. Coba lagi dalam ${minutes} menit.`,
    }),
  },
  VALIDATION_FAILED: {
    passwordTooShort: ({ min }: { min: number }) => ({
      en: `Password must be at least ${min} characters.`,
      id: `Kata sandi minimal ${min} karakter.`,
    }),
    passwordTooLong: {
      en: 'Password must be 200 characters or fewer.',
      id: 'Kata sandi paling banyak 200 karakter.',
    },
    passwordSpaces: {
      en: 'Password must not begin or end with a space.',
      id: 'Kata sandi tidak boleh diawali atau diakhiri spasi.',
    },
    samePassword: {
      en: 'Choose a different password from the one you are using now.',
      id: 'Pilih kata sandi yang berbeda dari yang Anda pakai sekarang.',
    },
    /* UI V1 (UI-111, ADR-0181): `POST /auth/me/email` with the address the account already has. */
    sameEmail: {
      en: 'That is already your email address.',
      id: 'Itu sudah alamat email Anda.',
    },
    impersonationReason: {
      en: 'A reason is required to impersonate a user.',
      id: 'Alasan wajib diisi untuk bertindak sebagai pengguna lain.',
    },
    elevationReason: {
      en: 'Say why this session needs to write. The office\'s Owner reads it.',
      id: 'Jelaskan mengapa sesi ini perlu mengubah data. Owner KPM akan membacanya.',
    },
    /* The DTOs' own sentences (`field`), each naming its field as the API names it. */
    agentCodeShape: {
      en: 'agentCode must be digits only, 3 to 32 of them',
      id: 'agentCode hanya boleh berisi angka, 3 sampai 32 digit',
    },
    dateOfBirthShape: {
      en: 'dateOfBirth must be a date, YYYY-MM-DD',
      id: 'dateOfBirth harus berupa tanggal, YYYY-MM-DD',
    },
    companyJoinMonthShape: {
      en: 'companyJoinMonth must be a month, YYYY-MM',
      id: 'companyJoinMonth harus berupa bulan, YYYY-MM',
    },
    workStatusShape: {
      en: 'workStatus must be full_time or part_time',
      id: 'workStatus harus full_time atau part_time',
    },
    genderShape: {
      en: 'gender must be male or female',
      id: 'gender harus male atau female',
    },
    localeShape: {
      en: 'locale must be id or en',
      id: 'locale harus id atau en',
    },
    /* UI V1 (2026-10-30; UI-081, D-22): a WhatsApp number, `+62` and 9 to 13 digits once read (`normalisePhone`). */
    phoneShape: {
      en: 'phone must be an Indonesian number: 9 to 13 digits after +62',
      id: 'phone harus nomor Indonesia: 9 sampai 13 digit setelah +62',
    },
  },
  TENANT_SUSPENDED: {
    suspended: {
      en: 'This office is suspended, so nobody in it can use AgencyBoost until it is reactivated. '
        + 'The office’s Owner can ask AgencyBoost about it.',
      id: 'KPM ini ditangguhkan, jadi tidak ada anggotanya yang dapat memakai AgencyBoost sampai KPM ini diaktifkan '
        + 'kembali. Owner KPM dapat menanyakannya kepada AgencyBoost.',
    },
  },
  TENANT_ARCHIVED: {
    archived: {
      en: 'This office is archived. Its records are kept, and nobody in it can use AgencyBoost.',
      id: 'KPM ini diarsipkan. Datanya tetap disimpan, dan tidak ada anggotanya yang dapat memakai AgencyBoost.',
    },
  },
  TENANT_SUBSCRIPTION_ENDED: {
    ended: ({ endDate }: { endDate: string }) => ({
      en: (figures) => `This office’s subscription ended on ${formatDate(endDate, figures)}. Nobody in it can use `
        + 'AgencyBoost until it is renewed. Contact AgencyBoost.',
      id: `Langganan KPM ini berakhir pada ${formatDate(endDate, 'id')}. Tidak ada anggotanya yang dapat memakai `
        + 'AgencyBoost sampai langganan diperpanjang. Hubungi AgencyBoost.',
    }),
  },
  PERM_DENIED: {
    alreadyImpersonating: {
      en: 'You are already impersonating. End that session first.',
      id: 'Anda sedang bertindak sebagai pengguna lain. Akhiri sesi itu dulu.',
    },
    superAdminOnly: {
      en: 'Only a Super Admin can impersonate a user.',
      id: 'Hanya Super Admin yang dapat bertindak sebagai pengguna lain.',
    },
    targetSuperAdmin: {
      en: 'A Super Admin cannot be impersonated.',
      id: 'Tidak ada yang dapat bertindak sebagai Super Admin.',
    },
    yourself: {
      en: 'You cannot impersonate yourself.',
      id: 'Anda tidak dapat bertindak sebagai diri sendiri.',
    },
    ownerOrAdminGrant: {
      en: 'Impersonating an office\'s Owner or Admin needs its own grant.',
      id: 'Bertindak sebagai Owner atau Admin KPM memerlukan izin tersendiri.',
    },
    approveSuperAdminOnly: {
      en: 'Only a Super Admin can approve writing in a support session.',
      id: 'Hanya Super Admin yang dapat menyetujui perubahan data dalam sesi dukungan.',
    },
    endYourOwn: {
      en: 'End your own support session before approving one.',
      id: 'Akhiri sesi dukungan Anda sendiri sebelum menyetujui sesi lain.',
    },
    secondSuperAdmin: {
      en: 'A second Super Admin has to approve this — not the one running the session.',
      id: 'Ini harus disetujui Super Admin kedua — bukan yang menjalankan sesi.',
    },
  },
  IMPERSONATION_OFFICE_UNAVAILABLE: {
    unavailable: ({ code, branch, reason }: { code: string; branch: string; reason: 'suspended' | 'archived' }) => ({
      en: `KPM ${code} · ${branch} is ${reason}, so nobody can act as its members until it is reactivated.`,
      id: `KPM ${code} · ${branch} ${reason === 'suspended' ? 'ditangguhkan' : 'diarsipkan'}, jadi tidak ada yang `
        + 'dapat bertindak sebagai anggotanya sampai KPM ini diaktifkan kembali.',
    }),
  },
  IMPERSONATION_SETUP_TARGET: {
    notOwnerOrAdmin: {
      en: 'A setup session acts as an office\'s Owner or one of its Admins, and this person is neither. '
        + 'Start a support session to look at their screens.',
      id: 'Sesi penyiapan bertindak sebagai Owner atau salah satu Admin KPM, dan orang ini bukan keduanya. '
        + 'Mulai sesi dukungan untuk melihat layarnya.',
    },
  },
  IMPERSONATION_JUST_STARTED: {
    aMomentAgo: {
      en: 'A session as this person started a moment ago. Use that one, or wait a second and start again.',
      id: 'Sesi sebagai orang ini baru saja dimulai. Gunakan sesi itu, atau tunggu sebentar lalu mulai lagi.',
    },
  },
});
