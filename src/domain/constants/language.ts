/**
 * **The two languages AgencyBoost speaks, and the one a person who has chosen neither reads** (ADR-0179 §1, OD-236;
 * P18.98-T1 AC-1).
 *
 * - `id` — Bahasa Indonesia, **the default**: a person who has not chosen reads Indonesian.
 * - `en` — English, a tap away.
 *
 * The codes are ISO 639-1, the values `<html lang>`, the language cookie (`ab_lang`) and `Accept-Language` carry
 * (ADR-0179 §2, §7, §8). They name the **reader's** language, never the office's: `kpms.locale` stays `id-ID`, with
 * the timezone and the currency (ADR-0016).
 *
 * Documented once in `docs/00-product/metrics-and-definitions.md` §B.27 and pinned by `language.spec.ts`. The frontend
 * mirrors both (`frontend/src/i18n/language.ts`), and its `contract.spec.ts` reads them here, so the two cannot drift
 * (invariant §7). Read by `users.locale` (P18.98-T2: `PATCH /auth/me` writes it, `GET /auth/me` answers it through
 * `languageOf`) and by the request's language (P18.98-T5: `readerOf`, `common/i18n/reader.ts`).
 */
export const LANGUAGES = ['id', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

/** A person who has chosen no language reads Bahasa Indonesia (ADR-0179 §1): `users.locale` `null` reads `'id'`. */
export const DEFAULT_LANGUAGE: Language = 'id';

/** Whether a value is one of the two languages — what a stored `locale`, a cookie or a header is read through. */
export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * **The language a stored choice reads as** (ADR-0179 §1, §2; P18.98-T2 AC-1): the choice itself, or Bahasa Indonesia
 * for a person who has made none. `users.locale` is `'id'`, `'en'` or `null`, and nothing has ever written anything
 * else (ADR-0016), so `null` — every account made before the switch — is the case that matters, and it reads `'id'`
 * with no migration. A value that is not one of the two (none exists) reads the default too, rather than reaching a
 * screen or an email.
 */
export function languageOf(stored: unknown): Language {
  return isLanguage(stored) ? stored : DEFAULT_LANGUAGE;
}

/**
 * **The language every sentence the API writes was written in first: English** (P18.98-T5). Each module's messages
 * are English and Indonesian side by side (`common/i18n/sentence.ts`); the English is what the API wrote before the
 * phase, so it is what a refusal's own `Error.message`, the log and a unit test read (`SOURCE_READER`). The frontend's
 * `SOURCE_LANGUAGE` is the same, and `language.spec.ts` reads it there.
 */
export const SOURCE_LANGUAGE: Language = 'en';

/**
 * **Whether the Indonesian default is live** — the backend's half of the frontend's `LANGUAGE_LIVE`
 * (`frontend/src/i18n/language.ts`; ADR-0179's dated note of 2026-10-29). **`false` until P18.98-T4's exit**, and the
 * two flip together: `language.spec.ts` reads the frontend's and fails when they differ.
 *
 * **While `false`** a reader who has chosen nothing — no `Accept-Language`, no saved `users.locale` — reads **English**,
 * the product as it was, and an email to a person with no saved language is English too: nothing anybody reads turns
 * Indonesian before the screens do. **A choice is honoured all the same** — `Accept-Language: id`, a saved `'id'` —
 * which is how P18.98-T4 to T6 read their translations on staging. And **a figure inside a sentence stays Indonesian**
 * for a reader who has not chosen, as the product wrote figures before the phase (`readerOf`, `common/i18n/reader.ts`).
 *
 * Flipping it is the release: from then a reader who has chosen nothing reads Bahasa Indonesia, figures and all.
 */
export const LANGUAGE_LIVE: boolean = false;

/** **What a reader who has chosen nothing reads**: Bahasa Indonesia once the default is live, English until then. */
export function unchosenLanguage(live: boolean): Language {
  return live ? DEFAULT_LANGUAGE : SOURCE_LANGUAGE;
}

/** What a reader who has chosen no language reads today: `unchosenLanguage(LANGUAGE_LIVE)`. */
export const LANGUAGE_UNCHOSEN: Language = unchosenLanguage(LANGUAGE_LIVE);
