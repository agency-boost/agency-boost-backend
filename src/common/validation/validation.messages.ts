import { refusals } from '@/common/i18n/sentence';

/** A bound in a field's sentence, as Indonesian writes it: *0,01*, *1.000*. English keeps the number as it always has. */
function idNumber(n: number): string {
  const [whole, fraction] = String(Math.abs(n)).split('.');
  return `${n < 0 ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${fraction ? `,${fraction}` : ''}`;
}

/**
 * **How a request body is refused, field by field, in both languages** (P18.98-T5 AC-3): the pipe's sentences
 * (`violations.ts` reads class-validator's English by its templates) and `Fields`', which every module's input checker
 * shares (`fields.ts`). A field is named as the API names it — `label`, `appliesToOrgLevelCodes` — in both.
 */
export const VALIDATION_REFUSALS = refusals('common/validation', {
  VALIDATION_FAILED: {
    /** class-validator's own sentence: the English as the pipe wrote it, and its Indonesian (`violations.ts`). */
    constraint: ({ english, indonesian }: { english: string; indonesian: string }) => ({ en: english, id: indonesian }),
    /** A DTO's own sentence (`field`), under the path it sits at. */
    own: ({ prefix, en, id }: { prefix: string; en: string; id: string }) => ({ en: `${prefix}${en}`, id: `${prefix}${id}` }),

    notAnObject: {
      en: 'The change must be an object of fields.',
      id: 'Perubahan harus berupa objek berisi kolom.',
    },
    unknownField: ({ key }: { key: string }) => ({
      en: `property ${key} should not exist`,
      id: `properti ${key} tidak dikenal`,
    }),
    required: ({ field }: { field: string }) => ({
      en: `${field} is required.`,
      id: `${field} wajib diisi.`,
    }),
    notText: ({ field }: { field: string }) => ({
      en: `${field} must be text.`,
      id: `${field} harus berupa teks.`,
    }),
    textBetween: ({ field, min, max }: { field: string; min: number; max: number }) => ({
      en: `${field} must be ${min}–${max} characters.`,
      id: `${field} harus ${idNumber(min)}–${idNumber(max)} karakter.`,
    }),
    textAtMost: ({ field, max }: { field: string; max: number }) => ({
      en: `${field} must be at most ${max} characters.`,
      id: `${field} paling banyak ${idNumber(max)} karakter.`,
    }),
    /** How a code may be typed (`CODE_PATTERN`): a DTO's `@Matches` says it, and so does `Fields.code`. */
    codeShape: {
      en: 'A code is 3–40 characters of A–Z, 0–9 and underscore, starting with a letter.',
      id: 'Kode terdiri dari 3–40 karakter A–Z, 0–9 dan garis bawah, diawali huruf.',
    },
    fieldCodeShape: ({ field }: { field: string }) => ({
      en: `${field}: A code is 3–40 characters of A–Z, 0–9 and underscore, starting with a letter.`,
      id: `${field}: Kode terdiri dari 3–40 karakter A–Z, 0–9 dan garis bawah, diawali huruf.`,
    }),
    codesBetween: ({ field, min, max }: { field: string; min: number; max: number }) => ({
      en: `${field} must name ${min}–${max} codes.`,
      id: `${field} harus berisi ${idNumber(min)}–${idNumber(max)} kode.`,
    }),
    notCodes: ({ field }: { field: string }) => ({
      en: `${field} must be a list of codes.`,
      id: `${field} harus berupa daftar kode.`,
    }),
    numberBetween: ({ field, min, max }: { field: string; min: number; max: number }) => ({
      en: `${field} must be a number from ${min} to ${max}.`,
      id: `${field} harus berupa angka dari ${idNumber(min)} sampai ${idNumber(max)}.`,
    }),
    oneOf: ({ field, values }: { field: string; values: readonly string[] }) => ({
      en: `${field} must be one of ${values.join(', ')}.`,
      id: `${field} harus salah satu dari ${values.join(', ')}.`,
    }),
  },
});
