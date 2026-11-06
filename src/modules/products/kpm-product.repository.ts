import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, UpdateQuery } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { KpmProductConfig, KpmProductConfigDocument } from './kpm-product-config.schema';

/**
 * An office's decisions about its company's products (P5-T5). Through the chokepoint, like every
 * other tenant-scoped collection: a decision is one office's and nobody else's business.
 */
@Injectable()
export class KpmProductConfigRepository extends TenantScopedRepository<KpmProductConfigDocument> {
  constructor(@InjectModel(KpmProductConfig.name) model: Model<KpmProductConfigDocument>) {
    super(model, 'kpmProductConfigs');
  }

  /**
   * Create the office's row for a product if it has none, then apply the change.
   *
   * **Upsert rather than read-then-write**, because a row's absence *is* a state — it means
   * "this office has no opinion" — and two people making their first decision about the same
   * product at the same moment would otherwise race to create two rows, which the unique index
   * would refuse with a 500 rather than a merge.
   */
  async upsert(
    ctx: RequestContext,
    productId: string,
    update: UpdateQuery<KpmProductConfigDocument>,
  ): Promise<KpmProductConfigDocument> {
    const kpmId = ctx.kpmId;
    const set = { ...(update.$set ?? {}), updatedBy: ctx.membershipId };
    return (await this.model.findOneAndUpdate(
      { kpmId, productId, deletedAt: null },
      {
        ...update,
        $set: set,
        $setOnInsert: { kpmId, productId, deletedAt: null, createdBy: ctx.membershipId },
      },
      { new: true, upsert: true },
    ).exec())!;
  }

  /**
   * **How many offices still name one product** (P19.4-T4 AC-13; ADR-0209 §10): offices that sell it — a row switched
   * on — and offices with a script for it, drafted, approved or sent back (ADR-0037). What refuses deleting a withdrawn
   * product, `409 PRODUCT_IN_USE`.
   *
   * **Deliberately unscoped, and named so** (invariant §1): a product is the company's, read by every office of it,
   * and the Super Admin who deletes it is in none of them. The caller must be a Super Admin. **Counts, never a row**:
   * no office, no name and no word of a script leaves the database.
   */
  async referencesToProductAcrossTenants(
    ctx: RequestContext, productId: string,
  ): Promise<{ activations: number; scriptApprovals: number }> {
    if (!ctx.isSuperAdmin) {
      throw new MissingTenantContextError(this.collectionName, 'referencesToProductAcrossTenants');
    }
    const [activations, scriptApprovals] = await Promise.all([
      this.model.countDocuments({ productId, active: true, deletedAt: null }).exec(),
      this.model.countDocuments({ productId, reviewState: { $ne: 'none' }, deletedAt: null }).exec(),
    ]);
    return { activations, scriptApprovals };
  }
}
