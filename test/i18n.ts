import { readerIn, SOURCE_READER } from '@/common/i18n/reader';
import { render, type Message } from '@/common/i18n/sentence';

/**
 * **A sentence as a test reads it** (P18.98-T5 AC-7; ADR-0179 §9: English unless a test asks).
 *
 * - `english` — the API's English as it wrote it before the phase, its figures Indonesian (`SOURCE_READER`): what a
 *   refusal's `Error.message` holds and what an integration suite reads by default.
 * - `indonesian` — the same sentence in Bahasa Indonesia, figures and all.
 */
export function english(message: Message): string;
export function english(message: Message | null | undefined): string | null | undefined;
export function english(message: Message | null | undefined): string | null | undefined {
  return message ? render(message, SOURCE_READER) : message;
}

export function indonesian(message: Message): string;
export function indonesian(message: Message | null | undefined): string | null | undefined;
export function indonesian(message: Message | null | undefined): string | null | undefined {
  return message ? render(message, readerIn('id')) : message;
}

/** A list of sentences, each as `english` reads it. */
export const englishAll = (messages: readonly Message[]): string[] => messages.map((m) => english(m));

/** A list of sentences, each as `indonesian` reads it. */
export const indonesianAll = (messages: readonly Message[]): string[] => messages.map((m) => indonesian(m));

/** The header an Indonesian screen sends: `.set(...IN_INDONESIAN)`. */
export const IN_INDONESIAN = ['Accept-Language', 'id'] as const;
