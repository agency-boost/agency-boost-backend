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
}
