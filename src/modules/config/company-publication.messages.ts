import { refusals } from '@/common/i18n/sentence';

const list = (items: readonly string[]) => items.join(', ');

/**
 * ***Terbitkan ke KPM*, refused in both languages** (P19.23-T4 AC-5; ADR-0278 §5–§7): nothing chosen, a change that is
 * not one any more, no KPM for a change that needs them, the Default template (which has no KPM), and a KPM's own
 * settings that would be overwritten without *"Saya paham pengaturan KPM ini akan ditimpa"*.
 */
export const COMPANY_PUBLICATION_REFUSALS = refusals('modules/config/company-publication', {
  VALIDATION_FAILED: {
    nothingChosen: {
      en: 'Choose at least one change to publish.',
      id: 'Pilih minimal satu perubahan untuk diterbitkan.',
    },
    unknownChange: ({ ids }: { ids: readonly string[] }) => ({
      en: `${list(ids)} is no longer a change waiting to be published. Read the page again.`,
      id: `${list(ids)} bukan lagi perubahan yang menunggu diterbitkan. Muat ulang halaman ini.`,
    }),
    noKpmChosen: {
      en: 'Choose at least one KPM: a new product and a settings change reach only the KPMs you choose.',
      id: 'Pilih minimal satu KPM: produk baru dan perubahan pengaturan hanya sampai ke KPM yang Anda pilih.',
    },
    defaultTemplateHasNoKpm: {
      en: 'The Default template has no KPM. Its changes reach a company when the company is created from it.',
      id: 'Default template tidak punya KPM. Perubahannya sampai ke perusahaan saat perusahaan dibuat darinya.',
    },
  },
  TEMPLATE_APPLY_UNCONFIRMED: {
    overwriteUnconfirmed: ({ names }: { names: readonly string[] }) => ({
      en: `${list(names)} changed these settings themselves, and publishing overwrites them. Tick “I understand this KPM’s settings will be overwritten” first.`,
      id: `${list(names)} sudah mengubah pengaturan ini sendiri, dan menerbitkan akan menimpanya. Centang “Saya paham pengaturan KPM ini akan ditimpa” terlebih dahulu.`,
    }),
  },
});
