/**
 * Storage is a port so the vendor is mockable and swappable. Tests never reach the
 * vendor; the adapter is stubbed at this boundary. Today's adapter is `GcsAdapter`
 * (ADR-0153), and `UnconfiguredStorage` stands in where no bucket is configured (D12).
 */
export interface SignedUpload {
  /** Where the browser **POSTs** the bytes, multipart: `file`, and every entry of `fields`. */
  readonly uploadUrl: string;
  readonly storageKey: string;
  /** Kept for the callers that read it; also one of `fields`. */
  readonly signature: string;
  readonly expiresAt: Date;
  /**
   * **The exact multipart fields the vendor needs beside `file`** (Phase 17): everything the signature
   * covers, the signature itself and whatever else the vendor asks for — so a browser appends each entry
   * and knows nothing about which vendor it is talking to. For Cloud Storage's V4 POST policy: `key`,
   * `Content-Type`, `policy`, `x-goog-algorithm`, `x-goog-credential`, `x-goog-date` and `x-goog-signature`,
   * with `file` sent last.
   */
  readonly fields: Readonly<Record<string, string>>;
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
  | { kind: 'company'; companyId: string }
  /**
   * **A person, not an office** (UI V1, UI-111): their profile photo, under `<env>/user/<userId>/…`. Identity is
   * global (ADR-0002), so the photo follows the person across offices and a person's erasure stays a folder operation.
   */
  | { kind: 'user'; userId: string };

/**
 * **The owner's folder in a key**: `<kpmId>`, `company/<companyId>` or `user/<userId>` (ADR-0032; UI-111). One
 * function, so the adapter and every stub of it name a folder the same way.
 */
export function ownerSegment(owner: AssetOwner): string {
  switch (owner.kind) {
    case 'kpm': return owner.kpmId;
    case 'company': return `company/${owner.companyId}`;
    case 'user': return `user/${owner.userId}`;
  }
}

export abstract class StoragePort {
  /**
   * A short-lived signed upload, so file bytes never transit the API. `allowedMimeTypes` is a route's
   * narrower list (a PDF-only route's), which the vendor is asked to enforce too where it can; absent, the
   * route keeps the whole allow-list, checked on confirm. `maxBytes` is a route's narrower ceiling (a profile
   * photo's, `AVATAR.MAX_BYTES`), which the vendor enforces on the bytes themselves; absent, `ASSET_LIMITS.MAX_BYTES`.
   */
  abstract createSignedUpload(params: {
    owner: AssetOwner;
    folder: string;
    filename: string;
    mimeType: string;
    allowedMimeTypes?: readonly string[];
    maxBytes?: number;
  }): Promise<SignedUpload>;

  /**
   * A signed, expiring delivery URL. Assets are private; there are no public URLs. `mimeType` is what the
   * registry recorded as stored (ADR-0040), so the vendor can be asked for the file as what it is — a PDF
   * as a PDF.
   */
  abstract createSignedUrl(storageKey: string, ttlSeconds: number, mimeType?: string): Promise<string>;

  /**
   * What storage actually holds under this key, or `null` if it holds nothing.
   *
   * The confirm step (ADR-0040): the browser uploads straight to the vendor, so the only
   * honest source for an object's real type and size is what storage holds. A client's
   * claim is a claim — and a vendor that only keeps the claim (Cloud Storage keeps the
   * form's `Content-Type`) has the type read from the stored bytes by its adapter
   * (`content-sniff.ts`, P18.7-T2), reporting `application/octet-stream` where they
   * disagree.
   */
  abstract describe(storageKey: string): Promise<StoredObject | null>;

  abstract remove(storageKey: string): Promise<void>;

  /**
   * **A second, independent copy of a stored object, under another owner's folder** (P13.2-T7,
   * ADR-0115 §6, ADR-0032 as amended).
   *
   * A template copied across an owner boundary — an office's own replacement material into a
   * company's template, or one company's material into another's — cannot reference the source's
   * file: an asset has one owner, and the company's file read would refuse the other. So the bytes
   * are duplicated, server side, into a key minted the way `createSignedUpload` mints one, and what
   * storage then holds under it is returned: the caller registers it as the destination's asset.
   *
   * Throws when the source holds nothing, or the vendor refuses: a copy that half-happened is not
   * reported as one that happened.
   */
  abstract copy(params: {
    storageKey: string;
    owner: AssetOwner;
    folder: string;
  }): Promise<StoredObject>;

  /**
   * **Bytes the server already holds, stored under a key named for them** (Phase 17, D-seed): the demo
   * seed's one-page demonstration PDFs, which no browser uploads. The key is minted as an upload's is —
   * `<owner>/<folder>/…` under the environment's prefix — but ends in `name` rather than a fresh id, so
   * the same file of the same owner is the same key on every run: **a key storage already holds is
   * described and returned, not sent again** (`sent: false`). What storage then holds is returned, so
   * the caller registers what landed rather than what it sent (ADR-0040).
   */
  abstract putObject(params: {
    owner: AssetOwner;
    folder: string;
    name: string;
    mimeType: string;
    body: Buffer;
  }): Promise<StoredObject & { sent: boolean }>;
}
