import { formatDate, formatNumber } from '@/common/format/format';
import { readerIn } from '@/common/i18n/reader';
import { messages, refusals, render, type Sentence } from '@/common/i18n/sentence';
import { CODE_SENTENCE } from '@/common/validation/fields';
import {
  ACTIVATION_DATA_LINK_KINDS, ACTIVATION_FEATURE_LINKS, ACTIVATION_INDEPENDENT_CLOSINGS, ACTIVATION_LINK_KINDS,
  ACTIVATION_TRAINING_LINK, ACTIVATION_TRAINING_LINK_PREFIX, ACTIVATION_WEEKLY_CHECK_INS, type ActivationDataLink,
  type ActivationNamedLink, type Language,
} from '@/domain/constants';

/** A count in an Indonesian sentence: *1.000* — the same digits below a thousand. English keeps the number as it was. */
const n = (count: number) => formatNumber(count, undefined, 'id');

/** Where in a checklist a sentence is about: an aspect by its place in the list, or an item in it. */
export interface ChecklistPlace {
  readonly aspect: number;
  readonly item?: number;
}

/** *Aspect 2*, *Aspect 2, item 3* — *Aspek 2, item 3* (an *item* is §B.4's *Item*). */
const PLACE: Readonly<Record<Language, (at: ChecklistPlace) => string>> = {
  en: ({ aspect, item }) => (item === undefined ? `Aspect ${aspect}` : `Aspect ${aspect}, item ${item}`),
  id: ({ aspect, item }) => (item === undefined ? `Aspek ${aspect}` : `Aspek ${aspect}, item ${item}`),
};

/** The day a record of a data-backed tick names, as its two sentences name it. */
const RECORD_DAY = {
  closing: { en: 'record.date, the day it was paid and issued,', id: 'record.date, hari case ini dibayar dan diterbitkan,' },
  oneOnOne: { en: 'record.date, the day the 1:1 was held,', id: 'record.date, hari 1:1 diadakan,' },
} as const;

/**
 * **The activation module's refusals, in both languages** (P18.98-T5 AC-2, AC-3): the checklist an office writes and
 * publishes, a hire's ticks and the record a data-backed tick is saved with, graduation, a leader's corrections and
 * note, and *Mark left*. The Indonesian follows the approved glossary: *checklist*, *Activation*, *New hire*, *3M
 * activation*, *Case*, *Closing*, *1:1* and *Leader* stay English (§A.5, §A.6); a field is named as the API names it
 * (`record.date`, `autoLink`); the reader is *Anda*, a person *dia*.
 */
