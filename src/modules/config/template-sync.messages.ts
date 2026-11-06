import { refusals } from '@/common/i18n/sentence';

/**
 * ***Sinkron dari template*, refused in both languages** (P19.6-T4, ADR-0220 §4): a KPM with no template to take names
 * from, and an apply whose preview is out of date — the template published again, or the KPM's training changed.
 */
export const TEMPLATE_SYNC_REFUSALS = refusals('modules/config/template-sync', {
  VALIDATION_FAILED: {
    noTemplate: {
      en: 'This KPM was not made from a template that has published its training, so there are no names to take.',
      id: 'KPM ini tidak dibuat dari template yang sudah menerbitkan training-nya, jadi tidak ada nama yang bisa diambil.',
    },
  },
  VERSION_CONFLICT: {
    templateMoved: {
      en: 'The template published again after you opened the list, and nothing was changed. '
        + 'Open Sinkron dari template again to see what would change now.',
      id: 'Template diterbitkan lagi setelah Anda membuka daftar ini, dan tidak ada yang diubah. '
        + 'Buka Sinkron dari template lagi untuk melihat apa yang akan berubah sekarang.',
    },
    trainingMoved: {
      en: 'This KPM’s training changed after you opened the list, and nothing was changed. '
        + 'Open Sinkron dari template again to see what would change now.',
      id: 'Training KPM ini berubah setelah Anda membuka daftar ini, dan tidak ada yang diubah. '
        + 'Buka Sinkron dari template lagi untuk melihat apa yang akan berubah sekarang.',
    },
  },
});
