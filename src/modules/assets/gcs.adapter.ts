import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage, type Bucket, type File } from '@google-cloud/storage';
import { ulid } from 'ulid';
import { Clock } from '@/common/clock/clock.port';
import { ASSET_LIMITS } from '@/domain/constants';
import { SNIFF_SAMPLE_BYTES, sniffedContentType } from './content-sniff';
import { AssetOwner, ownerSegment, SignedUpload, StoragePort, StoredObject } from './storage.port';

/** How long a signed upload form stays usable: the browser posts it at once. */
const UPLOAD_TTL_MS = 10 * 60 * 1000;

/**
 * **The SDK's own clock, and the one place this product reads the process's time on purpose** (P18.7-T2, the
 * contract's documented exception to the clock port). The SDK stamps `x-goog-date` from `Date.now()` and refuses
 * an `expires` it judges to be in the past by the same clock, so a signature's lifetime has to be measured from
 * that clock too — a fixed or offset `Clock` would sign a form that is born expired, or that outlives its
 * `expiresAt`. In production both clocks are the system's and agree; what the API *reports* (`expiresAt`) still
 * comes from the injected `Clock`.
 */
const sdkNow = (): number => Date.now();

/**
 * Types a browser may show in the tab rather than save: what a pitch PDF, a poster and a training video are for.
 * **Everything else is an attachment** — a spreadsheet, a CSV, and any type nobody recorded — so storage never
 * renders a file inline that this product did not decide it can.
 */
const INLINE_TYPES: ReadonlySet<string> = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'video/mp4',
]);

