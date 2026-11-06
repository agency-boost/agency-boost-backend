import { formatNumber } from '@/common/format/format';
import { readerIn } from '@/common/i18n/reader';
import { refusals, render, type Sentence } from '@/common/i18n/sentence';

/** A bound or a count in Indonesian: *1.000* from a thousand up (the glossary's §E). */
const idNumber = (n: number): string => formatNumber(n, undefined, 'id');

/** A level of the training taxonomy, as the API names it. */
export type TrainingLevel = 'category' | 'skill' | 'module';

/** Each level in a sentence — *Skill* kept (§A.6), *modul* in a sentence — and capitalised, as a row's place. */
const LEVEL = {
  category: { en: 'category', id: 'kategori', At: { en: 'Category', id: 'Kategori' } },
  skill: { en: 'skill', id: 'skill', At: { en: 'Skill', id: 'Skill' } },
  module: { en: 'module', id: 'modul', At: { en: 'Module', id: 'Modul' } },
} as const;

/** One item of a module's content, by its place in its section: *File 2*, *Video 1*, *Link 3* — *Tautan 3*. */
export interface ContentItem {
  kind: 'file' | 'video' | 'link';
  n: number;
}

const ITEM = {
  file: { en: 'File', id: 'File' },
  video: { en: 'Video', id: 'Video' },
  link: { en: 'Link', id: 'Tautan' },
} as const;

const itemAt = ({ kind, n }: ContentItem) => ({ en: `${ITEM[kind].en} ${n}`, id: `${ITEM[kind].id} ${n}` });

/**
 * **The training module's refusals, in both languages** (P18.10-T5 AC-2, AC-3): an office's taxonomy — categories,
 * skills and modules — a module's content, and a company template's taxonomy. *Training* and *Skill* stay as the
 * glossary keeps them (§A.6); a module is a *modul* in a sentence; a link is a *tautan* (§B.0). A field is named as
 * the API names it — `url`, `files` — in both languages.
 */
export const TRAINING_REFUSALS = refusals('modules/training', {
  VALIDATION_FAILED: {
    /* ---- an office's taxonomy (`training.service.ts`) ---- */
    nothingToChange: {
      en: 'Nothing to change.',
      id: 'Tidak ada yang diubah.',
    },
    skillInArchivedCategory: ({ code, categoryCode }: { code: string; categoryCode: string }) => ({
      en: `${code} is in ${categoryCode}, which is archived. Restore the category first — a skill in an archived `
        + 'category shows on no screen.',
      id: `${code} ada di ${categoryCode}, yang diarsipkan. Pulihkan kategorinya dulu — skill di kategori yang `
        + 'diarsipkan tidak tampil di layar mana pun.',
    }),
    moduleUnderArchivedSkill: ({ code, skillCode }: { code: string; skillCode: string }) => ({
      en: `${code} teaches ${skillCode}, which is archived. Restore the skill first — a module under an archived `
        + 'skill shows on no screen.',
      id: `${code} mengajarkan ${skillCode}, yang diarsipkan. Pulihkan skill-nya dulu — modul di bawah skill yang `
        + 'diarsipkan tidak tampil di layar mana pun.',
    }),
    codeTaken: ({ level, code }: { level: TrainingLevel; code: string }) => ({
      en: `This office already has a training ${LEVEL[level].en} called ${code}. A code is never reused.`,
      id: `KPM ini sudah memiliki ${LEVEL[level].id} training dengan kode ${code}. Kode tidak pernah dipakai ulang.`,
    }),
    noActiveCategory: ({ code }: { code: string }) => ({
      en: `No active training category called ${code} in this office.`,
      id: `Tidak ada kategori training aktif dengan kode ${code} di KPM ini.`,
    }),
    noActiveSkill: ({ code }: { code: string }) => ({
      en: `No active training skill called ${code} in this office.`,
      id: `Tidak ada skill training aktif dengan kode ${code} di KPM ini.`,
    }),

    /* ---- a module's content (`training-content.ts`) and a template's levels (`training-payload.ts`) ---- */
    notAList: ({ key }: { key: string }) => ({
      en: `${key} must be a list.`,
      id: `${key} harus berupa daftar.`,
    }),
    sectionTooMany: ({ max, key, count }: { max: number; key: string; count: number }) => ({
      en: `A module holds at most ${max} ${key}; this one has ${count}.`,
      id: `Satu modul paling banyak berisi ${idNumber(max)} ${key}; modul ini berisi ${idNumber(count)}.`,
    }),
    itemNotObject: ({ item }: { item: ContentItem }) => ({
      en: `${itemAt(item).en} must be an object of fields.`,
      id: `${itemAt(item).id} harus berupa objek berisi kolom.`,
    }),
    /** One of an item's own fields refused, after its place: *File 2: label is required.* */
    atItem: ({ item, inner }: { item: ContentItem; inner: Sentence }) => ({
      en: (figures) => `${itemAt(item).en}: ${render(inner, { language: 'en', figures })}`,
      id: `${itemAt(item).id}: ${render(inner, readerIn('id'))}`,
    }),
    urlRequired: ({ item }: { item: ContentItem }) => ({
      en: `${itemAt(item).en}: url is required.`,
      id: `${itemAt(item).id}: url wajib diisi.`,
    }),
    notAWebAddress: ({ item, value }: { item: ContentItem; value: string }) => ({
      en: `${itemAt(item).en}: "${value}" is not a web address.`,
      id: `${itemAt(item).id}: "${value}" bukan alamat web.`,
    }),
    httpsOnly: ({ item, value }: { item: ContentItem; value: string }) => ({
      en: `${itemAt(item).en}: a link must start with https://. "${value}" would be blocked or warned about on `
        + 'an agent’s phone.',
      id: `${itemAt(item).id}: tautan harus diawali https://. "${value}" akan diblokir atau diberi peringatan di `
        + 'ponsel agent.',
    }),
    sharedId: {
      en: 'Two items in this module share an id.',
      id: 'Dua item di modul ini memakai ID yang sama.',
    },
    levelCodeTwice: ({ level, code }: { level: TrainingLevel; code: string }) => ({
      en: `The ${LEVEL[level].en} code ${code} is used twice.`,
      id: `Kode ${LEVEL[level].id} ${code} dipakai dua kali.`,
    }),
    /** A row the office's own checker refused, after its place in its level: *Skill 2: label is required.* */
    atLevel: ({ level, n, inner }: { level: TrainingLevel; n: number; inner: Sentence }) => ({
      en: (figures) => `${LEVEL[level].At.en} ${n}: ${render(inner, { language: 'en', figures })}`,
      id: `${LEVEL[level].At.id} ${n}: ${render(inner, readerIn('id'))}`,
    }),
    skillUnknownCategory: ({ code, categoryCode }: { code: string; categoryCode: string }) => ({
      en: `The skill ${code} names ${categoryCode}, which no category in this taxonomy is.`,
      id: `Skill ${code} menyebut ${categoryCode}, yang bukan kategori di taksonomi ini.`,
    }),
    moduleUnknownSkill: ({ code, skillCode }: { code: string; skillCode: string }) => ({
      en: `The module ${code} names ${skillCode}, which no skill in this taxonomy is.`,
      id: `Modul ${code} menyebut ${skillCode}, yang bukan skill di taksonomi ini.`,
    }),
  },
});
