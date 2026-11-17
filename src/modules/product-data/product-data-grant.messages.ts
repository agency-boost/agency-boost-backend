import { refusals } from '@/common/i18n/sentence';

/**
 * ***Kelola data produk*'s refusals, in both languages** (ADR-0260; P19.15-T4 AC-2). *Kelola data produk* is the
 * access's own name, Indonesian in both (the glossary's *Proposal* section, *Manage product data*): the English sentence
 * names it so the Super Admin recognises the switch.
 */
export const PRODUCT_DATA_GRANT_REFUSALS = refusals('modules/product-data grants', {
  PRODUCT_DATA_GRANT_NOT_ELIGIBLE: {
    notOwnerOrAdmin: {
      en: 'Only a KPM Owner or a KPM Admin can be given access to manage product data. This person is neither now.',
      id: 'Kelola data produk hanya bisa diberikan kepada KPM Owner atau KPM Admin. Orang ini sekarang bukan keduanya.',
    },
  },
  VALIDATION_FAILED: {
    companiesRequired: {
      en: 'Tick at least one insurer company. To take the access away, remove it instead.',
      id: 'Centang minimal satu perusahaan asuransi. Untuk mencabut aksesnya, hapus aksesnya.',
    },
    cursorShape: {
      en: 'cursor is not one this list gave. Start again from the first page.',
      id: 'cursor bukan dari daftar ini. Mulai lagi dari halaman pertama.',
    },
    notAnInsurer: ({ companyId }: { companyId: string }) => ({
      en: `${companyId} is not an insurer company on AgencyBoost.`,
      id: `${companyId} bukan perusahaan asuransi di AgencyBoost.`,
    }),
  },
});
