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

export abstract class StoragePort {
  /** A short-lived signed upload, so file bytes never transit the API. */
  abstract createSignedUpload(params: {
    kpmId: string;
    folder: string;
    filename: string;
    mimeType: string;
  }): Promise<SignedUpload>;

  /** A signed, expiring delivery URL. Assets are private; there are no public URLs. */
  abstract createSignedUrl(storageKey: string, ttlSeconds: number): Promise<string>;

  abstract remove(storageKey: string): Promise<void>;
}

/** Limits enforced before a signature is issued, not after the bytes arrive. */
export const ASSET_LIMITS = {
  MAX_BYTES: 25 * 1024 * 1024,
  ALLOWED_MIME_TYPES: [
    'image/jpeg', 'image/png', 'image/webp',
    'application/pdf',
    'video/mp4',
    'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ] as const,
  SIGNED_URL_TTL_SECONDS: 300,
} as const;
