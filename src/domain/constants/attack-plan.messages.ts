import { messages } from '@/common/i18n/sentence';

/**
 * **The words the product drawer is sent, in both languages** (P18.98-T5 AC-4): written for the request's reader
 * where the drawer's answer is built (`ProductCatalogService`). *Run-off* stays the insurer's word; the shelf an
 * office sells from is its *etalase*.
 */
export const ATTACK_PLAN_MESSAGES = messages('domain/attack-plan', {
  /** The drawer's *Details* note for a product in run-off, verbatim (`Overall.html:10240`). */
  runOffNote: {
    en: 'In run-off — not actively issued to new applicants. Shown for reference only; not part of the current sales shelf.',
    id: 'Dalam masa run-off — tidak lagi diterbitkan untuk pemohon baru. Ditampilkan hanya sebagai referensi; bukan '
      + 'bagian dari etalase penjualan saat ini.',
  },
});
