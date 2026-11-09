import { formatDate } from '@/common/format/format';
import { refusals } from '@/common/i18n/sentence';

/**
 * **The auth module's refusals, in both languages** (P18.10-T5 AC-2): signing in and out, the session, registration's
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
    /* UI-169 item 5 (ADR-0199 §2, §4): the other login's password, on the link's page or in the switcher's sheet. */
    wrongLinkedPassword: {
      en: 'That is not the password of that login.',
      id: 'Itu bukan kata sandi akun tersebut.',
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
  /*
   * *Changed 2026-11-04 (P19-T1 AC-4; UI-163, ADR-0190 §4):* sign-in no longer answers this — it read *"Verify your
   * email address before signing in. Check your inbox."* What still needs a proven address does: being made a KPM's
   * Owner (`refuseUnverifiedAddress`, `verified-address.ts`).
   */
  AUTH_EMAIL_NOT_VERIFIED: {
    /* UI-169 item 5 (ADR-0199 §1): starting a link needs the starting login's own address proven (ADR-0190 §4). */
    linkNeedsVerifiedAddress: {
      en: 'Verify your own email address before you link another login. Use Send again on the banner.',
      id: 'Verifikasi dulu alamat email Anda sendiri sebelum menautkan akun lain. Gunakan Kirim ulang pada banner.',
    },
    notVerifiedYet: ({ email }: { email: string }) => ({
      en: `${email} has not been verified yet. They verify it from the link in their email, or with Send again on `
        + 'the banner once they sign in, and can then be made the Owner.',
      id: `${email} belum diverifikasi. Pemilik alamat itu memverifikasinya lewat tautan di emailnya, atau lewat Kirim `
        + 'ulang pada banner setelah masuk, lalu baru dapat dijadikan Owner.',
    }),
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
  /* UI-169 item 5 (ADR-0199 §1, §2): a login has one link, a pair, in v1. */
  AUTH_LINK_EXISTS: {
    youAreLinked: {
      en: 'Your login is already linked to another. Remove that link on My profile first.',
      id: 'Akun Anda sudah tertaut ke akun lain. Hapus dulu tautan itu di Profil saya.',
    },
    linkedSince: {
      en: 'One of these two logins was linked to another since this link was sent, so nothing was linked.',
      id: 'Salah satu dari kedua akun ini sudah tertaut ke akun lain sejak tautan ini dikirim, jadi tidak ada yang ditautkan.',
    },
  },
  /* UI-169 item 5 (ADR-0199 §4): the other login holds no session on this browser; its password is asked once. */
  AUTH_LINK_SIGN_IN_REQUIRED: {
    signInFirst: {
      en: 'That login is not signed in on this browser. Enter its password to switch to it.',
      id: 'Akun itu belum masuk di browser ini. Masukkan kata sandinya untuk beralih ke akun itu.',
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
    passwordTooLong: ({ max }: { max: number }) => ({
      en: `Password must be ${max} characters or fewer.`,
      id: `Kata sandi paling banyak ${max} karakter.`,
    }),
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
    /* UI-169 item 5 (ADR-0199 §1): `POST /auth/links` with the caller's own address — a login is never linked to itself. */
    linkOwnAddress: {
      en: 'That is your own address. Enter the email of your other login.',
      id: 'Itu alamat Anda sendiri. Masukkan email akun Anda yang lain.',
    },
    impersonationReason: {
      en: 'A reason is required to impersonate a user.',
      id: 'Alasan wajib diisi untuk bertindak sebagai pengguna lain.',
    },
    /* P19.4-T2 AC-1 (ADR-0206 §3): `purpose: 'setup'` on a start. There is one kind of session, and it only looks. */
    impersonationPurpose: {
      en: 'A support session only looks: there is no setup session. Start one with no purpose, or with support.',
      id: 'Sesi dukungan hanya untuk melihat: tidak ada lagi sesi penyiapan. Mulai sesi tanpa tujuan, atau dengan support.',
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
    /* UI-169 item 5 (ADR-0199 §1, §2): both logins of a link are an Owner's, an Admin's or a Super Admin's. */
    linkRolesOnly: {
      en: 'Only the logins of a KPM Owner, a KPM Admin or a Super Admin can be linked.',
      id: 'Hanya akun KPM Owner, KPM Admin, atau Super Admin yang dapat ditautkan.',
    },
    /* ADR-0199 §7: a Super Admin who holds the other login switches to it; they are that person, never a support case. */
    linkedToYou: {
      en: 'That login is linked to yours. Switch to it from your avatar menu instead.',
      id: 'Akun itu tertaut ke akun Anda. Beralihlah ke akun itu lewat menu avatar Anda.',
    },
  },
  IMPERSONATION_OFFICE_UNAVAILABLE: {
    unavailable: ({ code, branch, reason }: { code: string; branch: string; reason: 'suspended' | 'archived' }) => ({
      en: `KPM ${code} · ${branch} is ${reason}, so nobody can act as its members until it is reactivated.`,
      id: `KPM ${code} · ${branch} ${reason === 'suspended' ? 'ditangguhkan' : 'diarsipkan'}, jadi tidak ada yang `
        + 'dapat bertindak sebagai anggotanya sampai KPM ini diaktifkan kembali.',
    }),
  },
  IMPERSONATION_JUST_STARTED: {
    aMomentAgo: {
      en: 'A session as this person started a moment ago. Use that one, or wait a second and start again.',
      id: 'Sesi sebagai orang ini baru saja dimulai. Gunakan sesi itu, atau tunggu sebentar lalu mulai lagi.',
    },
  },
});
