import type { ErrorCodeValue } from '@/common/errors/error-codes';
import type { Language } from '@/domain/constants/language';
import { SOURCE_READER, type Reader } from './reader';

/**
 * **Every sentence the API writes, in both languages** (ADR-0179 §7; P18.98-T5).
 *
 * A sentence is English and Indonesian side by side, the English the source — what the API wrote before the phase —
 * and the Indonesian typed against it from the approved glossary's vocabulary and voice. **A missing language fails
 * `tsc`**: a `Message` is a record over `Language`. It is written for its reader when it is answered, never when it is
 * thrown: a refusal is raised deep in a service that knows nothing of the request, and the error filter knows the
 * reader (`readerOfRequest`).
 *
 * **The words live with their module**, one catalogue per module, `<module>.messages.ts` beside the code that raises
 * them — never one file for the API, which several people change at once. A refusal's catalogue is filed by error code
 * (`refusals`), so `sentence.spec.ts` can walk `ErrorCode` and fail a code nothing can say; any other sentence — a
 * notice, an email, a figure's words — is filed by name (`messages`).
 */

/**
 * One language's text: a string, or — where a figure is written into it — a function of the figures' language, so a
 * date or a sum reads in the reader's way (`common/format`, which takes the language last).
 */
export type Text = string | ((figures: Language) => string);

/** A sentence in each language, as a catalogue writes it. */
export type Message = Readonly<Record<Language, Text>>;

/** The code a sentence is filed under — `null` for one that is not a refusal's — kept on the sentence itself. */
const FILED_UNDER: unique symbol = Symbol('filedUnder');

/**
 * **A sentence out of a catalogue**: a `Message` that says which code it was filed under. `DomainException` takes only
 * these, typed by code, so a refusal cannot be raised with another code's words, nor with words written inline.
 */
export interface Sentence<C extends ErrorCodeValue | null = ErrorCodeValue | null> extends Message {
  readonly [FILED_UNDER]: C;
}

/** Whether a value is a sentence out of a catalogue — what `renderDeep` writes for its reader, and nothing else. */
export function isSentence(value: unknown): value is Sentence {
  return typeof value === 'object' && value !== null && FILED_UNDER in value;
}

/** The code a sentence is filed under, or `null`. */
export function filedUnder<C extends ErrorCodeValue | null>(sentence: Sentence<C>): C {
  return sentence[FILED_UNDER];
}

function file<C extends ErrorCodeValue | null>(message: Message, code: C): Sentence<C> {
  return Object.freeze({ en: message.en, id: message.id, [FILED_UNDER]: code });
}

/** **A sentence written for its reader**: their language, with every figure in it written in their figures' language. */
export function render(message: Message, reader: Reader): string {
  const text = message[reader.language];
  return typeof text === 'function' ? text(reader.figures) : text;
}

/** A sentence as the API wrote it before the phase — English words, Indonesian figures (`SOURCE_READER`). */
export function inSource(message: Message): string {
  return render(message, SOURCE_READER);
}

/**
 * **Every sentence inside a value, written for its reader** — a refusal's `details.violations`, a service's field
 * sentences (P18.98-T5 AC-3). Arrays and plain objects are walked; anything else is answered as it is, and a value with
 * no sentence in it is answered as the same object.
 */
export function renderDeep<T>(value: T, reader: Reader): T {
  if (isSentence(value)) return render(value, reader) as T;
  if (Array.isArray(value)) {
    const items = value.map((item) => renderDeep(item, reader));
    return (items.some((item, i) => item !== value[i]) ? items : value) as T;
  }
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    let changed = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const written = renderDeep(item, reader);
      changed ||= written !== item;
      return [key, written] as const;
    });
    return (changed ? Object.fromEntries(entries) : value) as T;
  }
  return value;
}

/**
 * **Sentences said one after another** — a list of problems in one refusal, a prefix and the sentence it introduces.
 * Each language joins its own parts; a figure in any part is written for the reader.
 */
export function joinSentences<C extends ErrorCodeValue | null>(parts: readonly Sentence<C>[], separator = ' '): Sentence<C> {
  const join = (language: Language): Text => (figures) => parts.map((part) => render(part, { language, figures })).join(separator);
  return file({ en: join('en'), id: join('id') }, (parts[0] ? filedUnder(parts[0]) : null) as C);
}

