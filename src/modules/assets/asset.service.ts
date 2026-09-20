import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { HttpStatus } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { AssetDocument } from './asset.schema';
import { AssetRepository } from './asset.repository';
import { ASSET_LIMITS } from '@/domain/constants';
import { SignedUpload, StoragePort, StoredObject } from './storage.port';

@Injectable()
export class AssetService {
  constructor(
    private readonly assets: AssetRepository,
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
    this.refuseBeyondLimits(params.mimeType, params.bytes);

    const signed = await this.storage.createSignedUpload({
      owner: { kind: 'kpm', kpmId }, ...params,
    });
    await this.assets.create(ctx, {
      storageKey: signed.storageKey,
      mimeType: params.mimeType,
      bytes: params.bytes,
      originalFilename: params.filename,
      uploadedByMembershipId: ctx.membershipId,
      refCount: 0,
      // The bytes may or may not have arrived: the browser uploads straight to the vendor,
      // and this row is written before it does. `confirmUpload` is what asks (ADR-0040).
      uploadState: 'pending',
    } as Partial<AssetDocument>);
    return signed;
  }

  /**
   * Confirm that the bytes actually arrived, and record what really landed (ADR-0040).
   *
   * **The client's claim is a claim.** `requestUpload` wrote the type and size the browser said
   * it was about to send, before it sent anything; this replaces both with what storage reports,
   * and re-checks the limits against *those*. A file that gets past the first check by
   * mis-declaring itself does not get past this one.
   *
   * Idempotent: confirming an already-confirmed asset re-reads storage and writes the same row,
   * because a retried request after a dropped response must not read as a failure.
   */
  async confirmUpload(ctx: RequestContext, storageKey: string): Promise<AssetDocument> {
    const asset = await this.assets.findOne(ctx, { storageKey });
    if (!asset) {
      throw new DomainException(ErrorCode.NOT_FOUND, 'Asset not found.', HttpStatus.NOT_FOUND);
    }

    const stored = await this.requireStored(storageKey);
    const confirmed = await this.assets.updateById(ctx, String(asset._id), {
      $set: { mimeType: stored.mimeType, bytes: stored.bytes, uploadState: 'confirmed' },
    });
    return confirmed!;
  }

  /**
   * A private, expiring URL. Assets are never publicly readable.
   *
   * Only a **confirmed** asset is deliverable: until storage has been asked, nobody knows the
   * bytes arrived, and a signed URL for an object that is not there is a broken link with a
   * signature on it.
   *
   * **This is not a malware check** (ADR-0040). v1 does not scan, and the state this refuses on
   * no longer pretends otherwise — it used to be `scanStatus`, which nothing ever moved out of
   * `pending`, so every upload was undeliverable while the field told each reader it had been
   * inspected.
   */
  async urlFor(ctx: RequestContext, storageKey: string): Promise<string> {
    const asset = await this.assets.findOne(ctx, { storageKey });
    if (!asset) {
      throw new DomainException(ErrorCode.NOT_FOUND, 'Asset not found.', HttpStatus.NOT_FOUND);
    }
    this.requireConfirmed(asset);
    return this.storage.createSignedUrl(storageKey, ASSET_LIMITS.SIGNED_URL_TTL_SECONDS);
  }

  async retain(ctx: RequestContext, storageKey: string): Promise<void> {
    await this.assets.updateMany(ctx, { storageKey }, { $inc: { refCount: 1 } });
  }

  async release(ctx: RequestContext, storageKey: string): Promise<void> {
    // Guarded rather than clamped afterwards: a count that went negative once would
    // report the file as an orphan for ever and never be reported as referenced again.
    await this.assets.updateMany(
      ctx, { storageKey, refCount: { $gt: 0 } }, { $inc: { refCount: -1 } },
    );
  }

  /**
   * Orphans: referenced by nothing for 30 days. Reported, never auto-deleted.
   *
   * Across every tenant, through the named unscoped read — storage accounting is a platform
   * job, and a per-office sweep would never see the office that has been archived.
   */
  async findOrphans(ctx: RequestContext, olderThanDays = 30): Promise<AssetDocument[]> {
    const cutoff = new Date(this.clock.now().getTime() - olderThanDays * 86_400_000);
    return this.assets.findAcrossAllTenants(ctx, { refCount: 0, createdAt: { $lt: cutoff } });
  }

