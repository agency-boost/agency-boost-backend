import { refusals } from '@/common/i18n/sentence';

/**
 * **The audit read's refusals, in both languages** (P19.2-T2 AC-6; UI-132): the page's query — a cursor this read did
 * not write, a day that is not one, a range that ends before it starts, an action that is not an action's shape. A
 * field is named as the API names it (`cursor`, `from`, `to`, `action`).
 */
export const AUDIT_REFUSALS = refusals('modules/audit', {
  VALIDATION_FAILED: {
    cursorShape: {
      en: 'cursor must be the nextCursor a previous page returned',
      id: 'cursor harus berupa nextCursor yang dikembalikan halaman sebelumnya',
    },
    dateShape: {
      en: 'from and to must each be a day, YYYY-MM-DD',
      id: 'from dan to masing-masing harus berupa tanggal, dengan format YYYY-MM-DD',
    },
    rangeBackwards: {
      en: 'to must be on or after from',
      id: 'to harus sama dengan atau setelah from',
    },
    actionShape: {
      en: 'action must be an action’s name, such as company.created',
      id: 'action harus berupa nama tindakan, misalnya company.created',
    },
  },
});
