import { refusals } from '@/common/i18n/sentence';

/**
 * **The platform reads' refusals, in both languages** (P19.4-T3; ADR-0207): the query of *All members* (*Anggota* since
 * P19.23-T3) and of *Akun terdaftar* (P19.12-T2). A field is named as the API names it (`q`, `role`, `status`, `kpm`,
 * `page`, `month`). The KPM comparison's `sort` went with it (P19.23; ADR-0277).
 */
export const PLATFORM_READS_REFUSALS = refusals('modules/reporting/platform', {
  VALIDATION_FAILED: {
    searchTooShort: {
      en: 'Type at least two characters of a name, a phone number or an email address.',
      id: 'Ketik minimal dua karakter nama, nomor telepon, atau alamat email.',
    },
    /** P19.12-T2 (ADR-0245 §1): *Akun terdaftar* searches a name or an email, never a phone. */
    accountSearchTooShort: {
      en: 'Type at least two characters of a name or an email address.',
      id: 'Ketik minimal dua karakter nama atau alamat email.',
    },
    kpmShape: {
      en: 'kpm must be none or some',
      id: 'kpm harus none atau some',
    },
    roleShape: {
      en: 'role must be ab, aab or agent',
      id: 'role harus ab, aab, atau agent',
    },
    statusShape: {
      en: 'status must be active, pending or removed',
      id: 'status harus active, pending, atau removed',
    },
    /** P19.23-T3 (OD-421): *Anggota*'s *Akun tes*. */
    testAccountShape: {
      en: 'testAccount must be only',
      id: 'testAccount harus only',
    },
    /** P19.23-T3 (ADR-0267 §1): the test-account switch's body. */
    testAccountValue: {
      en: 'testAccount must be true or false',
      id: 'testAccount harus true atau false',
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
