import { refusals } from '@/common/i18n/sentence';

/**
 * **The office's *Lengkapi data*, in both languages** (P19.12-T5 AC-3; ADR-0248 §3): `PATCH /members/:membershipId/
 * personal`'s own refusals. The shapes of the five fields are the profile's sentences (`AUTH_REFUSALS.VALIDATION_FAILED`,
 * the same field names), and a birth date or a join month the office's today refuses is `personal-data.ts`'s, so the two
 * forms refuse a value in the same words.
 *
 * The Indonesian follows the approved glossary: a person is ***dia*** (§B.0), *Profil saya* is the page's own name.
 */
export const MEMBER_PERSONAL_REFUSALS = refusals('modules/org/member-personal', {
  MEMBER_DETAIL_ON_FILE: {
    onFile: {
      en: 'Some of this is already recorded. Only they can change what is recorded, on My profile.',
      id: 'Sebagian data ini sudah tercatat. Hanya dia yang dapat mengubah data yang sudah tercatat, di Profil saya.',
    },
  },
  VALIDATION_FAILED: {
    /** A body that names none of the five: there is nothing to fill. */
    nothingToFill: {
      en: 'Fill in at least one of the details.',
      id: 'Isi paling tidak satu data.',
    },
  },
});
