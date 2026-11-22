import { refusals } from '@/common/i18n/sentence';

/**
 * **The member sheet's edits, in both languages** (P19.20-T2; ADR-0273 §3, amending ADR-0248 §3): `PATCH
 * /members/:membershipId/personal`'s own refusals. The shapes of the fields are the profile's sentences
 * (`AUTH_REFUSALS.VALIDATION_FAILED`, the same field names), a birth date or a join month the office's today refuses is
 * `personal-data.ts`'s, a join date `joining.ts`'s, a code or an address held by somebody else the registration's — so
 * every form refuses a value in the same words.
 *
 * The Indonesian follows the approved glossary: a person is ***dia*** (§B.0), *Profil saya* is the page's own name.
 */
export const MEMBER_PERSONAL_REFUSALS = refusals('modules/org/member-personal', {
  /**
   * *Retired 2026-11-20 (ADR-0273 §3):* the office fills blanks only — nothing raises it since the sheet edits every
   * field. Kept, as every retired code is, so a client that branches on it still reads its words.
   */
  MEMBER_DETAIL_ON_FILE: {
    onFile: {
      en: 'Some of this is already recorded. Only they can change what is recorded, on My profile.',
      id: 'Sebagian data ini sudah tercatat. Hanya dia yang dapat mengubah data yang sudah tercatat, di Profil saya.',
    },
  },
  MEMBER_EMAIL_SIGNED_IN: {
    /** OD-400: the address somebody signs in with is theirs to change. */
    signedIn: {
      en: 'They sign in with this email, so only they can change it, on My profile.',
      id: 'Dia masuk dengan email ini, jadi hanya dia yang dapat mengubahnya, di Profil saya.',
    },
  },
  VALIDATION_FAILED: {
    /** A body that names none of the fields: there is nothing to change. */
    nothingToFill: {
      en: 'Fill in at least one of the details.',
      id: 'Isi paling tidak satu data.',
    },
  },
});
