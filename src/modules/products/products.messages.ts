import { formatNumber } from '@/common/format/format';
import { messages, refusals, type Sentence } from '@/common/i18n/sentence';
import {
  PRODUCT_BUDGET_BAND_LABELS, PRODUCT_DOCUMENT_SLOTS, PRODUCT_LUMP_SUM_BUDGET_BAND, type ProductDocumentSlot,
} from '@/domain/constants';

/** A count in an Indonesian sentence: grouped the Indonesian way once it reaches a thousand (*1.250*). */
const idCount = (n: number) => formatNumber(n, undefined, 'id');

/**
 * **The products module's refusals, in both languages** (P18.98-T5 AC-2, AC-3): the company's catalogue (Super Admin)
 * and the office's own settings over it — what it sells, its words, its scripts' approval. A field is named as the
 * API names it (`displayName`, `fullScript`), a product by the name the company gave it; *script* stays English
 * (§A.6) and the shelf an office sells from is its *etalase*.
 */
export const PRODUCTS_REFUSALS = refusals('modules/products', {
  VALIDATION_FAILED: {
    nothingToChange: {
      en: 'Nothing to change.',
      id: 'Tidak ada yang diubah.',
    },

    /* The office's settings over the company's catalogue (`KpmProductService`). */
    withdrawn: ({ name }: { name: string }) => ({
      en: `${name} has been withdrawn by your company, so it cannot be activated. `
        + 'Your company decides what is on the shelf; your office decides which of it you sell.',
      id: `${name} telah ditarik oleh perusahaan Anda, jadi tidak dapat diaktifkan. `
        + 'Perusahaan Anda menentukan apa yang ada di etalase; KPM Anda menentukan mana yang Anda jual.',
    }),
    companysFields: ({ fields, allowed }: { fields: readonly string[]; allowed: readonly string[] }) => ({
      en: `Your office cannot change ${fields.join(', ')} on a product — those belong to your `
        + `company. You may change: ${allowed.join(', ')}.`,
      id: `KPM Anda tidak dapat mengubah ${fields.join(', ')} pada produk — kolom itu milik perusahaan Anda. `
        + `Yang dapat Anda ubah: ${allowed.join(', ')}.`,
    }),
    notOverridable: ({ field }: { field: string }) => ({
      en: `${field} is not a field your office can change.`,
      id: `${field} bukan kolom yang dapat diubah KPM Anda.`,
    }),
    rejectionReason: {
      en: 'Say why you are sending it back. Somebody has to act on it, and "no" on its own is not '
        + 'something anybody can act on.',
      id: 'Jelaskan mengapa Anda mengembalikannya. Seseorang harus menindaklanjutinya, dan "tidak" saja bukan '
        + 'sesuatu yang dapat ditindaklanjuti.',
    },
    nothingPending: {
      en: 'There is nothing waiting on you for this product. A decision is made on a script that has '
        + 'been written and not yet approved.',
      id: 'Tidak ada yang menunggu keputusan Anda untuk produk ini. Keputusan dibuat atas script yang sudah '
        + 'ditulis dan belum disetujui.',
    },
    notASlot: ({ slot, slots }: { slot: string; slots: readonly string[] }) => ({
      en: `${slot} is not a document slot. A product has: ${slots.join(', ')}.`,
      id: `${slot} bukan slot dokumen. Produk memiliki: ${slots.join(', ')}.`,
    }),

    /* The company's catalogue (`ProductService`). */
    replacementNotOnShelf: {
      en: 'The product you named as its replacement is not on this company’s shelf.',
      id: 'Produk yang Anda sebut sebagai penggantinya tidak ada di etalase perusahaan ini.',
    },
    sendEveryProduct: ({ count }: { count: number }) => ({
      en: `Send every product of this company, once each — ${count} of them.`,
      id: `Kirim setiap produk perusahaan ini, masing-masing sekali — semuanya ${idCount(count)}.`,
    }),
    codeTaken: ({ code }: { code: string }) => ({
      en: `This company already has a product with the code ${code}. A code is never reused.`,
      id: `Perusahaan ini sudah memiliki produk dengan kode ${code}. Kode tidak pernah dipakai ulang.`,
    }),
    scheduleGaps: ({ years }: { years: readonly number[] }) => ({
      en: 'A commission schedule is a rate for each policy year from year 1, with no year missing and '
        + `none twice. This one has year ${years.join(', ')}.`,
      id: 'Jadwal komisi berisi satu persentase untuk setiap tahun polis mulai tahun 1, tanpa tahun yang terlewat '
        + `dan tanpa tahun yang ganda. Jadwal ini berisi tahun ${years.join(', ')}.`,
    }),
    /** The DTO's own sentence (`field`): how a product code may be typed. */
    productCodeShape: {
      en: 'A product code starts with a letter and holds letters, digits and underscores.',
      id: 'Kode produk diawali huruf dan berisi huruf, angka, dan garis bawah.',
    },
  },
});

/** A document slot's English, read from the registry so the two cannot drift. */
const SLOT = (key: ProductDocumentSlot) => PRODUCT_DOCUMENT_SLOTS.find((s) => s.key === key)!.label;

/**
 * **The products module's own words, in both languages** (P18.98-T7; ADR-0179 §7): what the API serves of the
 * registry (`domain/constants/product-catalog.ts`) as words — the three document slots' names, on the office's
 * *Products* settings and the catalog's drawer, and the one budget band that is a word, *Lump-sum* — written for the
 * request's reader. Each English is the registry's, byte for byte; the slot keys and band numbers do not change. A
 * file's own name, and everything the company typed about a product, is content and stays as typed (ADR-0179 §5).
 * *Lump-sum* is the approved *Sekaligus* (§B.10, field selling).
 */
export const PRODUCTS_MESSAGES = messages('modules/products', {
  brochureSlot: { en: SLOT('brochure'), id: 'Brosur' },
  illustrationSlot: { en: SLOT('illustration'), id: 'Ilustrasi / Simulasi' },
  productDocSlot: { en: SLOT('productDoc'), id: 'Dokumen produk' },
  lumpSumBand: { en: PRODUCT_BUDGET_BAND_LABELS[PRODUCT_LUMP_SUM_BUDGET_BAND], id: 'Sekaligus' },
});

const SLOT_WORDS: Readonly<Record<ProductDocumentSlot, Sentence<null>>> = {
  brochure: PRODUCTS_MESSAGES.brochureSlot,
  illustration: PRODUCTS_MESSAGES.illustrationSlot,
  productDoc: PRODUCTS_MESSAGES.productDocSlot,
};

/** A document slot's name, as a sentence. */
export function documentSlotLabel(key: ProductDocumentSlot): Sentence<null> {
  return SLOT_WORDS[key];
}

/**
 * **A budget band's label** (`PRODUCT_BUDGET_BAND_LABELS`), as a sentence where it is a word — *Lump-sum* — and `null`
 * where it is a range of sums, which reads the same in both (*Rp 500 rb–Rp 2 jt*, ADR-0167 §1).
 */
export function budgetBandWords(band: number): Sentence<null> | null {
  return band === PRODUCT_LUMP_SUM_BUDGET_BAND ? PRODUCTS_MESSAGES.lumpSumBand : null;
}
