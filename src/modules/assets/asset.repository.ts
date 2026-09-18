import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { Asset, AssetDocument } from './asset.schema';

/**
 * The upload registry, behind the chokepoint (invariant §1).
 *
 * **P4-T11 AC-1 named `assets` and stopped short of it**, so `AssetService` kept injecting the raw
 * model and `Asset` never joined `TENANT_SCOPED_MODELS` — which is why the structural spec that
 * exists to catch exactly this never asked about it. An asset is one office's file: its signed
 * delivery URL is the whole of its access control, so a query that forgot `kpmId` would hand one
 * office's document to another.
 */
@Injectable()
export class AssetRepository extends TenantScopedRepository<AssetDocument> {
  constructor(@InjectModel(Asset.name) model: Model<AssetDocument>) {
    super(model, 'assets');
  }

  /**
   * The **company's** shared training material (ADR-0032).
   *
   * Deliberately verbose, and deliberately not reachable through `scope()`: a company asset
   * carries no `kpmId`, so the scoped filter would never match one — and if it were made to,
   * the row would stop being the company's. Every office of the company reads the same row,
   * which is the whole point of sharing by reference.
   *
   * The caller enforces **who** may reach it: Super Admin to write, and a member of that
   * company to read.
   */
  async findCompanyAsset(companyId: string, storageKey: string): Promise<AssetDocument | null> {
    return this.model.findOne({ companyId, storageKey, deletedAt: null }).exec();
  }

  async createCompanyAsset(doc: Partial<AssetDocument>): Promise<AssetDocument> {
    return this.model.create({ ...doc, kpmId: null, deletedAt: null });
  }

  async updateCompanyAsset(
    companyId: string, storageKey: string, set: Record<string, unknown>,
  ): Promise<AssetDocument | null> {
    return this.model
      .findOneAndUpdate({ companyId, storageKey, deletedAt: null }, { $set: set }, { new: true })
      .exec();
  }
}
