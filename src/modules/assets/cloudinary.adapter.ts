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

  async createSignedUpload(params: {
    owner: AssetOwner;
    folder: string;
    filename: string;
    mimeType: string;
  }): Promise<SignedUpload> {
    const storageKey = `${this.prefix()}/${this.ownerFolder(params.owner)}`
      + `/${params.folder}/${ulid()}`;
    const timestamp = Math.floor(this.clock.now().getTime() / 1000);
    const signature = cloudinary.utils.api_sign_request(
      { public_id: storageKey, timestamp },
      this.config.getOrThrow<string>('CLOUDINARY_API_SECRET'),
    );
    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${this.config.getOrThrow<string>(
        'CLOUDINARY_CLOUD_NAME',
      )}/auto/upload`,
      storageKey,
      signature,
      expiresAt: new Date(this.clock.now().getTime() + 10 * 60 * 1000),
    };
  }

  async createSignedUrl(
    storageKey: string,
    ttlSeconds: number = ASSET_LIMITS.SIGNED_URL_TTL_SECONDS,
  ): Promise<string> {
    return cloudinary.url(storageKey, {
      sign_url: true,
      type: 'authenticated',
      expires_at: Math.floor(this.clock.now().getTime() / 1000) + ttlSeconds,
    });
  }

  /**
   * What Cloudinary actually holds under this key (ADR-0040).
   *
   * **Three lookups, not one.** An upload goes to `auto/upload`, and Cloudinary decides for itself
   * which of its three resource types the file belongs to — a PDF lands under `image`, a
   * spreadsheet under `raw`, an mp4 under `video` — while `api.resource` defaults to `image` and
   * answers 404 for the others. Asking each in turn is what makes "did this arrive?" answerable
   * for every type on the allow-list rather than for pictures only.
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
    const from = cloudinary.url(params.storageKey, {
      resource_type: source.resourceType,
      type: source.deliveryType,
      sign_url: true,
      secure: true,
    });
    const copied = await cloudinary.uploader.upload(from, {
      public_id: storageKey,
      resource_type: source.resourceType,
      type: source.deliveryType,
      overwrite: false,
    }) as { bytes?: number };
    return {
      storageKey,
      mimeType: source.object.mimeType,
      bytes: Number(copied.bytes ?? source.object.bytes),
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
      const r = await cloudinary.api.resource(storageKey, { resource_type: resourceType }) as {
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
        // `upload` unless the vendor says otherwise: the signed upload sets no type of its own.
        deliveryType: r.type ?? 'upload',
      };
    } catch (err) {
      // 404 is the expected answer for two of the three probes above. Anything else is a real
      // failure — a bad key, a revoked credential — and must not read as "the file is not there".
      if ((err as { http_code?: number })?.http_code === 404) return null;
      throw err;
    }
  }

  async remove(storageKey: string): Promise<void> {
    await cloudinary.uploader.destroy(storageKey, { invalidate: true });
  }
}
