import { formatNumber } from '@/common/format/format';
import { readerIn } from '@/common/i18n/reader';
import { refusals, render, type Sentence } from '@/common/i18n/sentence';

/** A bound in Indonesian: *1.000* from a thousand up (the glossary's §E). */
const idNumber = (n: number): string => formatNumber(n, undefined, 'id');

/**
 * **The recruitment module's refusals, in both languages** (P18.98-T5 AC-2, AC-3): a plan's brief, read from its
 * address; the pitch materials' checklists; and a company's playbook, refused field by field. *Recruitment*,
 * *Playbook* and *Pitch* stay as the glossary keeps them (§A.6); *brief* is the loanword Indonesian offices use. A
 * parameter or a field is named as the API names it — `motivation`, `body.profiles.retiree.tagline` — in both.
 */
export const RECRUITMENT_REFUSALS = refusals('modules/recruitment', {
  VALIDATION_FAILED: {
    /* ---- a plan's brief (`recruitment-plan.ts`) ---- */
    briefIncomplete: ({ missing }: { missing: readonly string[] }) => ({
      en: `A brief needs a candidate type, a motivation and a hesitation; ${missing.join(' and ')} missing.`,
      id: `Brief memerlukan jenis kandidat, motivasi, dan keraguan; ${missing.join(' dan ')} belum diisi.`,
    }),
    notACandidateType: ({ type }: { type: string }) => ({
      en: `"${type}" is not a candidate type.`,
      id: `"${type}" bukan jenis kandidat.`,
    }),
    notOneOfAnswers: ({ parameter }: { parameter: string }) => ({
      en: `${parameter} holds a code that is not one of its answers, or none at all.`,
      id: `${parameter} berisi kode yang bukan salah satu jawabannya, atau tidak berisi kode sama sekali.`,
    }),
    answerTwice: ({ parameter }: { parameter: string }) => ({
      en: `${parameter} names one answer twice.`,
      id: `${parameter} menyebut satu jawaban dua kali.`,
    }),

    /* ---- the pitch materials (`recruitment-pitch.service.ts`); a slot's title is the product's, kept ---- */
    noSuchItem: ({ title, item }: { title: string; item: string }) => ({
      en: `${title} has no item "${item}" to confirm.`,
      id: `${title} tidak memiliki item "${item}" untuk dikonfirmasi.`,
    }),
    noFileYet: ({ title }: { title: string }) => ({
      en: `${title} has no file yet: upload one before confirming what it includes.`,
      id: `${title} belum memiliki file: unggah file dulu sebelum mengonfirmasi isinya.`,
    }),

    /* ---- a playbook, field by field (`recruitment-playbook-input.ts`): what follows the field's path ---- */
    notAnObject: {
      en: 'Must be an object of fields.',
      id: 'Harus berupa objek berisi kolom.',
    },
    notPartOfPlaybook: {
      en: 'Is not part of a recruitment playbook.',
      id: 'Bukan bagian dari playbook recruitment.',
    },
    empty: {
      en: 'Must not be empty.',
      id: 'Tidak boleh kosong.',
    },
    tooLong: ({ max }: { max: number }) => ({
      en: `Must be ${max} characters or fewer.`,
      id: `Paling banyak ${idNumber(max)} karakter.`,
    }),
    missing: {
      en: 'Is missing: every one must be answered.',
      id: 'Belum diisi: semuanya wajib dijawab.',
    },
    notAList: {
      en: 'Must be a list.',
      id: 'Harus berupa daftar.',
    },
    benefitsCount: ({ min, max }: { min: number; max: number }) => ({
      en: `Must hold ${min} to ${max} benefits.`,
      id: `Harus berisi ${idNumber(min)} sampai ${idNumber(max)} manfaat.`,
    }),
    /** The refusal's own message: every violation, its field's path then its sentence, in the reader's language. */
    cannotSave: ({ violations }: { violations: readonly { field: string; message: Sentence }[] }) => ({
      en: (figures) => `This playbook cannot be saved: ${violations
        .map((v) => `${v.field} — ${render(v.message, { language: 'en', figures })}`).join('; ')}`,
      id: `Playbook ini tidak dapat disimpan: ${violations
        .map((v) => `${v.field} — ${render(v.message, readerIn('id'))}`).join('; ')}`,
    }),
  },
});
