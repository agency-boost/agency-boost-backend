import { refusals } from '@/common/i18n/sentence';

/** A list of codes, as a sentence names them. */
const list = (codes: readonly string[]) => codes.join(', ');

/**
 * **The template's *Advanced analytics* section, refused in both languages** (P19.5-T1; ADR-0214 §2, §7). The
 * Indonesian is the template mockup's own where it has words for the case (*"Kode ini sudah dipakai."*, *"Satuan
 * terkunci karena sudah ada data…"*, *"Batas pasif harus lebih kecil dari promotor."*) and Case 10's for a pattern
 * the registered codes do not match. A field's sentence names the field by its path in the payload, as the API names
 * it (`uploadFields.3.unit`), and `details.violations` carries each one beside its field.
 */
export const ANALYTICS_TEMPLATE_REFUSALS = refusals('modules/config/analytics', {
  ANALYTICS_SYSTEM_COLUMN: {
    missing: ({ kode }: { kode: string }) => ({
      en: `${kode} is a system column: it can be renamed, not deleted.`,
      id: `${kode} adalah kolom sistem: bisa diganti nama, tidak bisa dihapus.`,
    }),
    notSystem: ({ kode }: { kode: string }) => ({
      en: `${kode} is a system column and must stay one.`,
      id: `${kode} adalah kolom sistem dan harus tetap begitu.`,
    }),
    onlyFour: ({ kode }: { kode: string }) => ({
      en: `${kode} cannot be a system column: only APE, POLICY_COUNT, RECRUITMENT and NEW_ACTIVE_AGENTS are.`,
      id: `${kode} tidak bisa menjadi kolom sistem: hanya APE, POLICY_COUNT, RECRUITMENT dan NEW_ACTIVE_AGENTS.`,
    }),
    fixed: ({ kode }: { kode: string }) => ({
      en: `${kode} is a system column: its unit and its year to date are fixed.`,
      id: `${kode} adalah kolom sistem: satuan dan YTD-nya tetap.`,
    }),
  },
  ANALYTICS_UNIT_LOCKED: {
    locked: ({ kode }: { kode: string }) => ({
      en: `The unit of ${kode} is locked because a KPM already holds data for it. Make a new column for another unit.`,
      id: `Satuan ${kode} terkunci karena sudah ada data. Buat kolom baru untuk satuan lain.`,
    }),
  },
  ANALYTICS_EFFECTIVE_FROM_LOCKED: {
    locked: ({ kode }: { kode: string }) => ({
      en: `The start month of ${kode} is locked because a KPM already holds data for it.`,
      id: `Bulan berlaku ${kode} terkunci karena sudah ada data.`,
    }),
  },
  ANALYTICS_KODE_TAKEN: {
    taken: ({ kode }: { kode: string }) => ({
      en: `${kode}: this code is already used.`,
      id: `${kode}: kode ini sudah dipakai.`,
    }),
  },
  ANALYTICS_CODE_PATTERN_MISMATCH: {
    mismatch: ({ mismatched, total, examples }: { mismatched: number; total: number; examples: readonly string[] }) => ({
      en: `${mismatched} of ${total} registered agent codes do not match the new format`
        + `${examples.length ? ` (e.g. ${list(examples)})` : ''}. Change the agent code format, then publish again.`,
      id: `${mismatched} kode agen yang sudah terdaftar tidak cocok dengan format baru`
        + `${examples.length ? ` (mis. ${list(examples)})` : ''}. Ubah format kode agen, lalu terbitkan lagi.`,
    }),
  },
  VALIDATION_FAILED: {
    cannotSave: ({ n }: { n: number }) => ({
      en: n === 1 ? 'The Advanced analytics section has 1 problem.' : `The Advanced analytics section has ${n} problems.`,
      id: `Bagian Advanced analytics memiliki ${n} masalah.`,
    }),
    notAnObject: { en: 'Must be an object.', id: 'Harus berupa objek.' },
    notAList: { en: 'Must be a list.', id: 'Harus berupa daftar.' },
    notPartOf: ({ key }: { key: string }) => ({
      en: `${key} is not part of the Advanced analytics section.`,
      id: `${key} bukan bagian dari Advanced analytics.`,
    }),
    sections: {
      en: 'The sections are the six — DEMOGRAPHICS, MAPA, NPS, QUANT, QUAL and SUBGROUP — each once.',
      id: 'Bagiannya enam — DEMOGRAPHICS, MAPA, NPS, QUANT, QUAL dan SUBGROUP — masing-masing sekali.',
    },
    tooManyFields: ({ max }: { max: number }) => ({
      en: `A template holds at most ${max} Data upload columns.`,
      id: `Template berisi paling banyak ${max} kolom data upload.`,
    }),
    kodeShape: {
      en: 'A code is capital letters, digits and _, starting with a letter, 40 at most, and never ends with _YTD.',
      id: 'Kode berupa huruf besar, angka dan _, diawali huruf, paling banyak 40, dan tidak diakhiri _YTD.',
    },
    kodeRequired: { en: 'Enter a code.', id: 'Isi kode.' },
    labelRequired: { en: 'Enter a name.', id: 'Isi nama.' },
    textTooLong: ({ max }: { max: number }) => ({
      en: `At most ${max} characters.`,
      id: `Paling banyak ${max} karakter.`,
    }),
    oneOf: ({ values }: { values: readonly string[] }) => ({
      en: `Must be one of ${list(values)}.`,
      id: `Harus salah satu dari ${list(values)}.`,
    }),
    yesOrNo: { en: 'Must be true or false.', id: 'Harus true atau false.' },
    number: { en: 'Must be a number, or empty.', id: 'Harus berupa angka, atau kosong.' },
    wholeBetween: ({ min, max }: { min: number; max: number }) => ({
      en: `A whole number from ${min} to ${max}.`,
      id: `Bilangan bulat dari ${min} sampai ${max}.`,
    }),
    numberBetween: ({ min, max }: { min: number; max: number }) => ({
      en: `A number from ${min} to ${max}.`,
      id: `Angka dari ${min} sampai ${max}.`,
    }),
    percentBounds: { en: 'A percentage is from 0 to 100.', id: 'Persen harus dari 0 sampai 100.' },
    minAboveMax: {
      en: 'The smallest value must not exceed the largest.',
      id: 'Nilai terkecil tidak boleh lebih besar dari nilai terbesar.',
    },
    month: { en: 'A month, YYYY-MM.', id: 'Bulan, YYYY-MM.' },
    fixed: ({ value }: { value: string }) => ({
      en: `Fixed at ${value}.`,
      id: `Tetap ${value}.`,
    }),
    maaFixed: {
      en: 'Active (MAA) reads APE and POLICY_COUNT, fixed, so every KPM counts an active agent the same way.',
      id: 'Agen aktif (MAA) membaca APE dan POLICY_COUNT, tetap, supaya semua KPM menghitung agen aktif dengan cara yang sama.',
    },
    patternNotAnchored: {
      en: 'The agent code format must start with ^ and end with $.',
      id: 'Format kode agen harus diawali ^ dan diakhiri $.',
    },
    patternTooLong: ({ max }: { max: number }) => ({
      en: `The agent code format is at most ${max} characters.`,
      id: `Format kode agen paling banyak ${max} karakter.`,
    }),
    patternBackreference: {
      en: 'The agent code format cannot refer back to a group (\\1, \\k<…>).',
      id: 'Format kode agen tidak boleh merujuk balik ke grup (\\1, \\k<…>).',
    },
    patternLookaround: {
      en: 'The agent code format cannot look ahead or behind ((?=, (?!, (?<=, (?<!).',
      id: 'Format kode agen tidak boleh melihat ke depan atau ke belakang ((?=, (?!, (?<=, (?<!).',
    },
    patternUnsupported: {
      en: 'The agent code format uses something a code format cannot (a word boundary, or ^ or $ inside it).',
      id: 'Format kode agen memakai sesuatu yang tidak bisa dipakai format kode (batas kata, atau ^ atau $ di tengah).',
    },
    patternSyntax: {
      en: 'The agent code format is not a pattern that can be read.',
      id: 'Format kode agen bukan pola yang bisa dibaca.',
    },
    patternTooLarge: {
      en: 'The agent code format repeats too much to be checked.',
      id: 'Format kode agen terlalu banyak pengulangan untuk diperiksa.',
    },
    exampleMismatch: {
      en: 'The example must match the agent code format.',
      id: 'Contoh harus cocok dengan format kode agen.',
    },
    passiveBelowPromoter: {
      en: 'The passive cut-off must be below the promoter one.',
      id: 'Batas pasif harus lebih kecil dari promotor.',
    },
    watchBelowBig: {
      en: '"Needs attention" must be below "Big issue".',
      id: '"Perlu perhatian" harus lebih kecil dari "Masalah besar".',
    },
    supportPassiveBelow: {
      en: 'Leader support: "enough" must be below "satisfied".',
      id: 'Dukungan leader: "cukup" harus lebih kecil dari "puas".',
    },
    ascending: {
      en: 'The bands must rise from one to the next.',
      id: 'Batas kelompok harus naik dari satu ke berikutnya.',
    },
    powerUserDays: {
      en: 'A power user\'s days fit inside the window.',
      id: 'Hari power user harus muat di dalam jendelanya.',
    },
    atLeastOneQuestion: {
      en: 'The NPS survey has at least one score question.',
      id: 'Survei NPS memiliki paling sedikit satu pertanyaan skor.',
    },
    questionKodeTaken: ({ kode }: { kode: string }) => ({
      en: `${kode}: this question code is already used.`,
      id: `${kode}: kode pertanyaan ini sudah dipakai.`,
    }),
    /* The push (ADR-0208) never carries the section: every KPM reads it live (ADR-0214 §1). */
    neverPushed: {
      en: 'Advanced analytics is read live by every KPM on the template, so it is never applied to a KPM: publishing it '
        + 'reaches them all.',
      id: 'Advanced analytics dibaca langsung oleh semua KPM di template ini, jadi tidak pernah diterapkan ke satu KPM: '
        + 'menerbitkannya sudah menjangkau semuanya.',
    },
  },
});
