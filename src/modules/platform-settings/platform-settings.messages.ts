import { refusals } from '@/common/i18n/sentence';

/** ***Pengaturan platform*'s refusals** (P19.23-T6 AC-3; ADR-0279): a WhatsApp number that is not one. */
export const PLATFORM_SETTINGS_REFUSALS = refusals('modules/platform-settings: refusals', {
  VALIDATION_FAILED: {
    whatsapp: {
      en: 'Enter an Indonesian WhatsApp number, such as 0811 2000 300, or leave it empty.',
      id: 'Masukkan nomor WhatsApp Indonesia, misalnya 0811 2000 300, atau kosongkan.',
    },
  },
});
