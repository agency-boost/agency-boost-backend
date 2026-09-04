import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { ulid } from 'ulid';
import { Clock } from '@/common/clock/clock.port';
import { ASSET_LIMITS, SignedUpload, StoragePort } from './storage.port';

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

  async createSignedUpload(params: {
    kpmId: string;
    folder: string;
    filename: string;
    mimeType: string;
  }): Promise<SignedUpload> {
    const storageKey = `${this.prefix()}/${params.kpmId}/${params.folder}/${ulid()}`;
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

  async remove(storageKey: string): Promise<void> {
    await cloudinary.uploader.destroy(storageKey, { invalidate: true });
  }
}
