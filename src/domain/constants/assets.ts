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
   * The whole vocabulary, and `modules/assets/content-sniff.ts` holds a byte signature for exactly
   * this list (P18.7-T2) — a type with none, or bytes that contradict the claim, confirm as
   * `application/octet-stream` and are refused.
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

/**
 * **A person's profile photo** (UI V1, UI-111; `metrics-and-definitions.md` §B.9): the square the screen crops it to
 * and saves as a JPEG, the narrower ceiling and type its upload is held to — inside `ASSET_LIMITS`, never beside them
 * — and how long the signed link every read draws it through lives.
 *
 * **The bucket stays private** (ADR-0153): `users.avatarUrl` holds the photo's storage key, and a read signs a link to
 * it (`AvatarLinks`). A link lives `URL_TTL_SECONDS` and is reused until `URL_RENEW_SECONDS` before its end, so a
 * roster of thirty people asks storage for at most thirty signatures in half a day, and a browser keeps the picture
 * it already holds under the same address.
 */
export const AVATAR = {
  /** 256 × 256 px: the crop *Simpan foto* sends (the report's *e.g. 256×256 JPEG*). */
  SIDE_PX: 256,
  /** 512 KB. A 256px JPEG is 15 to 60 KB; anything larger is not one. Inside `ASSET_LIMITS.MAX_BYTES`. */
  MAX_BYTES: 512 * 1024,
  /** The crop is always a JPEG; its bytes are sniffed at confirm as every upload's are (ADR-0040). */
  MIME_TYPES: ['image/jpeg'] as const,
  /** 12 hours: a signed link to a photo. Longer than a document's 300 s, because an avatar is drawn, not opened. */
  URL_TTL_SECONDS: 12 * 60 * 60,
  /** 1 hour: a cached link this close to its end is signed again, so no page draws one that dies on it. */
  URL_RENEW_SECONDS: 60 * 60,
  /**
   * 20 upload forms per account per `UPLOAD_WINDOW_SECONDS` (the Phase 18.99 exit review, L5), counted whether or not
   * the claim passes, past which `POST /auth/me/avatar/upload` is `429 AUTH_RATE_LIMITED`. A person changes their photo
   * a few times and retries a failed crop; twenty is far above that, and far below what filling storage with objects
   * nobody attaches would take — the runtime signer cannot delete (ADR-0153), so every form signed may leave one.
   */
  UPLOADS_PER_WINDOW: 20,
  /** 1 hour: the window `UPLOADS_PER_WINDOW` counts over. */
  UPLOAD_WINDOW_SECONDS: 60 * 60,
} as const;
