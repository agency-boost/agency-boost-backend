import { refusals } from '@/common/i18n/sentence';

/**
 * **What *Unduh akun & password (PDF)* refuses with** (P19.30-T1; ADR-0288), in both languages. The PDF's own words are
 * Indonesian only, as the KPM report's are: `temporary-passwords.words.ts`.
 */
export const TEMPORARY_PASSWORDS_REFUSALS = refusals('org/temporary-passwords', {
  VALIDATION_FAILED: {
    /**
     * Nobody left to list (AC-6's empty case): every account of the KPM — or of the ones named — is already its person's
     * own. The dialog says so before anything is asked for; this answers a download asked for all the same.
     */
    nobodyToList: {
      en: 'Everybody already uses their own password, so there is nobody to list in the PDF.',
      id: 'Semua orang sudah memakai password sendiri, jadi tidak ada yang perlu dimasukkan ke PDF.',
    },
  },
});
