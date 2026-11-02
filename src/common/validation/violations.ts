import type { ValidationError } from 'class-validator';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { joinSentences, type Message, type Sentence } from '@/common/i18n/sentence';
import { HttpStatus } from '@nestjs/common';
import { VALIDATION_REFUSALS } from './validation.messages';

/**
 * **The pipe's refusals in the reader's language** (P18.98-T5 AC-3).
 *
 * `ValidationPipe` answers `400 VALIDATION_FAILED` with every violation in `details.violations` and all of them, joined
 * by `; `, as the message. Its words are class-validator's — English, from templates class-validator has kept for
 * years — or a DTO's own (`field`). Here each becomes a sentence: **the English exactly as the pipe wrote it before**, so
 * every assertion on it stands, and the Indonesian read off the same template (`VALIDATION_REFUSALS`), the field's name
 * kept as the API names it.
 *
 * Flattened as Nest flattens them (`ValidationPipe.flattenValidationErrors`): a nested property's violations are
 * prefixed with its path — `items.0.code must be a string` — and a property with children answers its children's.
 */

/**
 * **A DTO's own sentence, in both languages** — what a decorator's `message` takes in place of an English string:
 * `@IsIn(LANGUAGES, { message: field(AUTH_REFUSALS.VALIDATION_FAILED.localeShape) })`. class-validator carries a
 * string, so the two languages travel encoded in one, and the pipe reads them back here. Anything else that reads a
 * DTO's errors sees the marker and knows to ask the pipe.
 */
export function field(sentence: Sentence<'VALIDATION_FAILED'>): string {
  const write = (text: Message['en']) => (typeof text === 'function' ? text('id') : text);
  return `${FIELD_MARK}${JSON.stringify({ en: write(sentence.en), id: write(sentence.id) })}`;
}

const FIELD_MARK = 'i18n:';

/** A DTO's own sentence, read back: both languages, or `null` for a message class-validator wrote. */
function fieldSentence(text: string): Message | null {
  if (!text.startsWith(FIELD_MARK)) return null;
  const { en, id } = JSON.parse(text.slice(FIELD_MARK.length)) as { en: string; id: string };
  return { en, id };
}

/** One violation, as the pipe would have written it: its constraint, its words, and the path it sits under. */
interface Violation {
  readonly constraint: string;
  readonly text: string;
  readonly path: string | null;
  readonly property: string;
}

/** Every violation, flattened as Nest flattens them, in the same order. */
function flatten(errors: readonly ValidationError[]): Violation[] {
  const out: Violation[] = [];
  const own = (error: ValidationError, path: string | null) => {
    for (const [constraint, text] of Object.entries(error.constraints ?? {})) {
      out.push({ constraint, text, path, property: error.property });
    }
  };
  const walk = (error: ValidationError, parent: string | null): void => {
    if (!error.children?.length) {
      own(error, parent);
      return;
    }
    const path = parent ? `${parent}.${error.property}` : error.property;
    for (const child of error.children) {
      if (child.children?.length) walk(child, path);
      own(child, path);
    }
  };
  for (const error of errors) walk(error, null);
  return out;
}

/** One violation as a sentence: the English the pipe wrote, and its Indonesian. */
export function violationSentence(violation: Violation): Sentence<'VALIDATION_FAILED'> {
  const prefix = violation.path ? `${violation.path}.` : '';
  const own = fieldSentence(violation.text);
  if (own) return VALIDATION_REFUSALS.VALIDATION_FAILED.own({ prefix, en: own.en as string, id: own.id as string });
  return VALIDATION_REFUSALS.VALIDATION_FAILED.constraint({
    english: `${prefix}${violation.text}`,
    indonesian: indonesianOf(violation.constraint, violation.text, prefix, violation.property),
  });
}

/** The violations of one request, as sentences. */
export function violationsOf(errors: readonly ValidationError[]): Sentence<'VALIDATION_FAILED'>[] {
  return flatten(errors).map(violationSentence);
}

/**
 * **A message Nest wrote with no constraint to read it by** — a `BadRequestException` built from a list of strings
 * (only a spec's own pipe still does). Read as class-validator's, by its words.
 */
export function legacyViolation(text: string): Sentence<'VALIDATION_FAILED'> {
  const constraint = Object.keys(CONSTRAINTS).find((name) => CONSTRAINTS[name].some(([pattern]) => pattern.test(stripEach(text).rest)));
  return violationSentence({ constraint: constraint ?? 'unknown', text, path: null, property: 'value' });
}

/** **`ValidationPipe`'s `exceptionFactory`**: `400 VALIDATION_FAILED`, `details.violations`, in the reader's language. */
export function validationRefusal(errors: ValidationError[]): DomainException<'VALIDATION_FAILED'> {
  const violations = violationsOf(errors);
  return new DomainException(
    ErrorCode.VALIDATION_FAILED,
    joinSentences(violations, '; '),
    HttpStatus.BAD_REQUEST,
    { violations },
  );
}

/* ---------------------------------------------------------------------------------------------------------------- *
 * class-validator's own sentences, read in Indonesian
 * ---------------------------------------------------------------------------------------------------------------- */

const EACH = 'each value in ';

