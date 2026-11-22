import { refusals } from '@/common/i18n/sentence';

/**
 * ***Perusahaan baru*, refused in both languages** (P19.23-T4 AC-1; ADR-0278 §3): a copy of the Default template asked
 * for as a company, and a company copied that has no template to copy.
 */
export const COMPANY_SETUP_REFUSALS = refusals('modules/tenants/company-setup', {
  VALIDATION_FAILED: {
    defaultIsNotACompany: {
      en: 'The Default template is not a company to copy. Choose “Default template” instead.',
      id: 'Default template bukan perusahaan untuk disalin. Pilih “Default template” saja.',
    },
    nothingToCopy: ({ name }: { name: string }) => ({
      en: `${name} has no template to copy yet. Start from the Default template, or fill ${name}’s template first.`,
      id: `${name} belum punya template untuk disalin. Mulai dari Default template, atau isi template ${name} dulu.`,
    }),
  },
});
