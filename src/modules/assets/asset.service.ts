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
    /**
     * A narrower list than `ALLOWED_MIME_TYPES` for a route that takes one kind of file — a PDF for a
     * pitch or product document (`DOCUMENT_MIME_TYPES`, Phase 17). Refused as any other type is.
     */
    allowed: readonly string[] = ASSET_LIMITS.ALLOWED_MIME_TYPES,
  ): Promise<SignedUpload> {
    const kpmId = ctx.kpmId;
    if (!kpmId) {
      throw new DomainException(
        ErrorCode.TENANT_NO_MEMBERSHIP,
        'You have not joined a KPM yet.',
        HttpStatus.FORBIDDEN,
      );
    }
    this.refuseBeyondLimits(params.mimeType, params.bytes, allowed);

    const signed = await this.storage.createSignedUpload({
      owner: { kind: 'kpm', kpmId },
      ...params,
      // A route's narrower list goes to the vendor too (Phase 17, N5); the whole allow-list is not sent.
      ...(allowed === ASSET_LIMITS.ALLOWED_MIME_TYPES ? {} : { allowedMimeTypes: allowed }),
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
  async confirmUpload(
    ctx: RequestContext,
    storageKey: string,
    /** The narrower list the upload was signed under, checked again against what storage reports. */
    allowed: readonly string[] = ASSET_LIMITS.ALLOWED_MIME_TYPES,
  ): Promise<AssetDocument> {
    const asset = await this.assets.findOne(ctx, { storageKey });
    if (!asset) {
      throw new DomainException(ErrorCode.NOT_FOUND, 'Asset not found.', HttpStatus.NOT_FOUND);
    }

    const stored = await this.requireStored(storageKey, allowed);
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
    return this.storage.createSignedUrl(storageKey, ASSET_LIMITS.SIGNED_URL_TTL_SECONDS, asset.mimeType);
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
   * job, and a per-office sweep would never see the office that has been archived. It reads the
   * company's material too (no `kpmId` filter), which is how a file a failed template copy left
   * behind is found (P13.2-T7 AC-5).
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
    return this.storage.createSignedUrl(storageKey, ASSET_LIMITS.SIGNED_URL_TTL_SECONDS, asset.mimeType);
  }

  /** One of the company's own files, or `null`: the named unscoped read, filtered by company (ADR-0032). */
  async companyAsset(companyId: string, storageKey: string): Promise<AssetDocument | null> {
    return this.assets.findCompanyAsset(companyId, storageKey);
  }

  /**
   * **A file duplicated into a company's assets** (P13.2-T7 AC-3, ADR-0115 §6).
   *
   * A template copied across an owner boundary cannot reference the source's file — an asset has one
   * owner (ADR-0032) — so storage copies the bytes into the company's folder and the copy is
   * registered here as the company's: confirmed, because storage has just said what it holds, and
   * **referenced by nothing yet** (`refCount: 0`). The caller retains it once the template naming it
   * exists (`retainCompanyCopies`); a copy that fails before then leaves it at zero, for the sweep.
   */
  async duplicateIntoCompany(
    companyId: string,
    source: { storageKey: string; originalFilename: string | null },
  ): Promise<StoredObject> {
    const copied = await this.storage.copy({
      storageKey: source.storageKey, owner: { kind: 'company', companyId }, folder: 'training',
    });
    await this.assets.createCompanyAsset({
      companyId,
      storageKey: copied.storageKey,
      mimeType: copied.mimeType,
      bytes: copied.bytes,
      originalFilename: source.originalFilename,
      uploadedByMembershipId: null,
      refCount: 0,
      uploadState: 'confirmed',
    } as Partial<AssetDocument>);
    return copied;
  }

  /** The copies a template now names: referenced once each, so the sweep no longer reports them. */
  async retainCompanyCopies(companyId: string, storageKeys: string[]): Promise<void> {
    await this.assets.retainCompanyAssets(companyId, storageKeys);
  }

  private async requireStored(
    storageKey: string, allowed: readonly string[] = ASSET_LIMITS.ALLOWED_MIME_TYPES,
  ): Promise<StoredObject> {
    const stored = await this.storage.describe(storageKey);
    if (!stored) {
      throw new DomainException(
        ErrorCode.ASSET_NOT_UPLOADED,
        'That file never finished uploading. Try again.',
        HttpStatus.CONFLICT,
        { storageKey },
      );
    }
    this.refuseBeyondLimits(stored.mimeType, stored.bytes, allowed);
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
  private refuseBeyondLimits(
    mimeType: string, bytes: number, allowed: readonly string[] = ASSET_LIMITS.ALLOWED_MIME_TYPES,
  ): void {
    if (bytes > ASSET_LIMITS.MAX_BYTES) {
      throw new DomainException(
        ErrorCode.ASSET_TOO_LARGE,
        `Files must be ${ASSET_LIMITS.MAX_BYTES / 1024 / 1024} MB or smaller.`,
        HttpStatus.PAYLOAD_TOO_LARGE,
        { maxBytes: ASSET_LIMITS.MAX_BYTES, receivedBytes: bytes },
      );
    }
    if (!allowed.includes(mimeType)) {
      throw new DomainException(
        ErrorCode.ASSET_TYPE_NOT_ALLOWED,
        'That file type is not accepted.',
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        { mimeType, allowed },
      );
    }
  }
}
