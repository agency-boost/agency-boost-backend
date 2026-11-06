import { refusals } from '@/common/i18n/sentence';

/**
 * **The platform reads' refusals, in both languages** (P19.4-T3; ADR-0207): the query of *All members* and of the KPM
 * comparison. A field is named as the API names it (`q`, `sort`, `role`, `status`, `page`, `month`).
 */
export const PLATFORM_READS_REFUSALS = refusals('modules/reporting/platform', {
  VALIDATION_FAILED: {
    searchTooShort: {
      en: 'Type at least two characters of a name, a phone number or an email address.',
      id: 'Ketik minimal dua karakter nama, nomor telepon, atau alamat email.',
    },
    sortUnknown: ({ sorts }: { sorts: readonly string[] }) => ({
      en: `sort must be one of ${sorts.join(', ')}, or one of them after a minus sign for descending.`,
      id: `sort harus salah satu dari ${sorts.join(', ')}, atau salah satunya diawali tanda minus untuk urutan menurun.`,
    }),
    roleShape: {
      en: 'role must be ab, aab or agent',
      id: 'role harus ab, aab, atau agent',
    },
    statusShape: {
      en: 'status must be active, pending or removed',
      id: 'status harus active, pending, atau removed',
    },
    pageShape: {
      en: 'page must be a whole number from 1',
      id: 'page harus berupa bilangan bulat mulai dari 1',
    },
    monthShape: {
      en: 'month must be a month, YYYY-MM',
      id: 'month harus berupa bulan, dengan format YYYY-MM',
    },
    idShape: {
      en: 'companyId and kpmId must each be an id',
      id: 'companyId dan kpmId masing-masing harus berupa id',
    },
  },
});
