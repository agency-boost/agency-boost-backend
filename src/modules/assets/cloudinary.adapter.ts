import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { ulid } from 'ulid';
import { Clock } from '@/common/clock/clock.port';
import { ASSET_LIMITS } from '@/domain/constants';
import {
  AssetOwner, FORMAT_TO_MIME_TYPE, SignedUpload, StoragePort, StoredObject,
} from './storage.port';

/**
 * **Every object is `authenticated`** (Phase 17): uploaded as one, looked up as one, and delivered only
 * through a signed, expiring link. The upload, the lookups and the link used to disagree — the browser's
 * upload set no type, so a file landed as public `upload`, while the link asked for `authenticated` — and
 * now all three say the same thing.
 */
const DELIVERY_TYPE = 'authenticated';

/** How long the link a copy's source is fetched through lasts: Cloudinary fetches it at once. */
const COPY_SOURCE_TTL_SECONDS = 300;

/**
 * A stored media type back to Cloudinary's resource type and format, for the link (the reverse of
 * `FORMAT_TO_MIME_TYPE`). **A PDF is an `image` resource in Cloudinary**, and is asked for as format `pdf`;
 * a spreadsheet is `raw`, whose format is part of nothing the key says, so none is named.
 */
const DELIVERY_OF: Readonly<Record<string, { resourceType: 'image' | 'video' | 'raw'; format?: string }>> = {
  'image/jpeg': { resourceType: 'image', format: 'jpg' },
  'image/png': { resourceType: 'image', format: 'png' },
  'image/webp': { resourceType: 'image', format: 'webp' },
  'application/pdf': { resourceType: 'image', format: 'pdf' },
  'video/mp4': { resourceType: 'video', format: 'mp4' },
  'text/csv': { resourceType: 'raw' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { resourceType: 'raw' },
};

/**
 * **What the vendor said, from either of the shapes it says it in** (Phase 17, found seeding against a real
 * account). The Admin API (`api.resource`) rejects with `{ error: { message, http_code }, request_options,
 * … }` — the status one level down — and the uploader with `{ message, http_code }`. Reading only the flat
 * shape took every Admin API 404 for a real failure, so `describe` threw where it should have answered
 * "nothing there". The original is never passed on: its `request_options` can carry the credentials.
 */
export function vendorRefusal(err: unknown): { httpCode: number | undefined; message: string } {
  const flat = (err ?? {}) as { http_code?: number; message?: unknown; error?: { http_code?: number; message?: unknown } };
  const httpCode = flat.http_code ?? flat.error?.http_code;
  const message = flat.error?.message ?? flat.message;
  return { httpCode, message: typeof message === 'string' ? message : 'no message' };
}

/**
 * Cloudinary, foldered per environment and per tenant.
 *
 * `<prefix>/<kpmId>/<folder>/<ulid>` — the environment prefix keeps dev uploads out of
 * production's storage accounting, and the tenant segment makes per-KPM usage and
 * bulk erasure a folder operation rather than a query.
 */
@Injectable()
export class CloudinaryAdapter extends StoragePort {
  constructor(
    private readonly config: ConfigService,
    private readonly clock: Clock,
  ) {
    super();
    cloudinary.config({
      cloud_name: this.config.getOrThrow<string>('CLOUDINARY_CLOUD_NAME'),
      api_key: this.config.getOrThrow<string>('CLOUDINARY_API_KEY'),
      api_secret: this.config.getOrThrow<string>('CLOUDINARY_API_SECRET'),
      secure: true,
    });
  }

  private prefix(): string {
    return this.config.getOrThrow<string>('CLOUDINARY_FOLDER_PREFIX');
  }

  /**
   * `<kpmId>` or `company/<companyId>` (ADR-0032, P5-T2 AC-2).
   *
   * The literal `company` segment keeps the two apart under one prefix: an office id and a
   * company id are both opaque strings, so without it a company folder would be
   * indistinguishable from an office's and per-office erasure could take the company's
   * material with it.
   */
  private ownerFolder(owner: AssetOwner): string {
    return owner.kind === 'kpm' ? owner.kpmId : `company/${owner.companyId}`;
  }

  /**
   * **A signed upload the browser POSTs straight to Cloudinary** (ADR-0032), multipart: `file` and every
   * entry of `fields`.
   *
   * Cloudinary refuses a signed upload without `api_key` and `timestamp` beside the signature, and the
   * signature must cover every parameter sent but `file`, `api_key` and the resource type — here
   * `public_id`, `timestamp`, `type`, `overwrite` and, for a route that takes one kind of file,
   * `allowed_formats` — signed by the SDK's own signer, each as the string the form sends.
   *
   * - `type: authenticated` makes the file private: nothing reaches it but a signed link.
   * - `overwrite: false`: a signature names one fresh key, and a replay of it can never replace a file
   *   somebody already attached under that key.
   * - `allowed_formats` (from `allowedMimeTypes`, a route's narrower list — `pdf` for a pitch or product
   *   document): Cloudinary itself refuses anything else, before the confirm step refuses it again
   *   (ADR-0040). A route that keeps the whole allow-list (training) sends none and is checked on confirm.
   *
   * The API key is not a secret; the secret signs and never leaves this process.
   */
  async createSignedUpload(params: {
    owner: AssetOwner;
    folder: string;
    filename: string;
    mimeType: string;
    allowedMimeTypes?: readonly string[];
  }): Promise<SignedUpload> {
    const storageKey = `${this.prefix()}/${this.ownerFolder(params.owner)}`
      + `/${params.folder}/${ulid()}`;
    const timestamp = String(Math.floor(this.clock.now().getTime() / 1000));
    const formats = (params.allowedMimeTypes ?? [])
      .map((mimeType) => DELIVERY_OF[mimeType]?.format)
      .filter((format): format is string => Boolean(format));
    const signed: Record<string, string> = {
      public_id: storageKey,
      timestamp,
      type: DELIVERY_TYPE,
      overwrite: 'false',
      ...(formats.length > 0 ? { allowed_formats: formats.join(',') } : {}),
    };
    const signature = cloudinary.utils.api_sign_request(
      signed,
      this.config.getOrThrow<string>('CLOUDINARY_API_SECRET'),
    );
    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${this.config.getOrThrow<string>(
        'CLOUDINARY_CLOUD_NAME',
      )}/auto/upload`,
      storageKey,
      signature,
      expiresAt: new Date(this.clock.now().getTime() + 10 * 60 * 1000),
      fields: {
        api_key: this.config.getOrThrow<string>('CLOUDINARY_API_KEY'),
        ...signed,
        signature,
      },
    };
  }

  /**
   * **A link that opens the file for `ttlSeconds`, then stops** — Cloudinary's private download URL for an
   * `authenticated` object, signed with `expires_at`, of the resource type and format the stored media type
   * says: a PDF as an `image` of format `pdf`. A plain signed delivery URL never expires, which is not what
   * *valid 300 seconds* means.
   */
  async createSignedUrl(
    storageKey: string,
    ttlSeconds: number = ASSET_LIMITS.SIGNED_URL_TTL_SECONDS,
    mimeType?: string,
  ): Promise<string> {
    const delivery = (mimeType && DELIVERY_OF[mimeType]) || { resourceType: 'image' as const };
    return this.downloadUrl(storageKey, delivery.resourceType, delivery.format, DELIVERY_TYPE, ttlSeconds);
  }

  /** Cloudinary's private download URL, signed by the SDK with the injected clock, valid `ttlSeconds`. */
  private downloadUrl(
    storageKey: string, resourceType: 'image' | 'video' | 'raw', format: string | undefined,
    deliveryType: string, ttlSeconds: number,
  ): string {
    const now = Math.floor(this.clock.now().getTime() / 1000);
    // `timestamp` is read by the signer (`options.timestamp || now`) though the SDK's types omit it: the
    // injected clock, rather than the process's, signs the link.
    const options = {
      resource_type: resourceType,
      type: deliveryType as typeof DELIVERY_TYPE,
      timestamp: now,
      expires_at: now + ttlSeconds,
    } as const;
    return cloudinary.utils.private_download_url(storageKey, format ?? '', options);
  }

  /**
   * What Cloudinary actually holds under this key (ADR-0040).
   *
   * **Three lookups, not one.** An upload goes to `auto/upload`, and Cloudinary decides for itself
   * which of its three resource types the file belongs to — a PDF lands under `image`, a
   * spreadsheet under `raw`, an mp4 under `video` — while `api.resource` defaults to `image` and
   * answers 404 for the others. Asking each in turn is what makes "did this arrive?" answerable
   * for every type on the allow-list rather than for pictures only. Each asks for the
   * `authenticated` type every upload now lands as; `api.resource` would otherwise look for `upload`.
   *
   * `null` means storage has nothing there: a signature was issued and the bytes never came.
   */
  async describe(storageKey: string): Promise<StoredObject | null> {
    const found = await this.locate(storageKey);
    return found ? found.object : null;
  }

  /**
   * **Duplicate an object into another owner's folder** (P13.2-T7, ADR-0115 §6).
   *
   * Cloudinary has no copy call, so the copy is an upload **from the source's own delivery URL**:
   * signed, of the source's resource and delivery type, into a key minted as an upload's is —
   * `<prefix>/<owner>/<folder>/<ulid>` — so the copy is the destination's by its folder, exactly
   * as if it had been uploaded there. `overwrite: false`: a fresh ULID never collides, and if it
   * somehow did, replacing another owner's file would be the worst way to find out.
   *
   * The source is located first, by the same three probes `describe` makes; a key holding nothing
   * throws rather than producing an empty copy.
   */
  async copy(params: { storageKey: string; owner: AssetOwner; folder: string }): Promise<StoredObject> {
    const source = await this.locate(params.storageKey);
    if (!source) {
      throw new Error(`Storage holds nothing under ${params.storageKey}, so it cannot be copied.`);
    }
    const storageKey = `${this.prefix()}/${this.ownerFolder(params.owner)}/${params.folder}/${ulid()}`;
    // The source through the private download API, valid long enough for Cloudinary to fetch it: a signed
    // delivery URL fails on an account that blocks delivering PDFs, and a copied PDF is the common case.
    const from = this.downloadUrl(
      params.storageKey, source.resourceType, DELIVERY_OF[source.object.mimeType]?.format,
      source.deliveryType, COPY_SOURCE_TTL_SECONDS,
    );
    const copied = await cloudinary.uploader.upload(from, {
      public_id: storageKey,
      resource_type: source.resourceType,
      type: source.deliveryType,
      overwrite: false,
    }).catch((err: unknown) => {
      const refusal = vendorRefusal(err);
      throw new Error(`Cloudinary refused the copy (${refusal.httpCode ?? 'no status'}): ${refusal.message}`);
    }) as { bytes?: number };
    return {
      storageKey,
      mimeType: source.object.mimeType,
      bytes: Number(copied.bytes ?? source.object.bytes),
    };
  }

  /**
   * **A server-held file, under `<prefix>/<owner>/<folder>/<name>`** (Phase 17, D-seed).
   *
   * Asked first, by the three probes `describe` makes: a key storage already holds is returned as it is
   * and not sent again, so a re-seed uploads nothing. Otherwise the bytes go up as a data URI to the same
   * `auto` resource type and `authenticated` type a browser's signed upload lands in, `overwrite: false`,
   * and what Cloudinary then reports is returned — its format turned back into a media type, as `describe`
   * does — so its link opens as a browser upload's does.
   */
  async putObject(params: {
    owner: AssetOwner; folder: string; name: string; mimeType: string; body: Buffer;
  }): Promise<StoredObject & { sent: boolean }> {
    const storageKey = `${this.prefix()}/${this.ownerFolder(params.owner)}/${params.folder}/${params.name}`;
    const held = await this.locate(storageKey);
    if (held) return { ...held.object, sent: false };
    const uploaded = await cloudinary.uploader.upload(
      `data:${params.mimeType};base64,${params.body.toString('base64')}`,
      { public_id: storageKey, resource_type: 'auto', type: DELIVERY_TYPE, overwrite: false },
    ) as { format?: string; bytes?: number };
    const format = String(uploaded.format ?? '').toLowerCase();
    return {
      storageKey,
      mimeType: FORMAT_TO_MIME_TYPE[format] ?? format,
      bytes: Number(uploaded.bytes ?? params.body.length),
      sent: true,
    };
  }

  /** Which of Cloudinary's three resource types holds the key, how it is delivered, and what it is. */
  private async locate(storageKey: string): Promise<{
    object: StoredObject; resourceType: 'image' | 'video' | 'raw'; deliveryType: string;
  } | null> {
    for (const resourceType of ['image', 'video', 'raw'] as const) {
      const found = await this.resource(storageKey, resourceType);
      if (found) return { ...found, resourceType };
    }
    return null;
  }

  private async resource(
    storageKey: string,
    resourceType: 'image' | 'video' | 'raw',
  ): Promise<{ object: StoredObject; deliveryType: string } | null> {
    try {
      const r = await cloudinary.api.resource(storageKey, { resource_type: resourceType, type: DELIVERY_TYPE }) as {
        format?: string; bytes?: number; type?: string;
      };
      const format = String(r.format ?? '').toLowerCase();
      return {
        object: {
          storageKey,
          // Unmapped formats pass through as themselves, so the allow-list refuses them by name
          // instead of this method inventing a media type for a file it does not recognise.
          mimeType: FORMAT_TO_MIME_TYPE[format] ?? format,
          bytes: Number(r.bytes ?? 0),
        },
        // What was asked for, unless the vendor says otherwise: every upload is `authenticated`.
        deliveryType: r.type ?? DELIVERY_TYPE,
      };
    } catch (err) {
      // 404 is the expected answer for two of the three probes above. Anything else is a real
      // failure — a bad key, a revoked credential — and must not read as "the file is not there".
      const refusal = vendorRefusal(err);
      if (refusal.httpCode === 404) return null;
      throw new Error(`Cloudinary refused the lookup (${refusal.httpCode ?? 'no status'}): ${refusal.message}`);
    }
  }

  async remove(storageKey: string): Promise<void> {
    // The type every object is stored as; destroy's default, `upload`, would find nothing to remove.
    await cloudinary.uploader.destroy(storageKey, { invalidate: true, type: DELIVERY_TYPE });
  }
}
