import { refusals } from '@/common/i18n/sentence';

/**
 * ***Pengumuman*'s refusals, in both languages** (P19.23-T6 AC-4; ADR-0279): a message that is empty or too long, a
 * *Pilih perusahaan / KPM* with nothing chosen, and an audience nobody is in.
 */
export const ANNOUNCEMENTS_REFUSALS = refusals('modules/announcements: refusals', {
  ANNOUNCEMENT_NO_RECIPIENTS: {
    nobody: {
      en: 'Nobody would receive this announcement: there is no active person in what you chose.',
      id: 'Tidak ada yang akan menerima pengumuman ini: tidak ada orang aktif pada pilihan Anda.',
    },
  },
  VALIDATION_FAILED: {
    message: {
      en: 'Write a message of at most 500 characters.',
      id: 'Tulis pesan paling banyak 500 karakter.',
    },
    audience: {
      en: 'audience must be owners, members or selected.',
      id: 'audience harus owners, members atau selected.',
    },
    chooseSome: {
      en: 'Choose at least one company or KPM.',
      id: 'Pilih minimal satu perusahaan atau KPM.',
    },
    ids: {
      en: 'Choose at most 100 companies and 100 KPMs, each by its id.',
      id: 'Pilih paling banyak 100 perusahaan dan 100 KPM, masing-masing dengan id-nya.',
    },
  },
});
