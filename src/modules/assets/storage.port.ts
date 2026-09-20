/**
 * Storage is a port so the vendor is mockable and swappable. Tests never reach
 * Cloudinary; the adapter is stubbed at this boundary.
 */
export interface SignedUpload {
  readonly uploadUrl: string;
  readonly storageKey: string;
  readonly signature: string;
  readonly expiresAt: Date;
}

export interface StoredObject {
  readonly storageKey: string;
  readonly mimeType: string;
  readonly bytes: number;
}

/**
 * Who a file belongs to, which decides the folder it lands in (ADR-0032).
 *
 * An office's upload is `<env>/<kpmId>/…` and the company's shared material is
 * `<env>/company/<companyId>/…`, so per-office erasure and per-company accounting both stay
 * folder operations rather than queries.
 */
export type AssetOwner =
  | { kind: 'kpm'; kpmId: string }
  | { kind: 'company'; companyId: string };

export abstract class StoragePort {
  /** A short-lived signed upload, so file bytes never transit the API. */
  abstract createSignedUpload(params: {
    owner: AssetOwner;
    folder: string;
    filename: string;
    mimeType: string;
  }): Promise<SignedUpload>;

  /** A signed, expiring delivery URL. Assets are private; there are no public URLs. */
  abstract createSignedUrl(storageKey: string, ttlSeconds: number): Promise<string>;

  /**
   * What storage actually holds under this key, or `null` if it holds nothing.
   *
   * The confirm step (ADR-0040): the browser uploads straight to the vendor, so the only
   * honest source for an object's real type and size is the vendor itself. A client's
   * claim is a claim.
   */
  abstract describe(storageKey: string): Promise<StoredObject | null>;

  abstract remove(storageKey: string): Promise<void>;
}


/**
 * A vendor's file extension back to the media type this product speaks (ADR-0040).
 *
 * The browser uploads straight to Cloudinary, which reports a `format` — `jpg`, `pdf`, `xlsx` —
 * rather than a media type. Confirming means turning that back into one, and this map covers
 * exactly `ALLOWED_MIME_TYPES` and nothing else: a format missing from here confirms as its own
 * raw string, which then fails the allow-list, so an unrecognised upload is refused rather than
 * waved through as something it is not.
 */
export const FORMAT_TO_MIME_TYPE: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
