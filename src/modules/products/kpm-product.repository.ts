import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, UpdateQuery } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
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
}
