import { refusals } from '@/common/i18n/sentence';

/**
 * **What is wrong with a person's own record, in both languages** (P18.98-T5 AC-3; ADR-0158 §2): a date of birth and
 * the month somebody joined their insurer — refused the same way by registration, `/profile` and the roster file.
 */
export const USERS_REFUSALS = refusals('modules/users', {
  VALIDATION_FAILED: {
    birthDateNotADate: ({ value }: { value: string }) => ({
      en: `"${value}" is not a date of birth. Write it YYYY-MM-DD, like 1990-03-15.`,
      id: `"${value}" bukan tanggal lahir. Tulis dengan format YYYY-MM-DD, misalnya 1990-03-15.`,
    }),
    birthDateNotPast: {
      en: 'A date of birth must be in the past.',
      id: 'Tanggal lahir harus sebelum hari ini.',
    },
    birthDateTooRecent: ({ years }: { years: number }) => ({
      en: `A date of birth must be at least ${years} years ago.`,
      id: `Tanggal lahir harus paling tidak ${years} tahun yang lalu.`,
    }),
    joinMonthNotAMonth: ({ value }: { value: string }) => ({
      en: `"${value}" is not a month. Write the company join month YYYY-MM, like 2021-07.`,
      id: `"${value}" bukan bulan. Tulis bulan bergabung dengan perusahaan dengan format YYYY-MM, misalnya 2021-07.`,
    }),
    joinMonthFuture: {
      en: 'The company join month cannot be in the future.',
      id: 'Bulan bergabung dengan perusahaan tidak boleh di masa depan.',
    },
  },
  /** *Profil saya*'s photo (UI-111): its own ceiling, `AVATAR.MAX_BYTES`, said in KB. */
  ASSET_TOO_LARGE: {
    photoAtMost: ({ kb }: { kb: number }) => ({
      en: `A profile photo must be ${kb} KB or smaller.`,
      id: `Ukuran foto profil paling besar ${kb} KB.`,
    }),
  },
});
