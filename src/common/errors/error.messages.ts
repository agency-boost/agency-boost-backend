import { refusals } from '@/common/i18n/sentence';
import { RESOURCE_NAMES, type ResourceName } from './resources';

/**
 * **The refusals every module shares, and the error filter's own** (P18.10-T5 AC-2): the resource that is not found,
 * the permission that is missing, an office suspended or never joined, a record changed under the reader, and what the
 * filter says for a request it never let reach a service. The Indonesian is the approved glossary's §B.6 wherever it
 * holds the sentence.
 */
export const ERROR_REFUSALS = refusals('common/errors', {
  NOT_FOUND: {
    resource: ({ resource }: { resource: ResourceName }) => ({
      en: `${resource} not found.`,
      id: `${RESOURCE_NAMES[resource]} tidak ditemukan.`,
    }),
    /** Nest's own, for an address no controller answers: *Cannot GET /api/v1/…*. */
    framework: ({ english }: { english: string }) => ({
      en: english,
      id: 'Alamat yang diminta tidak ditemukan.',
    }),
  },
  PERM_DENIED: {
    noPermission: {
      en: 'You do not have permission to perform this action.',
      id: 'Anda tidak memiliki izin untuk melakukan tindakan ini.',
    },
    /** Nest's own, for a guard that answered `false`: *Forbidden resource*. */
    framework: ({ english }: { english: string }) => ({
      en: english,
      id: 'Anda tidak memiliki izin untuk melakukan tindakan ini.',
    }),
  },
  TENANT_SUSPENDED: {
    contactOwner: {
      en: 'This office is suspended. Contact your KPM Owner.',
      id: 'KPM ini ditangguhkan. Hubungi KPM Owner Anda.',
    },
  },
  TENANT_NO_MEMBERSHIP: {
    notJoined: {
      en: 'You have not joined a KPM yet. Register your office to continue.',
      id: 'Anda belum bergabung dengan KPM. Daftarkan KPM Anda untuk melanjutkan.',
    },
    /** The tenancy backstop, firing: a scoped query with no office to scope it to (`error.filter.ts`). */
    noOffice: {
      en: 'This request needs an office, and yours resolves to none.',
      id: 'Permintaan ini memerlukan KPM, dan Anda tidak tergabung di KPM mana pun.',
    },
  },
  VERSION_CONFLICT: {
    reload: {
      en: 'This record changed since you loaded it. Reload and try again.',
      id: 'Data ini berubah sejak Anda membukanya. Muat ulang, lalu coba lagi.',
    },
  },
  VALIDATION_FAILED: {
    /** Nest's own 400 — a body that is not JSON, a built-in pipe's refusal — in English as Nest wrote it. */
    framework: ({ english }: { english: string }) => ({
      en: english,
      id: 'Permintaan ini tidak valid.',
    }),
  },
  AUTH_TOKEN_INVALID: {
    /** Nest's own 401. */
    framework: ({ english }: { english: string }) => ({
      en: english,
      id: 'Masuk untuk melanjutkan.',
    }),
  },
  INTERNAL_ERROR: {
    unexpected: {
      en: 'Something went wrong. Quote the request id if you contact support.',
      id: 'Terjadi kesalahan. Sebutkan ID permintaan ini jika Anda menghubungi tim dukungan.',
    },
    /** Nest's own answer at a status the catalogue has no code for (a body too large for the parser, say). */
    framework: ({ english }: { english: string }) => ({
      en: english,
      id: 'Permintaan ini tidak dapat diproses.',
    }),
  },
});