/** `each value in tags must be …` — class-validator's prefix for `{ each: true }` — read off, and said in Indonesian. */
function stripEach(text: string): { each: boolean; rest: string } {
  return text.startsWith(EACH) ? { each: true, rest: text.slice(EACH.length) } : { each: false, rest: text };
}

/** A figure inside a bound, as Indonesian writes it: *0,01*, *1.000*. */
function figure(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || raw.trim() === '') return raw;
  const [whole, fraction = ''] = raw.trim().replace(/^-/, '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${raw.trim().startsWith('-') ? '-' : ''}${grouped}${fraction ? `,${fraction}` : ''}`;
}

/** Each constraint's English templates, after the subject, and how each reads in Indonesian. */
type Template = readonly [pattern: RegExp, indonesian: (subject: string, groups: string[]) => string];

const CONSTRAINTS: Readonly<Record<string, readonly Template[]>> = {
  isString: [[/^(.+) must be a string$/, (s) => `${s} harus berupa teks`]],
  maxLength: [[/^(.+) must be shorter than or equal to (\S+) characters$/, (s, [n]) => `${s} paling banyak ${figure(n)} karakter`]],
  minLength: [[/^(.+) must be longer than or equal to (\S+) characters$/, (s, [n]) => `${s} paling sedikit ${figure(n)} karakter`]],
  isLength: [
    [/^(.+) must be longer than or equal to (\S+) and shorter than or equal to (\S+) characters$/,
      (s, [min, max]) => `${s} harus ${figure(min)} sampai ${figure(max)} karakter`],
    [/^(.+) must be longer than or equal to (\S+) characters$/, (s, [n]) => `${s} paling sedikit ${figure(n)} karakter`],
    [/^(.+) must be shorter than or equal to (\S+) characters$/, (s, [n]) => `${s} paling banyak ${figure(n)} karakter`],
  ],
  isIn: [[/^(.+) must be one of the following values: (.*)$/, (s, [values]) => `${s} harus salah satu dari nilai berikut: ${values}`]],
  isEnum: [[/^(.+) must be one of the following values: (.*)$/, (s, [values]) => `${s} harus salah satu dari nilai berikut: ${values}`]],
  matches: [[/^(.+) must match (.+) regular expression$/, (s, [pattern]) => `${s} harus sesuai dengan pola ${pattern}`]],
  isInt: [[/^(.+) must be an integer number$/, (s) => `${s} harus berupa bilangan bulat`]],
  min: [[/^(.+) must not be less than (\S+)$/, (s, [n]) => `${s} tidak boleh kurang dari ${figure(n)}`]],
  max: [[/^(.+) must not be greater than (\S+)$/, (s, [n]) => `${s} tidak boleh lebih dari ${figure(n)}`]],
  arrayMaxSize: [[/^(.+) must contain no more than (\S+) elements$/, (s, [n]) => `${s} paling banyak berisi ${figure(n)} item`]],
  arrayMinSize: [[/^(.+) must contain at least (\S+) elements$/, (s, [n]) => `${s} paling sedikit berisi ${figure(n)} item`]],
  isArray: [[/^(.+) must be an array$/, (s) => `${s} harus berupa daftar`]],
  isBoolean: [[/^(.+) must be a boolean value$/, (s) => `${s} harus bernilai true atau false`]],
  isMongoId: [[/^(.+) must be a mongodb id$/, (s) => `${s} harus berupa ID yang valid`]],
  isObject: [[/^(.+) must be an object$/, (s) => `${s} harus berupa objek`]],
  isNumber: [[/^(.+) must be a number conforming to the specified constraints$/, (s) => `${s} harus berupa angka`]],
  isNotEmpty: [[/^(.+) should not be empty$/, (s) => `${s} tidak boleh kosong`]],
  arrayNotEmpty: [[/^(.+) should not be empty$/, (s) => `${s} tidak boleh kosong`]],
  isEmail: [[/^(.+) must be an email$/, (s) => `${s} harus berupa alamat email`]],
  arrayUnique: [[/^All (.+)'s elements must be unique$/, (s) => `Setiap item di ${s} harus berbeda`]],
  whitelistValidation: [[/^property (.+) should not exist$/, (s) => `properti ${s} tidak dikenal`]],
  nestedValidation: [[/^nested property (.+) must be either object or array$/, (s) => `properti ${s} harus berupa objek atau daftar`]],
  unknownValue: [[/^an unknown value was passed to the validate function$/, () => 'nilai yang dikirim tidak dikenal']],
};

/** The constraints this reads in Indonesian — what `violations.spec.ts` holds every DTO's to. */
export const TRANSLATED_CONSTRAINTS: readonly string[] = Object.keys(CONSTRAINTS);

/**
 * **One of class-validator's sentences, in Indonesian**: read by its constraint's templates, the subject — the field,
 * under its path, *setiap nilai di …* for `{ each: true }` — kept as the API names it. A sentence no template reads
 * (a constraint this list does not know) still answers in Indonesian, naming the field.
 */
function indonesianOf(constraint: string, text: string, prefix: string, property: string): string {
  const { each, rest } = stripEach(text);
  for (const [pattern, write] of CONSTRAINTS[constraint] ?? []) {
    const match = pattern.exec(rest);
    if (match) {
      const named = `${prefix}${match[1]}`;
      return write(each ? `setiap nilai di ${named}` : named, match.slice(2));
    }
  }
  return `${prefix}${property} tidak valid`;
}