/** The extension a downloaded attachment is saved with, since a key carries none (`<…>/<ulid>`). */
const ATTACHMENT_EXTENSION: Readonly<Record<string, string>> = {
  'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};

/**
 * **What the vendor said, and nothing else it carried** (P18.7-T2). A Cloud Storage `ApiError` keeps the HTTP
 * status in `code`; a transport or auth failure (gaxios) keeps it in `status` or `response.status`, and also keeps
 * the request it made, **`Authorization` header included**. So the original is never passed on: only a status
 * and a message leave this file, as a plain `Error`. Exported for the demo seed, which reports a refusal in a line.
 */
export function storageRefusal(err: unknown): { httpCode: number | undefined; message: string } {
  const e = (err ?? {}) as { code?: unknown; status?: unknown; response?: { status?: unknown }; message?: unknown };
  const httpCode = [e.code, e.status, e.response?.status].find((v): v is number => typeof v === 'number');
  return { httpCode, message: typeof e.message === 'string' && e.message ? e.message : 'no message' };
}

const refused = (what: string, err: unknown): Error => {
  const refusal = storageRefusal(err);
  return new Error(`Storage refused ${what} (${refusal.httpCode ?? 'no status'}): ${refusal.message}`);
};

/**
 * **Google Cloud Storage, foldered per environment and per owner** (P18.7-T2, ADR-0153, replacing Cloudinary).
 *
 * `<STORAGE_KEY_PREFIX>/<kpmId | company/<companyId>>/<folder>/<ulid>` — the key shape Cloudinary's public ids
 * had, so every key already registered reads the same. One private bucket per environment, uniform access, no
 * public object: every read is a signed V4 link and every browser write a signed V4 POST policy.
 *
 * **The runtime signer can create and read, never replace or delete** (`roles/storage.objectCreator` +
 * `roles/storage.objectViewer` on the bucket). Overwriting an object needs `storage.objects.delete`, so a replayed
 * upload form is refused by storage itself (403), and every server-side write here also asks
 * `ifGenerationMatch: 0` — "only if nothing is there". Signing goes through IAM `signBlob` on the signer's own
 * account (`roles/iam.serviceAccountTokenCreator` on itself); the VM holds no key file.
 */
@Injectable()
export class GcsAdapter extends StoragePort {
  private readonly bucket: Bucket;

  constructor(
    private readonly config: ConfigService,
    private readonly clock: Clock,
  ) {
    super();
    // Application Default Credentials: the VM's service account in staging and production, a developer's
    // `gcloud auth application-default login --impersonate-service-account=…` locally. Nothing is dialled here.
    // Trimmed: a blank value falls through `ConfigService.get` to the raw environment (see `storage.provider.ts`).
    const projectId = this.config.get<string>('GCS_PROJECT_ID')?.trim();
    this.bucket = new Storage(projectId ? { projectId } : {}).bucket(this.config.getOrThrow<string>('GCS_BUCKET').trim());
  }

  /**
   * `<prefix>/<owner>/<folder>/<leaf>`. The owner segment is `<kpmId>`, `company/<companyId>` (ADR-0032) or, for a
   * person's profile photo, `user/<userId>` (UI-111): the
   * literal `company` keeps a company's material apart from any office's, so per-office erasure stays a prefix
   * operation that cannot take the company's files with it.
   */
  private key(owner: AssetOwner, folder: string, leaf: string): string {
    // A person's own (UI-111) is the literal `user`, as `company` keeps a company's material apart from any office's.
    const ownerFolder = ownerSegment(owner);
    return `${this.config.getOrThrow<string>('STORAGE_KEY_PREFIX')}/${ownerFolder}/${folder}/${leaf}`;
  }

  /**
   * **A V4 POST policy the browser submits straight to the bucket** (ADR-0032), multipart: every entry of `fields`
   * first and `file` last, as storage requires. Storage answers `204` with no body.
   *
   * What the policy pins, so storage itself refuses anything else:
   * - **`key`**: one fresh ULID key. A replay names an existing object, which the create-only signer cannot
   *   replace (403).
   * - **`Content-Type`**: exactly `mimeType`, which the service has already checked against the route's list —
   *   so a route's narrower `allowedMimeTypes` (a PDF-only route) needs nothing further here. It pins the *claim*
   *   only: at confirm the type is read from the bytes (`describe`), and the route's list is checked against that.
   * - **`content-length-range` 1 .. 25 MB** (`ASSET_LIMITS.MAX_BYTES`), or 1 .. the route's own `maxBytes` (a profile
   *   photo's 512 KB, `AVATAR.MAX_BYTES`): an empty or oversized file never lands.
   * - Nothing else: a form field the policy does not name is refused, so the browser cannot add metadata.
   */
  async createSignedUpload(params: {
    owner: AssetOwner;
    folder: string;
    filename: string;
    mimeType: string;
    allowedMimeTypes?: readonly string[];
    maxBytes?: number;
  }): Promise<SignedUpload> {
    const storageKey = this.key(params.owner, params.folder, ulid());
    const [policy] = await this.bucket.file(storageKey).generateSignedPostPolicyV4({
      // The SDK's clock, not the injected one (see `sdkNow`).
      expires: sdkNow() + UPLOAD_TTL_MS,
      conditions: [['content-length-range', 1, params.maxBytes ?? ASSET_LIMITS.MAX_BYTES]],
      fields: { 'Content-Type': params.mimeType },
    }).catch((err: unknown) => {
      throw refused('to sign the upload', err);
    });
    return {
      uploadUrl: policy.url,
      storageKey,
      signature: policy.fields['x-goog-signature'],
      expiresAt: new Date(this.clock.now().getTime() + UPLOAD_TTL_MS),
      fields: { ...policy.fields },
    };
  }

  /**
   * **A V4 signed read link, valid `ttlSeconds`** (300 by default, `ASSET_LIMITS.SIGNED_URL_TTL_SECONDS`), served
   * as the type the registry recorded at confirm (ADR-0040): `response-content-type` is the confirmed type — the
   * one the bytes are (`content-sniff.ts`) — and storage sends it in place of the object's own `Content-Type`.
   *
   * **The object's stored `Content-Type` is the upload form's claim, and no read depends on it.** A PNG uploaded
   * as `image/jpeg` keeps `image/jpeg` in its metadata (the policy pinned that), is confirmed as `image/png`, and is
   * served as `image/png` by every link, because both callers (`AssetService.urlFor` and `companyUrlFor`) pass the
   * recorded type. Only a link with no recorded type would fall back to the claim, and that one is an attachment,
   * never rendered.
   *
   * A PDF, an image or a video opens `inline`; a spreadsheet, a CSV and any type not recorded download as an
   * `attachment`, named with their extension because a key has none.
   */
  async createSignedUrl(
    storageKey: string,
    ttlSeconds: number = ASSET_LIMITS.SIGNED_URL_TTL_SECONDS,
    mimeType?: string,
  ): Promise<string> {
    const recorded = mimeType ?? '';
    const extension = ATTACHMENT_EXTENSION[recorded];
    const leaf = storageKey.slice(storageKey.lastIndexOf('/') + 1);
    const disposition = INLINE_TYPES.has(recorded) ? 'inline'
      : extension ? `attachment; filename="${leaf}.${extension}"` : 'attachment';
    const [url] = await this.bucket.file(storageKey).getSignedUrl({
      version: 'v4',
      action: 'read',
      // The SDK's clock, not the injected one (see `sdkNow`).
      expires: sdkNow() + ttlSeconds * 1000,
      // No recorded type: storage serves the object's own metadata, as an attachment.
      ...(recorded ? { responseType: recorded } : {}),
      responseDisposition: disposition,
    }).catch((err: unknown) => {
      throw refused('to sign the link', err);
    });
    return url;
  }

  /**
   * **What the bucket holds under this key, or `null` if nothing** (ADR-0040's confirm step).
   *
   * `bytes` is the object's `size`. The type is **what its first 4 KB are** (`content-sniff.ts`), whatever the
   * form claimed — storage keeps only the claim. An accepted type is reported as itself (a PNG claimed as a JPEG is
   * `image/png`), and the asset service's per-route list decides whether it may stay; bytes that are no accepted
   * type are `application/octet-stream`, which every list refuses. A 404 is "nothing there"; any
   * other failure — a revoked credential, a missing permission — throws, because reporting it as "never
   * arrived" would tell somebody to upload again for ever.
   */
  async describe(storageKey: string): Promise<StoredObject | null> {
    const file = this.bucket.file(storageKey);
    let metadata: { size?: string | number; contentType?: string };
    try {
      [metadata] = await file.getMetadata();
    } catch (err) {
      if (storageRefusal(err).httpCode === 404) return null;
      throw refused('the lookup', err);
    }
    const bytes = Number(metadata.size ?? 0);
    const sample = bytes > 0 ? await this.head(file) : Buffer.alloc(0);
    return { storageKey, mimeType: sniffedContentType(String(metadata.contentType ?? ''), sample), bytes };
  }

  /** The object's first `SNIFF_SAMPLE_BYTES` (a range read: the rest is never fetched). */
  private async head(file: File): Promise<Buffer> {
    const [sample] = await file.download({ start: 0, end: SNIFF_SAMPLE_BYTES - 1 }).catch((err: unknown) => {
      throw refused('the read', err);
    });
    return sample;
  }

  /**
   * **A server-side copy into another owner's folder** (P13.2-T7, ADR-0115 §6): the bytes never leave the bucket,
   * into a key minted as an upload's is, `ifGenerationMatch: 0` so it can only create. Then the copy is
   * described — sniffed as any upload is — and that is what the caller registers. A source that holds nothing
   * throws rather than producing an empty copy; so does any refusal.
   */
  async copy(params: { storageKey: string; owner: AssetOwner; folder: string }): Promise<StoredObject> {
    const destination = this.key(params.owner, params.folder, ulid());
    await this.bucket.file(params.storageKey).copy(this.bucket.file(destination), {
      preconditionOpts: { ifGenerationMatch: 0 },
    }).catch((err: unknown) => {
      if (storageRefusal(err).httpCode === 404) {
        throw new Error(`Storage holds nothing under ${params.storageKey}, so it cannot be copied.`);
      }
      throw refused('the copy', err);
    });
    const copied = await this.describe(destination);
    if (!copied) throw new Error(`Storage reported the copy to ${destination} and then held nothing there.`);
    return copied;
  }

  /**
   * **A server-held file under `<prefix>/<owner>/<folder>/<name>`** (Phase 17, D-seed). Described first: a key the
   * bucket already holds is returned as it is, `sent: false`, so a re-seed sends nothing. Otherwise one
   * non-resumable write with `ifGenerationMatch: 0`; a `412` means somebody wrote it in between, and what is
   * there is returned, `sent: false`. What the bucket then holds — sniffed — is what is returned.
   */
  async putObject(params: {
    owner: AssetOwner; folder: string; name: string; mimeType: string; body: Buffer;
  }): Promise<StoredObject & { sent: boolean }> {
    const storageKey = this.key(params.owner, params.folder, params.name);
    const held = await this.describe(storageKey);
    if (held) return { ...held, sent: false };
    let sent = true;
    try {
      await this.bucket.file(storageKey).save(params.body, {
        contentType: params.mimeType,
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    } catch (err) {
      if (storageRefusal(err).httpCode !== 412) throw refused('the write', err);
      sent = false;
    }
    const stored = await this.describe(storageKey);
    if (!stored) throw new Error(`Storage accepted ${storageKey} and then held nothing there.`);
    return { ...stored, sent };
  }

  /**
   * Delete one object; one already gone is not an error. **Nothing calls this at runtime**, and in staging and
   * production it is refused (403): the runtime signer is create-only by design (ADR-0153). Erasure, and the
   * identity allowed to perform it, belong to P19-T1.
   */
  async remove(storageKey: string): Promise<void> {
    await this.bucket.file(storageKey).delete({ ignoreNotFound: true }).catch((err: unknown) => {
      throw refused('the delete', err);
    });
  }
}