export const ACTIVATION_REFUSALS = refusals('modules/activation', {
  VALIDATION_FAILED: {
    /* ---- The checklist an office saves and publishes (`activation-input.ts`). */
    /** One of `Fields`' sentences, about a place in the checklist: `Aspect 1: label must be 1–80 characters.` */
    at: ({ where, inner }: { where: ChecklistPlace; inner: Sentence }) => ({
      en: (figures) => `${PLACE.en(where)}: ${render(inner, { language: 'en', figures })}`,
      id: `${PLACE.id(where)}: ${render(inner, readerIn('id'))}`,
    }),
    autoLinkNotText: ({ where }: { where: ChecklistPlace }) => ({
      en: `${PLACE.en(where)}: autoLink must be text, or null for a manual item.`,
      id: `${PLACE.id(where)}: autoLink harus berupa teks, atau null untuk item manual.`,
    }),
    trainingLinkCode: ({ where }: { where: ChecklistPlace }) => ({
      en: `${PLACE.en(where)}: a training link names a module code. ${render(CODE_SENTENCE, readerIn('en'))}`,
      id: `${PLACE.id(where)}: tautan training menyebut kode modul. ${render(CODE_SENTENCE, readerIn('id'))}`,
    }),
    dataLinkNotChosen: ({ where, link }: { where: ChecklistPlace; link: string }) => ({
      en: `${PLACE.en(where)}: ${link} is not chosen for an item. It belongs to the item whose code it is bound to, `
        + 'which reads it on its own.',
      id: `${PLACE.id(where)}: ${link} tidak dipilih untuk sebuah item. Tautan ini milik item yang kodenya terikat `
        + 'padanya, dan item itu membacanya sendiri.',
    }),
    unknownLink: ({ where, link }: { where: ChecklistPlace; link: string }) => ({
      en: `${PLACE.en(where)}: ${link} is not a link this product has. Use one of `
        + `${ACTIVATION_FEATURE_LINKS.join(', ')}, ${ACTIVATION_TRAINING_LINK_PREFIX}<module code>, `
        + 'or nothing at all for a manual item.',
      id: `${PLACE.id(where)}: ${link} bukan tautan yang dimiliki produk ini. Gunakan salah satu dari `
        + `${ACTIVATION_FEATURE_LINKS.join(', ')}, ${ACTIVATION_TRAINING_LINK_PREFIX}<kode modul>, `
        + 'atau kosongkan untuk item manual.',
    }),
    aspectsNotAList: {
      en: 'aspects must be a list.',
      id: 'aspects harus berupa daftar.',
    },
    aspectCount: ({ min, max, count }: { min: number; max: number; count: number }) => ({
      en: `A checklist has ${min}–${max} aspects; this one has ${count}.`,
      id: `Checklist memiliki ${n(min)}–${n(max)} aspek; checklist ini memiliki ${n(count)}.`,
    }),
    notAnObject: ({ where }: { where: ChecklistPlace }) => ({
      en: `${PLACE.en(where)} must be an object of fields.`,
      id: `${PLACE.id(where)} harus berupa objek berisi kolom.`,
    }),
    aspectCodeTwice: ({ code }: { code: string }) => ({
      en: `The aspect code ${code} is used twice.`,
      id: `Kode aspek ${code} dipakai dua kali.`,
    }),
    itemsNotAList: ({ where }: { where: ChecklistPlace }) => ({
      en: `${PLACE.en(where)}: items must be a list.`,
      id: `${PLACE.id(where)}: items harus berupa daftar.`,
    }),
    itemCount: ({ where, count, min, max }: { where: ChecklistPlace; count: number; min: number; max: number }) => ({
      en: `${PLACE.en(where)} has ${count} items; an aspect holds ${min}–${max}.`,
      id: `${PLACE.id(where)} memiliki ${n(count)} item; satu aspek berisi ${n(min)}–${n(max)} item.`,
    }),
    itemCodeTwice: ({ code }: { code: string }) => ({
      en: `The item code ${code} is used twice.`,
      id: `Kode item ${code} dipakai dua kali.`,
    }),

    /* ---- Publishing (`activation.service.ts`): Nest's `BadRequestException` before the phase, the same 400. */
    nothingToPublish: {
      en: 'There is nothing to publish. Change something first — a published version is immutable, '
        + 'because every hire records which one they started on.',
      id: 'Tidak ada yang dapat diterbitkan. Ubah sesuatu dulu — versi yang sudah diterbitkan tidak dapat diubah, '
        + 'karena setiap rekrut mencatat versi yang dia mulai.',
    },
    sameAsPublished: ({ version }: { version: number }) => ({
      en: `The draft is the same as version ${version}, so there is nothing to publish. Change `
        + 'something first — every hire records the version they started on.',
      id: `Draf ini sama dengan versi ${version}, jadi tidak ada yang dapat diterbitkan. Ubah `
        + 'sesuatu dulu — setiap rekrut mencatat versi yang dia mulai.',
    }),
    /** What opens the refusal of a link to a module nobody is offered; each module's own sentence follows it. */
    unwaitableModule: {
      en: 'A checklist item is linked to a training module it cannot wait for.',
      id: 'Sebuah item checklist ditautkan ke modul training yang tidak dapat ditunggunya.',
    },
    moduleMissing: ({ code }: { code: string }) => ({
      en: `${code} is not a training module in this office.`,
      id: `${code} bukan modul training di KPM ini.`,
    }),
    moduleArchived: ({ code }: { code: string }) => ({
      en: `${code} is archived, so no agent is offered it.`,
      id: `${code} diarsipkan, jadi tidak ditawarkan kepada agent mana pun.`,
    }),
    moduleDraft: ({ code }: { code: string }) => ({
      en: `${code} is a draft, so no agent is offered it. Publish the module first.`,
      id: `${code} masih draf, jadi tidak ditawarkan kepada agent mana pun. Terbitkan modul ini dulu.`,
    }),

    /* ---- A tick, and the record a data-backed one is saved with (`activation-records.service.ts`). */
    /** A day, as the service and the DTOs refuse one: `field` is the field's name, or class-validator's `$property`. */
    dayShape: ({ field }: { field: string }) => ({
      en: `${field} must be a day, written YYYY-MM-DD.`,
      id: `${field} harus berupa tanggal dengan format YYYY-MM-DD.`,
    }),
    recordNotTaken: ({ label }: { label: string }) => ({
      en: `record is for the items that complete from sales and coaching data, not for ${label}.`,
      id: `record hanya untuk item yang selesai dari data penjualan dan coaching, bukan untuk ${label}.`,
    }),
    recordKind: ({ kind, label }: { kind: string; label: string }) => ({
      en: `record.kind must be ${kind} for ${label}.`,
      id: `record.kind harus ${kind} untuk ${label}.`,
    }),
    closingEitherOr: {
      en: 'record names an existing closing by leadId, or a new one by name and date — not both.',
      id: 'record menyebut closing yang sudah ada dengan leadId, atau closing baru dengan name dan date — tidak keduanya.',
    },
    closingName: {
      en: 'record.name is who the case was sold to, and is required for a new closing.',
      id: 'record.name adalah nama orang yang membeli case ini, dan wajib diisi untuk closing baru.',
    },
    oneOnOneFields: {
      en: 'record for a 1:1 takes a date and a note only.',
      id: 'record untuk 1:1 hanya berisi tanggal dan catatan.',
    },
    oneOnOneNote: ({ max }: { max: number }) => ({
      en: `record.note is 1 to ${max} characters once trimmed.`,
      id: `record.note harus 1 sampai ${n(max)} karakter, tanpa spasi di awal dan akhir.`,
    }),
    recordDayShape: ({ what }: { what: keyof typeof RECORD_DAY }) => ({
      en: `${RECORD_DAY[what].en} is a date, written YYYY-MM-DD.`,
      id: `${RECORD_DAY[what].id} harus berupa tanggal dengan format YYYY-MM-DD.`,
    }),
    recordDayRange: ({ what, from, to }: { what: keyof typeof RECORD_DAY; from: string; to: string }) => ({
      en: (figures) => `${RECORD_DAY[what].en} is a day from the join date, ${formatDate(from, figures)}, to today, `
        + `${formatDate(to, figures)}.`,
      id: `${RECORD_DAY[what].id} harus berupa hari dari tanggal bergabung, ${formatDate(from, 'id')}, sampai hari ini, `
        + `${formatDate(to, 'id')}.`,
    }),

    /* ---- A leader's correction and note (`new-hires.service.ts`). */
    joinDateRange: ({ from, to, days }: { from: string; to: string; days: number }) => ({
      en: (figures) => `The join date must be a day from ${formatDate(from, figures)} to ${formatDate(to, figures)}: `
        + `no later than today, and no more than ${days} days before it.`,
      id: `Tanggal bergabung harus berupa hari dari ${formatDate(from, 'id')} sampai ${formatDate(to, 'id')}: `
        + `tidak setelah hari ini, dan tidak lebih dari ${n(days)} hari sebelumnya.`,
    }),
    coachingNote: ({ max }: { max: number }) => ({
      en: `text must be 1 to ${max} characters once trimmed.`,
      id: `text harus 1 sampai ${n(max)} karakter, tanpa spasi di awal dan akhir.`,
    }),
  },
  ACTIVATION_CLOSED: {
    // P18.96-T6 AC-5 (ADR-0173 §4): the checklist is complete — never *activation*, which is the 3M result.
    complete: {
      en: 'This checklist is complete. Nothing on it changes now.',
      id: 'Checklist ini sudah selesai. Tidak ada lagi yang dapat diubah.',
    },
    ended: {
      en: 'This activation has ended: its six months are over. It is kept as it was, and nothing on it changes now.',
      id: 'Activation ini telah berakhir: enam bulannya sudah lewat. Activation ini disimpan apa adanya, dan tidak ada '
        + 'lagi yang dapat diubah.',
    },
  },
  ACTIVATION_INCOMPLETE: {
    notDone: ({ left, total }: { left: number; total: number }) => ({
      en: `${left} of ${total} items are not done yet. The checklist is complete when every item is.`,
      id: `${n(left)} dari ${n(total)} item belum selesai. Checklist selesai jika semua item sudah selesai.`,
    }),
  },
  ACTIVATION_ITEM_AUTOMATIC: {
    /** `completesWhen`: the link kind's own words (`ACTIVATION_LINK_WORDS`), in the same reader's language. */
    onItsOwn: ({ completesWhen }: { completesWhen: Sentence }) => ({
      en: (figures) => `This item completes on its own, when ${render(completesWhen, { language: 'en', figures })}. `
        + 'Nobody ticks it by hand.',
      id: `Item ini selesai dengan sendirinya, saat ${render(completesWhen, readerIn('id'))}. `
        + 'Tidak ada yang mencentangnya secara manual.',
    }),
  },
  ACTIVATION_RECORD_REQUIRED: {
    closing: {
      en: 'This item is ticked with the case it names: choose one of the closings, or log a new one.',
      id: 'Item ini dicentang bersama case yang disebutkannya: pilih salah satu closing, atau catat closing baru.',
    },
    oneOnOne: {
      en: 'This item is ticked with the 1:1 it names: log it, with the day it was held and a note.',
      id: 'Item ini dicentang bersama 1:1 yang disebutkannya: catat 1:1 itu, dengan hari diadakannya dan catatannya.',
    },
  },
});

