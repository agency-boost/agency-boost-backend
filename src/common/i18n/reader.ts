import {
  DEFAULT_LANGUAGE, isLanguage, LANGUAGE_LIVE, SOURCE_LANGUAGE, unchosenLanguage, type Language,
} from '@/domain/constants/language';

/**
 * **Who a sentence is written for** (ADR-0179 §6, §7; P18.98-T5 AC-1): the language its words are in, and the language
 * its figures are in — a date, a number, a sum (`common/format`). The two are one language for anybody who has chosen,
 * and, since the Indonesian default went live on 2026-10-29 (`LANGUAGE_LIVE`), for everybody. Before, a reader who had
 * chosen nothing read the product as it was: English words, Indonesian figures (ADR-0167 §1).
 */
export interface Reader {
  readonly language: Language;
  readonly figures: Language;
}

/** What the request names, and what the person saved. */
export interface ReaderInput {
  /** The `Accept-Language` the app sent — `id` or `en` — or `null`: absent, or anything else (`headerLanguage`). */
  readonly header?: Language | null;
  /**
   * The signed-in person's saved choice, `users.locale`: `null` when they have made none, and in a support session,
   * where the person's own choice is neither read nor written (ADR-0179 §2, ADR-0162 §4).
   */
  readonly stored?: Language | null;
  /** Whether the Indonesian default is live; `LANGUAGE_LIVE` unless a test asks for the other state. */
  readonly live?: boolean;
}

/**
 * **The request's language** (ADR-0179 §7; P18.98-T5 AC-1): the `Accept-Language` the app sends from the screen's
 * language; failing that, the signed-in person's `users.locale`; failing that, the language of a reader who has chosen
 * nothing — Bahasa Indonesia since the default went live on 2026-10-29, English before (`unchosenLanguage`).
 *
 * **A figure's language is the chosen language, else Indonesian; once live, the request's** — the frontend's rule
 * (P18.98-T3). The API cannot see the browser's cookie, so a choice it can see is a saved one: before the release an
 * `Accept-Language: en` with nothing saved is the app's own default for a reader with no choice, and its figures stay
 * Indonesian, as the screens write them.
 */
export function readerOf({ header = null, stored = null, live = LANGUAGE_LIVE }: ReaderInput = {}): Reader {
  const language = header ?? stored ?? unchosenLanguage(live);
  return { language, figures: live || stored !== null ? language : DEFAULT_LANGUAGE };
}

/**
 * **The language an `Accept-Language` header names**, or `null` (P18.98-T5 AC-1). The app sends exactly `id` or `en`
 * (P18.98-T2 AC-6), so only those count — a browser's own `en-US,en;q=0.9` or `id-ID,id;q=0.9` is no choice of the
 * reader's, and must not turn the API Indonesian before the screens are. Case and surrounding spaces are forgiven.
 */
export function headerLanguage(value: string | string[] | undefined): Language | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const named = raw?.trim().toLowerCase();
  return isLanguage(named) ? named : null;
}

/**
 * **The reader of an email** (P18.98-T5 AC-5): the recipient's saved language, words and figures; for a recipient with
 * none, the request that caused it where it was the reader's own (the verification and reset emails: the language of
 * the page that asked for them); else a reader who has chosen nothing.
 */
export function recipientReader(stored: Language | null, caused?: Reader | null, live: boolean = LANGUAGE_LIVE): Reader {
  if (stored !== null) return { language: stored, figures: stored };
  return caused ?? readerOf({ live });
}

/**
 * **The API's own English, as it wrote it before the phase**: English words, Indonesian figures. What a refusal's
 * `Error.message` and `getResponse()` hold — so a log line, and a unit test that asserts a refusal's words, read what
 * they always read — while the response is written for the request's reader (`error.filter.ts`).
 */
export const SOURCE_READER: Reader = Object.freeze({ language: SOURCE_LANGUAGE, figures: DEFAULT_LANGUAGE });

/** A reader of one language, words and figures alike: what a test, or a person who chose it, reads. */
export function readerIn(language: Language): Reader {
  return { language, figures: language };
}

/**
 * **Where the request's reader is kept** — the Express request's own property, set by `AuthGuard` before anything
 * else it does (every route, public ones too) and refined once it has read who is signed in.
 */
export interface ReaderCarrier {
  reader?: Reader;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * **The request's reader, wherever it is asked for** (P18.98-T5 AC-1): the one `AuthGuard` resolved, or — for a request
 * refused before any guard ran (an unknown route, a body that is not JSON) — the header's, with nothing saved to read.
 */
export function readerOfRequest(request: ReaderCarrier | undefined): Reader {
  return request?.reader ?? readerOf({ header: headerLanguage(request?.headers?.['accept-language']) });
}
