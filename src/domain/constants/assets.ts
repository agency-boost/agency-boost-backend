/**
 * What this product accepts as an uploaded file (ADR-0032, ADR-0040).
 *
 * **Checked before a signature is issued, never after the bytes arrive.** The browser uploads
 * straight to the vendor, so refusing afterwards spends somebody's data allowance to say no —
 * and on a mid-range Android over 4G, which is this product's performance budget, that is the
 * difference between a rejection and a wasted morning.
 *
 * These lived in `modules/assets/storage.port.ts` until the Phase 5 exit review: thresholds in a
 * module file, invisible to `metrics-and-definitions.md`, against `backend/CLAUDE.md`'s own rule
 * that `domain/constants/` is "the single source for every threshold — never re-declare one".
 * Nothing had re-declared them yet; the point of moving them is that nothing now can without
 * somebody noticing.
 */
export const ASSET_LIMITS = {
  /** 25 MB. Anything larger is a link, not an upload (ADR-0032). */
  MAX_BYTES: 25 * 1024 * 1024,
  /**
   * The whole vocabulary, and `cloudinary.adapter.ts`'s format map covers exactly this list —
   * a format missing from there confirms as its own extension and is refused.
   */
  ALLOWED_MIME_TYPES: [
    'image/jpeg', 'image/png', 'image/webp',
    'application/pdf',
    'video/mp4',
    'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ] as const,
  /** 300 seconds. Nothing in storage is publicly readable, so every read is a signed, expiring URL. */
  SIGNED_URL_TTL_SECONDS: 300,
} as const;

/**
 * **A document somebody opens for a customer or a candidate: a PDF, and nothing else** (Phase 17, D-slots,
 * P17-T9). The office's recruitment pitch documents and its own product documents are uploaded under this
 * narrower list, checked before a signature is issued and again against what storage reports (ADR-0040);
 * every other upload keeps `ALLOWED_MIME_TYPES`.
 */
export const DOCUMENT_MIME_TYPES = ['application/pdf'] as const;