/**
 * **The same words under another code** — a rule a domain function words once (`resolveDisplayUnit`), refused under
 * whichever code each caller raises. Rare by design: a refusal is filed under its own code in its own catalogue.
 */
export function refiled<C extends ErrorCodeValue>(sentence: Sentence, code: C): Sentence<C> {
  return file({ en: sentence.en, id: sentence.id }, code);
}

/** **A sentence after a few characters that are no language's** — a code, a row's label: `REFERRAL_RATE: …`. */
export function prefixed<C extends ErrorCodeValue | null>(prefix: string, sentence: Sentence<C>): Sentence<C> {
  const write = (language: Language): Text => (figures) => `${prefix}${render(sentence, { language, figures })}`;
  return file({ en: write('en'), id: write('id') }, filedUnder(sentence));
}

/* ------------------------------------------------------------------------------------------------------------------ *
 * Catalogues
 * ------------------------------------------------------------------------------------------------------------------ */

/** A catalogue's entry: a sentence, or a function of its values that answers one. */
type Entry = Message | ((values: never) => Message);

/** An entry filed: a sentence, or the function answering one, each carrying its code. */
type Filed<C extends ErrorCodeValue | null, E> = E extends (values: infer V) => Message ? (values: V) => Sentence<C> : Sentence<C>;

/** A module's refusals, by the code each is raised under and then by name. */
export type RefusalCatalogue = { readonly [C in ErrorCodeValue]?: Readonly<Record<string, Entry>> };

export type Refusals<T extends RefusalCatalogue> = {
  readonly [C in keyof T & ErrorCodeValue]: { readonly [K in keyof T[C]]: Filed<C, T[C][K]> };
};

/** A module's other sentences — a notice, an email, a figure's words — by name. */
export type MessageCatalogue = Readonly<Record<string, Entry>>;

export type Messages<T extends MessageCatalogue> = { readonly [K in keyof T]: Filed<null, T[K]> };

/** One registered catalogue, as the walk reads it: its name, and its entries by code. */
export interface RegisteredRefusals {
  readonly name: string;
  readonly entries: Readonly<Partial<Record<ErrorCodeValue, Readonly<Record<string, Entry>>>>>;
}

/** One registered catalogue of other sentences, as the walk reads it. */
export interface RegisteredMessages {
  readonly name: string;
  readonly entries: MessageCatalogue;
}

const REFUSALS: RegisteredRefusals[] = [];
const MESSAGES: RegisteredMessages[] = [];

function fileEntry(entry: Entry, code: ErrorCodeValue | null): unknown {
  return typeof entry === 'function'
    ? (values: never) => file((entry as (values: never) => Message)(values), code)
    : file(entry, code);
}

/**
 * **A module's refusals** (P18.98-T5 AC-2), filed by code and then by name: `name` is the module's, the walk's way of
 * saying where a missing sentence belongs. A throw site names its sentence by both —
 * `new DomainException(ErrorCode.LEAD_ALREADY_CLOSED, LEAD_REFUSALS.LEAD_ALREADY_CLOSED.reopenFirst, …)` — and `tsc`
 * refuses a sentence filed under another code.
 */
export function refusals<const T extends RefusalCatalogue>(name: string, catalogue: T): Refusals<T> {
  REFUSALS.push({ name, entries: catalogue });
  return Object.freeze(Object.fromEntries(Object.entries(catalogue).map(([code, section]) => [
    code,
    Object.freeze(Object.fromEntries(Object.entries(section as Record<string, Entry>).map(
      ([key, entry]) => [key, fileEntry(entry, code as ErrorCodeValue)],
    ))),
  ]))) as Refusals<T>;
}

/** **A module's other sentences** — a notice, an email, a figure's words — by name (P18.98-T5 AC-4, AC-5). */
export function messages<const T extends MessageCatalogue>(name: string, catalogue: T): Messages<T> {
  MESSAGES.push({ name, entries: catalogue });
  return Object.freeze(Object.fromEntries(
    Object.entries(catalogue).map(([key, entry]) => [key, fileEntry(entry, null)]),
  )) as Messages<T>;
}

/** Every refusal catalogue loaded so far — what the walk reads, once it has loaded every `*.messages.ts`. */
export function registeredRefusals(): readonly RegisteredRefusals[] {
  return [...REFUSALS];
}

/** Every catalogue of other sentences loaded so far. */
export function registeredMessages(): readonly RegisteredMessages[] {
  return [...MESSAGES];
}
