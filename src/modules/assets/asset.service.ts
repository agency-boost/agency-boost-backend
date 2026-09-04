import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { HttpStatus } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { Asset, AssetDocument } from './asset.schema';
import { ASSET_LIMITS, SignedUpload, StoragePort } from './storage.port';

@Injectable()
export class AssetService {
  constructor(
    @InjectModel(Asset.name) private readonly assets: Model<AssetDocument>,
    private readonly storage: StoragePort,
    private readonly clock: Clock,
  ) {}

  /**
   * Limits are checked before a signature is issued. Rejecting after the bytes have
   * already been uploaded wastes the user's data allowance and our storage.
   */
  async requestUpload(
    ctx: RequestContext,
    params: { folder: string; filename: string; mimeType: string; bytes: number },
  ): Promise<SignedUpload> {
    const kpmId = ctx.kpmId;
    if (!kpmId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        'You have not joined a KPM yet.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (params.bytes > ASSET_LIMITS.MAX_BYTES) {
      throw new DomainException(
        ErrorCode.ASSET_TOO_LARGE,
        `Files must be ${ASSET_LIMITS.MAX_BYTES / 1024 / 1024} MB or smaller.`,
        HttpStatus.PAYLOAD_TOO_LARGE,
        { maxBytes: ASSET_LIMITS.MAX_BYTES, receivedBytes: params.bytes },
      );
    }
    if (!(ASSET_LIMITS.ALLOWED_MIME_TYPES as readonly string[]).includes(params.mimeType)) {
      throw new DomainException(
        ErrorCode.ASSET_TYPE_NOT_ALLOWED,
        `That file type is not accepted.`,
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        { mimeType: params.mimeType, allowed: ASSET_LIMITS.ALLOWED_MIME_TYPES },
      );
    }

    const signed = await this.storage.createSignedUpload({ kpmId, ...params });
    await this.assets.create({
      kpmId,
      storageKey: signed.storageKey,
      mimeType: params.mimeType,
      bytes: params.bytes,
      originalFilename: params.filename,
      uploadedByMembershipId: ctx.membershipId,
      refCount: 0,
      scanStatus: 'pending',
      deletedAt: null,
    });
    return signed;
  }

  /** A private, expiring URL. Assets are never publicly readable. */
  async urlFor(ctx: RequestContext, storageKey: string): Promise<string> {
    const asset = await this.assets
      .findOne({ storageKey, kpmId: ctx.kpmId, deletedAt: null })
      .exec();
    if (!asset) {
      throw new DomainException(ErrorCode.NOT_FOUND, 'Asset not found.', HttpStatus.NOT_FOUND);
    }
    if (asset.scanStatus === 'pending') {
      throw new DomainException(
        ErrorCode.ASSET_SCAN_PENDING,
        'This file is still being checked. Try again shortly.',
        HttpStatus.CONFLICT,
      );
    }
    return this.storage.createSignedUrl(storageKey, ASSET_LIMITS.SIGNED_URL_TTL_SECONDS);
  }

  async retain(ctx: RequestContext, storageKey: string): Promise<void> {
    await this.assets
      .updateOne({ storageKey, kpmId: ctx.kpmId }, { $inc: { refCount: 1 } })
      .exec();
  }

  async release(ctx: RequestContext, storageKey: string): Promise<void> {
    await this.assets
      .updateOne({ storageKey, kpmId: ctx.kpmId, refCount: { $gt: 0 } }, { $inc: { refCount: -1 } })
      .exec();
  }

  /** Orphans: referenced by nothing for 30 days. Reported, never auto-deleted. */
  async findOrphans(olderThanDays = 30): Promise<AssetDocument[]> {
    const cutoff = new Date(this.clock.now().getTime() - olderThanDays * 86_400_000);
    return this.assets.find({ refCount: 0, deletedAt: null, createdAt: { $lt: cutoff } }).exec();
  }
}
