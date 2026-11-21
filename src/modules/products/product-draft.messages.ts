import { refusals } from '@/common/i18n/sentence';

/**
 * **A product's draft, refused in both languages** (P19.23-T4 AC-3; ADR-0278 §4): a draft with nothing in it, a *Juga
 * sesuai* naming a product the company does not have (or the product itself), and a discard with nothing to discard.
 */
export const PRODUCT_DRAFT_REFUSALS = refusals('modules/products/product-draft', {
  VALIDATION_FAILED: {
    emptyDraft: {
      en: 'Change at least one field before saving the draft.',
      id: 'Ubah minimal satu isian sebelum menyimpan draf.',
    },
    alsoFitsUnknown: ({ codes }: { codes: readonly string[] }) => ({
      en: `“Also fits” names ${codes.join(', ')}, which is not another product of this company.`,
      id: `“Juga sesuai” menyebut ${codes.join(', ')}, yang bukan produk lain perusahaan ini.`,
    }),
    noDraft: ({ name }: { name: string }) => ({
      en: `${name} has no draft to discard.`,
      id: `${name} tidak punya draf untuk dibuang.`,
    }),
  },
});