  // ------------------------------------------------ the company's shared material (ADR-0032)

  /**
   * An upload that belongs to the **company**, not to any office.
   *
   * Super Admin's alone, and the caller has already been through `company_template:write`. It
   * lands under `company/<companyId>`, every office of that company reads it by reference, and
   * no office's erasure touches it.
   */
  async requestCompanyUpload(
    companyId: string,
    params: { folder: string; filename: string; mimeType: string; bytes: number },
  ): Promise<SignedUpload> {
    this.refuseBeyondLimits(params.mimeType, params.bytes);

    const signed = await this.storage.createSignedUpload({
      owner: { kind: 'company', companyId }, ...params,
    });
    await this.assets.createCompanyAsset({
      companyId,
      storageKey: signed.storageKey,
      mimeType: params.mimeType,
      bytes: params.bytes,
      originalFilename: params.filename,
      // No membership: a Super Admin is in no office, and inventing one would attribute the
      // upload to a member who does not exist.
      uploadedByMembershipId: null,
      refCount: 0,
      uploadState: 'pending',
    } as Partial<AssetDocument>);
    return signed;
  }

  async confirmCompanyUpload(companyId: string, storageKey: string): Promise<AssetDocument> {
    const asset = await this.assets.findCompanyAsset(companyId, storageKey);
    if (!asset) {
      throw new DomainException(ErrorCode.NOT_FOUND, 'Asset not found.', HttpStatus.NOT_FOUND);
    }
    const stored = await this.requireStored(storageKey);
    return (await this.assets.updateCompanyAsset(companyId, storageKey, {
      mimeType: stored.mimeType, bytes: stored.bytes, uploadState: 'confirmed',
    }))!;
  }

  /**
   * A delivery URL for the company's material.
   *
   * **Authorised by who may read the module, not by who owns the file** (ADR-0032): a member of
   * any office of that company may read it, which is what sharing by reference means. The caller
   * passes the company its reader belongs to — never one from the request body — so an office of
   * another insurer asking for this key gets a 404 like any other stranger.
   */
  async companyUrlFor(companyId: string, storageKey: string): Promise<string> {
    const asset = await this.assets.findCompanyAsset(companyId, storageKey);
    if (!asset) {
      throw new DomainException(ErrorCode.NOT_FOUND, 'Asset not found.', HttpStatus.NOT_FOUND);
    }
    this.requireConfirmed(asset);
    return this.storage.createSignedUrl(storageKey, ASSET_LIMITS.SIGNED_URL_TTL_SECONDS);
  }

  private async requireStored(storageKey: string): Promise<StoredObject> {
    const stored = await this.storage.describe(storageKey);
    if (!stored) {
      throw new DomainException(
        ErrorCode.ASSET_NOT_UPLOADED,
        'That file never finished uploading. Try again.',
        HttpStatus.CONFLICT,
        { storageKey },
      );
    }
    this.refuseBeyondLimits(stored.mimeType, stored.bytes);
    return stored;
  }

  private requireConfirmed(asset: AssetDocument): void {
    if (asset.uploadState !== 'confirmed') {
      throw new DomainException(
        ErrorCode.ASSET_NOT_CONFIRMED,
        'This file has not finished uploading yet. Try again shortly.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * The allow-list and the ceiling, enforced twice on purpose.
   *
   * Once before a signature is issued, so nothing oversized is ever uploaded, and once against
   * what storage reports, so a file that got past the first check by mis-declaring its own type
   * does not get past the second (ADR-0040).
   */
  private refuseBeyondLimits(mimeType: string, bytes: number): void {
    if (bytes > ASSET_LIMITS.MAX_BYTES) {
      throw new DomainException(
        ErrorCode.ASSET_TOO_LARGE,
        `Files must be ${ASSET_LIMITS.MAX_BYTES / 1024 / 1024} MB or smaller.`,
        HttpStatus.PAYLOAD_TOO_LARGE,
        { maxBytes: ASSET_LIMITS.MAX_BYTES, receivedBytes: bytes },
      );
    }
    if (!(ASSET_LIMITS.ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
      throw new DomainException(
        ErrorCode.ASSET_TYPE_NOT_ALLOWED,
        'That file type is not accepted.',
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        { mimeType, allowed: ASSET_LIMITS.ALLOWED_MIME_TYPES },
      );
    }
  }
}