/**
 * **The activation module's other sentences** (P18.98-T5 AC-4, AC-6): what completes an item on its own and where a
 * data-backed item's source line says it came from — served with every read of a checklist, for the reader — and the
 * name a pecah telor's closing is logged under (D-26), in the language of whoever records it. Each English is the registry's own
 * (`activation-checklist.ts`), read from it, so the two cannot drift; the feature links' *Goal Settings*, *Leads
 * Management* and *Activity Management* are page names and stay English in both (§A.1, §A.2).
 */
export const ACTIVATION_MESSAGES = messages('modules/activation', {
  completesWhenGoals: {
    en: ACTIVATION_LINK_KINDS['feature:goals'].completesWhen,
    id: 'rekrut telah menyimpan goal apa pun sejak bergabung',
  },
  completesWhenLeads: {
    en: ACTIVATION_LINK_KINDS['feature:leads'].completesWhen,
    id: 'rekrut telah menambahkan setidaknya satu prospek',
  },
  completesWhenActivity: {
    en: ACTIVATION_LINK_KINDS['feature:activity'].completesWhen,
    id: 'rekrut telah mencatat aktivitas selama empat minggu berturut-turut',
  },
  completesWhenTraining: {
    en: ACTIVATION_TRAINING_LINK.completesWhen,
    id: 'rekrut telah menyelesaikan modul training tersebut',
  },
  completesWhenFirstSale: {
    en: ACTIVATION_DATA_LINK_KINDS['sales:first'].completesWhen,
    id: 'rekrut telah melakukan penjualan pertama sejak bergabung: sebuah sales lead yang dibayar dan diterbitkan, '
      + 'atau sebuah polis di file produksi',
  },
  completesWhenClosings: {
    en: ACTIVATION_DATA_LINK_KINDS['sales:closings:3'].completesWhen,
    id: `rekrut telah memiliki ${n(ACTIVATION_INDEPENDENT_CLOSINGS)} sales leads yang dibayar dan diterbitkan sejak bergabung`,
  },
  completesWhenCheckIns: {
    en: ACTIVATION_DATA_LINK_KINDS['coaching:weekly:4'].completesWhen,
    id: `${n(ACTIVATION_WEEKLY_CHECK_INS)} kali 1:1 dengan rekrut telah dicatat sebagai sesi coaching sejak bergabung`,
  },
  /** A data kind's source line, *"Completed from {label} · {date}"*. */
  salesDataLabel: {
    en: ACTIVATION_DATA_LINK_KINDS['sales:first'].label,
    id: 'Data penjualan',
  },
  coachingSessionsLabel: {
    en: ACTIVATION_DATA_LINK_KINDS['coaching:weekly:4'].label,
    id: 'Sesi coaching',
  },
  /**
   * **The name a pecah telor's closing is logged under** (UI V1, D-26, UI-027): *Kapan pecah telor?* takes a date and
   * nothing else, so the closing it logs in the hire's pipeline is named by the API — in the language of whoever
   * records it, and shown as stored, as every lead's name is.
   */
  pecahTelorClosing: {
    en: 'First sale (date recorded by hand)',
    id: 'Pecah telor (tanggal dicatat manual)',
  },
});

const SAY = ACTIVATION_MESSAGES;

/** What completes each named kind, and — for a data kind — its source line's label. */
const LINK_WORDS: Readonly<Record<ActivationNamedLink, { completesWhen: Sentence<null>; label?: Sentence<null> }>> = {
  'feature:goals': { completesWhen: SAY.completesWhenGoals },
  'feature:leads': { completesWhen: SAY.completesWhenLeads },
  'feature:activity': { completesWhen: SAY.completesWhenActivity },
  'sales:first': { completesWhen: SAY.completesWhenFirstSale, label: SAY.salesDataLabel },
  'sales:closings:3': { completesWhen: SAY.completesWhenClosings, label: SAY.salesDataLabel },
  'coaching:weekly:4': { completesWhen: SAY.completesWhenCheckIns, label: SAY.coachingSessionsLabel },
};

/**
 * **What completes an item on its own, as a sentence** (P18.98-T5): a link of a kind the registry declares — a
 * `training:<module code>` link reads the training kind's words. What the link view serves, written for its reader,
 * and what `ACTIVATION_ITEM_AUTOMATIC` says.
 */
export function completesWhenOf(link: string): Sentence<null> {
  return link.startsWith(ACTIVATION_TRAINING_LINK_PREFIX)
    ? SAY.completesWhenTraining
    : LINK_WORDS[link as ActivationNamedLink].completesWhen;
}

/** A data kind's source-line label, as a sentence (`Sales data`, `Coaching sessions`). */
export function dataLinkLabelOf(link: ActivationDataLink): Sentence<null> {
  return LINK_WORDS[link].label!;
}
